import Dexie from 'dexie'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildBranchMessages } from '../../src/core/branch-flatten'
import { computeBranchTitle } from '../../src/core/chat-fork'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  type ChatExportEnvelope,
  NATTER_EXPORT_SCHEMA_VERSION,
} from '../../src/core/import-export/schema'
import { plaintextOf, writeTextInto } from '../../src/core/message-content'
import {
  fixedConversationSelectionTarget,
  type StructuralSnapshotRow,
} from '../../src/core/messages'
import type {
  Attachment,
  Chat,
  ChatId,
  ContinuationAttempt,
  Message,
  MessageAttachmentRef,
  MessageId,
} from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { putAttachment } from '../../src/store/attachments'
import { __resetBroadcastForTests, subscribeWorkspaceChanges } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { __resetDbForTests, CURRENT_DB_VERSION, getDb } from '../../src/store/db'
import { exportWorkspaceBackup, restoreWorkspaceBackup } from '../../src/store/import-export'
import { __setLockBackendForTests } from '../../src/store/locks'
import type { MessageHeaderRow } from '../../src/store/message-storage'
import {
  subscribeWorkspaceEffects,
  WORKSPACE_EFFECT_RECOVERY_OWNED,
  type WorkspaceEffect,
} from '../../src/store/workspace-effect-hub'
import type {
  CommitEnvelope,
  ReadEnvelope,
  WorkspaceChange,
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
import { expectAttachmentReferenceInvariants } from '../helpers/attachment-reference-invariants'
import { putTestChat } from '../helpers/chats'
import { executeMessageCommand } from '../helpers/message-commands'
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
): Promise<CommitEnvelope<WorkspaceCommandResult<C>>> {
  return runWorkspaceAction('maintenance', (permit) =>
    getWorkspaceRepository().execute(permit, command),
  )
}

