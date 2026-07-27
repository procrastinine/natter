import Dexie from 'dexie'
import { ownBrowserWorkspaceSuite } from '../helpers/browser-workspace-suite'
import {
  clearEndpointsCacheForProfile,
  clearModelsCacheForProfile,
  clearPrivacyPoliciesForProfile,
  putCachedEndpoints,
  putCachedModels,
  putCachedPrivacyPolicy,
} from '../helpers/discovery-cache'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { modelsCacheKey } from '../../src/core/cache-keys'
import { DEFAULT_CORS_PROXY_URL, DEV_CORS_PROXY_URL } from '../../src/core/cors-proxy'
import {
  defaultCorsProxyUrlForRuntime,
  GLOBAL_PREFERENCE_KEYS,
  PINNED_MODELS_KEY,
} from '../../src/core/global-settings'
import {
  normalizeCollapsedSidebarFolderIds,
  parseSidebarSortMode,
  SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
  SIDEBAR_SORT_SETTING_KEY,
} from '../../src/core/sidebar-sort'
import type { ConnectionProfile } from '../../src/core/types'
import { __resetBroadcastForTests, subscribeWorkspaceChanges } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import { configurationApplication } from '../../src/store/configuration-application'
import { __resetDbForTests, getDb } from '../../src/store/db'
import type {
  CachedModelsRow,
  CachedModelsStorageRow,
  CachedPrivacyPolicyRow,
  SettingsRow,
} from '../../src/store/db-rows'
import { ENDPOINTS_TTL_MS, isFresh, MODELS_TTL_MS } from '../../src/store/discovery-cache-policy'
import {
  DISCOVERY_CACHE_LIMITS,
  type DiscoveryCachePutResult,
  prepareDiscoveryPayload,
  putDiscoveryCacheRow,
  seedEmptyDiscoveryCacheState,
} from '../../src/store/discovery-cache-storage'
import {
  readGlobalPreferences,
  setPinnedModel,
  writeChatMaxWidth,
  writeLongMessageDisplayMode,
  writeMessageInitialRenderWork,
  writeMessageRenderWindowLoadMode,
  writeSidebarRenderWindowLoadMode,
  writeSidebarRenderWindowSize,
} from '../../src/store/global-settings'
import {
  clearCachedModels,
  getCachedEndpoints,
  getCachedModels,
} from '../../src/store/models-cache'
import { getCachedPrivacyPolicy } from '../../src/store/privacy-cache'
import { getSetting } from '../../src/store/settings'
import {
  setSidebarFolderCollapsed,
  writeSidebarSortMode,
} from '../../src/store/sidebar-preferences'
import {
  connectionDiscoveryRevisionKey,
  type WorkspaceChange,
  type WorkspaceDependency,
} from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import { runWorkspaceAction } from '../../src/store/workspace-runtime'

const DB_NAME = 'natter'
const workspaceSuite = ownBrowserWorkspaceSuite()

let initialSettings: SettingsRow[]

beforeAll(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
  await workspaceSuite.open()
  initialSettings = await getDb().settings.toArray()
})

beforeEach(async () => {
  vi.restoreAllMocks()
  const db = getDb()
  await db.transaction(
    'rw',
    [
      db.models,
      db.endpoints,
      db.privacyPolicies,
      db.discoveryCacheState,
      db.discoveryPayloadMetadata,
      db.discoveryPayloads,
      db.profiles,
      db.settings,
    ],
    async (tx) => {
      await db.models.clear()
      await db.endpoints.clear()
      await db.privacyPolicies.clear()
      await db.discoveryCacheState.clear()
      await db.discoveryPayloadMetadata.clear()
      await db.discoveryPayloads.clear()
      await db.profiles.clear()
      await db.settings.clear()
      await db.settings.bulkPut(initialSettings)
      await seedEmptyDiscoveryCacheState(tx)
      await db.profiles.bulkPut([profile('P1'), profile('P2'), profile('bounded-profile')])
    },
  )
})

