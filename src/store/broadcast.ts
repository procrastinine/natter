import { browserLocalStorage } from '../lib/browser-storage'
import type { WorkspaceFence } from './repository'
import {
  canonicalizeWorkspaceChange,
  workspaceFenceFromUnknownChange,
} from './workspace-change-boundary'
import type { WorkspaceChange } from './workspace-protocol'
import type { WorkspaceRuntimeResourceSubset } from './workspace-runtime-control'

type FallbackSnapshotReader = (signal?: AbortSignal) => Promise<{
  workspaceId: string
  replacementEpoch: number
}>

const CHANNEL_NAME = 'llm-api-frontend'
const FALLBACK_SIGNAL_KEY = 'natter:workspace-change'

let channel: BroadcastChannel | null = null
let channelUnavailable = false
const workspaceChangeSubs = new Set<(change: WorkspaceChange) => void>()
const remoteWorkspaceChangeSubs = new Set<(change: WorkspaceChange) => void>()
const workspaceApplicationChangeSubs = new Set<(change: WorkspaceChange) => void>()
let fallbackVerificationActive = false
let deliveredWorkspaceFence: WorkspaceFence | null = null
let productionFallbackSnapshotReader: FallbackSnapshotReader | null = null
let fallbackSnapshotReader: FallbackSnapshotReader = readFallbackSnapshot
let broadcastAdmissionsOpen = false
let fallbackVerificationAdmissionsOpen = false
let remoteInboundAdmissionsOpen = false
let remoteWorkspaceChangeMissed = false
let durableVerificationRequested = false
let durableVerificationInFlight = false
let durableVerificationPromise: Promise<void> = Promise.resolve()
let durableVerificationGeneration = 0
let storageListenerInstalled = false
let lifecycleListenersInstalled = false

export const broadcastWorkspaceRuntimeResources = {
  'broadcast-remote-inbound': {
    id: 'broadcast-remote-inbound',
    phase: 'inbound',
    closeAdmissions: () => {
      remoteInboundAdmissionsOpen = false
      stopFallbackVerification()
    },
    abort: () => {},
    awaitIdle: () => Promise.resolve(),
    assertClosed: () => {
      if (remoteInboundAdmissionsOpen) throw new Error('BroadcastRemoteInboundNotClosed')
    },
    attach: (snapshot) => {
      const previousFence = deliveredWorkspaceFence
      setDeliveredWorkspaceFence(snapshot)
      if (previousFence !== null) {
        fanOutWorkspaceChange(
          !sameWorkspaceFence(previousFence, snapshot)
            ? replacementChange(snapshot)
            : invalidationChange(snapshot),
        )
      } else if (remoteWorkspaceChangeMissed) {
        fanOutWorkspaceChange(invalidationChange(snapshot))
      }
      remoteWorkspaceChangeMissed = false
      remoteInboundAdmissionsOpen = true
      if (hasWorkspaceChangeSubscribers() && channel === null) startFallbackVerification()
    },
  },
  'broadcast-fallback-verification': {
    id: 'broadcast-fallback-verification',
    phase: 'query',
    closeAdmissions: () => {
      fallbackVerificationAdmissionsOpen = false
    },
    abort: stopFallbackVerification,
    awaitIdle: () => durableVerificationPromise,
    assertClosed: () => {
      if (
        fallbackVerificationAdmissionsOpen ||
        fallbackVerificationActive ||
        durableVerificationInFlight ||
        storageListenerInstalled ||
        lifecycleListenersInstalled
      ) {
        throw new Error('BroadcastFallbackVerificationNotClosed')
      }
    },
    attach: () => {
      fallbackVerificationAdmissionsOpen = true
      if (hasWorkspaceChangeSubscribers() && channel === null) startFallbackVerification()
    },
  },
  broadcast: {
    id: 'broadcast',
    phase: 'transport',
    closeAdmissions: () => {
      broadcastAdmissionsOpen = false
    },
    abort: () => {},
    awaitIdle: () => Promise.resolve(),
    assertClosed: () => {
      if (broadcastAdmissionsOpen || channel !== null) {
        throw new Error('BroadcastTransportNotClosed')
      }
    },
    finishDispose: () => {
      closeChannel(channel)
      channel = null
      stopFallbackVerification()
    },
    attach: () => {
      broadcastAdmissionsOpen = true
      if (!hasWorkspaceChangeSubscribers()) return
      if (!ensureChannel()) startFallbackVerification()
    },
  },
} satisfies WorkspaceRuntimeResourceSubset<
  'broadcast-remote-inbound' | 'broadcast-fallback-verification' | 'broadcast'
