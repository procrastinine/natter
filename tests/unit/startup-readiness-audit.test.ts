import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const AUDIT_URL = pathToFileURL(resolve(ROOT, 'scripts/audit-startup-readiness.mjs')).href
const INVENTORY_URL = pathToFileURL(resolve(ROOT, 'scripts/startup-readiness-inventory.mjs')).href
interface StartupReadinessReport {
  ok: boolean
  structurallyValid: boolean
  guaranteeClosed: boolean
  stageCount: number
  entryPathCount: number
  reopenStageCount: number
  hiddenLifecycleStageCount: number
  resourceCount: number
  resourceActivationHookCount: number
  reconciliationParticipantCount: number
  capabilityCount: number
  gapCount: number
  acceptanceCount: number
  gaps: Array<{ id: string; rationale: string; path: string }>
  resources: Array<{ id: string; phase: string; hooks: string[]; owner: string }>
  reconciliationParticipants: Array<{ id: string; hooks: string[]; owner: string }>
  problems: string[]
}
let evaluateStartupReadiness: (
  root: string,
  inventory: unknown,
  mode: 'inventory' | 'enforce',
) => StartupReadinessReport
let defaultInventory: unknown

beforeAll(async () => {
  evaluateStartupReadiness = (
    (await import(AUDIT_URL)) as {
      evaluateStartupReadiness: typeof evaluateStartupReadiness
    }
  ).evaluateStartupReadiness
  defaultInventory = await import(INVENTORY_URL)
})

