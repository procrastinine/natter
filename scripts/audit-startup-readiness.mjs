import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { staticAuditState } from './audit-result-state.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DEFAULT_INVENTORY = resolve(ROOT, 'scripts/startup-readiness-inventory.mjs')
const REQUIRED_STAGE_IDS = Object.freeze([
  'lifecycle-owner-installed',
  'storage-administration-responder-installed',
  'nonblocking-root-presentation',
  'storage-administration-presence',
  'database-selection',
  'database-bootstrap',
  'runtime-reconciliation-begin',
  'database-selection-activation',
  'core-resource-readiness',
  'capability-admissions-attached',
  'workspace-running-commit',
  'eligible-background-activation',
  'opening-status-retired',
])
const REQUIRED_ENTRY_PATH_IDS = Object.freeze([
  'terminally-sealed',
  'already-running',
  'inflight-terminal-request',
  'inflight-open-reuse',
  'cancelled-open-followup',
  'new-open-authority',
  'quiescing-drain',
  'unified-stable-open',
  'fatal-open-terminal-cleanup',
])
const REQUIRED_REOPEN_STAGE_IDS = Object.freeze([
  'reopen-inflight-quiesce-drain',
  'reopen-unified-state-gate',
  'reopen-database-selection',
  'reopen-database-bootstrap',
  'reopen-reconciliation-begin',
  'reopen-selection-activation',
  'reopen-core-resource-readiness',
  'reopen-capability-commit',
])
const REQUIRED_HIDDEN_LIFECYCLE_STAGE_IDS = Object.freeze([
  'fallback-verification-admitted',
  'fallback-lifecycle-listeners-armed',
  'pageshow-catch-up-listener',
  'visibility-catch-up-listener',
  'visible-only-durable-verification',
  'foreground-verification-request',
])
const REQUIRED_CAPABILITY_IDS = Object.freeze([
  'opening-status',
  'recovery-controls',
  'shell-chrome',
  'navigation-and-new-chat',
  'background-new-chat-first-activation',
  'sidebar-browse',
  'configuration-panels',
  'active-transcript',
  'composer-draft',
  'durable-write-admission',
  'active-stream-control',
  'orphan-stream-recovery',
  'storage-compaction-and-retention',
  'cross-tab-change-delivery',
])
const REQUIRED_GAP_IDS = Object.freeze([])
const VALID_CAPABILITY_GATES = new Set([
  'bootstrap-mounted',
  'open-failed-or-blocked',
  'workspace-demand-boundary',
  'sidebar-first-page',
  'active-configuration',
  'route-terminal',
  'generation-admission-ready',
  'active-stop',
  'stream-recovery-ready',
  'broadcast-remote-inbound-ready',
])

export function evaluateStartupReadiness(
  root,
  inventoryModule,
  mode = 'inventory',
  initialProblems = [],
) {
  if (mode !== 'inventory' && mode !== 'enforce') {
    throw new Error(`StartupReadinessAuditModeInvalid:${mode}`)
  }
  const report = auditStartupReadiness(root, inventoryModule, initialProblems)
  const structurallyValid = report.problems.length === 0
  return Object.freeze({
    mode,
    ok: structurallyValid && (mode !== 'enforce' || report.gaps.length === 0),
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps: report.gaps }),
    stageCount: report.stageCount,
    entryPathCount: report.entryPathCount,
    reopenStageCount: report.reopenStageCount,
    hiddenLifecycleStageCount: report.hiddenLifecycleStageCount,
    resourceCount: report.resourceCount,
    resourceActivationHookCount: report.resourceActivationHookCount,
    reconciliationParticipantCount: report.reconciliationParticipantCount,
    capabilityCount: report.capabilityCount,
    gapCount: report.gaps.length,
    acceptanceCount: report.acceptanceCount,
    gaps: report.gaps,
    resources: report.resources,
    reconciliationParticipants: report.reconciliationParticipants,
    problems: report.problems,
  })
}

