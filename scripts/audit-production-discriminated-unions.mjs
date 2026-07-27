import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { staticAuditState } from './audit-result-state.mjs'
import * as defaultInventory from './production-discriminated-union-inventory.mjs'
import { buildProductionProtocolFactBundle } from './production-protocol-fact-bundle.mjs'
import {
  PROTOCOL_CONTRACT_REPORT_ID_LIST,
  PROTOCOL_CONTRACT_REPORT_IDS,
} from './protocol-contract-descriptor.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const PRIMARY_DISCRIMINANT_PRIORITY = Object.freeze([
  'kind',
  'type',
  'operation',
  'objectKind',
  'outcome',
  'status',
  'state',
  'accepted',
  'ok',
  'phase',
  'custody',
  'mode',
  'capability',
  'availability',
  'originDialect',
  'carrier',
  'currency',
  'strategy',
  'task',
  'id',
  'source',
  'surface',
  'attemptKind',
  'ownerKind',
  'childSlot',
])
const PRIMARY_DISCRIMINANT_RANK = new Map(
  PRIMARY_DISCRIMINANT_PRIORITY.map((property, index) => [property, index]),
)

function primaryDiscriminantRank(property) {
  const namedRank = PRIMARY_DISCRIMINANT_RANK.get(property)
  if (namedRank !== undefined) return namedRank
  return /^(?:0|[1-9]\d*)$/u.test(property)
    ? PRIMARY_DISCRIMINANT_PRIORITY.length + Number(property)
    : Number.POSITIVE_INFINITY
}
const ROLES = new Set([
  'backcompat',
  'command',
  'data',
  'event',
  'incidental-finite-property',
  'presentation',
  'query',
  'result',
  'state',
])
const CONTROL_ROLES_BY_DOMAIN = Object.freeze({
  'application-shell': Object.freeze(['state']),
  attachments: Object.freeze(['command']),
  catalog: Object.freeze(['command', 'event']),
  conversation: Object.freeze(['command', 'event', 'presentation', 'query', 'result', 'state']),
  generation: Object.freeze(['command', 'event', 'query', 'result', 'state']),
  'presentation-state': Object.freeze([
    'command',
    'event',
    'presentation',
    'query',
    'result',
    'state',
  ]),
  'presentation-system': Object.freeze([
    'command',
    'event',
    'presentation',
    'query',
    'result',
    'state',
  ]),
  'provider-configuration': Object.freeze(['command', 'event', 'query', 'result', 'state']),
  'provider-io': Object.freeze(['event']),
  'storage-administration': Object.freeze(['command', 'event', 'query', 'result', 'state']),
  workspace: Object.freeze(['command', 'event', 'query', 'result', 'state']),
})
const SEMANTIC_MANIFEST_KEYS = Object.freeze([
  'roleOverrides',
  'controlExclusions',
  'canonicalFamilies',
  'constructionCompositionReviews',
])
const FORBIDDEN_MECHANICAL_KEYS = new Set([
  'aliasReferences',
  'constructorSites',
  'construction',
  'controlProtocol',
  'coverage',
  'declarationKind',
  'domain',
  'exported',
  'path',
  'property',
  'type',
  'variants',
])
const LIMITATIONS = Object.freeze([
  'Role overrides, control exclusions, canonical families, and composition reviews are explicit semantic judgments; source discovery proves their referential and structural validity, not their human rationale.',
  'Unique literal coincidences are retained as scanner diagnostics but never count as typed constructor evidence.',
  'A source-fact capability proves which root an evaluator consumed; the separate architecture-audit gate proves that evaluator remains structurally current.',
])
const AUDIT_CAPABILITY_OWNER_IDS = new Set(
  PROTOCOL_CONTRACT_REPORT_ID_LIST.filter(
    (ownerId) => ownerId !== PROTOCOL_CONTRACT_REPORT_IDS.unions,
  ),
)

export function buildProductionDiscriminatedUnionInventory(options = {}) {
  const root = options.root ?? ROOT
  const factBundle =
    options.factBundle ??
    (options.discovered === undefined || options.auditCapabilities === undefined
      ? buildProductionProtocolFactBundle()
      : null)
  return validateProductionDiscriminatedUnionInventory({
    schemaVersion: options.schemaVersion ?? defaultInventory.UNION_INVENTORY_SCHEMA_VERSION,
    semanticManifest:
      options.semanticManifest ?? defaultInventory.PRODUCTION_DISCRIMINATED_UNION_SEMANTICS,
    discovered: options.discovered ?? factBundle.unionDiscovery,
    moduleInventory:
      options.moduleInventory ??
      JSON.parse(readFileSync(resolve(root, 'scripts/production-module-inventory.json'), 'utf8')),
    auditCapabilities: options.auditCapabilities ?? factBundle.auditCapabilities,
  })
}

