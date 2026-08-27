import { mkdir, rename, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { currentWaveManifest } from './current-wave-manifest.mjs'
import { assertVerificationCandidateAdmissionReady } from './verification-candidate-admission.mjs'
import {
  createVerificationCandidateEnvironment,
  executeMaterializedVerificationCandidate,
} from './verification-candidate-execution.mjs'
import {
  assertMaterializedVerificationCandidateUnchanged,
  readMaterializedVerificationCandidate,
} from './verification-candidate-workspace.mjs'
import { buildVerificationSnapshot } from './verification-impact-plan.mjs'
import {
  createVerificationRuntimeInvocation,
  executeFileBackedVerificationProcess,
  verificationChildEnvironment,
} from './verification-process-execution.mjs'
import { createVerificationSlicePlan } from './verification-slice-workspace.mjs'

const ROOT = resolve(import.meta.dirname, '..')

export function createSliceTaskBatches(plan, runtime = null) {
  const batches = []
  for (const task of plan.tasks.node) {
    const invocation = createVerificationRuntimeInvocation(['node', ...task.argv], runtime)
    batches.push(
      Object.freeze({
        id: `node-${task.id}`,
        kind: 'node',
        ...invocation,
      }),
    )
  }
  if (plan.tasks.vitest.length > 0) {
    const invocation = createVerificationRuntimeInvocation(
      ['pnpm', 'exec', 'vitest', 'run', ...plan.tasks.vitest],
      runtime,
    )
    batches.push(
      Object.freeze({
        id: 'vitest',
        kind: 'vitest',
        ...invocation,
      }),
    )
  }
  for (const task of plan.tasks.playwright) {
    const invocation = createVerificationRuntimeInvocation(
      [
        'pnpm',
        'exec',
        'playwright',
        'test',
        `--project=${task.project}`,
        '--no-deps',
        ...task.files,
      ],
      runtime,
    )
    batches.push(
      Object.freeze({
        id: `playwright-${task.project}`,
        kind: 'playwright',
        ...invocation,
      }),
    )
  }
  return Object.freeze(batches)
}

export function assertSliceVerificationExecutionReady(manifest = currentWaveManifest) {
  assertVerificationCandidateAdmissionReady(manifest)
}

export async function runSliceVerification(options) {
  assertSliceVerificationExecutionReady()
  const evidenceRoot = resolve(options.evidenceRoot ?? ROOT)
  return executeMaterializedVerificationCandidate(
    {
      candidate: options.candidate,
      evidenceRoot,
      residentRoot: ROOT,
      runId: `slice-${options.candidate.id}`,
      purpose: `candidate-execution:${options.candidate.id}`,
    },
    async ({ candidate, runtime, environment }) => {
      const planBundle = createVerificationSlicePlan({
        evidenceRoot,
        baselineId: options.baselineId,
        candidate,
      })
      return executePreparedSliceVerification({
        baselineId: options.baselineId,
        candidate,
        evidenceRoot,
        runtimeRoot: candidate.runtimeRoot,
        planBundle,
        runtime,
        environment,
        provenance: sliceProvenance(planBundle),
        runKey: candidate.id,
        forwardOutput: options.forwardOutput,
        outputDestinations: options.outputDestinations,
      })
    },
  )
}

export async function executePreparedSliceVerification(options) {
  const evidenceRoot = options.evidenceRoot ?? ROOT
  const runtimeRoot = options.runtimeRoot
  if (typeof runtimeRoot !== 'string') throw new Error('VerificationImmutableCandidateRequired')
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const startedAt = monotonicNow()
  const planBundle = options.planBundle
  if (!planBundle) throw new Error('VerificationPreparedPlanRequired')
  const batches = createSliceTaskBatches(planBundle.plan, options.runtime)
  const outputDestinations = options.outputDestinations ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  }
  const executeBatch =
    options.executeBatch ??
    ((batch, batchOptions) =>
      executeFileBackedVerificationProcess({
        id: batch.id,
        command: batch.command,
        args: batch.args,
        cwd: batchOptions.root,
        environment: verificationChildEnvironment({
          kind: batch.kind,
          root: batchOptions.root,
          runId,
          baseEnv: batchOptions.environment,
        }),
        artifactRoot: batchOptions.artifactRoot,
        runDirectory: batchOptions.runDirectory,
        diagnosticPrefix: 'VerificationSlice',
        forwardOutput: batchOptions.forwardOutput,
        outputDestinations,
      }))
  const buildCurrentSnapshot =
    options.buildCurrentSnapshot ?? (() => buildVerificationSnapshot({ root: runtimeRoot }))
  const runId = sliceRunId(
    planBundle.plan.planDigest,
    options.now?.() ?? new Date(),
    options.runKey,
  )
  const runDirectory = resolve(evidenceRoot, 'test-results/verification-slice/runs', runId)
  const environment =
    options.environment ??
    (options.candidate
      ? createVerificationCandidateEnvironment(
          options.candidate,
          runId,
          process.env,
          options.runtime,
        )
      : Object.freeze({ ...process.env }))
  const persistSummary =
    options.persistSummary ?? ((summary) => persistSliceVerificationSummary(runDirectory, summary))
  const infrastructureDiagnostics = []
  const results = batches.map(plannedBatchResult)

  let summary = sliceSummary({
    runId,
    baselineId: options.baselineId,
    plan: planBundle.plan,
    results,
    outcome: planBundle.plan.executable ? 'running' : 'blocked',
    wallMs: monotonicNow() - startedAt,
    inputsChangedDuringRun: false,
    infrastructureDiagnostics,
    provenance: options.provenance ?? null,
  })
  await persistSliceEvidence(persistSummary, summary, 'initial', infrastructureDiagnostics)

  if (!planBundle.plan.executable) {
    summary = sliceSummary({
      runId,
      baselineId: options.baselineId,
      plan: planBundle.plan,
      results,
      outcome: 'blocked',
      wallMs: monotonicNow() - startedAt,
      inputsChangedDuringRun: false,
      infrastructureDiagnostics,
      provenance: options.provenance ?? null,
    })
    return { summary, exitCode: 1 }
  }

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]
    if (!batch) continue
    const batchStartedAt = monotonicNow()
    printBatchHeader(index, batches.length, batch)
    let execution
    try {
      const batchEnvironment =
        batch.kind === 'playwright'
          ? Object.freeze({
              ...environment,
              E2E_PLAYWRIGHT_OUTPUT_DIR: resolve(runDirectory, `${batch.id}.playwright`),
            })
          : environment
      execution = await executeBatch(batch, {
        artifactRoot: evidenceRoot,
        root: runtimeRoot,
        runDirectory,
        environment: batchEnvironment,
        forwardOutput: options.forwardOutput !== false,
      })
    } catch (error) {
      execution = {
        exitCode: null,
        signal: null,
        diagnostics: [errorMessage(error)],
        stdoutPath: null,
        stderrPath: null,
      }
    }
    results[index] = completedBatchResult(
      batch,
      execution,
      Math.max(0, monotonicNow() - batchStartedAt),
    )
    printBatchResult(results[index])
    summary = sliceSummary({
      runId,
      baselineId: options.baselineId,
      plan: planBundle.plan,
      results,
      outcome: 'running',
      wallMs: monotonicNow() - startedAt,
      inputsChangedDuringRun: false,
      infrastructureDiagnostics,
      provenance: options.provenance ?? null,
    })
    await persistSliceEvidence(
      persistSummary,
      summary,
      `batch:${batch.id}`,
      infrastructureDiagnostics,
    )
  }

  let finalSnapshot = null
  try {
    if (options.candidate) {
      assertMaterializedVerificationCandidateUnchanged(options.candidate)
      finalSnapshot = options.candidate.snapshot
    } else {
      finalSnapshot = await buildCurrentSnapshot()
    }
  } catch (error) {
    infrastructureDiagnostics.push(
      `VerificationSliceCandidatePostValidationFailed:${errorName(error)}:${errorMessage(error)}`,
    )
  }
  const inputsChangedDuringRun =
    finalSnapshot === null || finalSnapshot.digest !== planBundle.current.digest
  const batchFailed = results.some((result) => result.status === 'failed')
  const evidencePassed = !batchFailed && !inputsChangedDuringRun
  const outcome = !evidencePassed
    ? 'failed'
    : planBundle.plan.closable
      ? 'passed'
      : 'passed-with-open-guarantees'
  summary = sliceSummary({
    runId,
    baselineId: options.baselineId,
    plan: planBundle.plan,
    results,
    outcome,
    wallMs: monotonicNow() - startedAt,
    inputsChangedDuringRun,
    infrastructureDiagnostics,
    provenance: options.provenance ?? null,
  })
  await persistSliceEvidence(persistSummary, summary, 'final', infrastructureDiagnostics)
  let finalOutcome = outcome
  if (infrastructureDiagnostics.length > 0) {
    finalOutcome = 'failed'
    summary = sliceSummary({
      runId,
      baselineId: options.baselineId,
      plan: planBundle.plan,
      results,
      outcome: finalOutcome,
      wallMs: monotonicNow() - startedAt,
      inputsChangedDuringRun,
      infrastructureDiagnostics,
      provenance: options.provenance ?? null,
    })
  }
  printSliceSummary(summary, runDirectory, evidenceRoot)
  return { summary, exitCode: finalOutcome === 'passed' ? 0 : 1 }
}

