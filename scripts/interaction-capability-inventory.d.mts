export interface PresentationSourceDefinition {
  readonly id: string
  readonly capabilityId: string
  readonly concurrency: string
  readonly lifetime: 'presenter' | 'workspace-tab'
  readonly name: string
  readonly path: string
  readonly hookIds: readonly string[]
}

export interface PresentationSourceHook {
  readonly id: string
  readonly capabilityIds: readonly string[]
  readonly invocationIds: readonly string[]
}

export interface PresentationSourceAlias {
  readonly id: string
  readonly capabilityIds: readonly string[]
  readonly hookIds: readonly string[]
  readonly invocationIds: readonly string[]
}

export interface PresentationSourceInvocation {
  readonly id: string
  readonly aliasIds: readonly string[]
  readonly hookIds: readonly string[]
  readonly capabilityIds: readonly string[]
  readonly siteIds: readonly string[]
  readonly surface: string
  readonly backgroundOwner: { readonly kind: string } | null
}

export interface PresentationSourceContracts {
  readonly contractId: string
  readonly problems: readonly string[]
  readonly definitions: readonly PresentationSourceDefinition[]
  readonly hooks: readonly PresentationSourceHook[]
  readonly aliases: readonly PresentationSourceAlias[]
  readonly invocations: readonly PresentationSourceInvocation[]
  readonly configurationDemands: ReadonlyArray<{
    readonly id: string
    readonly property: string
    readonly siteIds: readonly string[]
  }>
  readonly directStarts: readonly unknown[]
  readonly directControllerStarts: readonly unknown[]
}

export interface InteractionCapabilitySite {
  readonly id: string
  readonly path: string
  readonly line: number
  readonly kind: string
  readonly element: string
  readonly event: string
  readonly architecturalCluster: string
  readonly scope: string
  readonly semanticIdentity: { readonly kind: string; readonly value: string }
  readonly effects: readonly string[]
  readonly requiredCapabilities: readonly string[]
  readonly continuityObligations: readonly string[]
  readonly classificationDisposition: string
  readonly classificationGaps: readonly string[]
  readonly architectureGaps: readonly string[]
  readonly outcomeGaps: readonly string[]
  readonly reviewDisposition: {
    readonly ruleIds: readonly string[]
    readonly exceptionId: string | null
    readonly exactLocator: string
  }
  readonly gates: {
    readonly inherited: readonly string[]
    readonly local: readonly unknown[]
    readonly ancestors: readonly unknown[]
  }
  readonly errorOwnership: { readonly reviewDisposition: string }
  readonly source: {
    readonly calledSymbols: readonly string[]
    readonly configurationDemands: ReadonlyArray<{
      readonly id: string
      readonly property: string
    }>
    readonly presentationInteraction: {
      readonly contractId: string
      readonly totalOwnership: boolean
      readonly capabilityIds: readonly string[]
      readonly invocationIds: readonly string[]
      readonly uncoveredAsyncSignals: readonly string[]
    }
  }
  readonly outcomeEvidence: {
    readonly status: 'gap' | 'claimed-exact-proof'
    readonly proofs: readonly InteractionOutcomeProof[]
  }
  readonly lifecycleEvidence: {
    readonly status: 'none' | 'claimed-source-contract'
    readonly proofs: readonly unknown[]
  }
}

export interface InteractionOutcomeContract {
  readonly id: string
  readonly outcome: string
  readonly evidence: readonly unknown[]
}

export interface InteractionOutcomeProof {
  readonly id: string
  readonly contractId: string
  readonly terminalRootIds: readonly string[]
  readonly carrierRootIds: readonly string[]
  readonly settlementRootIds: readonly string[]
  readonly deliveryPath: readonly string[]
  readonly graphDigest: string
}

export interface InteractionOutcomeGraphVertex {
  readonly id: string
  readonly kind: string
  readonly role?: 'carrier' | 'settlement'
  readonly path: string
  readonly component: string
  readonly event: string
  readonly element: string
  readonly synthetic: boolean
}

export interface InteractionOutcomeGraphEdge {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly kind: string
}

export interface InteractionOutcomeGraphComponent {
  readonly id: number
  readonly vertexIds: readonly string[]
  readonly cyclic: boolean
  readonly terminalIds: readonly string[]
  readonly gapReasons: readonly string[]
}

export interface InteractionOutcomeGraphOutcome {
  readonly siteId: string
  readonly contractId: string
  readonly terminalRootIds: readonly string[]
  readonly carrierRootIds: readonly string[]
  readonly settlementRootIds: readonly string[]
  readonly deliveryPath: readonly string[]
  readonly localGapReasons: readonly string[]
  readonly gapReasons: readonly string[]
}

