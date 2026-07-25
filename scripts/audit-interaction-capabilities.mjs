import { readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { staticAuditState } from './audit-result-state.mjs'
import {
  buildInteractionCapabilityInventory,
  interactionOutcomeGraphDigest,
  interactionSiteDigests,
  presentationDefinitionDigest,
} from './interaction-capability-inventory.mjs'
import {
  FORBIDDEN_INTERACTION_GATES,
  INTERACTION_CAPABILITIES,
  INTERACTION_CLASSIFICATION_CLOSURE_CRITERIA,
  INTERACTION_CLASSIFICATION_EXCEPTIONS,
  INTERACTION_CLASSIFICATION_RULES,
  INTERACTION_CONTINUITY_OBLIGATIONS,
  INTERACTION_EFFECT_KINDS,
  INTERACTION_OUTCOME_CONTRACTS,
  INTERACTION_REVIEW_BASELINE,
  INTERACTION_SCANNER_LIMITATIONS,
  INTERACTION_SCOPE_KINDS,
  INTERACTION_SOURCE_CONTRACTS,
  KNOWN_INTERACTION_GATES,
} from './interaction-capability-manifest.mjs'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')

export function auditInteractionCapabilities(options = {}) {
  const root = options.root ?? DEFAULT_ROOT
  const inventory = options.inventory ?? buildInteractionCapabilityInventory(root)
  const problems = []
  const capabilityIds = validateTaxonomy(INTERACTION_CAPABILITIES, 'capabilities', problems)
  const obligationIds = validateTaxonomy(
    INTERACTION_CONTINUITY_OBLIGATIONS,
    'continuity-obligations',
    problems,
  )
  const gateIds = validateKnownGates(root, problems)
  validateForbiddenGates(root, problems)
  const siteById = validateSites({
    inventory,
    capabilityIds,
    obligationIds,
    gateIds,
    problems,
  })
  validateReviewManifest({ inventory, siteById, problems })
  validateOutcomeContractsAndGraph({ root, inventory, siteById, problems })
  validateSourceContracts({ root, inventory, siteById, problems })
  validateQueues(inventory, siteById, problems)
  validateSourceParity(inventory, siteById, problems)
  problems.sort()

  const sites = [...siteById.values()]
  const counts = Object.freeze({
    sites: sites.length,
    sources: new Set(sites.map((site) => site.path)).size,
    reviewedClassifications: sites.filter(
      (site) =>
        site.classificationDisposition === 'reviewed-rule' ||
        site.classificationDisposition === 'reviewed-exception',
    ).length,
    derivedClassifications: sites.filter(
      (site) => site.classificationDisposition === 'derived-unreviewed',
    ).length,
    exactOutcomeProofSites: sites.filter(
      (site) => site.outcomeEvidence?.status === 'claimed-exact-proof',
    ).length,
    sourceContractLifecycleSites: sites.filter(
      (site) => site.lifecycleEvidence?.status === 'claimed-source-contract',
    ).length,
    sourceLevelCandidateSites: sites.filter(
      (site) => (site.outcomeEvidence?.sourceLevelCandidates?.length ?? 0) > 0,
    ).length,
    inheritedAggregateGateSites: sites.filter((site) =>
      site.gates?.inherited?.includes('aggregate-workspace-running-shell-inert'),
    ).length,
    localGateSites: sites.filter((site) => (site.gates?.local?.length ?? 0) > 0).length,
    asyncSites: sites.filter((site) => site.asyncOwnership?.isAsync).length,
    unresolvedAsyncErrorOwnerSites: sites.filter(
      (site) => site.errorOwnership?.reviewDisposition === 'reviewed-static-non-proof',
    ).length,
    structuralFallbackIdentitySites: sites.filter(
      (site) => site.semanticIdentity?.kind === 'structural-fallback',
    ).length,
    classificationGapSites: inventory.classificationGapQueue?.length ?? 0,
    architectureGapSites: inventory.architectureGapQueue?.length ?? 0,
    behavioralOutcomeGapSites: inventory.behavioralOutcomeQueue?.length ?? 0,
    gapSites: inventory.classificationGapQueue?.length ?? 0,
  })

  return Object.freeze({
    structurallyValid: problems.length === 0,
    classificationClosed:
      problems.length === 0 && (inventory.classificationGapQueue?.length ?? 0) === 0,
    behavioralOutcomesClosed:
      problems.length === 0 && (inventory.behavioralOutcomeQueue?.length ?? 0) === 0,
    counts,
    clusters: countBy(sites, (site) => site.architecturalCluster),
    scopes: countBy(sites, (site) => site.scope),
    asyncErrorOwners: countBy(sites, (site) => site.asyncOwnership.errorOwner),
    effects: countMany(sites, (site) => site.effects),
    capabilities: countMany(sites, (site) => site.requiredCapabilities),
    continuityObligations: countMany(sites, (site) => site.continuityObligations),
    classificationGapReasons: countMany(sites, (site) => site.classificationGaps),
    architectureGapReasons: countMany(sites, (site) => site.architectureGaps),
    behavioralOutcomeGapReasons: countMany(sites, (site) => site.outcomeGaps),
    gapReasons: countMany(sites, (site) => site.classificationGaps),
    classificationGapQueue: inventory.classificationGapQueue,
    architectureGapQueue: inventory.architectureGapQueue,
    behavioralOutcomeQueue: inventory.behavioralOutcomeQueue,
    gapQueue: inventory.classificationGapQueue,
    problems: Object.freeze(problems),
    inventory,
  })
}

function validateSites({ inventory, capabilityIds, obligationIds, gateIds, problems }) {
  const siteById = new Map()
  if (!Array.isArray(inventory?.sites)) {
    problems.push('sites: must be an array')
    return siteById
  }
  for (const site of inventory.sites) {
    const prefix = `sites:${site?.id ?? '<missing>'}`
    if (!site?.id || !site.path || !site.line || !site.kind || !site.event || !site.element) {
      problems.push(`${prefix}: exact source identity is incomplete`)
      continue
    }
    if (siteById.has(site.id)) problems.push(`${prefix}: duplicate id`)
    siteById.set(site.id, site)
    if (!site.semanticIdentity?.kind || !site.semanticIdentity?.value) {
      problems.push(`${prefix}: semantic identity is incomplete`)
    }
    if (!site.architecturalCluster) problems.push(`${prefix}: architectural cluster is missing`)
    if (!INTERACTION_SCOPE_KINDS.includes(site.scope)) {
      problems.push(`${prefix}: invalid scope: ${site.scope}`)
    }
    validateKnownValues(
      site.effects,
      new Set(INTERACTION_EFFECT_KINDS),
      `${prefix}:effects`,
      problems,
    )
    validateKnownValues(
      site.requiredCapabilities,
      capabilityIds,
      `${prefix}:capabilities`,
      problems,
    )
    validateKnownValues(site.continuityObligations, obligationIds, `${prefix}:continuity`, problems)
    validateKnownValues(site.gates?.inherited, gateIds, `${prefix}:inherited-gates`, problems, true)
    if (!Array.isArray(site.gates?.local) || !Array.isArray(site.gates?.ancestors)) {
      problems.push(`${prefix}: exact local and ancestor gate arrays are required`)
    }
    if (!site.asyncOwnership?.errorOwner || typeof site.asyncOwnership.isAsync !== 'boolean') {
      problems.push(`${prefix}: async and error ownership is incomplete`)
    }
    if (!site.errorOwnership?.owner || !site.errorOwnership?.reviewDisposition) {
      problems.push(`${prefix}: reviewed error-owner disposition is incomplete`)
    }
    if (!['reviewed-rule', 'reviewed-exception'].includes(site.classificationDisposition)) {
      problems.push(
        `${prefix}: invalid classification disposition: ${site.classificationDisposition}`,
      )
    }
    for (const [label, gaps] of [
      ['classification gaps', site.classificationGaps],
      ['architecture gaps', site.architectureGaps],
      ['outcome gaps', site.outcomeGaps],
    ]) {
      if (!Array.isArray(gaps)) problems.push(`${prefix}: ${label} must be an array`)
    }
    if (!site.reviewDisposition?.exactLocator || !Array.isArray(site.reviewDisposition.ruleIds)) {
      problems.push(`${prefix}: exact review disposition is missing`)
    } else if (site.reviewDisposition.exactLocator !== site.id) {
      problems.push(`${prefix}: review locator does not equal exact site id`)
    }
    if (!site.outcomeEvidence || !Array.isArray(site.outcomeEvidence.proofs)) {
      problems.push(`${prefix}: exact outcome evidence disposition is missing`)
    }
    if (
      site.outcomeEvidence?.status === 'claimed-exact-proof' &&
      site.outcomeEvidence.proofs.length === 0
    ) {
      problems.push(`${prefix}: claimed exact proof has no proof records`)
    }
    if (site.outcomeEvidence?.status === 'gap' && site.outcomeGaps?.length === 0) {
      problems.push(`${prefix}: outcome gap is absent from the behavioral proof queue`)
    }
    if (
      site.outcomeEvidence?.status !== 'gap' &&
      site.outcomeEvidence?.status !== 'claimed-exact-proof'
    ) {
      problems.push(`${prefix}: invalid outcome evidence status: ${site.outcomeEvidence?.status}`)
    }
    if (
      !site.lifecycleEvidence ||
      !['none', 'claimed-source-contract'].includes(site.lifecycleEvidence.status) ||
      !Array.isArray(site.lifecycleEvidence.proofs)
    ) {
      problems.push(`${prefix}: invalid lifecycle evidence disposition`)
    } else if (
      site.lifecycleEvidence.status === 'claimed-source-contract' &&
      site.lifecycleEvidence.proofs.length !== 1
    ) {
      problems.push(`${prefix}: claimed source lifecycle must have one proof record`)
    } else if (
      site.lifecycleEvidence.status === 'none' &&
      site.lifecycleEvidence.proofs.length > 0
    ) {
      problems.push(`${prefix}: absent lifecycle evidence retains proof records`)
    }
    if (site.outcomeEvidence?.candidateDisposition !== undefined) {
      const expected =
        'Source-level candidate tests are discovery hints only and never prove this exact site.'
      if (site.outcomeEvidence.candidateDisposition !== expected) {
        problems.push(`${prefix}: source-level candidates were given a proof disposition`)
      }
    }
  }
  return siteById
}

function validateReviewManifest({ inventory, siteById, problems }) {
  if (inventory?.schemaVersion !== INTERACTION_REVIEW_BASELINE.schemaVersion) {
    problems.push(
      `review-baseline: schema=${inventory?.schemaVersion}; expected=${INTERACTION_REVIEW_BASELINE.schemaVersion}`,
    )
  }
  const baseline = inventory?.reviewBaseline
  if (JSON.stringify(baseline) !== JSON.stringify(INTERACTION_REVIEW_BASELINE)) {
    problems.push('review-baseline: inventory does not expose the canonical reviewed baseline')
  }
  for (const [label, exposed, canonical] of [
    ['classification-rules', inventory?.classificationRules, INTERACTION_CLASSIFICATION_RULES],
    [
      'classification-exceptions',
      inventory?.classificationExceptions,
      INTERACTION_CLASSIFICATION_EXCEPTIONS,
    ],
    ['scanner-limitations', inventory?.scannerLimitations, INTERACTION_SCANNER_LIMITATIONS],
    [
      'classification-closure-criteria',
      inventory?.classificationClosureCriteria,
      INTERACTION_CLASSIFICATION_CLOSURE_CRITERIA,
    ],
  ]) {
    if (JSON.stringify(exposed) !== JSON.stringify(canonical)) {
      problems.push(`${label}: inventory does not expose the canonical manifest records`)
    }
  }
  validateNamedRecords(INTERACTION_SCANNER_LIMITATIONS, 'scanner-limitations', 'boundary', problems)
  validateNamedRecords(
    INTERACTION_CLASSIFICATION_CLOSURE_CRITERIA,
    'classification-closure-criteria',
    'requirement',
    problems,
  )

  const rulesById = new Map()
  for (const rule of INTERACTION_CLASSIFICATION_RULES) {
    const prefix = `classification-rules:${rule?.id ?? '<missing>'}`
    if (!rule?.id || rulesById.has(rule.id)) problems.push(`${prefix}: missing or duplicate id`)
    rulesById.set(rule?.id, rule)
    if (!rule?.architecturalCluster || !rule?.rationale) {
      problems.push(`${prefix}: cluster and rationale are required`)
    }
    if (
      !rule?.match ||
      !Array.isArray(rule.match.paths) ||
      !Array.isArray(rule.match.pathPrefixes) ||
      !Array.isArray(rule.match.excludedPaths) ||
      !Array.isArray(rule.match.excludedPathPrefixes) ||
      rule.match.paths.length + rule.match.pathPrefixes.length === 0
    ) {
      problems.push(`${prefix}: complete non-empty source matcher is required`)
    }
    if (
      rule?.projectionCapability !== null &&
      !INTERACTION_CAPABILITIES.some((capability) => capability.id === rule.projectionCapability)
    ) {
      problems.push(`${prefix}: unknown projection capability: ${rule?.projectionCapability}`)
    }
    if (!Array.isArray(rule?.projectionEffects)) {
      problems.push(`${prefix}: projection effects must be an array`)
    } else {
      validateKnownValues(
        rule.projectionEffects,
        new Set(INTERACTION_EFFECT_KINDS),
        `${prefix}:projection-effects`,
        problems,
        rule.projectionCapability === null,
      )
      if (rule.projectionCapability === null && rule.projectionEffects.length > 0) {
        problems.push(`${prefix}: projection effects require a projection capability`)
      }
    }
  }

  const exceptionsBySite = new Map()
  const exceptionIds = new Set()
  for (const exception of INTERACTION_CLASSIFICATION_EXCEPTIONS) {
    const prefix = `classification-exceptions:${exception?.id ?? '<missing>'}`
    if (!exception?.id || exceptionIds.has(exception.id)) {
      problems.push(`${prefix}: missing or duplicate id`)
    }
    exceptionIds.add(exception?.id)
    if (!exception?.siteId || !siteById.has(exception.siteId)) {
      problems.push(`${prefix}: exact site is missing`)
      continue
    }
    if (exceptionsBySite.has(exception.siteId)) {
      problems.push(`${prefix}: duplicate exact-site exception`)
    }
    exceptionsBySite.set(exception.siteId, exception)
    if (!exception.rationale || !exception.reviewerDisposition) {
      problems.push(`${prefix}: rationale and reviewer disposition are required`)
    }
    if (exception.scope && !INTERACTION_SCOPE_KINDS.includes(exception.scope)) {
      problems.push(`${prefix}: invalid scope: ${exception.scope}`)
    }
    for (const [label, values, known] of [
      ['effects', exception.effects, new Set(INTERACTION_EFFECT_KINDS)],
      [
        'capabilities',
        exception.requiredCapabilities,
        new Set(INTERACTION_CAPABILITIES.map((capability) => capability.id)),
      ],
      [
        'continuity',
        exception.continuityObligations,
        new Set(INTERACTION_CONTINUITY_OBLIGATIONS.map((obligation) => obligation.id)),
      ],
    ]) {
      if (values !== undefined) validateKnownValues(values, known, `${prefix}:${label}`, problems)
    }
    if (
      exception.errorOwnership &&
      (!exception.errorOwnership.owner || !exception.errorOwnership.reviewDisposition)
    ) {
      problems.push(`${prefix}: error ownership override is incomplete`)
    }
  }

  const usedRuleIds = new Set()
  for (const site of siteById.values()) {
    const matchingRules = INTERACTION_CLASSIFICATION_RULES.filter((rule) =>
      interactionRuleMatches(rule, site.path),
    )
    if (matchingRules.length !== 1) {
      problems.push(
        `classification-coverage:${site.id}: matched=${matchingRules.map((rule) => rule.id).join(',') || '<none>'}; expected=1`,
      )
      continue
    }
    const ruleId = matchingRules[0].id
    usedRuleIds.add(ruleId)
    if (JSON.stringify(site.reviewDisposition.ruleIds) !== JSON.stringify([ruleId])) {
      problems.push(`classification-coverage:${site.id}: recorded rule does not match source rule`)
    }
    const exception = exceptionsBySite.get(site.id)
    if ((site.reviewDisposition.exceptionId ?? null) !== (exception?.id ?? null)) {
      problems.push(`classification-coverage:${site.id}: exception disposition mismatch`)
    }
    const expectedDisposition = exception ? 'reviewed-exception' : 'reviewed-rule'
    if (site.classificationDisposition !== expectedDisposition) {
      problems.push(
        `classification-coverage:${site.id}: disposition=${site.classificationDisposition}; expected=${expectedDisposition}`,
      )
    }
    const expectedCluster = exception?.architecturalCluster ?? matchingRules[0].architecturalCluster
    if (site.architecturalCluster !== expectedCluster) {
      problems.push(`classification-coverage:${site.id}: cluster does not match reviewed rule`)
    }
    for (const field of [
      'semanticIdentity',
      'scope',
      'requiredCapabilities',
      'effects',
      'continuityObligations',
      'errorOwnership',
    ]) {
      if (exception?.[field] === undefined) continue
      if (JSON.stringify(site[field]) !== JSON.stringify(exception[field])) {
        problems.push(`classification-coverage:${site.id}: exception ${field} override mismatch`)
      }
    }
    const expectedRationale = exception?.rationale ?? matchingRules[0].rationale
    if (site.reviewDisposition.rationale !== expectedRationale) {
      problems.push(`classification-coverage:${site.id}: review rationale mismatch`)
    }
    if (site.gates.inherited.includes('aggregate-workspace-running-shell-inert')) {
      problems.push(`classification-coverage:${site.id}: inherited forbidden Shell gate`)
    }
    if (
      site.gates.inherited.includes('aggregate-workspace-running-shell-inert') !==
      site.architectureGaps.includes('inherited-aggregate-shell-gate')
    ) {
      problems.push(`classification-coverage:${site.id}: global gate gap disposition mismatch`)
    }
  }
  for (const ruleId of rulesById.keys()) {
    if (!usedRuleIds.has(ruleId)) problems.push(`classification-rules:${ruleId}: stale unused rule`)
  }
}

function validateOutcomeContractsAndGraph({ root, inventory, siteById, problems }) {
  const exposedContracts = inventory?.outcomeContracts
  if (JSON.stringify(exposedContracts) !== JSON.stringify(INTERACTION_OUTCOME_CONTRACTS)) {
    problems.push('outcome-contracts: inventory does not expose the canonical finite contracts')
  }
  const contractsById = new Map()
  for (const contract of INTERACTION_OUTCOME_CONTRACTS) {
    const prefix = `outcome-contracts:${contract?.id ?? '<missing>'}`
    if (!contract?.id || contractsById.has(contract.id)) {
      problems.push(`${prefix}: missing or duplicate id`)
    }
    contractsById.set(contract?.id, contract)
    if (!contract?.outcome || !Array.isArray(contract.evidence) || contract.evidence.length === 0) {
      problems.push(`${prefix}: outcome and evidence are required`)
    }
    for (const evidence of contract?.evidence ?? []) {
      validateEvidenceReference(root, evidence, prefix, problems)
    }
  }

  const graph = inventory?.outcomeGraph
  if (!graph || graph.schemaVersion !== 2) {
    problems.push(`callback-graph: schema=${graph?.schemaVersion ?? '<missing>'}; expected=2`)
    return
  }
  if (!Array.isArray(graph.problems)) {
    problems.push('callback-graph:problems: must be an array')
  } else {
    for (const problem of graph.problems) problems.push(`callback-graph: ${problem}`)
  }
  for (const [label, entries] of [
    ['vertices', graph.vertices],
    ['edges', graph.edges],
    ['terminals', graph.terminals],
    ['components', graph.components],
    ['outcomes', graph.outcomes],
  ]) {
    if (!Array.isArray(entries)) problems.push(`callback-graph:${label}: must be an array`)
  }
  if (
    !Array.isArray(graph.vertices) ||
    !Array.isArray(graph.edges) ||
    !Array.isArray(graph.terminals) ||
    !Array.isArray(graph.components) ||
    !Array.isArray(graph.outcomes)
  ) {
    return
  }

  const verticesById = uniqueRecordsById(graph.vertices, 'callback-graph:vertex', problems)
  const edgesById = uniqueRecordsById(graph.edges, 'callback-graph:edge', problems)
  const edgePairs = new Set([...edgesById.values()].map((edge) => `${edge.from}->${edge.to}`))
  const terminalsById = uniqueRecordsById(graph.terminals, 'callback-graph:terminal', problems)
  const outcomesBySite = new Map()
  const componentByVertex = new Map()
  const componentIds = new Set()
  for (const edge of edgesById.values()) {
    if (!edge?.kind || edge.id !== `${edge.kind}:${edge.from}->${edge.to}`) {
      problems.push(`callback-graph:edge:${edge?.id ?? '<missing>'}: id or kind is invalid`)
    }
    if (!verticesById.has(edge.from) || !verticesById.has(edge.to)) {
      problems.push(`callback-graph:edge:${edge.id}: endpoint is missing`)
    }
  }
  for (const terminal of terminalsById.values()) {
    if (!verticesById.has(terminal.id)) {
      problems.push(`callback-graph:terminal:${terminal.id}: vertex is missing`)
    } else if (JSON.stringify(verticesById.get(terminal.id)) !== JSON.stringify(terminal)) {
      problems.push(`callback-graph:terminal:${terminal.id}: terminal and vertex records diverge`)
    }
    if (!['carrier', 'settlement'].includes(terminal?.role)) {
      problems.push(`callback-graph:terminal:${terminal?.id ?? '<missing>'}: role is invalid`)
    }
  }
  for (const component of graph.components) {
    const prefix = `callback-graph:component:${component?.id ?? '<missing>'}`
    if (!Number.isInteger(component?.id) || !Array.isArray(component.vertexIds)) {
      problems.push(`${prefix}: integer id and vertex ids are required`)
      continue
    }
    if (componentIds.has(component.id)) problems.push(`${prefix}: duplicate id`)
    componentIds.add(component.id)
    if (typeof component.cyclic !== 'boolean') problems.push(`${prefix}: cyclic must be boolean`)
    if (component.vertexIds.length === 0) problems.push(`${prefix}: vertex ids must be non-empty`)
    validateUniqueStrings(component.vertexIds, `${prefix}:vertexIds`, problems)
    if (!Array.isArray(component.terminalIds) || !Array.isArray(component.gapReasons)) {
      problems.push(`${prefix}: terminals and gaps must be arrays`)
      continue
    }
    validateUniqueStrings(component.terminalIds, `${prefix}:terminalIds`, problems)
    validateUniqueStrings(component.gapReasons, `${prefix}:gapReasons`, problems)
    for (const vertexId of component.vertexIds) {
      if (!verticesById.has(vertexId)) problems.push(`${prefix}: vertex is missing: ${vertexId}`)
      if (componentByVertex.has(vertexId)) problems.push(`${prefix}: duplicate vertex: ${vertexId}`)
      componentByVertex.set(vertexId, component.id)
    }
    for (const terminalId of component.terminalIds ?? []) {
      if (!terminalsById.has(terminalId))
        problems.push(`${prefix}: terminal is missing: ${terminalId}`)
    }
  }
  if (
    JSON.stringify([...componentIds].sort((left, right) => left - right)) !==
    JSON.stringify(Array.from({ length: graph.components.length }, (_value, index) => index))
  ) {
    problems.push('callback-graph:component ids must be unique and contiguous')
  }
  for (const vertexId of verticesById.keys()) {
    if (!componentByVertex.has(vertexId)) {
      problems.push(`callback-graph:vertex:${vertexId}: condensed component is missing`)
    }
  }
  const interactionVertexIds = [...verticesById.values()]
    .filter((vertex) => vertex.kind === 'interaction-site')
    .map((vertex) => vertex.id)
  if (!sameStringSet(interactionVertexIds, [...siteById.keys()])) {
    problems.push('callback-graph: interaction-site vertices do not equal audited sites')
  }
  const usedContractIds = new Set()
  for (const outcome of graph.outcomes) {
    const prefix = `callback-graph:outcome:${outcome?.siteId ?? '<missing>'}`
    if (!outcome?.siteId || outcomesBySite.has(outcome.siteId)) {
      problems.push(`${prefix}: missing or duplicate site`)
    }
    outcomesBySite.set(outcome?.siteId, outcome)
    if (!siteById.has(outcome?.siteId)) problems.push(`${prefix}: exact site is missing`)
    if (!contractsById.has(outcome?.contractId)) {
      problems.push(`${prefix}: unknown outcome contract: ${outcome?.contractId}`)
    } else {
      usedContractIds.add(outcome.contractId)
    }
    if (
      !Array.isArray(outcome?.terminalRootIds) ||
      !Array.isArray(outcome?.carrierRootIds) ||
      !Array.isArray(outcome?.settlementRootIds) ||
      !Array.isArray(outcome?.deliveryPath) ||
      !Array.isArray(outcome?.localGapReasons) ||
      !Array.isArray(outcome?.gapReasons)
    ) {
      problems.push(
        `${prefix}: terminal roots, carrier roots, settlement roots, delivery path, local gaps, and gaps are required`,
      )
      continue
    }
    const component = graph.components[componentByVertex.get(outcome.siteId)]
    if (!component) {
      problems.push(`${prefix}: condensed component is missing`)
    } else {
      if (!sameStringSet(outcome.terminalRootIds, component.terminalIds)) {
        problems.push(`${prefix}: terminal roots do not match the condensed component`)
      }
      if (
        !sameStringSet(outcome.gapReasons, [...component.gapReasons, ...outcome.localGapReasons])
      ) {
        problems.push(`${prefix}: gaps do not match the condensed component plus local site gaps`)
      }
    }
    const expectedCarrierRoots = outcome.terminalRootIds.filter(
      (terminalId) => terminalsById.get(terminalId)?.role === 'carrier',
    )
    const expectedSettlementRoots = outcome.terminalRootIds.filter(
      (terminalId) => terminalsById.get(terminalId)?.role === 'settlement',
    )
    if (!sameStringSet(outcome.carrierRootIds, expectedCarrierRoots)) {
      problems.push(`${prefix}: carrier roots do not match typed terminals`)
    }
    if (!sameStringSet(outcome.settlementRootIds, expectedSettlementRoots)) {
      problems.push(`${prefix}: settlement roots do not match typed terminals`)
    }
    for (const terminalId of outcome.terminalRootIds) {
      if (!terminalsById.has(terminalId))
        problems.push(`${prefix}: terminal root is missing: ${terminalId}`)
    }
    if (outcome.deliveryPath[0] !== outcome.siteId) {
      problems.push(`${prefix}: delivery path does not start at the exact site`)
    }
    for (let index = 1; index < outcome.deliveryPath.length; index += 1) {
      const from = outcome.deliveryPath[index - 1]
      const to = outcome.deliveryPath[index]
      if (!edgePairs.has(`${from}->${to}`)) {
        problems.push(`${prefix}: callback graph edge is missing: ${from}->${to}`)
      }
    }
    const pathTerminal = outcome.deliveryPath.at(-1)
    if (
      outcome.gapReasons.length === 0 &&
      (!terminalsById.has(pathTerminal) || !outcome.carrierRootIds.includes(pathTerminal))
    ) {
      problems.push(`${prefix}: delivery path does not end at a carrier root`)
    }
  }
  for (const contractId of contractsById.keys()) {
    if (!usedContractIds.has(contractId)) problems.push(`outcome-contracts:${contractId}: unused`)
  }

  const condensedEdges = new Set(
    [...edgesById.values()].flatMap((edge) => {
      const from = componentByVertex.get(edge.from)
      const to = componentByVertex.get(edge.to)
      return from === undefined || to === undefined || from === to ? [] : [`${from}->${to}`]
    }),
  ).size
  const expectedCounts = {
    vertices: verticesById.size,
    edges: edgesById.size,
    callbackSlots: [...verticesById.values()].filter((vertex) => vertex.kind === 'callback-slot')
      .length,
    terminals: terminalsById.size,
    condensedComponents: graph.components.length,
    condensedEdges,
  }
  if (JSON.stringify(graph.counts) !== JSON.stringify(expectedCounts)) {
    problems.push('callback-graph: counts do not match serialized graph')
  }
  const expectedWork = {
    vertexDiscoveryVisits: verticesById.size,
    edgeDiscoveryVisits: edgesById.size,
    sccVertexVisits: verticesById.size,
    sccEdgeVisits: edgesById.size,
    terminalPropagationEdgeVisits: condensedEdges,
  }
  if (JSON.stringify(graph.work) !== JSON.stringify(expectedWork)) {
    problems.push('callback-graph: work does not match linear graph traversal')
  }

  const recomputedDigest = interactionOutcomeGraphDigest(graph)
  if (graph.digest !== recomputedDigest) {
    problems.push(`callback-graph: digest=${graph.digest}; recomputed=${recomputedDigest}`)
  }
  for (const site of siteById.values()) {
    const prefix = `callback-graph:site:${site.id}`
    const outcome = outcomesBySite.get(site.id)
    if (!outcome) {
      problems.push(`${prefix}: generated outcome is missing`)
      continue
    }
    if (JSON.stringify(site.outcomeGaps) !== JSON.stringify(outcome.gapReasons)) {
      problems.push(`${prefix}: outcome gaps do not match generated graph`)
    }
    if (!Array.isArray(outcome.gapReasons)) continue
    const closed = outcome.gapReasons.length === 0
    const expectedStatus = closed ? 'claimed-exact-proof' : 'gap'
    if (site.outcomeEvidence?.status !== expectedStatus) {
      problems.push(`${prefix}: exact outcome status does not match generated graph`)
    }
    if (!closed) {
      if ((site.outcomeEvidence?.proofs?.length ?? 0) > 0) {
        problems.push(`${prefix}: open outcome retains generated proof records`)
      }
      continue
    }
    const proofs = site.outcomeEvidence?.proofs
    const proof = proofs?.[0]
    if (
      !Array.isArray(proofs) ||
      proofs.length !== 1 ||
      proof?.id !== `generated-outcome:${site.id}` ||
      proof?.contractId !== outcome.contractId ||
      proof?.graphDigest !== graph.digest ||
      JSON.stringify(proof?.terminalRootIds) !== JSON.stringify(outcome.terminalRootIds) ||
      JSON.stringify(proof?.carrierRootIds) !== JSON.stringify(outcome.carrierRootIds) ||
      JSON.stringify(proof?.settlementRootIds) !== JSON.stringify(outcome.settlementRootIds) ||
      JSON.stringify(proof?.deliveryPath) !== JSON.stringify(outcome.deliveryPath)
    ) {
      problems.push(`${prefix}: generated exact proof does not match its callback graph outcome`)
    }
  }
}

function uniqueRecordsById(entries, label, problems) {
  const byId = new Map()
  for (const entry of entries) {
    const prefix = `${label}:${entry?.id ?? '<missing>'}`
    if (!entry?.id || byId.has(entry.id)) problems.push(`${prefix}: missing or duplicate id`)
    byId.set(entry?.id, entry)
  }
  return byId
}

function validateSourceContracts({ root, inventory, siteById, problems }) {
  const contracts = inventory?.sourceContracts
  if (!contracts) {
    problems.push('source-contracts: missing')
    return
  }
  if (JSON.stringify(contracts.manifest) !== JSON.stringify(INTERACTION_SOURCE_CONTRACTS)) {
    problems.push('source-contracts: inventory does not expose the canonical manifest')
  }
  const manifestById = new Map()
  for (const contract of INTERACTION_SOURCE_CONTRACTS) {
    const prefix = `source-contracts:${contract?.id ?? '<missing>'}`
    if (!contract?.id || manifestById.has(contract.id)) {
      problems.push(`${prefix}: missing or duplicate manifest id`)
    }
    manifestById.set(contract?.id, contract)
    if (!contract?.factory?.path || !contract.factory.name) {
      problems.push(`${prefix}: canonical factory is missing`)
    }
    if (!contract?.hook?.path || !contract.hook.name || !contract.hook.runMember) {
      problems.push(`${prefix}: canonical hook/run member is missing`)
    }
    if (!contract?.execution?.path || !contract.execution.name) {
      problems.push(`${prefix}: canonical execution boundary is missing`)
    }
    if (
      !contract?.disposition ||
      !Array.isArray(contract.evidence) ||
      contract.evidence.length === 0
    ) {
      problems.push(`${prefix}: disposition and controller evidence are required`)
    }
    for (const evidence of contract?.evidence ?? []) {
      validateEvidenceReference(root, evidence, prefix, problems)
    }
  }
  if (!manifestById.has(contracts.contractId)) {
    problems.push(`source-contracts: unknown contract id: ${contracts.contractId}`)
  }
  if (!Array.isArray(contracts.problems)) {
    problems.push('source-contracts: compiler problem list is missing')
  } else {
    for (const problem of contracts.problems) problems.push(`source-contracts: ${problem}`)
  }
  for (const [label, entries] of [
    ['definitions', contracts.definitions],
    ['hooks', contracts.hooks],
    ['aliases', contracts.aliases],
    ['invocations', contracts.invocations],
    ['configuration-demands', contracts.configurationDemands],
    ['direct-starts', contracts.directStarts],
    ['direct-controller-starts', contracts.directControllerStarts],
  ]) {
    if (!Array.isArray(entries)) problems.push(`source-contracts:${label}: must be an array`)
  }
  if (
    !Array.isArray(contracts.definitions) ||
    !Array.isArray(contracts.hooks) ||
    !Array.isArray(contracts.invocations)
  ) {
    return
  }
  const definitionsByCapability = new Map()
  const definitionIds = new Set()
  for (const definition of contracts.definitions) {
    const prefix = `source-contracts:definition:${definition?.capabilityId ?? '<missing>'}`
    if (!definition?.id || definitionIds.has(definition.id)) {
      problems.push(`${prefix}: missing or duplicate definition id`)
    }
    if (!definition?.capabilityId || definitionsByCapability.has(definition.capabilityId)) {
      problems.push(`${prefix}: missing or duplicate capability id`)
    }
    definitionIds.add(definition?.id)
    definitionsByCapability.set(definition?.capabilityId, definition)
    if (!['reject', 'replace'].includes(definition?.concurrency)) {
      problems.push(`${prefix}: concurrency must be reject or replace`)
    }
    if (!['presenter', 'workspace-tab'].includes(definition?.lifetime)) {
      problems.push(`${prefix}: lifetime must be presenter or workspace-tab`)
    }
    if (!Array.isArray(definition?.hookIds) || definition.hookIds.length === 0) {
      problems.push(`${prefix}: reverse hook ownership is missing`)
    }
    validateUniqueStrings(definition?.hookIds, `${prefix}:hookIds`, problems)
  }
  const hooksById = new Map()
  for (const hook of contracts.hooks) {
    const prefix = `source-contracts:hook:${hook?.id ?? '<missing>'}`
    if (!hook?.id || hooksById.has(hook.id)) problems.push(`${prefix}: missing or duplicate id`)
    hooksById.set(hook?.id, hook)
    if (!Array.isArray(hook?.capabilityIds) || hook.capabilityIds.length === 0) {
      problems.push(`${prefix}: capability ownership is missing`)
    }
    for (const capabilityId of hook?.capabilityIds ?? []) {
      if (!definitionsByCapability.has(capabilityId)) {
        problems.push(`${prefix}: unknown capability: ${capabilityId}`)
      }
    }
    if (!Array.isArray(hook?.invocationIds) || hook.invocationIds.length === 0) {
      problems.push(`${prefix}: reverse invocation ownership is missing`)
    }
    validateUniqueStrings(hook?.capabilityIds, `${prefix}:capabilityIds`, problems)
    validateUniqueStrings(hook?.invocationIds, `${prefix}:invocationIds`, problems)
  }
  const invocationsById = new Map()
  const aliasesById = new Map()
  for (const alias of contracts.aliases ?? []) {
    const prefix = `source-contracts:alias:${alias?.id ?? '<missing>'}`
    if (!alias?.id || aliasesById.has(alias.id)) problems.push(`${prefix}: missing or duplicate id`)
    aliasesById.set(alias?.id, alias)
    if (!Array.isArray(alias?.hookIds) || alias.hookIds.length === 0) {
      problems.push(`${prefix}: hook ownership is missing`)
    }
    if (!Array.isArray(alias?.capabilityIds) || alias.capabilityIds.length === 0) {
      problems.push(`${prefix}: capability ownership is missing`)
    }
    if (!Array.isArray(alias?.invocationIds) || alias.invocationIds.length === 0) {
      problems.push(`${prefix}: reverse invocation ownership is missing`)
    }
    validateUniqueStrings(alias?.hookIds, `${prefix}:hookIds`, problems)
    validateUniqueStrings(alias?.capabilityIds, `${prefix}:capabilityIds`, problems)
    validateUniqueStrings(alias?.invocationIds, `${prefix}:invocationIds`, problems)
    for (const hookId of alias?.hookIds ?? []) {
      if (!hooksById.has(hookId)) problems.push(`${prefix}: unknown hook: ${hookId}`)
    }
    for (const capabilityId of alias?.capabilityIds ?? []) {
      if (!definitionsByCapability.has(capabilityId)) {
        problems.push(`${prefix}: unknown capability: ${capabilityId}`)
      }
    }
    const aliasHookCapabilities = capabilityIdsForHooks(alias?.hookIds ?? [], hooksById)
    if (!sameStringSet(alias?.capabilityIds, aliasHookCapabilities)) {
      problems.push(`${prefix}: capability ownership does not equal hook ownership`)
    }
  }
  for (const invocation of contracts.invocations) {
    const prefix = `source-contracts:invocation:${invocation?.id ?? '<missing>'}`
    if (!invocation?.id || invocationsById.has(invocation.id)) {
      problems.push(`${prefix}: missing or duplicate id`)
    }
    invocationsById.set(invocation?.id, invocation)
    if (!Array.isArray(invocation?.capabilityIds) || invocation.capabilityIds.length === 0) {
      problems.push(`${prefix}: capability ownership is missing`)
    }
    if (!Array.isArray(invocation?.hookIds) || invocation.hookIds.length === 0) {
      problems.push(`${prefix}: hook ownership is missing`)
    }
    validateUniqueStrings(invocation?.hookIds, `${prefix}:hookIds`, problems)
    validateUniqueStrings(invocation?.capabilityIds, `${prefix}:capabilityIds`, problems)
    validateUniqueStrings(invocation?.aliasIds, `${prefix}:aliasIds`, problems)
    for (const hookId of invocation?.hookIds ?? []) {
      if (!hooksById.has(hookId)) problems.push(`${prefix}: unknown hook: ${hookId}`)
    }
    for (const capabilityId of invocation?.capabilityIds ?? []) {
      if (!definitionsByCapability.has(capabilityId)) {
        problems.push(`${prefix}: unknown capability: ${capabilityId}`)
      }
    }
    for (const aliasId of invocation?.aliasIds ?? []) {
      const alias = aliasesById.get(aliasId)
      if (!alias) problems.push(`${prefix}: unknown run alias: ${aliasId}`)
      else if (!alias.invocationIds.includes(invocation.id)) {
        problems.push(`${prefix}: run alias reverse link is missing: ${aliasId}`)
      }
    }
    const invocationHookCapabilities = capabilityIdsForHooks(invocation?.hookIds ?? [], hooksById)
    if (!sameStringSet(invocation?.capabilityIds, invocationHookCapabilities)) {
      problems.push(`${prefix}: capability ownership does not equal hook ownership`)
    }
    if (!Array.isArray(invocation?.siteIds)) {
      problems.push(`${prefix}: exact site reverse links are missing`)
      continue
    }
    validateUniqueStrings(invocation.siteIds, `${prefix}:siteIds`, problems)
    const expectedSurface =
      invocation.siteIds.length > 0
        ? 'interaction-site'
        : invocation.backgroundOwner?.kind === 'react-effect'
          ? 'react-effect'
          : 'unowned-non-gesture'
    if (invocation.surface !== expectedSurface) {
      problems.push(`${prefix}: surface does not match exact site links`)
    }
    if (invocation.surface === 'unowned-non-gesture') {
      problems.push(`${prefix}: invocation has neither an exact gesture nor a proved effect owner`)
    }
    for (const siteId of invocation.siteIds) {
      const site = siteById.get(siteId)
      if (!site) {
        problems.push(`${prefix}: unknown exact site: ${siteId}`)
      } else if (!site.source.presentationInteraction.invocationIds.includes(invocation.id)) {
        problems.push(`${prefix}: exact site reverse link is not bidirectional: ${siteId}`)
      }
    }
    const expectedSiteIds = [...siteById.values()]
      .filter((site) =>
        site.source?.presentationInteraction?.invocationIds?.includes(invocation.id),
      )
      .map((site) => site.id)
    if (!sameStringSet(invocation.siteIds, expectedSiteIds)) {
      problems.push(`${prefix}: exact site reverse links are not exact`)
    }
  }
  for (const definition of contracts.definitions) {
    const expectedHookIds = contracts.hooks
      .filter((hook) => hook.capabilityIds.includes(definition.capabilityId))
      .map((hook) => hook.id)
    if (!sameStringSet(definition.hookIds, expectedHookIds)) {
      problems.push(
        `source-contracts:definition:${definition.capabilityId}: reverse hook ownership is not exact`,
      )
    }
    for (const hookId of definition.hookIds) {
      const hook = hooksById.get(hookId)
      if (!hook?.capabilityIds.includes(definition.capabilityId)) {
        problems.push(
          `source-contracts:definition:${definition.capabilityId}: invalid hook reverse link: ${hookId}`,
        )
      }
    }
  }
  for (const hook of contracts.hooks) {
    const expectedInvocationIds = contracts.invocations
      .filter((invocation) => invocation.hookIds.includes(hook.id))
      .map((invocation) => invocation.id)
    if (!sameStringSet(hook.invocationIds, expectedInvocationIds)) {
      problems.push(`source-contracts:hook:${hook.id}: reverse invocation ownership is not exact`)
    }
    for (const capabilityId of hook.capabilityIds) {
      if (!definitionsByCapability.get(capabilityId)?.hookIds.includes(hook.id)) {
        problems.push(
          `source-contracts:hook:${hook.id}: definition reverse link is missing: ${capabilityId}`,
        )
      }
    }
    for (const invocationId of hook.invocationIds) {
      const invocation = invocationsById.get(invocationId)
      if (!invocation?.hookIds.includes(hook.id)) {
        problems.push(
          `source-contracts:hook:${hook.id}: invalid invocation reverse link: ${invocationId}`,
        )
      }
    }
  }
  for (const alias of contracts.aliases ?? []) {
    const expectedInvocationIds = contracts.invocations
      .filter((invocation) => invocation.aliasIds.includes(alias.id))
      .map((invocation) => invocation.id)
    if (!sameStringSet(alias.invocationIds, expectedInvocationIds)) {
      problems.push(`source-contracts:alias:${alias.id}: reverse invocation ownership is not exact`)
    }
    for (const invocationId of alias.invocationIds) {
      const invocation = invocationsById.get(invocationId)
      if (!invocation?.aliasIds.includes(alias.id)) {
        problems.push(
          `source-contracts:alias:${alias.id}: invalid invocation reverse link: ${invocationId}`,
        )
      }
      if (
        invocation &&
        (!sameStringSet(alias.hookIds, invocation.hookIds) ||
          !sameStringSet(alias.capabilityIds, invocation.capabilityIds))
      ) {
        problems.push(
          `source-contracts:alias:${alias.id}: ownership does not match linked invocation: ${invocationId}`,
        )
      }
    }
  }
  const configurationDemandsById = new Map()
  for (const demand of contracts.configurationDemands ?? []) {
    const prefix = `source-contracts:configuration-demand:${demand?.id ?? '<missing>'}`
    if (!demand?.id || configurationDemandsById.has(demand.id)) {
      problems.push(`${prefix}: missing or duplicate id`)
    }
    configurationDemandsById.set(demand?.id, demand)
    if (!['demandAfter', 'demandBefore'].includes(demand?.property)) {
      problems.push(`${prefix}: unknown demand property: ${demand?.property}`)
    }
    if (!Array.isArray(demand?.siteIds)) {
      problems.push(`${prefix}: exact site reverse links are missing`)
      continue
    }
    validateUniqueStrings(demand.siteIds, `${prefix}:siteIds`, problems)
    for (const siteId of demand.siteIds) {
      const site = siteById.get(siteId)
      if (!site?.source.configurationDemands.some((entry) => entry.id === demand.id)) {
        problems.push(`${prefix}: invalid exact site reverse link: ${siteId}`)
      } else {
        for (const effect of ['query']) {
          if (!site.effects.includes(effect))
            problems.push(`${prefix}: ${siteId} lacks ${effect} effect`)
        }
        for (const capability of ['configuration-projection', 'repository-read']) {
          if (!site.requiredCapabilities.includes(capability)) {
            problems.push(`${prefix}: ${siteId} lacks ${capability} capability`)
          }
        }
      }
    }
  }
  for (const site of siteById.values()) {
    const source = site.source?.presentationInteraction
    const claimed = site.lifecycleEvidence?.status === 'claimed-source-contract'
    if (source?.totalOwnership !== claimed) {
      problems.push(
        `source-contracts:site:${site.id}: total ownership and lifecycle status diverge`,
      )
    }
    for (const demand of site.source?.configurationDemands ?? []) {
      const canonicalDemand = configurationDemandsById.get(demand.id)
      if (!canonicalDemand?.siteIds.includes(site.id)) {
        problems.push(
          `source-contracts:site:${site.id}: configuration demand reverse link is missing: ${demand.id}`,
        )
      }
      if (canonicalDemand && canonicalDemand.property !== demand.property) {
        problems.push(
          `source-contracts:site:${site.id}: configuration demand property mismatch: ${demand.id}`,
        )
      }
    }
    const sourceInvocationIds = source?.invocationIds ?? []
    const sourceCapabilityIds = source?.capabilityIds ?? []
    validateUniqueStrings(
      sourceInvocationIds,
      `source-contracts:site:${site.id}:invocationIds`,
      problems,
    )
    validateUniqueStrings(
      sourceCapabilityIds,
      `source-contracts:site:${site.id}:capabilityIds`,
      problems,
    )
    const expectedCapabilityIds = [
      ...new Set(
        sourceInvocationIds.flatMap(
          (invocationId) => invocationsById.get(invocationId)?.capabilityIds ?? [],
        ),
      ),
    ]
    if (source?.contractId !== contracts.contractId) {
      problems.push(`source-contracts:site:${site.id}: source contract id mismatch`)
    }
    for (const invocationId of sourceInvocationIds) {
      const invocation = invocationsById.get(invocationId)
      if (!invocation) {
        problems.push(`source-contracts:site:${site.id}: unknown invocation: ${invocationId}`)
      } else if (!invocation.siteIds.includes(site.id)) {
        problems.push(
          `source-contracts:site:${site.id}: invocation reverse link is missing: ${invocationId}`,
        )
      }
    }
    if (!sameStringSet(sourceCapabilityIds, expectedCapabilityIds)) {
      problems.push(`source-contracts:site:${site.id}: capability ownership is not exact`)
    }
    const expectedTotalOwnership =
      sourceInvocationIds.length > 0 &&
      sourceInvocationIds.every(
        (invocationId) => (invocationsById.get(invocationId)?.capabilityIds.length ?? 0) > 0,
      ) &&
      (source?.uncoveredAsyncSignals?.length ?? 0) === 0
    if (source?.totalOwnership !== expectedTotalOwnership) {
      problems.push(`source-contracts:site:${site.id}: total ownership is not derived exactly`)
    }
    if (!claimed) continue
    const prefix = `source-contracts:site:${site.id}`
    const proof = site.lifecycleEvidence.proofs[0]
    if (!source?.totalOwnership || source.contractId !== contracts.contractId) {
      problems.push(`${prefix}: source does not prove total contract ownership`)
    }
    if (
      proof?.kind !== 'source-resolved-run-lifecycle' ||
      proof.contractId !== contracts.contractId ||
      !Array.isArray(proof.capabilityIds) ||
      proof.capabilityIds.length === 0 ||
      !Array.isArray(proof.invocationIds) ||
      proof.invocationIds.length === 0
    ) {
      problems.push(`${prefix}: aggregate proof record is incomplete`)
    }
    if (proof?.id !== `source-contract:${site.id}`) {
      problems.push(`${prefix}: proof id does not identify the exact site`)
    }
    if ((source?.uncoveredAsyncSignals?.length ?? 0) !== 0) {
      problems.push(`${prefix}: total contract retains uncovered async signals`)
    }
    if (JSON.stringify(proof?.capabilityIds) !== JSON.stringify(source?.capabilityIds)) {
      problems.push(`${prefix}: proof capabilities do not match source ownership`)
    }
    if (JSON.stringify(proof?.invocationIds) !== JSON.stringify(source?.invocationIds)) {
      problems.push(`${prefix}: proof invocations do not match source ownership`)
    }
  }
  const manifestHookPath = manifestById.get(contracts.contractId)?.hook.path
  if (
    contracts.directStarts?.length !== 1 ||
    contracts.directStarts[0]?.path !== manifestHookPath
  ) {
    problems.push('source-contracts: execution must have one hook-owned start call and no bypass')
  }
  const manifestExecutionPath = manifestById.get(contracts.contractId)?.execution.path
  if (
    contracts.directControllerStarts?.length !== 1 ||
    contracts.directControllerStarts[0]?.path !== manifestExecutionPath
  ) {
    problems.push(
      'source-contracts: controller start must have one application owner and no bypass',
    )
  }
}

function validateQueues(inventory, siteById, problems) {
  validateSiteQueue({
    queue: inventory?.classificationGapQueue,
    label: 'classification-gap-queue',
    siteById,
    siteValues: (site) => site.classificationGaps,
    queueValues: (entry) => entry.missing,
    problems,
  })
  validateSiteQueue({
    queue: inventory?.architectureGapQueue,
    label: 'architecture-gap-queue',
    siteById,
    siteValues: (site) => site.architectureGaps,
    queueValues: (entry) => entry.gaps,
    problems,
  })
  validateSiteQueue({
    queue: inventory?.behavioralOutcomeQueue,
    label: 'behavioral-outcome-queue',
    siteById,
    siteValues: (site) => site.outcomeGaps,
    queueValues: (entry) => entry.missing,
    problems,
  })
  if (JSON.stringify(inventory?.gapQueue) !== JSON.stringify(inventory?.classificationGapQueue)) {
    problems.push('gap-queue: legacy alias must equal the classification gap queue')
  }
}

function validateSiteQueue({ queue, label, siteById, siteValues, queueValues, problems }) {
  if (!Array.isArray(queue)) {
    problems.push(`${label}: must be an array`)
    return
  }
  const queued = new Map()
  for (const entry of queue) {
    const prefix = `${label}:${entry?.siteId ?? '<missing>'}`
    if (!entry?.siteId || !siteById.has(entry.siteId)) {
      problems.push(`${prefix}: exact site is missing`)
      continue
    }
    if (queued.has(entry.siteId)) problems.push(`${prefix}: duplicate site gap`)
    queued.set(entry.siteId, entry)
    const expected = siteValues(siteById.get(entry.siteId))
    if (JSON.stringify(queueValues(entry)) !== JSON.stringify(expected)) {
      problems.push(`${prefix}: values do not match the exact site record`)
    }
  }
  for (const site of siteById.values()) {
    const values = siteValues(site)
    if (values.length > 0 && !queued.has(site.id))
      problems.push(`${label}:${site.id}: missing site`)
    if (values.length === 0 && queued.has(site.id)) problems.push(`${label}:${site.id}: stale site`)
  }
}

function validateSourceParity(inventory, siteById, problems) {
  const parity = inventory?.sourceParity
  if (!parity) {
    problems.push('source-parity: missing')
    return
  }
  if (parity.baseSiteCount !== parity.discoveredSiteCount) {
    problems.push(
      `source-parity: base=${parity.baseSiteCount}; discovered=${parity.discoveredSiteCount}`,
    )
  }
  if (parity.discoveredSiteCount !== siteById.size) {
    problems.push(`source-parity: recorded=${parity.discoveredSiteCount}; audited=${siteById.size}`)
  }
  const recomputed = interactionSiteDigests([...siteById.values()])
  if (parity.exactSiteIdSha256 !== recomputed.exactSiteIdSha256) {
    problems.push(
      `source-parity: recorded exact-site digest=${parity.exactSiteIdSha256}; recomputed=${recomputed.exactSiteIdSha256}`,
    )
  }
  if (parity.sourceFactSha256 !== recomputed.sourceFactSha256) {
    problems.push(
      `source-parity: recorded source-fact digest=${parity.sourceFactSha256}; recomputed=${recomputed.sourceFactSha256}`,
    )
  }
  const recomputedPresentationDefinitionSha256 = presentationDefinitionDigest(
    inventory?.sourceContracts?.definitions ?? [],
  )
  if (parity.presentationDefinitionSha256 !== recomputedPresentationDefinitionSha256) {
    problems.push(
      `source-parity: recorded presentation-definition digest=${parity.presentationDefinitionSha256}; recomputed=${recomputedPresentationDefinitionSha256}`,
    )
  }
  const outcomeGraph = inventory?.outcomeGraph
  const recomputedInteractionOutcomeSha256 =
    outcomeGraph &&
    Array.isArray(outcomeGraph.vertices) &&
    Array.isArray(outcomeGraph.edges) &&
    Array.isArray(outcomeGraph.terminals) &&
    Array.isArray(outcomeGraph.components) &&
    Array.isArray(outcomeGraph.outcomes)
      ? interactionOutcomeGraphDigest(outcomeGraph)
      : '<invalid>'
  if (parity.interactionOutcomeSha256 !== recomputedInteractionOutcomeSha256) {
    problems.push(
      `source-parity: recorded interaction-outcome digest=${parity.interactionOutcomeSha256}; recomputed=${recomputedInteractionOutcomeSha256}`,
    )
  }
  if (parity.discoveredSiteCount !== INTERACTION_REVIEW_BASELINE.exactSiteCount) {
    problems.push(
      `source-parity: reviewed-sites=${INTERACTION_REVIEW_BASELINE.exactSiteCount}; discovered=${parity.discoveredSiteCount}`,
    )
  }
  const sourceCount = new Set([...siteById.values()].map((site) => site.path)).size
  if (sourceCount !== INTERACTION_REVIEW_BASELINE.sourceCount) {
    problems.push(
      `source-parity: reviewed-sources=${INTERACTION_REVIEW_BASELINE.sourceCount}; discovered=${sourceCount}`,
    )
  }
  if (parity.exactSiteIdSha256 !== INTERACTION_REVIEW_BASELINE.exactSiteIdSha256) {
    problems.push(
      `source-parity: exact-site digest=${parity.exactSiteIdSha256}; reviewed=${INTERACTION_REVIEW_BASELINE.exactSiteIdSha256}`,
    )
  }
  if (parity.sourceFactSha256 !== INTERACTION_REVIEW_BASELINE.sourceFactSha256) {
    problems.push(
      `source-parity: source-fact digest=${parity.sourceFactSha256}; reviewed=${INTERACTION_REVIEW_BASELINE.sourceFactSha256}`,
    )
  }
  if (
    parity.presentationDefinitionSha256 !== INTERACTION_REVIEW_BASELINE.presentationDefinitionSha256
  ) {
    problems.push(
      `source-parity: presentation-definition digest=${parity.presentationDefinitionSha256}; reviewed=${INTERACTION_REVIEW_BASELINE.presentationDefinitionSha256}`,
    )
  }
  if (parity.interactionOutcomeSha256 !== INTERACTION_REVIEW_BASELINE.interactionOutcomeSha256) {
    problems.push(
      `source-parity: interaction-outcome digest=${parity.interactionOutcomeSha256}; reviewed=${INTERACTION_REVIEW_BASELINE.interactionOutcomeSha256}`,
    )
  }
  for (const id of parity.missingSourceMetadata ?? []) {
    problems.push(`source-parity: source metadata missing for ${id}`)
  }
  for (const id of parity.extraSourceMetadata ?? []) {
    problems.push(`source-parity: source metadata has unknown site ${id}`)
  }
}

function validateTaxonomy(entries, label, problems) {
  const ids = new Set()
  if (!Array.isArray(entries) || entries.length === 0) {
    problems.push(`${label}: taxonomy must be a non-empty array`)
    return ids
  }
  for (const entry of entries) {
    if (!entry?.id || ids.has(entry.id))
      problems.push(`${label}: missing or duplicate id: ${entry?.id}`)
    ids.add(entry?.id)
    if (!entry?.rationale) problems.push(`${label}:${entry?.id}: rationale is missing`)
  }
  return ids
}

function validateNamedRecords(entries, label, requiredField, problems) {
  const ids = new Set()
  if (!Array.isArray(entries) || entries.length === 0) {
    problems.push(`${label}: must be a non-empty array`)
    return
  }
  for (const entry of entries) {
    const prefix = `${label}:${entry?.id ?? '<missing>'}`
    if (!entry?.id || ids.has(entry.id)) problems.push(`${prefix}: missing or duplicate id`)
    ids.add(entry?.id)
    if (!entry?.[requiredField]) problems.push(`${prefix}: ${requiredField} is required`)
  }
}

function interactionRuleMatches(rule, path) {
  if (rule.match.excludedPaths.includes(path)) return false
  if (rule.match.excludedPathPrefixes.some((prefix) => path.startsWith(prefix))) return false
  return (
    rule.match.paths.includes(path) ||
    rule.match.pathPrefixes.some((prefix) => path.startsWith(prefix))
  )
}

function validateKnownGates(root, problems) {
  const ids = new Set()
  for (const gate of KNOWN_INTERACTION_GATES) {
    const prefix = `gates:${gate?.id ?? '<missing>'}`
    if (!gate?.id || ids.has(gate.id)) problems.push(`${prefix}: missing or duplicate id`)
    ids.add(gate?.id)
    validateSourceLocator(root, gate, prefix, problems)
    if (!gate?.architecturalDisposition) problems.push(`${prefix}: disposition is missing`)
  }
  return ids
}

function validateForbiddenGates(root, problems) {
  const ids = new Set()
  for (const gate of FORBIDDEN_INTERACTION_GATES) {
    const prefix = `forbidden-gates:${gate?.id ?? '<missing>'}`
    if (!gate?.id || ids.has(gate.id)) problems.push(`${prefix}: missing or duplicate id`)
    ids.add(gate?.id)
    if (!gate?.path || !gate.locator || gate.expectedOccurrences !== 0) {
      problems.push(`${prefix}: path, locator, and zero expected occurrences are required`)
      continue
    }
    const absolutePath = resolve(root, gate.path)
    if (!isRootFile(root, absolutePath)) {
      problems.push(`${prefix}: source path is missing or escapes root: ${gate.path}`)
      continue
    }
    const count = occurrences(readFileSync(absolutePath, 'utf8'), gate.locator)
    if (count !== 0) problems.push(`${prefix}: locator occurrences=${count}; expected=0`)
    if (!gate.architecturalDisposition) problems.push(`${prefix}: disposition is missing`)
  }
}

function validateEvidenceReference(root, evidence, prefix, problems) {
  if (!evidence?.path || !evidence.testLocator || !evidence.assertionLocator) {
    problems.push(`${prefix}: evidence requires path, testLocator, and assertionLocator`)
    return
  }
  const absolutePath = resolve(root, evidence.path)
  if (!isRootFile(root, absolutePath)) {
    problems.push(`${prefix}: evidence path is missing or escapes root: ${evidence.path}`)
    return
  }
  const source = readFileSync(absolutePath, 'utf8')
  for (const [kind, locator] of [
    ['test', evidence.testLocator],
    ['assertion', evidence.assertionLocator],
  ]) {
    const count = occurrences(source, locator)
    if (count !== 1) problems.push(`${prefix}: ${kind} locator occurrences=${count}; expected=1`)
  }
}

function validateSourceLocator(root, record, prefix, problems) {
  if (!record?.path || !record.locator) {
    problems.push(`${prefix}: path and locator are required`)
    return
  }
  const absolutePath = resolve(root, record.path)
  if (!isRootFile(root, absolutePath)) {
    problems.push(`${prefix}: source path is missing or escapes root: ${record.path}`)
    return
  }
  const count = occurrences(readFileSync(absolutePath, 'utf8'), record.locator)
  if (count !== 1) problems.push(`${prefix}: locator occurrences=${count}; expected=1`)
}

function validateKnownValues(values, known, label, problems, allowEmpty = false) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    problems.push(`${label}: must be ${allowEmpty ? 'an' : 'a non-empty'} array`)
    return
  }
  const seen = new Set()
  for (const value of values) {
    if (!known.has(value)) problems.push(`${label}: unknown value: ${value}`)
    if (seen.has(value)) problems.push(`${label}: duplicate value: ${value}`)
    seen.add(value)
  }
}

