import Dexie, { type Transaction } from 'dexie'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  type ChatExportEnvelope,
  NATTER_EXPORT_SCHEMA_VERSION,
} from '../../src/core/import-export/schema'
import {
  planProviderOutputAuthoringOperations,
  projectProviderOutputAuthoring,
} from '../../src/core/message-body-authoring'
import type { StructuralSnapshot, StructuralSnapshotRow } from '../../src/core/messages'
import { reasoningCarrierDescriptorFromCarrier } from '../../src/core/reasoning-envelope'
import { createAncestorOutsideSetResolver, TreeChangedError } from '../../src/core/tree-ops'
import type {
  Chat,
  ChatId,
  ContentItem,
  Message,
  MessageId,
  MessageRole,
} from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { buildAttachment, putAttachment } from '../../src/store/attachments'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { __resetDbForTests, CURRENT_DB_VERSION, getDb } from '../../src/store/db'
import { exportWorkspaceBackup, restoreWorkspaceBackup } from '../../src/store/import-export'
import { __setLockBackendForTests, type LockBackend, type LockGrant } from '../../src/store/locks'
import type { MessageHeaderRow } from '../../src/store/message-storage'
import type {
  CommitEnvelope,
  ReadEnvelope,
  WorkspaceCommand,
  WorkspaceCommandResult,
  WorkspaceQuery,
  WorkspaceQueryResult,
} from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import { runWorkspaceAction, runWorkspaceRead } from '../../src/store/workspace-runtime'
import { putTestChat } from '../helpers/chats'
import {
  executeMessageCommand,
  isLegacyMessageCommand,
  type LegacyMessageCommand,
  type LegacyMessageCommandResult,
} from '../helpers/message-commands'
import {
  putTestMessages,
  readTestMessageHeader,
  readTestMessageHeaders,
} from '../helpers/message-storage'
import { reasoningEnvelopeFromDetailsForTest } from '../helpers/reasoning-events'

const DB_NAME = 'natter'

let emptyWorkspaceBackup: Awaited<ReturnType<typeof exportWorkspaceBackup>>

beforeAll(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
  await openBrowserWorkspace()
  emptyWorkspaceBackup = await exportWorkspaceBackup()
})

beforeEach(async () => {
  __setLockBackendForTests(null)
  await restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 1 })
})

afterAll(async () => {
  __setLockBackendForTests(null)
  await shutdownBrowserWorkspace()
})

function query<Q extends WorkspaceQuery>(
  request: Q,
): Promise<ReadEnvelope<WorkspaceQueryResult<Q>>> {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository().query(permit, request, { signal: permit.signal }),
  )
}

function execute<C extends WorkspaceCommand>(
  command: C,
): Promise<CommitEnvelope<WorkspaceCommandResult<C>>>
function execute<C extends LegacyMessageCommand>(
  command: C,
): Promise<{ value: LegacyMessageCommandResult<C> }>
function execute(
  command: WorkspaceCommand | LegacyMessageCommand,
): Promise<CommitEnvelope<unknown> | { value: unknown }> {
  if (isLegacyMessageCommand(command)) {
    return executeMessageCommand(command).then((value) => ({ value }))
  }
  return runWorkspaceAction('maintenance', (permit) =>
    getWorkspaceRepository().execute(permit, command),
  )
}

async function seedChat(overrides: Partial<Chat> = {}): Promise<Chat> {
  const chat: Chat = {
    id: newId(),
    title: 'Test',
    titleStatus: 'untitled',
    createdAt: 100,
    updatedAt: 100,
    lastViewedAt: 100,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 0,
    configurationVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 100,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
    previewText: '',
    ...overrides,
  }
  return putTestChat(chat)
}

function message(chatId: ChatId, overrides: Partial<Message> & Pick<Message, 'id'>): Message {
  const { id, ...fields } = overrides
  return {
    id,
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: newId(),
    turnIndex: 0,
    createdAt: 1,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: id }],
    nodeVersion: 0,
    deleted: false,
    ...fields,
  }
}

async function append(row: Message, expectedLeafId: MessageId | null) {
  const siblings = (await getHeaders(row.chatId)).filter(
    (header) => header.parentId === expectedLeafId,
  )
  const stored = {
    ...row,
    parentId: expectedLeafId,
    siblingIndex: Math.max(0, ...siblings.map((header) => header.siblingIndex + 1)),
  }
  await putTestMessages([stored])
  return stored
}

async function appendLinear(
  chatId: ChatId,
  specs: ReadonlyArray<
    Partial<Message> & Pick<Message, 'id'> & { role?: MessageRole; content?: ContentItem[] }
  >,
): Promise<Message[]> {
  const rows: Message[] = []
  let leafId: MessageId | null = null
  for (const [index, spec] of specs.entries()) {
    const row = message(chatId, {
      createdAt: index + 1,
      ...spec,
    })
    const stored = await append(row, leafId)
    rows.push(stored)
    leafId = stored.id
  }
  return rows
}

async function getChat(chatId: ChatId): Promise<Chat | undefined> {
  return (await query({ kind: 'chat.get', chatId })).value
}

async function getPresentation(messageId: MessageId) {
  return (await query({ kind: 'message.presentation', messageId })).value
}

async function getMessage(messageId: MessageId): Promise<Message | undefined> {
  return (await getPresentation(messageId))?.message
}

async function getHeader(messageId: MessageId): Promise<MessageHeaderRow | undefined> {
  return readTestMessageHeader(messageId)
}

async function getHeaders(chatId: ChatId): Promise<MessageHeaderRow[]> {
  const topology = (await query({ kind: 'message.headers-by-chat', chatId })).value
  if (topology.kind !== 'ready') throw new Error(`ChatTopologyUnavailable:${chatId}`)
  return [...topology.headers]
}

async function getChildren(
  chatId: ChatId,
  parentId: MessageId | null,
): Promise<MessageHeaderRow[]> {
  return (await getHeaders(chatId)).filter((header) => header.parentId === parentId)
}

function structuralRow(header: MessageHeaderRow): StructuralSnapshotRow {
  return {
    id: header.id,
    chatId: header.chatId,
    parentId: header.parentId,
    siblingIndex: header.siblingIndex,
    nodeVersion: header.nodeVersion,
    deleted: header.deleted,
    ...(header.attachmentRefs ? { attachmentRefs: structuredClone(header.attachmentRefs) } : {}),
  }
}

async function snapshotRows(
  chatId: ChatId,
  messageIds: readonly MessageId[],
): Promise<StructuralSnapshotRow[]> {
  const headers = await readTestMessageHeaders(messageIds)
  return headers.flatMap((header) => (header?.chatId === chatId ? [structuralRow(header)] : []))
}

interface ImportedGraph {
  readonly chat: Chat
  readonly id: (sourceId: string) => MessageId
}

async function importGraph(
  sourceMessages: readonly Message[],
  settings = cloneDefaultChatSettings(),
): Promise<ImportedGraph> {
  const sourceChatId = sourceMessages[0]?.chatId ?? `source-${newId()}`
  const envelope: ChatExportEnvelope = {
    objectKind: 'chat',
    exportSchemaVersion: NATTER_EXPORT_SCHEMA_VERSION,
    appStorageSchemaVersion: CURRENT_DB_VERSION,
    createdAt: 100,
    source: { app: 'natter', backendKind: 'unknown' },
    payload: {
      chat: {
        sourceChatId,
        title: 'Imported graph',
        createdAt: 1,
        updatedAt: 100,
        settings,
      },
      messages: sourceMessages.map((row) => structuredClone(row)),
      tags: [],
      attachments: [],
    },
  }
  const result = (
    await execute({ kind: 'interchange.import-chat', envelope, options: { now: 100 } })
  ).value
  const chat = await getChat(result.chatId)
  if (!chat) throw new Error(`ImportedChatMissing:${result.chatId}`)
  const importedHeaders = (await getHeaders(result.chatId)).sort((left, right) =>
    left.id.localeCompare(right.id),
  )
  if (importedHeaders.length !== sourceMessages.length) {
    throw new Error(`ImportedMessageCountMismatch:${result.chatId}`)
  }
  const importedIdBySourceId = new Map(
    sourceMessages.map((message, index) => {
      const imported = importedHeaders[index]
      if (!imported) throw new Error(`ImportedMessageIndexMissing:${index}`)
      return [message.id, imported.id] as const
    }),
  )
  return {
    chat,
    id: (sourceId) => {
      const mapped = importedIdBySourceId.get(sourceId)
      if (!mapped) throw new Error(`ImportedMessageMissing:${sourceId}`)
      return mapped
    },
  }
}

function sourceMessage(chatId: ChatId, id: MessageId, overrides: Partial<Message> = {}): Message {
  return message(chatId, { id, ...overrides })
}

