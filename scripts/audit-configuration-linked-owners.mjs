import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = resolve(ROOT, 'src')
const LINKED_TABLES = new Set(['chats', 'profiles', 'presets'])
const UNLINKED_TABLES = new Set(['keys', 'promptPresets'])
const UNLINKED_WRITERS = new Set([
  'addSemanticByteOwner',
  'deleteSemanticByteOwner',
  'replaceSemanticByteOwner',
])
const LINKED_WRITERS = new Set([
  'addLinkedSemanticByteOwner',
  'deleteLinkedSemanticByteOwner',
  'replaceLinkedSemanticByteOwner',
  'replaceLinkedSemanticByteOwnerBatch',
  'replaceLinkedSemanticByteOwnerPreservingLinksBatch',
])
const CHAT_ROW_WRITE_OWNER = 'src/store/chat-row-transition.ts#applyChatRowWriteTransitions'
const CHAT_ROW_RECEIPT_OWNER = 'src/store/chat-row-transition.ts#applyLinkedChatRowReplacements'
const CHAT_ROW_DELETE_OWNER = 'src/store/chat-storage-ownership.ts#deleteChatClosure'
const PROJECTION_API_OWNERS = new Map([
  [
    'applyChatSidebarProjectionTransitions',
    new Set([CHAT_ROW_WRITE_OWNER, CHAT_ROW_RECEIPT_OWNER]),
  ],
  [
    'rebuildChatSidebarProjectionRowsInTransaction',
    new Set(['src/store/browser-workspace-derived-repair.ts#<module>']),
  ],
])
const RETIRED_WRITERS = new Set([
  'replaceConfigurationOwnerLinks',
  'replaceConfigurationOwnerLinksBatch',
  'replaceConfigurationOwnerLinksInvariantBatch',
  'replaceLinkedSemanticMetadataByteOwner',
])
const RETIRED_CONFIGURATION_AUTHORITY = [
  'profile.dependents',
  'loadConnectionDependents',
  'getProfileDependents',
  'firstActiveProfileIdFromTransaction',
]

const problems = []
const counts = { linkedCalls: 0, unlinkedCalls: 0, files: 0 }
for (const path of productionSourceFiles(SRC)) {
  counts.files += 1
  const isOwnerModule = path === resolve(SRC, 'store/byte-owner-mutation.ts')
  const sourceText = readFileSync(path, 'utf8')
  for (const retired of RETIRED_CONFIGURATION_AUTHORITY) {
    if (sourceText.includes(retired)) {
      problems.push(`${relative(ROOT, path)}: retired configuration authority ${retired}`)
    }
  }
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const imports = importedOriginalNames(source)
  const sourcePath = relative(ROOT, path).split('\\').join('/')
  visit(source, (node) => {
    if (!ts.isIdentifier(node) || !RETIRED_WRITERS.has(node.text)) return
    problems.push(problem(source, node, `retired linked-owner writer ${node.text}`))
  })
  visit(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return
    const name = imports.get(node.expression.text) ?? node.expression.text
    if (!UNLINKED_WRITERS.has(name) && !LINKED_WRITERS.has(name)) return
    const tableName = stringLiteral(node.arguments[1])
    if (!tableName) {
      if (!isOwnerModule) problems.push(problem(source, node, `${name} table must be a literal`))
      return
    }
    if (UNLINKED_WRITERS.has(name)) {
      counts.unlinkedCalls += 1
      if (LINKED_TABLES.has(tableName)) {
        problems.push(problem(source, node, `${tableName} bypasses the linked-owner writer`))
      }
      return
    }
    counts.linkedCalls += 1
    if (UNLINKED_TABLES.has(tableName)) {
      problems.push(problem(source, node, `${tableName} incorrectly uses the linked-owner writer`))
    } else if (!LINKED_TABLES.has(tableName)) {
      problems.push(problem(source, node, `${name} has unknown linked table ${tableName}`))
    }
    if (tableName === 'chats') {
      const owner = `${sourcePath}#${enclosingFunctionName(node)}`
      const expectedOwner = name.startsWith('deleteLinked')
        ? CHAT_ROW_DELETE_OWNER
        : CHAT_ROW_WRITE_OWNER
      const allowedOwners =
        expectedOwner === CHAT_ROW_WRITE_OWNER
          ? new Set([CHAT_ROW_WRITE_OWNER, CHAT_ROW_RECEIPT_OWNER])
          : new Set([expectedOwner])
      if (!allowedOwners.has(owner)) {
        problems.push(
          problem(source, node, `${name} chat owner is ${owner}, expected ${expectedOwner}`),
        )
      }
    }
  })
  visit(source, (node) => {
    if (!ts.isIdentifier(node) || isImportOrDeclarationName(node)) return
    const name = imports.get(node.text) ?? node.text
    const allowedOwners = PROJECTION_API_OWNERS.get(name)
    if (!allowedOwners) return
    const owner = `${sourcePath}#${enclosingFunctionName(node)}`
    if (!allowedOwners.has(owner)) {
      problems.push(problem(source, node, `${name} owner is ${owner}`))
    }
  })
}

