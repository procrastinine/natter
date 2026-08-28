import type { VerificationCandidateAdmissionManifest } from './verification-candidate-admission.mjs'
import type { SliceVerificationPlan } from './verification-impact-plan.mjs'

export interface VerificationComparisonBaselineResult {
  readonly mode: 'comparison-baseline'
  readonly baselineId: string
  readonly baselineDigest: string
  readonly comparison: {
    readonly commitOid: string
    readonly treeOid: string
    readonly digest: string
    readonly sourceStats: Readonly<Record<string, number>>
  }
}

export interface VerificationCandidatePlanResult {
  readonly mode: 'candidate-plan'
  readonly baselineId: string
  readonly baselineDigest: string
  readonly candidateId: string
  readonly candidateDigest: string
  readonly candidateSnapshotDigest: string
  readonly compilerCohortStatus: string
  readonly dependencyImageId: string
  readonly dependencyImageDigest: string
  readonly comparison: {
    readonly commitOid: string
    readonly treeOid: string
    readonly digest: string
  }
  readonly plan: SliceVerificationPlan
}

export function beginVerificationSlice(options?: {
  readonly root?: string
  readonly now?: () => Date
  readonly comparisonMode?: 'canonical' | 'head'
}): Promise<VerificationComparisonBaselineResult>
export function prepareVerificationSliceCandidate(options: {
  readonly baselineId: string
  readonly root?: string
  readonly storeRoot?: string
  readonly manifest?: VerificationCandidateAdmissionManifest
}): Promise<VerificationCandidatePlanResult>
export function parseVerificationSlicePlanArgs(argv: readonly string[]): Readonly<{
  begin: boolean
  baseline: string | null
  explain: boolean
  head: boolean
  json: boolean
}>
