import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import {
  createFilesystemLocalModuleSource,
  reverseReachableLocalModules,
  scanReachableLocalModuleGraph,
} from './local-module-graph.mjs'

export const VITEST_SETUP_FILES = Object.freeze({
  node: 'tests/setup-node.ts',
  app: 'tests/setup.ts',
})

const TEST_FILE = /^tests\/(?:unit|integration|live)\/.*\.(?:test|spec)\.(?:ts|tsx)$/u
export function isVitestSuitePath(path) {
  return TEST_FILE.test(path) && path !== 'tests/unit/plan-audit.test.ts'
}

export function vitestSuiteFiles(options = {}) {
  const source =
    options.source ?? createFilesystemLocalModuleSource({ ...options, directories: ['tests'] })
  return [...source.allPaths].filter(isVitestSuitePath).sort()
}

export function vitestProjects(options = {}) {
  const source = options.source ?? createFilesystemLocalModuleSource(options)
  const node = nodeUnitTests({ ...options, source })
  const nodeSet = new Set(node)
  return [
    { project: 'node', files: node, setupFiles: [VITEST_SETUP_FILES.node] },
    {
      project: 'app',
      files: vitestSuiteFiles({ source }).filter((path) => !nodeSet.has(path)),
      setupFiles: [VITEST_SETUP_FILES.app],
    },
  ]
}

export function vitestProjectConfigurations(projects, createConfig) {
  return projects.map(({ project, files, setupFiles }) =>
    createConfig({
      test: {
        name: project,
        environment: project === 'node' ? 'node' : 'jsdom',
        ...(project === 'app'
          ? { environmentOptions: { jsdom: { url: 'http://localhost/' } } }
          : {}),
        setupFiles: [...setupFiles],
        include: [...files],
      },
    }),
  )
}

const NODE_CANDIDATE_PATH = /^(?:src\/|scripts\/|tests\/(?:unit|helpers)\/)/u
const NODE_PACKAGES = new Set(['vitest', 'vitest/node', 'typescript', 'css-tree'])
const NODE_WEB_GLOBALS = new Set([
  'AbortController',
  'AbortSignal',
  'Blob',
  'BroadcastChannel',
  'ByteLengthQueuingStrategy',
  'CompressionStream',
  'CountQueuingStrategy',
  'Crypto',
  'CryptoKey',
  'CustomEvent',
  'DOMException',
  'DecompressionStream',
  'Event',
  'EventTarget',
  'File',
  'FormData',
  'Headers',
  'MessageChannel',
  'MessageEvent',
  'MessagePort',
  'Performance',
  'PerformanceEntry',
  'PerformanceMark',
  'PerformanceMeasure',
  'ReadableStream',
  'ReadableStreamBYOBReader',
  'ReadableStreamBYOBRequest',
  'ReadableStreamDefaultController',
  'ReadableStreamDefaultReader',
  'Request',
  'Response',
  'SubtleCrypto',
  'TextDecoder',
  'TextDecoderStream',
  'TextEncoder',
  'TextEncoderStream',
  'TransformStream',
  'TransformStreamDefaultController',
  'URL',
  'URLSearchParams',
  'WritableStream',
  'WritableStreamDefaultController',
  'WritableStreamDefaultWriter',
  'atob',
  'btoa',
  'clearInterval',
  'clearTimeout',
  'console',
  'crypto',
  'fetch',
  'performance',
  'queueMicrotask',
  'setInterval',
  'setTimeout',
  'structuredClone',
])
let browserGlobals

function browserOnlyGlobals() {
  if (browserGlobals) return browserGlobals
  const path = resolve(dirname(ts.getDefaultLibFilePath({})), 'lib.dom.d.ts')
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest)
  browserGlobals = new Set()
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      if (!NODE_WEB_GLOBALS.has(statement.name.text)) browserGlobals.add(statement.name.text)
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && !NODE_WEB_GLOBALS.has(declaration.name.text)) {
        browserGlobals.add(declaration.name.text)
      }
    }
  }
  return browserGlobals
}

