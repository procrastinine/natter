// BroadcastChannel delivers messages to OTHER tabs only — the sender never
// receives its own `postMessage`. For same-tab-within-a-module fan-out
// UI listeners need to fire on local writes too, so `postEvent` dispatches
// locally and also crosses the channel. The two paths never double-fire because
// remote tabs only see the BroadcastChannel path and local tabs only see the
// direct dispatch (their own BC instance ignores their own posts).

import Dexie, { type ObservabilitySet, RangeSet } from 'dexie'
import type {
  ChatId,
  FolderId,
  KeyId,
  PresetId,
  ProfileId,
  PromptPresetId,
  TagId,
} from '../core/types'
import type { ChatMutationSummary, StreamLeaseRow } from './repository'

type EngineKind = 'daemon' | 'in-tab'
type AutoTitleStatus = 'auto' | 'auto-failed' | 'manual'
type StreamOutcome = 'done' | 'error' | 'abort'
type EngineDetachReason = 'daemon-offline' | 'tab-close' | 'shutdown'

export type BroadcastEvent =
  | {
      kind: 'chat-mutated'
      chatId: ChatId
      metaVersion: number
      summaryVersion: number
      affected: ChatMutationSummary[]
    }
  | { kind: 'chat-deleted'; chatId: ChatId }
  | { kind: 'branch-cache-refreshed'; chatId: ChatId }
  | { kind: 'profile-mutated'; profileId: ProfileId }
  | { kind: 'profile-deleted'; profileId: ProfileId }
  | { kind: 'preset-mutated'; presetId: PresetId }
  | { kind: 'preset-deleted'; presetId: PresetId }
  | { kind: 'prompt-preset-mutated'; promptPresetId: PromptPresetId }
  | { kind: 'prompt-preset-deleted'; promptPresetId: PromptPresetId }
  | { kind: 'folder-mutated'; folderId: FolderId }
  | { kind: 'folder-deleted'; folderId: FolderId }
  | { kind: 'tag-mutated'; tagId: TagId }
  | { kind: 'tag-deleted'; tagId: TagId }
  | { kind: 'autotitle-completed'; chatId: ChatId; status: AutoTitleStatus }
  | { kind: 'key-rotated'; keyId: KeyId }
  | { kind: 'settings-mutated'; key: string }
  | { kind: 'workspace-replaced'; replacementEpoch: number }
  | { kind: 'workspace-invalidated'; mutationCounter: number }
  | { kind: 'privacy-refreshed'; profileId: ProfileId; modelId: string }
  | { kind: 'models-refreshed'; profileId: ProfileId }
  | {
      kind: 'stream-started'
      chatId: ChatId
      streamId: string
      messageId?: string
      attemptKind?: 'generation' | 'continuation'
      ownerClientId: string
      replacementEpoch: number
    }
  | { kind: 'stream-heartbeat'; lease: StreamLeaseRow }
  | {
      kind: 'stream-abort-requested'
      chatId: ChatId
      streamId: string
      ownerClientId: string
      replacementEpoch: number
    }
  | {
      kind: 'stream-ended'
      chatId: ChatId
      streamId: string
      messageId?: string
      outcome: StreamOutcome
      replacementEpoch: number
    }
  | { kind: 'engine-attached'; engineKind: EngineKind; version: string }
  | { kind: 'engine-detached'; reason: EngineDetachReason }

export type BroadcastDelivery = 'local' | 'remote'
type BroadcastHandler = (event: BroadcastEvent, delivery: BroadcastDelivery) => void
type FallbackSnapshotReader = () => Promise<{
  db: Dexie
  mutationCounter: number
  replacementEpoch?: number
}>

const CHANNEL_NAME = 'llm-api-frontend'
const FALLBACK_POLL_INTERVAL_MS = 1_000

