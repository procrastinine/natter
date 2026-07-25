import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { RECENT_MODEL_RECENCY_KEY, RECENT_MODELS_KEY } from '../../src/core/global-settings'
import type {
  Chat,
  ChatPreset,
  ConfigurationRequestRevision,
  ConnectionProfile,
  KeyRecord,
} from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { runBrowserCommandTransaction } from '../../src/store/browser-command-mutation-journal'
import { executeConfigurationCommandInBrowser } from '../../src/store/browser-configuration-domain'
import type {
  BrowserCommandSessionPort,
  BrowserLockedCommandPort,
} from '../../src/store/browser-domain-mutations'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import type {
  ConfigurationDomainCommand,
  ConfigurationDomainResult,
} from '../../src/store/configuration-domain-contract'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import {
  __resetLockTrackerForTests,
  __setLockBackendForTests,
  type AuthoritativeCommandLockSession,
  type LockBackend,
  type LockGrant,
  withSharedAuthoritativeCommandSession,
} from '../../src/store/locks'
import {
  assertPhysicalTransactionTablesDeclared,
  bindFencedTransaction,
  type FencedTransaction,
  type PhysicalStorageTableName,
  type PhysicalTransactionPlan,
} from '../../src/store/physical-storage-tables'
import { registerPhysicalMutationTransaction } from '../../src/store/storage-compaction-state'
import { putTestChat } from '../helpers/chats'

const DB_NAME = 'natter'

class BeforeFirstTransactionBackend implements LockBackend {
  readonly kind = 'web-locks' as const
  readonly logicalNames: string[][] = []
  private readonly beforeFirst: () => Promise<void>
  private calls = 0

  constructor(beforeFirst: () => Promise<void>) {
    this.beforeFirst = beforeFirst
  }

  async run<T>(
    logicalNames: readonly string[],
    fn: (grant: LockGrant) => Promise<T> | T,
  ): Promise<T> {
    this.logicalNames.push([...logicalNames])
    if (this.calls === 0) await this.beforeFirst()
    this.calls += 1
    return fn({
      kind: 'web-locks',
      logicalNames,
      runTransaction: (db, tables, operation) =>
        db.transaction(
          'rw',
          tables.map((table) => db.table(typeof table === 'string' ? table : table.name)),
          operation,
        ),
    })
  }

  async runAuthoritativeCommandSession<T>(
    _database: Dexie,
    operation: (session: AuthoritativeCommandLockSession) => Promise<T> | T,
  ): Promise<T> {
    return operation({
      kind: 'web-locks',
      withResourceLocks: (resourceNames, child) => this.run(resourceNames, child),
    })
  }
}

async function executePlannedCommand<Command extends ConfigurationDomainCommand>(
  command: Command,
): Promise<ConfigurationDomainResult<Command['kind']>> {
  const db = getDb()
  return withSharedAuthoritativeCommandSession(db, (lockSession) => {
    const commandMeta: BrowserCommandSessionPort = {
      withLocks: (resourceNames, operation) =>
        lockSession.withResourceLocks(resourceNames, (grant) => {
          const locked: BrowserLockedCommandPort = {
            runTransaction<Tables extends PhysicalStorageTableName, Result>(
              plan: PhysicalTransactionPlan<Tables>,
              transactionOperation: (tx: FencedTransaction<Tables>) => Promise<Result> | Result,
            ): Promise<Result> {
              return grant.runTransaction(db, plan.tableNames, async (tx) => {
                registerPhysicalMutationTransaction(tx)
                const committed = await runBrowserCommandTransaction(tx, (transaction) =>
                  transactionOperation(bindFencedTransaction(transaction, plan)),
                )
                assertPhysicalTransactionTablesDeclared(plan, committed.facts.tableNames)
                return committed.value
              })
            },
          }
          return operation(locked)
        }),
    }
    return executeConfigurationCommandInBrowser(db, command, commandMeta)
  })
}

function chat(overrides: Partial<Chat> = {}): Chat {
  const row: Chat = {
    id: 'chat-a',
    title: 'Chat',
    titleStatus: 'untitled',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 0,
    configurationVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
  return Object.assign(row, overrides)
}

function profile(): ConnectionProfile {
  return {
    id: 'profile-a',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-a',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: 'http://localhost',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    requestRevision: 3,
    createdAt: 1,
    updatedAt: 1,
  }
}

function key(materialRevision: number): KeyRecord {
  return {
    id: 'key-a',
    name: 'Key',
    ciphertext: 'ciphertext',
    iv: 'iv',
    salt: 'salt',
    algorithm: 'AES-GCM-256',
    kdf: { name: 'PBKDF2', iterations: 200000, hash: 'SHA-256' },
    obscuredPreview: '••••',
    materialRevision,
    createdAt: 1,
  }
}

async function resetAll(): Promise<void> {
  __setLockBackendForTests(null)
  __resetLockTrackerForTests({ admissionsOpen: true })
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests({ admissionsOpen: true })
  __resetDbForTests({ admissionsOpen: true })
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
  __setLockBackendForTests(new BeforeFirstTransactionBackend(async () => undefined))
})

