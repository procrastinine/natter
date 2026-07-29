import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(SCRIPT_DIRECTORY, '..')
export const DEFAULT_E2E_STORAGE_INVENTORY_PATH = resolve(
  SCRIPT_DIRECTORY,
  'e2e-browser-storage-inventory.json',
)

export const E2E_STORAGE_PURPOSES = [
  'fault-injection',
  'read-only-assertion',
  'reset',
  'legacy-fixture',
  'physical-reclamation',
]

const MUTATION_SCOPE_KINDS = [
  'none',
  'database',
  'database-schema',
  'stores',
  'web-storage',
  'cache-storage',
  'origin-private-file-system',
  'storage-bucket',
  'origin-storage',
]

export function discoverE2eBrowserStorageSites(rootDirectory = DEFAULT_ROOT) {
  return discoverE2eSemanticSiteSets(rootDirectory).storageSites
}

export function discoverE2eCleanupEvidenceSites(rootDirectory = DEFAULT_ROOT) {
  return discoverE2eSemanticSiteSets(rootDirectory).cleanupEvidenceSites
}

function discoverE2eSemanticSiteSets(rootDirectory) {
  const e2eRoot = resolve(rootDirectory, 'tests/e2e')
  const files = sourceFiles(e2eRoot)
  const config = ts.readConfigFile(resolve(rootDirectory, 'tsconfig.app.json'), ts.sys.readFile)
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, rootDirectory)
  const program = ts.createProgram({
    rootNames: files,
    options: {
      ...parsed.options,
      noEmit: true,
      noResolve: true,
      noUnusedLocals: false,
      noUnusedParameters: false,
    },
  })
  const checker = program.getTypeChecker()
  const provisionalSites = []
  const provisionalCleanupEvidenceSites = []

  for (const absolutePath of files) {
    const sourceFile = program.getSourceFile(absolutePath)
    if (!sourceFile) throw new Error(`E2eStorageSourceMissing:${absolutePath}`)
    const sourcePath = relative(rootDirectory, absolutePath).replaceAll('\\', '/')
    provisionalSites.push(...discoverFileSites(sourceFile, sourcePath, checker))
    provisionalCleanupEvidenceSites.push(
      ...discoverFileCleanupEvidenceSites(sourceFile, sourcePath),
    )
  }

  return {
    storageSites: stableSiteIds(provisionalSites),
    cleanupEvidenceSites: stableSiteIds(provisionalCleanupEvidenceSites),
  }
}

function stableSiteIds(provisionalSites) {
  provisionalSites.sort(
    (left, right) => left.path.localeCompare(right.path) || left.position - right.position,
  )
  const occurrences = new Map()
  return provisionalSites.map(({ position: _position, ...site }) => {
    const signature = [
      site.path,
      site.owner,
      site.operation,
      site.mode ?? '-',
      site.store ?? '-',
    ].join('\u0000')
    const occurrence = (occurrences.get(signature) ?? 0) + 1
    occurrences.set(signature, occurrence)
    const id = [
      site.path,
      `owner=${encodeURIComponent(site.owner)}`,
      `operation=${site.operation}`,
      `mode=${site.mode ?? '-'}`,
      `store=${encodeURIComponent(site.store ?? '-')}`,
      `occurrence=${occurrence}`,
    ].join('::')
    return { id, ...site, occurrence }
  })
}

