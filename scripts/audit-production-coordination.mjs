import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import * as defaultInventory from './production-coordination-inventory.mjs'
import productionModuleInventory from './production-module-inventory.json' with { type: 'json' }

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')

export function discoverProductionCoordination({
  root = DEFAULT_ROOT,
  inventory = defaultInventory,
} = {}) {
  const lifecycleEvents = new Set(inventory.COORDINATION_LIFECYCLE_EVENT_NAMES)
  const primitiveExports = new Map(
    Object.entries(inventory.LIFECYCLE_PRIMITIVE_MODULES).flatMap(([modulePath, names]) =>
      names.map((name) => [`${modulePath}#${name}`, { modulePath, name }]),
    ),
  )
  const sourceUnits = sourceFiles(join(root, 'src')).map((path) => parseSourceUnit(path, root))
  return {
    sourceFiles: sourceUnits.length,
    discovered: {
      moduleMutableState: scanModuleMutableState(sourceUnits),
      retainedCollections: scanRetainedCollections(sourceUnits),
      lifecycleExternalIngress: scanLifecycleExternalIngress(
        sourceUnits,
        lifecycleEvents,
        inventory.LIFECYCLE_PRIMITIVE_MODULES,
      ),
      lifecycleDirectCalls: scanLifecycleDirectCalls(
        sourceUnits,
        primitiveExports,
        inventory.LIFECYCLE_PRIMITIVE_MODULES,
      ),
    },
  }
}

export function evaluateProductionCoordination({
  discovery,
  inventory = defaultInventory,
  moduleInventory = productionModuleInventory,
}) {
  const {
    LIFECYCLE_DIRECT_CALLS,
    LIFECYCLE_EXTERNAL_INGRESS,
    MODULE_MUTABLE_STATE,
    MUTABLE_MODULE_CONTRACTS,
    RETAINED_COLLECTIONS,
  } = inventory
  const canonicalDomainByPath = new Map(
    moduleInventory.classifications.flatMap((classification) =>
      classification.paths.map((path) => [path, classification.domain]),
    ),
  )
  const { discovered } = discovery
  const problems = []
  const declaredInventories = {
    moduleMutableState: MODULE_MUTABLE_STATE,
    retainedCollections: RETAINED_COLLECTIONS,
    lifecycleExternalIngress: LIFECYCLE_EXTERNAL_INGRESS,
    lifecycleDirectCalls: LIFECYCLE_DIRECT_CALLS,
  }
  for (const [section, entries] of Object.entries(declaredInventories)) {
    validateDeclaredMetadata(section, entries, problems)
  }
  const inventories = Object.fromEntries(
    Object.entries(declaredInventories).map(([section, entries]) => [
      section,
      entries.map((entry) => withCanonicalDomain(section, entry, problems, canonicalDomainByPath)),
    ]),
  )
  const mutableStatePaths = [
    ...new Set(discovered.moduleMutableState.map((entry) => entry.id.split('#', 1)[0])),
  ].sort()
  const mutableContractPaths = Object.keys(MUTABLE_MODULE_CONTRACTS).sort()
  for (const path of difference(mutableStatePaths, mutableContractPaths)) {
    problems.push(`moduleMutableState: module contract missing: ${path}`)
  }
  for (const path of difference(mutableContractPaths, mutableStatePaths)) {
    problems.push(`moduleMutableState: stale module contract: ${path}`)
  }
  const report = {}
  for (const [section, values] of Object.entries(discovered)) {
    const manifest = inventories[section]
    const actualIds = values.map((entry) => entry.id).sort()
    const declaredIds = manifest.map((entry) => entry.id).sort()
    const actualIdSet = new Set(actualIds)
    const currentManifest = manifest.filter((entry) => actualIdSet.has(entry.id))
    for (const duplicate of duplicates(actualIds)) {
      problems.push(`${section}: duplicate discovered id: ${duplicate}`)
    }
    const unclassified = difference(actualIds, declaredIds)
    const stale = difference(declaredIds, actualIds)
    if (unclassified.length > 0) {
      problems.push(`${section}: unclassified: ${unclassified.join(', ')}`)
    }
    if (stale.length > 0) problems.push(`${section}: stale: ${stale.join(', ')}`)
    const metadataById = new Map(manifest.map((entry) => [entry.id, entry]))
    report[section] = {
      count: actualIds.length,
      domainCounts: countBy(currentManifest, 'domain'),
      scopeCounts: countBy(currentManifest, 'scope'),
      unclassified,
      stale,
      entries: values.map((entry) => {
        const path = entry.id.split(/[|#]/u, 1)[0]
        return {
          ...entry,
          domain: canonicalDomainByPath.get(path) ?? null,
          ...metadataById.get(entry.id),
        }
      }),
    }
  }

  const architectureViolations = [
    ...lifecycleArchitectureViolations(discovered.lifecycleDirectCalls),
    ...declaredCoordinationGaps(inventories),
  ].sort()
  problems.push(...architectureViolations.map((problem) => `architecture: ${problem}`))

  return {
    sourceFiles: discovery.sourceFiles,
    ...report,
    architectureViolations,
    problems,
  }
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2))
  const root = args.root ?? DEFAULT_ROOT
  const inventory = args.inventory
    ? await import(pathToFileURL(args.inventory).href)
    : defaultInventory
  const discovery = discoverProductionCoordination({ root, inventory })
  const output = evaluateProductionCoordination({ discovery, inventory })
  if (args.json) {
    console.log(JSON.stringify(output, null, 2))
  } else if (output.problems.length === 0) {
    process.stdout.write(
      `Production coordination inventory complete: source-files=${discovery.sourceFiles}, module-mutable=${discovery.discovered.moduleMutableState.length}, retained-collections=${discovery.discovered.retainedCollections.length}, external-ingress=${discovery.discovered.lifecycleExternalIngress.length}, lifecycle-calls=${discovery.discovered.lifecycleDirectCalls.length}, architecture-violations=0.\n`,
    )
  } else {
    process.stderr.write(`Production coordination inventory failed (${output.problems.length}):\n`)
    for (const problem of output.problems) process.stderr.write(`  ${problem}\n`)
  }
  if (output.problems.length > 0) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli()
}

