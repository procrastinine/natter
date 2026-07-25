import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateWaveAMessageAndAttachmentRowsV94 } from '../../src/backcompat/wave-a-message-storage-v94'
import { WAVE_A_V94_STORES } from '../../src/backcompat/wave-a-storage-epoch-v94'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { withGeneratedOutputLocalizationState } from '../../src/core/generated-output-localization'
import type {
  Attachment,
  AttachmentJob,
  Chat,
  ConnectionProfile,
  Message,
  MessageAttachmentRef,
} from '../../src/core/types'
import { splitAttachmentForStorage } from '../../src/store/attachment-storage'
import { prepareGeneratedOutputRemoteBundle } from '../../src/store/generated-images'
import {
  type MessageBodyRow,
  type MessageHeaderRow,
  splitMessageForStorage,
} from '../../src/store/message-storage'

const databaseNames: string[] = []

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)))
})

describe('Wave A v94 message storage migration', () => {
  it('builds current previews and header projections from a v25-shaped pair', async () => {
    const name = `wave-a-v94-message-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = legacyMessageDatabase(name)
    await legacy.open()
    await legacy.table('chats').put(chat())
    const split = splitMessageForStorage(message())
    await legacy.table('messages').put(v25Header(split.header))
    await legacy.table('messageBodies').put(split.body)
    legacy.close()

    let obsoleteBytes = 0
    const db = legacyMessageDatabase(name)
    db.version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAMessageAndAttachmentRowsV94(tx, {
          observedAt: 10,
          recordObsoleteBytes: (bytes) => {
            obsoleteBytes += bytes
          },
        }),
      )
    await db.open()

    expect(await db.table('messages').get('message-1')).toMatchObject({
      id: 'message-1',
      treeParentKey: '__root__',
      treeLive: 1,
      bodyWordCount: 2,
      bodyTextCharCount: 11,
      bodyMediaCount: 0,
    })
    expect(await db.table('messagePreviews').get('message-1')).toEqual({
      id: 'message-1',
      chatId: 'chat-1',
      bodyVersion: 0,
      text: 'hello world',
    })
    expect(await db.table('messageBodies').get('message-1')).toEqual(split.body)
    expect(await db.table('attachmentRefEdges').count()).toBe(0)
    expect(await db.table('attachmentCatalogAggregate').get('workspace')).toMatchObject({
      totalCount: 0,
      referencedCount: 0,
      unreferencedCount: 0,
    })
    expect(await db.table('attachmentIntegrityState').get('workspace')).toMatchObject({
      phase: 'complete',
    })
    expect(obsoleteBytes).toBeGreaterThan(0)
    db.close()
  })

  it('deletes an orphan body but rejects a header whose body is missing', async () => {
    const orphanName = `wave-a-v94-message-${crypto.randomUUID()}`
    databaseNames.push(orphanName)
    const orphanLegacy = legacyMessageDatabase(orphanName)
    await orphanLegacy.open()
    await orphanLegacy.table('messageBodies').put({
      id: 'orphan',
      chatId: 'chat-1',
      bodyVersion: 0,
      updatedAt: 1,
      content: [],
    })
    orphanLegacy.close()
    const orphanDb = legacyMessageDatabase(orphanName)
    orphanDb
      .version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAMessageAndAttachmentRowsV94(tx, {
          observedAt: 10,
          recordObsoleteBytes: () => undefined,
        }),
      )
    await orphanDb.open()
    expect(await orphanDb.table('messageBodies').count()).toBe(0)
    orphanDb.close()

    const missingName = `wave-a-v94-message-${crypto.randomUUID()}`
    databaseNames.push(missingName)
    const missingLegacy = legacyMessageDatabase(missingName)
    await missingLegacy.open()
    const split = splitMessageForStorage(message())
    await missingLegacy.table('messages').put(v25Header(split.header))
    missingLegacy.close()
    const missingDb = legacyMessageDatabase(missingName)
    missingDb
      .version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAMessageAndAttachmentRowsV94(tx, {
          observedAt: 10,
          recordObsoleteBytes: () => undefined,
        }),
      )
    await expect(missingDb.open()).rejects.toThrow('WaveAMessageBodyMissing:message-1')
    missingDb.close()
  })

  it('normalizes generated output, provider output, and coexisting reasoning once', async () => {
    const name = `wave-a-v94-message-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = legacyMessageDatabase(name)
    await legacy.open()
    await legacy.table('chats').put(chat())
    const split = splitMessageForStorage(message({ role: 'assistant', origin: 'generated' }))
    const header = v25Header(split.header)
    header.generation = {
      id: 'generation-1',
      model: 'model',
      requestedModel: 'model',
      apiUsed: 'responses',
      delivery: 'streaming',
      costSource: 'stream',
      reasoningCarryForward: 'unknown',
      reasoningVisibility: { disclosure: 'unknown' },
      startedAt: 1,
      serverTools: [
        {
          type: 'web_search_call',
          source: 'responses-output',
          outputIndex: 0,
        },
      ],
    }
    const body = {
      ...split.body,
      content: [
        { type: 'output_text', text: 'answer' },
        {
          type: 'output_image',
          url: 'data:image/png;base64,AQID',
          prompt: 'tiny image',
        },
      ],
      generationServerToolOutputs: [
        {
          index: 0,
          output: {
            id: 'ws_1',
            type: 'web_search_call',
            status: 'completed',
          },
        },
      ],
      reasoningDetails: [
        {
          type: 'reasoning.text',
          id: 'claude-visible',
          index: 0,
          format: 'anthropic-claude-v1',
          text: 'visible thought',
          signature: 'claude-signature',
        },
        {
          type: 'reasoning.summary',
          id: 'gemini-summary',
          index: 1,
          format: 'google-gemini-v1',
          summary: 'summary thought',
        },
        {
          type: 'reasoning.encrypted',
          id: 'gemini-carrier',
          index: 2,
          format: 'google-gemini-v1',
          data: 'gemini-signature',
        },
      ],
    }
    await legacy.table('messages').put(header)
    await legacy.table('messageBodies').put(body)
    legacy.close()

    const db = legacyMessageDatabase(name)
    db.version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAMessageAndAttachmentRowsV94(tx, {
          observedAt: 10,
          recordObsoleteBytes: () => undefined,
        }),
      )
    await db.open()

    expect(await db.table('messages').get('message-1')).toMatchObject({
      nodeVersion: 2,
      requestContextVersion: 2,
      bodyVersion: 2,
    })
    const storedBody = await db.table<MessageBodyRow>('messageBodies').get('message-1')
    expect(storedBody).not.toHaveProperty('reasoningDetails')
    expect(storedBody).not.toHaveProperty('generationServerToolOutputs')
    expect(storedBody).toMatchObject({
      bodyVersion: 2,
      content: [
        { type: 'output_text', text: 'answer' },
        { type: 'output_image', attachmentId: 'generated:message-1:2' },
      ],
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'web_search_call',
          outputIndex: 0,
          item: { id: 'ws_1', type: 'web_search_call', status: 'completed' },
        },
      ],
    })
    expect(storedBody?.reasoningEnvelope?.visible.map((part) => part.text)).toEqual([
      'visible thought',
      'summary thought',
    ])
    expect(storedBody?.reasoningEnvelope?.carriers.map((carrier) => carrier.kind)).toEqual([
      'anthropic-signature',
      'gemini-thought-signature',
    ])
    expect(await db.table('attachmentRefEdges').count()).toBe(1)
    expect(await db.table('attachments').get('generated:message-1:2')).toMatchObject({
      refCount: 1,
      wireVersion: 0,
      unreferencedAt: null,
      storage: { kind: 'local-blob' },
    })
    expect(await db.table('attachmentBlobs').count()).toBe(1)
    expect(await db.table('attachmentCatalogAggregate').get('workspace')).toMatchObject({
      totalCount: 1,
      referencedCount: 1,
      localCount: 1,
      generatedCount: 1,
    })
    db.close()
  })

  it('preserves current rows across a page boundary and rebuilds exact attachment summaries', async () => {
    const name = `wave-a-v94-message-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = currentMessageDatabase(name)
    await legacy.open()
    const storedChat = chat()
    const storedProfile = profile()
    const remoteBundle = prepareGeneratedOutputRemoteBundle({
      id: 'remote-a',
      url: 'https://cdn.example.test/generated.png',
      filename: 'generated.png',
      mime: 'image/png',
      kind: 'image',
      now: 1,
    })
    const pendingJob = remoteBundle.jobs[0]
    if (!pendingJob) throw new Error('ExpectedGeneratedOutputJob')
    const completedJob: AttachmentJob = {
      ...pendingJob,
      status: 'succeeded',
      outputArtifactIds: [],
      finishedAt: 2,
      updatedAt: 2,
    }
    const remoteAttachment: Attachment = {
      ...remoteBundle.attachment,
      processing: withGeneratedOutputLocalizationState([], completedJob),
      refCount: 5,
    }
    const localAttachment: Attachment = {
      id: 'local-b',
      kind: 'other',
      mime: 'application/octet-stream',
      filename: 'local-b.bin',
      origin: 'import',
      createdAt: 1,
      updatedAt: 1,
      storage: { kind: 'missing', reason: 'blob-not-found', missingSince: 1 },
      artifacts: [],
      processing: [],
      refCount: 3,
    }
    const messageZeroRefs = [
      attachmentRef('message-000:remote-visible', 'remote-a', true),
      attachmentRef('message-000:remote-hidden', 'remote-a', false),
      attachmentRef('message-000:local-visible', 'local-b', true),
    ]
    const pairs = Array.from({ length: 130 }, (_unused, index) => {
      const id = `message-${String(index).padStart(3, '0')}`
      const refs =
        index === 0
          ? messageZeroRefs
          : index === 127
            ? [attachmentRef(`${id}:remote-visible`, 'remote-a', true)]
            : index === 128
              ? [attachmentRef(`${id}:local-hidden`, 'local-b', false)]
              : []
      return splitMessageForStorage(
        message({
          id,
          siblingIndex: index,
          turnId: `turn-${index}`,
          turnIndex: index,
          createdAt: index + 1,
          ...(index === 0
            ? {
                role: 'assistant' as const,
                origin: 'generated' as const,
                content: [{ type: 'output_image' as const, attachmentId: 'remote-a' }],
              }
            : {}),
          attachmentRefs: refs,
        }),
      )
    })
    storedChat.lastUpdatedLeafId = 'message-129'
    storedChat.wordCount = 258
    await legacy.table('chats').put(storedChat)
    await legacy.table('profiles').put(storedProfile)
    await legacy.table('configurationLinks').put({
      id: 'chat:chat-1:profile',
      ownerKind: 'chat',
      ownerId: 'chat-1',
      ownerKey: 'chat:chat-1',
      targetKind: 'profile',
      targetId: 'profile-1',
      targetKey: 'profile:profile-1',
      slot: 'profile',
      ownerActive: true,
    })
    await legacy.table('messages').bulkPut(pairs.map((pair) => pair.header))
    await legacy.table('messageBodies').bulkPut(pairs.map((pair) => pair.body))
    await legacy
      .table('attachments')
      .bulkPut([
        splitAttachmentForStorage(remoteAttachment, 7, null),
        splitAttachmentForStorage(localAttachment, 3, null),
      ])
    await legacy.table('attachmentJobs').put(completedJob)
    await legacy.table('drafts').put({
      chatId: 'chat-1',
      text: '',
      attachmentRefs: [
        attachmentRef('draft:remote-visible', 'remote-a', true),
        attachmentRef('draft:remote-hidden', 'remote-a', false),
        attachmentRef('draft:local-visible', 'local-b', true),
      ],
      updatedAt: 1,
    })
    const originalHeader = structuredClone(pairs[0]?.header)
    const originalBody = structuredClone(pairs[0]?.body)
    const originalRemote = structuredClone(
      await legacy.table<Attachment>('attachments').get('remote-a'),
    )
    const originalJob = structuredClone(completedJob)
    legacy.close()

    let obsoleteBytes = 0
    const db = currentMessageDatabase(name)
    db.version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAMessageAndAttachmentRowsV94(tx, {
          observedAt: 10,
          recordObsoleteBytes: (bytes) => {
            obsoleteBytes += bytes
          },
        }),
      )
    await db.open()

    expect(await db.table('messages').count()).toBe(130)
    expect(await db.table('messageBodies').count()).toBe(130)
    expect(await db.table('messagePreviews').count()).toBe(130)
    expect(await db.table('messages').get('message-000')).toEqual(originalHeader)
    expect(await db.table('messageBodies').get('message-000')).toEqual(originalBody)
    expect(await db.table('attachments').get('remote-a')).toEqual(originalRemote)
    expect(await db.table('attachmentJobs').get(completedJob.id)).toEqual(originalJob)
    expect(obsoleteBytes).toBe(0)
    expect(await db.table('attachmentRefEdges').count()).toBe(8)
    expect(await db.table('attachmentCatalogRows').get('remote-a')).toMatchObject({
      refCount: 5,
      messageRefCount: 2,
      draftRefCount: 1,
      visibleRefCount: 3,
      hiddenRefCount: 2,
    })
    expect(await db.table('attachmentCatalogRows').get('local-b')).toMatchObject({
      refCount: 3,
      messageRefCount: 2,
      draftRefCount: 1,
      visibleRefCount: 2,
      hiddenRefCount: 1,
    })
    expect(await db.table('attachmentCatalogAggregate').get('workspace')).toMatchObject({
      totalCount: 2,
      referencedCount: 2,
    })
    db.close()
  })

  it('rolls back generated-output and edge writes when a late attachment target is missing', async () => {
    const name = `wave-a-v94-message-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = currentMessageDatabase(name)
    await legacy.open()
    const attachmentA = splitAttachmentForStorage({
      id: 'attachment-a',
      kind: 'other',
      mime: 'application/octet-stream',
      filename: 'attachment-a.bin',
      origin: 'import',
      createdAt: 1,
      updatedAt: 1,
      storage: { kind: 'missing', reason: 'blob-not-found', missingSince: 1 },
      artifacts: [],
      processing: [],
      refCount: 1,
    })
    await legacy.table('attachments').put(attachmentA)
    await legacy.table('messagePreviews').put({
      id: 'stale-preview',
      chatId: 'chat-1',
      bodyVersion: 0,
      text: 'must survive rollback',
    })
    const staleEdge = {
      ownerKind: 'message' as const,
      ownerId: 'stale-owner',
      chatId: 'chat-1',
      refId: 'stale-ref',
      attachmentId: 'attachment-a',
      ordinal: 0,
      includeInContext: true,
      refUpdatedAt: 1,
    }
    await legacy.table('attachmentRefEdges').put(staleEdge)
    const pairs = Array.from({ length: 128 }, (_unused, index) => {
      const id = `message-${String(index).padStart(3, '0')}`
      return splitMessageForStorage(
        message({
          id,
          siblingIndex: index,
          turnId: `turn-${index}`,
          turnIndex: index,
          createdAt: index + 1,
          role: index === 0 ? 'assistant' : 'user',
          origin: index === 0 ? 'generated' : 'user',
          content:
            index === 0
              ? [{ type: 'output_image', url: 'data:image/png;base64,AQID' }]
              : [{ type: 'text', text: `message ${index}` }],
          attachmentRefs: [
            attachmentRef(`${id}:ref`, index === 127 ? 'missing-z' : 'attachment-a', true),
          ],
        }),
      )
    })
    await legacy.table('messages').bulkPut(pairs.map((pair) => pair.header))
    await legacy.table('messageBodies').bulkPut(pairs.map((pair) => pair.body))
    const originalHeader = structuredClone(pairs[0]?.header)
    const originalBody = structuredClone(pairs[0]?.body)
    legacy.close()

    const failing = currentMessageDatabase(name)
    failing
      .version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAMessageAndAttachmentRowsV94(tx, {
          observedAt: 10,
          recordObsoleteBytes: () => undefined,
        }),
      )
    await expect(failing.open()).rejects.toThrow('WaveAAttachmentTargetMissing:missing-z')
    failing.close()

    const reopened = currentMessageDatabase(name)
    await reopened.open()
    expect(reopened.verno).toBe(1)
    expect(await reopened.table('messagePreviews').get('stale-preview')).toEqual({
      id: 'stale-preview',
      chatId: 'chat-1',
      bodyVersion: 0,
      text: 'must survive rollback',
    })
    expect(
      await reopened.table('attachmentRefEdges').get(['message', 'stale-owner', 'stale-ref']),
    ).toEqual(staleEdge)
    expect(await reopened.table('messages').get('message-000')).toEqual(originalHeader)
    expect(await reopened.table('messageBodies').get('message-000')).toEqual(originalBody)
    expect(await reopened.table('attachments').get('attachment-a')).toEqual(attachmentA)
    expect(await reopened.table('attachments').get('generated:message-000:1')).toBeUndefined()
    expect(await reopened.table('attachmentBlobs').count()).toBe(0)
    expect(await reopened.table('attachmentJobs').count()).toBe(0)
    reopened.close()
  })
})