describe('models-cache', () => {
  it('stores and returns a row keyed by profile + normalized query key', async () => {
    await putCachedModels('P1', { supportedParameters: ['tools'] }, { data: ['m1'] }, 1000)
    const row = await getCachedModels('P1', { supportedParameters: ['tools'] })
    expect(row?.fetchedAt).toBe(1000)
    expect(row?.payload).toEqual({ data: ['m1'] })
  })

  it('queries with reordered arrays hit the same cache row (stable key)', async () => {
    await putCachedModels('P1', { supportedParameters: ['a', 'b'] }, { hit: true }, 1000)
    const row = await getCachedModels('P1', { supportedParameters: ['b', 'a'] })
    expect(row?.payload).toEqual({ hit: true })
  })

  it('queries that differ by any query field miss the cached row', async () => {
    await putCachedModels('P1', { supportedParameters: ['tools'] }, { one: 1 }, 1000)
    const miss = await getCachedModels('P1', { supportedParameters: ['tools', 'response_format'] })
    expect(miss).toBeUndefined()
  })

  it('putCachedModels publishes one scoped discovery invalidation', async () => {
    const seen: WorkspaceChange[] = []
    const unsub = subscribeWorkspaceChanges((change) => seen.push(change))
    await putCachedModels('P1', {}, 'payload', 1000)
    unsub()
    const dependency = changedDependencies(seen).find(
      (candidate) => candidate.kind === 'discovery-cache',
    )
    expect(dependency).toMatchObject({
      kind: 'discovery-cache',
      cacheKinds: ['models'],
      profileIds: ['P1'],
    })
    expect(dependency?.kind === 'discovery-cache' && Array.isArray(dependency.keys)).toBe(true)
  })

  it('clearModelsCacheForProfile removes only that profiles rows', async () => {
    await putCachedModels('P1', {}, 'a', 1)
    await putCachedModels('P2', {}, 'b', 2)
    await clearModelsCacheForProfile('P1')
    expect(await getCachedModels('P1', {})).toBeUndefined()
    expect((await getCachedModels('P2', {}))?.payload).toBe('b')
  })

  it('executes direct model-cache deletion exactly and leaves immediate replay inert', async () => {
    await putCachedModels('P1', {}, { data: [{ id: 'model' }] }, 1)

    await clearCachedModels('P1', {})
    await clearCachedModels('P1', {})

    expect(await getCachedModels('P1', {})).toBeUndefined()
    expect(await getDb().discoveryPayloadMetadata.count()).toBe(0)
    expect(await getDb().discoveryPayloads.count()).toBe(0)
  })

  it('retains a payload with many corrupt-state references using one-key existence probes', async () => {
    const db = getDb()
    await putCachedModels('P1', {}, { data: [{ id: 'shared/model' }] }, 1)
    const modelRow = await db.models.get(['P1', modelsCacheKey({})])
    expect(modelRow).toBeDefined()
    if (!modelRow) return
    await db.endpoints.bulkPut(
      Array.from({ length: 100 }, (_, index) => ({
        profileId: `reference-profile-${index}`,
        profileRevision: 'revision',
        modelId: `model-${index}`,
        fetchedAt: index,
        payloadId: modelRow.payloadId,
        payloadByteLength: modelRow.payloadByteLength,
      })),
    )
    await db.discoveryPayloadMetadata.update(modelRow.payloadId, { referenceCount: 101 })
    await db.discoveryCacheState.update('global', { valid: false })

    await clearCachedModels('P1', {})

    expect(await db.models.get(['P1', modelsCacheKey({})])).toBeUndefined()
    expect(await db.discoveryPayloads.get(modelRow.payloadId)).toBeDefined()
    expect(await db.discoveryPayloadMetadata.get(modelRow.payloadId)).toBeDefined()
  })

  it('stores one immutable payload for repeated large refreshes without rereading its body', async () => {
    const payload = { data: [{ id: 'large', description: 'x'.repeat(1024 * 1024) }] }
    const payloadGet = vi.spyOn(getDb().discoveryPayloads, 'get')

    for (let fetchedAt = 1; fetchedAt <= 8; fetchedAt += 1) {
      await putDiscoveryRowForTest('models', {
        profileId: 'P1',
        profileRevision: 'revision',
        queryKey: 'query',
        fetchedAt,
        payload,
      })
    }

    expect(payloadGet).not.toHaveBeenCalled()
    expect(await getDb().models.count()).toBe(1)
    expect(await getDb().discoveryPayloads.count()).toBe(1)
    const stored = await getDb().discoveryPayloads.toCollection().first()
    expect(stored?.byteLength).toBeGreaterThanOrEqual(1024 * 1024)
  })

  it('bounds model query headers and collects payloads evicted with them', async () => {
    for (let index = 0; index < 40; index += 1) {
      const payload = { data: [{ id: `model-${index}` }] }
      await putDiscoveryRowForTest('models', {
        profileId: 'bounded-profile',
        profileRevision: 'revision',
        queryKey: `query-${index}`,
        fetchedAt: index,
        payload,
      })
    }

    expect(await getDb().models.where('profileId').equals('bounded-profile').count()).toBe(
      DISCOVERY_CACHE_LIMITS.perProfileRows.models,
    )
    expect(await getDb().discoveryPayloads.count()).toBe(
      DISCOVERY_CACHE_LIMITS.perProfileRows.models,
    )
  })

  it('rejects a put against an over-cap profile snapshot and requests bounded repair', async () => {
    const db = getDb()
    await db.models.bulkPut(
      Array.from(
        { length: DISCOVERY_CACHE_LIMITS.perProfileRows.models + 1 },
        (_, index): CachedModelsStorageRow => ({
          profileId: 'corrupt-over-cap-profile',
          profileRevision: 'revision',
          queryKey: `existing-${index}`,
          fetchedAt: index,
          payloadId: `missing-${index}`,
          payloadByteLength: 2,
        }),
      ),
    )
    await db.discoveryCacheState.put({
      id: 'global',
      formatVersion: 1,
      valid: true,
      headerCounts: {
        models: DISCOVERY_CACHE_LIMITS.perProfileRows.models + 1,
        endpoints: 0,
        privacyPolicies: 0,
      },
      payloadCount: 0,
      payloadByteLength: 0,
    })

    const result = await putDiscoveryRowForTest('models', {
      profileId: 'corrupt-over-cap-profile',
      profileRevision: 'revision',
      queryKey: 'new',
      fetchedAt: 100,
      payload: { data: [{ id: 'new/model' }] },
    })

    expect(result).toMatchObject({
      cached: false,
      cacheChanged: false,
      repairRequired: true,
    })
    expect(await db.models.where('profileId').equals('corrupt-over-cap-profile').count()).toBe(
      DISCOVERY_CACHE_LIMITS.perProfileRows.models + 1,
    )
    expect(await db.discoveryCacheState.get('global')).toMatchObject({ valid: false })
  })

  it('deduplicates payload bytes across cache keys while retaining exact reference counts', async () => {
    const payload = { data: [{ id: 'shared-model', description: 'shared'.repeat(1_000) }] }
    const prepared = await prepareDiscoveryPayload('models', payload)
    for (let index = 0; index < 12; index += 1) {
      await putDiscoveryRowForTest('models', {
        profileId: 'P1',
        profileRevision: 'revision',
        queryKey: `shared-${index}`,
        fetchedAt: index,
        payload,
      })
    }

    expect(await getDb().discoveryPayloads.count()).toBe(1)
    expect(await getDb().discoveryPayloadMetadata.toCollection().first()).toMatchObject({
      id: prepared.id,
      byteLength: prepared.byteLength,
      referenceCount: 12,
    })
    expect(await getDb().discoveryCacheState.get('global')).toMatchObject({
      payloadCount: 1,
      payloadByteLength: prepared.byteLength,
      headerCounts: { models: 12, endpoints: 0, privacyPolicies: 0 },
    })
  })

  it('bounds model rows across many profiles and broadcasts every evicted exact key', async () => {
    const extraProfiles = Array.from({ length: 4 }, (_, index) => profile(`P${index + 3}`))
    await getDb().profiles.bulkPut(extraProfiles)
    const profileIds = ['P1', 'P2', ...extraProfiles.map((row) => row.id)]
    for (const profileId of profileIds) {
      for (let index = 0; index < 12; index += 1) {
        await putCachedModels(
          profileId,
          { supportedParameters: [`feature-${index}`] },
          { data: [{ id: `${profileId}/model-${index}` }] },
          index,
        )
      }
    }

    expect(await getDb().models.count()).toBe(DISCOVERY_CACHE_LIMITS.globalRows.models)
    expect(await getDb().discoveryPayloads.count()).toBe(DISCOVERY_CACHE_LIMITS.globalRows.models)

    const seen: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => seen.push(change))
    const evictedQuery = { supportedParameters: ['final-profile-oldest'] }
    for (let index = 0; index <= DISCOVERY_CACHE_LIMITS.perProfileRows.models; index += 1) {
      await putCachedModels(
        'bounded-profile',
        index === 0 ? evictedQuery : { supportedParameters: [`bounded-${index}`] },
        { data: [{ id: `bounded/model-${index}` }] },
        100 + index,
      )
    }
    unsubscribe()
    expect(changedDependencies(seen)).toContainEqual({
      kind: 'discovery-cache',
      cacheKinds: ['models'],
      profileIds: ['bounded-profile'],
      keys: [JSON.stringify(['models', 'bounded-profile', modelsCacheKey(evictedQuery)])],
    })
  })

  it('returns an oversized live result as accepted without retaining its body', async () => {
    const payload = {
      data: [
        {
          id: 'oversized/live-model',
          description: 'x'.repeat(DISCOVERY_CACHE_LIMITS.maxPayloadByteLength + 1),
        },
      ],
    }
    const prepared = await prepareDiscoveryPayload('models', payload)
    expect(prepared.cacheable).toBe(false)
    const result = await putDiscoveryRowForTest('models', {
      profileId: 'P1',
      profileRevision: 'revision',
      queryKey: 'oversized',
      fetchedAt: 1,
      payload,
    })

    expect(result).toMatchObject({ accepted: true, cached: false, cacheChanged: false })
    expect(await getDb().models.count()).toBe(0)
    expect(await getDb().discoveryPayloads.count()).toBe(0)
  })

  it('enforces the unique-byte budget from compact metadata and evicts oldest headers', async () => {
    const db = getDb()
    const syntheticByteLength = 8 * 1024 * 1024
    await db.transaction(
      'rw',
      [db.discoveryCacheState, db.discoveryPayloadMetadata, db.discoveryPayloads, db.models],
      async () => {
        for (let index = 0; index < 8; index += 1) {
          const id = `synthetic-${index}`
          await db.discoveryPayloads.put({
            id,
            canonicalJson: '{}',
            byteLength: syntheticByteLength,
          })
          await db.discoveryPayloadMetadata.put({
            id,
            byteLength: syntheticByteLength,
            referenceCount: 1,
            lastReferencedAt: index,
          })
          await db.models.put({
            profileId: `synthetic-profile-${index}`,
            profileRevision: 'revision',
            queryKey: 'query',
            fetchedAt: index,
            payloadId: id,
            payloadByteLength: syntheticByteLength,
          })
        }
        await db.discoveryCacheState.put({
          id: 'global',
          formatVersion: 1,
          valid: true,
          headerCounts: { models: 8, endpoints: 0, privacyPolicies: 0 },
          payloadCount: 8,
          payloadByteLength: DISCOVERY_CACHE_LIMITS.maxUniquePayloadByteLength,
        })
      },
    )

    const result = await putDiscoveryRowForTest('models', {
      profileId: 'P1',
      profileRevision: 'revision',
      queryKey: 'new-byte-budget-row',
      fetchedAt: 100,
      payload: { data: [{ id: 'new/model' }] },
    })

    expect(result.evictions).toContainEqual({
      tableName: 'models',
      profileId: 'synthetic-profile-0',
      discriminator: 'query',
    })
    expect(await db.discoveryPayloads.get('synthetic-0')).toBeUndefined()
    expect((await db.discoveryCacheState.get('global'))?.payloadByteLength).toBeLessThanOrEqual(
      DISCOVERY_CACHE_LIMITS.maxUniquePayloadByteLength,
    )
  })

  it('repairs crash-orphan payloads in bounded pages without hydrating payload bodies', async () => {
    const db = getDb()
    await db.discoveryPayloads.bulkPut([
      { id: 'body-only', canonicalJson: 'x'.repeat(512 * 1024), byteLength: 512 * 1024 },
      { id: 'metadata-orphan', canonicalJson: '{}', byteLength: 2 },
    ])
    await db.discoveryPayloadMetadata.put({
      id: 'metadata-orphan',
      byteLength: 2,
      referenceCount: 99,
      lastReferencedAt: 1,
    })
    await db.discoveryCacheState.put({
      id: 'global',
      formatVersion: 1,
      valid: false,
      headerCounts: { models: 0, endpoints: 0, privacyPolicies: 0 },
      payloadCount: 0,
      payloadByteLength: 0,
    })
    const fullBodyRead = vi.spyOn(db.discoveryPayloads, 'toArray')
    const bodyGet = vi.spyOn(db.discoveryPayloads, 'get')
    const scans: number[] = []
    for (;;) {
      const result = await maintainDiscoveryCacheForTest(1)
      scans.push(result.scanned)
      if (result.done) break
    }

    expect(scans.every((scanned) => scanned <= 1)).toBe(true)
    expect(await db.discoveryPayloads.count()).toBe(0)
    expect(await db.discoveryPayloadMetadata.count()).toBe(0)
    expect(await db.discoveryCacheState.get('global')).toMatchObject({
      valid: true,
      payloadCount: 0,
      payloadByteLength: 0,
    })
    expect(fullBodyRead).not.toHaveBeenCalled()
    expect(bodyGet).not.toHaveBeenCalled()
  })

  it('resumes a 129-row invalid-cache audit in 64-row durable pages and becomes inert', async () => {
    const db = getDb()
    await db.discoveryPayloads.bulkPut(
      Array.from({ length: 129 }, (_, index) => ({
        id: `orphan-body-${index.toString().padStart(3, '0')}`,
        canonicalJson: '{}',
        byteLength: 2,
      })),
    )
    await db.discoveryCacheState.put({
      id: 'global',
      formatVersion: 1,
      valid: false,
      headerCounts: { models: 0, endpoints: 0, privacyPolicies: 0 },
      payloadCount: 0,
      payloadByteLength: 0,
    })

    const pages = []
    for (;;) {
      const page = await maintainDiscoveryCacheForTest(64)
      pages.push(page)
      if (page.done) break
    }

    expect(pages.map((page) => page.scanned)).toEqual([64, 64, 1])
    expect(pages.every((page) => page.scanned <= 64)).toBe(true)
    expect(pages.reduce((total, page) => total + page.deletedPayloads, 0)).toBe(129)
    expect(await db.discoveryPayloads.count()).toBe(0)
    expect(await maintainDiscoveryCacheForTest(64)).toEqual({
      scanned: 0,
      deletedPayloads: 0,
      evictions: [],
      done: true,
    })
  })

  it('repairs an over-cap cache from a malformed durable cursor without unbounded reads', async () => {
    const db = getDb()
    const payloadId = 'shared-over-cap-payload'
    await db.discoveryPayloads.put({ id: payloadId, canonicalJson: '{}', byteLength: 2 })
    await db.discoveryPayloadMetadata.put({
      id: payloadId,
      byteLength: 2,
      referenceCount: DISCOVERY_CACHE_LIMITS.globalRows.models + 1,
      lastReferencedAt: 1,
    })
    await db.models.bulkPut(
      Array.from(
        { length: DISCOVERY_CACHE_LIMITS.globalRows.models + 1 },
        (_, index): CachedModelsStorageRow => ({
          profileId: `profile-${index}`,
          profileRevision: 'revision',
          queryKey: 'query',
          fetchedAt: index,
          payloadId,
          payloadByteLength: 2,
        }),
      ),
    )
    await db.discoveryCacheState.put({
      id: 'global',
      formatVersion: 1,
      valid: false,
      headerCounts: { models: 0, endpoints: 0, privacyPolicies: 0 },
      payloadCount: 0,
      payloadByteLength: 0,
      audit: {
        phase: 'metadata',
        afterKey: ['wrong', 'cursor'],
        headerCounts: { models: 0, endpoints: 0, privacyPolicies: 0 },
        payloadCount: 0,
        payloadByteLength: 0,
      },
    } as never)

    const pages = []
    for (;;) {
      const page = await maintainDiscoveryCacheForTest(8)
      pages.push(page)
      if (page.done) break
    }

    expect(pages[0]).toMatchObject({ scanned: 1, done: false })
    expect(pages.every((page) => page.scanned <= 8)).toBe(true)
    expect(await db.models.count()).toBe(DISCOVERY_CACHE_LIMITS.globalRows.models)
    expect(await db.discoveryPayloadMetadata.get(payloadId)).toMatchObject({ referenceCount: 64 })
    expect(await db.discoveryCacheState.get('global')).toMatchObject({
      valid: true,
      headerCounts: { models: 64, endpoints: 0, privacyPolicies: 0 },
    })
  })

  it('trusts the current transactional totals and skips completed maintenance scans', async () => {
    const wholeTableCounts = vi.spyOn(IDBObjectStore.prototype, 'count')
    await putDiscoveryRowForTest('models', {
      profileId: 'P1',
      profileRevision: 'revision',
      queryKey: 'no-whole-table-counts',
      fetchedAt: 1,
      payload: { data: [{ id: 'bounded/model' }] },
    })
    expect(wholeTableCounts.mock.calls.every(([query]) => query !== undefined)).toBe(true)

    const cursorReads: string[] = []
    const openCursor = IDBObjectStore.prototype.openCursor
    vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      cursorReads.push(this.name)
      return openCursor.apply(this, args)
    })
    const result = await maintainDiscoveryCacheForTest(32)

    expect(result).toEqual({ scanned: 0, deletedPayloads: 0, evictions: [], done: true })
    expect(cursorReads).toEqual([])
  })

  it('endpoints cache is keyed by (profileId, modelId)', async () => {
    await putCachedEndpoints('P1', 'anthropic/claude-opus-4.7', { list: [1] }, 1000)
    const row = await getCachedEndpoints('P1', 'anthropic/claude-opus-4.7')
    expect(row?.payload).toEqual({ list: [1] })
    expect(await getCachedEndpoints('P1', 'openai/gpt-5.4')).toBeUndefined()
    expect(await getCachedEndpoints('P2', 'anthropic/claude-opus-4.7')).toBeUndefined()
  })

  it('clearEndpointsCacheForProfile wipes per-profile rows', async () => {
    await putCachedEndpoints('P1', 'a', 1, 1)
    await putCachedEndpoints('P1', 'b', 2, 2)
    await putCachedEndpoints('P2', 'a', 3, 3)
    await clearEndpointsCacheForProfile('P1')
    expect(await getCachedEndpoints('P1', 'a')).toBeUndefined()
    expect(await getCachedEndpoints('P1', 'b')).toBeUndefined()
    expect((await getCachedEndpoints('P2', 'a'))?.payload).toBe(3)
  })

  it('isFresh respects the TTL window relative to now', () => {
    const now = 1_000_000
    expect(isFresh(now - 10, MODELS_TTL_MS, now)).toBe(true)
    expect(isFresh(now - MODELS_TTL_MS - 1, MODELS_TTL_MS, now)).toBe(false)
    expect(isFresh(now - ENDPOINTS_TTL_MS + 100, ENDPOINTS_TTL_MS, now)).toBe(true)
    expect(isFresh(now + 1, MODELS_TTL_MS, now)).toBe(false)
  })
})

