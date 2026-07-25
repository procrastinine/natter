import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { staticAuditState } from './audit-result-state.mjs'
import productionModuleInventory from './production-module-inventory.json' with { type: 'json' }
import * as defaultInventory from './production-work-memory-inventory.mjs'

const COLLECTION_METHODS = new Map(
  [
    ['bulkAdd', ['database-bulk-write', false]],
    ['bulkDelete', ['database-bulk-write', false]],
    ['bulkGet', ['database-bulk-materialization', true]],
    ['bulkPut', ['database-bulk-write', false]],
    ['concat', ['linear-copy', true]],
    ['copyWithin', ['linear-write', false]],
    ['count', ['database-count-pass', false]],
    ['difference', ['set-linear-pass-and-copy', true]],
    ['each', ['database-callback-pass', false]],
    ['eachKey', ['database-callback-pass', false]],
    ['eachPrimaryKey', ['database-callback-pass', false]],
    ['eachUniqueKey', ['database-callback-pass', false]],
    ['entries', ['iterator-or-materialization', false]],
    ['every', ['linear-short-circuit', false]],
    ['fill', ['linear-write', false]],
    ['filter', ['linear-copy', true]],
    ['find', ['linear-short-circuit', false]],
    ['findIndex', ['linear-short-circuit', false]],
    ['findLast', ['linear-short-circuit', false]],
    ['findLastIndex', ['linear-short-circuit', false]],
    ['flat', ['linear-copy', true]],
    ['flatMap', ['linear-copy', true]],
    ['forEach', ['linear-pass', false]],
    ['getAll', ['database-materialization', true]],
    ['getAllKeys', ['database-materialization', true]],
    ['groupBy', ['linear-group-and-copy', true]],
    ['includes', ['linear-short-circuit', false]],
    ['intersection', ['set-linear-pass-and-copy', true]],
    ['isDisjointFrom', ['set-linear-short-circuit', false]],
    ['isSubsetOf', ['set-linear-short-circuit', false]],
    ['isSupersetOf', ['set-linear-short-circuit', false]],
    ['indexOf', ['linear-short-circuit', false]],
    ['join', ['linear-copy', true]],
    ['keys', ['iterator-or-materialization', false]],
    ['lastIndexOf', ['linear-short-circuit', false]],
    ['map', ['linear-copy', true]],
    ['match', ['string-or-regexp-pass', true]],
    ['matchAll', ['string-or-regexp-iterator', false]],
    ['modify', ['database-callback-write-pass', false]],
    ['primaryKeys', ['database-materialization', true]],
    ['reduce', ['linear-pass', false]],
    ['reduceRight', ['linear-pass', false]],
    ['replace', ['string-or-regexp-pass', true]],
    ['replaceAll', ['string-or-regexp-pass', true]],
    ['reverse', ['linear-write', false]],
    ['search', ['string-or-regexp-pass', false]],
    ['slice', ['linear-copy', true]],
    ['some', ['linear-short-circuit', false]],
    ['sort', ['n-log-n-write', false]],
    ['sortBy', ['database-materialization-and-sort', true]],
    ['splice', ['linear-copy-and-write', true]],
    ['split', ['string-pass-and-copy', true]],
    ['toArray', ['whole-query-materialization', true]],
    ['toReversed', ['linear-copy', true]],
    ['toSorted', ['n-log-n-copy', true]],
    ['union', ['set-linear-pass-and-copy', true]],
    ['uniqueKeys', ['database-materialization', true]],
    ['values', ['iterator-or-materialization', false]],
    ['symmetricDifference', ['set-linear-pass-and-copy', true]],
  ].map(([name, [cost, materializes]]) => [name, { cost, materializes }]),
)
const CALLBACK_COLLECTION_METHODS = new Set([
  'Array.from',
  'Array.fromAsync',
  'Map.groupBy',
  'Object.groupBy',
  'each',
  'eachKey',
  'eachPrimaryKey',
  'eachUniqueKey',
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'groupBy',
  'map',
  'modify',
  'reduce',
  'reduceRight',
  'some',
  'sort',
  'toSorted',
])
const STATIC_COLLECTION_CALLS = new Map([
  ['Array.from', { cost: 'iterable-materialization', materializes: true }],
  ['Array.fromAsync', { cost: 'async-iterable-materialization', materializes: true }],
  ['Map.groupBy', { cost: 'iterable-group-and-copy', materializes: true }],
  ['Object.entries', { cost: 'object-enumeration-and-copy', materializes: true }],
  ['Object.fromEntries', { cost: 'iterable-enumeration-and-copy', materializes: true }],
  ['Object.groupBy', { cost: 'iterable-group-and-copy', materializes: true }],
  ['Object.keys', { cost: 'object-enumeration-and-copy', materializes: true }],
  ['Object.values', { cost: 'object-enumeration-and-copy', materializes: true }],
])
const WHOLE_BUFFER_METHODS = new Set(['arrayBuffer', 'blob', 'bytes', 'text'])
const WHOLE_CLONE_BOUNDARY_METHODS = new Map([
  ['bulkAdd', 'database-structured-clone'],
  ['bulkPut', 'database-structured-clone'],
  ['postMessage', 'message-structured-clone'],
  ['put', 'database-structured-clone'],
])
const COLLECTION_CONSTRUCTORS = new Set([
  'Array',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Uint8Array',
  'Uint16Array',
  'Uint32Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'ArrayBuffer',
  'Blob',
  'File',
])
const MATERIALIZING_CONSTRUCTORS = new Set([
  'Array',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Uint8Array',
  'Uint16Array',
  'Uint32Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
])
const GROWTH_METHODS = new Set(['add', 'push', 'set', 'unshift'])
const PROMISE_FANOUT_METHODS = new Set(['all', 'allSettled', 'any', 'race'])
const BOUND_METHODS = new Set(['limit', 'offset', 'slice', 'take'])
const YIELD_CALLS = new Set(['yieldToEventLoop', 'scheduler.yield'])
const WORK_BOUND_TOKENS = new Set([
  'batch',
  'budget',
  'chunk',
  'cursor',
  'limit',
  'offset',
  'overscan',
  'page',
  'quantum',
  'window',
  'yield',
])
const LARGE_LITERAL_MEMBER_COUNT = 32
const VALID_NECESSITIES = new Set([
  'required-domain-work',
  'bounded-infrastructure',
  'likely-accidental',
  'unresolved',
])
const VALID_DECISION_STATUSES = new Set(['accepted', 'gap'])

