import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Chat, ChatId, MessageId } from '../../src/core/types'
import { isBrowserCommandFanoutBudgetExceededError } from '../../src/store/browser-command-fanout-budget'
import {
  installBrowserCommandMutationJournal,
  recordBrowserCommandInvalidation,
  recordBrowserCommandOwnerInvalidation,
  runBrowserCommandTransaction,
} from '../../src/store/browser-command-mutation-journal'
import {
  activateBrowserWorkspaceCatchupJournals,
  BROWSER_WORKSPACE_CATCHUP_ACTIVE_ID,
  browserWorkspaceCatchupTransactionTableNames,
  deactivateBrowserWorkspaceCatchupJournals,
} from '../../src/store/browser-workspace-catchup-journal'
import { deleteChatOwnedPhysicalStorageCollectionWithKnownBytes } from '../../src/store/byte-owner-mutation'
import { NatterDb } from '../../src/store/db'
import { createIndexedDbLockBackend } from '../../src/store/locks'
import type { MessageBodyRow } from '../../src/store/message-storage'
import type { PhysicalStorageTableName } from '../../src/store/physical-storage-tables'
import { browserWorkspaceCatchupJournalTableName } from '../../src/store/physical-storage-tables'
import {
  type SemanticOperationReceiptFragment,
  withSemanticOperationExactReceiptAccumulator,
} from '../../src/store/semantic-operation-capability'
import { estimateStoredValueBytes } from '../../src/store/storage-size-estimate'
import {
  localTransactionActivityStats,
  resumeLocalTransactionAdmissions,
  stopLocalTransactionAdmissions,
  waitForLocalTransactionIdle,
} from '../../src/store/transaction-activity'
import { readBrowserWorkspaceMeta } from '../../src/store/workspace-meta'

const databases: Dexie[] = []

beforeEach(() => {
  if (!localTransactionActivityStats().accepting) resumeLocalTransactionAdmissions()
})

afterEach(async () => {
  for (const db of databases.splice(0)) {
    db.close()
    await Dexie.delete(db.name)
  }
  await waitForLocalTransactionIdle()
  stopLocalTransactionAdmissions()
})

