import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modelCatalogQueryForConnectionKind, modelsCacheKey } from '../../src/core/cache-keys'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { RECENT_MODEL_RECENCY_KEY, RECENT_MODELS_KEY } from '../../src/core/global-settings'
import { EMPTY_TEXT_TEMPLATE, type SavedTextTemplate } from '../../src/core/text-templates'
import type {
  Chat,
  ChatPreset,
  ConfigurationRequestRevision,
  ConnectionProfile,
  KeyRecord,
  PromptPreset,
} from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { runBrowserCommandTransaction } from '../../src/store/browser-command-mutation-journal'
import { executeConfigurationCommandInBrowser } from '../../src/store/browser-configuration-domain'
import type {
  BrowserCommandSessionPort,
  BrowserLockedCommandPort,
} from '../../src/store/browser-domain-mutations'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  configurationProfileCatalogProjectionRow,
  configurationPromptPresetCatalogProjectionRow,
} from '../../src/store/configuration-catalog-projection'
import type {
  ConfigurationDomainCommand,
  ConfigurationDomainResult,
} from '../../src/store/configuration-domain-contract'
import {
  configurationOwnerKey,
  configurationRequestRevisionKey,
  configurationTargetKey,
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
import { readPresetOrderIds } from '../../src/store/preset-order'
import {
  assertSemanticOperationExactInvalidations,
  assertSemanticOperationExactPhysicalMutations,
  assertSemanticOperationExactPhysicalReads,
  assertSemanticOperationExactPhysicalWrites,
  assertSemanticOperationReplay,
  attachSemanticOperationPhysicalIo,
  collectSemanticOperationPhysicalWrites,
  semanticOperationExecutionParts,
  semanticOperationResourceNames,
} from '../../src/store/semantic-operation-capability'
import { registerPhysicalMutationTransaction } from '../../src/store/storage-compaction-state'
import { normalizeWorkspaceDependencies } from '../../src/store/workspace-protocol'
import { putTestChat, putTestChats } from '../helpers/chats'

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
      readSemanticOperationPreflight: (plan, operation) =>
        db.transaction(
          'r',
          plan.tableNames.map((tableName) => db.table(tableName)),
          async (tx) => operation(bindFencedTransaction(tx, plan)),
        ),
      executeSemanticOperation: (descriptor, resourceInput, operation) =>
        lockSession.withResourceLocks(
          semanticOperationResourceNames(descriptor, resourceInput),
          (grant) =>
            grant.runTransaction(db, descriptor.transaction.tableNames, async (tx) => {
              registerPhysicalMutationTransaction(tx)
              const committed = await runBrowserCommandTransaction(
                tx,
                (transaction) => {
                  const fenced = bindFencedTransaction(transaction, descriptor.transaction)
                  return collectSemanticOperationPhysicalWrites(
                    fenced,
                    descriptor.exactPhysicalWrites?.receiptSource,
                    () => operation(fenced),
                  )
                },
                {
                  observePhysicalReads: descriptor.exactPhysicalReads !== undefined,
                  observePhysicalWrites: descriptor.exactPhysicalWrites !== undefined,
                },
              )
              assertPhysicalTransactionTablesDeclared(
                descriptor.transaction,
                committed.facts.tableNames,
              )
              const execution = semanticOperationExecutionParts(committed.value.value)
              const receipt = attachSemanticOperationPhysicalIo(
                execution.receipt,
                committed.value.fragment,
                committed.facts.physicalReads,
              )
              assertSemanticOperationReplay(descriptor, resourceInput, receipt)
              const didMutateStorage = committed.facts.successfulMutations > 0
              assertSemanticOperationExactInvalidations(
                descriptor,
                resourceInput,
                normalizeWorkspaceDependencies([
                  ...committed.facts.invalidations,
                  ...(committed.facts.chatStates.length > 0
                    ? [
                        {
                          kind: 'chat' as const,
                          chatIds: committed.facts.chatStates.map(({ chatId }) => chatId),
                        },
                        {
                          kind: 'sidebar' as const,
                          chatIds: committed.facts.chatStates.map(({ chatId }) => chatId),
                        },
                      ]
                    : []),
                ]),
                didMutateStorage,
                receipt,
              )
              assertSemanticOperationExactPhysicalMutations(
                descriptor,
                resourceInput,
                committed.facts.physicalMutations,
                committed.facts.successfulMutations,
                receipt,
              )
              assertSemanticOperationExactPhysicalReads(
                descriptor,
                resourceInput,
                committed.facts.physicalReads,
                true,
                receipt,
              )
              assertSemanticOperationExactPhysicalWrites(
                descriptor,
                resourceInput,
                committed.facts.physicalWrites,
                true,
                receipt,
              )
              return execution.value
            }),
        ),
      completeSemanticOperation: (descriptor, resourceInput, value, receipt) => {
        assertSemanticOperationReplay(descriptor, resourceInput, receipt)
        assertSemanticOperationExactInvalidations(descriptor, resourceInput, [], false, receipt)
        assertSemanticOperationExactPhysicalMutations(descriptor, resourceInput, [], 0, receipt)
        assertSemanticOperationExactPhysicalReads(descriptor, resourceInput, [], false, receipt)
        return Promise.resolve(value)
      },
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
    return executeConfigurationCommandInBrowser(command, commandMeta)
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

function promptPreset(overrides: Partial<PromptPreset> = {}): PromptPreset {
  return {
    id: 'prompt-a',
    kind: 'system',
    name: 'System',
    text: 'Initial prompt',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

async function seedModelsHeader(target: ConfigurationRequestRevision, fetchedAt = 4) {
  const queryKey = modelsCacheKey(modelCatalogQueryForConnectionKind('openrouter'))
  const row = {
    profileId: target.profileId,
    profileRevision: configurationRequestRevisionKey(target),
    queryKey,
    fetchedAt,
    payloadId: 'sha256:models-a',
    payloadByteLength: 1,
  }
  await getDb().models.put(row)
  return {
    kind: 'cached' as const,
    queryKey,
    profileRevision: row.profileRevision,
    payloadId: row.payloadId,
    payloadByteLength: row.payloadByteLength,
    fetchedAt,
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
  it('keeps missing-key profile edits and duplication inside one lifecycle atom', async () => {
    await expect(
      executePlannedCommand({
        kind: 'connection.create',
        profile: profile(),
        key: key(0),
        now: 2,
      }),
    ).resolves.toMatchObject({
      kind: 'connection-saved',
      profile: { id: 'profile-a' },
      key: { id: 'key-a' },
    })
    await expect(
      executePlannedCommand({ kind: 'key.delete', keyId: 'key-a', now: 3 }),
    ).resolves.toMatchObject({ kind: 'key-saved', changed: true, deleted: true })
    const backend = new BeforeFirstTransactionBackend(async () => undefined)
    __setLockBackendForTests(backend)

    await expect(
      executePlannedCommand({
        kind: 'connection.edit',
        profileId: 'profile-a',
        patch: { name: 'Renamed without material' },
        expectedRequestRevision: 3,
        now: 4,
      }),
    ).resolves.toMatchObject({
      kind: 'connection-saved',
      profile: { id: 'profile-a', name: 'Renamed without material', apiKeyRef: 'key-a' },
    })
    await expect(
      executePlannedCommand({
        kind: 'connection.edit',
        profileId: 'profile-a',
        patch: { archived: true },
        now: 5,
      }),
    ).resolves.toMatchObject({
      kind: 'connection-saved',
      profile: { id: 'profile-a', archived: true, apiKeyRef: 'key-a' },
    })
    await expect(
      executePlannedCommand({
        kind: 'connection.duplicate',
        sourceId: 'profile-a',
        copyId: 'profile-copy',
        now: 6,
      }),
    ).resolves.toMatchObject({
      kind: 'connection-saved',
      profile: { id: 'profile-copy', apiKeyRef: 'key-a', archived: false },
    })
    await expect(
      executePlannedCommand({
        kind: 'connection.edit',
        profileId: 'profile-a',
        patch: { apiKeyRef: 'key-a' },
        replacementKey: key(0),
        now: 7,
      }),
    ).resolves.toMatchObject({
      kind: 'connection-saved',
      profile: { id: 'profile-a', apiKeyRef: 'key-a' },
      key: { id: 'key-a', materialRevision: 0 },
    })

    expect(await getDb().keys.get('key-a')).toMatchObject({ materialRevision: 0 })
    expect(backend.logicalNames).toEqual([
      ['profile:profile-a'],
      ['profile:profile-a'],
      ['profile:profile-a', 'profile:profile-copy'],
      [
        'configuration-target:key:key-a',
        'discovery-cache:endpoints:profile-a',
        'discovery-cache:models:profile-a',
        'discovery-cache:privacyPolicies:profile-a',
        'key:key-a',
        'profile:profile-a',
      ],
    ])
  })

  it('deletes and reassigns a connection through one fixed-resource fanout atom', async () => {
    const source = profile()
    const replacement: ConnectionProfile = {
      ...profile(),
      id: 'profile-b',
      name: 'Replacement',
    }
    await executePlannedCommand({
      kind: 'connection.create',
      profile: source,
      key: key(0),
      now: 2,
    })
    await executePlannedCommand({
      kind: 'connection.create',
      profile: replacement,
      now: 3,
    })
    const preset: ChatPreset = {
      id: 'preset-source',
      name: 'Source preset',
      connectionProfileId: source.id,
      settings: { ...cloneDefaultChatSettings(), profileId: source.id },
      createdAt: 4,
      updatedAt: 4,
    }
    await executePlannedCommand({ kind: 'chat-preset.create', preset, now: 4 })
    await putTestChat(
      chat({
        id: 'chat-source',
        settings: { ...cloneDefaultChatSettings(), profileId: source.id },
      }),
    )
    const backend = new BeforeFirstTransactionBackend(async () => undefined)
    __setLockBackendForTests(backend)

    await expect(
      executePlannedCommand({
        kind: 'connection.delete',
        profileId: source.id,
        reassignTo: replacement.id,
        now: 10,
      }),
    ).resolves.toEqual({
      kind: 'connection-deleted',
      profileId: source.id,
      affectedPresetIds: [preset.id],
      affectedChatIds: ['chat-source'],
      deletedKeyIds: [],
      fallbackProfileId: replacement.id,
    })

    expect(await getDb().profiles.get(source.id)).toBeUndefined()
    expect(await getDb().presets.get(preset.id)).toMatchObject({
      connectionProfileId: replacement.id,
      settings: { profileId: replacement.id },
    })
    expect(await getDb().chats.get('chat-source')).toMatchObject({
      settings: { profileId: replacement.id },
    })
    expect(backend.logicalNames).toEqual([
      [
        `configuration-target:profile:${source.id}`,
        `configuration-target:profile:${replacement.id}`,
        `discovery-cache:endpoints:${source.id}`,
        `discovery-cache:models:${source.id}`,
        `discovery-cache:privacyPolicies:${source.id}`,
        'preset-order',
        `profile:${source.id}`,
        `profile:${replacement.id}`,
      ],
    ])
    expect(backend.logicalNames.flat()).not.toEqual(
      expect.arrayContaining([
        'profile-catalog',
        'preset-catalog',
        'discovery-cache:retention',
        'chat-meta:chat-source',
        `preset:${preset.id}`,
        'key:key-a',
      ]),
    )
  })

  it('resets one selected chat and discovery state only for a request-material edit', async () => {
    await executePlannedCommand({
      kind: 'connection.create',
      profile: profile(),
      key: key(0),
      now: 2,
    })
    const before = chat({
      id: 'chat-reset',
      settings: {
        ...cloneDefaultChatSettings(),
        profileId: 'profile-a',
        model: 'old-model',
      },
      configurationVersion: 4,
    })
    await putTestChat(before)
    const backend = new BeforeFirstTransactionBackend(async () => undefined)
    __setLockBackendForTests(backend)

    await expect(
      executePlannedCommand({
        kind: 'connection.edit',
        profileId: 'profile-a',
        patch: { baseUrl: 'https://new.example/v1' },
        expectedRequestRevision: 3,
        resetModelChatId: before.id,
        now: 10,
      }),
    ).resolves.toMatchObject({
      kind: 'connection-saved',
      profile: {
        id: 'profile-a',
        baseUrl: 'https://new.example/v1',
        requestRevision: 4,
      },
      affectedChatIds: [before.id],
    })

    expect(await getDb().chats.get(before.id)).toMatchObject({
      settings: { profileId: 'profile-a', model: '' },
      configurationVersion: 5,
    })
    expect(backend.logicalNames).toEqual([
      [
        `chat-meta:${before.id}`,
        'discovery-cache:endpoints:profile-a',
        'discovery-cache:models:profile-a',
        'discovery-cache:privacyPolicies:profile-a',
        'profile:profile-a',
      ],
    ])
  })

  it('touches one key row without coupling usage recency to target-link fanout', async () => {
    await getDb().keys.put(key(1))
    const backend = new BeforeFirstTransactionBackend(async () => undefined)
    __setLockBackendForTests(backend)
    const targetLinkQuery = vi.spyOn(getDb().configurationLinks, 'where')
    let keyUpdates = 0
    const observeUpdate = () => {
      keyUpdates += 1
    }
    getDb().keys.hook.updating.subscribe(observeUpdate)
    try {
      await expect(
        executePlannedCommand({ kind: 'key.touch', keyId: 'key-a', now: 10 }),
      ).resolves.toMatchObject({
        kind: 'key-saved',
        keyId: 'key-a',
        changed: true,
        deleted: false,
        key: { lastUsedAt: 10 },
      })
      await expect(
        executePlannedCommand({ kind: 'key.touch', keyId: 'key-a', now: 9 }),
      ).resolves.toMatchObject({
        kind: 'key-saved',
        keyId: 'key-a',
        changed: false,
        deleted: false,
        key: { lastUsedAt: 10 },
      })
      await expect(
        executePlannedCommand({ kind: 'key.touch', keyId: 'key-missing', now: 11 }),
      ).resolves.toEqual({
        kind: 'missing',
        entity: 'key',
        id: 'key-missing',
      })
    } finally {
      getDb().keys.hook.updating.unsubscribe(observeUpdate)
    }

    expect(targetLinkQuery).not.toHaveBeenCalled()
    expect(keyUpdates).toBe(1)
    expect(backend.logicalNames).toEqual([['key:key-a'], ['key:key-a'], ['key:key-missing']])
  })

  it.each([
    {
      label: 'put',
      seed: false,
      command: {
        kind: 'key.put',
        key: { ...key(0), ciphertext: 'created' },
        expectedMaterialRevision: null,
        now: 10,
      } as const,
      currentVersion: 0,
      ciphertext: 'created',
    },
    {
      label: 'material replace',
      seed: true,
      command: {
        kind: 'key.material-replace',
        key: { ...key(1), ciphertext: 'replacement' },
        expectedMaterialRevision: 0,
        now: 10,
      } as const,
      currentVersion: 1,
      ciphertext: 'replacement',
    },
  ])('treats exact $label replay as conflict without a second key mutation', async ({
    seed,
    command,
    currentVersion,
    ciphertext,
  }) => {
    if (seed) await getDb().keys.put(key(0))
    let mutations = 0
    const observeMutation = () => {
      mutations += 1
    }
    getDb().keys.hook.creating.subscribe(observeMutation)
    getDb().keys.hook.updating.subscribe(observeMutation)
    try {
      await expect(executePlannedCommand(command)).resolves.toMatchObject({
        kind: 'key-saved',
        keyId: 'key-a',
        changed: true,
        deleted: false,
      })
      await expect(executePlannedCommand(command)).resolves.toMatchObject({
        kind: 'conflict',
        reason: 'key-material-revision',
        currentVersion,
      })
    } finally {
      getDb().keys.hook.creating.unsubscribe(observeMutation)
      getDb().keys.hook.updating.unsubscribe(observeMutation)
    }

    expect(mutations).toBe(1)
    expect(await getDb().keys.get('key-a')).toMatchObject({
      ciphertext,
      materialRevision: currentVersion,
    })
  })

  it('keeps key-material work exact and independent of linked-profile cardinality', async () => {
    await getDb().keys.put(key(0))
    await getDb().profiles.put(profile())
    await getDb().configurationLinks.put({
      id: 'profile-a:key-a',
      ownerKind: 'profile',
      ownerId: 'profile-a',
      ownerKey: configurationOwnerKey('profile', 'profile-a'),
      targetKind: 'key',
      targetId: 'key-a',
      targetKey: configurationTargetKey('key', 'key-a'),
      slot: 'api-key',
    })
    const backend = new BeforeFirstTransactionBackend(async () => undefined)
    __setLockBackendForTests(backend)
    const targetLinkQuery = vi.spyOn(getDb().configurationLinks, 'where')

    await expect(
      executePlannedCommand({
        kind: 'key.material-replace',
        key: { ...key(1), ciphertext: 'replacement' },
        expectedMaterialRevision: 0,
        now: 10,
      }),
    ).resolves.toMatchObject({
      kind: 'key-saved',
      keyId: 'key-a',
      changed: true,
      deleted: false,
    })
    await expect(
      executePlannedCommand({
        kind: 'key.material-replace',
        key: { ...key(2), ciphertext: 'stale' },
        expectedMaterialRevision: 0,
        now: 11,
      }),
    ).resolves.toMatchObject({
      kind: 'conflict',
      reason: 'key-material-revision',
      currentVersion: 1,
    })
    await expect(
      executePlannedCommand({ kind: 'key.delete', keyId: 'missing-key', now: 12 }),
    ).resolves.toEqual({
      kind: 'key-saved',
      keyId: 'missing-key',
      changed: false,
      deleted: true,
    })
    await expect(
      executePlannedCommand({ kind: 'key.delete', keyId: 'key-a', now: 13 }),
    ).resolves.toMatchObject({
      kind: 'key-saved',
      keyId: 'key-a',
      changed: true,
      deleted: true,
    })

    expect(targetLinkQuery).not.toHaveBeenCalled()
    expect(backend.logicalNames).toEqual([
      ['key:key-a'],
      ['key:key-a'],
      ['key:missing-key'],
      ['key:key-a'],
    ])
  })

  it('changes a linked chat profile in one exact atom and makes replay a no-op', async () => {
    await putTestChats([
      chat({
        folderId: 'folder-a',
        settings: {
          ...cloneDefaultChatSettings(),
          profileId: 'profile-a',
        },
      }),
      chat({
        id: 'chat-b',
        folderId: 'folder-a',
        updatedAt: 5,
      }),
    ])
    const backend = new BeforeFirstTransactionBackend(async () => undefined)
    __setLockBackendForTests(backend)

    await expect(
      executePlannedCommand({
        kind: 'chat.settings-patch',
        chatId: 'chat-a',
        patch: { set: { profileId: 'profile-b' }, clear: [] },
        now: 10,
      }),
    ).resolves.toMatchObject({
      kind: 'chat-updated',
      changed: true,
      chat: { id: 'chat-a', settings: { profileId: 'profile-b' } },
    })
    await expect(
      executePlannedCommand({
        kind: 'chat.settings-patch',
        chatId: 'chat-a',
        patch: { set: { profileId: 'profile-b' }, clear: [] },
        now: 11,
      }),
    ).resolves.toMatchObject({
      kind: 'chat-updated',
      changed: false,
      chat: { id: 'chat-a', settings: { profileId: 'profile-b' } },
    })
    await expect(
      executePlannedCommand({
        kind: 'chat.settings-patch',
        chatId: 'missing-chat',
        patch: { set: { profileId: 'profile-b' }, clear: [] },
        now: 12,
      }),
    ).resolves.toEqual({
      kind: 'missing',
      entity: 'chat',
      id: 'missing-chat',
    })

    expect(await getDb().configurationProfileUsageRows.toArray()).toEqual([
      {
        id: 'profile-b',
        presetCount: 0,
        activePresetCount: 0,
        chatCount: 1,
        activeChatCount: 1,
      },
    ])
    expect(backend.logicalNames).toEqual([
      ['chat-meta:chat-a', 'configuration-target:profile:profile-b'],
      ['chat-meta:chat-a', 'configuration-target:profile:profile-b'],
      ['chat-meta:missing-chat', 'configuration-target:profile:profile-b'],
    ])
  })

  it('updates cataloged rows from authoritative transitions without rereading projections', async () => {
    const storedProfile = profile()
    const storedPrompt = promptPreset()
    await Promise.all([
      getDb().profiles.put(storedProfile),
      getDb().promptPresets.put(storedPrompt),
      getDb().configurationProfileCatalogRows.put(
        configurationProfileCatalogProjectionRow(storedProfile),
      ),
      getDb().configurationPromptPresetCatalogRows.put(
        configurationPromptPresetCatalogProjectionRow(storedPrompt),
      ),
    ])
    const backend = new BeforeFirstTransactionBackend(async () => undefined)
    __setLockBackendForTests(backend)

    await expect(
      executePlannedCommand({ kind: 'connection.touch', profileId: storedProfile.id, now: 10 }),
    ).resolves.toMatchObject({
      kind: 'connection-saved',
      profile: { id: storedProfile.id, lastUsedAt: 10 },
    })
    await expect(
      executePlannedCommand({ kind: 'connection.touch', profileId: storedProfile.id, now: 9 }),
    ).resolves.toMatchObject({
      kind: 'connection-saved',
      profile: { id: storedProfile.id, lastUsedAt: 10 },
    })
    await expect(
      executePlannedCommand({ kind: 'connection.touch', profileId: 'missing-profile', now: 11 }),
    ).resolves.toEqual({ kind: 'missing', entity: 'profile', id: 'missing-profile' })

    await expect(
      executePlannedCommand({
        kind: 'prompt-preset.rename',
        presetId: storedPrompt.id,
        name: 'Renamed',
        now: 14,
      }),
    ).resolves.toMatchObject({
      kind: 'prompt-preset-saved',
      preset: { id: storedPrompt.id, name: 'Renamed' },
    })
    await expect(
      executePlannedCommand({
        kind: 'prompt-preset.rename',
        presetId: storedPrompt.id,
        name: 'Renamed',
        now: 15,
      }),
    ).resolves.toMatchObject({ kind: 'prompt-preset-saved', preset: { name: 'Renamed' } })
    await expect(
      executePlannedCommand({
        kind: 'prompt-preset.rename',
        presetId: 'missing-prompt',
        name: 'Missing',
        now: 16,
      }),
    ).resolves.toEqual({ kind: 'missing', entity: 'prompt-preset', id: 'missing-prompt' })

    expect(backend.logicalNames).toEqual([
      ['profile:profile-a'],
      ['profile:profile-a'],
      ['profile:missing-profile'],
      ['prompt-preset:prompt-a'],
      ['prompt-preset:prompt-a'],
      ['prompt-preset:missing-prompt'],
    ])
  })

  it('moves preset order through one exact bounded semantic operation', async () => {
    const storedProfile = profile()
    await getDb().profiles.put(storedProfile)
    const preset = (id: string, name: string): ChatPreset => ({
      id,
      name,
      connectionProfileId: storedProfile.id,
      settings: { ...cloneDefaultChatSettings(), profileId: storedProfile.id },
      createdAt: 1,
      updatedAt: 1,
    })
    const first = preset('preset-a', 'A')
    const second = preset('preset-b', 'B')
    await executePlannedCommand({
      kind: 'chat-preset.create',
      preset: first,
      now: 1,
    })
    await executePlannedCommand({
      kind: 'chat-preset.create',
      preset: second,
      now: 2,
    })
    const backend = new BeforeFirstTransactionBackend(async () => undefined)
    __setLockBackendForTests(backend)

    await expect(
      executePlannedCommand({
        kind: 'chat-preset.move',
        presetId: second.id,
        afterPresetId: null,
        now: 3,
      }),
    ).resolves.toMatchObject({
      kind: 'chat-preset-saved',
      affectedPresetIds: [second.id],
    })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.move',
        presetId: second.id,
        afterPresetId: null,
        now: 4,
      }),
    ).resolves.toEqual({ kind: 'configuration-noop' })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.move',
        presetId: second.id,
        afterPresetId: second.id,
        now: 5,
      }),
    ).resolves.toEqual({ kind: 'invalid', reason: 'preset-order-anchor-self' })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.move',
        presetId: 'missing',
        afterPresetId: null,
        now: 6,
      }),
    ).resolves.toEqual({ kind: 'missing', entity: 'chat-preset', id: 'missing' })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.move',
        presetId: first.id,
        afterPresetId: 'missing-anchor',
        now: 7,
      }),
    ).resolves.toEqual({
      kind: 'missing',
      entity: 'chat-preset',
      id: 'missing-anchor',
    })
    await getDb().presets.update(first.id, { archived: true })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.move',
        presetId: second.id,
        afterPresetId: first.id,
        now: 8,
      }),
    ).resolves.toEqual({ kind: 'invalid', reason: 'preset-order-anchor-archived' })
    await getDb().presets.update(second.id, { archived: true })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.move',
        presetId: second.id,
        afterPresetId: null,
        now: 9,
      }),
    ).resolves.toEqual({ kind: 'invalid', reason: 'preset-order-target-archived' })

    expect(
      await getDb().transaction('r', getDb().presetOrderState, getDb().presetOrderBlocks, (tx) =>
        readPresetOrderIds(tx),
      ),
    ).toEqual([second.id, first.id])
    expect(backend.logicalNames).toEqual([
      ['preset-order', `preset:${second.id}`],
      ['preset-order', `preset:${second.id}`],
      ['preset-order', `preset:${second.id}`],
      ['preset-order', 'preset:missing'],
      ['preset-order', 'preset:missing-anchor', `preset:${first.id}`],
      ['preset-order', `preset:${first.id}`, `preset:${second.id}`],
      ['preset-order', `preset:${second.id}`],
    ])
  })

  it('runs the bounded preset lifecycle through one owner without a catalog-wide lock', async () => {
    const storedProfile = profile()
    await getDb().profiles.put(storedProfile)
    const first: ChatPreset = {
      id: 'preset-a',
      name: 'A',
      connectionProfileId: storedProfile.id,
      settings: { ...cloneDefaultChatSettings(), profileId: storedProfile.id },
      createdAt: 1,
      updatedAt: 1,
    }
    const backend = new BeforeFirstTransactionBackend(async () => undefined)
    __setLockBackendForTests(backend)

    await expect(
      executePlannedCommand({ kind: 'chat-preset.create', preset: first, now: 1 }),
    ).resolves.toMatchObject({
      kind: 'chat-preset-saved',
      preset: { id: first.id, name: 'A' },
    })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.update',
        presetId: first.id,
        patch: { name: 'Renamed' },
        now: 2,
      }),
    ).resolves.toMatchObject({
      kind: 'chat-preset-saved',
      preset: { id: first.id, name: 'Renamed' },
    })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.duplicate',
        sourceId: first.id,
        copyId: 'preset-b',
        now: 3,
      }),
    ).resolves.toMatchObject({
      kind: 'chat-preset-saved',
      preset: { id: 'preset-b', name: 'Renamed (copy)', archived: false },
    })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.set-archived',
        presetId: 'preset-b',
        archived: true,
        now: 4,
      }),
    ).resolves.toMatchObject({
      kind: 'chat-preset-saved',
      preset: { id: 'preset-b', archived: true },
    })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.set-archived',
        presetId: 'preset-b',
        archived: true,
        now: 5,
      }),
    ).resolves.toEqual({ kind: 'configuration-noop' })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.delete',
        presetId: 'preset-b',
        now: 6,
      }),
    ).resolves.toMatchObject({
      kind: 'chat-preset-saved',
      affectedPresetIds: ['preset-b'],
      affectedChatIds: [],
    })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.update',
        presetId: 'missing',
        patch: { name: 'Missing' },
        now: 7,
      }),
    ).resolves.toEqual({ kind: 'missing', entity: 'chat-preset', id: 'missing' })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.create',
        preset: {
          ...first,
          id: 'preset-missing-profile',
          connectionProfileId: 'missing-profile',
          settings: { ...first.settings, profileId: 'missing-profile' },
        },
        now: 8,
      }),
    ).resolves.toEqual({ kind: 'missing', entity: 'profile', id: 'missing-profile' })

    expect(backend.logicalNames).toEqual([
      [
        'configuration-target:profile:profile-a',
        'preset-order',
        'preset:preset-a',
        'profile:profile-a',
      ],
      ['preset-order', 'preset:preset-a'],
      ['preset-order', 'preset:preset-a', 'preset:preset-b'],
      ['preset-order', 'preset:preset-b'],
      ['preset-order', 'preset:preset-b'],
      ['configuration-target:chat-preset:preset-b', 'preset-order', 'preset:preset-b'],
      ['preset-order', 'preset:missing'],
      [
        'configuration-target:profile:missing-profile',
        'preset-order',
        'preset:preset-missing-profile',
        'profile:missing-profile',
      ],
    ])
    expect(backend.logicalNames.flat()).not.toContain('preset-catalog')
  })

  it('rolls back every preset lifecycle projection when a derived catalog write fails', async () => {
    const storedProfile = profile()
    await getDb().profiles.put(storedProfile)
    const preset: ChatPreset = {
      id: 'preset-rollback',
      name: 'Rollback',
      connectionProfileId: storedProfile.id,
      settings: { ...cloneDefaultChatSettings(), profileId: storedProfile.id },
      createdAt: 1,
      updatedAt: 1,
    }
    const rejectProjection = () => {
      throw new Error('injected preset catalog projection failure')
    }
    getDb().configurationPresetCatalogRows.hook.creating.subscribe(rejectProjection)
    try {
      await expect(
        executePlannedCommand({ kind: 'chat-preset.create', preset, now: 1 }),
      ).rejects.toThrow('injected preset catalog projection failure')
    } finally {
      getDb().configurationPresetCatalogRows.hook.creating.unsubscribe(rejectProjection)
    }

    expect(await getDb().presets.get(preset.id)).toBeUndefined()
    expect(
      await getDb()
        .configurationLinks.where('ownerKey')
        .equals(configurationOwnerKey('chat-preset', preset.id))
        .count(),
    ).toBe(0)
    expect(await getDb().configurationProfileUsageRows.toArray()).toEqual([])
    expect(await getDb().configurationPresetCatalogRows.get(preset.id)).toBeUndefined()
    expect(await getDb().presetOrderMembership.get(preset.id)).toBeUndefined()
    expect(
      await getDb().transaction('r', getDb().presetOrderState, getDb().presetOrderBlocks, (tx) =>
        readPresetOrderIds(tx),
      ),
    ).toEqual([])
  })

  it('composes preset create-link and save through the bounded lifecycle owner', async () => {
    const storedProfile = profile()
    const settings = {
      ...cloneDefaultChatSettings(),
      profileId: storedProfile.id,
      model: 'preset-model',
    }
    await Promise.all([
      getDb().profiles.put(storedProfile),
      putTestChat(chat({ settings: structuredClone(settings) })),
    ])
    const backend = new BeforeFirstTransactionBackend(async () => undefined)
    __setLockBackendForTests(backend)

    await expect(
      executePlannedCommand({
        kind: 'chat-preset.create-and-link',
        chatId: 'chat-a',
        preset: {
          id: 'preset-linked',
          name: 'Linked',
          connectionProfileId: storedProfile.id,
          settings,
        },
        now: 10,
      }),
    ).resolves.toMatchObject({
      kind: 'chat-preset-saved',
      preset: { id: 'preset-linked', settings: { model: 'preset-model' } },
      chatId: 'chat-a',
      chatChanged: true,
    })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.save',
        presetId: 'preset-linked',
        settings: { ...settings, model: 'saved-model' },
        chatModel: { chatId: 'chat-a', modelId: 'chat-model' },
        now: 11,
      }),
    ).resolves.toMatchObject({
      kind: 'chat-preset-saved',
      preset: { id: 'preset-linked', settings: { model: 'saved-model' } },
      chatId: 'chat-a',
      chatChanged: true,
    })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.create-and-link',
        chatId: 'chat-a',
        preset: {
          id: 'preset-linked',
          name: 'Conflict',
          connectionProfileId: storedProfile.id,
          settings,
        },
        now: 12,
      }),
    ).resolves.toEqual({ kind: 'conflict', reason: 'link-changed' })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.save',
        presetId: 'missing-preset',
        settings,
        now: 13,
      }),
    ).resolves.toEqual({
      kind: 'missing',
      entity: 'chat-preset',
      id: 'missing-preset',
    })

    expect((await getDb().chats.get('chat-a'))?.settings.model).toBe('chat-model')
    expect((await getDb().presets.get('preset-linked'))?.settings.model).toBe('saved-model')
    expect(backend.logicalNames).toEqual([
      [
        'chat-meta:chat-a',
        'configuration-target:chat-preset:preset-linked',
        'configuration-target:profile:profile-a',
        'preset-order',
        'preset:preset-linked',
        'profile:profile-a',
      ],
      [
        'chat-meta:chat-a',
        'configuration-target:profile:profile-a',
        'preset:preset-linked',
        'profile:profile-a',
      ],
      [
        'chat-meta:chat-a',
        'configuration-target:chat-preset:preset-linked',
        'configuration-target:profile:profile-a',
        'preset-order',
        'preset:preset-linked',
        'profile:profile-a',
      ],
      ['configuration-target:profile:profile-a', 'preset:missing-preset', 'profile:profile-a'],
    ])
    expect(backend.logicalNames.flat()).not.toContain('preset-catalog')
  })

  it('rolls back create-link preset, catalog, order, and chat when the chat projection fails', async () => {
    const storedProfile = profile()
    const settings = { ...cloneDefaultChatSettings(), profileId: storedProfile.id }
    await Promise.all([
      getDb().profiles.put(storedProfile),
      putTestChat(chat({ settings: structuredClone(settings) })),
    ])
    const rejectChatProjection = () => {
      throw new Error('injected chat projection failure')
    }
    getDb().chatSidebarRows.hook.updating.subscribe(rejectChatProjection)
    try {
      await expect(
        executePlannedCommand({
          kind: 'chat-preset.create-and-link',
          chatId: 'chat-a',
          preset: {
            id: 'preset-composite-rollback',
            name: 'Rollback',
            connectionProfileId: storedProfile.id,
            settings,
          },
          now: 10,
        }),
      ).rejects.toThrow('injected chat projection failure')
    } finally {
      getDb().chatSidebarRows.hook.updating.unsubscribe(rejectChatProjection)
    }

    expect(await getDb().presets.get('preset-composite-rollback')).toBeUndefined()
    expect(await getDb().configurationPresetCatalogRows.get('preset-composite-rollback')).toBe(
      undefined,
    )
    expect(await getDb().presetOrderMembership.get('preset-composite-rollback')).toBeUndefined()
    expect((await getDb().chats.get('chat-a'))?.presetId).toBeUndefined()
  })

  it('clears public recents and their ordering record in one command transaction', async () => {
    await getDb().settings.bulkPut([
      { key: RECENT_MODELS_KEY, value: ['model-b', 'model-a'] },
      {
        key: RECENT_MODEL_RECENCY_KEY,
        value: {
          version: 1,
          entries: [
            { modelId: 'model-b', usedAt: 20, streamId: 'stream-b' },
            { modelId: 'model-a', usedAt: 10, streamId: 'stream-a' },
          ],
        },
      },
    ])

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

  it('reads the latest preset once under the exact chat and preset locks', async () => {
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
    expect(backend.logicalNames).toEqual([['chat-meta:chat-a', 'preset:preset-a']])
  })

  it('composes source-only, chat-only, replay, missing, and conflict selection outcomes', async () => {
    const template: SavedTextTemplate = {
      id: 'user:template-a',
      name: 'Template',
      config: { ...EMPTY_TEXT_TEMPLATE, template: 'template source' },
      createdAt: 1,
      updatedAt: 1,
    }
    const preset: ChatPreset = {
      id: 'preset-a',
      name: 'Preset',
      connectionProfileId: 'profile-a',
      settings: {
        ...cloneDefaultChatSettings(),
        profileId: 'profile-a',
        model: 'selected-model',
      },
      createdAt: 1,
      updatedAt: 1,
    }
    const sourceOnlyPrompt = promptPreset({
      id: 'prompt-source-only',
      text: 'source-only prompt',
    })
    const chatOnlyPrompt = promptPreset({
      id: 'prompt-chat-only',
      text: 'chat-only prompt',
      lastUsedAt: 50,
    })
    const createdPrompt = promptPreset({
      id: 'prompt-created',
      text: 'created prompt',
    })
    await Promise.all([
      putTestChat(
        chat({
          id: 'chat-template',
          settings: { ...cloneDefaultChatSettings(), textTemplate: template.id },
        }),
      ),
      putTestChat(chat({ id: 'chat-preset' })),
      putTestChat(
        chat({
          id: 'chat-prompt-source',
          settings: {
            ...cloneDefaultChatSettings(),
            systemPrompt: sourceOnlyPrompt.text,
            systemPromptPresetId: sourceOnlyPrompt.id,
          },
        }),
      ),
      putTestChat(chat({ id: 'chat-prompt-target' })),
      putTestChat(
        chat({
          id: 'chat-prompt-create',
          settings: {
            ...cloneDefaultChatSettings(),
            systemPrompt: createdPrompt.text,
            systemPromptPresetId: createdPrompt.id,
          },
        }),
      ),
      getDb().presets.put(preset),
      getDb().promptPresets.bulkPut([sourceOnlyPrompt, chatOnlyPrompt]),
      getDb().configurationPromptPresetCatalogRows.bulkPut([
        configurationPromptPresetCatalogProjectionRow(sourceOnlyPrompt),
        configurationPromptPresetCatalogProjectionRow(chatOnlyPrompt),
      ]),
    ])
    const backend = new BeforeFirstTransactionBackend(async () => undefined)
    __setLockBackendForTests(backend)

    await expect(
      executePlannedCommand({
        kind: 'text-template.create-and-select',
        chatId: 'chat-template',
        template,
        now: 10,
      }),
    ).resolves.toMatchObject({
      kind: 'text-template-saved',
      templateId: template.id,
      changed: true,
      affectedChatIds: [],
    })
    await expect(
      executePlannedCommand({
        kind: 'text-template.create-and-select',
        chatId: 'chat-template',
        template,
        now: 11,
      }),
    ).resolves.toEqual({ kind: 'conflict', reason: 'link-changed' })
    await expect(
      executePlannedCommand({
        kind: 'text-template.delete',
        templateId: template.id,
        now: 11,
      }),
    ).resolves.toMatchObject({
      kind: 'text-template-saved',
      templateId: template.id,
      changed: true,
      deleted: true,
      affectedChatIds: ['chat-template'],
    })

    await expect(
      executePlannedCommand({
        kind: 'chat-preset.apply',
        chatId: 'chat-preset',
        presetId: preset.id,
        now: 12,
      }),
    ).resolves.toMatchObject({ kind: 'chat-preset-saved', chatChanged: true })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.apply',
        chatId: 'chat-preset',
        presetId: preset.id,
        now: 13,
      }),
    ).resolves.toMatchObject({ kind: 'chat-preset-saved', chatChanged: false })
    await expect(
      executePlannedCommand({
        kind: 'chat-preset.apply',
        chatId: 'chat-preset',
        presetId: 'missing-preset',
        now: 14,
      }),
    ).resolves.toEqual({
      kind: 'missing',
      entity: 'chat-preset',
      id: 'missing-preset',
    })

    await expect(
      executePlannedCommand({
        kind: 'prompt-preset.load-and-pin',
        chatId: 'chat-prompt-source',
        presetId: sourceOnlyPrompt.id,
        now: 20,
      }),
    ).resolves.toMatchObject({
      kind: 'prompt-preset-saved',
      preset: { lastUsedAt: 20 },
      affectedChatIds: [],
    })
    await expect(
      executePlannedCommand({
        kind: 'prompt-preset.load-and-pin',
        chatId: 'chat-prompt-target',
        presetId: chatOnlyPrompt.id,
        now: 20,
      }),
    ).resolves.toMatchObject({
      kind: 'prompt-preset-saved',
      preset: { lastUsedAt: 50 },
      affectedChatIds: ['chat-prompt-target'],
    })

    await expect(
      executePlannedCommand({
        kind: 'prompt-preset.create-and-pin',
        chatId: 'chat-prompt-create',
        preset: createdPrompt,
        now: 30,
      }),
    ).resolves.toMatchObject({
      kind: 'prompt-preset-saved',
      affectedChatIds: [],
    })
    await expect(
      executePlannedCommand({
        kind: 'prompt-preset.create-and-pin',
        chatId: 'chat-prompt-create',
        preset: createdPrompt,
        now: 31,
      }),
    ).resolves.toEqual({ kind: 'conflict', reason: 'link-changed' })
    await expect(
      executePlannedCommand({
        kind: 'prompt-preset.load-and-pin',
        chatId: 'missing-chat',
        presetId: sourceOnlyPrompt.id,
        now: 32,
      }),
    ).resolves.toEqual({ kind: 'missing', entity: 'chat', id: 'missing-chat' })

    expect(backend.logicalNames).toEqual([
      ['chat-meta:chat-template', `configuration-target:text-template:${template.id}`],
      ['chat-meta:chat-template', `configuration-target:text-template:${template.id}`],
      [`configuration-target:text-template:${template.id}`],
      ['chat-meta:chat-preset', 'preset:preset-a'],
      ['chat-meta:chat-preset', 'preset:preset-a'],
      ['chat-meta:chat-preset', 'preset:missing-preset'],
      [
        'chat-meta:chat-prompt-source',
        'configuration-target:prompt-preset:prompt-source-only',
        'prompt-preset:prompt-source-only',
      ],
      [
        'chat-meta:chat-prompt-target',
        'configuration-target:prompt-preset:prompt-chat-only',
        'prompt-preset:prompt-chat-only',
      ],
      [
        'chat-meta:chat-prompt-create',
        'configuration-target:prompt-preset:prompt-created',
        'prompt-preset:prompt-created',
      ],
      [
        'chat-meta:chat-prompt-create',
        'configuration-target:prompt-preset:prompt-created',
        'prompt-preset:prompt-created',
      ],
      [
        'chat-meta:missing-chat',
        'configuration-target:prompt-preset:prompt-source-only',
        'prompt-preset:prompt-source-only',
      ],
    ])
  })

  it('rolls back a created prompt and its catalog when the selected chat write fails', async () => {
    const before = chat({ id: 'chat-prompt-rollback' })
    const preset = promptPreset({
      id: 'prompt-rollback',
      text: 'must roll back',
    })
    await putTestChat(before)
    const aggregatesBefore = await getDb().configurationCatalogAggregates.toArray()
    const rejectChatWrite = () => {
      throw new Error('injected selected chat failure')
    }
    getDb().chats.hook.updating.subscribe(rejectChatWrite)
    try {
      await expect(
        executePlannedCommand({
          kind: 'prompt-preset.create-and-pin',
          chatId: before.id,
          preset,
          now: 40,
        }),
      ).rejects.toThrow('injected selected chat failure')
    } finally {
      getDb().chats.hook.updating.unsubscribe(rejectChatWrite)
    }

    expect(await getDb().chats.get(before.id)).toEqual(before)
    expect(await getDb().promptPresets.get(preset.id)).toBeUndefined()
    expect(await getDb().configurationPromptPresetCatalogRows.get(preset.id)).toBeUndefined()
    expect(await getDb().configurationCatalogAggregates.toArray()).toEqual(aggregatesBefore)
  })

  it('uses one static prompt-target atom for overwrite and missing outcomes', async () => {
    const preset = promptPreset({
      id: 'prompt-target-atom',
      name: 'Before',
      text: 'old text',
    })
    const selected = chat({ id: 'chat-prompt-target-atom' })
    await Promise.all([
      getDb().promptPresets.put(preset),
      getDb().configurationPromptPresetCatalogRows.put(
        configurationPromptPresetCatalogProjectionRow(preset),
      ),
      putTestChat(selected),
    ])
    const backend = new BeforeFirstTransactionBackend(async () => undefined)
    __setLockBackendForTests(backend)

    await expect(
      executePlannedCommand({
        kind: 'prompt-preset.overwrite-and-pin',
        chatId: selected.id,
        presetId: preset.id,
        text: 'new text',
        now: 20,
      }),
    ).resolves.toMatchObject({
      kind: 'prompt-preset-saved',
      chatId: selected.id,
      affectedChatIds: [selected.id],
      affectedPresetIds: [],
    })
    await expect(
      executePlannedCommand({
        kind: 'prompt-preset.overwrite-and-pin',
        chatId: 'missing-chat',
        presetId: preset.id,
        text: 'new text',
        now: 30,
      }),
    ).resolves.toEqual({
      kind: 'missing',
      entity: 'chat',
      id: 'missing-chat',
    })

    expect(await getDb().promptPresets.get(preset.id)).toMatchObject({
      name: 'Before',
      text: 'new text',
      updatedAt: 20,
      lastUsedAt: 20,
    })
    expect(await getDb().chats.get(selected.id)).toMatchObject({
      settings: {
        systemPrompt: 'new text',
        systemPromptPresetId: preset.id,
      },
      configurationVersion: 1,
    })
    expect(backend.logicalNames).toEqual([
      [
        `chat-meta:${selected.id}`,
        `configuration-target:prompt-preset:${preset.id}`,
        `prompt-preset:${preset.id}`,
      ],
      [
        'chat-meta:missing-chat',
        `configuration-target:prompt-preset:${preset.id}`,
        `prompt-preset:${preset.id}`,
      ],
    ])
  })

  it('switches chat and profile recency in one exact request-target atom', async () => {
    const oldTarget: ConfigurationRequestRevision = {
      profileId: 'profile-a',
      requestRevision: 3,
      key: { kind: 'material', keyId: 'key-a', materialRevision: 1 },
    }
    const nextProfile: ConnectionProfile = {
      ...profile(),
      id: 'profile-b',
      name: 'Missing material',
      apiKeyRef: 'key-b',
      requestRevision: 7,
      lastUsedAt: 1,
    }
    const nextTarget: ConfigurationRequestRevision = {
      profileId: nextProfile.id,
      requestRevision: 7,
      key: { kind: 'missing' },
    }
    const before = chat({
      settings: {
        ...cloneDefaultChatSettings(),
        profileId: 'profile-a',
        model: 'old-model',
      },
      configurationVersion: 4,
      modelResolution: {
        intentId: 'old-intent',
        target: oldTarget,
        sourceModelId: 'old-model',
        expectedConfigurationVersion: 4,
      },
    })
    await Promise.all([
      getDb().profiles.bulkPut([profile(), nextProfile]),
      getDb().keys.put(key(1)),
      getDb().configurationProfileCatalogRows.put(
        configurationProfileCatalogProjectionRow(nextProfile),
      ),
      putTestChat(before),
    ])
    const backend = new BeforeFirstTransactionBackend(async () => undefined)
    __setLockBackendForTests(backend)

    await expect(
      executePlannedCommand({
        kind: 'chat.switch-profile',
        chatId: before.id,
        profileId: nextProfile.id,
        requestKeyId: 'key-b',
        previousProfileId: 'profile-a',
        previousModelResolutionTarget: oldTarget,
        target: nextTarget,
        api: 'chat',
        model: {
          kind: 'pending',
          immediateId: '',
          resolution: {
            intentId: 'new-intent',
            target: nextTarget,
            sourceModelId: 'old-model',
            expectedConfigurationVersion: 5,
          },
        },
        expectedConfigurationVersion: 4,
        now: 10,
      }),
    ).resolves.toMatchObject({
      kind: 'chat-updated',
      changed: true,
      configurationVersion: 5,
      chat: {
        settings: { profileId: nextProfile.id, model: '' },
        modelResolution: { intentId: 'new-intent', target: nextTarget },
      },
      affectedProfileIds: [nextProfile.id],
    })

    expect((await getDb().profiles.get(nextProfile.id))?.lastUsedAt).toBe(10)
    expect(backend.logicalNames).toEqual([
      [
        `chat-meta:${before.id}`,
        'configuration-target:key:key-b',
        `configuration-target:model-resolution:${JSON.stringify(['profile-a', 3, 'key-a', 1])}`,
        `configuration-target:model-resolution:${JSON.stringify(['profile-b', 7, null])}`,
        'configuration-target:profile:profile-a',
        'configuration-target:profile:profile-b',
        'key:key-b',
        'profile:profile-b',
      ],
    ])
  })

  it('keeps chat-only, profile-only, no-op, conflict, and missing switch outcomes explicit', async () => {
    const { apiKeyRef: _apiKeyRef, ...profileWithoutPrimaryKey } = profile()
    const nextProfile: ConnectionProfile = {
      ...profileWithoutPrimaryKey,
      id: 'profile-b',
      name: 'Target',
      requestRevision: 0,
      lastUsedAt: 50,
    }
    const target: ConfigurationRequestRevision = {
      profileId: nextProfile.id,
      requestRevision: 0,
      key: { kind: 'missing' },
    }
    const noOpChat = chat({
      id: 'chat-noop',
      settings: {
        ...cloneDefaultChatSettings(),
        profileId: nextProfile.id,
        model: 'target-model',
        api: 'chat',
      },
      configurationVersion: 2,
    })
    const changeChat = chat({
      id: 'chat-change',
      settings: {
        ...cloneDefaultChatSettings(),
        profileId: 'profile-a',
        model: 'old-model',
      },
      configurationVersion: 3,
    })
    await Promise.all([
      getDb().profiles.put(nextProfile),
      getDb().configurationProfileCatalogRows.put(
        configurationProfileCatalogProjectionRow(nextProfile),
      ),
      putTestChat(noOpChat),
      putTestChat(changeChat),
    ])
    const command = (
      chatId: string,
      expectedConfigurationVersion: number,
      now: number,
      previousProfileId: string,
      profileId = nextProfile.id,
    ) =>
      ({
        kind: 'chat.switch-profile',
        chatId,
        profileId,
        requestKeyId: null,
        previousProfileId,
        previousModelResolutionTarget: null,
        target: { ...target, profileId },
        api: 'chat',
        model: { kind: 'resolved', id: 'target-model' },
        expectedConfigurationVersion,
        now,
      }) as const

    await expect(
      executePlannedCommand(command(noOpChat.id, 2, 60, nextProfile.id)),
    ).resolves.toMatchObject({
      kind: 'chat-updated',
      changed: false,
      affectedProfileIds: [nextProfile.id],
    })
    await expect(
      executePlannedCommand(command(noOpChat.id, 2, 59, nextProfile.id)),
    ).resolves.toMatchObject({
      kind: 'chat-updated',
      changed: false,
    })
    await expect(
      executePlannedCommand(command(changeChat.id, 3, 59, 'profile-a')),
    ).resolves.toMatchObject({
      kind: 'chat-updated',
      changed: true,
      chat: { settings: { profileId: nextProfile.id, model: 'target-model' } },
    })
    await expect(
      executePlannedCommand(command(noOpChat.id, 1, 59, nextProfile.id)),
    ).resolves.toEqual({
      kind: 'conflict',
      reason: 'configuration-version',
      currentVersion: 2,
    })
    await expect(
      executePlannedCommand(command('missing-chat', 0, 59, nextProfile.id)),
    ).resolves.toEqual({ kind: 'missing', entity: 'chat', id: 'missing-chat' })
    await expect(
      executePlannedCommand(command(noOpChat.id, 2, 59, nextProfile.id, 'missing-profile')),
    ).resolves.toEqual({
      kind: 'invalid',
      reason: 'model-resolution-target-mismatch',
    })
  })

  it('keeps switch chat/profile/catalog changes atomic when projection fails', async () => {
    const { apiKeyRef: _apiKeyRef, ...profileWithoutPrimaryKey } = profile()
    const nextProfile: ConnectionProfile = {
      ...profileWithoutPrimaryKey,
      id: 'profile-b',
      name: 'Target',
      requestRevision: 0,
      lastUsedAt: 1,
    }
    const target: ConfigurationRequestRevision = {
      profileId: nextProfile.id,
      requestRevision: 0,
      key: { kind: 'missing' },
    }
    const before = chat({
      settings: { ...cloneDefaultChatSettings(), profileId: 'profile-a', model: 'old-model' },
      configurationVersion: 2,
    })
    await Promise.all([
      getDb().profiles.put(nextProfile),
      getDb().configurationProfileCatalogRows.put(
        configurationProfileCatalogProjectionRow(nextProfile),
      ),
      putTestChat(before),
    ])
    const rejectProjection = () => {
      throw new Error('injected profile catalog projection failure')
    }
    getDb().configurationProfileCatalogRows.hook.updating.subscribe(rejectProjection)
    try {
      await expect(
        executePlannedCommand({
          kind: 'chat.switch-profile',
          chatId: before.id,
          profileId: nextProfile.id,
          requestKeyId: null,
          previousProfileId: 'profile-a',
          previousModelResolutionTarget: null,
          target,
          api: 'chat',
          model: { kind: 'resolved', id: 'new-model' },
          expectedConfigurationVersion: 2,
          now: 10,
        }),
      ).rejects.toThrow('injected profile catalog projection failure')
    } finally {
      getDb().configurationProfileCatalogRows.hook.updating.unsubscribe(rejectProjection)
    }

    expect(await getDb().chats.get(before.id)).toEqual(before)
    expect(await getDb().profiles.get(nextProfile.id)).toEqual(nextProfile)
    expect(await getDb().configurationProfileCatalogRows.get(nextProfile.id)).toEqual(
      configurationProfileCatalogProjectionRow(nextProfile),
    )
  })

  it('rejects a missing-key switch when that exact key becomes material before the atom', async () => {
    const nextProfile: ConnectionProfile = {
      ...profile(),
      id: 'profile-b',
      name: 'Dangling primary key',
      apiKeyRef: 'key-b',
      requestRevision: 7,
    }
    const target: ConfigurationRequestRevision = {
      profileId: nextProfile.id,
      requestRevision: 7,
      key: { kind: 'missing' },
    }
    const before = chat({
      settings: { ...cloneDefaultChatSettings(), profileId: 'profile-a', model: 'old-model' },
      configurationVersion: 2,
    })
    await Promise.all([getDb().profiles.put(nextProfile), putTestChat(before)])
    const backend = new BeforeFirstTransactionBackend(async () => {
      await getDb().keys.put({ ...key(1), id: 'key-b' })
    })
    __setLockBackendForTests(backend)

    await expect(
      executePlannedCommand({
        kind: 'chat.switch-profile',
        chatId: before.id,
        profileId: nextProfile.id,
        requestKeyId: 'key-b',
        previousProfileId: 'profile-a',
        previousModelResolutionTarget: null,
        target,
        api: 'chat',
        model: { kind: 'resolved', id: 'new-model' },
        expectedConfigurationVersion: 2,
        now: 10,
      }),
    ).resolves.toEqual({
      kind: 'invalid',
      reason: 'model-resolution-target-mismatch',
    })
    expect(await getDb().chats.get(before.id)).toEqual(before)
    expect(backend.logicalNames[0]).toContain('key:key-b')
    expect(backend.logicalNames[0]).toContain('configuration-target:key:key-b')
  })

  it('resolves the current model intent through the same bounded target atom', async () => {
    const target: ConfigurationRequestRevision = {
      profileId: 'profile-a',
      requestRevision: 3,
      key: { kind: 'material', keyId: 'key-a', materialRevision: 1 },
    }
    const catalog = await seedModelsHeader(target)
    await Promise.all([
      getDb().profiles.put(profile()),
      getDb().keys.put(key(1)),
      putTestChat(
        chat({
          settings: {
            ...cloneDefaultChatSettings(),
            profileId: 'profile-a',
            model: 'old-model',
          },
          configurationVersion: 4,
          modelResolution: {
            intentId: 'intent-a',
            target,
            sourceModelId: 'old-model',
            expectedConfigurationVersion: 4,
          },
        }),
      ),
    ])
    const backend = new BeforeFirstTransactionBackend(async () => undefined)
    __setLockBackendForTests(backend)

    await expect(
      executePlannedCommand({
        kind: 'chat.resolve-model',
        chatId: 'chat-a',
        intentId: 'intent-a',
        requestKeyId: 'key-a',
        target,
        pendingTarget: target,
        modelId: 'resolved-model',
        catalog,
        expectedConfigurationVersion: 4,
        now: 5,
      }),
    ).resolves.toMatchObject({
      kind: 'chat-updated',
      changed: true,
      chat: { settings: { model: 'resolved-model' } },
      configurationVersion: 5,
    })
    expect((await getDb().chats.get('chat-a'))?.modelResolution).toBeUndefined()
    expect(backend.logicalNames).toEqual([
      [
        'chat-meta:chat-a',
        'configuration-target:key:key-a',
        `configuration-target:model-resolution:${JSON.stringify(['profile-a', 3, 'key-a', 1])}`,
        'configuration-target:profile:profile-a',
        'key:key-a',
        'profile:profile-a',
      ],
    ])
  })

  it('rebases a still-pending model intent onto the current request target', async () => {
    const pendingTarget: ConfigurationRequestRevision = {
      profileId: 'profile-a',
      requestRevision: 2,
      key: { kind: 'material', keyId: 'key-a', materialRevision: 1 },
    }
    const target: ConfigurationRequestRevision = {
      profileId: 'profile-a',
      requestRevision: 3,
      key: { kind: 'material', keyId: 'key-a', materialRevision: 1 },
    }
    const catalog = await seedModelsHeader(target)
    await Promise.all([
      getDb().profiles.put(profile()),
      getDb().keys.put(key(1)),
      putTestChat(
        chat({
          settings: {
            ...cloneDefaultChatSettings(),
            profileId: 'profile-a',
            model: 'old-model',
          },
          configurationVersion: 4,
          modelResolution: {
            intentId: 'intent-a',
            target: pendingTarget,
            sourceModelId: 'old-model',
            expectedConfigurationVersion: 4,
          },
        }),
      ),
    ])

    await expect(
      executePlannedCommand({
        kind: 'chat.resolve-model',
        chatId: 'chat-a',
        intentId: 'intent-a',
        requestKeyId: 'key-a',
        target,
        pendingTarget,
        modelId: 'resolved-model',
        catalog,
        expectedConfigurationVersion: 4,
        now: 5,
      }),
    ).resolves.toMatchObject({
      kind: 'chat-updated',
      changed: true,
      chat: { settings: { model: 'resolved-model' } },
      configurationVersion: 5,
    })
    expect((await getDb().chats.get('chat-a'))?.modelResolution).toBeUndefined()
  })

  it('accepts a transient catalog only while no equal-or-newer durable catalog exists', async () => {
    const target: ConfigurationRequestRevision = {
      profileId: 'profile-a',
      requestRevision: 3,
      key: { kind: 'material', keyId: 'key-a', materialRevision: 1 },
    }
    const queryKey = modelsCacheKey(modelCatalogQueryForConnectionKind('openrouter'))
    await Promise.all([
      getDb().profiles.put(profile()),
      getDb().keys.put(key(1)),
      putTestChat(
        chat({
          settings: {
            ...cloneDefaultChatSettings(),
            profileId: 'profile-a',
            model: 'old-model',
          },
          configurationVersion: 4,
          modelResolution: {
            intentId: 'intent-a',
            target,
            sourceModelId: 'old-model',
            expectedConfigurationVersion: 4,
          },
        }),
      ),
    ])
    const transientCatalog = {
      kind: 'transient' as const,
      queryKey,
      profileRevision: configurationRequestRevisionKey(target),
      catalogId: 'transient:catalog-a',
      fetchedAt: 4,
    }
    const command = {
      kind: 'chat.resolve-model' as const,
      chatId: 'chat-a',
      intentId: 'intent-a',
      requestKeyId: 'key-a',
      target,
      pendingTarget: target,
      modelId: 'resolved-model',
      catalog: transientCatalog,
      expectedConfigurationVersion: 4,
      now: 5,
    }

    await expect(executePlannedCommand(command)).resolves.toMatchObject({
      kind: 'chat-updated',
      changed: true,
      chat: { settings: { model: 'resolved-model' } },
    })

    await putTestChat(
      chat({
        id: 'chat-b',
        settings: {
          ...cloneDefaultChatSettings(),
          profileId: 'profile-a',
          model: 'old-model',
        },
        configurationVersion: 4,
        modelResolution: {
          intentId: 'intent-a',
          target,
          sourceModelId: 'old-model',
          expectedConfigurationVersion: 4,
        },
      }),
    )
    await seedModelsHeader(target, transientCatalog.fetchedAt)

    await expect(executePlannedCommand({ ...command, chatId: 'chat-b' })).resolves.toEqual({
      kind: 'invalid',
      reason: 'model-resolution-catalog-changed',
    })
    expect((await getDb().chats.get('chat-b'))?.modelResolution?.intentId).toBe('intent-a')
  })

  it('rejects a cached model result after its durable catalog header changes', async () => {
    const target: ConfigurationRequestRevision = {
      profileId: 'profile-a',
      requestRevision: 3,
      key: { kind: 'material', keyId: 'key-a', materialRevision: 1 },
    }
    const catalog = await seedModelsHeader(target)
    await Promise.all([
      getDb().profiles.put(profile()),
      getDb().keys.put(key(1)),
      putTestChat(
        chat({
          settings: {
            ...cloneDefaultChatSettings(),
            profileId: 'profile-a',
            model: 'old-model',
          },
          configurationVersion: 4,
          modelResolution: {
            intentId: 'intent-a',
            target,
            sourceModelId: 'old-model',
            expectedConfigurationVersion: 4,
          },
        }),
      ),
    ])
    await getDb().models.update([target.profileId, catalog.queryKey], {
      payloadId: 'sha256:models-b',
      fetchedAt: catalog.fetchedAt + 1,
    })

    await expect(
      executePlannedCommand({
        kind: 'chat.resolve-model',
        chatId: 'chat-a',
        intentId: 'intent-a',
        requestKeyId: 'key-a',
        target,
        pendingTarget: target,
        modelId: 'resolved-model',
        catalog,
        expectedConfigurationVersion: 4,
        now: 5,
      }),
    ).resolves.toEqual({
      kind: 'invalid',
      reason: 'model-resolution-catalog-changed',
    })
    expect((await getDb().chats.get('chat-a'))?.modelResolution?.intentId).toBe('intent-a')
  })

  it('rejects a deferred model result when key material changes before its composite lock', async () => {
    const target: ConfigurationRequestRevision = {
      profileId: 'profile-a',
      requestRevision: 3,
      key: { kind: 'material', keyId: 'key-a', materialRevision: 1 },
    }
    const catalog = await seedModelsHeader(target)
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
      requestKeyId: 'key-a',
      target,
      pendingTarget: target,
      modelId: 'resolved-model',
      catalog,
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
