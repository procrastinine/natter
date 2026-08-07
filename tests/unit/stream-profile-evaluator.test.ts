import { describe, expect, it } from 'vitest'
import {
  evaluateConcurrentStreamProfile,
  evaluateStreamProfile,
  type StreamProfileHeapSample,
  type StreamProfilePhase,
  type StreamProfileReport,
  type StreamProfileStoreState,
  streamProfilePhaseLabel,
} from '../../scripts/stream-profile-evaluator.mjs'

const MIB = 1024 * 1024

describe('stream profile evaluator', () => {
  it('accepts a forced-GC profile whose released surfaces and resident heap stay frozen', () => {
    const result = evaluateStreamProfile(passingReport())

    expect(result.status).toBe('pass')
    expect(result.problems).toEqual([])
    expect(result.metrics.gcRetainedGrowthBytes).toBe(-5 * MIB)
    expect(result.metrics['tree.heap.slope']).toBeCloseTo(0.1 * MIB)
    expect(result.metrics['transcript.heap.slope']).toBeCloseTo(0.1 * MIB)
  })

  it('rejects retained heap growth after release and reload', () => {
    const report = mutableReport()
    sample(report, { kind: 'recycled' }).usedSize = 38 * MIB
    sample(report, { kind: 'reload', ordinal: 2 }).usedSize = 36 * MIB

    const result = evaluateStreamProfile(report)

    expect(problemCodes(result)).toContain('profile.heap.gc-retained-growth')
    expect(problemCodes(result)).toContain('profile.heap.reload-slope')
  })

  it('rejects missing, active, or overlapping IndexedDB capture evidence', () => {
    const missing = mutableReport()
    const missingSample = sample(missing, { kind: 'reload', ordinal: 1 })
    Reflect.deleteProperty(missingSample.debugState, 'measurementTransactions')

    const active = mutableReport()
    sample(active, {
      kind: 'reload',
      ordinal: 1,
    }).debugState.measurementTransactions.activeBeforeCapture = 1

    const overlapping = mutableReport()
    sample(overlapping, {
      kind: 'reload',
      ordinal: 1,
    }).debugState.measurementTransactions.revisionBeforeCapture += 1

    expect(problemCodes(evaluateStreamProfile(missing))).toContain(
      'profile.capture.idb-evidence-missing',
    )
    expect(problemCodes(evaluateStreamProfile(active))).toContain(
      'profile.capture.idb-active-before-capture',
    )
    expect(problemCodes(evaluateStreamProfile(overlapping))).toContain(
      'profile.capture.idb-revision-drift',
    )
  })

  it('does not treat IndexedDB request success as transaction completion', async () => {
    const databaseName = `stream-profile-transaction-${crypto.randomUUID()}`
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('rows')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const transaction = database.transaction('rows', 'readwrite')
      let transactionCompleted = false
      const terminal = new Promise<void>((resolve, reject) => {
        transaction.addEventListener(
          'complete',
          () => {
            transactionCompleted = true
            resolve()
          },
          { once: true },
        )
        transaction.addEventListener('abort', () => reject(transaction.error), { once: true })
      })
      const request = transaction.objectStore('rows').put({ value: 'proof' }, 'row')
      await new Promise<void>((resolve, reject) => {
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })

      expect(transactionCompleted).toBe(false)
      await terminal
      expect(transactionCompleted).toBe(true)
    } finally {
      database.close()
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
        request.onblocked = () => reject(new Error('profile proof database deletion blocked'))
      })
    }
  })

  it('rejects hidden tree bodies and nodes that survive a transcript handoff', () => {
    const report = mutableReport()
    const transcript = state(report, { kind: 'surface', surface: 'transcript', cycle: 2 }).state
    transcript.treeNodeCount = 25
    transcript.treePreviewTextChars = 1_000
    transcript.treeInspectorTextChars = 2_000

    expect(problemCodes(evaluateStreamProfile(report))).toEqual(
      expect.arrayContaining([
        'profile.dom.hidden-tree-nodes',
        'profile.dom.hidden-tree-preview-material',
        'profile.dom.hidden-tree-inspector-material',
      ]),
    )
  })

  it('rejects positive cycle heap slope and a rising frozen ceiling', () => {
    const report = mutableReport()
    sample(report, { kind: 'surface', surface: 'tree', cycle: 1 }).usedSize = 30 * MIB
    sample(report, { kind: 'surface', surface: 'tree', cycle: 2 }).usedSize = 36 * MIB
    sample(report, { kind: 'surface', surface: 'tree', cycle: 3 }).usedSize = 42 * MIB

    expect(problemCodes(evaluateStreamProfile(report))).toEqual(
      expect.arrayContaining(['profile.heap.tree-slope', 'profile.heap.tree-ceiling']),
    )
  })

  it('rejects a profile that never exceeds or releases the configured transcript demand', () => {
    const report = mutableReport()
    const preRelease = state(report, { kind: 'pre-release' }).state
    preRelease.totalMessages = 10
    preRelease.loadedMessages = 10
    preRelease.mountedMessages = 10
    preRelease.virtualized = false
    preRelease.assistantTextLengths = Array.from({ length: 5 }, () => 100_000)

    expect(problemCodes(evaluateStreamProfile(report))).toEqual(
      expect.arrayContaining([
        'profile.demand.branch-depth',
        'profile.demand.expanded-transcript-not-virtualized',
      ]),
    )
  })

  it('separates loaded branch demand from the bounded virtualized DOM window', () => {
    const report = mutableReport()
    const preRelease = state(report, { kind: 'pre-release' }).state
    preRelease.loadedMessages = 19
    preRelease.mountedMessages = 11
    preRelease.assistantTextLengths = []

    expect(problemCodes(evaluateStreamProfile(report))).toEqual(
      expect.arrayContaining([
        'profile.demand.expanded-transcript',
        'profile.demand.mounted-transcript-window',
        'profile.demand.visible-assistant-floor',
      ]),
    )
  })

  it('classifies a red recorded report without launching a second test process', () => {
    const report = mutableReport()
    sample(report, { kind: 'surface', surface: 'tree', cycle: 3 }).usedSize = 45 * MIB

    expect(evaluateStreamProfile(report)).toMatchObject({ status: 'fail' })
    expect(evaluateStreamProfile(passingReport())).toMatchObject({ status: 'pass' })
  })

  it('accepts exact application admission with transport-local provider concurrency', () => {
    const result = evaluateConcurrentStreamProfile(passingConcurrentReport())

    expect(result.status).toBe('pass')
    expect(result.problems).toEqual([])
    expect(result.metrics.reloadGrowthBytes).toBe(4 * MIB)
  })

  it('rejects concurrent under-admission, retained state, reload corruption, and diagnostics', () => {
    const report = passingConcurrentReport()
    report.applicationAdmissionPhases.currentTurn.observed = 99
    const firstPage = report.pageStates.at(0)
    if (!firstPage) throw new Error('expected at least one concurrent profile page')
    firstPage.activeCount = 1
    report.afterReload.failures.push('corrupt')
    report.consoleProblems.push({ type: 'warning', text: 'unexpected' })

    expect(problemCodes(evaluateConcurrentStreamProfile(report))).toEqual(
      expect.arrayContaining([
        'concurrent-profile.admission.currentTurn.observed',
        'concurrent-profile.page.0.active',
        'concurrent-profile.after-reload.failures',
        'concurrent-profile.console-problems',
      ]),
    )
  })

  it('rejects malformed concurrent report shapes', () => {
    expect(problemCodes(evaluateConcurrentStreamProfile({ schemaVersion: 2 }))).toEqual([
      'concurrent-profile.schema.report',
    ])
  })
})