describe('body edits', () => {
  it('rolls back an authoritative command cancelled while its transaction is queued', async () => {
    const chat = await seedChat()
    const row = await append(
      message(chat.id, {
        id: 'cancelled-queued-edit',
        content: [{ type: 'text', text: 'before' }],
      }),
      null,
    )

    let markTransactionEntered!: () => void
    const transactionEntered = new Promise<void>((resolve) => {
      markTransactionEntered = resolve
    })
    let releaseTransaction!: () => void
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransaction = resolve
    })
    const runTransaction: LockGrant['runTransaction'] = async (database, tables, operation) => {
      markTransactionEntered()
      await transactionGate
      return database.transaction(
        'rw',
        tables.map((table) => database.table(typeof table === 'string' ? table : table.name)),
        (transaction: Transaction) => operation(transaction),
      )
    }
    const backend: LockBackend = {
      kind: 'web-locks',
      run: (logicalNames, operation) =>
        Promise.resolve(
          operation({
            kind: 'web-locks',
            logicalNames,
            runTransaction,
          }),
        ),
      runAuthoritativeCommandSession: (_database, operation) =>
        Promise.resolve(
          operation({
            kind: 'web-locks',
            withResourceLocks: (logicalNames, child) =>
              Promise.resolve(
                child({
                  kind: 'web-locks',
                  logicalNames,
                  runTransaction,
                }),
              ),
          }),
        ),
    }
    __setLockBackendForTests(backend)
    const controller = new AbortController()
    const execution = runWorkspaceAction(
      'conversation-generation',
      (permit) =>
        getWorkspaceRepository().execute(permit, {
          kind: 'message.edit-body',
          input: {
            chatId: chat.id,
            messageId: row.id,
            content: [{ type: 'text', text: 'must not commit' }],
            now: 2,
          },
        }),
      { signal: controller.signal },
    )
    await transactionEntered
    controller.abort(new DOMException('cancel queued command', 'AbortError'))
    releaseTransaction()

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' })
    expect((await getMessage(row.id))?.content).toEqual([{ type: 'text', text: 'before' }])
  })

  it('changes only editable body fields and returns an exact versioned presentation', async () => {
    const chat = await seedChat()
    const rich = message(chat.id, {
      id: 'rich',
      createdAt: 123,
      role: 'assistant',
      origin: 'generated',
      turnId: 'turn-rich',
      content: [{ type: 'text', text: 'original' }],
      generation: {
        id: 'generation-rich',
        model: 'openai/gpt-5.4',
        requestedModel: 'openai/gpt-5.4',
        apiUsed: 'responses',
        delivery: 'streaming',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        cost: 0.001,
        costSource: 'stream',
        reasoningCarryForward: 'none',
        reasoningVisibility: { disclosure: 'unknown' },
        startedAt: 100,
        finishedAt: 110,
      },
      reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
        [{ type: 'reasoning.text', text: 'reasoning', format: 'unknown' }],
        'unknown',
      ),
    })
    await append(rich, null)
    const before = await getHeader(rich.id)
    const commit = await execute({
      kind: 'message.edit-body',
      input: {
        chatId: chat.id,
        messageId: rich.id,
        content: [{ type: 'text', text: 'edited' }],
        now: 500,
      },
    })
    const exact = await getPresentation(rich.id)

    expect(commit.value.message).toMatchObject({
      id: rich.id,
      createdAt: 123,
      turnId: 'turn-rich',
      turnIndex: 0,
      role: 'assistant',
      origin: 'generated',
      editedAt: 500,
      content: [{ type: 'text', text: 'edited' }],
    })
    expect(commit.value.message.generation).toEqual(rich.generation)
    expect(commit.value.message.reasoningEnvelope).toEqual(rich.reasoningEnvelope)
    expect(commit.value.header.bodyVersion).toBe((before?.bodyVersion ?? -1) + 1)
    expect(exact?.bodyVersion).toBe(commit.value.header.bodyVersion)
    expect(exact?.message).toEqual(commit.value.message)
    expect(
      commit.receipt.messageRevisions.flatMap((revision) =>
        revision.presentation ? [revision.presentation] : [],
      ),
    ).toEqual([exact])
  })

  it('uses the visible member as the sole visibility owner for a bound Claude signature', async () => {
    const chat = await seedChat()
    const reasoningEnvelope = reasoningEnvelopeFromDetailsForTest(
      [
        {
          type: 'reasoning.text',
          text: 'signed thought',
          signature: 'opaque-signature',
          format: 'anthropic-claude-v1',
        },
      ],
      'anthropic-messages',
    )
    const visible = reasoningEnvelope.visible[0]
    const signature = reasoningEnvelope.carriers[0]
    if (!visible || signature?.kind !== 'anthropic-signature') {
      throw new Error('SignedReasoningFixtureMissing')
    }
    const row = message(chat.id, {
      id: 'signed-reasoning',
      role: 'assistant',
      origin: 'generated',
      reasoningEnvelope,
    })
    await append(row, null)

    const hidden = await execute({
      kind: 'message.toggle-reasoning-detail',
      chatId: chat.id,
      messageId: row.id,
      member: { owner: { kind: 'generation' }, kind: 'visible', id: visible.id },
    })
    if (!hidden.value) throw new Error('HiddenReasoningToggleMissing')
    expect(hidden.value.message.reasoningEnvelope?.visible[0]?.hidden).toBe(true)
    expect(hidden.value.message.reasoningEnvelope?.carriers[0]?.hidden).toBeUndefined()

    const visibleAgain = await execute({
      kind: 'message.toggle-reasoning-detail',
      chatId: chat.id,
      messageId: row.id,
      member: { owner: { kind: 'generation' }, kind: 'carrier', id: signature.id },
    })
    if (!visibleAgain.value) throw new Error('VisibleReasoningToggleMissing')
    expect(visibleAgain.value.message.reasoningEnvelope?.visible[0]?.hidden).toBe(false)
    expect(visibleAgain.value.message.reasoningEnvelope?.carriers[0]?.hidden).toBeUndefined()
  })

  it('edits one visible reasoning member in place and drops only its invalidated signature', async () => {
    const chat = await seedChat()
    const signedEnvelope = reasoningEnvelopeFromDetailsForTest(
      [
        {
          type: 'reasoning.text',
          text: 'signed thought',
          signature: 'opaque-signature',
          format: 'anthropic-claude-v1',
        },
      ],
      'anthropic-messages',
    )
    const visible = signedEnvelope.visible[0]
    if (!visible) throw new Error('SignedReasoningFixtureMissing')
    const importedVisible = { ...visible, hidden: false }
    const unrelatedCarrier = {
      id: 'unrelated-encrypted-carrier',
      groupId: 'unrelated-group',
      kind: 'responses-encrypted' as const,
      data: 'preserve-me',
      format: 'openai-responses-v1' as const,
      source: {
        dialect: 'openai-responses' as const,
        bridge: 'openai-direct' as const,
        itemId: 'unrelated-provider-item',
      },
    }
    const reasoningEnvelope = {
      ...signedEnvelope,
      carriers: [...signedEnvelope.carriers, unrelatedCarrier],
    }
    const originalContent = [
      {
        type: 'output_text' as const,
        text: 'unchanged answer',
        annotations: [
          {
            type: 'url_citation' as const,
            startIndex: 0,
            endIndex: 9,
            source: 'openai-responses' as const,
            providerPayload: { cited: true },
            url: 'https://example.com/source',
          },
        ],
      },
      { type: 'image_url' as const, url: 'https://example.com/image.png', detail: 'high' as const },
      { type: 'output_text' as const, text: ' second segment' },
    ]
    const row = message(chat.id, {
      id: 'editable-reasoning',
      createdAt: 123,
      role: 'assistant',
      origin: 'generated',
      content: originalContent,
      reasoningEnvelope: { ...reasoningEnvelope, visible: [importedVisible] },
    })
    await append(row, null)

    const edited = await execute({
      kind: 'message.edit-body',
      input: {
        chatId: chat.id,
        messageId: row.id,
        now: 500,
        authoring: {
          reasoning: [
            {
              kind: 'visible-replace',
              member: { owner: { kind: 'generation' }, kind: 'visible', id: importedVisible.id },
              expected: importedVisible,
              next: { ...importedVisible, text: 'corrected thought' },
            },
          ],
        },
      },
    })

    expect(edited.value.message).toMatchObject({
      id: row.id,
      createdAt: 123,
      editedAt: 500,
    })
    expect(edited.value.message.content).toEqual(originalContent)
    expect(edited.value.message.reasoningEnvelope?.visible).toEqual([
      { ...importedVisible, text: 'corrected thought' },
    ])
    expect(edited.value.message.reasoningEnvelope?.carriers).toEqual([unrelatedCarrier])
  })

  it('addresses an applied continuation reasoning member without touching generation reasoning', async () => {
    const chat = await seedChat()
    const generationEnvelope = reasoningEnvelopeFromDetailsForTest(
      [{ type: 'reasoning.text', text: 'generation thought', format: 'unknown' }],
      'unknown',
    )
    const continuationEnvelope = reasoningEnvelopeFromDetailsForTest(
      [{ type: 'reasoning.summary', summary: 'continuation thought', format: 'unknown' }],
      'unknown',
    )
    const continuationVisible = continuationEnvelope.visible[0]
    if (!continuationVisible) throw new Error('ContinuationReasoningFixtureMissing')
    const row = message(chat.id, {
      id: 'continued-reasoning',
      role: 'assistant',
      origin: 'generated',
      reasoningEnvelope: generationEnvelope,
      continuationAttempts: [
        {
          streamId: 'continuation-stream',
          strategy: 'prompt',
          status: 'done',
          startedAt: 2,
          finishedAt: 3,
          application: { kind: 'applied' },
          reasoningEnvelope: continuationEnvelope,
          reasoningCarryForward: 'none',
          reasoningVisibility: { disclosure: 'visible', visibleKind: 'summary' },
        },
      ],
    })
    await append(row, null)

    const edited = await execute({
      kind: 'message.edit-body',
      input: {
        chatId: chat.id,
        messageId: row.id,
        authoring: {
          reasoning: [
            {
              kind: 'visible-replace',
              member: {
                owner: { kind: 'continuation', streamId: 'continuation-stream' },
                kind: 'visible',
                id: continuationVisible.id,
              },
              expected: continuationVisible,
              next: { ...continuationVisible, text: 'corrected continuation thought' },
            },
          ],
        },
      },
    })

    expect(edited.value.message.reasoningEnvelope).toEqual(generationEnvelope)
    expect(
      edited.value.message.continuationAttempts?.[0]?.reasoningEnvelope?.visible[0]?.text,
    ).toBe('corrected continuation thought')
  })

  it('creates, relabels and deletes exact reasoning members in one atomic body edit', async () => {
    const chat = await seedChat()
    const initialEnvelope = reasoningEnvelopeFromDetailsForTest(
      [
        { type: 'reasoning.text', text: 'delete me', format: 'unknown' },
        { type: 'reasoning.summary', summary: 'relabel me', format: 'unknown' },
        { type: 'reasoning.encrypted', data: 'remove opaque', format: 'unknown' },
      ],
      'unknown',
    )
    const deletedVisible = initialEnvelope.visible[0]
    const relabeledVisible = initialEnvelope.visible[1]
    const deletedCarrier = initialEnvelope.carriers[0]
    if (!deletedVisible || !relabeledVisible || !deletedCarrier) {
      throw new Error('ReasoningAuthoringFixtureMissing')
    }
    const row = message(chat.id, {
      id: 'message-body-authoring',
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'answer' }],
      reasoningEnvelope: initialEnvelope,
    })
    await append(row, null)

    const carrierDescriptor = reasoningCarrierDescriptorFromCarrier(deletedCarrier)
    const created = {
      id: 'authored-visible',
      groupId: 'authored-visible',
      kind: 'summary' as const,
      text: 'new summary',
      format: 'unknown' as const,
      source: { dialect: 'unknown' as const, bridge: 'unknown' as const },
    }
    const edited = await execute({
      kind: 'message.edit-body',
      input: {
        chatId: chat.id,
        messageId: row.id,
        authoring: {
          reasoning: [
            {
              kind: 'visible-delete',
              member: {
                owner: { kind: 'generation' },
                kind: 'visible',
                id: deletedVisible.id,
              },
              expected: deletedVisible,
            },
            {
              kind: 'visible-replace',
              member: {
                owner: { kind: 'generation' },
                kind: 'visible',
                id: relabeledVisible.id,
              },
              expected: relabeledVisible,
              next: { ...relabeledVisible, kind: 'text', text: 'now plaintext', hidden: true },
            },
            {
              kind: 'carrier-delete',
              member: {
                owner: { kind: 'generation' },
                kind: 'carrier',
                id: deletedCarrier.id,
              },
              expected: carrierDescriptor,
            },
            { kind: 'visible-create', owner: { kind: 'generation' }, part: created },
          ],
        },
      },
    })

    expect(edited.value.message.reasoningEnvelope).toEqual({
      schemaVersion: 2,
      visible: [
        { ...relabeledVisible, kind: 'text', text: 'now plaintext', hidden: true },
        created,
      ],
      carriers: [],
    })
  })

  it('merges disjoint reasoning edits and rejects a stale edit of the same member', async () => {
    const chat = await seedChat()
    const reasoningEnvelope = reasoningEnvelopeFromDetailsForTest(
      [
        { type: 'reasoning.text', text: 'first', format: 'unknown' },
        { type: 'reasoning.summary', summary: 'second', format: 'unknown' },
      ],
      'unknown',
    )
    const first = reasoningEnvelope.visible[0]
    const second = reasoningEnvelope.visible[1]
    if (!first || !second) throw new Error('ReasoningConflictFixtureMissing')
    const row = message(chat.id, {
      id: 'reasoning-conflict',
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'answer' }],
      reasoningEnvelope,
    })
    await append(row, null)
    const replace = (expected: typeof first, text: string) =>
      execute({
        kind: 'message.edit-body',
        input: {
          chatId: chat.id,
          messageId: row.id,
          authoring: {
            reasoning: [
              {
                kind: 'visible-replace',
                member: {
                  owner: { kind: 'generation' },
                  kind: 'visible',
                  id: expected.id,
                },
                expected,
                next: { ...expected, text },
              },
            ],
          },
        },
      })

    await replace(first, 'first changed')
    await replace(second, 'second changed')
    await expect(replace(first, 'stale overwrite')).rejects.toBeInstanceOf(TreeChangedError)

    const persisted = await getMessage(row.id)
    expect(persisted?.reasoningEnvelope?.visible.map((part) => part.text)).toEqual([
      'first changed',
      'second changed',
    ])
  })

  it('authors exact provider outputs, preserves sealed fields and rolls back a mixed conflict', async () => {
    const chat = await seedChat()
    const sealed = {
      dialect: 'openai-responses' as const,
      type: 'web_search_call',
      captureId: 'provider-capture-sealed',
      outputIndex: 0,
      item: {
        id: 'provider-item-sealed',
        query: 'before',
        encrypted_content: 'must-survive-raw-edit',
      },
    }
    const deleted = {
      dialect: 'google-gemini' as const,
      type: 'grounding_result',
      captureId: 'provider-capture-delete',
      outputIndex: 1,
      item: { result: 'delete me' },
    }
    const row = message(chat.id, {
      id: 'provider-output-authoring',
      role: 'assistant',
      origin: 'generated',
      providerOutputItems: [sealed, deleted],
    })
    await append(row, null)
    const projection = projectProviderOutputAuthoring(row)
    const first = projection.entries[0]
    if (!first) throw new Error('ProviderOutputAuthoringFixtureMissing')
    const next = [
      {
        ...first,
        item: {
          ...first.item,
          type: 'web_search_call_edited',
          item: { id: 'provider-item-sealed', query: 'after' },
        },
      },
      {
        editorId: 'new-provider-output',
        owner: { kind: 'generation' as const },
        item: {
          dialect: 'unknown' as const,
          type: 'manual_tool_call',
          outputIndex: 2,
          item: { authored: true },
        },
      },
    ]
    const operations = planProviderOutputAuthoringOperations(projection.entries, next)
    expect(operations).toHaveLength(3)
    expect(operations[0]).toMatchObject({
      kind: 'provider-output-replace',
      next: {
        edited: true,
        item: { query: 'after', encrypted_content: 'must-survive-raw-edit' },
      },
    })

    const edited = await execute({
      kind: 'message.edit-body',
      input: {
        chatId: chat.id,
        messageId: row.id,
        authoring: { providerOutput: operations },
      },
    })
    expect(edited.value.message.providerOutputItems).toEqual([
      {
        ...sealed,
        type: 'web_search_call_edited',
        edited: true,
        item: {
          id: 'provider-item-sealed',
          query: 'after',
          encrypted_content: 'must-survive-raw-edit',
        },
      },
      { ...next[1]?.item, edited: true },
    ])

    const beforeConflict = structuredClone(edited.value.message.providerOutputItems)
    const currentFirst = beforeConflict?.[0]
    if (!currentFirst) throw new Error('EditedProviderOutputMissing')
    await expect(
      execute({
        kind: 'message.edit-body',
        input: {
          chatId: chat.id,
          messageId: row.id,
          authoring: {
            providerOutput: [
              {
                kind: 'provider-output-replace',
                member: { owner: { kind: 'generation' }, itemIndex: 0 },
                expected: currentFirst,
                next: { ...currentFirst, type: 'must-roll-back' },
              },
              {
                kind: 'provider-output-delete',
                member: { owner: { kind: 'generation' }, itemIndex: 1 },
                expected: { ...currentFirst, type: 'stale-member' },
              },
            ],
          },
        },
      }),
    ).rejects.toBeInstanceOf(TreeChangedError)
    expect((await getMessage(row.id))?.providerOutputItems).toEqual(beforeConflict)
  })

  it('keeps presentation-only message actions out of chat and sidebar finalization', async () => {
    const chat = await seedChat()
    const row = message(chat.id, {
      id: 'presentation-only-actions',
      role: 'assistant',
      origin: 'generated',
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'reasoning',
          item: { id: 'provider-reasoning', encrypted_content: 'opaque' },
        },
      ],
      generation: {
        id: 'presentation-generation',
        model: 'openai/gpt-5.4',
        requestedModel: 'openai/gpt-5.4',
        apiUsed: 'responses',
        delivery: 'streaming',
        costSource: 'stream',
        reasoningCarryForward: 'carrier',
        reasoningVisibility: { disclosure: 'visible', visibleKind: 'summary' },
        startedAt: 100,
        finishedAt: 110,
        error: {
          category: 'network',
          code: 'NETWORK',
          message: 'interrupted',
          retryable: true,
          midStream: true,
        },
      },
    })
    await append(row, null)
    const chatBefore = await getChat(chat.id)

    const provider = await execute({
      kind: 'message.toggle-provider-output-item',
      chatId: chat.id,
      messageId: row.id,
      member: { owner: { kind: 'generation' }, itemIndex: 0 },
    })
    if (!provider.value) throw new Error('ProviderOutputToggleMissing')
    expect(provider.value.message.providerOutputItems?.[0]?.hidden).toBe(true)

    const context = await execute({
      kind: 'message.toggle-context',
      chatId: chat.id,
      messageId: row.id,
    })
    if (!context.value) throw new Error('ContextToggleMissing')
    expect(context.value.message.hiddenFromContext).toBe(true)

    const dismissed = await execute({
      kind: 'message.dismiss-generation-notice',
      chatId: chat.id,
      messageId: row.id,
    })
    if (!dismissed.value) throw new Error('GenerationNoticeDismissMissing')
    expect(dismissed.value.message.generation?.error).toBeUndefined()
    expect(await getChat(chat.id)).toEqual(chatBefore)
    expect(provider.receipt.chats).toEqual([])
    expect(context.receipt.chats).toEqual([])
    expect(dismissed.receipt.chats).toEqual([])
  })

  it('preserves an explicit empty attachment-ref list for content that still cites an attachment', async () => {
    const chat = await seedChat()
    const attachment = await buildAttachment({
      blob: new Blob(['generated image']),
      filename: 'generated.png',
      mime: 'image/png',
      kind: 'image',
    })
    await putAttachment(attachment)
    const row = message(chat.id, {
      id: 'generated-image',
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'image_url', attachmentId: attachment.id }],
      attachmentRefs: [
        {
          refId: 'generated-ref',
          attachmentId: attachment.id,
          includeInContext: true,
          presentation: {},
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    await append(row, null)

    await execute({
      kind: 'message.edit-body',
      input: {
        chatId: chat.id,
        messageId: row.id,
        content: [{ type: 'image_url', attachmentId: attachment.id }],
        attachmentRefs: [],
        now: 2,
      },
    })

    expect((await getMessage(row.id))?.attachmentRefs).toEqual([])
    expect(
      (await query({ kind: 'attachment.get', attachmentId: attachment.id })).value?.refCount,
    ).toBe(0)
  })

  it('does not rewrite descendants and only bumps branch freshness for the last-updated branch', async () => {
    const chat = await seedChat()
    const [user, assistant, descendant] = await appendLinear(chat.id, [
      { id: 'user', createdAt: 1 },
      { id: 'assistant', role: 'assistant', origin: 'generated', createdAt: 2 },
      { id: 'descendant', createdAt: 3 },
    ])
    const branch = (
      await execute({
        kind: 'message.branch-explicit',
        input: { chatId: chat.id, messageId: descendant?.id as MessageId, now: 400 },
      })
    ).value
    const assistantBefore = await getPresentation(assistant?.id as MessageId)
    const branchBefore = await getPresentation(branch.messageId)
    const freshness = (await getChat(chat.id))?.lastBranchUpdatedAt

    await execute({
      kind: 'message.edit-body',
      input: {
        chatId: chat.id,
        messageId: descendant?.id as MessageId,
        content: [{ type: 'text', text: 'off branch' }],
        now: 500,
      },
    })
    expect((await getChat(chat.id))?.lastBranchUpdatedAt).toBe(freshness)
    expect(await getPresentation(assistant?.id as MessageId)).toEqual(assistantBefore)

    await execute({
      kind: 'message.edit-body',
      input: {
        chatId: chat.id,
        messageId: branch.messageId,
        content: [{ type: 'text', text: 'on branch' }],
        now: 600,
      },
    })
    expect((await getChat(chat.id))?.lastBranchUpdatedAt).toBeGreaterThan(freshness ?? 0)
    expect((await getHeader(user?.id as MessageId))?.parentId).toBeNull()
    expect((await getHeader(branch.messageId))?.bodyVersion).toBe(
      (branchBefore?.bodyVersion ?? -1) + 1,
    )
  })
})

