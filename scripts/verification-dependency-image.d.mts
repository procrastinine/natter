export interface VerificationDependencyRuntimeIdentity {
  readonly nodeVersion: string
  readonly nodeExecutableSha256: string
  readonly nodeExecutableByteLength: number
  readonly pnpmVersion: string
  readonly pnpmExecutableSha256: string
  readonly pnpmExecutableByteLength: number
  readonly pnpmPackageJsonSha256: string
  readonly pnpmPackageTreeDigest: string
  readonly pnpmPackageTreeByteLength: number
  readonly pnpmPackageTreeFileCount: number
  readonly platform: string
  readonly arch: string
  readonly libc: string
}

export interface VerificationDependencyRuntimeCapability {
  readonly identity: VerificationDependencyRuntimeIdentity
  readonly nodeExecutablePath: string
  readonly pnpmExecutablePath: string
}

export interface VerificationDependencyRecipe {
  readonly schemaVersion: 1
  readonly installer: {
    readonly packageManager: 'pnpm'
    readonly offline: true
    readonly frozenLockfile: true
    readonly frozenStore: true
    readonly importMethod: 'copy'
  }
  readonly runtime: VerificationDependencyRuntimeIdentity
  readonly patchesDirectoryPresent: boolean
  readonly entries: readonly {
    readonly path: string
    readonly byteLength: number
    readonly sha256: string
  }[]
  readonly digest: string
}

export interface VerificationDependencyTree {
  readonly schemaVersion: 1
  readonly entryCount: number
  readonly fileCount: number
  readonly directoryCount: number
  readonly symlinkCount: number
  readonly totalBytes: number
  readonly contentDigest: string
  readonly digest: string
}

export interface VerificationDependencyFacade {
  readonly schemaVersion: 1
  readonly entryCount: number
  readonly fileCount: number
  readonly directoryCount: number
  readonly symlinkCount: number
  readonly totalBytes: number
  readonly contentDigest: string
  readonly digest: string
}

export interface VerificationDependencyImage {
  readonly schemaVersion: 2
  readonly kind: 'sealed-verification-dependency-image'
  readonly id: string
  readonly recipe: VerificationDependencyRecipe
  readonly tree: VerificationDependencyTree
  readonly facade: VerificationDependencyFacade
  readonly digest: string
  readonly evidenceRoot: string
  readonly directory: string
  readonly workspaceRoot: string
}

export interface VerificationDependencyProcessResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly error: string | null
  readonly stdout: Buffer
  readonly stderr: Buffer
}

export interface VerificationDependencyProcessInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

export function prepareVerificationDependencyImage(options: {
  readonly sourceRoot: string
  readonly evidenceRoot?: string
  readonly storeRoot?: string
  readonly runtime?: VerificationDependencyRuntimeIdentity
  readonly runProcess?: (
    invocation: VerificationDependencyProcessInvocation,
  ) => Promise<VerificationDependencyProcessResult>
}): Promise<VerificationDependencyImage>

export function readVerificationDependencyImage(options: {
  readonly evidenceRoot: string
  readonly id: string
  readonly expectedRecipe?: VerificationDependencyRecipe
}): VerificationDependencyImage

export function assertVerificationDependencyImage(value: unknown): VerificationDependencyImage
export function assertVerificationDependencyImageUnchanged(
  value: VerificationDependencyImage,
): VerificationDependencyImage
export function assertVerificationDependencyImageValidated(
  value: VerificationDependencyImage,
): VerificationDependencyImage
export function installVerificationDependencyFacade(options: {
  readonly image: VerificationDependencyImage
  readonly runtimeRoot: string
}): Promise<void>
export function assertVerificationDependencyFacade(options: {
  readonly image: VerificationDependencyImage
  readonly runtimeRoot: string
}): void
export const VERIFICATION_DEPENDENCY_RECIPE_FILES: readonly string[]
export function verificationDependencyRecipeInputPaths(sourceRoot: string): readonly string[]
export function resolveVerificationDependencyRuntime(
  value: VerificationDependencyImage,
): VerificationDependencyRuntimeCapability
export function findPnpmPackageJson(executablePath: string): string
export function discardVerificationDependencyImage(value: VerificationDependencyImage): void
export function verificationDependencyImageDirectory(evidenceRoot: string, id: string): string
