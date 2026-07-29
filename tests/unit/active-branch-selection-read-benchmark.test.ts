// @vitest-environment node

import Dexie, { type Table, type Transaction } from 'dexie'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildChildSlotProjection } from '../../src/core/child-list-state'
import { resolvingConversationSelectionTarget } from '../../src/core/messages'
import type {
  Chat,
  ChildListState,
  ChildSlotMember,
  Message,
  MessageId,
} from '../../src/core/types'
import {
  type BranchSelectionReadMeasurement,
  type ConversationOpenFrameStore,
  createBranchSelectionReadMeasurement,
  readConversationOpenInitialReceiptInTransaction,
  resolveConversationOpenReceipt,
} from '../../src/store/browser-active-branch-spine'
import { buildChat } from '../../src/store/chats'
import { type MessageHeaderRow, splitMessageForStorage } from '../../src/store/message-storage'

const RUN_BENCHMARK = process.env.BRANCH_SELECTION_BENCHMARK === '1'
const DEPTHS = [8, 32, 128, 512, 4_096] as const
const WIDTH_CONTROL_DEPTH = 128
const WIDTH_CONTROL_ROWS = 8_192
const SAMPLE_COUNT = 3

interface BranchSelectionBenchmarkDatabase extends Dexie {
  messages: Table<MessageHeaderRow, MessageId>
  childLists: Table<ChildListState, string>
  childSlotMembers: Table<ChildSlotMember, MessageId>
}

interface SelectionSample {
  readonly wallMs: number
  readonly measurement: BranchSelectionReadMeasurement
  readonly pathLength: number
}

interface WriterProbe {
  readonly waitMs: number
  readonly physicalRequestsBeforeCompletion: number
}

let db: BranchSelectionBenchmarkDatabase
const scenarios = new Map<string, { readonly chat: Chat; readonly headers: MessageHeaderRow[] }>()

beforeAll(async () => {
  db = new Dexie(
    `active-branch-selection-benchmark-${crypto.randomUUID()}`,
  ) as BranchSelectionBenchmarkDatabase
  db.version(1).stores({
    messages: 'id,chatId,[chatId+createdAt+id]',
    childLists: 'id,chatId',
    childSlotMembers: 'id,chatId',
  })
  await db.open()

  for (const depth of DEPTHS) {
    const scenario = linearScenario(`depth-${depth}`, depth)
    scenarios.set(`depth-${depth}`, scenario)
    await seedScenario(scenario)
  }

  const widthControl = linearScenario('width-control', WIDTH_CONTROL_DEPTH, WIDTH_CONTROL_ROWS)
  scenarios.set('width-control', widthControl)
  await seedScenario(widthControl)
})

afterAll(async () => {
  const name = db.name
  db.close()
  await Dexie.delete(name)
})

