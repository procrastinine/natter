import type { Collection, Table } from 'dexie'
import { findLastUpdatedLeafId } from '../core/active-path'
import { sha256Hex as sha256BytesHex } from '../core/attachments/process'
import { buildBranchCacheRow } from '../core/branch-flatten'
import { WorkspaceReplacementInProgressError } from '../core/import-export/errors'
import {
  flattenChatSettingsForPortableExport,
  stripPromptPresetPins,
} from '../core/import-export/flatten'
import {
  type ChatExportEnvelope,
  type ChatPresetExportEnvelope,
  type ConnectionSketch,
  NATTER_EXPORT_SCHEMA_VERSION,
  type NatterExportEnvelope,
  type NatterExportObjectKind,
  type PortableAttachmentBlob,
  type PortableAttachmentBundle,
  type PortableChatPayload,
  type PortableChatPresetPayload,
  type PortableFolderSketch,
  type PortableTagSketch,
  type WorkspaceBackupEnvelope,
  type WorkspaceBackupPayload,
} from '../core/import-export/schema'
import {
  validatePortableChatGraph,
  validateWorkspaceBackupGraph,
} from '../core/import-export/workspace-validation'
import { readSavedTextTemplates } from '../core/text-templates'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentId,
  AttachmentJob,
  Chat,
  ChatFolder,
  ChatPreset,
  ChatSettings,
  ChatTag,
  ChildListState,
  ConnectionProfile,
  ContentItem,
  FolderId,
  Message,
  MessageAttachmentRef,
  MessageId,
  PresetId,
  ProfileId,
  TagId,
} from '../core/types'
import { newId } from '../lib/ulid'
import { replaceAttachmentReferenceOwners } from './attachment-reference-edges'
import {
  type AttachmentHeaderRow,
  attachmentHeaderFromStoredRow,
  hydrateAttachment,
  splitAttachmentForStorage,
} from './attachment-storage'
import { postEvent } from './broadcast'
import {
  chatSidebarProjectionRow,
  chatSidebarProjectionSettings,
  isChatSidebarProjectionSettingKey,
  putChatSidebarProjection,
} from './chat-sidebar-projection'
import { childListKey, type NatterDb, openDb } from './db'
import type {
  ImportChatOptions,
  ImportChatPresetOptions,
  ImportChatPresetResult,
  ImportChatResult,
  RestoreWorkspaceBackupOptions,
  RestoreWorkspaceBackupResult,
  WorkspaceImportExportBackend,
} from './import-export-contract'
import { withNamedLock } from './locks'
import {
  hydrateMessages,
  type MessageBodyRow,
  type MessageHeaderRow,
  previewTextFromMessages,
  previewTextsByChat,
  splitMessageForStorage,
} from './message-storage'
import { PresetMissingError } from './presets'
import type { StreamLeaseRow } from './repository'
import { isFreshStreamLease, STREAM_LEASE_TTL_MS } from './stream-leases'
import {
  bumpBrowserWorkspaceMeta,
  markBrowserWorkspaceReplaced,
  readBrowserWorkspaceMetaFromTransaction,
} from './workspace-meta'
import { useStreamStore } from './zustand/streamStore'

const WORKSPACE_ID = 'browser-idb:natter'
const IMPORT_EXPORT_PAGE_SIZE = 128

interface ImportExportMaterializationMetrics {
  tableReadBatches: number
  tableReadRows: number
  maxTableReadBatchRows: number
  tableWriteBatches: number
  tableWriteRows: number
  maxTableWriteBatchRows: number
  messageBodyReadBatches: number
  maxMessageBodyReadBatchRows: number
  attachmentBlobReadBytes: number
  maxAttachmentBlobReadBytes: number
  attachmentBlobDecodeBytes: number
  maxAttachmentBlobDecodeBytes: number
}

let materializationMetrics = emptyMaterializationMetrics()

export function __resetImportExportMaterializationMetricsForTests(): void {
  materializationMetrics = emptyMaterializationMetrics()
}

export function __importExportMaterializationMetricsForTests(): Readonly<ImportExportMaterializationMetrics> {
  return { ...materializationMetrics }
}

interface StoredAttachmentBundle {
  attachment: Attachment
  blobs: AttachmentBlob[]
  artifacts: AttachmentArtifact[]
  jobs: AttachmentJob[]
}

interface ValidatedPortableAttachmentBlob extends PortableAttachmentBlob {
  blobType: string
}

interface ValidatedAttachmentBundle {
  attachment: Attachment
  blobs: ValidatedPortableAttachmentBlob[]
  artifacts: AttachmentArtifact[]
  jobs: AttachmentJob[]
}

interface ResolvedProfile {
  profileId: ProfileId
  matched: boolean
}

interface ImportedAttachmentBundle {
  sourceAttachmentId: AttachmentId
  targetAttachmentId: AttachmentId
  reused: boolean
  bundle?: ValidatedAttachmentBundle
}

class BrowserImportExportBackend implements WorkspaceImportExportBackend {
  async exportChat(chatId: string): Promise<ChatExportEnvelope> {
    const db = await openDb()
    const savedTextTemplates = await readSavedTextTemplates()
    const snapshot = await db.transaction(
      'r',
      [
        db.attachmentArtifacts,
        db.attachmentBlobs,
        db.attachmentJobs,
        db.attachments,
        db.chatBranchCache,
        db.chats,
        db.folders,
        db.messageBodies,
        db.messages,
        db.profiles,
        db.tags,
      ],
      async () => {
        const chat = await db.chats.get(chatId)
        if (!chat) throw new Error(`ChatMissing:${chatId}`)
        const messages = sortMessages(
          await hydrateStoredMessagesInPages(
            db,
            await db.messages.where('chatId').equals(chatId).primaryKeys(),
          ),
        )
        const folder = chat.folderId ? await db.folders.get(chat.folderId) : undefined
        const tags = chat.tags.length > 0 ? await db.tags.bulkGet(chat.tags) : []
        const profile = await db.profiles.get(chat.settings.profileId)
        const bundles = await storedAttachmentBundles(db, collectAttachmentIds(messages))
        return { chat, messages, folder, tags: tags.filter(isDefined), profile, bundles }
      },
    )

    const payload: PortableChatPayload = {
      chat: {
        sourceChatId: snapshot.chat.id,
        title: snapshot.chat.title,
        createdAt: snapshot.chat.createdAt,
        updatedAt: snapshot.chat.updatedAt,
        settings: flattenChatSettingsForPortableExport(snapshot.chat.settings, {
          savedTextTemplates,
        }),
        ...(snapshot.chat.color ? { color: snapshot.chat.color } : {}),
        ...(snapshot.chat.favoriteModels
          ? { favoriteModels: [...snapshot.chat.favoriteModels] }
          : {}),
        ...(snapshot.chat.recentModels ? { recentModels: [...snapshot.chat.recentModels] } : {}),
      },
      messages: snapshot.messages,
      ...(snapshot.folder ? { folder: folderSketch(snapshot.folder) } : {}),
      tags: snapshot.tags.map(tagSketch),
      attachments: await portableAttachmentBundles(snapshot.bundles),
      ...(snapshot.profile ? { connectionSketch: connectionSketch(snapshot.profile) } : {}),
    }

    return envelope(db, 'chat', payload)
  }

