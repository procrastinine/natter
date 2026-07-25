import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { createFilesystemLocalModuleSource } from '../../scripts/local-module-graph.mjs'
import {
  assertSafeProofExecution,
  buildVerificationSnapshot,
  diffVerificationSnapshots,
  planSliceVerification,
  type VerificationSnapshot,
  validateVerificationManifest,
} from '../../scripts/verification-impact-plan.mjs'
import {
  VERIFICATION_OBLIGATIONS,
  VERIFICATION_PROOFS,
  type VerificationObligation,
  type VerificationProof,
} from '../../scripts/verification-obligation-manifest.mjs'

const PROOF_FILE = 'tests/unit/verification-impact-plan.test.ts'
const NODE_PROOF_FILE = 'scripts/audit-production-coordination.mjs'
const NODE_PROOF_DEPENDENCY = 'scripts/production-coordination-inventory.mjs'

describe('verification slice impact planner', () => {
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

  it('conservatively invalidates registered proofs for a changed support script', () => {
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

    expect(plan.impactedObligations).toEqual(['owner'])
    expect(plan.tasks.vitest).toEqual([PROOF_FILE])
    expect(plan.structuralBlockers).toEqual([])
  })

  it('invalidates every registered obligation when a global toolchain input changes', () => {
    const base = snapshot({
      files: { 'package.json': 'before', 'src/a.ts': 'a', 'src/b.ts': 'b', [PROOF_FILE]: 'proof' },
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
          project: 'chromium',
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
    const current = buildVerificationSnapshot()

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
    expect(plan.tasks.playwright).toHaveLength(2)
    expect(plan.tasks.playwright[0]?.project).toBe('chromium')
    expect(Array.isArray(plan.tasks.playwright[0]?.files)).toBe(true)
    expect(plan.tasks.playwright[1]).toEqual({
      project: 'chromium-large-workspace',
      files: ['tests/e2e/large-workspace-startup.spec.ts'],
    })
    expect(plan.openGuarantees).toContainEqual({ id: `obligation:${obligationId}`, status: 'open' })
    expect(validateVerificationManifest({ current })).toEqual([])
    expect(Object.keys(current.files).length).toBeGreaterThan(500)
    expect(performance.now() - startedAt).toBeLessThan(10_000)
  }, 15_000)

  it('derives both terminal handoff proof tracks from any owner in the typed seam', () => {
    const current = buildVerificationSnapshot()
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
    expect(obligationProofs.map((proof) => proof.kind).sort()).toEqual(['browser', 'integration'])
    expect(plan.impactedObligations).toContain(obligationId)
    expect(plan.tasks.vitest).toEqual(
      expect.arrayContaining([
        'tests/integration/generation-lifecycle-contract.test.ts',
        'tests/unit/attempt-controller.test.ts',
        'tests/unit/ui-journey-invariant-recorder.test.ts',
      ]),
    )
    expect(plan.tasks.playwright).toHaveLength(2)
    expect(plan.tasks.playwright[0]?.project).toBe('chromium')
    expect(plan.tasks.playwright[0]?.files).toEqual(
      expect.arrayContaining([
        'tests/e2e/branch-tree-streaming.spec.ts',
        'tests/e2e/concurrent-ops.spec.ts',
      ]),
    )
    expect(plan.tasks.playwright[1]).toEqual({
      project: 'chromium-large-workspace',
      files: ['tests/e2e/large-workspace-startup.spec.ts'],
    })
    expect(plan.openGuarantees).toContainEqual({ id: `obligation:${obligationId}`, status: 'open' })
    expect(validateVerificationManifest({ current })).toEqual([])
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
}: {
  files: Record<string, string>
  dependencies: Record<string, string[]>
}): VerificationSnapshot {
  return {
    schemaVersion: 2,
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
  return { ...base, files, dependencies, digest: `${base.digest}|deleted:${path}` }
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
