// @vitest-environment node

import Dexie, { type Transaction } from 'dexie'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { connectionDispatchProfileProof } from '../../src/core/connection-dispatch-proof'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type {
  Chat,
  ChatSettings,
  ConnectionProfile,
  Message,
  MessageId,
} from '../../src/core/types'
import { HEADER_READ_PAGE_SIZE } from '../../src/store/browser-query-pages'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { __resetDbForTests, getDb } from '../../src/store/db'
import {
  type MessageBodyRow,
  type MessageHeaderRow,
  type MessageTextPreviewRow,
  splitMessageForStorage,
} from '../../src/store/message-storage'
import type { StreamLeaseAdmission, WorkspaceMeta } from '../../src/store/repository'
import {
  getStreamClientId,
  releaseStreamOwnershipReservation,
  reserveStreamOwnership,
  type StreamOwnershipReservation,
} from '../../src/store/stream-leases'
import type { WorkspaceCommand, WorkspaceCommandResult } from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import {
  reserveWorkspaceChild,
  runWorkspaceAction,
  runWorkspaceRead,
} from '../../src/store/workspace-runtime'
import { createChat } from '../helpers/chats'
import { testChatConfigurationLinkTransition } from '../helpers/configuration'
import { installGenerationProfile } from '../helpers/generation-engine'
import { testStreamLeaseAdmission } from '../helpers/stream-leases'

const RUN_BENCHMARK = process.env.ATTEMPT_PREPARE_BENCHMARK === '1'
const DB_NAME = 'natter'
const DEPTH = 4_096
const SAMPLE_COUNT = 3
const CONSTRAINED_SAMPLE_COUNT = 8
const MAX_MEDIAN_MS = 147
const MAX_CONSTRAINED_IMMEDIATE_HEAP_MIB = 96
const MAX_CONSTRAINED_ALLOCATION_MIB = 32
const MAX_CONSTRAINED_RETAINED_GROWTH_MIB = 8
const MAX_CONSTRAINED_RAW_OVERHEAD_MS = 64
const MODEL = 'test/attempt-prepare-performance'
const MEBIBYTE = 1024 * 1024

interface DeepPathFixture {
  readonly chat: Chat
  readonly targetId: MessageId
  readonly claims: ReadonlyArray<{
    readonly messageId: MessageId
    readonly parentId: MessageId | null
    readonly requestContextVersion: number
  }>
}

interface PrepareSample {
  readonly wallMs: number
  readonly heapBeforeBytes: number
  readonly immediateHeapBytes: number
}

interface PrepareStructure {
  readonly prepareTransactionCount: number
  readonly claimPageCount: number
  readonly maxClaimPageSize: number
  readonly claimedPageRows: number
  readonly uniqueClaimedRows: number
  readonly claimedRowsRead: number
  readonly transactionIdentities: number
}

let input: Extract<WorkspaceCommand, { kind: 'attempt.prepare' }>['input']
let ownershipReservation: StreamOwnershipReservation | undefined