export function evaluateProductionDiscriminatedUnionInventory(inventory, mode = 'inventory') {
  const gaps = [...inventory.gaps, ...inventory.constructionGaps]
  const structurallyValid = inventory.ok
  return Object.freeze({
    ...inventory,
    mode,
    ok: structurallyValid && (mode !== 'enforce' || gaps.length === 0),
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps }),
  })
}

export function validateProductionDiscriminatedUnionInventory({
  schemaVersion,
  semanticManifest,
  discovered,
  moduleInventory,
  auditCapabilities,
  initialViolations = [],
}) {
  const violations = Array.isArray(initialViolations) ? [...initialViolations] : []
  if (!Array.isArray(initialViolations)) violations.push('initial violations: expected array')
  if (schemaVersion !== 2) {
    violations.push(`schema version: expected 2, found ${format(schemaVersion)}`)
  }
  const unions = Array.isArray(discovered?.unions) ? discovered.unions : []
  if (!Array.isArray(discovered?.unions)) violations.push('discovery: unions must be an array')
  const unionById = uniqueMap(unions, 'discovered union', violations)
  const domainsByPath = moduleDomains(moduleInventory, violations)
  const { primaryIds } = derivePrimaryDiscriminants(unions, violations)
  const manifest = validateSemanticManifest(semanticManifest, unionById, primaryIds, violations)
  const roleOverrides = manifest.roleOverrides
  const controlExclusions = manifest.controlExclusions
  const capabilityInventory = validateAuditCapabilities(auditCapabilities, violations)
  const dedicatedAuditLinks = capabilityInventory.byRoot
  const familyMemberRoot = validateCanonicalFamilies(
    manifest.canonicalFamilies,
    unionById,
    primaryIds,
    violations,
  )
  const derivationEdges = buildDerivationGraph(
    unions,
    unionById,
    familyMemberRoot,
    new Set(manifest.canonicalFamilies.map((entry) => entry.rootId)),
  )
  const classifications = []

  for (const union of unions) {
    const domain = domainsByPath.get(union.path)
    if (!domain) violations.push(`${union.id}: production module domain is missing`)
    const primary = primaryIds.has(union.id)
    const inferredRole = inferUnionRole(union, primaryIds)
    const role = roleOverrides.get(union.id)?.role ?? inferredRole
    if (!ROLES.has(role)) {
      violations.push(`${union.id}: role inference is unresolved`)
    }
    const ordinarilyControl = isControlRole(role, domain)
    const excluded = controlExclusions.has(union.id)
    const controlProtocol = ordinarilyControl && !excluded
    const roots = canonicalRootsFor(union.id, derivationEdges, violations)
    if (roots.length > 1) {
      violations.push(`${union.id}: canonical roots are ambiguous: ${roots.join(', ')}`)
    }
    const canonicalRootControl =
      roots.length === 1 && roots[0] !== union.id
        ? isClassifiedControlRoot({
            id: roots[0],
            unionById,
            domainsByPath,
            primaryIds,
            roleOverrides,
            controlExclusions,
          })
        : false
    const construction = classifyConstruction({
      union,
      primary,
      control: controlProtocol,
      canonicalRoots: roots,
      compositionReview: manifest.constructionCompositionReviews.get(union.id),
    })
    const coverage = classifyCoverage({
      union,
      control: controlProtocol,
      canonicalRoots: roots,
      canonicalRootControl,
      dedicatedAudit: dedicatedAuditLinks.get(union.id),
    })
    classifications.push(
      Object.freeze({
        ...union,
        domain,
        primary,
        role,
        controlProtocol,
        canonicalRoots: Object.freeze(roots),
        construction: Object.freeze(construction),
        coverage: Object.freeze(coverage),
      }),
    )
  }

  const classificationById = new Map(classifications.map((entry) => [entry.id, entry]))
  validateRoleOverrides(roleOverrides, classificationById, primaryIds, violations)
  validateControlExclusions(controlExclusions, classificationById, primaryIds, violations)
  validateDedicatedAudits(dedicatedAuditLinks, classificationById, violations)
  validateCompositionReviews(
    manifest.constructionCompositionReviews,
    classificationById,
    violations,
  )

  const gaps = classifications
    .filter((entry) => entry.coverage.status === 'gap')
    .map((entry) => ({ id: entry.id, rationale: entry.coverage.rationale }))
    .sort((left, right) => left.id.localeCompare(right.id))
  const constructionGaps = classifications
    .filter((entry) => entry.construction.status === 'gap')
    .map((entry) => ({ id: entry.id, rationale: entry.construction.rationale }))
    .sort((left, right) => left.id.localeCompare(right.id))
  violations.sort()
  return Object.freeze({
    ok: violations.length === 0,
    sourceFiles: discovered?.sourceFiles ?? 0,
    discoveredCount: unions.length,
    classifiedCount: classifications.length,
    controlProtocolCount: classifications.filter((entry) => entry.controlProtocol).length,
    auditCapabilityCount: capabilityInventory.capabilities.length,
    dedicatedAuditRootCount: dedicatedAuditLinks.size,
    typedConstructorSiteCount: classifications.reduce(
      (total, entry) => total + typedConstructorSites(entry).length,
      0,
    ),
    heuristicConstructorSiteCount: classifications.reduce(
      (total, entry) =>
        total +
        entry.constructorSites.filter((site) => site.confidence === 'unique-literal').length,
      0,
    ),
    gapCount: gaps.length,
    constructionGapCount: constructionGaps.length,
    roleCounts: countBy(classifications, (entry) => entry.role),
    constructionCounts: countBy(classifications, (entry) => entry.construction.status),
    declarationKindCounts: countBy(classifications, (entry) => entry.declarationKind),
    coverageCounts: countBy(classifications, (entry) => entry.coverage.status),
    domainCounts: countBy(classifications, (entry) => entry.domain),
    gaps: Object.freeze(gaps),
    constructionGaps: Object.freeze(constructionGaps),
    entries: Object.freeze(classifications),
    auditCapabilities: capabilityInventory.capabilities,
    limitations: LIMITATIONS,
    violations: Object.freeze(violations),
  })
}

