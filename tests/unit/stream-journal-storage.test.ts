import Dexie from 'dexie'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { canonicalStreamEventV1FromUnknown } from '../../src/backcompat/canonical-stream-event-v1'
import type {
  CanonicalStreamEventV1,
  GenerationStreamFailureV1,
  ReasoningEnvelopeV1Schema,
} from '../../src/backcompat/generation-stream-events-v1'
import {
  persistedStreamEventV1FromUnknown,
  persistStreamEventV1,
} from '../../src/backcompat/persisted-stream-event-v1'
import { canonicalStreamEventV2FromUnknown } from '../../src/core/canonical-stream-event'
import type {
  CanonicalStreamEventV2,
  ReasoningEnvelopeV2Schema,
} from '../../src/core/generation-stream-events'
import { createDbForTests, type NatterDb } from '../../src/store/db'
import type { PersistedStreamEventV2 } from '../../src/store/persisted-stream-event'
import {
  persistedStreamEventV2FromUnknown,
  persistStreamEventV2,
} from '../../src/store/persisted-stream-event'
import type { StreamLeaseRow, StreamWriteFence } from '../../src/store/repository'
import { streamLeaseHasWriteFence } from '../../src/store/repository'
import {
  awaitStorageCompactionDebtIdle,
  readStorageCompactionState,
} from '../../src/store/storage-compaction-state'
import {
  estimateStoredValueBytes,
  estimateStreamJournalFrameStorageBytes,
} from '../../src/store/storage-size-estimate'
import type { CanonicalStreamJournalFrameRow } from '../../src/store/stream-journal-codec'
import {
  appendStreamJournalFrames,
  retireStreamJournalOwnershipPage,
} from '../../src/store/stream-journal-storage'
import {
  canonicalTestStreamJournalBatch,
  encodeTestStreamJournalEntries,
  runTestStreamJournalTransaction,
} from '../helpers/stream-journal'
import { testGenerationLease } from '../helpers/stream-leases'

let db: NatterDb | null = null

afterEach(async () => {
  const current = db
  db = null
  if (!current) return
  const name = current.name
  current.close()
  await Dexie.delete(name)
})