export function evaluateProductionWorkMemory(config, mode = 'inventory') {
  if (mode !== 'inventory' && mode !== 'enforce') {
    throw new Error(`ProductionWorkMemoryAuditModeInvalid:${mode}`)
  }
  const report = auditProductionWorkMemory(config)
  const structurallyValid = report.problems.length === 0
  return Object.freeze({
    mode,
    ok: structurallyValid && (mode !== 'enforce' || report.gaps.length === 0),
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps: report.gaps }),
    sourceFiles: report.sourceFiles,
    counts: report.counts,
    domainCounts: report.domainCounts,
    layerCounts: report.layerCounts,
    maximumTraversalDepth: report.maximumTraversalDepth,
    sites: report.sites,
    functions: report.functions,
    evidenceLinks: report.evidenceLinks,
    requiredDomainWork: report.requiredDomainWork,
    decisionCounts: report.decisionCounts,
    riskKindCounts: report.riskKindCounts,
    riskStatusCounts: report.riskStatusCounts,
    gaps: report.gaps,
    limitations: report.limitations,
    acceptanceCriteria: report.acceptanceCriteria,
    closureStatus: report.closureStatus,
    problems: report.problems,
  })
}

export function auditProductionWorkMemory({ root, sourceRoot, inventory, moduleInventory }) {
  const problems = []
  const classificationByPath = moduleClassifications(moduleInventory, problems)
  const units = sourceFiles(sourceRoot).map((path) => parseSourceUnit(root, path))
  validateClassificationParity(units, classificationByPath, problems)
  const discovered = scanUnits(units, classificationByPath, problems)
  const evidenceLinks = validateEvidenceLinks(
    inventory.WORK_MEMORY_EVIDENCE_LINKS,
    discovered,
    root,
    problems,
  )
  const decisionByRisk = validateRiskDecisions(
    inventory.WORK_MEMORY_RISK_DECISIONS,
    discovered.riskCandidates,
    problems,
  )
  const requiredDomainWork = validateRequiredDomainWork(
    inventory.REQUIRED_DOMAIN_WORK,
    discovered,
    problems,
  )
  validateAcceptedRiskSupport(
    decisionByRisk,
    discovered.riskCandidates,
    evidenceLinks,
    requiredDomainWork,
    problems,
  )
  const evidenceByOwner = groupBy(evidenceLinks, (entry) => entry.ownerId)
  const signalsByOwner = groupBy(discovered.signals, (entry) => entry.ownerId)
  const sitesByOwner = groupBy(discovered.allSites, (entry) => entry.ownerId)
  const risksByOwner = groupBy(discovered.riskCandidates, (entry) => entry.ownerId)
  const sites = discovered.allSites.map((site) => ({
    ...site,
    localSignals: (signalsByOwner.get(site.ownerId) ?? []).map(signalSummary),
    evidence: (evidenceByOwner.get(site.ownerId) ?? []).map((entry) => entry.id),
  }))
  const gaps = discovered.riskCandidates.map((risk) => {
    const decision = decisionByRisk.get(risk.id)
    return {
      ...risk,
      necessity: decision?.necessity ?? 'unresolved',
      status: decision?.status ?? 'gap',
      rationale:
        decision?.rationale ??
        'No exact source-site decision or measurement proves that this data-dependent work is required and bounded.',
      replacementDirection: decision?.replacementDirection ?? null,
      evidence: (evidenceByOwner.get(risk.ownerId) ?? []).map((entry) => entry.id),
      localSignals: (signalsByOwner.get(risk.ownerId) ?? []).map(signalSummary),
    }
  })
  const activeGaps = gaps.filter((entry) => entry.status === 'gap')
  const functions = [...discovered.functions.values()]
    .map((entry) => {
      const ownedSites = sitesByOwner.get(entry.id) ?? []
      const ownedRisks = risksByOwner.get(entry.id) ?? []
      return {
        ...entry,
        siteCounts: countBy(ownedSites, 'category'),
        maximumTraversalDepth: Math.max(0, ...ownedSites.map((site) => site.traversalDepth ?? 0)),
        riskIds: ownedRisks.map((risk) => risk.id),
        localSignals: (signalsByOwner.get(entry.id) ?? []).map(signalSummary),
        evidence: (evidenceByOwner.get(entry.id) ?? []).map((link) => link.id),
      }
    })
    .sort(compareId)
  const limitations = validateLimitations(inventory.WORK_MEMORY_LIMITATIONS, problems)
  const acceptanceCriteria = validateAcceptanceCriteria(
    inventory.WORK_MEMORY_ACCEPTANCE_CRITERIA,
    problems,
  )
  const explicitlyDecidedRiskIds = new Set()
  for (const candidate of discovered.riskCandidates) {
    if (decisionByRisk.has(candidate.id)) explicitlyDecidedRiskIds.add(candidate.id)
  }
  const closureStatus = {
    ready:
      problems.length === 0 &&
      activeGaps.length === 0 &&
      explicitlyDecidedRiskIds.size === discovered.riskCandidates.length,
    riskCandidates: discovered.riskCandidates.length,
    explicitlyDecidedRiskCandidates: explicitlyDecidedRiskIds.size,
    unreviewedRiskCandidates: discovered.riskCandidates.length - explicitlyDecidedRiskIds.size,
    activeGaps: activeGaps.length,
    unsupportedAcceptedDecisions: problems.filter((problem) =>
      problem.startsWith('decisions-support:'),
    ).length,
  }
  return {
    sourceFiles: units.length,
    counts: {
      explicitLoops: discovered.explicitLoops.length,
      collectionPasses: discovered.collectionPasses.length,
      awaitsInTraversal: discovered.awaitsInTraversal.length,
      promiseFanout: discovered.promiseFanout.length,
      materializations: discovered.materializations.length,
      wholeClones: discovered.wholeClones.length,
      allocations: discovered.allocations.length,
      growthSites: discovered.growthSites.length,
      signals: discovered.signals.length,
      inventoryRecords: discovered.allSites.length,
      exactFunctions: discovered.functions.size,
      nestedTraversalSites: [...discovered.explicitLoops, ...discovered.collectionPasses].filter(
        (entry) => entry.traversalDepth >= 2,
      ).length,
      riskCandidates: discovered.riskCandidates.length,
      activeGaps: activeGaps.length,
    },
    domainCounts: countBy(discovered.allSites, 'domain'),
    layerCounts: countBy(discovered.allSites, 'layer'),
    maximumTraversalDepth: Math.max(
      0,
      ...discovered.explicitLoops.map((entry) => entry.traversalDepth),
      ...discovered.collectionPasses.map((entry) => entry.traversalDepth),
    ),
    sites,
    functions,
    evidenceLinks,
    requiredDomainWork,
    decisionCounts: countBy(gaps, 'necessity'),
    riskKindCounts: countBy(gaps, 'riskKind'),
    riskStatusCounts: countBy(gaps, 'status'),
    gaps: activeGaps,
    limitations,
    acceptanceCriteria,
    closureStatus,
    problems,
  }
}

