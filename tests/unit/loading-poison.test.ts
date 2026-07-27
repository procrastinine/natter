import Dexie from 'dexie'
import { ownBrowserWorkspaceSuite } from '../helpers/browser-workspace-suite'
import { createChat } from '../helpers/chats'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AssistantPlanningResources } from '../../src/core/assistant-planning-resources'
import { createBranchPath } from '../../src/core/branch-session'
import { buildChildSlotProjection } from '../../src/core/child-list-state'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { resolveEffectiveEndpointRouting } from '../../src/core/effective-endpoint-routing'
import { fixedConversationSelectionTarget } from '../../src/core/messages'
import { EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS } from '../../src/core/reasoning'
import { EMPTY_TEXT_TEMPLATE, type SavedTextTemplate } from '../../src/core/text-templates'
import { GLOBAL_TOKEN_CALIBRATION_KEY } from '../../src/core/token-calibration'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentId,
  Chat,
  ChatId,
  ChatSettings,
  ConnectionProfile,
  Message,
  MessageId,
} from '../../src/core/types'
import {
  type AttachmentHeaderRow,
  splitAttachmentForStorage,
} from '../../src/store/attachment-storage'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import { openPreservingChatMutation } from '../../src/store/chat-row-transition'

import { __resetDbForTests, getDb } from '../../src/store/db'
import type { SettingsRow } from '../../src/store/db-rows'
import { createGenerationPromptMaterialLease } from '../../src/store/generation-prompt-material'
import {
  type MessageBodyRow,
  type MessageHeaderRow,
  splitMessageForStorage,
} from '../../src/store/message-storage'
import { joinKnownBranchPageMaterial } from '../../src/store/repository'
import { loadGenerationContextForBranch } from '../../src/store/send-context'
import type { WorkspaceQuery, WorkspaceQueryResult } from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import { runWorkspaceRead } from '../../src/store/workspace-runtime'
import { executeMessageCommand } from '../helpers/message-commands'

const DB_NAME = 'natter'
const workspaceSuite = ownBrowserWorkspaceSuite()
let fixtureSequence = 0