describe.skipIf(!RUN_BENCHMARK)('active branch selection read benchmark', () => {
  it('measures the current destination proof path across depth, width, and a queued writer', async () => {
    const results: Array<{
      readonly name: string
      readonly selectedDepth: number
      readonly storedRows: number
      readonly wallMs: readonly number[]
      readonly medianWallMs: number
      readonly measurement: BranchSelectionReadMeasurement
    }> = []

    for (const depth of DEPTHS) {
      const scenario = requiredScenario(`depth-${depth}`)
      const samples = await sampleScenario(scenario)
      assertEquivalentMeasurements(samples)
      for (const sample of samples) expect(sample.pathLength).toBe(depth)
      results.push({
        name: `depth-${depth}`,
        selectedDepth: depth,
        storedRows: scenario.headers.length,
        wallMs: samples.map((sample) => round(sample.wallMs)),
        medianWallMs: round(median(samples.map((sample) => sample.wallMs))),
        measurement: samples[0]?.measurement as BranchSelectionReadMeasurement,
      })
    }

    const widthControl = requiredScenario('width-control')
    const widthSamples = await sampleScenario(widthControl)
    assertEquivalentMeasurements(widthSamples)
    for (const sample of widthSamples) expect(sample.pathLength).toBe(WIDTH_CONTROL_DEPTH)
    results.push({
      name: 'depth-128-width-8192',
      selectedDepth: WIDTH_CONTROL_DEPTH,
      storedRows: widthControl.headers.length,
      wallMs: widthSamples.map((sample) => round(sample.wallMs)),
      medianWallMs: round(median(widthSamples.map((sample) => sample.wallMs))),
      measurement: widthSamples[0]?.measurement as BranchSelectionReadMeasurement,
    })

    const depthControl = results.find((result) => result.name === 'depth-128')
    const widthResult = results.find((result) => result.name === 'depth-128-width-8192')
    const shallowResult = results.find((result) => result.name === 'depth-8')
    expect(depthControl).toBeDefined()
    expect(widthResult).toBeDefined()
    expect(shallowResult?.measurement).toMatchObject({
      pathFrames: 1,
      slotFrames: 1,
      forkSlotsRead: 0,
    })
    expect(widthResult?.measurement.physicalHeaderReadRequests).toBe(
      depthControl?.measurement.physicalHeaderReadRequests,
    )
    expect(widthResult?.measurement.physicalHeaderRowsRead).toBeLessThanOrEqual(265)

    const writerProbe = await measureQueuedWriter(requiredScenario('depth-4096'))
    expect(
      results.find((result) => result.name === 'depth-4096')?.measurement.pathFrames,
    ).toBeLessThanOrEqual(65)
    expect(writerProbe.physicalRequestsBeforeCompletion).toBeLessThanOrEqual(64)

    console.info(
      `BRANCH_SELECTION_BENCHMARK ${JSON.stringify({
        runtime: {
          node: process.version,
          indexedDb: 'fake-indexeddb',
          samples: SAMPLE_COUNT,
        },
        results,
        writerProbe: {
          waitMs: round(writerProbe.waitMs),
          physicalRequestsBeforeCompletion: writerProbe.physicalRequestsBeforeCompletion,
        },
      })}`,
    )
  }, 30_000)
})

async function sampleScenario(scenario: {
  readonly chat: Chat
  readonly headers: readonly MessageHeaderRow[]
}): Promise<SelectionSample[]> {
  await readSelection(scenario.chat)
  const samples: SelectionSample[] = []
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    samples.push(await readSelection(scenario.chat))
  }
  return samples
}

async function readSelection(chat: Chat): Promise<SelectionSample> {
  const measurement = createBranchSelectionReadMeasurement()
  const target = resolvingConversationSelectionTarget({ kind: 'default' })
  const startedAt = performance.now()
  const receipt = await db.transaction('r', db.messages, (tx) =>
    readConversationOpenInitialReceiptInTransaction(
      tx,
      chat.id,
      structuredClone(chat),
      target,
      undefined,
      measurement,
    ),
  )
  const result = await resolveConversationOpenReceipt(
    {
      runFrame: (stores, read) => runReadFrame(stores, read),
    },
    receipt,
    'none',
    undefined,
    undefined,
    measurement,
  )
  const wallMs = performance.now() - startedAt
  expect(result.kind).toBe('ready')
  if (result.kind !== 'ready') throw new Error(`BenchmarkSelectionFailed:${result.kind}`)
  expect(result.proof.tipId).toBe(chat.lastUpdatedLeafId)
  return {
    wallMs,
    measurement: structuredClone(measurement),
    pathLength: result.proof.pathHeaders.length,
  }
}

