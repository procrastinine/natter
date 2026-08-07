import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const CAPTURE_ORDER = Object.freeze(['storage-evidence', 'forced-gc', 'heap-and-dom'])

export const STREAM_PROFILE_EVIDENCE_CONTRACT = Object.freeze({
  reportSchemaVersion: 2,
  minimumSurfaceCycles: 3,
  minimumReloads: 2,
  minimumRegenerations: 3,
  minimumTargetChars: 100_000,
  minimumReasoningChars: 100_000,
  minimumBranchDemandMultiples: 2,
  maximumGcRetainedGrowthBytes: 2_000_000,
  series: Object.freeze([
    Object.freeze({
      id: 'heap',
      value: (sample) => sample.usedSize,
      maximumSlope: 1_000_000,
      maximumCeilingGrowth: 4_000_000,
    }),
    Object.freeze({
      id: 'dom-node',
      value: (sample) => sample.dom.nodes,
      maximumSlope: 64,
      maximumCeilingGrowth: 256,
    }),
    Object.freeze({
      id: 'listener',
      value: (sample) => sample.dom.jsEventListeners,
      maximumCeilingGrowth: 8,
    }),
  ]),
})

export const CONCURRENT_STREAM_PROFILE_EVIDENCE_CONTRACT = Object.freeze({
  reportSchemaVersion: 2,
  minimumPageCount: 10,
  minimumStreamsPerPage: 10,
  minimumTotalStreams: 100,
  minimumContextChars: 100_000,
  minimumTargetChars: 100_000,
  minimumReasoningChars: 100_000,
  minimumRegenerations: 100,
  maximumReloadGrowthBytes: 128 * 1024 * 1024,
})

export function streamProfilePhaseLabel(phase) {
  switch (phase.kind) {
    case 'fresh':
    case 'pre-release':
      return phase.kind
    case 'recycled':
      return 'after-soft-recycle'
    case 'turn-active':
      return `during-turn-${phase.ordinal}-active-over-100k`
    case 'turn-settled':
      return phase.ordinal === 1 ? 'after-first' : `after-turn-${phase.ordinal}`
    case 'regeneration-settled':
      return `after-regen-${phase.ordinal}`
    case 'surface':
      return `after-${phase.surface}-cycle-${phase.cycle}`
    case 'reload':
      return `after-reload-${phase.ordinal}`
    default:
      throw new Error('StreamProfilePhaseInvalid')
  }
}