afterEach(async () => {
  await resetAll()
  vi.clearAllMocks()
})

describe('planned configuration commands', () => {
  it('updates public recents and their ordering record in one command transaction', async () => {
    await executePlannedCommand({
      kind: 'recent-model.bump',
      modelId: 'model-a',
      limit: 20,
      now: 10,
    })
    await executePlannedCommand({
      kind: 'recent-model.bump',
      modelId: 'model-b',
      limit: 20,
      now: 20,
    })

    expect((await getDb().settings.get(RECENT_MODELS_KEY))?.value).toEqual(['model-b', 'model-a'])
    expect((await getDb().settings.get(RECENT_MODEL_RECENCY_KEY))?.value).toEqual({
      version: 1,
      entries: [
        { modelId: 'model-b', usedAt: 20, streamId: 'command:model-b' },
        { modelId: 'model-a', usedAt: 10, streamId: 'command:model-a' },
      ],
    })

    await executePlannedCommand({ kind: 'recent-model.clear', now: 30 })

    expect((await getDb().settings.get(RECENT_MODELS_KEY))?.value).toEqual([])
    expect((await getDb().settings.get(RECENT_MODEL_RECENCY_KEY))?.value).toEqual({
      version: 1,
      entries: [],
    })
  })

  it('rejects generic writes that could split the coupled recent-model state', async () => {
    const result = await executePlannedCommand({
      kind: 'global-preference.set',
      key: RECENT_MODELS_KEY,
      value: ['uncoupled'],
      now: 10,
    })

    expect(result).toEqual({ kind: 'invalid', reason: 'coupled-setting-command-required' })
    expect((await getDb().settings.get(RECENT_MODELS_KEY))?.value).toEqual([])
    expect((await getDb().settings.get(RECENT_MODEL_RECENCY_KEY))?.value).toEqual({
      version: 1,
      entries: [],
    })
  })

  it('replans preset application when another tab edits the preset before lock acquisition', async () => {
    const settings = { ...cloneDefaultChatSettings(), profileId: 'profile-a', model: 'old-model' }
    const preset: ChatPreset = {
      id: 'preset-a',
      name: 'Preset',
      connectionProfileId: 'profile-a',
      settings,
      createdAt: 1,
      updatedAt: 1,
    }
    await putTestChat(chat({ settings: structuredClone(settings) }))
    await getDb().presets.put(preset)
    const backend = new BeforeFirstTransactionBackend(async () => {
      await getDb().presets.put({
        ...preset,
        settings: { ...preset.settings, model: 'newer-model' },
        updatedAt: 2,
      })
    })
    __setLockBackendForTests(backend)

    const result = await executePlannedCommand({
      kind: 'chat-preset.apply',
      chatId: 'chat-a',
      presetId: preset.id,
      now: 3,
    })

    expect(result.kind).toBe('chat-preset-saved')
    expect((await getDb().chats.get('chat-a'))?.settings.model).toBe('newer-model')
    expect(backend.logicalNames).toHaveLength(2)
  })

  it('rejects a deferred model result when key material changes before its composite lock', async () => {
    const target: ConfigurationRequestRevision = {
      profileId: 'profile-a',
      requestRevision: 3,
      key: { kind: 'material', keyId: 'key-a', materialRevision: 1 },
    }
    const settings = {
      ...cloneDefaultChatSettings(),
      profileId: 'profile-a',
      model: 'old-model',
    }
    await getDb().profiles.put(profile())
    await getDb().keys.put(key(1))
    await putTestChat(
      chat({
        settings,
        configurationVersion: 4,
        modelResolution: {
          intentId: 'intent-a',
          target,
          sourceModelId: 'old-model',
          expectedConfigurationVersion: 4,
        },
      }),
    )
    const backend = new BeforeFirstTransactionBackend(async () => {
      await getDb().keys.put(key(2))
    })
    __setLockBackendForTests(backend)

    const result = await executePlannedCommand({
      kind: 'chat.resolve-model',
      chatId: 'chat-a',
      intentId: 'intent-a',
      target,
      modelId: 'resolved-model',
      expectedConfigurationVersion: 4,
      now: 3,
    })

    expect(result).toEqual({ kind: 'invalid', reason: 'model-resolution-target-mismatch' })
    const stored = await getDb().chats.get('chat-a')
    expect(stored?.settings.model).toBe('old-model')
    expect(stored?.modelResolution?.intentId).toBe('intent-a')
    expect(backend.logicalNames[0]).toContain('key:key-a')
  })
})
