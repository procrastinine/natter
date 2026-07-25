import type {
  Attachment,
  AttachmentArtifact,
  AttachmentJob,
  Chat,
  ChatFolder,
  ChatPreset,
  ChatSettings,
  ChatTag,
  ChildListState,
  ConnectionKind,
  ConnectionProfile,
  DraftRow,
  KeyRecord,
  Message,
  ProfileId,
  PromptPreset,
} from '../types'
import {
  assertPortableChatPresetRows,
  assertPortableChatRows,
  assertPortableConnectionProfileRows,
  assertWorkspaceBackupRows,
} from './row-validation'

export const NATTER_EXPORT_SCHEMA_VERSION = 2

export type NatterExportObjectKind =
  | 'workspace-backup'
  | 'chat'
  | 'chat-preset'
  | 'connection-profile'

interface ExportSourceMeta {
  app: 'natter'
  backendKind: 'browser-idb' | 'daemon' | 'unknown'
  workspaceId?: string
}

interface NatterExportEnvelopeBase<TKind extends NatterExportObjectKind, TPayload> {
  objectKind: TKind
  exportSchemaVersion: typeof NATTER_EXPORT_SCHEMA_VERSION
  appStorageSchemaVersion: number
  createdAt: number
  source: ExportSourceMeta
  payload: TPayload
}

export interface ConnectionSketch {
  sourceProfileId?: ProfileId
  name: string
  kind: ConnectionKind
  baseUrl: string
}

export interface PortableFolderSketch {
  name: string
  color?: string
}

export interface PortableTagSketch {
  name: string
  color?: string
}

export interface PortableAttachmentBlob {
  id: string
  attachmentId: string
  role: 'original' | 'thumbnail' | 'image-resize' | 'normalized' | 'tool-peel'
  mime: string
  contentHash: string
  sizeBytes: number
  dataBase64: string
  createdAt: number
}

export interface PortableAttachmentBundle {
  attachment: Attachment
  blobs: PortableAttachmentBlob[]
  artifacts: AttachmentArtifact[]
  jobs: AttachmentJob[]
}

interface PortableChatHeader {
  sourceChatId: string
  title: string
  createdAt: number
  updatedAt: number
  settings: ChatSettings
  color?: string
  favoriteModels?: string[]
  recentModels?: string[]
}

export interface PortableChatPayload {
  chat: PortableChatHeader
  messages: Message[]
  folder?: PortableFolderSketch
  tags: PortableTagSketch[]
  attachments: PortableAttachmentBundle[]
  connectionSketch?: ConnectionSketch
}

export interface PortableChatPresetPayload {
  sourcePresetId: string
  name: string
  settings: ChatSettings
  createdAt: number
  updatedAt: number
  connectionSketch?: ConnectionSketch
}

export interface PortableConnectionProfilePayload
  extends Pick<
    ConnectionProfile,
    | 'name'
    | 'kind'
    | 'baseUrl'
    | 'defaultHeaders'
    | 'appTitle'
    | 'appUrl'
    | 'appCategories'
    | 'supportsEndpointsApi'
    | 'supportsGenerationApi'
    | 'supportsPrivacyScrape'
    | 'capabilityOverrides'
    | 'debugRequests'
  > {
  sourceProfileId: ProfileId
}

interface WorkspaceSettingsRow {
  key: string
  value: unknown
}

interface LegacyChatBranchCache {
  chatId: string
  branchLeafId: string | null
  generatedAt: number
  textContent: string
  previewText: string
  messageCount: number
  wordCount: number
  messageTimestamps: Array<{
    id: string
    createdAt: number
    editedAt: number
  }>
}

export interface WorkspaceBackupPayload {
  manifest?: WorkspaceBackupManifest
  chats: Chat[]
  messages: Message[]
  childLists: ChildListState[]
  chatBranchCache: LegacyChatBranchCache[]
  attachments: PortableAttachmentBundle[]
  profiles: ConnectionProfile[]
  presets: ChatPreset[]
  promptPresets: PromptPreset[]
  folders: ChatFolder[]
  tags: ChatTag[]
  drafts: DraftRow[]
  keys: KeyRecord[]
  settings: WorkspaceSettingsRow[]
}

