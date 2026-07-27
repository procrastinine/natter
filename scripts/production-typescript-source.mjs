import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')

export function createProductionTypeScriptProgram(root = DEFAULT_ROOT, options = {}) {
  const configPath = resolve(root, 'tsconfig.app.json')
  const config = ts.readConfigFile(configPath, (path) => readFileSync(path, 'utf8'))
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath)
  const overrides = new Map(
    Object.entries(options.sourceTextOverrides ?? {}).map(([path, text]) => [
      resolve(root, path),
      text,
    ]),
  )
  if (overrides.size === 0) {
    return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
  }
  const host = ts.createCompilerHost(parsed.options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = overrides.get(resolve(fileName))
    return text === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, text, languageVersion, true)
  }
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host })
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
