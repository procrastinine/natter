import { relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { staticAuditState } from './audit-result-state.mjs'
import { CONFIGURATION_COMMANDS } from './configuration-protocol-inventory.mjs'
import { discoverProductionDiscriminatedUnions } from './discover-production-discriminated-unions.mjs'
import * as defaultInventory from './durable-command-pipeline-inventory.mjs'
import { createProductionTypeScriptProgram } from './production-typescript-source.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SRC_ROOT = resolve(ROOT, 'src')
const WORKSPACE_COMMAND_UNION_ID = 'src/store/workspace-protocol.ts#WorkspaceCommand|kind'
const CONFIGURATION_COMMAND_UNION_ID =
  'src/store/configuration-domain-contract.ts#ConfigurationDomainCommandUnion|kind'
const BROWSER_REPO_PATH = 'src/store/browser-repo.ts'
const BROWSER_IMPORT_EXPORT_PATH = 'src/store/browser-import-export.ts'
const CONFIGURATION_HANDLER_PATH = 'src/store/browser-configuration-domain.ts'
const MUTATION_JOURNAL_PATH = 'src/store/browser-command-mutation-journal.ts'
const DATABASE_PATH = 'src/store/db.ts'
const WORKSPACE_REPOSITORY_PATH = 'src/store/workspace-repository.ts'
const WORKSPACE_EFFECT_HUB_PATH = 'src/store/workspace-effect-hub.ts'
const COMMAND_TRANSACTION_BOUNDARY_PATHS = [
  BROWSER_REPO_PATH,
  BROWSER_IMPORT_EXPORT_PATH,
  CONFIGURATION_HANDLER_PATH,
  'src/store/browser-domain-mutations.ts',
]
const VALID_STAGE_STATUSES = new Set(['observed', 'gap'])

const EXPECTED_PIPELINE_STAGES = Object.freeze([
  'constructor',
  'admission',
  'dispatch',
  'handler',
  'kernel',
  'lock',
  'transaction',
  'tables',
  'physicalWrites',
  'writeDetection',
  'receiptDelta',
  'broadcast',
  'rollback',
  'idempotence',
  'bounds',
])

export function buildDurableCommandPipelineSourceFacts(options = {}) {
  const program = options.program ?? createProductionTypeScriptProgram(ROOT)
  const discoveredUnions =
    options.discovered ?? discoverProductionDiscriminatedUnions(ROOT, { program })
  const workspaceUnion = exactUnion(discoveredUnions.unions, WORKSPACE_COMMAND_UNION_ID)
  const configurationUnion = exactUnion(discoveredUnions.unions, CONFIGURATION_COMMAND_UNION_ID)
  const browserRepoSource = exactSource(program, BROWSER_REPO_PATH)
  const sourceArchitectureProblems = []
  validateTransactionDerivedWriteSource(
    browserRepoSource,
    exactSource(program, MUTATION_JOURNAL_PATH),
    exactSource(program, DATABASE_PATH),
    exactSource(program, WORKSPACE_REPOSITORY_PATH),
    exactSource(program, WORKSPACE_EFFECT_HUB_PATH),
    sourceArchitectureProblems,
  )
  return Object.freeze({
    auditedUnionSubjects: Object.freeze(
      [
        ['workspace', workspaceUnion],
        ['configuration', configurationUnion],
      ].map(([name, union]) => Object.freeze({ name, id: union.id })),
    ),
    workspaceUnion,
    configurationUnion,
    constructorsByWorkspaceVariant: frozenArrayRecord(constructorSitesByVariant(workspaceUnion)),
    constructorsByConfigurationVariant: frozenArrayRecord(
      constructorSitesByVariant(configurationUnion),
    ),
    dispatchBodies: frozenScalarRecord(commandDispatchCaseBodies(browserRepoSource)),
    configurationHandlers: frozenScalarRecord(
      configurationHandlerTargets(exactSource(program, CONFIGURATION_HANDLER_PATH)),
    ),
    actualManualMarkers: frozenScalarRecord(manualWriteMarkerOwnerCounts(program)),
    actualDirectTransactions: frozenScalarRecord(directGrantTransactionOwnerCounts(program)),
    sourceArchitectureProblems: Object.freeze(sourceArchitectureProblems.sort()),
    physicalTables: Object.freeze(
      literalArrayValues(
        exactSource(program, 'src/store/physical-storage-tables.ts'),
        'PHYSICAL_STORAGE_TABLE_NAMES',
      ),
    ),
  })
}

export function evaluateDurableCommandPipeline(
  inventory = defaultInventory,
  mode = 'inventory',
  options = {},
  facts = buildDurableCommandPipelineSourceFacts(),
) {
  const {
    CONFIGURATION_COMMAND_PIPELINES,
    DIRECT_COMMAND_TRANSACTION_OWNER_COUNTS,
    MANUAL_WRITE_MARKER_OWNER_COUNTS,
    REQUIRED_PIPELINE_STAGES,
    WORKSPACE_COMMAND_PIPELINES,
    WRITE_DETECTION_ARCHITECTURE,
  } = inventory
  const {
    workspaceUnion,
    configurationUnion,
    constructorsByWorkspaceVariant: workspaceConstructorRecord,
    constructorsByConfigurationVariant: configurationConstructorRecord,
    dispatchBodies: dispatchBodyRecord,
    configurationHandlers: configurationHandlerRecord,
    actualManualMarkers: manualMarkerRecord,
    actualDirectTransactions: directTransactionRecord,
  } = facts
  const constructorsByWorkspaceVariant = new Map(Object.entries(workspaceConstructorRecord))
  const constructorsByConfigurationVariant = new Map(Object.entries(configurationConstructorRecord))
  const dispatchBodies = new Map(Object.entries(dispatchBodyRecord))
  const configurationHandlers = new Map(Object.entries(configurationHandlerRecord))
  const actualManualMarkers = new Map(Object.entries(manualMarkerRecord))
  const actualDirectTransactions = new Map(Object.entries(directTransactionRecord))
  const problems = []
  compareExact(
    'workspace command pipeline variants',
    workspaceUnion.variants,
    Object.keys(WORKSPACE_COMMAND_PIPELINES ?? {}),
    problems,
  )
  compareExact(
    'configuration command pipeline variants',
    configurationUnion.variants,
    Object.keys(CONFIGURATION_COMMAND_PIPELINES ?? {}),
    problems,
  )
  const requiredStages = Array.isArray(REQUIRED_PIPELINE_STAGES) ? REQUIRED_PIPELINE_STAGES : []
  compareExact(
    'required durable pipeline stages',
    EXPECTED_PIPELINE_STAGES,
    requiredStages,
    problems,
  )
  validatePipelineRecords('workspace', WORKSPACE_COMMAND_PIPELINES, requiredStages, problems)
  validatePipelineRecords(
    'configuration',
    CONFIGURATION_COMMAND_PIPELINES,
    requiredStages,
    problems,
  )
  for (const variant of workspaceUnion.variants) {
    const sites = constructorsByWorkspaceVariant.get(variant) ?? []
    if (sites.length === 0) problems.push(`workspace ${variant}: no typed production constructor`)
    if (WORKSPACE_COMMAND_PIPELINES?.[variant]?.constructor?.status !== 'observed') {
      problems.push(`workspace ${variant}: constructor stage must match reachable typed sites`)
    }
  }
  for (const variant of configurationUnion.variants) {
    const contract = CONFIGURATION_COMMANDS[variant]
    const sites = constructorsByConfigurationVariant.get(variant) ?? []
    const stage = CONFIGURATION_COMMAND_PIPELINES?.[variant]?.constructor
    if (contract?.status === 'reachable') {
      if (sites.length === 0)
        problems.push(`configuration ${variant}: reachable without constructor`)
      if (stage?.status !== 'observed') {
        problems.push(`configuration ${variant}: constructor stage contradicts reachable protocol`)
      }
    } else if (contract?.status === 'gap') {
      if (sites.length > 0)
        problems.push(`configuration ${variant}: gap has typed constructor sites`)
      if (stage?.status !== 'gap')
        problems.push(`configuration ${variant}: constructor gap is hidden`)
    } else {
      problems.push(`configuration ${variant}: missing nested protocol classification`)
    }
  }
  compareExact(
    'workspace dispatch variants',
    workspaceUnion.variants,
    [...dispatchBodies.keys()],
    problems,
  )
  for (const variant of workspaceUnion.variants) {
    const body = dispatchBodies.get(variant) ?? ''
    const handler = WORKSPACE_COMMAND_PIPELINES?.[variant]?.handler?.proof
    for (const token of proofTokens(handler)) {
      if (!body.includes(token))
        problems.push(`workspace ${variant}: dispatch handler missing ${token}`)
    }
  }
  compareExact(
    'configuration handler variants',
    configurationUnion.variants,
    [...configurationHandlers.keys()],
    problems,
  )
  for (const variant of configurationUnion.variants) {
    const expected = CONFIGURATION_COMMAND_PIPELINES?.[variant]?.handler?.proof
    const actual = configurationHandlers.get(variant)
    if (typeof expected === 'string' && actual !== expected) {
      problems.push(`configuration ${variant}: expected handler ${expected}, found ${actual}`)
    }
  }
  compareCountMap(
    'manual write-marker owners',
    MANUAL_WRITE_MARKER_OWNER_COUNTS ?? {},
    actualManualMarkers,
    problems,
  )
  compareCountMap(
    'direct command transaction owners',
    DIRECT_COMMAND_TRANSACTION_OWNER_COUNTS ?? {},
    actualDirectTransactions,
    problems,
  )
  validateWriteArchitectureDeclaration(WRITE_DETECTION_ARCHITECTURE, problems)
  problems.push(...facts.sourceArchitectureProblems)
  for (const [scope, records] of [
    ['workspace', WORKSPACE_COMMAND_PIPELINES],
    ['configuration', CONFIGURATION_COMMAND_PIPELINES],
  ]) {
    for (const [variant, record] of Object.entries(records ?? {})) {
      if (record?.writeDetection?.status !== 'observed') {
        problems.push(`${scope} ${variant}: transaction-derived write detection must be observed`)
      }
      if (record?.broadcast?.status !== 'observed') {
        problems.push(`${scope} ${variant}: committed-write broadcast must be observed`)
      }
    }
  }
  const allRecords = [
    ...Object.entries(WORKSPACE_COMMAND_PIPELINES ?? {}).map(([variant, record]) => ({
      scope: 'workspace',
      variant,
      record,
      constructors: constructorsByWorkspaceVariant.get(variant) ?? [],
    })),
    ...Object.entries(CONFIGURATION_COMMAND_PIPELINES ?? {}).map(([variant, record]) => ({
      scope: 'configuration',
      variant,
      record,
      constructors: constructorsByConfigurationVariant.get(variant) ?? [],
    })),
  ]
  const stageCells = allRecords.length * requiredStages.length
  const gaps = allRecords.flatMap(({ scope, variant, record }) =>
    requiredStages.flatMap((stage) =>
      record?.[stage]?.status === 'gap'
        ? [{ scope, variant, stage, reason: record[stage].reason }]
        : [],
    ),
  )
  const markerCalls = [...actualManualMarkers.values()].reduce((sum, count) => sum + count, 0)
  const directTransactionCalls = [...actualDirectTransactions.values()].reduce(
    (sum, count) => sum + count,
    0,
  )
  const gapStageCounts = Object.fromEntries(
    requiredStages.map((stage) => [stage, gaps.filter((gap) => gap.stage === stage).length]),
  )
  const structurallyValid = problems.length === 0
  return Object.freeze({
    mode,
    ok: structurallyValid && (mode !== 'enforce' || gaps.length === 0),
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps }),
    workspaceCommands: workspaceUnion.variants.length,
    workspaceConstructorSites: workspaceUnion.constructorSites.length,
    configurationCommands: configurationUnion.variants.length,
    configurationConstructorSites: configurationUnion.constructorSites.length,
    configurationConstructorGaps: Object.values(CONFIGURATION_COMMANDS).filter(
      (entry) => entry.status === 'gap',
    ).length,
    pipelineRecords: allRecords.length,
    requiredStages: requiredStages.length,
    stageCells,
    gapCells: gaps.length,
    observedCells: stageCells - gaps.length,
    manualMarkerOwners: actualManualMarkers.size,
    manualMarkerCalls: markerCalls,
    directTransactionOwners: actualDirectTransactions.size,
    directTransactionCalls,
    physicalTables: facts.physicalTables,
    gapStageCounts,
    ...(options.detail ? { records: allRecords, gaps } : {}),
    limitations: Object.freeze([
      'Transaction table guards prove only tables declared by a selected helper; command-to-helper-to-table completeness remains unproven.',
      'Transaction-local mutation facts close write detection, but the exact semantic meaning of each mutated table is not inferred from bytes alone.',
      'Physical evidence is checked against the generic commit envelope, but exact command-to-semantic-effect completeness remains a per-command gap.',
      'Rollback, retry idempotence, and work/memory bounds remain explicit per-command gaps.',
    ]),
    problems: Object.freeze(problems.sort()),
  })
}

