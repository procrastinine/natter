import { buildContinuationAttempt } from '../core/continuation-attempt'
import { appendContinuationText } from '../core/continuation-content'
import { replayStreamAccumulator } from '../core/stream-accumulator'
import type { ContentItem, MessageId } from '../core/types'
import type { MessageHeaderRow } from './message-storage'
import {
  type StreamLeaseRow,
  streamLeaseOwnsTargetWrites,
  type WorkspaceRepository,
} from './repository'
import {
  announceStreamEnded,
  isFreshStreamLease,
  isRecoveryClaimedStreamLease,
  newestStreamLeaseByAdmission,
  streamLeaseRecoveryKind,
  streamOwnershipLocksSupported,
  streamWriteFenceForLease,
  withStreamRecoveryLocks,
} from './stream-leases'
import type { CommittedMessagePresentation } from './zustand/chatStore'

interface ContinuationRecoveryInput {
  repo: WorkspaceRepository
  leases: readonly StreamLeaseRow[]
  now: number
  isTargetActive: (chatId: string, messageId: MessageId) => boolean
  isRecoveryPending?: (streamId: string) => boolean
  recoveryOutcome?: (streamId: string) => 'done' | 'error' | 'abort' | undefined
  onRecoveredPresentation?: (chatId: string, presentation: CommittedMessagePresentation) => void
}

export async function recoverStaleContinuationAttempts(
  input: ContinuationRecoveryInput,
): Promise<number> {
  const targetedMessageIds = new Set<MessageId>()
  const messageLess: StreamLeaseRow[] = []
  for (const lease of input.leases) {
    if (streamLeaseRecoveryKind(lease) !== 'continuation') continue
    if (!lease.messageId) {
      messageLess.push(lease)
      continue
    }
    targetedMessageIds.add(lease.messageId)
  }
  const targeted = new Map<MessageId, StreamLeaseRow[]>()
  for (const lease of input.leases) {
    if (!lease.messageId || !targetedMessageIds.has(lease.messageId)) continue
    const group = targeted.get(lease.messageId)
    if (group) group.push(lease)
    else targeted.set(lease.messageId, [lease])
  }

  let recovered = 0
  for (const lease of messageLess) {
    if (await recoverMessageLessContinuation(input, lease)) recovered += 1
  }
  for (const [messageId, leases] of targeted) {
    if (await recoverTargetedContinuations(input, messageId, leases)) recovered += 1
  }
  return recovered
}

async function recoverMessageLessContinuation(
  input: ContinuationRecoveryInput,
  lease: StreamLeaseRow,
): Promise<boolean> {
  if (
    isFreshStreamLease(lease, input.now) &&
    !streamOwnershipLocksSupported() &&
    !isRecoveryClaimedStreamLease(lease) &&
    !input.isRecoveryPending?.(lease.streamId)
  ) {
    return false
  }
  const guarded = await withStreamRecoveryLocks([lease.streamId], async (ownershipVerified) => {
    const currentLease = await input.repo.getStreamLease(lease.streamId)
    if (
      !currentLease ||
      streamLeaseRecoveryKind(currentLease) !== 'continuation' ||
      currentLease.messageId !== undefined ||
      recoveryMustWait(input, currentLease, ownershipVerified)
    ) {
      return false
    }
    const claimed = await input.repo.claimStreamLeaseForRecovery(currentLease, input.now)
    if (!claimed) return false
    await discardAttemptRows(
      input.repo,
      claimed,
      input.recoveryOutcome?.(claimed.streamId) ?? 'abort',
    )
    return true
  })
  return guarded.acquired && guarded.value
}

