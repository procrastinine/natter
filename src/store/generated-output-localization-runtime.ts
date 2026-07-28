import { downloadGeneratedOutput, pollGeneratedVideoOutput } from '../api/generated-output'
import {
  type GeneratedOutputKind,
  localizedGeneratedOutputFilename,
  withGeneratedOutputLocalizationJob,
} from '../core/generated-output-localization'
import type { Attachment } from '../core/types'
import { errorFromUnknown } from '../lib/error'
import { newId } from '../lib/ulid'
import { prepareAttachmentBytes, prepareRemoteAttachment } from './attachments'
import { resolveCapturedKeyProofForUse } from './keys'
import { subscribeWorkspaceEffects, WORKSPACE_EFFECT_RECOVERY_OWNED } from './workspace-effect-hub'
import type {
  GeneratedOutputLocalizationClaim,
  GeneratedOutputLocalizationTarget,
} from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import {
  isWorkspaceRuntimeClosedError,
  runWorkspaceAction,
  runWorkspaceRead,
  type WorkspaceWritePermit,
} from './workspace-runtime'

const MAX_CONCURRENCY = 2
const QUEUE_PAGE_SIZE = 8
const LEASE_TTL_MS = 5 * 60_000
const OPERATION_TIMEOUT_MS = 2 * 60_000
const VIDEO_POLL_RETRY_MS = 10_000
const MAX_RETRY_DELAY_MS = 5 * 60_000

let accepting = false
let generation = 0
let runtimeController: AbortController | null = null
let stopChanges: (() => void) | null = null
let pumpPromise: Promise<void> | null = null
let pumpAgain = false
let wakeTimer: ReturnType<typeof setTimeout> | null = null
let wakeTimerAt: number | null = null
const active = new Set<Promise<void>>()

export function startGeneratedOutputLocalizationRuntime(): void {
  if (accepting) {
    requestPump()
    return
  }
  accepting = true
  generation += 1
  runtimeController = new AbortController()
  stopChanges = subscribeWorkspaceEffects({
    owner: 'generated-output-localization-runtime',
    impactKinds: ['attachment-job'],
    replacements: false,
    apply: () => requestPump(),
    recover: () => {
      requestPump()
      return WORKSPACE_EFFECT_RECOVERY_OWNED
    },
  })
  requestPump()
}

export function closeGeneratedOutputLocalizationRuntime(): void {
  accepting = false
  generation += 1
  pumpAgain = false
  stopChanges?.()
  stopChanges = null
  clearWakeTimer()
  runtimeController?.abort(
    new DOMException('Generated output localization runtime closed', 'AbortError'),
  )
}

export function abortGeneratedOutputLocalizationRuntime(): void {
  runtimeController?.abort(new DOMException('Workspace replaced', 'AbortError'))
  runtimeController = null
}

export async function awaitGeneratedOutputLocalizationRuntimeIdle(): Promise<void> {
  for (;;) {
    const pump = pumpPromise
    const operations = [...active]
    await Promise.allSettled([...(pump ? [pump] : []), ...operations])
    if (pump === pumpPromise && pumpPromise === null && active.size === 0) return
  }
}

export function assertGeneratedOutputLocalizationRuntimeClosed(): void {
  if (accepting || stopChanges || wakeTimer !== null || active.size > 0 || pumpPromise) {
    throw new Error('GeneratedOutputLocalizationRuntimeNotClosed')
  }
}

export function resumeGeneratedOutputLocalizationRuntime(): void {
  // The runtime-opened phase starts work after repository reconciliation.
}

function requestPump(): void {
  if (!accepting) return
  if (pumpPromise) {
    pumpAgain = true
    return
  }
  const cycle = generation
  pumpPromise = Promise.resolve()
    .then(() => pump(cycle))
    .catch((error) => {
      if (!isWorkspaceRuntimeClosedError(error) && !isAbortError(error)) {
        console.error('Generated output localization queue failed', error)
      }
    })
    .finally(() => {
      pumpPromise = null
      if (pumpAgain && accepting && cycle === generation) {
        pumpAgain = false
        requestPump()
      }
    })
}