function withCanonicalDomain(section, entry, problems, canonicalDomainByPath) {
  const path = entry.id.split(/[|#]/u, 1)[0]
  const domain = canonicalDomainByPath.get(path) ?? null
  if (domain === null) {
    problems.push(`${section}: ${entry.id}: module missing from canonical domain inventory`)
  }
  return {
    ...entry,
    domain,
  }
}

function parseArgs(argv) {
  const parsed = { root: null, inventory: null, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg !== '--root' && arg !== '--inventory') {
      throw new Error(`Unknown production-coordination argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    if (arg === '--root') parsed.root = resolve(value)
    else parsed.inventory = resolve(value)
    index += 1
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

function parseSourceUnit(path, root) {
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

function scanModuleMutableState(units) {
  const entries = []
  for (const { rel, source } of units) {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      if ((statement.declarationList.flags & ts.NodeFlags.Const) !== 0) continue
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          entries.push({ id: `${rel}#${name}`, kind: 'module-mutable' })
        }
      }
    }
  }
  return entries.sort(compareIds)
}

function scanRetainedCollections(units) {
  const entries = []
  for (const { rel, source } of units) {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
        if (!containsRetainedCollection(declaration.initializer)) continue
        entries.push({ id: `${rel}#${declaration.name.text}`, kind: 'module-collection' })
      }
    }
    visit(source, (node) => {
      if (!ts.isClassDeclaration(node) || !node.name) return
      for (const member of node.members) {
        const name = collectionPropertyName(member)
        if (
          !ts.isPropertyDeclaration(member) ||
          !name ||
          !(
            (member.initializer && containsRetainedCollection(member.initializer)) ||
            isRetainedCollectionType(member.type)
          )
        ) {
          continue
        }
        entries.push({
          id: `${rel}#${node.name.text}.${name}`,
          kind: 'class-collection',
        })
      }
    })
    visit(source, (node) => {
      if (!isRetainedOwnerFactory(node)) return
      for (const statement of node.body.statements) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
          if (!containsRetainedCollection(declaration.initializer)) continue
          entries.push({
            id: `${rel}#${node.name.text}.${declaration.name.text}`,
            kind: 'factory-collection',
          })
        }
      }
    })
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
        const creator = zustandCreator(declaration.initializer)
        if (!creator || !ts.isArrowFunction(creator)) continue
        const body = unwrapParenthesizedExpression(creator.body)
        if (!ts.isObjectLiteralExpression(body)) continue
        for (const property of body.properties) {
          if (
            !ts.isPropertyAssignment(property) ||
            !(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) ||
            !containsRetainedCollection(property.initializer)
          ) {
            continue
          }
          entries.push({
            id: `${rel}#${declaration.name.text}.${property.name.text}`,
            kind: 'zustand-collection',
          })
        }
      }
    }
  }
  return entries.sort(compareIds)
}

