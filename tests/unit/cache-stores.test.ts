import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetBroadcastForTests, type BroadcastEvent, onEvent } from '../../src/store/broadcast'
import {
  defaultCorsProxyUrlForRuntime,
  readGlobalPreferences,
  writeChatMaxWidth,
  writeLongMessageDisplayMode,
} from '../../src/core/global-settings'
import { DEFAULT_CORS_PROXY_URL, DEV_CORS_PROXY_URL } from '../../src/core/cors-proxy'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import type { MessageHeaderRow } from '../../src/store/message-storage'
import type { DraftRow } from '../../src/core/types'
import {
  clearEndpointsCacheForProfile,
  clearModelsCacheForProfile,
  ENDPOINTS_TTL_MS,
  getCachedEndpoints,
  getCachedModels,
  isFresh,
  MODELS_TTL_MS,
  putCachedEndpoints,
  putCachedModels,
} from '../../src/store/models-cache'
import {
  clearPrivacyPoliciesForProfile,
  clearProvidersForProfile,
  getCachedPrivacyPolicy,
  getCachedProviders,
  putCachedPrivacyPolicy,
  putCachedProviders,
} from '../../src/store/privacy-cache'
import { deleteSetting, getSetting, setSetting, updateSetting } from '../../src/store/settings'
import {
  readCollapsedSidebarFolderIds,
  readSidebarSortMode,
  SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
  SIDEBAR_SORT_SETTING_KEY,
  updateCollapsedSidebarFolderIds,
  writeSidebarSortMode,
} from '../../src/store/sidebar-preferences'

const DB_NAME = 'natter'

async function resetAll() {
  __resetDbForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
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

  it('putCachedModels broadcasts models-refreshed exactly once', async () => {
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => {
      if (ev.kind === 'models-refreshed') seen.push(ev)
    })
    await putCachedModels('P1', {}, 'payload', 1000)
    unsub()
    expect(seen).toEqual([{ kind: 'models-refreshed', profileId: 'P1' }])
  })

  it('clearModelsCacheForProfile removes only that profiles rows', async () => {
    await putCachedModels('P1', {}, 'a', 1)
    await putCachedModels('P2', {}, 'b', 2)
    await clearModelsCacheForProfile('P1')
    expect(await getCachedModels('P1', {})).toBeUndefined()
    expect((await getCachedModels('P2', {}))?.payload).toBe('b')
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
  })
})

describe('privacy-cache', () => {
  it('stores scraped policy keyed by (profileId, modelId) and broadcasts on write', async () => {
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => {
      if (ev.kind === 'privacy-refreshed') seen.push(ev)
    })
    await putCachedPrivacyPolicy('P1', 'anthropic/claude-opus-4.7', { training: false }, 42)
    unsub()
    expect(seen).toEqual([
      { kind: 'privacy-refreshed', profileId: 'P1', modelId: 'anthropic/claude-opus-4.7' },
    ])
    const row = await getCachedPrivacyPolicy('P1', 'anthropic/claude-opus-4.7')
    expect(row?.fetchedAt).toBe(42)
    expect(row?.payload).toEqual({ training: false })
  })

  it('providers cache holds one row per profile', async () => {
    await putCachedProviders('P1', { providers: ['Anthropic'] }, 100)
    await putCachedProviders('P2', { providers: ['OpenAI'] }, 200)
    expect((await getCachedProviders('P1'))?.payload).toEqual({ providers: ['Anthropic'] })
    expect((await getCachedProviders('P2'))?.fetchedAt).toBe(200)
  })

  it('clear helpers only affect the targeted profile', async () => {
    await putCachedPrivacyPolicy('P1', 'a', {}, 1)
    await putCachedPrivacyPolicy('P2', 'a', {}, 1)
    await clearPrivacyPoliciesForProfile('P1')
    expect(await getCachedPrivacyPolicy('P1', 'a')).toBeUndefined()
    expect(await getCachedPrivacyPolicy('P2', 'a')).toBeDefined()

    await putCachedProviders('P1', {}, 1)
    await putCachedProviders('P2', {}, 1)
    await clearProvidersForProfile('P1')
    expect(await getCachedProviders('P1')).toBeUndefined()
    expect(await getCachedProviders('P2')).toBeDefined()
  })
})