function legacyMessageDatabase(name: string): Dexie {
  const db = new Dexie(name)
  db.version(1).stores({
    chats: '&id',
    messages: '&id',
    messageBodies: '&id',
  })
  return db
}

function currentMessageDatabase(name: string): Dexie {
  const db = new Dexie(name)
  db.version(1).stores(WAVE_A_V94_STORES)
  return db
}

function profile(): ConnectionProfile {
  return {
    id: 'profile-1',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function attachmentRef(
  refId: string,
  attachmentId: string,
  includeInContext: boolean,
): MessageAttachmentRef {
  return {
    refId,
    attachmentId,
    includeInContext,
    presentation: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function chat(): Chat {
  return {
    id: 'chat-1',
    title: 'Chat',
    titleStatus: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 2,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 0,
    configurationVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: 'message-1',
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    chatId: 'chat-1',
    parentId: null,
    siblingIndex: 0,
    turnId: 'turn-1',
    turnIndex: 0,
    createdAt: 1,
    role: 'user',
    origin: 'user',
    deleted: false,
    nodeVersion: 0,
    content: [{ type: 'text', text: 'hello world' }],
    attachmentRefs: [],
    ...overrides,
  }
}

function v25Header(header: MessageHeaderRow): Record<string, unknown> {
  const {
    treeParentKey: _treeParentKey,
    treeLive: _treeLive,
    bodyWordCount: _bodyWordCount,
    bodyTextCharCount: _bodyTextCharCount,
    bodyMediaCount: _bodyMediaCount,
    bodyRenderCost: _bodyRenderCost,
    contextRouteFacts: _contextRouteFacts,
    ...legacy
  } = header
  return { ...legacy, textPreview: 'stale' }
}