export function validateE2eBrowserStorageInventory(
  inventory,
  discoveredSites,
  cleanupEvidenceSites = [],
) {
  const violations = []
  if (!isRecord(inventory)) {
    return failedResult([
      { code: 'inventory-invalid', detail: 'Inventory root must be an object.' },
    ])
  }
  if (inventory.schemaVersion !== 2) {
    violations.push({
      code: 'schema-version-invalid',
      detail: `Expected schemaVersion 2; received ${JSON.stringify(inventory.schemaVersion)}.`,
    })
  }

  const allowedIds = []
  const allowedCounts = new Map()
  const allowanceBySiteId = new Map()
  const allowanceLocations = new Map()
  if (!Array.isArray(inventory.allowances)) {
    violations.push({ code: 'allowances-invalid', detail: 'allowances must be an array.' })
  } else {
    for (const [allowanceIndex, allowance] of inventory.allowances.entries()) {
      const location = `allowances[${allowanceIndex}]`
      if (!isRecord(allowance)) {
        violations.push({ code: 'allowance-invalid', detail: `${location} must be an object.` })
        continue
      }
      allowanceLocations.set(allowance, location)
      if (!E2E_STORAGE_PURPOSES.includes(allowance.purpose)) {
        violations.push({
          code: 'allowance-purpose-invalid',
          detail: `${location}.purpose must be one of ${E2E_STORAGE_PURPOSES.join(', ')}.`,
        })
      }
      validateMutationScope(allowance.mutationScope, location, violations)
      for (const field of ['cleanupRestoreObligation', 'publicUiCannotExpress']) {
        if (!isNonEmptyString(allowance[field])) {
          violations.push({
            code: 'allowance-metadata-missing',
            detail: `${location}.${field} must be a non-empty string.`,
          })
        }
      }
      if (!Array.isArray(allowance.siteIds) || allowance.siteIds.length === 0) {
        violations.push({
          code: 'allowance-sites-invalid',
          detail: `${location}.siteIds must be a non-empty array of exact site IDs.`,
        })
        continue
      }
      for (const [siteIndex, siteId] of allowance.siteIds.entries()) {
        if (!isNonEmptyString(siteId)) {
          violations.push({
            code: 'allowance-site-invalid',
            detail: `${location}.siteIds[${siteIndex}] must be a non-empty string.`,
          })
          continue
        }
        allowedIds.push(siteId)
        allowedCounts.set(siteId, (allowedCounts.get(siteId) ?? 0) + 1)
        if (!allowanceBySiteId.has(siteId)) allowanceBySiteId.set(siteId, allowance)
      }
    }
  }

  const discoveredById = new Map(discoveredSites.map((site) => [site.id, site]))
  const cleanupEvidenceById = new Map([
    ...discoveredSites.map((site) => [site.id, site]),
    ...cleanupEvidenceSites.map((site) => [site.id, site]),
  ])
  const cleanupOwnerEffects = collectCleanupOwnerEffects(cleanupEvidenceById.values())
  const allowed = new Set(allowedIds)
  const missingSiteIds = [...discoveredById.keys()].filter((id) => !allowed.has(id)).sort()
  const staleSiteIds = [...allowed].filter((id) => !discoveredById.has(id)).sort()
  const duplicateSiteIds = [...allowedCounts]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => left.id.localeCompare(right.id))

  for (const id of missingSiteIds) {
    violations.push({
      code: 'allowance-missing',
      siteId: id,
      detail: `${id} is a raw E2E storage site with no allowance.`,
    })
  }
  for (const id of staleSiteIds) {
    violations.push({
      code: 'allowance-stale',
      siteId: id,
      detail: `${id} is allowed but no longer exists.`,
    })
  }
  for (const duplicate of duplicateSiteIds) {
    violations.push({
      code: 'allowance-duplicate',
      siteId: duplicate.id,
      detail: `${duplicate.id} is allowed ${duplicate.count} times.`,
    })
  }
  if (Array.isArray(inventory.allowances)) {
    for (const allowance of inventory.allowances) {
      if (!isRecord(allowance) || !Array.isArray(allowance.siteIds)) continue
      const allowanceSites = allowance.siteIds.flatMap((id) => {
        const found = discoveredById.get(id)
        return found ? [found] : []
      })
      if (allowance.purpose === 'read-only-assertion') {
        const ownerScopes = new Set(
          allowanceSites.map((site) => `${site.path}::${site.owner.split('>', 1)[0]}`),
        )
        if (ownerScopes.size > 1) {
          violations.push({
            code: 'allowance-read-scope-mixed',
            detail: `${allowanceLocations.get(allowance) ?? 'allowance'} groups read-only sites from unrelated owner trees.`,
          })
        }
      }
      validateCleanupEvidence({
        allowance,
        allowanceSites,
        cleanupEvidenceById,
        cleanupOwnerEffects,
        location: allowanceLocations.get(allowance) ?? 'allowance',
        violations,
      })
    }
  }

  const unpairedOpenSiteIds = []
  for (const site of discoveredSites) {
    if (!isIndexedDbOpen(site)) continue
    const allowance = allowanceBySiteId.get(site.id)
    const processOwned = isRecord(allowance?.cleanupEvidence)
      ? allowance.cleanupEvidence.processOwned === true
      : false
    const paired = discoveredSites.some(
      (candidate) =>
        isDatabaseCloseEvidence(candidate) &&
        candidate.path === site.path &&
        sameOwnerTree(candidate.owner, site.owner),
    )
    if (!paired && !processOwned) {
      unpairedOpenSiteIds.push(site.id)
      violations.push({
        code: 'indexeddb-open-unpaired',
        siteId: site.id,
        detail: `${site.id} has no close or database deletion in its owner tree and is not explicitly process-owned.`,
      })
    }
  }
  for (const site of discoveredSites) {
    const allowance = allowanceBySiteId.get(site.id)
    if (!allowance || !isRecord(allowance.mutationScope)) continue
    if (['write', 'delete'].includes(site.access) && allowance.mutationScope.kind === 'none') {
      violations.push({
        code: 'allowance-mutation-scope-understated',
        siteId: site.id,
        detail: `${site.id} mutates storage but declares mutationScope.kind none.`,
      })
    }
    if (allowance.purpose === 'read-only-assertion' && ['write', 'delete'].includes(site.access)) {
      violations.push({
        code: 'allowance-purpose-contradiction',
        siteId: site.id,
        detail: `${site.id} mutates storage but is classified as read-only-assertion.`,
      })
    }
    if (site.access === 'unknown') {
      violations.push({
        code: 'storage-operation-unclassified',
        siteId: site.id,
        detail: `${site.id} reaches a raw storage API operation the audit does not classify.`,
      })
    }
  }

  violations.sort(compareViolations)
  return {
    ok: violations.length === 0,
    schemaVersion: inventory.schemaVersion,
    discoveredSiteCount: discoveredSites.length,
    allowedSiteCount: allowedIds.length,
    uniqueAllowedSiteCount: allowed.size,
    accessCounts: countBy(discoveredSites, (site) => site.access),
    apiCounts: countBy(discoveredSites, (site) => site.api),
    operationCounts: countBy(discoveredSites, (site) => site.operation),
    cleanupEvidenceSiteCount: cleanupEvidenceSites.length,
    readwriteTransactionCount: discoveredSites.filter(
      (site) => site.access === 'transaction' && site.mode === 'readwrite',
    ).length,
    missingSiteIds,
    staleSiteIds,
    duplicateSiteIds,
    unpairedOpenSiteIds: unpairedOpenSiteIds.sort(),
    sites: discoveredSites,
    violations,
  }
}

export function auditE2eBrowserStorage(
  rootDirectory = DEFAULT_ROOT,
  inventoryPath = DEFAULT_E2E_STORAGE_INVENTORY_PATH,
) {
  let inventory
  try {
    inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'))
  } catch (error) {
    return failedResult([
      {
        code: 'inventory-read-failed',
        detail: error instanceof Error ? error.message : String(error),
      },
    ])
  }
  const { storageSites, cleanupEvidenceSites } = discoverE2eSemanticSiteSets(rootDirectory)
  return validateE2eBrowserStorageInventory(inventory, storageSites, cleanupEvidenceSites)
}