describe('privacy-cache', () => {
  it('stores scraped policy by model and publishes a scoped invalidation', async () => {
    const seen: WorkspaceChange[] = []
    const unsub = subscribeWorkspaceChanges((change) => seen.push(change))
    await putCachedPrivacyPolicy('P1', 'anthropic/claude-opus-4.7', { training: false }, 42)
    unsub()
    const dependency = changedDependencies(seen).find(
      (candidate) => candidate.kind === 'discovery-cache',
    )
    expect(dependency).toMatchObject({
      kind: 'discovery-cache',
      cacheKinds: ['privacy'],
      profileIds: ['P1'],
    })
    expect(dependency?.kind === 'discovery-cache' && Array.isArray(dependency.keys)).toBe(true)
    const row = await getCachedPrivacyPolicy('P1', 'anthropic/claude-opus-4.7')
    expect(row?.fetchedAt).toBe(42)
    expect(row?.payload).toEqual({ training: false })
  })

  it('clear only affects the targeted profile', async () => {
    await putCachedPrivacyPolicy('P1', 'a', {}, 1)
    await putCachedPrivacyPolicy('P2', 'a', {}, 1)
    await clearPrivacyPoliciesForProfile('P1')
    expect(await getCachedPrivacyPolicy('P1', 'a')).toBeUndefined()
    expect(await getCachedPrivacyPolicy('P2', 'a')).toBeDefined()
  })

  it('reuses the guarded current row while replacing a privacy cache entry', async () => {
    const modelId = 'anthropic/claude-opus-4.7'
    await putCachedPrivacyPolicy('P1', modelId, { policies: [{ training: false }] }, 1)
    const previous = await getCachedPrivacyPolicy('P1', modelId)
    expect(previous).toBeDefined()

    await runWorkspaceAction('cache-refresh', async (permit) => {
      const snapshot = (
        await getWorkspaceRepository().query(permit, {
          kind: 'configuration.discovery-snapshot',
          profileId: 'P1',
        })
      ).value
      if (!snapshot) throw new Error('DiscoveryProfileMissing:P1')
      const row: CachedPrivacyPolicyRow = {
        profileId: 'P1',
        profileRevision: connectionDiscoveryRevisionKey(snapshot.revision),
        modelId,
        fetchedAt: 2,
        payload: { policies: [{ training: true }] },
      }
      await getWorkspaceRepository().execute(permit, {
        kind: 'discovery.privacy.put',
        row,
        guard: {
          expectedProfileRevision: snapshot.revision,
          expectedCurrent: previous ?? null,
        },
      })
    })

    expect(await getCachedPrivacyPolicy('P1', modelId)).toMatchObject({
      fetchedAt: 2,
      payload: { policies: [{ training: true }] },
    })
  })
})