  async importChat(
    envelope: ChatExportEnvelope,
    options: ImportChatOptions = {},
  ): Promise<ImportChatResult> {
    const db = await openDb()
    const now = options.now ?? Date.now()
    const payload = envelope.payload
    validatePortableChatGraph(payload)
    const resolvedProfile = await resolveProfileId(
      db,
      payload.chat.settings,
      payload.connectionSketch,
      {
        targetProfileId: options.targetProfileId,
      },
    )

    const attachmentRows = await prepareImportedAttachments(db, payload.attachments)
    const attachmentIdMap = Object.fromEntries(
      attachmentRows.map((row) => [row.sourceAttachmentId, row.targetAttachmentId]),
    )
    const chatId = newId()
    const messageIdMap = Object.fromEntries(
      payload.messages.map((message) => [message.id, newId()]),
    )
    const turnIdMap = new Map<string, string>()
    const messages = payload.messages.map((message) =>
      remapImportedMessage(message, {
        chatId,
        messageIdMap,
        turnIdMap,
        attachmentIdMap,
      }),
    )
    const liveRefCounts = countLiveAttachmentRefs(messages)
    const branchLeafId = findLastUpdatedLeafId(messages)
    const branchCache = buildBranchCacheRow({
      chatId,
      branchLeafId,
      messages,
      generatedAt: now,
    })
    const totalCostUsd = messages.reduce(
      (total, message) => total + (message.deleted ? 0 : (message.generation?.cost ?? 0)),
      0,
    )
    const settings = normalizedImportedSettings(payload.chat.settings, resolvedProfile.profileId)

    let folderId: FolderId | undefined
    let tagIds: TagId[] = []
    const createdFolderIds: FolderId[] = []
    const createdTagIds: TagId[] = []
    const childLists = childListsForMessages(chatId, messages, now)
    const createdAttachmentIds: AttachmentId[] = []
    const reusedAttachmentIds: AttachmentId[] = []

    await withNamedLock(`workspace:import-chat:${chatId}`, (grant) =>
      grant.runTransaction(
        db,
        [
          db.attachmentArtifacts,
          db.attachmentBlobs,
          db.attachmentJobs,
          db.attachmentRefEdges,
          db.attachments,
          db.chatBranchCache,
          db.chatSidebarRows,
          db.chats,
          db.childLists,
          db.folders,
          db.messageBodies,
          db.messages,
          db.settings,
          db.tags,
        ],
        async (tx) => {
          const folderResult = await ensurePortableFolder(db, payload.folder, now)
          folderId = folderResult.folderId
          if (folderResult.created && folderResult.folderId) {
            createdFolderIds.push(folderResult.folderId)
          }

          const tagResult = await ensurePortableTags(db, payload.tags, now)
          tagIds = tagResult.tagIds
          createdTagIds.push(...tagResult.createdTagIds)

          for (const imported of attachmentRows) {
            if (imported.reused) {
              reusedAttachmentIds.push(imported.targetAttachmentId)
              continue
            }
            if (!imported.bundle) continue
            await storeValidatedAttachmentBundle(db, imported.bundle)
            createdAttachmentIds.push(imported.targetAttachmentId)
          }

          const chat: Chat = {
            id: chatId,
            title: payload.chat.title,
            titleStatus: 'untitled',
            createdAt: now,
            updatedAt: now,
            lastViewedAt: now,
            wordCount: branchCache.wordCount,
            totalCostUsd,
            metaVersion: 0,
            summaryVersion: 0,
            settings,
            lastUpdatedLeafId: branchLeafId,
            lastBranchUpdatedAt: now,
            archived: false,
            pinned: false,
            folderId: folderId ?? null,
            tags: tagIds,
            ...(payload.chat.color ? { color: payload.chat.color } : {}),
            ...(payload.chat.favoriteModels
              ? { favoriteModels: [...payload.chat.favoriteModels] }
              : {}),
            ...(payload.chat.recentModels ? { recentModels: [...payload.chat.recentModels] } : {}),
            previewText: previewTextFromMessages(messages),
          }
          await db.chats.put(chat)
          await putChatSidebarProjection(tx, chat, true)
          await storeMessagesInPages(db, messages)
          await replaceMessageAttachmentReferenceOwnersInPages(tx, messages)
          if (childLists.length > 0) await db.childLists.bulkPut(childLists)
          await db.chatBranchCache.put(branchCache)
          await bumpBrowserWorkspaceMeta(tx, now)
        },
      ),
    )

    for (const id of createdFolderIds) postEvent({ kind: 'folder-mutated', folderId: id })
    for (const id of createdTagIds) postEvent({ kind: 'tag-mutated', tagId: id })
    postEvent({
      kind: 'chat-mutated',
      chatId,
      metaVersion: 0,
      summaryVersion: 0,
      affected: [
        { kind: 'chat-meta', chatId },
        { kind: 'children', chatId, parentId: null },
        ...messages.map((message) => ({ kind: 'message' as const, chatId, messageId: message.id })),
        ...[...liveRefCounts.keys()].map((attachmentId) => ({
          kind: 'attachment' as const,
          attachmentId,
        })),
      ],
    })
    postEvent({ kind: 'branch-cache-refreshed', chatId })

    return {
      chatId,
      messageIdMap,
      attachmentIdMap,
      createdAttachmentIds,
      reusedAttachmentIds,
      ...(folderId ? { folderId } : {}),
      tagIds,
      profileId: resolvedProfile.profileId,
      profileMatched: resolvedProfile.matched,
    }
  }

