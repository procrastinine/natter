import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discoverProductionCoordination,
  evaluateProductionCoordination,
  type ProductionCoordinationInventory,
} from '../../scripts/audit-production-coordination.mjs'
import * as canonicalInventory from '../../scripts/production-coordination-inventory.mjs'

interface AuditReport {
  sourceFiles: number
  architectureViolations: string[]
  problems: string[]
  moduleMutableState: AuditSection
  retainedCollections: AuditSection
  lifecycleExternalIngress: AuditSection
  lifecycleDirectCalls: AuditSection
}

interface AuditSection {
  count: number
  unclassified: string[]
  stale: string[]
  entries: Array<{
    id: string
    domain: string
    scope: string
    bound: string
    cleanup: string
    installation?: string
    removalOwner?: string
    stage?: string
    ownership?: string
  }>
}

const repoRoot = resolve(__dirname, '../..')
const discovery = discoverProductionCoordination({ root: repoRoot })

describe('production coordination audit', () => {
  it('emits a deterministic report for the same exact source inventory', () => {
    const first = runAudit()
    const second = runAudit()

    expect(first.status).toBe(0)
    expect(second.status).toBe(0)
    expect(second.stdout).toBe(first.stdout)
  })

  it('classifies every production coordination owner with explicit retention metadata', () => {
    const result = runAudit()
    const report = parseReport(result.stdout)

    expect(result.status).toBe(0)
    expect(report.problems).toEqual([])
    expect(report.architectureViolations).toEqual([])
    expect(report.sourceFiles).toBeGreaterThan(0)
    for (const section of sections(report)) {
      expect(section.count).toBe(section.entries.length)
      expect(section.unclassified).toEqual([])
      expect(section.stale).toEqual([])
      expect(
        section.entries.every(
          (entry) =>
            entry.domain.length > 0 &&
            entry.scope.length > 0 &&
            entry.bound.length > 0 &&
            entry.cleanup.length > 0,
        ),
      ).toBe(true)
    }
    expect(
      report.lifecycleExternalIngress.entries.every(
        (entry) => entry.installation && entry.removalOwner,
      ),
    ).toBe(true)
    expect(
      report.lifecycleDirectCalls.entries.every((entry) => entry.stage && entry.ownership),
    ).toBe(true)
    expect(report.lifecycleDirectCalls.entries.map((entry) => entry.id)).toContain(
      'src/store/workspace-runtime-control.ts|beginWorkspaceRuntimeQuiesceWithMode|workspaceRuntimeKernel.beginQuiesce|1',
    )
  })

  it('fails when a discovered exact owner is no longer classified', () => {
    const inventory = writeInventoryOverride('missing')
    const result = runAudit(inventory)
    const report = parseReport(result.stdout)

    expect(result.status).toBe(1)
    expect(report.moduleMutableState.unclassified).toHaveLength(1)
    expect(report.problems).toContain(
      `moduleMutableState: unclassified: ${report.moduleMutableState.unclassified[0]}`,
    )
  })

  it('fails when an exact inventory owner becomes stale', () => {
    const inventory = writeInventoryOverride('stale')
    const result = runAudit(inventory)
    const report = parseReport(result.stdout)

    expect(result.status).toBe(1)
    expect(report.moduleMutableState.stale).toEqual(['src/store/nonexistent.ts#staleOwner'])
    expect(report.problems).toContain(
      'moduleMutableState: stale: src/store/nonexistent.ts#staleOwner',
    )
    expect(report.problems).toContain(
      'moduleMutableState: src/store/nonexistent.ts#staleOwner: module missing from canonical domain inventory',
    )
    expect(result.stderr).not.toContain('CoordinationInventoryDomainMissing')
  })

  it('rejects declaration-owned domains so the module inventory remains the sole authority', () => {
    const inventory = writeInventoryOverride('manual-domain')
    const result = runAudit(inventory)
    const report = parseReport(result.stdout)

    expect(result.status).toBe(1)
    expect(
      report.problems.some((problem) => problem.endsWith(': declaration must not define domain')),
    ).toBe(true)
  })

  it('promotes an explicitly declared coordination gap to an architecture violation', () => {
    const inventory = writeInventoryOverride('gap')
    const result = runAudit(inventory)
    const report = parseReport(result.stdout)
    const expected =
      'lifecycleDirectCalls: src/app/WorkspaceBootstrap.tsx|useEffect<callback>|registerWorkspacePresentationRoot|1: GAP: disposer ownership unproven'

    expect(result.status).toBe(1)
    expect(report.architectureViolations).toContain(expected)
    expect(report.problems).toContain(`architecture: ${expected}`)
  })
})

function runAudit(inventory?: ProductionCoordinationInventory) {
  const report = evaluateProductionCoordination({
    discovery,
    inventory: inventory ?? canonicalInventory,
  })
  return {
    status: report.problems.length === 0 ? 0 : 1,
    stdout: JSON.stringify(report, null, 2),
    stderr: '',
  }
}

function parseReport(stdout: string): AuditReport {
  return JSON.parse(stdout) as AuditReport
}

function sections(report: AuditReport): AuditSection[] {
  return [
    report.moduleMutableState,
    report.retainedCollections,
    report.lifecycleExternalIngress,
    report.lifecycleDirectCalls,
  ]
}

function writeInventoryOverride(
  kind: 'gap' | 'manual-domain' | 'missing' | 'stale',
): ProductionCoordinationInventory {
  const moduleMutableState =
    kind === 'missing'
      ? canonicalInventory.MODULE_MUTABLE_STATE.slice(1)
      : kind === 'stale'
        ? [
            ...canonicalInventory.MODULE_MUTABLE_STATE,
            {
              id: 'src/store/nonexistent.ts#staleOwner',
              scope: 'test',
              bound: 'test',
              cleanup: 'test',
            },
          ]
        : kind === 'manual-domain'
          ? canonicalInventory.MODULE_MUTABLE_STATE.map((entry, index) =>
              index === 0 ? { ...entry, domain: 'manual-domain' } : entry,
            )
          : canonicalInventory.MODULE_MUTABLE_STATE
  const lifecycleDirectCalls =
    kind === 'gap'
      ? canonicalInventory.LIFECYCLE_DIRECT_CALLS.map((entry, index) =>
          index === 0 ? { ...entry, gap: 'disposer ownership unproven' } : entry,
        )
      : canonicalInventory.LIFECYCLE_DIRECT_CALLS
  return {
    ...canonicalInventory,
    MODULE_MUTABLE_STATE: moduleMutableState,
    LIFECYCLE_DIRECT_CALLS: lifecycleDirectCalls,
  }
}
