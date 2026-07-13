import type Dexie from 'dexie'
import type { Transaction } from 'dexie'
import { connectionKindDefaults } from '../core/connection-defaults'
import type {
  Chat,
  ChatId,
  ChatPreset,
  ChatSettings,
  ConnectionProfile,
  DraftRow,
  KeyId,
  PresetId,
  ProfileId,
  PromptPreset,
  PromptPresetId,
} from '../core/types'
import { deleteChatSidebarProjections, putChatSidebarProjection } from './chat-sidebar-projection'
import type { LockGrant } from './locks'
import type {
  ChatCascadeVersion,
  DeletePresetCascadeResult,
  DeleteProfileAtomicInput,
  DeleteProfileAtomicResult,
  DeletePromptPresetAtomicInput,
  DeletePromptPresetAtomicResult,
  PromptPresetSlot,
  UpdateProfileAtomicInput,
  UpdateProfileAtomicResult,
  UpdatePromptPresetAtomicInput,
  UpdatePromptPresetAtomicResult,
} from './repository'

type BumpWorkspaceMeta = (tx: Transaction, now: number) => Promise<void>

export async function deletePresetAndClearBreadcrumbsInBrowser(
  db: Dexie,
  grant: LockGrant,
  presetId: PresetId,
  now: number,
  bumpWorkspaceMeta: BumpWorkspaceMeta,
): Promise<DeletePresetCascadeResult> {
  return grant.runTransaction(
    db,
    ['chatSidebarRows', 'chats', 'presets', 'settings'],
    async (tx: Transaction) => {
      const presetTable = tx.table<ChatPreset, PresetId>('presets')
      if (!(await presetTable.get(presetId))) return { kind: 'missing' }

      const chatTable = tx.table<Chat, ChatId>('chats')
      const chats = await chatTable.where('presetId').equals(presetId).toArray()
      const versions: ChatCascadeVersion[] = []
      for (const chat of chats) {
        const next = structuredClone(chat)
        delete next.presetId
        next.updatedAt = now
        next.metaVersion = chat.metaVersion + 1
        next.summaryVersion = chat.summaryVersion + 1
        await chatTable.put(next)
        await putChatSidebarProjection(tx, next)
        versions.push({
          chatId: chat.id,
          metaVersion: next.metaVersion,
          summaryVersion: next.summaryVersion,
        })
      }
      await presetTable.delete(presetId)
      await bumpWorkspaceMeta(tx, now)
      return { kind: 'deleted', chats: versions }
    },
  )
}

async function clearProfileCaches(tx: Transaction, profileId: ProfileId): Promise<void> {
  await tx.table('models').where('profileId').equals(profileId).delete()
  await tx.table('endpoints').where('profileId').equals(profileId).delete()
  await tx.table('privacyPolicies').where('profileId').equals(profileId).delete()
  await tx.table('providers').delete(profileId)
  await tx.table('presetResolutions').where('profileId').equals(profileId).delete()
}

export async function updateProfileAndInvalidateCachesInBrowser(
  db: Dexie,
  grant: LockGrant,
  input: UpdateProfileAtomicInput,
  bumpWorkspaceMeta: BumpWorkspaceMeta,
): Promise<UpdateProfileAtomicResult> {
  return grant.runTransaction(
    db,
    [
      'endpoints',
      'models',
      'presetResolutions',
      'privacyPolicies',
      'profiles',
      'providers',
      'settings',
    ],
    async (tx: Transaction) => {
      const table = tx.table<ConnectionProfile, ProfileId>('profiles')
      const existing = await table.get(input.profileId)
      if (!existing) return { kind: 'missing' }
      const kindChanged = input.patch.kind !== undefined && input.patch.kind !== existing.kind
      const kindOverrides: Partial<ConnectionProfile> = {}
      if (kindChanged && input.patch.kind !== undefined) {
        const defaults = connectionKindDefaults(
          input.patch.kind,
          input.patch.baseUrl ?? existing.baseUrl,
        )
        if (input.patch.supportsEndpointsApi === undefined) {
          kindOverrides.supportsEndpointsApi = defaults.supportsEndpointsApi
        }
        if (input.patch.supportsGenerationApi === undefined) {
          kindOverrides.supportsGenerationApi = defaults.supportsGenerationApi
        }
        if (input.patch.supportsPrivacyScrape === undefined) {
          kindOverrides.supportsPrivacyScrape = defaults.supportsPrivacyScrape
        }
      }
      const cachesInvalidated =
        (input.patch.baseUrl !== undefined && input.patch.baseUrl !== existing.baseUrl) ||
        kindChanged
      const next: ConnectionProfile = {
        ...existing,
        ...input.patch,
        ...kindOverrides,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: input.now,
      }
      await table.put(next)
      if (cachesInvalidated) await clearProfileCaches(tx, input.profileId)
      await bumpWorkspaceMeta(tx, input.now)
      return { kind: 'updated', profile: next, cachesInvalidated }
    },
  )
}