function parseArgs(argv) {
  const parsed = { mode: 'inventory', json: false, detail: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg === '--detail') {
      parsed.detail = true
      continue
    }
    if (arg !== '--mode') {
      throw new Error(`Unknown durable-command-pipeline argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    if (value === 'inventory' || value === 'enforce') parsed.mode = value
    else throw new Error(`Invalid durable-command-pipeline mode: ${value}`)
    index += 1
  }
  return parsed
}

function exactUnion(unions, id) {
  const matches = unions.filter((entry) => entry.id === id)
  if (matches.length !== 1) throw new Error(`DurableCommandPipelineUnionExpectedOnce:${id}`)
  return matches[0]
}

function exactSource(currentProgram, path) {
  const source = currentProgram
    .getSourceFiles()
    .find((candidate) => relative(ROOT, candidate.fileName).split(sep).join('/') === path)
  if (!source) throw new Error(`DurableCommandPipelineSourceMissing:${path}`)
  return source
}

function constructorSitesByVariant(union) {
  const sites = new Map(union.variants.map((variant) => [variant, []]))
  for (const site of union.constructorSites) {
    sites.get(site.variant)?.push({
      path: site.path,
      owner: site.owner,
      confidence: site.confidence,
    })
  }
  return sites
}

function frozenArrayRecord(entries) {
  return Object.freeze(
    Object.fromEntries([...entries].map(([key, values]) => [key, Object.freeze([...values])])),
  )
}

function frozenScalarRecord(entries) {
  return Object.freeze(Object.fromEntries(entries))
}

function validatePipelineRecords(scope, records, required, outputProblems) {
  if (!records || typeof records !== 'object' || Array.isArray(records)) {
    outputProblems.push(`${scope}: pipeline records must be an object`)
    return
  }
  for (const [variant, record] of Object.entries(records)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      outputProblems.push(`${scope} ${variant}: pipeline record must be an object`)
      continue
    }
    compareExact(
      `${scope} ${variant}: pipeline stages`,
      required,
      Object.keys(record),
      outputProblems,
    )
    for (const stage of required) {
      const disposition = record[stage]
      if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)) {
        outputProblems.push(`${scope} ${variant}: missing stage ${stage}`)
        continue
      }
      if (!VALID_STAGE_STATUSES.has(disposition.status)) {
        outputProblems.push(
          `${scope} ${variant}: stage ${stage} has invalid status ${disposition.status}`,
        )
      } else if (disposition.status === 'observed') {
        if (!validProof(disposition.proof)) {
          outputProblems.push(`${scope} ${variant}: observed stage ${stage} needs proof`)
        }
      } else if (typeof disposition.reason !== 'string' || disposition.reason.length === 0) {
        outputProblems.push(`${scope} ${variant}: gap stage ${stage} needs a reason`)
      }
    }
  }
}

function validProof(value) {
  return (
    (typeof value === 'string' && value.length > 0) ||
    (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string'))
  )
}

function proofTokens(value) {
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
}

function commandDispatchCaseBodies(source) {
  const method = findMethod(source, 'BrowserWorkspaceRepository', 'dispatchCommand')
  const switchStatement = findSwitch(method, 'command.kind', source)
  const clauses = switchStatement.caseBlock.clauses
  const bodies = new Map()
  let nextBody = ''
  for (let index = clauses.length - 1; index >= 0; index -= 1) {
    const clause = clauses[index]
    if (!ts.isCaseClause(clause)) continue
    if (clause.statements.length > 0) {
      nextBody = clause.statements.map((statement) => statement.getText(source)).join('\n')
    }
    const variant = literalText(clause.expression)
    if (variant) bodies.set(variant, nextBody)
  }
  return bodies
}

function configurationHandlerTargets(source) {
  const object = variableObjectLiteral(source, 'configurationDomainHandlers')
  const handlers = new Map()
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue
    const variant = propertyName(property.name)
    if (!variant) continue
    if (ts.isShorthandPropertyAssignment(property)) {
      handlers.set(variant, property.name.text)
      continue
    }
    const initializer = unwrap(property.initializer)
    handlers.set(
      variant,
      ts.isIdentifier(initializer)
        ? initializer.text
        : ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
          ? '<inline>'
          : initializer.getText(source),
    )
  }
  return handlers
}

function manualWriteMarkerOwnerCounts(currentProgram) {
  const counts = new Map()
  for (const source of currentProgram.getSourceFiles()) {
    if (!isProductionSource(source)) continue
    const path = relative(ROOT, source.fileName).split(sep).join('/')
    const scan = (node, ownerNames) => {
      const name = declaredOwnerName(node, source)
      const nextOwners = name ? [...ownerNames, name] : ownerNames
      if (ts.isCallExpression(node)) {
        const marker = node.expression.getText(source)
        if (
          marker === 'commandMeta.markWrite' ||
          marker === 'commit.markWrite' ||
          marker === 'markWorkspaceWrite'
        ) {
          const id = `${path}#${nextOwners.join('.') || '<module>'}#${marker}`
          counts.set(id, (counts.get(id) ?? 0) + 1)
        }
      }
      node.forEachChild((child) => scan(child, nextOwners))
    }
    scan(source, [])
  }
  return counts
}

