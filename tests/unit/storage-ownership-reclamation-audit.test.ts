import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const AUDIT_URL = pathToFileURL(
  resolve(ROOT, 'scripts/audit-storage-ownership-reclamation.mjs'),
).href
const INVENTORY_URL = pathToFileURL(
  resolve(ROOT, 'scripts/storage-ownership-reclamation-inventory.mjs'),
).href
interface StorageOwnershipReclamationReport {
  ok: boolean
  structurallyValid: boolean
  guaranteeClosed: boolean
  runtimeProved: boolean | null
  tableCount: number
  schemaClassCounts: Record<string, number>
  dataClassCounts: Record<string, number>
  compactionActionCounts: Record<string, number>
  interchangeActionCounts: Record<string, number>
  namespaceCount: number
  lifecycleCount: number
  coordinationCount: number
  gapCount: number
  acceptanceCount: number
  directWebStorageOwnerCount: number
  directBroadcastOwnerCount: number
  gaps: Array<{ id: string; rationale: string; path: string }>
  problems: string[]
}
let evaluateStorageOwnershipReclamation: (
  root: string,
  inventory: unknown,
  mode: 'inventory' | 'enforce',
) => StorageOwnershipReclamationReport
let defaultInventory: unknown

beforeAll(async () => {
  evaluateStorageOwnershipReclamation = (
    (await import(AUDIT_URL)) as {
      evaluateStorageOwnershipReclamation: typeof evaluateStorageOwnershipReclamation
    }
  ).evaluateStorageOwnershipReclamation
  defaultInventory = await import(INVENTORY_URL)
})

describe('storage ownership and reclamation architecture audit', () => {
  it('keeps every physical table, origin namespace, and lifecycle mechanism inventoried', async () => {
    const result = await runAudit('inventory')

    expect(result.status).toBe(0)
    expect(result.report).toMatchObject({
      ok: true,
      structurallyValid: true,
      guaranteeClosed: false,
      runtimeProved: null,
      tableCount: 45,
      schemaClassCounts: { canonical: 22, repairable: 23 },
      dataClassCounts: {
        authoritative: 18,
        cache: 6,
        derived: 16,
        ephemeral: 1,
        journal: 4,
      },
      compactionActionCounts: {
        copy: 32,
        drop: 5,
        'filtered-copy': 4,
        'preserve-destination': 1,
        seed: 3,
      },
      interchangeActionCounts: { omit: 8, portable: 18, rebuild: 15, seed: 4 },
      namespaceCount: 20,
      lifecycleCount: 18,
      coordinationCount: 6,
      gapCount: 5,
      acceptanceCount: 9,
      directWebStorageOwnerCount: 9,
      directBroadcastOwnerCount: 4,
      problems: [],
    })
    expect(result.report.gaps.map((gap) => gap.id)).toEqual(
      expect.arrayContaining([
        'compaction-quiesces-whole-runtime',
        'quota-estimate-cannot-prove-reclamation',
      ]),
    )
  })

  it('keeps every documented architecture gap fatal in enforce mode', async () => {
    const result = await runAudit('enforce')

    expect(result.status).toBe(1)
    expect(result.report.ok).toBe(false)
    expect(result.report.structurallyValid).toBe(true)
    expect(result.report.gapCount).toBe(5)
    expect(result.report.problems).toEqual([])
  })

  it('rejects a missing table and manifest policy drift', async () => {
    const inventory = writeInventory(`
import * as base from ${JSON.stringify(INVENTORY_URL)}
export const STORAGE_TABLE_OWNERSHIP = base.STORAGE_TABLE_OWNERSHIP
  .filter((entry) => entry.name !== 'attachmentBlobs')
  .map((entry) => entry.name === 'attachments'
    ? { ...entry, schemaClass: 'repairable', dataClass: 'derived' }
    : entry.name === 'browserLocks'
      ? { ...entry, compaction: 'copy', interchange: 'portable' }
      : entry)
${unchangedExports('tables')}
`)
    const result = await runAudit('inventory', inventory)

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'tables: missing name: attachmentBlobs',
        'tables: canonical order changed',
        'tables:attachments: schemaClass=repairable; source=canonical',
        'tables:attachments: dataClass=derived; source=authoritative',
        'tables:browserLocks: compaction=copy; source=seed',
        'tables:browserLocks: interchange=portable; source=omit',
      ]),
    )
  })

  it('rejects incomplete owner policy, missing test evidence, and invented gap linkage', async () => {
    const inventory = writeInventory(`
import * as base from ${JSON.stringify(INVENTORY_URL)}
export const STORAGE_TABLE_OWNERSHIP = base.STORAGE_TABLE_OWNERSHIP.map((entry) => entry.name === 'drafts'
  ? { ...entry, debtPolicy: 'best-effort', testEvidence: [], gapIds: ['invented-gap'] }
  : entry)
${unchangedExports('tables')}
`)
    const result = await runAudit('inventory', inventory)

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'tables:drafts: debtPolicy: invalid value: best-effort',
        'tables:drafts: testEvidence: must be a non-empty array',
        'tables:drafts: gapIds: unknown gap: invented-gap',
      ]),
    )
  })

  it('rejects a missing namespace, a stale key, and an uncovered direct storage owner', async () => {
    const inventory = writeInventory(`
import * as base from ${JSON.stringify(INVENTORY_URL)}
export const ORIGIN_STORAGE_NAMESPACES = base.ORIGIN_STORAGE_NAMESPACES
  .filter((entry) => entry.id !== 'local-workspace-change')
  .map((entry) => entry.id === 'idb-control' ? { ...entry, key: 'retired-control-db' } : entry)
${unchangedExports('namespaces')}
`)
    const result = await runAudit('inventory', inventory)

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'namespaces: missing id: local-workspace-change',
        'namespaces: canonical order changed',
        'namespaces:idb-control: key literal occurrences=0; expected>=1',
        'namespaces: unowned direct web-storage access: src/store/broadcast.ts',
      ]),
    )
  })

  it('rejects a missing lifecycle path and a stale exact source locator', async () => {
    const inventory = writeInventory(`
import * as base from ${JSON.stringify(INVENTORY_URL)}
export const STORAGE_LIFECYCLE_PATHS = base.STORAGE_LIFECYCLE_PATHS
  .filter((entry) => entry.id !== 'idle-compaction-admission')
  .map((entry) => entry.id === 'quota-probe'
    ? { ...entry, locator: 'retiredQuotaProbe()' }
    : entry)
${unchangedExports('lifecycles')}
`)
    const result = await runAudit('inventory', inventory)

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'lifecycles: missing id: idle-compaction-admission',
        'lifecycles: canonical order changed',
        'lifecycles:quota-probe: locator occurrences=0; expected=1',
      ]),
    )
  })

  it('rejects deleting a known gap while table and lifecycle evidence still depend on it', async () => {
    const inventory = writeInventory(`
import * as base from ${JSON.stringify(INVENTORY_URL)}
export const STORAGE_RECLAMATION_GAPS = base.STORAGE_RECLAMATION_GAPS
  .filter((entry) => entry.id !== 'logical-debt-does-not-measure-physical-amplification')
${unchangedExports('gaps')}
`)
    const result = await runAudit('inventory', inventory)

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'gaps: missing id: logical-debt-does-not-measure-physical-amplification',
        'gaps: canonical order changed',
        'tables:attachmentBlobs: gapIds: unknown gap: logical-debt-does-not-measure-physical-amplification',
        'lifecycles:compaction-threshold: gapIds: unknown gap: logical-debt-does-not-measure-physical-amplification',
      ]),
    )
  })
})

