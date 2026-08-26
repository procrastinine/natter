import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { staticAuditState } from './audit-result-state.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DEFAULT_INVENTORY = resolve(ROOT, 'scripts/storage-ownership-reclamation-inventory.mjs')
const REQUIRED_NAMESPACE_IDS = Object.freeze([
  'idb-control',
  'idb-workspace-legacy',
  'idb-workspace-a',
  'idb-workspace-b',
  'idb-other-origin',
  'local-workspace-change',
  'local-slot-control',
  'local-storage-administration',
  'local-compaction-intents',
  'session-workspace-fence',
  'session-conversation',
  'session-composer-draft',
  'session-active-seed',
  'session-preload-recovery',
  'cache-storage-all',
  'opfs-all',
  'storage-buckets-all',
  'service-workers-all',
  'visible-cookies-all',
])
const REQUIRED_LIFECYCLE_IDS = Object.freeze([
  'control-manifest',
  'recover-preparing-discard',
  'nonblocking-pending-selection',
  'slot-switching-capability',
  'unslotted-replacement',
  'post-commit-debt-queue',
  'crash-intent-recovery',
  'compaction-threshold',
  'compaction-attempt-release',
  'retention-owner',
  'bounded-retention-pass',
  'orphan-workspace-database-sweep',
  'compaction-readiness',
  'idle-compaction-admission',
  'paged-compaction-copy',
  'retention-owned-slot-cleanup',
  'journal-authorized-peer-recovery',
  'clear-all-origin-wipe',
  'quota-probe',
])
const REQUIRED_COORDINATION_IDS = Object.freeze([
  'workspace-write-lock',
  'workspace-change-transport',
  'lock-wake-transport',
  'slot-control-transport',
  'storage-administration-transport',
  'retention-owner-lock',
])
const REQUIRED_GAP_IDS = Object.freeze([
  'compaction-unavailable-without-locks-or-transport',
  'logical-debt-does-not-measure-physical-amplification',
  'unknown-historical-databases-unverifiable-without-enumeration',
  'quota-estimate-cannot-prove-reclamation',
])
const VALID_DEBT_POLICIES = new Set([
  'typed-owner-port',
  'specialized-cache-port',
  'specialized-journal-port',
  'ephemeral-no-debt',
  'mixed-settings-ports',
])
const VALID_RETENTION = new Set([
  'explicit-owner-delete',
  'age-based-retention',
  'bounded-cache',
  'rebuild-on-repair',
  'lease-expiry',
  'mixed',
])
const VALID_REBUILD = new Set([
  'authoritative',
  'derived-from-authoritative',
  'cache-refetch',
  'journal-recovery',
  'ephemeral-recreate',
])
const VALID_MULTI_TAB = new Set([
  'workspace-write-lock-changefeed',
  'coordination-lock',
  'attempt-owner-lock-changefeed',
])

export function evaluateStorageOwnershipReclamation(
  root,
  inventoryModule,
  mode = 'inventory',
  initialProblems = [],
) {
  if (mode !== 'inventory' && mode !== 'enforce') {
    throw new Error(`StorageOwnershipReclamationAuditModeInvalid:${mode}`)
  }
  const report = auditStorageOwnershipReclamation(root, inventoryModule, initialProblems)
  const structurallyValid = report.problems.length === 0
  return Object.freeze({
    mode,
    ok: structurallyValid && (mode !== 'enforce' || report.gaps.length === 0),
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps: report.gaps }),
    tableCount: report.tableCount,
    schemaClassCounts: report.schemaClassCounts,
    dataClassCounts: report.dataClassCounts,
    compactionActionCounts: report.compactionActionCounts,
    interchangeActionCounts: report.interchangeActionCounts,
    namespaceCount: report.namespaceCount,
    lifecycleCount: report.lifecycleCount,
    coordinationCount: report.coordinationCount,
    directBroadcastOwnerCount: report.directBroadcastOwnerCount,
    gapCount: report.gaps.length,
    acceptanceCount: report.acceptanceCount,
    directWebStorageOwnerCount: report.directWebStorageOwnerCount,
    gaps: report.gaps,
    problems: report.problems,
  })
}