function directGrantTransactionOwnerCounts(currentProgram) {
  const counts = new Map()
  for (const path of COMMAND_TRANSACTION_BOUNDARY_PATHS) {
    const source = exactSource(currentProgram, path)
    const scan = (node, ownerNames) => {
      const name = declaredOwnerName(node, source)
      const nextOwners = name ? [...ownerNames, name] : ownerNames
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'grant.runTransaction') {
        const id = `${path}#${nextOwners.join('.') || '<module>'}#grant.runTransaction`
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
      node.forEachChild((child) => scan(child, nextOwners))
    }
    scan(source, [])
  }
  return counts
}

function validateWriteArchitectureDeclaration(architecture, output) {
  if (architecture?.mechanism !== 'transaction-local-mutation-journal') {
    output.push('write-detection architecture must use the transaction-local mutation journal')
  }
  if (architecture?.status !== 'observed') {
    output.push('transaction-local write detection must remain observed')
  }
  if (!validProof(architecture?.proof)) {
    output.push('transaction-local write detection needs proof')
  }
}

function validateTransactionDerivedWriteSource(
  browserRepo,
  mutationJournal,
  database,
  workspaceRepository,
  workspaceEffectHub,
  output,
) {
  const repoText = browserRepo.getText()
  const journalText = mutationJournal.getText()
  const databaseText = database.getText()
  const deliveryText = workspaceRepository.getText()
  const effectHubText = workspaceEffectHub.getText()

  for (const fragment of [
    'const journals = new WeakMap<DBCoreTransaction',
    'journals.get(request.trans)',
    'const value = await operation(tx)',
  ]) {
    if (!journalText.includes(fragment)) {
      output.push(`transaction mutation journal proof missing ${fragment}`)
    }
  }
  if (journalText.includes('storagemutated')) {
    output.push('transaction mutation journal must not use the global storagemutated event')
  }
  if (!databaseText.includes('installBrowserCommandMutationJournal(this)')) {
    output.push('database does not install the transaction mutation journal before commands run')
  }
  if (!hasAwaitedTransactionJournalCallback(browserRepo)) {
    output.push(
      'transaction-derived write proof missing awaited async runBrowserCommandTransaction callback',
    )
  }
  for (const fragment of [
    'this.recordCommittedMutationFacts(committed.facts)',
    'didMutateStorage: this.committedMutationTables.size > 0',
  ]) {
    if (!repoText.includes(fragment)) {
      output.push(`transaction-derived write proof missing ${fragment}`)
    }
  }
  const awaitCommit = repoText.indexOf('const committed = await grant.runTransaction')
  const mergeFacts = repoText.indexOf('this.recordCommittedMutationFacts(committed.facts)')
  if (awaitCommit < 0 || mergeFacts < 0 || awaitCommit > mergeFacts) {
    output.push('mutation facts must merge only after the fenced transaction commits')
  }
  const prepare = deliveryText.indexOf('prepared = prepareWorkspaceEffectForLocalCommit(commit)')
  const gate = deliveryText.indexOf('if (!prepared) return')
  const publishEffect = deliveryText.indexOf(
    'publishPreparedWorkspaceEffect(effect, suppressedGroups)',
  )
  const publishChange = deliveryText.indexOf('postWorkspaceChange(change)')
  if (!effectHubText.includes("if (commit.effectScope !== 'workspace') return null")) {
    output.push('local commit effect preparation is not gated by the typed effect scope')
  }
  if (prepare < 0) output.push('local commit effect preparation call is missing')
  if (gate < 0) output.push('local commit no-effect gate is missing')
  if (publishEffect < 0 || publishChange < 0) output.push('commit publication call is missing')
  if (
    prepare >= 0 &&
    gate >= 0 &&
    publishEffect >= 0 &&
    publishChange >= 0 &&
    !(prepare < gate && gate < publishEffect && publishEffect < publishChange)
  ) {
    output.push('commit publication is no longer gated by prepared committed effects')
  }
}

