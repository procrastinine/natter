import { createChat, putTestChat } from '../helpers/chats'
import { putCachedModels } from '../helpers/discovery-cache'
import { putTestMessages } from '../helpers/message-storage'
import { reasoningEnvelopeFromDetailsForTest } from '../helpers/reasoning-events'
// @vitest-environment node

import { Blob as NodeBlob } from 'node:buffer'
import type { Transaction } from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recentModelRecencyBackfillMarker } from '../../src/backcompat/global-settings'
import { migrateNatterExportEnvelope } from '../../src/backcompat/import-export'
import { LEGACY_STORAGE_COMPACTION_STATE_KEY } from '../../src/backcompat/storage-compaction-control'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { RECENT_MODEL_RECENCY_KEY, RECENT_MODELS_KEY } from '../../src/core/global-settings'
import { retainReachableIncomingAttachments } from '../../src/core/import-export/attachment-reachability'
import { assertCurrentWorkspaceBackupRows } from '../../src/core/import-export/row-validation'
import {
  type PortableAttachmentBundle,
  type PortableChatPayload,
  type WorkspaceBackupPayload,
  workspaceBackupManifest,
} from '../../src/core/import-export/schema'
import { normalizeWorkspaceCredentialReferences } from '../../src/core/import-export/workspace-credentials'
import { validateWorkspaceBackupGraph } from '../../src/core/import-export/workspace-validation'
import {
  EMPTY_TEXT_TEMPLATE,
  LEGACY_SAVED_TEXT_TEMPLATES_KEY,
  savedTextTemplatesFromStoredValue,
} from '../../src/core/text-templates'
import type {
  Chat,
  ChatFolder,
  ChatSettings,
  ChatTag,
  ConnectionProfile,
  ContentItem,
  Message,
  MessageAttachmentRef,
  ProfileId,
} from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import {
  addExistingAttachmentRef,
  deleteReferencedAttachmentBytes,
  getAttachmentBundle,
  ingestAttachmentBytes,
  putWorkspaceDraft,
} from '../../src/store/attachments'
import { attemptController } from '../../src/store/attempt-controller'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __importExportMaterializationMetricsForTests,
  __resetImportExportMaterializationMetricsForTests,
  commitPreparedBrowserWorkspaceBackup,
  prepareBrowserWorkspaceBackup,
} from '../../src/store/browser-import-export'
import { BROWSER_WRITER_LOCK_NAME } from '../../src/store/browser-lock-record'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import type { BrowserWorkspaceReplacementMutationGrant } from '../../src/store/browser-workspace-contract'
import { probeBrowserWorkspaceCurrent } from '../../src/store/browser-workspace-current-probe'
import {
  __resetBrowserWorkspaceControlDatabaseForTests,
  migrateBrowserWorkspaceCompactionState,
  readBrowserWorkspaceDatabaseManifest,
} from '../../src/store/browser-workspace-database-control'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import {
  CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY,
  CHAT_SIDEBAR_PROJECTION_LEGACY_BACKFILL_KEY,
  CHAT_SIDEBAR_PROJECTION_LEGACY_MANIFEST_KEY,
  CHAT_SIDEBAR_PROJECTION_MARKER_VERSION,
} from '../../src/store/chat-sidebar-projection'

import { configurationApplication } from '../../src/store/configuration-application'
import { CONFIGURATION_PROFILE_MANAGER_STATE_ID } from '../../src/store/configuration-profile-usage-projection'
import { __resetDbForTests, getDb, NatterDb, openDb } from '../../src/store/db'
import { configurationDiscoveryApplication } from '../../src/store/discovery-service'
import { createFolder as createChatFolder } from '../../src/store/folders'
import {
  encodeWorkspaceBackupDocument,
  exportChat,
  exportChatPreset,
  exportWorkspaceBackup,
  importChat,
  importChatPreset,
  importChats,
  restoreWorkspaceBackup,
  WorkspaceReplacementInProgressError,
} from '../../src/store/import-export'
import { __resetKeyCacheForTests, createKey } from '../../src/store/keys'
import {
  __resetLockTrackerForTests,
  createIndexedDbLockBackend,
  type LockGrant,
  withNamedLock,
} from '../../src/store/locks'
import {
  hydrateMessages,
  type MessageHeaderRow,
  splitMessageForStorage,
} from '../../src/store/message-storage'
import { getCachedModels } from '../../src/store/models-cache'
import { ALL_PHYSICAL_STORAGE_TABLE_NAMES } from '../../src/store/physical-storage-tables'
import { getCachedPrivacyPolicy } from '../../src/store/privacy-cache'
import {
  STREAM_LEASE_TTL_MS,
  type StreamLeaseRow,
  type WriterStreamLeaseRow,
} from '../../src/store/repository'
import { readStorageCompactionState } from '../../src/store/storage-compaction-state'
import {
  STORAGE_RETENTION_TASKS,
  type StorageRetentionStateRow,
  type StorageRetentionTask,
} from '../../src/store/storage-retention-state'
import { estimateStoredValueBytes } from '../../src/store/storage-size-estimate'
import { STREAM_JOURNAL_INTEGRITY_SETTING_KEY } from '../../src/store/stream-journal-integrity'
import {
  __resetStreamLeasesForTests,
  __setStreamLockManagerForTests,
} from '../../src/store/stream-leases'
import { readBrowserWorkspaceMetaFromTransaction } from '../../src/store/workspace-meta'
import { getWorkspaceRepository, readWorkspaceMeta } from '../../src/store/workspace-repository'
import { runWorkspaceAction } from '../../src/store/workspace-runtime'
import { expectAttachmentReferenceInvariants } from '../helpers/attachment-reference-invariants'
import { resetAttemptControllerForTests } from '../helpers/attempt-controller'
import {
  createConfigurationChatPreset,
  createConfigurationProfile,
  createConfigurationPromptPreset,
  listConfigurationChatPresets,
} from '../helpers/configuration'
import { deleteNatterIndexedDatabasesForTests } from '../helpers/fake-indexeddb'
import {
  testContinuationLease,
  testGenerationLease,
  testStreamLeaseAdmission,
} from '../helpers/stream-leases'

type TestLockCallback = (lock: { name: string }) => unknown

function requireTestLockCallback(
  optionsOrCallback: unknown,
  maybeCallback: unknown,
): TestLockCallback {
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
  if (typeof callback !== 'function') throw new Error('expected lock callback')
  return callback as TestLockCallback
}

async function resetAll() {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetAttemptControllerForTests()
  __resetImportExportMaterializationMetricsForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetKeyCacheForTests()
  __resetStreamLeasesForTests()
  __resetLockTrackerForTests()
  __resetDbForTests()
  __resetBrowserWorkspaceControlDatabaseForTests()
  await deleteNatterIndexedDatabasesForTests()
}

beforeEach(async () => {
  await resetAll()
  await openBrowserWorkspace()
})

afterEach(async () => {
  await shutdownBrowserWorkspace()
  await resetAll()
})

async function reopenEmptyWorkspace(): Promise<void> {
  await shutdownBrowserWorkspace()
  await resetAll()
  await openBrowserWorkspace()
}

async function estimatedLiveWorkspaceBytes(): Promise<number> {
  let total = 0
  for (const table of getDb().tables) {
    if (table.name === 'browserLocks') continue
    await table.each((row) => {
      total = Math.min(Number.MAX_SAFE_INTEGER, total + estimateStoredValueBytes(row))
    })
  }
  return total
}

function bytes(text: string): Blob {
  return new NodeBlob([new TextEncoder().encode(text)], { type: 'text/plain' }) as unknown as Blob
}

async function fakeProfile(name = 'OpenRouter'): Promise<ConnectionProfile> {
  const key = await createKey({ name, plaintextKey: 'sk-or-v1-fake', now: 1 })
  return createConfigurationProfile({
    name,
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: key.id,
    now: 2,
  })
}

async function flattenedSettings(profileId: ProfileId): Promise<ChatSettings> {
  const [system, append, continueSystem, continueUser, prefill] = await Promise.all([
    createConfigurationPromptPreset({
      kind: 'system',
      name: 'System',
      text: 'System text',
      now: 10,
    }),
    createConfigurationPromptPreset({
      kind: 'append',
      name: 'Append',
      text: 'Append text',
      now: 11,
    }),
    createConfigurationPromptPreset({
      kind: 'continue-system',
      name: 'Continue system',
      text: 'Continue system text',
      now: 12,
    }),
    createConfigurationPromptPreset({
      kind: 'continue-user',
      name: 'Continue user',
      text: 'Continue user text',
      now: 13,
    }),
    createConfigurationPromptPreset({
      kind: 'prefill',
      name: 'Prefill',
      text: 'Prefill text',
      now: 14,
    }),
  ])
  const template = await configurationApplication.createTextTemplate({
    name: 'Saved template',
    config: {
      ...EMPTY_TEXT_TEMPLATE,
      includeSystemPrompt: false,
      userPrefix: 'Saved user: ',
      assistantPrefix: 'Saved assistant: ',
    },
    now: 20,
  })
  const settings = cloneDefaultChatSettings()
  settings.profileId = profileId
  settings.model = 'anthropic/claude-opus-4.7'
  settings.systemPrompt = system.text
  settings.systemPromptPresetId = system.id
  settings.appendPrompt = append.text
  settings.appendPromptPresetId = append.id
  settings.continueSystemPrompt = continueSystem.text
  settings.continueSystemPromptPresetId = continueSystem.id
  settings.continueUserPrompt = continueUser.text
  settings.continueUserPromptPresetId = continueUser.id
  settings.defaultPrefill = prefill.text
  settings.defaultPrefillPresetId = prefill.id
  settings.textTemplate = template.id
  settings.enabledToolIds = ['local-tool']
  settings.trustedToolIds = ['local-tool']
  settings.tools.openrouter.enabledServerToolIds = ['web-search', 'shell']
  return settings
}

function attachmentRef(attachmentId: string, createdAt = 40): MessageAttachmentRef {
  return {
    refId: `source-ref-${attachmentId}`,
    attachmentId,
    includeInContext: true,
    presentation: { label: 'notes.txt' },
    createdAt,
    updatedAt: createdAt,
  }
}

function rekeyPortableAttachmentBundle(
  source: PortableAttachmentBundle,
  attachmentId: string,
  supersededByAttachmentId?: string,
): PortableAttachmentBundle {
  const blobIds = new Map(
    source.blobs.map((blob, index) => [blob.id, `${attachmentId}:blob:${index}`] as const),
  )
  const sourceArtifacts = new Map(
    [...source.attachment.artifacts, ...source.artifacts].map((artifact) => [
      artifact.artifactId,
      artifact,
    ]),
  )
  const artifactIds = new Map(
    [...sourceArtifacts.keys()].map((artifactId, index) => [
      artifactId,
      `${attachmentId}:artifact:${index}`,
    ]),
  )
  const rekeyArtifact = (
    artifact: PortableAttachmentBundle['artifacts'][number],
  ): PortableAttachmentBundle['artifacts'][number] => {
    const shared = {
      ...artifact,
      artifactId: must(artifactIds.get(artifact.artifactId), 'rekeyed artifact id'),
      attachmentId,
    }
    return artifact.kind === 'blob'
      ? {
          ...shared,
          kind: 'blob',
          blobId: must(blobIds.get(artifact.blobId), 'rekeyed artifact blob'),
        }
      : shared
  }
  const rekeyProcessing = <T extends { outputArtifactIds: string[] }>(state: T): T => ({
    ...state,
    outputArtifactIds: state.outputArtifactIds.map((artifactId) =>
      must(artifactIds.get(artifactId), 'rekeyed processing artifact'),
    ),
  })
  const storage = source.attachment.storage
  const nextStorage =
    storage.kind === 'local-blob'
      ? { ...storage, blobId: must(blobIds.get(storage.blobId), 'rekeyed storage blob') }
      : storage.kind === 'missing' && storage.lastKnownBlobId
        ? {
            ...storage,
            lastKnownBlobId: must(blobIds.get(storage.lastKnownBlobId), 'rekeyed last-known blob'),
          }
        : storage
  const {
    thumbnailBlobId: _thumbnailBlobId,
    supersededByAttachmentId: _supersededByAttachmentId,
    ...sourceAttachment
  } = source.attachment
  const attachment: PortableAttachmentBundle['attachment'] = {
    ...sourceAttachment,
    id: attachmentId,
    storage: nextStorage,
    ...(source.attachment.thumbnailBlobId
      ? {
          thumbnailBlobId: must(
            blobIds.get(source.attachment.thumbnailBlobId),
            'rekeyed thumbnail blob',
          ),
        }
      : {}),
    artifacts: source.attachment.artifacts.map(rekeyArtifact),
    processing: source.attachment.processing.map(rekeyProcessing),
    refCount: 0,
    ...(supersededByAttachmentId !== undefined ? { supersededByAttachmentId } : {}),
  }
  return {
    attachment,
    blobs: source.blobs.map((blob) => ({
      ...blob,
      id: must(blobIds.get(blob.id), 'rekeyed portable blob'),
      attachmentId,
    })),
    artifacts: source.artifacts.map(rekeyArtifact),
    jobs: source.jobs.map((job, index) => ({
      ...rekeyProcessing(job),
      id: `${attachmentId}:job:${index}`,
      attachmentId,
    })),
  }
}

function message(input: Partial<Message> & Pick<Message, 'chatId' | 'role'>): Message {
  const base: Message = {
    id: input.id ?? newId(),
    chatId: input.chatId,
    parentId: input.parentId ?? null,
    siblingIndex: input.siblingIndex ?? 0,
    turnId: input.turnId ?? newId(),
    turnIndex: input.turnIndex ?? 0,
    createdAt: input.createdAt ?? 50,
    role: input.role,
    origin: input.origin ?? (input.role === 'assistant' ? 'generated' : 'user'),
    content: input.content ?? [{ type: 'text', text: '' }],
    nodeVersion: input.nodeVersion ?? 0,
    deleted: input.deleted ?? false,
  }
  return { ...base, ...input }
}