export function evaluateStreamProfile(input) {
  const problems = []
  const metrics = {}
  if (
    !isRecord(input) ||
    input.schemaVersion !== STREAM_PROFILE_EVIDENCE_CONTRACT.reportSchemaVersion ||
    !isRecord(input.scenario)
  ) {
    return result(['profile.schema.report'], metrics)
  }
  const report = input
  if (report.measurementModel !== 'external-http-ui-v1') problems.push('profile.schema.model')
  if (!sameArray(report.residentHeapCaptureOrder, CAPTURE_ORDER)) {
    problems.push('profile.capture-order.invalid')
  }
  const samples = indexEvidence(report.samples, problems)
  const states = indexEvidence(report.storeStates, problems)
  if (!samples || !states) return result(problems, metrics)
  evaluateCaptureTransactions(report.samples, problems)

  minimum(
    problems,
    'profile.demand.surface-cycles',
    report.scenario.surfaceCycleCount,
    STREAM_PROFILE_EVIDENCE_CONTRACT.minimumSurfaceCycles,
  )
  minimum(
    problems,
    'profile.demand.reloads',
    report.scenario.reloadCount,
    STREAM_PROFILE_EVIDENCE_CONTRACT.minimumReloads,
  )
  minimum(
    problems,
    'profile.demand.regenerations',
    report.scenario.regenCount,
    STREAM_PROFILE_EVIDENCE_CONTRACT.minimumRegenerations,
  )
  minimum(
    problems,
    'profile.demand.target-chars',
    report.scenario.targetChars,
    STREAM_PROFILE_EVIDENCE_CONTRACT.minimumTargetChars,
  )
  minimum(
    problems,
    'profile.demand.reasoning-chars',
    report.scenario.reasoningChars,
    STREAM_PROFILE_EVIDENCE_CONTRACT.minimumReasoningChars,
  )

  const preSample = samples.get('pre-release')
  const recycledSample = samples.get('recycled')
  const preState = states.get('pre-release')?.state
  const recycledState = states.get('recycled')?.state
  required(problems, 'profile.sample.pre-release-missing', preSample)
  required(problems, 'profile.sample.recycled-missing', recycledSample)
  required(problems, 'profile.state.pre-release-missing', preState)
  required(problems, 'profile.state.recycled-missing', recycledState)

  if (preSample && recycledSample) {
    const growth = recycledSample.usedSize - preSample.usedSize
    metrics.gcRetainedGrowthBytes = growth
    maximum(
      problems,
      'profile.heap.gc-retained-growth',
      growth,
      STREAM_PROFILE_EVIDENCE_CONTRACT.maximumGcRetainedGrowthBytes,
    )
  }
  if (preState) evaluatePreRelease(report, preState, problems)
  if (recycledState) evaluateTranscriptState('recycled', recycledState, problems)
  if (preState) evaluateStableStorage(preState.counts, report.storeStates, problems)

  for (const surface of ['tree', 'transcript']) {
    const surfaceSamples = ordered(report.samples, 'surface', surface)
    const surfaceStates = ordered(report.storeStates, 'surface', surface)
    exact(
      problems,
      `profile.sample.${surface}-cycle-count`,
      surfaceSamples.length,
      report.scenario.surfaceCycleCount,
    )
    exact(
      problems,
      `profile.state.${surface}-cycle-count`,
      surfaceStates.length,
      report.scenario.surfaceCycleCount,
    )
    evaluateSeries(surface, surfaceSamples, metrics, problems)
    for (const entry of surfaceStates) evaluateSurfaceState(surface, entry.state, problems)
  }

  const reloadSamples = ordered(report.samples, 'reload')
  const reloadStates = ordered(report.storeStates, 'reload')
  exact(problems, 'profile.sample.reload-count', reloadSamples.length, report.scenario.reloadCount)
  exact(problems, 'profile.state.reload-count', reloadStates.length, report.scenario.reloadCount)
  evaluateSeries('reload', reloadSamples, metrics, problems)
  for (const entry of reloadSamples) {
    exact(problems, `profile.dom.reload-document-count: ${entry.label}`, entry.dom.documents, 1)
  }
  for (const entry of reloadStates) evaluateTranscriptState('reload', entry.state, problems)

  if (Array.isArray(report.failures)) {
    for (const failure of report.failures) problems.push(`profile.run.failure: ${String(failure)}`)
  } else {
    problems.push('profile.schema.failures')
  }
  return result(problems, metrics)
}