  async exportChatPreset(presetId: PresetId): Promise<ChatPresetExportEnvelope> {
    const db = await openDb()
    const savedTextTemplates = await readSavedTextTemplates()
    const snapshot = await db.transaction('r', [db.presets, db.profiles], async () => {
      const preset = await db.presets.get(presetId)
      if (!preset) throw new PresetMissingError(presetId)
      const profile = await db.profiles.get(preset.connectionProfileId)
      return { preset, profile }
    })

    return envelope(db, 'chat-preset', {
      sourcePresetId: snapshot.preset.id,
      name: snapshot.preset.name,
      settings: flattenChatSettingsForPortableExport(snapshot.preset.settings, {
        savedTextTemplates,
      }),
      createdAt: snapshot.preset.createdAt,
      updatedAt: snapshot.preset.updatedAt,
      ...(snapshot.profile ? { connectionSketch: connectionSketch(snapshot.profile) } : {}),
    })
  }

  async importChatPreset(
    envelope: ChatPresetExportEnvelope,
    options: ImportChatPresetOptions = {},
  ): Promise<ImportChatPresetResult> {
    const db = await openDb()
    const now = options.now ?? Date.now()
    const payload = envelope.payload
    const resolvedProfile = await resolveProfileId(db, payload.settings, payload.connectionSketch, {
      targetProfileId: options.targetProfileId,
    })
    const presetId = newId()
    const preset: ChatPreset = {
      id: presetId,
      name: await uniquePresetName(db, payload.name),
      connectionProfileId: resolvedProfile.profileId,
      settings: normalizedImportedSettings(payload.settings, resolvedProfile.profileId),
      sortIndex: await nextPresetSortIndex(db),
      createdAt: now,
      updatedAt: now,
      archived: false,
    }
    await withNamedLock(`preset:${presetId}`, (grant) =>
      grant.runTransaction(db, [db.presets, db.settings], async (tx) => {
        await tx.table('presets').put(preset)
        await bumpBrowserWorkspaceMeta(tx, now)
      }),
    )
    postEvent({ kind: 'preset-mutated', presetId })
    return {
      presetId,
      profileId: resolvedProfile.profileId,
      profileMatched: resolvedProfile.matched,
    }
  }

  async exportWorkspaceBackup(): Promise<WorkspaceBackupEnvelope> {
    const db = await openDb()
    const snapshot = await db.transaction('r', db.tables, async () => {
      return {
        chats: await readTableInPages(db.chats),
        messages: sortMessages(await hydrateAllStoredMessagesInPages(db)),
        childLists: await readTableInPages(db.childLists),
        chatBranchCache: await readTableInPages(db.chatBranchCache),
        attachmentBundles: await storedAllAttachmentBundlesInPages(db),
        profiles: await readTableInPages(db.profiles),
        presets: await readTableInPages(db.presets),
        promptPresets: await readTableInPages(db.promptPresets),
        folders: await readTableInPages(db.folders),
        tags: await readTableInPages(db.tags),
        drafts: await readTableInPages(db.drafts),
        keys: await readTableInPages(db.keys),
        settings: (await readTableInPages(db.settings)).filter(
          (row) => !isChatSidebarProjectionSettingKey(row.key),
        ),
      }
    })

    const attachments = await consumePortableAttachmentBundles(snapshot.attachmentBundles)

    return envelope(db, 'workspace-backup', {
      chats: snapshot.chats,
      messages: snapshot.messages,
      childLists: snapshot.childLists,
      chatBranchCache: snapshot.chatBranchCache,
      attachments,
      profiles: snapshot.profiles,
      presets: snapshot.presets,
      promptPresets: snapshot.promptPresets,
      folders: snapshot.folders,
      tags: snapshot.tags,
      drafts: snapshot.drafts,
      keys: snapshot.keys,
      settings: snapshot.settings,
    })
  }

  async restoreWorkspaceBackup(
    envelope: WorkspaceBackupEnvelope,
    options: RestoreWorkspaceBackupOptions = {},
  ): Promise<RestoreWorkspaceBackupResult> {
    const db = await openDb()
    const now = options.now ?? Date.now()
    validateWorkspaceBackupGraph(envelope.payload)
    const validatedBlobTypes = await validatePortableAttachmentBundles(envelope.payload.attachments)
    const previewTextByChatId = previewTextsByChat(envelope.payload.messages)
    const workspaceTables = db.tables.filter((table) => table.name !== 'browserLocks')
    let replacementEpoch: number | undefined
    await withNamedLock('db:global', async (grant) => {
      const runtimeStreamIds = await replacementRuntimeStreamIds()
      if (runtimeStreamIds.length > 0) {
        throw new WorkspaceReplacementInProgressError(runtimeStreamIds)
      }
      await grant.runTransaction(db, workspaceTables, async (tx) => {
        const beforeRestoreMeta = await readBrowserWorkspaceMetaFromTransaction(tx)
        const activeStreamIds = new Set<string>()
        const leases = await tx.table<StreamLeaseRow, string>('streamLeases').toArray()
        for (const lease of leases) {
          if (isFreshStreamLease(lease)) activeStreamIds.add(lease.streamId)
        }
        await tx.table<MessageHeaderRow, string>('messages').each((message) => {
          if (
            message.generation?.status === 'streaming' &&
            Date.now() - message.generation.startedAt <= STREAM_LEASE_TTL_MS
          ) {
            activeStreamIds.add(`streaming-message:${message.id}`)
          }
        })
        for (const streamId of useStreamStore.getState().listStreamIds()) {
          activeStreamIds.add(streamId)
        }
        if (activeStreamIds.size > 0) {
          throw new WorkspaceReplacementInProgressError(activeStreamIds)
        }
        for (const table of workspaceTables) await tx.table(table.name).clear()
        await bulkPutInPages(db.folders, envelope.payload.folders)
        await bulkPutInPages(db.tags, envelope.payload.tags)
        await bulkPutInPages(db.profiles, envelope.payload.profiles)
        await bulkPutInPages(db.presets, envelope.payload.presets)
        await bulkPutInPages(db.promptPresets, envelope.payload.promptPresets)
        await bulkPutInPages(db.keys, envelope.payload.keys)
        for (const page of pages(envelope.payload.settings)) {
          const authoritative = page.filter((row) => !isChatSidebarProjectionSettingKey(row.key))
          if (authoritative.length > 0) {
            await db.settings.bulkPut(authoritative)
            recordTableWrite(authoritative.length)
          }
        }
        for (const page of pages(envelope.payload.chats)) {
          const restored = page.map((chat) => ({
            ...chat,
            previewText: previewTextByChatId.get(chat.id) ?? '',
          }))
          await db.chats.bulkPut(restored)
          await db.chatSidebarRows.bulkPut(restored.map(chatSidebarProjectionRow))
          recordTableWrite(restored.length)
          recordTableWrite(restored.length)
        }
        await db.settings.bulkPut(chatSidebarProjectionSettings(envelope.payload.chats.length))
        recordTableWrite(2)
        for (const bundle of envelope.payload.attachments) {
          await storePortableAttachmentBundle(db, bundle, validatedBlobTypes)
        }
        await storeMessagesInPages(db, envelope.payload.messages)
        await bulkPutInPages(db.drafts, envelope.payload.drafts)
        await replaceMessageAttachmentReferenceOwnersInPages(tx, envelope.payload.messages)
        for (const page of pages(envelope.payload.drafts)) {
          await replaceAttachmentReferenceOwners(
            tx,
            page.map((draft) => ({
              ownerKind: 'draft' as const,
              ownerId: draft.chatId,
              chatId: draft.chatId,
              refs: draft.attachmentRefs,
            })),
          )
        }
        await bulkPutInPages(db.childLists, envelope.payload.childLists)
        await bulkPutInPages(db.chatBranchCache, envelope.payload.chatBranchCache)
        replacementEpoch = await markBrowserWorkspaceReplaced(tx, now, beforeRestoreMeta)
      })
      postEvent({ kind: 'workspace-replaced', replacementEpoch: replacementEpoch as number })
    })
    return {
      chatCount: envelope.payload.chats.length,
      messageCount: envelope.payload.messages.length,
      attachmentCount: envelope.payload.attachments.length,
      profileCount: envelope.payload.profiles.length,
      presetCount: envelope.payload.presets.length,
      promptPresetCount: envelope.payload.promptPresets.length,
      keyCount: envelope.payload.keys.length,
    }
  }
}

