export { type CreateChatInput, createChatRow as buildChat } from '../core/chat-metadata'

import type { Chat, ChatId, ChatSettings, FolderId, PresetId, TagId } from '../core/types'
import { newId } from '../lib/ulid'
import { CHAT_CLOSURE_BATCH_LIMIT } from './chat-storage-ownership'
import {
  type ConversationCommittedResult,
  conversationCommittedResult,
} from './conversation-repository-adapter'
import type {
  MaterializeTemporaryChatResult,
  WorkspaceCommand,
  WorkspaceCommandResult,
} from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceAction, runWorkspaceRead } from './workspace-runtime'

async function executeChatCommand<C extends WorkspaceCommand>(
  command: C,
  options: { readonly signal?: AbortSignal } = {},
): Promise<WorkspaceCommandResult<C>> {
  return runWorkspaceAction(
    'chat-metadata',
    (permit) =>
      getWorkspaceRepository()
        .execute(permit, command)
        .then((envelope) => envelope.value),
    options,
  )
}

export function materializeTemporaryChat(
  input: {
    readonly chatId?: ChatId
    readonly settings: ChatSettings
    readonly presetId?: PresetId
    readonly now?: number
  },
  apply?: (result: ConversationCommittedResult<MaterializeTemporaryChatResult>) => void,
): Promise<ConversationCommittedResult<MaterializeTemporaryChatResult>> {
  const chatId = input.chatId ?? newId()
  return runWorkspaceAction('chat-metadata', (permit) =>
    getWorkspaceRepository()
      .execute(
        permit,
        {
          kind: 'chat.materialize-temporary',
          input: {
            chatId,
            settings: structuredClone(input.settings),
            ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
            now: input.now ?? Date.now(),
          },
        },
        apply
          ? {
              localApplications: {
                conversation: (commit) => {
                  apply(conversationCommittedResult(commit, chatId))
                  return 'applied'
                },
              },
            }
          : undefined,
      )
      .then((commit) => conversationCommittedResult(commit, commit.value.destination.chat.id)),
  )
}

export async function getChat(chatId: ChatId): Promise<Chat | undefined> {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'chat.get', chatId }, { signal: permit.signal })
      .then((envelope) => envelope.value),
  )
}

export async function nextForkTitle(baseTitle: string): Promise<string> {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'chat.next-fork-title', baseTitle }, { signal: permit.signal })
      .then((envelope) => envelope.value),
  )
}

export async function discardEmptyDraftChat(
  chatId: ChatId,
  options: { readonly signal?: AbortSignal } = {},
): Promise<boolean> {
  const deleted = await discardEmptyDraftChats([chatId], options)
  return deleted.includes(chatId)
}

async function discardEmptyDraftChats(
  chatIds: readonly ChatId[],
  options: { readonly signal?: AbortSignal } = {},
): Promise<ChatId[]> {
  const now = Date.now()
  const deleted: ChatId[] = []
  for (const batch of closureBatches(chatIds)) {
    const result = await executeChatCommand(
      {
        kind: 'chat.discard-empty-drafts',
        chatIds: batch,
        exceptChatId: null,
        now,
      },
      options,
    )
    deleted.push(...result.deletedChatIds)
  }
  return deleted
}

export async function archiveChats(
  chatIds: readonly ChatId[],
  now = Date.now(),
): Promise<readonly ChatId[]> {
  const result = await executeChatCommand({
    kind: 'chat.set-archived',
    chatIds: [...chatIds],
    archived: true,
    now,
  })
  return result.value
}

export async function archiveChat(chatId: ChatId, now = Date.now()): Promise<void> {
  await archiveChats([chatId], now)
}

export async function unarchiveChats(
  chatIds: readonly ChatId[],
  now = Date.now(),
): Promise<readonly ChatId[]> {
  const result = await executeChatCommand({
    kind: 'chat.set-archived',
    chatIds: [...chatIds],
    archived: false,
    now,
  })
  return result.value
}

export async function unarchiveChat(chatId: ChatId, now = Date.now()): Promise<void> {
  await unarchiveChats([chatId], now)
}