export interface InteractionOutcomeGraph {
  readonly schemaVersion: 2
  readonly digest: string
  readonly vertices: readonly InteractionOutcomeGraphVertex[]
  readonly edges: readonly InteractionOutcomeGraphEdge[]
  readonly terminals: readonly InteractionOutcomeGraphVertex[]
  readonly components: readonly InteractionOutcomeGraphComponent[]
  readonly outcomes: readonly InteractionOutcomeGraphOutcome[]
  readonly problems: readonly string[]
  readonly counts: {
    readonly vertices: number
    readonly edges: number
    readonly callbackSlots: number
    readonly terminals: number
    readonly condensedComponents: number
    readonly condensedEdges: number
  }
  readonly work: {
    readonly vertexDiscoveryVisits: number
    readonly edgeDiscoveryVisits: number
    readonly sccVertexVisits: number
    readonly sccEdgeVisits: number
    readonly terminalPropagationEdgeVisits: number
  }
}

export interface InteractionCapabilityInventory {
  readonly schemaVersion: number
  readonly reviewBaseline: {
    readonly exactSiteCount: number
    readonly sourceCount: number
    readonly exactSiteIdSha256: string
    readonly sourceFactSha256: string
    readonly presentationDefinitionSha256: string
    readonly interactionOutcomeSha256: string
  }
  readonly classificationRules: ReadonlyArray<{ readonly id: string }>
  readonly classificationExceptions: ReadonlyArray<{ readonly id: string }>
  readonly scannerLimitations: ReadonlyArray<{ readonly id: string; readonly boundary: string }>
  readonly classificationClosureCriteria: ReadonlyArray<{
    readonly id: string
    readonly requirement: string
  }>
  readonly sourceParity: {
    readonly baseSiteCount: number
    readonly discoveredSiteCount: number
    readonly missingSourceMetadata: readonly string[]
    readonly extraSourceMetadata: readonly string[]
    readonly exactSiteIdSha256: string
    readonly sourceFactSha256: string
    readonly presentationDefinitionSha256: string
    readonly interactionOutcomeSha256: string
  }
  readonly taxonomies: {
    readonly knownGates: readonly unknown[]
    readonly forbiddenGates: ReadonlyArray<{
      readonly id: string
      readonly kind: string
      readonly expectedOccurrences: number
    }>
  }
  readonly classificationGapQueue: readonly unknown[]
  readonly architectureGapQueue: readonly unknown[]
  readonly behavioralOutcomeQueue: ReadonlyArray<{
    readonly siteId: string
  }>
  readonly sourceContracts: PresentationSourceContracts
  readonly outcomeContracts: readonly InteractionOutcomeContract[]
  readonly outcomeGraph: InteractionOutcomeGraph
  readonly sites: readonly InteractionCapabilitySite[]
}

export interface InteractionSourceSite {
  readonly id: string
  readonly path: string
  readonly line: number
  readonly kind: string
  readonly event: string
  readonly element: string
}

export function inventoryInteractionSitesInSource(
  path: string,
  source: string,
  typedSourceModel?: unknown,
): readonly InteractionSourceSite[]

export function buildInteractionCapabilityInventory(root?: string): InteractionCapabilityInventory

export function interactionSiteDigests(sites: readonly unknown[]): Readonly<{
  exactSiteIdSha256: string
  sourceFactSha256: string
}>

export function presentationDefinitionDigest(definitions: readonly unknown[]): string

export function interactionOutcomeGraphDigest(graph: InteractionOutcomeGraph): string

export interface PresentationRunFixtureResult {
  readonly line: number
  readonly actionResolved: boolean
  readonly asyncCommit: boolean
  readonly unresolvedCommit: boolean
  readonly opaqueSpread: boolean
  readonly duplicateInput: boolean
}

export function inspectPresentationRunFixtures(
  files: Readonly<Record<string, string>>,
  entryPath?: string,
): readonly PresentationRunFixtureResult[]

export function inspectInteractionCallbackGraphFixtures(
  files: Readonly<Record<string, string>>,
): InteractionOutcomeGraph

export function inspectTotalPromiseConstructionBoundaryFixtures(
  files?: Readonly<Record<string, string>>,
): readonly string[]

export function inspectInteractionGraphAlgorithmFixture(vertexCount: number): Readonly<{
  counts: Readonly<{
    vertices: number
    edges: number
    condensedComponents: number
    condensedEdges: number
  }>
  work: InteractionOutcomeGraph['work']
  terminalRootIds: readonly string[]
  gapReasons: readonly string[]
}>