describe('settings', () => {
  it('get → set → get round-trips arbitrary JSON values', async () => {
    expect(await getSetting<string>('theme')).toBeUndefined()
    await setSetting('theme', 'dark')
    expect(await getSetting<string>('theme')).toBe('dark')
    await setSetting('prefs', { sidebar: true, density: 3 })
    expect(await getSetting<{ sidebar: boolean; density: number }>('prefs')).toEqual({
      sidebar: true,
      density: 3,
    })
  })

  it('setSetting broadcasts settings-mutated with the key', async () => {
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => {
      if (ev.kind === 'settings-mutated') seen.push(ev)
    })
    await setSetting('theme', 'dark')
    unsub()
    expect(seen).toEqual([{ kind: 'settings-mutated', key: 'theme' }])
  })

  it('deleteSetting removes the row and still broadcasts', async () => {
    await setSetting('theme', 'dark')
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => {
      if (ev.kind === 'settings-mutated') seen.push(ev)
    })
    await deleteSetting('theme')
    unsub()
    expect(await getSetting('theme')).toBeUndefined()
    expect(seen).toEqual([{ kind: 'settings-mutated', key: 'theme' }])
  })

  it('updateSetting performs an atomic read-modify-write', async () => {
    await setSetting('counter', 0)
    await Promise.all(
      Array.from({ length: 10 }, () =>
        updateSetting<number>('counter', async (current) => (current ?? 0) + 1),
      ),
    )
    expect(await getSetting<number>('counter')).toBe(10)
  })

  it('sidebar preferences persist through the settings abstraction', async () => {
    expect(await readSidebarSortMode()).toBe('updatedAt-desc')
    await setSetting(SIDEBAR_SORT_SETTING_KEY, 'updated-asc')
    expect(await readSidebarSortMode()).toBe('updatedAt-desc')
    await writeSidebarSortMode('wordCount-desc')
    expect(await getSetting(SIDEBAR_SORT_SETTING_KEY)).toBe('wordCount-desc')
    expect(await readSidebarSortMode()).toBe('wordCount-desc')

    await setSetting(SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY, ['b', 1, 'a', 'b'])
    expect(await readCollapsedSidebarFolderIds()).toEqual(['a', 'b'])
    await updateCollapsedSidebarFolderIds((current) => [...current, 'c', 'a'])
    expect(await readCollapsedSidebarFolderIds()).toEqual(['a', 'b', 'c'])
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

  it('marks run-once backcompat tasks complete on a fresh database', async () => {
    expect(await getSetting('backfill:attachment-refs-v1')).toBe(1)
    expect(await getSetting('backfill:message-body-split-v1')).toBe(1)
    expect(await getSetting('backfill:organization-fields-v1')).toBe(1)
    expect(await getSetting('backfill:global-settings-v1')).toBe(1)
  })

  it('migrates the retired auto-scroll setting once before live reads', async () => {
    await setSetting('global:auto-scroll', false)
    await deleteSetting('backfill:global-settings-v1')
    __resetDbForTests()
    await openDb()

    expect(await getSetting('global:auto-scroll')).toBeUndefined()
    expect(await getSetting('global:auto-scroll-open')).toBe(false)
    expect(await getSetting('global:auto-scroll-stream')).toBe(false)
    const prefs = await readGlobalPreferences()
    expect(prefs.autoScrollOnOpen).toBe(false)
    expect(prefs.autoScrollOnStream).toBe(false)
    expect(await getSetting('backfill:global-settings-v1')).toBe(1)
  })

  it('migrates retired sidebar sort values before live reads', async () => {
    await setSetting('sidebar:sort-key', 'updated-asc')
    await deleteSetting('backfill:global-settings-v1')
    __resetDbForTests()
    await openDb()

    expect(await getSetting('sidebar:sort-key')).toBe('updatedAt-asc')
    expect(await readSidebarSortMode()).toBe('updatedAt-asc')
  })

  it('migrates stored string attachment refs before live reads', async () => {
    const db = getDb()
    await db.attachments.put({
      id: 'att-old',
      kind: 'other',
      mime: 'text/plain',
      filename: 'old.txt',
      origin: 'import',
      createdAt: 1,
      updatedAt: 1,
      storage: { kind: 'missing', reason: 'import-missing', missingSince: 1 },
      artifacts: [],
      processing: [],
      refCount: 0,
    })
    await db.messages.put({
      id: 'msg-old',
      chatId: 'chat-old',
      parentId: null,
      siblingIndex: 0,
      turnId: 'turn-old',
      turnIndex: 0,
      createdAt: 2,
      role: 'user',
      origin: 'user',
      nodeVersion: 0,
      deleted: false,
      attachmentRefs: ['att-old'],
    } as unknown as MessageHeaderRow)
    await db.drafts.put({
      chatId: 'chat-old',
      text: '',
      attachmentRefs: ['att-old'],
      updatedAt: 3,
    } as unknown as DraftRow)
    await deleteSetting('backfill:attachment-refs-v1')
    __resetDbForTests()
    await openDb()

    const migrated = getDb()
    expect((await migrated.messages.get('msg-old'))?.attachmentRefs).toEqual([
      expect.objectContaining({ refId: 'legacy:msg-old:0', attachmentId: 'att-old' }),
    ])
    expect((await migrated.drafts.get('chat-old'))?.attachmentRefs).toEqual([
      expect.objectContaining({ refId: 'legacy:chat-old:0', attachmentId: 'att-old' }),
    ])
    expect((await migrated.attachments.get('att-old'))?.refCount).toBe(2)
    expect(await getSetting('backfill:attachment-refs-v1')).toBe(1)
  })

  it('uses /_or_scrape only for the Vite dev runtime default', () => {
    expect(defaultCorsProxyUrlForRuntime(true)).toBe(DEV_CORS_PROXY_URL)
    expect(defaultCorsProxyUrlForRuntime(false)).toBe(DEFAULT_CORS_PROXY_URL)
    expect(DEFAULT_CORS_PROXY_URL).toBe('')
  })
})
