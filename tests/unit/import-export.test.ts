import { Blob as NodeBlob } from 'node:buffer'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildBranchCacheRow } from '../../src/core/branch-flatten'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
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
import { newId } from '../../src/lib/ulid'
import { getAttachmentBundle, ingestAttachmentBytes } from '../../src/store/attachments'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserImportExportBackendForTests } from '../../src/store/browser-import-export'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import { __resetDbForTests, childListKey, getDb, openDb } from '../../src/store/db'
import {
  __resetImportExportBackendForTests,
  exportChat,
  exportChatPreset,
  exportWorkspaceBackup,
  importChat,
  importChatPreset,
  restoreWorkspaceBackup,
} from '../../src/store/import-export'
import { __resetKeyCacheForTests, createKey } from '../../src/store/keys'
import { hydrateMessages } from '../../src/store/message-storage'
import { createPreset, listPresets } from '../../src/store/presets'
import { createProfile } from '../../src/store/profiles'
import { createPromptPreset } from '../../src/store/prompt-presets'
import { putTestMessages } from '../helpers/message-storage'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBrowserImportExportBackendForTests()
  __resetBrowserRepositoryForTests()
  __resetImportExportBackendForTests()
  __resetBroadcastForTests()
  __resetKeyCacheForTests()
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
  await db.attachments.put({ ...bundle.attachment, refCount: 1 })
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
  await db.chats.put(chat)
  await putTestMessages([userMessage, assistantMessage])
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
})

describe('workspace backup restore', () => {
  it('destructively replaces persisted workspace rows and clears rebuildable caches', async () => {
    const seeded = await seedPortableChat()
    await getDb().settings.put({ key: 'custom-setting', value: { ok: true } })
    const exported = await exportWorkspaceBackup()

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

    const result = await restoreWorkspaceBackup(exported, { now: 2000 })

    expect(result.chatCount).toBe(1)
    expect(await getDb().chats.get(seeded.chat.id)).toBeTruthy()
    expect(await getDb().chats.get(extraChat.id)).toBeUndefined()
    expect(await getDb().profiles.get(seeded.profile.id)).toBeTruthy()
    expect(await getDb().profiles.get(extraProfile.id)).toBeUndefined()
    expect((await getDb().settings.get('custom-setting'))?.value).toEqual({ ok: true })
    expect(await getDb().settings.get('extra-setting')).toBeUndefined()
    expect(await getDb().models.count()).toBe(0)
    expect(await getDb().streamLeases.count()).toBe(0)

    const restoredMessages = await messagesForChat(seeded.chat.id)
    expect(restoredMessages.map((row) => row.id).sort()).toEqual(
      [seeded.userMessage.id, seeded.assistantMessage.id].sort(),
    )
    const restoredBundle = await getAttachmentBundle(seeded.sourceAttachmentId)
    expect(restoredBundle?.blobs).toHaveLength(1)
    expect(await blobText(restoredBundle?.blobs[0]?.blob as Blob)).toBe('shared attachment bytes')
  })
})
