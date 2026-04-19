import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NatterDb } from '../../src/store/db'
import { __resetDbForTests, createDbForTests, openDb, registerSchema } from '../../src/store/db'

// Unique DB name per test so migrations start from a clean slate. We delete
// any pre-existing data at the top of each test so repeated runs don't pick
// up stale state from fake-indexeddb's in-memory persistence.
async function freshDb(name: string): Promise<NatterDb> {
  await Dexie.delete(name)
  return createDbForTests(name)
}

afterEach(() => {
  __resetDbForTests()
})

describe('Dexie schema', () => {
  beforeEach(async () => {
    await Dexie.delete('natter')
  })

  it('opens on a fresh IndexedDB with all declared tables', async () => {
    const db = await openDb()
    expect(db.isOpen()).toBe(true)
    const names = db.tables.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'attachments',
        'chatBranchCache',
        'chats',
        'childLists',
        'drafts',
        'endpoints',
        'folders',
        'generations',
        'keys',
        'messages',
        'models',
        'presets',
        'presetResolutions',
        'privacyPolicies',
        'profiles',
        'providers',
        'settings',
        'tags',
      ].sort(),
    )
  })

  it('is idempotent across repeated open calls', async () => {
    const a = await openDb()
    const b = await openDb()
    expect(a).toBe(b)
    expect(a.isOpen()).toBe(true)
  })

  it('reopens a previously-written DB and reads existing rows', async () => {
    const name = `natter-test-reopen-${Math.random().toString(36).slice(2)}`
    const first = await freshDb(name)
    await first.open()
    await first.settings.put({ key: 'hello', value: 'world' })
    first.close()

    const second = createDbForTests(name)
    await second.open()
    const row = await second.settings.get('hello')
    expect(row?.value).toBe('world')
    expect(second.tables.map((t) => t.name)).toContain('childLists')
    await second.delete()
  })
})

// Synthetic v2/v3 upgrades exercised through plain Dexie instances. We avoid
// subclassing (which trips "Type instantiation is excessively deep" under the
// NatterDb branded Table types) and declare versions directly on the base Db.

interface MinimalProfile {
  id: string
  name: string
  appTitle?: string
  [k: string]: unknown
}
interface MinimalSetting {
  key: string
  value: unknown
}

function registerV1(db: Dexie): void {
  registerSchema(db)
}

function registerV1Through3(db: Dexie): void {
  registerSchema(db)
  db.version(3)
    .stores({ profiles: 'id, name, kind, lastUsedAt, archived' })
    .upgrade(async (tx) => {
      await tx
        .table<MinimalProfile>('profiles')
        .toCollection()
        .modify((row) => {
          if (row.appTitle === undefined) row.appTitle = 'Natter'
        })
    })
  db.version(4)
    .stores({ settings: '&key' })
    .upgrade(async (tx) => {
      const settings = tx.table<MinimalSetting>('settings')
      const existing = await settings.get('schemaTag')
      if (!existing) await settings.put({ key: 'schemaTag', value: 'v3' })
    })
}

describe('Dexie migrations', () => {
  it('opens a fresh DB at the highest declared version without replaying upgrade callbacks', async () => {
    // Dexie's contract: on a truly fresh IDB, it creates the union of all
    // declared tables at the latest version and skips upgrade() callbacks —
    // there's no data to migrate. This test pins that contract so the
    // migration-backfill tests below can rely on "upgrades only fire when
    // transitioning from a lower on-disk version."
    const name = `natter-test-mig-fresh-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const db = new Dexie(name)
    registerV1Through3(db)
    await db.open()
    expect(db.verno).toBe(4)
    expect(db.tables.map((t) => t.name).includes('settings')).toBe(true)
    const tag = await db.table<MinimalSetting>('settings').get('schemaTag')
    expect(tag).toBeUndefined()
    await db.delete()
  })

  it('is idempotent across re-opens — upgrade callbacks do not rerun on already-migrated data', async () => {
    const name = `natter-test-mig-reopen-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)

    const v1 = new Dexie(name)
    registerV1(v1)
    await v1.open()
    await v1.table<MinimalProfile>('profiles').put({
      id: 'P1',
      name: 'Existing',
      kind: 'openrouter',
      baseUrl: 'https://example',
      apiKeyRef: 'K1',
      defaultHeaders: {},
      appTitle: 'CustomTitle',
      appUrl: '',
      usesResponsesApiByDefault: false,
      supportsEndpointsApi: false,
      supportsGenerationApi: false,
      supportsPrivacyScrape: false,
      createdAt: 1,
      updatedAt: 1,
    })
    await v1.table<MinimalSetting>('settings').put({ key: 'schemaTag', value: 'preexisting' })
    v1.close()

    const up = new Dexie(name)
    registerV1Through3(up)
    await up.open()
    expect(up.verno).toBe(4)
    const profile = await up.table<MinimalProfile>('profiles').get('P1')
    expect(profile?.appTitle).toBe('CustomTitle') // preserved — v2 only fills undefined
    const tag = await up.table<MinimalSetting>('settings').get('schemaTag')
    expect(tag?.value).toBe('preexisting') // v3 only seeds when absent
    up.close()

    const reopen = new Dexie(name)
    registerV1Through3(reopen)
    await reopen.open()
    expect(reopen.verno).toBe(4)
    const tag2 = await reopen.table<MinimalSetting>('settings').get('schemaTag')
    expect(tag2?.value).toBe('preexisting')
    await reopen.delete()
  })

  it('backfills defaults only for rows missing the field (second synthetic bump is a no-op when fields are present)', async () => {
    const name = `natter-test-mig-backfill-${Math.random().toString(36).slice(2)}`
    await Dexie.delete(name)
    const v1 = new Dexie(name)
    registerV1(v1)
    await v1.open()
    await v1.table<MinimalProfile>('profiles').put({
      id: 'P2',
      name: 'Bare',
      kind: 'openrouter',
      baseUrl: 'https://example',
      apiKeyRef: 'K1',
      defaultHeaders: {},
      // deliberately omit appTitle — v2 migration must set it
      appUrl: '',
      usesResponsesApiByDefault: false,
      supportsEndpointsApi: false,
      supportsGenerationApi: false,
      supportsPrivacyScrape: false,
      createdAt: 1,
      updatedAt: 1,
    })
    v1.close()

    const up = new Dexie(name)
    registerV1Through3(up)
    await up.open()
    const row = await up.table<MinimalProfile>('profiles').get('P2')
    expect(row?.appTitle).toBe('Natter') // v2 backfilled
    await up.delete()
  })
})