function unchangedExports(changed: 'tables' | 'namespaces' | 'lifecycles' | 'gaps'): string {
  const exports = {
    tables: 'export const STORAGE_TABLE_OWNERSHIP = base.STORAGE_TABLE_OWNERSHIP',
    namespaces: 'export const ORIGIN_STORAGE_NAMESPACES = base.ORIGIN_STORAGE_NAMESPACES',
    lifecycles: 'export const STORAGE_LIFECYCLE_PATHS = base.STORAGE_LIFECYCLE_PATHS',
    gaps: 'export const STORAGE_RECLAMATION_GAPS = base.STORAGE_RECLAMATION_GAPS',
  }
  return [
    changed === 'tables' ? '' : exports.tables,
    changed === 'namespaces' ? '' : exports.namespaces,
    changed === 'lifecycles' ? '' : exports.lifecycles,
    'export const STORAGE_COORDINATION_MECHANISMS = base.STORAGE_COORDINATION_MECHANISMS',
    changed === 'gaps' ? '' : exports.gaps,
    'export const STORAGE_RECLAMATION_ACCEPTANCE = base.STORAGE_RECLAMATION_ACCEPTANCE',
  ]
    .filter(Boolean)
    .join('\n')
}

async function runAudit(mode: 'inventory' | 'enforce', inventory?: string) {
  const inventoryModule: unknown = inventory
    ? await import(/* @vite-ignore */ inventory)
    : defaultInventory
  const report = evaluateStorageOwnershipReclamation(ROOT, inventoryModule, mode)
  return {
    status: report.ok ? 0 : 1,
    report,
  }
}

function writeInventory(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}