function discoverFileSites(sourceFile, sourcePath, checker) {
  const values = buildValueIndex(sourceFile, checker)
  const sites = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const classified = classifyCall(node, checker, values)
      if (classified) record(node, classified)
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'objectStoreNames' &&
      isType(node.expression, checker, 'IDBDatabase')
    ) {
      record(node, {
        api: 'indexeddb',
        access: 'enumeration',
        operation: 'indexeddb.database.enumerate-stores',
        mode: null,
        store: '<database>',
      })
    } else if (ts.isPropertyAccessExpression(node) && isPrototypeStorageMethod(node)) {
      const target = prototypeStorageMethod(node)
      const override =
        ts.isBinaryExpression(node.parent) &&
        node.parent.left === node &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      record(node, {
        api: 'indexeddb',
        access: 'instrumentation',
        operation: `${target.operation}-${override ? 'override' : 'read'}`,
        mode: null,
        store: null,
      })
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'length' &&
      globalStorageName(node.expression)
    ) {
      record(node, {
        api: 'web-storage',
        access: 'enumeration',
        operation: 'web-storage.length',
        mode: null,
        store: globalStorageName(node.expression),
      })
    }
    node.forEachChild(visit)
  }
  const record = (node, classified) => {
    const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    sites.push({
      path: sourcePath,
      owner: enclosingOwner(node, sourceFile),
      ...classified,
      line: point.line + 1,
      column: point.character + 1,
      position: node.getStart(sourceFile),
    })
  }
  visit(sourceFile)
  return sites
}

function discoverFileCleanupEvidenceSites(sourceFile, sourcePath) {
  const sites = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const classified = classifyCleanupEvidenceCall(node)
      if (classified) {
        const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        const { owner: explicitOwner, ...site } = classified
        sites.push({
          path: sourcePath,
          owner: explicitOwner ?? enclosingOwner(node, sourceFile),
          ...site,
          line: point.line + 1,
          column: point.character + 1,
          position: node.getStart(sourceFile),
        })
      }
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return sites
}

function classifyCleanupEvidenceCall(node) {
  const expression = unwrapExpression(node.expression)
  if (
    ts.isIdentifier(expression) &&
    ['test', 'it'].includes(expression.text) &&
    node.arguments[0] &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    testUsesBrowserContext(node.arguments[1])
  ) {
    return {
      ...cleanupEvidenceSite('fixture.playwright-context-teardown', [
        'close-database',
        'clear-data',
        'close-resource',
      ]),
      owner: `test:${node.arguments[0].text.replace(/\s+/gu, ' ').trim()}`,
    }
  }
  if (ts.isIdentifier(expression) && expression.text === 'clearIndexedDb') {
    return cleanupEvidenceSite('fixture.clear-indexeddb', [
      'delete-database',
      'clear-data',
      'reload',
    ])
  }
  if (!ts.isPropertyAccessExpression(expression)) return null
  if (expression.name.text === 'reload') {
    return cleanupEvidenceSite('fixture.page.reload', ['reload'])
  }
  if (
    expression.name.text === 'release' &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'clone'
  ) {
    return cleanupEvidenceSite('fixture.generated-profile-release', [
      'close-database',
      'clear-data',
      'close-resource',
    ])
  }
  if (expression.name.text === 'click' && isClearAllLocator(expression.expression)) {
    return cleanupEvidenceSite('fixture.public-clear-all', [
      'delete-database',
      'clear-data',
      'reload',
      'close-resource',
    ])
  }
  return null
}

function testUsesBrowserContext(callback) {
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return false
  }
  const parameter = callback.parameters[0]?.name
  if (!parameter || !ts.isObjectBindingPattern(parameter)) return false
  return parameter.elements.some((element) => {
    const name = element.propertyName ?? element.name
    return ts.isIdentifier(name) && ['page', 'context'].includes(name.text)
  })
}

function isClearAllLocator(expression) {
  const target = unwrapExpression(expression)
  if (!ts.isCallExpression(target) || !ts.isPropertyAccessExpression(target.expression)) {
    return false
  }
  if (target.expression.name.text !== 'getByRole') return false
  const [role, options] = target.arguments
  if (!role || !ts.isStringLiteralLike(role) || role.text !== 'button') return false
  if (!options || !ts.isObjectLiteralExpression(options)) return false
  const name = options.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyName(property.name) === 'name' &&
      ts.isStringLiteralLike(unwrapExpression(property.initializer)),
  )
  return (
    name !== undefined &&
    ts.isPropertyAssignment(name) &&
    ts.isStringLiteralLike(unwrapExpression(name.initializer)) &&
    unwrapExpression(name.initializer).text === 'Clear all'
  )
}

function cleanupEvidenceSite(operation, effects) {
  return {
    api: 'fixture-lifecycle',
    access: 'cleanup',
    operation,
    mode: null,
    store: null,
    cleanupEffects: effects,
  }
}