export function derivePrimaryDiscriminants(unions, violations) {
  const byType = new Map()
  for (const union of unions) {
    const key = `${union.path}#${union.type}`
    const group = byType.get(key) ?? []
    group.push(union)
    byType.set(key, group)
  }
  const primaryIds = new Set()
  for (const [typeKey, group] of byType) {
    const ranked = [...group].sort(
      (left, right) =>
        primaryDiscriminantRank(left.property) - primaryDiscriminantRank(right.property) ||
        left.property.localeCompare(right.property),
    )
    const firstRank = primaryDiscriminantRank(ranked[0].property)
    if (group.length > 1 && firstRank === Number.POSITIVE_INFINITY) {
      violations.push(
        `${typeKey}: primary discriminant is ambiguous: ${group
          .map((entry) => entry.property)
          .sort()
          .join(', ')}`,
      )
      continue
    }
    primaryIds.add(ranked[0].id)
  }
  return { primaryIds }
}

export function inferUnionRole(union, primaryIds) {
  if (union.path.startsWith('src/backcompat/')) return 'backcompat'
  if (!primaryIds.has(union.id)) return 'incidental-finite-property'
  const name = union.type.replace(/V\d+$/u, '')
  if (union.path.startsWith('src/ui/chat/ScrollRegion')) return 'presentation'
  if (union.path.startsWith('src/ui/') && /(Submission|Outcome)$/u.test(name)) return 'result'
  if (union.path.startsWith('src/ui/')) return 'presentation'
  if (/^Prepared.*Command$/u.test(name) || /^Revalidated.*Target$/u.test(name)) return 'result'
  if (/ResultMutation$/u.test(name)) return 'event'
  if (
    /(Command(?:Union)?|Mutation|Intent|Requirement|Claim|Start|Options|Input|Directive|Request)$/u.test(
      name,
    )
  ) {
    return 'command'
  }
  if (
    /(Event|Effect|Message|Update|Change|Dependency|Fact|Chunk|RetryPayload|Ingress)$/u.test(name)
  ) {
    return 'event'
  }
  if (/(Query|Lookup|Probe)$/u.test(name) || /(Proof|Capability|Query)Target$/u.test(name)) {
    return 'query'
  }
  if (
    /(Result(?:Union)?|Outcome|Decision|Receipt|Read|Page|Preparation|Submission|Resolution|Delivery|Shape|Begin|Reduction|Validation|Failure|Revalidation|Projection|Application|Attempt|Compilation|Observation)$/u.test(
      name,
    )
  ) {
    return 'result'
  }
  if (
    /(State|Slot|Installation|Retention|Surface|Binding|Capability|Lease|Progress|Custody|Epoch|Hint|Fill|Route|Phase|Selection|Plan|Journal|Target|PermitRecord|Availability|Authority|Record)$/u.test(
      name,
    ) ||
    name.includes('StreamLease')
  ) {
    return 'state'
  }
  if (
    /(Point|Baseline|MetadataRow|Context|Step|Tree|Evidence|Row|Item|Artifact|Storage|Identity|Scope|Part|Envelope|Annotation|Format|Execution|Node|Owner|Source|Contract|Descriptor|Payload|Unit|Alias|Policy|Expression|Token|Visibility|Ref|Container|Carrier)$/u.test(
      name,
    )
  ) {
    return 'data'
  }
  if (name.endsWith('Transition')) return 'state'
  return null
}