export function nodeUnitTests(options = {}) {
  const source = options.source ?? createFilesystemLocalModuleSource(options)
  const paths = [...source.allPaths].filter((path) => NODE_CANDIDATE_PATH.test(path))
  const entryPaths = paths.filter(isVitestSuitePath)
  const { graph, projections } = options.moduleScan
    ? projectObservedModules(options.moduleScan, entryPaths)
    : scanReachableLocalModuleGraph({
        source,
        availablePaths: paths,
        entryPaths,
        parseSourceFile: parseVitestProjectSource,
        projectFile: moduleNeedsBrowser,
      })
  const unsafe = new Set(
    reverseReachableLocalModules(graph, [
      ...graph.diagnostics.map(({ path }) => path),
      ...[...projections].filter(([, blocked]) => blocked).map(([path]) => path),
    ]),
  )
  return entryPaths.filter((path) => !unsafe.has(path))
}

export function parseVitestProjectSource(path, text) {
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function projectObservedModules(scan, entryPaths) {
  const queue = [...entryPaths]
  const visited = new Set(queue)
  const projections = new Map()
  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index]
    if (!NODE_CANDIDATE_PATH.test(path)) {
      projections.set(path, true)
      continue
    }
    const file = scan.files.get(path)
    if (!file) throw new Error(`VitestObservedModuleMissing:${path}`)
    projections.set(path, moduleNeedsBrowser(file))
    for (const dependency of scan.graph.dependencies.get(path) ?? []) {
      if (visited.has(dependency)) continue
      visited.add(dependency)
      queue.push(dependency)
    }
  }
  return { graph: scan.graph, projections }
}

function moduleNeedsBrowser(file) {
  if (file.kind !== 'code') return false
  const external = ts
    .preProcessFile(file.sourceFile.text, true, true)
    .importedFiles.some(
      ({ fileName }) =>
        !fileName.startsWith('.') &&
        !fileName.startsWith('/') &&
        !isBuiltin(fileName) &&
        !NODE_PACKAGES.has(fileName),
    )
  return external || (!file.path.startsWith('scripts/') && hasBrowserGlobal(file.sourceFile))
}

function hasBrowserGlobal(source) {
  let checker
  const unbound = (identifier) => {
    if (!checker) {
      const options = { allowJs: true, noLib: true, noResolve: true, types: [] }
      const host = ts.createCompilerHost(options)
      host.getSourceFile = (path) => (path === source.fileName ? source : undefined)
      host.fileExists = () => false
      host.readFile = () => undefined
      checker = ts.createProgram({ rootNames: [source.fileName], options, host }).getTypeChecker()
    }
    const symbol = checker.getSymbolAtLocation(identifier)
    return !symbol?.declarations?.some((declaration) => declaration.getSourceFile() === source)
  }
  const visit = (node, parent) => {
    if (ts.isTypeNode(node)) return false
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      unbound(node.expression)
    ) {
      return (
        !ts.isStringLiteralLike(node.argumentExpression) ||
        browserOnlyGlobals().has(node.argumentExpression.text)
      )
    }
    if (ts.isIdentifier(node)) {
      if (node.text === 'globalThis') {
        if (
          !parent ||
          !(
            (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
            parent.expression === node
          )
        ) {
          return unbound(node)
        }
      }
      if (browserOnlyGlobals().has(node.text)) {
        if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
          return (
            ts.isIdentifier(parent.expression) &&
            parent.expression.text === 'globalThis' &&
            unbound(parent.expression)
          )
        }
        if (
          parent &&
          ((ts.isPropertyAssignment(parent) && parent.name === node) ||
            (ts.isMethodDeclaration(parent) && parent.name === node))
        ) {
          return false
        }
        return unbound(node)
      }
    }
    return ts.forEachChild(node, (child) => visit(child, node)) ?? false
  }
  return visit(source)
}