let channel: BroadcastChannel | null = null
let channelUnavailable = false
const localSubs = new Set<BroadcastHandler>()
let fallbackPollTimer: ReturnType<typeof setTimeout> | null = null
let fallbackPollActive = false
let fallbackPollInFlight = false
let fallbackPollGeneration = 0
let lastMutationCounter: number | null = null
let lastReplacementEpoch: number | null = null
let productionFallbackSnapshotReader: FallbackSnapshotReader | null = null
let fallbackSnapshotReader: FallbackSnapshotReader = readFallbackSnapshot

function ensureChannel(): BroadcastChannel | null {
  if (channel !== null) return channel
  if (channelUnavailable || typeof BroadcastChannel === 'undefined') {
    channelUnavailable = true
    startFallbackPolling()
    return null
  }
  let next: BroadcastChannel | null = null
  try {
    next = new BroadcastChannel(CHANNEL_NAME)
    next.addEventListener('message', (msg: MessageEvent) => {
      if (isEpochFencedBroadcastEvent(msg.data)) fanOutLocal(msg.data, 'remote')
    })
    next.addEventListener('messageerror', () => {
      makeChannelUnavailable(next)
    })
    channel = next
    return channel
  } catch {
    closeChannel(next)
    makeChannelUnavailable(null)
    return null
  }
}

function isEpochFencedBroadcastEvent(value: unknown): value is BroadcastEvent {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { kind?: unknown }).kind !== 'string'
  ) {
    return false
  }
  const event = value as { kind: string; replacementEpoch?: unknown; lease?: unknown }
  if (event.kind === 'stream-heartbeat') {
    const lease = event.lease
    return (
      !!lease &&
      typeof lease === 'object' &&
      isReplacementEpoch((lease as { replacementEpoch?: unknown }).replacementEpoch)
    )
  }
  if (
    event.kind === 'workspace-replaced' ||
    event.kind === 'stream-started' ||
    event.kind === 'stream-abort-requested' ||
    event.kind === 'stream-ended'
  ) {
    return isReplacementEpoch(event.replacementEpoch)
  }
  return true
}

function isReplacementEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function isBroadcastChannelAvailable(): boolean {
  return ensureChannel() !== null
}

function closeChannel(target: BroadcastChannel | null): void {
  try {
    target?.close()
  } catch {
    // A broken transport must not escape notification cleanup.
  }
}

function makeChannelUnavailable(target: BroadcastChannel | null): void {
  if (target !== null && channel !== target) return
  closeChannel(channel)
  channel = null
  channelUnavailable = true
  startFallbackPolling()
}

function retryChannelPost(event: BroadcastEvent, failedChannel: BroadcastChannel): void {
  if (channel !== failedChannel) return
  closeChannel(failedChannel)
  channel = null
  const retry = ensureChannel()
  if (!retry) return
  try {
    retry.postMessage(event)
  } catch {
    makeChannelUnavailable(retry)
  }
}

function fanOutLocal(event: BroadcastEvent, delivery: BroadcastDelivery): void {
  for (const handler of [...localSubs]) {
    try {
      handler(event, delivery)
    } catch {
      // Broadcast delivery is post-commit notification; subscriber failures are isolated.
    }
  }
}

export function postEvent(event: BroadcastEvent): void {
  const bc = ensureChannel()
  if (bc) {
    try {
      bc.postMessage(event)
    } catch {
      retryChannelPost(event, bc)
    }
  }
  fanOutLocal(event, 'local')
}

export function onEvent(handler: BroadcastHandler): () => void {
  const bc = ensureChannel()
  localSubs.add(handler)
  if (!bc) startFallbackPolling()
  return () => {
    localSubs.delete(handler)
    if (localSubs.size === 0) stopFallbackPolling()
  }
}

export function __resetBroadcastForTests(): void {
  stopFallbackPolling()
  closeChannel(channel)
  channel = null
  channelUnavailable = false
  localSubs.clear()
  fallbackSnapshotReader = readFallbackSnapshot
}

