import { findLastUpdatedLeafId } from '../core/active-path'
import { sha256Hex as sha256BytesHex } from '../core/attachments/process'
import { buildBranchCacheRow } from '../core/branch-flatten'
import {
  flattenChatSettingsForPortableExport,
  stripPromptPresetPins,
} from '../core/import-export/flatten'
import {
  NATTER_EXPORT_SCHEMA_VERSION,
  type ChatExportEnvelope,
  type ChatPresetExportEnvelope,
  type ConnectionSketch,
  type NatterExportEnvelope,
  type NatterExportObjectKind,
  type PortableAttachmentBlob,
  type PortableAttachmentBundle,
  type PortableChatPresetPayload,
  type PortableChatPayload,
  type PortableFolderSketch,
  type PortableTagSketch,
  type WorkspaceBackupPayload,
  type WorkspaceBackupEnvelope,
} from '../core/import-export/schema'
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
import { postEvent } from './broadcast'
import { childListKey, openDb, type NatterDb } from './db'
import type {
  ImportChatOptions,
  ImportChatPresetOptions,
  ImportChatPresetResult,
  ImportChatResult,
  RestoreWorkspaceBackupOptions,
  RestoreWorkspaceBackupResult,
  WorkspaceImportExportBackend,
} from './import-export'
import {
  hydrateMessages,
  splitMessageForStorage,
  type MessageBodyRow,
} from './message-storage'
import { PresetMissingError } from './presets'

const WORKSPACE_META_KEY = 'workspace-meta'
const WORKSPACE_ID = 'browser-idb:natter'

interface StoredAttachmentBundle {
  attachment: Attachment
  blobs: AttachmentBlob[]
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
  bundle?: StoredAttachmentBundle
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
        const headers = await db.messages.where('chatId').equals(chatId).toArray()
        const bodies = (await db.messageBodies.bulkGet(headers.map((row) => row.id))).filter(
          (row): row is MessageBodyRow => row !== undefined,
        )
        const messages = sortMessages(hydrateMessages(headers, bodies))
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
        ...(snapshot.chat.favoriteModels ? { favoriteModels: [...snapshot.chat.favoriteModels] } : {}),
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
    validatePortableMessages(payload.messages)
    const resolvedProfile = await resolveProfileId(db, payload.chat.settings, payload.connectionSketch, {
      targetProfileId: options.targetProfileId,
    })

    const attachmentRows = await prepareImportedAttachments(db, payload.attachments)
    const attachmentIdMap = Object.fromEntries(
      attachmentRows.map((row) => [row.sourceAttachmentId, row.targetAttachmentId]),
    )
    const chatId = newId()
    const messageIdMap = Object.fromEntries(payload.messages.map((message) => [message.id, newId()]))
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
    const splitMessages = messages.map((message) => splitMessageForStorage(message))
    const childLists = childListsForMessages(chatId, messages, now)
    const createdAttachmentIds: AttachmentId[] = []
    const reusedAttachmentIds: AttachmentId[] = []

