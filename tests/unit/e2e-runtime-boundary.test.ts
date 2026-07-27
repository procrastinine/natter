import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { parseE2ePort } from '../../playwright.config'
import { VERIFICATION_STAGES } from '../../scripts/run-verification.mjs'
import { portableChatEnvelopeFromWorkspace } from '../../scripts/workspace-provider-fixture.mjs'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  assertNatterExportEnvelope,
  NATTER_EXPORT_SCHEMA_VERSION,
} from '../../src/core/import-export/schema'

const ROOT = resolve(__dirname, '../..')
const E2E_ROOT = resolve(ROOT, 'tests/e2e')
const SRC_ROOT = resolve(ROOT, 'src')
const TOOLS_ROOT = resolve(ROOT, 'tools')
const SCRIPTS_ROOT = resolve(ROOT, 'scripts')
const SOURCE_EXTENSION_PATTERN = /\.[cm]?[jt]sx?$/u
const BROWSER_INSTRUMENTATION_PATTERN =
  /(?:['"`]\/src\/|\b__debug[A-Za-z0-9_]*\b|\b__nuke\b|VITE_NATTER_DEBUG|instrumented-helpers|E2E_LANE)/u
const HARDCODED_PHYSICAL_WORKSPACE_PATTERN =
  /indexedDB\s*\.\s*(?:open|deleteDatabase)\(\s*['"]natter['"]\s*\)/u
const EXPECTED_RAW_E2E_DATABASE_MUTATIONS = {
  'error-boundary.spec.ts': 1,
  'helpers.ts': 2,
  'orphan-recovery.spec.ts': 2,
  'startup-recovery.spec.ts': 3,
  'storage-reclamation.spec.ts': 2,
} as const
const EXPECTED_RAW_E2E_READWRITE_TRANSACTIONS = {
  'error-boundary.spec.ts': 1,
  'helpers.ts': 2,
  'orphan-recovery.spec.ts': 1,
  'startup-recovery.spec.ts': 3,
  'storage-reclamation.spec.ts': 2,
} as const

function readText(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8')
}

function readJson<T>(path: string): T {
  return JSON.parse(readText(path)) as T
}

function filesBelow(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name)
    return entry.isDirectory() ? filesBelow(path) : [path]
  })
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function targetsRuntimeExcludedTooling(importerPath: string, specifier: string): boolean {
  const withoutQuery = specifier.replace(/[?#].*$/u, '')
  const target = withoutQuery.startsWith('/')
    ? resolve(ROOT, `.${withoutQuery}`)
    : resolve(dirname(importerPath), withoutQuery)
  return [TOOLS_ROOT, SCRIPTS_ROOT].some(
    (root) => target === root || target.startsWith(`${root}${sep}`),
  )
}

function toolingImportOffenders(path: string, source = readFileSync(path, 'utf8')): string[] {
  const sourcePath = relativePath(SRC_ROOT, path)
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const offenders: string[] = []
  const record = (node: ts.Node, kind: string, expression: ts.Expression | undefined) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    if (!expression || !ts.isStringLiteralLike(expression)) {
      offenders.push(`${sourcePath}:${line}:${kind}:<non-literal>`)
    } else if (targetsRuntimeExcludedTooling(path, expression.text)) {
      offenders.push(`${sourcePath}:${line}:${kind}:${expression.text}`)
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      record(node, 'import', node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      record(node, 'export', node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node, 'import-equals', node.moduleReference.expression)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record(node, 'dynamic-import', node.arguments[0])
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      record(node, 'require', node.arguments[0])
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return offenders
}

function e2eRuntimeSourceImportOffenders(path: string): string[] {
  const sourcePath = relativePath(E2E_ROOT, path)
  const sourceFile = ts.createSourceFile(
    sourcePath,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const offenders: string[] = []
  const record = (node: ts.Node, kind: string, expression: ts.Expression | undefined) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
    if (!expression || !ts.isStringLiteralLike(expression)) {
      offenders.push(`${sourcePath}:${line}:${kind}:<non-literal>`)
      return
    }
    const target = expression.text.startsWith('/')
      ? resolve(ROOT, `.${expression.text}`)
      : resolve(dirname(path), expression.text)
    if (target === SRC_ROOT || target.startsWith(`${SRC_ROOT}${sep}`)) {
      offenders.push(`${sourcePath}:${line}:${kind}:${expression.text}`)
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      record(node, 'import', node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      record(node, 'export', node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node, 'import-equals', node.moduleReference.expression)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record(node, 'dynamic-import', node.arguments[0])
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      record(node, 'require', node.arguments[0])
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return offenders
}

function rawE2eDatabaseMutations(path: string): string[] {
  const sourcePath = relativePath(E2E_ROOT, path)
  const sourceFile = ts.createSourceFile(
    sourcePath,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const objectStoreVariables = new Set<string>()
  const cursorRequestVariables = new Set<string>()
  const cursorVariables = new Set<string>()
  const isObjectStoreCall = (node: ts.Node | undefined): node is ts.CallExpression =>
    node !== undefined &&
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'objectStore'
  const collectObjectStores = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isObjectStoreCall(node.initializer)
    ) {
      objectStoreVariables.add(node.name.text)
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isPropertyAccessExpression(node.initializer.expression) &&
      node.initializer.expression.name.text === 'openCursor'
    ) {
      cursorRequestVariables.add(node.name.text)
    }
    node.forEachChild(collectObjectStores)
  }
  collectObjectStores(sourceFile)
  const collectCursors = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isPropertyAccessExpression(node.initializer) &&
      node.initializer.name.text === 'result' &&
      ts.isIdentifier(node.initializer.expression) &&
      cursorRequestVariables.has(node.initializer.expression.text)
    ) {
      cursorVariables.add(node.name.text)
    }
    node.forEachChild(collectCursors)
  }
  collectCursors(sourceFile)

  const mutations: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const receiver = node.expression.expression
      if (
        (['add', 'clear', 'delete', 'put'].includes(method) &&
          (isObjectStoreCall(receiver) ||
            (ts.isIdentifier(receiver) && objectStoreVariables.has(receiver.text)))) ||
        (['delete', 'update'].includes(method) &&
          ts.isIdentifier(receiver) &&
          cursorVariables.has(receiver.text))
      ) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        mutations.push(`${sourcePath}:${line}:${method}`)
      }
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return mutations
}

function rawE2eReadwriteTransactions(path: string): string[] {
  const sourcePath = relativePath(E2E_ROOT, path)
  const sourceFile = ts.createSourceFile(
    sourcePath,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const transactions: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'transaction' &&
      node.arguments.some(
        (argument) => ts.isStringLiteralLike(argument) && argument.text === 'readwrite',
      )
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      transactions.push(`${sourcePath}:${line}`)
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return transactions
}

function rawBrowserDatabaseImportOffenders(path: string): string[] {
  const sourcePath = relativePath(SRC_ROOT, path)
  const sourceFile = ts.createSourceFile(
    sourcePath,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const offenders: string[] = []
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }
    const target = resolve(dirname(path), statement.moduleSpecifier.text)
    if (target !== resolve(SRC_ROOT, 'store/db')) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text
      if (importedName !== 'getDb' && importedName !== 'openDb') continue
      const line = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1
      offenders.push(`${sourcePath}:${line}:${importedName}`)
    }
  }
  return offenders
}

function preCanonicalWorkspaceOpenOffenders(path: string): string[] {
  const sourcePath = relativePath(ROOT, path)
  const sourceFile = ts.createSourceFile(
    sourcePath,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const offenders: string[] = []
  const inspect = (scope: ts.FunctionLikeDeclaration) => {
    const calls: Array<{ name: string; position: number; line: number }> = []
    const visit = (node: ts.Node) => {
      if (
        node !== scope &&
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node))
      ) {
        return
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        calls.push({
          name: node.expression.text,
          position: node.getStart(sourceFile),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        })
      }
      node.forEachChild(visit)
    }
    scope.forEachChild(visit)
    const firstCanonicalOpen = calls.find((call) => call.name === 'openBrowserWorkspace')
    if (!firstCanonicalOpen) return
    for (const call of calls) {
      if (call.name === 'openDb' && call.position < firstCanonicalOpen.position) {
        offenders.push(`${sourcePath}:${call.line}`)
      }
    }
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      inspect(node)
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return offenders
}

function unguardedNamedCallOffenders(
  path: string,
  calleeName: string,
  guardName: string,
): string[] {
  const sourcePath = relativePath(ROOT, path)
  const sourceFile = ts.createSourceFile(
    sourcePath,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const requiresGuard = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression)) return expression.text === guardName
    if (
      ts.isCallExpression(expression) &&
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === guardName
    ) {
      return true
    }
    if (ts.isParenthesizedExpression(expression)) return requiresGuard(expression.expression)
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return requiresGuard(expression.left) || requiresGuard(expression.right)
    }
    return false
  }
  const insideGuard = (node: ts.Node): boolean => {
    let current = node
    while (current !== sourceFile) {
      const parent = current.parent
      if (
        ts.isIfStatement(parent) &&
        parent.thenStatement === current &&
        requiresGuard(parent.expression)
      ) {
        return true
      }
      current = parent
    }
    return false
  }
  const offenders: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === calleeName &&
      !insideGuard(node)
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      offenders.push(`${sourcePath}:${line}`)
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return offenders
}

function e2eInstrumentationSubject(path: string): string {
  const source = readFileSync(path, 'utf8')
  if (relativePath(E2E_ROOT, path) !== 'production-startup.spec.ts') return source
  return source
    .replaceAll('/src/main.tsx', '/')
    .replaceAll('__debugFakeStream', 'absentGlobalOne')
    .replaceAll('__debugRuntime', 'absentGlobalTwo')
    .replaceAll('__debugScroll', 'absentGlobalThree')
    .replaceAll('__debugStreams', 'absentGlobalFour')
    .replaceAll('__nuke', 'absentGlobalFive')
}

function ambientUniqueSymbolRuntimeOffenders(path: string): string[] {
  const sourcePath = relativePath(SRC_ROOT, path)
  const sourceFile = ts.createSourceFile(
    sourcePath,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    sourcePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const ambientSymbols = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
    ) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.type &&
        ts.isTypeOperatorNode(declaration.type) &&
        declaration.type.operator === ts.SyntaxKind.UniqueKeyword &&
        declaration.type.type.kind === ts.SyntaxKind.SymbolKeyword
      ) {
        ambientSymbols.add(declaration.name.text)
      }
    }
  }
  if (ambientSymbols.size === 0) return []
  const offenders: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isComputedPropertyName(node) &&
      ts.isIdentifier(node.expression) &&
      ambientSymbols.has(node.expression.text) &&
      (ts.isPropertyAssignment(node.parent) ||
        ts.isMethodDeclaration(node.parent) ||
        ts.isPropertyDeclaration(node.parent) ||
        ts.isGetAccessorDeclaration(node.parent) ||
        ts.isSetAccessorDeclaration(node.parent))
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      offenders.push(`${sourcePath}:${line}:${node.expression.text}`)
    }
    node.forEachChild(visit)
  }
  visit(sourceFile)
  return offenders
}

