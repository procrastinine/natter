import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import {
  createVerificationRuntimeInvocation,
  executeFileBackedVerificationProcess,
} from './verification-process-execution.mjs'

const root = process.cwd()
const reports = [
  await runKnipReport('knip-production-exports', [
    '--config',
    'knip.production.json',
    '--production',
  ]),
  await runKnipReport('knip-workspace-exports', []),
]

function readExecutionArtifact(path) {
  return path === null ? '' : readFileSync(resolve(root, path), 'utf8')
}
const declarations = [
  ...new Map(
    reports
      .flatMap((report) =>
        report.issues.flatMap((issue) => [
          ...(issue.exports ?? []).map((entry) => ({
            ...entry,
            file: issue.file,
            kind: 'value',
          })),
          ...(issue.types ?? []).map((entry) => ({
            ...entry,
            file: issue.file,
            kind: 'type',
          })),
        ]),
      )
      .map((declaration) => [
        `${declaration.kind}\u0000${declaration.file}\u0000${declaration.name}`,
        declaration,
      ]),
  ).values(),
]
const files = sourceFiles(['src', 'tests', 'scripts', 'tools'])
const fileSet = new Set(files)
const config = ts.readConfigFile(join(root, 'tsconfig.app.json'), ts.sys.readFile)
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
const program = ts.createProgram({
  rootNames: files,
  options: {
    ...parsedConfig.options,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    types: ['node', '@testing-library/jest-dom', 'vite/client'],
  },
})
const checker = program.getTypeChecker()
const sources = program.getSourceFiles().filter((source) => fileSet.has(resolve(source.fileName)))
const groups = {
  'production-reference': [],
  'test-or-tool-contract': [],
  'module-internal-export': [],
  'declaration-only': [],
}
const unresolvedDeclarations = []
const recordsBySymbol = new Map()
const recordsByName = new Map()

for (const declaration of declarations) {
  const declaringSource = program.getSourceFile(resolve(root, declaration.file))
  const moduleSymbol = declaringSource && checker.getSymbolAtLocation(declaringSource)
  const exportedSymbol =
    moduleSymbol &&
    checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === declaration.name)
  if (!exportedSymbol) {
    unresolvedDeclarations.push(declaration)
    continue
  }
  const targetSymbol = canonicalSymbol(exportedSymbol)
  const record = {
    ...declaration,
    ownOccurrences: 0,
    productionReferences: new Set(),
    testOrToolReferences: new Set(),
  }
  const records = recordsBySymbol.get(targetSymbol) ?? []
  records.push(record)
  recordsBySymbol.set(targetSymbol, records)
  const namedRecords = recordsByName.get(record.name) ?? []
  namedRecords.push(record)
  recordsByName.set(record.name, namedRecords)
}

for (const source of sources) {
  const sourcePath = relative(root, source.fileName)
  visit(source)

  function visit(node) {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node)
      const records = symbol && recordsBySymbol.get(canonicalSymbol(symbol))
      if (records) {
        for (const record of records) {
          if (sourcePath === record.file) record.ownOccurrences += 1
          else if (sourcePath.startsWith('src/')) record.productionReferences.add(sourcePath)
          else record.testOrToolReferences.add(sourcePath)
        }
      } else if (!sourcePath.startsWith('src/')) {
        const namedRecords = recordsByName.get(node.text)
        if (namedRecords?.length === 1) namedRecords[0].testOrToolReferences.add(sourcePath)
      }
    }
    if (!sourcePath.startsWith('src/') && ts.isStringLiteralLike(node)) {
      for (const record of toolContractRecords(node.text)) {
        record.testOrToolReferences.add(sourcePath)
      }
    }
    ts.forEachChild(node, visit)
  }
}

for (const records of recordsBySymbol.values()) {
  for (const record of records) {
    const classified = {
      ...record,
      productionReferences: [...record.productionReferences],
      testOrToolReferences: [...record.testOrToolReferences],
    }
    if (record.productionReferences.size > 0) groups['production-reference'].push(classified)
    else if (record.testOrToolReferences.size > 0) groups['test-or-tool-contract'].push(classified)
    else if (record.ownOccurrences > 1) groups['module-internal-export'].push(classified)
    else groups['declaration-only'].push(classified)
  }
}

console.log(`Workspace export classification: ${declarations.length} symbols`)
for (const [name, entries] of Object.entries(groups)) {
  console.log(`- ${name}: ${entries.length}`)
  if (name === 'module-internal-export' || name === 'declaration-only') {
    for (const entry of entries)
      console.log(`  ${entry.kind} ${entry.file}:${entry.line} ${entry.name}`)
  }
}
if (unresolvedDeclarations.length > 0) {
  console.error(`Unresolved exported declarations: ${unresolvedDeclarations.length}`)
  for (const entry of unresolvedDeclarations) {
    console.error(`  ${entry.kind} ${entry.file}:${entry.line} ${entry.name}`)
  }
}
if (groups['declaration-only'].length > 0 || unresolvedDeclarations.length > 0) {
  process.exitCode = 1
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
      else if (['.ts', '.tsx', '.mts', '.mjs'].includes(extname(child))) files.push(resolve(child))
    }
  }
  return files
}

function canonicalSymbol(symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
}

function toolContractRecords(text) {
  const exact = recordsByName.get(text)
  if (exact?.length === 1) return exact
  const site = /^(src\/[^|#]+\.(?:ts|tsx))[|#]([^|#]+)/.exec(text)
  if (!site) return []
  return (recordsByName.get(site[2]) ?? []).filter((record) => record.file === site[1])
}

async function runKnipReport(id, options) {
  const invocation = createVerificationRuntimeInvocation([
    'pnpm',
    'exec',
    'knip',
    ...options,
    '--include',
    'exports,types',
    '--reporter',
    'json',
    '--no-progress',
  ])
  const execution = await executeFileBackedVerificationProcess({
    id,
    command: invocation.command,
    args: invocation.args,
    cwd: root,
    environment: process.env,
    runDirectory: join(root, 'test-results', 'production-export-classification'),
    artifactRoot: root,
    forwardOutput: false,
    diagnosticPrefix: 'ProductionExportClassification',
  })
  const stdout = readExecutionArtifact(execution.stdoutPath)
  if (execution.exitCode === null || !stdout) {
    process.stderr.write(readExecutionArtifact(execution.stderrPath))
    for (const diagnostic of execution.diagnostics) process.stderr.write(`${diagnostic}\n`)
    process.exit(execution.exitCode ?? 1)
  }
  return JSON.parse(stdout)
}
