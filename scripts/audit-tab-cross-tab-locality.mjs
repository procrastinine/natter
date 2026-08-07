import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { buildProductionProtocolSourceFacts } from './audit-production-protocol.mjs'
import { staticAuditState } from './audit-result-state.mjs'
import { CONFIGURATION_COMMANDS } from './configuration-protocol-inventory.mjs'
import { discoverProductionDiscriminatedUnions } from './discover-production-discriminated-unions.mjs'
import {
  createProductionTypeScriptProgram,
  exactProductionTypeScriptSource,
  productionTypeScriptSources,
} from './production-typescript-source.mjs'
import * as defaultInventory from './tab-cross-tab-locality-inventory.mjs'

const ROOT = resolve(import.meta.dirname, '..')

const REMOTE_LOCALITY_BROWSER_FAMILIES = Object.freeze([
  'conversation',
  'catalogs',
  'configuration',
  'attachments',
  'attempts',
  'maintenance-replacement',
])
const REMOTE_LOCALITY_PRESERVATION_OUTCOMES = Object.freeze([
  'draft-local',
  'focus-local',
  'route-local',
  'scroll-local',
  'selection-local',
  'shared-projection-refresh',
  'stream-local',
])
const REMOTE_LOCALITY_REPLACEMENT_OUTCOMES = Object.freeze([
  'deterministic-local-fallback',
  'no-producer-route-copy',
  'shared-projection-refresh',
])

const LOCALITY_UNION_ROOTS = Object.freeze({
  'workspace-query': 'src/store/workspace-protocol.ts#WorkspaceQuery|kind',
  'workspace-command': 'src/store/workspace-protocol.ts#WorkspaceCommand|kind',
  'configuration-command':
    'src/store/configuration-domain-contract.ts#ConfigurationDomainCommandUnion|kind',
  'generation-intent': 'src/store/generation-admission-controller.ts#GenerationIntent|kind',
  route: 'src/app/router.ts#Route|kind',
  'storage-route': 'src/app/router.ts#StorageRoute|section',
  'active-branch-selection': 'src/core/active-branch-spine.ts#ActiveBranchSelection|kind',
  'conversation-operation':
    'src/store/conversation-controller.ts#ConversationOperationClaim|steering',
  'local-result-effect': 'src/store/conversation-controller.ts#ConversationLocalResultEffect|kind',
  'conversation-selection-delivery':
    'src/store/conversation-controller.ts#SelectingConversationOperationClaim|selectionDelivery',
  'conversation-route-delivery':
    'src/store/conversation-controller.ts#ConversationRouteDelivery|kind',
  'workspace-change': 'src/store/workspace-protocol.ts#WorkspaceChange|kind',
  'workspace-delta-fact': 'src/store/workspace-protocol.ts#WorkspaceDeltaFact|kind',
  'workspace-dependency': 'src/store/workspace-protocol.ts#WorkspaceDependency|kind',
})

const SURFACES = Object.freeze([
  {
    id: 'workspace-query',
    source: LOCALITY_UNION_ROOTS['workspace-query'],
    inventory: 'WORKSPACE_QUERY_LOCALITY',
  },
  {
    id: 'workspace-command',
    source: LOCALITY_UNION_ROOTS['workspace-command'],
    inventory: 'WORKSPACE_COMMAND_LOCALITY',
  },
  {
    id: 'configuration-command',
    source: LOCALITY_UNION_ROOTS['configuration-command'],
    inventory: 'CONFIGURATION_COMMAND_LOCALITY',
  },
  {
    id: 'generation-intent',
    source: LOCALITY_UNION_ROOTS['generation-intent'],
    inventory: 'GENERATION_INTENT_LOCALITY',
  },
  {
    id: 'route',
    source: LOCALITY_UNION_ROOTS.route,
    inventory: 'ROUTE_LOCALITY',
  },
  {
    id: 'storage-route',
    source: LOCALITY_UNION_ROOTS['storage-route'],
    inventory: 'STORAGE_ROUTE_LOCALITY',
  },
  {
    id: 'active-branch-selection',
    source: LOCALITY_UNION_ROOTS['active-branch-selection'],
    inventory: 'ACTIVE_BRANCH_SELECTION_LOCALITY',
  },
  {
    id: 'conversation-operation',
    source: LOCALITY_UNION_ROOTS['conversation-operation'],
    inventory: 'CONVERSATION_OPERATION_LOCALITY',
  },
  {
    id: 'local-result-effect',
    source: LOCALITY_UNION_ROOTS['local-result-effect'],
    inventory: 'LOCAL_RESULT_EFFECT_LOCALITY',
  },
  {
    id: 'conversation-selection-delivery',
    source: LOCALITY_UNION_ROOTS['conversation-selection-delivery'],
    inventory: 'CONVERSATION_SELECTION_DELIVERY_LOCALITY',
  },
  {
    id: 'conversation-route-delivery',
    source: LOCALITY_UNION_ROOTS['conversation-route-delivery'],
    inventory: 'CONVERSATION_ROUTE_DELIVERY_LOCALITY',
  },
  {
    id: 'workspace-change',
    source: LOCALITY_UNION_ROOTS['workspace-change'],
    inventory: 'WORKSPACE_CHANGE_LOCALITY',
  },
  {
    id: 'workspace-delta-fact',
    source: LOCALITY_UNION_ROOTS['workspace-delta-fact'],
    inventory: 'WORKSPACE_DELTA_FACT_LOCALITY',
  },
  {
    id: 'workspace-dependency',
    source: LOCALITY_UNION_ROOTS['workspace-dependency'],
    inventory: 'WORKSPACE_DEPENDENCY_LOCALITY',
  },
])

const STRING_UNION_SURFACES = Object.freeze([
  {
    id: 'workspace-root',
    path: 'src/store/workspace-runtime.ts',
    type: 'WorkspaceRootKind',
    inventory: 'WORKSPACE_ROOT_LOCALITY',
  },
  {
    id: 'workspace-child',
    path: 'src/store/workspace-runtime.ts',
    type: 'WorkspaceChildKind',
    inventory: 'WORKSPACE_CHILD_LOCALITY',
  },
])

