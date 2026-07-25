import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { currentWaveManifest } from './current-wave-manifest.mjs'
import {
  CHECKPOINT_REQUIRED_STAGE_IDS,
  collectVerificationMetadata,
  runVerification,
  serializeVerificationSummary,
} from './run-verification.mjs'
import { executeMaterializedVerificationCandidate } from './verification-candidate-execution.mjs'
import {
  assertMaterializedVerificationCandidateUnchanged,
  readMaterializedVerificationCandidate,
} from './verification-candidate-workspace.mjs'
import { readVerificationSliceBaseline } from './verification-slice-workspace.mjs'

const ROOT = resolve(import.meta.dirname, '..')

export async function runCheckpointVerification(options) {
  const evidenceRoot = resolve(options.evidenceRoot)
  const candidate = options.candidate
  const baseline = (options.readBaseline ?? readVerificationSliceBaseline)(
    evidenceRoot,
    options.baselineId,
    currentWaveManifest,
  )
  const runDirectory = resolve(evidenceRoot, 'test-results/verification-checkpoint', candidate.id)
  const executeCandidate = options.executeCandidate ?? executeMaterializedVerificationCandidate
  const assertCandidateUnchanged =
    options.assertCandidateUnchanged ?? assertMaterializedVerificationCandidateUnchanged
  return executeCandidate(
    {
      candidate,
      evidenceRoot,
      residentRoot: ROOT,
      runId: `checkpoint-${candidate.id}`,
      purpose: `candidate-checkpoint:${candidate.id}`,
    },
    async ({ runtime, environment }) => {
      let unchanged = false
      let validationError = null
      const provenance = checkpointProvenance(options.baselineId, baseline, candidate)
      const metadata = await collectVerificationMetadata({
        root: candidate.runtimeRoot,
        pnpmVersion: candidate.dependencyImage.recipe.runtime.pnpmVersion,
        nodeVersion: candidate.dependencyImage.recipe.runtime.nodeVersion.replace(/^v/u, ''),
        environment,
      })
      const verification = await (options.runVerification ?? runVerification)({
        root: candidate.runtimeRoot,
        baseEnv: environment,
        executionRuntime: runtime,
        metadata,
        artifactRoot: evidenceRoot,
        runDirectory: resolve(runDirectory, 'stages'),
        runId: candidate.id,
        provenance,
        requiredStageIds: CHECKPOINT_REQUIRED_STAGE_IDS,
        finalValidator: () => {
          try {
            assertCandidateUnchanged(candidate)
            unchanged = true
          } catch (error) {
            validationError =
              error instanceof Error ? `${error.name}:${error.message}` : String(error)
            throw error
          }
        },
        persistSummary: async (summary) => {
          await Promise.all([
            persistJson(resolve(runDirectory, 'verification-summary.json'), summary),
            persistText(
              resolve(evidenceRoot, 'test-results/verification-summary.json'),
              serializeVerificationSummary(summary),
            ),
          ])
        },
      })
      const summary = Object.freeze({
        schemaVersion: 1,
        baselineId: options.baselineId,
        baselineDigest: baseline.digest,
        comparisonCommitOid: baseline.comparison.commitOid,
        comparisonTreeOid: baseline.comparison.treeOid,
        comparisonDigest: baseline.comparison.digest,
        candidateId: candidate.id,
        candidateDigest: candidate.digest,
        candidateSnapshotDigest: candidate.snapshot.digest,
        dependencyImageId: candidate.dependency.imageId,
        dependencyImageDigest: candidate.dependency.imageDigest,
        compilerCohortDigest: candidate.compilerCohort.digest,
        verificationOutcome: verification.summary.outcome,
        verificationExitCode: verification.exitCode,
        candidateUnchanged: unchanged,
        validationError,
        outcome:
          verification.exitCode === 0 && verification.summary.outcome === 'passed' && unchanged
            ? 'passed'
            : 'failed',
      })
      await persistJson(resolve(runDirectory, 'checkpoint-summary.json'), summary)
      console.log('\nImmutable checkpoint verification complete')
      console.log(`- outcome: ${summary.outcome}`)
      console.log(`- candidate unchanged: ${unchanged ? 'yes' : 'no'}`)
      console.log(
        `- summary: test-results/verification-checkpoint/${candidate.id}/checkpoint-summary.json`,
      )
      return Object.freeze({
        summary,
        exitCode: summary.outcome === 'passed' ? 0 : 1,
      })
    },
  )
}

function checkpointProvenance(baselineId, baseline, candidate) {
  return Object.freeze({
    baselineId,
    baselineDigest: baseline.digest,
    comparisonCommitOid: baseline.comparison.commitOid,
    comparisonTreeOid: baseline.comparison.treeOid,
    comparisonDigest: baseline.comparison.digest,
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    candidateSnapshotDigest: candidate.snapshot.digest,
    dependencyImageId: candidate.dependency.imageId,
    dependencyImageDigest: candidate.dependency.imageDigest,
    compilerCohortDigest: candidate.compilerCohort.digest,
  })
}

function parseArgs(argv) {
  let baselineId = null
  let candidateId = null
  let candidateResident = false
  let evidenceRoot = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === '--candidate-resident') candidateResident = true
    else if (argument === '--evidence-root') {
      evidenceRoot = argv[index + 1] ?? null
      index += 1
    } else if (argument === '--baseline') {
      baselineId = argv[index + 1] ?? null
      index += 1
    } else if (argument === '--candidate') {
      candidateId = argv[index + 1] ?? null
      index += 1
    } else {
      throw new Error(`VerificationCheckpointArgumentForbidden:${argument}`)
    }
  }
  if (!baselineId) throw new Error('VerificationBaselineRequiredDirtyWorktree')
  if (!candidateId) throw new Error('VerificationCandidateIdRequired')
  if (!candidateResident) throw new Error('VerificationCandidateResidentInvocationRequired')
  if (!evidenceRoot) throw new Error('VerificationEvidenceRootRequired')
  return { baselineId, candidateId, evidenceRoot: resolve(evidenceRoot) }
}

async function persistJson(path, value) {
  await persistText(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function persistText(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, value, 'utf8')
  await rename(temporaryPath, path)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const candidate = readMaterializedVerificationCandidate({
    evidenceRoot: args.evidenceRoot,
    id: args.candidateId,
    manifest: currentWaveManifest,
  })
  const result = await runCheckpointVerification({ ...args, candidate })
  process.exitCode = result.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