describe('branch and insert commands', () => {
  it('keeps new sibling indices above live and tombstoned variants', async () => {
    const chat = await seedChat()
    const root = (await appendLinear(chat.id, [{ id: 'root' }]))[0] as Message
    const first = (
      await execute({
        kind: 'message.insert-sibling',
        input: {
          chatId: chat.id,
          targetId: root.id,
          role: root.role,
          content: [{ type: 'text', text: 'first alternative' }],
          now: 2,
        },
      })
    ).value
    await execute({
      kind: 'message.delete',
      mode: 'single',
      input: { chatId: chat.id, messageId: first.messageId, activeLeafId: first.messageId, now: 3 },
    })
    const second = (
      await execute({
        kind: 'message.insert-sibling',
        input: {
          chatId: chat.id,
          targetId: root.id,
          role: root.role,
          content: [{ type: 'text', text: 'second alternative' }],
          now: 4,
        },
      })
    ).value

    expect(first.header.siblingIndex).toBe(1)
    expect((await getHeader(first.messageId))?.deleted).toBe(true)
    expect(second.header.siblingIndex).toBe(2)
    expect(second.message.role).toBe(root.role)
  })

  it('inserts above a complete turn peer set without changing exact bodies', async () => {
    const sourceChatId = 'insert-graph'
    const graph = await importGraph([
      sourceMessage(sourceChatId, 'P', { role: 'user', createdAt: 1 }),
      sourceMessage(sourceChatId, 'C1', {
        parentId: 'P',
        siblingIndex: 0,
        role: 'assistant',
        turnId: 'shared-turn',
        createdAt: 2,
        content: [{ type: 'text', text: 'peer one' }],
      }),
      sourceMessage(sourceChatId, 'C2', {
        parentId: 'P',
        siblingIndex: 1,
        role: 'assistant',
        turnId: 'shared-turn',
        createdAt: 3,
        content: [{ type: 'text', text: 'peer two' }],
      }),
      sourceMessage(sourceChatId, 'V', {
        parentId: 'P',
        siblingIndex: 4,
        role: 'assistant',
        turnId: 'other-turn',
        createdAt: 4,
      }),
    ])
    const p = graph.id('P')
    const c1 = graph.id('C1')
    const c2 = graph.id('C2')
    const variant = graph.id('V')
    const c1Before = await getPresentation(c1)
    const c2Before = await getPresentation(c2)

    const commit = await execute({
      kind: 'message.insert-between',
      input: {
        chatId: graph.chat.id,
        parentId: p,
        childId: c1,
        content: [{ type: 'text', text: 'between' }],
        role: 'assistant',
        now: 5,
      },
    })
    const inserted = await getHeader(commit.value.messageId)

    expect(inserted).toMatchObject({ parentId: p, siblingIndex: 5 })
    expect(await getPresentation(c1)).toMatchObject({
      bodyVersion: c1Before?.bodyVersion,
      message: {
        parentId: commit.value.messageId,
        siblingIndex: 0,
        content: c1Before?.message.content,
      },
    })
    expect(await getPresentation(c2)).toMatchObject({
      bodyVersion: c2Before?.bodyVersion,
      message: {
        parentId: commit.value.messageId,
        siblingIndex: 1,
        content: c2Before?.message.content,
      },
    })
    expect((await getHeader(variant))?.parentId).toBe(p)
    expect(commit.value.effects).toEqual({
      newMessageIds: [commit.value.messageId],
      tombstoned: [],
      reparented: [
        { id: c1, previousParentId: p, newParentId: commit.value.messageId },
        { id: c2, previousParentId: p, newParentId: commit.value.messageId },
      ],
    })
    expect(new Set(commit.value.structuralHeaders.map((header) => header.id))).toEqual(
      new Set([commit.value.messageId, c1, c2]),
    )
    expect(commit.value.presentations.map((entry) => entry.message.id)).toEqual([
      commit.value.messageId,
    ])
  })

  it('appends one child and reports the introduced row exactly once', async () => {
    const chat = await seedChat()
    const parent = (await appendLinear(chat.id, [{ id: 'parent' }]))[0] as Message
    const commit = await execute({
      kind: 'message.append-child',
      input: {
        chatId: chat.id,
        parentMessageId: parent.id,
        content: [{ type: 'text', text: 'child' }],
        role: 'assistant',
        now: 2,
      },
    })

    expect(await getMessage(commit.value.messageId)).toMatchObject({
      parentId: parent.id,
      siblingIndex: 0,
      role: 'assistant',
    })
    expect(commit.value.effects.newMessageIds).toEqual([commit.value.messageId])
    expect(commit.value.structuralHeaders.map((header) => header.id)).toEqual([
      commit.value.messageId,
    ])
  })
})