export function buildTabCrossTabLocalitySourceFacts(options = {}) {
  const program = options.program ?? createProductionTypeScriptProgram(ROOT)
  const discovered = options.discovered ?? discoverProductionDiscriminatedUnions(ROOT, { program })
  const context = Object.freeze({ program, discovered })
  const sourceProblems = []
  const surfaceFacts = SURFACES.map((surface) => {
    const union = exactUnion(context, surface.source)
    return Object.freeze({
      ...surface,
      variants: Object.freeze([...union.variants]),
      constructorSites: Object.freeze(
        union.constructorSites.map((site) => Object.freeze({ ...site })),
      ),
    })
  })
  const stringSurfaceFacts = STRING_UNION_SURFACES.map((surface) =>
    Object.freeze({
      ...surface,
      variants: Object.freeze(stringUnionValues(context, surface.path, surface.type)),
    }),
  )
  const protocolFacts =
    options.productionFacts ?? buildProductionProtocolSourceFacts({ program, discovered })
  const rootAdmissions = protocolFacts.rootAdmissions.flatMap((site) => {
    if (!site.kinds || site.kinds.length === 0) {
      sourceProblems.push(`${site.path}:${site.line}: workspace root admission is not finite`)
      return []
    }
    return site.kinds.map((variant) => ({
      id: `${site.path}#${site.owner}|${site.admission}:${variant}|${site.offset}`,
      variant,
      path: site.path,
      owner: site.owner,
      line: site.line,
      status: 'observed',
    }))
  })
  const childReservations = collectPermitCallSites(context, new Set(['reserveWorkspaceChild']), 1)
  const configurationUnion = exactUnion(
    context,
    'src/store/configuration-domain-contract.ts#ConfigurationDomainCommandUnion|kind',
  )
  const rawPublicationSourceCount = countOccurrences(
    exactSource(context, 'src/store/workspace-effect-hub.ts').getText(),
    'attachedRepository.subscribeChanges(',
  )
  if (rawPublicationSourceCount !== 1) {
    sourceProblems.push(
      `workspace effect raw publication sources=${rawPublicationSourceCount}; expected=1`,
    )
  }
  const inlineQueryHandlers = discriminantValues(
    context,
    'src/store/browser-repo.ts',
    'BrowserInlineQuery',
    'kind',
  )
  const workspaceQueryVariants = exactUnion(
    context,
    LOCALITY_UNION_ROOTS['workspace-query'],
  ).variants
  const delegatedQueryHandlers = workspaceQueryVariants.filter(
    (variant) => !inlineQueryHandlers.includes(variant),
  )
  const publicationConsumerSelectors = workspaceEffectSubscriptionSites(context)
  const workspaceFactVariants = surfaceFacts.find(
    (surface) => surface.id === 'workspace-delta-fact',
  ).variants
  const workspaceDependencyVariants = surfaceFacts.find(
    (surface) => surface.id === 'workspace-dependency',
  ).variants
  const factDependencyKinds = workspaceFactDependencyKinds(
    context,
    workspaceFactVariants,
    workspaceDependencyVariants,
  )
  return Object.freeze({
    auditedUnionSubjects: Object.freeze(
      surfaceFacts.map((surface) => Object.freeze({ name: surface.id, id: surface.source })),
    ),
    surfaceFacts: Object.freeze(surfaceFacts),
    stringSurfaceFacts: Object.freeze(stringSurfaceFacts),
    resourceIds: Object.freeze(
      literalConstArray(
        context,
        'src/store/workspace-runtime-control.ts',
        'WORKSPACE_RUNTIME_RESOURCE_IDS',
      ),
    ),
    streamLeaseOperations: Object.freeze(streamLeaseOperationNames(context)),
    attemptControllerOperations: Object.freeze(
      interfaceMethodNames(context, 'src/store/attempt-controller.ts', 'AttemptController'),
    ),
    routeActions: Object.freeze(routeActionNames(context)),
    rootAdmissions: Object.freeze(rootAdmissions.map((site) => Object.freeze({ ...site }))),
    childReservations: Object.freeze(childReservations.map((site) => Object.freeze({ ...site }))),
    configurationUnion: Object.freeze({
      variants: Object.freeze([...configurationUnion.variants]),
      constructorSites: Object.freeze(
        configurationUnion.constructorSites.map((site) => Object.freeze({ ...site })),
      ),
    }),
    typedDeltaSites: Object.freeze(
      typedOwnerLiteralSites(
        context,
        'workspace-delta-fact',
        'src/store/browser-repo.ts',
        'BrowserCommandCommit.attachmentFacts',
        'WorkspaceDeltaFact[]',
        ['attachment-row-changed', 'attachment-row-deleted'],
      ).map((site) => Object.freeze({ ...site })),
    ),
    publicationConsumers: Object.freeze(
      [...new Set(publicationConsumerSelectors.map((selector) => selector.path))].sort(),
    ),
    publicationConsumerSelectors: Object.freeze(publicationConsumerSelectors),
    factDependencyKinds: Object.freeze(factDependencyKinds),
    publicationProducers: Object.freeze(
      callSites(context, 'postWorkspaceChange', 'src/store/broadcast.ts').map((site) =>
        Object.freeze({ ...site }),
      ),
    ),
    rawPublicationSourceCount,
    workspaceQueryDispatch: Object.freeze(
      switchCaseVariants(
        context,
        'src/store/browser-repo.ts',
        'BrowserWorkspaceRepository.dispatchQuery',
        'query.kind',
      ),
    ),
    workspaceCommandDispatch: Object.freeze(
      switchCaseVariants(
        context,
        'src/store/browser-repo.ts',
        'BrowserWorkspaceRepository.dispatchCommand',
        'command.kind',
      ),
    ),
    delegatedQueryHandlers: Object.freeze(delegatedQueryHandlers),
    configurationHandlers: Object.freeze(
      objectLiteralKeys(
        context,
        'src/store/browser-configuration-domain.ts',
        'configurationDomainHandlers',
      ),
    ),
    sourceProblems: Object.freeze(sourceProblems),
  })
}