async function pump(cycle: number): Promise<void> {
  if (!isCurrent(cycle)) return
  const slots = MAX_CONCURRENCY - active.size
  if (slots <= 0) return
  const now = Date.now()
  const snapshot = await runWorkspaceRead(
    'repository-query',
    (permit) =>
      getWorkspaceRepository()
        .query(
          permit,
          {
            kind: 'generated-output.localization-queue',
            now,
            limit: Math.max(slots, QUEUE_PAGE_SIZE),
          },
          { signal: permit.signal },
        )
        .then((envelope) => envelope.value),
    runtimeController ? { signal: runtimeController.signal } : {},
  )
  if (!isCurrent(cycle)) return
  if (snapshot.nextWakeAt !== undefined) scheduleWake(snapshot.nextWakeAt)
  for (const target of snapshot.readyJobs.slice(0, slots)) startJob(target, cycle)
}

function startJob(target: GeneratedOutputLocalizationTarget, cycle: number): void {
  const operation = processJob(target, cycle)
    .catch((error) => {
      if (!isWorkspaceRuntimeClosedError(error) && !isAbortError(error)) {
        console.error('Generated output localization failed', error)
      }
    })
    .finally(() => {
      active.delete(operation)
      if (isCurrent(cycle)) requestPump()
    })
  active.add(operation)
}

async function processJob(target: GeneratedOutputLocalizationTarget, cycle: number): Promise<void> {
  if (!isCurrent(cycle)) return
  await runWorkspaceAction('attachment', (permit) => processJobWithPermit(target, cycle, permit))
}

async function processJobWithPermit(
  target: GeneratedOutputLocalizationTarget,
  cycle: number,
  permit: WorkspaceWritePermit,
): Promise<void> {
  if (!isCurrent(cycle)) return
  const now = Date.now()
  const leaseId = newId()
  const claim = await getWorkspaceRepository()
    .execute(permit, {
      kind: 'generated-output.localization-claim',
      input: { ...target, leaseId, now, leaseExpiresAt: now + LEASE_TTL_MS },
    })
    .then((commit) => commit.value)
  if (!claim) return
  if (!isCurrent(cycle)) {
    await retryClaim(
      claim.job.id,
      claim.attachment.id,
      claim.job.leaseId ?? leaseId,
      {
        code: 'workspace-transition',
        message: 'Generated output localization yielded to a workspace transition.',
      },
      0,
      cycle,
      permit,
      false,
    )
    return
  }
  try {
    await withOperationTimeout(cycle, permit.signal, async (signal) => {
      const network = await localizationNetworkContext(
        permit,
        claim.profileIds,
        claim.attachment.storage.kind === 'remote-url' ? claim.attachment.storage.url : '',
        claim.job.task.requestCredential,
        signal,
      )
      if (network.polling) {
        await processVideoPollingJob(claim, network.headers, signal, cycle, permit)
      } else {
        await processRemoteDownload(claim, network.headers, signal, permit)
      }
    })
  } catch (error) {
    if (permit.signal.aborted || isWorkspaceRuntimeClosedError(error)) return
    if (!isCurrent(cycle)) {
      await retryClaim(
        claim.job.id,
        claim.attachment.id,
        claim.job.leaseId ?? leaseId,
        {
          code: 'workspace-transition',
          message: 'Generated output localization yielded to a workspace transition.',
        },
        0,
        cycle,
        permit,
        false,
      )
      return
    }
    await retryClaim(
      claim.job.id,
      claim.attachment.id,
      claim.job.leaseId ?? leaseId,
      generatedOutputError(error),
      retryDelay(claim.job.attemptCount),
      cycle,
      permit,
      true,
    )
  }
}

