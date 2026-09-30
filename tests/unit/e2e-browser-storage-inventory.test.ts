import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  auditE2eBrowserStorage,
  discoverBrowserFixtureSources,
  type E2eBrowserStorageSite,
  validateE2eBrowserStorageInventory,
  validateNativeFixtureOwnership,
} from '../../scripts/audit-e2e-browser-storage.mjs'

import { VERIFICATION_STAGES } from '../../scripts/run-verification.mjs'

const ROOT = resolve(__dirname, '../..')

describe('E2E raw browser storage inventory', () => {
  it('discovers exact native, facade, purpose, and cleanup semantics on a bounded source fixture', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'natter-native-inventory-'))
    const write = (path: string, text: string) => {
      const target = resolve(root, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text)
    }
    try {
      for (const stage of VERIFICATION_STAGES) {
        const entry = stage.argv[1]
        if (stage.argv[0] === 'node' && entry && !entry.startsWith('node_modules/')) {
          write(entry, 'export {}\n')
        }
      }
      write(
        'tsconfig.app.json',
        JSON.stringify({ compilerOptions: { types: [], lib: ['ES2022', 'DOM'] } }),
      )
      write('inventory.json', JSON.stringify({ schemaVersion: 2, allowances: [] }))
      write(
        'tests/e2e/example.spec.ts',
        `
interface NativeFixtureDatabase {
  completion(transaction: IDBTransaction): Promise<void>
  transaction(stores: string[], mode: IDBTransactionMode): IDBTransaction
}
export function inspectNative(db: IDBDatabase, facade: NativeFixtureDatabase) {
  const read = db.transaction(['messages', 'settings'], 'readonly')
  read.objectStore('messages').index('chatId').getAll('chat')
  read.addEventListener('complete', () => {})
  const write = facade.transaction(['messages'], 'readwrite')
  const messages = write.objectStore('messages')
  void facade.completion(write)
  messages.put({ id: 'first' })
  messages.put({ id: 'second' })
  indexedDB.open('fixture')
  db.close()
  indexedDB.deleteDatabase('fixture')
  globalThis.__natterNativeStorageFixture.active({ purpose: 'read-only-assertion' }, () => {})
  globalThis.__natterNativeStorageFixture.active({ purpose: 'unclassified-purpose' }, () => {})
}
`,
      )
      const result = auditE2eBrowserStorage(root, resolve(root, 'inventory.json'))
      const operationDetails = result.sites
        .map(({ operation, mode, store, occurrence }) =>
          [operation, mode, store, occurrence].join('|'),
        )
        .sort()
      expect(operationDetails).toEqual(
        [
          ['indexeddb.database.transaction', 'readonly', 'messages+settings', 1],
          ['indexeddb.transaction.object-store', 'readonly', 'messages', 1],
          ['indexeddb.object-store.index', 'readonly', 'messages@index:chatId', 1],
          ['indexeddb.getAll', 'readonly', 'messages@index:chatId', 1],
          ['indexeddb.transaction.addEventListener', 'readonly', '<transaction-scope>', 1],
          ['indexeddb.database.transaction', 'readwrite', 'messages', 1],
          ['indexeddb.transaction.object-store', 'readwrite', 'messages', 1],
          ['native-fixture.transaction-completion', null, '<transaction-scope>', 1],
          ['indexeddb.put', 'readwrite', 'messages', 1],
          ['indexeddb.put', 'readwrite', 'messages', 2],
          ['indexeddb.factory.open', null, null, 1],
          ['indexeddb.database.close', null, null, 1],
          ['indexeddb.factory.delete-database', null, null, 1],
          ['native-fixture.active', 'read-only-assertion', '<operation-scope>', 1],
          ['native-fixture.active', 'unclassified-purpose', '<operation-scope>', 1],
        ]
          .map((detail) => detail.join('|'))
          .sort(),
      )
      expect(result.discoveredSiteCount).toBe(result.sites.length)
      expect(result.cleanupEvidenceSiteCount).toBe(2)
      expect(result.readwriteTransactionCount).toBe(1)
      expect(new Set(result.sites.map(({ id }) => id)).size).toBe(result.sites.length)
      for (const site of result.sites) {
        expect(site.path).toBe('tests/e2e/example.spec.ts')
        expect(site.owner).toBe('function:inspectNative')
        expect(site.id).toBe(
          [
            site.path,
            'owner=function%3AinspectNative',
            `operation=${site.operation}`,
            `mode=${site.mode ?? '-'}`,
            `store=${encodeURIComponent(site.store ?? '-')}`,
            `occurrence=${site.occurrence}`,
          ].join('::'),
        )
      }
      expect(result.sites.find((site) => site.mode === 'unclassified-purpose')?.access).toBe(
        'unknown',
      )
      expect(result.ok).toBe(false)
      expect(result.missingSiteIds).toEqual(result.sites.map(({ id }) => id).sort())
      expect(new Set(result.violations.map(({ code }) => code))).toEqual(
        new Set([
          'allowance-missing',
          'native-fixture-open-bypass',
          'native-fixture-delete-bypass',
        ]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('derives mandatory browser profile roots and rejects raw opens and deletes outside their shared owner', () => {
    const sources = discoverBrowserFixtureSources(ROOT)
    expect(sources).toEqual(
      expect.arrayContaining([
        resolve(ROOT, 'scripts/profile-fake-stream.mjs'),
        resolve(ROOT, 'scripts/profile-concurrent-fake-stream.mjs'),
        resolve(ROOT, 'scripts/profile-stream-harness.mjs'),
        resolve(ROOT, 'scripts/native-workspace-storage-fixture.mjs'),
      ]),
    )
    expect(sources).not.toContain(resolve(ROOT, 'scripts/audit-e2e-browser-storage.mjs'))
    const open = site('unowned-open', 'open', 'indexeddb.factory.open')
    expect(validateNativeFixtureOwnership([open])).toEqual([
      expect.objectContaining({ code: 'native-fixture-open-bypass', siteId: open.id }),
    ])
    const remove = site('unowned-delete', 'delete', 'indexeddb.factory.delete-database')
    expect(validateNativeFixtureOwnership([remove])).toEqual([
      expect.objectContaining({ code: 'native-fixture-delete-bypass', siteId: remove.id }),
    ])
    expect(
      validateNativeFixtureOwnership([
        { ...open, path: 'scripts/native-workspace-storage-fixture.mjs' },
        { ...remove, path: 'scripts/native-workspace-storage-fixture.mjs' },
      ]),
    ).toEqual([])
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