export function evaluateTabCrossTabLocality(
  inventory = defaultInventory,
  mode = 'inventory',
  detail = false,
  sourceFacts = buildTabCrossTabLocalitySourceFacts(),
) {
  if (mode !== 'inventory' && mode !== 'enforce') {
    throw new Error(`TabCrossTabLocalityAuditModeInvalid:${mode}`)
  }
  const facts = sourceFacts
  const problems = [...facts.sourceProblems]
  const records = []
  const constructorSites = []
  for (const surface of facts.surfaceFacts) {
    const locality = inventory[surface.inventory]
    compareExact(`${surface.id} variants`, surface.variants, Object.keys(locality ?? {}), problems)
    validateRecords(
      surface.id,
      locality,
      surface.variants,
      problems,
      inventory.REQUIRED_LOCALITY_FIELDS,
    )
    for (const variant of surface.variants) {
      records.push({ surface: surface.id, variant, record: locality?.[variant] })
    }
    for (const site of surface.constructorSites) {
      constructorSites.push({ surface: surface.id, ...site })
    }
  }

  for (const surface of facts.stringSurfaceFacts) {
    const variants = surface.variants
    const locality = inventory[surface.inventory]
    compareExact(`${surface.id} variants`, variants, Object.keys(locality ?? {}), problems)
    validateRecords(surface.id, locality, variants, problems, inventory.REQUIRED_LOCALITY_FIELDS)
    for (const variant of variants) {
      records.push({ surface: surface.id, variant, record: locality?.[variant] })
    }
  }

  const resourceIds = facts.resourceIds
  compareAndAddSurface(
    'runtime-resource',
    resourceIds,
    inventory.RUNTIME_RESOURCE_LOCALITY,
    records,
    problems,
    inventory.REQUIRED_LOCALITY_FIELDS,
  )

  const streamLeaseOperations = facts.streamLeaseOperations
  compareAndAddSurface(
    'stream-lease-operation',
    streamLeaseOperations,
    inventory.STREAM_LEASE_OPERATION_LOCALITY,
    records,
    problems,
    inventory.REQUIRED_LOCALITY_FIELDS,
  )

  const attemptControllerOperations = facts.attemptControllerOperations
  compareAndAddSurface(
    'attempt-controller-operation',
    attemptControllerOperations,
    inventory.ATTEMPT_CONTROLLER_OPERATION_LOCALITY,
    records,
    problems,
    inventory.REQUIRED_LOCALITY_FIELDS,
  )

  const routeActions = facts.routeActions
  compareAndAddSurface(
    'route-action',
    routeActions,
    inventory.ROUTE_ACTION_LOCALITY,
    records,
    problems,
    inventory.REQUIRED_LOCALITY_FIELDS,
  )

  const rootAdmissions = facts.rootAdmissions
  const childReservations = facts.childReservations
  const rootVariants = facts.stringSurfaceFacts.find(
    (surface) => surface.id === 'workspace-root',
  ).variants
  const childVariants = facts.stringSurfaceFacts.find(
    (surface) => surface.id === 'workspace-child',
  ).variants
  const rootAdmissionCounts = countsBy(rootAdmissions, (site) => site.variant)
  const childReservationCounts = countsBy(childReservations, (site) => site.variant)
  for (const site of rootAdmissions) constructorSites.push({ surface: 'workspace-root', ...site })
  for (const site of childReservations)
    constructorSites.push({ surface: 'workspace-child', ...site })

  for (const variant of rootVariants) {
    if (!rootAdmissionCounts.has(variant)) {
      constructorSites.push({
        surface: 'workspace-root',
        variant,
        path: null,
        owner: null,
        id: `workspace-root::${variant}::unadmitted`,
        status: 'gap',
        reason: 'Declared root kind has no literal production admission site.',
      })
    }
  }
  for (const variant of childVariants) {
    if (!childReservationCounts.has(variant)) {
      constructorSites.push({
        surface: 'workspace-child',
        variant,
        path: null,
        owner: null,
        id: `workspace-child::${variant}::unreserved`,
        status: 'gap',
        reason: 'Declared child kind has no literal production reservation site.',
      })
    }
  }

  const configurationUnion = facts.configurationUnion
  for (const variant of configurationUnion.variants) {
    if (configurationUnion.constructorSites.some((site) => site.variant === variant)) continue
    constructorSites.push({
      surface: 'configuration-command',
      variant,
      path: null,
      owner: null,
      id: `configuration-command::${variant}::unconstructed`,
      status: 'gap',
      reason:
        CONFIGURATION_COMMANDS[variant]?.gap ??
        'Declared configuration command has no typed production constructor site.',
    })
  }

  constructorSites.push(...facts.typedDeltaSites.map((site) => ({ ...site })))

  for (const surface of ['workspace-delta-fact']) {
    const variants = records
      .filter((record) => record.surface === surface)
      .map((record) => record.variant)
    for (const variant of variants) {
      if (constructorSites.some((site) => site.surface === surface && site.variant === variant))
        continue
      constructorSites.push({
        surface,
        variant,
        path: null,
        owner: null,
        id: `${surface}::${variant}::unconstructed`,
        status: 'gap',
        reason: 'Declared fact variant has no typed literal constructor site.',
      })
    }
  }

  const pathOwners = flattenPathOwners(inventory.OWNER_PATH_CLASSIFICATIONS, problems)
  const actualOwnedPaths = new Set()
  const ownerSiteGaps = []
  for (const site of constructorSites) {
    if (!site.path) continue
    actualOwnedPaths.add(site.path)
    const classification = pathOwners.get(site.path)
    if (!classification) {
      ownerSiteGaps.push({
        id: site.id,
        surface: site.surface,
        variant: site.variant,
        path: site.path,
        reason: 'Constructor/admission path has no initiating-owner classification.',
      })
    } else {
      site.initiatingOwner = classification
    }
  }
  compareExact('initiating-owner paths', [...actualOwnedPaths], [...pathOwners.keys()], problems)

  const publicationConsumers = facts.publicationConsumers
  const publicationConsumerSelectors = facts.publicationConsumerSelectors
  compareExact(
    'workspace publication consumer files',
    publicationConsumers,
    Object.keys(inventory.PUBLICATION_CONSUMER_FILES ?? {}),
    problems,
  )
  compareExact(
    'workspace publication selector files',
    publicationConsumers,
    [...new Set(publicationConsumerSelectors.map((selector) => selector.path))],
    problems,
  )
  const workspaceFactVariants = facts.surfaceFacts.find(
    (surface) => surface.id === 'workspace-delta-fact',
  ).variants
  const workspaceDependencyVariants = facts.surfaceFacts.find(
    (surface) => surface.id === 'workspace-dependency',
  ).variants
  const publicationAddressing = publicationAddressingMatrix(
    publicationConsumerSelectors,
    workspaceFactVariants,
    workspaceDependencyVariants,
    facts.factDependencyKinds,
  )
  const publicationProducers = facts.publicationProducers
  const rawPublicationSourceCount = facts.rawPublicationSourceCount
  const remoteBrowserOutcomes = validateRemoteBrowserOutcomes(
    inventory.REMOTE_LOCALITY_BROWSER_OUTCOME_MATRIX,
    publicationConsumers,
    problems,
  )

  const workspaceQueryDispatch = facts.workspaceQueryDispatch
  const workspaceCommandDispatch = facts.workspaceCommandDispatch
  const delegatedQueryHandlers = facts.delegatedQueryHandlers
  compareExact(
    'workspace query dispatch handlers',
    Object.keys(inventory.WORKSPACE_QUERY_LOCALITY ?? {}),
    [...workspaceQueryDispatch, ...delegatedQueryHandlers],
    problems,
  )
  compareExact(
    'workspace command dispatch handlers',
    Object.keys(inventory.WORKSPACE_COMMAND_LOCALITY ?? {}),
    workspaceCommandDispatch,
    problems,
  )
  const configurationHandlers = facts.configurationHandlers
  compareExact(
    'configuration command handlers',
    Object.keys(inventory.CONFIGURATION_COMMAND_LOCALITY ?? {}),
    configurationHandlers,
    problems,
  )

  const architectureGaps = Object.entries(inventory.ARCHITECTURE_GAPS ?? {}).map(
    ([id, reason]) => ({
      id,
      reason,
    }),
  )
  for (const gap of architectureGaps) {
    if (!gap.id || typeof gap.reason !== 'string' || gap.reason.length < 20) {
      problems.push(`architecture gap ${gap.id || '<empty>'}: missing specific reason`)
    }
  }
  const scannerLimitations = inventory.SCANNER_LIMITATIONS ?? []
  for (const [index, limitation] of scannerLimitations.entries()) {
    if (typeof limitation !== 'string' || limitation.length < 40) {
      problems.push(`scanner limitation ${index}: missing exact limitation text`)
    }
  }
  const acceptanceCriteria = inventory.INVENTORY_CLOSURE_ACCEPTANCE ?? []
  const acceptanceIds = new Set()
  for (const [index, criterion] of acceptanceCriteria.entries()) {
    if (!criterion || typeof criterion !== 'object') {
      problems.push(`inventory closure acceptance ${index}: invalid record`)
      continue
    }
    if (typeof criterion.id !== 'string' || criterion.id.length === 0) {
      problems.push(`inventory closure acceptance ${index}: missing id`)
    } else if (acceptanceIds.has(criterion.id)) {
      problems.push(`inventory closure acceptance duplicated: ${criterion.id}`)
    } else acceptanceIds.add(criterion.id)
    if (typeof criterion.metric !== 'string' || criterion.metric.length === 0) {
      problems.push(`inventory closure acceptance ${criterion.id}: missing metric`)
    }
    if (!['boolean', 'number'].includes(typeof criterion.target)) {
      problems.push(`inventory closure acceptance ${criterion.id}: invalid target`)
    }
    if (typeof criterion.requirement !== 'string' || criterion.requirement.length < 40) {
      problems.push(`inventory closure acceptance ${criterion.id}: missing exact requirement`)
    }
  }
  const recordGaps = records
    .filter(({ record }) => record?.status === 'gap')
    .map(({ surface, variant, record }) => ({ surface, variant, reason: record.gap }))
  const siteGaps = [...constructorSites.filter((site) => site.status === 'gap'), ...ownerSiteGaps]

  const acceptanceMetrics = {
    structurallyValid: problems.length === 0,
    ownerSiteGaps: ownerSiteGaps.length,
    unconstructedOrUnadmittedSites: constructorSites.filter((site) => site.status === 'gap').length,
    recordGaps: recordGaps.length,
    architectureGaps: architectureGaps.length,
    'committed-write-semantic-delta-is-manual':
      inventory.ARCHITECTURE_GAPS?.['committed-write-semantic-delta-is-manual'] !== undefined,
    'remote-refresh-cannot-steer-is-not-proven':
      inventory.ARCHITECTURE_GAPS?.['remote-refresh-cannot-steer-is-not-proven'] !== undefined,
    'aggregate-runtime-globalizes-capabilities':
      inventory.ARCHITECTURE_GAPS?.['aggregate-runtime-globalizes-capabilities'] !== undefined,
    'stream-ownership-spans-separate-protocols':
      inventory.ARCHITECTURE_GAPS?.['stream-ownership-spans-separate-protocols'] !== undefined,
    'other-tab-outcomes-are-not-executable-contracts':
      inventory.ARCHITECTURE_GAPS?.['other-tab-outcomes-are-not-executable-contracts'] !==
      undefined,
    'performance-locality-proof': false,
    'publication-addressing-matrix-generated':
      publicationAddressing.inputs ===
        workspaceFactVariants.length + workspaceDependencyVariants.length &&
      publicationAddressing.pairs ===
        publicationConsumerSelectors.length * publicationAddressing.inputs,
    scannerLimitations: scannerLimitations.length,
  }
  const acceptanceResults = acceptanceCriteria.map((criterion) => ({
    ...criterion,
    actual: acceptanceMetrics[criterion.metric],
    satisfied: acceptanceMetrics[criterion.metric] === criterion.target,
  }))

  const surfaceCounts = Object.fromEntries(
    [...new Set(records.map((record) => record.surface))]
      .sort()
      .map((surface) => [surface, records.filter((record) => record.surface === surface).length]),
  )
  const constructorSiteCounts = Object.fromEntries(
    [...new Set(constructorSites.map((site) => site.surface))]
      .sort()
      .map((surface) => [
        surface,
        constructorSites.filter((site) => site.surface === surface && site.path !== null).length,
      ]),
  )
  const gaps = [...architectureGaps, ...recordGaps, ...siteGaps]
  const structurallyValid = problems.length === 0
  const output = {
    mode,
    ok:
      problems.length === 0 &&
      (mode !== 'enforce' ||
        (architectureGaps.length === 0 && recordGaps.length === 0 && siteGaps.length === 0)),
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps }),
    surfaces: Object.keys(surfaceCounts).length,
    records: records.length,
    surfaceCounts,
    constructorSites: constructorSites.filter((site) => site.path !== null).length,
    constructorSiteCounts,
    unconstructedOrUnadmittedSites: constructorSites.filter((site) => site.status === 'gap').length,
    ownerClassifiedSites: constructorSites.filter(
      (site) => site.path !== null && site.initiatingOwner,
    ).length,
    ownerSiteGaps: ownerSiteGaps.length,
    rootAdmissionSites: rootAdmissions.length,
    unadmittedRoots: rootVariants.filter((variant) => !rootAdmissionCounts.has(variant)).length,
    childReservationSites: childReservations.length,
    unreservedChildren: childVariants.filter((variant) => !childReservationCounts.has(variant))
      .length,
    configurationConstructorGaps: Object.values(CONFIGURATION_COMMANDS).filter(
      (entry) => entry.status === 'gap',
    ).length,
    publicationConsumers: publicationConsumers.length,
    publicationConsumerSelectors: publicationConsumerSelectors.length,
    publicationAddressingInputs: publicationAddressing.inputs,
    publicationAddressingPairs: publicationAddressing.pairs,
    publicationAddressedPairs: publicationAddressing.addressed,
    publicationUnaddressedPairs: publicationAddressing.unaddressed,
    publicationProducers: publicationProducers.length,
    rawPublicationSources: rawPublicationSourceCount,
    remoteBrowserOutcomeFamilies: remoteBrowserOutcomes.families,
    remoteBrowserOutcomeConsumers: remoteBrowserOutcomes.consumers,
    architectureGaps: architectureGaps.length,
    recordGaps: recordGaps.length,
    siteGaps: siteGaps.length,
    scannerLimitations: scannerLimitations.length,
    acceptanceCriteria: acceptanceCriteria.length,
    acceptanceSatisfied: acceptanceResults.filter((criterion) => criterion.satisfied).length,
    acceptanceOpen: acceptanceResults.filter((criterion) => !criterion.satisfied).length,
    ...(detail
      ? {
          localityRecords: records,
          constructorSites,
          publicationConsumerRecords: publicationConsumers.map((path) => ({
            path,
            role: inventory.PUBLICATION_CONSUMER_FILES[path],
          })),
          publicationConsumerSelectorRecords: publicationConsumerSelectors,
          publicationAddressingRecords: publicationAddressing.records,
          publicationProducers,
          architectureGapRecords: architectureGaps,
          recordGapRecords: recordGaps,
          siteGapRecords: siteGaps,
          scannerLimitationRecords: scannerLimitations,
          inventoryClosureAcceptance: acceptanceResults,
        }
      : {}),
    limitations: scannerLimitations,
    problems: problems.sort(),
  }
  return Object.freeze(output)
}