function validateSemanticManifest(manifest, unionById, primaryIds, violations) {
  if (!isRecord(manifest)) {
    violations.push('semantic manifest: expected object')
    manifest = {}
  }
  validateExactKeys(manifest, SEMANTIC_MANIFEST_KEYS, 'semantic manifest', violations)
  rejectMechanicalKeys(manifest, 'semantic manifest', violations)
  const roleOverrides = indexedEntries(
    manifest.roleOverrides,
    'role overrides',
    ['id', 'role'],
    unionById,
    violations,
  )
  const controlExclusions = indexedEntries(
    manifest.controlExclusions,
    'control exclusions',
    ['id', 'rationale'],
    unionById,
    violations,
  )
  const constructionCompositionReviews = indexedEntries(
    manifest.constructionCompositionReviews,
    'construction composition reviews',
    ['id', 'rationale'],
    unionById,
    violations,
  )
  const canonicalFamilies = Array.isArray(manifest.canonicalFamilies)
    ? manifest.canonicalFamilies
    : []
  if (!Array.isArray(manifest.canonicalFamilies)) {
    violations.push('canonical families: expected array')
  }
  for (const [index, entry] of canonicalFamilies.entries()) {
    if (!isRecord(entry)) {
      violations.push(`canonical families:${index}: expected object`)
      continue
    }
    validateExactKeys(entry, ['derivedId', 'rootId'], `canonical families:${index}`, violations)
    rejectMechanicalKeys(entry, `canonical families:${index}`, violations)
  }
  for (const entry of roleOverrides.values()) {
    if (!primaryIds.has(entry.id)) violations.push(`role overrides: non-primary ${entry.id}`)
  }
  return {
    roleOverrides,
    controlExclusions,
    canonicalFamilies,
    constructionCompositionReviews,
  }
}

function validateCanonicalFamilies(entries, unionById, primaryIds, violations) {
  const memberRoot = new Map()
  const roots = new Set()
  for (const [index, entry] of entries.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry.derivedId !== 'string' ||
      typeof entry.rootId !== 'string'
    ) {
      violations.push(`canonical families:${index}: derivedId and rootId are required`)
      continue
    }
    if (!unionById.has(entry.rootId))
      violations.push(`canonical family: missing root ${entry.rootId}`)
    if (!unionById.has(entry.derivedId)) {
      violations.push(`canonical family: missing member ${entry.derivedId}`)
    }
    if (!primaryIds.has(entry.rootId))
      violations.push(`canonical family: non-primary root ${entry.rootId}`)
    if (!primaryIds.has(entry.derivedId)) {
      violations.push(`canonical family: non-primary member ${entry.derivedId}`)
    }
    if (entry.derivedId === entry.rootId)
      violations.push(`canonical family: self edge ${entry.rootId}`)
    if (memberRoot.has(entry.derivedId)) {
      violations.push(`canonical family: duplicate member ${entry.derivedId}`)
    }
    memberRoot.set(entry.derivedId, entry.rootId)
    roots.add(entry.rootId)
    const root = unionById.get(entry.rootId)
    const member = unionById.get(entry.derivedId)
    if (root && member) {
      for (const variant of member.variants) {
        if (!root.variants.includes(variant)) {
          violations.push(
            `canonical family: ${entry.derivedId} variant ${variant} is absent from ${entry.rootId}`,
          )
        }
      }
    }
  }
  for (const root of roots) {
    if (memberRoot.has(root)) violations.push(`canonical family: root is also a member ${root}`)
  }
  return memberRoot
}