export function auditStartupReadiness(root, inventoryModule, initialProblems = []) {
  const problems = [...initialProblems]
  const stages = inventoryModule?.STARTUP_OPEN_SEQUENCE
  const entryPaths = inventoryModule?.STARTUP_ENTRY_PATHS
  const reopenStages = inventoryModule?.UNIFIED_REOPEN_SEQUENCE
  const hiddenLifecycleStages = inventoryModule?.HIDDEN_LIFECYCLE_SEQUENCE
  const resources = inventoryModule?.STARTUP_RUNTIME_RESOURCES
  const reconciliationParticipants = inventoryModule?.STARTUP_RECONCILIATION_PARTICIPANTS
  const capabilities = inventoryModule?.STARTUP_CAPABILITIES
  const gaps = inventoryModule?.STARTUP_READINESS_GAPS
  const acceptance = inventoryModule?.STARTUP_READINESS_ACCEPTANCE

  validateExactIds(stages, REQUIRED_STAGE_IDS, 'stages', problems)
  validateExactIds(entryPaths, REQUIRED_ENTRY_PATH_IDS, 'entry-paths', problems)
  validateExactIds(reopenStages, REQUIRED_REOPEN_STAGE_IDS, 'reopen-stages', problems)
  validateExactIds(
    hiddenLifecycleStages,
    REQUIRED_HIDDEN_LIFECYCLE_STAGE_IDS,
    'hidden-lifecycle-stages',
    problems,
  )
  validateExactIds(capabilities, REQUIRED_CAPABILITY_IDS, 'capabilities', problems)
  validateExactIds(gaps, REQUIRED_GAP_IDS, 'gaps', problems)
  validateSourceLocators(stages, 'stages', root, problems)
  validateSourceLocators(entryPaths, 'entry-paths', root, problems)
  validateSourceLocators(reopenStages, 'reopen-stages', root, problems)
  validateSourceLocators(hiddenLifecycleStages, 'hidden-lifecycle-stages', root, problems)
  validateSourceLocators(capabilities, 'capabilities', root, problems)
  validateSourceLocators(gaps, 'gaps', root, problems)
  validateSourceOrder(stages, 'stages', root, problems)
  validateSourceOrder(reopenStages, 'reopen-stages', root, problems)
  validateSourceOrder(hiddenLifecycleStages, 'hidden-lifecycle-stages', root, problems)

  const discovered = discoverRuntimeResources(root, problems)
  validateResources(resources, discovered.resources, problems)
  validateReconciliationParticipants(
    reconciliationParticipants,
    discovered.reconciliationParticipants,
    problems,
  )
  validateCapabilities(capabilities, problems)
  validateAcceptance(acceptance, problems)

  const normalizedGaps = Array.isArray(gaps)
    ? gaps
        .filter(isRecord)
        .map((gap) => ({ id: gap.id, rationale: gap.rationale, path: gap.path }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    : []
  problems.sort()
  return {
    stageCount: Array.isArray(stages) ? stages.length : 0,
    entryPathCount: Array.isArray(entryPaths) ? entryPaths.length : 0,
    reopenStageCount: Array.isArray(reopenStages) ? reopenStages.length : 0,
    hiddenLifecycleStageCount: Array.isArray(hiddenLifecycleStages)
      ? hiddenLifecycleStages.length
      : 0,
    resourceCount: Array.isArray(resources) ? resources.length : 0,
    resourceActivationHookCount: Array.isArray(resources)
      ? resources.filter((resource) => resource?.hooks?.includes('activate')).length
      : 0,
    reconciliationParticipantCount: Array.isArray(reconciliationParticipants)
      ? reconciliationParticipants.length
      : 0,
    capabilityCount: Array.isArray(capabilities) ? capabilities.length : 0,
    acceptanceCount: Array.isArray(acceptance) ? acceptance.length : 0,
    gaps: normalizedGaps,
    resources: normalizeOwners(resources),
    reconciliationParticipants: normalizeOwners(reconciliationParticipants),
    problems,
  }
}

function parseArgs(argv) {
  const parsed = { inventory: DEFAULT_INVENTORY, mode: 'inventory', json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg !== '--inventory' && arg !== '--mode') {
      throw new Error(`Unknown startup-readiness argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    if (arg === '--inventory') parsed.inventory = resolve(value)
    else {
      if (value !== 'inventory' && value !== 'enforce') {
        throw new Error(`Invalid startup-readiness mode: ${value}`)
      }
      parsed.mode = value
    }
    index += 1
  }
  return parsed
}

function validateExactIds(entries, expected, label, problems) {
  if (!Array.isArray(entries)) {
    problems.push(`${label}: must be an array`)
    return
  }
  const ids = entries.map((entry) => entry?.id)
  for (const duplicate of duplicates(ids)) problems.push(`${label}: duplicate id: ${duplicate}`)
  for (const stale of difference(ids, expected)) problems.push(`${label}: stale id: ${stale}`)
  for (const missing of difference(expected, ids)) problems.push(`${label}: missing id: ${missing}`)
  if (
    ['stages', 'entry-paths', 'reopen-stages', 'hidden-lifecycle-stages'].includes(label) &&
    ids.join('\0') !== expected.join('\0')
  ) {
    problems.push(`${label}: canonical order changed`)
  }
}

function validateSourceLocators(entries, label, root, problems) {
  if (!Array.isArray(entries)) return
  for (const entry of entries) {
    if (!isRecord(entry) || !isNonEmptyString(entry.id)) continue
    const prefix = `${label}:${entry.id}`
    if (!isNonEmptyString(entry.path) || !isExactRepoPath(entry.path)) {
      problems.push(`${prefix}: invalid exact source path: ${entry.path}`)
      continue
    }
    const absolute = resolve(root, entry.path)
    const relativePath = relative(root, absolute)
    if (relativePath.startsWith('..') || isAbsolute(relativePath) || !existsSync(absolute)) {
      problems.push(`${prefix}: source path does not exist: ${entry.path}`)
      continue
    }
    if (!isNonEmptyString(entry.locator)) {
      problems.push(`${prefix}: locator must be non-empty`)
      continue
    }
    const count = countOccurrences(readFileSync(absolute, 'utf8'), entry.locator)
    if (count !== 1) problems.push(`${prefix}: locator occurrences=${count}; expected=1`)
    if (!isNonEmptyString(entry.rationale ?? entry.readinessClass)) {
      problems.push(`${prefix}: rationale or readinessClass must be non-empty`)
    }
  }
}

function validateSourceOrder(stages, label, root, problems) {
  if (!Array.isArray(stages)) return
  const byPath = Map.groupBy(
    stages.filter((stage) => isRecord(stage) && isNonEmptyString(stage.path)),
    (stage) => stage.path,
  )
  for (const [path, pathStages] of byPath) {
    if (pathStages.length < 2) continue
    const source = readFileSync(resolve(root, path), 'utf8')
    let previous = -1
    for (const stage of pathStages) {
      const index = source.indexOf(stage.locator)
      if (index <= previous) {
        problems.push(`${label}:${stage.id}: source order is not strictly increasing`)
      }
      previous = index
    }
  }
}

function discoverRuntimeResources(root, problems) {
  const controlPath = resolve(root, 'src/store/workspace-runtime-control.ts')
  const lifecyclePath = resolve(root, 'src/store/browser-workspace-lifecycle.ts')
  const broadcastPath = resolve(root, 'src/store/broadcast.ts')
  const resourceIds = discoverStringArray(
    controlPath,
    'WORKSPACE_RUNTIME_RESOURCE_IDS',
    'resources',
    problems,
  )
  const participantIds = discoverStringArray(
    controlPath,
    'WORKSPACE_RUNTIME_RECONCILIATION_PARTICIPANT_IDS',
    'reconciliation-participants',
    problems,
  )
  const broadcastObject = discoverNamedObjectLiteral(
    broadcastPath,
    'broadcastWorkspaceRuntimeResources',
    'resources',
    problems,
  )
  const broadcastEntries = objectLiteralEntries(
    broadcastObject,
    'src/store/broadcast.ts',
    new Map(),
    'resources',
    problems,
  )
  const installed = discoverInstalledManifestLiterals(lifecyclePath, problems)
  const lifecycleEntries = objectLiteralEntries(
    installed.resources,
    'src/store/browser-workspace-lifecycle.ts',
    new Map([['broadcastWorkspaceRuntimeResources', broadcastEntries]]),
    'resources',
    problems,
  )
  const participantEntries = objectLiteralEntries(
    installed.reconciliationParticipants,
    'src/store/browser-workspace-lifecycle.ts',
    new Map(),
    'reconciliation-participants',
    problems,
  )
  const resources = new Map()
  for (const [id, entry] of lifecycleEntries) {
    if (resources.has(id)) problems.push(`resources: installed duplicate resource: ${id}`)
    resources.set(id, entry)
  }
  const discoveredResources = new Map()
  for (const id of resourceIds) {
    const entry = resources.get(id)
    if (!entry) {
      problems.push(`resources:${id}: missing installed resource object`)
      continue
    }
    const phase = stringProperty(entry.object, 'phase')
    const hooks = ['resume', 'attach', 'activate'].filter((hook) => hasProperty(entry.object, hook))
    discoveredResources.set(id, { id, phase, hooks, owner: entry.owner })
  }
  for (const stale of difference(resources.keys(), resourceIds)) {
    problems.push(`resources: installed stale resource: ${stale}`)
  }
  const discoveredParticipants = new Map()
  for (const id of participantIds) {
    const entry = participantEntries.get(id)
    if (!entry) {
      problems.push(`reconciliation-participants:${id}: missing installed participant object`)
      continue
    }
    const hooks = ['reconcile'].filter((hook) => hasProperty(entry.object, hook))
    discoveredParticipants.set(id, { id, hooks, owner: entry.owner })
  }
  for (const stale of difference(participantEntries.keys(), participantIds)) {
    problems.push(`reconciliation-participants: installed stale participant: ${stale}`)
  }
  return {
    resources: discoveredResources,
    reconciliationParticipants: discoveredParticipants,
  }
}

function validateResources(resources, discovered, problems) {
  if (!Array.isArray(resources)) {
    problems.push('resources: must be an array')
    return
  }
  const byId = new Map()
  for (const resource of resources) {
    if (!isRecord(resource) || !isNonEmptyString(resource.id)) {
      problems.push('resources: invalid entry')
      continue
    }
    if (byId.has(resource.id)) problems.push(`resources: duplicate id: ${resource.id}`)
    byId.set(resource.id, resource)
  }
  for (const stale of difference(byId.keys(), discovered.keys()))
    problems.push(`resources: stale id: ${stale}`)
  for (const missing of difference(discovered.keys(), byId.keys()))
    problems.push(`resources: missing id: ${missing}`)
  for (const [id, actual] of discovered) {
    const declared = byId.get(id)
    if (!declared) continue
    if (declared.phase !== actual.phase) {
      problems.push(`resources:${id}: phase=${declared.phase}; source=${actual.phase}`)
    }
    if (declared.owner !== actual.owner) {
      problems.push(`resources:${id}: owner=${declared.owner}; source=${actual.owner}`)
    }
    if (!Array.isArray(declared.hooks)) {
      problems.push(`resources:${id}: hooks must be an array`)
      continue
    }
    const declaredHooks = [...declared.hooks].sort()
    const actualHooks = [...actual.hooks].sort()
    if (declaredHooks.join('\0') !== actualHooks.join('\0')) {
      problems.push(
        `resources:${id}: hooks=${declaredHooks.join(',')}; source=${actualHooks.join(',')}`,
      )
    }
  }
}

function validateReconciliationParticipants(participants, discovered, problems) {
  if (!Array.isArray(participants)) {
    problems.push('reconciliation-participants: must be an array')
    return
  }
  const byId = new Map()
  for (const participant of participants) {
    if (!isRecord(participant) || !isNonEmptyString(participant.id)) {
      problems.push('reconciliation-participants: invalid entry')
      continue
    }
    if (byId.has(participant.id)) {
      problems.push(`reconciliation-participants: duplicate id: ${participant.id}`)
    }
    byId.set(participant.id, participant)
  }
  for (const stale of difference(byId.keys(), discovered.keys())) {
    problems.push(`reconciliation-participants: stale id: ${stale}`)
  }
  for (const missing of difference(discovered.keys(), byId.keys())) {
    problems.push(`reconciliation-participants: missing id: ${missing}`)
  }
  for (const [id, actual] of discovered) {
    const declared = byId.get(id)
    if (!declared) continue
    if (declared.owner !== actual.owner) {
      problems.push(
        `reconciliation-participants:${id}: owner=${declared.owner}; source=${actual.owner}`,
      )
    }
    if (!Array.isArray(declared.hooks)) {
      problems.push(`reconciliation-participants:${id}: hooks must be an array`)
      continue
    }
    const declaredHooks = [...declared.hooks].sort()
    const actualHooks = [...actual.hooks].sort()
    if (declaredHooks.join('\0') !== actualHooks.join('\0')) {
      problems.push(
        `reconciliation-participants:${id}: hooks=${declaredHooks.join(',')}; source=${actualHooks.join(',')}`,
      )
    }
  }
}

function validateCapabilities(capabilities, problems) {
  if (!Array.isArray(capabilities)) return
  for (const capability of capabilities) {
    if (!isRecord(capability) || !isNonEmptyString(capability.id)) continue
    validateGateList(
      capability.currentGates,
      VALID_CAPABILITY_GATES,
      `capabilities:${capability.id}:current`,
      problems,
    )
    validateGateList(
      capability.targetGates,
      VALID_CAPABILITY_GATES,
      `capabilities:${capability.id}:target`,
      problems,
    )
    if (!isNonEmptyString(capability.owner)) {
      problems.push(`capabilities:${capability.id}: owner must be non-empty`)
    }
    if (
      Array.isArray(capability.currentGates) &&
      Array.isArray(capability.targetGates) &&
      capability.currentGates.join('\0') !== capability.targetGates.join('\0')
    ) {
      problems.push(`capabilities:${capability.id}: current and target gates differ`)
    }
    if (!isNonEmptyString(capability.rationale)) {
      problems.push(`capabilities:${capability.id}: rationale must be non-empty`)
    }
  }
}

function validateGateList(values, allowed, label, problems) {
  if (!Array.isArray(values) || values.length === 0) {
    problems.push(`${label}: gates must be a non-empty array`)
    return
  }
  for (const duplicate of duplicates(values))
    problems.push(`${label}: duplicate gate: ${duplicate}`)
  for (const value of values) {
    if (!allowed.has(value)) problems.push(`${label}: unknown gate: ${value}`)
  }
}

function validateAcceptance(acceptance, problems) {
  if (!Array.isArray(acceptance) || acceptance.length !== 7) {
    problems.push(
      `acceptance: count=${Array.isArray(acceptance) ? acceptance.length : 0}; expected=7`,
    )
    return
  }
  for (const duplicate of duplicates(acceptance))
    problems.push(`acceptance: duplicate: ${duplicate}`)
  for (const item of acceptance) {
    if (!isNonEmptyString(item)) problems.push('acceptance: every entry must be non-empty')
  }
}

function discoverStringArray(path, name, label, problems) {
  const source = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let result = null
  visit(file)
  if (!result) problems.push(`${label}: could not discover ${name}`)
  return result ?? []

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      const array = unwrapFrozenArray(node.initializer)
      if (array) result = array.elements.filter(ts.isStringLiteralLike).map((item) => item.text)
    }
    ts.forEachChild(node, visit)
  }
}

function discoverNamedObjectLiteral(path, name, label, problems) {
  const source = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let object = null
  visit(file)
  if (!object) problems.push(`${label}: could not discover object ${name}`)
  return object

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      const value = unwrapExpression(node.initializer)
      if (value && ts.isObjectLiteralExpression(value)) object = value
    }
    ts.forEachChild(node, visit)
  }
}

function discoverInstalledManifestLiterals(path, problems) {
  const source = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declarations = new Map()
  const functions = new Map()
  const calls = []
  visit(file)
  if (calls.length !== 1) {
    problems.push(`resources: installWorkspaceRuntimeResources calls=${calls.length}; expected=1`)
  }
  const call = calls[0]
  const resources = resolveObjectLiteral(call?.arguments[0], declarations, functions)
  const reconciliationParticipants = resolveObjectLiteral(
    call?.arguments[1],
    declarations,
    functions,
  )
  if (!resources) {
    problems.push('resources: could not resolve installed resource manifest')
  }
  if (!reconciliationParticipants) {
    problems.push('reconciliation-participants: could not resolve installed manifest')
  }
  return { resources, reconciliationParticipants }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.set(node.name.text, node.initializer)
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      functions.set(node.name.text, node)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'installWorkspaceRuntimeResources'
    ) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
}

function resolveObjectLiteral(expression, declarations, functions, seen = new Set()) {
  const value = unwrapExpression(expression)
  if (!value) return null
  if (ts.isObjectLiteralExpression(value)) return value
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)) {
    const declaration = functions.get(value.expression.text)
    const returns = declaration?.body.statements.filter(ts.isReturnStatement) ?? []
    if (returns.length !== 1 || !returns[0].expression) return null
    return resolveObjectLiteral(returns[0].expression, declarations, functions, seen)
  }
  if (!ts.isIdentifier(value) || seen.has(value.text)) return null
  const initializer = declarations.get(value.text)
  if (!initializer) return null
  seen.add(value.text)
  return resolveObjectLiteral(initializer, declarations, functions, seen)
}

function objectLiteralEntries(object, owner, externalEntries, label, problems) {
  const entries = new Map()
  for (const property of object?.properties ?? []) {
    if (ts.isSpreadAssignment(property)) {
      const spread = unwrapExpression(property.expression)
      const external = spread && ts.isIdentifier(spread) ? externalEntries.get(spread.text) : null
      if (!external) {
        problems.push(
          `${label}: unresolved installed manifest spread: ${property.expression.getText()}`,
        )
        continue
      }
      for (const [id, entry] of external) {
        if (entries.has(id)) problems.push(`${label}: duplicate installed id: ${id}`)
        entries.set(id, entry)
      }
      continue
    }
    if (!ts.isPropertyAssignment(property)) continue
    const id = propertyName(property.name)
    const value = unwrapExpression(property.initializer)
    if (!id || !value || !ts.isObjectLiteralExpression(value)) continue
    if (entries.has(id)) problems.push(`${label}: duplicate installed id: ${id}`)
    entries.set(id, { object: value, owner })
  }
  return entries
}

function unwrapFrozenArray(expression) {
  const value = unwrapExpression(expression)
  if (value && ts.isArrayLiteralExpression(value)) return value
  if (
    value &&
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    value.expression.expression.getText() === 'Object' &&
    value.expression.name.text === 'freeze'
  ) {
    const argument = unwrapExpression(value.arguments[0])
    if (argument && ts.isArrayLiteralExpression(argument)) return argument
  }
  return null
}

function unwrapExpression(expression) {
  let current = expression
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression
  }
  return current
}

function stringProperty(object, name) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== name) continue
    const value = unwrapExpression(property.initializer)
    return value && ts.isStringLiteralLike(value) ? value.text : null
  }
  return null
}

function hasProperty(object, name) {
  return object.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) ||
        ts.isMethodDeclaration(property) ||
        ts.isShorthandPropertyAssignment(property)) &&
      propertyName(property.name) === name,
  )
}

function propertyName(name) {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return null
}

function countOccurrences(source, needle) {
  let count = 0
  let offset = 0
  while (true) {
    const index = source.indexOf(needle, offset)
    if (index < 0) return count
    count += 1
    offset = index + needle.length
  }
}

function normalizeOwners(entries) {
  if (!Array.isArray(entries)) return []
  return entries.filter(isRecord).map((entry) => ({
    id: entry.id,
    ...(entry.phase === undefined ? {} : { phase: entry.phase }),
    hooks: Array.isArray(entry.hooks) ? [...entry.hooks] : [],
    owner: entry.owner,
  }))
}

function difference(left, right) {
  const rightSet = new Set(right)
  return [...left].filter((value) => !rightSet.has(value)).sort()
}

function duplicates(values) {
  const seen = new Set()
  const found = new Set()
  for (const value of values) {
    if (seen.has(value)) found.add(value)
    seen.add(value)
  }
  return [...found].sort()
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isExactRepoPath(value) {
  return (
    isNonEmptyString(value) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  )
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2))
  let inventory = null
  const importProblems = []
  try {
    inventory = await import(`${pathToFileURL(args.inventory).href}?audit=${Date.now()}`)
  } catch (error) {
    importProblems.push(`inventory: ${errorText(error)}`)
  }
  const output = evaluateStartupReadiness(ROOT, inventory, args.mode, importProblems)
  process.stdout.write(`${JSON.stringify(output, null, args.json ? 2 : 0)}\n`)
  if (!output.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli()
}