async function recoverTargetedContinuations(
  input: ContinuationRecoveryInput,
  messageId: MessageId,
  initialLeases: readonly StreamLeaseRow[],
): Promise<boolean> {
  const initialLease = initialLeases[0]
  if (!initialLease) return false
  const initialChunks = await input.repo.listStreamChunksForMessage(messageId)
  const guardedStreamIds = new Set([
    ...initialLeases.map((lease) => lease.streamId),
    ...initialChunks.map((chunk) => chunk.streamId),
  ])
  const guarded = await withStreamRecoveryLocks(
    [...guardedStreamIds],
    async (ownershipVerified) => {
      const currentHeader = await input.repo.getMessageHeader(messageId)
      if (currentHeader?.generation && currentHeader.generation.finishedAt === undefined) {
        return false
      }
      const currentLeases = await input.repo.listStreamLeasesForMessage(messageId)
      if (
        currentLeases.some(
          (lease) =>
            !guardedStreamIds.has(lease.streamId) ||
            recoveryMustWait(input, lease, ownershipVerified),
        ) ||
        currentLeases.some(
          (lease) =>
            streamLeaseOwnsTargetWrites(lease) && input.isTargetActive(lease.chatId, messageId),
        )
      ) {
        return false
      }
      const currentChunks = await input.repo.listStreamChunksForMessage(messageId)
      if (currentChunks.some((chunk) => !guardedStreamIds.has(chunk.streamId))) return false

      const claimedLeases: StreamLeaseRow[] = []
      for (const currentLease of [...currentLeases].sort((left, right) =>
        left.streamId.localeCompare(right.streamId),
      )) {
        const claimed = await input.repo.claimStreamLeaseForRecovery(currentLease, input.now)
        if (!claimed) return false
        claimedLeases.push(claimed)
      }
      const primary = newestStreamLeaseByAdmission(
        claimedLeases.filter(
          (lease) =>
            streamLeaseRecoveryKind(lease) === 'continuation' && streamLeaseOwnsTargetWrites(lease),
        ),
      )
      const claimedByStreamId = new Map(claimedLeases.map((claimed) => [claimed.streamId, claimed]))
      const journalStreamIds = new Set([
        ...claimedLeases.map((claimed) => claimed.streamId),
        ...currentChunks.map((chunk) => chunk.streamId),
      ])
      if (!primary) {
        if (journalStreamIds.size === 0) return false
        const anchorStreamId = newestStreamLeaseByAdmission(claimedLeases)?.streamId
        await cleanupContinuationJournals({
          input,
          chatId: initialLease.chatId,
          messageId,
          streamIds: journalStreamIds,
          claimedByStreamId,
          removedLeaseIds: new Set(),
          ...(anchorStreamId ? { anchorStreamId } : {}),
        })
        return true
      }

      const removedLeaseIds = new Set<string>()
      for (const claimed of claimedLeases) {
        if (claimed.streamId === primary.streamId) continue
        await input.repo.deleteOwnedStreamLease(claimed.streamId, streamWriteFenceForLease(claimed))
        removedLeaseIds.add(claimed.streamId)
      }
      const chunks = currentChunks.filter((chunk) => chunk.streamId === primary.streamId)
      const result = await commitRecoveredContinuation(input, primary, chunks)
      if (result.presentation) {
        input.onRecoveredPresentation?.(primary.chatId, result.presentation)
      }
      await cleanupContinuationJournals({
        input,
        chatId: primary.chatId,
        messageId,
        streamIds: journalStreamIds,
        claimedByStreamId,
        removedLeaseIds,
        anchorStreamId: primary.streamId,
      })
      return result.finalized
    },
  )
  return guarded.acquired && guarded.value
}

async function commitRecoveredContinuation(
  input: ContinuationRecoveryInput,
  primary: StreamLeaseRow,
  chunks: Awaited<ReturnType<WorkspaceRepository['listStreamChunks']>>,
): Promise<{ finalized: boolean; presentation?: CommittedMessagePresentation }> {
  const messageId = primary.messageId as MessageId
  const result: { finalized: boolean; presentation?: CommittedMessagePresentation } = {
    finalized: false,
  }
  await input.repo.runMutation(
    [{ kind: 'message', messageId }],
    async (ctx) => {
      const currentHeader = await ctx.getMessageHeader(messageId)
      const current = await ctx.getMessage(messageId)
      if (
        !currentHeader ||
        !current ||
        current.chatId !== primary.chatId ||
        currentHeader.chatId !== primary.chatId
      ) {
        result.finalized = true
        return
      }
      if (current.continuationAttempts?.some((attempt) => attempt.streamId === primary.streamId)) {
        result.presentation = {
          header: currentHeader,
          message: current,
          bodyVersion: currentHeader.bodyVersion,
        }
        result.finalized = true
        return
      }

      const replayed = replayStreamAccumulator({
        initialContent: [],
        entries: chunks,
        now: input.now,
      })
      const status = replayed.accumulator.midStreamError
        ? 'error'
        : replayed.finishedCleanly
          ? 'done'
          : 'interrupted'
      const streamedText = textFromContent(replayed.final.content)
      const unappliedText =
        !baseVersionMatches(primary, currentHeader) && streamedText ? streamedText : undefined
      const attempt = buildContinuationAttempt({
        streamId: primary.streamId,
        strategy: primary.continuationStrategy ?? 'unknown',
        status,
        ...(primary.requestedModel ? { requestedModel: primary.requestedModel } : {}),
        ...(primary.apiUsed ? { apiUsed: primary.apiUsed } : {}),
        startedAt: primary.startedAt,
        finishedAt: input.now,
        accumulator: replayed.accumulator,
        ...(status === 'interrupted' ? { abortReason: 'tab-close' as const } : {}),
        ...(unappliedText ? { unappliedText } : {}),
      })
      const nextContent =
        baseVersionMatches(primary, currentHeader) && streamedText.length > 0
          ? appendContinuationText(current.content, streamedText)
          : current.content
      await ctx.putMessage({
        ...current,
        content: nextContent,
        continuationAttempts: [...(current.continuationAttempts ?? []), attempt],
      })
      const [committedHeader, committedMessage] = await Promise.all([
        ctx.getMessageHeader(messageId),
        ctx.getMessage(messageId),
      ])
      if (committedHeader && committedMessage) {
        result.presentation = {
          header: committedHeader,
          message: committedMessage,
          bodyVersion: committedHeader.bodyVersion,
        }
      }
      result.finalized = true
    },
    {
      streamFence: {
        streamId: primary.streamId,
        fence: streamWriteFenceForLease(primary),
      },
    },
  )
  return result
}

