import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, posix, relative, resolve } from 'node:path'
import ts from 'typescript'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')

export const LOCAL_MODULE_CODE_EXTENSIONS = Object.freeze([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.js',
  '.jsx',
])

export const LOCAL_MODULE_ASSET_EXTENSIONS = Object.freeze([
  '.json',
  '.css',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.woff',
  '.woff2',
  '.wasm',
])

const DEFAULT_LOCAL_MODULE_EXTENSIONS = Object.freeze([
  ...LOCAL_MODULE_CODE_EXTENSIONS,
  ...LOCAL_MODULE_ASSET_EXTENSIONS,
])

const RESOLUTION_SUFFIXES = Object.freeze([
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.js',
  '.jsx',
  '.json',
  '.d.ts',
  '.d.mts',
  '.d.cts',
])

export function createFilesystemLocalModuleSource(options = {}) {
  const root = options.root ?? DEFAULT_ROOT
  const allPaths = new Set()
  for (const directory of options.directories ?? ['src', 'scripts', 'tests', 'tools']) {
    const absoluteDirectory = resolve(root, directory)
    if (!statSync(absoluteDirectory, { throwIfNoEntry: false })?.isDirectory()) continue
    for (const path of walkFiles(absoluteDirectory, root)) allPaths.add(path)
  }
  for (const path of [
    ...(options.files ?? ['playwright.config.ts', 'vite.config.ts']),
    ...(options.additionalPaths ?? []),
  ]) {
    if (statSync(resolve(root, path), { throwIfNoEntry: false })?.isFile()) allPaths.add(path)
  }
  return Object.freeze({
    kind: 'filesystem',
    allPaths,
    readFileBytes(path) {
      if (!allPaths.has(path)) throw new Error(`LocalModuleSourcePathMissing:${path}`)
      return readFileSync(resolve(root, path))
    },
    isExecutable(path) {
      if (!allPaths.has(path)) throw new Error(`LocalModuleSourcePathMissing:${path}`)
      return (statSync(resolve(root, path)).mode & 0o111) !== 0
    },
  })
}

export function discoverLocalModulePaths(options = {}) {
  const source = options.source ?? createFilesystemLocalModuleSource(options)
  const extensions = new Set(options.extensions ?? DEFAULT_LOCAL_MODULE_EXTENSIONS)
  const paths = new Set()
  const directories = options.directories ?? ['src', 'scripts', 'tests', 'tools']
  const files = new Set(options.files ?? ['playwright.config.ts', 'vite.config.ts'])
  for (const path of source.allPaths) {
    if (files.has(path)) paths.add(path)
    else if (
      extensions.has(extname(path)) &&
      directories.some((directory) => path.startsWith(`${directory}/`))
    ) {
      paths.add(path)
    }
  }
  return paths
}

export function buildLocalModuleGraph(options = {}) {
  return scanLocalModuleGraphCore(options, null).graph
}

export function scanLocalModuleGraph(options) {
  return scanLocalModuleGraphCore(options, options.projectFile)
}

export function scanReachableLocalModuleGraph(options) {
  const source = options.source ?? createFilesystemLocalModuleSource(options)
  const availablePaths =
    options.availablePaths ??
    discoverLocalModulePaths({
      ...options,
      source,
    })
  const pathSet = availablePaths instanceof Set ? availablePaths : new Set(availablePaths)
  const entryPaths = uniqueSorted(options.entryPaths)
  for (const entryPath of entryPaths) {
    if (!pathSet.has(entryPath)) throw new Error(`LocalModuleGraphEntryMissing:${entryPath}`)
  }
  const parseSourceFile = options.parseSourceFile ?? parseSource
  const dependencies = new Map()
  const diagnostics = []
  const projections = new Map()
  const queue = [...entryPaths]
  const enqueued = new Set(queue)

  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index]
    const file = readLocalModuleFile(path, source, parseSourceFile)
    projections.set(path, options.projectFile(file))
    const resolvedDependencies = inspectLocalModuleDependencies({
      path,
      pathSet,
      source,
      file,
      diagnostics,
    })
    dependencies.set(path, resolvedDependencies)
    for (const dependency of resolvedDependencies) {
      if (enqueued.has(dependency)) continue
      enqueued.add(dependency)
      queue.push(dependency)
    }
  }

  return Object.freeze({
    graph: createLocalModuleGraph(queue, dependencies, diagnostics),
    projections,
  })
}