function scanUnits(units, classificationByPath, problems) {
  const state = {
    explicitLoops: [],
    collectionPasses: [],
    awaitsInTraversal: [],
    promiseFanout: [],
    materializations: [],
    wholeClones: [],
    allocations: [],
    growthSites: [],
    signals: [],
    functions: new Map(),
    counters: new Map(),
  }
  for (const unit of units) {
    const classification = classificationByPath.get(unit.rel)
    if (!classification) {
      problems.push(`modules: source path has no domain/layer classification: ${unit.rel}`)
      continue
    }
    scanNode(unit.source, unit, classification, state, { depth: 0, traversalKinds: [] })
  }
  const allSites = [
    ...state.explicitLoops,
    ...state.collectionPasses,
    ...state.awaitsInTraversal,
    ...state.promiseFanout,
    ...state.materializations,
    ...state.wholeClones,
    ...state.allocations,
    ...state.growthSites,
  ].sort(compareId)
  const riskCandidates = deriveRiskCandidates(state).sort(compareSiteId)
  return { ...state, allSites, riskCandidates }
}

function scanNode(node, unit, classification, state, context) {
  const owner = ownerFor(node, unit.rel)
  rememberFunction(owner, unit, classification, state, node)

  if (isExplicitLoop(node)) {
    const kind = explicitLoopKind(node)
    const site = recordSite(state, unit, classification, owner, node, 'explicit-loop', kind, {
      traversalDepth: context.depth + 1,
      condition: loopConditionText(node, unit.source),
      awaitsBody: containsAwait(loopBody(node)),
    })
    state.explicitLoops.push(site)
    if (ts.isForStatement(node) && node.condition) {
      recordSignal(state, unit, classification, owner, node.condition, 'loop-condition', 'for')
    }
    if (ts.isForStatement(node)) {
      if (node.initializer) scanNode(node.initializer, unit, classification, state, context)
      if (node.condition) scanNode(node.condition, unit, classification, state, context)
      if (node.incrementor) scanNode(node.incrementor, unit, classification, state, context)
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      scanNode(node.initializer, unit, classification, state, context)
      scanNode(node.expression, unit, classification, state, context)
    } else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      scanNode(node.expression, unit, classification, state, context)
    }
    scanNode(loopBody(node), unit, classification, state, {
      depth: context.depth + 1,
      traversalKinds: [...context.traversalKinds, kind],
    })
    return
  }

  if (ts.isCallExpression(node)) {
    const operation = collectionOperation(node)
    if (operation) {
      const site = recordSite(
        state,
        unit,
        classification,
        owner,
        node,
        'collection-pass',
        operation.name,
        {
          traversalDepth: context.depth + 1,
          costShape: operation.cost,
          materializes: operation.materializes,
          receiver: operation.receiver,
        },
      )
      state.collectionPasses.push(site)
      scanNode(node.expression, unit, classification, state, context)
      for (const argument of node.arguments) {
        const callback =
          CALLBACK_COLLECTION_METHODS.has(operation.method) && isFunctionLike(argument)
        scanNode(argument, unit, classification, state, {
          depth: callback ? context.depth + 1 : context.depth,
          traversalKinds: callback
            ? [...context.traversalKinds, operation.name]
            : context.traversalKinds,
        })
      }
      scanCallSpecifics(node, unit, classification, state, context, owner, operation)
      return
    }
    scanCallSpecifics(node, unit, classification, state, context, owner, null)
  }

  if (ts.isAwaitExpression(node) && context.depth > 0) {
    state.awaitsInTraversal.push(
      recordSite(state, unit, classification, owner, node, 'await-in-traversal', 'await', {
        traversalDepth: context.depth,
        enclosingTraversals: [...context.traversalKinds],
      }),
    )
  }
  if (ts.isSpreadElement(node)) {
    const kind = spreadMaterializationKind(node)
    if (kind) {
      state.materializations.push(
        recordSite(state, unit, classification, owner, node, 'materialization', kind, {
          traversalDepth: context.depth,
          sourceShape: expressionShape(node.expression),
        }),
      )
    }
  }
  if (ts.isBindingElement(node) && node.dotDotDotToken) {
    state.materializations.push(
      recordSite(state, unit, classification, owner, node, 'materialization', 'binding-rest', {
        traversalDepth: context.depth,
        sourceShape: oneLine(node.name.getText(unit.source)),
      }),
    )
  }
  if (ts.isSpreadAssignment(node)) {
    state.wholeClones.push(
      recordSite(state, unit, classification, owner, node, 'whole-clone', 'object-spread', {
        traversalDepth: context.depth,
        sourceShape: expressionShape(node.expression),
      }),
    )
  }
  if (ts.isJsxSpreadAttribute(node)) {
    state.wholeClones.push(
      recordSite(state, unit, classification, owner, node, 'whole-clone', 'jsx-spread', {
        traversalDepth: context.depth,
        sourceShape: expressionShape(node.expression),
      }),
    )
  }
  if (ts.isYieldExpression(node) && node.asteriskToken) {
    state.collectionPasses.push(
      recordSite(state, unit, classification, owner, node, 'collection-pass', 'yield-star', {
        traversalDepth: context.depth + 1,
        costShape: 'iterable-delegation',
        materializes: false,
        receiver: node.expression ? oneLine(node.expression.getText(unit.source)) : '<missing>',
      }),
    )
  }
  if (ts.isNewExpression(node)) scanAllocation(node, unit, classification, state, context, owner)
  if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) {
    scanLiteralAllocation(node, unit, classification, state, context, owner)
  }
  if (isPlusEquals(node) && context.depth > 0) {
    state.growthSites.push(
      recordSite(state, unit, classification, owner, node, 'growth', 'plus-equals', {
        traversalDepth: context.depth,
        target: node.left.getText(unit.source).slice(0, 120),
        valueShape: expressionShape(node.right),
      }),
    )
  }
  if (ts.isForStatement(node) && node.condition) {
    recordSignal(state, unit, classification, owner, node.condition, 'loop-condition', 'for')
  }
  if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
    recordWorkBoundNameSignals(node.name, unit, classification, owner, state)
  }
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    recordWorkBoundPropertySignal(node.name, unit, classification, owner, state)
  }
  if (isPropertyAssignmentExpression(node)) {
    recordWorkBoundPropertySignal(node.left.name, unit, classification, owner, state)
  }
  ts.forEachChild(node, (child) => scanNode(child, unit, classification, state, context))
}

