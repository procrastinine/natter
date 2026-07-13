import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, Message } from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import {
  attachmentScopes,
  deleteReferencedAttachmentBytes,
  ingestAttachmentBytes,
} from '../../src/store/attachments'
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
  persistPreparedGeneratedOutputAttachments,
  prepareGeneratedOutputAttachments,
} from '../../src/store/generated-images'
import { expectAttachmentReferenceInvariants } from '../helpers/attachment-reference-invariants'

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

async function putMessage(message: Message): Promise<void> {
  await getBrowserRepository().runMutation(
    [
      { kind: 'message', messageId: message.id },
      { kind: 'children', chatId: message.chatId, parentId: message.parentId },
      ...[...new Set((message.attachmentRefs ?? []).map((ref) => ref.attachmentId))].map(
        (attachmentId) => ({ kind: 'attachment' as const, attachmentId }),
      ),
    ],
    async (ctx) => {
      await ctx.putMessage(message)
    },
  )
}

describe('generated image output storage migration', () => {
  it('prepares generated output without writes and commits its attachment with the message', async () => {
    const chat = await seedChat()
    const message: Message = {
      id: 'm-prepared',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: newId(),
      turnIndex: 0,
      createdAt: 2,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: '' }],
      nodeVersion: 0,
      deleted: false,
    }
    await putMessage(message)
    const prepared = await prepareGeneratedOutputAttachments({
      messageId: message.id,
      content: [{ type: 'output_image', url: ONE_PIXEL_PNG }],
      now: 10,
    })

    expect(prepared.attachmentBundles).toHaveLength(1)
    expect(await getDb().attachments.count()).toBe(0)

    const scopes = [
      { kind: 'message' as const, messageId: message.id },
      ...attachmentScopes(prepared.newRefs),
    ]
    await expect(
      getBrowserRepository().runMutation(scopes, async (ctx) => {
        await persistPreparedGeneratedOutputAttachments(ctx, prepared)
        const current = await ctx.getMessage(message.id)
        if (!current) throw new Error('MessageMissing')
        await ctx.putMessage({
          ...current,
          content: prepared.content,
          attachmentRefs: prepared.newRefs,
        })
        throw new Error('reject-canonical-finalize')
      }),
    ).rejects.toThrow('reject-canonical-finalize')
    expect(await getDb().attachments.count()).toBe(0)
    expect((await getBrowserRepository().getMessage(message.id))?.attachmentRefs).toHaveLength(0)

    await getBrowserRepository().runMutation(scopes, async (ctx) => {
      await persistPreparedGeneratedOutputAttachments(ctx, prepared)
      const current = await ctx.getMessage(message.id)
      if (!current) throw new Error('MessageMissing')
      await ctx.putMessage({
        ...current,
        content: prepared.content,
        attachmentRefs: prepared.newRefs,
      })
    })

    const attachmentId = prepared.newRefs[0]?.attachmentId
    expect(attachmentId).toBe('generated:m-prepared:1')
    expect((await getBrowserRepository().getAttachment(attachmentId ?? ''))?.refCount).toBe(1)
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('preserves a referenced generated attachment whose bytes were manually deleted', async () => {
    const chat = await seedChat()
    const message: Message = {
      id: 'm-manual-delete',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: newId(),
      turnIndex: 0,
      createdAt: 2,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: '' }],
      nodeVersion: 0,
      deleted: false,
    }
    await putMessage(message)
    const prepared = await prepareGeneratedOutputAttachments({
      messageId: message.id,
      content: [{ type: 'output_image', url: ONE_PIXEL_PNG }],
      now: 10,
    })
    const scopes = [
      { kind: 'message' as const, messageId: message.id },
      ...attachmentScopes(prepared.newRefs),
    ]
    await getBrowserRepository().runMutation(scopes, async (ctx) => {
      await persistPreparedGeneratedOutputAttachments(ctx, prepared)
      const current = await ctx.getMessage(message.id)
      if (!current) throw new Error('MessageMissing')
      await ctx.putMessage({
        ...current,
        content: prepared.content,
        attachmentRefs: prepared.newRefs,
      })
    })
    const attachmentId = prepared.newRefs[0]?.attachmentId
    if (!attachmentId) throw new Error('AttachmentMissing')
    await deleteReferencedAttachmentBytes(attachmentId, 'deleted', 20)

    const retry = await prepareGeneratedOutputAttachments({
      messageId: message.id,
      content: [{ type: 'output_image', url: ONE_PIXEL_PNG }],
      now: 30,
    })
    await getBrowserRepository().runMutation(scopes, async (ctx) => {
      await persistPreparedGeneratedOutputAttachments(ctx, retry)
    })

    const bundle = await getBrowserRepository().getAttachmentBundle(attachmentId)
    expect(bundle?.attachment.storage).toMatchObject({ kind: 'missing', reason: 'deleted' })
    expect(bundle?.blobs).toHaveLength(0)
    expect(bundle?.attachment.refCount).toBe(1)
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('replaces a conflicting unreferenced legacy generated-output row at commit', async () => {
    const eager = await materializeGeneratedOutputAttachments({
      messageId: 'm-orphan',
      content: [{ type: 'output_image', url: 'https://old.example/generated.png' }],
      now: 10,
    })
    const attachmentId = eager.newRefs[0]?.attachmentId
    expect(attachmentId).toBe('generated:m-orphan:1')
    expect((await getBrowserRepository().getAttachment(attachmentId ?? ''))?.refCount).toBe(0)

    const prepared = await prepareGeneratedOutputAttachments({
      messageId: 'm-orphan',
      content: [{ type: 'output_image', url: 'https://new.example/generated.png' }],
      now: 20,
    })
    await getBrowserRepository().runMutation(attachmentScopes(prepared.newRefs), async (ctx) => {
      await persistPreparedGeneratedOutputAttachments(ctx, prepared)
    })

    expect(await getBrowserRepository().getAttachment(attachmentId ?? '')).toMatchObject({
      sourceUrl: 'https://new.example/generated.png',
      storage: { kind: 'remote-url', url: 'https://new.example/generated.png' },
      refCount: 0,
    })
  })

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
    await putMessage(message)

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
    await expectAttachmentReferenceInvariants(getDb())
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
    await putMessage(message)

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
    await expectAttachmentReferenceInvariants(getDb())
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
    await putMessage(message)

    await normalizeGeneratedImageOutputAttachmentRefs(message.id)

    const stored = await getBrowserRepository().getMessage(message.id)
    expect(stored?.attachmentRefs).toHaveLength(1)
    expect(stored?.attachmentRefs?.[0]).toMatchObject({ attachmentId: kept.attachment.id })
    expect(await getBrowserRepository().getAttachment(stale.attachment.id)).toBeUndefined()
    await expectAttachmentReferenceInvariants(getDb())
  })
})