async function replacementRuntimeStreamIds(): Promise<string[]> {
  const ids = new Set<string>()
  addRuntimeStreamIds(ids)
  const manager = lockQueryManager()
  if (!manager) return [...ids]
  try {
    const snapshot = await manager.query()
    for (const lock of [...(snapshot.held ?? []), ...(snapshot.pending ?? [])]) {
      if (lock.name?.startsWith('stream-owner:')) ids.add(lock.name.slice('stream-owner:'.length))
    }
  } catch {
    ids.add('stream-owner-state-unknown')
  }
  addRuntimeStreamIds(ids)
  return [...ids]
}

function addRuntimeStreamIds(ids: Set<string>): void {
  for (const streamId of useStreamStore.getState().listStreamIds()) ids.add(streamId)
}

function lockQueryManager():
  | {
      query: () => Promise<{ held?: Array<{ name?: string }>; pending?: Array<{ name?: string }> }>
    }
  | undefined {
  if (typeof navigator === 'undefined') return undefined
  const locks = (navigator as unknown as { locks?: LockManager }).locks as
    | (LockManager & {
        query?: () => Promise<{
          held?: Array<{ name?: string }>
          pending?: Array<{ name?: string }>
        }>
      })
    | undefined
  const query = locks?.query
  return typeof query === 'function' ? { query: () => query.call(locks) } : undefined
}

let singleton: WorkspaceImportExportBackend | null = null

export function getBrowserImportExportBackend(): WorkspaceImportExportBackend {
  singleton ??= new BrowserImportExportBackend()
  return singleton
}

export function __resetBrowserImportExportBackendForTests(): void {
  singleton = null
}

function envelope(db: NatterDb, kind: 'chat', payload: PortableChatPayload): ChatExportEnvelope
function envelope(
  db: NatterDb,
  kind: 'chat-preset',
  payload: PortableChatPresetPayload,
): ChatPresetExportEnvelope
function envelope(
  db: NatterDb,
  kind: 'workspace-backup',
  payload: WorkspaceBackupPayload,
): WorkspaceBackupEnvelope
function envelope(
  db: NatterDb,
  kind: NatterExportObjectKind,
  payload: PortableChatPayload | PortableChatPresetPayload | WorkspaceBackupPayload,
): NatterExportEnvelope {
  return {
    objectKind: kind,
    exportSchemaVersion: NATTER_EXPORT_SCHEMA_VERSION,
    appStorageSchemaVersion: db.verno,
    createdAt: Date.now(),
    source: {
      app: 'natter',
      backendKind: 'browser-idb',
      workspaceId: WORKSPACE_ID,
    },
    payload,
  } as NatterExportEnvelope
}

function connectionSketch(profile: ConnectionProfile): ConnectionSketch {
  return {
    sourceProfileId: profile.id,
    name: profile.name,
    kind: profile.kind,
    baseUrl: profile.baseUrl,
  }
}

function folderSketch(folder: ChatFolder): PortableFolderSketch {
  return {
    name: folder.name,
    ...(folder.color ? { color: folder.color } : {}),
  }
}

function tagSketch(tag: ChatTag): PortableTagSketch {
  return {
    name: tag.name,
    ...(tag.color ? { color: tag.color } : {}),
  }
}