function scanLifecycleExternalIngress(units, lifecycleEvents, lifecyclePrimitiveModules) {
  const entries = []
  for (const { rel, source } of units) {
    const occurrences = new Map()
    visit(source, (node) => {
      if (!ts.isCallExpression(node)) return
      const access = propertyAccessName(node.expression)
      if (access !== 'addEventListener') return
      const event = stringValue(node.arguments[0])
      if (!event || (!lifecycleEvents.has(event) && !(rel in lifecyclePrimitiveModules))) return
      const owner = enclosingOwner(node)
      const handler = expressionLabel(node.arguments[1])
      const stem = `${rel}|${owner}|${event}|${handler}`
      const occurrence = (occurrences.get(stem) ?? 0) + 1
      occurrences.set(stem, occurrence)
      entries.push({
        id: `${stem}|${occurrence}`,
        kind: 'external-event',
      })
    })
    visit(source, (node) => {
      if (!ts.isCallExpression(node)) return
      const callee = expressionLabel(node.expression)
      if (
        ![
          'claimBrowserWorkspaceFatalInvalidationOwner',
          'claimWorkspaceRuntimeDemandBoundary',
          'installBrowserWorkspaceSlotCoordinator',
          'subscribeWorkspaceApplicationChanges',
          'subscribeWorkspaceChanges',
          'subscribeWorkspaceRuntime',
          'subscribeWorkspaceRuntimeIdle',
          'subscribeWorkspaceRuntimeState',
        ].includes(callee)
      ) {
        return
      }
      const owner = enclosingOwner(node)
      const stem = `${rel}|${owner}|${callee}`
      const occurrence = (occurrences.get(stem) ?? 0) + 1
      occurrences.set(stem, occurrence)
      entries.push({ id: `${stem}|${occurrence}`, kind: 'coordination-subscription' })
    })
    visit(source, (node) => {
      if (
        !ts.isNewExpression(node) ||
        !ts.isIdentifier(node.expression) ||
        node.expression.text !== 'BroadcastChannel'
      ) {
        return
      }
      const owner = enclosingOwner(node)
      const channelName = expressionLabel(node.arguments?.[0])
      const stem = `${rel}|${owner}|BroadcastChannel|${channelName}`
      const occurrence = (occurrences.get(stem) ?? 0) + 1
      occurrences.set(stem, occurrence)
      entries.push({ id: `${stem}|${occurrence}`, kind: 'cross-tab-channel' })
    })
  }
  return entries.sort(compareIds)
}

function scanLifecycleDirectCalls(units, primitiveExports, lifecyclePrimitiveModules) {
  const entries = []
  for (const { rel, source } of units) {
    const localPrimitives = new Map()
    const ownPrimitives = lifecyclePrimitiveModules[rel]
    for (const name of ownPrimitives ?? []) localPrimitives.set(name, name)
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue
      }
      const importedPath = resolveImportPath(rel, statement.moduleSpecifier.text)
      const clause = statement.importClause?.namedBindings
      if (!clause || !ts.isNamedImports(clause)) continue
      for (const element of clause.elements) {
        const exportedName = element.propertyName?.text ?? element.name.text
        if (!primitiveExports.has(`${importedPath}#${exportedName}`)) continue
        localPrimitives.set(element.name.text, exportedName)
      }
    }
    const occurrences = new Map()
    visit(source, (node) => {
      if (!ts.isCallExpression(node)) return
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        (node.expression.expression.text === 'workspaceRuntimeInternal' ||
          (rel === 'src/store/workspace-runtime-control.ts' &&
            node.expression.expression.text === 'runtime'))
      ) {
        const owner = enclosingOwner(node)
        const primitive = `workspaceRuntimeKernel.${node.expression.name.text}`
        const stem = `${rel}|${owner}|${primitive}`
        const occurrence = (occurrences.get(stem) ?? 0) + 1
        occurrences.set(stem, occurrence)
        entries.push({ id: `${stem}|${occurrence}`, kind: 'direct-lifecycle-call' })
        return
      }
      if (!ts.isIdentifier(node.expression)) return
      const primitive = localPrimitives.get(node.expression.text)
      if (!primitive) return
      const owner = enclosingOwner(node)
      const stem = `${rel}|${owner}|${primitive}`
      const occurrence = (occurrences.get(stem) ?? 0) + 1
      occurrences.set(stem, occurrence)
      entries.push({ id: `${stem}|${occurrence}`, kind: 'direct-lifecycle-call' })
    })
    visit(source, (node) => {
      if (!ts.isIdentifier(node)) return
      const primitive = localPrimitives.get(node.text)
      if (!primitive || !isPrimitiveReference(node)) return
      const owner = enclosingOwner(node)
      const stem = `${rel}|${owner}|${primitive}:reference`
      const occurrence = (occurrences.get(stem) ?? 0) + 1
      occurrences.set(stem, occurrence)
      entries.push({ id: `${stem}|${occurrence}`, kind: 'lifecycle-reference' })
    })
  }
  return entries.sort(compareIds)
}