function buildDerivationGraph(unions, unionById, explicitMemberRoot, explicitRootIds) {
  const edges = new Map()
  for (const union of unions) {
    const explicitRoot = explicitMemberRoot.get(union.id)
    if (explicitRoot) {
      edges.set(union.id, [explicitRoot])
      continue
    }
    if (explicitRootIds.has(union.id) || union.declarationKind !== 'resolved-alias') continue
    const targets = union.aliasReferences
      .map((reference) => unionById.get(`${reference}|${union.property}`))
      .filter((target) => target !== undefined)
      .map((target) => target.id)
    if (targets.length > 0) edges.set(union.id, [...new Set(targets)].sort())
  }
  return edges
}

function canonicalRootsFor(id, edges, violations, trail = []) {
  if (trail.includes(id)) {
    violations.push(`canonical family cycle: ${[...trail, id].join(' -> ')}`)
    return []
  }
  const targets = edges.get(id)
  if (!targets || targets.length === 0) return [id]
  return [
    ...new Set(
      targets.flatMap((target) => canonicalRootsFor(target, edges, violations, [...trail, id])),
    ),
  ].sort()
}

function classifyCoverage({
  union,
  control,
  canonicalRoots,
  canonicalRootControl,
  dedicatedAudit,
}) {
  if (!control) return { status: 'not-control', auditOwners: Object.freeze([]) }
  if (canonicalRoots.length === 1 && canonicalRoots[0] !== union.id && canonicalRootControl) {
    return {
      status: 'derived',
      roots: Object.freeze(canonicalRoots),
      auditOwners: Object.freeze([]),
    }
  }
  if (dedicatedAudit) {
    return {
      status: 'dedicated',
      auditOwners: Object.freeze([...dedicatedAudit.auditOwners]),
    }
  }
  return {
    status: 'gap',
    rationale:
      canonicalRoots.length === 1 && canonicalRoots[0] !== union.id
        ? `Control union ${union.id} derives only from non-control root ${canonicalRoots[0]}.`
        : `Control root ${union.id} has no exact dedicated audit.`,
    auditOwners: Object.freeze([]),
  }
}

function isClassifiedControlRoot({
  id,
  unionById,
  domainsByPath,
  primaryIds,
  roleOverrides,
  controlExclusions,
}) {
  const union = unionById.get(id)
  if (!union) return false
  const role = roleOverrides.get(id)?.role ?? inferUnionRole(union, primaryIds)
  return isControlRole(role, domainsByPath.get(union.path)) && !controlExclusions.has(id)
}

function classifyConstruction({ union, primary, control, canonicalRoots, compositionReview }) {
  const typedSites = typedConstructorSites(union)
  const heuristicSiteCount = union.constructorSites.length - typedSites.length
  if (typedSites.length > 0) {
    return {
      status: 'direct-observed',
      constructorCount: typedSites.length,
      heuristicSiteCount,
    }
  }
  if (
    union.declarationKind === 'resolved-alias' &&
    canonicalRoots.length === 1 &&
    canonicalRoots[0] !== union.id
  ) {
    return { status: 'alias-derived', heuristicSiteCount }
  }
  if (!primary) return { status: 'composition-derived', heuristicSiteCount }
  if (compositionReview) {
    return {
      status: 'composition-derived',
      rationale: compositionReview.rationale,
      heuristicSiteCount,
    }
  }
  if (!control) return { status: 'boundary-or-value-derived', heuristicSiteCount }
  return {
    status: 'gap',
    rationale:
      heuristicSiteCount > 0
        ? `Control root ${union.id} has only ${heuristicSiteCount} coincident literal site(s), not typed constructor evidence.`
        : `Control root ${union.id} has no typed constructor evidence.`,
  }
}

function typedConstructorSites(union) {
  return union.constructorSites.filter((site) => site.confidence === 'type-assignable')
}