function scanLocalModuleGraphCore(options, projectFile) {
  const source =
    options.source ??
    createFilesystemLocalModuleSource({
      ...options,
      additionalPaths: options.supplementalPaths,
    })
  const paths = options.paths ?? discoverLocalModulePaths({ ...options, source })
  const pathSet = paths instanceof Set ? paths : new Set(paths)
  const allPaths = uniqueSorted([...pathSet, ...(options.supplementalPaths ?? [])])
  const parseSourceFile = options.parseSourceFile ?? parseSource
  const dependencies = new Map()
  const diagnostics = []
  const projections = new Map()

  for (const path of allPaths) {
    if (!source.allPaths.has(path)) throw new Error(`LocalModuleSourcePathMissing:${path}`)
    const file = readLocalModuleFile(path, source, parseSourceFile)
    if (projectFile) projections.set(path, projectFile(file))
    if (!pathSet.has(path)) continue
    dependencies.set(
      path,
      inspectLocalModuleDependencies({ path, pathSet, source, file, diagnostics }),
    )
  }

  return Object.freeze({
    graph: createLocalModuleGraph(pathSet, dependencies, diagnostics),
    projections,
  })
}

function inspectLocalModuleDependencies({ path, pathSet, source, file, diagnostics }) {
  if (file.kind === 'non-code') return Object.freeze([])
  const sourceFile = file.sourceFile
  for (const diagnostic of sourceFile.parseDiagnostics ?? []) {
    diagnostics.push(
      graphDiagnostic({
        code: 'parse-error',
        path,
        line: lineForPosition(sourceFile, diagnostic.start ?? 0),
        detail: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      }),
    )
  }
  const resolvedDependencies = []
  for (const reference of discoverModuleReferences(sourceFile)) {
    if (reference.specifier === null) {
      diagnostics.push(
        graphDiagnostic({
          code: 'opaque-module-reference',
          path,
          line: reference.line,
          detail: reference.kind,
        }),
      )
      continue
    }
    if (!isLocalSpecifier(reference.specifier)) continue
    const resolution = resolveLocalModule(path, reference.specifier, source.allPaths)
    if (resolution.kind === 'outside-root') {
      diagnostics.push(
        graphDiagnostic({
          code: 'module-reference-outside-root',
          path,
          line: reference.line,
          detail: reference.specifier,
        }),
      )
    } else if (resolution.kind === 'missing') {
      diagnostics.push(
        graphDiagnostic({
          code: 'unresolved-local-module',
          path,
          line: reference.line,
          detail: reference.specifier,
        }),
      )
    } else if (!pathSet.has(resolution.path)) {
      diagnostics.push(
        graphDiagnostic({
          code: 'resolved-module-outside-graph',
          path,
          line: reference.line,
          detail: `${reference.specifier} -> ${resolution.path}`,
        }),
      )
    } else {
      resolvedDependencies.push(resolution.path)
    }
  }
  return Object.freeze(uniqueSorted(resolvedDependencies))
}

function createLocalModuleGraph(paths, dependencies, diagnostics) {
  const sortedPaths = uniqueSorted(paths)
  const reverseDependencies = new Map(sortedPaths.map((path) => [path, []]))
  for (const [importer, importedPaths] of dependencies) {
    for (const importedPath of importedPaths) reverseDependencies.get(importedPath)?.push(importer)
  }
  for (const [path, importers] of reverseDependencies) {
    reverseDependencies.set(path, Object.freeze(uniqueSorted(importers)))
  }

  return Object.freeze({
    paths: Object.freeze(sortedPaths),
    dependencies,
    reverseDependencies,
    edgeCount: [...dependencies.values()].reduce((sum, values) => sum + values.length, 0),
    diagnostics: Object.freeze(diagnostics.sort(compareDiagnostic)),
  })
}