async function seedPortableChat(): Promise<{
  chat: Chat
  profile: ConnectionProfile
  sourceAttachmentId: string
  folder: ChatFolder
  tag: ChatTag
  userMessage: Message
  assistantMessage: Message
}> {
  const db = await openDb()
  const profile = await fakeProfile()
  const settings = await flattenedSettings(profile.id)
  const folder: ChatFolder = {
    id: newId(),
    name: 'Research',
    color: '#335577',
    sortIndex: 1,
    createdAt: 30,
    updatedAt: 30,
  }
  const tag: ChatTag = {
    id: newId(),
    name: 'Important',
    nameLower: 'important',
    color: '#775533',
    createdAt: 31,
    updatedAt: 31,
  }
  await createChatFolder({
    id: folder.id,
    name: folder.name,
    ...(folder.color ? { color: folder.color } : {}),
    sortIndex: folder.sortIndex,
    now: folder.createdAt,
  })
  await db.tags.put(tag)

  const bundle = await ingestAttachmentBytes({
    blob: bytes('shared attachment bytes'),
    filename: 'notes.txt',
    now: 32,
  })
  const ref = attachmentRef(bundle.attachment.id)
  const chatId = newId()
  const userMessage = message({
    id: newId(),
    chatId,
    role: 'user',
    createdAt: 50,
    content: [
      { type: 'text', text: 'Please inspect the attachment.' },
      {
        type: 'file',
        attachmentId: bundle.attachment.id,
        filename: 'notes.txt',
        mime: 'text/plain',
      },
    ],
    attachmentRefs: [ref],
  })
  const assistantMessage = message({
    id: newId(),
    chatId,
    role: 'assistant',
    parentId: userMessage.id,
    turnIndex: 1,
    createdAt: 60,
    content: [{ type: 'output_text', text: 'Attachment inspected.' }],
    generation: {
      id: 'gen-source',
      model: settings.model,
      requestedModel: settings.model,
      apiUsed: 'chat',
      delivery: 'buffered',
      costSource: 'estimated',
      reasoningCarryForward: 'none',
      reasoningVisibility: { disclosure: 'unknown' },
      startedAt: 55,
      finishedAt: 60,
      cost: 0.01,
    },
  })
  const chat: Chat = {
    id: chatId,
    title: 'Portable chat',
    titleStatus: 'manual',
    createdAt: 45,
    updatedAt: 70,
    lastViewedAt: 70,
    wordCount: 6,
    totalCostUsd: 0.01,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 1,
    configurationVersion: 0,
    settings,
    presetId: 'source-preset',
    lastUpdatedLeafId: assistantMessage.id,
    lastBranchUpdatedAt: 70,
    archived: false,
    pinned: true,
    color: '#123456',
    folderId: folder.id,
    tags: [tag.id],
    favoriteModels: ['openai/gpt-5.4'],
    recentModels: ['anthropic/claude-opus-4.7'],
    previewText: 'Please inspect the attachment.',
  }
  await createConfigurationChatPreset({
    id: 'source-preset',
    name: 'Source preset',
    connectionProfileId: profile.id,
    settings,
    now: 44,
  })
  await putTestChat(chat)
  await putTestMessages([userMessage, assistantMessage])
  return {
    chat,
    profile,
    sourceAttachmentId: bundle.attachment.id,
    folder,
    tag,
    userMessage,
    assistantMessage,
  }
}

async function prepareBlockingAttempt(
  seeded: Awaited<ReturnType<typeof seedPortableChat>>,
  kind: 'normal send' | 'Continue',
  streamId: string,
  startedAt = Date.now(),
): Promise<void> {
  await runWorkspaceAction('conversation-generation', async (permit) => {
    const assistantMessageId =
      kind === 'Continue' ? seeded.assistantMessage.id : 'reserved-send-target'
    const lease = testStreamLeaseAdmission({
      streamId,
      chatId: seeded.chat.id,
      messageId: assistantMessageId,
      ownerClientId: 'test-tab',
      fenceToken: `fence-${streamId}`,
      replacementEpoch: permit.replacementEpoch,
      startedAt,
      heartbeatAt: startedAt,
      attemptKind: kind === 'Continue' ? ('continuation' as const) : ('generation' as const),
    })
    const promptHeaders = await generationPromptPathClaims(seeded.assistantMessage.id)
    const configurationIntent = {
      preferredDispatchKeyId: null,
    }
    const sendTurnId = newId()
    const reservedUser = message({
      id: 'reserved-send-user',
      chatId: seeded.chat.id,
      role: 'user',
      parentId: seeded.assistantMessage.id,
      turnId: sendTurnId,
      turnIndex: 0,
      createdAt: startedAt,
      content: [{ type: 'text', text: 'Admitted send' }],
    })
    const reservedAssistant = message({
      id: assistantMessageId,
      chatId: seeded.chat.id,
      role: 'assistant',
      parentId: reservedUser.id,
      turnId: sendTurnId,
      turnIndex: 1,
      createdAt: startedAt,
      content: [],
      generation: {
        model: seeded.chat.settings.model,
        requestedModel: seeded.chat.settings.model,
        status: 'preparing',
        integrity: 'clean',
        costSource: 'stream',
        reasoningCarryForward: 'none',
        reasoningVisibility: { disclosure: 'unknown' },
        startedAt,
      },
    })
    const input =
      kind === 'Continue'
        ? ({
            strategy: 'continue',
            lease,
            configurationIntent,
            promptPath: {
              requirement: {
                kind: 'continue',
                surface: 'chat',
                chatId: seeded.chat.id,
                target: {
                  kind: 'include',
                  messageId: seeded.assistantMessage.id,
                  role: 'assistant',
                },
                childSlot: 'none',
              },
              pathHint: {
                chatId: seeded.chat.id,
                structuralVersion: seeded.chat.structuralVersion,
                leafId: seeded.assistantMessage.id,
                headers: promptHeaders,
                placementSlot: null,
                targetTurn: null,
              },
            },
          } as const)
        : ({
            strategy: 'send',
            lease,
            configurationIntent,
            promptPath: {
              requirement: {
                kind: 'send',
                surface: 'chat',
                chatId: seeded.chat.id,
                target: {
                  kind: 'selection',
                  selection: { kind: 'tip', messageId: seeded.assistantMessage.id },
                },
                childSlot: 'append',
              },
              pathHint: {
                chatId: seeded.chat.id,
                structuralVersion: seeded.chat.structuralVersion,
                leafId: seeded.assistantMessage.id,
                headers: promptHeaders,
                placementSlot: {
                  parentId: seeded.assistantMessage.id,
                  slotVersion: 0,
                  liveCount: 0,
                  nextSiblingIndex: 0,
                },
                targetTurn: {
                  turnId: seeded.assistantMessage.turnId,
                  turnIndex: seeded.assistantMessage.turnIndex,
                },
              },
            },
            placement: {
              chatId: seeded.chat.id,
              createdAt: startedAt,
              assistantMessageId: reservedAssistant.id,
              user: {
                messageId: reservedUser.id,
                content: reservedUser.content,
                attachmentRefs: reservedUser.attachmentRefs ?? [],
              },
              prefillContent: reservedAssistant.content,
            },
          } as const)
    await getWorkspaceRepository().execute(permit, { kind: 'attempt.prepare', input })
  })
}

async function generationPromptPathClaims(messageId: string) {
  const reversed: Array<{
    messageId: string
    parentId: string | null
    requestContextVersion: number
  }> = []
  const seen = new Set<string>()
  let cursor: string | null = messageId
  while (cursor !== null) {
    if (seen.has(cursor)) throw new Error(`TestPromptPathCycle:${cursor}`)
    seen.add(cursor)
    const header: MessageHeaderRow | undefined = await getDb().messages.get(cursor)
    if (!header) throw new Error(`TestPromptPathHeaderMissing:${cursor}`)
    reversed.push({
      messageId: header.id,
      parentId: header.parentId,
      requestContextVersion: header.requestContextVersion,
    })
    cursor = header.parentId
  }
  return reversed.reverse()
}

async function persistRemoteContinuationLease(
  db: NatterDb,
  input: {
    streamId: string
    chatId: string
    messageId: string
    ownerClientId: string
    now: number
  },
  grant?: LockGrant,
): Promise<StreamLeaseRow> {
  const persist = async (tx: Transaction): Promise<StreamLeaseRow> => {
    const meta = await readBrowserWorkspaceMetaFromTransaction(tx)
    const settings = tx.table<{ key: string; value: unknown }, string>('settings')
    const current = await settings.get('stream-admission-sequence')
    const currentSequence =
      typeof current?.value === 'number' && Number.isSafeInteger(current.value) ? current.value : 0
    const admissionSequence = currentSequence + 1
    const lease: StreamLeaseRow = testContinuationLease({
      streamId: input.streamId,
      chatId: input.chatId,
      messageId: input.messageId,
      ownerClientId: input.ownerClientId,
      fenceToken: `fence-${input.streamId}`,
      replacementEpoch: meta.replacementEpoch,
      admissionSequence,
      revision: 0,
      startedAt: input.now,
      heartbeatAt: input.now,
      targetCommittedAt: input.now,
      continuationStrategy: 'prompt',
      baseNodeVersion: 0,
      baseBodyVersion: 0,
      postCommit: { usedAt: input.now, profileId: 'test-profile' },
    })
    await settings.put({ key: 'stream-admission-sequence', value: admissionSequence })
    await tx.table<StreamLeaseRow, string>('streamLeases').put(lease)
    return lease
  }
  return grant
    ? grant.runTransaction(db, [db.settings, db.streamLeases, db.workspaceFence], persist)
    : db.transaction('rw', db.settings, db.streamLeases, db.workspaceFence, persist)
}

async function messagesForChat(chatId: string): Promise<Message[]> {
  const db = await openDb()
  const headers = await db.messages.where('chatId').equals(chatId).toArray()
  const bodies = (await db.messageBodies.bulkGet(headers.map((row) => row.id))).filter(
    (row): row is NonNullable<typeof row> => row !== undefined,
  )
  return hydrateMessages(headers, bodies)
}

function fileItem(items: readonly ContentItem[]): Extract<ContentItem, { type: 'file' }> {
  const item = items.find(
    (row): row is Extract<ContentItem, { type: 'file' }> => row.type === 'file',
  )
  if (!item) throw new Error('file item missing')
  return item
}

async function blobText(blob: Blob): Promise<string> {
  const withText = blob as Blob & { text?: () => Promise<string> }
  if (typeof withText.text === 'function') return withText.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('BlobReadFailed'))
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.readAsText(blob)
  })
}

async function authoritativeSnapshot(): Promise<Record<string, unknown[]>> {
  const db = getDb()
  const result: Record<string, unknown[]> = {}
  const tables = [...db.tables].sort((left, right) => left.name.localeCompare(right.name))
  for (const table of tables) {
    if (table.name === 'browserLocks' || table.name === 'storageRetentionState') continue
    const rows = await Promise.all((await table.toArray()).map(canonicalizeStoredValue))
    result[table.name] = [...rows].sort((left: unknown, right: unknown) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    )
  }
  return result
}

function withoutRebuildableSidebarProjection(
  snapshot: Record<string, unknown[]>,
): Record<string, unknown[]> {
  const {
    chatSidebarRows: _chatSidebarRows,
    chatSidebarAggregates: _chatSidebarAggregates,
    ...authoritative
  } = snapshot
  return authoritative
}

interface FailedReplacementSnapshot {
  readonly stableWorkspace: Record<string, unknown[]>
  readonly retentionByTask: ReadonlyMap<StorageRetentionTask, StorageRetentionStateRow>
}

async function failedReplacementSnapshot(
  options: { readonly withoutRebuildableSidebar?: boolean } = {},
): Promise<FailedReplacementSnapshot> {
  const snapshot = await authoritativeSnapshot()
  const projected = options.withoutRebuildableSidebar
    ? withoutRebuildableSidebarProjection(snapshot)
    : snapshot
  const retentionRows = await getDb().storageRetentionState.toArray()
  const retentionByTask = new Map<StorageRetentionTask, StorageRetentionStateRow>()
  for (const row of retentionRows) {
    if (!STORAGE_RETENTION_TASKS.includes(row.task) || retentionByTask.has(row.task)) {
      throw new Error(`StorageRetentionStateSnapshotInvalid:${row.task}`)
    }
    retentionByTask.set(row.task, row)
  }
  expect([...retentionByTask.keys()].sort()).toEqual([...STORAGE_RETENTION_TASKS].sort())
  return Object.freeze({ stableWorkspace: projected, retentionByTask })
}

function expectFailedReplacementPreserved(
  before: FailedReplacementSnapshot,
  after: FailedReplacementSnapshot,
): void {
  expect(after.stableWorkspace).toEqual(before.stableWorkspace)
  for (const task of STORAGE_RETENTION_TASKS) {
    const beforeRow = before.retentionByTask.get(task)
    const afterRow = after.retentionByTask.get(task)
    if (!beforeRow || !afterRow) throw new Error(`StorageRetentionStateSnapshotMissing:${task}`)
    const { revision: beforeRevision, ...beforeState } = beforeRow
    const { revision: afterRevision, ...afterState } = afterRow
    expect(afterState).toEqual(beforeState)
    expect(Number.isSafeInteger(beforeRevision) && beforeRevision >= 0).toBe(true)
    expect(Number.isSafeInteger(afterRevision) && afterRevision >= beforeRevision).toBe(true)
  }
}

interface ReplacementTransactionRecord {
  readonly tables: readonly string[]
  readonly epochBefore: number
  readonly epochAfter: number
}

function slottedReplacementGrant(
  db: NatterDb,
  records: ReplacementTransactionRecord[],
): BrowserWorkspaceReplacementMutationGrant {
  const readEpoch = () =>
    db.transaction('r', db.workspaceFence, async (tx) => {
      return (await readBrowserWorkspaceMetaFromTransaction(tx)).replacementEpoch
    })
  return {
    kind: 'web-locks',
    logicalNames: ['test:slotted-replacement'],
    atomicity: 'slotted-staging',
    runTransaction: async (transactionDb, tables, operation) => {
      const epochBefore = await readEpoch()
      const resolvedTables = tables.map((table) =>
        transactionDb.table(typeof table === 'string' ? table : table.name),
      )
      const result = await transactionDb.transaction('rw', resolvedTables, operation)
      const epochAfter = await readEpoch()
      records.push({
        tables: tables.map((table) => (typeof table === 'string' ? table : table.name)).sort(),
        epochBefore,
        epochAfter,
      })
      return result
    },
  }
}

async function canonicalizeStoredValue(value: unknown): Promise<unknown> {
  if (value instanceof Blob) {
    return {
      blobBytes: [...new Uint8Array(await value.arrayBuffer())],
      size: value.size,
      type: value.type,
    }
  }
  if (Array.isArray(value)) return Promise.all(value.map(canonicalizeStoredValue))
  if (value && typeof value === 'object') {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, entry]) => [
        key,
        await canonicalizeStoredValue(entry),
      ]),
    )
    return Object.fromEntries(entries)
  }
  return value
}

