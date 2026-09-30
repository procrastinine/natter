import type { TestCompilerProof, VerificationCompilerEvidence, VerificationMetadata } from './run-verification.mjs'
import type { VerificationAssurance, VerificationPolicy, VerificationStage } from './run-verification.mjs'
import type { Writable } from 'node:stream'
import type { SliceVerificationPlan, VerificationSnapshot } from './verification-impact-plan.mjs'
import type {
  MaterializedVerificationCandidate,
  VerificationCandidateRuntime,
} from './verification-candidate-workspace.mjs'

export interface SliceTaskBatch {
  readonly stage: VerificationStage
  readonly id: string
  readonly kind: 'node' | 'playwright' | 'vitest'
  readonly command: string
  readonly args: readonly string[]
  readonly browserTasks?: readonly { project: string; files: readonly string[] }[]
}

export interface SliceBatchExecution {
  readonly evidence?: VerificationCompilerEvidence
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly diagnostics: readonly string[]
  readonly stdoutPath: string | null
  readonly stderrPath: string | null
}

export interface SliceOutputDestinations {
  readonly stdout: Writable
  readonly stderr: Writable
}

export interface SliceVerificationSummary {
  readonly schemaVersion: 1
  readonly runId: string
  readonly baselineId: string
  readonly provenance: SliceVerificationProvenance | null
  readonly planDigest: string
  readonly currentDigest: string
  readonly executable: boolean
  readonly closable: boolean
  readonly structuralBlockers: readonly string[]
  readonly openGuarantees: readonly { readonly id: string; readonly status: string }[]
  readonly unregisteredAffectedTests: readonly string[]
  readonly batches: readonly {
    readonly evidence?: VerificationCompilerEvidence | null
    readonly id: string
    readonly stageId: string
    readonly policy: VerificationPolicy
    readonly assurance: VerificationAssurance
    readonly kind: SliceTaskBatch['kind']
    readonly command: string
    readonly args: readonly string[]
    readonly status: 'failed' | 'inventoried' | 'passed' | 'planned'
    readonly exitCode: number | null
    readonly signal: NodeJS.Signals | null
    readonly diagnostics: readonly string[]
    readonly wallMs: number | null
    readonly stdoutPath: string | null
    readonly stderrPath: string | null
  }[]
  readonly inputsChangedDuringRun: boolean
  readonly infrastructureDiagnostics: readonly string[]
  readonly outcome: 'blocked' | 'failed' | 'passed' | 'passed-with-open-guarantees' | 'running'
  readonly wallMs: number
}

export interface SliceVerificationProvenance {
  readonly comparisonCommitOid: string
  readonly comparisonTreeOid: string
  readonly comparisonDigest: string
  readonly baselineDigest: string
  readonly candidateId: string
  readonly candidateDigest: string
  readonly candidateSnapshotDigest: string
  readonly compilerCohortDigest: string
  readonly dependencyImageId: string
  readonly dependencyImageDigest: string
}

export function createSliceTaskBatches(
  plan: SliceVerificationPlan,
  runtime?: Pick<VerificationCandidateRuntime, 'nodeExecutablePath' | 'pnpmExecutablePath'> | null,
): readonly SliceTaskBatch[]

export function assertSliceVerificationExecutionReady(manifest?: {
  readonly id: string
  readonly mode: string
  readonly sourceObligations: readonly string[]
  readonly heartbeatObligations?: readonly string[]
  readonly costObligations: readonly string[]
}): void

export interface SliceVerificationOptions {
  readonly baselineId: string
  readonly evidenceRoot?: string
  readonly candidate: MaterializedVerificationCandidate
  readonly forwardOutput?: boolean
  readonly outputDestinations?: SliceOutputDestinations
}

export interface PreparedSliceVerificationOptions {
  readonly metadata?: VerificationMetadata
  readonly testCompilerProof?: TestCompilerProof
  readonly baselineId: string
  readonly evidenceRoot?: string
  readonly runtimeRoot: string
  readonly candidate?: MaterializedVerificationCandidate
  readonly provenance?: SliceVerificationProvenance
  readonly runKey?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly runtime?: Pick<
    VerificationCandidateRuntime,
    'nodeExecutablePath' | 'pnpmExecutablePath'
  >
  readonly planBundle: {
    readonly baseline: VerificationSnapshot
    readonly current: VerificationSnapshot
    readonly plan: SliceVerificationPlan
  }
  readonly executeBatch?: (
    batch: SliceTaskBatch,
    options: {
      readonly artifactRoot: string
      readonly root: string
      readonly runDirectory: string
      readonly environment: NodeJS.ProcessEnv
      readonly forwardOutput: boolean
    },
  ) => Promise<SliceBatchExecution>
  readonly buildCurrentSnapshot?: () => VerificationSnapshot | Promise<VerificationSnapshot>
  readonly persistSummary?: (summary: SliceVerificationSummary) => Promise<void>
  readonly monotonicNow?: () => number
  readonly now?: () => Date
  readonly forwardOutput?: boolean
  readonly outputDestinations?: SliceOutputDestinations
}

export function runSliceVerification(
  options: SliceVerificationOptions,
): Promise<{ readonly summary: SliceVerificationSummary; readonly exitCode: 0 | 1 }>

export function executePreparedSliceVerification(
  options: PreparedSliceVerificationOptions,
): Promise<{ readonly summary: SliceVerificationSummary; readonly exitCode: 0 | 1 }>
