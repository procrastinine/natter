import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { prepareVerificationCandidate } from './verification-candidate-preparation.mjs'
import { materializeCommittedVerificationComparison } from './verification-git-comparison.mjs'
import {
  createVerificationSliceBaseline,
  createVerificationSlicePlan,
} from './verification-slice-workspace.mjs'

const ROOT = resolve(import.meta.dirname, '..')

export async function beginVerificationSlice(options = {}) {
  const root = resolve(options.root ?? ROOT)
  const comparison = await materializeCommittedVerificationComparison({ root })
  const created = createVerificationSliceBaseline({
    root,
    comparison,
    now: options.now,
  })
  return Object.freeze({
    mode: 'comparison-baseline',
    baselineId: created.id,
    baselineDigest: created.baseline.digest,
    comparison: Object.freeze({
      commitOid: comparison.commitOid,
      treeOid: comparison.treeOid,
      digest: comparison.digest,
      sourceStats: comparison.sourceStats,
    }),
  })
}

export async function prepareVerificationSliceCandidate(options) {
  const root = resolve(options.root ?? ROOT)
  const { candidate, dependencyImage } = await prepareVerificationCandidate({
    root,
    storeRoot: options.storeRoot,
    manifest: options.manifest,
  })
  const bundle = createVerificationSlicePlan({
    evidenceRoot: root,
    baselineId: options.baselineId,
    candidate,
    manifest: options.manifest,
  })
  return Object.freeze({
    mode: 'candidate-plan',
    baselineId: options.baselineId,
    baselineDigest: bundle.baselineEnvelope.digest,
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    candidateSnapshotDigest: candidate.snapshot.digest,
    compilerCohortStatus: candidate.compilerCohort.status,
    dependencyImageId: dependencyImage.id,
    dependencyImageDigest: dependencyImage.digest,
    comparison: Object.freeze({
      commitOid: bundle.baselineEnvelope.comparison.commitOid,
      treeOid: bundle.baselineEnvelope.comparison.treeOid,
      digest: bundle.baselineEnvelope.comparison.digest,
    }),
    plan: bundle.plan,
  })
}

export function parseVerificationSlicePlanArgs(argv) {
  const parsed = { begin: false, baseline: null, explain: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--begin') parsed.begin = true
    else if (arg === '--explain') parsed.explain = true
    else if (arg === '--json') parsed.json = true
    else if (arg === '--baseline') {
      const value = argv[index + 1]
      if (!value) throw new Error('VerificationBaselineIdMissing')
      parsed.baseline = value
      index += 1
    } else {
      throw new Error(`VerificationSliceArgumentForbidden:${arg}`)
    }
  }
  if (parsed.begin && parsed.baseline) throw new Error('VerificationSliceBaselineModeConflict')
  if (!parsed.begin && !parsed.baseline)
    throw new Error('VerificationBaselineRequiredDirtyWorktree')
  return Object.freeze(parsed)
}

async function main() {
  const args = parseVerificationSlicePlanArgs(process.argv.slice(2))
  const result = args.begin
    ? await beginVerificationSlice()
    : await prepareVerificationSliceCandidate({ baselineId: args.baseline })
  if (args.json) {
    console.log(JSON.stringify(result))
    return
  }
  if (result.mode === 'comparison-baseline') {
    console.log(`Verification comparison baseline: ${result.baselineId}`)
    console.log(`- commit: ${result.comparison.commitOid}`)
    console.log(`- tree: ${result.comparison.treeOid}`)
    console.log(`- digest: ${result.baselineDigest}`)
    return
  }
  console.log(`Verification candidate: ${result.candidateId}`)
  console.log(`- baseline: ${result.baselineId}`)
  console.log(`- dependency image: ${result.dependencyImageId}`)
  console.log(`- compiler cohort: ${result.compilerCohortStatus}`)
  console.log(`- plan: ${result.plan.planDigest}`)
  console.log(`- executable: ${result.plan.executable ? 'yes' : 'no'}`)
  if (args.explain) console.log(JSON.stringify(result.plan, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
