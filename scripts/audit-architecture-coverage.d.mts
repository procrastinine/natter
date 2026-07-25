export interface ArchitectureCoverageAuditOptions {
  readonly root?: string
  readonly inventory?: string
  readonly manifest?: string
  readonly mode?: 'inventory' | 'enforce'
  readonly transformManifest?: (
    manifest: ArchitectureCoverageManifest,
  ) => ArchitectureCoverageManifest
}

export interface ArchitectureCoverageDimension {
  readonly id: string
  readonly description: string
  readonly allowedProofKinds: readonly string[]
}

export interface ArchitectureCoverageProof {
  readonly id: string
  readonly kind: string
  readonly path: string
  readonly locator: string
  readonly domains: readonly string[]
  readonly dimensions: readonly string[]
}

export interface ArchitectureCoverageCell {
  readonly status: 'covered' | 'gap' | 'not-applicable'
  readonly rationale: string
  readonly proofs: readonly string[]
}

export interface ArchitectureCoverageRow {
  readonly domain: string
  readonly cells: Readonly<Record<string, ArchitectureCoverageCell>>
}

export interface ArchitectureCoverageManifest {
  readonly ARCHITECTURE_DIMENSIONS: readonly ArchitectureCoverageDimension[]
  readonly ARCHITECTURE_PROOFS: readonly ArchitectureCoverageProof[]
  readonly ARCHITECTURE_COVERAGE: readonly ArchitectureCoverageRow[]
}

export interface ArchitectureCoverageAuditReport {
  readonly mode: 'inventory' | 'enforce'
  readonly ok: boolean
  readonly structurallyValid: boolean
  readonly sourceModuleCount: number
  readonly classifiedModuleCount: number
  readonly domainCount: number
  readonly dimensionCount: number
  readonly cellCount: number
  readonly proofCount: number
  readonly statusCounts: Readonly<Record<'covered' | 'gap' | 'not-applicable', number>>
  readonly gaps: readonly {
    readonly domain: string
    readonly dimension: string
    readonly rationale: string
  }[]
  readonly problems: readonly string[]
}

export function auditArchitectureCoverage(
  options?: ArchitectureCoverageAuditOptions,
): Promise<ArchitectureCoverageAuditReport>