function readLocalModuleFile(path, source, parseSourceFile) {
  const bytes = source.readFileBytes(path)
  const executable = source.isExecutable(path)
  if (!LOCAL_MODULE_CODE_EXTENSIONS.includes(extname(path))) {
    return Object.freeze({ kind: 'non-code', path, bytes, executable, sourceFile: null })
  }
  const text = bytes.toString('utf8')
  return Object.freeze({
    kind: 'code',
    path,
    bytes,
    executable,
    sourceFile: parseSourceFile(path, text),
  })
}

export function reverseReachableLocalModules(graph, roots) {
  const visited = new Set()
  const queue = [...new Set(roots)].sort(compareText)
  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index]
    if (visited.has(path)) continue
    visited.add(path)
    for (const importer of graph.reverseDependencies.get(path) ?? []) {
      if (!visited.has(importer)) queue.push(importer)
    }
  }
  return Object.freeze([...visited].sort(compareText))
}

function discoverModuleReferences(sourceFile) {
  const references = ts.preProcessFile(sourceFile.text, true, true).importedFiles.map((reference) =>
    Object.freeze({
      specifier: reference.fileName,
      kind: 'literal',
      line: lineForPosition(sourceFile, reference.pos),
    }),
  )
  const add = (node, specifier, kind) => {
    references.push(
      Object.freeze({
        specifier,
        kind,
        line: lineForPosition(sourceFile, node.getStart(sourceFile)),
      }),
    )
  }
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      add(statement, null, ts.isImportDeclaration(statement) ? 'import' : 'export')
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      const expression = statement.moduleReference.expression
      if (!expression || !ts.isStringLiteralLike(expression)) add(statement, null, 'import=')
    }
  }
  if (!/\b(?:import|require)\s*\(|\bvi\s*\.\s*(?:doMock|mock)\s*\(/u.test(sourceFile.text)) {
    return references
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (!argument || !ts.isStringLiteralLike(argument)) add(node, null, 'import()')
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      const argument = node.arguments[0]
      if (!argument || !ts.isStringLiteralLike(argument)) add(node, null, 'require()')
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'vi' &&
      (node.expression.name.text === 'mock' || node.expression.name.text === 'doMock')
    ) {
      const argument = node.arguments[0]
      add(
        node,
        argument && ts.isStringLiteralLike(argument) ? argument.text : null,
        `vi.${node.expression.name.text}()`,
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return references
}

function resolveLocalModule(importerPath, specifier, sourcePaths) {
  const relativeBase = specifier.startsWith('/')
    ? posix.normalize(specifier.slice(1))
    : posix.normalize(posix.join(posix.dirname(importerPath), specifier))
  if (relativeBase === '..' || relativeBase.startsWith('../')) return { kind: 'outside-root' }
  for (const suffix of RESOLUTION_SUFFIXES) {
    const path = `${relativeBase}${suffix}`
    if (sourcePaths.has(path)) return { kind: 'resolved', path }
  }
  for (const suffix of RESOLUTION_SUFFIXES.slice(1)) {
    const path = posix.join(relativeBase, `index${suffix}`)
    if (sourcePaths.has(path)) return { kind: 'resolved', path }
  }
  return { kind: 'missing' }
}

function parseSource(path, source) {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    false,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function walkFiles(directory, root) {
  const paths = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name)
    if (entry.isDirectory()) paths.push(...walkFiles(absolutePath, root))
    else if (entry.isFile()) paths.push(normalizePath(relative(root, absolutePath)))
  }
  return paths
}

function graphDiagnostic({ code, path, line, detail }) {
  return Object.freeze({ code, path, line, detail })
}

function lineForPosition(sourceFile, position) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1
}

function isLocalSpecifier(specifier) {
  return specifier.startsWith('.') || specifier.startsWith('/')
}

function compareDiagnostic(left, right) {
  return (
    compareText(left.path, right.path) ||
    left.line - right.line ||
    compareText(left.code, right.code) ||
    compareText(left.detail, right.detail)
  )
}

function compareText(left, right) {
  return left.localeCompare(right)
}

function normalizePath(path) {
  return path.replaceAll('\\', '/')
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareText)
}
