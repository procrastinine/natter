import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const config = ts.readConfigFile(join(root, 'tsconfig.app.json'), ts.sys.readFile)
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
const presentationFiles = sourceFiles(['src/app', 'src/ui', 'src/hooks'])
const importsByTarget = new Map()
assertEmbeddedTypeReferenceDiscovery()
const PRESENTATION_STORE_TARGET_ROLES = Object.freeze({
  'src/store/attachment-application.ts': 'application',
  'src/store/attachment-catalog-workspace.ts': 'tab-local-projection',
  'src/store/attachment-object-url.ts': 'browser-resource',
  'src/store/attempt-control-application.ts': 'application',
  'src/store/attempt-controller.ts': 'tab-local-projection',
  'src/store/branch-tree-search-session.ts': 'reactive-read',
  'src/store/branch-tree-session-workspace.ts': 'tab-local-projection',
  'src/store/catalog-application.ts': 'application',
  'src/store/catalog-session-workspace.ts': 'reactive-read',
  'src/store/chat-fork.ts': 'application-command',
  'src/store/chat-search.ts': 'public-contract',
  'src/store/chat-metadata-application.ts': 'application',
  'src/store/configuration-application.ts': 'application',
  'src/store/configuration-catalog-session.ts': 'tab-local-projection',
  'src/store/configuration-controller.ts': 'tab-local-projection',
  'src/store/connection-onboarding.ts': 'application',
  'src/store/connection-probe-capability.ts': 'application',
  'src/store/conversation-command-client.ts': 'application-command',
  'src/store/conversation-controller.ts': 'tab-local-projection',
  'src/store/conversation-route-owner.ts': 'application-capability',
  'src/store/generation-capability-controller.ts': 'tab-local-projection',
  'src/store/interchange-application.ts': 'application',
  'src/store/message-storage.ts': 'public-contract',
  'src/store/new-chat-seed.ts': 'application',
  'src/store/preferences-application.ts': 'application',
  'src/store/presentation-contracts.ts': 'type-contract',
  'src/store/presentation-interaction-controller.ts': 'presentation-interaction-runtime',
  'src/store/prompt-estimate-context-workspace.ts': 'tab-local-projection',
  'src/store/quota.ts': 'browser-resource',
  'src/store/search-session.ts': 'reactive-read',
  'src/store/storage-application.ts': 'application',
  'src/store/storage-overview-controller.ts': 'tab-local-projection',
  'src/store/transcript-window.ts': 'public-contract',
  'src/store/workspace-runtime.ts': 'reactive-read',
  'src/store/workspace-presentation-lifecycle.ts': 'presentation-lifecycle',
  'src/store/workspace-shell-application.ts': 'application',
  'src/store/workspace-tab-session.ts': 'tab-local-projection',
  'src/store/zustand/announcementStore.ts': 'ui-state',
  'src/store/zustand/toastStore.ts': 'ui-state',
  'src/store/zustand/uiStore.ts': 'ui-state',
})
const ROLE_SOURCE_PATTERNS = Object.freeze({
  'application-capability': /^src\/app\/(?:conversation-actions|router)\.ts$/u,
  'application-command': /^src\/app\/conversation-actions\.ts$/u,
  'presentation-interaction-runtime': /^src\/app\/presentation-interactions\.ts$/u,
  'presentation-lifecycle': /^src\/app\/WorkspaceBootstrap\.tsx$/u,
})