export function auditStorageOwnershipReclamation(root, inventoryModule, initialProblems = []) {
  const problems = [...initialProblems]
  const tables = inventoryModule?.STORAGE_TABLE_OWNERSHIP
  const namespaces = inventoryModule?.ORIGIN_STORAGE_NAMESPACES
  const lifecycles = inventoryModule?.STORAGE_LIFECYCLE_PATHS
  const coordination = inventoryModule?.STORAGE_COORDINATION_MECHANISMS
  const gaps = inventoryModule?.STORAGE_RECLAMATION_GAPS
  const acceptance = inventoryModule?.STORAGE_RECLAMATION_ACCEPTANCE

  const physicalStoragePath = resolve(root, 'src/store/physical-storage-tables.ts')
  const basePhysicalTables = discoverStringArray(
    physicalStoragePath,
    'PHYSICAL_STORAGE_TABLE_NAMES',
    problems,
  )
  const classTables = discoverNatterDbTables(resolve(root, 'src/store/db.ts'), problems)
  if (!sameSortedStrings(basePhysicalTables, classTables)) {
    problems.push(
      `tables: physical-list=${sorted(basePhysicalTables).join(',')}; NatterDb=${sorted(classTables).join(',')}`,
    )
  }
  const basePhysicalPolicy = discoverPhysicalStoragePolicy(physicalStoragePath, problems)
  const physicalPolicyVocabulary = {
    schema: new Set(
      discoverStringUnion(physicalStoragePath, 'PhysicalStorageSchemaClass', problems),
    ),
    data: new Set(discoverStringUnion(physicalStoragePath, 'PhysicalStorageDataClass', problems)),
    compaction: new Set(
      discoverStringUnion(physicalStoragePath, 'PhysicalStorageCompactionAction', problems),
    ),
    interchange: new Set(
      discoverStringUnion(physicalStoragePath, 'PhysicalStorageInterchangeAction', problems),
    ),
  }
  validatePhysicalStoragePolicy(basePhysicalPolicy, physicalPolicyVocabulary, problems)
  if (!sameSortedStrings(basePhysicalTables, [...basePhysicalPolicy.keys()])) {
    problems.push('storage-policy: policy keys do not cover every physical table exactly once')
  }
  if (basePhysicalTables.join('\0') !== [...basePhysicalPolicy.keys()].join('\0')) {
    problems.push('storage-policy: canonical order changed')
  }
  const physicalPolicy = withCatchupJournalPolicies(basePhysicalPolicy)
  const physicalTables = [...physicalPolicy.keys()]
  validatePhysicalStoragePolicyConsumers(root, problems)

  validateExactIds(tables, physicalTables, 'tables', 'name', problems, true)
  validateExactIds(namespaces, REQUIRED_NAMESPACE_IDS, 'namespaces', 'id', problems, true)
  validateExactIds(lifecycles, REQUIRED_LIFECYCLE_IDS, 'lifecycles', 'id', problems, true)
  validateExactIds(coordination, REQUIRED_COORDINATION_IDS, 'coordination', 'id', problems, true)
  validateExactIds(gaps, REQUIRED_GAP_IDS, 'gaps', 'id', problems, true)

  const gapIds = new Set(Array.isArray(gaps) ? gaps.map((gap) => gap?.id) : [])
  validateTables(root, tables, physicalPolicy, physicalPolicyVocabulary, gapIds, problems)
  validateNamespaces(root, namespaces, gapIds, problems)
  validateSourceRecords(root, lifecycles, 'lifecycles', gapIds, problems, true)
  validateSourceRecords(root, coordination, 'coordination', gapIds, problems, false)
  validateSourceRecords(root, gaps, 'gaps', gapIds, problems, false)
  validateWorkspaceReplacementLifecycle(root, problems)
  validateCompactionAttemptRelease(root, problems)
  validateSynchronousTransactionLocalDebtAccounting(root, problems)
  validateTransactionPromiseOwnership(root, problems)
  validateCompactionTransactionPromiseOwnership(root, problems)
  validateControlDatabaseTransactionIsolation(root, problems)
  validateOrphanWorkspaceReclamation(root, problems)
  validateAcceptance(acceptance, problems)

  const registeredDatabaseNames = discoverOriginDatabaseNames(root, problems)
  const inventoriedDatabaseNames = Array.isArray(namespaces)
    ? namespaces
        .filter((entry) => entry?.kind === 'indexeddb')
        .map((entry) => entry.key)
        .filter(isNonEmptyString)
    : []
  if (!sameSortedStrings(registeredDatabaseNames, inventoriedDatabaseNames)) {
    problems.push(
      `namespaces: registered-indexeddb=${sorted(registeredDatabaseNames).join(',')}; inventoried=${sorted(inventoriedDatabaseNames).join(',')}`,
    )
  }

  const directWebStorageOwners = discoverDirectWebStorageOwners(root)
  const inventoriedAccessPaths = new Set(
    Array.isArray(namespaces)
      ? namespaces.flatMap((entry) => (Array.isArray(entry?.accessPaths) ? entry.accessPaths : []))
      : [],
  )
  for (const path of directWebStorageOwners) {
    if (!inventoriedAccessPaths.has(path)) {
      problems.push(`namespaces: unowned direct web-storage access: ${path}`)
    }
  }
  const directBroadcastOwners = discoverDirectBroadcastOwners(root)
  const coordinationPaths = new Set(
    Array.isArray(coordination) ? coordination.map((entry) => entry?.path) : [],
  )
  for (const path of directBroadcastOwners) {
    if (!coordinationPaths.has(path)) {
      problems.push(`coordination: unowned BroadcastChannel construction: ${path}`)
    }
  }

  const normalizedGaps = Array.isArray(gaps)
    ? gaps
        .filter(isRecord)
        .map((gap) => ({ id: gap.id, rationale: gap.rationale, path: gap.path }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    : []
  const validTables = Array.isArray(tables) ? tables.filter(isRecord) : []
  problems.sort()
  return {
    tableCount: validTables.length,
    schemaClassCounts: countBy(validTables, 'schemaClass'),
    dataClassCounts: countBy(validTables, 'dataClass'),
    compactionActionCounts: countBy(validTables, 'compaction'),
    interchangeActionCounts: countBy(validTables, 'interchange'),
    namespaceCount: Array.isArray(namespaces) ? namespaces.length : 0,
    lifecycleCount: Array.isArray(lifecycles) ? lifecycles.length : 0,
    coordinationCount: Array.isArray(coordination) ? coordination.length : 0,
    acceptanceCount: Array.isArray(acceptance) ? acceptance.length : 0,
    directWebStorageOwnerCount: directWebStorageOwners.length,
    directBroadcastOwnerCount: directBroadcastOwners.length,
    gaps: normalizedGaps,
    problems,
  }
}

export function discoverCanonicalPhysicalStorageTableNames(root = ROOT) {
  const problems = []
  const policies = discoverPhysicalStoragePolicy(
    resolve(root, 'src/store/physical-storage-tables.ts'),
    problems,
  )
  if (problems.length > 0) {
    throw new Error(`PhysicalStoragePolicyDiscoveryFailed:${problems.join('|')}`)
  }
  return Object.freeze(
    [...policies].filter(([, policy]) => policy.schema === 'canonical').map(([name]) => name),
  )
}

export function discoverBrowserWorkspaceDatabaseNames(root = ROOT) {
  const problems = []
  const names = discoverOriginDatabaseNames(root, problems).slice(1)
  if (problems.length > 0 || names.length === 0) {
    throw new Error(`BrowserWorkspaceDatabaseNameDiscoveryFailed:${problems.join('|')}`)
  }
  return Object.freeze(names)
}

function validateCompactionAttemptRelease(root, problems) {
  const expectations = [
    [
      'src/store/browser-workspace-compaction.ts',
      'if (!isRetryableBrowserWorkspaceCompactionError(error) || attemptState.claim === null)',
    ],
    [
      'src/store/browser-workspace-compaction.ts',
      'const release = await attemptState.claim.release()',
    ],
    [
      'src/store/browser-workspace-compaction.ts',
      'if (release.released) publishStorageCompactionRequest()',
    ],
    [
      'src/store/browser-workspace-database-control.ts',
      'requestRevision: Math.max(previous.requestRevision, saturatingAdd(revision, 1))',
    ],
    [
      'src/store/browser-workspace-database-control.ts',
      'attemptedRevision: previous.completedRevision',
    ],
    [
      'tests/unit/storage-compaction-state.test.ts',
      "it('atomically requeues only the exact uncommitted attempt without new debt'",
    ],
    [
      'tests/unit/storage-retention.test.ts',
      "it('keeps foreground work live without repeating the physical copy'",
    ],
    [
      'tests/e2e/storage-reclamation.spec.ts',
      "test('normal use catches up foreground work without repeating the physical copy and preserves two-tab state'",
    ],
  ]
  for (const [path, locator] of expectations) {
    const source = readFileSync(resolve(root, path), 'utf8')
    if (!source.includes(locator)) {
      problems.push(`compaction-attempt-release: missing exact evidence: ${path}: ${locator}`)
    }
  }
}

function validateSynchronousTransactionLocalDebtAccounting(root, problems) {
  const ownerNames = new Set(['recordObsoleteByteOwnerBytes', 'recordObsoleteByteOwnerValues'])
  const declarationCounts = new Map([...ownerNames].map((name) => [name, 0]))
  for (const path of sourceFiles(resolve(root, 'src'))) {
    const sourceFile = sourceFileFor(path)
    const relativePath = relative(root, path).split('\\').join('/')
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name && ownerNames.has(node.name.text)) {
        declarationCounts.set(node.name.text, (declarationCounts.get(node.name.text) ?? 0) + 1)
        if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
          problems.push(`transaction-local-debt: async owner: ${relativePath}:${node.name.text}`)
        }
        if (node.type?.kind !== ts.SyntaxKind.VoidKeyword) {
          problems.push(`transaction-local-debt: non-void owner: ${relativePath}:${node.name.text}`)
        }
      }
      if (ts.isAwaitExpression(node)) {
        const expression = unwrapExpression(node.expression)
        if (
          expression &&
          ts.isCallExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          ownerNames.has(expression.expression.text)
        ) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
          problems.push(
            `transaction-local-debt: awaited synchronous accounting: ${relativePath}:${line}:${expression.expression.text}`,
          )
        }
      }
      node.forEachChild(visit)
    }
    visit(sourceFile)
  }
  for (const [name, count] of declarationCounts) {
    if (count !== 1)
      problems.push(`transaction-local-debt: ${name} declarations=${count}; expected=1`)
  }
}