describe.skipIf(!RUN_BENCHMARK)('attempt.prepare performance gate', () => {
  beforeAll(async () => {
    await reset()
    await openBrowserWorkspace()
    await installGenerationProfile(profile())
    const fixture = await seedDeepPath()
    input = await continuationPrepareInput(fixture)
    ownershipReservation = await runWorkspaceAction('conversation-generation', (permit) =>
      reserveStreamOwnership(reserveWorkspaceChild(permit, 'stream-lease'), input.lease, () => {}),
    )
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    if (ownershipReservation) await releaseStreamOwnershipReservation(ownershipReservation)
    await shutdownBrowserWorkspace()
    await reset()
  })

  it('prepares a 4,096-header path inside the declared timing, transaction, page, and heap bounds', async () => {
    const db = getDb()
    expect(await db.messages.count()).toBe(DEPTH)
    expect(await db.messageBodies.count()).toBe(1)
    expect(await db.messagePreviews.count()).toBe(1)
    const claimedIds = new Set(input.promptPath.claim.headers.map((header) => header.messageId))
    const structure = await measurePrepareStructure(db, claimedIds)
    expect(HEADER_READ_PAGE_SIZE).toBe(256)
    expect(structure.prepareTransactionCount).toBe(1)
    expect(structure.transactionIdentities).toBe(1)
    expect(structure.claimPageCount).toBe(DEPTH / HEADER_READ_PAGE_SIZE)
    expect(structure.maxClaimPageSize).toBeLessThanOrEqual(HEADER_READ_PAGE_SIZE)
    expect(structure.claimedPageRows).toBe(DEPTH)
    expect(structure.uniqueClaimedRows).toBe(DEPTH)
    expect(structure.claimedRowsRead).toBeGreaterThanOrEqual(DEPTH)
    expect(structure.claimedRowsRead).toBeLessThanOrEqual(DEPTH + 2)

    const requestedHeapMb = requestedHeapLimitMb()
    const sampleCount = requestedHeapMb === undefined ? SAMPLE_COUNT : CONSTRAINED_SAMPLE_COUNT
    const claimIds = input.promptPath.claim.headers.map((header) => header.messageId)
    await execute({ kind: 'attempt.prepare', input })
    if (requestedHeapMb !== undefined) {
      await measureRawHeaderMaterialization(db, claimIds)
    }
    const samples: PrepareSample[] = []
    const rawWallMs: number[] = []
    const retainedHeapBytes: number[] = []

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      releaseUnmeasuredGarbage()
      if (requestedHeapMb !== undefined) {
        rawWallMs.push(await measureRawHeaderMaterialization(db, claimIds))
        releaseUnmeasuredGarbage()
      }
      samples.push(await measurePrepareSample(claimIds))
      if (requestedHeapMb !== undefined) {
        releaseUnmeasuredGarbage()
        retainedHeapBytes.push(process.memoryUsage().heapUsed)
      }
    }

    const medianWallMs = median(samples.map((sample) => sample.wallMs))
    const immediateHeapMiB = samples.map((sample) => sample.immediateHeapBytes / MEBIBYTE)
    const allocationMiB = samples.map(
      (sample) => Math.max(0, sample.immediateHeapBytes - sample.heapBeforeBytes) / MEBIBYTE,
    )
    const retainedGrowthBytes = retainedHeapBytes.length
      ? Math.max(
          0,
          Math.max(...retainedHeapBytes.slice(1)) - (retainedHeapBytes[0] ?? 0),
          positiveRetainedSlopeGrowth(retainedHeapBytes),
        )
      : 0
    const medianRawWallMs = rawWallMs.length ? median(rawWallMs) : null
    const pairedRawOverheadMs = rawWallMs.map(
      (rawWall, index) => (samples[index]?.wallMs ?? Number.POSITIVE_INFINITY) - rawWall,
    )
    const medianPairedRawOverheadMs = pairedRawOverheadMs.length
      ? median(pairedRawOverheadMs)
      : null
    console.info(
      `ATTEMPT_PREPARE_BENCHMARK ${JSON.stringify({
        runtime: {
          node: process.version,
          samples: sampleCount,
          requestedHeapMb: requestedHeapMb ?? null,
          forcedGc: process.env.ATTEMPT_PREPARE_MAX_HEAP_MB !== undefined,
        },
        depth: DEPTH,
        pageSize: HEADER_READ_PAGE_SIZE,
        maxMedianMs: MAX_MEDIAN_MS,
        wallMs: samples.map((sample) => round(sample.wallMs)),
        medianWallMs: round(medianWallMs),
        structure,
        immediateHeapMiB: immediateHeapMiB.map(round),
        allocationMiB: allocationMiB.map(round),
        retainedHeapMiB: retainedHeapBytes.map((bytes) => round(bytes / MEBIBYTE)),
        retainedGrowthMiB: round(retainedGrowthBytes / MEBIBYTE),
        rawWallMs: rawWallMs.map(round),
        medianRawWallMs: medianRawWallMs === null ? null : round(medianRawWallMs),
        pairedRawOverheadMs: pairedRawOverheadMs.map(round),
        medianPairedRawOverheadMs:
          medianPairedRawOverheadMs === null ? null : round(medianPairedRawOverheadMs),
      })}`,
    )
    if (requestedHeapMb !== undefined) {
      expect(requestedHeapMb).toBe(128)
      expect(Math.max(...immediateHeapMiB)).toBeLessThanOrEqual(MAX_CONSTRAINED_IMMEDIATE_HEAP_MIB)
      expect(Math.max(...allocationMiB)).toBeLessThanOrEqual(MAX_CONSTRAINED_ALLOCATION_MIB)
      expect(retainedGrowthBytes).toBeLessThanOrEqual(
        MAX_CONSTRAINED_RETAINED_GROWTH_MIB * MEBIBYTE,
      )
      expect(medianPairedRawOverheadMs).not.toBeNull()
      expect(medianPairedRawOverheadMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
        MAX_CONSTRAINED_RAW_OVERHEAD_MS,
      )
    } else {
      expect(medianWallMs).toBeLessThanOrEqual(MAX_MEDIAN_MS)
    }
  }, 30_000)
})