function resolveImportPath(importer, specifier) {
  if (!specifier.startsWith('.')) return specifier
  const importerParts = importer.split('/')
  importerParts.pop()
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') importerParts.pop()
    else importerParts.push(part)
  }
  let result = importerParts.join('/')
  if (!/\.[cm]?[jt]sx?$/u.test(result)) result += '.ts'
  return result
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  )
}

function containsRetainedCollection(node) {
  if (ts.isArrayLiteralExpression(node)) return node.elements.length === 0
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    isRetainedCollectionConstructor(node.expression.text)
  ) {
    return true
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node)) {
    return false
  }
  let retained = false
  ts.forEachChild(node, (child) => {
    if (!retained) retained = containsRetainedCollection(child)
  })
  return retained
}

function isRetainedCollectionType(type) {
  if (!type) return false
  if (ts.isParenthesizedTypeNode(type)) return isRetainedCollectionType(type.type)
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some(isRetainedCollectionType)
  }
  if (ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type)) return true
  return (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    isRetainedCollectionConstructor(type.typeName.text)
  )
}

function isRetainedCollectionConstructor(name) {
  return [
    'Array',
    'BigInt64Array',
    'BigUint64Array',
    'Float32Array',
    'Float64Array',
    'Int16Array',
    'Int32Array',
    'Int8Array',
    'Map',
    'ReadonlyArray',
    'ReadonlyMap',
    'ReadonlySet',
    'Set',
    'Uint16Array',
    'Uint32Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'WeakMap',
    'WeakSet',
  ].includes(name)
}

function collectionPropertyName(member) {
  if (!ts.isPropertyDeclaration(member)) return null
  return ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name)
    ? member.name.text
    : null
}

function isRetainedOwnerFactory(node) {
  return (
    ts.isFunctionDeclaration(node) &&
    node.name &&
    node.body &&
    /^create[A-Z].*(?:Kernel|Registry)$/u.test(node.name.text)
  )
}

function zustandCreator(initializer) {
  if (!ts.isCallExpression(initializer)) return undefined
  if (ts.isIdentifier(initializer.expression) && initializer.expression.text === 'create') {
    return initializer.arguments[0]
  }
  if (
    ts.isCallExpression(initializer.expression) &&
    ts.isIdentifier(initializer.expression.expression) &&
    initializer.expression.expression.text === 'create'
  ) {
    return initializer.arguments[0]
  }
  return undefined
}

function unwrapParenthesizedExpression(node) {
  let current = node
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

function propertyAccessName(expression) {
  let current = expression
  while (ts.isPropertyAccessChain(current)) current = current.expression
  if (ts.isPropertyAccessExpression(expression) || ts.isPropertyAccessChain(expression)) {
    return expression.name.text
  }
  return null
}

function stringValue(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null
}

function expressionLabel(node) {
  if (!node) return '<missing>'
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) return node.name.text
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return '<inline>'
  return `<${ts.SyntaxKind[node.kind]}>`
}

function enclosingOwner(node) {
  let current = node.parent
  while (current) {
    if ((ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) && current.name) {
      return current.name.text
    }
    if (ts.isMethodDeclaration(current) && current.name) return expressionLabel(current.name)
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
      if (ts.isPropertyAssignment(parent)) return expressionLabel(parent.name)
      if (ts.isCallExpression(parent)) return `${expressionLabel(parent.expression)}<callback>`
    }
    current = current.parent
  }
  return '<module>'
}

function isPrimitiveReference(node) {
  const parent = node.parent
  if (ts.isImportSpecifier(parent)) return false
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return false
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false
  if (ts.isCallExpression(parent) && parent.expression === node) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false
  return true
}

function visit(node, callback) {
  callback(node)
  ts.forEachChild(node, (child) => visit(child, callback))
}

