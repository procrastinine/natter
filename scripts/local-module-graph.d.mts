import type { Buffer } from 'node:buffer'
import type { SourceFile } from 'typescript'

export interface LocalModuleGraphDiagnostic {
  readonly code:
    | 'parse-error'
    | 'opaque-module-reference'
    | 'module-reference-outside-root'
    | 'unresolved-local-module'
    | 'resolved-module-outside-graph'
  readonly path: string
  readonly line: number
  readonly detail: string
}

export interface LocalModuleGraph {
  readonly paths: readonly string[]
  readonly dependencies: ReadonlyMap<string, readonly string[]>
  readonly reverseDependencies: ReadonlyMap<string, readonly string[]>
  readonly edgeCount: number
  readonly diagnostics: readonly LocalModuleGraphDiagnostic[]
}

export interface LocalModuleGraphOptions {
  readonly root?: string
  readonly paths?: ReadonlySet<string> | readonly string[]
  readonly directories?: readonly string[]
  readonly files?: readonly string[]
  readonly extensions?: readonly string[]
  readonly source?: LocalModuleFileSource
  readonly parseSourceFile?: (path: string, source: string) => SourceFile
}

export interface LocalModuleFileSource {
  readonly kind: 'filesystem' | 'git-tree'
  readonly allPaths: ReadonlySet<string>
  readonly readFileBytes: (path: string) => Buffer
  readonly isExecutable: (path: string) => boolean
}

export interface FilesystemLocalModuleSourceOptions extends LocalModuleGraphOptions {
  readonly additionalPaths?: readonly string[]
}

export type ScannedLocalModuleFile =
  | {
      readonly kind: 'code'
      readonly path: string
      readonly bytes: Buffer
      readonly executable: boolean
      readonly sourceFile: SourceFile
    }
  | {
      readonly kind: 'non-code'
      readonly path: string
      readonly bytes: Buffer
      readonly executable: boolean
      readonly sourceFile: null
    }

export interface LocalModuleScanResult<T> {
  readonly graph: LocalModuleGraph
  readonly projections: ReadonlyMap<string, T>
}

export interface LocalModuleScanOptions<T> extends LocalModuleGraphOptions {
  readonly supplementalPaths?: ReadonlySet<string> | readonly string[]
  readonly projectFile: (file: ScannedLocalModuleFile) => T
}

export interface ReachableLocalModuleScanOptions<T>
  extends Omit<LocalModuleGraphOptions, 'paths'> {
  readonly entryPaths: readonly string[]
  readonly availablePaths?: ReadonlySet<string> | readonly string[]
  readonly projectFile: (file: ScannedLocalModuleFile) => T
}

export const LOCAL_MODULE_CODE_EXTENSIONS: readonly string[]
export const LOCAL_MODULE_ASSET_EXTENSIONS: readonly string[]
export function createFilesystemLocalModuleSource(
  options?: FilesystemLocalModuleSourceOptions,
): LocalModuleFileSource
export function discoverLocalModulePaths(options?: LocalModuleGraphOptions): Set<string>
export function buildLocalModuleGraph(options?: LocalModuleGraphOptions): LocalModuleGraph
export function scanLocalModuleGraph<T>(options: LocalModuleScanOptions<T>): LocalModuleScanResult<T>
export function scanReachableLocalModuleGraph<T>(
  options: ReachableLocalModuleScanOptions<T>,
): LocalModuleScanResult<T>
export function reverseReachableLocalModules(
  graph: LocalModuleGraph,
  roots: readonly string[],
): readonly string[]