export function __setBroadcastFallbackReaderForTests(reader: FallbackSnapshotReader | null): void {
  fallbackSnapshotReader = reader ?? readFallbackSnapshot
}

export function configureBroadcastFallbackReader(reader: FallbackSnapshotReader): void {
  productionFallbackSnapshotReader = reader
}

function startFallbackPolling(): void {
  if (fallbackPollActive || channel !== null || localSubs.size === 0) return
  fallbackPollActive = true
  const generation = ++fallbackPollGeneration
  void pollWorkspaceMeta(generation)
}

function stopFallbackPolling(): void {
  fallbackPollActive = false
  fallbackPollGeneration += 1
  lastMutationCounter = null
  lastReplacementEpoch = null
  if (fallbackPollTimer !== null) clearTimeout(fallbackPollTimer)
  fallbackPollTimer = null
}

async function pollWorkspaceMeta(generation: number): Promise<void> {
  if (!fallbackPollShouldRun(generation)) return
  if (fallbackPollInFlight) {
    scheduleFallbackPoll(generation)
    return
  }

  fallbackPollInFlight = true
  try {
    const { db, mutationCounter, replacementEpoch } = await fallbackSnapshotReader()
    if (!fallbackPollShouldRun(generation)) return
    if (mutationCounter === lastMutationCounter) return
    const replacementChanged =
      replacementEpoch !== undefined &&
      lastReplacementEpoch !== null &&
      replacementEpoch !== lastReplacementEpoch
    lastMutationCounter = mutationCounter
    if (replacementEpoch !== undefined) lastReplacementEpoch = replacementEpoch
    fireBroadDexieInvalidation(db)
    const event: BroadcastEvent = replacementChanged
      ? { kind: 'workspace-replaced', replacementEpoch }
      : { kind: 'workspace-invalidated', mutationCounter }
    fanOutLocal(event, 'remote')
  } catch {
    // A transient open/read failure must not stop later cross-tab checks.
  } finally {
    fallbackPollInFlight = false
    if (fallbackPollShouldRun(generation)) scheduleFallbackPoll(generation)
  }
}

function fallbackPollShouldRun(generation: number): boolean {
  return (
    fallbackPollActive &&
    fallbackPollGeneration === generation &&
    channel === null &&
    localSubs.size > 0
  )
}

function scheduleFallbackPoll(generation: number): void {
  if (!fallbackPollShouldRun(generation) || fallbackPollTimer !== null) return
  fallbackPollTimer = setTimeout(() => {
    fallbackPollTimer = null
    void pollWorkspaceMeta(generation)
  }, FALLBACK_POLL_INTERVAL_MS)
}

function fireBroadDexieInvalidation(db: Dexie): void {
  Dexie.on.storagemutated.fire(buildBroadDexieObservabilitySet(db))
}

export function __buildBroadDexieObservabilitySetForTests(db: Dexie): ObservabilitySet {
  return buildBroadDexieObservabilitySet(db)
}

function buildBroadDexieObservabilitySet(db: Dexie): ObservabilitySet {
  const parts: ObservabilitySet = {}
  for (const table of db.tables) {
    const tablePart = `idb://${db.name}/${table.name}/`
    parts[tablePart] = fullKeyRange()
    parts[`${tablePart}:dels`] = fullKeyRange()
    for (const index of table.schema.indexes) {
      if (index.name) parts[`${tablePart}${index.name}`] = fullKeyRange()
    }
  }
  return parts
}

function fullKeyRange(): RangeSet {
  return new RangeSet(Dexie.minKey, Dexie.maxKey)
}

async function readFallbackSnapshot(): Promise<{
  db: Dexie
  mutationCounter: number
  replacementEpoch?: number
}> {
  if (!productionFallbackSnapshotReader) throw new Error('BroadcastFallbackReaderUnavailable')
  return productionFallbackSnapshotReader()
}