export async function deleteArchivedChatsPermanently(
  chatIds: readonly ChatId[],
  now = Date.now(),
): Promise<readonly ChatId[]> {
  const deleted: ChatId[] = []
  for (const batch of closureBatches(chatIds)) {
    const result = await executeChatCommand({
      kind: 'chat.delete-archived',
      chatIds: batch,
      now,
    })
    deleted.push(...result.deletedChatIds)
  }
  return deleted
}

export async function deleteArchivedChatPermanently(
  chatId: ChatId,
  now = Date.now(),
): Promise<boolean> {
  return (await deleteArchivedChatsPermanently([chatId], now)).includes(chatId)
}

export async function emptyArchivedChats(now = Date.now()): Promise<readonly ChatId[]> {
  const deleted: ChatId[] = []
  let afterChatId: ChatId | undefined
  for (;;) {
    const result = await executeChatCommand({
      kind: 'chat.empty-archive',
      ...(afterChatId === undefined ? {} : { afterChatId }),
      limit: CHAT_CLOSURE_BATCH_LIMIT,
      now,
    })
    deleted.push(...result.deletedChatIds)
    if (result.done) return deleted
    if (result.nextAfterChatId === undefined) throw new Error('ArchiveCleanupCursorMissing')
    afterChatId = result.nextAfterChatId
  }
}

function closureBatches(chatIds: readonly ChatId[]): ChatId[][] {
  const unique = [...new Set(chatIds)]
  const batches: ChatId[][] = []
  for (let start = 0; start < unique.length; start += CHAT_CLOSURE_BATCH_LIMIT) {
    batches.push(unique.slice(start, start + CHAT_CLOSURE_BATCH_LIMIT))
  }
  return batches
}

export async function moveChatsToFolder(
  chatIds: readonly ChatId[],
  folderId: FolderId | null,
  now = Date.now(),
): Promise<boolean> {
  const result = await executeChatCommand({
    kind: 'chat.move-to-folder',
    chatIds: [...chatIds],
    folderId,
    now,
  })
  return result.value
}

export async function moveChatToFolder(
  chatId: ChatId,
  folderId: FolderId | null,
  now = Date.now(),
): Promise<boolean> {
  return moveChatsToFolder([chatId], folderId, now)
}

export async function setChatsTagsFromNames(
  chatIds: readonly ChatId[],
  names: readonly string[],
  now = Date.now(),
): Promise<TagId[]> {
  const result = await executeChatCommand({
    kind: 'chat.set-tags-from-names',
    chatIds: [...chatIds],
    names: [...names],
    now,
  })
  return [...result.value]
}

export async function setChatTagsFromNames(
  chatId: ChatId,
  names: readonly string[],
  now = Date.now(),
): Promise<TagId[]> {
  return setChatsTagsFromNames([chatId], names, now)
}

export async function clearChatTokenCalibration(
  chatId: ChatId,
  calibrationKey?: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await executeChatCommand({
    kind: 'chat.calibration.clear',
    chatId,
    ...(calibrationKey === undefined ? {} : { calibrationKey }),
    now,
  })
  return result.value
}

export async function clearTokenCalibrationFamilyEverywhere(
  calibrationKey: string,
  now = Date.now(),
): Promise<{ globalChanged: boolean; chatCount: number }> {
  const result = await executeChatCommand({
    kind: 'chat.calibration.clear-family',
    calibrationKey,
    now,
  })
  return result.value
}

export async function clearAllTokenCalibrationEverywhere(
  now = Date.now(),
): Promise<{ globalChanged: boolean; chatCount: number }> {
  return (await executeChatCommand({ kind: 'chat.calibration.clear-all', now })).value
}

export async function touchLastViewed(
  chatId: ChatId,
  now = Date.now(),
  options: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  await executeChatCommand({ kind: 'chat.touch-viewed', chatId, now }, options)
}

export async function setManualTitle(
  chatId: ChatId,
  title: string,
  now = Date.now(),
): Promise<boolean> {
  if (title.trim().length === 0) return false
  return (await executeChatCommand({ kind: 'chat.set-manual-title', chatId, title, now })).value
}