>

function ensureChannel(): BroadcastChannel | null {
  if (channel !== null) return channel
  if (!broadcastAdmissionsOpen) return null
  if (channelUnavailable || typeof BroadcastChannel === 'undefined') {
    channelUnavailable = true
    startFallbackVerification()
    return null
  }
  let next: BroadcastChannel | null = null
  try {
    next = new BroadcastChannel(CHANNEL_NAME)
    next.addEventListener('message', (message: MessageEvent) => {
      let change: WorkspaceChange
      try {
        change = canonicalizeWorkspaceChange(message.data)
      } catch {
        remoteWorkspaceChangeMissed = true
        requestDurableWorkspaceVerification()
        return
      }
      if (!remoteInboundAdmissionsOpen) {
        remoteWorkspaceChangeMissed = true
        return
      }
      receiveRemoteWorkspaceChange(change)
    })
    next.addEventListener('messageerror', () => makeChannelUnavailable(next))
    channel = next
    return channel
  } catch {
    closeChannel(next)
    makeChannelUnavailable(null)
    return null
  }
}

function closeChannel(target: BroadcastChannel | null): void {
  try {
    target?.close()
  } catch {
    // Transport cleanup cannot affect workspace state.
  }
}

function makeChannelUnavailable(target: BroadcastChannel | null): void {
  if (target !== null && channel !== target) return
  closeChannel(channel)
  channel = null
  channelUnavailable = true
  startFallbackVerification()
}

function retryChannelPost(change: WorkspaceChange, failedChannel: BroadcastChannel): boolean {
  if (channel !== failedChannel) return false
  closeChannel(failedChannel)
  channel = null
  const retry = ensureChannel()
  if (!retry) return false
  try {
    retry.postMessage(change)
    return true
  } catch {
    makeChannelUnavailable(retry)
    return false
  }
}

function fanOutWorkspaceChange(
  change: WorkspaceChange,
  delivery: 'local' | 'shared' = 'shared',
): void {
  const canonical = canonicalizeWorkspaceChange(change)
  const subscribers =
    delivery === 'local'
      ? [...workspaceApplicationChangeSubs, ...workspaceChangeSubs]
      : [...workspaceApplicationChangeSubs, ...workspaceChangeSubs, ...remoteWorkspaceChangeSubs]
  for (const handler of subscribers) {
    try {
      handler(canonical)
    } catch {
      // A projection subscriber cannot affect transport delivery.
    }
  }
}

function receiveLocalWorkspaceChange(change: WorkspaceChange): void {
  const stamp = workspaceStamp(change)
  const prior = deliveredWorkspaceFence
  if (prior && !sameWorkspaceFence(prior, stamp)) {
    setDeliveredWorkspaceFence(stamp)
    if (change.kind === 'replace') fanOutWorkspaceChange(change, 'local')
    else {
      fanOutWorkspaceChange(replacementChange(stamp), 'local')
      fanOutWorkspaceChange(change, 'local')
    }
    return
  }
  setDeliveredWorkspaceFence(stamp)
  fanOutWorkspaceChange(change, 'local')
}

function receiveRemoteWorkspaceChange(change: WorkspaceChange): void {
  const stamp = workspaceStamp(change)
  const current = deliveredWorkspaceFence
  if (!current || !sameWorkspaceFence(current, stamp)) {
    remoteWorkspaceChangeMissed = true
    requestDurableWorkspaceVerification()
    return
  }
  fanOutWorkspaceChange(change)
}

function requestDurableWorkspaceVerification(): void {
  durableVerificationRequested = true
  if (durableVerificationInFlight) return
  durableVerificationInFlight = true
  const generation = durableVerificationGeneration
  durableVerificationPromise = (async () => {
    while (
      generation === durableVerificationGeneration &&
      durableVerificationRequested &&
      remoteInboundAdmissionsOpen
    ) {
      durableVerificationRequested = false
      try {
        const snapshot = await fallbackSnapshotReader()
        if (generation !== durableVerificationGeneration) return
        if (remoteInboundAdmissionsClosed()) {
          remoteWorkspaceChangeMissed = true
          return
        }
        const prior = deliveredWorkspaceFence
        setDeliveredWorkspaceFence(snapshot)
        fanOutWorkspaceChange(
          prior && !sameWorkspaceFence(prior, snapshot)
            ? replacementChange(snapshot)
            : invalidationChange(snapshot),
        )
        remoteWorkspaceChangeMissed = false
      } catch {
        remoteWorkspaceChangeMissed = true
      }
    }
  })().finally(() => {
    if (generation !== durableVerificationGeneration) return
    durableVerificationInFlight = false
    if (durableVerificationRequested && remoteInboundAdmissionsOpen) {
      requestDurableWorkspaceVerification()
    }
  })
}

