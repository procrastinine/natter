import { buildContinuationAttempt } from '../core/continuation-attempt'
import { appendContinuationText } from '../core/continuation-content'
import { replayStreamAccumulator } from '../core/stream-accumulator'
import type { ContentItem, Message, MessageId } from '../core/types'
import type { StreamLeaseRow, WorkspaceRepository } from './repository'
import {
  announceStreamEnded,
  isFreshStreamLease,
  isRecoveryClaimedStreamLease,
  streamOwnershipLocksSupported,
  streamWriteFenceForLease,
  withStreamRecoveryLocks,
} from './stream-leases'

export async function recoverStaleContinuationAttempts(input: {
  repo: WorkspaceRepository
  leases: readonly StreamLeaseRow[]
  now: number
  isTargetActive: (chatId: string, messageId: MessageId) => boolean
}): Promise<number> {
  let recovered = 0
  for (const lease of input.leases) {
    if (
      lease.attemptKind !== 'continuation' ||
      (isFreshStreamLease(lease, input.now) &&
        !streamOwnershipLocksSupported() &&
        !isRecoveryClaimedStreamLease(lease))
    ) {
      continue
    }
    if (!lease.messageId) {
      const guarded = await withStreamRecoveryLocks([lease.streamId], async (ownershipVerified) => {
        const currentLease = (await input.repo.listStreamLeases(lease.chatId)).find(
          (candidate) => candidate.streamId === lease.streamId,
        )
        if (
          !currentLease ||
          (isFreshStreamLease(currentLease, input.now) &&
            !ownershipVerified &&
            !isRecoveryClaimedStreamLease(currentLease))
        ) {
          return
        }
        const claimed = await input.repo.claimStreamLeaseForRecovery(currentLease, input.now)
        if (!claimed) return false
        await discardAttemptRows(input.repo, claimed)
        return true
      })
      if (guarded.acquired && guarded.value) recovered += 1
      continue
    }
    if (input.isTargetActive(lease.chatId, lease.messageId)) continue

    const guarded = await withStreamRecoveryLocks([lease.streamId], async (ownershipVerified) => {
      if (input.isTargetActive(lease.chatId, lease.messageId as MessageId)) return false
      const currentLease = (await input.repo.listStreamLeases(lease.chatId)).find(
        (candidate) => candidate.streamId === lease.streamId,
      )
      if (
        !currentLease ||
        (isFreshStreamLease(currentLease, input.now) &&
          !ownershipVerified &&
          !isRecoveryClaimedStreamLease(currentLease))
      ) {
        return false
      }
      const claimedLease = await input.repo.claimStreamLeaseForRecovery(currentLease, input.now)
      if (!claimedLease?.messageId) return false
      const chunks = await input.repo.listStreamChunks(lease.streamId)
      const result = { finalized: false }
      await input.repo.runMutation(
        [{ kind: 'message', messageId: claimedLease.messageId }],
        async (ctx) => {
          const current = await ctx.getMessage(claimedLease.messageId as MessageId)
          if (!current || current.chatId !== claimedLease.chatId) return
          if (
            current.continuationAttempts?.some(
              (attempt) => attempt.streamId === claimedLease.streamId,
            )
          ) {
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
            !baseVersionMatches(claimedLease, current) && streamedText ? streamedText : undefined
          const attempt = buildContinuationAttempt({
            streamId: claimedLease.streamId,
            strategy: claimedLease.continuationStrategy ?? 'unknown',
            status,
            ...(claimedLease.requestedModel ? { requestedModel: claimedLease.requestedModel } : {}),
            ...(claimedLease.apiUsed ? { apiUsed: claimedLease.apiUsed } : {}),
            startedAt: claimedLease.startedAt,
            finishedAt: input.now,
            accumulator: replayed.accumulator,
            ...(status === 'interrupted' ? { abortReason: 'tab-close' as const } : {}),
            ...(unappliedText ? { unappliedText } : {}),
          })
          const baseUnchanged = baseVersionMatches(claimedLease, current)
          const nextContent =
            baseUnchanged && streamedText.length > 0
              ? appendContinuationText(current.content, streamedText)
              : current.content
          await ctx.putMessage({
            ...current,
            content: nextContent,
            continuationAttempts: [...(current.continuationAttempts ?? []), attempt],
          })
          result.finalized = true
        },
        {
          streamFence: {
            streamId: claimedLease.streamId,
            fence: streamWriteFenceForLease(claimedLease),
          },
        },
      )
      if (!result.finalized) return false
      await discardAttemptRows(input.repo, claimedLease)
      return true
    })
    if (guarded.acquired && guarded.value) recovered += 1
  }
  return recovered
}

function baseVersionMatches(lease: StreamLeaseRow, message: Message): boolean {
  return lease.baseNodeVersion === undefined || message.nodeVersion === lease.baseNodeVersion
}

function textFromContent(content: readonly ContentItem[]): string {
  let text = ''
  for (const item of content) {
    if (item.type === 'text' || item.type === 'output_text') text += item.text
  }
  return text
}

async function discardAttemptRows(repo: WorkspaceRepository, lease: StreamLeaseRow): Promise<void> {
  await repo.deleteStreamChunks(lease.streamId)
  await repo.deleteStreamLease(lease.streamId)
  announceStreamEnded({
    chatId: lease.chatId,
    streamId: lease.streamId,
    ...(lease.messageId ? { messageId: lease.messageId } : {}),
    outcome: 'abort',
  })
}