function hasAwaitedTransactionJournalCallback(source) {
  const method = findMethod(source, 'BrowserCommandCommit', 'runTransaction')
  let matched = false
  visit(method, (node) => {
    if (
      matched ||
      !ts.isAwaitExpression(node) ||
      !ts.isCallExpression(unwrap(node.expression)) ||
      unwrap(node.expression).expression.getText(source) !== 'grant.runTransaction'
    ) {
      return
    }
    const transactionCall = unwrap(node.expression)
    const callback = transactionCall.arguments[2] ? unwrap(transactionCall.arguments[2]) : undefined
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return
    if (!callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
      return
    visit(callback.body, (candidate) => {
      if (
        matched ||
        !ts.isAwaitExpression(candidate) ||
        !ts.isCallExpression(unwrap(candidate.expression))
      ) {
        return
      }
      const journalCall = unwrap(candidate.expression)
      if (
        journalCall.expression.getText(source) !== 'runBrowserCommandTransaction' ||
        journalCall.arguments[0]?.getText(source) !== 'tx'
      ) {
        return
      }
      const operationCallback = journalCall.arguments[1]
        ? unwrap(journalCall.arguments[1])
        : undefined
      if (
        !operationCallback ||
        (!ts.isArrowFunction(operationCallback) && !ts.isFunctionExpression(operationCallback))
      ) {
        return
      }
      visit(operationCallback.body, (operationCandidate) => {
        if (
          !matched &&
          ts.isCallExpression(operationCandidate) &&
          operationCandidate.expression.getText(source) === 'operation' &&
          operationCandidate.arguments[0]?.getText(source) ===
            'bindFencedTransaction(transaction, plan)'
        ) {
          matched = true
        }
      })
    })
  })
  return matched
}

function literalArrayValues(source, variableName) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== variableName) continue
      const initializer = declaration.initializer ? unwrap(declaration.initializer) : undefined
      if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
        throw new Error(`DurableCommandPipelineArrayInvalid:${variableName}`)
      }
      return initializer.elements.flatMap((element) => {
        const value = literalText(element)
        return value ? [value] : []
      })
    }
  }
  throw new Error(`DurableCommandPipelineArrayMissing:${variableName}`)
}

