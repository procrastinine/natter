import type { Reporter } from 'vitest/reporters'
import type { VitestProjectFiles } from './vitest-projects.mjs'

export interface VitestProofFile { readonly project: string; readonly file: string }
export interface VitestProofCase { readonly id: string; readonly name: string; readonly mode: string }
export interface VitestProofResult extends VitestProofFile {
  readonly id: string
  readonly state: string
  readonly errors: readonly string[]
  readonly diagnostic: { readonly retryCount: number; readonly repeatCount: number; readonly flaky: boolean; readonly duration: number } | null
}
export interface VitestProof {
  readonly invocation: string
  readonly schemaVersion: 1
  readonly reason: string
  readonly timedOut: boolean
  readonly expected: readonly VitestProofFile[]
  readonly scheduled: readonly VitestProofFile[]
  readonly collected: readonly (VitestProofFile & { readonly cases: readonly VitestProofCase[] })[]
  readonly completed: readonly (VitestProofFile & { readonly state: string })[]
  readonly finalModules: readonly VitestProofFile[]
  readonly results: readonly VitestProofResult[]
  readonly unhandledErrors: readonly string[]
  readonly selectionProblems: readonly string[]
}
export function selectVitestProofFiles(projects: readonly VitestProjectFiles[], selection?: string): VitestProofFile[]
export function vitestProofProblems(report: VitestProof, expectedFiles?: readonly string[], invocation?: string): string[]
export function readVitestProof(path: string, expectedFiles: readonly string[], invocation: string): VitestProof & { readonly status: 'passed' }
export default class VitestProofReporter implements Reporter {
  constructor(options: { readonly invocation: string | undefined; readonly path: string; readonly expected: readonly VitestProofFile[] })
  onInit: NonNullable<Reporter['onInit']>
  onTestRunStart: NonNullable<Reporter['onTestRunStart']>
  onTestModuleCollected: NonNullable<Reporter['onTestModuleCollected']>
  onTestCaseResult: NonNullable<Reporter['onTestCaseResult']>
  onTestModuleEnd: NonNullable<Reporter['onTestModuleEnd']>
  onTestRunEnd: NonNullable<Reporter['onTestRunEnd']>
  onProcessTimeout: NonNullable<Reporter['onProcessTimeout']>
}