beforeAll(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
  await workspaceSuite.open()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cold message-body repository boundary', () => {
  it('reads generation attachment token evidence without hydrating artifacts or blobs', async () => {
    const attachmentId = nextId('attachment')
    const artifact: AttachmentArtifact = {
      kind: 'text',
      artifactId: nextId('artifact'),
      attachmentId,
      processorId: 'test',
      text: 'cold'.repeat(250_000),
      charCount: 1_000_000,
      createdAt: 1,
    }
    const attachment: Attachment = {
      id: attachmentId,
      kind: 'pdf',
      mime: 'application/pdf',
      filename: 'large.pdf',
      origin: 'system-fixture',
      createdAt: 1,
      updatedAt: 1,
      storage: { kind: 'remote-url', url: 'https://example.test/large.pdf' },
      pageCount: 200,
      artifacts: [artifact],
      processing: [],
      refCount: 1,
    }
    await getDb().transaction('rw', getDb().attachments, getDb().attachmentArtifacts, async () => {
      await getDb().attachments.put(splitAttachmentForStorage(attachment, 7))
      await getDb().attachmentArtifacts.put(artifact)
    })
    let artifactReads = 0
    let blobReads = 0
    const readArtifact = (row: AttachmentArtifact | undefined) => {
      if (row) artifactReads += 1
      return row
    }
    const readBlob = <T>(row: T | undefined): T | undefined => {
      if (row) blobReads += 1
      return row
    }
    getDb().attachmentArtifacts.hook('reading', readArtifact)
    getDb().attachmentBlobs.hook('reading', readBlob)

    const evidence = await query({
      kind: 'attachment.generation-token-evidence',
      attachmentId,
    })

    getDb().attachmentArtifacts.hook('reading').unsubscribe(readArtifact)
    getDb().attachmentBlobs.hook('reading').unsubscribe(readBlob)
    expect(evidence).toMatchObject({
      wireVersion: 7,
      attachment: { id: attachmentId, pageCount: 200, artifacts: [] },
    })
    expect(artifactReads).toBe(0)
    expect(blobReads).toBe(0)
  })

  it('keeps organized sidebar reads on projected chat metadata', async () => {
    const seeded = await seedLinearChat({ count: 12, bodyLength: 20_000 })
    const headers = captureReads<MessageHeaderRow>('messages')
    const bodies = captureReads<MessageBodyRow>('messageBodies')

    const rows = (
      await query({
        kind: 'sidebar.presentation-page',
        request: {
          mode: 'expanded',
          sort: 'updatedAt-desc',
          collapsedFolderIds: [],
          createdAtGroupBoundaries: [100, 90, 40, -190],
          limit: 100,
          countMode: 'exact',
        },
      })
    ).rows.flatMap((row) => (row.kind === 'chat' ? [row.chat] : []))

    expect(rows.some((row) => row.id === seeded.chat.id)).toBe(true)
    expect(headers.ids).toEqual([])
    expect(bodies.ids).toEqual([])
    headers.stop()
    bodies.stop()
  })

  it('keeps eager and selected configuration independent of cold chat, calibration, and template bodies', async () => {
    const templateId = nextId('cold-template')
    const previousCalibration = await getDb().settings.get(GLOBAL_TOKEN_CALIBRATION_KEY)
    await getDb().transaction('rw', getDb().settings, getDb().textTemplates, async () => {
      await getDb().settings.put({
        key: GLOBAL_TOKEN_CALIBRATION_KEY,
        value: {
          version: 1,
          byKey: Object.fromEntries(
            Array.from({ length: 1_000 }, (_, index) => [
              `model-${index}`,
              { prompt: [], completion: [] },
            ]),
          ),
          clearGeneration: 0,
        },
      })
      await getDb().textTemplates.put({
        id: templateId,
        name: 'Cold template',
        config: { ...EMPTY_TEXT_TEMPLATE, template: 'x'.repeat(2_000_000) },
        createdAt: 1,
        updatedAt: 1,
      })
    })
    const chats = captureReads<Chat>('chats')
    const headers = captureReads<MessageHeaderRow>('messages')
    const bodies = captureReads<MessageBodyRow>('messageBodies')
    const templates = captureReads<SavedTextTemplate>('textTemplates')
    const settings = captureSettingReads()

    await Promise.all([
      query({
        kind: 'configuration.active-selection',
        target: {
          kind: 'chat',
          profileId: null,
          presetId: null,
          promptPresets: [],
          textTemplateId: null,
        },
      }),
      query({ kind: 'configuration.shell' }),
    ])

    expect(chats.ids).toEqual([])
    expect(headers.ids).toEqual([])
    expect(bodies.ids).toEqual([])
    expect(templates.ids).toEqual([])
    expect(templates.textCharacters()).toBe(0)
    expect(settings.keys).not.toContain(GLOBAL_TOKEN_CALIBRATION_KEY)
    chats.stop()
    headers.stop()
    bodies.stop()
    templates.stop()
    settings.stop()
    await getDb().transaction('rw', getDb().settings, getDb().textTemplates, async () => {
      if (previousCalibration) await getDb().settings.put(previousCalibration)
      else await getDb().settings.delete(GLOBAL_TOKEN_CALIBRATION_KEY)
      await getDb().textTemplates.delete(templateId)
    })
  })

  it('opens a branch longer than 128 rows while hydrating only its destination row', async () => {
    const seeded = await seedLinearChat({ count: 257, bodyLength: 128 })
    const bodies = captureReads<MessageBodyRow>('messageBodies')

    const opened = await query({
      kind: 'branch.open',
      chatId: seeded.chat.id,
      target: fixedConversationSelectionTarget(
        { kind: 'tip', messageId: seeded.leafId },
        seeded.leafId,
      ),
      bodyDemand: 'none',
    })
    const destination = await query({
      kind: 'message.presentation',
      messageId: seeded.leafId,
    })

    expect(opened.kind).toBe('ready')
    if (opened.kind !== 'ready') throw new Error('ExpectedReadySelection')
    expect(opened.proof.pathHeaders).toHaveLength(257)
    expect(destination?.message.id).toBe(seeded.leafId)
    expect(bodies.ids).toEqual([seeded.leafId])
    bodies.stop()
  })

  it('does not hydrate a huge sibling when opening another tab-local tip', async () => {
    const prefix = linearMessages(nextId('branch-chat'), 20, 64)
    const branchRoot = prefix[0]
    const branchTail = prefix.at(-1)
    if (!branchRoot || !branchTail) throw new Error('ExpectedBranchPrefix')
    const branchParent = prefix[9] as Message
    const selectedSuffix = linearMessages(branchRoot.chatId, 8, 64, {
      startIndex: 20,
      parentId: branchTail.id,
      idPrefix: 'selected',
    })
    const hugeSibling = message(branchRoot.chatId, nextId('huge-sibling'), {
      parentId: branchParent.id,
      siblingIndex: 1,
      turnIndex: 99,
      createdAt: 99,
      content: [{ type: 'output_text', text: 'x'.repeat(2_000_000) }],
    })
    const rows = [...prefix, ...selectedSuffix, hugeSibling]
    const seeded = await seedChat(rows, selectedSuffix.at(-1)?.id ?? branchTail.id)
    const bodies = captureReads<MessageBodyRow>('messageBodies')

    const opened = await query({
      kind: 'branch.open',
      chatId: seeded.chat.id,
      target: fixedConversationSelectionTarget(
        { kind: 'tip', messageId: seeded.leafId },
        seeded.leafId,
      ),
      bodyDemand: 'none',
    })
    const destination = await query({
      kind: 'message.presentation',
      messageId: seeded.leafId,
    })

    expect(opened.kind).toBe('ready')
    expect(destination?.message.id).toBe(seeded.leafId)
    expect(bodies.ids).toEqual([seeded.leafId])
    expect(bodies.textCharacters()).toBe(64)
    expect(bodies.ids).not.toContain(hugeSibling.id)
    bodies.stop()
  })

  it('reports a missing destination body without blanking the exact header spine', async () => {
    const seeded = await seedLinearChat({ count: 40, bodyLength: 80 })
    await getDb().messageBodies.delete(seeded.leafId)

    const opened = await query({
      kind: 'branch.open',
      chatId: seeded.chat.id,
      target: fixedConversationSelectionTarget(
        { kind: 'tip', messageId: seeded.leafId },
        seeded.leafId,
      ),
      bodyDemand: 'none',
    })
    const destination = await query({
      kind: 'message.presentation',
      messageId: seeded.leafId,
    })

    expect(opened.kind).toBe('ready')
    if (opened.kind !== 'ready') throw new Error('ExpectedReadySelection')
    expect(opened.proof.pathHeaders).toHaveLength(40)
    expect(destination).toBeUndefined()
  })

  it('reads only branch-page structure before joining exactly the requested material', async () => {
    const seeded = await seedLinearChat({ count: 80, bodyLength: 256 })
    const headers = await branchHeaders(seeded.chat.id, seeded.leafId)
    const path = createBranchPath(headers)
    const window = path.window({ offset: 31, limit: 17 })
    const bodies = captureReads<MessageBodyRow>('messageBodies')

    const structural = await query({
      kind: 'branch.page-structure',
      chatId: seeded.chat.id,
      resolvedTipId: seeded.leafId,
      structuralVersion: seeded.chat.structuralVersion,
      window,
    })

    expect(structural.kind).toBe('ready')
    if (structural.kind !== 'ready') throw new Error('ExpectedReadyPageStructure')
    expect(structural.snapshot.pageHeaders.map((row) => row.id)).toEqual(
      seeded.rows.slice(31, 48).map((row) => row.id),
    )
    expect(structural.snapshot.pageHeaders.every((row) => !('content' in row))).toBe(true)
    expect(bodies.ids).toEqual([])

    const material = await query({
      kind: 'message.presentations',
      messageIds: structural.snapshot.pageHeaders.map((row) => row.id),
    })
    const page = joinKnownBranchPageMaterial(structural, material)

    expect(page.kind).toBe('ready')
    if (page.kind !== 'ready') throw new Error('ExpectedReadyPage')
    expect(page.snapshot.pageMessages.map((row) => row.id)).toEqual(
      seeded.rows.slice(31, 48).map((row) => row.id),
    )
    expect(bodies.ids).toEqual(seeded.rows.slice(31, 48).map((row) => row.id))
    bodies.stop()
  })

  it('keeps semantic transcript pages bounded at 24 and cumulative material reads linear', async () => {
    const seeded = await seedLinearChat({ count: 96, bodyLength: 32 })
    const path = createBranchPath(await branchHeaders(seeded.chat.id, seeded.leafId))
    const bodies = captureReads<MessageBodyRow>('messageBodies')

    await expect(
      query({
        kind: 'branch.page-structure',
        chatId: seeded.chat.id,
        resolvedTipId: seeded.leafId,
        structuralVersion: seeded.chat.structuralVersion,
        window: path.window({ offset: 0, limit: 25 }),
      }),
    ).rejects.toThrow('BranchPageBatchTooLarge')
    expect(bodies.ids).toEqual([])

    for (const page of [
      { offset: 88, limit: 8 },
      { offset: 72, limit: 16 },
      { offset: 48, limit: 24 },
      { offset: 24, limit: 24 },
      { offset: 0, limit: 24 },
    ]) {
      const window = path.window(page)
      const structural = await query({
        kind: 'branch.page-structure',
        chatId: seeded.chat.id,
        resolvedTipId: seeded.leafId,
        structuralVersion: seeded.chat.structuralVersion,
        window,
      })
      expect(structural.kind).toBe('ready')
      if (structural.kind !== 'ready') throw new Error('ExpectedReadyPageStructure')
      expect(structural.snapshot.pageHeaders.length).toBeLessThanOrEqual(24)
      const material = await query({
        kind: 'message.presentations',
        messageIds: structural.snapshot.pageHeaders.map((row) => row.id),
      })
      expect(joinKnownBranchPageMaterial(structural, material).kind).toBe('ready')
    }

    expect(bodies.ids).toHaveLength(96)
    expect(new Set(bodies.ids).size).toBe(96)
    expect(bodies.textCharacters()).toBe(96 * 32)
    bodies.stop()
  })

  it('starts no body read for a pre-aborted page request', async () => {
    const seeded = await seedLinearChat({ count: 30, bodyLength: 100 })
    const path = createBranchPath(await branchHeaders(seeded.chat.id, seeded.leafId))
    const bodies = captureReads<MessageBodyRow>('messageBodies')
    const controller = new AbortController()
    controller.abort()

    await expect(
      query(
        {
          kind: 'branch.page-structure',
          chatId: seeded.chat.id,
          resolvedTipId: seeded.leafId,
          structuralVersion: seeded.chat.structuralVersion,
          window: path.window({ offset: 10, limit: 10 }),
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(bodies.ids).toEqual([])
    bodies.stop()
  })

  it('classifies missing requested material without changing the structural page', async () => {
    const seeded = await seedLinearChat({ count: 12, bodyLength: 64 })
    const path = createBranchPath(await branchHeaders(seeded.chat.id, seeded.leafId))
    const structural = await query({
      kind: 'branch.page-structure',
      chatId: seeded.chat.id,
      resolvedTipId: seeded.leafId,
      structuralVersion: seeded.chat.structuralVersion,
      window: path.window({ offset: 5, limit: 1 }),
    })
    expect(structural.kind).toBe('ready')
    if (structural.kind !== 'ready') throw new Error('ExpectedReadyPageStructure')
    const targetId = structural.snapshot.pageHeaders[0]?.id
    if (!targetId) throw new Error('ExpectedPageTarget')
    await getDb().messageBodies.delete(targetId)

    const material = await query({ kind: 'message.presentations', messageIds: [targetId] })

    expect(joinKnownBranchPageMaterial(structural, material)).toMatchObject({
      kind: 'stale-path',
      reason: 'missing-body',
      messageId: targetId,
    })
    expect(structural.snapshot.pageHeaders.map((row) => row.id)).toEqual([targetId])
  })

  it('classifies full-header and body-version material drift as body-version mismatch', async () => {
    const seeded = await seedLinearChat({ count: 12, bodyLength: 64 })
    const path = createBranchPath(await branchHeaders(seeded.chat.id, seeded.leafId))
    const structural = await query({
      kind: 'branch.page-structure',
      chatId: seeded.chat.id,
      resolvedTipId: seeded.leafId,
      structuralVersion: seeded.chat.structuralVersion,
      window: path.window({ offset: 5, limit: 1 }),
    })
    expect(structural.kind).toBe('ready')
    if (structural.kind !== 'ready') throw new Error('ExpectedReadyPageStructure')
    const targetId = structural.snapshot.pageHeaders[0]?.id
    if (!targetId) throw new Error('ExpectedPageTarget')
    const presentation = (await query({ kind: 'message.presentations', messageIds: [targetId] }))[0]
    if (!presentation) throw new Error('ExpectedMessagePresentation')

    const changedHeader = {
      ...presentation,
      header: { ...presentation.header, nodeVersion: presentation.header.nodeVersion + 1 },
    }
    const changedBodyVersion = {
      ...presentation,
      bodyVersion: presentation.bodyVersion + 1,
    }

    for (const material of [[changedHeader], [changedBodyVersion]]) {
      expect(joinKnownBranchPageMaterial(structural, material)).toMatchObject({
        kind: 'stale-path',
        reason: 'body-version-mismatch',
        messageId: targetId,
      })
    }
  })

  it('serves tree previews from the preview projection even when bodies are cold', async () => {
    const seeded = await seedLinearChat({ count: 8, bodyLength: 2_000 })
    const target = seeded.stored[3] as StoredMessage
    await getDb().messageBodies.delete(target.header.id)
    const bodies = captureReads<MessageBodyRow>('messageBodies')

    const previews = await query({
      kind: 'message.preview-window',
      targets: [{ messageId: target.header.id, bodyVersion: target.header.bodyVersion }],
      maxChars: 80,
    })

    expect(previews[0]?.messageId).toBe(target.header.id)
    expect(previews[0]?.text.length).toBeLessThanOrEqual(80)
    expect(bodies.ids).toEqual([])
    bodies.stop()
  })

  it('hydrates only the requested message presentation', async () => {
    const seeded = await seedLinearChat({ count: 25, bodyLength: 50_000 })
    const target = seeded.rows[12] as Message
    const bodies = captureReads<MessageBodyRow>('messageBodies')

    const presentation = await query({ kind: 'message.presentation', messageId: target.id })

    expect(presentation?.message.id).toBe(target.id)
    expect(bodies.ids).toEqual([target.id])
    expect(bodies.textCharacters()).toBe(50_000)
    bodies.stop()
  })

  it('enumerates topology without hydrating any message body', async () => {
    const seeded = await seedLinearChat({ count: 180, bodyLength: 10_000 })
    const bodies = captureReads<MessageBodyRow>('messageBodies')

    const topology = await query({ kind: 'message.headers-by-chat', chatId: seeded.chat.id })

    expect(topology.kind).toBe('ready')
    if (topology.kind !== 'ready') throw new Error('ExpectedReadyTopology')
    expect(topology.headers).toHaveLength(180)
    expect(bodies.ids).toEqual([])
    bodies.stop()
  })

  it('edits one row without hydrating its branch or huge sibling', async () => {
    const seeded = await seedLinearChat({ count: 22, bodyLength: 300_000 })
    const target = seeded.rows[8] as Message
    const bodies = captureReads<MessageBodyRow>('messageBodies')

    const result = await executeMessageCommand({
      kind: 'message.edit-content',
      input: {
        chatId: seeded.chat.id,
        messageId: target.id,
        content: [{ type: 'text', text: 'edited target' }],
        now: 10_000,
      },
    })

    expect(result.message.content).toEqual([{ type: 'text', text: 'edited target' }])
    expect(bodies.ids).toEqual([target.id])
    expect(bodies.ids).not.toContain(seeded.leafId)
    bodies.stop()
  })

  it('inserts a sibling from topology without reading existing payloads', async () => {
    const seeded = await seedLinearChat({ count: 18, bodyLength: 400_000 })
    const target = seeded.rows[7] as Message
    const bodies = captureReads<MessageBodyRow>('messageBodies')

    const inserted = await executeMessageCommand({
      kind: 'message.insert-sibling',
      input: {
        chatId: seeded.chat.id,
        targetId: target.id,
        content: [{ type: 'output_text', text: 'new sibling' }],
        role: target.role,
        origin: 'imported',
        now: 20_000,
      },
    })

    expect(inserted.message.parentId).toBe(target.parentId)
    expect(bodies.ids).toEqual([])
    bodies.stop()
  })

  it('cascades structural deletion without hydrating or mutating payloads', async () => {
    const seeded = await seedLinearChat({ count: 30, bodyLength: 250_000 })
    const target = seeded.rows[10] as Message
    const bodies = captureReads<MessageBodyRow>('messageBodies')
    const before = await getDb().messageBodies.bulkGet(seeded.rows.map((row) => row.id))
    bodies.ids.length = 0

    const deleted = await executeMessageCommand({
      kind: 'message.delete',
      mode: 'single',
      input: {
        chatId: seeded.chat.id,
        messageId: target.id,
        activeLeafId: seeded.leafId,
        cascade: true,
        now: 30_000,
      },
    })

    expect(deleted.effects.tombstoned).toContain(target.id)
    expect(deleted.destination.proof.tipId).not.toBeNull()
    expect(deleted.destination.presentations).toEqual([])
    expect(bodies.ids).toEqual([])
    const after = await getDb().messageBodies.bulkGet(seeded.rows.map((row) => row.id))
    expect(after).toEqual(before)
    bodies.stop()
  })

  it('plans bounded send context from the tail without hydrating the cold prefix', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-4o'
    settings.customMaxContext = 1
    settings.maxCompletionTokens = 0
    settings.contextStrategy = { ...settings.contextStrategy, keepFirstPairs: 0 }
    const seeded = await seedLinearChat({ count: 24, bodyLength: 180, settings })
    const snapshot = await query({
      kind: 'branch.open',
      chatId: seeded.chat.id,
      target: fixedConversationSelectionTarget(
        { kind: 'tip', messageId: seeded.leafId },
        seeded.leafId,
      ),
      bodyDemand: 'none',
    })
    if (snapshot.kind !== 'ready') throw new Error('ExpectedReadySelection')
    const pending = message(seeded.chat.id, nextId('pending'), {
      parentId: seeded.leafId,
      createdAt: 100_000,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'mandatory '.repeat(200) }],
    })
    const bodies = captureReads<MessageBodyRow>('messageBodies')

    const context = await runWorkspaceRead('repository-query', (authority) => {
      const promptMaterial = createGenerationPromptMaterialLease(
        authority,
        snapshot.chat.id,
        snapshot.proof.pathHeaders,
      )
      return loadGenerationContextForBranch({
        chat: snapshot.chat,
        branchHeaders: snapshot.proof.pathHeaders,
        settings: snapshot.chat.settings,
        pendingMessages: [pending],
        routing: loadingPoisonRoute(snapshot.chat.settings),
        promptMaterial,
        authority,
        signal: authority.signal,
      }).finally(() => promptMaterial.release())
    })

    expect(context.usedFullBranch).toBe(false)
    expect(context.pathMessages.at(-1)?.id).toBe(pending.id)
    expect(context.loadedBodyIds.length).toBeLessThanOrEqual(16)
    expect(bodies.ids).not.toContain(seeded.rows[0]?.id)
    expect(bodies.ids).not.toContain(seeded.rows[1]?.id)
    bodies.stop()
  })

  it('reads attachment evidence only for evaluated tail buckets and keeps artifact bodies cold', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-4o'
    settings.customMaxContext = 500
    settings.maxCompletionTokens = 0
    settings.contextStrategy = { ...settings.contextStrategy, keepFirstPairs: 0 }
    const chatId = nextId('chat')
    const rows = linearMessages(chatId, 24, 180)
    const cold = largeImageAttachment(nextId('cold-attachment'))
    const tail = largeImageAttachment(nextId('tail-attachment'))
    rows[0] = withAttachment(rows[0] as Message, cold.attachment.id)
    rows[22] = withAttachment(rows[22] as Message, tail.attachment.id)
    const seeded = await seedChat(rows, undefined, settings)
    const headers = await branchHeaders(seeded.chat.id, seeded.leafId)
    const db = getDb()
    await db.transaction(
      'rw',
      db.attachments,
      db.attachmentArtifacts,
      db.attachmentBlobs,
      async () => {
        await db.attachments.bulkPut([
          splitAttachmentForStorage(cold.attachment, 7),
          splitAttachmentForStorage(tail.attachment, 8),
        ])
        await db.attachmentArtifacts.bulkPut([cold.artifact, tail.artifact])
        await db.attachmentBlobs.bulkPut([cold.blob, tail.blob])
      },
    )

    const attachmentReads: AttachmentId[] = []
    let artifactReads = 0
    let blobReads = 0
    const readAttachment = (row: AttachmentHeaderRow | undefined) => {
      if (row) attachmentReads.push(row.id)
      return row
    }
    const readArtifact = (row: AttachmentArtifact | undefined) => {
      if (row) artifactReads += 1
      return row
    }
    const readBlob = (row: AttachmentBlob | undefined) => {
      if (row) blobReads += 1
      return row
    }
    db.attachments.hook('reading', readAttachment)
    db.attachmentArtifacts.hook('reading', readArtifact)
    db.attachmentBlobs.hook('reading', readBlob)
    const bodies = captureReads<MessageBodyRow>('messageBodies')
    const evidenceReads: AttachmentId[] = []
    const bundleReads: AttachmentId[] = []
    let context: Awaited<ReturnType<typeof loadGenerationContextForBranch>>
    try {
      context = await runWorkspaceRead('repository-query', (authority) => {
        const promptMaterial = createGenerationPromptMaterialLease(
          authority,
          seeded.chat.id,
          headers,
        )
        const resources: AssistantPlanningResources = {
          globalCalibration: () => ({ version: 1, updatedAt: 0, byModel: {} }),
          calibrationMode: () => 'adaptive',
          proxy: () => ({ url: '', secret: '' }),
          readModels: async () => undefined,
          resolveEndpoints: async () => null,
          resolvePrivacy: async () => ({ policies: {}, offlineFallback: false }),
          getAttachment: async (attachmentId) => {
            evidenceReads.push(attachmentId)
            return getWorkspaceRepository()
              .query(
                authority,
                { kind: 'attachment.generation-token-evidence', attachmentId },
                { signal: authority.signal },
              )
              .then((envelope) => envelope.value?.attachment)
          },
          getAttachmentBundle: async (attachmentId) => {
            bundleReads.push(attachmentId)
            throw new Error(`UnexpectedAttachmentBundleRead:${attachmentId}`)
          },
          resolveTextTemplate: async () => null,
        }
        return loadGenerationContextForBranch({
          chat: seeded.chat,
          branchHeaders: headers,
          settings,
          pendingMessages: [],
          routing: loadingPoisonRoute(settings),
          knownMessages: [rows[22] as Message, rows[23] as Message],
          promptMaterial,
          authority,
          signal: authority.signal,
          planningResources: resources,
        }).finally(() => promptMaterial.release())
      })
    } finally {
      db.attachments.hook('reading').unsubscribe(readAttachment)
      db.attachmentArtifacts.hook('reading').unsubscribe(readArtifact)
      db.attachmentBlobs.hook('reading').unsubscribe(readBlob)
      bodies.stop()
    }

    expect(context.usedFullBranch).toBe(false)
    expect(context.pathMessages.map((message) => message.id)).toContain(rows[22].id)
    expect(context.pathMessages.map((message) => message.id)).not.toContain(rows[0].id)
    expect(context.preCutAttachmentIds).toEqual([tail.attachment.id])
    expect(context.attachmentTokenEvidence.map((attachment) => attachment.id)).toEqual([
      tail.attachment.id,
    ])
    expect(evidenceReads).toEqual([tail.attachment.id])
    expect(bundleReads).toEqual([])
    expect(attachmentReads).toEqual([tail.attachment.id])
    expect(artifactReads).toBe(0)
    expect(blobReads).toBe(0)
    const penultimate = rows.at(22)
    const final = rows.at(23)
    if (!penultimate || !final) throw new Error('Expected terminal loading-poison rows')
    expect(bodies.ids).not.toContain(penultimate.id)
    expect(bodies.ids).not.toContain(final.id)
    expect(context.loadedBodyIds).not.toContain(penultimate.id)
    expect(context.loadedBodyIds).not.toContain(final.id)
  })
})

