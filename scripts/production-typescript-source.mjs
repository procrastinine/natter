import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')
const PROGRAM_INPUTS_BY_ROOT = new Map()

export function createProductionTypeScriptProgram(root = DEFAULT_ROOT, options = {}) {
  const resolvedRoot = resolve(root)
  const inputs = productionProgramInputs(resolvedRoot)
  const overrides = new Map(
    Object.entries(options.sourceTextOverrides ?? {}).map(([path, text]) => [
      resolve(resolvedRoot, path),
      text,
    ]),
  )
  if (!inputs.baselineProgram) {
    inputs.baselineProgram = ts.createProgram({
      rootNames: inputs.parsed.fileNames,
      options: inputs.parsed.options,
      host: productionCompilerHost(inputs, new Map()),
    })
  }
  if (overrides.size === 0) return inputs.baselineProgram
  return ts.createProgram({
    rootNames: inputs.parsed.fileNames,
    options: inputs.parsed.options,
    host: productionCompilerHost(inputs, overrides),
    oldProgram: inputs.baselineProgram,
  })
}

function productionCompilerHost(inputs, overrides) {
  const host = ts.createCompilerHost(inputs.parsed.options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const resolvedFileName = resolve(fileName)
    const text = overrides.get(resolvedFileName)
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true)
    const cached = inputs.sourceFiles.get(resolvedFileName)
    if (cached) return cached
    const source = getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
    if (source) inputs.sourceFiles.set(resolvedFileName, source)
    return source
  }
  return host
}

function productionProgramInputs(root) {
  const cached = PROGRAM_INPUTS_BY_ROOT.get(root)
  if (cached) return cached
  const configPath = resolve(root, 'tsconfig.app.json')
  const config = ts.readConfigFile(configPath, (path) => readFileSync(path, 'utf8'))
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }
  const inputs = {
    baselineProgram: null,
    parsed: ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath),
    sourceFiles: new Map(),
  }
  PROGRAM_INPUTS_BY_ROOT.set(root, inputs)
  return inputs
}

export function productionTypeScriptSources(program, root = DEFAULT_ROOT) {
  const sourceRoot = resolve(root, 'src')
  return program.getSourceFiles().filter((source) => {
    const path = resolve(source.fileName)
    return (
      path.startsWith(`${sourceRoot}${sep}`) && /\.tsx?$/u.test(path) && !path.endsWith('.d.ts')
    )
  })
}

export function exactProductionTypeScriptSource(program, path, root = DEFAULT_ROOT) {
  const expected = resolve(root, path)
  const source = program.getSourceFile(expected)
  if (source) return source
  const normalized = path.split('/').join(sep)
  const match = program
    .getSourceFiles()
    .find((candidate) => relative(root, candidate.fileName) === normalized)
  if (!match) throw new Error(`ProductionTypeScriptSourceMissing:${path}`)
  return match
}

export function productionTypeScriptSourceDigest(program, root = DEFAULT_ROOT) {
  return sourceDigest(
    productionTypeScriptSources(program, root).map((source) => ({
      path: relative(root, source.fileName).split(sep).join('/'),
      text: source.text,
    })),
  )
}

export function productionTypeScriptFileDigest(root = DEFAULT_ROOT) {
  const sourceRoot = resolve(root, 'src')
  return sourceDigest(
    productionTypeScriptFilePaths(sourceRoot).map((path) => ({
      path: relative(root, path).split(sep).join('/'),
      text: readFileSync(path, 'utf8'),
    })),
  )
}

function productionTypeScriptFilePaths(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return productionTypeScriptFilePaths(path)
      return entry.isFile() && /\.tsx?$/u.test(path) && !path.endsWith('.d.ts') ? [path] : []
    })
    .sort()
}

function sourceDigest(sources) {
  const hash = createHash('sha256')
  for (const source of sources.toSorted((left, right) => left.path.localeCompare(right.path))) {
    hash.update(source.path)
    hash.update('\0')
    hash.update(source.text)
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}
