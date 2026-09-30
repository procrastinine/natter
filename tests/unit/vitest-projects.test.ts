import { describe, expect, it } from 'vitest'
import {
  type LocalModuleFileSource,
  type ScannedLocalModuleFile,
  scanLocalModuleGraph,
} from '../../scripts/local-module-graph.mjs'
import {
  nodeUnitTests,
  parseVitestProjectSource,
  vitestProjectConfigurations,
  vitestProjects,
} from '../../scripts/vitest-projects.mjs'
import {
  selectVitestProofFiles,
  type VitestProof,
  vitestProofProblems,
} from '../../scripts/vitest-proof-reporter.mjs'

function source(files: Readonly<Record<string, string>>): LocalModuleFileSource {
  return {
    kind: 'filesystem',
    allPaths: new Set(Object.keys(files)),
    readFileBytes: (path) => {
      const text = files[path]
      if (text === undefined) throw new Error(`TestModuleSourceMissing:${path}`)
      return Buffer.from(text)
    },
    isExecutable: () => false,
  }
}

describe('Node unit test ownership', () => {
  it('keeps the browser-independent CSS parser in the Node proof project', () => {
    const projects = vitestProjects({
      source: source({
        'scripts/css.mjs': "import { parse } from 'css-tree'; export const css = parse(':root {}')",
        'tests/unit/css.test.ts': "import '../../scripts/css.mjs'",
      }),
    })
    expect(projects).toEqual([
      { project: 'node', files: ['tests/unit/css.test.ts'], setupFiles: ['tests/setup-node.ts'] },
      { project: 'app', files: [], setupFiles: ['tests/setup.ts'] },
    ])
  })

  it('partitions the same source-owned population used by configuration and receipts', () => {
    const projects = vitestProjects({
      source: source({
        'scripts/audit.mjs': 'export const audit = 1',
        'tests/unit/tool.test.ts': "import '../../scripts/audit.mjs'",
        'tests/unit/ui.test.tsx': 'export const element = document.body',
        'tests/integration/contract.spec.ts': 'export const contract = 1',
        'tests/live/provider.live.test.ts': 'export const LIVE = false',
        'tests/unit/plan-audit.test.ts': "import '../../scripts/audit.mjs'",
        'tests/e2e/send.spec.ts': 'export const page = 1',
        'tests/helpers/assert.ts': 'export const check = 1',
      }),
    })
    expect(projects).toEqual([
      { project: 'node', files: ['tests/unit/tool.test.ts'], setupFiles: ['tests/setup-node.ts'] },
      {
        project: 'app',
        setupFiles: ['tests/setup.ts'],
        files: [
          'tests/integration/contract.spec.ts',
          'tests/live/provider.live.test.ts',
          'tests/unit/ui.test.tsx',
        ],
      },
    ])
    expect(selectVitestProofFiles(projects, JSON.stringify(['tests/unit/ui.test.tsx']))).toEqual([
      { project: 'app', file: 'tests/unit/ui.test.tsx' },
    ])
    expect(() =>
      selectVitestProofFiles(projects, JSON.stringify(['tests/unit/absent.test.ts'])),
    ).toThrow('VitestProofSelectionUnknown')
  })

  it('derives isolated inline projects and receipt membership without reloading the root config', () => {
    const projects = vitestProjects({
      source: source({
        'tests/unit/pure.test.ts': "import { it } from 'vitest'",
        'tests/unit/browser.test.ts': 'window.close()',
      }),
    })
    let configured = 0
    const configurations = vitestProjectConfigurations(projects, (project) => {
      configured += 1
      return {
        ...project,
        base: './',
        plugins: [{ name: 'fresh-base-plugin' }],
        server: { proxy: { '/_or_scrape': { target: 'https://openrouter.ai' } } },
        build: { target: 'es2022', sourcemap: false },
        test: {
          globals: false,
          css: false,
          pool: 'forks',
          execArgv: ['--no-experimental-webstorage'],
          maxWorkers: 2,
          allowOnly: false,
          ...project.test,
        },
      }
    })
    expect(configured).toBe(2)
    expect(
      configurations.map((config) => ({
        name: config.test?.name,
        environment: config.test?.environment,
        environmentOptions: config.test?.environmentOptions,
        setupFiles: config.test?.setupFiles,
        include: config.test?.include,
      })),
    ).toEqual([
      {
        name: 'node',
        environment: 'node',
        environmentOptions: undefined,
        setupFiles: ['tests/setup-node.ts'],
        include: ['tests/unit/pure.test.ts'],
      },
      {
        name: 'app',
        environment: 'jsdom',
        environmentOptions: { jsdom: { url: 'http://localhost/' } },
        setupFiles: ['tests/setup.ts'],
        include: ['tests/unit/browser.test.ts'],
      },
    ])
    for (const config of configurations) {
      expect(config).not.toHaveProperty('extends')
      expect(config).toMatchObject({
        base: './',
        plugins: [{ name: 'fresh-base-plugin' }],
        server: { proxy: { '/_or_scrape': { target: 'https://openrouter.ai' } } },
        build: { target: 'es2022', sourcemap: false },
        test: {
          globals: false,
          css: false,
          pool: 'forks',
          execArgv: ['--no-experimental-webstorage'],
          maxWorkers: 2,
          allowOnly: false,
        },
      })
    }
    expect(configurations[0]?.plugins?.[0]).not.toBe(configurations[1]?.plugins?.[0])
    expect(
      configurations.flatMap((config) =>
        (config.test?.include ?? []).map((file) => ({ project: config.test?.name, file })),
      ),
    ).toEqual(selectVitestProofFiles(projects))
    expect(
      selectVitestProofFiles(projects, JSON.stringify(['tests/unit/browser.test.ts'])),
    ).toEqual([{ project: 'app', file: 'tests/unit/browser.test.ts' }])
  })

  it('does not inspect ambient globals after an external package already requires the app project', () => {
    const original = source({
      'tests/unit/external.test.ts': "import 'dexie'; window.close()",
    })
    const files = new Map<string, ScannedLocalModuleFile>()
    const scan = scanLocalModuleGraph({
      source: original,
      projectFile(file) {
        if (file.kind !== 'code') throw new Error('FixtureCodeExpected')
        files.set(file.path, {
          ...file,
          sourceFile: new Proxy(file.sourceFile, {
            get(target, property, receiver) {
              if (property === 'kind') throw new Error('UnnecessaryBrowserGlobalWalk')
              return Reflect.get(target, property, receiver) as unknown
            },
          }),
        })
      },
    })
    expect(vitestProjects({ source: original, moduleScan: { graph: scan.graph, files } })).toEqual([
      { project: 'node', files: [], setupFiles: ['tests/setup-node.ts'] },
      { project: 'app', files: ['tests/unit/external.test.ts'], setupFiles: ['tests/setup.ts'] },
    ])
  })

  it('reuses a complete module observation without reading or parsing source again', () => {
    const original = source({
      'tests/unit/pure.test.ts': "import '../../src/core/value'",
      'src/core/value.ts': 'export const value = 1',
      'tests/unit/ui.test.ts': "import '../../src/ui/value'",
      'src/ui/value.ts': 'export const value = document.body',
      'tests/unit/tool.test.ts': "import '../../tools/owner'",
      'tools/owner.ts': 'export const value = 1',
    })
    const files = new Map<string, ScannedLocalModuleFile>()
    const scan = scanLocalModuleGraph({
      source: original,
      parseSourceFile: parseVitestProjectSource,
      projectFile(file) {
        files.set(file.path, file)
      },
    })
    const expected = vitestProjects({ source: original })
    expect(
      vitestProjects({
        source: {
          ...original,
          readFileBytes() {
            throw new Error('ObservedSourceReadAgain')
          },
        },
        moduleScan: { graph: scan.graph, files },
      }),
    ).toEqual(expected)
  })

  it('selects tests only when their complete import closure is browser-free', () => {
    const files = {
      'scripts/audit.mjs': "import './shared.mjs'\nexport const audit = 1",
      'scripts/shared.mjs': "import { readFileSync } from 'node:fs'\nimport ts from 'typescript'",
      'tests/unit/pure.test.ts': "import { it } from 'vitest'\nimport '../../scripts/audit.mjs'",
      'tests/unit/app.test.ts': "import '../../scripts/audit.mjs'\nimport '../helpers/browser'",
      'tests/helpers/browser.ts': "import '../../src/store/db'",
      'src/store/db.ts': 'export const db = indexedDB',
      'tests/unit/external.test.ts':
        "import '../../scripts/audit.mjs'\nimport '@testing-library/react'",
      'tests/unit/opaque.test.ts': "import '../../scripts/audit.mjs'\nvoid import(target)",
      'tests/unit/missing.test.ts': "import '../../scripts/absent.mjs'",
      'tests/unit/browser-global.test.ts':
        "import '../../scripts/audit.mjs'\nindexedDB.open('proof')",
      'tests/unit/member-global.test.ts':
        "import '../../scripts/audit.mjs'\nvoid globalThis.indexedDB",
      'tests/unit/computed-global.test.ts':
        "import '../../scripts/audit.mjs'\nvoid globalThis['indexedDB']",
      'tests/unit/unknown-global.test.ts':
        "import '../../scripts/audit.mjs'\nvoid globalThis[name]",
      'tests/unit/browser-helper.test.ts':
        "import '../../scripts/audit.mjs'\nimport '../helpers/browser-global'",
      'tests/helpers/browser-global.ts': 'export const page = window',
      'tests/unit/unrelated.test.ts': "import { it } from 'vitest'",
    }
    expect(nodeUnitTests({ source: source(files) })).toEqual([
      'tests/unit/pure.test.ts',
      'tests/unit/unrelated.test.ts',
    ])
  })

  it('classifies application imports transitively and rejects browser-only constructors', () => {
    expect(
      nodeUnitTests({
        source: source({
          'tests/unit/core.test.ts': "import '../../src/core/value'",
          'src/core/value.ts': "import { shared } from './shared'; export const value = shared",
          'src/core/shared.ts': 'export const shared = 1',
          'tests/unit/gesture.test.ts': "import '../../src/core/gesture'",
          'src/core/gesture.ts': "export const press = () => new PointerEvent('pointerdown')",
          'tests/unit/element.test.ts': 'new HTMLAnchorElement()',
          'tests/unit/navigation.test.ts': "import '../../src/core/navigation'",
          'src/core/navigation.ts': 'export const navigate = () => location.assign("/")',
          'tests/unit/opaque-core.test.ts': "import '../../src/core/opaque'",
          'src/core/opaque.ts': 'export const load = () => import(target)',
          'tests/unit/external-core.test.ts': "import '../../src/core/external'",
          'src/core/external.ts': "import unknown from 'unknown-environment'; export { unknown }",
        }),
      }),
    ).toEqual(['tests/unit/core.test.ts'])
  })

  it('distinguishes local bindings and erased types from actual ambient browser access', () => {
    expect(
      nodeUnitTests({
        source: source({
          'tests/unit/local.test.ts': [
            'const window = { close() {} }; window.close()',
            'const object = { document: 1 }; void object.document',
            'function owner(name: string) { return name }',
            'type Element = { name: string }',
          ].join('\n'),
          'tests/unit/scope.test.ts': 'function local(window: unknown) {} ; window.close()',
          'tests/unit/escaped.test.ts': "Reflect.get(globalThis, 'document')",
          'tests/unit/shared.test.ts': "new Request('http://localhost'); new AbortController()",
        }),
      }),
    ).toEqual(['tests/unit/local.test.ts', 'tests/unit/shared.test.ts'])
  })

  it('does not confuse quoted source fixtures with browser global access', () => {
    expect(
      nodeUnitTests({
        source: source({
          'scripts/audit.mjs': 'export const audit = 1',
          'tests/unit/fixture.test.ts':
            "import '../../scripts/audit.mjs'\nconst source = `indexedDB.open('proof'); window.close()`",
        }),
      }),
    ).toEqual(['tests/unit/fixture.test.ts'])
  })

  it('resolves existing root-relative dynamic audit imports without changing test location', () => {
    expect(
      nodeUnitTests({
        source: source({
          'scripts/audit.mjs': 'export const audit = 1',
          'tests/unit/owner.test.ts': [
            "import { resolve } from 'node:path'",
            "import { pathToFileURL } from 'node:url'",
            "const ROOT = resolve(__dirname, '../..')",
            "const AUDIT = pathToFileURL(resolve(ROOT, 'scripts/audit.mjs')).href",
            'void import(AUDIT)',
          ].join('\n'),
        }),
      }),
    ).toEqual(['tests/unit/owner.test.ts'])
  })
})