function scanCallSpecifics(node, unit, classification, state, context, owner, operation) {
  const callName = qualifiedCallName(node.expression)
  if (callName && isPromiseFanout(callName)) {
    const method = callName.slice('Promise.'.length)
    const input = node.arguments[0]
    state.promiseFanout.push(
      recordSite(state, unit, classification, owner, node, 'promise-fanout', method, {
        traversalDepth: context.depth,
        inputShape: input ? expressionShape(input) : 'missing',
        fixedInputCount: input && ts.isArrayLiteralExpression(input) ? input.elements.length : null,
      }),
    )
  }
  if (operation?.materializes && isWholeMaterializationOperation(operation)) {
    state.materializations.push(
      recordSite(state, unit, classification, owner, node, 'materialization', operation.name, {
        traversalDepth: context.depth,
        sourceShape: operation.receiver,
      }),
    )
  }
  if (
    callName === 'JSON.stringify' ||
    callName === 'JSON.parse' ||
    callName === 'structuredClone' ||
    callName === 'Object.assign'
  ) {
    state.wholeClones.push(
      recordSite(state, unit, classification, owner, node, 'whole-clone', callName, {
        traversalDepth: context.depth,
        sourceShape: node.arguments[0] ? expressionShape(node.arguments[0]) : 'missing',
      }),
    )
  }
  const method = propertyCallName(node.expression)
  const cloneBoundary = method ? WHOLE_CLONE_BOUNDARY_METHODS.get(method) : null
  if (method && cloneBoundary) {
    state.wholeClones.push(
      recordSite(state, unit, classification, owner, node, 'whole-clone', `boundary:${method}`, {
        traversalDepth: context.depth,
        boundary: cloneBoundary,
        sourceShape: node.arguments[0] ? expressionShape(node.arguments[0]) : 'missing',
        hasTransferOrOptionsArgument: node.arguments.length > 1,
      }),
    )
  }
  if (method && WHOLE_BUFFER_METHODS.has(method)) {
    state.materializations.push(
      recordSite(state, unit, classification, owner, node, 'materialization', `buffer:${method}`, {
        traversalDepth: context.depth,
        sourceShape: receiverText(node.expression, unit.source),
      }),
    )
  }
  if (method === 'repeat') {
    state.allocations.push(
      recordSite(state, unit, classification, owner, node, 'allocation', 'string-repeat', {
        traversalDepth: context.depth,
        lifetime: allocationLifetime(node),
        sizeShape: node.arguments[0] ? expressionShape(node.arguments[0]) : 'missing',
      }),
    )
  }
  if (method && GROWTH_METHODS.has(method) && context.depth > 0) {
    state.growthSites.push(
      recordSite(state, unit, classification, owner, node, 'growth', method, {
        traversalDepth: context.depth,
        target: receiverText(node.expression, unit.source),
      }),
    )
  }
  if (method && BOUND_METHODS.has(method)) {
    recordSignal(state, unit, classification, owner, node, 'bound-call', method)
  }
  if (callName && YIELD_CALLS.has(callName)) {
    recordSignal(state, unit, classification, owner, node, 'cooperative-yield', callName)
  }
  if (
    callName === 'throwIfAborted' ||
    method === 'throwIfAborted' ||
    callName?.endsWith('throwIfReadonlyAborted')
  ) {
    recordSignal(state, unit, classification, owner, node, 'cancellation-check', callName ?? method)
  }
}

function scanAllocation(node, unit, classification, state, context, owner) {
  const name = node.expression.getText(unit.source)
  if (!COLLECTION_CONSTRUCTORS.has(name)) return
  const source = node.arguments?.[0]
  state.allocations.push(
    recordSite(state, unit, classification, owner, node, 'allocation', `new:${name}`, {
      traversalDepth: context.depth,
      lifetime: allocationLifetime(node),
      sizeShape: source ? expressionShape(source) : 'empty',
    }),
  )
  if (source && MATERIALIZING_CONSTRUCTORS.has(name)) {
    state.materializations.push(
      recordSite(
        state,
        unit,
        classification,
        owner,
        node,
        'materialization',
        `constructor-input:${name}`,
        {
          traversalDepth: context.depth,
          sourceShape: expressionShape(source),
        },
      ),
    )
  }
}