function findMethod(source, className, methodName) {
  for (const statement of source.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== className) continue
    const method = statement.members.find(
      (member) => ts.isMethodDeclaration(member) && propertyName(member.name) === methodName,
    )
    if (method) return method
  }
  throw new Error(`DurableCommandPipelineMethodMissing:${className}.${methodName}`)
}

function findSwitch(node, expressionText, source) {
  let match
  visit(node, (current) => {
    if (
      !match &&
      ts.isSwitchStatement(current) &&
      unwrap(current.expression).getText(source) === expressionText
    ) {
      match = current
    }
  })
  if (!match) throw new Error(`DurableCommandPipelineSwitchMissing:${expressionText}`)
  return match
}

function variableObjectLiteral(source, name) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
      const initializer = declaration.initializer ? unwrap(declaration.initializer) : undefined
      if (initializer && ts.isObjectLiteralExpression(initializer)) return initializer
    }
  }
  throw new Error(`DurableCommandPipelineObjectMissing:${name}`)
}

function declaredOwnerName(node, source) {
  if (ts.isMethodDeclaration(node) && node.name) {
    return propertyName(node.name) ?? '<computed-method>'
  }
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text
  if (
    ts.isPropertyAssignment(node) &&
    (ts.isArrowFunction(unwrap(node.initializer)) ||
      ts.isFunctionExpression(unwrap(node.initializer)))
  ) {
    return propertyName(node.name) ?? '<computed-property>'
  }
  if (ts.isClassDeclaration(node) && node.name) return node.name.text
  void source
  return undefined
}

