import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  auditE2eBrowserStorage,
  type E2eBrowserStorageSite,
  validateE2eBrowserStorageInventory,
} from '../../scripts/audit-e2e-browser-storage.mjs'

const ROOT = resolve(__dirname, '../..')

describe('E2E raw browser storage inventory', () => {
  it('allows every semantic AST site exactly once with operation detail', () => {
    const result = auditE2eBrowserStorage(ROOT)
    const discovered = result.sites

    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.discoveredSiteCount).toBe(discovered.length)
    expect(result.allowedSiteCount).toBe(discovered.length)
    expect(result.uniqueAllowedSiteCount).toBe(discovered.length)
    expect(result.cleanupEvidenceSiteCount).toBeGreaterThan(0)
    expect(result.unpairedOpenSiteIds).toEqual([])
    expect(result.readwriteTransactionCount).toBeGreaterThan(0)
    expect(discovered).toContainEqual(
      expect.objectContaining({
        path: 'tests/e2e/large-workspace-startup.spec.ts',
        owner: 'function:installStartupProbe',
        access: 'instrumentation',
        operation: 'indexeddb.transaction.addEventListener',
      }),
    )
    expect(
      (
        [
          'close',
          'delete',
          'enumeration',
          'instrumentation',
          'open',
          'read',
          'selection',
          'transaction',
          'write',
        ] as const
      ).every((access) => typeof result.accessCounts[access] === 'number'),
    ).toBe(true)
    expect(
      discovered.every(
        (site) =>
          site.id.includes(site.path) &&
          site.id.includes('owner=') &&
          site.id.includes(`operation=${site.operation}`) &&
          site.id.includes('mode=') &&
          site.id.includes('store=') &&
          site.id.includes(`occurrence=${site.occurrence}`),
      ),
    ).toBe(true)
  })

  it('fails closed on inventory drift, duplicates, and missing metadata', () => {
    const read = site('read-site', 'read')
    const write = site('write-site', 'write')
    const unknown = site('unknown-site', 'unknown')
    const cleanup = cleanupSite('cleanup-site', ['clear-data'])
    const result = validateE2eBrowserStorageInventory(
      {
        schemaVersion: 2,
        allowances: [
          {
            purpose: 'read-only-assertion',
            mutationScope: { kind: 'none', targets: [] },
            cleanupRestoreObligation: '',
            publicUiCannotExpress: '',
            siteIds: [write.id, write.id, unknown.id, 'stale-site'],
            cleanupEvidence: {
              siteIds: [cleanup.id],
              fixtureOwners: [],
              processOwned: false,
            },
          },
        ],
      },
      [read, write, unknown],
      [cleanup],
    )
    const codes = new Set(result.violations.map((violation) => violation.code))

    expect(result.ok).toBe(false)
    expect(result.missingSiteIds).toEqual([read.id])
    expect(result.staleSiteIds).toEqual(['stale-site'])
    expect(result.duplicateSiteIds).toEqual([{ id: write.id, count: 2 }])
    expect(codes).toEqual(
      new Set([
        'allowance-duplicate',
        'allowance-metadata-missing',
        'allowance-missing',
        'allowance-mutation-scope-understated',
        'allowance-purpose-contradiction',
        'allowance-stale',
        'storage-operation-unclassified',
      ]),
    )
  })

  it('rejects missing, stale, incompatible, and unpaired cleanup evidence', () => {
    const open = site('open-site', 'open', 'indexeddb.factory.open')
    const read = site('read-site', 'read')
    const write = site('write-site', 'write')
    const unscopedWrite = { ...site('unscoped-write', 'write'), owner: 'test:unscoped' }
    const foreignCleanup = cleanupSite('foreign-cleanup', ['clear-data'])
    const result = validateE2eBrowserStorageInventory(
      {
        schemaVersion: 2,
        allowances: [
          {
            purpose: 'read-only-assertion',
            mutationScope: { kind: 'none', targets: [] },
            cleanupRestoreObligation: 'Close the database handle.',
            publicUiCannotExpress: 'The exact stored row is not exposed by public UI.',
            siteIds: [open.id, read.id],
            cleanupEvidence: {
              siteIds: [read.id, 'missing-cleanup-site'],
              fixtureOwners: [],
              processOwned: false,
            },
          },
          {
            purpose: 'fault-injection',
            mutationScope: { kind: 'stores', targets: ['messages'] },
            cleanupRestoreObligation: 'Clear the injected row.',
            publicUiCannotExpress: 'The public editor rejects this invalid row.',
            siteIds: [write.id],
          },
          {
            purpose: 'fault-injection',
            mutationScope: { kind: 'stores', targets: ['messages'] },
            cleanupRestoreObligation: 'Clear the injected row.',
            publicUiCannotExpress: 'The public editor rejects this invalid row.',
            siteIds: [unscopedWrite.id],
            cleanupEvidence: {
              siteIds: [foreignCleanup.id],
              fixtureOwners: [],
              processOwned: false,
            },
          },
        ],
      },
      [open, read, write, unscopedWrite],
      [foreignCleanup],
    )
    const codes = new Set(result.violations.map((violation) => violation.code))

    expect(result.unpairedOpenSiteIds).toEqual([open.id])
    expect(codes).toEqual(
      new Set([
        'cleanup-evidence-effect-missing',
        'cleanup-evidence-missing',
        'cleanup-evidence-mutation-unscoped',
        'cleanup-evidence-open-unpaired',
        'cleanup-evidence-site-incompatible',
        'cleanup-evidence-site-stale',
        'indexeddb-open-unpaired',
      ]),
    )
  })

  it('accepts an exact compatible fixture owner as cleanup evidence', () => {
    const open = site('open-site', 'open', 'indexeddb.factory.open')
    const close = site('close-site', 'close', 'indexeddb.database.close')
    const result = validateE2eBrowserStorageInventory(
      {
        schemaVersion: 2,
        allowances: [
          {
            purpose: 'read-only-assertion',
            mutationScope: { kind: 'none', targets: [] },
            cleanupRestoreObligation: 'Close the database handle.',
            publicUiCannotExpress: 'The exact stored row is not exposed by public UI.',
            siteIds: [open.id, close.id],
            cleanupEvidence: {
              siteIds: [],
              fixtureOwners: ['tests/e2e/example.spec.ts::owner=test%3Aexample'],
              processOwned: false,
            },
          },
        ],
      },
      [open, close],
    )

    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('rejects generic read-only grouping across unrelated owner trees', () => {
    const first = site('first-read', 'read')
    const second = { ...site('second-read', 'read'), owner: 'test:other' }
    const result = validateE2eBrowserStorageInventory(
      {
        schemaVersion: 2,
        allowances: [
          {
            purpose: 'read-only-assertion',
            mutationScope: { kind: 'none', targets: [] },
            cleanupRestoreObligation: 'Leave storage unchanged.',
            publicUiCannotExpress: 'The exact stored rows are not exposed by public UI.',
            siteIds: [first.id, second.id],
          },
        ],
      },
      [first, second],
    )

    expect(result.violations.map((violation) => violation.code)).toEqual([
      'allowance-read-scope-mixed',
    ])
  })

  it('permits an unpaired open only with an explicit process owner and reason', () => {
    const open = site('open-site', 'open', 'indexeddb.factory.open')
    const teardown = cleanupSite('teardown-site', ['close-database'])
    const result = validateE2eBrowserStorageInventory(
      {
        schemaVersion: 2,
        allowances: [
          {
            purpose: 'fault-injection',
            mutationScope: { kind: 'none', targets: [] },
            cleanupRestoreObligation: 'The process owner releases the handle.',
            publicUiCannotExpress: 'The public UI cannot expose the physical handle.',
            siteIds: [open.id],
            cleanupEvidence: {
              siteIds: [],
              fixtureOwners: ['tests/e2e/example.spec.ts::owner=test%3Aexample'],
              processOwned: true,
              processOwnerReason: 'The test-scoped browser context owns this delayed handle.',
            },
          },
        ],
      },
      [open],
      [teardown],
    )

    expect(result.violations).toEqual([])
    expect(result.unpairedOpenSiteIds).toEqual([])
  })
})

function site(id: string, access: string, operation?: string): E2eBrowserStorageSite {
  return {
    id,
    path: 'tests/e2e/example.spec.ts',
    owner: 'test:example',
    api: 'indexeddb',
    access,
    operation:
      operation ??
      (access === 'write'
        ? 'indexeddb.put'
        : access === 'unknown'
          ? 'indexeddb.unclassified'
          : 'indexeddb.get'),
    mode: access === 'write' ? 'readwrite' : 'readonly',
    store: 'messages',
    line: 1,
    column: 1,
    occurrence: 1,
  }
}

function cleanupSite(id: string, cleanupEffects: string[]): E2eBrowserStorageSite {
  return {
    ...site(id, 'cleanup', 'fixture.clear-indexeddb'),
    api: 'fixture-lifecycle',
    cleanupEffects,
  }
}