function classifyCall(node, checker, values) {
  const expression = node.expression
  if (!ts.isPropertyAccessExpression(expression)) return null
  const method = expression.name.text
  const receiver = unwrapExpression(expression.expression)

  if (
    method === 'keys' &&
    ts.isIdentifier(receiver) &&
    receiver.text === 'Object' &&
    globalStorageName(node.arguments[0])
  ) {
    return site(
      'web-storage',
      'enumeration',
      'web-storage.enumerate-keys',
      null,
      globalStorageName(node.arguments[0]),
    )
  }

  if (method === 'call') {
    const receiverValue = symbolValue(receiver, values, checker)
    if (receiverValue?.kind === 'idb-factory-open-method') {
      return site('indexeddb', 'open', 'indexeddb.factory.open-via-alias')
    }
    if (receiverValue?.kind === 'idb-database-close-method') {
      return site('indexeddb', 'close', 'indexeddb.database.close-via-alias')
    }
  }

  if (isGlobal(receiver, 'indexedDB')) {
    if (method === 'open') return site('indexeddb', 'open', 'indexeddb.factory.open')
    if (method === 'deleteDatabase') {
      return site('indexeddb', 'delete', 'indexeddb.factory.delete-database')
    }
    if (method === 'databases') {
      return site('indexeddb', 'enumeration', 'indexeddb.factory.enumerate-databases')
    }
    if (method === 'cmp') return site('indexeddb', 'read', 'indexeddb.factory.compare-keys')
    return site('indexeddb', 'unknown', `indexeddb.factory.${method}`)
  }

  if (method === 'transaction' && isType(receiver, checker, 'IDBDatabase')) {
    return site(
      'indexeddb',
      'transaction',
      'indexeddb.database.transaction',
      transactionMode(node.arguments[1], values, checker),
      staticStoreList(node.arguments[0], values, checker),
    )
  }
  if (method === 'createObjectStore' && isType(receiver, checker, 'IDBDatabase')) {
    return site(
      'indexeddb',
      'write',
      'indexeddb.database.create-object-store',
      'versionchange',
      staticStoreList(node.arguments[0], values, checker),
    )
  }
  if (method === 'deleteObjectStore' && isType(receiver, checker, 'IDBDatabase')) {
    return site(
      'indexeddb',
      'delete',
      'indexeddb.database.delete-object-store',
      'versionchange',
      staticStoreList(node.arguments[0], values, checker),
    )
  }
  if (method === 'close' && isType(receiver, checker, 'IDBDatabase')) {
    return site('indexeddb', 'close', 'indexeddb.database.close')
  }
  if (method === 'objectStore' && isType(receiver, checker, 'IDBTransaction')) {
    return site(
      'indexeddb',
      'selection',
      'indexeddb.transaction.object-store',
      transactionModeForReceiver(receiver, values, checker),
      staticStoreList(node.arguments[0], values, checker),
    )
  }
  if (
    ['addEventListener', 'removeEventListener'].includes(method) &&
    isType(receiver, checker, 'IDBTransaction')
  ) {
    return site(
      'indexeddb',
      'instrumentation',
      `indexeddb.transaction.${method}`,
      transactionModeForReceiver(receiver, values, checker),
      '<transaction-scope>',
    )
  }
  if (['abort', 'commit'].includes(method) && isType(receiver, checker, 'IDBTransaction')) {
    return site(
      'indexeddb',
      'transaction-control',
      `indexeddb.transaction.${method}`,
      transactionModeForReceiver(receiver, values, checker),
      '<transaction-scope>',
    )
  }

  const storeTarget = resolveStoreTarget(receiver, values, checker)
  if (storeTarget && method === 'index') {
    const index = staticStoreList(node.arguments[0], values, checker)
    return site(
      'indexeddb',
      'selection',
      'indexeddb.object-store.index',
      storeTarget.mode,
      `${storeTarget.store}@index:${index}`,
    )
  }
  if (storeTarget && ['createIndex', 'deleteIndex'].includes(method)) {
    return site(
      'indexeddb',
      method === 'createIndex' ? 'write' : 'delete',
      `indexeddb.${method}`,
      storeTarget.mode ?? 'versionchange',
      `${storeTarget.store}@index:${staticStoreList(node.arguments[0], values, checker)}`,
    )
  }
  if (storeTarget) {
    const access = indexedDbDataAccess(method)
    if (access) {
      return site('indexeddb', access, `indexeddb.${method}`, storeTarget.mode, storeTarget.store)
    }
  }
  if (method === 'continue' && isType(receiver, checker, 'IDBCursor')) {
    return site('indexeddb', 'read', 'indexeddb.cursor.continue', null, '<cursor-source>')
  }
  if (isType(receiver, checker, 'IDBCursor')) {
    const access = {
      advance: 'read',
      continuePrimaryKey: 'read',
      update: 'write',
      delete: 'delete',
    }[method]
    if (access) {
      return site('indexeddb', access, `indexeddb.cursor.${method}`, null, '<cursor-source>')
    }
    return site('indexeddb', 'unknown', `indexeddb.cursor.${method}`, null, '<cursor-source>')
  }

  const webStorage = globalStorageName(receiver)
  if (webStorage) {
    const access = {
      getItem: 'read',
      setItem: 'write',
      removeItem: 'delete',
      clear: 'delete',
      key: 'enumeration',
    }[method]
    if (access) return site('web-storage', access, `web-storage.${method}`, null, webStorage)
    return site('web-storage', 'unknown', `web-storage.${method}`, null, webStorage)
  }

  if (isGlobal(receiver, 'caches')) {
    const access = { open: 'open', keys: 'enumeration', match: 'read', delete: 'delete' }[method]
    if (access) return site('cache-storage', access, `cache-storage.${method}`, null, '<origin>')
    return site('cache-storage', 'unknown', `cache-storage.${method}`, null, '<origin>')
  }
  if (
    isType(receiver, checker, 'Cache') ||
    symbolValue(receiver, values, checker)?.kind === 'cache'
  ) {
    const access = {
      match: 'read',
      matchAll: 'read',
      keys: 'enumeration',
      put: 'write',
      delete: 'delete',
    }[method]
    if (access) return site('cache-storage', access, `cache.${method}`, null, '<cache>')
    return site('cache-storage', 'unknown', `cache.${method}`, null, '<cache>')
  }

  if (
    isNavigatorStorage(receiver) ||
    symbolValue(receiver, values, checker)?.kind === 'storage-manager'
  ) {
    const access = {
      estimate: 'read',
      persist: 'write',
      persisted: 'read',
      getDirectory: 'open',
    }[method]
    if (access)
      return site('storage-manager', access, `storage-manager.${method}`, null, '<origin>')
    return site('storage-manager', 'unknown', `storage-manager.${method}`, null, '<origin>')
  }
  const receiverValue = symbolValue(receiver, values, checker)
  if (receiverValue?.kind === 'opfs-root') {
    const access = { getFileHandle: 'open', getDirectoryHandle: 'open', entries: 'enumeration' }[
      method
    ]
    if (access) return site('opfs', access, `opfs.${method}`, null, '<origin-root>')
    return site('opfs', 'unknown', `opfs.${method}`, null, '<origin-root>')
  }
  if (receiverValue?.kind === 'opfs-file' && method === 'createWritable') {
    return site('opfs', 'open', 'opfs.createWritable', null, '<file>')
  }
  if (receiverValue?.kind === 'opfs-file') {
    return site('opfs', 'unknown', `opfs.${method}`, null, '<file>')
  }
  if (receiverValue?.kind === 'opfs-writable' && ['write', 'truncate', 'close'].includes(method)) {
    return site('opfs', 'write', `opfs.${method}`, null, '<file>')
  }
  if (receiverValue?.kind === 'opfs-writable') {
    return site('opfs', 'unknown', `opfs.${method}`, null, '<file>')
  }
  if (receiverValue?.kind === 'storage-buckets') {
    const access = { open: 'open', keys: 'enumeration', delete: 'delete' }[method]
    if (access)
      return site('storage-buckets', access, `storage-buckets.${method}`, null, '<origin>')
    return site('storage-buckets', 'unknown', `storage-buckets.${method}`, null, '<origin>')
  }
  if (isType(receiver, checker, 'IDBDatabase')) {
    return site('indexeddb', 'unknown', `indexeddb.database.${method}`)
  }
  if (isType(receiver, checker, 'IDBTransaction')) {
    return site(
      'indexeddb',
      'unknown',
      `indexeddb.transaction.${method}`,
      transactionModeForReceiver(receiver, values, checker),
      '<transaction-scope>',
    )
  }
  if (storeTarget) {
    return site('indexeddb', 'unknown', `indexeddb.${method}`, storeTarget.mode, storeTarget.store)
  }
  return null
}