async function cleanupContinuationJournals(args: {
  input: ContinuationRecoveryInput
  chatId: string
  messageId: MessageId
  streamIds: ReadonlySet<string>
  claimedByStreamId: ReadonlyMap<string, StreamLeaseRow>
  removedLeaseIds: ReadonlySet<string>
  anchorStreamId?: string
}): Promise<void> {
  const anchorLease = args.anchorStreamId
    ? args.claimedByStreamId.get(args.anchorStreamId)
    : undefined
  const fallbackReplacementEpoch = anchorLease
    ? streamWriteFenceForLease(anchorLease).replacementEpoch
    : (await args.input.repo.getWorkspaceMeta()).replacementEpoch
  const streamIds = [...args.streamIds].sort()
  if (args.anchorStreamId && args.streamIds.has(args.anchorStreamId)) {
    const anchorIndex = streamIds.indexOf(args.anchorStreamId)
    streamIds.splice(anchorIndex, 1)
    streamIds.push(args.anchorStreamId)
  }
  for (const streamId of streamIds) {
    const claimed = args.claimedByStreamId.get(streamId)
    const claimedFence = claimed ? streamWriteFenceForLease(claimed) : undefined
    const retainedFence =
      claimedFence && !args.removedLeaseIds.has(streamId) ? claimedFence : undefined
    await args.input.repo.deleteStreamJournal(streamId, {
      replacementEpoch: claimedFence?.replacementEpoch ?? fallbackReplacementEpoch,
      ...(retainedFence ? { streamFence: retainedFence } : { expectedLeaseMissing: true as const }),
    })
    announceStreamEnded({
      chatId: claimed?.chatId ?? args.chatId,
      streamId,
      messageId: claimed?.messageId ?? args.messageId,
      outcome: args.input.recoveryOutcome?.(streamId) ?? 'abort',
      replacementEpoch: claimedFence?.replacementEpoch ?? fallbackReplacementEpoch,
    })
  }
}

function recoveryMustWait(
  input: ContinuationRecoveryInput,
  lease: StreamLeaseRow,
  ownershipVerified: boolean,
): boolean {
  return (
    isFreshStreamLease(lease, input.now) &&
    !ownershipVerified &&
    !isRecoveryClaimedStreamLease(lease) &&
    !input.isRecoveryPending?.(lease.streamId)
  )
}

function baseVersionMatches(
  lease: StreamLeaseRow,
  header: Pick<MessageHeaderRow, 'bodyVersion' | 'nodeVersion'>,
): boolean {
  if (lease.baseBodyVersion !== undefined) return header.bodyVersion === lease.baseBodyVersion
  return lease.baseNodeVersion === undefined || header.nodeVersion === lease.baseNodeVersion
}

function textFromContent(content: readonly ContentItem[]): string {
  let text = ''
  for (const item of content) {
    if (item.type === 'text' || item.type === 'output_text') text += item.text
  }
  return text
}

async function discardAttemptRows(
  repo: WorkspaceRepository,
  lease: StreamLeaseRow,
  outcome: 'done' | 'error' | 'abort',
): Promise<void> {
  const fence = streamWriteFenceForLease(lease)
  await repo.deleteStreamJournal(lease.streamId, {
    replacementEpoch: fence.replacementEpoch,
    streamFence: fence,
  })
  announceStreamEnded({
    chatId: lease.chatId,
    streamId: lease.streamId,
    ...(lease.messageId ? { messageId: lease.messageId } : {}),
    outcome,
    replacementEpoch: fence.replacementEpoch,
  })
}
