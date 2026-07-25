import type { SliceVerificationPlan, VerificationSnapshot } from './verification-impact-plan.mjs'
import type { VerificationCandidateAdmissionManifest } from './verification-candidate-admission.mjs'
import type { MaterializedVerificationCandidate } from './verification-candidate-workspace.mjs'
import type { CommittedVerificationComparison } from './verification-git-comparison.mjs'
import type { VerificationComparisonManifest } from './verification-git-comparison.mjs'

type VerificationSliceManifest = VerificationCandidateAdmissionManifest & VerificationComparisonManifest

export interface VerificationSliceBaseline {
  readonly schemaVersion: 2
  readonly comparison: CommittedVerificationComparison
  readonly digest: string
}

export function createVerificationSliceBaseline(options: {
  root: string
  comparison: CommittedVerificationComparison
  now?: () => Date
}): {
  readonly id: string
  readonly baseline: VerificationSliceBaseline
  readonly comparisonSnapshot: VerificationSnapshot
}

export function createVerificationSlicePlan(options: {
  evidenceRoot: string
  baselineId: string
  candidate: MaterializedVerificationCandidate
  manifest?: VerificationSliceManifest
}): {
  readonly baseline: VerificationSnapshot
  readonly baselineEnvelope: VerificationSliceBaseline
  readonly candidate: MaterializedVerificationCandidate
  readonly current: VerificationSnapshot
  readonly plan: SliceVerificationPlan
}

export function readVerificationSliceBaseline(
  root: string,
  baselineId: string,
  manifest?: VerificationSliceManifest,
): VerificationSliceBaseline
export function verificationSliceBaselineDirectory(root: string): string
export function assertVerificationBaselineId(value: string): string
