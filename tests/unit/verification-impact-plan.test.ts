import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  createFilesystemLocalModuleSource,
  scanReachableLocalModuleGraph,
} from '../../scripts/local-module-graph.mjs'
import { PROTOCOL_CONTRACT_STAGE } from '../../scripts/protocol-contract-descriptor.mjs'
import { VERIFICATION_STAGES } from '../../scripts/run-verification.mjs'
import {
  assertSafeProofExecution,
  buildVerificationSnapshot,
  diffVerificationSnapshots,
  planSliceVerification,
  type VerificationSnapshot,
  validateOpaqueModuleDispositions,
  validateVerificationManifest,
} from '../../scripts/verification-impact-plan.mjs'
import {
  VERIFICATION_EXPLICIT_MODULE_EDGES,
  VERIFICATION_OBLIGATIONS,
  VERIFICATION_OPAQUE_MODULE_REFERENCE_DISPOSITIONS,
  VERIFICATION_PROOFS,
  type VerificationObligation,
  type VerificationProof,
} from '../../scripts/verification-obligation-manifest.mjs'
import { verificationStage } from '../../scripts/verification-stage-contract.mjs'
import { isVitestSuitePath, type VitestProjectFiles } from '../../scripts/vitest-projects.mjs'

const PROOF_FILE = 'tests/unit/verification-impact-plan.test.ts'
const NODE_PROOF_FILE = 'scripts/audit-production-coordination.mjs'
const NODE_PROOF_DEPENDENCY = 'scripts/production-coordination-inventory.mjs'

let cachedRepositorySnapshot: VerificationSnapshot | undefined
function repositorySnapshot(): VerificationSnapshot {
  cachedRepositorySnapshot ??= buildVerificationSnapshot()
  return cachedRepositorySnapshot
}