describe('delete topology and selection outputs', () => {
  it('deletes a pair, splices the later branch upward, and returns the exact fallback', async () => {
    const sourceChatId = 'pair-graph'
    const graph = await importGraph([
      sourceMessage(sourceChatId, 'U1', { role: 'user', createdAt: 1 }),
      sourceMessage(sourceChatId, 'A1', {
        parentId: 'U1',
        role: 'assistant',
        createdAt: 2,
      }),
      sourceMessage(sourceChatId, 'U2', { parentId: 'A1', role: 'user', createdAt: 3 }),
      sourceMessage(sourceChatId, 'A2', {
        parentId: 'U2',
        role: 'assistant',
        createdAt: 4,
      }),
      sourceMessage(sourceChatId, 'U3', { parentId: 'A2', role: 'user', createdAt: 5 }),
      sourceMessage(sourceChatId, 'A3', {
        parentId: 'U3',
        role: 'assistant',
        createdAt: 6,
      }),
    ])
    const result = (
      await execute({
        kind: 'message.delete',
        mode: 'pair',
        input: {
          chatId: graph.chat.id,
          messageId: graph.id('U2'),
          activeLeafId: graph.id('A3'),
          now: 10,
        },
      })
    ).value

    expect(result.effects.tombstoned).toEqual([graph.id('U2'), graph.id('A2')])
    expect(result.effects.reparented).toEqual([
      {
        id: graph.id('U3'),
        previousParentId: graph.id('A2'),
        newParentId: graph.id('A1'),
      },
    ])
    expect((await getHeader(graph.id('U2')))?.deleted).toBe(true)
    expect((await getHeader(graph.id('A2')))?.deleted).toBe(true)
    expect((await getHeader(graph.id('U3')))?.parentId).toBe(graph.id('A1'))
    expect((await getHeader(graph.id('A3')))?.parentId).toBe(graph.id('U3'))
    expect(result.destination.proof.tipId).toBe(graph.id('A3'))
    expect(new Set(result.preImage.previousRows.map((row) => row.id))).toEqual(
      new Set([graph.id('U2'), graph.id('A2'), graph.id('U3')]),
    )
    expect(new Set(result.structuralHeaders.map((row) => row.id))).toEqual(
      new Set([graph.id('U2'), graph.id('A2'), graph.id('U3')]),
    )
  })

  it('keeps sibling indices unique after splicing beside tombstoned rows', async () => {
    const sourceChatId = 'splice-indices'
    const graph = await importGraph([
      sourceMessage(sourceChatId, 'P', { role: 'user', createdAt: 1 }),
      sourceMessage(sourceChatId, 'L', {
        parentId: 'P',
        siblingIndex: 0,
        role: 'assistant',
        createdAt: 2,
      }),
      sourceMessage(sourceChatId, 'A', {
        parentId: 'P',
        siblingIndex: 1,
        role: 'assistant',
        createdAt: 3,
      }),
      sourceMessage(sourceChatId, 'T', {
        parentId: 'P',
        siblingIndex: 5,
        deleted: true,
        createdAt: 4,
      }),
      sourceMessage(sourceChatId, 'C', {
        parentId: 'A',
        role: 'user',
        createdAt: 5,
      }),
    ])

    await execute({
      kind: 'message.delete',
      mode: 'single',
      input: {
        chatId: graph.chat.id,
        messageId: graph.id('A'),
        activeLeafId: graph.id('C'),
      },
    })

    const children = await getChildren(graph.chat.id, graph.id('P'))
    expect((await getHeader(graph.id('C')))?.parentId).toBe(graph.id('P'))
    expect(new Set(children.map((header) => header.siblingIndex)).size).toBe(children.length)
    expect(children.find((header) => header.id === graph.id('T'))?.deleted).toBe(true)
  })

  it('splices through every row in one multi-step turn chain', async () => {
    const sourceChatId = 'pair-turn-chain'
    const graph = await importGraph([
      sourceMessage(sourceChatId, 'P', { role: 'user', createdAt: 1 }),
      sourceMessage(sourceChatId, 'HEAD', {
        parentId: 'P',
        role: 'assistant',
        turnId: 'shared-turn',
        turnIndex: 0,
        createdAt: 2,
      }),
      sourceMessage(sourceChatId, 'MID', {
        parentId: 'HEAD',
        role: 'tool',
        turnId: 'shared-turn',
        turnIndex: 1,
        createdAt: 3,
      }),
      sourceMessage(sourceChatId, 'TAIL', {
        parentId: 'MID',
        role: 'assistant',
        turnId: 'shared-turn',
        turnIndex: 2,
        createdAt: 4,
      }),
      sourceMessage(sourceChatId, 'K', {
        parentId: 'TAIL',
        role: 'user',
        createdAt: 5,
      }),
    ])
    const result = (
      await execute({
        kind: 'message.delete',
        mode: 'variant',
        input: {
          chatId: graph.chat.id,
          messageId: graph.id('MID'),
          activeLeafId: graph.id('K'),
        },
      })
    ).value

    expect(new Set(result.effects.tombstoned)).toEqual(
      new Set([graph.id('HEAD'), graph.id('MID'), graph.id('TAIL')]),
    )
    expect((await getHeader(graph.id('K')))?.parentId).toBe(graph.id('P'))
    expect(result.destination.proof.tipId).toBe(graph.id('K'))
  })

  it('distinguishes whole-turn deletion from one-variant deletion', async () => {
    const makeVariantGraph = async (suffix: string) => {
      const sourceChatId = `variant-${suffix}`
      return importGraph([
        sourceMessage(sourceChatId, 'P', { role: 'user', createdAt: 1 }),
        sourceMessage(sourceChatId, 'V1', {
          parentId: 'P',
          siblingIndex: 0,
          role: 'assistant',
          turnId: 'variant-one',
          turnIndex: 0,
          createdAt: 2,
        }),
        sourceMessage(sourceChatId, 'V1B', {
          parentId: 'V1',
          role: 'assistant',
          turnId: 'variant-one',
          turnIndex: 1,
          createdAt: 3,
        }),
        sourceMessage(sourceChatId, 'V2', {
          parentId: 'P',
          siblingIndex: 1,
          role: 'assistant',
          turnId: 'variant-two',
          turnIndex: 0,
          createdAt: 4,
        }),
        sourceMessage(sourceChatId, 'V2B', {
          parentId: 'V2',
          role: 'assistant',
          turnId: 'variant-two',
          turnIndex: 1,
          createdAt: 5,
        }),
      ])
    }

    const turnGraph = await makeVariantGraph('turn')
    const turnResult = (
      await execute({
        kind: 'message.delete',
        mode: 'turn',
        input: {
          chatId: turnGraph.chat.id,
          messageId: turnGraph.id('V1B'),
          activeLeafId: turnGraph.id('V1B'),
        },
      })
    ).value
    expect(new Set(turnResult.effects.tombstoned)).toEqual(
      new Set([turnGraph.id('V1'), turnGraph.id('V1B'), turnGraph.id('V2'), turnGraph.id('V2B')]),
    )

    const variantGraph = await makeVariantGraph('single')
    const variantResult = (
      await execute({
        kind: 'message.delete',
        mode: 'variant',
        input: {
          chatId: variantGraph.chat.id,
          messageId: variantGraph.id('V1B'),
          activeLeafId: variantGraph.id('V1B'),
        },
      })
    ).value
    expect(new Set(variantResult.effects.tombstoned)).toEqual(
      new Set([variantGraph.id('V1'), variantGraph.id('V1B')]),
    )
    expect((await getHeader(variantGraph.id('V2')))?.deleted).toBe(false)
    expect((await getHeader(variantGraph.id('V2B')))?.deleted).toBe(false)
  })

  it('cascade-deletes descendants without any splice-up', async () => {
    const chat = await seedChat()
    const [parent, target, child, grandchild] = await appendLinear(chat.id, [
      { id: 'parent' },
      { id: 'target', role: 'assistant' },
      { id: 'child' },
      { id: 'grandchild', role: 'assistant' },
    ])
    const result = (
      await execute({
        kind: 'message.delete',
        mode: 'variant',
        input: {
          chatId: chat.id,
          messageId: target?.id as MessageId,
          activeLeafId: grandchild?.id as MessageId,
          cascade: true,
        },
      })
    ).value

    expect(new Set(result.effects.tombstoned)).toEqual(
      new Set([target?.id, child?.id, grandchild?.id]),
    )
    expect(result.effects.reparented).toEqual([])
    expect((await getHeader(child?.id as MessageId))?.parentId).toBe(target?.id)
    expect((await getHeader(grandchild?.id as MessageId))?.parentId).toBe(child?.id)
    expect(result.destination.proof.tipId).toBe(parent?.id)
    expect(new Set(result.preImage.previousRows.map((row) => row.id))).toEqual(
      new Set([target?.id, child?.id, grandchild?.id]),
    )
  })

  it('serializes simultaneous deletes so exactly one commits', async () => {
    const chat = await seedChat()
    const target = (
      await appendLinear(chat.id, [{ id: 'target', role: 'assistant' }])
    )[0] as Message

    const command = () =>
      execute({
        kind: 'message.delete' as const,
        mode: 'single' as const,
        input: {
          chatId: chat.id,
          messageId: target.id,
          activeLeafId: target.id,
        },
      })
    const outcomes = await Promise.allSettled([command(), command()])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(TreeChangedError)
    expect((await getHeader(target.id))?.deleted).toBe(true)
  })
})