function remoteInboundAdmissionsClosed(): boolean {
  return !remoteInboundAdmissionsOpen
}

function workspaceStamp(change: WorkspaceChange): WorkspaceFence {
  return change.kind === 'commit' ? change.stamp : change
}

function sameWorkspaceFence(left: WorkspaceFence, right: WorkspaceFence): boolean {
  return left.workspaceId === right.workspaceId && left.replacementEpoch === right.replacementEpoch
}

function setDeliveredWorkspaceFence(snapshot: WorkspaceFence): void {
  deliveredWorkspaceFence = {
    workspaceId: snapshot.workspaceId,
    replacementEpoch: snapshot.replacementEpoch,
  }
}

function replacementChange(snapshot: WorkspaceFence): WorkspaceChange {
  return {
    kind: 'replace',
    workspaceId: snapshot.workspaceId,
    replacementEpoch: snapshot.replacementEpoch,
  }
}

function invalidationChange(snapshot: WorkspaceFence): WorkspaceChange {
  return {
    kind: 'invalidate',
    workspaceId: snapshot.workspaceId,
    replacementEpoch: snapshot.replacementEpoch,
    dependencies: 'all',
  }
}

export function postWorkspaceChange(change: WorkspaceChange): void {
  let canonical: WorkspaceChange
  try {
    canonical = canonicalizeWorkspaceChange(change)
  } catch {
    const fence = workspaceFenceFromUnknownChange(change)
    if (!fence) return
    canonical = canonicalizeWorkspaceChange(invalidationChange(fence))
  }
  try {
    receiveLocalWorkspaceChange(canonical)
  } catch {
    // Local projection delivery cannot alter an authoritative commit.
  }
  try {
    const bc = ensureChannel()
    let posted = false
    if (bc) {
      try {
        bc.postMessage(canonical)
        posted = true
      } catch {
        posted = retryChannelPost(canonical, bc)
      }
    }
    if (!posted) postFallbackSignal(canonical)
  } catch {
    postFallbackSignal(canonical)
  }
}

export function subscribeWorkspaceChanges(
  handler: (change: WorkspaceChange) => void,
  options: { readonly delivery?: 'all' | 'remote' } = {},
): () => void {
  const bc = ensureChannel()
  const subscribers =
    options.delivery === 'remote' ? remoteWorkspaceChangeSubs : workspaceChangeSubs
  subscribers.add(handler)
  if (!bc) startFallbackVerification()
  return () => {
    subscribers.delete(handler)
    if (!hasWorkspaceChangeSubscribers()) stopFallbackVerification()
  }
}

export function subscribeWorkspaceApplicationChanges(
  handler: (change: WorkspaceChange) => void,
): () => void {
  const bc = ensureChannel()
  workspaceApplicationChangeSubs.add(handler)
  if (!bc) startFallbackVerification()
  return () => {
    workspaceApplicationChangeSubs.delete(handler)
    if (!hasWorkspaceChangeSubscribers()) stopFallbackVerification()
  }
}

export function __resetBroadcastForTests(options: { admissionsOpen?: boolean } = {}): void {
  stopFallbackVerification()
  closeChannel(channel)
  channel = null
  channelUnavailable = false
  workspaceChangeSubs.clear()
  remoteWorkspaceChangeSubs.clear()
  fallbackSnapshotReader = readFallbackSnapshot
  const admissionsOpen = options.admissionsOpen ?? false
  broadcastAdmissionsOpen = admissionsOpen
  fallbackVerificationAdmissionsOpen = admissionsOpen
  remoteInboundAdmissionsOpen = admissionsOpen
  deliveredWorkspaceFence = null
  remoteWorkspaceChangeMissed = false
  durableVerificationGeneration += 1
  durableVerificationRequested = false
  durableVerificationInFlight = false
  durableVerificationPromise = Promise.resolve()
}

export function __setBroadcastFallbackReaderForTests(reader: FallbackSnapshotReader | null): void {
  fallbackSnapshotReader = reader ?? readFallbackSnapshot
}

export function configureBroadcastFallbackReader(reader: FallbackSnapshotReader): void {
  productionFallbackSnapshotReader = reader
}