describe('browser command mutation journal', () => {
  it('routes every invalidation producer into the bound exact receipt', async () => {
    const db = await openDatabase()
    const chatId = 'chat' as ChatId
    const messageId = 'message' as MessageId

    const result = await db.transaction('rw', db.table('rows'), (tx) =>
      runBrowserCommandTransaction(tx, (tracked) =>
        withSemanticOperationExactReceiptAccumulator<
          PhysicalStorageTableName,
          SemanticOperationReceiptFragment<PhysicalStorageTableName>
        >(tracked, (receipt) => {
          recordBrowserCommandInvalidation(tracked, {
            kind: 'message-header',
            chatId,
            messageIds: [messageId],
          })
          recordBrowserCommandOwnerInvalidation(tracked, {
            kind: 'stream-lease',
            chatId,
            streamIds: ['stream'],
          })
          return receipt.snapshotFragment()
        }),
      ),
    )

    expect(result.value.dependencies).toEqual([
      { kind: 'message-header', chatId, messageIds: [messageId] },
      { kind: 'stream-lease', chatId, streamIds: ['stream'] },
    ])
    expect(result.facts.invalidations).toEqual(result.value.dependencies)
  })

  it('observes exact primary and secondary reads only when requested', async () => {
    const db = await openDatabase()
    const storedRows = [
      { id: 'one', value: 1 },
      { id: 'two', value: 2 },
      { id: 'three', value: 3 },
    ]
    await db.table('rows').bulkPut(storedRows)
    const firstBytes = estimateStoredValueBytes(storedRows[0])
    const allBytes = storedRows.reduce((total, row) => total + estimateStoredValueBytes(row), 0)

    const observed = await db.transaction('r', db.table('rows'), (tx) =>
      runBrowserCommandTransaction(
        tx,
        async (tracked) => {
          await tracked.table('rows').get('one')
          await tracked.table('rows').get('missing')
          await tracked.table('rows').bulkGet(['one', 'missing'])
          await tracked.table('rows').where('value').above(0).toArray()
          await tracked.table('rows').where('value').above(1).count()
          await tracked
            .table('rows')
            .where('value')
            .above(0)
            .each(() => undefined)
        },
        { observePhysicalReads: true },
      ),
    )

    expect(observed.facts.physicalReads).toEqual(
      expect.arrayContaining([
        {
          tableName: 'rows',
          indexKind: 'primary',
          operation: 'get',
          requestCount: 2,
          rowCount: 2,
          maxRequestRows: 1,
          estimatedBytes: firstBytes,
        },
        {
          tableName: 'rows',
          indexKind: 'primary',
          operation: 'get-many',
          requestCount: 1,
          rowCount: 2,
          maxRequestRows: 2,
          estimatedBytes: firstBytes,
        },
        {
          tableName: 'rows',
          indexKind: 'secondary',
          indexName: 'value',
          operation: 'query',
          requestCount: 1,
          rowCount: 3,
          maxRequestRows: 3,
          estimatedBytes: allBytes,
        },
        {
          tableName: 'rows',
          indexKind: 'secondary',
          indexName: 'value',
          operation: 'count',
          requestCount: 1,
          rowCount: 2,
          maxRequestRows: 2,
          estimatedBytes: 0,
        },
        {
          tableName: 'rows',
          indexKind: 'secondary',
          indexName: 'value',
          operation: 'open-cursor',
          requestCount: 1,
          rowCount: 3,
          maxRequestRows: 3,
          estimatedBytes: allBytes,
        },
      ]),
    )
    expect(observed.facts.physicalReads).toHaveLength(5)
    expect(observed.facts.readConflictAddresses).toEqual([
      'rows\u0000s:3:one',
      'rows\u0000s:3:two',
      'rows\u0000s:5:three',
      'rows\u0000s:7:missing',
    ])
    expect(observed.facts.readConflictScopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: 'rows',
          indexName: 'value',
          keyPath: 'value',
          anyMutation: true,
        }),
        expect.objectContaining({
          tableName: 'rows',
          indexName: 'value',
          keyPath: 'value',
          anyMutation: true,
        }),
      ]),
    )
    expect(observed.facts.readConflictScopes).toHaveLength(2)

    const unobserved = await db.transaction('r', db.table('rows'), (tx) =>
      runBrowserCommandTransaction(tx, (tracked) => tracked.table('rows').get('one')),
    )
    expect(unobserved.facts.physicalReads).toEqual([])
    expect(unobserved.facts.readConflictAddresses).toEqual([])
    expect(unobserved.facts.readConflictScopes).toEqual([])
  })

  it('aborts the whole direct transaction before an over-budget fanout can commit', async () => {
    const db = await openDatabase()
    await db
      .table('rows')
      .bulkPut(Array.from({ length: 100 }, (_, index) => ({ id: `row-${index}`, value: index })))
    let visited = 0

    const operation = db.transaction('rw', db.table('rows'), (tx) =>
      runBrowserCommandTransaction(
        tx,
        async (tracked) => {
          await tracked.table('rows').put({ id: 'must-rollback', value: -1 })
          await tracked
            .table('rows')
            .orderBy('value')
            .each(() => {
              visited += 1
            })
        },
        {
          fanoutBudget: {
            maxReadRequestRows: 8,
            maxReadRequestBytes: 1024 * 1024,
            maxWriteRows: 8,
            maxWriteBytes: 1024 * 1024,
          },
        },
      ),
    )

    await expect(operation).rejects.toSatisfy(isBrowserCommandFanoutBudgetExceededError)
    expect(visited).toBe(8)
    expect(await db.table('rows').get('must-rollback')).toBeUndefined()
    expect(await db.table('rows').count()).toBe(100)
  })

  it('does not mistake a dependency chain of point reads for row fanout', async () => {
    const db = await openDatabase()
    await db
      .table('rows')
      .bulkPut(Array.from({ length: 100 }, (_, index) => ({ id: `row-${index}`, value: index })))

    await expect(
      db.transaction('rw', db.table('rows'), (tx) =>
        runBrowserCommandTransaction(
          tx,
          async (tracked) => {
            for (let index = 0; index < 100; index += 1) {
              await tracked.table('rows').get(`row-${index}`)
            }
            await tracked.table('rows').put({ id: 'point-read-commit', value: -1 })
          },
          {
            fanoutBudget: {
              maxReadRequestRows: 8,
              maxReadRequestBytes: 1024 * 1024,
              maxWriteRows: 8,
              maxWriteBytes: 1024 * 1024,
            },
          },
        ),
      ),
    ).resolves.toMatchObject({ value: undefined })
    expect(await db.table('rows').get('point-read-commit')).toEqual({
      id: 'point-read-commit',
      value: -1,
    })

    const writeOperation = db.transaction('rw', db.table('rows'), (tx) =>
      runBrowserCommandTransaction(
        tx,
        async (tracked) => {
          for (let index = 0; index < 9; index += 1) {
            await tracked.table('rows').put({ id: `must-rollback-${index}`, value: index })
          }
        },
        {
          fanoutBudget: {
            maxReadRequestRows: 8,
            maxReadRequestBytes: 1024 * 1024,
            maxWriteRows: 8,
            maxWriteBytes: 1024 * 1024,
          },
        },
      ),
    )
    await expect(writeOperation).rejects.toSatisfy(isBrowserCommandFanoutBudgetExceededError)
    expect(await db.table('rows').where('id').startsWith('must-rollback-').count()).toBe(0)
  })

  it('bounds direct work by the page plus its largest physical value', async () => {
    const db = await openDatabase()
    const largest = { id: 'largest', value: 'x'.repeat(4_096) }
    const companion = { id: 'companion', value: 'small' }

    await expect(
      db.transaction('rw', db.table('rows'), (tx) =>
        runBrowserCommandTransaction(
          tx,
          async (tracked) => {
            await tracked.table('rows').put(largest)
            await tracked.table('rows').put(companion)
          },
          {
            fanoutBudget: {
              maxReadRequestRows: 8,
              maxReadRequestBytes: 128,
              maxWriteRows: 8,
              maxWriteBytes: 128,
            },
          },
        ),
      ),
    ).resolves.toMatchObject({ value: undefined })

    const operation = db.transaction('rw', db.table('rows'), (tx) =>
      runBrowserCommandTransaction(
        tx,
        async (tracked) => {
          await tracked.table('rows').put({ id: 'second-large', value: 'y'.repeat(4_096) })
          await tracked.table('rows').put({ id: 'must-rollback', value: 'z'.repeat(4_096) })
        },
        {
          fanoutBudget: {
            maxReadRequestRows: 8,
            maxReadRequestBytes: 128,
            maxWriteRows: 8,
            maxWriteBytes: 128,
          },
        },
      ),
    )

    await expect(operation).rejects.toSatisfy(isBrowserCommandFanoutBudgetExceededError)
    expect(await db.table('rows').get('second-large')).toBeUndefined()
    expect(await db.table('rows').get('must-rollback')).toBeUndefined()
  })

  it('includes mutation-internal identity reads in command physical work', async () => {
    const db = await openDatabase()
    await db.table('rows').put({ id: 'one', value: 1 })

    const result = await db.transaction('rw', db.table('rows'), (tx) =>
      runBrowserCommandTransaction(tx, (tracked) => tracked.table('rows').delete('one'), {
        observePhysicalReads: true,
      }),
    )

    expect(result.facts.physicalReads).toEqual([
      {
        tableName: 'rows',
        indexKind: 'primary',
        operation: 'get-many',
        requestCount: 1,
        rowCount: 1,
        maxRequestRows: 1,
        estimatedBytes: estimateStoredValueBytes({ id: 'one', value: 1 }),
      },
    ])
    expect(result.facts.finalizationPhysicalReads).toEqual([])
    expect(result.facts.physicalMutations).toEqual([
      expect.objectContaining({ tableName: 'rows', key: 'one', operation: 'delete' }),
    ])
  })

  it('observes write request shape only when requested', async () => {
    const db = await openDatabase()
    const rows = [
      { id: 'one', value: 'a' },
      { id: 'two', value: 'bb' },
    ]

    const observed = await db.transaction('rw', db.table('rows'), (tx) =>
      runBrowserCommandTransaction(
        tx,
        async (tracked) => {
          await tracked.table('rows').bulkPut(rows)
          await tracked.table('rows').delete('one')
        },
        { observePhysicalWrites: true },
      ),
    )

    expect(observed.facts.physicalWrites).toEqual([
      {
        tableName: 'rows',
        operation: 'put',
        requestCount: 1,
        rowCount: 2,
        maxRequestRows: 2,
      },
      {
        tableName: 'rows',
        operation: 'delete',
        requestCount: 1,
        rowCount: 1,
        maxRequestRows: 1,
      },
    ])

    const unobserved = await db.transaction('rw', db.table('rows'), (tx) =>
      runBrowserCommandTransaction(tx, (tracked) =>
        tracked.table('rows').put({ id: 'three', value: 'ccc' }),
      ),
    )
    expect(unobserved.facts.physicalWrites).toEqual([])
  })

  it('keeps submitted write work distinct from successful mutation identities', async () => {
    const db = await openDatabase()
    await db.table('rows').add({ id: 'existing', value: 'old' })
    const submitted = [
      { id: 'existing', value: 'conflict' },
      { id: 'inserted', value: 'new' },
    ]

    const result = await db.transaction('rw', db.table('rows'), (tx) =>
      runBrowserCommandTransaction(
        tx,
        async (tracked) => {
          await tracked
            .table('rows')
            .bulkAdd(submitted)
            .catch(() => undefined)
        },
        { observePhysicalWrites: true },
      ),
    )

    expect(result.facts.physicalWrites).toEqual([
      {
        tableName: 'rows',
        operation: 'add',
        requestCount: 1,
        rowCount: 2,
        maxRequestRows: 2,
      },
    ])
    expect(result.facts.physicalMutations).toEqual([
      expect.objectContaining({ key: 'inserted', operation: 'write' }),
    ])
    expect(result.facts.successfulMutations).toBe(1)
  })

  it('returns transaction-local facts only after a non-empty mutation commits', async () => {
    const db = await openDatabase()

    const committed = await db.transaction('rw', db.table('rows'), (tx) =>
      runBrowserCommandTransaction(tx, async (tracked) => {
        await db.table('rows').put({ id: 'one', value: 1 })
        await db.table('rows').put({ id: 'two', value: 2 })
        expect(tracked.active).toBe(true)
        return 'committed'
      }),
    )

    expect(committed.value).toBe('committed')
    expect(committed.facts).toMatchObject({
      tableNames: ['rows'],
      successfulMutations: 2,
      invalidations: [],
      internalMutationEvidence: [],
      attachmentReferenceStates: [],
      attachmentRows: [],
      messageRevisions: [],
      childSlots: [],
      chatStates: [],
    })
    expect(committed.facts.physicalMutations).toEqual([
      expect.objectContaining({ tableName: 'rows', rowId: 'one', operation: 'write' }),
      expect.objectContaining({ tableName: 'rows', rowId: 'two', operation: 'write' }),
    ])
  })

  it('does not return facts or rows from an aborted transaction', async () => {
    const db = await openDatabase()

    await expect(
      db.transaction('rw', db.table('rows'), (tx) =>
        runBrowserCommandTransaction(tx, async (tracked) => {
          await tracked.table('rows').put({ id: 'rolled-back', value: 1 })
          throw new Error('rollback')
        }),
      ),
    ).rejects.toThrow('rollback')

    expect(await db.table('rows').count()).toBe(0)
  })

  it('keeps simultaneous transaction journals isolated', async () => {
    const left = await openDatabase()
    const right = await openDatabase()

    const [leftResult, rightResult] = await Promise.all([
      left.transaction('rw', left.table('rows'), (tx) =>
        runBrowserCommandTransaction(tx, async (tracked) => {
          await tracked.table('rows').put({ id: 'left', value: 1 })
        }),
      ),
      right.transaction('rw', right.table('rows'), (tx) =>
        runBrowserCommandTransaction(tx, async (tracked) => {
          await tracked.table('rows').put({ id: 'right', value: 2 })
          await tracked.table('rows').put({ id: 'right-2', value: 3 })
        }),
      ),
    ])

    expect(leftResult.facts).toMatchObject({ tableNames: ['rows'], successfulMutations: 1 })
    expect(rightResult.facts).toMatchObject({ tableNames: ['rows'], successfulMutations: 2 })
    expect(leftResult.facts.physicalMutations).toHaveLength(1)
    expect(rightResult.facts.physicalMutations).toHaveLength(2)
  })

  it('tracks NatterDb transactions without always-on catch-up write amplification', async () => {
    const db = new NatterDb(`browser-command-journal-natter-${crypto.randomUUID()}`)
    databases.push(db)
    await db.open()

    const result = await db.transaction('rw', ['profiles', 'settings'], (tx) =>
      runBrowserCommandTransaction(tx, async () => {
        await db.settings.put({ key: 'journal:first', value: 1 })
        await db.settings.put({ key: 'journal:second', value: 2 })
      }),
    )

    expect(result.facts).toMatchObject({ tableNames: ['settings'], successfulMutations: 2 })
    expect(result.facts.physicalMutations.map((mutation) => mutation.key)).toEqual([
      'journal:first',
      'journal:second',
    ])
    expect(await db.table(browserWorkspaceCatchupJournalTableName('settings')).toArray()).toEqual(
      [],
    )

    await activateBrowserWorkspaceCatchupJournals(db)
    await db.transaction('rw', ['settings'], (tx) =>
      runBrowserCommandTransaction(tx, () => db.settings.put({ key: 'journal:active', value: 3 })),
    )
    expect(await db.table(browserWorkspaceCatchupJournalTableName('settings')).toArray()).toEqual([
      expect.objectContaining({
        id: BROWSER_WORKSPACE_CATCHUP_ACTIVE_ID,
        sourceTableName: 'settings',
      }),
      expect.objectContaining({
        id: 's:14:journal:active',
        sourceKey: 'journal:active',
        sourceTableName: 'settings',
      }),
    ])

    await deactivateBrowserWorkspaceCatchupJournals(db)
    await db.transaction('rw', ['settings'], (tx) =>
      runBrowserCommandTransaction(tx, () =>
        db.settings.put({ key: 'journal:inactive', value: 4 }),
      ),
    )
    expect(await db.table(browserWorkspaceCatchupJournalTableName('settings')).toArray()).toEqual(
      [],
    )
  })

  it('retains only existing chat identities when rich publication evidence exceeds its cache', async () => {
    const db = new NatterDb(`browser-command-journal-thin-chat-${crypto.randomUUID()}`)
    databases.push(db)
    await db.open()
    await db.table('chats').put({ id: 'existing-chat', title: 'before' })

    const existing = await db.transaction('rw', ['chats'], (tx) =>
      runBrowserCommandTransaction(
        tx,
        () => db.table('chats').put({ id: 'existing-chat', title: 'after' }),
        { retainFullChatStates: false },
      ),
    )
    expect(existing.facts.chatStates).toEqual([{ chatId: 'existing-chat', initialExists: true }])

    const created = await db.transaction('rw', ['chats'], (tx) =>
      runBrowserCommandTransaction(
        tx,
        () => db.table('chats').add({ id: 'created-chat', title: 'created' }),
        { retainFullChatStates: false },
      ),
    )
    expect(created.facts.chatStates).toEqual([
      {
        chatId: 'created-chat',
        chat: { id: 'created-chat', title: 'created' },
        initialExists: false,
      },
    ])
  })

  it('degrades rich chat cache evidence without limiting a multi-page transaction', async () => {
    const db = new NatterDb(`browser-command-journal-adaptive-chat-${crypto.randomUUID()}`)
    databases.push(db)
    await db.open()
    const chats = Array.from({ length: 130 }, (_, index) => ({
      id: `adaptive-chat-${String(index).padStart(3, '0')}`,
      title: 'before',
    }))
    await db.table('chats').bulkPut(chats)

    const result = await db.transaction('rw', ['chats'], (tx) =>
      runBrowserCommandTransaction(tx, async () => {
        for (let offset = 0; offset < chats.length; offset += 32) {
          await db
            .table('chats')
            .bulkPut(chats.slice(offset, offset + 32).map((chat) => ({ ...chat, title: 'after' })))
        }
      }),
    )

    expect(result.facts.successfulMutations).toBe(130)
    expect(result.facts.chatStates).toHaveLength(130)
    expect(result.facts.chatStates).toEqual(
      chats.map((chat) => ({ chatId: chat.id, initialExists: true })),
    )
    expect(
      (await db.table<Chat, string>('chats').bulkGet(chats.map((chat) => chat.id))).every(
        (chat) => chat?.title === 'after',
      ),
    ).toBe(true)
  })

  it('rolls a catch-up key back with its source mutation and preserves disjoint table scopes', async () => {
    const db = new NatterDb(`browser-command-journal-rollback-${crypto.randomUUID()}`)
    databases.push(db)
    await db.open()
    const tables = browserWorkspaceCatchupTransactionTableNames(['settings'])
    expect(tables).toEqual(['settings', 'replacementCatchup__settings'])
    expect(browserWorkspaceCatchupTransactionTableNames(['messages'])).toEqual([
      'messages',
      'replacementCatchup__messages',
    ])
    await activateBrowserWorkspaceCatchupJournals(db)

    await expect(
      db.transaction('rw', ['settings'], (tx) =>
        runBrowserCommandTransaction(tx, async () => {
          await db.settings.put({ key: 'journal:rolled-back', value: true })
          throw new Error('rollback')
        }),
      ),
    ).rejects.toThrow('rollback')

    expect(await db.settings.get('journal:rolled-back')).toBeUndefined()
    expect(
      await db
        .table(browserWorkspaceCatchupJournalTableName('settings'))
        .get('s:19:journal:rolled-back'),
    ).toBeUndefined()
    expect(
      await db
        .table(browserWorkspaceCatchupJournalTableName('settings'))
        .get(BROWSER_WORKSPACE_CATCHUP_ACTIVE_ID),
    ).toBeDefined()
  })

  it('tracks the exact transaction behind the IndexedDB lock fence', async () => {
    const db = new NatterDb(`browser-command-journal-lock-${crypto.randomUUID()}`)
    databases.push(db)
    await db.open()
    const backend = createIndexedDbLockBackend({
      openDatabase: async () => db,
      leaseMs: 10_000,
      renewMs: 2_000,
      retryMs: 1,
    })

    const result = await backend.run(
      ['journal-test'],
      async (grant) => {
        await readBrowserWorkspaceMeta(db)
        return grant.runTransaction(db, ['settings'], (tx) =>
          runBrowserCommandTransaction(tx, async () => {
            await db.settings.put({ key: 'journal:locked-first', value: 1 })
            await db.settings.put({ key: 'journal:locked-second', value: 2 })
          }),
        )
      },
      { database: db },
    )

    expect(result.facts).toMatchObject({ tableNames: ['settings'], successfulMutations: 2 })
    backend.dispose?.()
  })

  it('keeps a multi-table import-shaped transaction active', async () => {
    const db = new NatterDb(`browser-command-journal-import-${crypto.randomUUID()}`)
    databases.push(db)
    await db.open()

    const result = await db.transaction(
      'rw',
      ['configurationLinks', 'configurationPresetCatalogRows', 'presets', 'profiles', 'settings'],
      (tx) =>
        runBrowserCommandTransaction(tx, async () => {
          await db.profiles.get('missing')
          await db.presets.toArray()
          await db.presets.toArray()
          await tx
            .table<{ id: string; sortIndex: number }, string>('presets')
            .add({ id: 'imported', sortIndex: 0 })
          await tx
            .table<{ id: string }, string>('configurationPresetCatalogRows')
            .add({ id: 'imported' })
          await db.configurationLinks.bulkPut([])
        }),
    )

    expect(result.facts.tableNames).toEqual(['configurationPresetCatalogRows', 'presets'])
  })

  it('leaves non-command migration and replacement clears outside command enforcement', async () => {
    const db = new NatterDb(`browser-command-journal-clear-${crypto.randomUUID()}`)
    databases.push(db)
    await db.open()
    await db.settings.put({ key: 'clear-me', value: true })

    await expect(
      db.transaction('rw', db.settings, () => db.settings.clear()),
    ).resolves.toBeUndefined()

    expect(await db.settings.count()).toBe(0)
  })

  it('rejects anonymous range deletion only inside a journaled command transaction', async () => {
    const db = new NatterDb(`browser-command-journal-range-${crypto.randomUUID()}`)
    databases.push(db)
    await db.open()
    await db.settings.bulkPut([
      { key: 'range:a', value: 1 },
      { key: 'range:b', value: 2 },
    ])

    await expect(
      db.transaction('rw', db.settings, (tx) =>
        runBrowserCommandTransaction(tx, () =>
          db.settings.where(':id').between('range:a', 'range:z').delete(),
        ),
      ),
    ).rejects.toThrow('BrowserCommandExactDeleteRangeForbidden:settings')
  })

  it('records a deleted cold body by key without retaining its body graph', async () => {
    const db = new NatterDb(`browser-command-journal-body-${crypto.randomUUID()}`)
    databases.push(db)
    await db.open()
    const sentinel = `cold-body-${'x'.repeat(100_000)}`
    await db.messageBodies.put({
      id: 'message-a',
      chatId: 'chat-a',
      bodyVersion: 1,
      updatedAt: 1,
      content: [{ type: 'text', text: sentinel }],
    })

    const result = await db.transaction('rw', ['messageBodies'], (tx) =>
      runBrowserCommandTransaction(tx, async () => {
        await deleteChatOwnedPhysicalStorageCollectionWithKnownBytes<MessageBodyRow, string>(
          tx,
          'messageBodies',
          ['chat-a'],
          100_000,
        )
      }),
    )

    expect(result.facts.physicalMutations).toEqual([
      expect.objectContaining({
        tableName: 'messageBodies',
        messageId: 'message-a',
        operation: 'delete',
      }),
    ])
    expect(result.facts.physicalOwnerScopes).toEqual([
      expect.objectContaining({ kind: 'chat', ownerIds: ['chat-a'] }),
    ])
    expect(JSON.stringify(result.facts)).not.toContain(sentinel)
  })
})

async function openDatabase(): Promise<Dexie> {
  const db = new Dexie(`browser-command-journal-${crypto.randomUUID()}`)
  installBrowserCommandMutationJournal(db)
  db.version(1).stores({ rows: 'id,value' })
  databases.push(db)
  await db.open()
  return db
}
