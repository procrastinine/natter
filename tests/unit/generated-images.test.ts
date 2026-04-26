import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, Message } from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import {
  materializeGeneratedOutputAttachments,
  migrateGeneratedImageOutputAttachments,
  normalizeGeneratedImageOutputAttachmentRefs,
} from '../../src/store/generated-images'
import { ingestAttachmentBytes } from '../../src/store/attachments'

const DB_NAME = 'natter'
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

async function resetAll() {
  __resetDbForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

async function seedChat(): Promise<Chat> {
  const chat: Chat = {
    id: newId(),
    title: 'Test',
    titleStatus: 'untitled',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
  await getDb().chats.put(chat)
  return chat
}

describe('generated image output storage migration', () => {
  it('materializes raw generated audio data URLs into attachments', async () => {
    const materialized = await materializeGeneratedOutputAttachments({
      messageId: 'm-audio',
      content: [
        {
          type: 'audio_output',
          url: 'data:audio/wav;base64,UklGRg==',
          transcript: 'Hi',
          format: 'wav',
        },
      ],
      now: 10,
    })
    const output = materialized.content[0]
    expect(output).toMatchObject({ type: 'audio_output', transcript: 'Hi', format: 'wav' })
    expect(output?.type === 'audio_output' ? output.url : undefined).toBeUndefined()
    const attachmentId = output?.type === 'audio_output' ? output.attachmentId : undefined
    expect(attachmentId).toBeTruthy()
    expect(materialized.newRefs).toHaveLength(1)
    const bundle = attachmentId
      ? await getBrowserRepository().getAttachmentBundle(attachmentId)
      : undefined
    expect(bundle?.attachment).toMatchObject({
      kind: 'audio',
      mime: 'audio/wav',
      origin: 'generated-output',
    })
  })

  it('moves legacy raw output_image data URLs into stored generated attachments', async () => {
    const chat = await seedChat()
    const message: Message = {
      id: newId(),
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: newId(),
      turnIndex: 0,
      createdAt: 2,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_image', url: ONE_PIXEL_PNG, prompt: 'red square' }],
      nodeVersion: 0,
      deleted: false,
    }
    await getDb().messages.put(message)

    await migrateGeneratedImageOutputAttachments(message.id)

    const stored = await getBrowserRepository().getMessage(message.id)
    const output = stored?.content.find((item) => item.type === 'output_image')
    expect(output).toMatchObject({ type: 'output_image', prompt: 'red square' })
    expect(output && 'url' in output ? output.url : undefined).toBeUndefined()
    const attachmentId = output?.type === 'output_image' ? output.attachmentId : undefined
    expect(attachmentId).toBeTruthy()
    expect(stored?.attachmentRefs).toHaveLength(1)
    expect(stored?.attachmentRefs?.[0]).toMatchObject({
      attachmentId,
      includeInContext: true,
    })

    const bundle = attachmentId
      ? await getBrowserRepository().getAttachmentBundle(attachmentId)
      : undefined
    expect(bundle?.attachment).toMatchObject({
      kind: 'image',
      mime: 'image/png',
      origin: 'generated-output',
      refCount: 1,
    })
    expect(bundle?.blobs.some((blob) => blob.role === 'original')).toBe(true)
  })

  it('is idempotent when a legacy row is migrated twice at the same time', async () => {
    const chat = await seedChat()
    const message: Message = {
      id: newId(),
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: newId(),
      turnIndex: 0,
      createdAt: 2,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_image', url: ONE_PIXEL_PNG }],
      nodeVersion: 0,
      deleted: false,
    }
    await getDb().messages.put(message)

    await Promise.all([
      migrateGeneratedImageOutputAttachments(message.id),
      migrateGeneratedImageOutputAttachments(message.id),
    ])

    const stored = await getBrowserRepository().getMessage(message.id)
    expect(stored?.attachmentRefs).toHaveLength(1)
    const output = stored?.content.find((item) => item.type === 'output_image')
    const attachmentId = output?.type === 'output_image' ? output.attachmentId : undefined
    expect(stored?.attachmentRefs?.[0]).toMatchObject({ attachmentId })
    const generated = await getDb()
      .attachments.filter((attachment) => attachment.origin === 'generated-output')
      .toArray()
    expect(generated).toHaveLength(1)
    expect(generated[0]?.id).toBe(attachmentId)
    expect(generated[0]?.refCount).toBe(1)
  })

  it('removes stale generated-output refs that are not the inline output image', async () => {
    const chat = await seedChat()
    const kept = await ingestAttachmentBytes({
      id: 'att-kept',
      blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
      filename: 'kept.png',
      declaredMime: 'image/png',
      origin: 'generated-output',
    })
    const stale = await ingestAttachmentBytes({
      id: 'att-stale',
      blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x48])], { type: 'image/png' }),
      filename: 'stale.png',
      declaredMime: 'image/png',
      origin: 'generated-output',
    })
    await getDb().attachments.update(kept.attachment.id, { refCount: 1 })
    await getDb().attachments.update(stale.attachment.id, { refCount: 1 })
    const message: Message = {
      id: newId(),
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: newId(),
      turnIndex: 0,
      createdAt: 2,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_image', attachmentId: kept.attachment.id }],
      attachmentRefs: [
        {
          refId: 'ref-kept',
          attachmentId: kept.attachment.id,
          includeInContext: true,
          presentation: {},
          createdAt: 2,
          updatedAt: 2,
        },
        {
          refId: 'ref-stale',
          attachmentId: stale.attachment.id,
          includeInContext: true,
          presentation: {},
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      nodeVersion: 0,
      deleted: false,
    }
    await getDb().messages.put(message)

    await normalizeGeneratedImageOutputAttachmentRefs(message.id)

    const stored = await getBrowserRepository().getMessage(message.id)
    expect(stored?.attachmentRefs).toHaveLength(1)
    expect(stored?.attachmentRefs?.[0]).toMatchObject({ attachmentId: kept.attachment.id })
    expect(await getBrowserRepository().getAttachment(stale.attachment.id)).toBeUndefined()
  })
})
