import { readdirSync, readFileSync } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')
const RESET_CLASSIFICATIONS = Object.freeze({
  'tests/unit/backcompat-boundary.test.ts': Object.freeze({
    classification: 'mocked-migration-module-lifetime',
    callCount: 4,
    dynamicTargets: Object.freeze(['../../src/store/db']),
  }),
  'tests/unit/shiki-code-plugin-cache.test.tsx': Object.freeze({
    classification: 'pure-cache',
    callCount: 1,
    dynamicTargets: Object.freeze(['../../src/ui/chat/shiki-code-plugin']),
  }),
})
const PRODUCTION_KERNEL_INSTANTIATIONS = Object.freeze([
  'src/store/workspace-runtime-control.ts#productionWorkspaceRuntimeControl#createWorkspaceRuntimeControlKernel',
  'src/store/workspace-runtime.ts#productionWorkspaceRuntime#createWorkspaceRuntimeKernel',
])

export function auditTestRuntimeIsolation(root = ROOT) {
  const resetSites = []
  const dynamicTargets = new Map()
  const mixedMockImportSites = []
  const productionKernelInstantiations = []
  const browserWorkspaceLifetimeFiles = []
  const unownedBrowserWorkspaceLifetimeFiles = []
  const problems = []
  for (const path of sourceFiles(resolve(root, 'src'))) {
    const rel = repositoryRelative(root, path)
    const text = readFileSync(path, 'utf8')
    if (
      !containsAny(text, [
        'resetModules',
        'createWorkspaceRuntimeKernel',
        'createWorkspaceRuntimeControlKernel',
      ])
    ) {
      continue
    }
    const source = parse(rel, text)
    visit(source, (node) => {
      if (isResetModulesCall(node)) {
        resetSites.push({ path: rel, line: lineFor(source, node) })
      }
      const kernel = calledIdentifier(node)
      if (
        kernel !== 'createWorkspaceRuntimeKernel' &&
        kernel !== 'createWorkspaceRuntimeControlKernel'
      ) {
        return
      }
      productionKernelInstantiations.push(`${rel}#${enclosingOwner(node)}#${kernel}`)
    })
  }
  for (const path of sourceFiles(resolve(root, 'tests'))) {
    const rel = repositoryRelative(root, path)
    const text = readFileSync(path, 'utf8')
    if (!containsAny(text, ['resetModules', 'openBrowserWorkspace', 'mock'])) {
      continue
    }
    const source = parse(rel, text)
    const staticTargets = new Set()
    const mockedTargets = new Set()
    const fileDynamicTargets = new Set()
    const browserWorkspaceOpenNames = new Set()
    const browserWorkspaceShutdownNames = new Set()
    const calledNames = new Set()
    visit(source, (node) => {
      if (isResetModulesCall(node)) resetSites.push({ path: rel, line: lineFor(source, node) })
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        isRuntimeImportDeclaration(node)
      ) {
        staticTargets.add(node.moduleSpecifier.text)
        if (node.moduleSpecifier.text.endsWith('/src/store/browser-workspace-lifecycle')) {
          collectNamedImportLocals(node, 'openBrowserWorkspace', browserWorkspaceOpenNames)
          collectNamedImportLocals(node, 'shutdownBrowserWorkspace', browserWorkspaceShutdownNames)
        }
      }
      const called = calledIdentifier(node)
      if (called) calledNames.add(called)
      const mockedTarget = mockedModuleTarget(node)
      if (mockedTarget) mockedTargets.add(mockedTarget)
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const targets = dynamicTargets.get(rel) ?? []
        targets.push(node.arguments[0].text)
        dynamicTargets.set(rel, targets)
        fileDynamicTargets.add(node.arguments[0].text)
      }
    })
    for (const target of mockedTargets) {
      if (!staticTargets.has(target) || !fileDynamicTargets.has(target)) continue
      mixedMockImportSites.push({ path: rel, target })
      problems.push(`MockedDynamicTargetAlsoStaticallyImported:${rel}:${target}`)
    }
    const opensWorkspace = intersects(browserWorkspaceOpenNames, calledNames)
    if (opensWorkspace) browserWorkspaceLifetimeFiles.push(rel)
    if (opensWorkspace && !intersects(browserWorkspaceShutdownNames, calledNames)) {
      unownedBrowserWorkspaceLifetimeFiles.push(rel)
      problems.push(`BrowserWorkspaceSuiteLifetimeUnowned:${rel}`)
    }
  }

  const resetCounts = countByPath(resetSites)
  for (const [path, count] of resetCounts) {
    const classification = RESET_CLASSIFICATIONS[path]
    if (!classification) {
      problems.push(`ResetModulesUnclassified:${path}:${count}`)
      continue
    }
    if (count !== classification.callCount) {
      problems.push(`ResetModulesCountChanged:${path}:${count}:${classification.callCount}`)
    }
    const actualTargets = uniqueSorted(dynamicTargets.get(path) ?? [])
    const expectedTargets = uniqueSorted(classification.dynamicTargets)
    if (actualTargets.join('\0') !== expectedTargets.join('\0')) {
      problems.push(
        `ResetModulesTargetsChanged:${path}:${actualTargets.join(',')}:${expectedTargets.join(',')}`,
      )
    }
  }
  for (const path of Object.keys(RESET_CLASSIFICATIONS)) {
    if (!resetCounts.has(path)) problems.push(`ResetModulesClassificationStale:${path}`)
  }
  const actualKernelInstantiations = uniqueSorted(productionKernelInstantiations)
  if (actualKernelInstantiations.join('\0') !== PRODUCTION_KERNEL_INSTANTIATIONS.join('\0')) {
    problems.push(
      `ProductionRuntimeKernelInstantiationChanged:${actualKernelInstantiations.join(',')}`,
    )
  }
  return Object.freeze({
    ok: problems.length === 0,
    resetSiteCount: resetSites.length,
    classifiedResetFileCount: resetCounts.size,
    mixedMockImportSiteCount: mixedMockImportSites.length,
    productionKernelInstantiationCount: actualKernelInstantiations.length,
    browserWorkspaceLifetimeFileCount: browserWorkspaceLifetimeFiles.length,
    unownedBrowserWorkspaceLifetimeFileCount: unownedBrowserWorkspaceLifetimeFiles.length,
    resetSites: Object.freeze(resetSites),
    mixedMockImportSites: Object.freeze(mixedMockImportSites),
    productionKernelInstantiations: Object.freeze(actualKernelInstantiations),
    browserWorkspaceLifetimeFiles: Object.freeze(browserWorkspaceLifetimeFiles.sort()),
    unownedBrowserWorkspaceLifetimeFiles: Object.freeze(
      unownedBrowserWorkspaceLifetimeFiles.sort(),
    ),
    problems: Object.freeze(problems.sort()),
  })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = auditTestRuntimeIsolation()
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  else {
    process.stdout.write(
      `Test runtime isolation audit: reset-sites=${result.resetSiteCount}, classified-reset-files=${result.classifiedResetFileCount}, mixed-mock-imports=${result.mixedMockImportSiteCount}, production-kernel-instantiations=${result.productionKernelInstantiationCount}, workspace-lifetimes=${result.browserWorkspaceLifetimeFileCount}, unowned-workspace-lifetimes=${result.unownedBrowserWorkspaceLifetimeFileCount}, problems=${result.problems.length}.\n`,
    )
    for (const problem of result.problems) process.stderr.write(`  ${problem}\n`)
  }
  if (!result.ok) process.exitCode = 1
}