describe('stream journal byte ownership', () => {
  it('keeps the current event contract explicitly mapped to persisted V2', () => {
    expectTypeOf<PersistedStreamEventV2['event']>().toEqualTypeOf<CanonicalStreamEventV2>()
  })

  it('has one exhaustive V1 validator for every persisted canonical lane', () => {
    for (const event of validCanonicalEventsV1()) {
      expect(canonicalStreamEventV1FromUnknown(event)).toBe(event)
      expect(persistedStreamEventV1FromUnknown({ version: 1, event })?.event).toBe(event)

      expect(canonicalStreamEventV1FromUnknown({ ...event, unexpected: true })).toBeNull()
      const missing = { ...event } as Record<string, unknown>
      delete missing[REQUIRED_KEY_BY_LANE[event.lane]]
      expect(canonicalStreamEventV1FromUnknown(missing)).toBeNull()
    }
  })

  it('has one exhaustive native V2 validator for every persisted canonical lane', () => {
    for (const event of validCanonicalEventsV2()) {
      expect(canonicalStreamEventV2FromUnknown(event)).toBe(event)
      expect(persistedStreamEventV2FromUnknown({ version: 2, event })?.event).toBe(event)

      expect(canonicalStreamEventV2FromUnknown({ ...event, unexpected: true })).toBeNull()
      const missing = { ...event } as Record<string, unknown>
      delete missing[REQUIRED_KEY_BY_LANE[event.lane]]
      expect(canonicalStreamEventV2FromUnknown(missing)).toBeNull()
    }
  })

  it('keeps frozen V1 and current V2 reasoning schemas mutually exclusive', () => {
    const v1Reasoning = validCanonicalEventsV1().find((event) => event.lane === 'reasoning')
    const v1Snapshot = validCanonicalEventsV1().find((event) => event.lane === 'result-snapshot')
    const v2Reasoning = validCanonicalEventsV2().find((event) => event.lane === 'reasoning')
    const v2Snapshot = validCanonicalEventsV2().find((event) => event.lane === 'result-snapshot')
    if (!v1Reasoning || !v1Snapshot || !v2Reasoning || !v2Snapshot) {
      throw new Error('ExpectedVersionedReasoningEvents')
    }

    expect(canonicalStreamEventV1FromUnknown(v2Reasoning)).toBeNull()
    expect(canonicalStreamEventV1FromUnknown(v2Snapshot)).toBeNull()
    expect(canonicalStreamEventV2FromUnknown(v1Reasoning)).toBeNull()
    expect(canonicalStreamEventV2FromUnknown(v1Snapshot)).toBeNull()
    expect(persistedStreamEventV1FromUnknown(persistStreamEventV2(v2Reasoning))).toBeNull()
    expect(persistedStreamEventV2FromUnknown(persistStreamEventV1(v1Reasoning))).toBeNull()
  })

  it('keeps intentionally unchanged V1 and V2 lanes structurally equal', () => {
    type SharedV1 = Exclude<CanonicalStreamEventV1, { lane: 'reasoning' | 'result-snapshot' }>
    type SharedV2 = Exclude<CanonicalStreamEventV2, { lane: 'reasoning' | 'result-snapshot' }>
    expectTypeOf<SharedV1>().toEqualTypeOf<SharedV2>()
  })

  it('admits only complete V1 semantic events at the shared persistence boundary', () => {
    const text = persistStreamEventV1({ lane: 'text', text: 'complete' })
    expect(persistedStreamEventV1FromUnknown(text)).toEqual(text)
    expect(
      persistedStreamEventV1FromUnknown({
        version: 1,
        event: {
          lane: 'result-snapshot',
          payload: { kind: 'retain' },
          outcome: { kind: 'finish', finishReason: 'stop' },
        },
      }),
    ).not.toBeNull()
    expect(persistedStreamEventV1FromUnknown({ version: 1, event: { lane: 'text' } })).toBeNull()
    expect(
      persistedStreamEventV1FromUnknown({ version: 1, event: { lane: 'result-snapshot' } }),
    ).toBeNull()
    expect(
      persistedStreamEventV1FromUnknown({
        version: 1,
        event: { lane: 'reasoning', mutations: [{ kind: 'replace', envelope: {} }] },
      }),
    ).toBeNull()
    expect(
      persistedStreamEventV1FromUnknown({ version: 1, event: text.event, extra: true }),
    ).toBeNull()
    expect(persistedStreamEventV1FromUnknown({ version: 2, event: text.event })).toBeNull()
  })

  it('rejects malformed nested canonical values without traversing opaque payloads', () => {
    const validReplace = validCanonicalEventsV1().find(
      (event): event is Extract<CanonicalStreamEventV1, { lane: 'result-snapshot' }> =>
        event.lane === 'result-snapshot',
    )
    expect(validReplace).toBeDefined()

    expect(
      canonicalStreamEventV1FromUnknown({
        lane: 'reasoning',
        mutations: [{ kind: 'replace', envelope: emptyReasoningEnvelope(), extra: true }],
      }),
    ).toBeNull()
    expect(
      canonicalStreamEventV1FromUnknown({
        lane: 'reasoning',
        mutations: [],
        observed: { firstAt: 2, lastAt: 1 },
      }),
    ).toBeNull()
    expect(
      canonicalStreamEventV1FromUnknown({
        lane: 'reasoning',
        mutations: [],
        observed: { firstAt: Number.NaN, lastAt: 1 },
      }),
    ).toBeNull()

    const annotationBase = {
      type: 'url_citation',
      source: 'openai-responses',
      startIndex: 0,
      endIndex: 1,
      providerPayload: { deeply: { opaque: true } },
      url: 'https://example.com',
    } as const
    expect(
      canonicalStreamEventV1FromUnknown({
        lane: 'text-annotations',
        annotations: [{ ...annotationBase, source: 'invalid' }],
        ownerTextLength: 1,
      }),
    ).toBeNull()
    expect(
      canonicalStreamEventV1FromUnknown({
        lane: 'text-annotations',
        annotations: [{ ...annotationBase, endIndex: 2 }],
        ownerTextLength: 1,
      }),
    ).toBeNull()
    expect(
      canonicalStreamEventV1FromUnknown({
        lane: 'text-annotations',
        annotations: [{ ...annotationBase, extra: true }],
        ownerTextLength: 1,
      }),
    ).toBeNull()
    expect(
      canonicalStreamEventV1FromUnknown({
        lane: 'text-annotations',
        annotations: [
          {
            ...annotationBase,
            type: 'file_citation',
            file: { kind: 'document', provider: 'openai-responses', documentIndex: -1 },
          },
        ],
        ownerTextLength: 1,
      }),
    ).toBeNull()

    for (const item of [
      { type: 'text', text: 'x', cacheControl: { type: 'ephemeral', ttl: 'forever' } },
      { type: 'image_url', detail: 'original' },
      { type: 'file', filename: 'a', mime: 'text/plain', attachmentId: 'a', url: 'b' },
      { type: 'text', text: 'x', extra: true },
    ]) {
      expect(canonicalStreamEventV1FromUnknown({ lane: 'content-item', item })).toBeNull()
    }

    expect(
      canonicalStreamEventV1FromUnknown({
        lane: 'usage',
        usage: { prompt_tokens: '1', provider_extension: { opaque: true } },
      }),
    ).toBeNull()
    expect(
      canonicalStreamEventV1FromUnknown({
        lane: 'usage',
        usage: { prompt_tokens: 1, provider_extension: { opaque: true } },
      }),
    ).not.toBeNull()
    for (const error of [
      streamFailure({ name: 1 }),
      streamFailure({ code: Number.NaN }),
      streamFailure({ httpStatus: 99 }),
    ]) {
      expect(canonicalStreamEventV1FromUnknown({ lane: 'error', error })).toBeNull()
    }
    expect(
      canonicalStreamEventV1FromUnknown({
        lane: 'server-tool-output',
        dialect: 'google-gemini',
        itemType: 'tool',
        itemId: 'tool-1',
        outputIndex: 0,
        output: undefined,
      }),
    ).toBeNull()
    expect(
      canonicalStreamEventV1FromUnknown({
        lane: 'output-item-done',
        dialect: 'openai-responses',
        outputIndex: 0,
        item: {},
      }),
    ).toBeNull()

    const replace = structuredClone(validReplace as CanonicalStreamEventV1) as Extract<
      CanonicalStreamEventV1,
      { lane: 'result-snapshot' }
    >
    if (replace.payload.kind !== 'replace') throw new Error('ExpectedReplaceSnapshot')
    const extendedReplace: CanonicalStreamEventV1 = {
      ...replace,
      payload: {
        ...replace.payload,
        providerOutputItems: [
          ...replace.payload.providerOutputItems,
          { dialect: 'unknown', type: 'opaque', item: null },
        ],
      },
    }
    expect(canonicalStreamEventV1FromUnknown(extendedReplace)).not.toBeNull()
    const malformedProviderItem = structuredClone(extendedReplace) as unknown as Record<
      string,
      unknown
    >
    const malformedPayload = malformedProviderItem.payload as Record<string, unknown>
    malformedPayload.providerOutputItems = [{ dialect: 'unknown', type: 'opaque', item: undefined }]
    expect(canonicalStreamEventV1FromUnknown(malformedProviderItem)).toBeNull()
    const legacySnapshot = structuredClone(extendedReplace) as unknown as Record<string, unknown>
    const legacyPayload = legacySnapshot.payload as Record<string, unknown>
    legacyPayload.reasoningDetails = []
    delete legacyPayload.reasoningEnvelope
    expect(canonicalStreamEventV1FromUnknown(legacySnapshot)).toBeNull()
  })

  it('appends canonical frames idempotently and retires their exact aggregate', async () => {
    db = createDbForTests(`natter-stream-journal-${crypto.randomUUID()}`)
    await db.open()
    const lease = streamLease({ streamId: 'stream:owned' })
    const fence = leaseFence(lease)
    const frames = await encodeTestStreamJournalEntries({
      streamId: lease.streamId,
      chatId: lease.chatId,
      messageId: lease.messageId,
      fence,
      entries: [
        { createdAt: 1, event: { lane: 'text', text: 'first' } },
        { createdAt: 2, event: { lane: 'text', text: 'second' } },
      ],
    })
    const journalStorageBytes = frameStorageBytes(frames)
    await db.streamLeases.add(lease)

    const appended = await runTestStreamJournalTransaction(db, (tx) =>
      appendStreamJournalFrames(tx, canonicalTestStreamJournalBatch(frames), 1),
    )
    expect(appended).toMatchObject({
      journalMaxSeq: frames.at(-1)?.seq,
      journalStorageBytes,
    })
    await awaitStorageCompactionDebtIdle()
    expect((await db.streamChunks.toArray()).map((row) => row.id)).toEqual(
      frames.map((frame) => frame.id),
    )
    const afterAppend = await readStorageCompactionState(db)
    expect(afterAppend.knownReclaimableBytes).toBe(estimateStoredValueBytes(lease))

    const duplicate = await runTestStreamJournalTransaction(db, (tx) =>
      appendStreamJournalFrames(tx, canonicalTestStreamJournalBatch(frames), 1),
    )
    expect(duplicate).toBeUndefined()
    await awaitStorageCompactionDebtIdle()
    expect(await readStorageCompactionState(db)).toEqual(afterAppend)

    const conflicting = await encodeTestStreamJournalEntries({
      streamId: lease.streamId,
      chatId: lease.chatId,
      messageId: lease.messageId,
      fence,
      entries: [
        { createdAt: 1, event: { lane: 'text', text: 'replacement' } },
        { createdAt: 2, event: { lane: 'text', text: 'second' } },
      ],
    })
    await expect(
      runTestStreamJournalTransaction(db, (tx) =>
        appendStreamJournalFrames(tx, canonicalTestStreamJournalBatch(conflicting), 1),
      ),
    ).rejects.toThrow(`StreamJournalFrameConflict:${lease.streamId}:0`)
    expect(await readStorageCompactionState(db)).toEqual(afterAppend)

    const metadata = terminalLease(lease, frames)
    await db.streamLeases.put(metadata)
    const beforeRetire = await readStorageCompactionState(db)
    const retired = await runTestStreamJournalTransaction(db, (tx) =>
      retireStreamJournalOwnershipPage(tx, {
        kind: 'owned-metadata-committed',
        streamId: metadata.streamId,
        fence,
      }),
    )
    expect(retired).toEqual({
      outcome: 'complete',
      done: true,
      deletedFrames: frames.length,
      deletedLeases: 1,
      obsoleteBytes: journalStorageBytes + estimateStoredValueBytes(metadata),
    })
    await awaitStorageCompactionDebtIdle()
    const afterRetire = await readStorageCompactionState(db)
    expect(afterRetire.knownReclaimableBytes - beforeRetire.knownReclaimableBytes).toBe(
      journalStorageBytes + estimateStoredValueBytes(metadata),
    )
    expect(await db.streamChunks.count()).toBe(0)
    expect(await db.streamLeases.count()).toBe(0)
  })

  it('retires more than one physical page without deleting the lease early', async () => {
    db = createDbForTests(`natter-stream-journal-pages-${crypto.randomUUID()}`)
    await db.open()
    const lease = streamLease({ streamId: 'paged-stream' })
    const fence = leaseFence(lease)
    const frames = await encodeTestStreamJournalEntries({
      streamId: lease.streamId,
      chatId: lease.chatId,
      messageId: lease.messageId,
      fence,
      entries: Array.from({ length: 130 }, (_, index) => ({
        createdAt: index + 1,
        event: { lane: 'text', text: `${index}` },
      })),
    })
    const metadata = terminalLease(lease, frames)
    await db.streamLeases.add(metadata)
    await db.streamChunks.bulkAdd([...frames])
    const before = await readStorageCompactionState(db)
    const pages: number[] = []
    let obsoleteBytes = 0

    for (;;) {
      const page = await runTestStreamJournalTransaction(db, (tx) =>
        retireStreamJournalOwnershipPage(tx, {
          kind: 'owned-metadata-committed',
          streamId: metadata.streamId,
          fence,
        }),
      )
      pages.push(page.deletedFrames)
      obsoleteBytes += page.obsoleteBytes
      if (page.done) break
      expect(await db.streamLeases.get(metadata.streamId)).toEqual(metadata)
    }

    expect(pages).toEqual([64, 64, 2])
    expect(obsoleteBytes).toBe(frameStorageBytes(frames) + estimateStoredValueBytes(metadata))
    await awaitStorageCompactionDebtIdle()
    const after = await readStorageCompactionState(db)
    expect(after.knownReclaimableBytes - before.knownReclaimableBytes).toBe(obsoleteBytes)
    expect(await db.streamChunks.count()).toBe(0)
    expect(await db.streamLeases.count()).toBe(0)
  })

  it('rejects a mismatched stable identity before deleting frames or recording debt', async () => {
    db = createDbForTests(`natter-stream-journal-forged-${crypto.randomUUID()}`)
    await db.open()
    const lease = streamLease({ streamId: 'forged-stream', replacementEpoch: 1 })
    const metadata = terminalLease(lease, [])
    const forgedFrames = await encodeTestStreamJournalEntries({
      streamId: lease.streamId,
      chatId: lease.chatId,
      messageId: lease.messageId,
      fence: { ...leaseFence(lease), replacementEpoch: 2 },
      entries: [{ createdAt: 1, event: { lane: 'text', text: 'forged' } }],
    })
    const forgedLast = forgedFrames.at(-1)
    if (!forgedLast) throw new Error('ExpectedForgedStreamJournalFrame')
    await db.streamLeases.add({
      ...metadata,
      journalMaxSeq: forgedLast.seq,
      journalStorageBytes: frameStorageBytes(forgedFrames),
    })
    await db.streamChunks.bulkAdd([...forgedFrames])
    const before = await readStorageCompactionState(db)

    await expect(
      runTestStreamJournalTransaction(db, (tx) =>
        retireStreamJournalOwnershipPage(tx, {
          kind: 'owned-metadata-committed',
          streamId: lease.streamId,
          fence: leaseFence(lease),
        }),
      ),
    ).rejects.toThrow(`StreamJournalAppendInvariantError:${lease.streamId}:retirement-identity`)
    await awaitStorageCompactionDebtIdle()
    expect(await db.streamChunks.count()).toBe(forgedFrames.length)
    expect(await db.streamLeases.count()).toBe(1)
    expect(await readStorageCompactionState(db)).toEqual(before)
  })

  it('rejects a mixed-stream command before it can enter a transaction', async () => {
    db = createDbForTests(`natter-stream-journal-mixed-${crypto.randomUUID()}`)
    await db.open()
    const first = streamLease({ streamId: 'first-stream' })
    const second = streamLease({ streamId: 'second-stream' })
    const firstFrames = await encodeTestStreamJournalEntries({
      streamId: first.streamId,
      chatId: first.chatId,
      messageId: first.messageId,
      fence: leaseFence(first),
      entries: [{ createdAt: 1, event: { lane: 'text', text: 'first' } }],
    })
    const secondFrames = await encodeTestStreamJournalEntries({
      streamId: second.streamId,
      chatId: second.chatId,
      messageId: second.messageId,
      fence: leaseFence(second),
      entries: [{ createdAt: 1, event: { lane: 'text', text: 'second' } }],
    })
    const before = await readStorageCompactionState(db)

    expect(() => canonicalTestStreamJournalBatch([...firstFrames, ...secondFrames])).toThrow(
      'StreamJournalAppendBatchMixedStreams',
    )
    expect(await db.streamChunks.count()).toBe(0)
    expect(await db.streamLeases.count()).toBe(0)
    expect(await readStorageCompactionState(db)).toEqual(before)
  })
})