describe('built-app runtime boundary', () => {
  it('never emits type-only unique-symbol brands as runtime object keys', () => {
    const offenders = filesBelow(SRC_ROOT)
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .flatMap(ambientUniqueSymbolRuntimeOffenders)
      .sort()
    expect(offenders).toEqual([])
  })

  it('builds browser fixtures through the public portable-chat contract', () => {
    const settings = {
      ...cloneDefaultChatSettings(),
      profileId: 'profile-1',
      model: 'fixture/model',
    }
    const backup = {
      objectKind: 'workspace-backup',
      exportSchemaVersion: NATTER_EXPORT_SCHEMA_VERSION,
      appStorageSchemaVersion: 55,
      createdAt: 1,
      source: { app: 'natter', backendKind: 'browser-idb' },
      payload: {
        profiles: [
          {
            id: 'profile-1',
            name: 'Fixture profile',
            kind: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:4174/v1',
          },
        ],
        presets: [
          {
            id: 'preset-1',
            connectionProfileId: 'profile-1',
            settings,
          },
        ],
      },
    }
    const value = portableChatEnvelopeFromWorkspace(backup, {
      sourceChatId: 'source-chat',
      title: 'Public fixture',
      createdAt: 10,
      messages: [
        {
          id: 'source-message',
          chatId: 'ignored-private-id',
          parentId: null,
          siblingIndex: 0,
          turnId: 'turn-1',
          turnIndex: 0,
          createdAt: 10,
          role: 'user',
          origin: 'user',
          content: [{ type: 'text', text: 'fixture body' }],
          nodeVersion: 0,
          deleted: false,
        },
      ],
    })

    expect(() => assertNatterExportEnvelope(value)).not.toThrow()
    expect(value).toMatchObject({
      objectKind: 'chat',
      payload: {
        chat: { sourceChatId: 'source-chat', settings },
        messages: [{ id: 'source-message', chatId: 'source-chat' }],
      },
    })
  })

  it('keeps raw browser database handles behind the tracked workspace boundary', () => {
    const offenders = filesBelow(SRC_ROOT)
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .flatMap((path) => rawBrowserDatabaseImportOffenders(path))
      .sort()
    expect(offenders).toEqual([])
    expect(readText('src/main.tsx')).toContain('openBrowserWorkspace')
    expect(readText('src/main.tsx')).not.toMatch(/\b(?:getDb|openDb)\b/u)
  })

  it('keeps lifecycle tests on the canonical workspace open path', () => {
    const offenders = filesBelow(resolve(ROOT, 'tests'))
      .filter((path) => /\.(?:test|spec)\.tsx?$/u.test(path))
      .flatMap((path) => preCanonicalWorkspaceOpenOffenders(path))
      .sort()
    expect(offenders).toEqual([])
  })

  it('keeps runtime source imports pointed away from dev-only tools', () => {
    const offenders = filesBelow(SRC_ROOT)
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .flatMap((path) => toolingImportOffenders(path))
      .sort()
    expect(offenders).toEqual([])

    const cruiser = readText('.dependency-cruiser.cjs')
    expect(cruiser).toContain("name: 'runtime-must-not-import-devtools'")
    expect(cruiser).toContain("name: 'runtime-must-not-import-scripts'")
    expect(cruiser).toContain("from: { path: '^src/' }")
    expect(cruiser).toContain("to: { path: '^tools/' }")
    expect(cruiser).toContain("to: { path: '^scripts/' }")
    expect(cruiser).toContain("includeOnly: '^(src|tools|scripts)/'")
  })

  it('recognizes static, dynamic, and unanalyzable imports across the devtool boundary', () => {
    const importer = resolve(SRC_ROOT, 'nested/runtime.ts')
    const source = [
      "import type { One } from '../../tools/static'",
      "export { Two } from '/scripts/reexport?raw'",
      "import Three = require('../../tools/import-equals')",
      'void import(`../../tools/dynamic`)',
      "require('../../tools/commonjs')",
      'void import(runtimeModule)',
    ].join('\n')
    expect(toolingImportOffenders(importer, source)).toEqual([
      'nested/runtime.ts:1:import:../../tools/static',
      'nested/runtime.ts:2:export:/scripts/reexport?raw',
      'nested/runtime.ts:3:import-equals:../../tools/import-equals',
      'nested/runtime.ts:4:dynamic-import:../../tools/dynamic',
      'nested/runtime.ts:5:require:../../tools/commonjs',
      'nested/runtime.ts:6:dynamic-import:<non-literal>',
    ])
  })

  it('canonicalizes E2E ports before checking server separation', () => {
    expect(parseE2ePort('04174', 'TEST_PORT')).toBe(4174)
    expect(parseE2ePort('4174', 'TEST_PORT')).toBe(4174)
    for (const invalid of ['', '0', '-1', '1.5', '65536', 'not-a-port']) {
      expect(() => parseE2ePort(invalid, 'TEST_PORT')).toThrow(`Invalid TEST_PORT: ${invalid}`)
    }

    const config = readText('playwright.config.ts')
    expect(config).toContain('if (fakeProviderPort === port)')
  })

  it('keeps every browser spec independent of Vite source modules and debug globals', () => {
    const offenders = filesBelow(E2E_ROOT)
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .flatMap((path) => {
        const source = e2eInstrumentationSubject(path)
        return BROWSER_INSTRUMENTATION_PATTERN.test(source) ? [relativePath(E2E_ROOT, path)] : []
      })
    expect(offenders).toEqual([])
    expect(
      filesBelow(E2E_ROOT)
        .map((path) => relativePath(E2E_ROOT, path))
        .filter((path) => /\.instrumented\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(path)),
    ).toEqual([])
  })

  it('keeps ordinary E2E setup on public application boundaries', () => {
    const files = filesBelow(E2E_ROOT).filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
    expect(files.flatMap((path) => e2eRuntimeSourceImportOffenders(path)).sort()).toEqual([])

    const mutationCounts: Record<string, number> = {}
    for (const entry of files.flatMap((path) => rawE2eDatabaseMutations(path))) {
      const path = entry.split(':', 1)[0] ?? ''
      mutationCounts[path] = (mutationCounts[path] ?? 0) + 1
    }
    expect(mutationCounts).toEqual(EXPECTED_RAW_E2E_DATABASE_MUTATIONS)

    const readwriteTransactionCounts: Record<string, number> = {}
    for (const entry of files.flatMap((path) => rawE2eReadwriteTransactions(path))) {
      const path = entry.split(':', 1)[0] ?? ''
      readwriteTransactionCounts[path] = (readwriteTransactionCounts[path] ?? 0) + 1
    }
    expect(readwriteTransactionCounts).toEqual(EXPECTED_RAW_E2E_READWRITE_TRANSACTIONS)
  })

  it('keeps browser tests and profile tools independent of the active physical workspace slot', () => {
    const candidates = [
      ...filesBelow(E2E_ROOT),
      ...filesBelow(SCRIPTS_ROOT).filter((path) =>
        /^profile-.*\.[cm]?[jt]s$/u.test(relativePath(SCRIPTS_ROOT, path)),
      ),
    ].filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
    const offenders = candidates
      .filter((path) => HARDCODED_PHYSICAL_WORKSPACE_PATTERN.test(readFileSync(path, 'utf8')))
      .map((path) => relativePath(ROOT, path))
      .sort()
    expect(offenders).toEqual(['tests/e2e/legacy-import-recovery.spec.ts'])
    expect(readText('tests/e2e/helpers.ts')).toContain("indexedDB.open('natter-control')")
    expect(readText('scripts/profile-stream-harness.mjs')).toContain(
      "const control = await openDatabase('natter-control')",
    )
  })

  it('runs one built artifact with the standalone fake API server', () => {
    const config = readText('playwright.config.ts')
    const packageJson = readJson<{ scripts: Record<string, string> }>('package.json')

    expect(config).toContain("const skipBuild = process.env.E2E_SKIP_BUILD === '1'")
    expect(config).toContain('...(skipBuild ? [] : [`${packageManagerCommand} build`])')
    expect(config).toContain('command: applicationServerCommand')
    expect(config).toContain('command: `${packageManagerCommand} fake-provider -- --host')
    expect(config).not.toContain('E2E_BUILD_KIND')
    expect(config).not.toContain('build:pages')
    expect(config).toContain('${packageManagerCommand} exec vite preview --host')
    expect(packageJson.scripts.preview).toBe('pnpm build && vite preview')
    expect(config).toContain('${packageManagerCommand} fake-provider -- --host')
    expect(config).toContain('E2E_FAKE_PROVIDER_ORIGIN')
    expect(config).not.toContain('E2E_FAKE_PROVIDER_URL')
    expect(config).toMatch(/url: `\$\{fakeProviderURL\}\/healthz`/u)
    expect(config).toContain("process.env.E2E_REUSE_EXISTING_SERVER === '1'")
    expect(readText('scripts/run-verification.mjs')).toContain("E2E_REUSE_EXISTING_SERVER: '0'")
    expect(readText('scripts/run-verification.mjs')).toContain(
      "['chromium-e2e', 'headed-hidden-tab-visual-continuity', 'dev-preview-parity'].includes(item.id)",
    )
    const runner = readText('scripts/run-verification.mjs')
    expect(runner.indexOf("stage('production-build'")).toBeLessThan(
      runner.indexOf("stage('chromium-e2e'"),
    )
    expect(runner.indexOf("stage('chromium-e2e'")).toBeLessThan(
      runner.indexOf("'headed-hidden-tab-visual-continuity',"),
    )
    expect(runner.indexOf("'headed-hidden-tab-visual-continuity',")).toBeLessThan(
      runner.indexOf("'dev-preview-parity',"),
    )
    expect(runner.indexOf("'dev-preview-parity',")).toBeLessThan(
      runner.indexOf("stage('stream-profile-single'"),
    )
    expect(runner.indexOf("'stream-profile-concurrent'")).toBeLessThan(
      runner.indexOf("stage('performance'"),
    )
    expect(config).toContain('--strictPort')
    expect(config).toContain("process.env.E2E_DEV_PREVIEW_PARITY === '1'")
    expect(config).toContain('command: devServerCommand')
    expect(config).toContain('url: `${devBaseURL}/src/main.tsx`')
    expect(config).toContain("name: 'chromium-preview-parity'")
    expect(config).toContain("name: 'chromium-dev-parity'")
    expect(config).toContain("process.env.E2E_HEADED_VISIBILITY === '1'")
    expect(config).toContain("name: 'chromium-headed-visibility'")
    expect(config).toContain('headless: false')
    expect(config).toContain('testMatch: devPreviewParitySpec')
    const headedRunner = readText('scripts/run-headed-visibility.mjs')
    expect(headedRunner).toContain("process.env.E2E_NATIVE_TMP_ROOT ?? '/tmp'")
    expect(headedRunner).toContain("mkdtempSync(join(nativeTmpRoot, 'ntr-hv-'))")
    expect(headedRunner).toContain('TEMP: workingDirectory')
    expect(headedRunner).toContain('TMP: workingDirectory')
    expect(headedRunner).toContain('TMPDIR: workingDirectory')
    expect(headedRunner).toContain('env: nativeChildEnvironment')
    expect(headedRunner).not.toContain('mkdtempSync(join(tmpdir()')
    expect(config).not.toContain('VITE_NATTER_DEBUG')
    expect(config).not.toContain('E2E_LANE')
    expect(config).toContain("name: 'large-workspace-setup'")
    expect(config).toContain("name: 'chromium-large-workspace'")
    expect(config).toContain('large-workspace-startup')
    expect(config).toContain('large-workspace\\.setup')

    expect(packageJson.scripts.e2e).toBe('playwright test --project=chromium')
    expect(packageJson.scripts['e2e:production']).toBe('playwright test --project=chromium')
    expect(packageJson.scripts['e2e:headed-visibility']).toContain('xvfb-run --auto-servernum')
    expect(packageJson.scripts['e2e:startup-scale']).toBe(
      'playwright test --project=chromium-large-workspace',
    )
    expect(packageJson.scripts['e2e:instrumented']).toBeUndefined()
    expect(packageJson.scripts['e2e:smoke']).toMatch(/^playwright test /u)
    expect(packageJson.scripts['e2e:production-startup']).toMatch(/^playwright test /u)
    expect(packageJson.scripts['build:pages']).toBeUndefined()
    expect(packageJson.scripts['fake-provider']).toBe('node scripts/fake-stream-server.mjs')
  })

  it('retargets fake-provider workspaces through one production import boundary', () => {
    const e2eSetup = readText('tests/e2e/fake-stream-provider.ts')
    const profileHarness = readText('scripts/profile-stream-harness.mjs')
    const sharedSetup = readText('scripts/workspace-provider-fixture.mjs')

    expect(e2eSetup).toContain('retargetWorkspaceThroughBackupImport')
    expect(profileHarness).toContain('retargetWorkspaceThroughBackupImport')
    expect(e2eSetup).not.toMatch(/indexedDB|objectStore\(['"]profiles['"]\)/u)
    expect(profileHarness).not.toContain('retargetWorkspaceForCurrentTab')
    expect(profileHarness).not.toMatch(/transaction\(\['profiles', 'presets', 'chats'\]/u)
    expect(sharedSetup).toContain('[data-ui="storage-workspace-import-input"]')
    expect(sharedSetup).toContain('Export sensitive backup')
    expect(sharedSetup).not.toMatch(/indexedDB|sessionStorage/u)
  })

  it('inventories tab storage and reconciles workspace-scoped keys at one epoch boundary', () => {
    const sessionStorageFiles = filesBelow(SRC_ROOT)
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .filter((path) => readFileSync(path, 'utf8').includes('sessionStorage'))
      .map((path) => relativePath(SRC_ROOT, path))
      .sort()
    expect(sessionStorageFiles).toEqual(['lib/browser-storage.ts', 'lib/storage-wipe.ts'])

    const sessionStoragePortFiles = filesBelow(SRC_ROOT)
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .filter((path) => readFileSync(path, 'utf8').includes('browserSessionStorage'))
      .map((path) => relativePath(SRC_ROOT, path))
      .sort()
    expect(sessionStoragePortFiles).toEqual([
      'lib/browser-storage.ts',
      'lib/preload-recovery.ts',
      'lib/storage-wipe.ts',
      'store/configuration-controller.ts',
      'store/conversation-controller.ts',
      'store/workspace-tab-session.ts',
      'ui/chat/composer-draft-state.ts',
    ])

    const localStoragePortFiles = filesBelow(SRC_ROOT)
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .filter((path) => readFileSync(path, 'utf8').includes('browserLocalStorage'))
      .map((path) => relativePath(SRC_ROOT, path))
      .sort()
    expect(localStoragePortFiles).toEqual([
      'lib/browser-storage.ts',
      'lib/storage-wipe.ts',
      'store/broadcast.ts',
      'store/browser-workspace-slot-coordination.ts',
      'store/storage-administration.ts',
      'store/storage-compaction-state.ts',
    ])

    for (const workspaceKey of [
      'natter:active-seed',
      'natter:conversation-session:',
      'natter:composer-draft:',
      'natter:workspace-tab-session:v3',
    ]) {
      const owners = filesBelow(SRC_ROOT)
        .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
        .filter((path) => readFileSync(path, 'utf8').includes(workspaceKey))
        .map((path) => relativePath(SRC_ROOT, path))
      expect(owners, workspaceKey).toEqual(['store/workspace-tab-session.ts'])
    }

    const replacementFiles = filesBelow(SRC_ROOT)
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .filter((path) => readFileSync(path, 'utf8').includes('markBrowserWorkspaceReplaced('))
      .map((path) => relativePath(SRC_ROOT, path))
      .sort()
    expect(replacementFiles).toEqual(['store/browser-import-export.ts', 'store/workspace-meta.ts'])
    expect(readText('src/store/browser-workspace-replacement-runner.ts')).toContain(
      "postWorkspaceChange({ kind: 'replace'",
    )
    const lifecycle = readText('src/store/browser-workspace-lifecycle.ts')
    expect(lifecycle).toContain("id: 'tab-session'")
    expect(lifecycle).toContain('reconcileWorkspaceTabSessionStorage(authority)')
    expect(readText('src/lib/storage-wipe.ts')).toContain(
      "requiredWebStorage(browserSessionStorage(), 'sessionStorage')",
    )
    const resetEntryPoints = [...filesBelow(SRC_ROOT), ...filesBelow(TOOLS_ROOT)]
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .filter((path) => readFileSync(path, 'utf8').includes('clearLocalWorkspaceStorage('))
      .map((path) => relativePath(ROOT, path))
      .sort()
    expect(resetEntryPoints).toEqual([
      'src/main.tsx',
      'src/store/storage-administration.ts',
      'tools/debug-nuke.ts',
    ])
    expect(readText('src/lib/preload-recovery.ts')).toContain("'natter:preload-recovery-build'")
    expect(readText('src/ui/settings/PromptPresetEditor.tsx')).toContain(
      "'natter:system-prompt-toast-shown'",
    )
  })

  it('starts the fake API explicitly in CI and tests before performance reporting', () => {
    const verify = readText('.github/workflows/verify.yml')
    const deploy = readText('.github/workflows/deploy.yml')
    const verifyE2eIndex = VERIFICATION_STAGES.findIndex((stage) => stage.id === 'chromium-e2e')
    const verifyPerfIndex = VERIFICATION_STAGES.findIndex((stage) => stage.id === 'performance')
    const verifyE2e = VERIFICATION_STAGES[verifyE2eIndex]
    const deployStartupIndex = deploy.indexOf('run: pnpm e2e:production-startup')
    const deployUploadIndex = deploy.indexOf('uses: actions/upload-pages-artifact')

    expect(verify).toContain('run: pnpm verify:ci')
    expect(readText('scripts/run-ci-verification.mjs')).toContain(
      "import('./launch-slice-verification.mjs')",
    )
    expect(readText('scripts/run-ci-verification.mjs')).toContain("runnerKind: 'checkpoint'")
    expect(verify).toContain('test-results/verification-checkpoint/')
    expect(verify).toContain('test-results/verification-stages/')
    expect(verifyE2e?.label).toBe('Test the built app against the loopback fake provider')
    expect(verifyE2e?.argv).toEqual([
      'pnpm',
      'exec',
      'playwright',
      'test',
      '--project=chromium',
      '--project=chromium-large-workspace',
    ])
    expect(readText('scripts/run-verification.mjs')).toContain("E2E_FAKE_PROVIDER_PORT: '4174'")
    expect(verifyE2eIndex).toBeGreaterThanOrEqual(0)
    expect(verifyPerfIndex).toBeGreaterThan(verifyE2eIndex)
    expect(
      VERIFICATION_STAGES.slice(verifyE2eIndex, verifyPerfIndex).some((stage) =>
        stage.argv.includes('build'),
      ),
    ).toBe(false)
    expect(deployStartupIndex).toBeGreaterThanOrEqual(0)
    expect(deployUploadIndex).toBeGreaterThan(deployStartupIndex)
    expect(deploy.slice(deployStartupIndex, deployUploadIndex)).not.toContain('pnpm build')
  })

  it('pins local tools and every CI workflow to the same Node and pnpm runtime', () => {
    const packageJson = readJson<{
      packageManager: string
      engines: { node: string }
      scripts: Record<string, string>
    }>('package.json')
    const nodeVersion = readText('.node-version').trim()
    const workflows = filesBelow(resolve(ROOT, '.github/workflows')).filter((path) =>
      path.endsWith('.yml'),
    )

    expect(nodeVersion).toMatch(/^26\.\d+\.\d+$/u)
    expect(packageJson.engines.node).toBe(nodeVersion)
    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/u)
    for (const workflow of workflows) {
      const source = readFileSync(workflow, 'utf8')
      expect(source, relativePath(ROOT, workflow)).toContain('node-version-file: .node-version')
      expect(source, relativePath(ROOT, workflow)).not.toMatch(/node-version:\s*['"]?\d/iu)
    }

    const verify = readText('.github/workflows/verify.yml')
    expect(verify).toContain('run: pnpm verify:ci')
    expect(VERIFICATION_STAGES.find((stage) => stage.id === 'vitest')?.argv).toEqual([
      'pnpm',
      'exec',
      'vitest',
      'run',
    ])
    expect(VERIFICATION_STAGES.find((stage) => stage.id === 'chromium-e2e')?.argv).toEqual([
      'pnpm',
      'exec',
      'playwright',
      'test',
      '--project=chromium',
      '--project=chromium-large-workspace',
    ])
    expect(
      VERIFICATION_STAGES.find((stage) => stage.id === 'headed-hidden-tab-visual-continuity')?.argv,
    ).toEqual(['pnpm', 'run', 'e2e:headed-visibility'])
    expect(VERIFICATION_STAGES.find((stage) => stage.id === 'dev-preview-parity')?.argv).toEqual([
      'pnpm',
      'exec',
      'playwright',
      'test',
      '--project=chromium-preview-parity',
      '--project=chromium-dev-parity',
    ])
    expect(packageJson.scripts['test:run']).toBe(
      'node scripts/audit-protocol-contracts.mjs --mode inventory --facts-output test-results/protocol-contract-facts.json --mutation-output test-results/protocol-contract-mutation-proof.json && vitest run',
    )
    expect(packageJson.scripts.e2e).toBe('playwright test --project=chromium')
  })

  it('limits build-mode behavior to the privacy proxy and keeps devtools outside the app entry', () => {
    const unsupportedRuntimeEnvFiles = filesBelow(SRC_ROOT)
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .filter((path) => {
        const sourcePath = relativePath(SRC_ROOT, path)
        let source = readFileSync(path, 'utf8').replaceAll(
          "import.meta.env.MODE === 'test'",
          'false',
        )
        if (
          sourcePath === 'core/global-settings.ts' ||
          sourcePath === 'ui/settings/GeneralSettings.tsx'
        ) {
          source = source.replaceAll('import.meta.env.DEV', 'false')
        }
        return /import\.meta\.env/u.test(source)
      })
      .map((path) => relativePath(SRC_ROOT, path))
      .sort()
    expect(unsupportedRuntimeEnvFiles).toEqual([])

    const envSwitchFiles = filesBelow(SRC_ROOT)
      .filter((path) => SOURCE_EXTENSION_PATTERN.test(path))
      .filter((path) => /import\.meta\.env\.(?:DEV|PROD)/u.test(readFileSync(path, 'utf8')))
      .map((path) => relativePath(SRC_ROOT, path))
      .sort()
    expect(envSwitchFiles).toEqual(['core/global-settings.ts', 'ui/settings/GeneralSettings.tsx'])
    expect(readText('src/core/global-settings.ts')).toContain('defaultCorsProxyUrlForRuntime')
    expect(readText('src/ui/settings/GeneralSettings.tsx')).toContain(
      'const isDev = import.meta.env.DEV',
    )

    const main = readText('src/main.tsx')
    const vite = readText('vite.config.ts')
    const devtools = readText('tools/browser-devtools.ts')
    expect(main).not.toMatch(/installDebug|browser-devtools|import\.meta\.env/u)
    expect(vite).toContain("apply: 'serve' as const")
    expect(vite).toContain("src: '/tools/browser-devtools.ts'")
    expect(vite).not.toMatch(/STATEFUL_RUNTIME_PATHS|fullReloadStatefulRuntime|handleHotUpdate/u)
    expect(vite).toContain("'/_or_scrape'")
    expect(vite).toContain('watch:')
    expect(devtools).toContain('installDebugScroll()')
    expect(devtools).toContain('installDebugStreams()')
    const streamDiagnostics = readText('src/lib/debug-streams.ts')
    const streamDevtool = readText('tools/debug-streams.ts')
    expect(streamDiagnostics).toContain('setStreamDebugSink')
    expect(streamDiagnostics).toContain('setRequestPlanDebugSink')
    expect(streamDiagnostics).not.toMatch(/entryBuffer|planBuffer|MAX_BUFFER_ENTRIES/u)
    expect(streamDevtool).toMatch(/entryBuffer|planBuffer|MAX_BUFFER_ENTRIES/u)
    expect(readText('src/lib/debug-scroll.ts')).not.toMatch(/localStorage|MAX_BUFFER_ENTRIES/u)
    expect(readText('tools/debug-scroll.ts')).toMatch(/localStorage|MAX_BUFFER_ENTRIES/u)
    const scrollRegionPath = resolve(SRC_ROOT, 'ui/chat/ScrollRegion.tsx')
    const scrollRegion = readFileSync(scrollRegionPath, 'utf8')
    expect(scrollRegion).not.toContain('import.meta.env')
    expect(scrollRegion).toContain('if (!hasScrollDebugSink()) return')
    expect(
      unguardedNamedCallOffenders(scrollRegionPath, 'debugScroll', 'hasScrollDebugSink'),
    ).toEqual([])
    const fixtures = readText('tests/e2e/fixtures.ts')
    expect(fixtures).not.toMatch(/vite:forward-console|vite-forward-console|\.on\(['"]websocket/u)
    expect(main).toContain("from './store/storage-administration'")
    expect(existsSync(resolve(SRC_ROOT, 'lib/debug-nuke.ts'))).toBe(false)
    expect(readText('src/app/Shell.tsx')).not.toContain('recycle-transcript')
    expect(existsSync(resolve(SRC_ROOT, 'lib/debug-fake-stream.ts'))).toBe(false)
  })

  it('keeps the production startup probe explicit about absent devtools', () => {
    const source = readText('tests/e2e/production-startup.spec.ts')
    expect(source).toContain("request.get('/src/main.tsx',")
    expect(source).toContain("Accept: 'application/javascript'")
    for (const global of [
      '__debugFakeStream',
      '__debugRuntime',
      '__debugScroll',
      '__debugStreams',
      '__nuke',
    ]) {
      expect(source).toContain(global)
    }
    expect(source).toContain('toEqual([])')
  })

  it('rejects standalone fake-provider fingerprints from distribution artifacts', () => {
    const verifier = readText('scripts/verify-dist.mjs')
    for (const marker of [
      'natter/fake-stream',
      '/__control/scenarios/',
      'E2E_FAKE_PROVIDER_ORIGIN',
      'fake-stream-server.mjs',
    ]) {
      expect(verifier).toContain(`'${marker}'`)
    }
  })
})
