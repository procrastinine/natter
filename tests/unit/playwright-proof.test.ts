// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  playwrightProjects,
  selectedPlaywrightProjects,
} from '../../scripts/playwright-projects.mjs'
import {
  type BrowserProofCase,
  browserProofProblems,
  browserSuiteFiles,
  fullBrowserTasks,
  reconcileBrowserPhaseProofs,
} from '../../scripts/playwright-proof-reporter.mjs'
import {
  browserExecutionPhases,
  browserGroupProjects,
  browserProjectsForFile,
  selectBrowserTasks,
} from '../../scripts/playwright-selection.mjs'

import {
  planSliceVerification,
  type VerificationSnapshot,
} from '../../scripts/verification-impact-plan.mjs'

const root = resolve(__dirname, '../..')
const file = 'tests/e2e/send-flow.spec.ts'
const tasks = [{ project: 'firefox', files: [file] }]
const completed: BrowserProofCase = {
  id: 'first',
  project: 'firefox',
  file,
  outcome: 'expected',
  annotations: [],
  results: [{ status: 'passed', retry: 0, duration: 1 }],
}

describe('browser proof ownership and receipts', () => {
  it('matches real Playwright collection for every file and every project', () => {
    const collection = JSON.parse(
      execFileSync(
        process.execPath,
        [
          resolve(root, 'node_modules/@playwright/test/cli.js'),
          'test',
          '--list',
          '--reporter=json',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, E2E_DEV_PREVIEW_PARITY: '1', E2E_HEADED_VISIBILITY: '1' },
        },
      ),
    ) as { errors: unknown[]; suites: Suite[] }
    expect(collection.errors).toEqual([])
    const collected = new Map<string, Set<string>>()
    function visit(suite: Suite) {
      for (const spec of suite.specs ?? []) {
        const path = `tests/e2e/${spec.file}`
        const owners = collected.get(path) ?? new Set<string>()
        for (const test of spec.tests) owners.add(test.projectName)
        collected.set(path, owners)
      }
      for (const child of suite.suites ?? []) visit(child)
    }
    for (const suite of collection.suites) visit(suite)
    const files = browserSuiteFiles(root)
    expect([...collected.keys()].sort()).toEqual(files)
    const snapshot: VerificationSnapshot = {
      schemaVersion: 4,
      unitExecution: { status: 'owned', providerInputs: {}, projects: [] },
      obligationSchemaVersion: 3,
      digest: 'base',
      graphDiagnostics: [],
      files: Object.fromEntries(
        files.map((path) => [path, { sha256: 'base', executable: false, symbols: [] }]),
      ),
      dependencies: Object.fromEntries(files.map((path) => [path, []])),
    }
    for (const path of files) {
      expect(
        browserProjectsForFile(path)
          .map((project) => project.name)
          .sort(),
        path,
      ).toEqual([...(collected.get(path) ?? [])].sort())
      const plan = planSliceVerification({
        base: snapshot,
        current: {
          ...snapshot,
          digest: path,
          files: {
            ...snapshot.files,
            [path]: { sha256: 'changed', executable: false, symbols: [] },
          },
        },
        proofs: [],
        obligations: [],
        opaqueDispositions: [],
        moduleInventory: { classifications: [] },
      })
      expect(plan.structuralBlockers, path).toEqual([])
      expect(
        plan.tasks.playwright
          .filter((task) => task.files.includes(path))
          .map((task) => task.project)
          .sort(),
        path,
      ).toEqual([...(collected.get(path) ?? [])].sort())
      const selection = selectBrowserTasks([path], files)
      expect(selection.problems, path).toEqual([])
      expect(plan.tasks.playwright, path).toEqual(selection.tasks)
      expect(
        selection.tasks
          .filter((task) => task.files.includes(path))
          .map((task) => task.project)
          .sort(),
        path,
      ).toEqual([...(collected.get(path) ?? [])].sort())
    }
  }, 15_000)

  it('preserves setup ownership and the checkpoint dependency order', () => {
    const files = browserSuiteFiles(root)
    expect(selectBrowserTasks(['tests/e2e/large-workspace-startup.spec.ts'], files).tasks).toEqual([
      { project: 'large-workspace-setup', files: ['tests/e2e/large-workspace.setup.ts'] },
      { project: 'chromium-large-workspace', files: ['tests/e2e/large-workspace-startup.spec.ts'] },
    ])
    expect(selectBrowserTasks(['tests/e2e/large-workspace.setup.ts'], files).tasks).toEqual([
      { project: 'large-workspace-setup', files: ['tests/e2e/large-workspace.setup.ts'] },
      { project: 'chromium-large-workspace', files: ['tests/e2e/large-workspace-startup.spec.ts'] },
    ])
    expect(
      fullBrowserTasks(browserGroupProjects('chromium'), files).map((task) => task.project),
    ).toEqual([
      'large-workspace-setup',
      'chromium',
      'chromium-large-workspace',
      'chromium-send-performance',
    ])
    expect(
      playwrightProjects().find((project) => project.name === 'firefox-send-performance'),
    ).toMatchObject({ executionPhase: 'measurement', workers: 1, fullyParallel: false })
    expect(selectBrowserTasks(['tests/e2e/not-a-suite.ts'], files).problems).toEqual([
      'VerificationBrowserFileUncollected:tests/e2e/not-a-suite.ts',
    ])
  })

  it('bounds a slice to exact files without adding order-only dependencies', () => {
    const tasks = [
      { project: 'chromium', files: [file] },
      { project: 'chromium-send-performance', files: ['tests/e2e/render-window.spec.ts'] },
    ]
    const projects = selectedPlaywrightProjects({
      E2E_BROWSER_SELECTION: JSON.stringify(tasks),
    })
    expect(projects.map((project) => project.name)).toEqual(tasks.map((task) => task.project))
    expect(projects[1]?.dependencies).toEqual([])
    expect(projects[0]?.testMatch.some((pattern) => pattern.test(`/repo/${file}`))).toBe(true)
    expect(
      projects[0]?.testMatch.some((pattern) => pattern.test('/repo/tests/e2e/composer.spec.ts')),
    ).toBe(false)
    expect(() =>
      selectedPlaywrightProjects({
        E2E_BROWSER_SELECTION: JSON.stringify([
          { project: 'chromium', files: ['tests/e2e/render-window.spec.ts'] },
        ]),
      }),
    ).toThrow('BrowserSelectionInvalid:chromium')
  })

  it('separates quiet phase order from actual fixture requirements', () => {
    const files = browserSuiteFiles(root)
    const tasks = fullBrowserTasks(browserGroupProjects('chromium'), files)
    const phases = browserExecutionPhases(tasks)
    expect(phases.map(({ name }) => name)).toEqual(['ordinary', 'workspace', 'measurement'])
    expect(
      phases
        .flatMap(({ tasks }) => tasks)
        .map(({ project }) => project)
        .sort(),
    ).toEqual(tasks.map(({ project }) => project).sort())
    expect(
      playwrightProjects()
        .filter(({ dependencies }) => dependencies?.length)
        .map(({ name, dependencies }) => ({ name, dependencies })),
    ).toEqual([{ name: 'chromium-large-workspace', dependencies: ['large-workspace-setup'] }])
    expect(
      browserExecutionPhases([
        { project: 'chromium-send-performance', files: ['tests/e2e/send-performance.spec.ts'] },
      ]).map(({ name }) => name),
    ).toEqual(['measurement'])
    expect(() =>
      browserExecutionPhases([
        {
          project: 'chromium-large-workspace',
          files: ['tests/e2e/large-workspace-startup.spec.ts'],
        },
      ]),
    ).toThrow('BrowserPhaseProducerMissing')
  })

  it('rejects omitted, duplicated, mismatched and failed phase receipts', () => {
    const receipt = {
      name: 'ordinary',
      tasks,
      exitCode: 0,
      signal: null,
      proof: { schemaVersion: 1 as const, status: 'passed', expected: tasks, cases: [completed] },
    }
    expect(reconcileBrowserPhaseProofs(tasks, [receipt]).status).toBe('passed')
    expect(reconcileBrowserPhaseProofs(tasks, []).problems).toContain(
      `BrowserPhaseMissingFile:firefox:${file}`,
    )
    expect(reconcileBrowserPhaseProofs(tasks, [receipt, receipt]).problems).toContain(
      `BrowserPhaseDuplicateFile:firefox:${file}`,
    )
    expect(reconcileBrowserPhaseProofs(tasks, [{ ...receipt, proof: null }]).problems).toContain(
      'BrowserPhaseReceiptMissing:ordinary',
    )
    expect(
      reconcileBrowserPhaseProofs(tasks, [
        { ...receipt, proof: { ...receipt.proof, expected: [] } },
      ]).problems,
    ).toContain('BrowserPhaseReceiptSelection:ordinary')
    expect(reconcileBrowserPhaseProofs(tasks, [{ ...receipt, exitCode: 1 }]).problems).toContain(
      'BrowserPhaseFailed:ordinary',
    )
    expect(
      reconcileBrowserPhaseProofs(tasks, [
        { ...receipt, proof: { ...receipt.proof, cases: [{ ...completed, results: [] }] } },
      ]).problems,
    ).toContain('BrowserProofAttemptCount:first:0')
  })

  it('rejects missing, extra, duplicate, retried and unfinished evidence despite exit zero', () => {
    expect(browserProofProblems(tasks, [completed])).toEqual([])
    expect(browserProofProblems(tasks, [])).toContain(`BrowserProofMissingFile:firefox:${file}`)
    expect(browserProofProblems(tasks, [{ ...completed, project: 'chromium' }])).toContain(
      `BrowserProofUnexpectedFile:chromium:${file}`,
    )
    expect(browserProofProblems(tasks, [completed, completed])).toContain(
      'BrowserProofDuplicateTest:first',
    )
    expect(browserProofProblems(tasks, [{ ...completed, results: [] }])).toContain(
      'BrowserProofAttemptCount:first:0',
    )
    expect(
      browserProofProblems(tasks, [
        { ...completed, results: [{ status: 'passed', retry: 1, duration: 1 }] },
      ]),
    ).toContain('BrowserProofIncomplete:first')
    expect(browserProofProblems(tasks, [{ ...completed, outcome: 'unexpected' }])).toContain(
      'BrowserProofOutcome:first:unexpected',
    )
  })

  it('distinguishes declared skips from unexecuted tests', () => {
    const skipped = {
      ...completed,
      outcome: 'skipped',
      results: [{ status: 'skipped', retry: 0, duration: 0 }],
    }
    expect(browserProofProblems(tasks, [skipped])).toContain('BrowserProofUnexplainedSkip:first')
    expect(
      browserProofProblems(tasks, [
        { ...skipped, annotations: [{ type: 'skip', description: 'requires native visibility' }] },
      ]),
    ).toEqual([])
    expect(
      browserProofProblems(tasks, [{ ...skipped, annotations: [{ type: 'skip' }], results: [] }]),
    ).toContain('BrowserProofAttemptCount:first:0')
  })
})

interface Suite {
  specs?: Array<{ file: string; tests: Array<{ projectName: string }> }>
  suites?: Suite[]
}
