import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installBrowserCommandMutationJournal,
  runBrowserCommandTransaction,
} from '../../src/store/browser-command-mutation-journal'
import { deleteChatOwnedPhysicalStorageCollectionWithKnownBytes } from '../../src/store/byte-owner-mutation'
import { NatterDb } from '../../src/store/db'
import { createIndexedDbLockBackend } from '../../src/store/locks'
import type { MessageBodyRow } from '../../src/store/message-storage'
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

  it('tracks NatterDb transactions without losing the Dexie transaction context', async () => {
    const db = new NatterDb(`browser-command-journal-natter-${crypto.randomUUID()}`)
    databases.push(db)
    await db.open()

    const result = await db.transaction('rw', [db.profiles, db.settings], (tx) =>
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
      [
        db.configurationLinks,
        db.configurationPresetCatalogRows,
        db.presets,
        db.profiles,
        db.settings,
      ],
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

    const result = await db.transaction('rw', db.messageBodies, (tx) =>
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
  db.version(1).stores({ rows: 'id' })
  databases.push(db)
  await db.open()
  return db
}