interface StoredMessage {
  readonly header: MessageHeaderRow
  readonly body: MessageBodyRow
  readonly preview: ReturnType<typeof splitMessageForStorage>['preview']
}

const LOADING_POISON_PROFILE: ConnectionProfile = {
  id: 'loading-poison-profile',
  name: 'Loading poison fixture',
  kind: 'custom',
  baseUrl: 'https://example.test/v1',
  defaultHeaders: {},
  appTitle: '',
  appUrl: '',
  supportsEndpointsApi: false,
  supportsGenerationApi: false,
  supportsPrivacyScrape: false,
  createdAt: 0,
  updatedAt: 0,
}

function loadingPoisonRoute(settings: ChatSettings) {
  return resolveEffectiveEndpointRouting({
    profile: LOADING_POISON_PROFILE,
    settings,
    contextFacts: EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
  }).route
}

interface SeededChat {
  readonly chat: Chat
  readonly rows: readonly Message[]
  readonly stored: readonly StoredMessage[]
  readonly leafId: MessageId
}

async function seedLinearChat(input: {
  readonly count: number
  readonly bodyLength: number
  readonly settings?: Chat['settings']
}): Promise<SeededChat> {
  const chatId = nextId('chat')
  return seedChat(linearMessages(chatId, input.count, input.bodyLength), undefined, input.settings)
}