describe('startup readiness architecture audit', () => {
  it('keeps the exact positive startup, resource, participant, and capability inventories', async () => {
    const result = await runAudit('inventory')

    expect(result.status).toBe(0)
    expect(result.report).toMatchObject({
      ok: true,
      structurallyValid: true,
      guaranteeClosed: true,
      stageCount: 13,
      entryPathCount: 9,
      reopenStageCount: 8,
      hiddenLifecycleStageCount: 6,
      resourceCount: 17,
      resourceActivationHookCount: 5,
      reconciliationParticipantCount: 1,
      capabilityCount: 14,
      gapCount: 0,
      acceptanceCount: 7,
      gaps: [],
      problems: [],
    })
    expect(result.report.resources.map((resource) => resource.id)).toContain(
      'broadcast-fallback-verification',
    )
    expect(result.report.resources.map((resource) => resource.id)).not.toContain(
      'broadcast-fallback-poll',
    )
    expect(result.report.reconciliationParticipants).toEqual([
      {
        id: 'tab-session',
        hooks: ['reconcile'],
        owner: 'src/store/browser-workspace-lifecycle.ts',
      },
    ])
  })

  it('keeps enforce mode green only after every declared readiness gap is closed', async () => {
    const result = await runAudit('enforce')

    expect(result.status).toBe(0)
    expect(result.report).toMatchObject({
      ok: true,
      structurallyValid: true,
      guaranteeClosed: true,
      gapCount: 0,
      problems: [],
    })
  })

  it('rejects a missing or reordered opening stage', async () => {
    const inventory = writeInventory(`
import * as base from ${JSON.stringify(INVENTORY_URL)}
export const STARTUP_OPEN_SEQUENCE = base.STARTUP_OPEN_SEQUENCE.slice(1)
export const STARTUP_ENTRY_PATHS = base.STARTUP_ENTRY_PATHS
export const UNIFIED_REOPEN_SEQUENCE = base.UNIFIED_REOPEN_SEQUENCE
export const HIDDEN_LIFECYCLE_SEQUENCE = base.HIDDEN_LIFECYCLE_SEQUENCE
export const STARTUP_RUNTIME_RESOURCES = base.STARTUP_RUNTIME_RESOURCES
export const STARTUP_RECONCILIATION_PARTICIPANTS = base.STARTUP_RECONCILIATION_PARTICIPANTS
export const STARTUP_CAPABILITIES = base.STARTUP_CAPABILITIES
export const STARTUP_READINESS_GAPS = base.STARTUP_READINESS_GAPS
export const STARTUP_READINESS_ACCEPTANCE = base.STARTUP_READINESS_ACCEPTANCE
`)
    const result = await runAudit('inventory', inventory)

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'stages: missing id: lifecycle-owner-installed',
        'stages: canonical order changed',
      ]),
    )
  })

  it('rejects resource phase, lifecycle-hook, or owner drift', async () => {
    const inventory = writeInventory(`
import * as base from ${JSON.stringify(INVENTORY_URL)}
export const STARTUP_OPEN_SEQUENCE = base.STARTUP_OPEN_SEQUENCE
export const STARTUP_ENTRY_PATHS = base.STARTUP_ENTRY_PATHS
export const UNIFIED_REOPEN_SEQUENCE = base.UNIFIED_REOPEN_SEQUENCE
export const HIDDEN_LIFECYCLE_SEQUENCE = base.HIDDEN_LIFECYCLE_SEQUENCE
export const STARTUP_RUNTIME_RESOURCES = base.STARTUP_RUNTIME_RESOURCES.map((resource) => resource.id === 'stream-recovery'
  ? { ...resource, phase: 'query', hooks: ['resume'], owner: 'src/store/broadcast.ts' }
  : resource)
export const STARTUP_RECONCILIATION_PARTICIPANTS = base.STARTUP_RECONCILIATION_PARTICIPANTS
export const STARTUP_CAPABILITIES = base.STARTUP_CAPABILITIES
export const STARTUP_READINESS_GAPS = base.STARTUP_READINESS_GAPS
export const STARTUP_READINESS_ACCEPTANCE = base.STARTUP_READINESS_ACCEPTANCE
`)
    const result = await runAudit('inventory', inventory)

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'resources:stream-recovery: phase=query; source=producer',
        'resources:stream-recovery: hooks=resume; source=activate,attach',
        'resources:stream-recovery: owner=src/store/broadcast.ts; source=src/store/browser-workspace-lifecycle.ts',
      ]),
    )
  })

  it('rejects reconciliation-participant hook or owner drift', async () => {
    const inventory = writeInventory(`
import * as base from ${JSON.stringify(INVENTORY_URL)}
export const STARTUP_OPEN_SEQUENCE = base.STARTUP_OPEN_SEQUENCE
export const STARTUP_ENTRY_PATHS = base.STARTUP_ENTRY_PATHS
export const UNIFIED_REOPEN_SEQUENCE = base.UNIFIED_REOPEN_SEQUENCE
export const HIDDEN_LIFECYCLE_SEQUENCE = base.HIDDEN_LIFECYCLE_SEQUENCE
export const STARTUP_RUNTIME_RESOURCES = base.STARTUP_RUNTIME_RESOURCES
export const STARTUP_RECONCILIATION_PARTICIPANTS = base.STARTUP_RECONCILIATION_PARTICIPANTS.map((participant) => ({
  ...participant,
  hooks: [],
  owner: 'src/store/broadcast.ts',
}))
export const STARTUP_CAPABILITIES = base.STARTUP_CAPABILITIES
export const STARTUP_READINESS_GAPS = base.STARTUP_READINESS_GAPS
export const STARTUP_READINESS_ACCEPTANCE = base.STARTUP_READINESS_ACCEPTANCE
`)
    const result = await runAudit('inventory', inventory)

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'reconciliation-participants:tab-session: hooks=; source=reconcile',
        'reconciliation-participants:tab-session: owner=src/store/broadcast.ts; source=src/store/browser-workspace-lifecycle.ts',
      ]),
    )
  })

  it('rejects missing capabilities and invented readiness gates', async () => {
    const inventory = writeInventory(`
import * as base from ${JSON.stringify(INVENTORY_URL)}
export const STARTUP_OPEN_SEQUENCE = base.STARTUP_OPEN_SEQUENCE
export const STARTUP_ENTRY_PATHS = base.STARTUP_ENTRY_PATHS
export const UNIFIED_REOPEN_SEQUENCE = base.UNIFIED_REOPEN_SEQUENCE
export const HIDDEN_LIFECYCLE_SEQUENCE = base.HIDDEN_LIFECYCLE_SEQUENCE
export const STARTUP_RUNTIME_RESOURCES = base.STARTUP_RUNTIME_RESOURCES
export const STARTUP_RECONCILIATION_PARTICIPANTS = base.STARTUP_RECONCILIATION_PARTICIPANTS
export const STARTUP_CAPABILITIES = base.STARTUP_CAPABILITIES
  .filter((capability) => capability.id !== 'active-stream-control')
  .map((capability) => capability.id === 'shell-chrome'
    ? { ...capability, targetGates: ['arbitrary-timeout-finished'] }
    : capability)
export const STARTUP_READINESS_GAPS = base.STARTUP_READINESS_GAPS
export const STARTUP_READINESS_ACCEPTANCE = base.STARTUP_READINESS_ACCEPTANCE
`)
    const result = await runAudit('inventory', inventory)

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'capabilities: missing id: active-stream-control',
        'capabilities:shell-chrome:target: unknown gate: arbitrary-timeout-finished',
        'capabilities:shell-chrome: current and target gates differ',
      ]),
    )
  })

  it('rejects a stale capability owner or source locator', async () => {
    const inventory = writeInventory(`
import * as base from ${JSON.stringify(INVENTORY_URL)}
export const STARTUP_OPEN_SEQUENCE = base.STARTUP_OPEN_SEQUENCE
export const STARTUP_ENTRY_PATHS = base.STARTUP_ENTRY_PATHS
export const UNIFIED_REOPEN_SEQUENCE = base.UNIFIED_REOPEN_SEQUENCE
export const HIDDEN_LIFECYCLE_SEQUENCE = base.HIDDEN_LIFECYCLE_SEQUENCE
export const STARTUP_RUNTIME_RESOURCES = base.STARTUP_RUNTIME_RESOURCES
export const STARTUP_RECONCILIATION_PARTICIPANTS = base.STARTUP_RECONCILIATION_PARTICIPANTS
export const STARTUP_CAPABILITIES = base.STARTUP_CAPABILITIES.map((capability) => capability.id === 'opening-status'
  ? { ...capability, owner: '', locator: 'retiredRootReadinessCondition()' }
  : capability)
export const STARTUP_READINESS_GAPS = base.STARTUP_READINESS_GAPS
export const STARTUP_READINESS_ACCEPTANCE = base.STARTUP_READINESS_ACCEPTANCE
`)
    const result = await runAudit('inventory', inventory)

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'capabilities:opening-status: locator occurrences=0; expected=1',
        'capabilities:opening-status: owner must be non-empty',
      ]),
    )
  })
})

async function runAudit(mode: 'inventory' | 'enforce', inventory?: string) {
  const inventoryModule: unknown = inventory
    ? await import(/* @vite-ignore */ inventory)
    : defaultInventory
  const report = evaluateStartupReadiness(ROOT, inventoryModule, mode)
  return {
    status: report.ok ? 0 : 1,
    report,
  }
}

function writeInventory(source: string) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}
