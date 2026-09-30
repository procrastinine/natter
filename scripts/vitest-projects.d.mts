import type { UserWorkspaceConfig } from 'vitest/config'
import type { SourceFile } from 'typescript'
import type { LocalModuleGraph, LocalModuleGraphOptions, ScannedLocalModuleFile } from './local-module-graph.mjs'

export interface VitestProjectOptions extends LocalModuleGraphOptions {
  readonly moduleScan?: {
    readonly graph: LocalModuleGraph
    readonly files: ReadonlyMap<string, ScannedLocalModuleFile>
  }
}
export function parseVitestProjectSource(path: string, text: string): SourceFile
export function nodeUnitTests(options?: VitestProjectOptions): string[]

export const VITEST_SETUP_FILES: Readonly<{ node: 'tests/setup-node.ts'; app: 'tests/setup.ts' }>

export interface VitestProjectFiles { readonly project: 'node' | 'app'; readonly files: readonly string[]; readonly setupFiles: readonly string[] }
export function isVitestSuitePath(path: string): boolean
export function vitestSuiteFiles(options?: LocalModuleGraphOptions): string[]
export function vitestProjects(options?: VitestProjectOptions): [VitestProjectFiles, VitestProjectFiles]

export function vitestProjectConfigurations(
  projects: readonly VitestProjectFiles[],
  createConfig: (project: UserWorkspaceConfig) => UserWorkspaceConfig,
): UserWorkspaceConfig[]