function validateTransactionPromiseOwnership(root, problems) {
  const reported = new Set()
  const report = (sourceFile, relativePath, node) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    const problem = `transaction-owned-promise: native Promise.${node.expression.name.text}: ${relativePath}:${line}`
    if (reported.has(problem)) return
    reported.add(problem)
    problems.push(problem)
  }
  const isNativePromiseCall = (node) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Promise'
  const ownsTransactionParameter = (node) =>
    ts.isFunctionLike(node) &&
    node.parameters.some(
      (parameter) =>
        ts.isIdentifier(parameter.name) &&
        (parameter.name.text === 'tx' || parameter.name.text === 'transaction'),
    )
  for (const path of sourceFiles(resolve(root, 'src/store'))) {
    const relativePath = relative(root, path)
    const sourceFile = sourceFileFor(path)
    const inspect = (node, transactionOwned = false) => {
      const owned = transactionOwned || ownsTransactionParameter(node)
      if (owned && isNativePromiseCall(node)) report(sourceFile, relativePath, node)
      if (ts.isCallExpression(node) && transactionRunnerName(node.expression) !== undefined) {
        const operation = node.arguments.at(-1)
        if (operation && (ts.isArrowFunction(operation) || ts.isFunctionExpression(operation))) {
          inspect(operation.body, true)
        }
      }
      node.forEachChild((child) => inspect(child, owned))
    }
    inspect(sourceFile)
  }
}