function validateAuditCapabilities(value, violations) {
  const capabilities = []
  const byRoot = new Map()
  if (!Array.isArray(value)) {
    violations.push('audit capabilities: expected array')
    return { capabilities: Object.freeze(capabilities), byRoot }
  }

  const ownerIds = new Set()
  for (const [index, capability] of value.entries()) {
    const localViolations = []
    const label = `audit capabilities:${index}`
    if (!isRecord(capability)) {
      violations.push(`${label}: expected object`)
      continue
    }
    validateExactKeys(capability, ['ownerId', 'roots'], label, localViolations)
    if (!nonEmpty(capability.ownerId)) {
      localViolations.push(`${label}: ownerId must be a nonempty string`)
    } else if (!AUDIT_CAPABILITY_OWNER_IDS.has(capability.ownerId)) {
      localViolations.push(`${label}: unknown ownerId ${capability.ownerId}`)
    } else if (ownerIds.has(capability.ownerId)) {
      localViolations.push(`${label}: duplicate ownerId ${capability.ownerId}`)
    }
    if (typeof capability.ownerId === 'string') ownerIds.add(capability.ownerId)

    const normalizedRoots = []
    const rootNames = new Set()
    const rootIds = new Set()
    if (!Array.isArray(capability.roots)) {
      localViolations.push(`${label}: roots must be an array`)
    } else if (capability.roots.length === 0) {
      localViolations.push(`${label}: roots must not be empty`)
    } else {
      for (const [rootIndex, root] of capability.roots.entries()) {
        const rootLabel = `${label}:roots:${rootIndex}`
        if (!isRecord(root)) {
          localViolations.push(`${rootLabel}: expected object`)
          continue
        }
        validateExactKeys(root, ['name', 'id'], rootLabel, localViolations)
        if (!nonEmpty(root.name)) {
          localViolations.push(`${rootLabel}: name must be a nonempty string`)
        } else if (rootNames.has(root.name)) {
          localViolations.push(`${rootLabel}: duplicate name ${root.name}`)
        }
        if (!nonEmpty(root.id)) {
          localViolations.push(`${rootLabel}: id must be a nonempty string`)
        } else if (rootIds.has(root.id)) {
          localViolations.push(`${rootLabel}: duplicate id ${root.id}`)
        }
        if (typeof root.name === 'string') rootNames.add(root.name)
        if (typeof root.id === 'string') rootIds.add(root.id)
        if (nonEmpty(root.name) && nonEmpty(root.id)) {
          normalizedRoots.push(Object.freeze({ name: root.name, id: root.id }))
        }
      }
    }

    violations.push(...localViolations)
    if (localViolations.length > 0) continue
    capabilities.push(
      Object.freeze({
        ownerId: capability.ownerId,
        roots: Object.freeze(normalizedRoots),
      }),
    )
  }

  capabilities.sort((left, right) => left.ownerId.localeCompare(right.ownerId))
  for (const capability of capabilities) {
    for (const root of capability.roots) {
      const existing = byRoot.get(root.id) ?? { auditOwners: [] }
      existing.auditOwners.push(capability.ownerId)
      byRoot.set(root.id, existing)
    }
  }
  for (const [id, entry] of byRoot) {
    byRoot.set(id, Object.freeze({ auditOwners: Object.freeze([...entry.auditOwners].sort()) }))
  }
  return { capabilities: Object.freeze(capabilities), byRoot }
}

function validateRoleOverrides(overrides, classifications, primaryIds, violations) {
  for (const entry of overrides.values()) {
    if (!ROLES.has(entry.role))
      violations.push(`${entry.id}: invalid role override ${format(entry.role)}`)
    if (!primaryIds.has(entry.id))
      violations.push(`${entry.id}: role override must target a primary discriminant`)
    if (!classifications.has(entry.id)) violations.push(`${entry.id}: stale role override`)
  }
}

function validateControlExclusions(exclusions, classifications, primaryIds, violations) {
  for (const entry of exclusions.values()) {
    const classification = classifications.get(entry.id)
    if (!classification) continue
    if (!primaryIds.has(entry.id)) violations.push(`${entry.id}: control exclusion must be primary`)
    if (!nonEmpty(entry.rationale))
      violations.push(`${entry.id}: control exclusion needs rationale`)
    if (!isControlRole(classification.role, classification.domain)) {
      violations.push(`${entry.id}: control exclusion does not exclude an inferred control`)
    }
  }
}