describe('structural undo', () => {
  it('restores topology and attachment refs while preserving uncaptured exact bodies', async () => {
    const sourceChatId = 'undo-delete'
    const graph = await importGraph([
      sourceMessage(sourceChatId, 'P', { role: 'user', createdAt: 1 }),
      sourceMessage(sourceChatId, 'U', {
        parentId: 'P',
        siblingIndex: 0,
        role: 'user',
        createdAt: 2,
      }),
      sourceMessage(sourceChatId, 'A', {
        parentId: 'P',
        siblingIndex: 2,
        role: 'assistant',
        createdAt: 3,
      }),
      sourceMessage(sourceChatId, 'S', {
        parentId: 'P',
        siblingIndex: 9,
        role: 'assistant',
        createdAt: 4,
      }),
      sourceMessage(sourceChatId, 'C', {
        parentId: 'A',
        role: 'user',
        createdAt: 5,
      }),
      sourceMessage(sourceChatId, 'G', {
        parentId: 'C',
        role: 'assistant',
        createdAt: 6,
      }),
    ])
    const attachment = await buildAttachment({
      blob: new Blob(['undo attachment']),
      filename: 'undo.txt',
      mime: 'text/plain',
      kind: 'plaintext',
    })
    await putAttachment(attachment)
    await execute({
      kind: 'message.edit-body',
      input: {
        chatId: graph.chat.id,
        messageId: graph.id('C'),
        content: [{ type: 'text', text: 'attached child' }],
        attachmentRefs: [
          {
            refId: 'undo-ref',
            attachmentId: attachment.id,
            includeInContext: true,
            presentation: {},
            createdAt: 7,
            updatedAt: 7,
          },
        ],
        now: 7,
      },
    })

    const result = (
      await execute({
        kind: 'message.delete',
        mode: 'single',
        input: {
          chatId: graph.chat.id,
          messageId: graph.id('A'),
          activeLeafId: graph.id('G'),
        },
      })
    ).value
    expect(new Set(result.preImage.previousRows.map((row) => row.id))).toEqual(
      new Set([graph.id('S'), graph.id('A'), graph.id('C')]),
    )
    expect(result.preImage.previousRows.some((row) => row.id === graph.id('U'))).toBe(false)
    expect(result.preImage.previousRows.some((row) => row.id === graph.id('G'))).toBe(false)
    expect(result.preImage.attachmentIds).toEqual([attachment.id])
    expect(
      (await query({ kind: 'attachment.get', attachmentId: attachment.id })).value?.refCount,
    ).toBe(1)

    await execute({
      kind: 'message.edit-body',
      input: {
        chatId: graph.chat.id,
        messageId: graph.id('G'),
        content: [{ type: 'text', text: 'changed after delete' }],
        now: 8,
      },
    })
    await execute({
      kind: 'message.edit-body',
      input: {
        chatId: graph.chat.id,
        messageId: graph.id('U'),
        content: [{ type: 'text', text: 'uncaptured edit' }],
        now: 9,
      },
    })
    const restored = (
      await execute({
        kind: 'message.restore-structure',
        input: { snapshot: result.preImage },
      })
    ).value

    expect(restored.destination.proof.pathHeaders.map((header) => header.id)).toEqual([
      graph.id('P'),
      graph.id('A'),
      graph.id('C'),
      graph.id('G'),
    ])
    expect(restored.destination.presentations).toEqual([])
    expect((await getHeader(graph.id('A')))?.deleted).toBe(false)
    expect((await getHeader(graph.id('C')))?.parentId).toBe(graph.id('A'))
    expect((await getMessage(graph.id('G')))?.content).toEqual([
      { type: 'text', text: 'changed after delete' },
    ])
    expect((await getMessage(graph.id('U')))?.content).toEqual([
      { type: 'text', text: 'uncaptured edit' },
    ])
    expect(
      (await query({ kind: 'attachment.get', attachmentId: attachment.id })).value?.refCount,
    ).toBe(1)
  })

  it('rejects undo after a captured row changes in another operation', async () => {
    const chat = await seedChat()
    const [target, child] = await appendLinear(chat.id, [
      { id: 'target', role: 'assistant' },
      { id: 'child', role: 'user' },
    ])
    const deletion = (
      await execute({
        kind: 'message.delete',
        mode: 'single',
        input: {
          chatId: chat.id,
          messageId: target?.id as MessageId,
          activeLeafId: child?.id as MessageId,
        },
      })
    ).value
    await execute({
      kind: 'message.edit-body',
      input: {
        chatId: chat.id,
        messageId: child?.id as MessageId,
        content: [{ type: 'text', text: 'changed concurrently' }],
        now: 3,
      },
    })

    await expect(
      execute({
        kind: 'message.restore-structure',
        input: { snapshot: deletion.preImage },
      }),
    ).rejects.toBeInstanceOf(TreeChangedError)
    expect((await getHeader(target?.id as MessageId))?.deleted).toBe(true)
    expect((await getHeader(child?.id as MessageId))?.parentId).toBeNull()
  })

  it('undoes an insert without overwriting its later body edit', async () => {
    const sourceChatId = 'undo-insert'
    const graph = await importGraph([
      sourceMessage(sourceChatId, 'P', { role: 'user', createdAt: 1 }),
      sourceMessage(sourceChatId, 'U', {
        parentId: 'P',
        siblingIndex: 0,
        createdAt: 2,
      }),
      sourceMessage(sourceChatId, 'C', {
        parentId: 'P',
        siblingIndex: 7,
        role: 'assistant',
        createdAt: 3,
      }),
    ])
    const previousRows = await snapshotRows(graph.chat.id, [graph.id('C')])
    const inserted = (
      await execute({
        kind: 'message.insert-between',
        input: {
          chatId: graph.chat.id,
          parentId: graph.id('P'),
          childId: graph.id('C'),
          content: [{ type: 'text', text: 'inserted' }],
          role: 'assistant',
          now: 4,
        },
      })
    ).value
    await execute({
      kind: 'message.edit-body',
      input: {
        chatId: graph.chat.id,
        messageId: inserted.messageId,
        content: [{ type: 'text', text: 'edited after insertion' }],
        now: 5,
      },
    })
    const snapshot: StructuralSnapshot = {
      chatId: graph.chat.id,
      selectedTipId: graph.id('C'),
      previousRows,
      newMessageIds: [inserted.messageId],
      attachmentIds: [],
    }
    const restored = (
      await execute({
        kind: 'message.restore-structure',
        input: { snapshot },
      })
    ).value

    expect(await getMessage(inserted.messageId)).toMatchObject({
      deleted: true,
      content: [{ type: 'text', text: 'edited after insertion' }],
    })
    expect((await getHeader(graph.id('C')))?.parentId).toBe(graph.id('P'))
    expect(restored.destination.proof.pathHeaders.map((header) => header.id)).toEqual([
      graph.id('P'),
      graph.id('C'),
    ])
    expect(restored.destination.presentations).toEqual([])
    const siblings = await getChildren(graph.chat.id, graph.id('P'))
    expect(new Set(siblings.map((header) => header.siblingIndex)).size).toBe(siblings.length)
  })

  it('keeps restore header work linear and exact-body reads bounded', async () => {
    const sourceChatId = 'linear-restore'
    const peerCount = 96
    const sourceRows: Message[] = [sourceMessage(sourceChatId, 'P', { role: 'user', createdAt: 1 })]
    for (let index = 0; index < peerCount; index += 1) {
      sourceRows.push(
        sourceMessage(sourceChatId, `peer-${index}`, {
          parentId: 'P',
          siblingIndex: index * 3,
          turnId: 'shared-turn',
          role: 'assistant',
          createdAt: index + 2,
        }),
      )
    }
    const graph = await importGraph(sourceRows)
    const peerIds = Array.from({ length: peerCount }, (_, index) => graph.id(`peer-${index}`))
    const previousRows = await snapshotRows(graph.chat.id, peerIds)
    const inserted = (
      await execute({
        kind: 'message.insert-between',
        input: {
          chatId: graph.chat.id,
          parentId: graph.id('P'),
          childId: peerIds[0] as MessageId,
          content: [{ type: 'text', text: 'inserted' }],
          role: 'assistant',
          now: 200,
        },
      })
    ).value
    const restoreTargetIds = [...peerIds, inserted.messageId]
    const restoreTargets = await readTestMessageHeaders(restoreTargetIds)
    expect(restoreTargetIds.filter((_, index) => restoreTargets[index] === undefined)).toEqual([])

    let headerReads = 0
    let headerWrites = 0
    let bodyReads = 0
    const readHeader = (row: unknown) => {
      headerReads += 1
      return row
    }
    const updateHeader = () => {
      headerWrites += 1
    }
    const createHeader = () => {
      headerWrites += 1
    }
    const readBody = (row: unknown) => {
      bodyReads += 1
      return row
    }
    getDb().messages.hook('reading', readHeader as never)
    getDb().messages.hook('updating', updateHeader as never)
    getDb().messages.hook('creating', createHeader as never)
    getDb().messageBodies.hook('reading', readBody as never)
    try {
      await execute({
        kind: 'message.restore-structure',
        input: {
          snapshot: {
            chatId: graph.chat.id,
            selectedTipId: peerIds[0] as MessageId,
            previousRows,
            newMessageIds: [inserted.messageId],
            attachmentIds: [],
          },
        },
      })
    } finally {
      getDb()
        .messages.hook('reading')
        .unsubscribe(readHeader as never)
      getDb()
        .messages.hook('updating')
        .unsubscribe(updateHeader as never)
      getDb()
        .messages.hook('creating')
        .unsubscribe(createHeader as never)
      getDb()
        .messageBodies.hook('reading')
        .unsubscribe(readBody as never)
    }

    const rowCount = peerCount + 2
    expect(headerReads).toBeLessThanOrEqual(rowCount * 16)
    expect(headerWrites).toBeLessThanOrEqual(rowCount * 3)
    expect(bodyReads).toBeLessThanOrEqual(1)
    expect((await getHeader(inserted.messageId))?.deleted).toBe(true)
    expect(
      (await getChildren(graph.chat.id, graph.id('P'))).filter((row) => !row.deleted),
    ).toHaveLength(peerCount)
  })
})