function validateDeclaredMetadata(section, entries, problems) {
  const seen = new Set()
  const requiredKeys = [
    'scope',
    'bound',
    'cleanup',
    ...(section === 'lifecycleExternalIngress' ? ['installation', 'removalOwner'] : []),
    ...(section === 'lifecycleDirectCalls' ? ['stage', 'ownership'] : []),
  ]
  for (const entry of entries) {
    if (seen.has(entry.id)) problems.push(`${section}: duplicate manifest id: ${entry.id}`)
    seen.add(entry.id)
    if (Object.hasOwn(entry, 'domain')) {
      problems.push(`${section}: ${entry.id}: declaration must not define domain`)
    }
    for (const key of requiredKeys) {
      if (typeof entry[key] !== 'string' || entry[key].trim() === '') {
        problems.push(`${section}: ${entry.id}: missing ${key}`)
      }
    }
  }
}

function declaredCoordinationGaps(inventories) {
  const gaps = []
  for (const [section, entries] of Object.entries(inventories)) {
    for (const entry of entries) {
      if (typeof entry.gap === 'string' && entry.gap.trim() !== '') {
        gaps.push(`${section}: ${entry.id}: GAP: ${entry.gap}`)
      }
    }
  }
  return gaps
}

function difference(left, right) {
  const rightSet = new Set(right)
  return left.filter((value) => !rightSet.has(value))
}

function duplicates(values) {
  const seen = new Set()
  const duplicateValues = new Set()
  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value)
    seen.add(value)
  }
  return [...duplicateValues].sort()
}

function countBy(entries, key) {
  const counts = {}
  for (const entry of entries) {
    const value = entry[key] ?? '<unclassified>'
    counts[value] = (counts[value] ?? 0) + 1
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  )
}

function lifecycleArchitectureViolations(entries) {
  const violations = []
  const lowLevelOwners = new Set([
    'src/store/browser-workspace-lifecycle.ts',
    'src/store/browser-workspace-replacement-runner.ts',
    'src/store/workspace-runtime-control.ts',
  ])
  for (const entry of entries) {
    const [path, , primitiveWithKind] = entry.id.split('|')
    const primitive = primitiveWithKind.replace(/:reference$/u, '')
    if (
      primitive.startsWith('workspaceRuntimeInternal.') &&
      path !== 'src/store/workspace-runtime-control.ts'
    ) {
      violations.push(`${entry.id}: workspaceRuntimeInternal bypasses workspace-runtime-control`)
      continue
    }
    if (
      primitive.startsWith('workspaceRuntimeKernel.') &&
      path !== 'src/store/workspace-runtime-control.ts'
    ) {
      violations.push(`${entry.id}: workspaceRuntimeKernel bypasses workspace-runtime-control`)
      continue
    }
    if (
      [
        'awaitWorkspaceRuntimeQuiesced',
        'beginWorkspaceRuntimeQuiesce',
        'beginWorkspaceRuntimeReconciliation',
        'beginWorkspaceRuntimeReplacement',
        'finishWorkspaceRuntimeReconciliation',
        'getWorkspaceRuntimeControlSnapshot',
        'installWorkspaceRuntimeResources',
        'launchCommandFanoutWorkspaceRuntimeReplacementNow',
        'launchImportExportWorkspaceRuntimeReplacementNow',
        'noteWorkspaceRuntimeGatedChange',
        'refreshWorkspaceRuntimeReconciliation',
        'resumeWorkspaceRuntimeResources',
        'sealWorkspaceRuntime',
        'settleWorkspaceUsableSurface',
        'tryLaunchMaintenanceWorkspaceRuntimeReplacementIfIdle',
        'tryBeginWorkspaceRuntimeQuiesceIfIdle',
      ].includes(primitive) &&
      !lowLevelOwners.has(path)
    ) {
      violations.push(`${entry.id}: low-level runtime control called outside an orchestrator`)
    }
    if (
      primitive === 'workspaceUsableSurfaceSettlementPort' &&
      path !== 'src/store/catalog-session-workspace.ts'
    ) {
      violations.push(`${entry.id}: usable-surface settlement port created outside composition`)
    }
    if (
      [
        'prepareBrowserWorkspaceDatabaseSelection',
        'releaseBrowserWorkspaceDatabaseSelection',
      ].includes(primitive) &&
      ![
        'src/store/browser-workspace-lifecycle.ts',
        'src/store/browser-workspace-replacement-runner.ts',
      ].includes(path)
    ) {
      violations.push(
        `${entry.id}: physical database selection called outside workspace orchestration`,
      )
    }
  }
  return violations.sort()
}

function compareIds(left, right) {
  return left.id.localeCompare(right.id)
}