export const WORKSPACE_BACKUP_TABLE_KEYS = [
  'chats',
  'messages',
  'childLists',
  'chatBranchCache',
  'attachments',
  'profiles',
  'presets',
  'promptPresets',
  'folders',
  'tags',
  'drafts',
  'keys',
  'settings',
] as const

type WorkspaceBackupTableKey = (typeof WORKSPACE_BACKUP_TABLE_KEYS)[number]

export interface WorkspaceBackupManifest {
  version: 1
  counts: Record<WorkspaceBackupTableKey, number>
  attachmentBlobCount: number
  attachmentBlobBytes: number
}

export function workspaceBackupManifest(
  payload: Omit<WorkspaceBackupPayload, 'manifest'>,
): WorkspaceBackupManifest {
  let attachmentBlobCount = 0
  let attachmentBlobBytes = 0
  for (const bundle of payload.attachments) {
    attachmentBlobCount += bundle.blobs.length
    if (!Number.isSafeInteger(attachmentBlobCount)) {
      throw new Error('ExportWorkspaceManifestBlobCountOverflow')
    }
    for (const blob of bundle.blobs) {
      if (!Number.isSafeInteger(blob.sizeBytes) || blob.sizeBytes < 0) {
        throw new Error(`ExportWorkspaceManifestBlobSizeInvalid:${blob.id}`)
      }
      attachmentBlobBytes += blob.sizeBytes
      if (!Number.isSafeInteger(attachmentBlobBytes)) {
        throw new Error('ExportWorkspaceManifestBlobBytesOverflow')
      }
    }
  }
  return {
    version: 1,
    counts: Object.fromEntries(
      WORKSPACE_BACKUP_TABLE_KEYS.map((key) => [key, payload[key].length]),
    ) as Record<WorkspaceBackupTableKey, number>,
    attachmentBlobCount,
    attachmentBlobBytes,
  }
}

export type ChatExportEnvelope = NatterExportEnvelopeBase<'chat', PortableChatPayload>
export type ChatPresetExportEnvelope = NatterExportEnvelopeBase<
  'chat-preset',
  PortableChatPresetPayload
>
export type ConnectionProfileExportEnvelope = NatterExportEnvelopeBase<
  'connection-profile',
  PortableConnectionProfilePayload
>
export type WorkspaceBackupEnvelope = NatterExportEnvelopeBase<
  'workspace-backup',
  WorkspaceBackupPayload
>

export type NatterExportEnvelope =
  | ChatExportEnvelope
  | ChatPresetExportEnvelope
  | ConnectionProfileExportEnvelope
  | WorkspaceBackupEnvelope

export function assertNatterExportEnvelope(value: unknown): asserts value is NatterExportEnvelope {
  if (!isRecord(value)) throw new Error('ImportEnvelopeInvalid')
  if (value.exportSchemaVersion !== NATTER_EXPORT_SCHEMA_VERSION) {
    throw new Error(`ImportSchemaUnsupported:${String(value.exportSchemaVersion)}`)
  }
  if (
    value.objectKind !== 'chat' &&
    value.objectKind !== 'chat-preset' &&
    value.objectKind !== 'connection-profile' &&
    value.objectKind !== 'workspace-backup'
  ) {
    throw new Error(`ImportObjectKindUnsupported:${String(value.objectKind)}`)
  }
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) {
    throw new Error('ImportEnvelopeMissingCreatedAt')
  }
  if (typeof value.appStorageSchemaVersion !== 'number') {
    throw new Error('ImportEnvelopeMissingStorageSchemaVersion')
  }
  if (!isRecord(value.source) || value.source.app !== 'natter') {
    throw new Error('ImportEnvelopeSourceInvalid')
  }
  if (!isRecord(value.payload)) throw new Error('ImportEnvelopePayloadInvalid')
  if (value.objectKind === 'chat') assertChatPayload(value.payload)
  if (value.objectKind === 'chat-preset') assertChatPresetPayload(value.payload)
  if (value.objectKind === 'connection-profile') {
    assertPortableConnectionProfileRows(value.payload)
  }
  if (value.objectKind === 'workspace-backup') assertWorkspaceBackupPayload(value.payload)
}