function scanLiteralAllocation(node, unit, classification, state, context, owner) {
  const memberCount = ts.isArrayLiteralExpression(node)
    ? node.elements.length
    : node.properties.length
  const lifetime = allocationLifetime(node)
  if (
    context.depth === 0 &&
    lifetime === 'function-local' &&
    memberCount < LARGE_LITERAL_MEMBER_COUNT
  ) {
    return
  }
  state.allocations.push(
    recordSite(
      state,
      unit,
      classification,
      owner,
      node,
      'allocation',
      ts.isArrayLiteralExpression(node) ? 'literal:Array' : 'literal:Object',
      {
        traversalDepth: context.depth,
        lifetime,
        sizeShape: `literal-members:${memberCount}`,
      },
    ),
  )
}

function deriveRiskCandidates(state) {
  const risks = []
  for (const site of [...state.explicitLoops, ...state.collectionPasses]) {
    if (site.traversalDepth < 2) continue
    risks.push(risk(site, 'nested-traversal', 'potential-quadratic-or-multiplicative-work'))
  }
  for (const site of state.explicitLoops) {
    if (site.kind === 'while' || site.kind === 'do' || (site.kind === 'for' && !site.condition)) {
      risks.push(risk(site, 'open-ended-loop', 'potential-unbounded-cpu-work'))
    }
  }
  for (const site of state.awaitsInTraversal) {
    risks.push(risk(site, 'serial-await-in-traversal', 'potential-serial-latency-and-lock-hold'))
  }
  for (const site of state.promiseFanout) {
    if (site.fixedInputCount !== null && site.fixedInputCount <= 8) continue
    risks.push(
      risk(site, 'dynamic-promise-fanout', 'potential-unbounded-concurrency-and-peak-memory'),
    )
  }
  for (const site of state.materializations) {
    if (!isMaterializationRisk(site)) continue
    risks.push(risk(site, 'whole-materialization', 'potential-unbounded-materialization'))
  }
  for (const site of state.wholeClones) {
    if (site.kind === 'object-spread' && site.traversalDepth < 2) continue
    risks.push(risk(site, 'whole-clone-or-serialization', 'potential-copy-amplification'))
  }
  for (const site of state.allocations) {
    if (
      site.lifetime === 'function-local' &&
      site.kind !== 'string-repeat' &&
      site.traversalDepth === 0
    )
      continue
    risks.push(risk(site, 'retained-or-large-allocation', 'potential-peak-or-retained-memory'))
  }
  for (const site of state.growthSites) {
    if (site.traversalDepth >= 2) {
      risks.push(risk(site, 'nested-accumulation', 'potential-copy-or-retention-amplification'))
      continue
    }
    if (site.kind === 'plus-equals' && isPotentialStringAccumulation(site)) {
      risks.push(
        risk(site, 'growing-string-in-traversal', 'potential-quadratic-copy-and-peak-memory'),
      )
    }
  }
  return dedupeBy(risks, (entry) => `${entry.siteId}|${entry.riskKind}`)
}

function isMaterializationRisk(site) {
  if (
    site.kind === 'method:toArray' ||
    site.kind === 'method:primaryKeys' ||
    site.kind === 'method:uniqueKeys' ||
    site.kind === 'Array.from' ||
    site.kind.startsWith('buffer:')
  ) {
    return true
  }
  if (site.kind.startsWith('Object.')) return site.traversalDepth > 0
  if (site.kind === 'array-spread') return site.traversalDepth > 0
  return site.traversalDepth > 0
}

function isPotentialStringAccumulation(site) {
  if (
    /(?:metrics|count|index|total|rows|bytes|links|scans|visits|offset|length|chars|tokens|cost|size)/i.test(
      site.target ?? '',
    )
  ) {
    return false
  }
  if (/string-literal|call:.*(?:decode|strFrom|serialize|stringify)/i.test(site.valueShape ?? '')) {
    return true
  }
  return /(?:text|buffer|document|content|output|reasoning|json|line|source|html|css|prompt)/i.test(
    site.target ?? '',
  )
}

function risk(site, riskKind, impact) {
  return {
    id: `${site.id}#risk:${riskKind}`,
    siteId: site.id,
    ownerId: site.ownerId,
    path: site.path,
    line: site.line,
    domain: site.domain,
    layer: site.layer,
    sourceKind: site.category,
    operation: site.kind,
    traversalDepth: site.traversalDepth ?? 0,
    riskKind,
    impact,
  }
}

function recordSite(state, unit, classification, owner, node, category, kind, metadata) {
  const key = `${unit.rel}|${owner.name}|${category}|${kind}`
  const ordinal = (state.counters.get(key) ?? 0) + 1
  state.counters.set(key, ordinal)
  return {
    id: `${key}|${ordinal}`,
    ownerId: owner.id,
    path: unit.rel,
    owner: owner.name,
    domain: classification.domain,
    layer: classification.layer,
    category,
    kind,
    ordinal,
    line: lineOf(unit.source, node),
    excerpt: oneLine(node.getText(unit.source)),
    ...metadata,
  }
}

function recordSignal(state, unit, classification, owner, node, category, kind) {
  const signal = recordSite(
    state,
    unit,
    classification,
    owner,
    node,
    'local-signal',
    `${category}:${kind}`,
    {
      signalCategory: category,
      signalKind: kind,
    },
  )
  state.signals.push(signal)
}

function rememberFunction(owner, unit, classification, state, node) {
  if (state.functions.has(owner.id)) return
  state.functions.set(owner.id, {
    id: owner.id,
    path: unit.rel,
    owner: owner.name,
    domain: classification.domain,
    layer: classification.layer,
    firstObservedLine: lineOf(unit.source, node),
  })
}

