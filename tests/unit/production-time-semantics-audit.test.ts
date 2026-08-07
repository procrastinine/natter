import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const BASE_AUDIT_URL = pathToFileURL(resolve(ROOT, 'scripts/audit-production-time.mjs')).href
const SEMANTIC_AUDIT_URL = pathToFileURL(
  resolve(ROOT, 'scripts/audit-production-time-semantics.mjs'),
).href
const MANIFEST_URL = pathToFileURL(
  resolve(ROOT, 'scripts/production-time-semantics-inventory.mjs'),
).href

type AuditMode = 'inventory' | 'enforce'
type TemporalSiteKind =
  | 'schedulers'
  | 'durations'
  | 'asyncRaces'
  | 'retryLoops'
  | 'maintenanceCommands'

interface SemanticGroup {
  readonly id: string
  readonly sites: Partial<Record<TemporalSiteKind, readonly string[]>>
  readonly correctnessFromElapsedTime: boolean
  readonly cancellationCleanup: string
  readonly progressEvidence: string
  readonly boundInputShape: string
  readonly gapRationale?: string
  readonly [field: string]: unknown
}

interface SourceEvidence {
  readonly path: string
  readonly locator: string
}

interface ReadinessEvidence {
  readonly id: string
  readonly evidence: readonly SourceEvidence[]
  readonly acceptanceEvidence: readonly SourceEvidence[]
  readonly [field: string]: unknown
}

interface TemporalManifest {
  readonly TEMPORAL_SEMANTIC_GROUPS: readonly SemanticGroup[]
  readonly TEMPORAL_READINESS_PROOFS: readonly ReadinessEvidence[]
  readonly TEMPORAL_READINESS_GAPS: readonly ReadinessEvidence[]
  readonly TEMPORAL_SEMANTIC_LIMITATIONS: readonly Readonly<Record<string, unknown>>[]
}

interface TemporalReport {
  readonly ok: boolean
  readonly structurallyValid: boolean
  readonly baseCounts: Readonly<Record<string, number>>
  readonly semanticSiteCount: number
  readonly groupCount: number
  readonly statusCounts: Readonly<Record<string, number>>
  readonly readinessProofCount: number
  readonly readinessGapCount: number
  readonly criticalGapCount: number
  readonly gaps: readonly Readonly<Record<string, unknown>>[]
  readonly readinessProofs: readonly ReadinessEvidence[]
  readonly readinessGaps: readonly ReadinessEvidence[]
  readonly limitations: readonly Readonly<Record<string, unknown>>[]
  readonly sites: readonly {
    readonly source: { readonly file: string; readonly line: number }
    readonly correctnessFromElapsedTime: boolean
  }[]
  readonly problems: readonly string[]
}

interface BaseAuditModule {
  buildProductionTimeInventory(): unknown
}

interface SemanticAuditModule {
  evaluateProductionTimeSemantics(
    baseInventory: unknown,
    manifest: TemporalManifest,
    mode: AuditMode,
  ): TemporalReport
}

let baseInventory: unknown
let manifest: TemporalManifest
let evaluateProductionTimeSemantics: SemanticAuditModule['evaluateProductionTimeSemantics']

beforeAll(async () => {
  const loadedBaseAudit: unknown = await import(BASE_AUDIT_URL)
  const loadedSemanticAudit: unknown = await import(SEMANTIC_AUDIT_URL)
  const loadedManifest: unknown = await import(MANIFEST_URL)
  const baseAudit = loadedBaseAudit as BaseAuditModule
  const semanticAudit = loadedSemanticAudit as SemanticAuditModule
  manifest = loadedManifest as TemporalManifest
  evaluateProductionTimeSemantics = semanticAudit.evaluateProductionTimeSemantics
  baseInventory = baseAudit.buildProductionTimeInventory()
})

