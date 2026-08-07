import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanonicalStreamEventV1 } from '../../src/backcompat/generation-stream-events-v1'
import { persistStreamEventV1 } from '../../src/backcompat/persisted-stream-event-v1'
import { WAVE_A_V94_STORES } from '../../src/backcompat/wave-a-storage-epoch-v94'
import {
  createWaveAJournalEventConverterV94,
  decodeExplicitWaveALeaseV94,
  migrateWaveAOperationalStreamRowsV94,
  normalizeWaveAStoredStreamEventV94,
  waveAStreamIntegrityEventV94,
} from '../../src/backcompat/wave-a-stream-storage-v94'
import { canonicalStreamEventV2FromUnknown } from '../../src/core/canonical-stream-event'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, ConnectionProfile, Message } from '../../src/core/types'
import type { SettingsRow } from '../../src/store/db-rows'
import { type MessageHeaderRow, splitMessageForStorage } from '../../src/store/message-storage'
import {
  persistedStreamEventV2FromUnknown,
  persistStreamEventV2,
} from '../../src/store/persisted-stream-event'
import type { StreamJournalFrameRow, StreamLeaseRow } from '../../src/store/repository'
import { requireCanonicalStreamJournalFrame } from '../../src/store/stream-journal-codec'
import { BROWSER_WORKSPACE_FENCE_ID } from '../../src/store/workspace-meta'
import {
  decodeTestStreamJournalFrames,
  encodeTestStreamJournalEntries,
} from '../helpers/stream-journal'
import {
  testContinuationLease,
  testGenerationLease,
  testRecoveryPendingLease,
} from '../helpers/stream-leases'

const databaseNames: string[] = []

afterEach(async () => {
  await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)))
})