export async function deleteProfileAndReassignInBrowser(
  db: Dexie,
  grant: LockGrant,
  input: DeleteProfileAtomicInput,
  bumpWorkspaceMeta: BumpWorkspaceMeta,
): Promise<DeleteProfileAtomicResult> {
  return grant.runTransaction(
    db,
    [
      'chats',
      'chatSidebarRows',
      'endpoints',
      'keys',
      'models',
      'presetResolutions',
      'presets',
      'privacyPolicies',
      'profiles',
      'providers',
      'settings',
    ],
    async (tx: Transaction) => {
      const profileTable = tx.table<ConnectionProfile, ProfileId>('profiles')
      const existing = await profileTable.get(input.profileId)
      if (!existing) return { kind: 'missing-profile', profileId: input.profileId }
      if (input.reassignTo !== undefined && !(await profileTable.get(input.reassignTo))) {
        return { kind: 'missing-target', profileId: input.reassignTo }
      }

      const presetTable = tx.table<ChatPreset, PresetId>('presets')
      const presetRows = await presetTable
        .where('connectionProfileId')
        .equals(input.profileId)
        .toArray()
      const chatTable = tx.table<Chat, ChatId>('chats')
      const chatRows = (await chatTable.toArray()).filter(
        (chat) => chat.settings.profileId === input.profileId,
      )
      if (input.reassignTo === undefined && !input.force) {
        const presetIds = presetRows
          .filter((preset) => preset.archived !== true)
          .map((preset) => preset.id)
        const chatIds = chatRows.filter((chat) => chat.archived !== true).map((chat) => chat.id)
        if (presetIds.length > 0 || chatIds.length > 0) {
          return { kind: 'in-use', presetIds, chatIds }
        }
      }

      const touchedPresetIds: PresetId[] = []
      const chatVersions: ChatCascadeVersion[] = []
      if (input.reassignTo !== undefined) {
        for (const preset of presetRows) {
          await presetTable.put({
            ...preset,
            connectionProfileId: input.reassignTo,
            settings: { ...preset.settings, profileId: input.reassignTo },
            updatedAt: input.now,
          })
          touchedPresetIds.push(preset.id)
        }
        for (const chat of chatRows) {
          const next: Chat = {
            ...chat,
            settings: { ...chat.settings, profileId: input.reassignTo },
            updatedAt: input.now,
            metaVersion: chat.metaVersion + 1,
            summaryVersion: chat.summaryVersion + 1,
          }
          await chatTable.put(next)
          await putChatSidebarProjection(tx, next)
          chatVersions.push({
            chatId: chat.id,
            metaVersion: next.metaVersion,
            summaryVersion: next.summaryVersion,
          })
        }
      }

      await profileTable.delete(input.profileId)
      await clearProfileCaches(tx, input.profileId)
      const remainingKeyRefs = new Set((await profileTable.toArray()).flatMap(profileKeyRefs))
      const deletedKeyIds: KeyId[] = []
      for (const keyId of new Set(profileKeyRefs(existing))) {
        if (remainingKeyRefs.has(keyId)) continue
        await tx.table('keys').delete(keyId)
        deletedKeyIds.push(keyId)
      }
      await bumpWorkspaceMeta(tx, input.now)
      return {
        kind: 'deleted',
        chats: chatVersions,
        presetIds: touchedPresetIds,
        deletedKeyIds,
      }
    },
  )
}

function profileKeyRefs(profile: ConnectionProfile): KeyId[] {
  return [
    profile.apiKeyRef,
    ...(profile.apiKeyFallbackRefs ?? []),
    ...(profile.managementApiKeyRef === undefined ? [] : [profile.managementApiKeyRef]),
  ]
}

function withPromptText(
  settings: ChatSettings,
  key: PromptPresetSlot['textKey'],
  text: string,
): ChatSettings {
  const next = { ...settings }
  ;(next as unknown as Record<string, unknown>)[key] = text
  return next
}