function validateRemoteBrowserOutcomes(matrix, publicationConsumers, problems) {
  if (!Array.isArray(matrix)) {
    problems.push('remote locality browser outcome matrix: missing array')
    return { families: 0, consumers: 0 }
  }
  const familyIds = []
  const consumerIds = []
  const sources = new Map()
  for (const [index, row] of matrix.entries()) {
    if (!row || typeof row !== 'object') {
      problems.push(`remote locality browser outcome matrix ${index}: invalid row`)
      continue
    }
    const id = typeof row.id === 'string' ? row.id : ''
    familyIds.push(id)
    if (!Array.isArray(row.consumers) || row.consumers.length === 0) {
      problems.push(`remote locality browser outcome ${id || index}: missing consumers`)
    } else {
      consumerIds.push(...row.consumers)
    }
    if (!Array.isArray(row.journeys) || row.journeys.length === 0) {
      problems.push(`remote locality browser outcome ${id || index}: missing journeys`)
      continue
    }
    for (const [journeyIndex, journey] of row.journeys.entries()) {
      const subject = `${id || index} journey ${journeyIndex}`
      const expectedOutcomes = journey.targetMayDisappear
        ? REMOTE_LOCALITY_REPLACEMENT_OUTCOMES
        : REMOTE_LOCALITY_PRESERVATION_OUTCOMES
      compareExact(
        `remote locality browser outcome ${subject} outcomes`,
        expectedOutcomes,
        Array.isArray(journey.outcomes) ? journey.outcomes : [],
        problems,
      )
      if (typeof journey.path !== 'string' || !journey.path.startsWith('tests/e2e/')) {
        problems.push(`remote locality browser outcome ${subject}: invalid browser path`)
        continue
      }
      const absolutePath = resolve(ROOT, journey.path)
      if (!existsSync(absolutePath)) {
        problems.push(`remote locality browser outcome ${subject}: missing ${journey.path}`)
        continue
      }
      if (typeof journey.locator !== 'string' || journey.locator.length === 0) {
        problems.push(`remote locality browser outcome ${subject}: missing locator`)
        continue
      }
      const source = sources.get(absolutePath) ?? readFileSync(absolutePath, 'utf8')
      sources.set(absolutePath, source)
      const occurrences = source.split(journey.locator).length - 1
      if (occurrences !== 1) {
        problems.push(
          `remote locality browser outcome ${subject}: locator occurs ${occurrences} times in ${journey.path}`,
        )
      }
    }
  }
  compareExact(
    'remote locality browser outcome families',
    REMOTE_LOCALITY_BROWSER_FAMILIES,
    familyIds,
    problems,
  )
  compareExact(
    'remote locality browser outcome consumers',
    publicationConsumers,
    consumerIds,
    problems,
  )
  if (new Set(consumerIds).size !== consumerIds.length) {
    problems.push('remote locality browser outcome consumers: duplicate consumer coverage')
  }
  return { families: familyIds.length, consumers: consumerIds.length }
}