describe('message import placement', () => {
  it('appends a multi-message chain and returns its selected tail material', async () => {
    const chat = await seedChat()
    const root = (await appendLinear(chat.id, [{ id: 'root' }]))[0] as Message
    const result = (
      await execute({
        kind: 'message.import',
        input: {
          chatId: chat.id,
          slot: { kind: 'at-end' },
          activeLeafId: root.id,
          messages: [
            { role: 'assistant', content: [{ type: 'text', text: 'A' }] },
            { role: 'user', content: [{ type: 'text', text: 'B' }] },
          ],
          now: 5,
        },
      })
    ).value
    const [firstId, secondId] = result.newMessageIds as [MessageId, MessageId]

    expect(await getMessage(firstId)).toMatchObject({ parentId: root.id, origin: 'imported' })
    expect(await getMessage(secondId)).toMatchObject({ parentId: firstId, origin: 'imported' })
    expect(result.insertedTailId).toBe(secondId)
    expect(result.effects.newMessageIds).toEqual([firstId, secondId])
    expect(result.presentations.map((entry) => entry.message.id)).toEqual([firstId, secondId])
  })

  it('inserts one chain before every peer in the selected turn and leaves other variants alone', async () => {
    const sourceChatId = 'paste-before'
    const graph = await importGraph([
      sourceMessage(sourceChatId, 'P', { role: 'user', createdAt: 1 }),
      sourceMessage(sourceChatId, 'C1', {
        parentId: 'P',
        siblingIndex: 0,
        turnId: 'target-turn',
        role: 'assistant',
        createdAt: 2,
      }),
      sourceMessage(sourceChatId, 'C2', {
        parentId: 'P',
        siblingIndex: 1,
        turnId: 'target-turn',
        role: 'assistant',
        createdAt: 3,
      }),
      sourceMessage(sourceChatId, 'V', {
        parentId: 'P',
        siblingIndex: 2,
        turnId: 'variant-turn',
        role: 'assistant',
        createdAt: 4,
      }),
    ])
    const result = (
      await execute({
        kind: 'message.import',
        input: {
          chatId: graph.chat.id,
          slot: { kind: 'before', messageId: graph.id('C1') },
          activeLeafId: graph.id('C1'),
          messages: [
            { role: 'assistant', content: [{ type: 'text', text: 'X1' }] },
            { role: 'user', content: [{ type: 'text', text: 'X2' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'X3' }] },
          ],
          now: 5,
        },
      })
    ).value
    const [x1, x2, x3] = result.newMessageIds as [MessageId, MessageId, MessageId]

    expect((await getHeader(x1))?.parentId).toBe(graph.id('P'))
    expect((await getHeader(x2))?.parentId).toBe(x1)
    expect((await getHeader(x3))?.parentId).toBe(x2)
    expect((await getHeader(graph.id('C1')))?.parentId).toBe(x3)
    expect((await getHeader(graph.id('C2')))?.parentId).toBe(x3)
    expect((await getHeader(graph.id('V')))?.parentId).toBe(graph.id('P'))
    expect(result.effects.reparented).toEqual([
      { id: graph.id('C1'), previousParentId: graph.id('P'), newParentId: x3 },
      { id: graph.id('C2'), previousParentId: graph.id('P'), newParentId: x3 },
    ])
    expect(result.insertedTailId).toBe(x3)
  })

  it('inserts after a selected child but appends normally after a leaf', async () => {
    const chat = await seedChat()
    const [parent, selectedChild] = await appendLinear(chat.id, [
      { id: 'parent' },
      { id: 'selected-child', role: 'assistant' },
    ])
    const parentId = parent?.id as MessageId
    const selectedChildId = selectedChild?.id as MessageId
    const between = (
      await execute({
        kind: 'message.import',
        input: {
          chatId: chat.id,
          slot: { kind: 'after', messageId: parentId },
          activeLeafId: selectedChildId,
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'between' }] }],
          now: 3,
        },
      })
    ).value
    const inserted = between.newMessageIds[0] as MessageId
    expect((await getHeader(inserted))?.parentId).toBe(parentId)
    expect((await getHeader(selectedChildId))?.parentId).toBe(inserted)
    expect(between.destination.proof.tipId).toBe(selectedChildId)

    const appended = (
      await execute({
        kind: 'message.import',
        input: {
          chatId: chat.id,
          slot: { kind: 'after', messageId: selectedChildId },
          activeLeafId: selectedChildId,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'leaf child' }] }],
          now: 4,
        },
      })
    ).value
    expect((await getHeader(appended.newMessageIds[0] as MessageId))?.parentId).toBe(
      selectedChildId,
    )
  })

  it('moves every live child under one shared chain while preserving tombstones and descendants', async () => {
    const sourceChatId = 'paste-shared'
    const graph = await importGraph([
      sourceMessage(sourceChatId, 'P', { role: 'user', createdAt: 1 }),
      sourceMessage(sourceChatId, 'V', {
        parentId: 'P',
        siblingIndex: 0,
        turnId: 'variant',
        role: 'assistant',
        createdAt: 2,
      }),
      sourceMessage(sourceChatId, 'C2', {
        parentId: 'P',
        siblingIndex: 2,
        turnId: 'shared',
        role: 'assistant',
        createdAt: 3,
      }),
      sourceMessage(sourceChatId, 'C1', {
        parentId: 'P',
        siblingIndex: 3,
        turnId: 'shared',
        role: 'assistant',
        createdAt: 4,
      }),
      sourceMessage(sourceChatId, 'T', {
        parentId: 'P',
        siblingIndex: 9,
        deleted: true,
        createdAt: 5,
      }),
      sourceMessage(sourceChatId, 'G', {
        parentId: 'C1',
        role: 'user',
        createdAt: 6,
      }),
    ])
    const attachment = await buildAttachment({
      blob: new Blob(['shared attachment']),
      filename: 'shared.txt',
      mime: 'text/plain',
      kind: 'plaintext',
    })
    await putAttachment(attachment)
    const result = (
      await execute({
        kind: 'message.import',
        input: {
          chatId: graph.chat.id,
          slot: { kind: 'after-all', parentId: graph.id('P') },
          activeLeafId: graph.id('C2'),
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'X1' }],
              attachmentRefs: [attachment.id],
            },
            { role: 'user', content: [{ type: 'text', text: 'X2' }] },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'X3' }],
              attachmentRefs: [attachment.id],
            },
          ],
          now: 10,
        },
      })
    ).value
    const [x1, x2, x3] = result.newMessageIds as [MessageId, MessageId, MessageId]

    expect((await getHeader(x1))?.parentId).toBe(graph.id('P'))
    expect((await getHeader(x1))?.siblingIndex).toBe(10)
    expect((await getHeader(x2))?.parentId).toBe(x1)
    expect((await getHeader(x3))?.parentId).toBe(x2)
    for (const [sourceId, index] of [
      ['V', 0],
      ['C2', 1],
      ['C1', 2],
    ] as const) {
      expect(await getHeader(graph.id(sourceId))).toMatchObject({
        parentId: x3,
        siblingIndex: index,
      })
    }
    expect((await getHeader(graph.id('T')))?.parentId).toBe(graph.id('P'))
    expect((await getHeader(graph.id('G')))?.parentId).toBe(graph.id('C1'))
    expect(
      (await query({ kind: 'attachment.get', attachmentId: attachment.id })).value?.refCount,
    ).toBe(2)
    expect(result.effects.reparented.map((effect) => effect.id)).toEqual([
      graph.id('V'),
      graph.id('C2'),
      graph.id('C1'),
    ])
  })

  it('appends a shared chain normally when its slot has no live children', async () => {
    const sourceChatId = 'paste-empty-shared-slot'
    const graph = await importGraph([
      sourceMessage(sourceChatId, 'P', { role: 'user', createdAt: 1 }),
      sourceMessage(sourceChatId, 'T', {
        parentId: 'P',
        siblingIndex: 7,
        deleted: true,
        createdAt: 2,
      }),
    ])
    const result = (
      await execute({
        kind: 'message.import',
        input: {
          chatId: graph.chat.id,
          slot: { kind: 'after-all', parentId: graph.id('P') },
          activeLeafId: graph.id('P'),
          messages: [
            { role: 'assistant', content: [{ type: 'text', text: 'X1' }] },
            { role: 'user', content: [{ type: 'text', text: 'X2' }] },
          ],
          now: 5,
        },
      })
    ).value
    const [x1, x2] = result.newMessageIds as [MessageId, MessageId]

    expect(await getHeader(x1)).toMatchObject({ parentId: graph.id('P'), siblingIndex: 8 })
    expect((await getHeader(x2))?.parentId).toBe(x1)
    expect(await getHeader(graph.id('T'))).toMatchObject({
      parentId: graph.id('P'),
      siblingIndex: 7,
      deleted: true,
    })
    expect(result.effects.reparented).toEqual([])
    expect(result.insertedTailId).toBe(x2)
  })

  it('supports the virtual root and serializes a shared-trunk race without partial commits', async () => {
    const sourceChatId = 'paste-root'
    const graph = await importGraph([
      sourceMessage(sourceChatId, 'R2', { siblingIndex: 1, createdAt: 20 }),
      sourceMessage(sourceChatId, 'R1', { siblingIndex: 5, createdAt: 1 }),
      sourceMessage(sourceChatId, 'R1L', { parentId: 'R1', createdAt: 100 }),
      sourceMessage(sourceChatId, 'RT', { siblingIndex: 9, createdAt: 200, deleted: true }),
    ])
    const rootResult = (
      await execute({
        kind: 'message.import',
        input: {
          chatId: graph.chat.id,
          slot: { kind: 'after-all', parentId: null },
          activeLeafId: graph.id('R1L'),
          messages: [
            { role: 'system', content: [{ type: 'text', text: 'X1' }] },
            { role: 'user', content: [{ type: 'text', text: 'X2' }] },
          ],
          now: 300,
        },
      })
    ).value
    const [x1, x2] = rootResult.newMessageIds as [MessageId, MessageId]
    expect((await getHeader(x1))?.parentId).toBeNull()
    expect((await getHeader(x1))?.siblingIndex).toBe(10)
    expect((await getHeader(x2))?.parentId).toBe(x1)
    expect((await getHeader(graph.id('R2')))?.parentId).toBe(x2)
    expect((await getHeader(graph.id('R1')))?.parentId).toBe(x2)
    expect((await getHeader(graph.id('R1L')))?.parentId).toBe(graph.id('R1'))
    expect((await getHeader(graph.id('RT')))?.parentId).toBeNull()

    const parent = graph.id('R1')
    const command = (text: string) =>
      execute({
        kind: 'message.import' as const,
        input: {
          chatId: graph.chat.id,
          slot: { kind: 'after-all' as const, parentId: parent },
          activeLeafId: graph.id('R1L'),
          messages: [{ role: 'assistant' as const, content: [{ type: 'text' as const, text }] }],
          now: 400,
        },
      })
    const outcomes = await Promise.allSettled([command('race A'), command('race B')])
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(TreeChangedError)
    }
    const headers = await getHeaders(graph.chat.id)
    const importedRaceIds = new Set(
      fulfilled.flatMap((outcome) => outcome.value.value.newMessageIds),
    )
    const importedRaceRows = await Promise.all(
      headers
        .filter((header) => !header.deleted && importedRaceIds.has(header.id))
        .map((header) => getMessage(header.id)),
    )
    expect(importedRaceRows.filter(Boolean)).toHaveLength(fulfilled.length)
    expect(new Set(headers.map((header) => header.id)).size).toBe(headers.length)
  })
})