function completedProof(): VitestProof {
  const file = { project: 'app', file: 'tests/unit/proof.test.ts' }
  return {
    schemaVersion: 1,
    invocation: 'current',
    reason: 'passed',
    timedOut: false,
    expected: [file],
    scheduled: [file],
    collected: [{ ...file, cases: [{ id: 'case', name: 'runs', mode: 'run' }] }],
    completed: [{ ...file, state: 'passed' }],
    finalModules: [file],
    results: [
      {
        ...file,
        id: 'case',
        state: 'passed',
        errors: [],
        diagnostic: { retryCount: 0, repeatCount: 0, flaky: false, duration: 1 },
      },
    ],
    unhandledErrors: [],
    selectionProblems: [],
  }
}

describe('exact Vitest collection and completion receipts', () => {
  it('requires every selected file even when another CLI filter matched and passed', () => {
    const report = completedProof()
    expect(vitestProofProblems(report, ['tests/unit/proof.test.ts'])).toEqual([])
    expect(vitestProofProblems(report, undefined, 'later-invocation')).toContain(
      'VitestProofInvocationMismatch',
    )
    expect(
      vitestProofProblems(report, ['tests/unit/proof.test.ts', 'tests/unit/missing.test.ts']),
    ).toContain('VitestProofMissingSelection:tests/unit/missing.test.ts')
    expect(
      vitestProofProblems({
        ...report,
        expected: [...report.expected, { project: 'app', file: 'tests/unit/missing.test.ts' }],
      }),
    ).toContain('VitestProofMissingScheduled:app:tests/unit/missing.test.ts')
  })

  it('rejects substring overselection and a file collected in the wrong project', () => {
    const report = completedProof()
    const extra = { project: 'app', file: 'tests/unit/proof.test.ts.extra.test.ts' }
    expect(vitestProofProblems({ ...report, scheduled: [...report.scheduled, extra] })).toContain(
      'VitestProofUnexpectedScheduled:app:tests/unit/proof.test.ts.extra.test.ts',
    )
    expect(
      vitestProofProblems({
        ...report,
        scheduled: [{ project: 'node', file: 'tests/unit/proof.test.ts' }],
      }),
    ).toContain('VitestProofMissingScheduled:app:tests/unit/proof.test.ts')
  })

  it('requires one collection, completion and terminal result for every identity', () => {
    const report = completedProof()
    expect(vitestProofProblems({ ...report, collected: [] })).toContain(
      'VitestProofMissingCollected:app:tests/unit/proof.test.ts',
    )
    expect(vitestProofProblems({ ...report, completed: [] })).toContain(
      'VitestProofMissingCompleted:app:tests/unit/proof.test.ts',
    )
    expect(vitestProofProblems({ ...report, results: [] })).toContain(
      'VitestProofMissingCaseResult:app:tests/unit/proof.test.ts:case',
    )
    expect(
      vitestProofProblems({ ...report, results: [...report.results, ...report.results] }),
    ).toContain('VitestProofDuplicateCaseResult:app:tests/unit/proof.test.ts:case')
  })

  it.each(['skip', 'todo'])('records declared %s without counting it as executed', (mode) => {
    const report = completedProof()
    const declared = {
      ...report,
      collected: report.collected.map((module) => ({
        ...module,
        cases: module.cases.map((entry) => ({ ...entry, mode })),
      })),
      completed: report.completed.map((module) => ({ ...module, state: 'skipped' })),
      results: report.results.map((entry) => ({ ...entry, state: 'skipped', diagnostic: null })),
    }
    expect(vitestProofProblems(declared)).toEqual([])
    expect(vitestProofProblems({ ...declared, collected: report.collected })).toContain(
      'VitestProofCaseState:app:tests/unit/proof.test.ts:case:skipped',
    )
  })

  it('rejects incomplete, interrupted, filtered and unhandled-error runs', () => {
    const report = completedProof()
    expect(vitestProofProblems({ ...report, reason: 'interrupted' })).toContain(
      'VitestProofRun:interrupted',
    )
    expect(vitestProofProblems({ ...report, timedOut: true })).toContain(
      'VitestProofProcessTimeout',
    )
    expect(vitestProofProblems({ ...report, unhandledErrors: ['late rejection'] })).toContain(
      'VitestProofUnhandledErrors',
    )
    expect(
      vitestProofProblems({
        ...report,
        selectionProblems: ['VitestProofFilteredCases:configuration'],
      }),
    ).toContain('VitestProofFilteredCases:configuration')
    expect(
      vitestProofProblems({
        ...report,
        results: report.results.map((entry) => ({ ...entry, state: 'pending', diagnostic: null })),
      }),
    ).toContain('VitestProofCaseUnfinished:app:tests/unit/proof.test.ts:case')
  })

  it.each([
    { retryCount: 1, repeatCount: 0, flaky: true },
    { retryCount: 0, repeatCount: 1, flaky: false },
  ])('rejects a passing rerun: %j', (diagnostic) => {
    const report = completedProof()
    expect(
      vitestProofProblems({
        ...report,
        results: report.results.map((entry) => ({
          ...entry,
          diagnostic: { ...diagnostic, duration: 1 },
        })),
      }),
    ).toContain('VitestProofCaseRepeated:app:tests/unit/proof.test.ts:case')
  })
})