function validateEvidenceLinks(rows, discovered, root, problems) {
  if (!Array.isArray(rows)) {
    problems.push('evidence: WORK_MEMORY_EVIDENCE_LINKS must be an array')
    return []
  }
  const ownerIds = new Set(discovered.functions.keys())
  const sitesById = new Map(discovered.allSites.map((site) => [site.id, site]))
  const ids = new Set()
  const valid = []
  for (const row of rows) {
    const prefix = `evidence:${row?.id ?? '<missing>'}`
    if (!isRecord(row) || !nonEmpty(row.id)) {
      problems.push('evidence: row missing id')
      continue
    }
    if (ids.has(row.id)) problems.push(`${prefix}: duplicate id`)
    ids.add(row.id)
    if (!nonEmpty(row.ownerId) || !ownerIds.has(row.ownerId)) {
      problems.push(`${prefix}: stale owner: ${row.ownerId}`)
    }
    if (row.siteIds !== undefined) {
      if (!Array.isArray(row.siteIds) || row.siteIds.length === 0) {
        problems.push(`${prefix}: siteIds must be a non-empty array when present`)
      } else {
        for (const siteId of row.siteIds) {
          const site = sitesById.get(siteId)
          if (!site) problems.push(`${prefix}: stale site: ${siteId}`)
          else if (site.ownerId !== row.ownerId) {
            problems.push(`${prefix}: site owner mismatch: ${siteId}`)
          }
        }
      }
    }
    for (const field of ['testPath', 'testLocator', 'proof']) {
      if (!nonEmpty(row[field])) problems.push(`${prefix}: ${field} must be non-empty`)
    }
    if (!Array.isArray(row.assertionLocators) || row.assertionLocators.length === 0) {
      problems.push(`${prefix}: assertionLocators must be non-empty`)
      continue
    }
    const testPath = nonEmpty(row.testPath) ? resolve(root, row.testPath) : null
    let text = ''
    try {
      text = testPath ? readFileSync(testPath, 'utf8') : ''
    } catch {
      problems.push(`${prefix}: test path missing: ${row.testPath}`)
      continue
    }
    validateExactLocator(text, row.testLocator, `${prefix}:testLocator`, problems)
    for (const locator of row.assertionLocators) {
      validateExactLocator(text, locator, `${prefix}:assertionLocator`, problems)
    }
    valid.push({ ...row })
  }
  return valid.sort(compareId)
}

function validateRiskDecisions(rows, risks, problems) {
  if (!Array.isArray(rows)) {
    problems.push('decisions: WORK_MEMORY_RISK_DECISIONS must be an array')
    return new Map()
  }
  const riskIds = new Set(risks.map((entry) => entry.id))
  const decisions = new Map()
  for (const row of rows) {
    const decisionId =
      nonEmpty(row?.siteId) && nonEmpty(row?.riskKind)
        ? `${row.siteId}#risk:${row.riskKind}`
        : '<missing>'
    const prefix = `decisions:${decisionId}`
    if (!isRecord(row) || !nonEmpty(row.siteId) || !nonEmpty(row.riskKind)) {
      problems.push('decisions: row missing siteId or riskKind')
      continue
    }
    if (!riskIds.has(decisionId)) problems.push(`${prefix}: stale exact risk`)
    if (decisions.has(decisionId)) problems.push(`${prefix}: duplicate decision`)
    if (!VALID_NECESSITIES.has(row.necessity)) problems.push(`${prefix}: invalid necessity`)
    if (!VALID_DECISION_STATUSES.has(row.status)) problems.push(`${prefix}: invalid status`)
    if (!nonEmpty(row.rationale)) problems.push(`${prefix}: rationale must be non-empty`)
    if (row.status === 'gap' && !nonEmpty(row.replacementDirection)) {
      problems.push(`${prefix}: gap requires replacementDirection`)
    }
    decisions.set(decisionId, row)
  }
  return decisions
}

function validateRequiredDomainWork(rows, discovered, problems) {
  if (!Array.isArray(rows)) {
    problems.push('required-work: REQUIRED_DOMAIN_WORK must be an array')
    return []
  }
  const sites = new Set(discovered.allSites.map((entry) => entry.id))
  const ids = new Set()
  const output = []
  for (const row of rows) {
    const prefix = `required-work:${row?.id ?? '<missing>'}`
    if (!isRecord(row) || !nonEmpty(row.id)) {
      problems.push('required-work: row missing id')
      continue
    }
    if (ids.has(row.id)) problems.push(`${prefix}: duplicate id`)
    ids.add(row.id)
    if (!Array.isArray(row.siteIds) || row.siteIds.length === 0) {
      problems.push(`${prefix}: siteIds must be non-empty`)
      continue
    }
    for (const siteId of row.siteIds)
      if (!sites.has(siteId)) problems.push(`${prefix}: stale site: ${siteId}`)
    for (const field of ['requirement', 'minimumWork', 'boundingStrategy']) {
      if (!nonEmpty(row[field])) problems.push(`${prefix}: ${field} must be non-empty`)
    }
    if (typeof row.allowsFixedTranscriptMaximum !== 'boolean') {
      problems.push(`${prefix}: allowsFixedTranscriptMaximum must be boolean`)
    } else if (row.allowsFixedTranscriptMaximum) {
      problems.push(`${prefix}: fixed transcript/message maxima are forbidden`)
    }
    output.push({ ...row })
  }
  return output.sort(compareId)
}

function validateAcceptedRiskSupport(decisions, risks, evidenceLinks, requiredWork, problems) {
  const risksById = new Map(risks.map((entry) => [entry.id, entry]))
  const evidenceSiteIds = new Set(evidenceLinks.flatMap((entry) => entry.siteIds ?? []))
  const requiredSiteIds = new Set(requiredWork.flatMap((entry) => entry.siteIds))
  for (const [riskId, decision] of decisions) {
    const risk = risksById.get(riskId)
    if (decision.status !== 'accepted' || !risk) continue
    const { siteId } = risk
    if (evidenceSiteIds.has(siteId) || requiredSiteIds.has(siteId)) continue
    problems.push(
      `decisions-support:${siteId}: accepted risk needs an exact evidence siteId or required-work siteId`,
    )
  }
}