async function seedChat(title = 'Source', overrides: Partial<Chat> = {}): Promise<Chat> {
  const chat: Chat = {
    id: newId(),
    title,
    titleStatus: 'manual',
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
  await putTestMessages([{ ...row, parentId: expectedLeafId }])
}

async function getChat(chatId: ChatId): Promise<Chat | undefined> {
  return (await query({ kind: 'chat.get', chatId })).value
}

async function getMessage(messageId: MessageId): Promise<Message | undefined> {
  return (await query({ kind: 'message.presentation', messageId })).value?.message
}

async function getHeader(messageId: MessageId): Promise<MessageHeaderRow | undefined> {
  return readTestMessageHeader(messageId)
}

async function getMessages(chatId: ChatId): Promise<Message[]> {
  const topology = (await query({ kind: 'message.headers-by-chat', chatId })).value
  if (topology.kind === 'missing') return []
  if (topology.kind === 'stale') throw new Error(`TestConversationTopologyStale:${chatId}`)
  const headers = topology.headers
  const presentations = (
    await query({ kind: 'message.presentations', messageIds: headers.map((header) => header.id) })
  ).value
  return presentations.flatMap((presentation) => (presentation ? [presentation.message] : []))
}

async function getAttachment(attachmentId: string): Promise<Attachment | undefined> {
  return (await query({ kind: 'attachment.get', attachmentId })).value
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

async function importGraph(sourceMessages: readonly Message[]): Promise<ImportedGraph> {
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
        title: 'Imported source',
        createdAt: 1,
        updatedAt: 100,
        settings: cloneDefaultChatSettings(),
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
  const topology = (await query({ kind: 'message.headers-by-chat', chatId: result.chatId })).value
  if (topology.kind !== 'ready') throw new Error(`ImportedTopologyUnavailable:${result.chatId}`)
  if (
    result.destination.chat.id !== result.chatId ||
    result.destination.proof.chatId !== result.chatId ||
    result.destination.proof.structuralVersion !== chat.structuralVersion
  ) {
    throw new Error(`ImportedDestinationInvalid:${result.chatId}`)
  }
  const importedIdBySourceId = mapImportedMessageIds(sourceMessages, topology.headers)
  return {
    chat,
    id: (sourceId) => {
      const mapped = importedIdBySourceId.get(sourceId)
      if (!mapped) throw new Error(`ImportedMessageMissing:${sourceId}`)
      return mapped
    },
  }
}

function mapImportedMessageIds(
  sourceMessages: readonly Message[],
  importedHeaders: readonly MessageHeaderRow[],
): ReadonlyMap<MessageId, MessageId> {
  const importedIdBySourceId = new Map<MessageId, MessageId>()
  const pending = [...sourceMessages]
  while (pending.length > 0) {
    let progressed = false
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const source = pending[index] as Message
      const importedParentId =
        source.parentId === null ? null : importedIdBySourceId.get(source.parentId)
      if (source.parentId !== null && importedParentId === undefined) continue
      const matches = importedHeaders.filter(
        (header) =>
          header.parentId === importedParentId &&
          header.siblingIndex === source.siblingIndex &&
          header.createdAt === source.createdAt &&
          header.role === source.role,
      )
      if (matches.length !== 1) throw new Error(`ImportedMessageMappingAmbiguous:${source.id}`)
      importedIdBySourceId.set(source.id, (matches[0] as MessageHeaderRow).id)
      pending.splice(index, 1)
      progressed = true
    }
    if (!progressed) throw new Error('ImportedMessageMappingIncomplete')
  }
  return importedIdBySourceId
}

function sourceMessage(chatId: ChatId, id: MessageId, overrides: Partial<Message> = {}): Message {
  return message(chatId, { id, ...overrides })
}

function missingAttachment(id: string): Attachment {
  return {
    id,
    kind: 'plaintext',
    mime: 'text/plain',
    filename: `${id}.txt`,
    sizeBytes: 0,
    origin: 'user-upload',
    createdAt: 1,
    updatedAt: 1,
    storage: { kind: 'missing', reason: 'import-missing', missingSince: 1 },
    artifacts: [],
    processing: [],
    refCount: 0,
  }
}

function attachmentRef(
  refId: string,
  attachmentId: string,
  deletedAt?: number,
): MessageAttachmentRef {
  return {
    refId,
    attachmentId,
    includeInContext: true,
    presentation: { label: refId },
    createdAt: 1,
    updatedAt: 1,
    ...(deletedAt === undefined ? {} : { deletedAt }),
  }
}

describe('fork title and ancestry helpers', () => {
  it.each([
    ['Design review', [], 'Design review Branch 1'],
    ['', [], 'Untitled chat Branch 1'],
    ['   ', [], 'Untitled chat Branch 1'],
    [
      'Design review',
      ['Design review', 'Design review Branch 1', 'Design review Branch 2'],
      'Design review Branch 3',
    ],
    ['Notes', ['Notes', 'Notes Branch 3'], 'Notes Branch 1'],
  ] as const)('chooses the first unused title for %j', (base, existing, expected) => {
    expect(computeBranchTitle(base, existing)).toBe(expected)
  })

  it('collects root-to-target only, excluding siblings and descendants', () => {
    const chatId = 'ancestry'
    const rows = [
      sourceMessage(chatId, 'R', { createdAt: 1 }),
      sourceMessage(chatId, 'A', { parentId: 'R', role: 'assistant', createdAt: 2 }),
      sourceMessage(chatId, 'A2', {
        parentId: 'R',
        siblingIndex: 1,
        role: 'assistant',
        createdAt: 3,
      }),
      sourceMessage(chatId, 'U2', { parentId: 'A', role: 'user', createdAt: 4 }),
      sourceMessage(chatId, 'A3', { parentId: 'U2', role: 'assistant', createdAt: 5 }),
    ]
    expect(buildBranchMessages(rows, 'U2').map((row) => row.id)).toEqual(['R', 'A', 'U2'])
  })
})

describe('public chat fork command', () => {
  it('copies only the selected ancestry with fresh tree identity and leaves the source untouched', async () => {
    const sourceChatId = 'fork-path'
    const graph = await importGraph([
      sourceMessage(sourceChatId, 'R', {
        createdAt: 1,
        content: [{ type: 'text', text: 'root' }],
      }),
      sourceMessage(sourceChatId, 'A', {
        parentId: 'R',
        role: 'assistant',
        createdAt: 2,
        content: [{ type: 'text', text: 'selected answer' }],
      }),
      sourceMessage(sourceChatId, 'A2', {
        parentId: 'R',
        siblingIndex: 1,
        role: 'assistant',
        createdAt: 3,
        content: [{ type: 'text', text: 'sibling answer' }],
      }),
      sourceMessage(sourceChatId, 'U2', {
        parentId: 'A',
        role: 'user',
        createdAt: 4,
        content: [{ type: 'text', text: 'descendant' }],
      }),
    ])
    const sourceBefore = await getMessages(graph.chat.id)
    const commit = await execute({
      kind: 'chat.fork',
      input: {
        chatId: graph.chat.id,
        messageId: graph.id('A'),
        title: 'Design review Branch 1',
        now: 1_000,
      },
    })
    const fork = await getChat(commit.value.chatId)
    const forkMessages = (await getMessages(commit.value.chatId)).sort(
      (left, right) => left.createdAt - right.createdAt,
    )

    expect(commit.value.messageCount).toBe(2)
    expect(commit.value.destination.proof.tipId).toBe(forkMessages.at(-1)?.id)
    expect(commit.value.destination.proof.pathHeaders.map((row) => row.id)).toEqual(
      forkMessages.map((row) => row.id),
    )
    const forkSlots = (
      await query({
        kind: 'branch.forks',
        chatId: commit.value.chatId,
        structuralVersion: commit.value.destination.proof.structuralVersion,
        targets: commit.value.destination.proof.pathHeaders.map((header) => ({
          parentId: header.parentId,
          selectedMessageId: header.id,
        })),
      })
    ).value
    expect(forkSlots.kind).toBe('ready')
    if (forkSlots.kind !== 'ready') throw new Error('ForkSelectionBecameStale')
    expect(forkSlots.forks.map((slot) => slot.liveCount)).toEqual([1, 1])
    expect(commit.value.destination.presentations.map((row) => row.message.id)).toEqual([
      forkMessages.at(-1)?.id,
    ])
    expect(fork).toMatchObject({
      title: 'Design review Branch 1',
      titleStatus: 'manual',
      previewText: 'root',
    })
    expect(forkMessages.map((row) => row.role)).toEqual(['user', 'assistant'])
    expect(forkMessages.map((row) => plaintextOf(row.content))).toEqual(['root', 'selected answer'])
    const sourceIds = new Set(sourceBefore.map((row) => row.id))
    expect(forkMessages.some((row) => sourceIds.has(row.id))).toBe(false)
    expect(forkMessages[0]?.parentId).toBeNull()
    expect(forkMessages[1]?.parentId).toBe(forkMessages[0]?.id)
    expect(forkMessages.every((row) => row.siblingIndex === 0)).toBe(true)
    expect(await getMessages(graph.chat.id)).toEqual(sourceBefore)
  })

  it('maps source turn identity one-to-one and preserves every turnIndex', async () => {
    const sourceChatId = 'fork-turns'
    const graph = await importGraph([
      sourceMessage(sourceChatId, 'U', {
        role: 'user',
        turnId: 'user-turn',
        turnIndex: 0,
        createdAt: 1,
      }),
      sourceMessage(sourceChatId, 'A', {
        parentId: 'U',
        role: 'assistant',
        turnId: 'tool-turn',
        turnIndex: 0,
        createdAt: 2,
      }),
      sourceMessage(sourceChatId, 'T', {
        parentId: 'A',
        role: 'tool',
        turnId: 'tool-turn',
        turnIndex: 1,
        createdAt: 3,
      }),
      sourceMessage(sourceChatId, 'A2', {
        parentId: 'T',
        role: 'assistant',
        turnId: 'tool-turn',
        turnIndex: 2,
        createdAt: 4,
      }),
    ])
    const sourceRows = (await getMessages(graph.chat.id)).sort(
      (left, right) => left.createdAt - right.createdAt,
    )
    expect(sourceRows.map((row) => row.turnIndex)).toEqual([0, 0, 1, 2])
    expect(new Set(sourceRows.slice(1).map((row) => row.turnId)).size).toBe(1)
    const result = (
      await execute({
        kind: 'chat.fork',
        input: {
          chatId: graph.chat.id,
          messageId: graph.id('A2'),
          title: 'Turn-preserving fork',
          now: 1_000,
        },
      })
    ).value
    const forkRows = (await getMessages(result.chatId)).sort(
      (left, right) => left.createdAt - right.createdAt,
    )

    expect(forkRows.map((row) => row.turnIndex)).toEqual([0, 0, 1, 2])
    expect(new Set(forkRows.slice(1).map((row) => row.turnId)).size).toBe(1)
    expect(forkRows[1]?.turnId).not.toBe(sourceRows[1]?.turnId)
    expect(forkRows[0]?.turnId).not.toBe(forkRows[1]?.turnId)
  })

  it('preserves full message payloads, reconciles live refs, and publishes canonical projections once', async () => {
    const chat = await seedChat('Fidelity', { presetId: 'preset-1' })
    await putAttachment(missingAttachment('live-attachment'))
    await putAttachment(missingAttachment('dead-only'))
    const continuationAttempt: ContinuationAttempt = {
      streamId: 'continuation-1',
      strategy: 'prefill',
      status: 'done',
      requestedModel: 'requested-model',
      model: 'actual-model',
      apiUsed: 'responses',
      provider: 'provider-a',
      generationId: 'continuation-generation',
      startedAt: 3,
      finishedAt: 4,
      finishReason: 'stop',
      reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
        [
          {
            type: 'reasoning.summary',
            summary: 'continued thought',
            format: 'openai-responses-v1',
          },
          {
            type: 'reasoning.encrypted',
            data: 'opaque',
            format: 'openai-responses-v1',
          },
        ],
        'openai-responses',
      ),
      reasoningCarryForward: 'carrier',
      reasoningVisibility: { disclosure: 'visible', visibleKind: 'summary' },
      application: { kind: 'applied' },
      phase: 'final_answer',
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'reasoning',
          item: { id: 'continued-output', encrypted_content: 'opaque' },
        },
      ],
    }
    const source = message(chat.id, {
      id: 'full-source',
      turnId: 'source-turn',
      turnIndex: 2,
      createdAt: 2,
      editedAt: 5,
      role: 'assistant',
      origin: 'generated',
      generation: {
        id: 'generation-1',
        model: 'actual-model',
        requestedModel: 'requested-model',
        apiUsed: 'responses',
        delivery: 'streaming',
        costSource: 'stream',
        reasoningCarryForward: 'none',
        reasoningVisibility: { disclosure: 'visible', visibleKind: 'summary' },
        startedAt: 1,
        finishedAt: 2,
        cost: 0.25,
      },
      content: [{ type: 'output_text', text: 'complete answer' }],
      reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
        [
          {
            type: 'reasoning.summary',
            summary: 'private thought',
            format: 'openai-responses-v1',
          },
        ],
        'openai-responses',
      ),
      toolCalls: [
        { id: 'tool-1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
      refusal: 'preserved refusal',
      phase: 'final_answer',
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'message',
          outputIndex: 0,
          item: { type: 'message', id: 'output-1', unknown: { nested: true } },
        },
      ],
      continuationAttempts: [continuationAttempt],
      attachmentRefs: [
        attachmentRef('live-1', 'live-attachment'),
        attachmentRef('live-2', 'live-attachment'),
        attachmentRef('tombstoned-same', 'live-attachment', 9),
        attachmentRef('tombstoned-only', 'dead-only', 9),
      ],
      approval: { state: 'approved', approvedAt: 6, approvedBy: 'local-user' },
      pinCache: true,
      hiddenFromContext: true,
      originalCharCount: 12,
      originalTokenEstimate: 4,
      originalModelId: 'requested-model',
      originalCalibrationKey: 'calibration-family',
      charCountDelta: 3,
      cachedTokenEstimate: 5,
      cachedMediaTokens: 6,
    })
    await append(source, null)
    const storedSource = await getMessage(source.id)
    if (!storedSource) throw new Error('StoredSourceMissing')
    expect((await getAttachment('live-attachment'))?.refCount).toBe(2)
    expect((await getAttachment('dead-only'))?.refCount).toBe(0)

    const order: string[] = []
    const localEffects: WorkspaceEffect[] = []
    const changes: WorkspaceChange[] = []
    const unsubscribeLocal = subscribeWorkspaceEffects({
      owner: `phase-8-fork-${newId()}`,
      sources: ['local'],
      replacements: false,
      impactKinds: ['chat'],
      apply: (effect) => {
        order.push('local')
        localEffects.push(effect)
      },
      recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
    })
    const unsubscribeChanges = subscribeWorkspaceChanges((change) => {
      order.push('change')
      changes.push(change)
    })
    const now = 1_000
    const commit = await execute({
      kind: 'chat.fork',
      input: {
        chatId: chat.id,
        messageId: source.id,
        title: 'Fidelity Branch 1',
        now,
      },
    })
    order.push('resolved')
    unsubscribeChanges()
    unsubscribeLocal()

    const fork = await getChat(commit.value.chatId)
    const copied = (await getMessages(commit.value.chatId))[0]
    if (!copied) throw new Error('ForkCopyMissing')
    expect(fork).toMatchObject({
      title: 'Fidelity Branch 1',
      titleStatus: 'manual',
      presetId: 'preset-1',
      metaVersion: 0,
      summaryVersion: 1,
      lastUpdatedLeafId: copied.id,
      wordCount: 2,
      totalCostUsd: 0.25,
      previewText: '',
    })
    const expectedCopy = structuredClone(storedSource)
    expectedCopy.id = copied.id
    expectedCopy.chatId = commit.value.chatId
    expectedCopy.parentId = null
    expectedCopy.siblingIndex = 0
    expectedCopy.turnId = copied.turnId
    expectedCopy.createdAt = now - 1
    expectedCopy.editedAt = now
    expectedCopy.nodeVersion = 0
    expect(copied).toEqual(expectedCopy)
    expect(copied.id).not.toBe(storedSource.id)
    expect(copied.turnId).not.toBe(storedSource.turnId)
    expect(copied.turnIndex).toBe(storedSource.turnIndex)

    expect((await getAttachment('live-attachment'))?.refCount).toBe(4)
    expect((await getAttachment('dead-only'))?.refCount).toBe(0)
    const referenceRows = (
      await query({ kind: 'attachment.reference-rows', attachmentId: 'live-attachment' })
    ).value
    expect(referenceRows).toHaveLength(4)
    expect(new Set(referenceRows.map((row) => row.messageId))).toEqual(
      new Set([storedSource.id, copied.id]),
    )

    const opened = (
      await query({
        kind: 'branch.open',
        chatId: commit.value.chatId,
        target: fixedConversationSelectionTarget({ kind: 'tip', messageId: copied.id }, copied.id),
        bodyDemand: 'terminal',
      })
    ).value
    expect(opened.kind).toBe('ready')
    if (opened.kind !== 'ready') throw new Error('ForkDestinationUnavailable')
    const sidebarRow = (await query({ kind: 'sidebar.rows-by-id', chatIds: [commit.value.chatId] }))
      .value[0]
    expect(opened.proof.pathHeaders.map((header) => header.id)).toEqual([copied.id])
    expect(opened.presentations.map((row) => row.message.id)).toEqual([copied.id])
    expect(sidebarRow).toMatchObject({
      id: commit.value.chatId,
      lastUpdatedLeafId: copied.id,
      wordCount: 2,
      totalCostUsd: 0.25,
    })

    expect(commit.effectScope).toBe('workspace')
    expect(commit.commitId).toEqual(expect.any(String))
    expect(commit.receipt.chats).toEqual([])
    expect(commit.receipt.constructions.map((row) => row.id)).toEqual([commit.value.chatId])
    expect(commit.delta.facts).toContainEqual({
      kind: 'conversation-created',
      chatId: commit.value.chatId,
    })
    expect(
      commit.delta.invalidations.filter(
        (invalidation) => invalidation.kind === 'chat' || invalidation.kind === 'sidebar',
      ),
    ).toEqual([])
    expect(localEffects).toHaveLength(1)
    expect(localEffects[0]).toMatchObject({
      kind: 'changed',
      source: 'local',
      cause: 'commit',
      workspaceId: commit.workspaceId,
      replacementEpoch: commit.replacementEpoch,
      receipt: commit.receipt,
    })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.kind).toBe('commit')
    if (changes[0]?.kind !== 'commit') throw new Error('ExpectedCommitChange')
    expect(changes[0].stamp.commitId).toBe(commit.commitId)
    expect(changes[0].delta).toBe(commit.delta)
    expect(order).toEqual(['local', 'change', 'resolved'])
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('rolls back every destination projection and attachment edge on a failed fork', async () => {
    const chat = await seedChat('Rollback')
    await putAttachment(missingAttachment('rollback-attachment'))
    const source = message(chat.id, {
      id: 'rollback-source',
      content: [{ type: 'text', text: 'rollback source' }],
      attachmentRefs: [attachmentRef('rollback-ref', 'rollback-attachment')],
    })
    await append(source, null)
    const sourceBefore = await getMessage(source.id)
    const chatIdsBefore = (await getDb().chats.toArray()).map((row) => row.id).sort()
    expect((await getAttachment('rollback-attachment'))?.refCount).toBe(1)

    const failureCases = [
      { event: getDb().messageBodies.hook('creating'), message: 'body write failed' },
      { event: getDb().attachments.hook('updating'), message: 'refcount write failed' },
      { event: getDb().attachmentRefEdges.hook('creating'), message: 'edge write failed' },
    ]
    for (const failureCase of failureCases) {
      const fail = () => {
        throw new Error(failureCase.message)
      }
      failureCase.event.subscribe(fail)
      const changes: WorkspaceChange[] = []
      const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))
      await expect(
        execute({
          kind: 'chat.fork',
          input: {
            chatId: chat.id,
            messageId: source.id,
            title: 'Must Roll Back',
            now: 2_000,
          },
        }),
      ).rejects.toThrow(failureCase.message)
      unsubscribe()
      failureCase.event.unsubscribe(fail)

      expect((await getDb().chats.toArray()).map((row) => row.id).sort()).toEqual(chatIdsBefore)
      expect(await getMessage(source.id)).toEqual(sourceBefore)
      expect((await getAttachment('rollback-attachment'))?.refCount).toBe(1)
      expect(changes).toEqual([])
      await expectAttachmentReferenceInvariants(getDb())
    }
  })

  it('reads work proportional to ancestry depth, not unrelated branches', async () => {
    const sourceChatId = 'fork-performance'
    const pathLength = 8
    const rows: Message[] = []
    let parentId: MessageId | null = null
    for (let index = 0; index < pathLength; index += 1) {
      const id = `path-${index}`
      rows.push(
        sourceMessage(sourceChatId, id, {
          parentId,
          siblingIndex: 0,
          role: index % 2 === 0 ? 'user' : 'assistant',
          createdAt: index + 1,
        }),
      )
      parentId = id
    }
    for (let index = 0; index < 512; index += 1) {
      rows.push(
        sourceMessage(sourceChatId, `sibling-${index}`, {
          parentId: 'path-0',
          siblingIndex: index + 1,
          role: 'assistant',
          createdAt: pathLength + index + 1,
          content: [{ type: 'text', text: `unrelated ${'x'.repeat(256)}` }],
        }),
      )
    }
    const graph = await importGraph(rows)
    let headerReads = 0
    let bodyReads = 0
    const readHeader = (row: unknown) => {
      headerReads += 1
      return row
    }
    const readBody = (row: unknown) => {
      bodyReads += 1
      return row
    }
    getDb().messages.hook('reading', readHeader as never)
    getDb().messageBodies.hook('reading', readBody as never)
    let forkMessageCount: number | undefined
    try {
      const commit = await execute({
        kind: 'chat.fork',
        input: {
          chatId: graph.chat.id,
          messageId: graph.id(`path-${pathLength - 1}`),
          title: 'Bounded fork',
          now: 1_000,
        },
      })
      forkMessageCount = commit.value.messageCount
    } finally {
      getDb()
        .messages.hook('reading')
        .unsubscribe(readHeader as never)
      getDb()
        .messageBodies.hook('reading')
        .unsubscribe(readBody as never)
    }

    expect(forkMessageCount).toBe(pathLength)
    expect(headerReads).toBeLessThanOrEqual(pathLength * 4)
    expect(bodyReads).toBeLessThanOrEqual(pathLength)
  })
})

