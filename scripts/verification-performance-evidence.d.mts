import type { VerificationStageResult } from './run-verification.mjs'
export interface VerificationPerformanceStageEvidence {
  readonly id:
    | 'production-build'
    | 'vitest'
    | 'chromium-e2e'
    | 'firefox-e2e'
    | 'stream-profile-single'
    | 'stream-profile-concurrent'
  readonly executionStageId: string
  readonly status: 'failed' | 'inventoried' | 'passed' | 'planned'
  readonly exitCode: number | null
  readonly timing: {
    readonly wallMs: number
    readonly runnerCpuUserMs: number | null
    readonly runnerCpuSystemMs: number | null
  } | null
  readonly stdoutArtifact: string | null
}

export interface VerificationPerformanceEvidence {
  readonly schemaVersion: 1
  readonly kind: 'verification-performance-evidence'
  readonly runId: string
  readonly provenance: Readonly<Record<string, unknown>> | null
  readonly stages: readonly VerificationPerformanceStageEvidence[]
}

export const VERIFICATION_PERFORMANCE_EVIDENCE_SCHEMA_VERSION: 1
export const VERIFICATION_PERFORMANCE_REQUIRED_STAGE_IDS: readonly VerificationPerformanceStageEvidence['id'][]

export interface VerificationPerformanceInputStage {
  readonly id: string
  readonly stageId?: string
  readonly status: VerificationPerformanceStageEvidence['status']
  readonly exitCode: number | null
  readonly timing?: VerificationPerformanceStageEvidence['timing']
  readonly wallMs?: number | null
  readonly stdoutPath: string | null
}

export interface VerificationPerformancePreparation {
  readonly artifactRoot: string
  readonly runDirectory: string
  readonly runId: string
  readonly provenance?: Readonly<Record<string, unknown>> | null
  readonly stages: readonly (VerificationPerformanceInputStage | VerificationStageResult)[]
  readonly stageAliases?: Readonly<Record<string, string>>
}

export function persistVerificationPerformanceEvidence(options: VerificationPerformancePreparation): Promise<Readonly<{ evidence: VerificationPerformanceEvidence; path: string }>>



export function readVerificationPerformanceEvidence(
  path: string,
  expectedRunId?: string,
): Promise<Readonly<{ evidence: VerificationPerformanceEvidence; path: string }>>

export function validateVerificationPerformanceEvidence(
  value: unknown,
  expectedRunId?: string,
): VerificationPerformanceEvidence

export function verificationPerformanceArtifactPath(
  inputPath: string,
  stage: VerificationPerformanceStageEvidence,
): string