function buildValueIndex(sourceFile, checker) {
  const values = new Map()
  let changed = true
  for (let pass = 0; pass < 6 && changed; pass += 1) {
    changed = false
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const symbol = checker.getSymbolAtLocation(node.name)
        const value = symbol && classifyInitializer(node.initializer, checker, values)
        if (symbol && value && !sameValue(values.get(symbol), value)) {
          values.set(symbol, value)
          changed = true
        }
      }
      node.forEachChild(visit)
    }
    visit(sourceFile)
  }
  return values
}

function classifyInitializer(initializer, checker, values) {
  const expression = unwrapExpression(initializer)
  const literal = staticLiteral(expression, values, checker)
  if (literal !== null) return { kind: 'literal', value: literal }
  const prototypeMethod =
    ts.isPropertyAccessExpression(expression) && prototypeStorageMethod(expression)
  if (prototypeMethod?.operation === 'indexeddb.factory.prototype-open') {
    return { kind: 'idb-factory-open-method' }
  }
  if (prototypeMethod?.operation === 'indexeddb.database.prototype-close') {
    return { kind: 'idb-database-close-method' }
  }
  if (isNavigatorStorage(expression)) return { kind: 'storage-manager' }
  if (isStorageBucketsExpression(expression)) return { kind: 'storage-buckets' }
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) {
    return null
  }
  const method = expression.expression.name.text
  const receiver = unwrapExpression(expression.expression.expression)
  if (isGlobal(receiver, 'caches') && method === 'open') return { kind: 'cache' }
  if (
    (isNavigatorStorage(receiver) ||
      symbolValue(receiver, values, checker)?.kind === 'storage-manager') &&
    method === 'getDirectory'
  ) {
    return { kind: 'opfs-root' }
  }
  const receiverValue = symbolValue(receiver, values, checker)
  if (receiverValue?.kind === 'opfs-root' && method === 'getFileHandle') {
    return { kind: 'opfs-file' }
  }
  if (receiverValue?.kind === 'opfs-file' && method === 'createWritable') {
    return { kind: 'opfs-writable' }
  }
  if (method === 'transaction' && isType(receiver, checker, 'IDBDatabase')) {
    return {
      kind: 'idb-transaction',
      mode: transactionMode(expression.arguments[1], values, checker),
      stores: staticStoreList(expression.arguments[0], values, checker),
    }
  }
  if (method === 'objectStore' && isType(receiver, checker, 'IDBTransaction')) {
    return {
      kind: 'idb-store',
      mode: transactionModeForReceiver(receiver, values, checker),
      store: staticStoreList(expression.arguments[0], values, checker),
    }
  }
  const storeTarget = resolveStoreTarget(receiver, values, checker)
  if (method === 'index' && storeTarget) {
    return {
      kind: 'idb-index',
      mode: storeTarget.mode,
      store: `${storeTarget.store}@index:${staticStoreList(expression.arguments[0], values, checker)}`,
    }
  }
  return null
}

function resolveStoreTarget(expression, values, checker) {
  const target = unwrapExpression(expression)
  const value = symbolValue(target, values, checker)
  if (value?.kind === 'idb-store' || value?.kind === 'idb-index') {
    return { mode: value.mode, store: value.store }
  }
  if (ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)) {
    const method = target.expression.name.text
    const receiver = unwrapExpression(target.expression.expression)
    if (method === 'objectStore' && isType(receiver, checker, 'IDBTransaction')) {
      return {
        mode: transactionModeForReceiver(receiver, values, checker),
        store: staticStoreList(target.arguments[0], values, checker),
      }
    }
    const storeTarget = resolveStoreTarget(receiver, values, checker)
    if (method === 'index' && storeTarget) {
      return {
        mode: storeTarget.mode,
        store: `${storeTarget.store}@index:${staticStoreList(target.arguments[0], values, checker)}`,
      }
    }
  }
  if (isType(target, checker, 'IDBObjectStore')) {
    return { mode: null, store: '<dynamic>' }
  }
  if (isType(target, checker, 'IDBIndex')) {
    return { mode: null, store: '<dynamic>@index:<dynamic>' }
  }
  return null
}

function transactionModeForReceiver(receiver, values, checker) {
  const target = unwrapExpression(receiver)
  const value = symbolValue(target, values, checker)
  if (value?.kind === 'idb-transaction') return value.mode
  if (
    ts.isCallExpression(target) &&
    ts.isPropertyAccessExpression(target.expression) &&
    target.expression.name.text === 'transaction' &&
    isType(target.expression.expression, checker, 'IDBDatabase')
  ) {
    return transactionMode(target.arguments[1], values, checker)
  }
  return isType(target, checker, 'IDBTransaction') ? '<dynamic>' : null
}

function transactionMode(expression, values, checker) {
  if (!expression) return 'readonly'
  const literal = staticLiteral(expression, values, checker)
  return typeof literal === 'string' ? literal : '<dynamic>'
}