function streamLease(
  input: { readonly streamId?: string; readonly replacementEpoch?: number } = {},
): StreamLeaseRow {
  return testGenerationLease({
    streamId: input.streamId ?? 'stream',
    chatId: 'chat',
    messageId: 'message',
    ownerClientId: 'tab',
    fenceToken: 'fence',
    replacementEpoch: input.replacementEpoch ?? 1,
    startedAt: 1,
    heartbeatAt: 1,
    admissionSequence: 1,
    revision: 0,
    targetCommittedAt: 1,
  })
}

function terminalLease(
  lease: StreamLeaseRow,
  frames: readonly CanonicalStreamJournalFrameRow[],
): StreamLeaseRow {
  const lastFrame = frames.at(-1)
  return testGenerationLease({
    phase: 'metadata-committed',
    streamId: lease.streamId,
    chatId: lease.chatId,
    messageId: lease.messageId,
    ownerClientId: streamLeaseHasWriteFence(lease) ? lease.ownerClientId : 'tab',
    fenceToken: streamLeaseHasWriteFence(lease) ? lease.fenceToken : 'fence',
    replacementEpoch: lease.replacementEpoch,
    startedAt: lease.startedAt,
    heartbeatAt: streamLeaseHasWriteFence(lease) ? lease.heartbeatAt : lease.startedAt,
    admissionSequence: lease.admissionSequence,
    revision: lease.revision + 1,
    canonicalAt: 10,
    metadataCommittedAt: 11,
    ...(lastFrame ? { journalMaxSeq: lastFrame.seq } : {}),
    journalStorageBytes: frameStorageBytes(frames),
  })
}

