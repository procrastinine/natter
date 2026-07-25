import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { discoverLocalModulePaths, scanReachableLocalModuleGraph } from './local-module-graph.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const GENERATOR_ENTRIES = [
  'scripts/production-protocol-fact-bundle.mjs',
  'scripts/audit-protocol-contracts.mjs',
]

export function protocolContractGeneratorDigest(root = ROOT) {
  const hash = createHash('sha256')
  const scan = scanReachableLocalModuleGraph({
    root,
    entryPaths: GENERATOR_ENTRIES,
    availablePaths: discoverLocalModulePaths({ root, directories: ['scripts'], files: [] }),
    projectFile: (file) => sha256(file.bytes),
  })
  if (scan.graph.diagnostics.length > 0) {
    throw new Error(
      `ProtocolContractGeneratorGraphInvalid:${scan.graph.diagnostics
        .map(
          (diagnostic) =>
            `${diagnostic.path}:${diagnostic.line}:${diagnostic.code}:${diagnostic.detail}`,
        )
        .join('|')}`,
    )
  }
  for (const path of scan.graph.paths) {
    hash.update(path)
    hash.update('\0')
    hash.update(scan.projections.get(path))
    hash.update('\0')
  }
  const rootInputs = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (/^tsconfig.*\.json$/u.test(entry.name) ||
          ['.node-version', 'package.json', 'pnpm-lock.yaml'].includes(entry.name)),
    )
    .map((entry) => resolve(root, entry.name))
  for (const absolute of rootInputs.sort()) {
    hash.update(relative(root, absolute).split(sep).join('/'))
    hash.update('\0')
    hash.update(readFileSync(absolute))
    hash.update('\0')
  }
  const typescriptPackage = JSON.parse(
    readFileSync(resolve(root, 'node_modules/typescript/package.json'), 'utf8'),
  )
  hash.update(`typescript:${String(typescriptPackage.version)}`)
  hash.update('\0')
  hash.update(`node:${process.versions.node}`)
  return `sha256:${hash.digest('hex')}`
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