async function measureQueuedWriter(scenario: {
  readonly chat: Chat
  readonly headers: readonly MessageHeaderRow[]
}): Promise<WriterProbe> {
  const measurement = createBranchSelectionReadMeasurement()
  const target = resolvingConversationSelectionTarget({ kind: 'default' })
  const receipt = await db.transaction('r', db.messages, (tx) =>
    readConversationOpenInitialReceiptInTransaction(
      tx,
      scenario.chat.id,
      structuredClone(scenario.chat),
      target,
      undefined,
      measurement,
    ),
  )
  let writerStartedAt = 0
  let writerFinishedAt = 0
  let writerStartRequests = 0
  let writerEndRequests = 0
  let writerPromise: Promise<void> | undefined
  let frameNumber = 0
  const result = await resolveConversationOpenReceipt(
    {
      runFrame: (stores, read) => {
        frameNumber += 1
        return runReadFrame(stores, async (tx) => {
          if (frameNumber === 1) {
            writerStartedAt = performance.now()
            writerStartRequests = measurement.physicalHeaderReadRequests
            writerPromise = Dexie.ignoreTransaction(async () => {
              await db.transaction('rw', db.messages, async () => {
                await db.messages.put(benchmarkHeader('writer-probe', null, 0, 0))
              })
              writerEndRequests = measurement.physicalHeaderReadRequests
              writerFinishedAt = performance.now()
            })
          }
          return read(tx)
        })
      },
    },
    receipt,
    'none',
    undefined,
    undefined,
    measurement,
  )
  expect(result.kind).toBe('ready')
  if (!writerPromise) throw new Error('BenchmarkWriterProbeDidNotStart')
  await writerPromise
  return {
    waitMs: writerFinishedAt - writerStartedAt,
    physicalRequestsBeforeCompletion: writerEndRequests - writerStartRequests,
  }
}

function runReadFrame<T>(
  stores: readonly ConversationOpenFrameStore[],
  read: (tx: Transaction) => Promise<T>,
) {
  const tables = stores.map((store) => {
    switch (store) {
      case 'messages':
        return db.messages
      case 'childLists':
        return db.childLists
      case 'childSlotMembers':
        return db.childSlotMembers
      case 'messageBodies':
        throw new Error('BenchmarkDoesNotReadMessageBodies')
      default:
        throw new Error('BenchmarkStoreUnsupported')
    }
  })
  return db.transaction('r', tables, async (tx) => ({
    kind: 'ready' as const,
    value: await read(tx),
  }))
}

async function seedScenario(scenario: {
  readonly chat: Chat
  readonly headers: readonly MessageHeaderRow[]
}): Promise<void> {
  const projection = buildChildSlotProjection(scenario.chat.id, scenario.headers, {
    updatedAt: 1,
  })
  await db.transaction('rw', [db.messages, db.childLists, db.childSlotMembers], async () => {
    await db.messages.bulkPut(scenario.headers)
    await db.childLists.bulkPut(projection.states)
    await db.childSlotMembers.bulkPut(projection.members)
  })
}

function linearScenario(prefix: string, depth: number, unrelatedWidth = 0) {
  const chatId = `selection-benchmark-${prefix}`
  const spine: MessageHeaderRow[] = []
  let parentId: MessageId | null = null
  for (let index = 0; index < depth; index += 1) {
    const header = benchmarkHeader(`${chatId}-spine-${index}`, parentId, index, index, chatId)
    spine.push(header)
    parentId = header.id
  }
  const unrelated = Array.from({ length: unrelatedWidth }, (_, index) =>
    benchmarkHeader(
      `${chatId}-wide-${index}`,
      spine[0]?.id ?? null,
      index + 1,
      depth + index,
      chatId,
    ),
  )
  const chat = {
    ...buildChat({ id: chatId, now: 1 }),
    structuralVersion: depth + unrelatedWidth,
    lastUpdatedLeafId: parentId,
    lastBranchUpdatedAt: depth,
  }
  return { chat, headers: [...spine, ...unrelated] }
}

function benchmarkHeader(
  id: MessageId,
  parentId: MessageId | null,
  siblingIndex: number,
  index: number,
  chatId = 'selection-benchmark-writer',
): MessageHeaderRow {
  const message: Message = {
    id,
    chatId,
    parentId,
    siblingIndex,
    turnId: `${id}-turn`,
    turnIndex: index,
    createdAt: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    origin: index % 2 === 0 ? 'user' : 'generated',
    content: [{ type: index % 2 === 0 ? 'text' : 'output_text', text: id }],
    nodeVersion: 0,
    deleted: false,
  }
  return splitMessageForStorage(message).header
}

function requiredScenario(name: string) {
  const scenario = scenarios.get(name)
  if (!scenario) throw new Error(`BenchmarkScenarioMissing:${name}`)
  return scenario
}

function assertEquivalentMeasurements(samples: readonly SelectionSample[]): void {
  const first = samples[0]
  expect(first).toBeDefined()
  for (const sample of samples.slice(1)) expect(sample.measurement).toEqual(first?.measurement)
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