function validateDedicatedAudits(entries, classifications, violations) {
  for (const [id, entry] of entries) {
    const classification = classifications.get(id)
    if (!classification) {
      violations.push(`${id}: audit capability names a stale union root`)
      continue
    }
    if (!classification.primary)
      violations.push(`${id}: dedicated audit must target a primary discriminant`)
    if (!classification.controlProtocol)
      violations.push(`${id}: non-control union cannot claim dedicated coverage`)
    if (classification.canonicalRoots.length !== 1 || classification.canonicalRoots[0] !== id) {
      violations.push(`${id}: derived union cannot claim separate dedicated coverage`)
    }
    if (entry.auditOwners.length === 0)
      violations.push(`${id}: dedicated audit capability has no owner`)
  }
}

function validateCompositionReviews(entries, classifications, violations) {
  for (const [id, entry] of entries) {
    const classification = classifications.get(id)
    if (!classification) continue
    if (!nonEmpty(entry.rationale)) violations.push(`${id}: composition review needs rationale`)
    if (
      classification.declarationKind !== 'declared-union' ||
      typedConstructorSites(classification).length > 0 ||
      !classification.primary ||
      !classification.controlProtocol
    ) {
      violations.push(`${id}: composition review does not describe a constructor-free control root`)
    }
  }
}

function indexedEntries(value, label, allowedKeys, unionById, violations) {
  const result = new Map()
  if (!Array.isArray(value)) {
    violations.push(`${label}: expected array`)
    return result
  }
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || typeof entry.id !== 'string') {
      violations.push(`${label}:${index}: string id is required`)
      continue
    }
    validateExactKeys(entry, allowedKeys, `${label}:${entry.id}`, violations)
    rejectMechanicalKeys(entry, `${label}:${entry.id}`, violations)
    if (result.has(entry.id)) violations.push(`${label}: duplicate ${entry.id}`)
    else result.set(entry.id, entry)
    if (!unionById.has(entry.id)) violations.push(`${label}: stale ${entry.id}`)
  }
  return result
}

function validateExactKeys(value, allowedKeys, label, violations) {
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) violations.push(`${label}: unsupported key ${key}`)
  }
  for (const key of allowedKeys) {
    if (!(key in value)) violations.push(`${label}: missing key ${key}`)
  }
}

function rejectMechanicalKeys(value, label, violations) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_MECHANICAL_KEYS.has(key)) {
      violations.push(`${label}: mechanical field ${key} must be source-derived`)
    }
  }
}

function moduleDomains(inventory, violations) {
  const result = new Map()
  for (const classification of inventory?.classifications ?? []) {
    for (const path of classification.paths ?? []) {
      if (result.has(path)) violations.push(`module domains: duplicate ${path}`)
      result.set(path, classification.domain)
    }
  }
  return result
}

function isControlRole(role, domain) {
  return CONTROL_ROLES_BY_DOMAIN[domain]?.includes(role) ?? false
}

function uniqueMap(items, label, violations) {
  const result = new Map()
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== 'string') {
      violations.push(`${label}: entry missing string id`)
      continue
    }
    if (result.has(item.id)) violations.push(`${label}: duplicate ${item.id}`)
    else result.set(item.id, item)
  }
  return result
}

function countBy(items, keyOf) {
  const counts = new Map()
  for (const item of items) {
    const key = keyOf(item)
    if (typeof key !== 'string') continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)))
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function format(value) {
  return JSON.stringify(value)
}

function parseArgs(argv) {
  const parsed = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    throw new Error(`Unknown union-audit argument: ${arg}`)
  }
  return parsed
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2))
  const report = buildProductionDiscriminatedUnionInventory({
    schemaVersion: defaultInventory.UNION_INVENTORY_SCHEMA_VERSION,
    semanticManifest: defaultInventory.PRODUCTION_DISCRIMINATED_UNION_SEMANTICS,
  })
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(
      `Production discriminated unions: discovered=${report.discoveredCount}, control=${report.controlProtocolCount}, dedicated=${report.coverageCounts.dedicated ?? 0}, derived=${report.coverageCounts.derived ?? 0}, gaps=${report.gapCount}, construction-gaps=${report.constructionGapCount}.\n`,
    )
    for (const gap of report.gaps) process.stdout.write(`  gap ${gap.id}: ${gap.rationale}\n`)
    for (const gap of report.constructionGaps) {
      process.stdout.write(`  construction-gap ${gap.id}: ${gap.rationale}\n`)
    }
    for (const violation of report.violations) process.stderr.write(`  ${violation}\n`)
  }
  if (!report.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli()
}