async function processRemoteDownload(
  claim: GeneratedOutputLocalizationClaim,
  headers: Record<string, string>,
  signal: AbortSignal,
  permit: WorkspaceWritePermit,
): Promise<void> {
  const url = remoteClaimUrl(claim)
  const blob = await downloadGeneratedOutput(url, { headers, signal })
  signal.throwIfAborted()
  const kind = generatedOutputKind(claim.attachment)
  const mime = blob.type || claim.attachment.mime
  const bundle = await prepareAttachmentBytes({
    id: claim.attachment.id,
    blob,
    filename: localizedGeneratedOutputFilename(claim.attachment.filename, mime, kind),
    declaredMime: mime,
    origin: 'generated-output',
    sourceUrl: url,
    now: Date.now(),
  })
  signal.throwIfAborted()
  await getWorkspaceRepository().execute(permit, {
    kind: 'generated-output.localization-complete',
    input: {
      jobId: claim.job.id,
      attachmentId: claim.attachment.id,
      leaseId: claim.job.leaseId ?? '',
      bundle,
      now: Date.now(),
    },
  })
}

async function processVideoPollingJob(
  claim: GeneratedOutputLocalizationClaim,
  headers: Record<string, string>,
  signal: AbortSignal,
  cycle: number,
  permit: WorkspaceWritePermit,
): Promise<void> {
  const snapshot = await pollGeneratedVideoOutput(remoteClaimUrl(claim), { headers, signal })
  signal.throwIfAborted()
  if (snapshot.failureMessage) {
    await failClaim(
      claim.job.id,
      claim.attachment.id,
      claim.job.leaseId ?? '',
      { code: 'video-generation-failed', message: snapshot.failureMessage },
      cycle,
      permit,
    )
    return
  }
  if (snapshot.urls.length === 0) {
    await retryClaim(
      claim.job.id,
      claim.attachment.id,
      claim.job.leaseId ?? '',
      {
        code: 'video-generation-pending',
        message: `Video generation is ${snapshot.status}.`,
      },
      VIDEO_POLL_RETRY_MS,
      cycle,
      permit,
      true,
    )
    return
  }
  const now = Date.now()
  const bundles = snapshot.urls.map((url, index) =>
    withGeneratedOutputLocalizationJob(
      prepareRemoteAttachment({
        id: `${claim.attachment.id}:resolved:${index + 1}`,
        url,
        filename: `generated-video-${claim.attachment.id}-${index + 1}.mp4`,
        mime: 'video/mp4',
        kind: 'video',
        origin: 'generated-output',
        now,
      }),
      now,
      claim.job.task.requestCredential,
    ),
  )
  signal.throwIfAborted()
  const expansion = await getWorkspaceRepository()
    .execute(permit, {
      kind: 'generated-output.video-expand',
      input: {
        jobId: claim.job.id,
        attachmentId: claim.attachment.id,
        leaseId: claim.job.leaseId ?? '',
        attachmentBundles: bundles,
        now,
      },
    })
    .then((commit) => commit.value)
  if (expansion.outcome === 'plan-changed') {
    await retryClaim(
      claim.job.id,
      claim.attachment.id,
      claim.job.leaseId ?? '',
      {
        code: 'video-expansion-plan-changed',
        message: 'Video references changed while the generated output was being expanded.',
      },
      0,
      cycle,
      permit,
      false,
    )
  }
}

async function retryClaim(
  jobId: string,
  attachmentId: string,
  leaseId: string,
  error: { code: string; message: string },
  delayMs: number,
  cycle: number,
  permit: WorkspaceWritePermit,
  schedule: boolean,
): Promise<void> {
  if (schedule && !isCurrent(cycle)) return
  const now = Date.now()
  await getWorkspaceRepository().execute(permit, {
    kind: 'generated-output.localization-retry',
    input: {
      jobId,
      attachmentId,
      leaseId,
      error,
      nextAttemptAt: now + delayMs,
      now,
    },
  })
  if (schedule) scheduleWake(now + delayMs)
}