function plannedBatchResult(batch) {
  return Object.freeze({
    id: batch.id,
    kind: batch.kind,
    command: batch.command,
    args: batch.args,
    status: 'planned',
    exitCode: null,
    signal: null,
    diagnostics: Object.freeze([]),
    wallMs: null,
    stdoutPath: null,
    stderrPath: null,
  })
}

function completedBatchResult(batch, execution, wallMs) {
  return Object.freeze({
    id: batch.id,
    kind: batch.kind,
    command: batch.command,
    args: batch.args,
    status:
      execution.exitCode === 0 && execution.signal === null && execution.diagnostics.length === 0
        ? 'passed'
        : 'failed',
    exitCode: execution.exitCode,
    signal: execution.signal,
    diagnostics: Object.freeze([...execution.diagnostics]),
    wallMs,
    stdoutPath: execution.stdoutPath,
    stderrPath: execution.stderrPath,
  })
}

function sliceProvenance(planBundle) {
  const comparison = planBundle.baselineEnvelope.comparison
  const candidate = planBundle.candidate
  return Object.freeze({
    comparisonCommitOid: comparison.commitOid,
    comparisonTreeOid: comparison.treeOid,
    comparisonDigest: comparison.digest,
    baselineDigest: planBundle.baselineEnvelope.digest,
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    candidateSnapshotDigest: candidate.snapshot.digest,
    compilerCohortDigest: candidate.compilerCohort.digest,
    dependencyImageId: candidate.dependency.imageId,
    dependencyImageDigest: candidate.dependency.imageDigest,
  })
}