async function resolveProfileId(
  db: NatterDb,
  settings: ChatSettings,
  sketch: ConnectionSketch | undefined,
  options: { targetProfileId?: ProfileId | null | undefined },
): Promise<ResolvedProfile> {
  if (typeof options.targetProfileId === 'string') {
    return {
      profileId: options.targetProfileId,
      matched: Boolean(await db.profiles.get(options.targetProfileId)),
    }
  }

  const sourceId = sketch?.sourceProfileId ?? settings.profileId
  if (options.targetProfileId === null) {
    return { profileId: sourceId || `missing:${newId()}`, matched: false }
  }

  if (sourceId && (await db.profiles.get(sourceId))) return { profileId: sourceId, matched: true }

  if (sketch) {
    const profiles = await db.profiles.toArray()
    const match = profiles.find(
      (profile) =>
        profile.archived !== true &&
        profile.kind === sketch.kind &&
        normalizeBaseUrl(profile.baseUrl) === normalizeBaseUrl(sketch.baseUrl),
    )
    if (match) return { profileId: match.id, matched: true }
  }

  return { profileId: sourceId || `missing:${newId()}`, matched: false }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizedImportedSettings(settings: ChatSettings, profileId: ProfileId): ChatSettings {
  const next = stripPromptPresetPins(structuredClone(settings))
  next.profileId = profileId
  next.enabledToolIds = []
  next.trustedToolIds = []
  return next
}

async function ensurePortableFolder(
  db: NatterDb,
  sketch: PortableFolderSketch | undefined,
  now: number,
): Promise<{ folderId: FolderId | undefined; created: boolean }> {
  if (!sketch) return { folderId: undefined, created: false }
  const name = sketch.name.trim()
  if (!name) return { folderId: undefined, created: false }
  const existing = (await db.folders.toArray()).find(
    (folder) => folder.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
  )
  if (existing) return { folderId: existing.id, created: false }
  const rows = await db.folders.toArray()
  const sortIndex = rows.reduce((max, row) => Math.max(max, row.sortIndex), 0) + 1
  const folder: ChatFolder = {
    id: newId(),
    name,
    ...(sketch.color ? { color: sketch.color } : {}),
    sortIndex,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
  }
  await db.folders.put(folder)
  return { folderId: folder.id, created: true }
}

async function ensurePortableTags(
  db: NatterDb,
  sketches: readonly PortableTagSketch[],
  now: number,
): Promise<{ tagIds: TagId[]; createdTagIds: TagId[] }> {
  const existing = await db.tags.toArray()
  const byLower = new Map(existing.map((tag) => [tag.nameLower, tag]))
  const tagIds: TagId[] = []
  const createdTagIds: TagId[] = []
  for (const sketch of sketches) {
    const name = sketch.name.trim()
    if (!name) continue
    const nameLower = name.toLocaleLowerCase()
    const current = byLower.get(nameLower)
    if (current) {
      tagIds.push(current.id)
      continue
    }
    const tag: ChatTag = {
      id: newId(),
      name,
      nameLower,
      ...(sketch.color ? { color: sketch.color } : {}),
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    }
    await db.tags.put(tag)
    byLower.set(nameLower, tag)
    tagIds.push(tag.id)
    createdTagIds.push(tag.id)
  }
  return { tagIds: [...new Set(tagIds)], createdTagIds }
}

async function uniquePresetName(db: NatterDb, name: string): Promise<string> {
  const base = name.trim() || 'Imported preset'
  const existing = new Set((await db.presets.toArray()).map((preset) => preset.name))
  if (!existing.has(base)) return base
  for (let i = 2; ; i += 1) {
    const candidate = `${base} (${i})`
    if (!existing.has(candidate)) return candidate
  }
}

async function nextPresetSortIndex(db: NatterDb): Promise<number> {
  const rows = await db.presets.toArray()
  return rows.length === 0 ? 0 : Math.max(...rows.map((row) => row.sortIndex)) + 1
}

async function storedAttachmentBundles(
  db: NatterDb,
  ids: Iterable<AttachmentId>,
): Promise<StoredAttachmentBundle[]> {
  const bundles: StoredAttachmentBundle[] = []
  for (const id of [...new Set(ids)]) {
    const header = await db.attachments.get(id)
    if (!header) continue
    const artifacts = await readCollectionInPages(
      db.attachmentArtifacts.where('attachmentId').equals(id),
    )
    bundles.push({
      attachment: hydrateAttachment(attachmentHeaderFromStoredRow(header), artifacts),
      blobs: await readCollectionInPages(db.attachmentBlobs.where('attachmentId').equals(id)),
      artifacts,
      jobs: await readCollectionInPages(db.attachmentJobs.where('attachmentId').equals(id)),
    })
  }
  return bundles
}

async function storedAllAttachmentBundlesInPages(db: NatterDb): Promise<StoredAttachmentBundle[]> {
  const bundles: StoredAttachmentBundle[] = []
  for await (const attachments of tablePages(db.attachments)) {
    for (const header of attachments) {
      const artifacts = await readCollectionInPages(
        db.attachmentArtifacts.where('attachmentId').equals(header.id),
      )
      bundles.push({
        attachment: hydrateAttachment(attachmentHeaderFromStoredRow(header), artifacts),
        blobs: await readCollectionInPages(
          db.attachmentBlobs.where('attachmentId').equals(header.id),
        ),
        artifacts,
        jobs: await readCollectionInPages(
          db.attachmentJobs.where('attachmentId').equals(header.id),
        ),
      })
    }
  }
  return bundles
}

async function portableAttachmentBundles(
  bundles: readonly StoredAttachmentBundle[],
): Promise<PortableAttachmentBundle[]> {
  const portable: PortableAttachmentBundle[] = []
  for (const bundle of bundles) {
    const blobs: PortableAttachmentBlob[] = []
    for (const blob of bundle.blobs) blobs.push(await portableBlob(blob))
    portable.push({
      attachment: structuredClone(bundle.attachment),
      blobs,
      artifacts: structuredClone(bundle.artifacts),
      jobs: structuredClone(bundle.jobs),
    })
  }
  return portable
}

async function consumePortableAttachmentBundles(
  bundles: StoredAttachmentBundle[],
): Promise<PortableAttachmentBundle[]> {
  const portable: PortableAttachmentBundle[] = []
  for (const bundle of bundles) {
    const blobs: PortableAttachmentBlob[] = []
    for (const blob of bundle.blobs) blobs.push(await portableBlob(blob))
    portable.push({
      attachment: bundle.attachment,
      blobs,
      artifacts: bundle.artifacts,
      jobs: bundle.jobs,
    })
    bundle.blobs.length = 0
  }
  return portable
}

async function hydrateStoredMessagesInPages(
  db: NatterDb,
  messageIds: readonly string[],
): Promise<Message[]> {
  const messages: Message[] = []
  for (const ids of pages(messageIds)) {
    const headers = (await db.messages.bulkGet(ids)).filter(
      (row): row is MessageHeaderRow => row !== undefined,
    )
    const bodies = (await db.messageBodies.bulkGet(headers.map((row) => row.id))).filter(
      (row): row is MessageBodyRow => row !== undefined,
    )
    recordMessageBodyRead(headers.length)
    recordTableRead(headers.length)
    recordTableRead(bodies.length)
    messages.push(...hydrateMessages(headers, bodies))
  }
  return messages
}

async function hydrateAllStoredMessagesInPages(db: NatterDb): Promise<Message[]> {
  const messages: Message[] = []
  for await (const headers of tablePages(db.messages)) {
    const bodies = (await db.messageBodies.bulkGet(headers.map((row) => row.id))).filter(
      (row): row is MessageBodyRow => row !== undefined,
    )
    recordMessageBodyRead(headers.length)
    recordTableRead(bodies.length)
    messages.push(...hydrateMessages(headers, bodies))
  }
  return messages
}

async function storeMessagesInPages(db: NatterDb, messages: readonly Message[]): Promise<void> {
  for (const page of pages(messages)) {
    const split = page.map((message) => splitMessageForStorage(message))
    await db.messages.bulkPut(split.map((row) => row.header))
    await db.messageBodies.bulkPut(split.map((row) => row.body))
    recordTableWrite(split.length)
    recordTableWrite(split.length)
  }
}

async function replaceMessageAttachmentReferenceOwnersInPages(
  tx: Parameters<typeof replaceAttachmentReferenceOwners>[0],
  messages: readonly Message[],
): Promise<void> {
  for (const page of pages(messages)) {
    await replaceAttachmentReferenceOwners(
      tx,
      page.map((message) => ({
        ownerKind: 'message' as const,
        ownerId: message.id,
        chatId: message.chatId,
        refs: message.attachmentRefs,
      })),
    )
  }
}

function* pages<T>(rows: readonly T[]): Generator<T[]> {
  for (let index = 0; index < rows.length; index += IMPORT_EXPORT_PAGE_SIZE) {
    yield rows.slice(index, index + IMPORT_EXPORT_PAGE_SIZE)
  }
}

async function readTableInPages<T>(table: Table<T, string>): Promise<T[]> {
  const rows: T[] = []
  for await (const page of tablePages(table)) rows.push(...page)
  return rows
}

async function* tablePages<T>(table: Table<T, string>): AsyncGenerator<T[]> {
  let after: string | undefined
  for (;;) {
    const page: T[] = []
    let lastPrimaryKey: string | undefined
    const collection = after === undefined ? table.orderBy(':id') : table.where(':id').above(after)
    await collection.limit(IMPORT_EXPORT_PAGE_SIZE).each((row, cursor) => {
      if (typeof cursor.primaryKey !== 'string') {
        throw new Error(`ImportExportPrimaryKeyInvalid:${table.name}`)
      }
      page.push(row)
      lastPrimaryKey = cursor.primaryKey
    })
    if (page.length === 0) return
    recordTableRead(page.length)
    yield page
    if (page.length < IMPORT_EXPORT_PAGE_SIZE) return
    if (lastPrimaryKey === undefined) throw new Error(`ImportExportPrimaryKeyMissing:${table.name}`)
    after = lastPrimaryKey
  }
}

async function readCollectionInPages<T>(collection: Collection<T, string>): Promise<T[]> {
  const rows: T[] = []
  let batchRows = 0
  await collection.clone().each((row) => {
    rows.push(row)
    batchRows += 1
    if (batchRows !== IMPORT_EXPORT_PAGE_SIZE) return
    recordTableRead(batchRows)
    batchRows = 0
  })
  if (batchRows > 0) recordTableRead(batchRows)
  return rows
}

async function bulkPutInPages<T>(table: Table<T, string>, rows: readonly T[]): Promise<void> {
  for (const page of pages(rows)) {
    await table.bulkPut(page)
    recordTableWrite(page.length)
  }
}

function emptyMaterializationMetrics(): ImportExportMaterializationMetrics {
  return {
    tableReadBatches: 0,
    tableReadRows: 0,
    maxTableReadBatchRows: 0,
    tableWriteBatches: 0,
    tableWriteRows: 0,
    maxTableWriteBatchRows: 0,
    messageBodyReadBatches: 0,
    maxMessageBodyReadBatchRows: 0,
    attachmentBlobReadBytes: 0,
    maxAttachmentBlobReadBytes: 0,
    attachmentBlobDecodeBytes: 0,
    maxAttachmentBlobDecodeBytes: 0,
  }
}

function recordTableRead(rows: number): void {
  materializationMetrics.tableReadBatches += 1
  materializationMetrics.tableReadRows += rows
  materializationMetrics.maxTableReadBatchRows = Math.max(
    materializationMetrics.maxTableReadBatchRows,
    rows,
  )
}

function recordTableWrite(rows: number): void {
  materializationMetrics.tableWriteBatches += 1
  materializationMetrics.tableWriteRows += rows
  materializationMetrics.maxTableWriteBatchRows = Math.max(
    materializationMetrics.maxTableWriteBatchRows,
    rows,
  )
}

function recordMessageBodyRead(rows: number): void {
  materializationMetrics.messageBodyReadBatches += 1
  materializationMetrics.maxMessageBodyReadBatchRows = Math.max(
    materializationMetrics.maxMessageBodyReadBatchRows,
    rows,
  )
}

async function portableBlob(blob: AttachmentBlob): Promise<PortableAttachmentBlob> {
  const bytes = await blobBytes(blob.blob)
  materializationMetrics.attachmentBlobReadBytes += bytes.byteLength
  materializationMetrics.maxAttachmentBlobReadBytes = Math.max(
    materializationMetrics.maxAttachmentBlobReadBytes,
    bytes.byteLength,
  )
  return {
    id: blob.id,
    attachmentId: blob.attachmentId,
    role: blob.role,
    mime: blob.mime,
    contentHash: blob.contentHash,
    sizeBytes: blob.sizeBytes,
    dataBase64: bytesToBase64(bytes),
    createdAt: blob.createdAt,
  }
}

async function prepareImportedAttachments(
  db: NatterDb,
  bundles: readonly PortableAttachmentBundle[],
): Promise<ImportedAttachmentBundle[]> {
  const prepared: ImportedAttachmentBundle[] = []
  for (const bundle of bundles) {
    const duplicate = await findExistingAttachment(db, bundle.attachment)
    if (duplicate) {
      prepared.push({
        sourceAttachmentId: bundle.attachment.id,
        targetAttachmentId: duplicate.id,
        reused: true,
      })
      continue
    }
    const stored = await validatedAttachmentBundleFromPortableWithNewIds(bundle)
    prepared.push({
      sourceAttachmentId: bundle.attachment.id,
      targetAttachmentId: stored.attachment.id,
      reused: false,
      bundle: stored,
    })
  }
  return prepared
}

async function findExistingAttachment(
  db: NatterDb,
  source: Attachment,
): Promise<Attachment | undefined> {
  if (!source.contentHash) return undefined
  return db.attachments
    .where('contentHash')
    .equals(source.contentHash)
    .filter(
      (attachment) =>
        attachment.filename === source.filename &&
        attachment.deletedAt === undefined &&
        attachment.storage.kind !== 'missing',
    )
    .first()
}

async function validatePortableAttachmentBundles(
  bundles: readonly PortableAttachmentBundle[],
): Promise<ReadonlyMap<PortableAttachmentBlob, string>> {
  const blobTypes = new Map<PortableAttachmentBlob, string>()
  for (const bundle of bundles) {
    for (const blob of bundle.blobs) {
      blobTypes.set(blob, await validatePortableBlob(blob))
    }
    verifyPortableBundleIntegrity(bundle.attachment, bundle.blobs)
  }
  return blobTypes
}

async function validatedAttachmentBundleFromPortableWithNewIds(
  bundle: PortableAttachmentBundle,
): Promise<ValidatedAttachmentBundle> {
  const source = {
    attachment: structuredClone(bundle.attachment),
    blobs: bundle.blobs.map((blob) => ({ ...blob })),
    artifacts: structuredClone(bundle.artifacts),
    jobs: structuredClone(bundle.jobs),
  }
  const targetAttachmentId = newId()
  const blobIdMap = new Map<string, string>()
  const artifactIdMap = new Map<string, string>()
  const blobs = await validatePortableBlobs(
    source.blobs.map((blob) => {
      const targetBlobId = newId()
      blobIdMap.set(blob.id, targetBlobId)
      return { ...blob, id: targetBlobId, attachmentId: targetAttachmentId }
    }),
  )
  for (const artifact of source.artifacts) artifactIdMap.set(artifact.artifactId, newId())

  const attachment: Attachment = rewriteAttachmentForImport(
    source.attachment,
    targetAttachmentId,
    blobIdMap,
    artifactIdMap,
  )
  const artifacts = source.artifacts.map((artifact) =>
    rewriteArtifactForImport(artifact, targetAttachmentId, blobIdMap, artifactIdMap),
  )
  const jobs = source.jobs.map((job) => rewriteJobForImport(job, targetAttachmentId, artifactIdMap))
  verifyPortableBundleIntegrity(attachment, blobs)
  return { attachment, blobs, artifacts, jobs }
}

async function validatePortableBlobs(
  blobs: readonly PortableAttachmentBlob[],
): Promise<ValidatedPortableAttachmentBlob[]> {
  const validated: ValidatedPortableAttachmentBlob[] = []
  for (const blob of blobs) {
    validated.push({ ...blob, blobType: await validatePortableBlob(blob) })
  }
  return validated
}

async function validatePortableBlob(blob: PortableAttachmentBlob): Promise<string> {
  const bytes = base64ToBytes(blob.dataBase64)
  const computedHash = await sha256BytesHex(bytes)
  if (computedHash !== blob.contentHash) {
    throw new Error(`ImportAttachmentBlobHashMismatch:${blob.id}`)
  }
  if (bytes.byteLength !== blob.sizeBytes) {
    throw new Error(`ImportAttachmentBlobSizeMismatch:${blob.id}`)
  }
  return (await makeBlob(new Uint8Array(0), blob.mime)).type
}

function materializeValidatedBlob(blob: ValidatedPortableAttachmentBlob): AttachmentBlob {
  return materializePortableBlob(blob, blob.blobType)
}

function materializePortableBlob(blob: PortableAttachmentBlob, blobType: string): AttachmentBlob {
  const bytes = base64ToBytes(blob.dataBase64)
  return {
    id: blob.id,
    attachmentId: blob.attachmentId,
    role: blob.role,
    mime: blob.mime,
    contentHash: blob.contentHash,
    sizeBytes: blob.sizeBytes,
    blob: makeStoredBlob(bytes, blobType),
    createdAt: blob.createdAt,
  }
}

async function storeValidatedAttachmentBundle(
  db: NatterDb,
  bundle: ValidatedAttachmentBundle,
): Promise<void> {
  await db
    .table<AttachmentHeaderRow, string>('attachments')
    .put(splitAttachmentForStorage({ ...bundle.attachment, refCount: 0 }))
  recordTableWrite(1)
  for (const blob of bundle.blobs) {
    await db.attachmentBlobs.put(materializeValidatedBlob(blob))
    recordTableWrite(1)
  }
  await bulkPutInPages(db.attachmentArtifacts, bundle.artifacts)
  await bulkPutInPages(db.attachmentJobs, bundle.jobs)
}

async function storePortableAttachmentBundle(
  db: NatterDb,
  bundle: PortableAttachmentBundle,
  blobTypes: ReadonlyMap<PortableAttachmentBlob, string>,
): Promise<void> {
  await db
    .table<AttachmentHeaderRow, string>('attachments')
    .put(splitAttachmentForStorage({ ...bundle.attachment, refCount: 0 }))
  recordTableWrite(1)
  for (const blob of bundle.blobs) {
    const blobType = blobTypes.get(blob)
    if (blobType === undefined) throw new Error(`ImportAttachmentBlobValidationMissing:${blob.id}`)
    await db.attachmentBlobs.put(materializePortableBlob(blob, blobType))
    recordTableWrite(1)
  }
  await bulkPutInPages(db.attachmentArtifacts, bundle.artifacts)
  await bulkPutInPages(db.attachmentJobs, bundle.jobs)
}

function verifyPortableBundleIntegrity(
  attachment: Attachment,
  blobs: readonly Pick<AttachmentBlob, 'contentHash' | 'id' | 'role'>[],
): void {
  if (!attachment.contentHash) return
  const originalBlobId =
    attachment.storage.kind === 'local-blob'
      ? attachment.storage.blobId
      : blobs.find((blob) => blob.role === 'original')?.id
  const original = originalBlobId ? blobs.find((blob) => blob.id === originalBlobId) : undefined
  if (original && original.contentHash !== attachment.contentHash) {
    throw new Error(`ImportAttachmentHashMismatch:${attachment.id}`)
  }
}

function rewriteAttachmentForImport(
  source: Attachment,
  targetAttachmentId: AttachmentId,
  blobIdMap: ReadonlyMap<string, string>,
  artifactIdMap: ReadonlyMap<string, string>,
): Attachment {
  const attachment = structuredClone(source)
  attachment.id = targetAttachmentId
  attachment.origin = 'import'
  attachment.refCount = 0
  attachment.artifacts = source.artifacts.map((artifact) =>
    rewriteArtifactForImport(artifact, targetAttachmentId, blobIdMap, artifactIdMap),
  )
  attachment.processing = source.processing.map((state) => ({
    ...structuredClone(state),
    outputArtifactIds: state.outputArtifactIds.map((id) => artifactIdMap.get(id) ?? id),
  }))
  if (attachment.storage.kind === 'local-blob') {
    const blobId = blobIdMap.get(attachment.storage.blobId)
    if (!blobId) {
      attachment.storage = {
        kind: 'missing',
        reason: 'import-missing',
        missingSince: Date.now(),
        lastKnownBlobId: attachment.storage.blobId,
      }
    } else {
      attachment.storage = { kind: 'local-blob', blobId }
    }
  }
  if (attachment.thumbnailBlobId) {
    const mapped = blobIdMap.get(attachment.thumbnailBlobId)
    if (mapped) attachment.thumbnailBlobId = mapped
    else delete attachment.thumbnailBlobId
  }
  return attachment
}

function rewriteArtifactForImport(
  artifact: AttachmentArtifact,
  attachmentId: AttachmentId,
  blobIdMap: ReadonlyMap<string, string>,
  artifactIdMap: ReadonlyMap<string, string>,
): AttachmentArtifact {
  const next = structuredClone(artifact)
  next.artifactId = artifactIdMap.get(artifact.artifactId) ?? artifact.artifactId
  next.attachmentId = attachmentId
  if (next.kind === 'blob') next.blobId = blobIdMap.get(next.blobId) ?? next.blobId
  return next
}

function rewriteJobForImport(
  job: AttachmentJob,
  attachmentId: AttachmentId,
  artifactIdMap: ReadonlyMap<string, string>,
): AttachmentJob {
  return {
    ...structuredClone(job),
    id: newId(),
    attachmentId,
    outputArtifactIds: job.outputArtifactIds.map((id) => artifactIdMap.get(id) ?? id),
  }
}

function collectAttachmentIds(messages: readonly Message[]): AttachmentId[] {
  const ids: AttachmentId[] = []
  for (const message of messages) {
    for (const ref of message.attachmentRefs ?? []) ids.push(ref.attachmentId)
    for (const item of message.content) {
      const id = contentAttachmentId(item)
      if (id) ids.push(id)
    }
  }
  return ids
}

function contentAttachmentId(item: ContentItem): AttachmentId | undefined {
  switch (item.type) {
    case 'image_url':
    case 'input_audio':
    case 'file':
    case 'video_url':
    case 'output_image':
    case 'audio_output':
    case 'output_video':
      return item.attachmentId
    case 'text':
    case 'output_text':
      return undefined
  }
}

function remapImportedMessage(
  message: Message,
  maps: {
    chatId: Chat['id']
    messageIdMap: Record<string, string>
    turnIdMap: Map<string, string>
    attachmentIdMap: Record<string, string>
  },
): Message {
  const id = maps.messageIdMap[message.id]
  if (!id) throw new Error(`ImportMessageIdMissing:${message.id}`)
  let parentId: MessageId | null = null
  if (message.parentId !== null) {
    const mappedParentId = maps.messageIdMap[message.parentId]
    if (!mappedParentId) throw new Error(`ImportParentMissing:${message.id}`)
    parentId = mappedParentId
  }
  let turnId = maps.turnIdMap.get(message.turnId)
  if (!turnId) {
    turnId = newId()
    maps.turnIdMap.set(message.turnId, turnId)
  }
  const next: Message = {
    ...structuredClone(message),
    id,
    chatId: maps.chatId,
    parentId,
    turnId,
    nodeVersion: 0,
  }
  next.content = message.content.map((item) => remapContentAttachmentId(item, maps.attachmentIdMap))
  if (message.attachmentRefs) {
    next.attachmentRefs = message.attachmentRefs.map((ref) =>
      remapAttachmentRef(ref, maps.attachmentIdMap),
    )
  }
  return next
}

function remapContentAttachmentId(
  item: ContentItem,
  attachmentIdMap: Record<string, string>,
): ContentItem {
  const next = structuredClone(item)
  const id = contentAttachmentId(next)
  if (!id) return next
  const mapped = attachmentIdMap[id]
  if (!mapped) return next
  switch (next.type) {
    case 'image_url':
    case 'input_audio':
    case 'file':
    case 'video_url':
    case 'output_image':
    case 'audio_output':
    case 'output_video':
      next.attachmentId = mapped
      break
    case 'text':
    case 'output_text':
      break
  }
  return next
}

function remapAttachmentRef(
  ref: MessageAttachmentRef,
  attachmentIdMap: Record<string, string>,
): MessageAttachmentRef {
  return {
    ...structuredClone(ref),
    refId: newId(),
    attachmentId: attachmentIdMap[ref.attachmentId] ?? ref.attachmentId,
  }
}

function countLiveAttachmentRefs(messages: readonly Message[]): Map<AttachmentId, number> {
  const counts = new Map<AttachmentId, number>()
  for (const message of messages) {
    for (const ref of message.attachmentRefs ?? []) {
      if (ref.deletedAt !== undefined) continue
      counts.set(ref.attachmentId, (counts.get(ref.attachmentId) ?? 0) + 1)
    }
  }
  return counts
}

function childListsForMessages(
  chatId: string,
  messages: readonly Message[],
  updatedAt: number,
): ChildListState[] {
  const parentIds = new Set<MessageId | null>([null])
  for (const message of messages) parentIds.add(message.parentId)
  return [...parentIds].map((parentId) => ({
    id: childListKey(chatId, parentId),
    chatId,
    parentId,
    version: 0,
    updatedAt,
  }))
}

function sortMessages(messages: Message[]): Message[] {
  return messages.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    if (left.turnIndex !== right.turnIndex) return left.turnIndex - right.turnIndex
    if (left.siblingIndex !== right.siblingIndex) return left.siblingIndex - right.siblingIndex
    return left.id.localeCompare(right.id)
  })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  materializationMetrics.attachmentBlobDecodeBytes += bytes.byteLength
  materializationMetrics.maxAttachmentBlobDecodeBytes = Math.max(
    materializationMetrics.maxAttachmentBlobDecodeBytes,
    bytes.byteLength,
  )
  return bytes
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  const withArrayBuffer = blob as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }
  if (typeof withArrayBuffer.arrayBuffer === 'function') {
    return new Uint8Array(await withArrayBuffer.arrayBuffer())
  }
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error ?? new Error('BlobReadFailed'))
      reader.onload = () => {
        if (!(reader.result instanceof ArrayBuffer)) {
          reject(new Error('BlobReadFailed'))
          return
        }
        resolve(new Uint8Array(reader.result))
      }
      reader.readAsArrayBuffer(blob)
    })
  }
  throw new Error('BlobReadUnsupported')
}

async function makeBlob(bytes: Uint8Array, mime: string): Promise<Blob> {
  const blobBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(blobBuffer).set(bytes)
  if (typeof Response === 'function') {
    const init: ResponseInit = mime ? { headers: { 'content-type': mime } } : {}
    return new Response(blobBuffer, init).blob()
  }
  return new Blob([blobBuffer], { type: mime })
}

function makeStoredBlob(bytes: Uint8Array, mime: string): Blob {
  const blobBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(blobBuffer).set(bytes)
  return new Blob([blobBuffer], { type: mime })
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
