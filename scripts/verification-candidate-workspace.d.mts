import type { VerificationCandidateAdmissionManifest } from './verification-candidate-admission.mjs'
import type {
  VerificationDependencyImage,
  VerificationDependencyProcessResult,
} from './verification-dependency-image.mjs'
import type { VerificationSnapshot } from './verification-impact-plan.mjs'
import type { TestCompilerCapture, TestCompilerCohort } from './test-compiler-cohort.mjs'

export interface VerificationSourceManifest {
  readonly schemaVersion: 2
  readonly fileCount: number
  readonly totalBytes: number
  readonly entries: readonly {
    readonly path: string
    readonly executable: boolean
    readonly byteLength: number
    readonly sha256: string
  }[]
  readonly digest: string
}

export interface VerificationCandidateDependencyReference {
  readonly imageId: string
  readonly imageDigest: string
  readonly recipeDigest: string
  readonly treeDigest: string
  readonly facadeDigest: string
}

export interface MaterializedVerificationCandidate {
  readonly schemaVersion: 3
  readonly kind: 'materialized-verification-candidate'
  readonly id: string
  readonly waveId: string
  readonly dependency: VerificationCandidateDependencyReference
  readonly sourceManifest: VerificationSourceManifest
  readonly snapshot: VerificationSnapshot
  readonly compilerCohort: TestCompilerCohort
  readonly digest: string
  readonly evidenceRoot: string
  readonly directory: string
  readonly runtimeRoot: string
  readonly dependencyImage: VerificationDependencyImage
  readonly runtimePaths: {
    readonly cache: string
    readonly home: string
    readonly tmp: string
    readonly toolBin: string
  }
}

export function materializeVerificationCandidate(options: {
  readonly sourceRoot: string
  readonly evidenceRoot?: string
  readonly dependencyImage: VerificationDependencyImage
  readonly manifest?: VerificationCandidateAdmissionManifest
  readonly sourcePathInventory?: () => readonly string[] | Promise<readonly string[]>
  readonly runProcess?: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  ) => Promise<VerificationDependencyProcessResult>
  readonly captureCompiler?: (options: {
    readonly runtimeRoot: string
    readonly candidateId: string
    readonly snapshot: VerificationSnapshot
  }) => Promise<TestCompilerCapture>
}): Promise<MaterializedVerificationCandidate>

export function readMaterializedVerificationCandidate(options: {
  readonly evidenceRoot: string
  readonly id: string
  readonly manifest?: VerificationCandidateAdmissionManifest
}): MaterializedVerificationCandidate

export function assertMaterializedVerificationCandidate(
  value: unknown,
): MaterializedVerificationCandidate
export function assertMaterializedVerificationCandidateUnchanged(
  value: MaterializedVerificationCandidate,
): MaterializedVerificationCandidate
export function assertMaterializedVerificationCandidateExecutionReady(
  value: MaterializedVerificationCandidate,
): MaterializedVerificationCandidate
export interface VerificationCandidateRuntime {
  readonly nodeExecutablePath: string
  readonly pnpmExecutablePath: string
  readonly compilerCliEntryPath: string
  readonly nativeExecutablePath: string
}
export function resolveVerificationCandidateRuntime(
  value: MaterializedVerificationCandidate,
): Promise<VerificationCandidateRuntime>
export function resetMaterializedVerificationCandidateWritableState(
  value: MaterializedVerificationCandidate,
): MaterializedVerificationCandidate
export function installMaterializedVerificationCandidateRuntime(
  value: MaterializedVerificationCandidate,
  runtime: VerificationCandidateRuntime,
): MaterializedVerificationCandidate
export function discardMaterializedVerificationCandidate(
  value: MaterializedVerificationCandidate,
): void
export function verificationCandidateDirectory(evidenceRoot: string, candidateId: string): string