function sliceSummary(options) {
  return Object.freeze({
    schemaVersion: 1,
    runId: options.runId,
    baselineId: options.baselineId,
    provenance: options.provenance,
    planDigest: options.plan.planDigest,
    currentDigest: options.plan.currentDigest,
    executable: options.plan.executable,
    closable: options.plan.closable,
    structuralBlockers: options.plan.structuralBlockers,
    openGuarantees: options.plan.openGuarantees,
    unregisteredAffectedTests: options.plan.unregisteredAffectedTests,
    batches: Object.freeze([...options.results]),
    inputsChangedDuringRun: options.inputsChangedDuringRun,
    infrastructureDiagnostics: Object.freeze([...options.infrastructureDiagnostics]),
    outcome: options.outcome,
    wallMs: Math.max(0, options.wallMs),
  })
}

async function persistSliceVerificationSummary(runDirectory, summary) {
  await mkdir(runDirectory, { recursive: true })
  const path = resolve(runDirectory, 'summary.json')
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

async function persistSliceEvidence(persistSummary, summary, phase, diagnostics) {
  try {
    await persistSummary(summary)
  } catch (error) {
    const diagnostic = `VerificationSliceSummaryPersistenceFailed:${phase}:${errorName(error)}`
    if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic)
    console.error(`[verify:slice] ${diagnostic}`)
  }
}