function compareAndAddSurface(id, variants, locality, target, targetProblems, requiredFields) {
  compareExact(`${id} variants`, variants, Object.keys(locality ?? {}), targetProblems)
  validateRecords(id, locality, variants, targetProblems, requiredFields)
  for (const variant of variants) target.push({ surface: id, variant, record: locality?.[variant] })
}

function validateRecords(surface, locality, variants, targetProblems, requiredFields) {
  const required = requiredFields ?? []
  for (const variant of variants) {
    const record = locality?.[variant]
    if (!record || typeof record !== 'object') {
      targetProblems.push(`${surface} ${variant}: missing locality record`)
      continue
    }
    for (const field of required) {
      if (!(field in record)) targetProblems.push(`${surface} ${variant}: missing ${field}`)
    }
    if (!['observed', 'gap'].includes(record.status)) {
      targetProblems.push(`${surface} ${variant}: invalid status ${String(record.status)}`)
    }
    if (record.status === 'gap' && (typeof record.gap !== 'string' || record.gap.length < 20)) {
      targetProblems.push(`${surface} ${variant}: gap needs a specific reason`)
    }
    if (
      !Array.isArray(record.forbiddenRemoteSteering) ||
      !sameSet(record.forbiddenRemoteSteering, ['route', 'cursor', 'draft', 'selection'])
    ) {
      targetProblems.push(
        `${surface} ${variant}: forbiddenRemoteSteering must cover route,cursor,draft,selection`,
      )
    }
    for (const field of required.filter((name) => name !== 'forbiddenRemoteSteering')) {
      if (typeof record[field] !== 'string' || record[field].length === 0) {
        targetProblems.push(`${surface} ${variant}: ${field} must be a non-empty string`)
      }
    }
  }
}

function flattenPathOwners(groups, targetProblems) {
  const found = new Map()
  for (const [owner, paths] of Object.entries(groups ?? {})) {
    if (!['tab-local', 'background', 'maintenance'].includes(owner)) {
      targetProblems.push(`initiating-owner classification invalid: ${owner}`)
    }
    for (const path of paths ?? []) {
      if (found.has(path)) targetProblems.push(`initiating-owner path duplicated: ${path}`)
      found.set(path, owner)
    }
  }
  return found
}

function exactUnion(context, id) {
  const found = context.discovered.unions.filter((union) => union.id === id)
  if (found.length !== 1) throw new Error(`LocalityUnionExpectedOnce:${id}:${found.length}`)
  return found[0]
}

