import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildLocalModuleGraph,
  createFilesystemLocalModuleSource,
  discoverLocalModulePaths,
  reverseReachableLocalModules,
  scanLocalModuleGraph,
  scanReachableLocalModuleGraph,
} from '../../scripts/local-module-graph.mjs'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('local module graph', () => {
  it('resolves literal import forms and assets into one forward and reverse graph', () => {
    const root = fixtureRoot({
      'src/a.ts': "import './theme.css'\nexport const a = 1\n",
      'src/b.ts': "export { a } from './a'\n",
      'src/c.ts': "export async function c() { return import('./b') }\n",
      'src/import-equals.ts': "import a = require('./a')\nexport { a }\n",
      'src/require.ts': "export const a = require('./a')\n",
      'src/theme.css': ':root {}',
      'tests/unit/c.test.ts':
        "import '../../src/c'\nvi.mock('../../src/a')\nvi.doMock('../../src/b')\n",
    })
    const paths = discoverLocalModulePaths({ root, directories: ['src', 'tests'], files: [] })
    const graph = buildLocalModuleGraph({ root, paths })

    expect(graph.diagnostics).toEqual([])
    expect(graph.dependencies.get('src/a.ts')).toEqual(['src/theme.css'])
    expect(graph.dependencies.get('src/b.ts')).toEqual(['src/a.ts'])
    expect(graph.dependencies.get('src/c.ts')).toEqual(['src/b.ts'])
    expect(graph.dependencies.get('src/import-equals.ts')).toEqual(['src/a.ts'])
    expect(graph.dependencies.get('src/require.ts')).toEqual(['src/a.ts'])
    expect(reverseReachableLocalModules(graph, ['src/a.ts'])).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/import-equals.ts',
      'src/require.ts',
      'tests/unit/c.test.ts',
    ])
    expect(graph.dependencies.get('tests/unit/c.test.ts')).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ])
  })

  it('reports opaque and unresolved local edges instead of silently dropping them', () => {
    const root = fixtureRoot({
      'src/a.ts':
        "const path = './b'\nvoid import(path)\nvoid require(path)\nvoid import('./missing')\nvi.mock(path)\nvi.doMock('./missing-mock')\n",
    })
    const graph = buildLocalModuleGraph({
      root,
      paths: discoverLocalModulePaths({ root, directories: ['src'], files: [] }),
    })

    expect(graph.diagnostics).toEqual([
      { code: 'opaque-module-reference', path: 'src/a.ts', line: 2, detail: 'import()' },
      { code: 'opaque-module-reference', path: 'src/a.ts', line: 3, detail: 'require()' },
      { code: 'unresolved-local-module', path: 'src/a.ts', line: 4, detail: './missing' },
      { code: 'opaque-module-reference', path: 'src/a.ts', line: 5, detail: 'vi.mock()' },
      {
        code: 'unresolved-local-module',
        path: 'src/a.ts',
        line: 6,
        detail: './missing-mock',
      },
    ])
  })

  it('never resolves an injected source against a conflicting physical worktree', () => {
    const root = fixtureRoot({
      'src/current.ts': "import './worktree-only'\n",
      'src/worktree-only.ts': 'export const leaked = true\n',
    })
    const files = new Map([['src/current.ts', Buffer.from("import './worktree-only'\n")]])
    const source = {
      kind: 'git-tree' as const,
      allPaths: new Set(files.keys()),
      readFileBytes(path: string) {
        const bytes = files.get(path)
        if (!bytes) throw new Error(`VirtualSourcePathMissing:${path}`)
        return bytes
      },
      isExecutable: () => false,
    }
    const graph = buildLocalModuleGraph({ source })

    expect(graph.paths).toEqual(['src/current.ts'])
    expect(graph.diagnostics).toEqual([
      {
        code: 'unresolved-local-module',
        path: 'src/current.ts',
        line: 1,
        detail: './worktree-only',
      },
    ])
    expect(root).toContain('natter-local-module-graph-')
  })

  it('reads and parses every unique graph or supplemental file at most once', () => {
    const root = fixtureRoot({
      'src/a.ts': "import './b'\nimport './theme.css'\nexport const a = 1\n",
      'src/b.ts': 'export const b = 2\n',
      'src/data.json': '{"value":1}',
      'src/theme.css': ':root {}',
      'package.json': '{"name":"fixture"}',
    })
    const paths = discoverLocalModulePaths({ root, directories: ['src'], files: [] })
    const reads = new Map<string, number>()
    const parses = new Map<string, number>()
    const visits: string[] = []
    const filesystemSource = createFilesystemLocalModuleSource({
      root,
      directories: ['src'],
      files: [],
      additionalPaths: ['package.json'],
    })
    const scan = scanLocalModuleGraph({
      paths,
      supplementalPaths: ['package.json', 'src/a.ts'],
      source: {
        kind: 'filesystem',
        allPaths: filesystemSource.allPaths,
        readFileBytes(path) {
          reads.set(path, (reads.get(path) ?? 0) + 1)
          return filesystemSource.readFileBytes(path)
        },
        isExecutable: (path) => filesystemSource.isExecutable(path),
      },
      parseSourceFile(path, source) {
        parses.set(path, (parses.get(path) ?? 0) + 1)
        return ts.createSourceFile(
          path,
          source,
          ts.ScriptTarget.Latest,
          false,
          path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        )
      },
      projectFile(file) {
        visits.push(file.path)
        return {
          kind: file.kind,
          parent: file.kind === 'code' ? file.sourceFile.statements[0]?.parent : undefined,
        }
      },
    })

    expect(Object.fromEntries(reads)).toEqual({
      'package.json': 1,
      'src/a.ts': 1,
      'src/b.ts': 1,
      'src/data.json': 1,
      'src/theme.css': 1,
    })
    expect(Object.fromEntries(parses)).toEqual({ 'src/a.ts': 1, 'src/b.ts': 1 })
    expect(visits).toEqual([
      'package.json',
      'src/a.ts',
      'src/b.ts',
      'src/data.json',
      'src/theme.css',
    ])
    expect(scan.graph.paths).not.toContain('package.json')
    expect(scan.graph.dependencies.has('package.json')).toBe(false)
    expect(scan.graph.dependencies.get('src/a.ts')).toEqual(['src/b.ts', 'src/theme.css'])
    expect(scan.projections.get('src/a.ts')).toEqual({ kind: 'code', parent: undefined })
    expect(scan.projections.get('src/theme.css')).toEqual({
      kind: 'non-code',
      parent: undefined,
    })
  })

  it('scans a deterministic forward closure without reading unrelated modules', () => {
    const root = fixtureRoot({
      'scripts/entry.mjs': "import './middle.mjs'\nimport './data.json' with { type: 'json' }\n",
      'scripts/middle.mjs': "export { leaf } from './leaf.mjs'\n",
      'scripts/leaf.mjs': "import './middle.mjs'\nexport const leaf = 1\n",
      'scripts/data.json': '{"value":1}',
      'scripts/unrelated.mjs': 'export const = 1\n',
    })
    const availablePaths = discoverLocalModulePaths({
      root,
      directories: ['scripts'],
      files: [],
    })
    const reads = new Map<string, number>()
    const parses = new Map<string, number>()
    const filesystemSource = createFilesystemLocalModuleSource({
      root,
      directories: ['scripts'],
      files: [],
    })
    const scan = scanReachableLocalModuleGraph({
      entryPaths: ['scripts/entry.mjs'],
      availablePaths,
      source: {
        kind: 'filesystem',
        allPaths: filesystemSource.allPaths,
        readFileBytes(path) {
          reads.set(path, (reads.get(path) ?? 0) + 1)
          return filesystemSource.readFileBytes(path)
        },
        isExecutable: (path) => filesystemSource.isExecutable(path),
      },
      parseSourceFile(path, source) {
        parses.set(path, (parses.get(path) ?? 0) + 1)
        return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
      },
      projectFile: (file) => file.bytes.length,
    })

    expect(scan.graph.paths).toEqual([
      'scripts/data.json',
      'scripts/entry.mjs',
      'scripts/leaf.mjs',
      'scripts/middle.mjs',
    ])
    expect(scan.graph.diagnostics).toEqual([])
    expect(scan.graph.dependencies.get('scripts/entry.mjs')).toEqual([
      'scripts/data.json',
      'scripts/middle.mjs',
    ])
    expect(scan.graph.dependencies.get('scripts/leaf.mjs')).toEqual(['scripts/middle.mjs'])
    expect(scan.graph.dependencies.get('scripts/middle.mjs')).toEqual(['scripts/leaf.mjs'])
    expect(Object.fromEntries(reads)).toEqual({
      'scripts/data.json': 1,
      'scripts/entry.mjs': 1,
      'scripts/leaf.mjs': 1,
      'scripts/middle.mjs': 1,
    })
    expect(Object.fromEntries(parses)).toEqual({
      'scripts/entry.mjs': 1,
      'scripts/leaf.mjs': 1,
      'scripts/middle.mjs': 1,
    })
    expect(scan.projections.has('scripts/unrelated.mjs')).toBe(false)

    const reversed = scanReachableLocalModuleGraph({
      source: filesystemSource,
      entryPaths: ['scripts/entry.mjs'],
      availablePaths: [...availablePaths].reverse(),
      projectFile: (file) => file.bytes.length,
    })
    expect(reversed.graph.paths).toEqual(scan.graph.paths)
    expect([...reversed.graph.dependencies]).toEqual([...scan.graph.dependencies])
    expect([...reversed.projections]).toEqual([...scan.projections])
    expect(() =>
      scanReachableLocalModuleGraph({
        source: filesystemSource,
        entryPaths: ['scripts/missing.mjs'],
        availablePaths,
        projectFile: (file) => file.bytes.length,
      }),
    ).toThrow('LocalModuleGraphEntryMissing:scripts/missing.mjs')
  })

  it('preserves parser diagnostics from the projected syntax tree', () => {
    const root = fixtureRoot({ 'src/invalid.ts': 'export const = 1\n' })
    const graph = buildLocalModuleGraph({
      root,
      paths: discoverLocalModulePaths({ root, directories: ['src'], files: [] }),
    })

    expect(graph.diagnostics).toEqual([
      {
        code: 'parse-error',
        path: 'src/invalid.ts',
        line: 1,
        detail: 'Variable declaration expected.',
      },
      {
        code: 'parse-error',
        path: 'src/invalid.ts',
        line: 1,
        detail: 'Variable declaration expected.',
      },
    ])
  })

  it('terminates reverse traversal across a cycle', () => {
    const root = fixtureRoot({
      'src/a.ts': "import './b'\n",
      'src/b.ts': "import './a'\n",
    })
    const graph = buildLocalModuleGraph({
      root,
      paths: discoverLocalModulePaths({ root, directories: ['src'], files: [] }),
    })

    expect(reverseReachableLocalModules(graph, ['src/a.ts'])).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), 'natter-local-module-graph-'))
  temporaryRoots.push(root)
  for (const [path, source] of Object.entries(files)) {
    const absolutePath = resolve(root, path)
    mkdirSync(resolve(absolutePath, '..'), { recursive: true })
    writeFileSync(absolutePath, source)
  }
  return root
}