async function failClaim(
  jobId: string,
  attachmentId: string,
  leaseId: string,
  error: { code: string; message: string },
  cycle: number,
  permit: WorkspaceWritePermit,
): Promise<void> {
  if (!isCurrent(cycle)) return
  await getWorkspaceRepository().execute(permit, {
    kind: 'generated-output.localization-fail',
    input: { jobId, attachmentId, leaseId, error, now: Date.now() },
  })
}

async function localizationNetworkContext(
  permit: WorkspaceWritePermit,
  profileIds: readonly string[],
  url: string,
  requestCredential: { profileId: string; selectedKeyId: string } | undefined,
  signal: AbortSignal,
): Promise<{ headers: Record<string, string>; polling: boolean }> {
  const access = await getWorkspaceRepository()
    .query(
      permit,
      {
        kind: 'configuration.generated-output-network-access',
        profileIds,
        url,
        ...(requestCredential ? { requestCredential } : {}),
      },
      { signal },
    )
    .then((envelope) => envelope.value)
  if (access.profileKind !== 'openrouter' || !access.credentialKey) {
    return { headers: {}, polling: access.polling }
  }
  const credentialKey = access.credentialKey
  try {
    const apiKey = await resolveCapturedKeyProofForUse(credentialKey, {}, permit)
    signal.throwIfAborted()
    return { headers: { Authorization: `Bearer ${apiKey}` }, polling: access.polling }
  } catch {
    return { headers: {}, polling: access.polling }
  }
}

function generatedOutputKind(attachment: Pick<Attachment, 'kind'>): GeneratedOutputKind {
  if (attachment.kind === 'image') return 'image'
  if (attachment.kind === 'audio') return 'audio'
  if (attachment.kind === 'video') return 'video'
  return 'file'
}

function remoteClaimUrl(claim: GeneratedOutputLocalizationClaim): string {
  if (claim.attachment.storage.kind !== 'remote-url') {
    throw new Error(`GeneratedOutputLocalizationStorage:${claim.attachment.id}`)
  }
  return claim.attachment.storage.url
}

async function withOperationTimeout<T>(
  cycle: number,
  permitSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const runtimeSignal = runtimeController?.signal
  const abortRuntime = () => controller.abort(runtimeSignal?.reason)
  const abortPermit = () => controller.abort(permitSignal.reason)
  runtimeSignal?.addEventListener('abort', abortRuntime, { once: true })
  permitSignal.addEventListener('abort', abortPermit, { once: true })
  const timer = setTimeout(
    () =>
      controller.abort(new DOMException('Generated output localization timed out', 'TimeoutError')),
    OPERATION_TIMEOUT_MS,
  )
  try {
    permitSignal.throwIfAborted()
    if (!isCurrent(cycle)) throw new DOMException('Workspace replaced', 'AbortError')
    return await operation(controller.signal)
  } finally {
    clearTimeout(timer)
    runtimeSignal?.removeEventListener('abort', abortRuntime)
    permitSignal.removeEventListener('abort', abortPermit)
  }
}

function retryDelay(attemptCount: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 5_000 * 2 ** Math.min(6, Math.max(0, attemptCount - 1)))
}

function generatedOutputError(error: unknown): { code: string; message: string } {
  const normalized = errorFromUnknown(error)
  return {
    code: normalized.name || 'GeneratedOutputLocalizationError',
    message: normalized.message.slice(0, 500),
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isCurrent(cycle: number): boolean {
  return accepting && cycle === generation && runtimeController?.signal.aborted === false
}

function scheduleWake(at: number): void {
  if (!accepting) return
  if (wakeTimerAt !== null && wakeTimerAt <= at) return
  clearWakeTimer()
  wakeTimerAt = at
  wakeTimer = setTimeout(
    () => {
      wakeTimer = null
      wakeTimerAt = null
      requestPump()
    },
    Math.max(0, Math.min(2_147_483_647, at - Date.now())),
  )
}

function clearWakeTimer(): void {
  if (wakeTimer !== null) clearTimeout(wakeTimer)
  wakeTimer = null
  wakeTimerAt = null
}