function capabilityIdsForHooks(hookIds, hooksById) {
  return [...new Set(hookIds.flatMap((hookId) => hooksById.get(hookId)?.capabilityIds ?? []))]
}

function validateUniqueStrings(values, label, problems) {
  if (!Array.isArray(values)) return
  const seen = new Set()
  for (const value of values) {
    if (typeof value !== 'string' || seen.has(value)) {
      problems.push(`${label}: entries must be unique strings`)
      return
    }
    seen.add(value)
  }
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  if (leftSet.size !== left.length || rightSet.size !== right.length) return false
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value))
}

function countBy(values, keyFor) {
  const counts = {}
  for (const value of values) {
    const key = keyFor(value)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return sortedObject(counts)
}

function countMany(values, keysFor) {
  const counts = {}
  for (const value of values) {
    for (const key of keysFor(value)) counts[key] = (counts[key] ?? 0) + 1
  }
  return sortedObject(counts)
}

function sortedObject(value) {
  return Object.freeze(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  )
}

function occurrences(source, needle) {
  return source.split(needle).length - 1
}

function isRootFile(root, absolutePath) {
  const relativePath = relative(root, absolutePath)
  return (
    !relativePath.startsWith('..') &&
    !relativePath.startsWith('/') &&
    statSync(absolutePath, { throwIfNoEntry: false })?.isFile()
  )
}

function parseArgs(argv) {
  const parsed = { mode: 'inventory', json: false, summary: false, inventory: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg === '--summary') {
      parsed.summary = true
      continue
    }
    if (arg !== '--mode' && arg !== '--inventory') {
      throw new Error(`Unknown interaction-capability argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    if (arg === '--mode') {
      if (!['inventory', 'enforce'].includes(value)) {
        throw new Error(`Invalid interaction-capability mode: ${value}`)
      }
      parsed.mode = value
    } else parsed.inventory = resolve(value)
    index += 1
  }
  return parsed
}

function printReport(report, mode) {
  console.log('Interaction capability inventory')
  console.log(`- exact interaction sites: ${report.counts.sites}`)
  console.log(`- production sources: ${report.counts.sources}`)
  console.log(`- reviewed classifications: ${report.counts.reviewedClassifications}`)
  console.log(`- derived classifications awaiting review: ${report.counts.derivedClassifications}`)
  console.log(`- exact outcome-proof sites: ${report.counts.exactOutcomeProofSites}`)
  console.log(
    `- source-contract run-lifecycle sites: ${report.counts.sourceContractLifecycleSites}`,
  )
  console.log(`- source-level candidate-test sites: ${report.counts.sourceLevelCandidateSites}`)
  console.log(
    `- inherited aggregate-shell-gate sites: ${report.counts.inheritedAggregateGateSites}`,
  )
  console.log(`- sites with an exact local disabled/inert gate: ${report.counts.localGateSites}`)
  console.log(`- async sites: ${report.counts.asyncSites}`)
  console.log(
    `- async sites with reviewed non-proof ownership: ${report.counts.unresolvedAsyncErrorOwnerSites}`,
  )
  console.log(`- classification gap sites: ${report.counts.classificationGapSites}`)
  console.log(`- architectural gap sites: ${report.counts.architectureGapSites}`)
  console.log(`- behavioral outcome gap sites: ${report.counts.behavioralOutcomeGapSites}`)
  console.log(`- classification closed: ${report.classificationClosed}`)
  console.log(`- behavioral outcomes closed: ${report.behavioralOutcomesClosed}`)
  console.log(`- clusters: ${JSON.stringify(report.clusters)}`)
  console.log(`- scopes: ${JSON.stringify(report.scopes)}`)
  console.log(`- async error owners: ${JSON.stringify(report.asyncErrorOwners)}`)
  console.log(`- effects: ${JSON.stringify(report.effects)}`)
  console.log(`- capabilities: ${JSON.stringify(report.capabilities)}`)
  console.log(`- continuity obligations: ${JSON.stringify(report.continuityObligations)}`)
  console.log(`- classification gap reasons: ${JSON.stringify(report.classificationGapReasons)}`)
  console.log(`- architecture gap reasons: ${JSON.stringify(report.architectureGapReasons)}`)
  console.log(
    `- behavioral outcome gap reasons: ${JSON.stringify(report.behavioralOutcomeGapReasons)}`,
  )
  console.log(`- mode: ${mode}`)
  if (report.problems.length > 0) {
    console.log('- structural problems:')
    for (const problem of report.problems) console.log(`  - ${problem}`)
  }
}

async function readInventory(path) {
  if (!path) return undefined
  const module = await import(pathToFileURL(path).href)
  if (typeof module.buildInteractionCapabilityInventory === 'function') {
    return module.buildInteractionCapabilityInventory(DEFAULT_ROOT)
  }
  return module.default ?? module.INTERACTION_CAPABILITY_INVENTORY
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = parseArgs(process.argv.slice(2))
  const inventory = await readInventory(args.inventory)
  const report = auditInteractionCapabilities({ inventory })
  const ok =
    report.structurallyValid &&
    (args.mode === 'inventory' || (report.classificationClosed && report.behavioralOutcomesClosed))
  const gaps = [
    ...(report.classificationClosed ? [] : [{ kind: 'classification-open' }]),
    ...(report.behavioralOutcomesClosed ? [] : [{ kind: 'behavioral-outcomes-open' }]),
  ]
  const output = Object.freeze({
    ...report,
    ...staticAuditState({ structurallyValid: report.structurallyValid, gaps }),
    ok,
    mode: args.mode,
  })
  if (args.json) console.log(JSON.stringify(output))
  else if (args.summary) {
    console.log(
      `interaction-capabilities inventory=${output.inventoryComplete} manifest=${output.manifestFresh} classificationClosed=${output.classificationClosed} outcomesClosed=${output.behavioralOutcomesClosed} sites=${output.counts.sites} architectureGaps=${output.counts.architectureGapSites}`,
    )
  } else printReport(output, args.mode)
  if (!ok) process.exitCode = 1
}