    await db.transaction(
      'rw',
      [
        db.attachmentArtifacts,
        db.attachmentBlobs,
        db.attachmentJobs,
        db.attachments,
        db.chatBranchCache,
        db.chats,
        db.childLists,
        db.folders,
        db.messageBodies,
        db.messages,
        db.settings,
        db.tags,
      ],
      async () => {
        const folderResult = await ensurePortableFolder(db, payload.folder, now)
        folderId = folderResult.folderId
        if (folderResult.created && folderResult.folderId) {
          createdFolderIds.push(folderResult.folderId)
        }

        const tagResult = await ensurePortableTags(db, payload.tags, now)
        tagIds = tagResult.tagIds
        createdTagIds.push(...tagResult.createdTagIds)

        for (const imported of attachmentRows) {
          const refCount = liveRefCounts.get(imported.targetAttachmentId) ?? 0
          if (imported.reused) {
            const existing = await db.attachments.get(imported.targetAttachmentId)
            if (existing && refCount > 0) {
              await db.attachments.put({ ...existing, refCount: existing.refCount + refCount })
            }
            reusedAttachmentIds.push(imported.targetAttachmentId)
            continue
          }
          if (!imported.bundle) continue
          const attachment: Attachment = {
            ...imported.bundle.attachment,
            refCount,
          }
          await db.attachments.put(attachment)
          if (imported.bundle.blobs.length > 0) await db.attachmentBlobs.bulkPut(imported.bundle.blobs)
          if (imported.bundle.artifacts.length > 0) {
            await db.attachmentArtifacts.bulkPut(imported.bundle.artifacts)
          }
          if (imported.bundle.jobs.length > 0) await db.attachmentJobs.bulkPut(imported.bundle.jobs)
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
          ...(payload.chat.favoriteModels ? { favoriteModels: [...payload.chat.favoriteModels] } : {}),
          ...(payload.chat.recentModels ? { recentModels: [...payload.chat.recentModels] } : {}),
          previewText: branchCache.previewText,
        }
        await db.chats.put(chat)
        if (splitMessages.length > 0) {
          await db.messages.bulkPut(splitMessages.map((row) => row.header))
          await db.messageBodies.bulkPut(splitMessages.map((row) => row.body))
        }
        if (childLists.length > 0) await db.childLists.bulkPut(childLists)
        await db.chatBranchCache.put(branchCache)
        await touchWorkspaceMeta(db, now)
      },
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
      createdAt: now,
      updatedAt: now,
      archived: false,
    }
    await db.transaction('rw', [db.presets, db.settings], async () => {
      await db.presets.put(preset)
      await touchWorkspaceMeta(db, now)
    })
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
        const headers = await db.messages.toArray()
        const bodies = (await db.messageBodies.bulkGet(headers.map((row) => row.id))).filter(
          (row): row is MessageBodyRow => row !== undefined,
        )
        return {
          chats: await db.chats.toArray(),
          messages: sortMessages(hydrateMessages(headers, bodies)),
          childLists: await db.childLists.toArray(),
          chatBranchCache: await db.chatBranchCache.toArray(),
          attachmentBundles: await storedAttachmentBundles(
            db,
            (await db.attachments.toArray()).map((row) => row.id),
          ),
          profiles: await db.profiles.toArray(),
          presets: await db.presets.toArray(),
          promptPresets: await db.promptPresets.toArray(),
          folders: await db.folders.toArray(),
          tags: await db.tags.toArray(),
          drafts: await db.drafts.toArray(),
          keys: await db.keys.toArray(),
          settings: await db.settings.toArray(),
        }
    })

    return envelope(db, 'workspace-backup', {
      chats: snapshot.chats,
      messages: snapshot.messages,
      childLists: snapshot.childLists,
      chatBranchCache: snapshot.chatBranchCache,
      attachments: await portableAttachmentBundles(snapshot.attachmentBundles),
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
    validatePortableMessages(envelope.payload.messages)
    const attachmentBundles = await Promise.all(
      envelope.payload.attachments.map((bundle) => storedBundleFromPortable(bundle)),
    )
    const splitMessages = envelope.payload.messages.map((message) => splitMessageForStorage(message))
    await db.transaction('rw', db.tables, async () => {
      for (const table of db.tables) await table.clear()
      if (envelope.payload.folders.length > 0) await db.folders.bulkPut(envelope.payload.folders)
      if (envelope.payload.tags.length > 0) await db.tags.bulkPut(envelope.payload.tags)
      if (envelope.payload.profiles.length > 0) await db.profiles.bulkPut(envelope.payload.profiles)
      if (envelope.payload.presets.length > 0) await db.presets.bulkPut(envelope.payload.presets)
      if (envelope.payload.promptPresets.length > 0) {
        await db.promptPresets.bulkPut(envelope.payload.promptPresets)
      }
      if (envelope.payload.keys.length > 0) await db.keys.bulkPut(envelope.payload.keys)
      if (envelope.payload.settings.length > 0) await db.settings.bulkPut(envelope.payload.settings)
      if (envelope.payload.chats.length > 0) await db.chats.bulkPut(envelope.payload.chats)
      if (splitMessages.length > 0) {
        await db.messages.bulkPut(splitMessages.map((row) => row.header))
        await db.messageBodies.bulkPut(splitMessages.map((row) => row.body))
      }
      if (envelope.payload.childLists.length > 0) {
        await db.childLists.bulkPut(envelope.payload.childLists)
      }
      if (envelope.payload.chatBranchCache.length > 0) {
        await db.chatBranchCache.bulkPut(envelope.payload.chatBranchCache)
      }
      for (const bundle of attachmentBundles) {
        await db.attachments.put(bundle.attachment)
        if (bundle.blobs.length > 0) await db.attachmentBlobs.bulkPut(bundle.blobs)
        if (bundle.artifacts.length > 0) await db.attachmentArtifacts.bulkPut(bundle.artifacts)
        if (bundle.jobs.length > 0) await db.attachmentJobs.bulkPut(bundle.jobs)
      }
      await touchWorkspaceMeta(db, now)
    })
    postEvent({ kind: 'workspace-replaced' })
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

async function storedAttachmentBundles(
  db: NatterDb,
  ids: Iterable<AttachmentId>,
): Promise<StoredAttachmentBundle[]> {
  const bundles: StoredAttachmentBundle[] = []
  for (const id of [...new Set(ids)]) {
    const attachment = await db.attachments.get(id)
    if (!attachment) continue
    bundles.push({
      attachment,
      blobs: await db.attachmentBlobs.where('attachmentId').equals(id).toArray(),
      artifacts: await db.attachmentArtifacts.where('attachmentId').equals(id).toArray(),
      jobs: await db.attachmentJobs.where('attachmentId').equals(id).toArray(),
    })
  }
  return bundles
}

async function portableAttachmentBundles(
  bundles: readonly StoredAttachmentBundle[],
): Promise<PortableAttachmentBundle[]> {
  return Promise.all(
    bundles.map(async (bundle) => ({
      attachment: structuredClone(bundle.attachment),
      blobs: await Promise.all(bundle.blobs.map(portableBlob)),
      artifacts: structuredClone(bundle.artifacts),
      jobs: structuredClone(bundle.jobs),
    })),
  )
}

async function portableBlob(blob: AttachmentBlob): Promise<PortableAttachmentBlob> {
  return {
    id: blob.id,
    attachmentId: blob.attachmentId,
    role: blob.role,
    mime: blob.mime,
    contentHash: blob.contentHash,
    sizeBytes: blob.sizeBytes,
    dataBase64: bytesToBase64(await blobBytes(blob.blob)),
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
    const stored = await storedBundleFromPortableWithNewIds(bundle)
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

async function storedBundleFromPortable(
  bundle: PortableAttachmentBundle,
): Promise<StoredAttachmentBundle> {
  return {
    attachment: structuredClone(bundle.attachment),
    blobs: await Promise.all(bundle.blobs.map(storedBlob)),
    artifacts: structuredClone(bundle.artifacts),
    jobs: structuredClone(bundle.jobs),
  }
}

async function storedBundleFromPortableWithNewIds(
  bundle: PortableAttachmentBundle,
): Promise<StoredAttachmentBundle> {
  const targetAttachmentId = newId()
  const blobIdMap = new Map<string, string>()
  const artifactIdMap = new Map<string, string>()
  const blobs = await Promise.all(
    bundle.blobs.map(async (blob) => {
      const targetBlobId = newId()
      blobIdMap.set(blob.id, targetBlobId)
      return storedBlob({ ...blob, id: targetBlobId, attachmentId: targetAttachmentId })
    }),
  )
  for (const artifact of bundle.artifacts) artifactIdMap.set(artifact.artifactId, newId())

  const attachment: Attachment = rewriteAttachmentForImport(
    bundle.attachment,
    targetAttachmentId,
    blobIdMap,
    artifactIdMap,
  )
  const artifacts = bundle.artifacts.map((artifact) =>
    rewriteArtifactForImport(artifact, targetAttachmentId, blobIdMap, artifactIdMap),
  )
  const jobs = bundle.jobs.map((job) =>
    rewriteJobForImport(job, targetAttachmentId, artifactIdMap),
  )
  await verifyPortableBundleIntegrity(attachment, blobs)
  return { attachment, blobs, artifacts, jobs }
}

async function storedBlob(blob: PortableAttachmentBlob): Promise<AttachmentBlob> {
  const bytes = base64ToBytes(blob.dataBase64)
  const computedHash = await sha256BytesHex(bytes)
  if (computedHash !== blob.contentHash) {
    throw new Error(`ImportAttachmentBlobHashMismatch:${blob.id}`)
  }
  if (bytes.byteLength !== blob.sizeBytes) {
    throw new Error(`ImportAttachmentBlobSizeMismatch:${blob.id}`)
  }
  return {
    id: blob.id,
    attachmentId: blob.attachmentId,
    role: blob.role,
    mime: blob.mime,
    contentHash: blob.contentHash,
    sizeBytes: blob.sizeBytes,
    blob: await makeBlob(bytes, blob.mime),
    createdAt: blob.createdAt,
  }
}

async function verifyPortableBundleIntegrity(
  attachment: Attachment,
  blobs: readonly AttachmentBlob[],
): Promise<void> {
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

function validatePortableMessages(messages: readonly Message[]): void {
  const ids = new Set(messages.map((message) => message.id))
  if (ids.size !== messages.length) throw new Error('ImportMessageDuplicateId')
  for (const message of messages) {
    if (message.parentId !== null && !ids.has(message.parentId)) {
      throw new Error(`ImportParentMissing:${message.id}`)
    }
    const seen = new Set<MessageId>([message.id])
    let parentId = message.parentId
    while (parentId !== null) {
      if (seen.has(parentId)) throw new Error(`ImportParentCycle:${message.id}`)
      seen.add(parentId)
      const parent = messages.find((row) => row.id === parentId)
      parentId = parent?.parentId ?? null
    }
  }
}

function sortMessages(messages: Message[]): Message[] {
  return messages.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    if (left.turnIndex !== right.turnIndex) return left.turnIndex - right.turnIndex
    if (left.siblingIndex !== right.siblingIndex) return left.siblingIndex - right.siblingIndex
    return left.id.localeCompare(right.id)
  })
}

async function touchWorkspaceMeta(db: NatterDb, now: number): Promise<void> {
  const stored = (await db.settings.get(WORKSPACE_META_KEY))?.value as
    | { workspaceId?: string; lastMutationAt?: number; mutationCounter?: number }
    | undefined
  const next = {
    workspaceId: stored?.workspaceId ?? WORKSPACE_ID,
    backendKind: 'browser-idb' as const,
    lastMutationAt: now,
    mutationCounter: (stored?.mutationCounter ?? 0) + 1,
  }
  await db.settings.put({ key: WORKSPACE_META_KEY, value: next })
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

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
