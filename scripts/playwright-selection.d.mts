import type { BrowserProject } from './playwright-projects.mjs'
export function browserProjectsForFile(path: string): BrowserProject[]
export function selectBrowserTasks(files: readonly string[], allFiles: readonly string[]): {
  tasks: Array<{ project: string; files: string[] }>
  problems: string[]
}
export function browserTaskGroups(tasks: readonly { project: string; files: readonly string[] }[]): Array<{
  name: string
  tasks: Array<{ project: string; files: readonly string[] }>
}>

export interface BrowserExecutionPhase {
  readonly name: string
  readonly tasks: readonly { readonly project: string; readonly files: readonly string[] }[]
  readonly argv: readonly string[]
}
export function browserGroupProjects(group: string): string[]
export function browserExecutionPhases(tasks: readonly { readonly project: string; readonly files: readonly string[] }[]): readonly BrowserExecutionPhase[]