function passingConcurrentReport() {
  const persistence = () => ({
    checkedRows: 100,
    regenerationRowsChecked: 100,
    leaseCount: 0,
    chunkCount: 0,
    failures: [] as string[],
  })
  const heap = (usedBytes: number) => ({
    measuredPages: 10,
    usedBytes,
    maxPageUsedBytes: usedBytes / 10,
    totalHeapBytes: usedBytes * 2,
    documents: 10,
    nodes: 1_000,
    listeners: 100,
  })
  return {
    schemaVersion: 2,
    measurementModel: 'external-http-ui-v1',
    scenario: {
      pageCount: 10,
      streamsPerPage: 10,
      totalStreams: 100,
      contextChars: 100_000,
      targetChars: 100_000,
      reasoningChars: 100_000,
      regenerationCount: 100,
      totalPersistedChars: 50_000_000,
    },
    providerPhases: {
      previousTurn: { maxActiveStreams: 6 },
      currentTurn: { maxActiveStreams: 6 },
      regeneration: { maxActiveStreams: 6 },
    },
    applicationAdmissionPhases: {
      previousTurn: { expected: 100, observed: 100, statuses: { active: 100 }, failures: [] },
      currentTurn: { expected: 100, observed: 100, statuses: { active: 100 }, failures: [] },
      regeneration: { expected: 100, observed: 100, statuses: { active: 100 }, failures: [] },
    },
    seed: { outcome: 'done' },
    resultCounts: { done: 100 },
    regenerationResultCounts: { done: 100 },
    beforeReload: persistence(),
    afterReload: persistence(),
    pageStates: Array.from({ length: 10 }, () => ({
      activeCount: 0,
      liveSnapshotCount: 0,
      streamChunkCount: 0,
    })),
    consoleProblems: [] as unknown[],
    failures: [] as string[],
    heap: {
      baseline: heap(100 * MIB),
      afterPrevious: heap(110 * MIB),
      afterCurrent: heap(120 * MIB),
      afterRegeneration: heap(125 * MIB),
      afterReload: heap(129 * MIB),
    },
  }
}

