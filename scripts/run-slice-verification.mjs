import { mkdir, rename, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { currentWaveManifest } from './current-wave-manifest.mjs'
import {
  collectVerificationMetadata,
  executeVerificationStage,
  prepareVerificationStageExecution,
} from './run-verification.mjs'
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
import { createVerificationRuntimeInvocation } from './verification-process-execution.mjs'
import { createVerificationSlicePlan } from './verification-slice-workspace.mjs'
import {
  verificationPrerequisiteDiagnostics,
  verificationStageAssurance,
  verificationStageBlocks,
  verificationStageStatus,
} from './verification-stage-contract.mjs'

const ROOT = resolve(import.meta.dirname, '..')

export function createSliceTaskBatches(plan, runtime = null) {
  return Object.freeze(
    plan.stages.map((stage) =>
      Object.freeze({
        id: stage.kind === 'node' && stage.argv[0] === 'node' ? `node-${stage.id}` : stage.id,
        kind: stage.kind ?? 'node',
        stage,
        ...(stage.browserTasks ? { browserTasks: stage.browserTasks } : {}),
        ...(stage.argv[0] === 'internal'
          ? { command: 'internal', args: Object.freeze(stage.argv.slice(1)) }
          : createVerificationRuntimeInvocation(stage.argv, runtime)),
      }),
    ),
  )
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
    async ({ candidate, runtime, environment, testCompilerProof }) => {
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
        testCompilerProof,
        metadata: planBundle.plan.stages.some((stage) => stage.argv[0] === 'internal')
          ? await collectVerificationMetadata({
              root: candidate.runtimeRoot,
              pnpmVersion: candidate.dependencyImage.recipe.runtime.pnpmVersion,
              nodeVersion: candidate.dependencyImage.recipe.runtime.nodeVersion.replace(/^v/u, ''),
              environment,
            })
          : undefined,
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
  let performanceEvidencePath = null
  const executeBatch = (batch, batchOptions) =>
    executeVerificationStage(batch.stage, options.metadata, {
      root: batchOptions.root,
      baseEnv: batchOptions.environment,
      executionRuntime: options.runtime,
      testCompilerProof: options.testCompilerProof,
      performanceEvidencePath,
      artifactRoot: batchOptions.artifactRoot,
      runDirectory: batchOptions.runDirectory,
      runId,
      executionId: batch.id,
      diagnosticPrefix: 'VerificationSlice',
      forwardOutput: batchOptions.forwardOutput,
      outputDestinations,
      ...(options.executeBatch
        ? {
            executeProcess: (item, _metadata, context) =>
              options.executeBatch(
                {
                  ...batch,
                  stage: item,
                  ...(item.browserTasks ? { browserTasks: item.browserTasks } : {}),
                  ...createVerificationRuntimeInvocation(item.argv, options.runtime),
                },
                { ...batchOptions, environment: context.environment },
              ),
          }
        : {}),
    })
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
      const diagnostics = verificationPrerequisiteDiagnostics(batch.stage, results.slice(0, index))
      performanceEvidencePath = diagnostics.length
        ? null
        : await prepareVerificationStageExecution(batch.stage, {
            artifactRoot: evidenceRoot,
            runDirectory,
            runId,
            provenance: options.provenance ?? null,
            stages: results,
          })
      execution =
        diagnostics.length > 0
          ? { exitCode: null, signal: null, diagnostics, stdoutPath: null, stderrPath: null }
          : await executeBatch(batch, {
              artifactRoot: evidenceRoot,
              root: runtimeRoot,
              runDirectory,
              environment,
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
  const batchFailed = results.some(verificationStageBlocks)
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
    stageId: batch.stage.id,
    policy: batch.stage.policy,
    assurance: verificationStageAssurance(batch.stage),
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
    stageId: batch.stage.id,
    policy: batch.stage.policy,
    assurance: verificationStageAssurance(batch.stage),
    kind: batch.kind,
    command: batch.command,
    args: batch.args,
    status: verificationStageStatus(batch.stage, execution),
    exitCode: execution.exitCode,
    signal: execution.signal,
    diagnostics: Object.freeze([...execution.diagnostics]),
    wallMs,
    stdoutPath: execution.stdoutPath,
    stderrPath: execution.stderrPath,
    evidence: execution.evidence ?? null,
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