export function seedBroadcastWorkspaceSnapshot(snapshot: WorkspaceFence): void {
  if (deliveredWorkspaceFence !== null) return
  setDeliveredWorkspaceFence(snapshot)
}

function startFallbackVerification(): void {
  if (
    !broadcastAdmissionsOpen ||
    !fallbackVerificationAdmissionsOpen ||
    !remoteInboundAdmissionsOpen ||
    fallbackVerificationActive ||
    channel !== null ||
    !hasWorkspaceChangeSubscribers()
  ) {
    return
  }
  fallbackVerificationActive = true
  installStorageListener()
  installLifecycleListeners()
  requestDurableWorkspaceVerification()
}

function hasWorkspaceChangeSubscribers(): boolean {
  return (
    workspaceApplicationChangeSubs.size > 0 ||
    workspaceChangeSubs.size > 0 ||
    remoteWorkspaceChangeSubs.size > 0
  )
}

function stopFallbackVerification(): void {
  fallbackVerificationActive = false
  removeStorageListener()
  removeLifecycleListeners()
}

function postFallbackSignal(change: WorkspaceChange): void {
  try {
    const storage = browserLocalStorage()
    if (!storage) return
    const stamp = workspaceStamp(change)
    const value = JSON.stringify({
      workspaceId: stamp.workspaceId,
      replacementEpoch: stamp.replacementEpoch,
      commitId: change.kind === 'commit' ? change.stamp.commitId : null,
      nonce: `${Date.now()}:${Math.random()}`,
    })
    storage.setItem(FALLBACK_SIGNAL_KEY, value)
  } catch {
    return
  }
}

function installStorageListener(): void {
  if (storageListenerInstalled || typeof window === 'undefined') return
  window.addEventListener('storage', handleStorageSignal)
  storageListenerInstalled = true
}

function removeStorageListener(): void {
  if (!storageListenerInstalled || typeof window === 'undefined') return
  window.removeEventListener('storage', handleStorageSignal)
  storageListenerInstalled = false
}

function handleStorageSignal(event: StorageEvent): void {
  if (event.key !== FALLBACK_SIGNAL_KEY) return
  if (!remoteInboundAdmissionsOpen) {
    remoteWorkspaceChangeMissed = true
    return
  }
  const fence = fallbackSignalFence(event.newValue)
  if (fence && deliveredWorkspaceFence && sameWorkspaceFence(deliveredWorkspaceFence, fence)) {
    fanOutWorkspaceChange(invalidationChange(fence))
    remoteWorkspaceChangeMissed = false
    return
  }
  remoteWorkspaceChangeMissed = true
  requestDurableWorkspaceVerification()
}

function installLifecycleListeners(): void {
  if (lifecycleListenersInstalled || typeof window === 'undefined') return
  window.addEventListener('focus', handleFallbackLifecycleCatchUp)
  window.addEventListener('pageshow', handleFallbackLifecycleCatchUp)
  document.addEventListener('visibilitychange', handleFallbackVisibilityChange)
  lifecycleListenersInstalled = true
}

function removeLifecycleListeners(): void {
  if (!lifecycleListenersInstalled || typeof window === 'undefined') return
  window.removeEventListener('focus', handleFallbackLifecycleCatchUp)
  window.removeEventListener('pageshow', handleFallbackLifecycleCatchUp)
  document.removeEventListener('visibilitychange', handleFallbackVisibilityChange)
  lifecycleListenersInstalled = false
}

function handleFallbackVisibilityChange(): void {
  if (document.visibilityState === 'visible') handleFallbackLifecycleCatchUp()
}

function handleFallbackLifecycleCatchUp(): void {
  if (!fallbackVerificationActive || channel !== null) return
  requestDurableWorkspaceVerification()
}

function fallbackSignalFence(value: string | null): WorkspaceFence | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return typeof parsed.workspaceId === 'string' &&
      parsed.workspaceId.length > 0 &&
      Number.isSafeInteger(parsed.replacementEpoch) &&
      (parsed.replacementEpoch as number) >= 0
      ? {
          workspaceId: parsed.workspaceId,
          replacementEpoch: parsed.replacementEpoch as number,
        }
      : null
  } catch {
    return null
  }
}

async function readFallbackSnapshot(): Promise<{
  workspaceId: string
  replacementEpoch: number
}> {
  if (!productionFallbackSnapshotReader) throw new Error('BroadcastFallbackReaderUnavailable')
  return productionFallbackSnapshotReader()
}