async function measurePrepareSample(claimIds: readonly MessageId[]): Promise<PrepareSample> {
  const heapBeforeBytes = process.memoryUsage().heapUsed
  const startedAt = performance.now()
  const prepared = await execute({ kind: 'attempt.prepare', input })
  const wallMs = performance.now() - startedAt
  const immediateHeapBytes = process.memoryUsage().heapUsed
  if (prepared.strategy !== 'continue' || prepared.prompt.headers.length !== claimIds.length) {
    throw new Error('AttemptPrepareSampleShapeMismatch')
  }
  for (let index = 0; index < claimIds.length; index += 1) {
    if (prepared.prompt.headers[index]?.id !== claimIds[index]) {
      throw new Error(`AttemptPrepareSampleHeaderMismatch:${index}`)
    }
  }
  return { wallMs, heapBeforeBytes, immediateHeapBytes }
}

async function measureRawHeaderMaterialization(
  db: ReturnType<typeof getDb>,
  claimIds: readonly MessageId[],
): Promise<number> {
  const startedAt = performance.now()
  const materialized = await db.transaction('r', db.messages, async () => {
    const headers: MessageHeaderRow[] = []
    for (let offset = 0; offset < claimIds.length; offset += HEADER_READ_PAGE_SIZE) {
      const ids = claimIds.slice(offset, offset + HEADER_READ_PAGE_SIZE)
      const rows = await db.messages.bulkGet(ids)
      for (let index = 0; index < ids.length; index += 1) {
        const row = rows[index]
        if (!row || row.id !== ids[index])
          throw new Error(`AttemptPrepareRawHeaderMissing:${offset}`)
        headers.push(row)
      }
    }
    return headers
  })
  const wallMs = performance.now() - startedAt
  expect(materialized).toHaveLength(DEPTH)
  return wallMs
}