describe('verification slice impact planner', () => {
  it.each(['modified', 'deleted', 'disconnected'] as const)(
    'retains stylesheet and font ownership when an asset is %s',
    (transition) => {
      const base = snapshot({
        files: {
          'src/view.ts': 'view',
          'src/theme.css': 'theme',
          'src/font.woff2': 'font',
          [PROOF_FILE]: 'proof',
          'tests/unit/unrelated.test.ts': 'unrelated',
        },
        dependencies: {
          'src/view.ts': ['src/theme.css'],
          'src/theme.css': ['src/font.woff2'],
          'src/font.woff2': [],
          [PROOF_FILE]: [],
          'tests/unit/unrelated.test.ts': [],
        },
      })
      let current =
        transition === 'deleted'
          ? removeFile(base, 'src/font.woff2')
          : mutateFile(base, 'src/font.woff2', 'changed')
      if (transition === 'disconnected') {
        current = {
          ...current,
          dependencies: { ...current.dependencies, 'src/theme.css': [] },
        }
      }
      const plan = planSliceVerification({
        base,
        current,
        obligations: [verificationObligation('view', ['src/view.ts'], ['view-proof'])],
        proofs: [vitestProof('view-proof', [PROOF_FILE])],
        moduleInventory: moduleInventory(['src/view.ts']),
        globalInputs: [],
      })
      expect(plan.structuralBlockers).toEqual([])
      expect(plan.impactedDomains).toEqual(['synthetic'])
      expect(plan.impactedObligations).toEqual(['view'])
      expect(plan.affectedPaths).toContain('src/view.ts')
      expect(plan.tasks.vitest).toEqual([PROOF_FILE])
    },
  )

  it('rejects orphan assets and code without its own classification', () => {
    const base = snapshot({ files: {}, dependencies: {} })
    const current = snapshot({
      files: { 'src/unused.css': 'css', 'src/unknown.ts': 'code', 'src/view.ts': 'view' },
      dependencies: {
        'src/unused.css': [],
        'src/unknown.ts': [],
        'src/view.ts': ['src/unknown.ts'],
      },
    })
    const plan = planSliceVerification({
      base,
      current,
      obligations: [verificationObligation('view', ['src/view.ts'], [])],
      proofs: [],
      moduleInventory: moduleInventory(['src/view.ts']),
    })
    expect(plan.structuralBlockers).toEqual([
      'VerificationChangedPathUnclassified:src/unknown.ts',
      'VerificationChangedPathUnclassified:src/unused.css',
      'VerificationChangedPathWithoutObligation:src/unused.css',
    ])
  })

  it.each(['parse-error', 'unresolved-local-module', 'module-reference-outside-root'] as const)(
    'does not exempt a registered stylesheet from %s diagnostics',
    (code) => {
      const base = snapshot({
        files: { 'src/view.ts': 'view', 'src/theme.css': 'css', [PROOF_FILE]: 'proof' },
        dependencies: { 'src/view.ts': ['src/theme.css'], 'src/theme.css': [], [PROOF_FILE]: [] },
      })
      const current = {
        ...mutateFile(base, 'src/theme.css', 'changed'),
        graphDiagnostics: [{ code, path: 'src/theme.css', line: 1, detail: 'invalid' }],
      }
      const plan = planSliceVerification({
        base,
        current,
        obligations: [verificationObligation('view', ['src/view.ts'], ['view-proof'])],
        proofs: [vitestProof('view-proof', [PROOF_FILE])],
        moduleInventory: moduleInventory(['src/view.ts']),
        globalInputs: [],
      })
      expect(plan.structuralBlockers).toEqual([
        `VerificationImpactEdgeUnresolved:src/theme.css:1:${code}`,
      ])
    },
  )

  it.each(['src/styles/tokens.css', 'src/assets/fonts/InterVariable.woff2'])(
    'derives browser build consumers for shared style input %s without unrelated unit suites',
    (path) => {
      const dependencies = {
        'src/main.tsx': ['src/app/theme.css'],
        'src/app/theme.css': ['src/styles/tokens.css'],
        'src/styles/tokens.css': ['src/assets/fonts/InterVariable.woff2'],
        'src/assets/fonts/InterVariable.woff2': [],
        'tests/e2e/send-flow.spec.ts': [],
        'tests/e2e/scroll.spec.ts': [],
        'tests/unit/ulid.test.ts': [],
      }
      const base = snapshot({
        files: Object.fromEntries(Object.keys(dependencies).map((file) => [file, 'before'])),
        dependencies,
      })
      const plan = planSliceVerification({
        base,
        current: mutateFile(base, path, 'changed'),
        obligations: [verificationObligation('app', ['src/main.tsx'], [])],
        proofs: [],
        moduleInventory: moduleInventory(['src/main.tsx'], 'application-shell'),
      })
      expect(plan.structuralBlockers).toEqual([])
      expect(plan.impactedDomains).toContain('application-shell')
      expect(plan.stages.map(({ id }) => id)).toContain('production-build')
      const browserFiles = plan.tasks.playwright.flatMap(({ files }) => files)
      expect(browserFiles).toContain('tests/e2e/send-flow.spec.ts')
      expect(browserFiles).toContain('tests/e2e/scroll.spec.ts')
      expect(plan.tasks.vitest).not.toContain('tests/unit/ulid.test.ts')
    },
  )

  it('keeps unrelated CSS diagnostics outside a unit-only change', () => {
    const base = snapshot({
      files: { 'src/view.ts': 'view', 'src/theme.css': 'css', [PROOF_FILE]: 'proof' },
      dependencies: { 'src/view.ts': ['src/theme.css'], 'src/theme.css': [], [PROOF_FILE]: [] },
    })
    const current = {
      ...mutateFile(base, PROOF_FILE, 'changed'),
      graphDiagnostics: [
        {
          code: 'parse-error' as const,
          path: 'src/theme.css',
          line: 1,
          detail: 'unrelated',
        },
      ],
    }
    const plan = planSliceVerification({
      base,
      current,
      obligations: [verificationObligation('view', ['src/view.ts'], [])],
      proofs: [],
      moduleInventory: moduleInventory(['src/view.ts']),
      globalInputs: [],
    })
    expect(plan.structuralBlockers).toEqual([])
    expect(plan.tasks.vitest).toEqual([PROOF_FILE])
    expect(plan.tasks.playwright).toEqual([])
  })

  it('resolves aggregate performance inputs once through the same grouped browser and unit batches', () => {
    const report = 'scripts/report-performance-baseline.mjs'
    const browserFiles = [
      'tests/e2e/send-flow.spec.ts',
      'tests/e2e/send-performance.spec.ts',
      'tests/e2e/render-window.spec.ts',
      'tests/e2e/large-workspace.setup.ts',
      'tests/e2e/large-workspace-startup.spec.ts',
    ]
    const files = [report, PROOF_FILE, 'tests/unit/other.test.ts', ...browserFiles]
    const base = snapshot({
      files: Object.fromEntries(files.map((path) => [path, 'before'])),
      dependencies: Object.fromEntries(files.map((path) => [path, []])),
    })
    const plan = planSliceVerification({
      base,
      current: mutateFile(base, report, 'after'),
      obligations: [],
      proofs: [],
      globalInputs: [],
      opaqueDispositions: [],
      moduleInventory: moduleInventory([]),
    })
    expect(plan.structuralBlockers).toEqual([])
    const ids = plan.stages.map(({ id }) => id)
    expect(ids.filter((id) => id === 'production-build')).toHaveLength(1)
    expect(ids.filter((id) => id === 'vitest')).toHaveLength(1)
    expect(ids.filter((id) => id.startsWith('playwright-')).sort()).toEqual([
      'playwright-chromium',
      'playwright-firefox',
    ])
    expect(ids).not.toContain('chromium-e2e')
    expect(ids).not.toContain('firefox-e2e')
    expect(plan.tasks.vitest).toEqual(['tests/unit/other.test.ts', PROOF_FILE].sort())
    const performance = plan.stages.find(({ id }) => id === 'performance')
    expect(performance?.performanceStageAliases).toMatchObject({
      'chromium-e2e': 'playwright-chromium',
      'firefox-e2e': 'playwright-firefox',
    })
    expect(performance?.prerequisiteIds).toEqual([
      'production-build',
      'vitest',
      'playwright-chromium',
      'playwright-firefox',
      'stream-profile-single',
      'stream-profile-concurrent',
    ])
    for (const dependency of performance?.prerequisiteIds ?? [])
      expect(ids.indexOf(dependency)).toBeLessThan(ids.indexOf('performance'))
    const selected = plan.stages
      .flatMap((stage) => stage.browserTasks ?? [])
      .flatMap((task) => task.files.map((file) => `${task.project}:${file}`))
    expect(new Set(selected).size).toBe(selected.length)
  })

  it.each(['scripts/profile-one.mjs', 'scripts/shared-harness.mjs'])(
    'owns Node stage entrypoints and transitive inputs without accepting neighboring scripts: %s',
    (input) => {
      const base = snapshot({
        files: {
          'scripts/profile-one.mjs': 'first',
          'scripts/profile-two.mjs': 'second',
          'scripts/shared-harness.mjs': 'before',
          'scripts/unowned.mjs': 'unowned',
        },
        dependencies: {
          'scripts/profile-one.mjs': ['scripts/shared-harness.mjs'],
          'scripts/profile-two.mjs': ['scripts/shared-harness.mjs'],
          'scripts/shared-harness.mjs': [],
          'scripts/unowned.mjs': [],
        },
      })
      const stages = ['one', 'two'].map((id) =>
        verificationStage(id, id, 'blocking', ['node', `scripts/profile-${id}.mjs`]),
      )
      const options = {
        base,
        stages,
        obligations: [],
        proofs: [],
        globalInputs: [],
        opaqueDispositions: [],
        moduleInventory: moduleInventory([]),
      }
      const plan = planSliceVerification({ ...options, current: mutateFile(base, input, 'after') })
      expect(plan.structuralBlockers).toEqual([])
      expect(plan.stages.map(({ id }) => id)).toEqual(
        input.endsWith('shared-harness.mjs') ? ['one', 'two'] : ['one'],
      )
      const unknown = planSliceVerification({
        ...options,
        current: mutateFile(base, 'scripts/unowned.mjs', 'after'),
      })
      expect(unknown.structuralBlockers).toContain(
        'VerificationChangedPathUnclassified:scripts/unowned.mjs',
      )
    },
  )

  it('accounts for the generated browser asset through exact source edges and a counted disposition', () => {
    const path = 'scripts/measure-terminal-paint-waterfall.mjs'
    const dispositions = VERIFICATION_OPAQUE_MODULE_REFERENCE_DISPOSITIONS.filter(
      (entry) => entry.path === path,
    )
    const diagnostic = {
      path,
      code: 'opaque-module-reference' as const,
      line: 184,
      detail: 'generated asset import',
    }
    const current = snapshot({ files: { [path]: 'measurement' }, dependencies: { [path]: [] } })
    expect(
      VERIFICATION_EXPLICIT_MODULE_EDGES.filter((edge) => edge.importer === path)
        .map((edge) => edge.dependency)
        .sort(),
    ).toEqual(['src/ui/chat/MessageList.tsx', 'vite.config.ts'])
    expect(validateOpaqueModuleDispositions([diagnostic], dispositions, current.files)).toEqual([])
    expect(
      validateOpaqueModuleDispositions(
        [diagnostic, { ...diagnostic, line: 200 }],
        dispositions,
        current.files,
      ),
    ).toEqual([`VerificationOpaqueDispositionDrift:${path}:1:2`])
  })

  it.each([
    ['js', 'd.ts'],
    ['mjs', 'd.mts'],
    ['cjs', 'd.cts'],
  ])('selects script consumers when their %s declaration changes', (extension, declaration) => {
    const root = mkdtempSync(resolve(tmpdir(), 'natter-declaration-impact-'))
    const script = `scripts/owner.${extension}`
    const types = `scripts/owner.${declaration}`
    const test = 'tests/unit/owner.test.ts'
    try {
      writeFixture(root, script, 'export const value = 1')
      writeFixture(root, types, 'export const value: number')
      writeFixture(root, test, `import '../../${script}'`)
      const base = withUnitProjects(
        buildVerificationSnapshot({ root, globalInputs: [], explicitEdges: [] }),
        [{ project: 'node', files: [test], setupFiles: [] }],
      )
      const plan = planSliceVerification({
        root,
        base,
        current: mutateFile(base, types, 'changed-declaration'),
        globalInputs: [],
        obligations: [],
        proofs: [],
        moduleInventory: moduleInventory([]),
      })
      expect(plan.tasks.vitest).toEqual([test])
      expect(plan.affectedPaths).toEqual([types, script, test].sort())
      expect(plan.structuralBlockers).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('selects every hosted structural audit for a production source change', () => {
    const current = repositorySnapshot()
    const candidate = mutateFile(
      current,
      'src/hooks/useSettledConfigurationEdit.ts',
      'changed-boundary',
    )
    const plan = planSliceVerification({ base: current, current: candidate })
    const obligation = VERIFICATION_OBLIGATIONS.find(
      (item) => item.id === 'production-static-contracts',
    )
    if (!obligation) throw new Error('ProductionStaticContractsMissing')
    const selected = new Set(plan.tasks.node.map((task) => task.id))
    expect(obligation.proofIds.length).toBeGreaterThan(3)
    for (const id of obligation.proofIds) expect(selected.has(id), id).toBe(true)
    expect([...selected]).toEqual(
      expect.arrayContaining([
        'presentation-store-boundary',
        'production-time',
        'production-time-semantics',
      ]),
    )
  }, 15_000)

  it('turns one producer change into one batched reverse-dependent proof set', () => {
    const base = snapshot({
      files: {
        'src/leaf.ts': 'before',
        'src/owner.ts': 'owner',
        [PROOF_FILE]: 'proof',
        'tests/unit/owner-extra.test.ts': 'extra',
      },
      dependencies: {
        'src/leaf.ts': [],
        'src/owner.ts': ['src/leaf.ts'],
        [PROOF_FILE]: ['src/owner.ts'],
        'tests/unit/owner-extra.test.ts': ['src/owner.ts'],
      },
    })
    const current = mutateFile(base, 'src/leaf.ts', 'after')
    const proof = vitestProof('owner-proof', [PROOF_FILE])
    const obligation = verificationObligation('owner-contract', ['src/owner.ts'], ['owner-proof'])

    const plan = planSliceVerification({
      base,
      current,
      obligations: [obligation],
      proofs: [proof],
      moduleInventory: moduleInventory(['src/leaf.ts', 'src/owner.ts']),
    })

    expect(plan.impactedObligations).toEqual(['owner-contract'])
    expect(plan.tasks.vitest).toEqual(['tests/unit/owner-extra.test.ts', PROOF_FILE])
    expect(plan.unregisteredAffectedTests).toEqual([])
    expect(plan.tasks.playwright).toEqual([])
    expect(plan.structuralBlockers).toEqual([])
    expect(plan.executable).toBe(true)
    expect(plan.closable).toBe(true)
  })

  it('uses the baseline graph for deleted producers and terminates cycles', () => {
    const base = snapshot({
      files: {
        'src/deleted.ts': 'deleted',
        'src/left.ts': 'left',
        'src/right.ts': 'right',
        [PROOF_FILE]: 'proof',
      },
      dependencies: {
        'src/deleted.ts': [],
        'src/left.ts': ['src/deleted.ts', 'src/right.ts'],
        'src/right.ts': ['src/left.ts'],
        [PROOF_FILE]: ['src/right.ts'],
      },
    })
    const current = removeFile(base, 'src/deleted.ts')

    const plan = planSliceVerification({
      base,
      current,
      obligations: [verificationObligation('cycle-contract', ['src/right.ts'], ['proof'])],
      proofs: [vitestProof('proof', [PROOF_FILE])],
      moduleInventory: moduleInventory(['src/left.ts', 'src/right.ts']),
    })

    expect(plan.impact.deletedPaths).toEqual(['src/deleted.ts'])
    expect(plan.impactedObligations).toEqual(['cycle-contract'])
    expect(plan.affectedPaths).toEqual([
      'src/deleted.ts',
      'src/left.ts',
      'src/right.ts',
      PROOF_FILE,
    ])
  })

  it('fails closed for an unknown production path', () => {
    const base = snapshot({ files: {}, dependencies: {} })
    const current = snapshot({
      files: { 'src/unknown.ts': 'new' },
      dependencies: { 'src/unknown.ts': [] },
    })

    const plan = planSliceVerification({
      base,
      current,
      obligations: [],
      proofs: [],
      moduleInventory: moduleInventory([]),
    })

    expect(plan.structuralBlockers).toEqual([
      'VerificationChangedPathUnclassified:src/unknown.ts',
      'VerificationChangedPathWithoutObligation:src/unknown.ts',
    ])
    expect(plan.executable).toBe(false)
  })

  it('selects an affected test intrinsically without a manual proof table', () => {
    const base = snapshot({
      files: { 'tests/unit/unregistered.test.ts': 'before' },
      dependencies: { 'tests/unit/unregistered.test.ts': [] },
    })
    const current = mutateFile(base, 'tests/unit/unregistered.test.ts', 'after')

    const plan = planSliceVerification({
      base,
      current,
      obligations: [],
      proofs: [],
      moduleInventory: moduleInventory([]),
    })

    expect(plan.tasks.vitest).toEqual(['tests/unit/unregistered.test.ts'])
    expect(plan.unregisteredAffectedTests).toEqual([])
    expect(plan.structuralBlockers).toEqual([])
    expect(plan.executable).toBe(true)
    expect(plan.closable).toBe(true)
  })

  it('recognizes and selects a registered Node proof when its script changes', () => {
    const base = snapshot({
      files: { [NODE_PROOF_FILE]: 'before', 'src/owner.ts': 'owner' },
      dependencies: { [NODE_PROOF_FILE]: [], 'src/owner.ts': [] },
    })
    const current = mutateFile(base, NODE_PROOF_FILE, 'after')

    const plan = planSliceVerification({
      base,
      current,
      obligations: [verificationObligation('owner', ['src/owner.ts'], ['owner-audit'])],
      proofs: [nodeProof('owner-audit', [NODE_PROOF_FILE])],
      opaqueDispositions: [],
      moduleInventory: moduleInventory(['src/owner.ts']),
    })

    expect(plan.tasks.node).toEqual([{ id: 'owner-audit', argv: [NODE_PROOF_FILE] }])
    expect(plan.structuralBlockers).toEqual([])
  })

  it('selects a registered Node proof when an explicit script dependency changes', () => {
    const base = snapshot({
      files: {
        [NODE_PROOF_FILE]: 'audit',
        [NODE_PROOF_DEPENDENCY]: 'before',
        'src/owner.ts': 'owner',
      },
      dependencies: {
        [NODE_PROOF_FILE]: [NODE_PROOF_DEPENDENCY],
        [NODE_PROOF_DEPENDENCY]: [],
        'src/owner.ts': [],
      },
    })
    const current = mutateFile(base, NODE_PROOF_DEPENDENCY, 'after')

    const plan = planSliceVerification({
      base,
      current,
      obligations: [verificationObligation('owner', ['src/owner.ts'], ['owner-audit'])],
      proofs: [nodeProof('owner-audit', [NODE_PROOF_FILE])],
      opaqueDispositions: [],
      moduleInventory: moduleInventory(['src/owner.ts']),
    })

    expect(plan.tasks.node).toEqual([{ id: 'owner-audit', argv: [NODE_PROOF_FILE] }])
    expect(plan.structuralBlockers).toEqual([])
  })

  it('rejects an unowned support script instead of substituting unrelated tests', () => {
    const script = 'scripts/unregistered.mjs'
    const base = snapshot({
      files: { [script]: 'before', 'src/owner.ts': 'owner', [PROOF_FILE]: 'proof' },
      dependencies: { [script]: [], 'src/owner.ts': [], [PROOF_FILE]: [] },
    })
    const current = mutateFile(base, script, 'after')

    const plan = planSliceVerification({
      base,
      current,
      obligations: [verificationObligation('owner', ['src/owner.ts'], ['owner-proof'])],
      proofs: [vitestProof('owner-proof', [PROOF_FILE])],
      moduleInventory: moduleInventory([]),
    })

    expect(plan.impactedObligations).toEqual([])
    expect(plan.tasks.vitest).toEqual([])
    expect(plan.structuralBlockers).toEqual([`VerificationChangedPathUnclassified:${script}`])
  })

  it('bounds an ordinary tooling change to its consumers and registered audit', () => {
    const unrelated = 'tests/unit/unrelated.test.ts'
    const browser = 'tests/e2e/send-flow.spec.ts'
    const base = snapshot({
      files: {
        [NODE_PROOF_DEPENDENCY]: 'before',
        [NODE_PROOF_FILE]: 'audit',
        [PROOF_FILE]: 'consumer',
        [unrelated]: 'unrelated',
        [browser]: 'browser',
      },
      dependencies: {
        [NODE_PROOF_DEPENDENCY]: [],
        [NODE_PROOF_FILE]: [NODE_PROOF_DEPENDENCY],
        [PROOF_FILE]: [NODE_PROOF_DEPENDENCY],
        [unrelated]: [],
        [browser]: [],
      },
    })
    const plan = planSliceVerification({
      base,
      current: mutateFile(base, NODE_PROOF_DEPENDENCY, 'after'),
      obligations: [verificationObligation('tooling', [NODE_PROOF_FILE], ['owner-audit'])],
      proofs: [nodeProof('owner-audit', [NODE_PROOF_FILE])],
      opaqueDispositions: [],
      moduleInventory: moduleInventory([]),
    })
    expect(plan.structuralBlockers).toEqual([])
    expect(plan.tasks).toEqual({
      node: [{ id: 'owner-audit', argv: [NODE_PROOF_FILE] }],
      vitest: [PROOF_FILE],
      playwright: [],
    })
  })

  it('bounds shared test helpers and their dependencies to their actual consumers', () => {
    const helper = 'tests/helpers/protocol-facts.ts'
    const dependency = 'scripts/fact-generator.mjs'
    const unrelated = 'tests/unit/unrelated.test.ts'
    const browser = 'tests/e2e/send-flow.spec.ts'
    const base = snapshot({
      files: {
        [dependency]: 'generator',
        [helper]: 'helper',
        [PROOF_FILE]: 'consumer',
        [unrelated]: 'unrelated',
        [browser]: 'browser',
      },
      dependencies: {
        [dependency]: [],
        [helper]: [dependency],
        [PROOF_FILE]: [helper],
        [unrelated]: [],
        [browser]: [],
      },
    })
    for (const path of [helper, dependency]) {
      const plan = planSliceVerification({
        base,
        current: mutateFile(base, path, 'after'),
        obligations: [],
        proofs: [],
        opaqueDispositions: [],
        moduleInventory: moduleInventory([]),
      })
      expect(plan.structuralBlockers, path).toEqual([])
      expect(plan.tasks, path).toEqual({ node: [], vitest: [PROOF_FILE], playwright: [] })
    }
  })

  it('invalidates browser consumers without unrelated units when a browser configuration dependency changes', () => {
    const runtime = 'scripts/browser-runtime.mjs'
    const browser = 'tests/e2e/send-flow.spec.ts'
    const base = snapshot({
      files: {
        [runtime]: 'before',
        'playwright.config.ts': 'config',
        [PROOF_FILE]: 'unit',
        [browser]: 'browser',
      },
      dependencies: {
        [runtime]: [],
        'playwright.config.ts': [runtime],
        [PROOF_FILE]: [],
        [browser]: [],
      },
    })
    const plan = planSliceVerification({
      base,
      current: mutateFile(base, runtime, 'after'),
      obligations: [],
      proofs: [],
      opaqueDispositions: [],
      moduleInventory: moduleInventory([]),
    })
    expect(plan.tasks.vitest).toEqual([])
    expect(plan.tasks.playwright.map((task) => task.project)).toEqual(['chromium', 'firefox'])
    expect(plan.structuralBlockers).toEqual([])
  })

  it('plans generated facts once for a test-only change that imports their consumer helper', () => {
    const helper = PROTOCOL_CONTRACT_STAGE.consumerModules[0]
    if (!helper) throw new Error('FactConsumerMissing')
    const base = snapshot({
      files: { [PROOF_FILE]: 'before', [helper]: 'helper' },
      dependencies: { [PROOF_FILE]: [helper], [helper]: [] },
    })
    const plan = planSliceVerification({
      base,
      current: mutateFile(base, PROOF_FILE, 'after'),
      obligations: [],
      proofs: [],
      globalInputs: [],
      opaqueDispositions: [],
      moduleInventory: moduleInventory([]),
    })
    expect(plan.stages.map((stage) => stage.id)).toEqual(['protocol-contracts', 'vitest'])
    expect(plan.stages[1]?.prerequisiteIds).toEqual(['protocol-contracts'])
    expect(plan.stages[0]?.argv).toEqual(PROTOCOL_CONTRACT_STAGE.argv)
    const withoutProducer = planSliceVerification({
      base,
      current: mutateFile(base, PROOF_FILE, 'after'),
      stages: VERIFICATION_STAGES.filter((stage) => stage.id !== 'protocol-contracts'),
      obligations: [],
      proofs: [],
      globalInputs: [],
      opaqueDispositions: [],
      moduleInventory: moduleInventory([]),
    })
    expect(withoutProducer.structuralBlockers).toContain(
      'VerificationStagePrerequisiteMissing:vitest:protocol-contracts',
    )
    expect(withoutProducer.executable).toBe(false)
    expect(withoutProducer.planDigest).not.toBe(plan.planDigest)
  })

  it.each(['tests/setup.ts', 'tests/setup-node.ts', 'vitest.config.ts'])(
    'limits %s invalidation to the unit runner',
    (input) => {
      const browser = 'tests/e2e/send-flow.spec.ts'
      const base = snapshot({
        files: { [input]: 'before', [PROOF_FILE]: 'unit', [browser]: 'browser' },
        dependencies: { [input]: [], [PROOF_FILE]: [], [browser]: [] },
        projects: [
          {
            project: input === 'tests/setup-node.ts' ? 'node' : 'app',
            files: [PROOF_FILE],
            setupFiles: input === 'vitest.config.ts' ? [] : [input],
          },
        ],
      })
      const plan = planSliceVerification({
        base,
        current: mutateFile(base, input, 'after'),
        obligations: [],
        proofs: [],
        globalInputs: [],
        opaqueDispositions: [],
        moduleInventory: moduleInventory([]),
      })
      expect(plan.tasks.vitest).toEqual([PROOF_FILE])
      expect(plan.tasks.playwright).toEqual([])
      expect(plan.impactedStageIds).toEqual(input === 'vitest.config.ts' ? ['vitest'] : [])
      expect(plan.stages.map(({ id }) => id)).toContain('vitest')
      expect(plan.structuralBlockers).toEqual([])
    },
  )

  it.each(['scripts/vitest-projects.mjs', 'vitest.config.ts'])(
    'owns project inputs only when captured %s matches its actual producer',
    (input) => {
      const modules = createFilesystemLocalModuleSource({
        directories: ['scripts'],
        files: ['vitest.config.ts', 'vite.config.ts'],
      })
      const provider = scanReachableLocalModuleGraph({
        source: modules,
        entryPaths: ['scripts/vitest-projects.mjs', 'vitest.config.ts'],
        availablePaths: modules.allPaths,
        projectFile: (file) => file.bytes,
      })
      const bytes = new Map(provider.projections)
      bytes.set('tests/setup.ts', Buffer.from('export {}'))
      bytes.set('tests/setup-node.ts', Buffer.from('export {}'))
      bytes.set('tests/unit/fixture.test.ts', Buffer.from('export const fixture = 1'))
      const observedSource = {
        kind: 'git-tree' as const,
        allPaths: new Set(bytes.keys()),
        readFileBytes(path: string) {
          const value = bytes.get(path)
          if (!value) throw new Error(`FixtureInputMissing:${path}`)
          return value
        },
        isExecutable: () => false,
      }
      const observed = buildVerificationSnapshot({
        source: observedSource,
        globalInputs: [],
        explicitEdges: [],
      })
      expect(observed.unitExecution.status).toBe('owned')
      expect(observed.dependencies['tests/unit/fixture.test.ts']).toContain('tests/setup-node.ts')
      bytes.set(input, Buffer.concat([observedSource.readFileBytes(input), Buffer.from('\n')]))
      const stale = buildVerificationSnapshot({
        source: observedSource,
        globalInputs: [],
        explicitEdges: [],
      })
      expect(stale.unitExecution).toMatchObject({ status: 'unavailable', mismatchedPaths: [input] })
      expect(stale.dependencies['tests/unit/fixture.test.ts']).not.toContain('tests/setup-node.ts')
    },
  )

  it('keeps browser setup dependencies out of Node proofs while retaining explicit obligations', () => {
    const app = 'tests/unit/app.test.ts'
    const node = 'tests/unit/node.test.ts'
    const runtime = 'src/runtime.ts'
    const setup = 'tests/setup.ts'
    const base = snapshot({
      files: { [app]: 'app', [node]: 'node', [runtime]: 'before', [setup]: 'setup' },
      dependencies: { [app]: [], [node]: [], [runtime]: [], [setup]: [runtime] },
      projects: [
        { project: 'app', files: [app], setupFiles: [setup] },
        { project: 'node', files: [node], setupFiles: [] },
      ],
    })
    const options = {
      base,
      current: mutateFile(base, runtime, 'after'),
      obligations: [],
      proofs: [],
      globalInputs: [],
      opaqueDispositions: [],
      moduleInventory: moduleInventory([runtime]),
    }
    const plan = planSliceVerification(options)
    expect(plan.tasks.vitest).toEqual([app])
    expect(plan.affectedPaths).not.toContain(node)
    expect(plan.structuralBlockers).toEqual([])
    const required = planSliceVerification({
      ...options,
      obligations: [verificationObligation('retained-proof', [runtime], ['node-proof'])],
      proofs: [vitestProof('node-proof', [node])],
    })
    expect(required.tasks.vitest).toEqual([app, node])
  })

  it('selects a file whose owned project changes even when its bytes do not', () => {
    const file = 'tests/unit/moved.test.ts'
    const base = snapshot({
      files: { [file]: 'same' },
      dependencies: { [file]: [] },
      projects: [{ project: 'node', files: [file], setupFiles: [] }],
    })
    const current = withUnitProjects(base, [{ project: 'app', files: [file], setupFiles: [] }])
    const plan = planSliceVerification({
      base,
      current,
      obligations: [],
      proofs: [],
      globalInputs: [],
      opaqueDispositions: [],
      moduleInventory: moduleInventory([]),
    })
    expect(plan.impact.changedPaths).toEqual([])
    expect(plan.tasks.vitest).toEqual([file])
    expect(plan.structuralBlockers).toEqual([])
  })

  it('invalidates the full unit runner when historical project provenance is unknown', () => {
    const app = 'tests/unit/app.test.ts'
    const node = 'tests/unit/node.test.ts'
    const setup = 'tests/setup.ts'
    const current = snapshot({
      files: { [app]: 'app', [node]: 'node', [setup]: 'after' },
      dependencies: { [app]: [], [node]: [], [setup]: [] },
      projects: [
        { project: 'app', files: [app], setupFiles: [setup] },
        { project: 'node', files: [node], setupFiles: [] },
      ],
    })
    const base: VerificationSnapshot = {
      ...mutateFile(current, setup, 'before'),
      unitExecution: {
        status: 'unavailable',
        providerInputs: {},
        mismatchedPaths: ['old-provider'],
      },
    }
    const plan = planSliceVerification({
      base,
      current,
      obligations: [],
      proofs: [],
      globalInputs: [],
      opaqueDispositions: [],
      moduleInventory: moduleInventory([]),
    })
    expect(plan.tasks.vitest).toEqual([app, node])
    expect(plan.impactedStageIds).toContain('vitest')
    expect(plan.structuralBlockers).toEqual([])
    const unowned = planSliceVerification({
      base: current,
      current: base,
      obligations: [],
      proofs: [],
      globalInputs: [],
      opaqueDispositions: [],
      moduleInventory: moduleInventory([]),
    })
    expect(unowned.structuralBlockers).toContain('VerificationUnitExecutionUnowned:current')
  })

  it('rejects missing ownership or setup edges before scope can suppress a proof', () => {
    const file = 'tests/unit/owned.test.ts'
    const setup = 'tests/setup.ts'
    const base = snapshot({
      files: { [file]: 'file', [setup]: 'setup' },
      dependencies: { [file]: [], [setup]: [] },
      projects: [{ project: 'app', files: [file], setupFiles: [setup] }],
    })
    const options = {
      base,
      obligations: [],
      proofs: [],
      globalInputs: [],
      opaqueDispositions: [],
      moduleInventory: moduleInventory([]),
    }
    expect(() =>
      planSliceVerification({
        ...options,
        current: { ...base, dependencies: { ...base.dependencies, [file]: [] } },
      }),
    ).toThrow('VerificationUnitSetupEdgeMissing:current')
    expect(() =>
      planSliceVerification({
        ...options,
        current: { ...base, unitExecution: { status: 'owned', providerInputs: {}, projects: [] } },
      }),
    ).toThrow('VerificationUnitProjectPopulationMismatch:current')
  })

  it('keeps a transitive unit runner configuration change out of the production browser scope', () => {
    const input = 'scripts/test-sequencer.mjs'
    const browser = 'tests/e2e/send-flow.spec.ts'
    const base = snapshot({
      files: {
        [input]: 'before',
        'vitest.config.ts': 'unit config',
        'vite.config.ts': 'build config',
        [PROOF_FILE]: 'unit',
        [browser]: 'browser',
      },
      dependencies: {
        [input]: [],
        'vitest.config.ts': [input, 'vite.config.ts'],
        'vite.config.ts': [],
        [PROOF_FILE]: [],
        [browser]: [],
      },
    })
    const plan = planSliceVerification({
      base,
      current: mutateFile(base, input, 'after'),
      obligations: [],
      proofs: [],
      globalInputs: [],
      opaqueDispositions: [],
      moduleInventory: moduleInventory([]),
    })
    expect(plan.tasks.vitest).toEqual([PROOF_FILE])
    expect(plan.tasks.playwright).toEqual([])
    expect(plan.impactedStageIds).toEqual(['vitest'])
    expect(plan.structuralBlockers).toEqual([])
  })

  it('selects a lint stage for its config without either test runner', () => {
    const base = snapshot({
      files: { 'biome.json': 'before', [PROOF_FILE]: 'unit' },
      dependencies: { [PROOF_FILE]: [] },
    })
    const plan = planSliceVerification({
      base,
      current: mutateFile(base, 'biome.json', 'after'),
      obligations: [],
      proofs: [],
      globalInputs: [],
      opaqueDispositions: [],
      moduleInventory: moduleInventory([]),
    })
    expect(plan.stages.map((stage) => stage.id)).toEqual(['formatting'])
    expect(plan.tasks.vitest).toEqual([])
    expect(plan.tasks.playwright).toEqual([])
    expect(plan.structuralBlockers).toEqual([])
  })

  it('selects every checkpoint descriptor and registered obligation for a global input change', () => {
    const browserFiles = [
      'tests/e2e/large-workspace.setup.ts',
      'tests/e2e/large-workspace-startup.spec.ts',
      'tests/e2e/send-flow.spec.ts',
      'tests/e2e/send-performance.spec.ts',
      'tests/e2e/render-window.spec.ts',
      'tests/e2e/dev-preview-parity.spec.ts',
      'tests/e2e/reactive-storage-stress.spec.ts',
    ]
    const base = snapshot({
      files: {
        'package.json': 'before',
        'src/a.ts': 'a',
        'src/b.ts': 'b',
        [PROOF_FILE]: 'proof',
        ...Object.fromEntries(browserFiles.map((path) => [path, 'browser'])),
      },
      dependencies: { 'src/a.ts': [], 'src/b.ts': [], [PROOF_FILE]: [] },
    })
    const current = mutateFile(base, 'package.json', 'after')
    const proofs = [vitestProof('proof-a', [PROOF_FILE]), vitestProof('proof-b', [PROOF_FILE])]
    const obligations = [
      verificationObligation('a', ['src/a.ts'], ['proof-a']),
      verificationObligation('b', ['src/b.ts'], ['proof-b']),
    ]

    const plan = planSliceVerification({
      base,
      current,
      obligations,
      proofs,
      globalInputs: ['package.json'],
      moduleInventory: moduleInventory(['src/a.ts', 'src/b.ts']),
    })

    expect(plan.impactedObligations).toEqual(['a', 'b'])
    expect(plan.tasks.vitest).toEqual([PROOF_FILE])
    expect(plan.structuralBlockers).toEqual([])
    expect(plan.impactedStageIds).toEqual(VERIFICATION_STAGES.map((stage) => stage.id).sort())
    expect(
      plan.stages.filter((stage) => stage.kind !== 'playwright').map((stage) => stage.id),
    ).toEqual(
      VERIFICATION_STAGES.filter((stage) => stage.kind !== 'playwright').map((stage) => stage.id),
    )
    expect(plan.stages.flatMap((stage) => stage.browserProjects ?? []).sort()).toEqual(
      VERIFICATION_STAGES.flatMap((stage) => stage.browserProjects ?? []).sort(),
    )
    const ids = plan.stages.map((stage) => stage.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const stage of plan.stages) {
      for (const dependency of stage.prerequisiteIds ?? []) {
        expect(ids.indexOf(dependency)).toBeGreaterThanOrEqual(0)
        expect(ids.indexOf(dependency)).toBeLessThan(ids.indexOf(stage.id))
      }
    }
  })

  it('keeps a nonglobal source edit precise when an unchanged global input is present', () => {
    const base = snapshot({
      files: { 'package.json': 'unchanged', 'src/a.ts': 'before', [PROOF_FILE]: 'proof' },
      dependencies: { 'src/a.ts': [], [PROOF_FILE]: ['src/a.ts'] },
    })
    const plan = planSliceVerification({
      base,
      current: mutateFile(base, 'src/a.ts', 'after'),
      obligations: [verificationObligation('a', ['src/a.ts'], ['proof-a'])],
      proofs: [vitestProof('proof-a', [PROOF_FILE])],
      globalInputs: ['package.json'],
      opaqueDispositions: [],
      moduleInventory: moduleInventory(['src/a.ts']),
    })
    expect(plan.structuralBlockers).toEqual([])
    expect(plan.impactedStageIds).toEqual([])
    expect(plan.stages.map((stage) => stage.id)).toEqual(['vitest'])
    expect(plan.tasks.vitest).toEqual([PROOF_FILE])
    expect(plan.tasks.playwright).toEqual([])
  })

  it('derives exactly one runtime-isolation proof from the checkpoint stage', () => {
    const stages = VERIFICATION_STAGES.filter((stage) => stage.id === 'test-runtime-isolation')
    const proofs = VERIFICATION_PROOFS.filter((proof) => proof.id === 'test-runtime-isolation')
    expect(stages).toHaveLength(1)
    expect(proofs).toHaveLength(1)
    expect(proofs[0]?.execution).toEqual({ runner: 'node', argv: stages[0]?.argv.slice(1) })
    expect(stages[0]?.policy).toBe('blocking')
  })

  it('separates structural executability from still-open architectural guarantees', () => {
    const base = snapshot({
      files: { 'src/workspace.ts': 'before', [PROOF_FILE]: 'proof' },
      dependencies: { 'src/workspace.ts': [], [PROOF_FILE]: ['src/workspace.ts'] },
    })
    const current = mutateFile(base, 'src/workspace.ts', 'after')

    const plan = planSliceVerification({
      base,
      current,
      obligations: [verificationObligation('workspace', ['src/workspace.ts'], ['proof'])],
      proofs: [vitestProof('proof', [PROOF_FILE])],
      moduleInventory: moduleInventory(['src/workspace.ts'], 'workspace'),
    })

    expect(plan.structuralBlockers).toEqual([])
    expect(plan.executable).toBe(true)
    expect(plan.closable).toBe(false)
    expect(plan.openGuarantees.some((gap) => gap.id.startsWith('architecture:workspace:'))).toBe(
      true,
    )
  })

  it('rejects unsafe browser selectors and missing proof kinds', () => {
    expect(() =>
      assertSafeProofExecution({
        id: 'unsafe-browser',
        kind: 'browser',
        execution: {
          runner: 'playwright',
          files: ['tests/e2e/send-flow.spec.ts:18'],
        },
      }),
    ).toThrow('VerificationBrowserSelectorUnsafe:unsafe-browser:tests/e2e/send-flow.spec.ts:18')

    const current = snapshot({
      files: { 'src/root.ts': 'root' },
      dependencies: { 'src/root.ts': [] },
    })
    expect(
      validateVerificationManifest({
        current,
        obligations: [verificationObligation('root', ['src/root.ts'], ['missing'])],
        proofs: [],
      }),
    ).toContain('VerificationObligationProofMissing:root:missing')
  })

  it('keeps file and declaration changes explicit in the snapshot diff', () => {
    const base = snapshot({ files: { 'src/a.ts': 'before' }, dependencies: { 'src/a.ts': [] } })
    const current = snapshot({ files: { 'src/a.ts': 'after' }, dependencies: { 'src/a.ts': [] } })
    const diff = diffVerificationSnapshots(base, current)

    expect(diff.modifiedPaths).toEqual(['src/a.ts'])
    expect(diff.changedSymbols).toEqual([
      { id: 'src/a.ts#module:<module>', path: 'src/a.ts', change: 'modified' },
    ])
  })

  it('snapshots graph and supplemental inputs from one typed file scan', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'natter-verification-snapshot-'))
    try {
      const source = "import './theme.css'\nexport const a = 1\n"
      writeFixture(root, 'src/a.ts', source)
      writeFixture(root, 'src/theme.css', ':root {}')
      writeFixture(root, 'package.json', '{"name":"fixture"}')
      const reads = new Map<string, number>()
      const parses = new Map<string, number>()
      const filesystemSource = createFilesystemLocalModuleSource({
        root,
        additionalPaths: ['package.json'],
      })
      const current = buildVerificationSnapshot({
        globalInputs: ['package.json', 'src/a.ts'],
        explicitEdges: [],
        source: {
          kind: 'filesystem',
          allPaths: filesystemSource.allPaths,
          readFileBytes(path) {
            reads.set(path, (reads.get(path) ?? 0) + 1)
            return filesystemSource.readFileBytes(path)
          },
          isExecutable: (path) => filesystemSource.isExecutable(path),
        },
        parseSourceFile(path, text) {
          parses.set(path, (parses.get(path) ?? 0) + 1)
          return ts.createSourceFile(
            path,
            text,
            ts.ScriptTarget.Latest,
            false,
            path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
          )
        },
      })

      expect(Object.fromEntries(reads)).toEqual({
        'package.json': 1,
        'src/a.ts': 1,
        'src/theme.css': 1,
      })
      expect(Object.fromEntries(parses)).toEqual({ 'src/a.ts': 1 })
      expect(current.dependencies).toEqual({
        'src/a.ts': ['src/theme.css'],
        'src/theme.css': [],
      })
      expect(current.files['src/a.ts']).toEqual({
        sha256: digest(source),
        executable: false,
        symbols: [
          {
            id: 'src/a.ts#module:<module>',
            kind: 'module',
            name: '<module>',
            sha256: digest(source),
          },
          {
            id: 'src/a.ts#variable:a',
            kind: 'variable',
            name: 'a',
            sha256: digest('export const a = 1'),
          },
        ],
      })
      expect(Object.keys(current.files['src/a.ts'] ?? {}).sort()).toEqual([
        'executable',
        'sha256',
        'symbols',
      ])
      expect(current.files['package.json']?.symbols).toEqual([])
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('validates the real manifest and derives an open browser proof slice in one bounded planning pass', () => {
    const startedAt = performance.now()
    const current = repositorySnapshot()

    const obligationId = 'wave-a-cut-5-conversation-viewport-presentation'
    const obligation = VERIFICATION_OBLIGATIONS.find((candidate) => candidate.id === obligationId)
    if (!obligation) throw new Error('Cut5ViewportObligationMissing')
    const proofIds = new Set(obligation.proofIds)
    const obligationProofs = VERIFICATION_PROOFS.filter((proof) => proofIds.has(proof.id))
    const candidate = mutateFile(current, 'src/ui/chat/MessageList.tsx', 'cut-5-change')
    const plan = planSliceVerification({ base: current, current: candidate })

    expect(obligation.status).toBe('open')
    expect(obligationProofs.map((proof) => proof.kind).sort()).toEqual([
      'browser',
      'browser',
      'browser',
      'integration',
      'integration',
    ])
    expect(plan.impactedObligations).toContain(obligationId)
    expect(plan.tasks.vitest.length).toBeGreaterThan(0)
    for (const file of ['tests/e2e/scroll.spec.ts', 'tests/e2e/render-window.spec.ts']) {
      expect(
        plan.tasks.playwright
          .filter((task) => task.files.includes(file))
          .map((task) => task.project),
      ).toEqual(
        file.endsWith('/render-window.spec.ts')
          ? ['chromium-send-performance', 'firefox']
          : ['chromium', 'firefox'],
      )
    }
    expect(plan.tasks.playwright).toContainEqual({
      project: 'large-workspace-setup',
      files: ['tests/e2e/large-workspace.setup.ts'],
    })
    expect(plan.openGuarantees).toContainEqual({ id: `obligation:${obligationId}`, status: 'open' })
    expect(validateVerificationManifest({ current })).toEqual([])
    expect(Object.keys(current.files).length).toBeGreaterThan(500)
    expect(performance.now() - startedAt).toBeLessThan(10_000)
  }, 15_000)

  it('derives both terminal handoff proof tracks from any owner in the typed seam', () => {
    const current = repositorySnapshot()
    const obligationId = 'wave-a-cut-6-terminal-presentation-handoff'
    const obligation = VERIFICATION_OBLIGATIONS.find((candidate) => candidate.id === obligationId)
    if (!obligation) throw new Error('Cut6TerminalPresentationHandoffObligationMissing')
    const proofIds = new Set(obligation.proofIds)
    const obligationProofs = VERIFICATION_PROOFS.filter((proof) => proofIds.has(proof.id))
    const candidate = mutateFile(
      current,
      'src/store/attempt-controller.ts',
      'cut-6-terminal-handoff-change',
    )
    const plan = planSliceVerification({ base: current, current: candidate })

    expect(obligation.status).toBe('open')
    expect(obligationProofs.map((proof) => proof.kind).sort()).toEqual([
      'browser',
      'integration',
      'performance',
    ])
    expect(plan.impactedObligations).toContain(obligationId)
    expect(plan.tasks.vitest).toEqual(
      expect.arrayContaining([
        'tests/integration/generation-lifecycle-contract.test.ts',
        'tests/unit/attempt-controller.test.ts',
        'tests/unit/ui-journey-invariant-recorder.test.ts',
      ]),
    )
    expect(
      plan.tasks.playwright
        .filter((task) => task.files.includes('tests/e2e/send-performance.spec.ts'))
        .map((task) => task.project),
    ).toEqual(['chromium-send-performance', 'firefox-send-performance'])
    for (const project of ['chromium', 'firefox']) {
      expect(plan.tasks.playwright.find((task) => task.project === project)?.files).toEqual(
        expect.arrayContaining([
          'tests/e2e/branch-tree-streaming.spec.ts',
          'tests/e2e/concurrent-ops.spec.ts',
        ]),
      )
    }
    expect(plan.openGuarantees).toContainEqual({ id: `obligation:${obligationId}`, status: 'open' })
    expect(validateVerificationManifest({ current })).toEqual([])
  }, 15_000)

  it('derives the complete Firefox viewport proof from either transcript viewport owner', () => {
    const current = repositorySnapshot()
    for (const path of ['src/ui/chat/ScrollRegion.tsx', 'src/ui/chat/MessageList.tsx']) {
      const candidate = mutateFile(current, path, 'native-find-coordinate-change')
      const plan = planSliceVerification({ base: current, current: candidate })
      expect(plan.impactedObligations).toContain('native-find-viewport')
      expect(plan.tasks.vitest).toContain('tests/unit/scroll-region.test.tsx')
      const firefoxFiles = plan.tasks.playwright.find(({ project }) => project === 'firefox')?.files
      expect(firefoxFiles).toEqual(
        expect.arrayContaining([
          'tests/e2e/render-window-loading.spec.ts',
          'tests/e2e/render-window-streaming.spec.ts',
          'tests/e2e/render-window.spec.ts',
          'tests/e2e/scroll.spec.ts',
        ]),
      )
      const viewportBrowserFiles = VERIFICATION_PROOFS.flatMap((proof) =>
        proof.execution.runner === 'playwright' &&
        ['conversation-viewport-presentation-browser'].includes(proof.id)
          ? proof.execution.files
          : [],
      )
      expect(firefoxFiles).toEqual(expect.arrayContaining(viewportBrowserFiles))
      expect(
        plan.tasks.playwright.find(({ project }) => project === 'chromium')?.files,
      ).not.toContain('tests/e2e/render-window.spec.ts')
      expect(
        plan.tasks.playwright.find(({ project }) => project === 'chromium-send-performance')?.files,
      ).toContain('tests/e2e/render-window.spec.ts')
      expect(plan.structuralBlockers).toEqual([])
    }
  }, 15_000)

  it('derives sidebar continuity and target-local privacy proof from the catalog owner', () => {
    const current = repositorySnapshot()
    const candidate = mutateFile(current, 'src/hooks/useModelCatalog.ts', 'privacy-target-change')
    const plan = planSliceVerification({ base: current, current: candidate })

    expect(plan.impactedObligations).toContain('configuration-target-presentation')
    expect(plan.tasks.vitest).toContain('tests/unit/privacy-policies.test.tsx')
    expect(plan.tasks.playwright.find(({ project }) => project === 'chromium')?.files).toEqual(
      expect.arrayContaining([
        'tests/e2e/sidebar.spec.ts',
        'tests/e2e/provider-crosswalk-switching.spec.ts',
      ]),
    )
    expect(plan.structuralBlockers).toEqual([])
  }, 15_000)

  it('derives both browser engines for focused configuration continuity', () => {
    const current = repositorySnapshot()
    const candidate = mutateFile(
      current,
      'src/ui/settings/PromptPresetEditor.tsx',
      'configuration-focus-change',
    )
    const plan = planSliceVerification({ base: current, current: candidate })

    expect(plan.impactedObligations).toContain('configuration-edit-continuity')
    expect(plan.tasks.vitest).toEqual(
      expect.arrayContaining([
        'tests/unit/param-form.test.tsx',
        'tests/unit/prompt-preset-editor.test.tsx',
      ]),
    )
    expect(plan.tasks.playwright.find(({ project }) => project === 'chromium')?.files).toContain(
      'tests/e2e/system-prompt.spec.ts',
    )
    expect(plan.tasks.playwright.find(({ project }) => project === 'firefox')?.files).toEqual(
      expect.arrayContaining([
        'tests/e2e/advanced-generation-routing.spec.ts',
        'tests/e2e/system-prompt.spec.ts',
      ]),
    )
    expect(plan.structuralBlockers).toEqual([])
  }, 15_000)
})

function writeFixture(root: string, path: string, source: string): void {
  const absolutePath = resolve(root, path)
  mkdirSync(resolve(absolutePath, '..'), { recursive: true })
  writeFileSync(absolutePath, source)
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function snapshot({
  files,
  dependencies,
  projects,
}: {
  files: Record<string, string>
  dependencies: Record<string, string[]>
  projects?: readonly VitestProjectFiles[]
}): VerificationSnapshot {
  return withUnitProjects(
    {
      schemaVersion: 4,
      unitExecution: { status: 'owned', providerInputs: {}, projects: [] },
      obligationSchemaVersion: 2,
      files: Object.fromEntries(
        Object.entries(files).map(([path, sha256]) => [
          path,
          {
            sha256,
            executable: false,
            symbols: [{ id: `${path}#module:<module>`, kind: 'module', name: '<module>', sha256 }],
          },
        ]),
      ),
      dependencies,
      graphDiagnostics: [],
      digest: Object.entries(files)
        .map(([path, value]) => `${path}:${value}`)
        .sort()
        .join('|'),
    },
    projects ?? [
      { project: 'app', files: Object.keys(files).filter(isVitestSuitePath), setupFiles: [] },
    ],
  )
}

function withUnitProjects(
  base: VerificationSnapshot,
  projects: readonly VitestProjectFiles[],
): VerificationSnapshot {
  const oldSetups =
    base.unitExecution.status === 'owned'
      ? new Set(base.unitExecution.projects.flatMap(({ setupFiles }) => setupFiles))
      : new Set<string>()
  const dependencies = Object.fromEntries(
    Object.entries(base.dependencies).map(([path, values]) => [
      path,
      isVitestSuitePath(path) ? values.filter((value) => !oldSetups.has(value)) : [...values],
    ]),
  )
  for (const project of projects) {
    for (const file of project.files)
      dependencies[file] = [
        ...new Set([...(dependencies[file] ?? []), ...project.setupFiles]),
      ].sort()
  }
  return {
    ...base,
    dependencies,
    unitExecution: { status: 'owned', providerInputs: {}, projects },
    digest: `${base.digest}|projects:${JSON.stringify(projects)}`,
  }
}

function mutateFile(
  base: VerificationSnapshot,
  path: string,
  sha256: string,
): VerificationSnapshot {
  const files = Object.fromEntries(
    Object.entries(base.files).map(([filePath, file]) => [
      filePath,
      filePath === path
        ? {
            sha256,
            executable: file.executable,
            symbols: [{ id: `${path}#module:<module>`, kind: 'module', name: '<module>', sha256 }],
          }
        : file,
    ]),
  )
  return { ...base, files, digest: `${base.digest}|${path}:${sha256}` }
}

function removeFile(base: VerificationSnapshot, path: string): VerificationSnapshot {
  const files = Object.fromEntries(
    Object.entries(base.files).filter(([filePath]) => filePath !== path),
  )
  const dependencies = Object.fromEntries(
    Object.entries(base.dependencies)
      .filter(([filePath]) => filePath !== path)
      .map(([filePath, values]) => [filePath, values.filter((value) => value !== path)]),
  )
  return withUnitProjects(
    { ...base, files, dependencies, digest: `${base.digest}|deleted:${path}` },
    base.unitExecution.status === 'owned'
      ? base.unitExecution.projects.map((project) => ({
          ...project,
          files: project.files.filter((file) => file !== path),
        }))
      : [],
  )
}

function vitestProof(id: string, files: string[]): VerificationProof {
  return { id, kind: 'unit', execution: { runner: 'vitest', files } }
}

function nodeProof(id: string, argv: string[]): VerificationProof {
  return { id, kind: 'static', execution: { runner: 'node', argv } }
}

function verificationObligation(
  id: string,
  impactModules: string[],
  proofIds: string[],
): VerificationObligation {
  return { id, status: 'covered', impactModules, proofIds }
}

function moduleInventory(paths: string[], domain = 'synthetic') {
  return {
    classifications: [{ domain, layer: 'test', responsibility: 'test', paths }],
  }
}