async function seedChat(
  rows: readonly Message[],
  leafId = rows.at(-1)?.id,
  settings?: Chat['settings'],
): Promise<SeededChat> {
  const chatId = rows[0]?.chatId ?? nextId('empty-chat')
  if (!leafId) throw new Error('SeedLeafMissing')
  const chat = await createChat({
    id: chatId,
    title: chatId,
    now: fixtureSequence + 1,
    ...(settings === undefined ? {} : { settings }),
  })
  const stored = rows.map((row) => splitMessageForStorage(row, { bodyVersion: 1 }))
  const childProjection = buildChildSlotProjection(
    chatId,
    stored.map((row) => row.header),
    { updatedAt: fixtureSequence + 1 },
  )
  const firstUser = rows.find((row) => row.role === 'user' && !row.deleted)
  const nextChat: Chat = {
    ...chat,
    lastUpdatedLeafId: leafId,
    lastBranchUpdatedAt: fixtureSequence + 1,
    previewText: firstUser ? textOf(firstUser).slice(0, 240) : '',
  }
  const db = getDb()
  await db.transaction(
    'rw',
    [
      db.chats,
      db.chatSidebarRows,
      db.chatSidebarAggregates,
      db.settings,
      db.messages,
      db.messageBodies,
      db.messagePreviews,
      db.childLists,
      db.childSlotMembers,
    ],
    async (tx) => {
      const chatMutation = openPreservingChatMutation(tx)
      const currentChat = await chatMutation.read(chat.id)
      if (!currentChat) throw new Error(`MissingCurrentChat:${chat.id}`)
      chatMutation.replace(chat.id, () => nextChat)
      await chatMutation.commit()
      await db.messages.bulkPut(stored.map((row) => row.header))
      await db.messageBodies.bulkPut(stored.map((row) => row.body))
      await db.messagePreviews.bulkPut(stored.map((row) => row.preview))
      await db.childLists.bulkPut(childProjection.states)
      await db.childSlotMembers.bulkPut(childProjection.members)
    },
  )
  return { chat: nextChat, rows, stored, leafId }
}