function validateCompactionTransactionPromiseOwnership(root, problems) {
  const relativePath = 'src/store/browser-workspace-compaction.ts'
  const path = resolve(root, relativePath)
  const source = readFileSync(path, 'utf8')
  const sourceFile = sourceFileFor(path)
  const required = [
    'operation: (transaction: Transaction) => PromiseExtended<T> | T',
    'function runDestinationCompactionTransaction<T>(',
    "const transaction = backend.transaction([journalName, tableName], 'readonly')",
    'const cursorRequest = journalStore.openCursor(',
    'rows.forEach((journal, index) => {',
    'const request = sourceStore.get(journal.sourceKey as IDBValidKey)',
    "const transaction = backend.transaction(journalName, 'readwrite')",
    'const request = store.get(journal.id)',
    'if (current?.revision !== journal.revision) return',
    'const deletion = store.delete(journal.id)',
    'transaction.oncomplete = () => {',
    '`observe-catchup:$' + '{tableName}`',
    '`apply-catchup:$' + '{tableName}`',
    "'observe-final-workspace-meta'",
    "'finalize-workspace-meta'",
  ]
  for (const token of required) {
    if (!source.includes(token)) {
      problems.push(`compaction-transaction-owned-promise: missing ${token}`)
    }
  }
  if (source.includes('journalTable.get(journal.id)')) {
    problems.push('compaction-transaction-owned-promise: retained sequential journal reread')
  }
  const catchupRead = source.slice(
    source.indexOf('async function readBrowserWorkspaceCatchupPage('),
    source.indexOf('async function deactivateSourceCatchupJournals('),
  )
  for (const forbidden of ['runSourceCompactionTransaction(', '.toArray()', '.bulkGet(']) {
    if (catchupRead.includes(forbidden)) {
      problems.push(`compaction-transaction-owned-promise: catch-up read retained ${forbidden}`)
    }
  }
  const catchupAcknowledgement = source.slice(
    source.indexOf('async function acknowledgeBrowserWorkspaceCatchupPage('),
    source.indexOf('function runDestinationCompactionTransaction<T>('),
  )
  for (const forbidden of ['runSourceCompactionTransaction(', '.bulkGet(', '.bulkDelete(']) {
    if (catchupAcknowledgement.includes(forbidden)) {
      problems.push(
        `compaction-transaction-owned-promise: catch-up acknowledgement retained ${forbidden}`,
      )
    }
  }
  const transactionRunners = new Set(['runDestinationCompactionTransaction'])
  const destinationReadMethods = new Set(['get', 'bulkGet', 'toArray', 'first', 'last', 'count'])
  const destinationWriteMethods = new Set([
    'add',
    'bulkAdd',
    'put',
    'bulkPut',
    'delete',
    'bulkDelete',
    'clear',
    'modify',
  ])
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      transactionRunners.has(node.expression.text)
    ) {
      const operation = node.arguments.at(-1)
      if (
        operation &&
        (ts.isArrowFunction(operation) || ts.isFunctionExpression(operation)) &&
        operation.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(operation.getStart(sourceFile)).line + 1
        problems.push(
          `compaction-transaction-owned-promise: async transaction scope: ${relativePath}:${line}`,
        )
      }
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'runDestinationCompactionTransaction' &&
        operation &&
        (ts.isArrowFunction(operation) || ts.isFunctionExpression(operation))
      ) {
        const methods = new Set()
        const collectMethods = (candidate) => {
          if (
            ts.isCallExpression(candidate) &&
            ts.isPropertyAccessExpression(candidate.expression)
          ) {
            methods.add(candidate.expression.name.text)
          }
          candidate.forEachChild(collectMethods)
        }
        collectMethods(operation.body)
        const reads = [...methods].filter((method) => destinationReadMethods.has(method))
        const writes = [...methods].filter((method) => destinationWriteMethods.has(method))
        if (reads.length > 0 && writes.length > 0) {
          const line =
            sourceFile.getLineAndCharacterOfPosition(operation.getStart(sourceFile)).line + 1
          problems.push(
            `compaction-transaction-owned-promise: destination read/write continuation: ${relativePath}:${line}: reads=${reads.join(',')}: writes=${writes.join(',')}`,
          )
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)

  const workspaceMetaPath = resolve(root, 'src/store/workspace-meta.ts')
  const workspaceMeta = readFileSync(workspaceMetaPath, 'utf8')
  for (const signature of [
    'export function readBrowserWorkspaceMetaFromTransaction(',
    'export function markBrowserWorkspaceReplaced(',
    '): PromiseExtended<',
  ]) {
    if (!workspaceMeta.includes(signature)) {
      problems.push(`compaction-transaction-owned-promise: workspace meta missing ${signature}`)
    }
  }
}

function validateControlDatabaseTransactionIsolation(root, problems) {
  const path = resolve(root, 'src/store/browser-workspace-database-control.ts')
  const sourceFile = sourceFileFor(path)
  const declarations = sourceFile.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'withControlDb',
  )
  if (declarations.length !== 1) {
    problems.push(
      `control-database-transaction-isolation: withControlDb declarations=${declarations.length}; expected=1`,
    )
    return
  }
  let isolated = false
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Dexie' &&
      node.expression.name.text === 'ignoreTransaction'
    ) {
      isolated = true
    }
    node.forEachChild(visit)
  }
  visit(declarations[0])
  if (!isolated) {
    problems.push(
      'control-database-transaction-isolation: withControlDb must start in Dexie.ignoreTransaction',
    )
  }
}

