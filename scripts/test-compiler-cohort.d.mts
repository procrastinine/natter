import type { VerificationSnapshot } from './verification-impact-plan.mjs'

export interface TestCompilerEncodedOutput {
  readonly encoding: 'base64'
  readonly byteLength: number
  readonly sha256: string
  readonly data: string
}

export interface TestCompilerExecutionCapture {
  readonly invocation: {
    readonly packageSpecifier: string
    readonly args: readonly string[]
    readonly environment: Readonly<Record<string, string>>
  }
  readonly stdout: TestCompilerEncodedOutput
  readonly stderr: TestCompilerEncodedOutput
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly error: string | null
}

export interface TestCompilerIdentity {
  readonly packageSpecifier: string
  readonly packageName: string
  readonly packageVersion: string
  readonly packageJsonSha256: string
  readonly cliEntrySha256: string
  readonly nodeExecutableSha256: string
  readonly nodeExecutableByteLength: number
  readonly nativePackageJsonSha256: string
  readonly nativeExecutableSha256: string
  readonly nativeExecutableByteLength: number
  readonly nodeVersion: string
  readonly platform: NodeJS.Platform
  readonly arch: string
}

export interface TestCompilerCapture {
  readonly schemaVersion: 1
  readonly candidateId: string
  readonly snapshotDigest: string
  readonly descriptorDigest: string
  readonly compiler: TestCompilerIdentity
  readonly roots: TestCompilerExecutionCapture
  readonly diagnostics: TestCompilerExecutionCapture
  readonly digest: string
}

export interface TestCompilerCohortDescriptor {
  readonly schemaVersion: 1
  readonly assignment: {
    readonly waveId: string
    readonly sourceObligation: string
  }
  readonly compiler: {
    readonly packageSpecifier: string
    readonly rootArgs: readonly string[]
    readonly diagnosticArgs: readonly string[]
    readonly environment: Readonly<Record<string, string>>
  }
  readonly historicalCohort: {
    readonly status: 'evidence-lost'
    readonly expectedFileCount: number
    readonly disposition: string
  }
}

export interface TestCompilerCohort {
  readonly schemaVersion: 1
  readonly assignment: TestCompilerCohortDescriptor['assignment']
  readonly candidateId: string
  readonly snapshotDigest: string
  readonly descriptorDigest: string
  readonly compiler: TestCompilerIdentity
  readonly status: 'invalid' | 'pending' | 'resolved'
  readonly configuredRootOrder: readonly string[]
  readonly roots: readonly { readonly path: string; readonly sha256: string | null }[]
  readonly diagnostics: readonly {
    readonly ordinal: number
    readonly channel: 'stderr' | 'stdout'
    readonly path: string | null
    readonly line: number | null
    readonly column: number | null
    readonly category: string
    readonly code: number
    readonly raw: string
  }[]
  readonly unparsedOutput: readonly {
    readonly channel: 'stderr' | 'stdout'
    readonly raw: string
  }[]
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly error: string | null
  readonly problems: readonly string[]
  readonly historicalCohort: TestCompilerCohortDescriptor['historicalCohort']
  readonly capture: TestCompilerCapture
  readonly digest: string
}

export const TEST_COMPILER_COHORT_DESCRIPTOR: TestCompilerCohortDescriptor
export const TEST_COMPILER_COHORT_DESCRIPTOR_DIGEST: string
export function buildTestCompilerCohort(options: {
  readonly snapshot: VerificationSnapshot
  readonly capture: TestCompilerCapture
}): TestCompilerCohort
export function validateTestCompilerCohort(
  cohort: TestCompilerCohort,
  snapshot: VerificationSnapshot,
): readonly string[]
