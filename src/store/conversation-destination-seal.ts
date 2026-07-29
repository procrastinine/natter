import type { Transaction } from 'dexie'
import type { ActiveBranchChildSlot, ActiveBranchForkSlot } from '../core/active-branch-spine'
import { readLiveBranchPath } from '../core/branch-session'
import type {
  ConversationProvedSelection,
  ConversationSelectionProofTarget,
  MessagePresentation,
} from '../core/messages'
import { TreeChangedError } from '../core/tree-ops'
import type { Chat, MessageId } from '../core/types'
import { readActiveBranchPathSlotFrameInTransaction } from './active-branch-fork-storage'
import { canonicalMessageHeaderRow, type MessageHeaderRow } from './message-storage'

export interface ConversationSelectionProofInput {
  readonly chat: Chat
  readonly target: ConversationSelectionProofTarget
  readonly tipId: MessageId | null
  readonly exactPathHeaders?: readonly MessageHeaderRow[]
  readonly forks?: readonly ActiveBranchForkSlot[]
  readonly terminalChildSlot?: ActiveBranchChildSlot
  readonly presentations?: readonly MessagePresentation[]
  readonly snapshotOwnership?: 'clone' | 'adopt'
}

export async function proveConversationSelectionInTransaction(
  tx: Transaction,
  input: ConversationSelectionProofInput,
): Promise<ConversationProvedSelection> {
  const { chat, tipId } = input
  let pathHeaders = input.exactPathHeaders
  if (tipId !== null && !pathHeaders) {
    const messages = tx.table<MessageHeaderRow, MessageId>('messages')
    const result = await readLiveBranchPath({
      chatId: chat.id,
      leafId: tipId,
      getHeader: (messageId) => messages.get(messageId),
    })
    if (result.kind === 'unavailable') {
      throw new TreeChangedError(chat.id, `branch target unavailable:${result.reason}`)
    }
    pathHeaders = result.rows
  }
  const exactPathHeaders = pathHeaders ?? Object.freeze([])
  const slotFrame =
    input.forks && input.terminalChildSlot
      ? null
      : await readActiveBranchPathSlotFrameInTransaction(tx, chat.id, exactPathHeaders)
  const forks = input.forks ?? slotFrame!.forks
  const terminalChildSlot = input.terminalChildSlot ?? slotFrame!.terminalChildSlot
  return proveConversationSelectionFromExactPath({
    ...input,
    exactPathHeaders,
    forks,
    terminalChildSlot,
  })
}

export function proveConversationSelectionFromExactPath(
  input: ConversationSelectionProofInput & {
    readonly exactPathHeaders: readonly MessageHeaderRow[]
    readonly forks: readonly ActiveBranchForkSlot[]
    readonly terminalChildSlot: ActiveBranchChildSlot
  },
): ConversationProvedSelection {
  const {
    chat,
    target,
    tipId,
    exactPathHeaders,
    forks,
    terminalChildSlot,
    presentations = [],
    snapshotOwnership = 'clone',
  } = input
  const ownedChat = snapshotOwnership === 'adopt' ? chat : structuredClone(chat)
  if (tipId === null) {
    if (exactPathHeaders.length > 0 || presentations.length > 0 || forks.length > 0) {
      throw new TreeChangedError(chat.id, 'empty committed branch contains rows')
    }
    return Object.freeze({
      kind: 'ready',
      chat: ownedChat,
      target,
      proof: Object.freeze({
        chatId: chat.id,
        structuralVersion: chat.structuralVersion,
        tipId: null,
        pathHeaders: Object.freeze([]),
      }),
      presentations: Object.freeze([]),
      forks: Object.freeze([]),
      terminalChildSlot: Object.freeze({ ...terminalChildSlot }),
    })
  }

  const pathHeaders = Object.freeze(
    exactPathHeaders.map((header) => canonicalMessageHeaderRow(header)),
  )
  const presentationsById = new Map<MessageId, MessagePresentation[]>()
  for (const presentation of presentations) {
    if (
      presentation.header.chatId !== chat.id ||
      presentation.message.chatId !== chat.id ||
      presentation.header.id !== presentation.message.id
    ) {
      continue
    }
    const candidates = presentationsById.get(presentation.header.id)
    if (candidates) candidates.push(presentation)
    else presentationsById.set(presentation.header.id, [presentation])
  }

  const tipHeader = pathHeaders.at(-1)
  if (!tipHeader || tipHeader.id !== tipId) {
    throw new TreeChangedError(chat.id, `committed tip ${tipId} unavailable`)
  }
  const pathById = new Map(pathHeaders.map((header) => [header.id, header]))
  const forkIds = new Set<MessageId>()
  if (
    forks.some((fork) => {
      const header = pathById.get(fork.selectedMessageId)
      if (!header || forkIds.has(fork.selectedMessageId) || fork.parentId !== header.parentId) {
        return true
      }
      forkIds.add(fork.selectedMessageId)
      return false
    })
  ) {
    throw new TreeChangedError(chat.id, `committed fork frame ${tipId} unavailable`)
  }

  const exactPresentations: MessagePresentation[] = []
  for (const pathHeader of pathHeaders) {
    const candidates = presentationsById.get(pathHeader.id)
    if (!candidates) continue
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const presentation = candidates[index] as MessagePresentation
      if (
        presentation.header.nodeVersion !== pathHeader.nodeVersion ||
        presentation.header.bodyVersion !== pathHeader.bodyVersion ||
        presentation.bodyVersion !== pathHeader.bodyVersion
      ) {
        continue
      }
      exactPresentations.push({
        header: pathHeader,
        message:
          snapshotOwnership === 'adopt'
            ? presentation.message
            : structuredClone(presentation.message),
        bodyVersion: pathHeader.bodyVersion,
      })
      break
    }
  }

  const proof = Object.freeze({
    chatId: chat.id,
    structuralVersion: chat.structuralVersion,
    tipId,
    pathHeaders,
  })
  return Object.freeze({
    kind: 'ready',
    chat: ownedChat,
    target,
    proof,
    presentations: Object.freeze(exactPresentations),
    forks: Object.freeze(forks.map((fork) => Object.freeze({ ...fork }))),
    terminalChildSlot: Object.freeze({ ...terminalChildSlot }),
  })
}