export function evaluateConcurrentStreamProfile(input) {
  const problems = []
  const metrics = {}
  if (
    !isRecord(input) ||
    input.schemaVersion !== CONCURRENT_STREAM_PROFILE_EVIDENCE_CONTRACT.reportSchemaVersion ||
    input.measurementModel !== 'external-http-ui-v1' ||
    !isRecord(input.scenario)
  ) {
    return result(
      ['concurrent-profile.schema.report'],
      metrics,
      CONCURRENT_STREAM_PROFILE_EVIDENCE_CONTRACT,
    )
  }
  const report = input
  const scenario = report.scenario
  minimum(
    problems,
    'concurrent-profile.demand.pages',
    scenario.pageCount,
    CONCURRENT_STREAM_PROFILE_EVIDENCE_CONTRACT.minimumPageCount,
  )
  minimum(
    problems,
    'concurrent-profile.demand.streams-per-page',
    scenario.streamsPerPage,
    CONCURRENT_STREAM_PROFILE_EVIDENCE_CONTRACT.minimumStreamsPerPage,
  )
  minimum(
    problems,
    'concurrent-profile.demand.total-streams',
    scenario.totalStreams,
    CONCURRENT_STREAM_PROFILE_EVIDENCE_CONTRACT.minimumTotalStreams,
  )
  minimum(
    problems,
    'concurrent-profile.demand.context-chars',
    scenario.contextChars,
    CONCURRENT_STREAM_PROFILE_EVIDENCE_CONTRACT.minimumContextChars,
  )
  minimum(
    problems,
    'concurrent-profile.demand.target-chars',
    scenario.targetChars,
    CONCURRENT_STREAM_PROFILE_EVIDENCE_CONTRACT.minimumTargetChars,
  )
  minimum(
    problems,
    'concurrent-profile.demand.reasoning-chars',
    scenario.reasoningChars,
    CONCURRENT_STREAM_PROFILE_EVIDENCE_CONTRACT.minimumReasoningChars,
  )
  minimum(
    problems,
    'concurrent-profile.demand.regenerations',
    scenario.regenerationCount,
    CONCURRENT_STREAM_PROFILE_EVIDENCE_CONTRACT.minimumRegenerations,
  )
  exact(
    problems,
    'concurrent-profile.demand.cardinality',
    scenario.totalStreams,
    scenario.pageCount * scenario.streamsPerPage,
  )
  exact(
    problems,
    'concurrent-profile.demand.persisted-chars',
    scenario.totalPersistedChars,
    scenario.totalStreams *
      (scenario.contextChars + scenario.targetChars + scenario.reasoningChars) +
      scenario.regenerationCount * (scenario.targetChars + scenario.reasoningChars),
  )
  exact(
    problems,
    'concurrent-profile.results.done',
    report.resultCounts?.done,
    scenario.totalStreams,
  )
  exact(
    problems,
    'concurrent-profile.regenerations.done',
    report.regenerationResultCounts?.done,
    scenario.regenerationCount,
  )
  exact(problems, 'concurrent-profile.seed.outcome', report.seed?.outcome, 'done')

  for (const [id, expected] of [
    ['previousTurn', scenario.totalStreams],
    ['currentTurn', scenario.totalStreams],
    ['regeneration', scenario.regenerationCount],
  ]) {
    const admission = report.applicationAdmissionPhases?.[id]
    exact(problems, `concurrent-profile.admission.${id}.expected`, admission?.expected, expected)
    exact(problems, `concurrent-profile.admission.${id}.observed`, admission?.observed, expected)
    exact(
      problems,
      `concurrent-profile.admission.${id}.failures`,
      Array.isArray(admission?.failures) ? admission.failures.length : undefined,
      0,
    )
    const highWater = report.providerPhases?.[id]?.maxActiveStreams
    if (!Number.isSafeInteger(highWater) || highWater < 1 || highWater > expected) {
      problems.push(`concurrent-profile.provider.${id}.high-water`)
    }
  }

  evaluateConcurrentPersistence('before-reload', report.beforeReload, scenario, problems)
  evaluateConcurrentPersistence('after-reload', report.afterReload, scenario, problems)
  if (!Array.isArray(report.pageStates)) {
    problems.push('concurrent-profile.schema.page-states')
  } else {
    exact(
      problems,
      'concurrent-profile.page-state-count',
      report.pageStates.length,
      scenario.pageCount,
    )
    for (const [index, state] of report.pageStates.entries()) {
      exact(problems, `concurrent-profile.page.${index}.active`, state?.activeCount, 0)
      exact(problems, `concurrent-profile.page.${index}.snapshots`, state?.liveSnapshotCount, 0)
      exact(problems, `concurrent-profile.page.${index}.chunks`, state?.streamChunkCount, 0)
    }
  }
  exact(
    problems,
    'concurrent-profile.console-problems',
    Array.isArray(report.consoleProblems) ? report.consoleProblems.length : undefined,
    0,
  )
  exact(
    problems,
    'concurrent-profile.run-failures',
    Array.isArray(report.failures) ? report.failures.length : undefined,
    0,
  )
  const heap = report.heap
  if (!isRecord(heap)) {
    problems.push('concurrent-profile.schema.heap')
  } else {
    for (const id of [
      'baseline',
      'afterPrevious',
      'afterCurrent',
      'afterRegeneration',
      'afterReload',
    ]) {
      const sample = heap[id]
      exact(
        problems,
        `concurrent-profile.heap.${id}.pages`,
        sample?.measuredPages,
        scenario.pageCount,
      )
      if (!finiteNonNegative(sample?.usedBytes)) {
        problems.push(`concurrent-profile.heap.${id}.used-bytes`)
      }
    }
    if (
      finiteNonNegative(heap.afterReload?.usedBytes) &&
      finiteNonNegative(heap.afterRegeneration?.usedBytes)
    ) {
      const growth = heap.afterReload.usedBytes - heap.afterRegeneration.usedBytes
      metrics.reloadGrowthBytes = growth
      maximum(
        problems,
        'concurrent-profile.heap.reload-growth',
        growth,
        CONCURRENT_STREAM_PROFILE_EVIDENCE_CONTRACT.maximumReloadGrowthBytes,
      )
    }
  }
  return result(problems, metrics, CONCURRENT_STREAM_PROFILE_EVIDENCE_CONTRACT)
}