function compareCountMap(label, expectedObject, actualMap, output) {
  const expected = new Map(Object.entries(expectedObject))
  compareExact(label, [...expected.keys()], [...actualMap.keys()], output)
  for (const [id, count] of expected) {
    const actual = actualMap.get(id)
    if (actual !== undefined && actual !== count) {
      output.push(`${label}: ${id} expected ${count}, found ${actual}`)
    }
  }
}

function compareExact(label, expected, actual, output) {
  const expectedValues = [...expected].sort()
  const actualValues = [...actual].sort()
  for (const value of difference(expectedValues, actualValues))
    output.push(`${label}: missing ${value}`)
  for (const value of difference(actualValues, expectedValues)) {
    output.push(`${label}: unclassified ${value}`)
  }
  for (const value of duplicates(actualValues)) output.push(`${label}: duplicate ${value}`)
}

function difference(left, right) {
  const rightSet = new Set(right)
  return left.filter((value) => !rightSet.has(value))
}

function duplicates(values) {
  const seen = new Set()
  const repeated = new Set()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    else seen.add(value)
  }
  return [...repeated].sort()
}

function literalText(expression) {
  const current = unwrap(expression)
  return ts.isStringLiteralLike(current) ? current.text : undefined
}

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined
}

function unwrap(node) {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function visit(node, callback) {
  callback(node)
  node.forEachChild((child) => visit(child, callback))
}

function isProductionSource(source) {
  const path = resolve(source.fileName)
  return path.startsWith(`${SRC_ROOT}${sep}`) && /\.tsx?$/u.test(path) && !path.endsWith('.d.ts')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2))
  const output = evaluateDurableCommandPipeline(defaultInventory, args.mode, {
    detail: args.detail,
  })
  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } else {
    process.stdout.write(
      `Durable command pipeline: workspace=${output.workspaceCommands}, configuration=${output.configurationCommands}, records=${output.pipelineRecords}, cells=${output.stageCells}, gaps=${output.gapCells}, manual-markers=${output.manualMarkerCalls}, direct-transactions=${output.directTransactionCalls}.\n`,
    )
    for (const problem of output.problems) process.stderr.write(`  ${problem}\n`)
  }
  if (!output.ok) process.exitCode = 1
}