function passingReport(): StreamProfileReport {
  const phases: StreamProfilePhase[] = [
    { kind: 'fresh' },
    ...Array.from(
      { length: 10 },
      (_, index): StreamProfilePhase => ({
        kind: 'turn-settled',
        ordinal: index + 1,
      }),
    ),
    ...Array.from(
      { length: 5 },
      (_, index): StreamProfilePhase => ({
        kind: 'regeneration-settled',
        ordinal: index + 1,
      }),
    ),
    { kind: 'pre-release' },
    { kind: 'recycled' },
    ...Array.from({ length: 3 }, (_, index): StreamProfilePhase[] => [
      { kind: 'surface', surface: 'tree', cycle: index + 1 },
      { kind: 'surface', surface: 'transcript', cycle: index + 1 },
    ]).flat(),
    { kind: 'reload', ordinal: 1 },
    { kind: 'reload', ordinal: 2 },
  ]
  const usedSize = new Map<string, number>([
    ['fresh', 10 * MIB],
    ['pre-release', 35 * MIB],
    ['recycled', 30 * MIB],
    ['surface:tree:1', 31 * MIB],
    ['surface:tree:2', 31.1 * MIB],
    ['surface:tree:3', 31.2 * MIB],
    ['surface:transcript:1', 29 * MIB],
    ['surface:transcript:2', 29.1 * MIB],
    ['surface:transcript:3', 29.2 * MIB],
    ['reload:1', 28 * MIB],
    ['reload:2', 28.1 * MIB],
  ])
  const samples = phases.map(
    (phase, index): StreamProfileHeapSample => ({
      phase,
      label: streamProfilePhaseLabel(phase),
      usedSize: usedSize.get(key(phase)) ?? (12 + index) * MIB,
      totalSize: 64 * MIB,
      dom: {
        documents: 1,
        jsEventListeners: phase.kind === 'surface' && phase.surface === 'tree' ? 32 : 24,
        nodes: phase.kind === 'surface' && phase.surface === 'tree' ? 1_500 : 800,
      },
      debugState: {
        measurementTransactions: {
          activeBeforeGarbageCollection: 0,
          activeBeforeCapture: 0,
          activeAfterCapture: 0,
          revisionBeforeGarbageCollection: index * 2,
          revisionBeforeCapture: index * 2,
          revisionAfterCapture: index * 2,
          attempts: 1,
        },
      },
    }),
  )
  const statePhases: StreamProfilePhase[] = [
    { kind: 'pre-release' },
    { kind: 'recycled' },
    ...Array.from({ length: 3 }, (_, index): StreamProfilePhase[] => [
      { kind: 'surface', surface: 'tree', cycle: index + 1 },
      { kind: 'surface', surface: 'transcript', cycle: index + 1 },
    ]).flat(),
    { kind: 'reload', ordinal: 1 },
    { kind: 'reload', ordinal: 2 },
  ]
  const storeStates = statePhases.map((phase): StreamProfileStoreState => {
    const preRelease = phase.kind === 'pre-release'
    const tree = phase.kind === 'surface' && phase.surface === 'tree'
    return {
      phase,
      label: streamProfilePhaseLabel(phase),
      state: {
        mountedMessages: preRelease ? 9 : 10,
        loadedMessages: preRelease ? 20 : 10,
        virtualized: preRelease,
        initialRenderWork: 10,
        totalMessages: 20,
        assistantTextLengths: Array.from({ length: 5 }, () => 100_000),
        transcriptVisible: !tree,
        treeVisible: tree,
        treeNodeCount: tree ? 25 : 0,
        treePreviewTextChars: 0,
        treeInspectorTextChars: 0,
        counts: { messages: 25, messageBodies: 25, streamChunks: 0 },
      },
    }
  })
  return {
    schemaVersion: 2,
    measurementModel: 'external-http-ui-v1',
    scenario: {
      regenCount: 5,
      targetChars: 100_000,
      reasoningChars: 100_000,
      turnCount: 10,
      reloadCount: 2,
      surfaceCycleCount: 3,
    },
    residentHeapCaptureOrder: ['storage-evidence', 'forced-gc', 'heap-and-dom'],
    samples,
    storeStates,
    failures: [],
  }
}