function staticStoreList(expression, values, checker) {
  if (!expression) return '<dynamic>'
  const literal = staticLiteral(expression, values, checker)
  if (typeof literal === 'string') return literal
  if (Array.isArray(literal) && literal.every((entry) => typeof entry === 'string')) {
    return literal.join('+')
  }
  return '<dynamic>'
}

function staticLiteral(expression, values, checker) {
  const target = unwrapExpression(expression)
  if (ts.isStringLiteralLike(target)) return target.text
  if (ts.isArrayLiteralExpression(target)) {
    const entries = target.elements.map((entry) => staticLiteral(entry, values, checker))
    return entries.every((entry) => typeof entry === 'string') ? entries : null
  }
  const value = symbolValue(target, values, checker)
  return value?.kind === 'literal' ? value.value : null
}

function symbolValue(expression, values, checker) {
  const target = unwrapExpression(expression)
  if (!ts.isIdentifier(target)) return null
  const symbol = checker.getSymbolAtLocation(target)
  return symbol ? (values.get(symbol) ?? null) : null
}

function indexedDbDataAccess(method) {
  if (['get', 'getAll', 'getAllKeys', 'count', 'openCursor', 'openKeyCursor'].includes(method)) {
    return 'read'
  }
  if (['put', 'add'].includes(method)) return 'write'
  if (['delete', 'clear'].includes(method)) return 'delete'
  return null
}

function site(api, access, operation, mode = null, store = null) {
  return { api, access, operation, mode, store }
}

function enclosingOwner(node, sourceFile) {
  const labels = []
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue
    const label = functionOwnerLabel(current, sourceFile)
    if (label && !labels.includes(label)) labels.push(label)
  }
  const outerBoundary = [...labels].reverse().find((label) => /^(?:test|hook):/u.test(label))
  const specific = labels.filter((label) => !/^(?:test|hook):/u.test(label))
  const nearestSpecific = specific[0]
  const outerSpecific = [...specific]
    .reverse()
    .find((label) => /^(?:function|method):/u.test(label))
  const outerOwner = outerBoundary ?? outerSpecific
  if (outerOwner && nearestSpecific && outerOwner !== nearestSpecific) {
    return `${outerOwner}>${nearestSpecific}`
  }
  return nearestSpecific ?? outerOwner ?? '<module>'
}

function functionOwnerLabel(node, sourceFile) {
  if (ts.isFunctionDeclaration(node) && node.name) return `function:${node.name.text}`
  if (ts.isMethodDeclaration(node) && node.name) return `method:${propertyName(node.name)}`
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return `function:${node.parent.name.text}`
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isBinaryExpression(node.parent) &&
    node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    const left = node.parent.left.getText(sourceFile)
    const property = left.split('.').at(-1) ?? left
    return `callback:${property}`
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isCallExpression(node.parent)
  ) {
    const call = node.parent
    const callee = call.expression.getText(sourceFile)
    const title = call.arguments[0]
    if (/^(?:test|it)$/u.test(callee) && title && ts.isStringLiteralLike(title)) {
      return `test:${title.text.replace(/\s+/gu, ' ').trim()}`
    }
    if (/\.(?:beforeEach|afterEach|beforeAll|afterAll)$/u.test(callee)) {
      return `hook:${callee.split('.').at(-1)}`
    }
  }
  return null
}

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : '<computed>'
}

function unwrapExpression(expression) {
  let current = expression
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function isGlobal(expression, name) {
  const target = unwrapExpression(expression)
  if (ts.isIdentifier(target)) return target.text === name
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === name &&
    ts.isIdentifier(unwrapExpression(target.expression)) &&
    ['window', 'globalThis', 'self'].includes(unwrapExpression(target.expression).text)
  )
}

function globalStorageName(expression) {
  if (isGlobal(expression, 'localStorage')) return 'localStorage'
  if (isGlobal(expression, 'sessionStorage')) return 'sessionStorage'
  return null
}

function isNavigatorStorage(expression) {
  const target = unwrapExpression(expression)
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === 'storage' &&
    ts.isIdentifier(unwrapExpression(target.expression)) &&
    unwrapExpression(target.expression).text === 'navigator'
  )
}

function isStorageBucketsExpression(expression) {
  const target = unwrapExpression(expression)
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === 'storageBuckets' &&
    ts.isIdentifier(unwrapExpression(target.expression)) &&
    unwrapExpression(target.expression).text === 'navigator'
  )
}

function isPrototypeStorageMethod(expression) {
  return prototypeStorageMethod(expression) !== null
}

function prototypeStorageMethod(expression) {
  if (!ts.isPropertyAccessExpression(expression)) return null
  const method = expression.name.text
  const prototype = unwrapExpression(expression.expression)
  if (
    !ts.isPropertyAccessExpression(prototype) ||
    prototype.name.text !== 'prototype' ||
    !ts.isIdentifier(unwrapExpression(prototype.expression))
  ) {
    return null
  }
  const owner = unwrapExpression(prototype.expression).text
  if (owner === 'IDBFactory' && method === 'open') {
    return { operation: 'indexeddb.factory.prototype-open' }
  }
  if (owner === 'IDBDatabase' && method === 'close') {
    return { operation: 'indexeddb.database.prototype-close' }
  }
  return null
}

function isType(expression, checker, expected) {
  const expectedNames =
    expected === 'IDBCursor' ? new Set(['IDBCursor', 'IDBCursorWithValue']) : new Set([expected])
  const pending = [checker.getTypeAtLocation(unwrapExpression(expression))]
  const visited = new Set()
  while (pending.length > 0) {
    const type = pending.pop()
    if (!type || visited.has(type)) continue
    visited.add(type)
    const symbolName = (type.aliasSymbol ?? type.getSymbol())?.getName()
    if (symbolName && expectedNames.has(symbolName)) return true
    if (type.isUnionOrIntersection()) pending.push(...type.types)
    const apparent = checker.getApparentType(type)
    if (apparent !== type) pending.push(apparent)
    const bases = typeof type.getBaseTypes === 'function' ? type.getBaseTypes() : undefined
    if (bases) pending.push(...bases)
  }
  return false
}

