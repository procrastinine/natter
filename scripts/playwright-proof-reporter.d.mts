import type { Reporter } from '@playwright/test/reporter'
export interface BrowserTask { project: string; files: readonly string[] }
export interface BrowserProofCase {
  id: string
  project: string
  file: string
  outcome: string
  annotations: Array<{ type: string; description?: string }>
  results: Array<{ status: string; retry: number; duration: number }>
}
export function browserSuiteFiles(root: string): string[]
export function fullBrowserTasks(names: readonly string[], files: readonly string[]): BrowserTask[]
export function browserProofProblems(expected: readonly BrowserTask[], cases: BrowserProofCase[]): string[]
export function readBrowserProof(path: string, expected: readonly BrowserTask[]): { schemaVersion: 1; status: string; cases: BrowserProofCase[] }
export default class BrowserProofReporter implements Reporter {}

export interface BrowserProofReport { schemaVersion: 1; status: string; expected: readonly BrowserTask[]; cases: BrowserProofCase[]; problems?: string[] }
export function reconcileBrowserPhaseProofs(expected: readonly BrowserTask[], phases: readonly { readonly name: string; readonly tasks: readonly BrowserTask[]; readonly exitCode: number | null; readonly signal: string | null; readonly proof: BrowserProofReport | null; readonly diagnostics?: readonly string[] }[]): BrowserProofReport & { problems: string[] }