function evaluateConcurrentPersistence(label, value, scenario, problems) {
  if (!isRecord(value)) {
    problems.push(`concurrent-profile.schema.${label}`)
    return
  }
  exact(problems, `concurrent-profile.${label}.rows`, value.checkedRows, scenario.totalStreams)
  exact(
    problems,
    `concurrent-profile.${label}.regeneration-rows`,
    value.regenerationRowsChecked,
    scenario.regenerationCount,
  )
  exact(problems, `concurrent-profile.${label}.leases`, value.leaseCount, 0)
  exact(problems, `concurrent-profile.${label}.chunks`, value.chunkCount, 0)
  exact(
    problems,
    `concurrent-profile.${label}.failures`,
    Array.isArray(value.failures) ? value.failures.length : undefined,
    0,
  )
}

function evaluatePreRelease(report, state, problems) {
  const requiredRows =
    state.initialRenderWork * STREAM_PROFILE_EVIDENCE_CONTRACT.minimumBranchDemandMultiples
  minimum(problems, 'profile.demand.branch-depth', state.totalMessages, requiredRows)
  exact(problems, 'profile.demand.expanded-transcript', state.loadedMessages, state.totalMessages)
  minimum(problems, 'profile.demand.mounted-transcript-floor', state.mountedMessages, 1)
  maximum(
    problems,
    'profile.demand.mounted-transcript-window',
    state.mountedMessages,
    state.initialRenderWork,
  )
  minimum(problems, 'profile.demand.visible-assistant-floor', state.assistantTextLengths.length, 1)
  if (!state.virtualized) problems.push('profile.demand.expanded-transcript-not-virtualized')
  const minimumRenderedText = Math.floor(report.scenario.targetChars * 0.99)
  if (state.assistantTextLengths.some((length) => length < minimumRenderedText)) {
    problems.push('profile.demand.visible-assistant-content')
  }
  if (!state.transcriptVisible || state.treeVisible)
    problems.push('profile.demand.pre-release-surface')
}

function evaluateSurfaceState(surface, state, problems) {
  if (surface === 'tree') {
    evaluateResidentTranscriptWindow('tree', state, problems)
    if (!state.treeVisible || state.transcriptVisible) {
      problems.push('profile.dom.tree-surface-visibility')
    }
    minimum(
      problems,
      'profile.dom.visible-tree-node-floor',
      state.treeNodeCount,
      Math.min(state.counts.messages, state.initialRenderWork),
    )
    return
  }
  evaluateTranscriptState('transcript', state, problems)
}

function evaluateTranscriptState(label, state, problems) {
  evaluateResidentTranscriptWindow(label, state, problems)
  if (!state.transcriptVisible || state.treeVisible) {
    problems.push(`profile.dom.${label}-surface-visibility`)
  }
  exact(problems, 'profile.dom.hidden-tree-nodes', state.treeNodeCount, 0)
  exact(problems, 'profile.dom.hidden-tree-preview-material', state.treePreviewTextChars, 0)
  exact(problems, 'profile.dom.hidden-tree-inspector-material', state.treeInspectorTextChars, 0)
}

function evaluateResidentTranscriptWindow(label, state, problems) {
  const expected = Math.min(state.totalMessages, state.initialRenderWork)
  exact(problems, `profile.dom.${label}-loaded-transcript-window`, state.loadedMessages, expected)
  exact(problems, `profile.dom.${label}-mounted-transcript-window`, state.mountedMessages, expected)
}

function evaluateSeries(label, samples, metrics, problems) {
  if (samples.length < 2) return
  for (const capability of STREAM_PROFILE_EVIDENCE_CONTRACT.series) {
    const values = samples.map(capability.value)
    const slope = linearSlope(values)
    const ceilingGrowth = Math.max(...values.slice(1)) - values[0]
    metrics[`${label}.${capability.id}.slope`] = slope
    metrics[`${label}.${capability.id}.ceilingGrowth`] = ceilingGrowth
    if (capability.maximumSlope !== undefined) {
      maximum(problems, `profile.${capability.id}.${label}-slope`, slope, capability.maximumSlope)
    }
    maximum(
      problems,
      `profile.${capability.id}.${label}-ceiling`,
      ceilingGrowth,
      capability.maximumCeilingGrowth,
    )
  }
}