for (const file of presentationFiles) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  for (const statement of source.statements) {
    if (
      (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue
    addReference(file, statement.moduleSpecifier.text, referencedNames(statement))
  }
  visitEmbeddedReferences(source, file, source, addReference)
}

function addReference(file, specifier, imports) {
  const resolved = ts.resolveModuleName(specifier, file, parsedConfig.options, ts.sys)
    .resolvedModule?.resolvedFileName
  if (!resolved) return
  const target = relative(root, resolved)
  if (!target.startsWith('src/store/')) return
  const edge = {
    source: relative(root, file),
    imports,
  }
  const edges = importsByTarget.get(target) ?? []
  edges.push(edge)
  importsByTarget.set(target, edges)
}

const missingRoles = [...importsByTarget.keys()].filter(
  (target) => !(target in PRESENTATION_STORE_TARGET_ROLES),
)
const staleRoles = Object.keys(PRESENTATION_STORE_TARGET_ROLES).filter(
  (target) => !importsByTarget.has(target),
)
const countsByRole = new Map()
for (const target of importsByTarget.keys()) {
  const role = PRESENTATION_STORE_TARGET_ROLES[target] ?? 'unclassified'
  countsByRole.set(role, (countsByRole.get(role) ?? 0) + 1)
}

console.log(`Presentation store boundary: ${importsByTarget.size} target modules`)
for (const [role, count] of [...countsByRole].sort(([left], [right]) =>
  left.localeCompare(right),
)) {
  console.log(`- ${role}: ${count}`)
}
if (process.argv.includes('--verbose')) printInventory()
const policyViolations = importPolicyViolations()
if (missingRoles.length > 0 || staleRoles.length > 0 || policyViolations.length > 0) {
  for (const target of missingRoles)
    console.error(`Unclassified presentation store target: ${target}`)
  for (const target of staleRoles) console.error(`Stale presentation store target role: ${target}`)
  for (const violation of policyViolations) console.error(violation)
  process.exitCode = 1
}

function printInventory() {
  for (const [target, edges] of [...importsByTarget].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    console.log(`${target} [${PRESENTATION_STORE_TARGET_ROLES[target] ?? 'unclassified'}]`)
    for (const edge of edges.sort((left, right) => left.source.localeCompare(right.source))) {
      console.log(`  ${edge.source}: ${edge.imports.join(', ')}`)
    }
  }
}

function referencedNames(statement) {
  if (ts.isExportDeclaration(statement)) {
    if (!statement.exportClause) return [`${statement.isTypeOnly ? 'type ' : ''}*`]
    if (ts.isNamespaceExport(statement.exportClause)) {
      return [`${statement.isTypeOnly ? 'type ' : ''}*`]
    }
    return statement.exportClause.elements.map((element) => {
      const exported = element.propertyName?.text ?? element.name.text
      return `${statement.isTypeOnly || element.isTypeOnly ? 'type ' : ''}${exported}`
    })
  }
  const clause = statement.importClause
  if (!clause) return ['side-effect']
  const names = []
  if (clause.name) names.push(`${clause.isTypeOnly ? 'type ' : ''}default`)
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    names.push(`${clause.isTypeOnly ? 'type ' : ''}*`)
  }
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text
      names.push(`${clause.isTypeOnly || element.isTypeOnly ? 'type ' : ''}${imported}`)
    }
  }
  return names
}

function visitEmbeddedReferences(node, file, source, record) {
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0])
  ) {
    record(file, node.arguments[0].text, ['dynamic *'])
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteral(node.argument.literal)
  ) {
    record(file, node.argument.literal.text, [`type ${node.qualifier?.getText(source) ?? '*'}`])
  }
  ts.forEachChild(node, (child) => visitEmbeddedReferences(child, file, source, record))
}

function assertEmbeddedTypeReferenceDiscovery() {
  const file = 'src/hooks/__presentation_boundary_fixture__.ts'
  const source = ts.createSourceFile(
    file,
    "type Leak = import('../store/storage-overview-controller').StorageGlobalCalibrationModel",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const references = []
  visitEmbeddedReferences(source, file, source, (_file, specifier, imports) => {
    references.push({ specifier, imports })
  })
  const expected = JSON.stringify([
    {
      specifier: '../store/storage-overview-controller',
      imports: ['type StorageGlobalCalibrationModel'],
    },
  ])
  if (JSON.stringify(references) !== expected) {
    throw new Error('PresentationBoundaryImportTypeDiscoveryFailed')
  }
}

function importPolicyViolations() {
  const violations = []
  for (const [target, edges] of importsByTarget) {
    const typeContract = PRESENTATION_STORE_TARGET_ROLES[target] === 'type-contract'
    const sourcePattern = ROLE_SOURCE_PATTERNS[PRESENTATION_STORE_TARGET_ROLES[target]]
    for (const edge of edges) {
      if (sourcePattern && !sourcePattern.test(edge.source)) {
        violations.push(
          `Presentation role imported by the wrong owner: ${edge.source} -> ${target} ` +
            `(${PRESENTATION_STORE_TARGET_ROLES[target]})`,
        )
      }
      for (const imported of edge.imports) {
        const typeOnly = imported.startsWith('type ')
        if (typeContract && !typeOnly) {
          violations.push(
            `Runtime import from type contract: ${edge.source} -> ${target} (${imported})`,
          )
        } else if (!typeContract && typeOnly) {
          violations.push(
            `Store type bypasses presentation contract: ${edge.source} -> ${target} (${imported})`,
          )
        }
      }
    }
  }
  return violations
}

function sourceFiles(directories) {
  const files = []
  const pending = directories.map((directory) => join(root, directory))
  while (pending.length > 0) {
    const path = pending.pop()
    if (!path) continue
    for (const name of readdirSync(path)) {
      const child = join(path, name)
      if (statSync(child).isDirectory()) pending.push(child)
      else if (['.ts', '.tsx'].includes(extname(child))) files.push(resolve(child))
    }
  }
  return files
}