describe('settings', () => {
  it('get → set → get round-trips arbitrary JSON values', async () => {
    expect(await getSetting<string>('theme')).toBeUndefined()
    await setGlobalPreference('theme', 'dark')
    expect(await getSetting<string>('theme')).toBe('dark')
    await setGlobalPreference('prefs', { sidebar: true, density: 3 })
    expect(await getSetting<{ sidebar: boolean; density: number }>('prefs')).toEqual({
      sidebar: true,
      density: 3,
    })
  })

  it('the configuration command publishes a scoped setting invalidation', async () => {
    const seen: WorkspaceChange[] = []
    const unsub = subscribeWorkspaceChanges((change) => seen.push(change))
    await setGlobalPreference('theme', 'dark')
    unsub()
    expect(changedDependencies(seen)).toContainEqual({ kind: 'setting', keys: ['theme'] })
  })

  it('semantic membership removal updates pinned models and publishes its exact invalidation', async () => {
    await setPinnedModel('model-a', true)
    const seen: WorkspaceChange[] = []
    const unsub = subscribeWorkspaceChanges((change) => seen.push(change))
    await setPinnedModel('model-a', false)
    unsub()
    expect((await readGlobalPreferences()).pinnedModels).not.toContain('model-a')
    expect(changedDependencies(seen)).toContainEqual({
      kind: 'setting',
      keys: [PINNED_MODELS_KEY],
    })
  })

  it('semantic set membership preserves concurrent pinned-model additions', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => setPinnedModel(`model-${index}`, true)),
    )
    expect(new Set((await readGlobalPreferences()).pinnedModels)).toEqual(
      new Set(Array.from({ length: 10 }, (_, index) => `model-${index}`)),
    )
  })

  it('sidebar preferences persist through the settings abstraction', async () => {
    expect(parseSidebarSortMode(await getSetting(SIDEBAR_SORT_SETTING_KEY))).toBe('updatedAt-desc')
    await setGlobalPreference(SIDEBAR_SORT_SETTING_KEY, 'updated-asc')
    expect(parseSidebarSortMode(await getSetting(SIDEBAR_SORT_SETTING_KEY))).toBe('updatedAt-desc')
    await writeSidebarSortMode('wordCount-desc')
    expect(await getSetting(SIDEBAR_SORT_SETTING_KEY)).toBe('wordCount-desc')
    expect(parseSidebarSortMode(await getSetting(SIDEBAR_SORT_SETTING_KEY))).toBe('wordCount-desc')

    await setGlobalPreference(SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY, ['b', 1, 'a', 'b'])
    expect(
      normalizeCollapsedSidebarFolderIds(await getSetting(SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY)),
    ).toEqual(['a', 'b'])
    await setSidebarFolderCollapsed('c', true)
    expect(
      normalizeCollapsedSidebarFolderIds(await getSetting(SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY)),
    ).toEqual(['a', 'b', 'c'])
  })

  it('global preferences preserve slider chat-width values', async () => {
    await writeChatMaxWidth(960)
    expect(await getSetting('global:chat-max-width')).toBe(960)
    expect((await readGlobalPreferences()).chatMaxWidth).toBe(960)
  })

  it('global preferences preserve the long-message display mode', async () => {
    await writeLongMessageDisplayMode('compact')
    expect(await getSetting('global:long-message-display-mode')).toBe('compact')
    expect((await readGlobalPreferences()).longMessageDisplayMode).toBe('compact')
  })

  it('global preferences preserve render-window controls', async () => {
    await writeMessageInitialRenderWork(12)
    await writeSidebarRenderWindowSize(80)
    await writeMessageRenderWindowLoadMode('manual')
    await writeSidebarRenderWindowLoadMode('manual')
    const prefs = await readGlobalPreferences()
    expect(await getSetting('global:message-initial-render-work')).toBe(12)
    expect(await getSetting('global:sidebar-render-window-size')).toBe(80)
    expect(prefs.messageInitialRenderWork).toBe(12)
    expect(prefs.sidebarRenderWindowSize).toBe(80)
    expect(prefs.messageRenderWindowLoadMode).toBe('manual')
    expect(prefs.sidebarRenderWindowLoadMode).toBe('manual')
  })

  it('reads the global preference snapshot with one IndexedDB request', async () => {
    const settings = getDb().settings
    const get = vi.spyOn(settings, 'get')
    const bulkGet = vi.spyOn(settings, 'bulkGet')

    await readGlobalPreferences()

    expect(bulkGet).toHaveBeenCalledOnce()
    expect(bulkGet.mock.calls[0]?.[0]).toHaveLength(GLOBAL_PREFERENCE_KEYS.length)
    expect(get).not.toHaveBeenCalled()
  })

  it('marks run-once backcompat tasks complete on a fresh database', async () => {
    expect(await getSetting('backfill:attachment-refs-v1')).toBe(1)
    expect(await getSetting('backfill:message-body-split-v1')).toBe(1)
    expect(await getSetting('backfill:organization-fields-v1')).toBe(1)
    expect(await getSetting('backfill:global-settings-v1')).toBe(1)
    expect(await getSetting('backfill:token-calibration-canonicalize-v1')).toBe(1)
  })

  it('uses /_or_scrape only for the Vite dev runtime default', () => {
    expect(defaultCorsProxyUrlForRuntime(true)).toBe(DEV_CORS_PROXY_URL)
    expect(defaultCorsProxyUrlForRuntime(false)).toBe(DEFAULT_CORS_PROXY_URL)
    expect(DEFAULT_CORS_PROXY_URL).toBe('')
  })
})