function linearMessages(
  chatId: ChatId,
  count: number,
  bodyLength: number,
  options: {
    readonly startIndex?: number
    readonly parentId?: MessageId | null
    readonly idPrefix?: string
  } = {},
): Message[] {
  const rows: Message[] = []
  let parentId = options.parentId ?? null
  const startIndex = options.startIndex ?? 0
  for (let offset = 0; offset < count; offset += 1) {
    const index = startIndex + offset
    const role = index % 2 === 0 ? 'user' : 'assistant'
    const id = nextId(options.idPrefix ?? 'message')
    const row = message(chatId, id, {
      parentId,
      turnId: `turn-${chatId}-${Math.floor(index / 2)}`,
      turnIndex: index % 2,
      createdAt: index + 1,
      role,
      origin: role === 'assistant' ? 'generated' : 'user',
      content: [
        {
          type: role === 'assistant' ? 'output_text' : 'text',
          text: (role === 'assistant' ? 'a' : 'u').repeat(bodyLength),
        },
      ],
    })
    rows.push(row)
    parentId = row.id
  }
  return rows
}

function message(chatId: ChatId, id: MessageId, overrides: Partial<Message> = {}): Message {
  return {
    id,
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: id,
    turnIndex: 0,
    createdAt: 1,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: `body:${id}` }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}