function leaseFence(lease: StreamLeaseRow): StreamWriteFence {
  if (!streamLeaseHasWriteFence(lease)) throw new Error('ExpectedFencedTestLease')
  return {
    ownerClientId: lease.ownerClientId,
    fenceToken: lease.fenceToken,
    replacementEpoch: lease.replacementEpoch,
    admissionSequence: lease.admissionSequence,
  }
}

function frameStorageBytes(frames: readonly CanonicalStreamJournalFrameRow[]): number {
  return frames.reduce((sum, frame) => sum + estimateStreamJournalFrameStorageBytes(frame), 0)
}

function emptyReasoningEnvelope(): ReasoningEnvelopeV1Schema {
  return { schemaVersion: 1, visible: [], carriers: [] }
}

function streamFailure(): GenerationStreamFailureV1
function streamFailure(overrides: Record<string, unknown>): Record<string, unknown>
function streamFailure(
  overrides: Record<string, unknown> = {},
): GenerationStreamFailureV1 | Record<string, unknown> {
  return {
    kind: 'protocol',
    code: 'PROTOCOL',
    message: 'invalid provider stream',
    midStream: true,
    retryable: false,
    ...overrides,
  }
}

function validCanonicalEventsV1(): readonly CanonicalStreamEventV1[] {
  return [
    {
      lane: 'reasoning',
      mutations: [
        {
          kind: 'visible-set',
          part: {
            id: 'visible:v1',
            groupId: 'group:v1',
            kind: 'text',
            text: 'frozen reasoning text',
            format: 'unknown',
            source: { dialect: 'openrouter-chat', choiceIndex: 0 },
          },
        },
      ],
    },
    { lane: 'text', text: 'text' },
    { lane: 'text-annotations', annotations: [], ownerTextLength: 0 },
    { lane: 'tool-call', index: 0 },
    {
      lane: 'server-tool',
      itemType: 'web_search_call',
      status: 'completed',
      itemId: 'server-tool-1',
      outputIndex: 0,
    },
    {
      lane: 'server-tool-output',
      dialect: 'google-gemini',
      itemType: 'tool_result',
      itemId: 'server-tool-1',
      outputIndex: 0,
      output: null,
    },
    { lane: 'content-item', item: { type: 'text', text: 'content' } },
    { lane: 'audio-output' },
    {
      lane: 'output-item-added',
      dialect: 'openai-responses',
      outputIndex: 0,
      item: { type: 'message' },
    },
    {
      lane: 'output-item-done',
      dialect: 'openrouter-responses',
      outputIndex: 0,
      item: { type: 'message' },
    },
    { lane: 'phase', phase: null, outputIndex: 0 },
    {
      lane: 'result-snapshot',
      payload: {
        kind: 'replace',
        textParts: [],
        reasoningEnvelope: emptyReasoningEnvelope(),
        toolCalls: [],
        generatedContent: [],
        serverTools: [],
        providerOutputItems: [],
        phase: null,
      },
      outcome: { kind: 'finish', finishReason: 'stop' },
    },
    { lane: 'usage', usage: {} },
    { lane: 'finish', finishReason: 'stop' },
    { lane: 'terminal', evidence: 'done-sentinel' },
    { lane: 'meta' },
    { lane: 'keepalive', comment: 'ping' },
    {
      lane: 'integrity',
      integrity: {
        category: 'malformed-json-frame',
        adapter: 'responses',
        eventType: 'response.output_text.delta',
        count: 1,
        fingerprint: 'fnv1a32:test',
        characterCount: 1,
      },
    },
    { lane: 'error', error: streamFailure() },
  ] satisfies readonly CanonicalStreamEventV1[]
}