function validateCleanupEvidence({
  allowance,
  allowanceSites,
  cleanupEvidenceById,
  cleanupOwnerEffects,
  location,
  violations,
}) {
  const databaseOpens = allowanceSites.filter(isIndexedDbOpen)
  const mutations = allowanceSites.filter(isStorageMutation)
  const needsEvidence = databaseOpens.length > 0 || mutations.length > 0
  const evidence = allowance.cleanupEvidence
  if (!needsEvidence && evidence === undefined) return
  if (!isRecord(evidence)) {
    if (needsEvidence) {
      violations.push({
        code: 'cleanup-evidence-missing',
        detail: `${location}.cleanupEvidence is required because the allowance opens IndexedDB or mutates browser storage.`,
      })
    } else {
      violations.push({
        code: 'cleanup-evidence-invalid',
        detail: `${location}.cleanupEvidence must be an object when present.`,
      })
    }
    return
  }

  const siteIds = Array.isArray(evidence.siteIds) ? evidence.siteIds : null
  const fixtureOwners = Array.isArray(evidence.fixtureOwners) ? evidence.fixtureOwners : null
  if (!siteIds || siteIds.some((id) => !isNonEmptyString(id))) {
    violations.push({
      code: 'cleanup-evidence-invalid',
      detail: `${location}.cleanupEvidence.siteIds must be an array of exact non-empty site IDs.`,
    })
  }
  if (!fixtureOwners || fixtureOwners.some((owner) => !isNonEmptyString(owner))) {
    violations.push({
      code: 'cleanup-evidence-invalid',
      detail: `${location}.cleanupEvidence.fixtureOwners must be an array of exact non-empty owner IDs.`,
    })
  }
  if (evidence.processOwned !== undefined && typeof evidence.processOwned !== 'boolean') {
    violations.push({
      code: 'cleanup-evidence-invalid',
      detail: `${location}.cleanupEvidence.processOwned must be boolean when present.`,
    })
  }
  if (evidence.processOwned === true && !isNonEmptyString(evidence.processOwnerReason)) {
    violations.push({
      code: 'cleanup-evidence-invalid',
      detail: `${location}.cleanupEvidence.processOwnerReason is required for process-owned handles.`,
    })
  }
  if (evidence.processOwned === true && (fixtureOwners?.length ?? 0) === 0) {
    violations.push({
      code: 'cleanup-evidence-invalid',
      detail: `${location}.cleanupEvidence.fixtureOwners must name the exact lifecycle owner of a process-owned handle.`,
    })
  }
  if ((siteIds?.length ?? 0) === 0 && (fixtureOwners?.length ?? 0) === 0) {
    violations.push({
      code: 'cleanup-evidence-empty',
      detail: `${location}.cleanupEvidence must cite at least one exact site ID or fixture owner.`,
    })
  }

  const citedSites = []
  for (const id of new Set(siteIds ?? [])) {
    const site = cleanupEvidenceById.get(id)
    if (!site) {
      violations.push({
        code: 'cleanup-evidence-site-stale',
        siteId: id,
        detail: `${location}.cleanupEvidence.siteIds cites ${id}, which does not exist.`,
      })
      continue
    }
    const effects = cleanupEffectsForSite(site)
    if (effects.length === 0) {
      violations.push({
        code: 'cleanup-evidence-site-incompatible',
        siteId: id,
        detail: `${location}.cleanupEvidence.siteIds cites ${id}, which is not a close, delete, clear, or reload operation.`,
      })
      continue
    }
    citedSites.push(site)
  }
  if ((siteIds?.length ?? 0) !== new Set(siteIds ?? []).size) {
    violations.push({
      code: 'cleanup-evidence-site-duplicate',
      detail: `${location}.cleanupEvidence.siteIds contains a duplicate exact site ID.`,
    })
  }

  const fixtureSites = []
  for (const owner of new Set(fixtureOwners ?? [])) {
    const owned = cleanupOwnerEffects.get(owner)
    if (!owned) {
      violations.push({
        code: 'cleanup-evidence-owner-stale',
        detail: `${location}.cleanupEvidence.fixtureOwners cites ${owner}, which has no compatible cleanup operation.`,
      })
      continue
    }
    fixtureSites.push(...owned.sites)
  }
  if ((fixtureOwners?.length ?? 0) !== new Set(fixtureOwners ?? []).size) {
    violations.push({
      code: 'cleanup-evidence-owner-duplicate',
      detail: `${location}.cleanupEvidence.fixtureOwners contains a duplicate exact owner ID.`,
    })
  }

  const evidenceSites = [...citedSites, ...fixtureSites]
  const effects = new Set(evidenceSites.flatMap(cleanupEffectsForSite))
  if (
    mutations.length > 0 &&
    !citedSites.some(
      (candidate) =>
        cleanupEffectsForSite(candidate).some((effect) =>
          ['delete-database', 'clear-data'].includes(effect),
        ) && mutations.some((mutation) => sameSiteOwnerTree(candidate, mutation)),
    ) &&
    !fixtureSites.some((candidate) =>
      cleanupEffectsForSite(candidate).some((effect) =>
        ['delete-database', 'clear-data'].includes(effect),
      ),
    )
  ) {
    violations.push({
      code: 'cleanup-evidence-mutation-unscoped',
      detail: `${location}.cleanupEvidence does not tie durable cleanup to the mutation owner tree or an exact fixture owner.`,
    })
  }
  for (const requirement of cleanupRequirements(allowance, allowanceSites)) {
    if (requirement.anyOf.some((effect) => effects.has(effect))) continue
    violations.push({
      code: 'cleanup-evidence-effect-missing',
      detail: `${location}.cleanupEvidence does not prove ${requirement.label}; expected one of ${requirement.anyOf.join(', ')}.`,
    })
  }

  if (evidence.processOwned !== true) {
    for (const open of databaseOpens) {
      const paired = evidenceSites.some(
        (candidate) =>
          isDatabaseCloseEvidence(candidate) &&
          candidate.path === open.path &&
          sameOwnerTree(candidate.owner, open.owner),
      )
      if (!paired) {
        violations.push({
          code: 'cleanup-evidence-open-unpaired',
          siteId: open.id,
          detail: `${location}.cleanupEvidence does not cite a close or deletion in the owner tree of ${open.id}.`,
        })
      }
    }
  }
}