describe('production temporal semantics meta-audit', () => {
  it('covers every exact timer, duration, candidate retry loop, and maintenance path while preserving gaps', () => {
    const report = runAudit('inventory')

    expect(report).toMatchObject({
      ok: true,
      structurallyValid: true,
      baseCounts: {
        schedulers: 56,
        durations: 46,
        asyncRaces: 7,
        retryLoops: 92,
        maintenanceCommands: 6,
      },
      semanticSiteCount: 207,
      groupCount: 40,
      statusCounts: { covered: 207, gap: 0 },
      readinessProofCount: 1,
      readinessGapCount: 0,
      criticalGapCount: 0,
      problems: [],
    })
    expect(report.gaps).toEqual([])
    expect(report.readinessProofs).toHaveLength(1)
    const readinessProof = report.readinessProofs[0]
    expect(readinessProof?.group).toBe('active-stream-reload-first-gesture-browser-proof')
    expect(readinessProof?.timerRelationship).toBe('source-closed-browser-proof-closed')
    expect(readinessProof?.evidence).toContainEqual({
      path: 'src/app/WorkspaceBootstrap.tsx',
      locator: 'data-presentation="nonblocking"',
    })
    expect(
      readinessProof?.evidence.some((row) => row.path === 'src/store/workspace-runtime-control.ts'),
    ).toBe(true)
    expect(readinessProof?.acceptanceEvidence).toEqual([
      {
        path: 'tests/e2e/reactive-storage-stress.spec.ts',
        locator:
          'reload during an active stream keeps pure UI controls actionable within bounded latency while opening is pending',
      },
    ])
    expect(report.readinessGaps).toEqual([])
    expect(report.limitations).toHaveLength(4)
    expect(report.sites).toHaveLength(207)
    expect(
      report.sites.every(
        (site) =>
          site.source.file.startsWith('src/') &&
          site.source.line > 0 &&
          site.correctnessFromElapsedTime === false,
      ),
    ).toBe(true)
  })

  it('makes an explicit semantic gap fatal only in enforce mode', () => {
    const groups = mutateGroups('workspace-runtime-transition-admission', (group) => ({
      ...group,
      status: 'gap',
      criticalOutcomes: ['shell-clickability'],
      gapRationale: 'Synthetic meta-audit gap.',
    }))
    const inventory = runAudit('inventory', { groups })
    const enforce = runAudit('enforce', { groups })
    const expectedGapCount = Object.values(
      groups.find((group) => group.id === 'workspace-runtime-transition-admission')?.sites ?? {},
    ).flat().length

    expect(inventory.ok).toBe(true)
    expect(inventory.structurallyValid).toBe(true)
    expect(inventory.gaps).toHaveLength(expectedGapCount)
    expect(enforce.ok).toBe(false)
    expect(enforce.structurallyValid).toBe(true)
    expect(enforce.gaps).toHaveLength(expectedGapCount)
    expect(enforce.problems).toEqual([])
  })

  it('rejects stale exact evidence for the closed first-gesture browser proof', () => {
    const readinessProofs = manifest.TEMPORAL_READINESS_PROOFS.map((proof, proofIndex) =>
      proofIndex === 0
        ? {
            ...proof,
            evidence: proof.evidence.map((item, itemIndex) =>
              itemIndex === 0
                ? { ...item, locator: 'await retiredStorageAdministrationGate()' }
                : item,
            ),
          }
        : proof,
    )
    const report = runAudit('inventory', { readinessProofs })

    expect(report.ok).toBe(false)
    expect(report.problems).toContain(
      'readiness-proofs:active-stream-reload-first-gesture-browser-proof:evidence:0: locator occurrences=0; expected=1',
    )
  })

  it('rejects a syntactically discovered site omitted from the semantic inventory', () => {
    const groups = mutateGroups('http-request-deadlines', (group) => ({
      ...group,
      sites: { ...group.sites, schedulers: (group.sites.schedulers ?? []).slice(1) },
    }))
    const report = runAudit('inventory', { groups })

    expect(report.ok).toBe(false)
    expect(report.problems).toContain(
      'unclassified:schedulers: src/api/client.ts|fetchWithTimeout|setTimeout|timeoutMs|1',
    )
  })

  it('rejects duplicate and stale exact source assignments', () => {
    const duplicate = 'src/api/client.ts|fetchWithTimeout|setTimeout|timeoutMs|1'
    const stale = 'src/api/client.ts|fetchWithTimeout|setTimeout|timeoutMs|2'
    const groups = manifest.TEMPORAL_SEMANTIC_GROUPS.map((group) => {
      if (group.id === 'sse-watchdogs-and-parser') {
        return {
          ...group,
          sites: {
            ...group.sites,
            schedulers: [...(group.sites.schedulers ?? []), duplicate],
          },
        }
      }
      if (group.id === 'http-request-deadlines') {
        return {
          ...group,
          sites: {
            ...group.sites,
            schedulers: [...(group.sites.schedulers ?? []), stale],
          },
        }
      }
      return group
    })
    const report = runAudit('inventory', { groups })

    expect(report.ok).toBe(false)
    expect(report.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('duplicate assignment with http-request-deadlines'),
        expect.stringContaining(
          'stale site: src/api/client.ts|fetchWithTimeout|setTimeout|timeoutMs|2',
        ),
      ]),
    )
  })

  it('rejects elapsed time as successful correctness evidence', () => {
    const groups = mutateGroups('http-request-deadlines', (group) => ({
      ...group,
      correctnessFromElapsedTime: true,
    }))
    const report = runAudit('inventory', { groups })

    expect(report.ok).toBe(false)
    expect(report.problems).toContain(
      'groups:http-request-deadlines: elapsed time may not establish correctness',
    )
  })

  it('rejects laundering a shell, navigation, projection, durability, or run-once time path as covered', () => {
    const groups = mutateGroups('workspace-runtime-transition-admission', (group) => ({
      ...group,
      status: 'covered',
      criticalOutcomes: ['shell-clickability'],
    }))
    const report = runAudit('inventory', { groups })

    expect(report.ok).toBe(false)
    expect(report.problems).toContain(
      'groups:workspace-runtime-transition-admission: critical temporal path must remain an explicit gap',
    )
  })

  it('rejects schedulers without cancellation and unbounded loops without progress evidence', () => {
    const groups = manifest.TEMPORAL_SEMANTIC_GROUPS.map((group) => {
      if (group.id === 'http-request-deadlines') return { ...group, cancellationCleanup: 'none' }
      if (group.id === 'stream-and-text-parser-consumers') {
        return { ...group, progressEvidence: '' }
      }
      return group
    })
    const report = runAudit('inventory', { groups })

    expect(report.ok).toBe(false)
    expect(report.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('scheduler lacks cancellation/cleanup evidence'),
        expect.stringContaining('unbounded loop lacks progress evidence'),
      ]),
    )
  })

  it('rejects maintenance without version/marker/keyset/deadline/index evidence', () => {
    const groups = mutateGroups('run-once-integrity-maintenance', (group) => ({
      ...group,
      boundInputShape: 'batch',
    }))
    const report = runAudit('inventory', { groups })

    expect(report.ok).toBe(false)
    expect(report.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('maintenance needs run-once or indexed bound evidence'),
      ]),
    )
  })
})

function runAudit(
  mode: AuditMode,
  overrides: {
    groups?: readonly SemanticGroup[]
    readinessProofs?: readonly ReadinessEvidence[]
    readinessGaps?: readonly ReadinessEvidence[]
  } = {},
) {
  return evaluateProductionTimeSemantics(
    baseInventory,
    {
      TEMPORAL_SEMANTIC_GROUPS: overrides.groups ?? manifest.TEMPORAL_SEMANTIC_GROUPS,
      TEMPORAL_READINESS_PROOFS: overrides.readinessProofs ?? manifest.TEMPORAL_READINESS_PROOFS,
      TEMPORAL_READINESS_GAPS: overrides.readinessGaps ?? manifest.TEMPORAL_READINESS_GAPS,
      TEMPORAL_SEMANTIC_LIMITATIONS: manifest.TEMPORAL_SEMANTIC_LIMITATIONS,
    },
    mode,
  )
}

function mutateGroups(
  groupId: string,
  mutation: (group: SemanticGroup) => SemanticGroup,
): SemanticGroup[] {
  return manifest.TEMPORAL_SEMANTIC_GROUPS.map((group) =>
    group.id === groupId ? mutation(group) : group,
  )
}
