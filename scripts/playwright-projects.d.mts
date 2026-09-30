export interface BrowserProject {
  name: string
  browser: 'chromium' | 'firefox'
  testMatch: RegExp[]
  testIgnore?: RegExp[]
  dependencies?: string[]
  executionPhase?: 'workspace' | 'measurement'
  setup?: boolean
  fullyParallel?: boolean
  workers?: number
  activation?: string
  development?: boolean
  headed?: boolean
}
export function playwrightProjects(): BrowserProject[]
export function projectCollectsFile(project: BrowserProject, path: string): boolean
export function selectedPlaywrightProjects(environment?: Record<string, string | undefined>): BrowserProject[]