function validCanonicalEventsV2(): readonly CanonicalStreamEventV2[] {
  return validCanonicalEventsV1().map((event): CanonicalStreamEventV2 => {
    if (event.lane === 'reasoning') {
      return {
        lane: 'reasoning',
        mutations: [
          {
            kind: 'visible-set',
            part: {
              id: 'visible:v2',
              groupId: 'group:v2',
              kind: 'summary',
              text: 'current reasoning summary',
              format: 'google-gemini-v1',
              source: {
                dialect: 'gemini-native',
                bridge: 'google-direct',
                candidateIndex: 0,
                partIndex: 0,
              },
            },
          },
        ],
        observed: { firstAt: 1, lastAt: 2 },
      }
    }
    if (event.lane === 'result-snapshot') {
      return {
        lane: 'result-snapshot',
        payload: {
          kind: 'replace',
          textParts: [],
          reasoningEnvelope: currentReasoningEnvelope(),
          toolCalls: [],
          generatedContent: [],
          serverTools: [],
          providerOutputItems: [],
          phase: null,
        },
        outcome: { kind: 'finish', finishReason: 'stop' },
      }
    }
    return event
  })
}

function currentReasoningEnvelope(): ReasoningEnvelopeV2Schema {
  return {
    schemaVersion: 2,
    visible: [
      {
        id: 'visible:v2',
        groupId: 'group:v2',
        kind: 'summary',
        text: 'current reasoning summary',
        format: 'google-gemini-v1',
        source: {
          dialect: 'gemini-native',
          bridge: 'google-direct',
          candidateIndex: 0,
          partIndex: 0,
        },
      },
    ],
    carriers: [
      {
        id: 'carrier:v2',
        groupId: 'group:v2',
        kind: 'gemini-thought-signature',
        data: 'thought-signature',
        bindsVisiblePartId: 'visible:v2',
        format: 'google-gemini-v1',
        source: {
          dialect: 'gemini-native',
          bridge: 'google-direct',
          candidateIndex: 0,
          partIndex: 0,
        },
      },
    ],
  }
}

const REQUIRED_KEY_BY_LANE = {
  reasoning: 'mutations',
  text: 'text',
  'text-annotations': 'annotations',
  'tool-call': 'index',
  'server-tool': 'itemType',
  'server-tool-output': 'output',
  'content-item': 'item',
  'audio-output': 'lane',
  'output-item-added': 'item',
  'output-item-done': 'item',
  phase: 'phase',
  'result-snapshot': 'payload',
  usage: 'usage',
  finish: 'finishReason',
  terminal: 'evidence',
  meta: 'lane',
  keepalive: 'comment',
  integrity: 'integrity',
  error: 'error',
} as const satisfies Record<CanonicalStreamEventV1['lane'], string>
