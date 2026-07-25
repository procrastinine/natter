export interface TestRuntimeIsolationSite {
  readonly path: string
  readonly line: number
}

export interface TestRuntimeIsolationAuditResult {
  readonly ok: boolean
  readonly resetSiteCount: number
  readonly classifiedResetFileCount: number
  readonly mixedMockImportSiteCount: number
  readonly productionKernelInstantiationCount: number
  readonly browserWorkspaceLifetimeFileCount: number
  readonly unownedBrowserWorkspaceLifetimeFileCount: number
  readonly resetSites: readonly TestRuntimeIsolationSite[]
  readonly mixedMockImportSites: readonly {
    readonly path: string
    readonly target: string
  }[]
  readonly productionKernelInstantiations: readonly string[]
  readonly browserWorkspaceLifetimeFiles: readonly string[]
  readonly unownedBrowserWorkspaceLifetimeFiles: readonly string[]
  readonly problems: readonly string[]
}

export function auditTestRuntimeIsolation(root?: string): TestRuntimeIsolationAuditResult