function evaluateStableStorage(expected, states, problems) {
  for (const entry of states) {
    const actual = entry.state.counts
    if (
      actual.messages !== expected.messages ||
      actual.messageBodies !== expected.messageBodies ||
      actual.streamChunks !== expected.streamChunks
    ) {
      problems.push(`profile.storage.cycle-drift: ${entry.label}`)
    }
  }
}

function evaluateCaptureTransactions(samples, problems) {
  for (const sample of samples) {
    const evidence = sample.debugState?.measurementTransactions
    if (!isRecord(evidence)) {
      problems.push(`profile.capture.idb-evidence-missing: ${sample.label}`)
      continue
    }
    exact(
      problems,
      `profile.capture.idb-active-before-gc: ${sample.label}`,
      evidence.activeBeforeGarbageCollection,
      0,
    )
    exact(
      problems,
      `profile.capture.idb-active-before-capture: ${sample.label}`,
      evidence.activeBeforeCapture,
      0,
    )
    exact(
      problems,
      `profile.capture.idb-active-after-capture: ${sample.label}`,
      evidence.activeAfterCapture,
      0,
    )
    exact(
      problems,
      `profile.capture.idb-revision-drift: ${sample.label}`,
      evidence.revisionBeforeCapture,
      evidence.revisionBeforeGarbageCollection,
    )
    exact(
      problems,
      `profile.capture.idb-revision-drift: ${sample.label}`,
      evidence.revisionAfterCapture,
      evidence.revisionBeforeGarbageCollection,
    )
  }
}

function indexEvidence(entries, problems) {
  if (!Array.isArray(entries)) {
    problems.push('profile.schema.evidence')
    return null
  }
  const indexed = new Map()
  for (const entry of entries) {
    let key
    try {
      key = phaseKey(entry.phase)
      if (entry.label !== streamProfilePhaseLabel(entry.phase)) {
        problems.push(`profile.schema.phase-label: ${entry.label}`)
      }
    } catch {
      problems.push('profile.schema.phase')
      continue
    }
    if (indexed.has(key)) problems.push(`profile.schema.duplicate-phase: ${key}`)
    else indexed.set(key, entry)
  }
  return indexed
}

function ordered(entries, kind, surface) {
  return entries
    .filter(
      (entry) =>
        entry.phase.kind === kind && (kind !== 'surface' || entry.phase.surface === surface),
    )
    .sort((left, right) => phaseOrdinal(left.phase) - phaseOrdinal(right.phase))
}

function phaseKey(phase) {
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
    default:
      throw new Error('StreamProfilePhaseInvalid')
  }
}

function phaseOrdinal(phase) {
  return phase.kind === 'surface' ? phase.cycle : phase.ordinal
}

function linearSlope(values) {
  const meanX = (values.length - 1) / 2
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length
  let numerator = 0
  let denominator = 0
  for (const [index, value] of values.entries()) {
    const delta = index - meanX
    numerator += delta * (value - meanY)
    denominator += delta * delta
  }
  return numerator / denominator
}

function required(problems, code, value) {
  if (value === undefined) problems.push(code)
}

function minimum(problems, code, observed, limit) {
  if (!Number.isFinite(observed) || observed < limit)
    problems.push(`${code}: ${observed} < ${limit}`)
}

function maximum(problems, code, observed, limit) {
  if (!Number.isFinite(observed) || observed > limit)
    problems.push(`${code}: ${observed} > ${limit}`)
}

function exact(problems, code, observed, expected) {
  if (observed !== expected) problems.push(`${code}: ${observed} !== ${expected}`)
}

function sameArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  )
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function result(problems, metrics, contract = STREAM_PROFILE_EVIDENCE_CONTRACT) {
  return Object.freeze({
    schemaVersion: 1,
    status: problems.length === 0 ? 'pass' : 'fail',
    contract,
    metrics: Object.freeze({ ...metrics }),
    problems: Object.freeze([...problems]),
  })
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

async function cli() {
  const path = process.argv[2]
  if (!path || process.argv.length > 3) {
    process.stderr.write('Usage: node scripts/stream-profile-evaluator.mjs <report.json|->\n')
    process.exitCode = 2
    return
  }
  try {
    const raw = path === '-' ? await readStandardInput() : await readFile(path, 'utf8')
    const evaluation = evaluateStreamProfile(JSON.parse(raw))
    process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`)
    if (evaluation.status === 'fail') process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}

async function readStandardInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await cli()