function sliceRunId(planDigest, now, runKey) {
  const suffix = typeof runKey === 'string' ? `-${safeFilePart(runKey)}` : ''
  return `${now.toISOString().replaceAll(/[:.]/gu, '-')}-${planDigest.slice(0, 12)}${suffix}`
}

function repositoryRelative(root, path) {
  return relative(root, path).replaceAll('\\', '/')
}

function safeFilePart(value) {
  return value.replaceAll(/[^A-Za-z0-9._-]/gu, '-')
}

function errorName(error) {
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string') {
    return error.name
  }
  return 'UnknownError'
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function printBatchHeader(index, count, batch) {
  console.log(`\n[verify:slice ${index + 1}/${count}] ${batch.id}`)
  console.log(`$ ${batch.command} ${batch.args.join(' ')}`)
}

function printBatchResult(result) {
  const detail =
    result.exitCode === null ? (result.signal ?? 'no exit code') : `exit ${result.exitCode}`
  console.log(`[verify:slice] ${result.status} (${detail}, ${result.wallMs.toFixed(1)} ms)`)
}

function printSliceSummary(summary, runDirectory, root) {
  console.log('\nVerification slice complete')
  console.log(`- outcome: ${summary.outcome}`)
  console.log(`- batches: ${summary.batches.length}`)
  console.log(`- wall time: ${summary.wallMs.toFixed(1)} ms`)
  console.log(`- inputs changed during run: ${summary.inputsChangedDuringRun ? 'yes' : 'no'}`)
  console.log(`- summary: ${repositoryRelative(root, resolve(runDirectory, 'summary.json'))}`)
}

function parseArgs(argv) {
  let baselineId = null
  let candidateId = null
  let candidateResident = false
  let evidenceRoot = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--candidate-resident') candidateResident = true
    else if (arg === '--evidence-root') {
      evidenceRoot = argv[index + 1] ?? null
      index += 1
    } else if (arg === '--baseline') {
      baselineId = argv[index + 1] ?? null
      index += 1
    } else if (arg === '--candidate') {
      candidateId = argv[index + 1] ?? null
      index += 1
    } else {
      throw new Error(`VerificationSliceArgumentForbidden:${arg}`)
    }
  }
  if (!baselineId) throw new Error('VerificationBaselineRequiredDirtyWorktree')
  if (!candidateId) throw new Error('VerificationCandidateIdRequired')
  if (!candidateResident) throw new Error('VerificationCandidateResidentInvocationRequired')
  if (!evidenceRoot) throw new Error('VerificationEvidenceRootRequired')
  return { baselineId, candidateId, evidenceRoot: resolve(evidenceRoot) }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  assertSliceVerificationExecutionReady()
  const candidate = readMaterializedVerificationCandidate({
    evidenceRoot: args.evidenceRoot,
    id: args.candidateId,
  })
  if (resolve(candidate.runtimeRoot) !== ROOT) {
    throw new Error('VerificationCandidateResidentRootMismatch')
  }
  const result = await runSliceVerification({
    baselineId: args.baselineId,
    candidate,
    evidenceRoot: args.evidenceRoot,
  })
  process.exitCode = result.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