function stringUnionValues(context, path, typeName) {
  const source = exactSource(context, path)
  const alias = source.statements.find(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName,
  )
  if (!alias) throw new Error(`LocalityStringUnionMissing:${path}#${typeName}`)
  const checker = context.program.getTypeChecker()
  const type = checker.getTypeFromTypeNode(alias.type)
  const alternatives = type.isUnion() ? type.types : [type]
  const values = alternatives.flatMap((alternative) =>
    alternative.isStringLiteral() ? [alternative.value] : [],
  )
  if (values.length !== alternatives.length) {
    throw new Error(`LocalityStringUnionNotLiteral:${path}#${typeName}`)
  }
  return [...new Set(values)].sort()
}

function discriminantValues(context, path, typeName, discriminant) {
  const source = exactSource(context, path)
  const alias = source.statements.find(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName,
  )
  if (!alias) throw new Error(`LocalityDiscriminatedTypeMissing:${path}#${typeName}`)
  const checker = context.program.getTypeChecker()
  const type = checker.getTypeFromTypeNode(alias.type)
  const members = type.isUnion() ? type.types : [type]
  const values = []
  for (const member of members) {
    const property = member.getProperty(discriminant)
    if (!property) {
      throw new Error(`LocalityDiscriminantMissing:${path}#${typeName}|${discriminant}`)
    }
    const location = property.valueDeclaration ?? property.declarations?.[0] ?? alias
    const propertyType = checker.getTypeOfSymbolAtLocation(property, location)
    const alternatives = propertyType.isUnion() ? propertyType.types : [propertyType]
    for (const alternative of alternatives) {
      if (!alternative.isStringLiteral()) {
        throw new Error(`LocalityDiscriminantNotLiteral:${path}#${typeName}|${discriminant}`)
      }
      values.push(alternative.value)
    }
  }
  return [...new Set(values)].sort()
}

function literalConstArray(context, path, name) {
  const source = exactSource(context, path)
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
      let value = unwrap(declaration.initializer)
      if (
        value &&
        ts.isCallExpression(value) &&
        ts.isPropertyAccessExpression(value.expression) &&
        value.expression.expression.getText(source) === 'Object' &&
        value.expression.name.text === 'freeze'
      ) {
        value = unwrap(value.arguments[0])
      }
      if (!value || !ts.isArrayLiteralExpression(value)) {
        throw new Error(`LocalityConstArrayInvalid:${path}#${name}`)
      }
      return value.elements.map((element) => {
        const literal = literalValue(element)
        if (literal === undefined) throw new Error(`LocalityConstArrayNonLiteral:${path}#${name}`)
        return literal
      })
    }
  }
  throw new Error(`LocalityConstArrayMissing:${path}#${name}`)
}

function streamLeaseOperationNames(context) {
  const source = exactSource(context, 'src/store/stream-leases.ts')
  const exportedFunctions = source.statements.flatMap((statement) => {
    if (
      !ts.isFunctionDeclaration(statement) ||
      !statement.name ||
      statement.name.text.startsWith('__') ||
      !hasExport(statement)
    ) {
      return []
    }
    return [statement.name.text]
  })
  const handleMethods = interfaceMethodNames(
    context,
    'src/store/stream-leases.ts',
    'StreamLeaseHandle',
  ).map((name) => `handle.${name}`)
  return [...exportedFunctions, ...handleMethods].sort()
}

function interfaceMethodNames(context, path, interfaceName) {
  const source = exactSource(context, path)
  const declaration = source.statements.find(
    (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName,
  )
  if (!declaration || !ts.isInterfaceDeclaration(declaration)) {
    throw new Error(`LocalityInterfaceMissing:${path}#${interfaceName}`)
  }
  return [
    ...new Set(
      declaration.members.flatMap((member) => {
        if (!ts.isMethodSignature(member)) return []
        const name = propertyName(member.name)
        return name ? [name] : []
      }),
    ),
  ].sort()
}

function routeActionNames(context) {
  const source = exactSource(context, 'src/app/router.ts')
  const bodies = new Map()
  const exported = new Set()
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      bodies.set(statement.name.text, statement.body.getText(source))
      if (hasExport(statement)) exported.add(statement.name.text)
    }
  }
  const calls = new Map(
    [...bodies].map(([name, body]) => [
      name,
      [...bodies.keys()].filter((candidate) =>
        new RegExp(`\\b${candidate}\\s*\\(`, 'u').test(body),
      ),
    ]),
  )
  const action = new Set(['claimRouteIntent', 'invalidateRouteIntent', 'consumeRouteIntent'])
  for (const [name, body] of bodies) {
    if (
      body.includes('window.history.pushState') ||
      body.includes('window.history.replaceState') ||
      /currentRouteIntent\s*=(?!=)/.test(body)
    ) {
      action.add(name)
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const [name, targets] of calls) {
      if (action.has(name) || !targets.some((target) => action.has(target))) continue
      action.add(name)
      changed = true
    }
  }
  const result = [...exported].filter((name) => action.has(name))
  const navigationPort = source.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'browserConversationNavigationPort',
      ),
  )
  if (!navigationPort?.getText(source).includes('replaceConversationUrl')) {
    throw new Error('LocalityBrowserConversationNavigationPortMissing')
  }
  result.push('browserConversationNavigationPort.replaceConversationUrl')
  return [...new Set(result)].sort()
}

function collectPermitCallSites(context, functions, argumentIndex) {
  const sites = []
  for (const source of productionSources(context)) {
    visit(source, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return
      if (!functions.has(node.expression.text)) return
      const variant = literalValue(node.arguments[argumentIndex])
      if (variant === undefined) return
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      const path = relativePath(source.fileName)
      sites.push({
        id: `${path}#${enclosingOwner(node)}|${node.expression.text}:${variant}|${line}`,
        variant,
        path,
        owner: enclosingOwner(node),
        line,
        status: 'observed',
      })
    })
  }
  return sites.sort((left, right) => left.id.localeCompare(right.id))
}

function callSites(context, functionName, declarationPath) {
  const sites = []
  for (const source of productionSources(context)) {
    const path = relativePath(source.fileName)
    if (path === declarationPath) continue
    visit(source, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !ts.isIdentifier(node.expression) ||
        node.expression.text !== functionName
      ) {
        return
      }
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      sites.push({ path, line, owner: enclosingOwner(node) })
    })
  }
  return sites.sort((left, right) =>
    `${left.path}:${left.line}`.localeCompare(`${right.path}:${right.line}`),
  )
}