function withAttachment(row: Message, attachmentId: AttachmentId): Message {
  return {
    ...row,
    attachmentRefs: [
      {
        refId: nextId('attachment-ref'),
        attachmentId,
        includeInContext: true,
        presentation: {},
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }
}

function largeImageAttachment(attachmentId: AttachmentId): {
  attachment: Attachment
  artifact: AttachmentArtifact
  blob: AttachmentBlob
} {
  const blobId = nextId('attachment-blob')
  const artifact: AttachmentArtifact = {
    kind: 'text',
    artifactId: nextId('attachment-artifact'),
    attachmentId,
    processorId: 'poison-test',
    text: 'artifact'.repeat(125_000),
    charCount: 1_000_000,
    createdAt: 1,
  }
  return {
    attachment: {
      id: attachmentId,
      contentHash: `hash:${attachmentId}`,
      kind: 'image',
      mime: 'image/png',
      filename: `${attachmentId}.png`,
      sizeBytes: 1_000_000,
      origin: 'system-fixture',
      createdAt: 1,
      updatedAt: 1,
      storage: { kind: 'local-blob', blobId },
      dimensions: { width: 64, height: 64 },
      artifacts: [artifact],
      processing: [],
      refCount: 1,
    },
    artifact,
    blob: {
      id: blobId,
      attachmentId,
      role: 'original',
      mime: 'image/png',
      contentHash: `hash:${attachmentId}`,
      sizeBytes: 1_000_000,
      blob: new Blob(['x'.repeat(1_000_000)], { type: 'image/png' }),
      createdAt: 1,
    },
  }
}

async function branchHeaders(chatId: ChatId, leafId: MessageId): Promise<MessageHeaderRow[]> {
  const topology = await query({ kind: 'message.headers-by-chat', chatId })
  if (topology.kind !== 'ready') throw new Error('ExpectedReadyTopology')
  const path = createBranchPath(topology.headers)
  if (path.leaf?.id !== leafId) throw new Error('ExpectedTopologyTip')
  return [...topology.headers]
}

async function query<Q extends WorkspaceQuery>(
  request: Q,
  signal?: AbortSignal,
): Promise<WorkspaceQueryResult<Q>> {
  return runWorkspaceRead(
    'repository-query',
    (permit) =>
      getWorkspaceRepository()
        .query(permit, request, { signal: signal ?? permit.signal })
        .then((envelope) => envelope.value),
    signal ? { signal } : {},
  )
}

function captureReads<Row extends { id: string }>(
  table: 'chats' | 'messages' | 'messageBodies' | 'textTemplates',
): {
  readonly ids: string[]
  readonly textCharacters: () => number
  readonly stop: () => void
} {
  const ids: string[] = []
  let textCharacters = 0
  const reading = (row: Row | undefined): Row | undefined => {
    if (!row) return row
    ids.push(row.id)
    if ('content' in row && Array.isArray(row.content)) {
      for (const item of row.content as unknown[]) {
        if (
          item &&
          typeof item === 'object' &&
          'type' in item &&
          (item.type === 'text' || item.type === 'output_text') &&
          'text' in item &&
          typeof item.text === 'string'
        ) {
          textCharacters += item.text.length
        }
      }
    }
    if (
      'config' in row &&
      row.config &&
      typeof row.config === 'object' &&
      'template' in row.config &&
      typeof row.config.template === 'string'
    ) {
      textCharacters += row.config.template.length
    }
    return row
  }
  const db = getDb()
  const selected =
    table === 'chats'
      ? db.chats
      : table === 'messages'
        ? db.messages
        : table === 'messageBodies'
          ? db.messageBodies
          : db.textTemplates
  selected.hook('reading', reading as never)
  return {
    ids,
    textCharacters: () => textCharacters,
    stop: () => selected.hook('reading').unsubscribe(reading as never),
  }
}

function captureSettingReads(): { readonly keys: string[]; readonly stop: () => void } {
  const keys: string[] = []
  const reading = (row: SettingsRow | undefined): SettingsRow | undefined => {
    if (row) keys.push(row.key)
    return row
  }
  const table = getDb().settings
  table.hook('reading', reading)
  return {
    keys,
    stop: () => table.hook('reading').unsubscribe(reading),
  }
}

function textOf(row: Message): string {
  return row.content
    .flatMap((item) => (item.type === 'text' || item.type === 'output_text' ? [item.text] : []))
    .join(' ')
}

function nextId(prefix: string): string {
  fixtureSequence += 1
  return `${prefix}-${fixtureSequence}`
}
