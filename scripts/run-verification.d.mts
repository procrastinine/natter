import type { Writable } from 'node:stream'

export type VerificationPolicy = 'advisory' | 'blocking'
export type VerificationAssurance = 'guarantee' | 'hygiene' | 'inventory' | 'runtime'
export type VerificationStatus = 'failed' | 'inventoried' | 'passed' | 'planned'
export type VerificationOutcome =
  | 'completed-with-open-inventories'
  | 'failed'
  | 'passed'
  | 'planned'
  | 'running'

export interface VerificationStage {
  readonly id: string
  readonly label: string
  readonly policy: VerificationPolicy
  readonly argv: readonly string[]
}

export interface VerificationExecution {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly diagnostics: readonly string[]
  readonly stdoutPath?: string | null
  readonly stderrPath?: string | null
}

export interface VerificationMetadata {
  readonly nodeVersion: string
  readonly expectedNodeVersion: string
  readonly pnpmVersion: string
  readonly expectedPnpmVersion: string
  readonly playwrightVersion: string
  readonly platform: NodeJS.Platform
  readonly architecture: string
  readonly ci: boolean
  readonly githubActions: boolean
  readonly runnerOs: string | null
  readonly timezone: string
  readonly e2ePort: number
  readonly fakeProviderPort: number
  readonly metadataDiagnostics: readonly string[]
}

export interface VerificationStageResult {
  readonly id: string
  readonly label: string
  readonly policy: VerificationPolicy
  readonly argv: readonly string[]
  readonly assurance: VerificationAssurance
  readonly status: VerificationStatus
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly diagnostics: readonly string[]
  readonly timing: VerificationTiming | null
  readonly stdoutPath: string | null
  readonly stderrPath: string | null
}

export interface VerificationTiming {
  readonly wallMs: number
  readonly runnerCpuUserMs: number
  readonly runnerCpuSystemMs: number
}

export interface VerificationSummary {
  readonly schemaVersion: 4
  readonly provenance: Readonly<Record<string, unknown>> | null
  readonly metadata: VerificationMetadata
  readonly timing: VerificationTiming
  readonly policy: {
    readonly execution: 'sequential-non-fail-fast'
    readonly blockingFailureExitCode: 1
    readonly advisoryFailureExitCode: 0
  }
  readonly stages: readonly VerificationStageResult[]
  readonly assurance: {
    readonly hygiene: readonly string[]
    readonly inventories: readonly string[]
    readonly guarantees: readonly string[]
    readonly runtimeProofs: readonly string[]
  }
  readonly blockingFailures: readonly string[]
  readonly advisoryFailures: readonly string[]
  readonly infrastructureDiagnostics: readonly string[]
  readonly outcome: VerificationOutcome
}

export interface RunVerificationOptions {
  readonly root?: string
  readonly baseEnv?: Readonly<NodeJS.ProcessEnv>
  readonly executionRuntime?: {
    readonly nodeExecutablePath: string
    readonly pnpmExecutablePath: string
  }
  readonly stages?: readonly VerificationStage[]
  readonly metadata?: VerificationMetadata
  readonly executeStage?: (
    stage: VerificationStage,
    metadata: VerificationMetadata,
  ) => Promise<VerificationExecution>
  readonly persistSummary?: (summary: VerificationSummary) => Promise<void>
  readonly finalValidator?: () => void | Promise<void>
  readonly requiredStageIds?: readonly string[]
  readonly provenance?: Readonly<Record<string, unknown>> | null
  readonly artifactRoot?: string
  readonly runDirectory?: string
  readonly runId?: string
  readonly now?: () => Date
  readonly forwardOutput?: boolean
  readonly outputDestinations?: { readonly stdout: Writable; readonly stderr: Writable }
  readonly dryRun?: boolean
  readonly monotonicNow?: () => number
  readonly cpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage
}

export const VERIFICATION_STAGES: readonly VerificationStage[]
export const CHECKPOINT_REQUIRED_STAGE_IDS: readonly string[]

export function collectVerificationMetadata(options?: {
  readonly root?: string
  readonly pnpmVersion?: string
  readonly nodeVersion?: string
  readonly environment?: Readonly<NodeJS.ProcessEnv>
}): Promise<VerificationMetadata>

export function runVerification(options?: RunVerificationOptions): Promise<{
  readonly summary: VerificationSummary
  readonly exitCode: 0 | 1
}>

export function createVerificationSummary(
  metadata: VerificationMetadata,
  stages: readonly VerificationStageResult[],
  outcome: VerificationOutcome,
  timing?: VerificationTiming,
  infrastructureDiagnostics?: readonly string[],
  provenance?: Readonly<Record<string, unknown>> | null,
): VerificationSummary

export function serializeVerificationSummary(summary: VerificationSummary): string
export function executeVerificationStage(
  stage: VerificationStage,
  metadata: VerificationMetadata,
  options?: {
    readonly root?: string
    readonly baseEnv?: Readonly<NodeJS.ProcessEnv>
    readonly executionRuntime?: {
      readonly nodeExecutablePath: string
      readonly pnpmExecutablePath: string
    }
    readonly artifactRoot?: string
    readonly runDirectory?: string
    readonly runId?: string
    readonly forwardOutput?: boolean
    readonly outputDestinations?: { readonly stdout: Writable; readonly stderr: Writable }
    readonly performanceEvidencePath?: string | null
  },
): Promise<VerificationExecution>
export function verificationStageEnvironment(
  stage: VerificationStage,
  options?: {
    readonly root?: string
    readonly baseEnv?: Readonly<NodeJS.ProcessEnv>
    readonly runId?: string
    readonly runDirectory?: string
    readonly performanceEvidencePath?: string | null
  },
): NodeJS.ProcessEnv