const ownerSource = readFileSync(resolve(SRC, 'store/byte-owner-mutation.ts'), 'utf8')
for (const required of [
  "type LinkedSemanticByteOwnerRows = Pick<AllSemanticByteOwnerRows, 'chats' | 'profiles' | 'presets'>",
  "if (tableName === 'chats') return configurationLinksForChat(row as Chat)",
  "if (tableName === 'profiles') return configurationLinksForProfile(row as ConnectionProfile)",
  'return configurationLinksForPreset(row as ChatPreset)',
  'configurationProfileUsageDeltas(',
  "transition.kind === 'exact' ? transition.previous : transition.accountedPrevious",
  'ConfigurationOwnerLinkPreviousMismatch',
]) {
  if (!ownerSource.includes(required)) problems.push(`byte-owner-mutation.ts: missing ${required}`)
}
if (!ownerSource.includes(".where('ownerKey')")) {
  problems.push('byte-owner-mutation.ts: replacement links do not validate their stored prior rows')
}
const additionStart = ownerSource.indexOf('async function addConfigurationOwnerLinks')
const additionEnd = ownerSource.indexOf('function assertConfigurationOwnerLinkTransitions')
const additionSource = ownerSource.slice(additionStart, additionEnd)
if (
  additionStart < 0 ||
  additionEnd <= additionStart ||
  additionSource.includes('.where(') ||
  !additionSource.includes('addPhysicalStorageRows')
) {
  problems.push('byte-owner-mutation.ts: known-new links are not a read-free bounded addition')
}

const repoSource = readFileSync(resolve(SRC, 'store/browser-repo.ts'), 'utf8')
const modelResolutionTargetTemplate = [
  '`configuration-target:',
  '$',
  '{input.modelResolutionTargetKey}`',
].join('')
if (
  !repoSource.includes('...(input.modelResolutionTargetKey') ||
  !repoSource.includes(modelResolutionTargetTemplate)
) {
  problems.push('browser-repo.ts: pending model publication lacks its exact target resource')
}
if (
  repoSource.includes('configurationTargetResourceNamesForLinks(configurationLinksForChat(chat))')
) {
  problems.push('browser-repo.ts: retired dynamic chat-link target resource planning')
}

const catalogProjectionSource = readFileSync(
  resolve(SRC, 'store/configuration-catalog-projection.ts'),
  'utf8',
)
for (const source of [
  repoSource,
  readFileSync(resolve(SRC, 'store/browser-configuration-domain.ts'), 'utf8'),
]) {
  if (!source.includes('readDefaultConfigurationProfileId')) {
    problems.push('configuration fallback consumer bypasses the canonical active-profile ordering')
  }
}
if (!catalogProjectionSource.includes('export async function readDefaultConfigurationProfileId')) {
  problems.push('configuration-catalog-projection.ts: canonical active-profile fallback is missing')
}

const catalogSessionSource = readFileSync(
  resolve(SRC, 'store/configuration-catalog-session.ts'),
  'utf8',
)
const managerSessionStart = catalogSessionSource.indexOf(
  'export function createConfigurationConnectionManagerSessionController',
)
const managerSessionEnd = catalogSessionSource.indexOf(
  'export function createConfigurationPresetCatalogSessionController',
)
if (
  managerSessionStart < 0 ||
  managerSessionEnd < managerSessionStart ||
  !catalogSessionSource
    .slice(managerSessionStart, managerSessionEnd)
    .includes('maxRetainedPages: 1')
) {
  problems.push('configuration-catalog-session.ts: manager retention is not exactly one page')
}
for (const retired of ['chatSettingsLinkResourceNames', 'chatPresetLinkResourceNames']) {
  if (repoSource.includes(retired)) problems.push(`browser-repo.ts: retired lock helper ${retired}`)
}

const output = {
  ok: problems.length === 0,
  productionFiles: counts.files,
  linkedCalls: counts.linkedCalls,
  unlinkedCalls: counts.unlinkedCalls,
  problems: problems.sort(),
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
if (!output.ok) process.exitCode = 1

function productionSourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...productionSourceFiles(path))
      continue
    }
    if (!entry.isFile() || !['.ts', '.tsx'].includes(extname(entry.name))) continue
    if (entry.name.endsWith('.d.ts')) continue
    files.push(path)
  }
  return files.sort()
}

function visit(node, callback) {
  callback(node)
  ts.forEachChild(node, (child) => visit(child, callback))
}

function stringLiteral(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined
}

function importedOriginalNames(source) {
  const names = new Map()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      names.set(element.name.text, element.propertyName?.text ?? element.name.text)
    }
  }
  return names
}

function enclosingFunctionName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isFunctionExpression(current)) &&
      current.name &&
      ts.isIdentifier(current.name)
    ) {
      return current.name.text
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text
    }
  }
  return '<module>'
}

function isImportOrDeclarationName(node) {
  const parent = node.parent
  if (!parent) return false
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent)
  ) {
    return true
  }
  return (
    ((ts.isFunctionDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isVariableDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node)
  )
}

function problem(source, node, message) {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source))
  return `${relative(ROOT, source.fileName)}:${position.line + 1}:${position.character + 1}: ${message}`
}
