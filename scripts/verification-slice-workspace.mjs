import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertVerificationCandidateAdmissionReady } from './verification-candidate-admission.mjs'
import { assertMaterializedVerificationCandidate } from './verification-candidate-workspace.mjs'
import {
  assertCommittedVerificationComparison,
  restoreCommittedVerificationComparison,
} from './verification-git-comparison.mjs'
import { planSliceVerification } from './verification-impact-plan.mjs'
import { VERIFICATION_SNAPSHOT_SCHEMA_VERSION } from './verification-snapshot-schema.mjs'

export function createVerificationSliceBaseline(options) {
  const root = options.root
  const comparison = assertCommittedVerificationComparison(options.comparison)
  const envelopeWithoutDigest = { schemaVersion: 2, comparison }
  const baseline = Object.freeze({
    ...envelopeWithoutDigest,
    digest: digestJson(envelopeWithoutDigest),
  })
  const id = verificationBaselineId(baseline.digest, options.now?.() ?? new Date())
  const directory = verificationSliceBaselineDirectory(root)
  mkdirSync(directory, { recursive: true })
  const path = resolve(directory, `${id}.json`)
  const temporaryPath = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(baseline)}\n`, { flag: 'wx' })
    renameSync(temporaryPath, path)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
  return Object.freeze({ id, baseline, comparisonSnapshot: comparison.snapshot })
}

export function createVerificationSlicePlan(options) {
  const admission = assertVerificationCandidateAdmissionReady(options.manifest)
  const baseline = readVerificationSliceBaseline(
    options.evidenceRoot,
    options.baselineId,
    options.manifest,
  )
  const candidate = assertMaterializedVerificationCandidate(options.candidate)
  if (candidate.waveId !== admission.waveId) throw new Error('VerificationCandidateWaveMismatch')
  assertVerificationSnapshot(candidate.snapshot, 'candidate')
  if (candidate.snapshot.schemaVersion !== baseline.comparison.snapshotSchemaVersion) {
    throw new Error('VerificationSnapshotSchemaMismatch')
  }
  const plan = planSliceVerification({
    root: candidate.runtimeRoot,
    base: baseline.comparison.snapshot,
    current: candidate.snapshot,
  })
  return Object.freeze({
    baseline: baseline.comparison.snapshot,
    baselineEnvelope: baseline,
    candidate,
    current: candidate.snapshot,
    plan,
  })
}

export function readVerificationSliceBaseline(root, baselineId, manifest) {
  const id = assertVerificationBaselineId(baselineId)
  const baseline = JSON.parse(
    readFileSync(resolve(verificationSliceBaselineDirectory(root), `${id}.json`), 'utf8'),
  )
  if (baseline?.schemaVersion !== 2) throw new Error('VerificationBaselineSchemaInvalid')
  const { digest: _digest, ...withoutDigest } = baseline
  if (baseline.digest !== digestJson(withoutDigest))
    throw new Error('VerificationBaselineDigestInvalid')
  const comparison = restoreCommittedVerificationComparison(baseline.comparison, manifest)
  return deepFreeze({ ...baseline, comparison })
}

export function verificationSliceBaselineDirectory(root) {
  return resolve(root, 'test-results/verification-slice/baselines')
}

export function assertVerificationBaselineId(value) {
  if (!/^slice-[A-Za-z0-9-]+$/u.test(value)) throw new Error('VerificationBaselineIdInvalid')
  return value
}

function assertVerificationSnapshot(snapshot, label) {
  if (
    snapshot?.schemaVersion !== VERIFICATION_SNAPSHOT_SCHEMA_VERSION ||
    typeof snapshot?.digest !== 'string'
  ) {
    throw new Error(`VerificationSnapshotInvalid:${label}`)
  }
  const { digest: _digest, ...withoutDigest } = snapshot
  if (snapshot.digest !== sha256(JSON.stringify(withoutDigest))) {
    throw new Error(`VerificationSnapshotDigestInvalid:${label}`)
  }
}

function verificationBaselineId(digest, now) {
  const digestHex = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest
  return `slice-${now.toISOString().replaceAll(/[:.]/gu, '-')}-${digestHex.slice(0, 12)}`
}

function digestJson(value) {
  return `sha256:${sha256(JSON.stringify(value))}`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