describe('committed structural selection contract', () => {
  it.each([
    {
      name: 'paste',
      async run(chatId: ChatId, rootId: MessageId, leafId: MessageId) {
        const result = (
          await execute({
            kind: 'message.import',
            input: {
              chatId,
              slot: { kind: 'at-end' },
              activeLeafId: leafId,
              messages: [{ role: 'user', content: [{ type: 'text', text: 'new tail' }] }],
              now: 3,
            },
          })
        ).value
        return {
          selection: result.destination,
          expectedPath: [rootId, leafId, result.newMessageIds[0] as MessageId],
          presentationLimit: 1,
        }
      },
    },
    {
      name: 'delete',
      async run(chatId: ChatId, rootId: MessageId, leafId: MessageId) {
        const result = (
          await execute({
            kind: 'message.delete',
            mode: 'single',
            input: { chatId, messageId: leafId, activeLeafId: leafId, now: 3 },
          })
        ).value
        return {
          selection: result.destination,
          expectedPath: [rootId],
          presentationLimit: 0,
        }
      },
    },
    {
      name: 'undo',
      async run(chatId: ChatId, rootId: MessageId, leafId: MessageId) {
        const deleted = (
          await execute({
            kind: 'message.delete',
            mode: 'single',
            input: { chatId, messageId: leafId, activeLeafId: leafId, now: 3 },
          })
        ).value
        const restored = (
          await execute({
            kind: 'message.restore-structure',
            input: { snapshot: deleted.preImage },
          })
        ).value
        return {
          selection: restored.destination,
          expectedPath: [rootId, leafId],
          presentationLimit: 0,
        }
      },
    },
  ])('returns one exact path/fork proof for $name', async ({ run }) => {
    const chat = await seedChat()
    const [root, leaf] = await appendLinear(chat.id, [
      { id: `root-${newId()}` },
      { id: `leaf-${newId()}`, role: 'assistant' },
    ])
    if (!root || !leaf) throw new Error('SelectionFixtureMissing')
    const result = await run(chat.id, root.id, leaf.id)
    const selection = result.selection
    expect(selection.proof.pathHeaders.map((header) => header.id)).toEqual(result.expectedPath)
    expect(selection.proof.tipId).toBe(result.expectedPath.at(-1) ?? null)
    expect(
      selection.proof.pathHeaders.every(
        (header, index) => header.parentId === (selection.proof.pathHeaders[index - 1]?.id ?? null),
      ),
    ).toBe(true)
    expect(selection.presentations).toHaveLength(result.presentationLimit)
    if (result.presentationLimit > 0) {
      expect(selection.presentations.map((row) => row.header.id)).toContain(selection.proof.tipId)
    }
    if (selection.proof.tipId) {
      expect(await getPresentation(selection.proof.tipId)).toBeDefined()
    }
  })
})