describe('Wave A v94 stream storage normalization', () => {
  it.each([
    ['v67', 'legacy-unversioned'],
    ['v88', 'legacy-unversioned'],
    ['v89', 'persisted-v1'],
    ['v90', 'persisted-v1'],
    ['v91', 'persisted-v2'],
    ['v92', 'persisted-v2'],
  ] as const)('decodes %s with explicit journal semantics', (version, journalSemantics) => {
    const decoded = decodeExplicitWaveALeaseV94({
      value: historicalLease(version),
      replacementEpoch: 17,
      observedAt: 101,
    })

    expect(decoded).toMatchObject({
      kind: 'nonterminal',
      journalSemantics,
      lease: {
        custody: 'recovery-pending',
        replacementEpoch: 17,
        handedOffAt: 101,
        handoffReason: 'owner-unavailable',
        journalEventVersion: 2,
        controlRevision: 0,
      },
    })
    expect(decoded?.structuralV88).not.toHaveProperty('journalEventVersion')
    expect(decoded?.structuralV88.dispatch).not.toHaveProperty('reasoningCarryForward')
    expect(decoded?.structuralV88.dispatch).not.toHaveProperty('reasoningVisibility')
  })

  it('seeds nonterminal custody once with stable identity and no obsolete owner or Stop facts', () => {
    const value = testGenerationLease({
      replacementEpoch: 3,
      revision: 8,
      ownerClientId: 'obsolete-tab',
      fenceToken: 'obsolete-fence',
      heartbeatAt: 77,
      stopControl: {
        requestId: 'stop-1',
        requestedBy: 'obsolete-tab',
        requestedAt: 78,
        reason: 'user',
      },
    })
    const input = { value, replacementEpoch: 17, observedAt: 101 }
    const first = decodeExplicitWaveALeaseV94(input)
    const second =
      first?.kind === 'nonterminal'
        ? decodeExplicitWaveALeaseV94({ ...input, value: first.lease })
        : undefined

    expect(first?.kind).toBe('nonterminal')
    expect(second?.kind).toBe('nonterminal')
    if (first?.kind !== 'nonterminal' || second?.kind !== 'nonterminal') {
      throw new Error('ExpectedRecoveryPendingLease')
    }
    expect(first.lease).not.toHaveProperty('ownerClientId')
    expect(first.lease).not.toHaveProperty('fenceToken')
    expect(first.lease).not.toHaveProperty('heartbeatAt')
    expect(first.lease).not.toHaveProperty('stopControl')
    expect(first.lease.revision).toBe(9)
    expect(second.lease).toEqual(first.lease)
  })

  it('retains terminal state instead of fabricating recovery custody', () => {
    const decoded = decodeExplicitWaveALeaseV94({
      value: testGenerationLease({ phase: 'canonical', canonicalAt: 12 }),
      replacementEpoch: 17,
      observedAt: 101,
    })

    expect(decoded).toMatchObject({
      kind: 'terminal',
      candidate: {
        phase: 'canonical',
        canonicalAt: 12,
        custody: 'writer',
        journalEventVersion: 2,
      },
    })
  })

  it('normalizes legacy, persisted V1, and persisted V2 events to one V2 contract', () => {
    const lease = historicalLease('v88')
    const decoded = decodeExplicitWaveALeaseV94({
      value: lease,
      replacementEpoch: 17,
      observedAt: 101,
    })
    if (!decoded) throw new Error('ExpectedDecodedLease')
    const converter = createWaveAJournalEventConverterV94(decoded.structuralV88, {
      kind: 'openrouter',
    })
    const event: CanonicalStreamEventV1 = { lane: 'text', text: 'complete' }
    const context = { apiUsed: 'chat', profile: { kind: 'openrouter' } }

    const legacy = normalizeWaveAStoredStreamEventV94(event, 50, converter, context)
    const persistedV1 = normalizeWaveAStoredStreamEventV94(
      persistStreamEventV1(event),
      50,
      converter,
      context,
    )
    const persistedV2Input = persistStreamEventV2({ lane: 'text', text: 'current' })
    const persistedV2 = normalizeWaveAStoredStreamEventV94(persistedV2Input, 50, converter, context)

    expect(legacy).toEqual({ version: 2, event })
    expect(persistedV1).toEqual({ version: 2, event })
    expect(persistedV2).toEqual(persistedV2Input)
    expect(canonicalStreamEventV2FromUnknown(legacy.event)).toEqual(event)
  })

  it('rejects malformed events and emits a valid V2 integrity event', () => {
    const decoded = decodeExplicitWaveALeaseV94({
      value: historicalLease('v88'),
      replacementEpoch: 17,
      observedAt: 101,
    })
    if (!decoded) throw new Error('ExpectedDecodedLease')
    const converter = createWaveAJournalEventConverterV94(decoded.structuralV88, {
      kind: 'openrouter',
    })

    expect(() =>
      normalizeWaveAStoredStreamEventV94({ lane: 'text' }, 50, converter, { apiUsed: 'chat' }),
    ).toThrow('StreamJournalV89SemanticEventInvalid')
    expect(waveAStreamIntegrityEventV94(converter, 'stream-1', {})).toMatchObject({
      version: 2,
      event: { lane: 'integrity' },
    })
  })

  it('normalizes a v25 active generation and raw journal in one bounded transaction', async () => {
    const name = `wave-a-v94-stream-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = waveAStreamDatabase(name)
    await legacy.open()
    await seedStreamTarget(legacy)
    await legacy.table('workspaceFence').put({
      id: BROWSER_WORKSPACE_FENCE_ID,
      workspaceId: 'workspace-1',
      replacementEpoch: 7,
    })
    await legacy.table('streamLeases').put({
      streamId: 'legacy-stream',
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: 'old-tab',
      startedAt: 10,
      heartbeatAt: 11,
      attemptKind: 'generation',
    })
    await legacy.table('streamChunks').bulkPut([
      {
        id: 'legacy-frame-0',
        streamId: 'legacy-stream',
        chatId: 'chat-1',
        messageId: 'message-1',
        seq: 0,
        createdAt: 12,
        event: persistStreamEventV2({ lane: 'text', text: 'hello' }),
      },
      {
        id: 'legacy-frame-1',
        streamId: 'legacy-stream',
        chatId: 'chat-1',
        messageId: 'message-1',
        seq: 1,
        createdAt: 13,
        event: { lane: 'finish', finishReason: 'stop' },
      },
    ])
    legacy.close()

    let markers: readonly { key: string; value: unknown }[] = []
    let obsoleteBytes = 0
    const migrated = waveAStreamDatabase(name)
    migrated
      .version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade(async (tx) => {
        const result = await migrateWaveAOperationalStreamRowsV94(tx, {
          observedAt: 100,
          recordObsoleteBytes: (bytes) => {
            obsoleteBytes += bytes
          },
        })
        markers = result.delayedMarkers
      })
    await migrated.open()

    const lease = await migrated.table<StreamLeaseRow, string>('streamLeases').get('legacy-stream')
    if (!lease) throw new Error('Expected legacy stream lease')
    expect(lease).toMatchObject({
      custody: 'recovery-pending',
      handoffReason: 'owner-unavailable',
      replacementEpoch: 7,
      phase: 'active',
      journalEventVersion: 2,
      journalMaxSeq: 1,
    })
    const frames = await migrated
      .table<StreamJournalFrameRow, string>('streamChunks')
      .where('streamId')
      .equals('legacy-stream')
      .sortBy('seq')
    const decoded = await decodeTestStreamJournalFrames(
      frames.map(requireCanonicalStreamJournalFrame),
      {
        streamId: 'legacy-stream',
        chatId: 'chat-1',
        messageId: 'message-1',
        replacementEpoch: 7,
        admissionSequence: lease.admissionSequence,
      },
    )
    expect(decoded.map((entry) => persistedStreamEventV2FromUnknown(entry.event)?.event)).toEqual([
      { lane: 'text', text: 'hello' },
      { lane: 'finish', finishReason: 'stop' },
    ])
    expect(markers.map((row) => row.key)).toEqual([
      'backfill:stream-journal-frames-v83',
      'backfill:stream-journal-integrity-v1',
    ])
    expect(
      await migrated.table<SettingsRow, string>('settings').bulkGet(markers.map((row) => row.key)),
    ).toEqual([undefined, undefined])
    expect(obsoleteBytes).toBeGreaterThan(0)
    migrated.close()
  })

  it('retains a dense current V2 journal without rewriting its frames', async () => {
    const name = `wave-a-v94-stream-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = waveAStreamDatabase(name)
    await legacy.open()
    await seedStreamTarget(legacy)
    await legacy.table('workspaceFence').put({
      id: BROWSER_WORKSPACE_FENCE_ID,
      workspaceId: 'workspace-1',
      replacementEpoch: 7,
    })
    const frames = await encodeTestStreamJournalEntries({
      streamId: 'current-stream',
      chatId: 'chat-1',
      messageId: 'message-1',
      fence: {
        ownerClientId: 'old-tab',
        fenceToken: 'old-fence',
        replacementEpoch: 7,
        admissionSequence: 4,
      },
      entries: [
        {
          createdAt: 12,
          event: persistStreamEventV2({ lane: 'text', text: 'current' }),
        },
      ],
    })
    const lastFrame = frames.at(-1)
    const lease = testRecoveryPendingLease({
      streamId: 'current-stream',
      chatId: 'chat-1',
      messageId: 'message-1',
      replacementEpoch: 7,
      admissionSequence: 4,
      handedOffAt: 100,
      handoffReason: 'owner-unavailable',
      ...(lastFrame ? { journalMaxSeq: lastFrame.seq } : {}),
      journalStorageBytes: 1,
    })
    await legacy.table('streamLeases').put(lease)
    await legacy.table('streamChunks').bulkPut(frames)
    legacy.close()

    const migrated = waveAStreamDatabase(name)
    migrated
      .version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAOperationalStreamRowsV94(tx, {
          observedAt: 100,
          recordObsoleteBytes: () => undefined,
        }),
      )
    await migrated.open()
    expect(
      await migrated.table('streamChunks').where('streamId').equals('current-stream').sortBy('seq'),
    ).toEqual(frames)
    migrated.close()
  })

  it('preserves a terminal decision at its authoritative cutoff and drops its tail', async () => {
    const name = `wave-a-v94-stream-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = waveAStreamDatabase(name)
    await legacy.open()
    await seedStreamTarget(legacy)
    await legacy.table('workspaceFence').put({
      id: BROWSER_WORKSPACE_FENCE_ID,
      workspaceId: 'workspace-1',
      replacementEpoch: 7,
    })
    const frames = await encodeTestStreamJournalEntries({
      streamId: 'terminal-stream',
      chatId: 'chat-1',
      messageId: 'message-1',
      fence: {
        ownerClientId: 'old-tab',
        fenceToken: 'old-fence',
        replacementEpoch: 7,
        admissionSequence: 4,
      },
      entries: [
        { createdAt: 10, event: persistStreamEventV2({ lane: 'text', text: 'kept' }) },
        { createdAt: 11, event: persistStreamEventV2({ lane: 'finish', finishReason: 'stop' }) },
        { createdAt: 12, event: persistStreamEventV2({ lane: 'text', text: 'tail' }) },
      ],
    })
    await legacy.table('streamLeases').put(
      testGenerationLease({
        streamId: 'terminal-stream',
        chatId: 'chat-1',
        messageId: 'message-1',
        replacementEpoch: 7,
        admissionSequence: 4,
        phase: 'terminal-decided',
        journalMaxSeq: 1,
        journalStorageBytes: 1,
      }),
    )
    await legacy.table('streamChunks').bulkPut(frames)
    legacy.close()

    const migrated = waveAStreamDatabase(name)
    migrated
      .version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAOperationalStreamRowsV94(tx, {
          observedAt: 100,
          recordObsoleteBytes: () => undefined,
        }),
      )
    await migrated.open()
    expect(await migrated.table('streamLeases').get('terminal-stream')).toMatchObject({
      phase: 'terminal-decided',
      journalMaxSeq: 1,
      terminal: { journalMaxSeq: 1 },
    })
    expect(
      await migrated
        .table('streamChunks')
        .where('streamId')
        .equals('terminal-stream')
        .sortBy('seq'),
    ).toEqual(frames.slice(0, 2))
    migrated.close()
  })

  it('keeps a valid prefix, appends one integrity event, and deletes orphan journals', async () => {
    const name = `wave-a-v94-stream-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = waveAStreamDatabase(name)
    await legacy.open()
    await seedStreamTarget(legacy)
    await legacy.table('workspaceFence').put({
      id: BROWSER_WORKSPACE_FENCE_ID,
      workspaceId: 'workspace-1',
      replacementEpoch: 7,
    })
    await legacy.table('streamLeases').put({
      streamId: 'malformed-stream',
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: 'old-tab',
      startedAt: 10,
      heartbeatAt: 11,
      attemptKind: 'generation',
    })
    await legacy.table('streamChunks').bulkPut([
      {
        id: 'malformed-0',
        streamId: 'malformed-stream',
        chatId: 'chat-1',
        messageId: 'message-1',
        seq: 0,
        createdAt: 12,
        event: { lane: 'text', text: 'prefix' },
      },
      {
        id: 'malformed-1',
        streamId: 'malformed-stream',
        chatId: 'chat-1',
        messageId: 'message-1',
        seq: 1,
        createdAt: 13,
        event: { lane: 'text' },
      },
      {
        id: 'orphan-0',
        streamId: 'orphan-stream',
        chatId: 'chat-1',
        messageId: 'message-1',
        seq: 0,
        createdAt: 12,
        event: { lane: 'text', text: 'orphan' },
      },
    ])
    legacy.close()

    const migrated = waveAStreamDatabase(name)
    migrated
      .version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAOperationalStreamRowsV94(tx, {
          observedAt: 100,
          recordObsoleteBytes: () => undefined,
        }),
      )
    await migrated.open()
    const lease = await migrated
      .table<StreamLeaseRow, string>('streamLeases')
      .get('malformed-stream')
    if (!lease) throw new Error('Expected malformed stream lease')
    const frames = await migrated
      .table<StreamJournalFrameRow, string>('streamChunks')
      .where('streamId')
      .equals('malformed-stream')
      .sortBy('seq')
    const decoded = await decodeTestStreamJournalFrames(
      frames.map(requireCanonicalStreamJournalFrame),
      {
        streamId: 'malformed-stream',
        chatId: 'chat-1',
        messageId: 'message-1',
        replacementEpoch: 7,
        admissionSequence: lease.admissionSequence,
      },
    )
    expect(decoded.map((entry) => persistedStreamEventV2FromUnknown(entry.event)?.event)).toEqual([
      { lane: 'text', text: 'prefix' },
      expect.objectContaining({ lane: 'integrity' }),
    ])
    expect(
      await migrated.table('streamChunks').where('streamId').equals('orphan-stream').count(),
    ).toBe(0)
    migrated.close()
  })

  it('recovers an exact orphan journal into one recovery-pending generation lease', async () => {
    const name = `wave-a-v94-stream-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = waveAStreamDatabase(name)
    await legacy.open()
    await seedStreamTarget(legacy)
    await legacy.table('workspaceFence').put({
      id: BROWSER_WORKSPACE_FENCE_ID,
      workspaceId: 'workspace-1',
      replacementEpoch: 7,
    })
    await legacy.table('streamChunks').bulkPut([
      {
        id: 'orphan-exact-0',
        streamId: 'orphan-exact',
        chatId: 'chat-1',
        messageId: 'message-1',
        seq: 0,
        createdAt: 12,
        event: { lane: 'text', text: 'recover me' },
      },
      {
        id: 'orphan-exact-1',
        streamId: 'orphan-exact',
        chatId: 'chat-1',
        messageId: 'message-1',
        seq: 1,
        createdAt: 13,
        event: { lane: 'finish', finishReason: 'stop' },
      },
    ])
    legacy.close()

    const migrated = waveAStreamDatabase(name)
    migrated
      .version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAOperationalStreamRowsV94(tx, {
          observedAt: 100,
          recordObsoleteBytes: () => undefined,
        }),
      )
    await migrated.open()

    const lease = await migrated.table<StreamLeaseRow, string>('streamLeases').get('orphan-exact')
    expect(lease).toMatchObject({
      streamId: 'orphan-exact',
      chatId: 'chat-1',
      messageId: 'message-1',
      targetOwnerKey: 'message-1',
      custody: 'recovery-pending',
      phase: 'active',
      attemptKind: 'generation',
      replacementEpoch: 7,
      handedOffAt: 100,
      journalMaxSeq: 1,
    })
    expect(
      (await migrated.table<MessageHeaderRow, string>('messages').get('message-1'))?.generation
        ?.finishedAt,
    ).toBeUndefined()
    expect(
      (await migrated.table<SettingsRow, string>('settings').toArray()).filter((row) =>
        row.key.startsWith('backcompat:v94:orphan-target:'),
      ),
    ).toEqual([])
    migrated.close()
  })

  it('terminalizes an unfinished generation that only a continuation lease references', async () => {
    const name = `wave-a-v94-stream-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = waveAStreamDatabase(name)
    await legacy.open()
    await seedStreamTarget(legacy)
    await legacy.table('workspaceFence').put({
      id: BROWSER_WORKSPACE_FENCE_ID,
      workspaceId: 'workspace-1',
      replacementEpoch: 7,
    })
    await legacy.table('streamLeases').put(
      testContinuationLease({
        streamId: 'continuation-only',
        chatId: 'chat-1',
        messageId: 'message-1',
        replacementEpoch: 7,
      }),
    )
    legacy.close()

    const migrated = waveAStreamDatabase(name)
    migrated
      .version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAOperationalStreamRowsV94(tx, {
          observedAt: 100,
          recordObsoleteBytes: () => undefined,
        }),
      )
    await migrated.open()

    expect(
      (await migrated.table<MessageHeaderRow, string>('messages').get('message-1'))?.generation,
    ).toMatchObject({
      status: 'interrupted',
      abortReason: 'tab-close',
      integrity: 'clean',
      finishedAt: 100,
    })
    expect(await migrated.table('streamLeases').get('continuation-only')).toMatchObject({
      attemptKind: 'continuation',
      phase: 'active',
    })
    migrated.close()
  })

  it('terminalizes 1,024 stranded generation headers with two ordered cursors and bounded writes', async () => {
    const name = `wave-a-v94-stream-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = waveAStreamDatabase(name)
    await legacy.open()
    await seedStreamTarget(legacy)
    await legacy.table('workspaceFence').put({
      id: BROWSER_WORKSPACE_FENCE_ID,
      workspaceId: 'workspace-1',
      replacementEpoch: 7,
    })
    const rowCount = 1_024
    const ids = Array.from({ length: rowCount }, (_, index) =>
      index === 0 ? 'message-1' : `message-${String(index).padStart(4, '0')}`,
    )
    const rows = ids.map((id, index) =>
      splitMessageForStorage({
        id,
        chatId: 'chat-1',
        parentId: index === 0 ? null : (ids[index - 1] ?? null),
        siblingIndex: 0,
        turnId: `turn-${index}`,
        turnIndex: index,
        createdAt: index + 1,
        role: 'assistant',
        origin: 'generated',
        deleted: false,
        nodeVersion: 0,
        content: [],
        generation: {
          id: `generation-${index}`,
          model: 'test/model',
          requestedModel: 'test/model',
          apiUsed: 'chat',
          delivery: 'streaming',
          status: 'streaming',
          integrity: 'clean',
          costSource: 'stream',
          reasoningCarryForward: 'none',
          reasoningVisibility: { disclosure: 'unknown' },
          startedAt: index + 1,
        },
      }),
    )
    await legacy.table('messages').bulkPut(rows.map(({ header }) => header))
    const chat = await legacy.table<Chat, string>('chats').get('chat-1')
    if (!chat) throw new Error('Expected stream migration chat')
    await legacy.table('chats').put({ ...chat, lastUpdatedLeafId: ids.at(-1) })
    legacy.close()

    const migrated = waveAStreamDatabase(name)
    migrated
      .version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAOperationalStreamRowsV94(tx, {
          observedAt: 10_000,
          recordObsoleteBytes: () => undefined,
        }),
      )
    const whereSpy = vi.spyOn(migrated.Table.prototype, 'where')
    const objectStoreCursorSpy = vi.spyOn(IDBObjectStore.prototype, 'openCursor')
    const indexCursorSpy = vi.spyOn(IDBIndex.prototype, 'openCursor')
    const bulkPutSpy = vi.spyOn(migrated.Table.prototype, 'bulkPut')
    await migrated.open()
    const targetOwnerQueries = whereSpy.mock.calls.filter(
      ([index]) => typeof index === 'string' && index === 'targetOwnerKey',
    )
    const messageCursorCalls = objectStoreCursorSpy.mock.contexts.filter(
      (context) => context instanceof IDBObjectStore && context.name === 'messages',
    )
    const targetOwnerCursorCalls = indexCursorSpy.mock.contexts.filter(
      (context) => context instanceof IDBIndex && context.name === 'targetOwnerKey',
    )
    const messageWriteBatches = bulkPutSpy.mock.calls.flatMap(([values], index) => {
      const context = bulkPutSpy.mock.contexts[index] as { name?: unknown }
      return context.name === 'messages' ? [values as readonly unknown[]] : []
    })
    whereSpy.mockRestore()
    objectStoreCursorSpy.mockRestore()
    indexCursorSpy.mockRestore()
    bulkPutSpy.mockRestore()

    expect(targetOwnerQueries).toHaveLength(0)
    expect(messageCursorCalls).toHaveLength(1)
    expect(targetOwnerCursorCalls).toHaveLength(2)
    expect(messageWriteBatches.length).toBeGreaterThan(1)
    expect(messageWriteBatches.every((batch) => batch.length <= 128)).toBe(true)
    const migratedHeaders = await migrated.table<MessageHeaderRow, string>('messages').toArray()
    expect(migratedHeaders).toHaveLength(rowCount)
    expect(
      migratedHeaders.every(
        (header) =>
          header.generation?.status === 'interrupted' &&
          header.generation.abortReason === 'tab-close' &&
          header.generation.finishedAt === 10_000,
      ),
    ).toBe(true)
    migrated.close()
  }, 30_000)

  it('elects one duplicate target deterministically across the 128-row page boundary', async () => {
    const name = `wave-a-v94-stream-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = waveAStreamDatabase(name)
    await legacy.open()
    await seedStreamTarget(legacy)
    await legacy.table('workspaceFence').put({
      id: BROWSER_WORKSPACE_FENCE_ID,
      workspaceId: 'workspace-1',
      replacementEpoch: 7,
    })
    const sourceLeases = Array.from({ length: 129 }, (_, index) => ({
      streamId: `duplicate-${String(index).padStart(3, '0')}`,
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: `old-tab-${index}`,
      startedAt: 10 + index,
      heartbeatAt: 10_000 - index,
      admissionSequence: 1,
      attemptKind: 'generation',
    }))
    await legacy.table('streamLeases').bulkPut(sourceLeases)
    legacy.close()

    const migrated = waveAStreamDatabase(name)
    migrated
      .version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAOperationalStreamRowsV94(tx, {
          observedAt: 1000,
          recordObsoleteBytes: () => undefined,
        }),
      )
    const whereSpy = vi.spyOn(migrated.Table.prototype, 'where')
    await migrated.open()
    const targetOwnerQueries = whereSpy.mock.calls.filter(
      ([index]) => typeof index === 'string' && index === 'targetOwnerKey',
    )
    whereSpy.mockRestore()

    expect(await migrated.table('streamLeases').toArray()).toMatchObject([
      {
        streamId: 'duplicate-128',
        messageId: 'message-1',
        targetOwnerKey: 'message-1',
        admissionSequence: 1,
        custody: 'recovery-pending',
      },
    ])
    expect(targetOwnerQueries).toHaveLength(0)
    migrated.close()
  })

  it('retires a malformed non-string lease primary key', async () => {
    const name = `wave-a-v94-stream-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = waveAStreamDatabase(name)
    await legacy.open()
    await legacy.table('workspaceFence').put({
      id: BROWSER_WORKSPACE_FENCE_ID,
      workspaceId: 'workspace-1',
      replacementEpoch: 7,
    })
    await legacy.table('streamLeases').put({
      streamId: 42,
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: 'old-tab',
      startedAt: 10,
      heartbeatAt: 11,
      attemptKind: 'generation',
    })
    legacy.close()

    const migrated = waveAStreamDatabase(name)
    migrated
      .version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAOperationalStreamRowsV94(tx, {
          observedAt: 1000,
          recordObsoleteBytes: () => undefined,
        }),
      )
    await migrated.open()
    expect(await migrated.table('streamLeases').count()).toBe(0)
    migrated.close()
  })

  it('rolls temporary journal staging back atomically when the upgrade fails', async () => {
    const name = `wave-a-v94-stream-${crypto.randomUUID()}`
    databaseNames.push(name)
    const legacy = waveAStreamDatabase(name)
    await legacy.open()
    await seedStreamTarget(legacy)
    await legacy.table('workspaceFence').put({
      id: BROWSER_WORKSPACE_FENCE_ID,
      workspaceId: 'workspace-1',
      replacementEpoch: 7,
    })
    const sourceLease = {
      streamId: 'rollback-stream',
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: 'old-tab',
      startedAt: 10,
      heartbeatAt: 11,
      attemptKind: 'generation',
    }
    const sourceFrame = {
      id: 'rollback-0',
      streamId: 'rollback-stream',
      chatId: 'chat-1',
      messageId: 'message-1',
      seq: 0,
      createdAt: 12,
      event: { lane: 'text', text: 'source' },
    }
    await legacy.table('streamLeases').put(sourceLease)
    await legacy.table('streamChunks').put(sourceFrame)
    legacy.close()

    const failed = waveAStreamDatabase(name)
    let accountingCalls = 0
    failed
      .version(2)
      .stores(WAVE_A_V94_STORES)
      .upgrade((tx) =>
        migrateWaveAOperationalStreamRowsV94(tx, {
          observedAt: 100,
          recordObsoleteBytes: () => {
            accountingCalls += 1
            if (accountingCalls === 2) throw new Error('InjectedStreamMigrationFailure')
          },
        }),
      )
    await expect(failed.open()).rejects.toThrow('InjectedStreamMigrationFailure')
    failed.close()

    const reopened = waveAStreamDatabase(name)
    await reopened.open()
    expect(await reopened.table('streamLeases').get('rollback-stream')).toEqual(sourceLease)
    expect(await reopened.table('streamChunks').toArray()).toEqual([sourceFrame])
    expect(await reopened.table('settings').toArray()).toEqual([])
    reopened.close()
  })
})

type HistoricalLeaseVersion = 'v67' | 'v88' | 'v89' | 'v90' | 'v91' | 'v92'

function historicalLease(version: HistoricalLeaseVersion): Record<string, unknown> {
  const current = structuredClone(testGenerationLease()) as unknown as Record<string, unknown>
  const dispatch = current.dispatch as Record<string, unknown>
  if (
    version === 'v91' ||
    version === 'v90' ||
    version === 'v89' ||
    version === 'v88' ||
    version === 'v67'
  ) {
    delete dispatch.reasoningVisibility
  }
  if (version === 'v89' || version === 'v88' || version === 'v67') {
    delete dispatch.reasoningCarryForward
  }
  if (version === 'v90' || version === 'v89') current.journalEventVersion = 1
  if (version === 'v88' || version === 'v67') delete current.journalEventVersion
  if (version === 'v67') delete current.controlRevision
  return current
}

function waveAStreamDatabase(name: string): Dexie {
  const db = new Dexie(name)
  db.version(1).stores(WAVE_A_V94_STORES)
  return db
}

async function seedStreamTarget(db: Dexie): Promise<void> {
  const settings = { ...cloneDefaultChatSettings(), profileId: 'profile-1', model: 'test/model' }
  const chat: Chat = {
    id: 'chat-1',
    title: 'Stream migration',
    titleStatus: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 0,
    configurationVersion: 0,
    settings,
    lastUpdatedLeafId: 'message-1',
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
  const profile: ConnectionProfile = {
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
  const message: Message = {
    id: 'message-1',
    chatId: 'chat-1',
    parentId: null,
    siblingIndex: 0,
    turnId: 'turn-1',
    turnIndex: 0,
    createdAt: 1,
    role: 'assistant',
    origin: 'generated',
    deleted: false,
    nodeVersion: 0,
    content: [],
    generation: {
      id: 'generation-1',
      model: 'test/model',
      requestedModel: 'test/model',
      apiUsed: 'chat',
      delivery: 'streaming',
      status: 'streaming',
      integrity: 'clean',
      costSource: 'stream',
      reasoningCarryForward: 'none',
      reasoningVisibility: { disclosure: 'unknown' },
      startedAt: 1,
    },
  }
  const split = splitMessageForStorage(message)
  await db.table('chats').put(chat)
  await db.table('profiles').put(profile)
  await db.table('messages').put(split.header)
  await db.table('messageBodies').put(split.body)
}
