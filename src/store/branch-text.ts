import { branchMessageTextSegments } from '../core/branch-flatten'
import {
  fixedConversationSelectionTarget,
  resolvingConversationSelectionTarget,
} from '../core/messages'
import { TRANSCRIPT_BODY_READ_BATCH_ROWS } from '../core/transcript-work-budget'
import { TreeChangedError } from '../core/tree-ops'
import type { Chat, ChatId, MessageId } from '../core/types'
import { joinKnownBranchPageMaterial } from './repository'
import type { WorkspaceReadAuthority, WorkspaceRepository } from './workspace-protocol'

export interface LastUpdatedBranchText {
  readonly chat: Chat
  readonly branchLeafId: MessageId | null
  readonly textContent: string
}

export interface BranchTextConsumer {
  reset(chat: Chat, branchLeafId: MessageId | null): void
  push(segment: string): void
}

export type LastUpdatedBranchSnapshot = Omit<LastUpdatedBranchText, 'textContent'>

export async function consumeLastUpdatedBranchText(
  repo: WorkspaceRepository,
  authority: WorkspaceReadAuthority,
  chatId: ChatId,
  consumer: BranchTextConsumer,
  signal: AbortSignal = authority.signal,
): Promise<LastUpdatedBranchSnapshot | undefined> {
  return consumeCanonicalBranchText(
    repo,
    authority,
    chatId,
    { kind: 'last-updated' },
    consumer,
    signal,
  )
}

async function consumeBranchText(
  repo: WorkspaceRepository,
  authority: WorkspaceReadAuthority,
  chatId: ChatId,
  branchLeafId: MessageId | null,
  consumer: BranchTextConsumer,
  signal: AbortSignal = authority.signal,
): Promise<LastUpdatedBranchSnapshot | undefined> {
  return consumeCanonicalBranchText(
    repo,
    authority,
    chatId,
    { kind: 'fixed', branchLeafId },
    consumer,
    signal,
  )
}