export function assertEnvelopeKind<TKind extends NatterExportObjectKind>(
  value: unknown,
  kind: TKind,
): asserts value is Extract<NatterExportEnvelope, { objectKind: TKind }> {
  assertNatterExportEnvelope(value)
  if (value.objectKind !== kind) throw new Error(`ImportObjectKindMismatch:${value.objectKind}`)
}

function assertChatPayload(value: unknown): asserts value is PortableChatPayload {
  if (!isRecord(value)) throw new Error('ImportChatPayloadInvalid')
  if (!isRecord(value.chat)) throw new Error('ImportChatMissingChat')
  if (typeof value.chat.sourceChatId !== 'string') throw new Error('ImportChatMissingSourceId')
  if (typeof value.chat.title !== 'string') throw new Error('ImportChatMissingTitle')
  if (!isRecord(value.chat.settings)) throw new Error('ImportChatMissingSettings')
  if (!Array.isArray(value.messages)) throw new Error('ImportChatMissingMessages')
  if (!Array.isArray(value.tags)) throw new Error('ImportChatMissingTags')
  if (!Array.isArray(value.attachments)) throw new Error('ImportChatMissingAttachments')
  assertPortableChatRows(value)
}

function assertChatPresetPayload(value: unknown): asserts value is PortableChatPresetPayload {
  if (!isRecord(value)) throw new Error('ImportPresetPayloadInvalid')
  if (typeof value.sourcePresetId !== 'string') throw new Error('ImportPresetMissingSourceId')
  if (typeof value.name !== 'string') throw new Error('ImportPresetMissingName')
  if (!isRecord(value.settings)) throw new Error('ImportPresetMissingSettings')
  assertPortableChatPresetRows(value)
}

function assertWorkspaceBackupPayload(value: unknown): asserts value is WorkspaceBackupPayload {
  if (!isRecord(value)) throw new Error('ImportWorkspacePayloadInvalid')
  for (const key of [
    'chats',
    'messages',
    'childLists',
    'chatBranchCache',
    'attachments',
    'profiles',
    'presets',
    'promptPresets',
    'folders',
    'tags',
    'drafts',
    'keys',
    'settings',
  ] as const) {
    if (!Array.isArray(value[key])) throw new Error(`ImportWorkspaceMissingTable:${key}`)
  }
  if (value.manifest !== undefined) assertWorkspaceBackupManifest(value.manifest)
  assertWorkspaceBackupRows(value)
}

function assertWorkspaceBackupManifest(value: unknown): asserts value is WorkspaceBackupManifest {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.counts)) {
    throw new Error('ImportWorkspaceManifestInvalid')
  }
  const countKeys = Object.keys(value.counts)
  if (
    countKeys.length !== WORKSPACE_BACKUP_TABLE_KEYS.length ||
    countKeys.some((key) => !WORKSPACE_BACKUP_TABLE_KEYS.includes(key as WorkspaceBackupTableKey))
  ) {
    throw new Error('ImportWorkspaceManifestCountsInvalid')
  }
  for (const key of WORKSPACE_BACKUP_TABLE_KEYS) {
    if (!isNonnegativeSafeInteger(value.counts[key])) {
      throw new Error(`ImportWorkspaceManifestCountInvalid:${key}`)
    }
  }
  if (!isNonnegativeSafeInteger(value.attachmentBlobCount)) {
    throw new Error('ImportWorkspaceManifestBlobCountInvalid')
  }
  if (!isNonnegativeSafeInteger(value.attachmentBlobBytes)) {
    throw new Error('ImportWorkspaceManifestBlobBytesInvalid')
  }
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
