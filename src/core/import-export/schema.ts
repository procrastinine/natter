import type {
  Attachment,
  AttachmentArtifact,
  AttachmentJob,
  Chat,
  ChatBranchCache,
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

export const NATTER_EXPORT_SCHEMA_VERSION = 1

export type NatterExportObjectKind = 'workspace-backup' | 'chat' | 'chat-preset'

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

interface WorkspaceSettingsRow {
  key: string
  value: unknown
}

export interface WorkspaceBackupPayload {
  chats: Chat[]
  messages: Message[]
  childLists: ChildListState[]
  chatBranchCache: ChatBranchCache[]
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

export type ChatExportEnvelope = NatterExportEnvelopeBase<'chat', PortableChatPayload>
export type ChatPresetExportEnvelope = NatterExportEnvelopeBase<
  'chat-preset',
  PortableChatPresetPayload
>
export type WorkspaceBackupEnvelope = NatterExportEnvelopeBase<
  'workspace-backup',
  WorkspaceBackupPayload
>

export type NatterExportEnvelope =
  | ChatExportEnvelope
  | ChatPresetExportEnvelope
  | WorkspaceBackupEnvelope

export function assertNatterExportEnvelope(value: unknown): asserts value is NatterExportEnvelope {
  if (!isRecord(value)) throw new Error('ImportEnvelopeInvalid')
  if (value.exportSchemaVersion !== NATTER_EXPORT_SCHEMA_VERSION) {
    throw new Error(`ImportSchemaUnsupported:${String(value.exportSchemaVersion)}`)
  }
  if (
    value.objectKind !== 'chat' &&
    value.objectKind !== 'chat-preset' &&
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
}

function assertChatPresetPayload(value: unknown): asserts value is PortableChatPresetPayload {
  if (!isRecord(value)) throw new Error('ImportPresetPayloadInvalid')
  if (typeof value.sourcePresetId !== 'string') throw new Error('ImportPresetMissingSourceId')
  if (typeof value.name !== 'string') throw new Error('ImportPresetMissingName')
  if (!isRecord(value.settings)) throw new Error('ImportPresetMissingSettings')
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