function withoutPromptPin(settings: ChatSettings, key: PromptPresetSlot['pinKey']): ChatSettings {
  const next = { ...settings }
  delete (next as Partial<ChatSettings>)[key]
  return next
}

export async function updatePromptPresetAndPropagateInBrowser(
  db: Dexie,
  grant: LockGrant,
  input: UpdatePromptPresetAtomicInput,
  bumpWorkspaceMeta: BumpWorkspaceMeta,
): Promise<UpdatePromptPresetAtomicResult> {
  return grant.runTransaction(
    db,
    ['chatSidebarRows', 'chats', 'presets', 'promptPresets', 'settings'],
    async (tx: Transaction) => {
      const promptTable = tx.table<PromptPreset, PromptPresetId>('promptPresets')
      const existing = await promptTable.get(input.presetId)
      if (!existing) return { kind: 'missing' }
      const next: PromptPreset = {
        ...existing,
        ...input.patch,
        id: existing.id,
        kind: existing.kind,
        createdAt: existing.createdAt,
        updatedAt: input.now,
      }
      await promptTable.put(next)

      const chatVersions: ChatCascadeVersion[] = []
      const touchedPresetIds: PresetId[] = []
      if (input.patch.text !== undefined && input.patch.text !== existing.text) {
        const chatTable = tx.table<Chat, ChatId>('chats')
        const chats = (await chatTable.toArray()).filter(
          (chat) => chat.settings[input.slot.pinKey] === input.presetId,
        )
        for (const chat of chats) {
          const written: Chat = {
            ...chat,
            settings: withPromptText(chat.settings, input.slot.textKey, input.patch.text),
            updatedAt: input.now,
            metaVersion: chat.metaVersion + 1,
            summaryVersion: chat.summaryVersion + 1,
          }
          await chatTable.put(written)
          await putChatSidebarProjection(tx, written)
          chatVersions.push({
            chatId: chat.id,
            metaVersion: written.metaVersion,
            summaryVersion: written.summaryVersion,
          })
        }
        const presetTable = tx.table<ChatPreset, PresetId>('presets')
        const presets = (await presetTable.toArray()).filter(
          (preset) => preset.settings[input.slot.pinKey] === input.presetId,
        )
        for (const preset of presets) {
          await presetTable.put({
            ...preset,
            settings: withPromptText(preset.settings, input.slot.textKey, input.patch.text),
            updatedAt: input.now,
          })
          touchedPresetIds.push(preset.id)
        }
      }
      await bumpWorkspaceMeta(tx, input.now)
      return {
        kind: 'updated',
        promptPreset: next,
        chats: chatVersions,
        presetIds: touchedPresetIds,
      }
    },
  )
}

export async function deletePromptPresetAndClearPinsInBrowser(
  db: Dexie,
  grant: LockGrant,
  input: DeletePromptPresetAtomicInput,
  bumpWorkspaceMeta: BumpWorkspaceMeta,
): Promise<DeletePromptPresetAtomicResult> {
  return grant.runTransaction(
    db,
    ['chatSidebarRows', 'chats', 'presets', 'promptPresets', 'settings'],
    async (tx: Transaction) => {
      const promptTable = tx.table<PromptPreset, PromptPresetId>('promptPresets')
      if (!(await promptTable.get(input.presetId))) return { kind: 'missing' }

      const chatTable = tx.table<Chat, ChatId>('chats')
      const chats = (await chatTable.toArray()).filter(
        (chat) => chat.settings[input.slot.pinKey] === input.presetId,
      )
      const chatVersions: ChatCascadeVersion[] = []
      for (const chat of chats) {
        const written: Chat = {
          ...chat,
          settings: withoutPromptPin(chat.settings, input.slot.pinKey),
          updatedAt: input.now,
          metaVersion: chat.metaVersion + 1,
          summaryVersion: chat.summaryVersion + 1,
        }
        await chatTable.put(written)
        await putChatSidebarProjection(tx, written)
        chatVersions.push({
          chatId: chat.id,
          metaVersion: written.metaVersion,
          summaryVersion: written.summaryVersion,
        })
      }
      const presetTable = tx.table<ChatPreset, PresetId>('presets')
      const presets = (await presetTable.toArray()).filter(
        (preset) => preset.settings[input.slot.pinKey] === input.presetId,
      )
      const touchedPresetIds: PresetId[] = []
      for (const preset of presets) {
        await presetTable.put({
          ...preset,
          settings: withoutPromptPin(preset.settings, input.slot.pinKey),
          updatedAt: input.now,
        })
        touchedPresetIds.push(preset.id)
      }
      await promptTable.delete(input.presetId)
      await bumpWorkspaceMeta(tx, input.now)
      return { kind: 'deleted', chats: chatVersions, presetIds: touchedPresetIds }
    },
  )
}