async function consumeCanonicalBranchText(
  repo: WorkspaceRepository,
  authority: WorkspaceReadAuthority,
  chatId: ChatId,
  selection:
    | { readonly kind: 'last-updated' }
    | { readonly kind: 'fixed'; readonly branchLeafId: MessageId | null },
  consumer: BranchTextConsumer,
  signal: AbortSignal,
): Promise<LastUpdatedBranchSnapshot | undefined> {
  readAttempt: for (;;) {
    const requestedLeafId = selection.kind === 'fixed' ? selection.branchLeafId : null
    const source = await repo.query(
      authority,
      {
        kind: 'branch.open',
        chatId,
        target:
          selection.kind === 'last-updated'
            ? resolvingConversationSelectionTarget({ kind: 'default' })
            : fixedConversationSelectionTarget(
                requestedLeafId === null
                  ? { kind: 'default' }
                  : { kind: 'tip', messageId: requestedLeafId },
                requestedLeafId,
              ),
        bodyDemand: 'none',
      },
      { signal },
    )
    const snapshot = source.value
    if (snapshot.kind === 'missing') return undefined
    if (snapshot.kind === 'unavailable') {
      if (selection.kind === 'fixed') return undefined
      throw new TreeChangedError(chatId, `last-updated branch unavailable:${snapshot.reason}`)
    }
    if (snapshot.kind === 'stale') {
      if (selection.kind === 'fixed') return undefined
      throw new TreeChangedError(chatId, 'last-updated branch unexpectedly stale')
    }
    const chat = snapshot.chat
    const branchLeafId = snapshot.proof.tipId
    if (
      (selection.kind === 'last-updated' && chat.lastUpdatedLeafId !== branchLeafId) ||
      (selection.kind === 'fixed' && selection.branchLeafId !== branchLeafId)
    ) {
      continue
    }
    consumer.reset(chat, branchLeafId)
    if (branchLeafId !== null) {
      const headers = snapshot.proof.pathHeaders
      if (headers.at(-1)?.id !== branchLeafId) continue

      let hasMessage = false
      for (let offset = 0; offset < headers.length; offset += TRANSCRIPT_BODY_READ_BATCH_ROWS) {
        const nodes = headers.slice(offset, offset + TRANSCRIPT_BODY_READ_BATCH_ROWS)
        const [pageEnvelope, materialEnvelope] = await Promise.all([
          repo.query(
            authority,
            {
              kind: 'branch.page-structure',
              chatId,
              resolvedTipId: branchLeafId,
              structuralVersion: snapshot.proof.structuralVersion,
              window: {
                branchLength: headers.length,
                offset,
                limit: nodes.length,
                boundaryParentId: offset === 0 ? null : (headers[offset - 1]?.id ?? null),
                nodes,
              },
            },
            { signal },
          ),
          repo.query(
            authority,
            { kind: 'message.presentations', messageIds: nodes.map((node) => node.id) },
            { signal },
          ),
        ])
        if (
          source.workspaceId !== pageEnvelope.workspaceId ||
          source.replacementEpoch !== pageEnvelope.replacementEpoch ||
          source.workspaceId !== materialEnvelope.workspaceId ||
          source.replacementEpoch !== materialEnvelope.replacementEpoch
        ) {
          continue readAttempt
        }
        const page = joinKnownBranchPageMaterial(pageEnvelope.value, materialEnvelope.value)
        if (page.kind !== 'ready') continue readAttempt
        for (const message of page.snapshot.pageMessages) {
          if (hasMessage) consumer.push('\n\n')
          for (const segment of branchMessageTextSegments(message)) consumer.push(segment)
          hasMessage = true
        }
      }
      consumer.push('\n')
    }

    const confirmed = await repo.query(authority, { kind: 'chat.get', chatId }, { signal })
    if (!confirmed.value) return undefined
    if (
      source.workspaceId !== confirmed.workspaceId ||
      source.replacementEpoch !== confirmed.replacementEpoch ||
      !sameBranchRevision(chat, confirmed.value, selection)
    ) {
      continue
    }
    return { chat: confirmed.value, branchLeafId }
  }
}

export async function readLastUpdatedBranchText(
  repo: WorkspaceRepository,
  authority: WorkspaceReadAuthority,
  chatId: ChatId,
  signal: AbortSignal = authority.signal,
): Promise<LastUpdatedBranchText | undefined> {
  return collectBranchText((consumer) =>
    consumeLastUpdatedBranchText(repo, authority, chatId, consumer, signal),
  )
}

export async function readBranchText(
  repo: WorkspaceRepository,
  authority: WorkspaceReadAuthority,
  chatId: ChatId,
  branchLeafId: MessageId | null,
  signal: AbortSignal = authority.signal,
): Promise<LastUpdatedBranchText | undefined> {
  return collectBranchText((consumer) =>
    consumeBranchText(repo, authority, chatId, branchLeafId, consumer, signal),
  )
}

async function collectBranchText(
  read: (consumer: BranchTextConsumer) => Promise<LastUpdatedBranchSnapshot | undefined>,
): Promise<LastUpdatedBranchText | undefined> {
  let segments: string[] = []
  const snapshot = await read({
    reset: () => {
      segments = []
    },
    push: (segment) => {
      segments.push(segment)
    },
  })
  return snapshot ? { ...snapshot, textContent: segments.join('') } : undefined
}

function sameBranchRevision(
  left: Chat,
  right: Chat,
  selection:
    | { readonly kind: 'last-updated' }
    | { readonly kind: 'fixed'; readonly branchLeafId: MessageId | null },
): boolean {
  return (
    left.id === right.id &&
    left.lastBranchUpdatedAt === right.lastBranchUpdatedAt &&
    left.structuralVersion === right.structuralVersion &&
    (selection.kind === 'fixed' || left.lastUpdatedLeafId === right.lastUpdatedLeafId)
  )
}
