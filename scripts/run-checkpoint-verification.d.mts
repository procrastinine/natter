import type { MaterializedVerificationCandidate } from './verification-candidate-workspace.mjs'
import type { VerificationCandidateExecutionContext } from './verification-candidate-execution.mjs'
import type {
  RunVerificationOptions,
  VerificationSummary,
} from './run-verification.mjs'

export interface CheckpointVerificationSummary {
  readonly schemaVersion: 1
  readonly baselineId: string
  readonly baselineDigest: string
  readonly comparisonCommitOid: string
  readonly comparisonTreeOid: string
  readonly comparisonDigest: string
  readonly candidateId: string
  readonly candidateDigest: string
  readonly candidateSnapshotDigest: string
  readonly dependencyImageId: string
  readonly dependencyImageDigest: string
  readonly compilerCohortDigest: string
  readonly verificationOutcome: string
  readonly verificationExitCode: 0 | 1
  readonly candidateUnchanged: boolean
  readonly validationError: string | null
  readonly outcome: 'failed' | 'passed'
}

export function runCheckpointVerification(options: {
  readonly baselineId: string
  readonly evidenceRoot: string
  readonly candidate: MaterializedVerificationCandidate
  readonly readBaseline?: (
    evidenceRoot: string,
    baselineId: string,
    manifest: unknown,
  ) => {
    readonly digest: string
    readonly comparison: {
      readonly commitOid: string
      readonly treeOid: string
      readonly digest: string
    }
  }
  readonly assertCandidateUnchanged?: (
    candidate: MaterializedVerificationCandidate,
  ) => MaterializedVerificationCandidate
  readonly executeCandidate?: <T>(
    options: {
      readonly candidate: MaterializedVerificationCandidate
      readonly evidenceRoot: string
      readonly residentRoot: string
      readonly runId: string
      readonly purpose: string
    },
    operation: (context: VerificationCandidateExecutionContext) => Promise<T>,
  ) => Promise<T>
  readonly runVerification?: (options: RunVerificationOptions) => Promise<{
    readonly summary: VerificationSummary
    readonly exitCode: 0 | 1
  }>
}): Promise<{ readonly summary: CheckpointVerificationSummary; readonly exitCode: 0 | 1 }>