function cleanupRequirements(allowance, allowanceSites) {
  const requirements = []
  if (allowanceSites.some(isIndexedDbOpen) && allowance.cleanupEvidence?.processOwned !== true) {
    requirements.push({
      label: 'database handle closure',
      anyOf: ['close-database', 'delete-database'],
    })
  }
  if (allowanceSites.some(isStorageMutation)) {
    requirements.push({
      label: 'durable mutation cleanup or replacement',
      anyOf: ['delete-database', 'clear-data'],
    })
  }
  const obligation = isNonEmptyString(allowance.cleanupRestoreObligation)
    ? allowance.cleanupRestoreObligation
    : ''
  if (/\breload\b/iu.test(obligation)) {
    requirements.push({ label: 'the declared reload', anyOf: ['reload'] })
  }
  if (/\bclose\b/iu.test(obligation) && !allowanceSites.some(isIndexedDbOpen)) {
    requirements.push({
      label: 'the declared resource closure',
      anyOf: ['close-database', 'close-resource'],
    })
  }
  if (/\b(?:clear|delete|remove)\b/iu.test(obligation) && !allowanceSites.some(isStorageMutation)) {
    requirements.push({
      label: 'the declared durable cleanup',
      anyOf: ['delete-database', 'clear-data'],
    })
  }
  return requirements
}

function collectCleanupOwnerEffects(sites) {
  const owners = new Map()
  for (const site of sites) {
    if (cleanupEffectsForSite(site).length === 0) continue
    const id = ownerScopeId(site)
    const current = owners.get(id) ?? { sites: [] }
    current.sites.push(site)
    owners.set(id, current)
  }
  return owners
}

function ownerScopeId(site) {
  return `${site.path}::owner=${encodeURIComponent(site.owner)}`
}

function cleanupEffectsForSite(site) {
  if (Array.isArray(site.cleanupEffects)) return site.cleanupEffects
  if (isDatabaseCloseEvidence(site)) {
    return site.operation === 'indexeddb.factory.delete-database'
      ? ['delete-database', 'clear-data']
      : ['close-database']
  }
  if (site.operation === 'opfs.close') return ['close-resource']
  if (
    site.access === 'delete' ||
    /(?:\.clear|\.removeItem|\.delete(?:-object-store)?$)/u.test(site.operation)
  ) {
    return ['clear-data']
  }
  return []
}

function isIndexedDbOpen(site) {
  return site.api === 'indexeddb' && site.access === 'open'
}

function isStorageMutation(site) {
  return ['write', 'delete'].includes(site.access) && site.operation !== 'opfs.close'
}

function isDatabaseCloseEvidence(site) {
  return (
    site.api === 'indexeddb' &&
    (site.access === 'close' || site.operation === 'indexeddb.factory.delete-database')
  )
}

function sameOwnerTree(left, right) {
  return left.split('>', 1)[0] === right.split('>', 1)[0]
}

function sameSiteOwnerTree(left, right) {
  return left.path === right.path && sameOwnerTree(left.owner, right.owner)
}

function validateMutationScope(scope, location, violations) {
  if (!isRecord(scope)) {
    violations.push({
      code: 'allowance-mutation-scope-invalid',
      detail: `${location}.mutationScope must be an object.`,
    })
    return
  }
  if (!MUTATION_SCOPE_KINDS.includes(scope.kind)) {
    violations.push({
      code: 'allowance-mutation-scope-invalid',
      detail: `${location}.mutationScope.kind must be one of ${MUTATION_SCOPE_KINDS.join(', ')}.`,
    })
  }
  if (!Array.isArray(scope.targets) || scope.targets.some((target) => !isNonEmptyString(target))) {
    violations.push({
      code: 'allowance-mutation-scope-invalid',
      detail: `${location}.mutationScope.targets must be an array of non-empty strings.`,
    })
  } else if (scope.kind === 'none' && scope.targets.length !== 0) {
    violations.push({
      code: 'allowance-mutation-scope-invalid',
      detail: `${location}.mutationScope.targets must be empty when kind is none.`,
    })
  } else if (scope.kind !== 'none' && scope.targets.length === 0) {
    violations.push({
      code: 'allowance-mutation-scope-invalid',
      detail: `${location}.mutationScope.targets must name at least one mutation target.`,
    })
  }
}

function sourceFiles(root) {
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) continue
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) files.push(path)
    }
  }
  return files.sort()
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function countBy(values, keyFor) {
  const counts = new Map()
  for (const value of values) {
    const key = keyFor(value)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)))
}

function compareViolations(left, right) {
  return (
    left.code.localeCompare(right.code) ||
    (left.siteId ?? '').localeCompare(right.siteId ?? '') ||
    left.detail.localeCompare(right.detail)
  )
}

function failedResult(violations) {
  return {
    ok: false,
    schemaVersion: null,
    discoveredSiteCount: 0,
    allowedSiteCount: 0,
    uniqueAllowedSiteCount: 0,
    accessCounts: {},
    apiCounts: {},
    operationCounts: {},
    cleanupEvidenceSiteCount: 0,
    readwriteTransactionCount: 0,
    missingSiteIds: [],
    staleSiteIds: [],
    duplicateSiteIds: [],
    unpairedOpenSiteIds: [],
    sites: [],
    violations,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--discover')) {
    process.stdout.write(`${JSON.stringify(discoverE2eBrowserStorageSites(), null, 2)}\n`)
  } else {
    const result = auditE2eBrowserStorage()
    const { sites: _sites, ...summary } = result
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    if (!result.ok) process.exitCode = 1
  }
}