function validateAcceptanceCriteria(rows, problems) {
  if (!Array.isArray(rows) || rows.length === 0) {
    problems.push('acceptance: WORK_MEMORY_ACCEPTANCE_CRITERIA must be a non-empty array')
    return []
  }
  const ids = new Set()
  const output = []
  for (const row of rows) {
    const prefix = `acceptance:${row?.id ?? '<missing>'}`
    if (!isRecord(row) || !nonEmpty(row.id)) {
      problems.push('acceptance: every row needs an id')
      continue
    }
    if (ids.has(row.id)) problems.push(`${prefix}: duplicate id`)
    ids.add(row.id)
    for (const field of ['requirement', 'automatedCheck', 'closureCondition']) {
      if (!nonEmpty(row[field])) problems.push(`${prefix}: ${field} must be non-empty`)
    }
    output.push({ ...row })
  }
  return output.sort(compareId)
}

function validateLimitations(rows, problems) {
  if (!Array.isArray(rows) || rows.length === 0) {
    problems.push('limitations: WORK_MEMORY_LIMITATIONS must be a non-empty array')
    return []
  }
  const ids = new Set()
  for (const row of rows) {
    if (!isRecord(row) || !nonEmpty(row.id) || !nonEmpty(row.statement)) {
      problems.push('limitations: every row needs id and statement')
      continue
    }
    if (ids.has(row.id)) problems.push(`limitations: duplicate id: ${row.id}`)
    ids.add(row.id)
  }
  return rows
}

function moduleClassifications(moduleInventory, problems) {
  const result = new Map()
  if (!Array.isArray(moduleInventory?.classifications)) {
    problems.push('modules: classifications must be an array')
    return result
  }
  for (const classification of moduleInventory.classifications) {
    if (!nonEmpty(classification.domain) || !nonEmpty(classification.layer)) {
      problems.push('modules: classification missing domain/layer')
      continue
    }
    for (const path of classification.paths ?? []) {
      if (result.has(path)) problems.push(`modules: duplicate classification: ${path}`)
      result.set(path, { domain: classification.domain, layer: classification.layer })
    }
  }
  return result
}

function validateClassificationParity(units, classifications, problems) {
  const sourcePaths = new Set(units.map((unit) => unit.rel))
  for (const path of classifications.keys()) {
    if (!sourcePaths.has(path))
      problems.push(`modules: classified path is not production source: ${path}`)
  }
}

function parseArgs(argv) {
  const parsed = {
    root: null,
    inventory: null,
    moduleInventory: null,
    mode: 'inventory',
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (
      arg === '--root' ||
      arg === '--inventory' ||
      arg === '--module-inventory' ||
      arg === '--mode'
    ) {
      const value = argv[index + 1]
      if (!value) throw new Error(`Missing value for ${arg}`)
      if (arg === '--root') parsed.root = resolve(value)
      else if (arg === '--inventory') parsed.inventory = resolve(value)
      else if (arg === '--module-inventory') parsed.moduleInventory = resolve(value)
      else if (value === 'inventory' || value === 'enforce') parsed.mode = value
      else throw new Error(`Invalid work/memory audit mode: ${value}`)
      index += 1
      continue
    }
    throw new Error(`Unknown work/memory audit argument: ${arg}`)
  }
  return parsed
}

function sourceFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...sourceFiles(path))
    else if (extname(path) === '.ts' || extname(path) === '.tsx') files.push(path)
  }
  return files
}

function parseSourceUnit(root, path) {
  const rel = relative(root, path).split(sep).join('/')
  return {
    rel,
    source: ts.createSourceFile(
      rel,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    ),
  }
}

function ownerFor(node, path) {
  for (let current = node; current; current = current.parent) {
    if (!isFunctionLike(current)) continue
    const name = functionName(current)
    if (name) return { id: `${path}#${name}`, name }
  }
  return { id: `${path}#<module>`, name: '<module>' }
}

function functionName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text
  if (ts.isFunctionExpression(node) && node.name) return node.name.text
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    const own = propertyName(node.name)
    if (!own) return null
    const parent = node.parent
    return ts.isClassLike(parent) && parent.name ? `${parent.name.text}.${own}` : own
  }
  if (ts.isConstructorDeclaration(node)) {
    const parent = node.parent
    return ts.isClassLike(parent) && parent.name ? `${parent.name.text}.constructor` : 'constructor'
  }
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) {
    const own = propertyName(parent.name)
    if (!own) return null
    const container = parent.parent
    return ts.isClassLike(container) && container.name ? `${container.name.text}.${own}` : own
  }
  return null
}

function collectionOperation(node) {
  const staticName = qualifiedCallName(node.expression)
  const staticOperation = staticName ? STATIC_COLLECTION_CALLS.get(staticName) : null
  if (staticOperation) {
    return {
      name: staticName,
      method: staticName,
      receiver: staticName.split('.')[0],
      ...staticOperation,
    }
  }
  const method = propertyCallName(node.expression)
  const operation = method ? COLLECTION_METHODS.get(method) : null
  if (!method || !operation) return null
  return {
    name: `method:${method}`,
    method,
    receiver: receiverText(node.expression, node.getSourceFile()),
    ...operation,
  }
}

function isWholeMaterializationOperation(operation) {
  return (
    operation.name === 'Array.from' ||
    operation.name === 'Array.fromAsync' ||
    operation.name === 'Map.groupBy' ||
    operation.name.startsWith('Object.') ||
    operation.cost.includes('database-materialization') ||
    operation.cost.includes('database-bulk-materialization') ||
    operation.name === 'method:toArray'
  )
}

function qualifiedCallName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (
    ts.isPropertyAccessExpression(expression) &&
    (ts.isIdentifier(expression.expression) || ts.isPropertyAccessExpression(expression.expression))
  ) {
    return `${expression.expression.getText()}.${expression.name.text}`
  }
  return null
}

function propertyCallName(expression) {
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : null
}

function receiverText(expression, source) {
  return ts.isPropertyAccessExpression(expression)
    ? oneLine(expression.expression.getText(source)).slice(0, 160)
    : '<unknown>'
}

function isPromiseFanout(callName) {
  return callName.startsWith('Promise.') && PROMISE_FANOUT_METHODS.has(callName.slice(8))
}

function isExplicitLoop(node) {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  )
}