function transactionRunnerName(expression) {
  if (ts.isIdentifier(expression) && expression.text === 'runDestinationTransaction') {
    return expression.text
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    (expression.name.text === 'transaction' || expression.name.text === 'runTransaction')
  ) {
    return expression.name.text
  }
  return undefined
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
      throw new Error(`Unknown storage-ownership-reclamation argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    if (arg === '--inventory') parsed.inventory = resolve(value)
    else {
      if (value !== 'inventory' && value !== 'enforce') {
        throw new Error(`Invalid storage-ownership-reclamation mode: ${value}`)
      }
      parsed.mode = value
    }
    index += 1
  }
  return parsed
}

function validateTables(root, entries, physicalPolicy, physicalPolicyVocabulary, gapIds, problems) {
  if (!Array.isArray(entries)) return
  for (const entry of entries) {
    if (!isRecord(entry) || !isNonEmptyString(entry.name)) continue
    const prefix = `tables:${entry.name}`
    const expectedPolicy = physicalPolicy.get(entry.name)
    requireEnum(
      entry.schemaClass,
      physicalPolicyVocabulary.schema,
      `${prefix}: schemaClass`,
      problems,
    )
    requireEnum(entry.dataClass, physicalPolicyVocabulary.data, `${prefix}: dataClass`, problems)
    requireEnum(
      entry.compaction,
      physicalPolicyVocabulary.compaction,
      `${prefix}: compaction`,
      problems,
    )
    requireEnum(
      entry.interchange,
      physicalPolicyVocabulary.interchange,
      `${prefix}: interchange`,
      problems,
    )
    for (const [field, sourceField] of [
      ['schemaClass', 'schema'],
      ['dataClass', 'data'],
      ['compaction', 'compaction'],
      ['interchange', 'interchange'],
    ]) {
      const expected = expectedPolicy?.[sourceField]
      if (entry[field] !== expected) {
        problems.push(`${prefix}: ${field}=${entry[field]}; source=${expected}`)
      }
    }
    requireText(entry.owner, `${prefix}: owner`, problems)
    validatePath(root, entry.ownerPath, `${prefix}: ownerPath`, problems)
    requireText(entry.sizeDriver, `${prefix}: sizeDriver`, problems)
    requireEnum(entry.debtPolicy, VALID_DEBT_POLICIES, `${prefix}: debtPolicy`, problems)
    requireEnum(entry.retention, VALID_RETENTION, `${prefix}: retention`, problems)
    requireEnum(entry.rebuild, VALID_REBUILD, `${prefix}: rebuild`, problems)
    if (entry.wipeCoverage !== 'workspace-database-delete') {
      problems.push(`${prefix}: wipeCoverage=${entry.wipeCoverage}`)
    }
    requireText(entry.normalReclamation, `${prefix}: normalReclamation`, problems)
    requireEnum(entry.multiTab, VALID_MULTI_TAB, `${prefix}: multiTab`, problems)
    validatePaths(root, entry.testEvidence, `${prefix}: testEvidence`, problems)
    validateGapReferences(entry.gapIds, gapIds, `${prefix}: gapIds`, problems)
    if (entry.dataClass !== 'ephemeral' && entry.gapIds.length === 0) {
      problems.push(`${prefix}: non-ephemeral table has no explicit current gap linkage`)
    }
  }
}

function validateNamespaces(root, entries, gapIds, problems) {
  if (!Array.isArray(entries)) return
  const validKinds = new Set([
    'indexeddb',
    'indexeddb-enumerated',
    'local-storage-key',
    'local-storage-prefix',
    'session-storage-key',
    'session-storage-prefix',
    'cache-storage',
    'opfs',
    'storage-buckets',
    'service-workers',
    'cookies',
  ])
  for (const entry of entries) {
    if (!isRecord(entry) || !isNonEmptyString(entry.id)) continue
    const prefix = `namespaces:${entry.id}`
    requireEnum(entry.kind, validKinds, `${prefix}: kind`, problems)
    requireText(entry.key, `${prefix}: key`, problems)
    validatePath(root, entry.path, `${prefix}: path`, problems)
    validatePaths(root, entry.accessPaths, `${prefix}: accessPaths`, problems)
    requireText(entry.ownership, `${prefix}: ownership`, problems)
    requireText(entry.normalReclamation, `${prefix}: normalReclamation`, problems)
    requireText(entry.wipeCoverage, `${prefix}: wipeCoverage`, problems)
    validateGapReferences(entry.gapIds, gapIds, `${prefix}: gapIds`, problems)
    if (entry.key !== '*' && isNonEmptyString(entry.path)) {
      const occurrences = countStringLiteral(resolve(root, entry.path), entry.key)
      if (occurrences < 1) {
        problems.push(`${prefix}: key literal occurrences=0; expected>=1`)
      }
    }
  }
}

function validateSourceRecords(root, entries, label, gapIds, problems, requireGapIds) {
  if (!Array.isArray(entries)) return
  for (const entry of entries) {
    if (!isRecord(entry) || !isNonEmptyString(entry.id)) continue
    const prefix = `${label}:${entry.id}`
    if (!validatePath(root, entry.path, `${prefix}: path`, problems)) continue
    requireText(entry.locator, `${prefix}: locator`, problems)
    requireText(entry.rationale, `${prefix}: rationale`, problems)
    if (isNonEmptyString(entry.locator)) {
      const occurrences = countOccurrences(
        readFileSync(resolve(root, entry.path), 'utf8'),
        entry.locator,
      )
      if (occurrences !== 1) {
        problems.push(`${prefix}: locator occurrences=${occurrences}; expected=1`)
      }
    }
    if (requireGapIds) validateGapReferences(entry.gapIds, gapIds, `${prefix}: gapIds`, problems)
  }
}

function validateAcceptance(entries, problems) {
  if (!Array.isArray(entries)) {
    problems.push('acceptance: must be an array')
    return
  }
  if (entries.length < 8) problems.push(`acceptance: count=${entries.length}; expected>=8`)
  for (const [index, entry] of entries.entries()) {
    requireText(entry, `acceptance:${index}`, problems)
  }
  for (const duplicate of duplicates(entries)) problems.push(`acceptance: duplicate: ${duplicate}`)
}

function validateOrphanWorkspaceReclamation(root, problems) {
  const sweep = readFileSync(
    resolve(root, 'src/store/browser-workspace-orphan-reclamation.ts'),
    'utf8',
  )
  const retention = readFileSync(resolve(root, 'src/store/storage-maintenance-runtime.ts'), 'utf8')
  const proofs = [
    'tests/unit/browser-workspace-orphan-reclamation.test.ts',
    'tests/unit/storage-retention.test.ts',
  ]
    .map((path) => readFileSync(resolve(root, path), 'utf8'))
    .join('\n')
  for (const [token, expected] of [
    ['tryWithBrowserWorkspaceSelectionGate(', 2],
    ['tryWithExclusiveBrowserWorkspaceSlot(', 1],
    ['Dexie.delete(', 1],
  ]) {
    const actual = countOccurrences(sweep, token)
    if (actual !== expected) {
      problems.push(`orphan-workspace-sweep: ${token} occurrences=${actual}; expected=${expected}`)
    }
  }
  if (/\b(?:setTimeout|setInterval|requestIdleCallback)\s*\(/u.test(sweep)) {
    problems.push('orphan-workspace-sweep: polling or delay API is forbidden')
  }
  if (countOccurrences(retention, 'await reclaimInactiveBrowserWorkspaceDatabases()') !== 1) {
    problems.push('orphan-workspace-sweep: retention-pass ownership missing or duplicated')
  }
  for (const proof of [
    'deletes only inactive registered slots without opening workspace tables or deleting active and control databases',
    'skips an active peer slot and reclaims it on a later explicit retention pass',
    'retries a peer-held inactive workspace only after a later retention invalidation',
    'does no slot work while a durable replacement journal is pending',
    'returns immediately without reading or deleting when selection is in progress',
    'holds selection continuously from candidate revalidation through physical deletion',
    'contains a delete failure to the failed slot without poisoning other reclamation',
  ]) {
    if (countOccurrences(proofs, proof) !== 1) {
      problems.push(`orphan-workspace-sweep: missing exact proof: ${proof}`)
    }
  }
}

function validateWorkspaceReplacementLifecycle(root, problems) {
  const control = readFileSync(
    resolve(root, 'src/store/browser-workspace-database-control.ts'),
    'utf8',
  )
  const cleanup = readFileSync(
    resolve(root, 'src/store/browser-workspace-database-cleanup.ts'),
    'utf8',
  )
  const selection = readFileSync(
    resolve(root, 'src/store/browser-workspace-database-selection.ts'),
    'utf8',
  )
  const replacement = readFileSync(
    resolve(root, 'src/store/browser-workspace-replacement-runner.ts'),
    'utf8',
  )
  const retention = readFileSync(resolve(root, 'src/store/storage-maintenance-runtime.ts'), 'utf8')
  const proofs = [
    'tests/unit/browser-workspace-database-control.test.ts',
    'tests/unit/browser-workspace-replacement-transition.test.ts',
    'tests/unit/db-open-recovery.test.ts',
    'tests/unit/storage-retention.test.ts',
  ]
    .map((path) => readFileSync(resolve(root, path), 'utf8'))
    .join('\n')

  for (const [source, token, expected, label] of [
    [control, "readonly phase: 'discard'", 1, 'durable discard journal variant'],
    [
      cleanup,
      'await abandonPreparedBrowserWorkspaceDatabase(expected)',
      1,
      'selection-owned cleanup abandon',
    ],
    [cleanup, 'withExclusiveBrowserWorkspaceSlots(', 1, 'obsolete-slot lock'],
    [cleanup, 'withBrowserWorkspaceSelectionGate(', 2, 'peer recovery and cleanup selection gates'],
    [cleanup, 'await Dexie.delete(databaseName)', 1, 'physical obsolete-slot delete'],
    [
      cleanup,
      'await completeBrowserWorkspaceDatabaseCleanup(journal)',
      1,
      'journal acknowledgement',
    ],
    [retention, 'cleanPendingBrowserWorkspaceDatabase(this.#ownerSignal())', 1, 'retention owner'],
    [
      replacement,
      'createBrowserWorkspaceReplacementTransitionController({',
      1,
      'replacement transition construction',
    ],
  ]) {
    const actual = countOccurrences(source, token)
    if (actual !== expected) {
      problems.push(`workspace-replacement: ${label} occurrences=${actual}; expected=${expected}`)
    }
  }
  for (const [source, token, label] of [
    [selection, 'Dexie.delete(', 'selection physical deletion'],
    [cleanup, 'indexedDB.databases(', 'cleanup namespace enumeration'],
    [replacement, 'completeBrowserWorkspaceDatabaseCleanup(', 'replacement physical cleanup'],
    [replacement, 'Dexie.delete(journal.sourceDatabaseName)', 'committed source deletion'],
  ]) {
    if (source.includes(token)) problems.push(`workspace-replacement: forbidden ${label}`)
  }
  for (const proof of [
    'keeps a malformed authoritative source selected and cleans under one selection admission',
    'keeps active-slot selection ready while old-slot deletion waits on a peer',
    'cleans one journaled slot without enumerating or opening workspace stores',
    'waits on durable selection ownership then resumes before discarding an abandoned destination',
    'recovers an activated quiesced peer before obsolete source cleanup',
    'attempts every committed finalizer and retains every failure',
    'never guesses rollback or publication after an uncertain activation',
    'memoizes terminal finalization and rejects a durability downgrade',
    'drains an abandoned workspace slot under the existing retention owner',
    'blocks pending-journal compaction before quiescing the active runtime',
  ]) {
    if (countOccurrences(proofs, proof) !== 1) {
      problems.push(`workspace-replacement: missing exact proof: ${proof}`)
    }
  }
}

function validateExactIds(entries, expected, label, field, problems, requireOrder) {
  if (!Array.isArray(entries)) {
    problems.push(`${label}: must be an array`)
    return
  }
  const ids = entries.map((entry) => entry?.[field])
  for (const duplicate of duplicates(ids))
    problems.push(`${label}: duplicate ${field}: ${duplicate}`)
  for (const stale of difference(ids, expected)) problems.push(`${label}: stale ${field}: ${stale}`)
  for (const missing of difference(expected, ids))
    problems.push(`${label}: missing ${field}: ${missing}`)
  if (requireOrder && ids.join('\0') !== expected.join('\0')) {
    problems.push(`${label}: canonical order changed`)
  }
}

function validateGapReferences(entries, gapIds, label, problems) {
  if (!Array.isArray(entries)) {
    problems.push(`${label}: must be an array`)
    return
  }
  for (const duplicate of duplicates(entries)) problems.push(`${label}: duplicate: ${duplicate}`)
  for (const gapId of entries) {
    if (!gapIds.has(gapId)) problems.push(`${label}: unknown gap: ${gapId}`)
  }
}

function validatePaths(root, paths, label, problems) {
  if (!Array.isArray(paths) || paths.length === 0) {
    problems.push(`${label}: must be a non-empty array`)
    return
  }
  for (const duplicate of duplicates(paths)) problems.push(`${label}: duplicate: ${duplicate}`)
  for (const path of paths) validatePath(root, path, label, problems)
}

function validatePath(root, path, label, problems) {
  if (!isNonEmptyString(path) || !isExactRepoPath(path)) {
    problems.push(`${label}: invalid exact source path: ${path}`)
    return false
  }
  const absolute = resolve(root, path)
  const relativePath = relative(root, absolute)
  if (relativePath.startsWith('..') || isAbsolute(relativePath) || !existsSync(absolute)) {
    problems.push(`${label}: path does not exist: ${path}`)
    return false
  }
  return true
}

function discoverStringArray(path, variableName, problems) {
  const initializer = variableInitializer(path, variableName, problems)
  const expression = unwrapExpression(initializer)
  if (!expression || !ts.isArrayLiteralExpression(expression)) {
    problems.push(`discovery:${variableName}: expected array literal`)
    return []
  }
  return stringElements(expression, variableName, problems)
}

function discoverPhysicalStoragePolicy(path, problems) {
  let expression = unwrapExpression(variableInitializer(path, 'PHYSICAL_STORAGE_POLICY', problems))
  if (
    expression &&
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === 'Object' &&
    expression.expression.name.text === 'freeze'
  ) {
    expression = unwrapExpression(expression.arguments[0])
  }
  if (!expression || !ts.isObjectLiteralExpression(expression)) {
    problems.push('discovery:PHYSICAL_STORAGE_POLICY: expected Object.freeze(object literal)')
    return new Map()
  }
  const policies = new Map()
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) {
      problems.push('discovery:PHYSICAL_STORAGE_POLICY: expected property assignments only')
      continue
    }
    const name = propertyNameText(property.name)
    if (!name) {
      problems.push('discovery:PHYSICAL_STORAGE_POLICY: unsupported property name')
      continue
    }
    if (policies.has(name)) {
      problems.push(`discovery:PHYSICAL_STORAGE_POLICY: duplicate property: ${name}`)
      continue
    }
    const call = unwrapExpression(property.initializer)
    if (
      !call ||
      !ts.isCallExpression(call) ||
      !ts.isIdentifier(call.expression) ||
      call.expression.text !== 'policy' ||
      call.arguments.length < 5 ||
      call.arguments.length > 6
    ) {
      problems.push(`discovery:PHYSICAL_STORAGE_POLICY:${name}: expected policy(a,b,c,d,e[,f])`)
      continue
    }
    const values = call.arguments.slice(0, 4).map((argument) => {
      const value = unwrapExpression(argument)
      return value && ts.isStringLiteralLike(value) ? value.text : undefined
    })
    if (values.some((value) => value === undefined)) {
      problems.push(`discovery:PHYSICAL_STORAGE_POLICY:${name}: expected string arguments`)
      continue
    }
    policies.set(name, {
      schema: values[0],
      data: values[1],
      compaction: values[2],
      interchange: values[3],
    })
  }
  return policies
}

function withCatchupJournalPolicies(basePolicies) {
  const policies = new Map(basePolicies)
  for (const [name, policy] of basePolicies) {
    if (policy.compaction !== 'copy' && policy.compaction !== 'filtered-copy') continue
    policies.set(`replacementCatchup__${name}`, {
      schema: 'canonical',
      data: 'journal',
      compaction: 'seed',
      interchange: 'omit',
    })
  }
  return policies
}

function discoverStringUnion(path, typeName, problems) {
  const sourceFile = sourceFileFor(path)
  let declaration
  const visit = (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) declaration = node
    node.forEachChild(visit)
  }
  visit(sourceFile)
  if (!declaration) {
    problems.push(`discovery:${typeName}: declaration not found`)
    return []
  }
  const nodes = ts.isUnionTypeNode(declaration.type) ? declaration.type.types : [declaration.type]
  const values = []
  for (const node of nodes) {
    if (!ts.isLiteralTypeNode(node) || !ts.isStringLiteralLike(node.literal)) {
      problems.push(`discovery:${typeName}: expected string literal union`)
      continue
    }
    values.push(node.literal.text)
  }
  return values
}

function validatePhysicalStoragePolicy(policies, vocabulary, problems) {
  for (const [name, policy] of policies) {
    for (const field of ['schema', 'data', 'compaction', 'interchange']) {
      requireEnum(policy[field], vocabulary[field], `storage-policy:${name}:${field}`, problems)
    }
  }
}

function validatePhysicalStoragePolicyConsumers(root, problems) {
  const db = readFileSync(resolve(root, 'src/store/db.ts'), 'utf8')
  const mutationJournal = readFileSync(
    resolve(root, 'src/store/browser-command-mutation-journal.ts'),
    'utf8',
  )
  const compaction = readFileSync(
    resolve(root, 'src/store/browser-workspace-compaction.ts'),
    'utf8',
  )
  for (const [source, token, expected, label] of [
    [
      db,
      'const CANONICAL_BROWSER_WORKSPACE_STORES = new Set<string>([',
      1,
      'canonical schema classification',
    ],
    [
      db,
      'new Set<string>(REPAIRABLE_PHYSICAL_STORAGE_TABLE_NAMES)',
      1,
      'repairable schema classification',
    ],
  ]) {
    const actual = countOccurrences(source, token)
    if (actual !== expected) {
      problems.push(`storage-policy-consumer:${label} occurrences=${actual}; expected=${expected}`)
    }
  }
  for (const token of [
    '...CANONICAL_PHYSICAL_STORAGE_TABLE_NAMES',
    '...BROWSER_WORKSPACE_CATCHUP_JOURNAL_TABLE_NAMES',
  ]) {
    if (countOccurrences(db, token) !== 1) {
      problems.push(
        `storage-policy-consumer: canonical schema source occurrences invalid: ${token}`,
      )
    }
  }
  for (const token of [
    "mode === 'readwrite'",
    'browserWorkspaceCatchupTransactionTableNames(stores)',
  ]) {
    if (countOccurrences(mutationJournal, token) !== 1) {
      problems.push(`storage-policy-consumer: automatic catch-up scope invalid: ${token}`)
    }
  }
  if (compaction.includes('COMPACTION_EXCLUDED_TABLES')) {
    problems.push('storage-policy-consumer: legacy compaction exclusion set remains')
  }
  if (countOccurrences(compaction, 'PHYSICAL_STORAGE_POLICY[name].compaction') < 2) {
    problems.push('storage-policy-consumer: compaction actions are not manifest-derived')
  }
  if (countOccurrences(compaction, 'PHYSICAL_STORAGE_POLICY[tableName].compaction') !== 1) {
    problems.push('storage-policy-consumer: filtered-copy dispatch is not manifest-derived')
  }
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return undefined
}

function discoverNatterDbTables(path, problems) {
  const sourceFile = sourceFileFor(path)
  const names = []
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'NatterDb') {
      for (const member of node.members) {
        if (
          ts.isPropertyDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          member.type &&
          ts.isTypeReferenceNode(member.type) &&
          ts.isIdentifier(member.type.typeName) &&
          member.type.typeName.text === 'Table'
        ) {
          names.push(member.name.text)
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  if (names.length === 0) problems.push('discovery:NatterDb: no Table properties found')
  return names
}

function discoverOriginDatabaseNames(root, problems) {
  const path = resolve(root, 'src/lib/origin-storage-names.ts')
  const control = unwrapExpression(
    variableInitializer(path, 'BROWSER_WORKSPACE_CONTROL_DATABASE_NAME', problems),
  )
  const workspace = unwrapExpression(
    variableInitializer(path, 'BROWSER_WORKSPACE_DATABASE_NAMES', problems),
  )
  const names = []
  if (control && ts.isStringLiteralLike(control)) names.push(control.text)
  else problems.push('discovery:origin-databases: control name is not a string literal')
  if (workspace && ts.isCallExpression(workspace)) {
    const array = unwrapExpression(workspace.arguments[0])
    if (array && ts.isArrayLiteralExpression(array)) {
      names.push(...stringElements(array, 'BROWSER_WORKSPACE_DATABASE_NAMES', problems))
    } else problems.push('discovery:origin-databases: workspace names are not an array literal')
  } else problems.push('discovery:origin-databases: workspace names are not Object.freeze(array)')
  return names
}

function discoverDirectWebStorageOwners(root) {
  const src = resolve(root, 'src')
  return sourceFiles(src)
    .flatMap((path) => {
      const relativePath = relative(root, path).split('\\').join('/')
      if (
        relativePath === 'src/lib/browser-storage.ts' ||
        relativePath === 'src/lib/storage-wipe.ts'
      ) {
        return []
      }
      const source = readFileSync(path, 'utf8')
      return /\bbrowser(?:Local|Session)Storage\s*\(/u.test(source) ? [relativePath] : []
    })
    .sort()
}

function discoverDirectBroadcastOwners(root) {
  return sourceFiles(resolve(root, 'src'))
    .flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      if (!/\bnew\s+BroadcastChannel\s*\(/u.test(source)) return []
      return [relative(root, path).split('\\').join('/')]
    })
    .sort()
}

function variableInitializer(path, variableName, problems) {
  const sourceFile = sourceFileFor(path)
  let initializer
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName
    ) {
      initializer = node.initializer
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  if (!initializer) problems.push(`discovery:${variableName}: declaration not found`)
  return initializer
}

function unwrapExpression(expression) {
  let current = expression
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) {
    current = current.expression
  }
  return current
}

function stringElements(array, label, problems) {
  const values = []
  for (const element of array.elements) {
    const value = unwrapExpression(element)
    if (!value || !ts.isStringLiteralLike(value)) {
      problems.push(`discovery:${label}: non-string array element`)
      continue
    }
    values.push(value.text)
  }
  return values
}

function countStringLiteral(path, value) {
  const sourceFile = sourceFileFor(path)
  let count = 0
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) && node.text === value) count += 1
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return count
}

function sourceFileFor(path) {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function sourceFiles(directory) {
  if (!existsSync(directory)) return []
  const files = []
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...sourceFiles(path))
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) files.push(path)
  }
  return files
}

function requireText(value, label, problems) {
  if (!isNonEmptyString(value)) problems.push(`${label}: must be non-empty`)
}

function requireEnum(value, allowed, label, problems) {
  if (!allowed.has(value)) problems.push(`${label}: invalid value: ${value}`)
}

function countBy(entries, field) {
  return Object.fromEntries(
    [...Map.groupBy(entries, (entry) => String(entry[field])).entries()]
      .map(([key, values]) => [key, values.length])
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

function countOccurrences(source, needle) {
  if (!needle) return 0
  let count = 0
  let offset = 0
  for (;;) {
    const index = source.indexOf(needle, offset)
    if (index < 0) return count
    count += 1
    offset = index + needle.length
  }
}

function duplicates(values) {
  const seen = new Set()
  const repeated = new Set()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    else seen.add(value)
  }
  return sorted([...repeated].map(String))
}

function difference(left, right) {
  const rightSet = new Set(right)
  return sorted([...new Set(left)].filter((value) => !rightSet.has(value)).map(String))
}

function sameSortedStrings(left, right) {
  const normalizedLeft = sorted(left)
  const normalizedRight = sorted(right)
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  )
}

function sorted(values) {
  return [...values].map(String).sort((left, right) => left.localeCompare(right))
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isExactRepoPath(value) {
  return isNonEmptyString(value) && !isAbsolute(value) && !value.includes('..')
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
  const output = evaluateStorageOwnershipReclamation(ROOT, inventory, args.mode, importProblems)
  process.stdout.write(`${JSON.stringify(output, null, args.json ? 2 : 0)}\n`)
  if (!output.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli()
}