describe('inline message text helpers', () => {
  it('concatenates text lanes while skipping media', () => {
    expect(
      plaintextOf([
        { type: 'text', text: 'hello ' },
        { type: 'image_url', url: 'x' },
        { type: 'output_text', text: 'world' },
      ]),
    ).toBe('hello world')
  })

  it('replaces the first text item without disturbing other content', () => {
    expect(
      writeTextInto(
        [
          { type: 'text', text: 'old' },
          { type: 'image_url', url: 'x' },
        ],
        'new',
      ),
    ).toEqual([
      { type: 'text', text: 'new' },
      { type: 'image_url', url: 'x' },
    ])
  })

  it('appends a text lane when none exists', () => {
    expect(writeTextInto([{ type: 'image_url', url: 'x' }], 'new')).toEqual([
      { type: 'image_url', url: 'x' },
      { type: 'text', text: 'new' },
    ])
  })
})

describe('public structural undo', () => {
  it('restores a deleted pair through the same structural command boundary', async () => {
    const chat = await seedChat()
    const user = message(chat.id, { id: 'undo-user', role: 'user', createdAt: 1 })
    const assistant = message(chat.id, {
      id: 'undo-assistant',
      role: 'assistant',
      parentId: user.id,
      createdAt: 2,
    })
    await append(user, null)
    await append(assistant, user.id)
    const rowsBefore = await snapshotRows(chat.id, [user.id, assistant.id])
    await execute({
      kind: 'message.delete',
      mode: 'pair',
      input: { chatId: chat.id, messageId: assistant.id, activeLeafId: assistant.id },
    })
    expect((await getHeader(user.id))?.deleted).toBe(true)
    expect((await getHeader(assistant.id))?.deleted).toBe(true)

    const restored = await execute({
      kind: 'message.restore-structure',
      input: {
        snapshot: {
          chatId: chat.id,
          selectedTipId: assistant.id,
          previousRows: rowsBefore,
          newMessageIds: [],
          attachmentIds: [],
        },
      },
    })
    expect(restored.value.destination.proof.pathHeaders.map((header) => header.id)).toEqual([
      user.id,
      assistant.id,
    ])
    expect(restored.value.destination.presentations).toEqual([])
    const opened = (
      await query({
        kind: 'branch.open',
        chatId: chat.id,
        target: fixedConversationSelectionTarget(
          { kind: 'tip', messageId: assistant.id },
          assistant.id,
        ),
        bodyDemand: 'terminal',
      })
    ).value
    expect(opened.kind).toBe('ready')
    if (opened.kind !== 'ready') throw new Error('RestoredPairDestinationUnavailable')
    expect(opened.presentations.map((row) => row.message.id)).toEqual([assistant.id])
    expect((await getHeader(user.id))?.deleted).toBe(false)
    expect((await getHeader(assistant.id))?.deleted).toBe(false)
  })

  it('tombstones introduced rows without overwriting unrelated body/ref edits', async () => {
    const chat = await seedChat()
    await putAttachment(missingAttachment('undo-a'))
    await putAttachment(missingAttachment('undo-b'))
    const previous = message(chat.id, {
      id: 'undo-previous',
      content: [{ type: 'text', text: 'previous' }],
      attachmentRefs: [attachmentRef('undo-ref-a', 'undo-a')],
    })
    await append(previous, null)
    const previousRows = await snapshotRows(chat.id, [previous.id])
    const introduced = await executeMessageCommand({
      kind: 'message.insert-sibling',
      input: {
        chatId: chat.id,
        targetId: previous.id,
        content: [{ type: 'text', text: 'introduced' }],
        attachmentRefs: [attachmentRef('undo-ref-b', 'undo-b')],
        now: 2,
      },
    })
    await execute({
      kind: 'message.edit-content',
      input: {
        chatId: chat.id,
        messageId: previous.id,
        content: [{ type: 'text', text: 'edited independently' }],
        attachmentRefs: [attachmentRef('undo-ref-b-replacement', 'undo-b')],
        now: 3,
      },
    })

    const restored = await execute({
      kind: 'message.restore-structure',
      input: {
        snapshot: {
          chatId: chat.id,
          selectedTipId: previous.id,
          previousRows,
          newMessageIds: [introduced.messageId],
          attachmentIds: ['undo-a', 'undo-b'],
        },
      },
    })

    expect(restored.value.destination.proof.pathHeaders.map((header) => header.id)).toEqual([
      previous.id,
    ])
    expect(restored.value.destination.presentations).toEqual([])
    const opened = (
      await query({
        kind: 'branch.open',
        chatId: chat.id,
        target: fixedConversationSelectionTarget(
          { kind: 'tip', messageId: previous.id },
          previous.id,
        ),
        bodyDemand: 'terminal',
      })
    ).value
    expect(opened.kind).toBe('ready')
    if (opened.kind !== 'ready') throw new Error('RestoredInsertionDestinationUnavailable')
    expect(opened.presentations.map((row) => row.message.id)).toEqual([previous.id])

    expect(await getMessage(introduced.messageId)).toMatchObject({
      id: introduced.messageId,
      deleted: true,
      content: [{ type: 'text', text: 'introduced' }],
      attachmentRefs: introduced.message.attachmentRefs,
    })
    expect(await getMessage(previous.id)).toMatchObject({
      content: [{ type: 'text', text: 'edited independently' }],
      attachmentRefs: [
        {
          refId: 'undo-ref-b-replacement',
          attachmentId: 'undo-b',
          updatedAt: 3,
        },
      ],
    })
    expect((await getAttachment('undo-a'))?.refCount).toBe(0)
    expect((await getAttachment('undo-b'))?.refCount).toBe(2)
    await expectAttachmentReferenceInvariants(getDb())
  })
})