async function setGlobalPreference(key: string, value: unknown): Promise<void> {
  await configurationApplication.execute({
    kind: 'global-preference.set',
    key,
    value,
    now: Date.now(),
  })
}

function profile(id: string): ConnectionProfile {
  return {
    id,
    name: id,
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: `${id}:key`,
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

async function putDiscoveryRowForTest(
  tableName: 'models',
  row: CachedModelsRow,
): Promise<DiscoveryCachePutResult> {
  const db = getDb()
  const prepared = await prepareDiscoveryPayload(tableName, row.payload)
  return db.transaction(
    'rw',
    [
      db.discoveryCacheState,
      db.discoveryPayloadMetadata,
      db.discoveryPayloads,
      db.endpoints,
      db.models,
      db.privacyPolicies,
    ],
    async (tx) => {
      return putDiscoveryCacheRow(tx, tableName, row, prepared)
    },
  )
}

async function maintainDiscoveryCacheForTest(limit: number) {
  return runWorkspaceAction('maintenance', async (permit) => {
    const committed = await getWorkspaceRepository().execute(permit, {
      kind: 'maintenance.prune-discovery-cache',
      limit,
    })
    return committed.value
  })
}

function changedDependencies(changes: readonly WorkspaceChange[]): WorkspaceDependency[] {
  return changes.flatMap((change) => {
    if (change.kind === 'replace') return [{ kind: 'workspace' } satisfies WorkspaceDependency]
    if (change.kind === 'invalidate') {
      return change.dependencies === 'all'
        ? [{ kind: 'workspace' } satisfies WorkspaceDependency]
        : [...change.dependencies]
    }
    return [...change.delta.invalidations]
  })
}