type MutableReport = {
  -readonly [Key in keyof StreamProfileReport]: Key extends 'samples'
    ? MutableHeapSample[]
    : Key extends 'storeStates'
      ? MutableStoreState[]
      : StreamProfileReport[Key]
}

type MutableHeapSample = {
  -readonly [Key in keyof StreamProfileHeapSample]: Key extends 'debugState'
    ? {
        -readonly [DebugKey in keyof StreamProfileHeapSample['debugState']]: DebugKey extends 'measurementTransactions'
          ? {
              -readonly [EvidenceKey in keyof StreamProfileHeapSample['debugState']['measurementTransactions']]: StreamProfileHeapSample['debugState']['measurementTransactions'][EvidenceKey]
            }
          : StreamProfileHeapSample['debugState'][DebugKey]
      }
    : StreamProfileHeapSample[Key]
}

type MutableStoreState = {
  -readonly [Key in keyof StreamProfileStoreState]: Key extends 'state'
    ? {
        -readonly [StateKey in keyof StreamProfileStoreState['state']]: StreamProfileStoreState['state'][StateKey]
      }
    : StreamProfileStoreState[Key]
}

function mutableReport(): MutableReport {
  return structuredClone(passingReport()) as MutableReport
}

function sample(report: MutableReport, phase: StreamProfilePhase): MutableHeapSample {
  const found = report.samples.find((entry) => key(entry.phase) === key(phase))
  if (!found) throw new Error(`missing sample ${key(phase)}`)
  return found
}

function state(report: MutableReport, phase: StreamProfilePhase): MutableStoreState {
  const found = report.storeStates.find((entry) => key(entry.phase) === key(phase))
  if (!found) throw new Error(`missing state ${key(phase)}`)
  return found
}

function key(phase: StreamProfilePhase): string {
  switch (phase.kind) {
    case 'fresh':
    case 'pre-release':
    case 'recycled':
      return phase.kind
    case 'turn-active':
    case 'turn-settled':
    case 'regeneration-settled':
    case 'reload':
      return `${phase.kind}:${phase.ordinal}`
    case 'surface':
      return `surface:${phase.surface}:${phase.cycle}`
  }
}

function problemCodes(result: ReturnType<typeof evaluateStreamProfile>): string[] {
  return result.problems.map((entry) => entry.split(':', 1)[0] as string)
}
