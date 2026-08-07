import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectDeliveryWeight, deliveryBudgetProblems } from './delivery-weight.mjs'
import {
  evaluateConcurrentStreamProfile,
  evaluateStreamProfile,
} from './stream-profile-evaluator.mjs'
import {
  readVerificationPerformanceEvidence,
  verificationPerformanceArtifactPath,
} from './verification-performance-evidence.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baseline = JSON.parse(readFileSync(join(root, 'scripts/performance-baseline.json'), 'utf8'))
const inputPath = process.env.VERIFICATION_PERFORMANCE_INPUT
const expectedRunId = process.env.VERIFICATION_RUN_ID
const inputProblems = []
let verification = null

if (!inputPath) {
  inputProblems.push('verification performance input is missing')
} else {
  try {
    verification = await readVerificationPerformanceEvidence(inputPath, expectedRunId)
  } catch (error) {
    inputProblems.push(`verification performance input is invalid: ${errorMessage(error)}`)
  }
}

const bundle = collectDeliveryWeight(root, baseline.deliveryBudgets)
const bundleBudgetProblems = deliveryBudgetProblems(bundle, baseline.deliveryBudgets)
const stageProblems = verification ? collectStageProblems(verification.evidence.stages) : []
const profiles = verification
  ? collectProfiles(verification.path, verification.evidence.stages, inputProblems)
  : { single: unavailableProfile(), concurrent: unavailableProfile() }
const hardProblems = [
  ...inputProblems,
  ...stageProblems,
  ...bundle.topologyProblems,
  ...profiles.single.evaluation.problems.map((problem) => `single stream: ${problem}`),
  ...profiles.concurrent.evaluation.problems.map((problem) => `concurrent stream: ${problem}`),
]

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  verification: verification
    ? {
        available: true,
        runId: verification.evidence.runId,
        provenance: verification.evidence.provenance,
        stages: verification.evidence.stages,
      }
    : { available: false },
  bundle: {
    ...bundle,
    budgetRecordedAt: baseline.deliveryBudgets.recordedAt,
    budgetProblems: bundleBudgetProblems,
    targetDeviations: bundleBudgetProblems,
  },
  tests: verification
    ? {
        vitest: stageTiming(verification.evidence.stages, 'vitest'),
        chromium: stageTiming(verification.evidence.stages, 'chromium-e2e'),
        firefox: stageTiming(verification.evidence.stages, 'firefox-e2e'),
      }
    : { available: false },
  profiles,
  hardProblems,
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (hardProblems.length > 0) process.exitCode = 1

function collectStageProblems(stages) {
  return stages.flatMap((stage) =>
    stage.status === 'passed' && stage.exitCode === 0
      ? []
      : [`required performance input stage is not green: ${stage.id} (${stage.status})`],
  )
}

function collectProfiles(path, stages, problems) {
  return {
    single: readProfile(path, stages, 'stream-profile-single', evaluateStreamProfile, problems),
    concurrent: readProfile(
      path,
      stages,
      'stream-profile-concurrent',
      evaluateConcurrentStreamProfile,
      problems,
    ),
  }
}

function readProfile(inputPath, stages, id, evaluate, problems) {
  const stage = stages.find((candidate) => candidate.id === id)
  if (!stage) {
    problems.push(`verification profile stage is missing: ${id}`)
    return unavailableProfile()
  }
  try {
    const artifactPath = verificationPerformanceArtifactPath(inputPath, stage)
    const report = JSON.parse(readFileSync(artifactPath, 'utf8'))
    return { available: true, evaluation: evaluate(report) }
  } catch (error) {
    problems.push(`verification profile artifact is invalid: ${id}: ${errorMessage(error)}`)
    return unavailableProfile()
  }
}

function unavailableProfile() {
  return {
    available: false,
    evaluation: {
      schemaVersion: 1,
      status: 'fail',
      metrics: {},
      problems: ['profile unavailable'],
    },
  }
}

function stageTiming(stages, id) {
  const stage = stages.find((candidate) => candidate.id === id)
  return stage?.timing ? { available: true, ...stage.timing } : { available: false }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