export async function createChatInBrowser(
  db: Dexie,
  grant: LockGrant,
  chat: Chat,
  bumpWorkspaceMeta: BumpWorkspaceMeta,
): Promise<Chat> {
  await grant.runTransaction(
    db,
    ['chatSidebarRows', 'chats', 'settings'],
    async (tx: Transaction) => {
      await tx.table<Chat, ChatId>('chats').add(structuredClone(chat))
      await putChatSidebarProjection(tx, chat, true)
      await bumpWorkspaceMeta(tx, chat.updatedAt)
    },
  )
  return structuredClone(chat)
}

function isEmptyDraftRow(draft: DraftRow | undefined): boolean {
  return (
    draft === undefined || (draft.text.trim().length === 0 && draft.attachmentRefs.length === 0)
  )
}

function isEmptyMaterializedDraftChat(chat: Chat): boolean {
  const hasCalibration = Object.keys(chat.tokenCalibration ?? {}).length > 0
  const legacyHiddenDraft =
    chat.temporary === undefined &&
    chat.presetId === undefined &&
    chat.title.trim().length === 0 &&
    chat.titleStatus === 'untitled' &&
    (chat.previewText === undefined || chat.previewText === '')
  return (
    (chat.temporary === true || legacyHiddenDraft) &&
    chat.lastUpdatedLeafId === null &&
    chat.wordCount === 0 &&
    chat.totalCostUsd === 0 &&
    !hasCalibration
  )
}

export async function discardEmptyDraftChatsInBrowser(
  db: Dexie,
  grant: LockGrant,
  input: { chatIds?: readonly ChatId[]; exceptChatId?: ChatId | null },
  now: number,
  bumpWorkspaceMeta: BumpWorkspaceMeta,
): Promise<ChatId[]> {
  return grant.runTransaction(
    db,
    [
      'chatBranchCache',
      'chatSidebarRows',
      'chats',
      'childLists',
      'drafts',
      'messageBodies',
      'messages',
      'settings',
      'streamChunks',
      'streamLeases',
    ],
    async (tx: Transaction) => {
      const chatTable = tx.table<Chat, ChatId>('chats')
      const candidates =
        input.chatIds === undefined
          ? await chatTable.where('wordCount').equals(0).toArray()
          : (await chatTable.bulkGet([...new Set(input.chatIds)])).filter(
              (chat): chat is Chat => chat !== undefined,
            )
      const deleted: ChatId[] = []
      for (const candidate of candidates) {
        if (candidate.id === input.exceptChatId) continue
        const chat = await chatTable.get(candidate.id)
        if (!chat || !isEmptyMaterializedDraftChat(chat)) continue
        const messageTable = tx.table<{ chatId: ChatId }, string>('messages')
        const draftTable = tx.table<DraftRow, ChatId>('drafts')
        const [message, draft, streamLease] = await Promise.all([
          messageTable.where('chatId').equals(chat.id).first(),
          draftTable.get(chat.id),
          tx
            .table<{ chatId: ChatId }, string>('streamLeases')
            .where('chatId')
            .equals(chat.id)
            .first(),
        ])
        if (message || !isEmptyDraftRow(draft) || streamLease) continue
        await messageTable.where('chatId').equals(chat.id).delete()
        await tx.table('messageBodies').where('chatId').equals(chat.id).delete()
        await draftTable.delete(chat.id)
        await tx.table('chatBranchCache').delete(chat.id)
        await tx
          .table('childLists')
          .filter((row: { chatId?: unknown }) => row.chatId === chat.id)
          .delete()
        await tx.table('streamChunks').where('chatId').equals(chat.id).delete()
        await chatTable.delete(chat.id)
        deleted.push(chat.id)
      }
      if (deleted.length > 0) {
        await deleteChatSidebarProjections(tx, deleted)
        await bumpWorkspaceMeta(tx, now)
      }
      return deleted
    },
  )
}