function stableBackupPayload(payload: WorkspaceBackupPayload): WorkspaceBackupPayload {
  const cloned = structuredClone(payload)
  cloned.settings = cloned.settings.filter((row) => row.key !== 'workspace-meta')
  return cloned
}

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label}`)
  return value
}

function trackDigestConcurrency(): {
  calls: () => number
  maxActive: () => number
  maxActiveBytes: () => number
} {
  const subtle = globalThis.crypto.subtle
  const originalDigest = subtle.digest.bind(subtle)
  let calls = 0
  let active = 0
  let activeBytes = 0
  let maxActive = 0
  let maxActiveBytes = 0
  vi.spyOn(subtle, 'digest').mockImplementation(async (...args) => {
    const input = args[1]
    calls += 1
    active += 1
    activeBytes += input.byteLength
    maxActive = Math.max(maxActive, active)
    maxActiveBytes = Math.max(maxActiveBytes, activeBytes)
    await Promise.resolve()
    try {
      return await originalDigest(...args)
    } finally {
      active -= 1
      activeBytes -= input.byteLength
    }
  })
  return {
    calls: () => calls,
    maxActive: () => maxActive,
    maxActiveBytes: () => maxActiveBytes,
  }
}

function trackBlobReadConcurrency(): {
  calls: () => number
  maxActive: () => number
  maxActiveBytes: () => number
} {
  const originalArrayBuffer = NodeBlob.prototype.arrayBuffer
  let calls = 0
  let active = 0
  let activeBytes = 0
  let maxActive = 0
  let maxActiveBytes = 0
  vi.spyOn(NodeBlob.prototype, 'arrayBuffer').mockImplementation(async function (this: NodeBlob) {
    calls += 1
    active += 1
    activeBytes += this.size
    maxActive = Math.max(maxActive, active)
    maxActiveBytes = Math.max(maxActiveBytes, activeBytes)
    await Promise.resolve()
    try {
      return await originalArrayBuffer.call(this)
    } finally {
      active -= 1
      activeBytes -= this.size
    }
  })
  return {
    calls: () => calls,
    maxActive: () => maxActive,
    maxActiveBytes: () => maxActiveBytes,
  }
}

describe('chat preset export/import', () => {
  it('exports presets with flattened prompt pins and saved text templates', async () => {
    const profile = await fakeProfile()
    const settings = await flattenedSettings(profile.id)
    const preset = await createConfigurationChatPreset({
      name: 'Pinned preset',
      connectionProfileId: profile.id,
      settings,
      now: 100,
    })

    const exported = await exportChatPreset(preset.id)
    const portable = exported.payload.settings

    expect(portable.systemPrompt).toBe('System text')
    expect(portable.appendPrompt).toBe('Append text')
    expect(portable.continueSystemPrompt).toBe('Continue system text')
    expect(portable.continueUserPrompt).toBe('Continue user text')
    expect(portable.defaultPrefill).toBe('Prefill text')
    expect(portable).not.toHaveProperty('systemPromptPresetId')
    expect(portable).not.toHaveProperty('appendPromptPresetId')
    expect(portable).not.toHaveProperty('continueSystemPromptPresetId')
    expect(portable).not.toHaveProperty('continueUserPromptPresetId')
    expect(portable).not.toHaveProperty('defaultPrefillPresetId')
    expect(portable.textTemplate).toBe('custom')
    expect(portable.customTextTemplate?.userPrefix).toBe('Saved user: ')
    expect(portable.enabledToolIds).toEqual([])
    expect(portable.trustedToolIds).toEqual([])
    expect(portable.tools.openrouter.enabledServerToolIds).toEqual(['web-search', 'shell'])
  })

  it('imports a flattened preset even when the source connection is missing', async () => {
    const sourceProfile = await fakeProfile()
    const preset = await createConfigurationChatPreset({
      name: 'Portable preset',
      connectionProfileId: sourceProfile.id,
      settings: await flattenedSettings(sourceProfile.id),
      now: 100,
    })
    const exported = await exportChatPreset(preset.id)

    await reopenEmptyWorkspace()

    const result = await importChatPreset(exported, { targetProfileId: null, now: 200 })
    const row = await getDb().presets.get(result.presetId)

    expect(result.profileMatched).toBe(false)
    expect(result.profileId).toBe(sourceProfile.id)
    expect(await getDb().profiles.count()).toBe(0)
    expect(row?.connectionProfileId).toBe(sourceProfile.id)
    expect(row?.settings.profileId).toBe(sourceProfile.id)
    expect(row?.settings.systemPrompt).toBe('System text')
    expect(row?.settings).not.toHaveProperty('systemPromptPresetId')
  })

  it('does not export picker order and imports uploaded presets at the end', async () => {
    const profile = await fakeProfile()
    const settings = await flattenedSettings(profile.id)
    const first = await createConfigurationChatPreset({
      name: 'First',
      connectionProfileId: profile.id,
      settings,
      now: 100,
    })
    const second = await createConfigurationChatPreset({
      name: 'Second',
      connectionProfileId: profile.id,
      settings,
      now: 200,
    })
    const exported = await exportChatPreset(first.id)

    expect(exported.payload).not.toHaveProperty('sortIndex')

    const result = await importChatPreset(exported, { targetProfileId: profile.id, now: 300 })
    const rows = await listConfigurationChatPresets()
    expect(rows.map((row) => row.id)).toEqual([first.id, second.id, result.presetId])
  })
})

describe('chat export/import', () => {
  it('hydrates and restores split message bodies in bounded pages', async () => {
    const seeded = await seedPortableChat()
    const extraMessages = Array.from({ length: 300 }, (_, index) =>
      message({
        id: `paged-message-${String(index).padStart(3, '0')}`,
        chatId: seeded.chat.id,
        role: 'assistant',
        parentId: seeded.userMessage.id,
        siblingIndex: index + 1,
        turnIndex: index + 2,
        createdAt: 100 + index,
        content: [{ type: 'output_text', text: `paged body ${index}` }],
      }),
    )
    const split = extraMessages.map((row) => splitMessageForStorage(row))
    await getDb().messages.bulkPut(split.map((row) => row.header))
    await getDb().messageBodies.bulkPut(split.map((row) => row.body))
    const messageToArray = vi.spyOn(getDb().messages, 'toArray')
    const bodyBulkGet = vi.spyOn(getDb().messageBodies, 'bulkGet')

    const exported = await exportChat(seeded.chat.id)

    expect(exported.payload.messages).toHaveLength(extraMessages.length + 2)
    expect(messageToArray).not.toHaveBeenCalled()
    expect(bodyBulkGet.mock.calls.length).toBeGreaterThan(1)
    expect(Math.max(...bodyBulkGet.mock.calls.map(([ids]) => ids.length))).toBeLessThanOrEqual(128)

    const messageBulkPut = vi.spyOn(getDb().messages, 'bulkPut')
    const bodyBulkPut = vi.spyOn(getDb().messageBodies, 'bulkPut')
    const workspace = await exportWorkspaceBackup()
    await restoreWorkspaceBackup(workspace, { now: 1000 })

    expect(Math.max(...messageBulkPut.mock.calls.map(([rows]) => rows.length))).toBeLessThanOrEqual(
      128,
    )
    expect(Math.max(...bodyBulkPut.mock.calls.map(([rows]) => rows.length))).toBeLessThanOrEqual(
      128,
    )
  })

  it('imports chats additively with flattened settings, rewritten messages, and attachment reuse', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)

    expect(exported.payload.chat.settings).not.toHaveProperty('systemPromptPresetId')
    expect(exported.payload.chat.settings.textTemplate).toBe('custom')
    expect(exported.payload.attachments).toHaveLength(1)

    const result = await importChat(exported, { now: 1000 })
    const db = getDb()
    const importedChat = await db.chats.get(result.chatId)
    const importedMessages = await messagesForChat(result.chatId)
    const importedUser = importedMessages.find((row) => row.role === 'user')
    const importedAssistant = importedMessages.find((row) => row.role === 'assistant')

    expect(importedChat?.presetId).toBeUndefined()
    expect(importedChat?.title).toBe('Portable chat')
    expect(importedChat?.pinned).toBe(false)
    expect(importedChat?.folderId).toBe(seeded.folder.id)
    expect(importedChat?.tags).toEqual([seeded.tag.id])
    expect(importedChat?.settings.systemPrompt).toBe('System text')
    expect(importedChat?.settings).not.toHaveProperty('systemPromptPresetId')
    expect(importedChat?.settings.profileId).toBe(seeded.profile.id)
    expect(importedChat?.previewText).toBe('Please inspect the attachment.')
    expect(await db.chatSidebarRows.get(result.chatId)).toEqual(
      expect.objectContaining({
        id: result.chatId,
        title: 'Portable chat',
        previewText: 'Please inspect the attachment.',
      }),
    )
    expect(result.destination).toMatchObject({
      kind: 'ready',
      proof: {
        chatId: result.chatId,
        tipId: importedAssistant?.id,
      },
      target: {
        kind: 'fixed-tip',
        messageId: importedAssistant?.id,
        selection: { kind: 'tip', messageId: importedAssistant?.id },
      },
    })
    expect(result.destination.proof.pathHeaders.map((row) => row.id)).toEqual(
      importedMessages
        .filter((row) => !row.deleted)
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((row) => row.id),
    )
    expect(result.destination.presentations.map((row) => row.message.id)).toEqual([
      result.destination.proof.tipId,
    ])
    expect(await db.attachments.count()).toBe(1)
    expect((await db.attachments.get(seeded.sourceAttachmentId))?.refCount).toBe(2)

    expect(importedUser?.id).not.toBe(seeded.userMessage.id)
    expect(importedAssistant?.parentId).toBe(importedUser?.id)
    expect(importedUser?.attachmentRefs?.[0]?.attachmentId).toBe(seeded.sourceAttachmentId)
    expect(importedUser?.attachmentRefs?.[0]?.refId).not.toBe(
      seeded.userMessage.attachmentRefs?.[0]?.refId,
    )
    expect(fileItem(importedUser?.content ?? []).attachmentId).toBe(seeded.sourceAttachmentId)
    await expectAttachmentReferenceInvariants(db)
  })

  it('commits a multi-chat import once or rolls every entry back on parse or storage failure', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)
    const beforeChats = await getDb().chats.count()
    const duplicateDestination = 'atomic-chat-import'

    await expect(importChats([exported, { objectKind: 'chat' }])).rejects.toThrow()

    expect(await getDb().chats.count()).toBe(beforeChats)

    await expect(
      importChats(
        [exported, exported],
        [
          { destinationChatId: duplicateDestination, now: 1000 },
          { destinationChatId: duplicateDestination, now: 1001 },
        ],
      ),
    ).rejects.toThrow()

    expect(await getDb().chats.count()).toBe(beforeChats)
    expect(await getDb().chats.get(duplicateDestination)).toBeUndefined()
    expect(await messagesForChat(duplicateDestination)).toEqual([])

    const managerBefore = await getDb().configurationCatalogAggregates.get(
      CONFIGURATION_PROFILE_MANAGER_STATE_ID,
    )
    if (!managerBefore || !('revision' in managerBefore)) {
      throw new Error('ConfigurationProfileManagerStateMissing')
    }
    const imported = await importChats([exported, exported], [{ now: 1100 }, { now: 1101 }])
    const managerAfter = await getDb().configurationCatalogAggregates.get(
      CONFIGURATION_PROFILE_MANAGER_STATE_ID,
    )
    if (!managerAfter || !('revision' in managerAfter)) {
      throw new Error('ConfigurationProfileManagerStateMissing')
    }

    expect(imported).toHaveLength(2)
    expect(new Set(imported.map((result) => result.chatId)).size).toBe(2)
    expect(await getDb().chats.count()).toBe(beforeChats + 2)
    expect(managerAfter.revision).toBe(managerBefore.revision + 1)
  })

  it('normalizes getter-only imported message rows without provenance eligibility', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)
    const assistant = must(
      exported.payload.messages.find((row) => row.role === 'assistant'),
      'exported assistant',
    )
    assistant.generation = {
      status: 'done',
      model: 'openai/test',
      startedAt: 1,
      finishedAt: 2,
      apiUsed: 'responses',
      reasoningCarryForward: 'unknown',
      reasoningVisibility: { disclosure: 'unknown' },
    }
    const legacyContent = [
      {
        type: 'output_text',
        text: 'Getter-only citation',
        annotations: [
          {
            type: 'url_citation',
            start_index: 0,
            end_index: 6,
            url: 'https://example.com/getter',
          },
        ],
      } as unknown as ContentItem,
    ]
    Object.defineProperty(assistant, 'content', {
      configurable: true,
      enumerable: true,
      get: () => legacyContent,
    })

    const imported = await importChat(exported, { now: 1200 })
    const importedAssistant = must(
      (await messagesForChat(imported.chatId)).find((row) => row.role === 'assistant'),
      'imported assistant',
    )
    const content = importedAssistant.content[0]
    if (content?.type !== 'output_text') throw new Error('ImportedOutputTextMissing')
    expect(content.annotations?.[0]).toMatchObject({
      type: 'url_citation',
      source: 'openai-responses',
      startIndex: 0,
      endIndex: 6,
      url: 'https://example.com/getter',
    })
  })

  it('deduplicates shared catalogs and attachments across concurrent chat imports', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)
    await reopenEmptyWorkspace()

    const imports = await Promise.all([
      importChat(exported, { targetProfileId: null, now: 1_001 }),
      importChat(exported, { targetProfileId: null, now: 1_002 }),
    ])
    const db = getDb()
    const attachments = await db.attachments.toArray()

    expect(new Set(imports.map(({ chatId }) => chatId)).size).toBe(2)
    expect(await db.chats.count()).toBe(2)
    expect(await db.folders.count()).toBe(1)
    expect(await db.tags.count()).toBe(1)
    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.refCount).toBe(2)
    await expectAttachmentReferenceInvariants(db)
  })

  it('prunes an unreferenced chat attachment before blob validation or storage', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)
    const source = must(exported.payload.attachments[0], 'referenced portable attachment')
    const orphan = rekeyPortableAttachmentBundle(source, 'orphan-chat-attachment')
    for (const blob of orphan.blobs) {
      blob.dataBase64 = 'not-valid-base64'
      blob.contentHash = 'sha256:must-not-be-digested'
    }
    exported.payload.attachments.push(orphan)
    const referencedBlobCount = source.blobs.length

    await reopenEmptyWorkspace()
    const digest = trackDigestConcurrency()
    const result = await importChat(exported, { targetProfileId: null, now: 1_100 })
    const importedUser = (await messagesForChat(result.chatId)).find((row) => row.role === 'user')
    const importedAttachmentId = importedUser?.attachmentRefs?.[0]?.attachmentId

    expect(digest.calls()).toBe(referencedBlobCount)
    expect(importedAttachmentId).toBeTruthy()
    expect(importedAttachmentId).not.toBe(orphan.attachment.id)
    expect(await getDb().attachments.count()).toBe(1)
    expect(await getDb().attachments.get(orphan.attachment.id)).toBeUndefined()
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('creates a new attachment when only the hash matches but the filename differs', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)

    await reopenEmptyWorkspace()
    const existing = await ingestAttachmentBytes({
      blob: bytes('shared attachment bytes'),
      filename: 'renamed.txt',
      now: 500,
    })

    const result = await importChat(exported, { now: 600 })
    const importedMessages = await messagesForChat(result.chatId)
    const importedUser = importedMessages.find((row) => row.role === 'user')
    const importedAttachmentId = importedUser?.attachmentRefs?.[0]?.attachmentId

    expect(importedAttachmentId).toBeTruthy()
    expect(importedAttachmentId).not.toBe(existing.attachment.id)
    expect((await getDb().attachments.get(importedAttachmentId ?? ''))?.filename).toBe('notes.txt')
    expect(await getDb().attachments.count()).toBe(2)
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('validates a multi-blob attachment sequentially and preserves every imported blob', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)
    const portable = must(exported.payload.attachments[0], 'portable attachment')
    const original = must(portable.blobs[0], 'portable original blob')
    for (let index = 0; index < 8; index += 1) {
      portable.blobs.push({
        ...original,
        id: `portable-normalized-${index}`,
        role: 'normalized',
      })
    }
    const expectedBlobCount = portable.blobs.length
    const largestBlobSize = Math.max(...portable.blobs.map((blob) => blob.sizeBytes))

    await reopenEmptyWorkspace()
    const digest = trackDigestConcurrency()
    const result = await importChat(exported, { targetProfileId: null, now: 600 })
    const importedUser = (await messagesForChat(result.chatId)).find((row) => row.role === 'user')
    const importedAttachmentId = importedUser?.attachmentRefs?.[0]?.attachmentId

    expect(digest.calls()).toBe(expectedBlobCount)
    expect(digest.maxActive()).toBe(1)
    expect(digest.maxActiveBytes()).toBe(largestBlobSize)
    expect(await getDb().attachments.count()).toBe(1)
    const imported = await getAttachmentBundle(must(importedAttachmentId, 'attachment'))
    expect(imported?.blobs).toHaveLength(expectedBlobCount)
    expect(
      await Promise.all(
        (imported?.blobs ?? []).map(async (blob) => ({
          role: blob.role,
          mime: blob.mime,
          contentHash: blob.contentHash,
          sizeBytes: blob.sizeBytes,
          text: await blobText(blob.blob),
        })),
      ),
    ).toEqual([
      {
        role: 'original',
        mime: original.mime,
        contentHash: original.contentHash,
        sizeBytes: original.sizeBytes,
        text: 'shared attachment bytes',
      },
      ...Array.from({ length: 8 }, () => ({
        role: 'normalized' as const,
        mime: original.mime,
        contentHash: original.contentHash,
        sizeBytes: original.sizeBytes,
        text: 'shared attachment bytes',
      })),
    ])
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('round-trips a referenced attachment after its bytes were intentionally deleted', async () => {
    const seeded = await seedPortableChat()
    const beforeDelete = await getAttachmentBundle(seeded.sourceAttachmentId)
    const originalBlobId = beforeDelete?.blobs.find((blob) => blob.role === 'original')?.id
    await deleteReferencedAttachmentBytes(seeded.sourceAttachmentId, 'deleted', 500)

    const exported = await exportChat(seeded.chat.id)
    const portable = exported.payload.attachments[0]
    expect(portable?.attachment.storage).toEqual({
      kind: 'missing',
      reason: 'deleted',
      missingSince: 500,
      lastKnownBlobId: originalBlobId,
    })
    expect(portable?.blobs).toEqual([])
    expect(portable?.attachment.thumbnailBlobId).toBeUndefined()
    expect(portable?.artifacts.some((artifact) => artifact.kind === 'text')).toBe(true)
    expect(portable?.artifacts.every((artifact) => artifact.kind !== 'blob')).toBe(true)

    const result = await importChat(exported, { now: 600 })
    const importedUser = (await messagesForChat(result.chatId)).find((row) => row.role === 'user')
    const restoredId = importedUser?.attachmentRefs?.[0]?.attachmentId
    if (!restoredId) throw new Error('expected restored missing attachment')
    const restored = await getAttachmentBundle(restoredId)
    expect(restored?.attachment.storage).toMatchObject({
      kind: 'missing',
      reason: 'deleted',
      lastKnownBlobId: originalBlobId,
    })
    expect(restored?.blobs).toEqual([])
    expect(restored?.artifacts.some((artifact) => artifact.kind === 'text')).toBe(true)
    const artifactIds = new Set(restored?.artifacts.map((artifact) => artifact.artifactId))
    expect(
      restored?.jobs.every((job) => job.outputArtifactIds.every((id) => artifactIds.has(id))),
    ).toBe(true)

    expect(importedUser.attachmentRefs?.[0]?.attachmentId).toBe(restoredId)
    expect(fileItem(importedUser.content).attachmentId).toBe(restoredId)
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('rejects the wrong envelope kind before writing rows', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)
    const wrongKind = { ...exported, objectKind: 'chat-preset' }
    await expect(importChat(wrongKind)).rejects.toThrow()
    expect(await getDb().chats.count()).toBe(1)
  })

  it('rejects unsupported export schema versions before writing rows', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)
    const unsupported = { ...exported, exportSchemaVersion: 999 }
    await expect(importChat(unsupported)).rejects.toThrow(/ImportSchemaUnsupported/)
    expect(await getDb().chats.count()).toBe(1)
  })

  it('rejects malformed portable message rows before an additive import writes', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)
    const poisoned = structuredClone(exported) as unknown as {
      payload: { messages: Array<Record<string, unknown>> }
    }
    must(poisoned.payload.messages.at(-1), 'final message').content = 'not-an-array'
    const bulkPut = vi.spyOn(getDb().messages, 'bulkPut')

    await expect(importChat(poisoned, { now: 999 })).rejects.toThrow(
      'ImportRowInvalid:message.content',
    )
    expect(bulkPut).not.toHaveBeenCalled()
    expect(await getDb().chats.count()).toBe(1)
  })

  it.each([
    {
      name: 'a message from another source chat',
      mutate(payload: PortableChatPayload) {
        must(payload.messages[0], 'message').chatId = 'different-source-chat'
      },
      error: 'ImportMessageChatMissing',
    },
    {
      name: 'duplicate attachment bundle IDs',
      mutate(payload: PortableChatPayload) {
        payload.attachments.push(must(payload.attachments[0], 'attachment'))
      },
      error: 'ImportAttachmentDuplicateId',
    },
    {
      name: 'a missing storage blob',
      mutate(payload: PortableChatPayload) {
        must(payload.attachments[0], 'attachment').attachment.storage = {
          kind: 'local-blob',
          blobId: 'missing-blob',
        }
      },
      error: 'ImportAttachmentStorageBlobMissing',
    },
    {
      name: 'a blob artifact with no blob',
      mutate(payload: PortableChatPayload) {
        const bundle = must(payload.attachments[0], 'attachment')
        bundle.artifacts.push({
          kind: 'blob',
          artifactId: 'orphaned-artifact',
          attachmentId: bundle.attachment.id,
          processorId: 'test',
          blobId: 'missing-blob',
          createdAt: 1,
        })
      },
      error: 'ImportAttachmentArtifactBlobMissing',
    },
    {
      name: 'a job output with no artifact',
      mutate(payload: PortableChatPayload) {
        const bundle = must(payload.attachments[0], 'attachment')
        bundle.jobs.push({
          id: 'orphaned-job',
          attachmentId: bundle.attachment.id,
          processorId: 'test',
          inputHash: 'hash',
          status: 'succeeded',
          outputArtifactIds: ['missing-artifact'],
          updatedAt: 1,
        })
      },
      error: 'ImportAttachmentArtifactOutputMissing',
    },
    {
      name: 'a content attachment with no bundle',
      mutate(payload: PortableChatPayload) {
        const message = must(
          payload.messages.find((candidate) =>
            candidate.content.some((item) => item.type === 'file'),
          ),
          'message with file',
        )
        const item = fileItem(message.content)
        item.attachmentId = 'missing-content-target'
      },
      error: 'ImportGeneratedOutputAttachmentMissing',
    },
  ])('rejects $name before decoding or writing rows', async ({ mutate, error }) => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)
    const poisoned = structuredClone(exported)
    mutate(poisoned.payload)
    const before = await authoritativeSnapshot()

    await expect(importChat(poisoned, { now: 1000 })).rejects.toThrow(error)
    expect(await authoritativeSnapshot()).toEqual(before)
  })

  it.each(['missing', 'tombstoned'] as const)(
    'repairs content whose only owner ref is $situation',
    async (situation) => {
      const seeded = await seedPortableChat()
      const exported = await exportChat(seeded.chat.id)
      const source = must(
        exported.payload.messages.find((candidate) =>
          candidate.content.some((item) => item.type === 'file'),
        ),
        'message with file',
      )
      const ref = must(source.attachmentRefs?.[0], 'attachment ref')
      source.attachmentRefs = situation === 'missing' ? [] : [{ ...ref, deletedAt: 123 }]

      const result = await importChat(exported, { now: 1_000 })
      const restored = must(
        (await messagesForChat(result.chatId)).find((message) => message.role === 'user'),
        'restored user message',
      )
      const attachmentId = fileItem(restored.content).attachmentId
      const liveRefs = (restored.attachmentRefs ?? []).filter(
        (candidate) => candidate.attachmentId === attachmentId && candidate.deletedAt === undefined,
      )

      expect(liveRefs).toHaveLength(1)
      await expectAttachmentReferenceInvariants(getDb())
    },
  )

  it('rejects an imported chat when a live attachment ref has no target before writing', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)
    const poisoned = structuredClone(exported)
    const message = poisoned.payload.messages.find((row) => row.attachmentRefs?.length)
    const ref = message?.attachmentRefs?.[0]
    if (!message || !ref) throw new Error('expected exported attachment ref')
    message.attachmentRefs = [{ ...ref, attachmentId: 'missing-import-target' }]
    const before = {
      chats: await getDb().chats.count(),
      messages: await getDb().messages.count(),
      edges: await getDb().attachmentRefEdges.count(),
    }

    await expect(importChat(poisoned, { now: 1000 })).rejects.toThrow(
      'AttachmentMissing:missing-import-target',
    )
    expect({
      chats: await getDb().chats.count(),
      messages: await getDb().messages.count(),
      edges: await getDb().attachmentRefEdges.count(),
    }).toEqual(before)
    await expectAttachmentReferenceInvariants(getDb())
  })
})

describe('workspace backup restore', () => {
  it('upgrades legacy recent-model settings at the interchange boundary', async () => {
    const exported = await exportWorkspaceBackup()
    const marker = recentModelRecencyBackfillMarker()
    exported.payload.settings = exported.payload.settings.filter(
      (row) =>
        row.key !== RECENT_MODELS_KEY &&
        row.key !== RECENT_MODEL_RECENCY_KEY &&
        row.key !== marker.key,
    )
    exported.payload.settings.push({
      key: RECENT_MODELS_KEY,
      value: ['model-b', 'model-a'],
    })
    delete exported.payload.manifest

    const migrated = migrateNatterExportEnvelope(exported)

    if (migrated.objectKind !== 'workspace-backup') throw new Error('expected workspace backup')
    expect(
      migrated.payload.settings.find((row) => row.key === RECENT_MODEL_RECENCY_KEY)?.value,
    ).toEqual({
      version: 1,
      entries: [
        { modelId: 'model-b', usedAt: 0, streamId: 'legacy:20' },
        { modelId: 'model-a', usedAt: 0, streamId: 'legacy:19' },
      ],
    })
    expect(migrated.payload.settings.find((row) => row.key === marker.key)).toEqual(marker)
  })

  it('never exports destination-owned physical compaction state', async () => {
    const sourceState = await migrateBrowserWorkspaceCompactionState(getDb().name, {
      knownReclaimableBytes: 123_456,
      lastCompactedLiveBytes: 789_012,
      requestRevision: 7,
      completedRevision: 3,
    })
    expect(await readStorageCompactionState(getDb())).toEqual(sourceState)

    const exported = await exportWorkspaceBackup()

    expect(exported.payload.settings.map((row) => row.key)).not.toContain(
      LEGACY_STORAGE_COMPACTION_STATE_KEY,
    )
    expect(exported.payload.manifest?.counts.settings).toBe(exported.payload.settings.length)
  })

  it('ignores a legacy imported compaction row and measures the rebuilt destination once', async () => {
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const legacy = structuredClone(exported)
    legacy.payload.settings.push({
      key: LEGACY_STORAGE_COMPACTION_STATE_KEY,
      value: {
        formatVersion: 1,
        knownReclaimableBytes: Number.MAX_SAFE_INTEGER,
        lastCompactedLiveBytes: Number.MAX_SAFE_INTEGER,
        requestRevision: Number.MAX_SAFE_INTEGER,
      },
    })
    legacy.payload.manifest = workspaceBackupManifest(legacy.payload)

    await restoreWorkspaceBackup(legacy, { now: 2_400 })

    const state = await readStorageCompactionState(getDb())
    expect(state).toEqual({
      databaseName: getDb().name,
      formatVersion: 2,
      knownReclaimableBytes: 0,
      lastCompactedLiveBytes: await estimatedLiveWorkspaceBytes(),
      requestRevision: 0,
      attemptedRevision: 0,
      completedRevision: 0,
    })
    const roundTrip = await exportWorkspaceBackup()
    expect(roundTrip.payload.settings.map((row) => row.key)).not.toContain(
      LEGACY_STORAGE_COMPACTION_STATE_KEY,
    )
  })

  it('does not preserve zero-owner attachment garbage in a workspace backup', async () => {
    const seeded = await seedPortableChat()
    const orphan = await ingestAttachmentBytes({
      blob: bytes('unreachable bytes'),
      filename: 'orphan.txt',
      now: 100,
    })

    const exported = await exportWorkspaceBackup()
    expect(exported.payload.attachments.map((bundle) => bundle.attachment.id)).toEqual([
      seeded.sourceAttachmentId,
    ])
    expect(
      exported.payload.attachments.some((bundle) => bundle.attachment.id === orphan.attachment.id),
    ).toBe(false)
    expect(await getDb().attachments.get(orphan.attachment.id)).toBeTruthy()
  })

  it('retains the full supersession chain rooted by an incoming message', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const source = must(exported.payload.attachments[0], 'portable attachment')
    const first = rekeyPortableAttachmentBundle(source, 'chain-a', 'chain-b')
    const second = rekeyPortableAttachmentBundle(source, 'chain-b', 'chain-c')
    const third = rekeyPortableAttachmentBundle(source, 'chain-c')
    const orphan = rekeyPortableAttachmentBundle(source, 'chain-orphan')
    const rootedMessage = message({
      chatId: seeded.chat.id,
      role: 'user',
      content: [
        {
          type: 'file',
          attachmentId: first.attachment.id,
          filename: first.attachment.filename,
          mime: first.attachment.mime,
        },
      ],
      attachmentRefs: [attachmentRef(first.attachment.id)],
    })

    const retained = retainReachableIncomingAttachments([first, second, third, orphan], {
      messages: [rootedMessage],
    })

    expect(retained.map((bundle) => bundle.attachment.id)).toEqual([
      'chain-a',
      'chain-b',
      'chain-c',
    ])
  })

  it('repairs the storage-v25 empty-chat shape with omitted tables, a dangling key, and orphan bytes', async () => {
    const seeded = await seedPortableChat()
    const configuredProfile = seeded.profile
    const exported = await exportWorkspaceBackup()
    const configuredKeyId = must(configuredProfile.apiKeyRef, 'configured profile key')
    const legacy = structuredClone(exported)
    legacy.appStorageSchemaVersion = 25
    legacy.payload.chats = []
    legacy.payload.messages = []
    legacy.payload.drafts = []
    const orphan = must(legacy.payload.attachments[0], 'legacy orphan attachment')
    orphan.attachment.refCount = 0
    for (const blob of orphan.blobs) {
      blob.dataBase64 = 'not-valid-base64'
      blob.contentHash = 'sha256:must-not-be-digested'
    }
    legacy.payload.profiles.push({
      ...configuredProfile,
      id: 'profile-needs-key',
      name: 'Needs key',
      apiKeyRef: 'missing-key',
    })
    const partialPayload = legacy.payload as unknown as Record<string, unknown>
    delete partialPayload.manifest
    delete partialPayload.messages
    delete partialPayload.childLists
    delete partialPayload.chatBranchCache

    const migrated = migrateNatterExportEnvelope(legacy)
    if (migrated.objectKind !== 'workspace-backup') throw new Error('expected workspace backup')
    const normalizedPayload = normalizeWorkspaceCredentialReferences(migrated.payload)

    expect(normalizedPayload.chats).toEqual([])
    expect(normalizedPayload.messages).toEqual([])
    expect(normalizedPayload.childLists).toEqual([])
    expect(normalizedPayload.chatBranchCache).toEqual([])
    expect(normalizedPayload.attachments).toEqual([])
    expect(normalizedPayload.keys.map((key) => key.id)).toContain(configuredKeyId)
    expect(normalizedPayload.settings.map((row) => row.key)).toContain('install-secret')
    expect(
      normalizedPayload.profiles.find((profile) => profile.id === configuredProfile.id)?.apiKeyRef,
    ).toBe(configuredKeyId)
    expect(
      must(
        normalizedPayload.profiles.find((profile) => profile.id === 'profile-needs-key'),
        'normalized needs-key profile',
      ),
    ).not.toHaveProperty('apiKeyRef')
    expect(() => validateWorkspaceBackupGraph(normalizedPayload)).not.toThrow()

    const result = await restoreWorkspaceBackup(legacy, { now: 2_500 })

    expect(result).toMatchObject({
      chatCount: 0,
      messageCount: 0,
      attachmentCount: 0,
      profileCount: 2,
      keyCount: 1,
    })
    expect((await getDb().profiles.get(configuredProfile.id))?.apiKeyRef).toBe(configuredKeyId)
    expect(
      must(await getDb().profiles.get('profile-needs-key'), 'restored needs-key profile'),
    ).not.toHaveProperty('apiKeyRef')
    expect(await getDb().keys.get(configuredKeyId)).toBeTruthy()
    expect(await getDb().attachments.count()).toBe(0)
    expect((await getDb().settings.get('install-secret'))?.value).toBeTruthy()
  })

  it('seeds current run-once stream integrity state when an older backup has no marker', async () => {
    const exported = await exportWorkspaceBackup()
    exported.payload.settings = exported.payload.settings.filter(
      (row) => row.key !== STREAM_JOURNAL_INTEGRITY_SETTING_KEY,
    )
    delete exported.payload.manifest

    await restoreWorkspaceBackup(exported, { now: 2_550 })

    expect(await getDb().settings.get(STREAM_JOURNAL_INTEGRITY_SETTING_KEY)).toEqual({
      key: STREAM_JOURNAL_INTEGRITY_SETTING_KEY,
      value: { version: 1, phase: 'complete' },
    })
  })

  it('never exports a profile credential reference whose key row is absent', async () => {
    const profile = await fakeProfile('Dangling credential source')
    await getDb().profiles.put({ ...profile, apiKeyRef: 'missing-export-key' })

    const exported = await exportWorkspaceBackup()
    const exportedProfile = must(
      exported.payload.profiles.find((candidate) => candidate.id === profile.id),
      'exported profile',
    )

    expect(exported.payload.messages).toEqual([])
    expect(exported.payload.childLists).toEqual([])
    expect(exported.payload.chatBranchCache).toEqual([])
    expect(exportedProfile).not.toHaveProperty('apiKeyRef')
    expect(() => validateWorkspaceBackupGraph(exported.payload)).not.toThrow()
  })

  it('exports no rebuildable tree projections and reconstructs them atomically on restore', async () => {
    const seeded = await seedPortableChat()

    const exported = await exportWorkspaceBackup()

    expect(exported.payload.childLists).toEqual([])
    expect(exported.payload.chatBranchCache).toEqual([])
    expect(exported.payload.manifest).toMatchObject({
      version: 1,
      counts: { childLists: 0, chatBranchCache: 0 },
    })

    await restoreWorkspaceBackup(exported, { now: 2_600 })

    const childLists = await getDb()
      .childLists.filter((row) => row.chatId === seeded.chat.id)
      .toArray()
    const childMembers = await getDb()
      .childSlotMembers.filter((row) => row.chatId === seeded.chat.id)
      .toArray()
    expect(new Set(childLists.map((row) => row.parentId))).toEqual(
      new Set([null, seeded.userMessage.id]),
    )
    expect(childMembers.map((row) => row.id)).toEqual([
      seeded.userMessage.id,
      seeded.assistantMessage.id,
    ])
    expect(getDb().tables.map((table) => table.name)).not.toContain('chatBranchCache')
  })

  it('rejects a truncated backup at the final document encoder boundary', async () => {
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const truncated = structuredClone(exported)
    truncated.payload.messages.pop()
    const encode = vi.fn(() => new Blob())

    expect(() => encodeWorkspaceBackupDocument(truncated, encode)).toThrow(
      'ImportWorkspaceManifestCountMismatch:messages',
    )
    expect(encode).not.toHaveBeenCalled()
  })

  it('rejects the incoming manifest before orphan pruning could make its counts look valid', async () => {
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const source = must(exported.payload.attachments[0], 'referenced attachment')
    const poisoned = structuredClone(exported)
    poisoned.payload.attachments.push(rekeyPortableAttachmentBundle(source, 'manifest-orphan'))
    const before = await authoritativeSnapshot()

    await expect(restoreWorkspaceBackup(poisoned, { now: 2_700 })).rejects.toThrow(
      'ImportWorkspaceManifestCountMismatch:attachments:1:2',
    )
    expect(await authoritativeSnapshot()).toEqual(before)
  })

  it('pages a large public backup without whole-table key materialization', async () => {
    const seeded = await seedPortableChat()
    const extraMessages = Array.from({ length: 640 }, (_, index) =>
      message({
        id: `workspace-page-${String(index).padStart(4, '0')}`,
        chatId: seeded.chat.id,
        role: 'assistant',
        parentId: seeded.userMessage.id,
        siblingIndex: index + 1,
        turnIndex: index + 2,
        createdAt: 1_000 + index,
        content: [{ type: 'output_text', text: `workspace page body ${index}` }],
      }),
    )
    const split = extraMessages.map((row) => splitMessageForStorage(row))
    await getDb().messages.bulkPut(split.map((row) => row.header))
    await getDb().messageBodies.bulkPut(split.map((row) => row.body))
    for (let index = 0; index < 16; index += 1) {
      await ingestAttachmentBytes({
        blob: bytes(`large fixture attachment ${index}`),
        filename: `large-fixture-${index}.txt`,
        now: 2_000 + index,
      })
    }
    const exported = await exportWorkspaceBackup()
    const exportMetrics = __importExportMaterializationMetricsForTests()

    expect(exported.payload.messages).toHaveLength(extraMessages.length + 2)
    expect(exported.payload.attachments).toHaveLength(1)
    expect(await getDb().attachments.count()).toBe(17)
    expect(exportMetrics.maxTableReadBatchRows).toBeLessThanOrEqual(128)
    expect(exportMetrics.maxMessageBodyReadBatchRows).toBeLessThanOrEqual(128)
    expect(exportMetrics.messageBodyReadBatches).toBe(6)
    expect(exportMetrics.attachmentBlobReadBytes).toBeGreaterThan(0)

    __resetImportExportMaterializationMetricsForTests()
    await restoreWorkspaceBackup(exported, { now: 3_000 })
    const restoreMetrics = __importExportMaterializationMetricsForTests()

    expect(restoreMetrics.maxTableWriteBatchRows).toBeLessThanOrEqual(128)
    expect(restoreMetrics.tableWriteBatches).toBeGreaterThan(10)
    expect(restoreMetrics.maxAttachmentBlobDecodeBytes).toBeLessThanOrEqual(
      Math.max(
        ...exported.payload.attachments.flatMap((bundle) =>
          bundle.blobs.map((blob) => blob.sizeBytes),
        ),
      ),
    )
  })

  it('base64-encodes attachment blobs sequentially during workspace export', async () => {
    const seeded = await seedPortableChat()
    for (let index = 0; index < 12; index += 1) {
      const ingested = await ingestAttachmentBytes({
        blob: bytes(`workspace export attachment ${index}`),
        filename: `workspace-export-${index}.txt`,
        now: 100 + index,
      })
      await addExistingAttachmentRef({
        attachmentId: ingested.attachment.id,
        draftChatId: seeded.chat.id,
        now: 200 + index,
      })
    }
    const blobReads = trackBlobReadConcurrency()

    const exported = await exportWorkspaceBackup()

    const blobs = exported.payload.attachments.flatMap((bundle) => bundle.blobs)
    expect(blobReads.calls()).toBe(blobs.length)
    expect(blobReads.maxActive()).toBe(1)
    expect(blobReads.maxActiveBytes()).toBe(Math.max(...blobs.map((blob) => blob.sizeBytes)))
  })

  it('serializes admission started during replacement under Web Locks', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    expect(exported.payload.settings.map((row) => row.key)).not.toContain(
      'backfill:chat-sidebar-projection-v1',
    )
    expect(exported.payload.settings.map((row) => row.key)).not.toContain(
      'projection:chat-sidebar-v1',
    )
    const exclusiveEntered = deferredVoid()
    const releaseExclusive = deferredVoid()
    const releaseShared = deferredVoid()
    let exclusive = false
    const request = vi.fn(
      async (name: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
        const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
        const callback = requireTestLockCallback(optionsOrCallback, maybeCallback)
        if (name !== 'workspace:authoritative') return callback({ name })
        const mode = (options as { mode?: string }).mode ?? 'exclusive'
        if (mode === 'exclusive') {
          exclusive = true
          exclusiveEntered.resolve()
          await releaseExclusive.promise
          try {
            return await callback({ name })
          } finally {
            exclusive = false
            releaseShared.resolve()
          }
        }
        if (exclusive) await releaseShared.promise
        return callback({ name })
      },
    )
    vi.stubGlobal('navigator', {
      locks: { request, query: vi.fn(async () => ({ held: [], pending: [] })) },
    })
    const restoring = restoreWorkspaceBackup(exported, { now: 3510 })
    await exclusiveEntered.promise
    const admission = request('workspace:authoritative', { mode: 'shared' }, async () => {
      const manifest = await readBrowserWorkspaceDatabaseManifest()
      const remoteDb = new NatterDb(manifest.activeDatabaseName)
      try {
        await remoteDb.open()
        return await persistRemoteContinuationLease(remoteDb, {
          streamId: 'during-web-lock-restore',
          chatId: seeded.chat.id,
          messageId: seeded.assistantMessage.id,
          ownerClientId: 'new-tab',
          now: 3511,
        })
      } finally {
        remoteDb.close()
      }
    }) as Promise<StreamLeaseRow>
    let admitted = false
    void admission.then(() => {
      admitted = true
    })
    await Promise.resolve()
    expect(admitted).toBe(false)

    releaseExclusive.resolve()
    await restoring
    const lease = await admission
    expect(lease.replacementEpoch).toBe((await readWorkspaceMeta()).replacementEpoch)
    expect(await getDb().streamLeases.get(lease.streamId)).toEqual(lease)
  })

  it('fails replacement closed when admission wins the IndexedDB fallback fence', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    vi.stubGlobal('navigator', { locks: undefined })
    const remoteDb = new NatterDb(getDb().name)
    await remoteDb.open()
    const remoteBackend = createIndexedDbLockBackend({
      openDatabase: async () => remoteDb,
      clientId: 'remote-fallback-tab',
      retryMs: 1,
      trackTransactionActivity: false,
    })
    const admissionEntered = deferredVoid()
    const releaseAdmission = deferredVoid()
    const heartbeatAt = Date.now()
    const admission = remoteBackend.run(
      ['remote-stream-admission:during-fallback-restore'],
      async (grant) => {
        admissionEntered.resolve()
        await releaseAdmission.promise
        return persistRemoteContinuationLease(
          remoteDb,
          {
            streamId: 'during-fallback-restore',
            chatId: seeded.chat.id,
            messageId: seeded.assistantMessage.id,
            ownerClientId: 'new-tab',
            now: heartbeatAt,
          },
          grant,
        )
      },
    )
    await admissionEntered.promise
    const restoring = restoreWorkspaceBackup(exported, { now: heartbeatAt + 1 })
    expect(await getDb().streamLeases.count()).toBe(0)

    releaseAdmission.resolve()
    const lease = await admission
    await remoteBackend.disposeAndDrain?.()
    await expect(restoring).rejects.toMatchObject({
      name: 'WorkspaceReplacementInProgressError',
      blockerIds: [lease.streamId],
    })
    expect(lease.replacementEpoch).toBe((await readWorkspaceMeta()).replacementEpoch)
    expect(await getDb().streamLeases.get(lease.streamId)).toEqual(lease)
    remoteDb.close()
  })

  it('round-trips a default unconfigured chat with the empty profile sentinel', async () => {
    const source = await createChat({ id: 'unconfigured-chat', title: 'Unconfigured', now: 100 })
    expect(source.settings.profileId).toBe('')
    const exported = await exportWorkspaceBackup()
    await createChat({ id: 'post-export-chat', title: 'Post export', now: 200 })

    const result = await restoreWorkspaceBackup(exported, { now: 300 })

    expect(result.chatCount).toBe(1)
    expect(await getDb().chats.get(source.id)).toMatchObject({
      id: source.id,
      settings: { profileId: '' },
    })
    expect(await getDb().chats.get('post-export-chat')).toBeUndefined()
  })

  it('normalizes legacy annotation wire shapes at the import boundary using generation dialect', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const assistant = must(
      exported.payload.messages.find((row) => row.id === seeded.assistantMessage.id),
      'exported assistant',
    )
    if (!assistant.generation) throw new Error('expected generation metadata')
    assistant.generation.apiUsed = 'responses'
    ;(assistant.generation as unknown as Record<string, unknown>).reasoningCarryForward = 'invalid'
    assistant.content = [
      {
        type: 'output_text',
        text: 'Attachment inspected.',
        annotations: [
          {
            type: 'url_citation',
            start_index: 0,
            end_index: 10,
            url: 'https://example.com/source',
            future_field: { preserved: true },
          },
        ],
      } as unknown as ContentItem,
    ]
    assistant.continuationAttempts = [
      {
        streamId: 'legacy-cited-continuation',
        strategy: 'prompt',
        status: 'done',
        apiUsed: 'anthropic-messages',
        startedAt: 1,
        finishedAt: 2,
        unappliedText: 'cited tail',
        unappliedAnnotations: [
          {
            type: 'char_location',
            cited_text: 'tail',
            document_index: 2,
          },
        ],
      } as unknown as NonNullable<Message['continuationAttempts']>[number],
    ]
    delete exported.payload.manifest
    expect(() =>
      assertCurrentWorkspaceBackupRows(exported.payload as unknown as Record<string, unknown>),
    ).toThrow(/reasoningCarryForward/u)

    const migrated = migrateNatterExportEnvelope(exported)
    if (migrated.objectKind !== 'workspace-backup') throw new Error('expected workspace backup')
    const migratedAssistant = must(
      migrated.payload.messages.find((row) => row.id === assistant.id),
      'migrated assistant',
    )
    expect(migratedAssistant.generation?.reasoningCarryForward).toBe('unknown')
    expect(migratedAssistant.continuationAttempts?.[0]?.reasoningCarryForward).toBe('unknown')
    expect(() =>
      assertCurrentWorkspaceBackupRows(migrated.payload as unknown as Record<string, unknown>),
    ).not.toThrow()
    const migratedContent = migratedAssistant.content[0]
    if (migratedContent?.type !== 'output_text') throw new Error('ExpectedMigratedOutputText')
    const migratedAnnotation = migratedContent.annotations?.[0]
    expect(migratedAnnotation).toMatchObject({
      type: 'url_citation',
      source: 'openai-responses',
      startIndex: 0,
      endIndex: 10,
      url: 'https://example.com/source',
    })
    if (migratedAnnotation?.type !== 'url_citation') {
      throw new Error('ExpectedMigratedUrlCitation')
    }
    expect(migratedAnnotation.providerPayload).toMatchObject({
      future_field: { preserved: true },
    })
    const migratedAttempt = migratedAssistant.continuationAttempts?.[0]
    expect(migratedAttempt?.application).toEqual({
      kind: 'unapplied',
      reason: 'base-version-changed',
    })
    if (migratedAttempt?.application.kind !== 'unapplied') {
      throw new Error('ExpectedUnappliedContinuationAttempt')
    }
    if (!('unappliedAnnotations' in migratedAttempt)) {
      throw new Error('ExpectedUnappliedContinuationAnnotations')
    }
    expect(migratedAttempt.unappliedAnnotations).toEqual([
      expect.objectContaining({
        type: 'file_citation',
        source: 'anthropic-messages',
        startIndex: 6,
        endIndex: 10,
        file: {
          kind: 'document',
          provider: 'anthropic-messages',
          documentIndex: 2,
        },
      }),
    ])
  })

  it('preserves current V2 reasoning envelopes exactly across workspace import migration', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const assistant = must(
      exported.payload.messages.find((row) => row.id === seeded.assistantMessage.id),
      'exported assistant',
    )
    const reasoningEnvelope = {
      schemaVersion: 2 as const,
      visible: [
        {
          id: 'visible:claude',
          groupId: 'group:claude',
          kind: 'text' as const,
          text: 'preserved thought',
          format: 'anthropic-claude-v1' as const,
          source: {
            dialect: 'openrouter-chat' as const,
            bridge: 'openrouter' as const,
            detailId: 'thinking-0',
          },
        },
      ],
      carriers: [
        {
          id: 'carrier:claude',
          groupId: 'group:claude',
          kind: 'anthropic-signature' as const,
          signature: 'preserved-signature',
          bindsVisiblePartId: 'visible:claude',
          format: 'anthropic-claude-v1' as const,
          source: {
            dialect: 'openrouter-chat' as const,
            bridge: 'openrouter' as const,
            detailId: 'thinking-0',
          },
        },
      ],
    }
    assistant.reasoningEnvelope = reasoningEnvelope
    delete exported.payload.manifest

    const migrated = migrateNatterExportEnvelope(exported)

    if (migrated.objectKind !== 'workspace-backup') throw new Error('expected workspace backup')
    const migratedAssistant = must(
      migrated.payload.messages.find((row) => row.id === assistant.id),
      'migrated assistant',
    )
    expect(migratedAssistant.reasoningEnvelope).toBe(reasoningEnvelope)
    expect(migratedAssistant.reasoningEnvelope).toEqual(reasoningEnvelope)
    expect(() =>
      assertCurrentWorkspaceBackupRows(migrated.payload as unknown as Record<string, unknown>),
    ).not.toThrow()
  })

  it('salvages legacy message and continuation reasoning once into current V2 envelopes', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const assistant = must(
      exported.payload.messages.find((row) => row.id === seeded.assistantMessage.id),
      'exported assistant',
    )
    ;(assistant as unknown as Record<string, unknown>).reasoningEnvelope = {
      schemaVersion: 1,
      visible: [
        {
          id: 'legacy-visible',
          groupId: 'legacy-group',
          kind: 'text',
          text: 'legacy visible thought',
          format: 'anthropic-claude-v1',
          source: { dialect: 'openrouter-chat', detailId: 'legacy-thinking' },
        },
      ],
      carriers: [
        {
          id: 'legacy-signature',
          groupId: 'legacy-group',
          kind: 'anthropic-signature',
          signature: 'legacy-signature-value',
          bindsVisiblePartId: 'legacy-visible',
          format: 'anthropic-claude-v1',
          source: { dialect: 'openrouter-chat', detailId: 'legacy-thinking' },
        },
      ],
    }
    assistant.continuationAttempts = [
      {
        streamId: 'legacy-continuation-reasoning',
        strategy: 'prompt',
        status: 'done',
        apiUsed: 'anthropic-messages',
        startedAt: 1,
        finishedAt: 2,
        reasoningCarryForward: 'unknown',
        reasoningEnvelope: {
          schemaVersion: 1,
          visible: [
            {
              id: 'legacy-attempt-visible',
              groupId: 'legacy-attempt-group',
              kind: 'summary',
              text: 'legacy attempt summary',
              format: 'anthropic-claude-v1',
              source: { dialect: 'anthropic-messages', blockIndex: 0 },
            },
          ],
          carriers: [],
        },
      } as unknown as NonNullable<Message['continuationAttempts']>[number],
    ]
    delete exported.payload.manifest

    const migrated = migrateNatterExportEnvelope(exported)

    if (migrated.objectKind !== 'workspace-backup') throw new Error('expected workspace backup')
    const migratedAssistant = must(
      migrated.payload.messages.find((row) => row.id === assistant.id),
      'migrated assistant',
    )
    const migratedEnvelope = must(migratedAssistant.reasoningEnvelope, 'migrated envelope')
    expect(migratedEnvelope.schemaVersion).toBe(2)
    const migratedVisible = must(
      migratedEnvelope.visible.find((part) => part.id === 'legacy-visible'),
      'migrated visible reasoning',
    )
    expect(migratedVisible.text).toBe('legacy visible thought')
    expect(migratedVisible.source.bridge).toBe('openrouter')
    const migratedCarrier = must(
      migratedEnvelope.carriers.find((carrier) => carrier.id === 'legacy-signature'),
      'migrated carrier',
    )
    expect(migratedCarrier.kind).toBe('anthropic-signature')
    if (migratedCarrier.kind !== 'anthropic-signature') {
      throw new Error('ExpectedAnthropicSignature')
    }
    expect(migratedCarrier.signature).toBe('legacy-signature-value')
    expect(migratedCarrier.source.bridge).toBe('openrouter')
    const attemptEnvelope = must(
      migratedAssistant.continuationAttempts?.[0]?.reasoningEnvelope,
      'migrated attempt envelope',
    )
    expect(attemptEnvelope.schemaVersion).toBe(2)
    const attemptVisible = must(
      attemptEnvelope.visible.find((part) => part.id === 'legacy-attempt-visible'),
      'migrated attempt visible reasoning',
    )
    expect(attemptVisible.text).toBe('legacy attempt summary')
    expect(attemptVisible.source.bridge).toBe('anthropic-direct')
    expect(() =>
      assertCurrentWorkspaceBackupRows(migrated.payload as unknown as Record<string, unknown>),
    ).not.toThrow()
  })

  it('bounds backup blob validation to one attachment at a time and restores identically', async () => {
    await seedPortableChat()
    for (let index = 0; index < 12; index += 1) {
      await ingestAttachmentBytes({
        blob: bytes(`unreferenced backup attachment ${index}`),
        filename: `unreferenced-${index}.txt`,
        now: 100 + index,
      })
    }
    const exported = await exportWorkspaceBackup()
    const migrated = migrateNatterExportEnvelope(exported)
    if (migrated.objectKind !== 'workspace-backup') throw new Error('expected workspace backup')
    const expectedPayload = stableBackupPayload(migrated.payload)
    const blobCount = exported.payload.attachments.reduce(
      (total, bundle) => total + bundle.blobs.length,
      0,
    )
    const largestBlobSize = Math.max(
      ...exported.payload.attachments.flatMap((bundle) =>
        bundle.blobs.map((blob) => blob.sizeBytes),
      ),
    )
    const digest = trackDigestConcurrency()

    await restoreWorkspaceBackup(exported, { now: 400 })

    expect(digest.calls()).toBe(blobCount)
    expect(digest.maxActive()).toBe(1)
    expect(digest.maxActiveBytes()).toBe(largestBlobSize)
    const restored = await exportWorkspaceBackup()
    expect(stableBackupPayload(restored.payload)).toEqual(expectedPayload)
  })

  it('canonicalizes duplicate legacy template rows into the per-template store on restore', async () => {
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const setting = must(
      exported.payload.settings.find((row) => row.key === LEGACY_SAVED_TEXT_TEMPLATES_KEY),
      'legacy text template setting',
    )
    const original = must(savedTextTemplatesFromStoredValue(setting.value)[0], 'saved template')
    setting.value = [
      original,
      {
        ...original,
        config: { ...original.config, template: 'newer duplicate source' },
        updatedAt: original.updatedAt + 1,
      },
    ]
    delete exported.payload.manifest

    await restoreWorkspaceBackup(exported, { now: 500 })

    expect(await getDb().settings.get(LEGACY_SAVED_TEXT_TEMPLATES_KEY)).toBeUndefined()
    const restoredTemplates = await getDb().textTemplates.toArray()
    expect(restoredTemplates).toHaveLength(1)
    expect(restoredTemplates[0]?.id).toBe(original.id)
    expect(restoredTemplates[0]?.updatedAt).toBe(original.updatedAt + 1)
    expect(restoredTemplates[0]?.config.template).toBe('newer duplicate source')
  })

  it('destructively replaces persisted workspace rows and clears rebuildable caches', async () => {
    const seeded = await seedPortableChat()
    await putWorkspaceDraft(
      {
        chatId: seeded.chat.id,
        text: 'restored draft',
        attachmentRefs: [attachmentRef(seeded.sourceAttachmentId, 80)],
        updatedAt: 80,
      },
      null,
    )
    await getDb().settings.put({ key: 'custom-setting', value: { ok: true } })
    const exported = await exportWorkspaceBackup()
    const portableTemplates = savedTextTemplatesFromStoredValue(
      exported.payload.settings.find((row) => row.key === LEGACY_SAVED_TEXT_TEMPLATES_KEY)?.value,
    )
    expect(portableTemplates).toHaveLength(1)
    delete exported.payload.manifest
    must(exported.payload.chats[0], 'exported chat').previewText = 'stale derived preview'
    exported.payload.settings = exported.payload.settings.filter(
      (row) => row.key !== 'backfill:chat-preview-projection-v1',
    )

    const extraProfile = await fakeProfile('Extra')
    const { presetId: _presetId, ...chatWithoutPreset } = seeded.chat
    const extraChat: Chat = {
      ...chatWithoutPreset,
      id: newId(),
      title: 'Extra',
      settings: { ...seeded.chat.settings, profileId: extraProfile.id },
      folderId: null,
      tags: [],
    }
    await getDb().chats.put(extraChat)
    await getDb().settings.put({ key: 'extra-setting', value: true })
    await putCachedModels(extraProfile.id, {}, { stale: true }, 1)
    const staleFence = await readWorkspaceMeta()
    await getDb().streamLeases.put(
      testGenerationLease({
        streamId: 'settled-stream',
        chatId: extraChat.id,
        messageId: 'settled-target',
        ownerClientId: 'old-tab',
        fenceToken: 'settled-fence',
        replacementEpoch: staleFence.replacementEpoch,
        admissionSequence: 1,
        revision: 0,
        startedAt: 1,
        heartbeatAt: 1,
        phase: 'canonical',
        canonicalAt: 2,
        postCommit: { usedAt: 1, profileId: extraProfile.id },
      }),
    )
    const seededFence = await getDb().browserLocks.get(BROWSER_WRITER_LOCK_NAME)
    if (!seededFence) throw new Error('expected browser writer fence')
    await getDb().browserLocks.put({ ...seededFence, fencingToken: 41 })
    const fenceBeforeRestore = await getDb().browserLocks.get(BROWSER_WRITER_LOCK_NAME)
    const metaBeforeRestore = await readWorkspaceMeta()

    const result = await restoreWorkspaceBackup(exported, { now: STREAM_LEASE_TTL_MS + 2_000 })

    expect(result.chatCount).toBe(1)
    expect(await getDb().chats.get(seeded.chat.id)).toMatchObject({
      previewText: 'Please inspect the attachment.',
    })
    expect(await getDb().chats.get(extraChat.id)).toBeUndefined()
    expect(await getDb().profiles.get(seeded.profile.id)).toBeTruthy()
    expect(await getDb().profiles.get(extraProfile.id)).toBeUndefined()
    expect((await getDb().settings.get('custom-setting'))?.value).toEqual({ ok: true })
    expect((await getDb().settings.get('backfill:chat-preview-projection-v1'))?.value).toBe(1)
    expect((await getDb().settings.get(CHAT_SIDEBAR_PROJECTION_BACKFILL_KEY))?.value).toBe(
      CHAT_SIDEBAR_PROJECTION_MARKER_VERSION,
    )
    expect(await getDb().settings.get(CHAT_SIDEBAR_PROJECTION_LEGACY_BACKFILL_KEY)).toBeUndefined()
    expect(await getDb().settings.get(CHAT_SIDEBAR_PROJECTION_LEGACY_MANIFEST_KEY)).toBeUndefined()
    expect(await getDb().chatSidebarRows.get(seeded.chat.id)).toEqual(
      expect.objectContaining({
        id: seeded.chat.id,
        previewText: 'Please inspect the attachment.',
      }),
    )
    expect(await getDb().chatSidebarRows.get(extraChat.id)).toBeUndefined()
    expect(await getDb().settings.get('extra-setting')).toBeUndefined()
    expect(await getDb().settings.get(LEGACY_SAVED_TEXT_TEMPLATES_KEY)).toBeUndefined()
    expect(await getDb().textTemplates.get(portableTemplates[0]?.id ?? '')).toEqual(
      portableTemplates[0],
    )
    expect(await getDb().models.count()).toBe(0)
    expect(await getDb().streamLeases.count()).toBe(0)
    expect(await readWorkspaceMeta()).toMatchObject({
      workspaceId: metaBeforeRestore.workspaceId,
      replacementEpoch: metaBeforeRestore.replacementEpoch + 1,
    })
    expect(fenceBeforeRestore?.fencingToken).toBe(41)
    const fenceAfterRestore = await getDb().browserLocks.get(BROWSER_WRITER_LOCK_NAME)
    expect(fenceAfterRestore).toMatchObject({
      ownerClientId: null,
      leaseId: null,
      fencingToken: 0,
      expiresAt: 0,
    })

    const restoredMessages = await messagesForChat(seeded.chat.id)
    expect(restoredMessages.map((row) => row.id).sort()).toEqual(
      [seeded.userMessage.id, seeded.assistantMessage.id].sort(),
    )
    const restoredBundle = await getAttachmentBundle(seeded.sourceAttachmentId)
    expect(restoredBundle?.blobs).toHaveLength(1)
    expect(await blobText(restoredBundle?.blobs[0]?.blob as Blob)).toBe('shared attachment bytes')
    expect(await getDb().drafts.get(seeded.chat.id)).toMatchObject({ text: 'restored draft' })
    expect(restoredBundle?.attachment.refCount).toBe(2)
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('rolls the destructive restore back when an owner has duplicate ref IDs', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const poisoned = structuredClone(exported)
    const message = poisoned.payload.messages.find((row) => row.attachmentRefs?.length)
    const ref = message?.attachmentRefs?.[0]
    if (!message || !ref) throw new Error('expected backup attachment ref')
    message.attachmentRefs = [ref, { ...ref }]
    const beforeMessages = await messagesForChat(seeded.chat.id)
    const beforeWorkspace = await readWorkspaceMeta()

    await expect(restoreWorkspaceBackup(poisoned, { now: 3000 })).rejects.toThrow(
      `DuplicateAttachmentRefId:message:${message.id}:${ref.refId}`,
    )
    expect(await messagesForChat(seeded.chat.id)).toEqual(beforeMessages)
    expect(await readWorkspaceMeta()).toEqual(beforeWorkspace)
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('repairs workspace content whose attachment has no live message ref', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const poisoned = structuredClone(exported)
    const message = must(
      poisoned.payload.messages.find((candidate) =>
        candidate.content.some((item) => 'attachmentId' in item),
      ),
      'message with attachment content',
    )
    message.attachmentRefs = []
    await expect(restoreWorkspaceBackup(poisoned, { now: 3050 })).resolves.toMatchObject({
      chatCount: 1,
      messageCount: 2,
    })
    const restored = must(
      (await messagesForChat(seeded.chat.id)).find((candidate) => candidate.id === message.id),
      'restored attachment message',
    )
    const attachmentId = fileItem(restored.content).attachmentId
    expect(restored.attachmentRefs).toContainEqual(expect.objectContaining({ attachmentId }))
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('rejects malformed final rows before any authoritative bulk write', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const poisoned = structuredClone(exported) as unknown as {
      payload: { messages: Array<Record<string, unknown>> }
    }
    must(poisoned.payload.messages.at(-1), 'final message').content = 'not-an-array'
    const before = await authoritativeSnapshot()
    const bulkPut = vi.spyOn(getDb().messages, 'bulkPut')

    await expect(restoreWorkspaceBackup(poisoned, { now: 3100 })).rejects.toThrow(
      'ImportRowInvalid:message.content',
    )
    expect(bulkPut).not.toHaveBeenCalled()
    expect(await authoritativeSnapshot()).toEqual(before)
    expect(await getDb().chats.get(seeded.chat.id)).toBeTruthy()
  })

  it('validates continuation-attempt tool calls before workspace replacement', async () => {
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const poisoned = structuredClone(exported) as unknown as {
      payload: { messages: Array<Record<string, unknown>> }
    }
    must(poisoned.payload.messages.at(-1), 'final message').continuationAttempts = [
      {
        streamId: 'continue-import',
        strategy: 'prompt',
        status: 'done',
        startedAt: 1,
        finishedAt: 2,
        toolCalls: [
          {
            id: 'call-import',
            type: 'function',
            function: { name: 'lookup', arguments: 42 },
          },
        ],
      },
    ]
    const before = await authoritativeSnapshot()

    await expect(restoreWorkspaceBackup(poisoned, { now: 3150 })).rejects.toThrow(
      'ImportRowInvalid:tool call.function.arguments',
    )
    expect(await authoritativeSnapshot()).toEqual(before)
  })

  it.each([
    {
      name: 'chat profile links',
      mutate(payload: WorkspaceBackupPayload) {
        must(payload.chats[0], 'chat').settings.profileId = 'missing-profile'
      },
      error: 'ImportChatProfileMissing',
    },
    {
      name: 'chat preset breadcrumbs',
      mutate(payload: WorkspaceBackupPayload) {
        must(payload.chats[0], 'chat').presetId = 'missing-preset'
      },
      error: 'ImportChatPresetMissing',
    },
    {
      name: 'preset connection links',
      mutate(payload: WorkspaceBackupPayload) {
        const preset = must(payload.presets[0], 'preset')
        preset.connectionProfileId = 'missing-profile'
        preset.settings.profileId = 'missing-profile'
      },
      error: 'ImportPresetConnectionProfileMissing',
    },
    {
      name: 'duplicate message IDs',
      mutate(payload: WorkspaceBackupPayload) {
        payload.messages.push(structuredClone(must(payload.messages[0], 'message')))
      },
      error: 'ImportMessageDuplicateId',
    },
    {
      name: 'cross-chat parents',
      mutate(payload: WorkspaceBackupPayload) {
        const source = must(payload.chats[0], 'chat')
        const extraId = newId()
        payload.chats.push({ ...structuredClone(source), id: extraId, lastUpdatedLeafId: null })
        must(payload.messages.at(-1), 'final message').chatId = extraId
      },
      error: 'ImportParentChatMismatch',
    },
    {
      name: 'parent cycles',
      mutate(payload: WorkspaceBackupPayload) {
        must(payload.messages[0], 'root message').parentId = must(
          payload.messages.at(-1),
          'final message',
        ).id
      },
      error: 'ImportParentCycle',
    },
    {
      name: 'declared attachment ref counts',
      mutate(payload: WorkspaceBackupPayload) {
        must(payload.attachments[0], 'attachment').attachment.refCount += 1
      },
      error: 'ImportAttachmentRefCountMismatch',
    },
    {
      name: 'missing attachments that still contain bytes',
      mutate(payload: WorkspaceBackupPayload) {
        must(payload.attachments[0], 'attachment').attachment.storage = {
          kind: 'missing',
          reason: 'deleted',
          missingSince: 1,
        }
      },
      error: 'ImportMissingAttachmentContainsBytes',
    },
    {
      name: 'preset profile links',
      mutate(payload: WorkspaceBackupPayload) {
        const profile = must(payload.profiles[0], 'profile')
        const settings = structuredClone(must(payload.chats[0], 'chat').settings)
        settings.profileId = 'different-profile'
        payload.presets.push({
          id: 'preset-link-check',
          name: 'Preset link check',
          connectionProfileId: profile.id,
          settings,
          createdAt: 1,
          updatedAt: 1,
        })
      },
      error: 'ImportPresetProfileMismatch',
    },
    {
      name: 'declared branch counts',
      mutate(payload: WorkspaceBackupPayload) {
        const chat = must(payload.chats[0], 'chat')
        const timestamps = payload.messages
          .filter((message) => message.chatId === chat.id)
          .map((message) => ({
            id: message.id,
            createdAt: message.createdAt,
            editedAt: message.editedAt ?? message.createdAt,
          }))
        payload.chatBranchCache.push({
          chatId: chat.id,
          branchLeafId: chat.lastUpdatedLeafId,
          generatedAt: chat.updatedAt,
          textContent: '',
          previewText: '',
          messageCount: timestamps.length + 1,
          wordCount: 0,
          messageTimestamps: timestamps,
        })
      },
      error: 'ImportBranchCacheCountMismatch',
    },
  ])('rejects $name in memory without touching the workspace', async ({ mutate, error }) => {
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const poisoned = structuredClone(exported)
    delete poisoned.payload.manifest
    mutate(poisoned.payload)
    const before = await authoritativeSnapshot()

    await expect(restoreWorkspaceBackup(poisoned, { now: 3200 })).rejects.toThrow(error)
    expect(await authoritativeSnapshot()).toEqual(before)
  })

  it('rejects a non-string chat preset breadcrumb before any authoritative write', async () => {
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const poisoned = structuredClone(exported) as unknown as {
      payload: { chats: Array<Record<string, unknown>> }
    }
    must(poisoned.payload.chats[0], 'chat').presetId = 42
    const before = await authoritativeSnapshot()

    await expect(restoreWorkspaceBackup(poisoned, { now: 3250 })).rejects.toThrow(
      'ImportRowInvalid:chat.presetId',
    )
    expect(await authoritativeSnapshot()).toEqual(before)
  })

  it('validates every blob hash before entering the destructive transaction', async () => {
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const poisoned = structuredClone(exported)
    must(must(poisoned.payload.attachments[0], 'attachment').blobs[0], 'blob').dataBase64 =
      btoa('different bytes')
    const before = await authoritativeSnapshot()

    await expect(restoreWorkspaceBackup(poisoned, { now: 3300 })).rejects.toThrow(
      'ImportAttachmentBlobHashMismatch',
    )
    expect(await authoritativeSnapshot()).toEqual(before)
  })

  it('rolls the whole replacement back on an injected storage failure', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    must(exported.payload.chats[0], 'replacement chat').title = 'Must not commit'
    const before = await failedReplacementSnapshot({ withoutRebuildableSidebar: true })
    const originalPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === 'messageBodies') throw new Error('InjectedRestoreWriteFailure')
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key)
    })

    await expect(restoreWorkspaceBackup(exported, { now: 3400 })).rejects.toThrow(
      'InjectedRestoreWriteFailure',
    )
    expectFailedReplacementPreserved(
      before,
      await failedReplacementSnapshot({ withoutRebuildableSidebar: true }),
    )
    expect((await getDb().chats.get(seeded.chat.id))?.title).toBe('Portable chat')
  })

  it('rolls a discardable replacement transaction back at a preactivation checkpoint', async () => {
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    must(exported.payload.chats[0], 'replacement chat').title = 'Must not survive cancellation'
    const prepared = await prepareBrowserWorkspaceBackup(exported)
    const before = await failedReplacementSnapshot({ withoutRebuildableSidebar: true })
    const reason = new Error('replacement-authority-cancelled')
    let checkpoints = 0

    await expect(
      withNamedLock('replacement-checkpoint-test', (grant) =>
        commitPreparedBrowserWorkspaceBackup(
          getDb(),
          { ...grant, atomicity: 'in-place-atomic' },
          prepared,
          { now: 3425 },
          () => {
            checkpoints += 1
            if (checkpoints === 5) throw reason
          },
        ),
      ),
    ).rejects.toBe(reason)

    expect(checkpoints).toBe(5)
    expectFailedReplacementPreserved(
      before,
      await failedReplacementSnapshot({ withoutRebuildableSidebar: true }),
    )
  })

  it('stages a large slotted replacement in bounded exact-store transactions and commits the fence last', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const sourcePreset = must(exported.payload.presets[0], 'source preset')
    const sourceChat = must(exported.payload.chats[0], 'source chat')
    let parentId = seeded.assistantMessage.id
    for (let index = 0; index < 255; index += 1) {
      const next = message({
        chatId: seeded.chat.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        parentId,
        turnIndex: index + 2,
        createdAt: 100 + index,
        content: [{ type: 'text', text: `bounded restore row ${index}` }],
      })
      exported.payload.messages.push(next)
      parentId = next.id
    }
    Object.assign(sourceChat, {
      lastUpdatedLeafId: parentId,
      structuralVersion: sourceChat.structuralVersion + 255,
    })
    exported.payload.presets = Array.from({ length: 257 }, (_, index) => ({
      ...sourcePreset,
      id: index === 0 ? sourcePreset.id : newId(),
      name: `Bounded preset ${index}`,
      settings: structuredClone(sourcePreset.settings),
    }))
    exported.payload.manifest = workspaceBackupManifest(exported.payload)
    const prepared = await prepareBrowserWorkspaceBackup(exported)
    const destination = new NatterDb(`natter-slotted-success-${newId()}`)
    try {
      await destination.open()
      const records: ReplacementTransactionRecord[] = []
      const epochBefore = (
        await destination.transaction('r', destination.workspaceFence, (tx) =>
          readBrowserWorkspaceMetaFromTransaction(tx),
        )
      ).replacementEpoch

      const committed = await commitPreparedBrowserWorkspaceBackup(
        destination,
        slottedReplacementGrant(destination, records),
        prepared,
        { now: 3430 },
      )

      expect(committed.result).toMatchObject({
        chatCount: 1,
        messageCount: 257,
        presetCount: 257,
      })
      expect(await destination.messages.count()).toBe(257)
      expect(await destination.presets.count()).toBe(257)
      await expect(probeBrowserWorkspaceCurrent(destination.name)).resolves.toEqual({
        kind: 'current',
        physicalVersion: 980,
      })
      const messageScope = JSON.stringify([
        'attachmentCatalogAggregate',
        'attachmentCatalogRows',
        'attachmentRefEdges',
        'attachments',
        'messageBodies',
        'messagePreviews',
        'messages',
      ])
      const messageTransactions = records.filter(
        (record) => JSON.stringify(record.tables) === messageScope,
      )
      expect(messageTransactions).toHaveLength(3)
      expect(
        records.filter(
          (record) =>
            JSON.stringify(record.tables) ===
            JSON.stringify([
              'attachmentCatalogAggregate',
              'attachmentCatalogRows',
              'attachmentRefEdges',
              'attachments',
            ]),
        ),
      ).toEqual([])
      const clearScope = [...ALL_PHYSICAL_STORAGE_TABLE_NAMES]
        .filter((name) => name !== 'browserLocks' && name !== 'workspaceFence')
        .sort()
      expect(records.filter((record) => record.tables.length === clearScope.length)).toEqual([
        expect.objectContaining({ tables: clearScope }),
      ])
      const changedFenceTransactions = records.filter(
        (record) => record.epochAfter !== record.epochBefore,
      )
      expect(changedFenceTransactions).toEqual([
        expect.objectContaining({
          tables: [
            'attachmentCatalogAggregate',
            'attachmentIntegrityState',
            'settings',
            'workspaceFence',
          ],
          epochBefore,
          epochAfter: epochBefore + 1,
        }),
      ])
      expect(records.at(-1)).toEqual(changedFenceTransactions[0])
    } finally {
      await destination.delete()
    }
  })

  it('leaves the activation fence unchanged when slotted staging is interrupted', async () => {
    await seedPortableChat()
    const prepared = await prepareBrowserWorkspaceBackup(await exportWorkspaceBackup())
    const reason = new Error('slotted-staging-cancelled')
    let checkpoints = 0
    const destination = new NatterDb(`natter-slotted-cancel-${newId()}`)
    try {
      await destination.open()
      const records: ReplacementTransactionRecord[] = []
      const readDestinationMeta = () =>
        destination.transaction('r', destination.workspaceFence, (tx) =>
          readBrowserWorkspaceMetaFromTransaction(tx),
        )
      const epochBefore = (await readDestinationMeta()).replacementEpoch

      await expect(
        commitPreparedBrowserWorkspaceBackup(
          destination,
          slottedReplacementGrant(destination, records),
          prepared,
          { now: 3435 },
          () => {
            checkpoints += 1
            if (checkpoints === 10) throw reason
          },
        ),
      ).rejects.toBe(reason)

      expect(checkpoints).toBe(10)
      expect((await readDestinationMeta()).replacementEpoch).toBe(epochBefore)
      expect(records.every((record) => record.epochAfter === epochBefore)).toBe(true)
    } finally {
      await destination.delete()
    }
  })

  it('rolls an in-place replacement back when its final fence write fails', async () => {
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    must(exported.payload.chats[0], 'replacement chat').title = 'Must not survive fence failure'
    const before = await failedReplacementSnapshot({ withoutRebuildableSidebar: true })
    const beforeEpoch = (await readWorkspaceMeta()).replacementEpoch
    const originalPut = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      const replacementEpoch = (value as { readonly replacementEpoch?: unknown }).replacementEpoch
      if (
        this.name === 'workspaceFence' &&
        typeof replacementEpoch === 'number' &&
        replacementEpoch > beforeEpoch
      ) {
        throw new Error('InjectedWorkspaceFenceWriteFailure')
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key)
    })

    await expect(restoreWorkspaceBackup(exported, { now: 3438 })).rejects.toThrow(
      'InjectedWorkspaceFenceWriteFailure',
    )
    expectFailedReplacementPreserved(
      before,
      await failedReplacementSnapshot({ withoutRebuildableSidebar: true }),
    )
  })

  it('fails closed on known active streams without aborting or clearing their state', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const fence = await readWorkspaceMeta()
    const activeLease = testGenerationLease({
      streamId: 'active-runtime-stream',
      chatId: seeded.chat.id,
      messageId: seeded.assistantMessage.id,
      ownerClientId: 'this-tab',
      fenceToken: 'active-runtime-fence',
      replacementEpoch: fence.replacementEpoch,
      admissionSequence: 1,
      revision: 0,
      startedAt: 3450,
      heartbeatAt: 3450,
      targetCommittedAt: 3450,
    })
    await getDb().streamLeases.put(activeLease)
    attemptController.observeLease(activeLease, {
      workspaceId: fence.workspaceId,
      localAuthority: {
        kind: 'writer',
        workspaceId: fence.workspaceId,
        lease: activeLease as WriterStreamLeaseRow,
      },
      phase: 'streaming',
    })
    const before = await failedReplacementSnapshot()

    const error = await restoreWorkspaceBackup(exported, { now: 3450 }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(WorkspaceReplacementInProgressError)
    expect(error).toMatchObject({ blockerIds: ['active-runtime-stream'] })
    expect(attemptController.get('active-runtime-stream')).toBeDefined()
    expect(await getDb().streamLeases.get('active-runtime-stream')).toEqual(activeLease)
    expectFailedReplacementPreserved(before, await failedReplacementSnapshot())
  })

  it('fails closed on a fresh persisted lease inside the replacement transaction', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const fence = await readWorkspaceMeta()
    const now = Date.now()
    await getDb().streamLeases.put(
      testContinuationLease({
        streamId: 'fresh-persisted-stream',
        chatId: seeded.chat.id,
        messageId: seeded.assistantMessage.id,
        ownerClientId: 'other-tab',
        fenceToken: 'fresh-persisted-fence',
        replacementEpoch: fence.replacementEpoch,
        admissionSequence: 1,
        revision: 0,
        startedAt: now,
        heartbeatAt: now,
        targetCommittedAt: now,
        continuationStrategy: 'prompt',
        baseNodeVersion: 0,
        baseBodyVersion: 0,
        postCommit: { usedAt: now, profileId: seeded.profile.id },
      }),
    )
    const before = await failedReplacementSnapshot()

    await expect(restoreWorkspaceBackup(exported, { now })).rejects.toMatchObject({
      name: 'WorkspaceReplacementInProgressError',
      blockerIds: ['fresh-persisted-stream'],
    })
    expectFailedReplacementPreserved(before, await failedReplacementSnapshot())
  })

  it('does not fabricate attempt ownership from a streaming message marker without a lease', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const header = await getDb().messages.get(seeded.assistantMessage.id)
    if (!header?.generation) throw new Error('expected generation header')
    await getDb().messages.put({
      ...header,
      generation: { ...header.generation, status: 'streaming', startedAt: 3_470 },
    })
    expect(await getDb().streamLeases.count()).toBe(0)
    await expect(restoreWorkspaceBackup(exported, { now: 3470 })).resolves.toMatchObject({
      chatCount: 1,
    })
  })

  it('does not let an old orphaned streaming marker block restore forever', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const header = await getDb().messages.get(seeded.assistantMessage.id)
    if (!header?.generation) throw new Error('expected generation header')
    await getDb().messages.put({
      ...header,
      generation: {
        ...header.generation,
        status: 'streaming',
        startedAt: 100,
      },
    })

    await expect(
      restoreWorkspaceBackup(exported, { now: STREAM_LEASE_TTL_MS + 101 }),
    ).resolves.toMatchObject({
      chatCount: 1,
    })
  })

  it('uses held and pending stream-owner Web Locks to close the pre-lease cross-tab race', async () => {
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const request = vi.fn(
      async (name: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
        const callback = requireTestLockCallback(optionsOrCallback, maybeCallback)
        return callback({ name })
      },
    )
    const query = vi.fn(async () => ({
      held: [{ name: 'stream-owner:held-before-lease' }],
      pending: [{ name: 'stream-owner:pending-before-lease' }],
    }))
    vi.stubGlobal('navigator', {
      locks: {
        request,
        query,
      },
    })
    const before = await failedReplacementSnapshot()

    const error = await restoreWorkspaceBackup(exported, { now: 3480 }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(WorkspaceReplacementInProgressError)
    expect(error).toMatchObject({
      blockerIds: ['held-before-lease', 'pending-before-lease'],
    })
    expect(query).toHaveBeenCalled()
    expectFailedReplacementPreserved(before, await failedReplacementSnapshot())
  })

  it.each(['normal send', 'Continue'] as const)(
    'sees pre-mutation %s admission with neither BroadcastChannel nor Web Locks',
    async (kind) => {
      const seeded = await seedPortableChat()
      const exported = await exportWorkspaceBackup()
      vi.stubGlobal('BroadcastChannel', undefined)
      vi.stubGlobal('navigator', { locks: undefined })
      __resetBroadcastForTests()
      __setStreamLockManagerForTests(null)
      const streamId = kind === 'Continue' ? 'admitted-continue' : 'admitted-send'
      const now = Date.now()
      await prepareBlockingAttempt(seeded, kind, streamId, now)
      expect(await getDb().streamLeases.get(streamId)).toMatchObject({
        streamId,
        chatId: seeded.chat.id,
      })
      expect(await getDb().streamLeases.get(streamId)).toMatchObject({
        messageId: kind === 'Continue' ? seeded.assistantMessage.id : 'reserved-send-target',
      })
      __resetBroadcastForTests()
      const before = await failedReplacementSnapshot()

      await expect(restoreWorkspaceBackup(exported, { now })).rejects.toMatchObject({
        name: 'WorkspaceReplacementInProgressError',
        blockerIds: [streamId],
      })
      expectFailedReplacementPreserved(before, await failedReplacementSnapshot())
    },
  )

  it('invalidates pre-replacement discovery and privacy fetches before they can repopulate caches', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const fetches = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    vi.stubGlobal('fetch', fetches)
    const models = configurationDiscoveryApplication
      .refreshModels(seeded.profile, {}, { force: true, apiKey: 'test-key' })
      .catch((error: unknown) => error)
    const privacy = configurationDiscoveryApplication
      .refreshPrivacy(seeded.profile, 'anthropic/claude-opus-4.7', {
        force: true,
        apiKey: 'test-key',
        proxy: { url: 'https://proxy.test/{model}', secret: '' },
      })
      .catch((error: unknown) => error)
    await vi.waitFor(() => {
      expect(fetches).toHaveBeenCalledTimes(2)
    })

    await restoreWorkspaceBackup(exported, { now: 3490 })
    await Promise.all([models, privacy])

    expect(await getCachedModels(seeded.profile.id, {})).toBeUndefined()
    expect(
      await getCachedPrivacyPolicy(seeded.profile.id, 'anthropic/claude-opus-4.7'),
    ).toBeUndefined()
  })

  it('reopens to a deeply equivalent schema-v1 workspace including provider reasoning data', async () => {
    const seeded = await seedPortableChat()
    const current = (await messagesForChat(seeded.chat.id)).find(
      (row) => row.id === seeded.assistantMessage.id,
    )
    if (!current) throw new Error('expected assistant')
    const stored = splitMessageForStorage(
      {
        ...current,
        reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
          [
            {
              type: 'reasoning.text',
              id: 'reasoning-1',
              format: 'anthropic-claude-v1',
              text: 'kept reasoning',
              signature: 'signed',
            },
          ],
          'anthropic-messages',
        ),
        providerOutputItems: [
          {
            dialect: 'anthropic-claude',
            type: 'thinking',
            item: { thinking: 'kept reasoning', signature: 'signed' },
          },
        ],
      },
      { bodyVersion: 2 },
    )
    await getDb().messages.put(stored.header)
    await getDb().messageBodies.put(stored.body)
    const exported = await exportWorkspaceBackup()
    const migrated = migrateNatterExportEnvelope(exported)
    if (migrated.objectKind !== 'workspace-backup') throw new Error('expected workspace backup')

    await restoreWorkspaceBackup(exported, { now: 3500 })
    await shutdownBrowserWorkspace()
    await openBrowserWorkspace()
    const reopened = await exportWorkspaceBackup()

    expect(stableBackupPayload(reopened.payload)).toEqual(stableBackupPayload(migrated.payload))
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('removes impossible runtime custody and recomputes the authoritative leaf at import', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const chat = must(exported.payload.chats[0], 'chat')
    const assistant = must(
      exported.payload.messages.find((message) => message.id === seeded.assistantMessage.id),
      'assistant',
    )
    chat.lastUpdatedLeafId = seeded.userMessage.id
    assistant.generation = {
      ...must(assistant.generation, 'generation'),
      status: 'streaming',
    }

    const migrated = migrateNatterExportEnvelope(exported)

    if (migrated.objectKind !== 'workspace-backup') throw new Error('expected workspace backup')
    expect(must(migrated.payload.chats[0], 'migrated chat').lastUpdatedLeafId).toBe(
      seeded.assistantMessage.id,
    )
    expect(
      must(
        migrated.payload.messages.find((message) => message.id === seeded.assistantMessage.id),
        'migrated assistant',
      ).generation,
    ).toMatchObject({
      status: 'interrupted',
      abortReason: 'tab-close',
      finishedAt: assistant.generation.finishedAt,
    })
    expect('streamLeases' in migrated.payload).toBe(false)
  })

  it('canonicalizes salvageable historical generation metadata at chat and workspace import', async () => {
    const seeded = await seedPortableChat()
    const chat = await exportChat(seeded.chat.id)
    const workspace = await exportWorkspaceBackup()
    const generation = {
      ...must(seeded.assistantMessage.generation, 'generation'),
      apiUsed: 'openrouter',
      delivery: 'legacy-stream',
      costSource: 'legacy',
      status: 'complete',
      integrity: 'unknown',
      reasoningCarryForward: 'legacy',
      reasoningVisibility: null,
      startedAt: undefined,
      model: undefined,
      requestedModel: undefined,
    } as unknown as NonNullable<Message['generation']>
    must(
      chat.payload.messages.find((message) => message.id === seeded.assistantMessage.id),
      'chat assistant',
    ).generation = generation
    must(
      workspace.payload.messages.find((message) => message.id === seeded.assistantMessage.id),
      'workspace assistant',
    ).generation = generation

    const importedChat = await importChat(chat, { now: 4_000 })
    const chatGeneration = must(
      (await messagesForChat(importedChat.chatId)).find((message) => message.role === 'assistant')
        ?.generation,
      'imported chat generation',
    )
    await expect(restoreWorkspaceBackup(workspace, { now: 4_100 })).resolves.toMatchObject({
      chatCount: 1,
    })
    const workspaceGeneration = must(
      (await messagesForChat(seeded.chat.id)).find(
        (message) => message.id === seeded.assistantMessage.id,
      )?.generation,
      'imported workspace generation',
    )

    for (const canonical of [chatGeneration, workspaceGeneration]) {
      expect(canonical).toMatchObject({
        status: 'done',
        integrity: 'clean',
        startedAt: 60,
        reasoningCarryForward: 'unknown',
        reasoningVisibility: { disclosure: 'unknown' },
      })
      expect(canonical).not.toHaveProperty('apiUsed')
      expect(canonical).not.toHaveProperty('delivery')
      expect(canonical).not.toHaveProperty('costSource')
      expect(canonical).not.toHaveProperty('model')
      expect(canonical).not.toHaveProperty('requestedModel')
    }
  })

  it('returns a current large backup by identity without cloning unchanged payload nodes', async () => {
    await seedPortableChat()
    const firstPass = migrateNatterExportEnvelope(await exportWorkspaceBackup())
    if (firstPass.objectKind !== 'workspace-backup') throw new Error('expected workspace backup')
    const largeText = 'large-current-payload-'.repeat(250_000)
    const sourceMessage = must(
      firstPass.payload.messages.find((message) => message.role === 'user'),
      'user message',
    )
    const largeContent: ContentItem[] = [
      { type: 'text', text: largeText },
      ...sourceMessage.content.slice(1),
    ]
    const largeMessage: Message = { ...sourceMessage, content: largeContent }
    const messages = firstPass.payload.messages.map((message) =>
      message === sourceMessage ? largeMessage : message,
    )
    const current = {
      ...firstPass,
      payload: { ...firstPass.payload, messages },
    }

    const migrated = migrateNatterExportEnvelope(current)

    expect(migrated).toBe(current)
    if (migrated.objectKind !== 'workspace-backup') throw new Error('expected workspace backup')
    expect(migrated.payload).toBe(current.payload)
    expect(migrated.payload.messages).toBe(messages)
    expect(migrated.payload.settings).toBe(current.payload.settings)
    expect(migrated.payload.messages.find((message) => message.id === largeMessage.id)).toBe(
      largeMessage,
    )
    expect(largeMessage.content).toBe(largeContent)
    expect((largeMessage.content[0] as { text: string }).text).toBe(largeText)
  })

  it('copies only the outdated message and settings array in a mixed large backup', async () => {
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const sourceUser = must(
      exported.payload.messages.find((message) => message.role === 'user'),
      'user message',
    )
    const sourceAssistant = must(
      exported.payload.messages.find((message) => message.role === 'assistant'),
      'assistant message',
    )
    const generation = { ...must(sourceAssistant.generation, 'generation') }
    delete generation.status
    delete generation.integrity
    const outdatedAssistant = { ...sourceAssistant, generation }
    const largeText = 'large-mixed-payload-'.repeat(250_000)
    const largeContent: ContentItem[] = [
      { type: 'text', text: largeText },
      ...sourceUser.content.slice(1),
    ]
    const largeUser: Message = { ...sourceUser, content: largeContent }
    const messages = exported.payload.messages.map((message) => {
      if (message === sourceUser) return largeUser
      if (message === sourceAssistant) return outdatedAssistant
      return message
    })
    const settings = exported.payload.settings.filter(
      (row) => row.key !== 'backfill:chat-preview-projection-v1',
    )
    const { manifest: _manifest, ...payload } = exported.payload
    const mixed = { ...exported, payload: { ...payload, messages, settings } }

    const migrated = migrateNatterExportEnvelope(mixed)

    expect(migrated).not.toBe(mixed)
    if (migrated.objectKind !== 'workspace-backup') throw new Error('expected workspace backup')
    expect(migrated.payload.messages).not.toBe(messages)
    expect(migrated.payload.settings).not.toBe(settings)
    expect(migrated.payload.settings.slice(0, settings.length)).toEqual(settings)
    for (let index = 0; index < settings.length; index += 1) {
      expect(migrated.payload.settings[index]).toBe(settings[index])
    }
    expect(migrated.payload.messages.find((message) => message.id === largeUser.id)).toBe(largeUser)
    expect(
      migrated.payload.messages.find((message) => message.id === outdatedAssistant.id),
    ).not.toBe(outdatedAssistant)
    expect(largeUser.content).toBe(largeContent)
    expect((largeUser.content[0] as { text: string }).text).toBe(largeText)
  })
})

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
