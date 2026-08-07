import type { VerificationStageResult } from './run-verification.mjs'

export interface VerificationPerformanceStageEvidence {
  readonly id:
    | 'production-build'
    | 'vitest'
    | 'chromium-e2e'
    | 'firefox-e2e'
    | 'stream-profile-single'
    | 'stream-profile-concurrent'
  readonly status: 'failed' | 'inventoried' | 'passed' | 'planned'
  readonly exitCode: number | null
  readonly timing: {
    readonly wallMs: number
    readonly runnerCpuUserMs: number
    readonly runnerCpuSystemMs: number
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

export function persistVerificationPerformanceEvidence(options: {
  readonly artifactRoot: string
  readonly runDirectory: string
  readonly runId: string
  readonly provenance?: Readonly<Record<string, unknown>> | null
  readonly stages: readonly VerificationStageResult[]
}): Promise<Readonly<{ evidence: VerificationPerformanceEvidence; path: string }>>

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