async function measurePrepareStructure(
  db: ReturnType<typeof getDb>,
  claimedIds: ReadonlySet<MessageId>,
): Promise<PrepareStructure> {
  const messageTablePrototype = Object.getPrototypeOf(db.messages) as typeof db.messages
  const bulkGet = vi.spyOn(messageTablePrototype, 'bulkGet')
  const transaction = vi.spyOn(db, 'transaction')
  const transactionIdentities = new Set<Transaction>()
  const claimedRowsRead: MessageId[] = []
  const reading = (header: MessageHeaderRow | undefined): MessageHeaderRow | undefined => {
    if (!header || !claimedIds.has(header.id)) return header
    const current = Dexie.currentTransaction
    transactionIdentities.add(current)
    claimedRowsRead.push(header.id)
    return header
  }
  db.messages.hook('reading', reading)
  try {
    const prepared = await execute({ kind: 'attempt.prepare', input })
    expect(prepared.strategy).toBe('continue')
    const claimPages = bulkGet.mock.calls
      .map(([ids]) => [...ids] as MessageId[])
      .filter((ids) => ids.length > 0 && ids.every((id) => claimedIds.has(id)))
    const pageRows = claimPages.flat()
    return {
      prepareTransactionCount: transaction.mock.calls.filter((call) =>
        transactionCallIncludesTable(call, 'messages'),
      ).length,
      claimPageCount: claimPages.length,
      maxClaimPageSize: Math.max(0, ...claimPages.map((page) => page.length)),
      claimedPageRows: pageRows.length,
      uniqueClaimedRows: new Set(pageRows).size,
      claimedRowsRead: claimedRowsRead.length,
      transactionIdentities: transactionIdentities.size,
    }
  } finally {
    db.messages.hook('reading').unsubscribe(reading)
    bulkGet.mockRestore()
    transaction.mockRestore()
  }
}

async function seedDeepPath(): Promise<DeepPathFixture> {
  const chat = await createChat({ id: 'attempt-prepare-performance-chat', settings: settings() })
  const headers: MessageHeaderRow[] = []
  let targetBody: MessageBodyRow | undefined
  let targetPreview: MessageTextPreviewRow | undefined
  const claims: Array<{
    messageId: MessageId
    parentId: MessageId | null
    requestContextVersion: number
  }> = []
  let parentId: MessageId | null = null
  for (let index = 0; index < DEPTH; index += 1) {
    const id = `attempt-prepare-performance-message-${index}`
    const assistant = index % 2 === 1
    const message: Message = {
      id,
      chatId: chat.id,
      parentId,
      siblingIndex: 0,
      turnId: `attempt-prepare-performance-turn-${Math.floor(index / 2)}`,
      turnIndex: assistant ? 1 : 0,
      createdAt: index + 1,
      role: assistant ? 'assistant' : 'user',
      origin: assistant ? 'generated' : 'user',
      content: [
        assistant
          ? { type: 'output_text', text: `answer-${index}` }
          : { type: 'text', text: `question-${index}` },
      ],
      nodeVersion: 0,
      deleted: false,
    }
    const split = splitMessageForStorage(message)
    headers.push(split.header)
    if (index === DEPTH - 1) {
      targetBody = split.body
      targetPreview = split.preview
    }
    claims.push({
      messageId: split.header.id,
      parentId: split.header.parentId,
      requestContextVersion: split.header.requestContextVersion,
    })
    parentId = id
  }
  if (!parentId) throw new Error('AttemptPreparePerformanceTargetMissing')
  if (!targetBody || !targetPreview) throw new Error('AttemptPreparePerformanceTargetBodyMissing')

  const db = getDb()
  const seededChat: Chat = {
    ...chat,
    structuralVersion: DEPTH,
    lastUpdatedLeafId: parentId,
    lastBranchUpdatedAt: DEPTH,
  }
  await db.transaction(
    'rw',
    [db.chats, db.messages, db.messageBodies, db.messagePreviews],
    async () => {
      await db.chats.put(seededChat)
      await db.messages.bulkPut(headers)
      await db.messageBodies.put(targetBody)
      await db.messagePreviews.put(targetPreview)
    },
  )
  headers.length = 0
  return { chat: seededChat, targetId: parentId, claims }
}