function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.isFile() && ['.ts', '.tsx', '.mts', '.cts'].includes(extname(path))) {
      files.push(path)
    }
  }
  return files.sort()
}

function parse(path, source) {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function isResetModulesCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'vi' &&
    node.expression.name.text === 'resetModules'
  )
}

function isRuntimeImportDeclaration(node) {
  const clause = node.importClause
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  const bindings = clause.namedBindings
  if (!bindings || ts.isNamespaceImport(bindings)) return true
  return bindings.elements.some((element) => !element.isTypeOnly)
}

function collectNamedImportLocals(declaration, importedName, target) {
  const bindings = declaration.importClause?.namedBindings
  if (!bindings || !ts.isNamedImports(bindings)) return
  for (const element of bindings.elements) {
    if ((element.propertyName?.text ?? element.name.text) === importedName) {
      target.add(element.name.text)
    }
  }
}

function intersects(left, right) {
  for (const value of left) if (right.has(value)) return true
  return false
}

function containsAny(source, needles) {
  return needles.some((needle) => source.includes(needle))
}

function mockedModuleTarget(node) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== 'vi' ||
    (node.expression.name.text !== 'mock' && node.expression.name.text !== 'doMock') ||
    !ts.isStringLiteralLike(node.arguments[0])
  ) {
    return null
  }
  return node.arguments[0].text
}

function calledIdentifier(node) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : null
}

function enclosingOwner(node) {
  let current = node.parent
  while (current) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.text
    }
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    current = current.parent
  }
  return '<module>'
}

function countByPath(entries) {
  const counts = new Map()
  for (const entry of entries) counts.set(entry.path, (counts.get(entry.path) ?? 0) + 1)
  return counts
}

function lineFor(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

function repositoryRelative(root, path) {
  return relative(root, path).split(sep).join('/')
}

function uniqueSorted(values) {
  return [...new Set(values)].sort()
}

function visit(node, callback) {
  callback(node)
  ts.forEachChild(node, (child) => visit(child, callback))
}