function workspaceEffectSubscriptionSites(context) {
  const sites = []
  for (const source of productionSources(context)) {
    const path = relativePath(source.fileName)
    if (path === 'src/store/workspace-effect-hub.ts') continue
    visit(source, (node) => {
      if (
        !ts.isCallExpression(node) ||
        !ts.isIdentifier(node.expression) ||
        node.expression.text !== 'subscribeWorkspaceEffects'
      ) {
        return
      }
      const input = unwrap(node.arguments[0])
      if (!input || !ts.isObjectLiteralExpression(input)) {
        throw new Error(`LocalityWorkspaceEffectSubscriptionNotLiteral:${path}`)
      }
      const owner = requiredStringProperty(input, 'owner', path)
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      sites.push(
        Object.freeze({
          id: `${path}#${owner}|${line}`,
          path,
          line,
          owner,
          sources: Object.freeze(
            optionalStringArrayProperty(input, 'sources', source, path) ?? ['local', 'remote'],
          ),
          factKinds: Object.freeze(
            optionalStringArrayProperty(input, 'factKinds', source, path) ?? [],
          ),
          residualKinds: Object.freeze(
            optionalStringArrayProperty(input, 'residualKinds', source, path) ?? [],
          ),
          impactKinds: Object.freeze(
            optionalStringArrayProperty(input, 'impactKinds', source, path) ?? [],
          ),
          replacements: optionalBooleanProperty(input, 'replacements', path) ?? true,
        }),
      )
    })
  }
  return sites.sort((left, right) => left.id.localeCompare(right.id))
}

function workspaceFactDependencyKinds(context, factVariants, dependencyVariants) {
  const source = exactSource(context, 'src/store/workspace-protocol.ts')
  const declaration = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'workspaceDependenciesForDeltaFact',
  )
  if (!declaration?.body) throw new Error('LocalityWorkspaceFactDependencyOwnerMissing')
  const targetSwitch = findNode(
    declaration.body,
    (node) => ts.isSwitchStatement(node) && node.expression.getText(source) === 'fact.kind',
  )
  if (!targetSwitch || !ts.isSwitchStatement(targetSwitch)) {
    throw new Error('LocalityWorkspaceFactDependencySwitchMissing')
  }
  const dependencyKinds = new Set(dependencyVariants)
  const result = {}
  let pendingFacts = []
  for (const clause of targetSwitch.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue
    const factKind = literalValue(clause.expression)
    if (factKind === undefined) {
      throw new Error('LocalityWorkspaceFactDependencyCaseNotLiteral')
    }
    pendingFacts.push(factKind)
    if (clause.statements.length === 0) continue
    const foundKinds = new Set()
    for (const statement of clause.statements) {
      visit(statement, (node) => {
        if (!ts.isObjectLiteralExpression(node)) return
        const kindNode = objectPropertyInitializer(node, 'kind')
        const kind = literalValue(kindNode)
        if (kind !== undefined && dependencyKinds.has(kind)) foundKinds.add(kind)
      })
    }
    for (const pending of pendingFacts) result[pending] = Object.freeze([...foundKinds].sort())
    pendingFacts = []
  }
  const missing = factVariants.filter((variant) => !(variant in result))
  const extra = Object.keys(result).filter((variant) => !factVariants.includes(variant))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `LocalityWorkspaceFactDependencyMappingMismatch:missing=${missing.join(',')}:extra=${extra.join(',')}`,
    )
  }
  return Object.freeze(result)
}

function publicationAddressingMatrix(
  selectors,
  factVariants,
  dependencyVariants,
  factDependencies,
) {
  const records = []
  for (const selector of selectors) {
    const acceptsRemote = selector.sources.includes('remote')
    for (const factKind of factVariants) {
      const dependencyKinds = factDependencies[factKind] ?? []
      const addressed =
        acceptsRemote &&
        (selector.factKinds.includes(factKind) ||
          dependencyKinds.some((kind) => selector.impactKinds.includes(kind)))
      records.push(
        Object.freeze({
          consumer: selector.owner,
          input: `fact:${factKind}`,
          addressed,
        }),
      )
    }
    for (const dependencyKind of dependencyVariants) {
      const addressed =
        acceptsRemote &&
        (dependencyKind === 'workspace' ||
          selector.residualKinds.includes(dependencyKind) ||
          selector.impactKinds.includes(dependencyKind))
      records.push(
        Object.freeze({
          consumer: selector.owner,
          input: `dependency:${dependencyKind}`,
          addressed,
        }),
      )
    }
  }
  const addressed = records.filter((record) => record.addressed).length
  return Object.freeze({
    inputs: factVariants.length + dependencyVariants.length,
    pairs: records.length,
    addressed,
    unaddressed: records.length - addressed,
    records: Object.freeze(records),
  })
}

function requiredStringProperty(object, name, path) {
  const value = literalValue(objectPropertyInitializer(object, name))
  if (typeof value !== 'string') {
    throw new Error(`LocalityObjectStringPropertyInvalid:${path}#${name}`)
  }
  return value
}

function optionalStringArrayProperty(object, name, source, path) {
  const initializer = objectPropertyInitializer(object, name)
  if (!initializer) return undefined
  const value = staticArrayInitializer(initializer, source, path, name)
  if (!ts.isArrayLiteralExpression(value)) {
    throw new Error(`LocalityObjectArrayPropertyInvalid:${path}#${name}`)
  }
  return value.elements.map((element) => {
    const literal = literalValue(element)
    if (typeof literal !== 'string') {
      throw new Error(`LocalityObjectArrayElementInvalid:${path}#${name}`)
    }
    return literal
  })
}

function staticArrayInitializer(node, source, path, propertyName, seen = new Set()) {
  const value = unwrap(node)
  if (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.expression.getText(source) === 'Object' &&
    value.expression.name.text === 'freeze' &&
    value.arguments.length === 1
  ) {
    return staticArrayInitializer(value.arguments[0], source, path, propertyName, seen)
  }
  if (!ts.isIdentifier(value)) return value
  if (seen.has(value.text)) {
    throw new Error(`LocalityObjectArrayReferenceCycle:${path}#${propertyName}`)
  }
  seen.add(value.text)
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === value.text)
  if (!declaration?.initializer) {
    throw new Error(`LocalityObjectArrayReferenceInvalid:${path}#${propertyName}`)
  }
  return staticArrayInitializer(declaration.initializer, source, path, propertyName, seen)
}

function optionalBooleanProperty(object, name, path) {
  const initializer = objectPropertyInitializer(object, name)
  if (!initializer) return undefined
  const value = unwrap(initializer)
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false
  throw new Error(`LocalityObjectBooleanPropertyInvalid:${path}#${name}`)
}

function objectPropertyInitializer(object, name) {
  const property = object.properties.find((candidate) => {
    if (!ts.isPropertyAssignment(candidate)) return false
    if (ts.isIdentifier(candidate.name) || ts.isStringLiteralLike(candidate.name)) {
      return candidate.name.text === name
    }
    return false
  })
  return property?.initializer
}

