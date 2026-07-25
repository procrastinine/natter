export interface TestEvidenceAuditReport {
  ok: boolean
  structurallyValid: boolean
  counts: {
    files: number
    suites: number
    supportFiles: number
    fixtureFiles: number
    testDefinitions: number
    activeDefinitions: number
    dynamicDefinitions: number
    guaranteeClaims: number
  }
  statusCounts: Readonly<Record<string, number>>
  proofKindCounts: Readonly<Record<string, number>>
  dimensionCounts: Readonly<Record<string, number>>
  domainCounts: Readonly<Record<string, number>>
  gaps: readonly {
    id: string
    status: string
    rationale: string
    missing?: string
  }[]
  parity: {
    nodeVersion: string
    packageManager: string | null
    assertions: readonly { id: string; satisfied: boolean; detail: string }[]
    unavoidableEnvironmentDifferences: readonly string[]
  }
  divergences: {
    discoveredRuntimeGateCount: number
    allowedCount: number
    allowed: readonly {
      id: string
      category: string
      path: string
      locator: string
      rationale: string
    }[]
  }
  problems: readonly string[]
  inventory: TestEvidenceInventory
}

export interface TestEvidenceInventory {
  schemaVersion: number
  generatedFrom: Readonly<Record<string, string>>
  signalDisposition: string
  evidenceDimensions: readonly string[]
  canonicalDomains: readonly string[]
  files: readonly TestEvidenceFile[]
  interactionEvidence: {
    sites: readonly {
      id: string
      path: string
      line: number
      kind: string
      event: string
      element: string
      semanticHooks: readonly string[]
      candidateTests: readonly string[]
    }[]
    siteCount: number
    sourceCount: number
    sourceLevelCandidateCount: number
    perSiteOutcomeProofCount: number
    proofDisposition: string
  }
  guaranteeClaims: readonly TestGuaranteeClaim[]
}

export interface TestEvidenceFile {
  path: string
  role: string
  execution: string
  proofKinds: readonly string[]
  definitions: {
    describes: readonly TestDefinition[]
    tests: readonly TestDefinition[]
  }
  productionOwners: {
    source: string
    modules: readonly string[]
    directOrNearestImportModules: readonly string[]
    exactSourceReferenceModules: readonly string[]
  }
  domains: readonly string[]
  domainSource: string
  layers: readonly string[]
  evidenceSignals: Readonly<Record<string, unknown>>
  dimensionDispositions: Readonly<
    Record<string, { status: 'candidate-signal' | 'not-deterministically-signaled' }>
  >
}

export interface TestDefinition {
  api: string
  title: string
  titleKind: string
  line: number
  status: string
  parameterized: boolean
}

export interface TestGuaranteeClaim {
  id: string
  status: string
  requiredProofKinds: readonly string[]
  rationale: string
  evidence?: readonly TestEvidenceReference[]
  touchedBy?: readonly TestEvidenceReference[]
  missing?: string
}

export interface TestEvidenceReference {
  path: string
  locator: string
}

export function auditTestEvidence(options?: {
  root?: string
  inventory?: TestEvidenceInventory
  declaredDomains?: Readonly<Record<string, readonly string[]>>
  claims?: readonly TestGuaranteeClaim[]
  allowedDivergences?: readonly {
    id: string
    category: string
    path: string
    locator: string
    rationale: string
  }[]
}): TestEvidenceAuditReport