async function continuationPrepareInput(
  deepPath: DeepPathFixture,
): Promise<Extract<WorkspaceCommand, { kind: 'attempt.prepare' }>['input']> {
  const startedAt = Date.now()
  const workspace = await workspaceMeta()
  const lease: StreamLeaseAdmission = testStreamLeaseAdmission({
    streamId: 'attempt-prepare-performance-stream',
    chatId: deepPath.chat.id,
    messageId: deepPath.targetId,
    ownerClientId: getStreamClientId(),
    fenceToken: 'attempt-prepare-performance-fence',
    replacementEpoch: workspace.replacementEpoch,
    startedAt,
    heartbeatAt: startedAt,
    attemptKind: 'continuation',
  })
  const selectedProfile = profile()
  return {
    strategy: 'continue',
    lease,
    configurationLinkTransition: testChatConfigurationLinkTransition(deepPath.chat),
    promptPath: {
      requirement: {
        kind: 'continue',
        surface: 'chat',
        chatId: deepPath.chat.id,
        target: {
          kind: 'include',
          messageId: deepPath.targetId,
          role: 'assistant',
        },
        childSlot: 'none',
      },
      claim: {
        chatId: deepPath.chat.id,
        structuralVersion: deepPath.chat.structuralVersion,
        leafId: deepPath.targetId,
        headers: deepPath.claims,
        placementSlot: null,
        targetTurn: null,
      },
    },
    configurationClaim: {
      configurationVersion: deepPath.chat.configurationVersion ?? 0,
      settings: deepPath.chat.settings,
      presetId: deepPath.chat.presetId ?? null,
      profile: connectionDispatchProfileProof(selectedProfile, MODEL),
      requestRevision: {
        profileId: selectedProfile.id,
        requestRevision: selectedProfile.requestRevision ?? 0,
        key: { kind: 'missing' },
      },
      dispatchKeyRevisions: [],
      preferredDispatchKeyId: null,
      workspaceSettingOverrides: [],
    },
  }
}

function profile(): ConnectionProfile {
  return {
    id: 'attempt-prepare-performance-profile',
    name: 'Attempt prepare performance profile',
    kind: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: 'http://localhost:5173',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

function settings(): ChatSettings {
  return {
    ...cloneDefaultChatSettings(),
    profileId: profile().id,
    model: MODEL,
  }
}

async function execute<C extends WorkspaceCommand>(command: C): Promise<WorkspaceCommandResult<C>> {
  return runWorkspaceAction('conversation-generation', async (permit) => {
    return (await getWorkspaceRepository().execute(permit, command)).value
  })
}

async function workspaceMeta(): Promise<WorkspaceMeta> {
  return runWorkspaceRead('repository-query', async (permit) => {
    return (
      await getWorkspaceRepository().query(
        permit,
        { kind: 'workspace.meta' },
        { signal: permit.signal },
      )
    ).value
  })
}

async function reset(): Promise<void> {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

function requestedHeapLimitMb(): number | undefined {
  const raw = process.env.ATTEMPT_PREPARE_MAX_HEAP_MB
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`AttemptPrepareHeapLimitInvalid:${raw}`)
  }
  const argumentsText = [...process.execArgv, process.env.NODE_OPTIONS ?? ''].join(' ')
  if (!argumentsText.includes(`--max-old-space-size=${value}`)) {
    throw new Error(`AttemptPrepareHeapLimitNotApplied:${value}`)
  }
  return value
}

function releaseUnmeasuredGarbage(): void {
  if (process.env.ATTEMPT_PREPARE_MAX_HEAP_MB === undefined) return
  const collect = (globalThis as typeof globalThis & { gc?: () => void }).gc
  if (!collect) throw new Error('AttemptPrepareGarbageCollectorUnavailable')
  collect()
}

function transactionCallIncludesTable(call: readonly unknown[], tableName: string): boolean {
  return call.some((argument) => {
    if (Array.isArray(argument)) {
      return (argument as unknown[]).some(
        (table) =>
          table !== null &&
          typeof table === 'object' &&
          'name' in table &&
          table.name === tableName,
      )
    }
    return (
      argument !== null &&
      typeof argument === 'object' &&
      'name' in argument &&
      argument.name === tableName
    )
  })
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] as number
}

function positiveRetainedSlopeGrowth(values: readonly number[]): number {
  const slopes: number[] = []
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      slopes.push(((values[right] ?? 0) - (values[left] ?? 0)) / (right - left))
    }
  }
  return Math.max(0, median(slopes)) * Math.max(0, values.length - 1)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