describe('structural safety and pure linear helpers', () => {
  it('serializes concurrent sibling inserts without torn indices or cycles', async () => {
    const chat = await seedChat()
    const [root, child] = await appendLinear(chat.id, [
      { id: 'root' },
      { id: 'child', role: 'assistant' },
    ])
    const [left, right] = await Promise.all([
      execute({
        kind: 'message.insert-sibling',
        input: {
          chatId: chat.id,
          targetId: child?.id as MessageId,
          content: [{ type: 'text', text: 'left' }],
          now: 10,
        },
      }),
      execute({
        kind: 'message.insert-sibling',
        input: {
          chatId: chat.id,
          targetId: child?.id as MessageId,
          content: [{ type: 'text', text: 'right' }],
          now: 11,
        },
      }),
    ])
    expect(left.value.messageId).not.toBe(right.value.messageId)
    const siblings = (await getChildren(chat.id, root?.id as MessageId)).filter(
      (header) => !header.deleted,
    )
    expect(new Set(siblings.map((header) => header.siblingIndex)).size).toBe(siblings.length)

    const rows = await getHeaders(chat.id)
    const byId = new Map(rows.map((row) => [row.id, row] as const))
    for (const row of rows) {
      const seen = new Set<MessageId>()
      let current: MessageId | null = row.id
      while (current !== null) {
        expect(seen.has(current)).toBe(false)
        seen.add(current)
        current = byId.get(current)?.parentId ?? null
      }
    }
  })

  it('path-compresses a deep deleted ancestor chain to linear total work', () => {
    const length = 16_384
    const rows = Array.from({ length }, (_, index) => ({
      id: `deleted-${index}`,
      parentId: index === 0 ? null : `deleted-${index - 1}`,
    }))
    const byId = new Map(rows.map((row) => [row.id, row]))
    const excluded = new Set(rows.map((row) => row.id))
    let visits = 0
    const resolve = createAncestorOutsideSetResolver(byId, excluded, () => {
      visits += 1
    })

    for (const row of rows) expect(resolve(row)).toBeNull()
    expect(visits).toBeLessThanOrEqual(length)
  })
})
