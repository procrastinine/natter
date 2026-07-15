// @vitest-environment node

import { Blob as NodeBlob } from 'node:buffer'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateNatterExportEnvelope } from '../../src/backcompat/import-export'
import { buildBranchCacheRow } from '../../src/core/branch-flatten'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type {
  PortableChatPayload,
  WorkspaceBackupPayload,
} from '../../src/core/import-export/schema'
import { createSavedTextTemplate, EMPTY_TEXT_TEMPLATE } from '../../src/core/text-templates'
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
import { startRequestLifecycle } from '../../src/hooks/requestLifecycle'
import { newId } from '../../src/lib/ulid'
import {
  deleteReferencedAttachmentBytes,
  getAttachmentBundle,
  ingestAttachmentBytes,
} from '../../src/store/attachments'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __importExportMaterializationMetricsForTests,
  __resetBrowserImportExportBackendForTests,
  __resetImportExportMaterializationMetricsForTests,
} from '../../src/store/browser-import-export'
import { BROWSER_WRITER_LOCK_NAME } from '../../src/store/browser-lock-record'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { createChat } from '../../src/store/chats'
import { __resetDbForTests, childListKey, getDb, openDb } from '../../src/store/db'
import {
  __resetImportExportBackendForTests,
  exportChat,
  exportChatPreset,
  exportWorkspaceBackup,
  importChat,
  importChatPreset,
  restoreWorkspaceBackup,
  WorkspaceReplacementInProgressError,
} from '../../src/store/import-export'
import { __resetKeyCacheForTests, createKey } from '../../src/store/keys'
import { __resetLockTrackerForTests, withNamedLock } from '../../src/store/locks'
import { hydrateMessages, splitMessageForStorage } from '../../src/store/message-storage'
import {
  __resetModelsInFlightForTests,
  dedupedModelsFetch,
  getCachedModels,
} from '../../src/store/models-cache'
import { createPreset, listPresets } from '../../src/store/presets'
import {
  __resetPrivacyInFlightForTests,
  dedupedPrivacyFetch,
  getCachedPrivacyPolicy,
} from '../../src/store/privacy-cache'
import { createProfile } from '../../src/store/profiles'
import { createPromptPreset } from '../../src/store/prompt-presets'
import {
  __flushStreamLeaseWritesForTests,
  __resetStreamLeasesForTests,
  __setStreamLockManagerForTests,
} from '../../src/store/stream-leases'
import { useStreamStore } from '../../src/store/zustand/streamStore'
import { expectAttachmentReferenceInvariants } from '../helpers/attachment-reference-invariants'

const DB_NAME = 'natter'

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
  useStreamStore.getState().reset()
  __resetBrowserImportExportBackendForTests()
  __resetImportExportMaterializationMetricsForTests()
  __resetBrowserRepositoryForTests()
  __resetImportExportBackendForTests()
  __resetBroadcastForTests()
  __resetKeyCacheForTests()
  __resetModelsInFlightForTests()
  __resetPrivacyInFlightForTests()
  __resetStreamLeasesForTests()
  __resetLockTrackerForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

function bytes(text: string): Blob {
  return new NodeBlob([new TextEncoder().encode(text)], { type: 'text/plain' }) as unknown as Blob
}

async function fakeProfile(name = 'OpenRouter'): Promise<ConnectionProfile> {
  const key = await createKey({ name, plaintextKey: 'sk-or-v1-fake', now: 1 })
  return createProfile({
    name,
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: key.id,
    now: 2,
  })
}