function explicitLoopKind(node) {
  if (ts.isForStatement(node)) return 'for'
  if (ts.isForInStatement(node)) return 'for-in'
  if (ts.isForOfStatement(node)) return node.awaitModifier ? 'for-await-of' : 'for-of'
  if (ts.isWhileStatement(node)) return 'while'
  return 'do'
}

function loopBody(node) {
  return node.statement
}

function loopConditionText(node, source) {
  if (ts.isForStatement(node))
    return node.condition ? oneLine(node.condition.getText(source)) : null
  if (ts.isWhileStatement(node) || ts.isDoStatement(node))
    return oneLine(node.expression.getText(source))
  return null
}

function containsAwait(node) {
  let found = false
  const visit = (current) => {
    if (found || (current !== node && isFunctionLike(current))) return
    if (ts.isAwaitExpression(current)) {
      found = true
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

function allocationLifetime(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isPropertyDeclaration(current)) return 'class-instance'
    if (ts.isCallExpression(current) && qualifiedCallName(current.expression) === 'useRef') {
      return 'hook-instance'
    }
    if (isFunctionLike(current)) return 'function-local'
    if (ts.isSourceFile(current)) return 'module'
  }
  return 'unknown'
}

function isPlusEquals(node) {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
}

function spreadMaterializationKind(node) {
  if (ts.isArrayLiteralExpression(node.parent)) return 'array-spread'
  if (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent)) {
    return 'argument-spread'
  }
  return null
}

function isPropertyAssignmentExpression(node) {
  return (
    ts.isBinaryExpression(node) &&
    ts.isPropertyAccessExpression(node.left) &&
    isAssignmentOperator(node.operatorToken.kind)
  )
}

function isAssignmentOperator(kind) {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  )
}

function recordWorkBoundNameSignals(name, unit, classification, owner, state) {
  for (const identifier of bindingIdentifiers(name)) {
    const tokens = workBoundTokens(identifier.text)
    if (tokens.length === 0) continue
    recordSignal(
      state,
      unit,
      classification,
      owner,
      identifier,
      'work-bound-name',
      `${identifier.text}:${tokens.join('+')}`,
    )
  }
}

function recordWorkBoundPropertySignal(name, unit, classification, owner, state) {
  const text = propertyName(name)
  if (!text) return
  const tokens = workBoundTokens(text)
  if (tokens.length === 0) return
  recordSignal(
    state,
    unit,
    classification,
    owner,
    name,
    'work-bound-property',
    `${text}:${tokens.join('+')}`,
  )
}

function bindingIdentifiers(name) {
  if (ts.isIdentifier(name)) return [name]
  const identifiers = []
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue
    identifiers.push(...bindingIdentifiers(element.name))
  }
  return identifiers
}

function workBoundTokens(name) {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter(Boolean)
  return [...new Set(words.filter((word) => WORK_BOUND_TOKENS.has(word)))]
}

function expressionShape(node) {
  if (ts.isArrayLiteralExpression(node)) return `array-literal:${node.elements.length}`
  if (ts.isObjectLiteralExpression(node)) return `object-literal:${node.properties.length}`
  if (ts.isIdentifier(node)) return `identifier:${node.text}`
  if (ts.isStringLiteralLike(node)) return `string-literal:${node.text.length}`
  if (ts.isNumericLiteral(node)) return `number-literal:${node.text}`
  if (ts.isCallExpression(node))
    return `call:${qualifiedCallName(node.expression) ?? propertyCallName(node.expression) ?? '<dynamic>'}`
  if (ts.isPropertyAccessExpression(node)) return `property:${node.name.text}`
  return ts.SyntaxKind[node.kind] ?? 'unknown'
}

function isFunctionLike(node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  )
}

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : null
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240)
}

function signalSummary(signal) {
  return {
    id: signal.id,
    line: signal.line,
    category: signal.signalCategory,
    kind: signal.signalKind,
  }
}

function validateExactLocator(text, locator, prefix, problems) {
  if (!nonEmpty(locator)) {
    problems.push(`${prefix}: locator must be non-empty`)
    return
  }
  const count = text.split(locator).length - 1
  if (count !== 1) problems.push(`${prefix}: locator occurrences=${count}; expected=1: ${locator}`)
}

function groupBy(rows, keyFor) {
  const map = new Map()
  for (const row of rows) {
    const key = keyFor(row)
    const group = map.get(key) ?? []
    group.push(row)
    map.set(key, group)
  }
  return map
}

function countBy(rows, key) {
  const counts = {}
  for (const row of rows) counts[row[key]] = (counts[row[key]] ?? 0) + 1
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  )
}

function dedupeBy(rows, keyFor) {
  const map = new Map()
  for (const row of rows) map.set(keyFor(row), row)
  return [...map.values()]
}

function compareId(left, right) {
  return left.id.localeCompare(right.id)
}

function compareSiteId(left, right) {
  return left.siteId.localeCompare(right.siteId) || left.riskKind.localeCompare(right.riskKind)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2))
  const root = args.root ?? resolve(import.meta.dirname, '..')
  const inventory = args.inventory
    ? await import(`${pathToFileURL(args.inventory).href}?audit=${Date.now()}`)
    : defaultInventory
  const moduleInventory = args.moduleInventory
    ? JSON.parse(readFileSync(args.moduleInventory, 'utf8'))
    : productionModuleInventory
  const output = evaluateProductionWorkMemory(
    {
      root,
      sourceRoot: join(root, 'src'),
      inventory,
      moduleInventory,
    },
    args.mode,
  )
  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } else {
    process.stdout.write(
      `Production work/memory inventory: files=${output.sourceFiles}, loops=${output.counts.explicitLoops}, passes=${output.counts.collectionPasses}, max-depth=${output.maximumTraversalDepth}, awaits-in-traversal=${output.counts.awaitsInTraversal}, promise-fanout=${output.counts.promiseFanout}, materializations=${output.counts.materializations}, clones=${output.counts.wholeClones}, allocations=${output.counts.allocations}, growth=${output.counts.growthSites}, risks=${output.gaps.length}, structural-problems=${output.problems.length}.\n`,
    )
  }
  if (!output.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli()
}