function switchCaseVariants(context, path, qualifiedOwner, discriminantText) {
  const source = exactSource(context, path)
  let found = null
  visit(source, (node) => {
    if (found) return
    if (!ts.isMethodDeclaration(node) && !ts.isFunctionDeclaration(node)) return
    if (enclosingOwner(node) !== qualifiedOwner && ownerWithSelf(node) !== qualifiedOwner) return
    const targetSwitch = findNode(
      node,
      (child) =>
        ts.isSwitchStatement(child) && child.expression.getText(source) === discriminantText,
    )
    const values = targetSwitch
      ? targetSwitch.caseBlock.clauses.flatMap((clause) => {
          if (!ts.isCaseClause(clause)) return []
          const value = literalValue(clause.expression)
          return value === undefined ? [] : [value]
        })
      : []
    found = values
  })
  if (!found) throw new Error(`LocalityDispatchOwnerMissing:${path}#${qualifiedOwner}`)
  return [...new Set(found)].sort()
}

function findNode(node, predicate) {
  if (predicate(node)) return node
  let found
  node.forEachChild((child) => {
    if (!found) found = findNode(child, predicate)
  })
  return found
}

function objectLiteralKeys(context, path, variableName) {
  const source = exactSource(context, path)
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== variableName) continue
      const value = unwrap(declaration.initializer)
      if (!value || !ts.isObjectLiteralExpression(value)) {
        throw new Error(`LocalityObjectMapInvalid:${path}#${variableName}`)
      }
      return value.properties.flatMap((property) => {
        if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) return []
        const name = propertyName(property.name)
        return name ? [name] : []
      })
    }
  }
  throw new Error(`LocalityObjectMapMissing:${path}#${variableName}`)
}

function typedOwnerLiteralSites(context, surface, path, qualifiedOwner, returnType, variants) {
  const source = exactSource(context, path)
  const matches = []
  visit(source, (node) => {
    if (!ts.isMethodDeclaration(node) && !ts.isFunctionDeclaration(node)) return
    if (ownerWithSelf(node) !== qualifiedOwner || node.type?.getText(source) !== returnType) return
    const literals = new Map()
    visit(node.body ?? node, (child) => {
      if (!ts.isStringLiteralLike(child) || !variants.includes(child.text)) return
      if (!literals.has(child.text)) literals.set(child.text, child)
    })
    for (const variant of variants) {
      const literal = literals.get(variant)
      if (!literal) continue
      const line = source.getLineAndCharacterOfPosition(literal.getStart(source)).line + 1
      matches.push({
        surface,
        variant,
        path,
        owner: qualifiedOwner,
        line,
        id: `${path}#${qualifiedOwner}|${surface}:${variant}|${line}`,
        status: 'observed',
      })
    }
  })
  if (matches.length !== variants.length) {
    throw new Error(
      `LocalityTypedOwnerLiteralMismatch:${path}#${qualifiedOwner}:${matches.length}/${variants.length}`,
    )
  }
  return matches
}

function compareExact(label, expected, actual, targetProblems) {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  for (const value of [...expectedSet].sort()) {
    if (!actualSet.has(value)) targetProblems.push(`${label}: missing ${value}`)
  }
  for (const value of [...actualSet].sort()) {
    if (!expectedSet.has(value)) targetProblems.push(`${label}: unclassified ${value}`)
  }
  if (expected.length !== expectedSet.size)
    targetProblems.push(`${label}: source contains duplicates`)
  if (actual.length !== actualSet.size)
    targetProblems.push(`${label}: inventory contains duplicates`)
}

function countsBy(values, key) {
  const counts = new Map()
  for (const value of values) counts.set(key(value), (counts.get(key(value)) ?? 0) + 1)
  return counts
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value))
}

function countOccurrences(text, needle) {
  let count = 0
  let offset = 0
  while (true) {
    offset = text.indexOf(needle, offset)
    if (offset === -1) break
    count += 1
    offset += needle.length
  }
  return count
}

function exactSource(context, path) {
  return exactProductionTypeScriptSource(context.program, path, ROOT)
}

function productionSources(context) {
  return productionTypeScriptSources(context.program, ROOT)
}

function relativePath(path) {
  return relative(ROOT, path).split(sep).join('/')
}

function hasExport(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function literalValue(node) {
  if (!node) return undefined
  const value = unwrap(node)
  if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)) return value.text
  return undefined
}

function unwrap(node) {
  let value = node
  while (
    value &&
    (ts.isAsExpression(value) ||
      ts.isSatisfiesExpression(value) ||
      ts.isParenthesizedExpression(value) ||
      ts.isTypeAssertionExpression(value))
  ) {
    value = value.expression
  }
  return value
}

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined
}

function enclosingOwner(node) {
  const names = []
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) || ts.isMethodSignature(current)) {
      names.push(propertyName(current.name) ?? '<computed-method>')
    } else if (ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) {
      if (current.name) names.push(current.name.text)
    } else if (
      (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      names.push(current.parent.name.text)
    }
  }
  return names.reverse().join('.') || '<module>'
}

function ownerWithSelf(node) {
  const self =
    (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name
      ? propertyName(node.name)
      : undefined
  const parent = enclosingOwner(node)
  return [parent === '<module>' ? '' : parent, self].filter(Boolean).join('.')
}

function visit(node, callback) {
  callback(node)
  node.forEachChild((child) => visit(child, callback))
}

function parseArgs(argv) {
  let mode = 'inventory'
  let json = false
  let detail = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--mode') mode = argv[++index]
    else if (arg === '--json') json = true
    else if (arg === '--detail') detail = true
    else throw new Error(`Unknown locality audit argument: ${arg}`)
  }
  if (!['inventory', 'enforce'].includes(mode)) throw new Error(`Invalid locality mode: ${mode}`)
  return { mode, json, detail }
}

export function formatTabCrossTabLocalityReport(report, json = false) {
  if (json) return `${JSON.stringify(report, null, 2)}\n`
  const summary =
    `Tab/cross-tab locality: surfaces=${report.surfaces}, records=${report.records}, ` +
    `sites=${report.constructorSites}, record-gaps=${report.recordGaps}, ` +
    `site-gaps=${report.siteGaps}, architecture-gaps=${report.architectureGaps}.\n`
  return `${summary}${report.problems.map((problem) => `  ${problem}\n`).join('')}`
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2))
  const report = evaluateTabCrossTabLocality(defaultInventory, args.mode, args.detail)
  process.stdout.write(formatTabCrossTabLocalityReport(report, args.json))
  if (!report.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli()
}