async function flattenedSettings(profileId: ProfileId): Promise<ChatSettings> {
  const [system, append, continueSystem, continueUser, prefill] = await Promise.all([
    createPromptPreset({
      kind: 'system',
      name: 'System',
      text: 'System text',
      now: 10,
    }),
    createPromptPreset({
      kind: 'append',
      name: 'Append',
      text: 'Append text',
      now: 11,
    }),
    createPromptPreset({
      kind: 'continue-system',
      name: 'Continue system',
      text: 'Continue system text',
      now: 12,
    }),
    createPromptPreset({
      kind: 'continue-user',
      name: 'Continue user',
      text: 'Continue user text',
      now: 13,
    }),
    createPromptPreset({
      kind: 'prefill',
      name: 'Prefill',
      text: 'Prefill text',
      now: 14,
    }),
  ])
  const template = await createSavedTextTemplate({
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
  settings.tools.openrouter.enabledServerToolIds = ['web-search']
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
  await db.folders.put(folder)
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
      startedAt: 55,
      finishedAt: 60,
      cost: 0.01,
    },
  })
  const cache = buildBranchCacheRow({
    chatId,
    branchLeafId: assistantMessage.id,
    messages: [userMessage, assistantMessage],
    generatedAt: 70,
  })
  const chat: Chat = {
    id: chatId,
    title: 'Portable chat',
    titleStatus: 'manual',
    createdAt: 45,
    updatedAt: 70,
    lastViewedAt: 70,
    wordCount: cache.wordCount,
    totalCostUsd: 0.01,
    metaVersion: 0,
    summaryVersion: 0,
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
    previewText: cache.previewText,
  }
  await db.presets.put({
    id: 'source-preset',
    name: 'Source preset',
    connectionProfileId: profile.id,
    settings,
    sortIndex: 0,
    createdAt: 44,
    updatedAt: 44,
  })
  await db.chats.put(chat)
  await getBrowserRepository().runMutation(
    [
      { kind: 'message', messageId: userMessage.id },
      { kind: 'message', messageId: assistantMessage.id },
      { kind: 'children', chatId, parentId: null },
      { kind: 'children', chatId, parentId: userMessage.id },
      { kind: 'attachment', attachmentId: bundle.attachment.id },
    ],
    async (ctx) => {
      await ctx.putMessage(userMessage)
      await ctx.putMessage(assistantMessage)
    },
  )
  await db.childLists.bulkPut([
    { id: childListKey(chatId, null), chatId, parentId: null, version: 0, updatedAt: 70 },
    {
      id: childListKey(chatId, userMessage.id),
      chatId,
      parentId: userMessage.id,
      version: 0,
      updatedAt: 70,
    },
  ])
  await db.chatBranchCache.put(cache)
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
    if (table.name === 'browserLocks') continue
    const rows = await Promise.all((await table.toArray()).map(canonicalizeStoredValue))
    result[table.name] = [...rows].sort((left: unknown, right: unknown) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    )
  }
  return result
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
    const preset = await createPreset({
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
    expect(portable.tools.openrouter.enabledServerToolIds).toEqual(['web-search'])
  })

  it('imports a flattened preset even when the source connection is missing', async () => {
    const sourceProfile = await fakeProfile()
    const preset = await createPreset({
      name: 'Portable preset',
      connectionProfileId: sourceProfile.id,
      settings: await flattenedSettings(sourceProfile.id),
      now: 100,
    })
    const exported = await exportChatPreset(preset.id)

    await resetAll()
    await openDb()

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
    const first = await createPreset({
      name: 'First',
      connectionProfileId: profile.id,
      settings,
      now: 100,
    })
    const second = await createPreset({
      name: 'Second',
      connectionProfileId: profile.id,
      settings,
      now: 200,
    })
    const exported = await exportChatPreset(first.id)

    expect(exported.payload).not.toHaveProperty('sortIndex')

    const result = await importChatPreset(exported, { targetProfileId: profile.id, now: 300 })
    const rows = await listPresets()
    expect(rows.map((row) => row.id)).toEqual([first.id, second.id, result.presetId])
    expect(rows.at(-1)?.sortIndex).toBeGreaterThan(second.sortIndex)
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
        projectionVersion: 1,
      }),
    )
    expect(result.createdAttachmentIds).toEqual([])
    expect(result.reusedAttachmentIds).toEqual([seeded.sourceAttachmentId])
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

  it('creates a new attachment when only the hash matches but the filename differs', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)

    await resetAll()
    await openDb()
    const existing = await ingestAttachmentBytes({
      blob: bytes('shared attachment bytes'),
      filename: 'renamed.txt',
      now: 500,
    })

    const result = await importChat(exported, { now: 600 })
    const importedMessages = await messagesForChat(result.chatId)
    const importedUser = importedMessages.find((row) => row.role === 'user')
    const importedAttachmentId = importedUser?.attachmentRefs?.[0]?.attachmentId

    expect(result.reusedAttachmentIds).toEqual([])
    expect(result.createdAttachmentIds).toHaveLength(1)
    expect(importedAttachmentId).toBe(result.createdAttachmentIds[0])
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

    await resetAll()
    await openDb()
    const digest = trackDigestConcurrency()
    const result = await importChat(exported, { targetProfileId: null, now: 600 })

    expect(digest.calls()).toBe(expectedBlobCount)
    expect(digest.maxActive()).toBe(1)
    expect(digest.maxActiveBytes()).toBe(largestBlobSize)
    expect(result.createdAttachmentIds).toHaveLength(1)
    const imported = await getAttachmentBundle(must(result.createdAttachmentIds[0], 'attachment'))
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
    expect(result.createdAttachmentIds).toHaveLength(1)
    expect(result.reusedAttachmentIds).toEqual([])
    const restoredId = result.createdAttachmentIds[0]
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

    const importedUser = (await messagesForChat(result.chatId)).find((row) => row.role === 'user')
    expect(importedUser?.attachmentRefs?.[0]?.attachmentId).toBe(restoredId)
    expect(fileItem(importedUser?.content ?? []).attachmentId).toBe(restoredId)
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('rejects the wrong envelope kind before writing rows', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)
    const wrongKind = { ...exported, objectKind: 'chat-preset' }
    expect(() => importChat(wrongKind)).toThrow()
    expect(await getDb().chats.count()).toBe(1)
  })

  it('rejects unsupported export schema versions before writing rows', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)
    const unsupported = { ...exported, exportSchemaVersion: 999 }
    expect(() => importChat(unsupported)).toThrow(/ImportSchemaUnsupported/)
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

    expect(() => importChat(poisoned, { now: 999 })).toThrow('ImportRowInvalid:message.content')
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
      error: 'ImportContentAttachmentMissing',
    },
    {
      name: 'content pointing to an attachment without a live owner ref',
      mutate(payload: PortableChatPayload) {
        const message = must(
          payload.messages.find((candidate) =>
            candidate.content.some((item) => item.type === 'file'),
          ),
          'message with file',
        )
        message.attachmentRefs = []
      },
      error: 'ImportContentAttachmentRefMissing',
    },
    {
      name: 'content pointing only to a tombstoned owner ref',
      mutate(payload: PortableChatPayload) {
        const message = must(
          payload.messages.find((candidate) =>
            candidate.content.some((item) => item.type === 'file'),
          ),
          'message with file',
        )
        const ref = must(message.attachmentRefs?.[0], 'attachment ref')
        message.attachmentRefs = [{ ...ref, deletedAt: 123 }]
      },
      error: 'ImportContentAttachmentRefMissing',
    },
  ])('rejects $name before decoding or writing rows', async ({ mutate, error }) => {
    const seeded = await seedPortableChat()
    const exported = await exportChat(seeded.chat.id)
    const poisoned = structuredClone(exported)
    mutate(poisoned.payload)
    const before = await authoritativeSnapshot()

    expect(() => importChat(poisoned, { now: 1000 })).toThrow(error)
    expect(await authoritativeSnapshot()).toEqual(before)
  })

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

    expect(() => importChat(poisoned, { now: 1000 })).toThrow(
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
    const messageToCollection = vi.spyOn(getDb().messages, 'toCollection')
    const attachmentToCollection = vi.spyOn(getDb().attachments, 'toCollection')

    const exported = await exportWorkspaceBackup()
    const exportMetrics = __importExportMaterializationMetricsForTests()

    expect(exported.payload.messages).toHaveLength(extraMessages.length + 2)
    expect(exported.payload.attachments).toHaveLength(17)
    expect(messageToCollection).not.toHaveBeenCalled()
    expect(attachmentToCollection).not.toHaveBeenCalled()
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
    await seedPortableChat()
    for (let index = 0; index < 12; index += 1) {
      await ingestAttachmentBytes({
        blob: bytes(`workspace export attachment ${index}`),
        filename: `workspace-export-${index}.txt`,
        now: 100 + index,
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
    await seedPortableChat()
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
    vi.stubGlobal('navigator', { locks: { request, query: vi.fn(async () => ({})) } })

    const restoring = restoreWorkspaceBackup(exported, { now: 3510 })
    await exclusiveEntered.promise
    const admission = getBrowserRepository().upsertStreamLease({
      streamId: 'during-web-lock-restore',
      chatId: 'restored-chat',
      ownerClientId: 'new-tab',
      startedAt: 3511,
      heartbeatAt: 3511,
    })
    await Promise.resolve()
    expect(await getDb().streamLeases.count()).toBe(0)

    releaseExclusive.resolve()
    await restoring
    const lease = await admission
    expect(lease.replacementEpoch).toBe(
      (await getBrowserRepository().getWorkspaceMeta()).replacementEpoch,
    )
    expect(await getDb().streamLeases.get(lease.streamId)).toEqual(lease)
  })

  it('fails replacement closed when admission wins the IndexedDB fallback fence', async () => {
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    vi.stubGlobal('navigator', { locks: undefined })
    __resetLockTrackerForTests()
    const holderEntered = deferredVoid()
    const releaseHolder = deferredVoid()
    const holder = withNamedLock('test:hold-fallback-writer', async () => {
      holderEntered.resolve()
      await releaseHolder.promise
    })
    await holderEntered.promise

    const heartbeatAt = Date.now()
    const admission = getBrowserRepository().upsertStreamLease({
      streamId: 'during-fallback-restore',
      chatId: 'restored-chat',
      ownerClientId: 'new-tab',
      startedAt: heartbeatAt,
      heartbeatAt,
    })
    await Promise.resolve()
    const restoring = restoreWorkspaceBackup(exported, { now: heartbeatAt + 1 })
    expect(await getDb().streamLeases.count()).toBe(0)

    releaseHolder.resolve()
    await holder
    const lease = await admission
    await expect(restoring).rejects.toMatchObject({
      name: 'WorkspaceReplacementInProgressError',
      blockerIds: [lease.streamId],
    })
    expect(lease.replacementEpoch).toBe(
      (await getBrowserRepository().getWorkspaceMeta()).replacementEpoch,
    )
    expect(await getDb().streamLeases.get(lease.streamId)).toEqual(lease)
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

  it('destructively replaces persisted workspace rows and clears rebuildable caches', async () => {
    const seeded = await seedPortableChat()
    await getBrowserRepository().runMutation(
      [
        { kind: 'draft', chatId: seeded.chat.id },
        { kind: 'attachment', attachmentId: seeded.sourceAttachmentId },
      ],
      async (ctx) => {
        await ctx.putDraft({
          chatId: seeded.chat.id,
          text: 'restored draft',
          attachmentRefs: [attachmentRef(seeded.sourceAttachmentId, 80)],
          updatedAt: 80,
        })
      },
    )
    await getDb().settings.put({ key: 'custom-setting', value: { ok: true } })
    const exported = await exportWorkspaceBackup()
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
    await getDb().models.put({
      profileId: extraProfile.id,
      queryKey: 'models',
      fetchedAt: 1,
      payload: { stale: true },
    })
    await getDb().streamLeases.put({
      streamId: 'stale-stream',
      chatId: extraChat.id,
      ownerClientId: 'old-tab',
      startedAt: 1,
      heartbeatAt: 1,
    })
    const seededFence = await getDb().browserLocks.get(BROWSER_WRITER_LOCK_NAME)
    if (!seededFence) throw new Error('expected browser writer fence')
    await getDb().browserLocks.put({ ...seededFence, fencingToken: 41 })
    const fenceBeforeRestore = await getDb().browserLocks.get(BROWSER_WRITER_LOCK_NAME)
    const metaBeforeRestore = await getBrowserRepository().getWorkspaceMeta()

    const result = await restoreWorkspaceBackup(exported, { now: 2000 })

    expect(result.chatCount).toBe(1)
    expect(await getDb().chats.get(seeded.chat.id)).toMatchObject({
      previewText: 'Please inspect the attachment.',
    })
    expect(await getDb().chats.get(extraChat.id)).toBeUndefined()
    expect(await getDb().profiles.get(seeded.profile.id)).toBeTruthy()
    expect(await getDb().profiles.get(extraProfile.id)).toBeUndefined()
    expect((await getDb().settings.get('custom-setting'))?.value).toEqual({ ok: true })
    expect((await getDb().settings.get('backfill:chat-preview-projection-v1'))?.value).toBe(1)
    expect((await getDb().settings.get('backfill:chat-sidebar-projection-v1'))?.value).toBe(1)
    expect((await getDb().settings.get('projection:chat-sidebar-v1'))?.value).toEqual({
      projectionVersion: 1,
      expectedCount: 1,
    })
    expect(await getDb().chatSidebarRows.get(seeded.chat.id)).toEqual(
      expect.objectContaining({
        id: seeded.chat.id,
        previewText: 'Please inspect the attachment.',
      }),
    )
    expect(await getDb().chatSidebarRows.get(extraChat.id)).toBeUndefined()
    expect(await getDb().settings.get('extra-setting')).toBeUndefined()
    expect(await getDb().models.count()).toBe(0)
    expect(await getDb().streamLeases.count()).toBe(0)
    expect(await getBrowserRepository().getWorkspaceMeta()).toMatchObject({
      mutationCounter: metaBeforeRestore.mutationCounter + 1,
      replacementEpoch: metaBeforeRestore.replacementEpoch + 1,
    })
    const fenceAfterRestore = await getDb().browserLocks.get(BROWSER_WRITER_LOCK_NAME)
    expect(fenceAfterRestore?.fencingToken).toBeGreaterThanOrEqual(
      fenceBeforeRestore?.fencingToken ?? 41,
    )
    expect(fenceAfterRestore).toMatchObject({ ownerClientId: null, leaseId: null, expiresAt: 0 })

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
    const beforeWorkspace = await getBrowserRepository().getWorkspaceMeta()

    await expect(restoreWorkspaceBackup(poisoned, { now: 3000 })).rejects.toThrow(
      `DuplicateAttachmentRefId:message:${message.id}:${ref.refId}`,
    )
    expect(await messagesForChat(seeded.chat.id)).toEqual(beforeMessages)
    expect((await getBrowserRepository().getWorkspaceMeta()).mutationCounter).toBe(
      beforeWorkspace.mutationCounter,
    )
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('rejects workspace content whose attachment has no live message ref', async () => {
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
    const before = await authoritativeSnapshot()

    await expect(restoreWorkspaceBackup(poisoned, { now: 3050 })).rejects.toThrow(
      `ImportContentAttachmentRefMissing:${message.id}`,
    )
    expect(await authoritativeSnapshot()).toEqual(before)
    expect(await getDb().chats.get(seeded.chat.id)).toBeTruthy()
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

    expect(() => restoreWorkspaceBackup(poisoned, { now: 3100 })).toThrow(
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

    expect(() => restoreWorkspaceBackup(poisoned, { now: 3150 })).toThrow(
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
      name: 'profile primary key links',
      mutate(payload: WorkspaceBackupPayload) {
        must(payload.profiles[0], 'profile').apiKeyRef = 'missing-key'
      },
      error: 'ImportProfileKeyMissing',
    },
    {
      name: 'profile fallback key links',
      mutate(payload: WorkspaceBackupPayload) {
        must(payload.profiles[0], 'profile').apiKeyFallbackRefs = ['missing-key']
      },
      error: 'ImportProfileKeyMissing',
    },
    {
      name: 'profile management key links',
      mutate(payload: WorkspaceBackupPayload) {
        must(payload.profiles[0], 'profile').managementApiKeyRef = 'missing-key'
      },
      error: 'ImportProfileKeyMissing',
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
          sortIndex: 0,
          createdAt: 1,
          updatedAt: 1,
        })
      },
      error: 'ImportPresetProfileMismatch',
    },
    {
      name: 'declared branch counts',
      mutate(payload: WorkspaceBackupPayload) {
        must(payload.chatBranchCache[0], 'branch cache').messageCount += 1
      },
      error: 'ImportBranchCacheCountMismatch',
    },
  ])('rejects $name in memory without touching the workspace', async ({ mutate, error }) => {
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const poisoned = structuredClone(exported)
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

    expect(() => restoreWorkspaceBackup(poisoned, { now: 3250 })).toThrow(
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
    await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const before = await authoritativeSnapshot()
    vi.spyOn(getDb().messageBodies, 'bulkPut').mockRejectedValueOnce(
      new Error('InjectedRestoreWriteFailure'),
    )

    await expect(restoreWorkspaceBackup(exported, { now: 3400 })).rejects.toThrow(
      'InjectedRestoreWriteFailure',
    )
    expect(await authoritativeSnapshot()).toEqual(before)
  })

  it('fails closed on known active streams without aborting or clearing their state', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const abort = vi.fn()
    useStreamStore.getState().setActive({
      streamId: 'active-runtime-stream',
      replacementEpoch: 0,
      chatId: seeded.chat.id,
      messageId: seeded.assistantMessage.id,
      ownerClientId: 'this-tab',
      startedAt: Date.now(),
      abort,
    })
    const before = await authoritativeSnapshot()

    const error = await restoreWorkspaceBackup(exported, { now: 3450 }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(WorkspaceReplacementInProgressError)
    expect(error).toMatchObject({ blockerIds: ['active-runtime-stream'] })
    expect(abort).not.toHaveBeenCalled()
    expect(useStreamStore.getState().isActive('active-runtime-stream')).toBe(true)
    expect(await authoritativeSnapshot()).toEqual(before)
  })

  it('fails closed on a fresh persisted lease inside the replacement transaction', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    await getDb().streamLeases.put({
      streamId: 'fresh-persisted-stream',
      chatId: seeded.chat.id,
      messageId: seeded.assistantMessage.id,
      ownerClientId: 'other-tab',
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    })
    const before = await authoritativeSnapshot()

    await expect(restoreWorkspaceBackup(exported, { now: 3460 })).rejects.toMatchObject({
      name: 'WorkspaceReplacementInProgressError',
      blockerIds: ['fresh-persisted-stream'],
    })
    expect(await authoritativeSnapshot()).toEqual(before)
  })

  it('catches a committed streaming placeholder before its lease upsert lands', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    const header = await getDb().messages.get(seeded.assistantMessage.id)
    if (!header?.generation) throw new Error('expected generation header')
    await getDb().messages.put({
      ...header,
      generation: { ...header.generation, status: 'streaming', startedAt: Date.now() },
    })
    expect(await getDb().streamLeases.count()).toBe(0)
    const before = await authoritativeSnapshot()

    await expect(restoreWorkspaceBackup(exported, { now: 3470 })).rejects.toMatchObject({
      name: 'WorkspaceReplacementInProgressError',
      blockerIds: [`streaming-message:${seeded.assistantMessage.id}`],
    })
    expect(await authoritativeSnapshot()).toEqual(before)
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
        startedAt: Date.now() - 60_000,
      },
    })

    await expect(restoreWorkspaceBackup(exported, { now: 3475 })).resolves.toMatchObject({
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
    vi.stubGlobal('navigator', {
      locks: {
        request,
        query: vi.fn(async () => ({
          held: [{ name: 'stream-owner:held-before-lease' }],
          pending: [{ name: 'stream-owner:pending-before-lease' }],
        })),
      },
    })
    const before = await authoritativeSnapshot()

    const error = await restoreWorkspaceBackup(exported, { now: 3480 }).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(WorkspaceReplacementInProgressError)
    expect(error).toMatchObject({
      blockerIds: ['held-before-lease', 'pending-before-lease'],
    })
    expect(request).toHaveBeenCalled()
    expect(await authoritativeSnapshot()).toEqual(before)
  })

  it.each([
    'normal send',
    'Continue',
  ])('sees pre-mutation %s admission with neither BroadcastChannel nor Web Locks', async (kind) => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    vi.stubGlobal('BroadcastChannel', undefined)
    vi.stubGlobal('navigator', { locks: undefined })
    __resetBroadcastForTests()
    __setStreamLockManagerForTests(null)
    const streamId = kind === 'Continue' ? 'admitted-continue' : 'admitted-send'
    const lifecycle = await startRequestLifecycle(
      kind === 'Continue'
        ? {
            chatId: seeded.chat.id,
            streamId,
            messageId: seeded.assistantMessage.id,
            attemptKind: 'continuation',
          }
        : {
            chatId: seeded.chat.id,
            streamId,
            messageId: 'reserved-send-target',
            attemptKind: 'generation',
          },
    )
    expect(await getDb().streamLeases.get(streamId)).toMatchObject({
      streamId,
      chatId: seeded.chat.id,
    })
    expect(await getDb().streamLeases.get(streamId)).toMatchObject({
      messageId: kind === 'Continue' ? seeded.assistantMessage.id : 'reserved-send-target',
    })
    useStreamStore.getState().reset()
    __resetBroadcastForTests()
    const before = await authoritativeSnapshot()

    await expect(restoreWorkspaceBackup(exported, { now: 3485 })).rejects.toMatchObject({
      name: 'WorkspaceReplacementInProgressError',
      blockerIds: [streamId],
    })
    expect(await authoritativeSnapshot()).toEqual(before)

    await lifecycle.end('abort')
    await __flushStreamLeaseWritesForTests()
  })

  it('invalidates pre-replacement discovery and privacy fetches before they can repopulate caches', async () => {
    const seeded = await seedPortableChat()
    const exported = await exportWorkspaceBackup()
    let releaseModels!: (value: unknown) => void
    let releasePrivacy!: (value: unknown) => void
    const modelsGate = new Promise<unknown>((resolve) => {
      releaseModels = resolve
    })
    const privacyGate = new Promise<unknown>((resolve) => {
      releasePrivacy = resolve
    })
    const fetchModels = vi.fn(() => modelsGate)
    const fetchPrivacy = vi.fn(() => privacyGate)
    const models = dedupedModelsFetch(seeded.profile.id, {}, fetchModels)
    const privacy = dedupedPrivacyFetch(
      seeded.profile.id,
      'anthropic/claude-opus-4.7',
      fetchPrivacy,
    )
    await vi.waitFor(() => {
      expect(fetchModels).toHaveBeenCalledOnce()
      expect(fetchPrivacy).toHaveBeenCalledOnce()
    })

    await restoreWorkspaceBackup(exported, { now: 3490 })
    releaseModels({ stale: 'models' })
    releasePrivacy({ stale: 'privacy' })
    await Promise.all([models, privacy])

    expect(await getCachedModels(seeded.profile.id, {})).toBeUndefined()
    expect(
      await getCachedPrivacyPolicy(seeded.profile.id, 'anthropic/claude-opus-4.7'),
    ).toBeUndefined()
  })

  it('reopens to a deeply equivalent schema-v1 workspace including provider reasoning data', async () => {
    const seeded = await seedPortableChat()
    await getBrowserRepository().runMutation(
      [{ kind: 'message', messageId: seeded.assistantMessage.id }],
      async (ctx) => {
        const current = await ctx.getMessage(seeded.assistantMessage.id)
        if (!current) throw new Error('expected assistant')
        await ctx.putMessage({
          ...current,
          reasoningDetails: [
            {
              type: 'reasoning.text',
              id: 'reasoning-1',
              format: 'anthropic-claude-v1',
              text: 'kept reasoning',
              signature: 'signed',
            },
          ],
          providerOutputItems: [
            {
              dialect: 'anthropic-claude',
              type: 'thinking',
              item: { thinking: 'kept reasoning', signature: 'signed' },
            },
          ],
        })
      },
    )
    const exported = await exportWorkspaceBackup()
    const migrated = migrateNatterExportEnvelope(exported)
    if (migrated.objectKind !== 'workspace-backup') throw new Error('expected workspace backup')

    await restoreWorkspaceBackup(exported, { now: 3500 })
    __resetBrowserImportExportBackendForTests()
    __resetBrowserRepositoryForTests()
    __resetDbForTests()
    await openDb()
    const reopened = await exportWorkspaceBackup()

    expect(stableBackupPayload(reopened.payload)).toEqual(stableBackupPayload(migrated.payload))
    await expectAttachmentReferenceInvariants(getDb())
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
    const mixed = { ...exported, payload: { ...exported.payload, messages, settings } }

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
