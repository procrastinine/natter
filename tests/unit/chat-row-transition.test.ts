import Dexie, { type Table, type Transaction } from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, ChatId } from '../../src/core/types'
import { runBrowserCommandTransaction } from '../../src/store/browser-command-mutation-journal'
import { deleteBrowserWorkspaceCompactionState } from '../../src/store/browser-workspace-database-control'
import {
  CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
  CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
  openLinkedChatMutation,
} from '../../src/store/chat-row-transition'
import {
  accumulateChatSidebarAggregateRows,
  type ChatSidebarAggregateProjectionRow,
  type ChatSidebarProjectionRow,
  chatSidebarProjectionRow,
  createChatSidebarAggregateAccumulator,
  materializeChatSidebarAggregateRows,
} from '../../src/store/chat-sidebar-projection'
import { buildChat } from '../../src/store/chats'
import { createDbForTests, type NatterDb } from '../../src/store/db'
import {
  assertPhysicalTransactionTablesDeclared,
  bindFencedTransaction,
  type PhysicalTransactionPlan,
  physicalTransactionPlan,
} from '../../src/store/physical-storage-tables'
import {
  awaitStorageCompactionDebtIdle,
  registerPhysicalMutationTransaction,
} from '../../src/store/storage-compaction-state'

const PRESERVING_PLAN = physicalTransactionPlan(CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY)
const LINKED_PLAN = physicalTransactionPlan(CHAT_ROW_LINKED_TRANSACTION_CAPABILITY)
const databases: NatterDb[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await awaitStorageCompactionDebtIdle()
  const retained = databases.splice(0)
  const names = [...new Set(retained.map((db) => db.name))]
  for (const db of retained) db.close()
  for (const name of names) {
    await deleteBrowserWorkspaceCompactionState(name)
    await Dexie.delete(name)
  }
})

describe('chat row transition', () => {
  it.each([
    'missing',
    'mismatched',
  ] as const)('rolls back canonical, link, usage, and aggregate writes when the prior projection is %s', async (poison) => {
    const db = await openDatabase()
    const previous = chat('strict-prior')
    await executeTransitions(db, LINKED_PLAN, [{ kind: 'add-linked', next: previous }])
    if (poison === 'missing') {
      await db.chatSidebarRows.delete(previous.id)
    } else {
      await db.chatSidebarRows.put(
        chatSidebarProjectionRow({ ...previous, title: 'valid but not the declared prior row' }),
      )
    }
    const before = await transitionState(db, previous.id)
    const tablePrototype = Object.getPrototypeOf(db.chats) as typeof db.chats
    const bulkPut = vi.spyOn(tablePrototype, 'bulkPut')
    const next: Chat = {
      ...previous,
      title: 'next title',
      settings: { ...previous.settings, profileId: 'profile-b' },
      configurationVersion: (previous.configurationVersion ?? 0) + 1,
    }

    await expect(
      executeTransitions(db, LINKED_PLAN, async (tx) => [
        { kind: 'replace-linked', previous: await currentChat(tx, previous.id), next },
      ]),
    ).rejects.toThrow(`ChatSidebarProjectionPreviousMismatch:${previous.id}`)

    expect(tableCallCount(bulkPut, 'configurationLinks')).toBeGreaterThan(0)
    expect(await transitionState(db, previous.id)).toEqual(before)
  })

  it('writes a cold-field replacement without reading or writing sidebar or configuration rows', async () => {
    const db = await openDatabase()
    const previous = chat('cold-fast-path')
    await executeTransitions(db, LINKED_PLAN, [{ kind: 'add-linked', next: previous }])
    const sidebarBefore = await db.chatSidebarRows.get(previous.id)
    const linksBefore = await db.configurationLinks.toArray()
    const usageBefore = await db.configurationProfileUsageRows.toArray()
    const tablePrototype = Object.getPrototypeOf(db.chats) as typeof db.chats
    const bulkGet = vi.spyOn(tablePrototype, 'bulkGet')
    const bulkPut = vi.spyOn(tablePrototype, 'bulkPut')
    const put = vi.spyOn(tablePrototype, 'put')
    const next: Chat = {
      ...previous,
      tokenCalibration: {
        family: {
          totalTextChars: 400,
          totalTextTokens: 100,
          sampleCount: 1,
          updatedAt: 2,
        },
      },
      tokenCalibrationGeneration: 1,
    }

    const committed = await executeTransitions(db, PRESERVING_PLAN, async (tx) => [
      {
        kind: 'replace-preserving-links',
        previous: await currentChat(tx, previous.id),
        next,
      },
    ])

    expect(committed.facts.tableNames).toEqual(['chats'])
    expect(committed.facts.successfulMutations).toBe(1)
    expect(committed.facts.physicalMutations).toEqual([
      expect.objectContaining({ tableName: 'chats', rowId: previous.id, operation: 'write' }),
    ])
    expect(committed.facts.chatStates).toEqual([
      { chatId: previous.id, chat: next, initialExists: true },
    ])
    expect(tableCallCount(bulkGet, 'chats')).toBe(0)
    expect(committed.value.chatWrites).toEqual([
      { chatId: previous.id, transition: 'replace-preserving-links' },
    ])
    expect(committed.value.linkPhases).toEqual([])
    expect(committed.value.fragment.dependencies).toEqual([
      { kind: 'chat', chatIds: [previous.id] },
    ])
    expect(committed.value.fragment.physicalMutations).toEqual([
      { tableName: 'chats', operation: 'write', key: previous.id },
    ])
    expect(committed.value.fragment.physicalReads).toEqual([])
    for (const tableName of ['chatSidebarRows', 'chatSidebarAggregates']) {
      expect(tableCallCount(bulkGet, tableName)).toBe(0)
      expect(tableCallCount(bulkPut, tableName)).toBe(0)
      expect(tableCallCount(put, tableName)).toBe(0)
    }
    expect(await db.chats.get(previous.id)).toEqual(next)
    expect(await db.chatSidebarRows.get(previous.id)).toEqual(sidebarBefore)
    expect(await db.configurationLinks.toArray()).toEqual(linksBefore)
    expect(await db.configurationProfileUsageRows.toArray()).toEqual(usageBefore)
  })

  it('rolls back every linked transition when stored configuration ownership contradicts the declared prior', async () => {
    const db = await openDatabase()
    const previous = chat('configuration-strict-prior')
    await executeTransitions(db, LINKED_PLAN, [{ kind: 'add-linked', next: previous }])
    await db.configurationLinks.clear()
    const before = await transitionState(db, previous.id)
    const next: Chat = {
      ...previous,
      settings: { ...previous.settings, profileId: 'profile-b' },
      configurationVersion: (previous.configurationVersion ?? 0) + 1,
    }

    await expect(
      executeTransitions(db, LINKED_PLAN, async (tx) => [
        { kind: 'replace-linked', previous: await currentChat(tx, previous.id), next },
      ]),
    ).rejects.toThrow(`ConfigurationOwnerLinkPreviousMismatch:chat:${previous.id}`)

    expect(await transitionState(db, previous.id)).toEqual(before)
  })

  it('returns one exact composed receipt for a linked replacement batch', async () => {
    const db = await openDatabase()
    const previous = [chat('receipt-a'), chat('receipt-b')]
    await executeTransitions(
      db,
      LINKED_PLAN,
      previous.map((next) => ({ kind: 'add-linked' as const, next })),
    )

    const committed = await executeLinkedReplacements(db, async (tx) => {
      const current = await currentChats(
        tx,
        previous.map(({ id }) => id),
      )
      return current.map((row, index) => {
        return {
          previous: row,
          next: {
            ...row,
            title: `updated ${index}`,
            settings: { ...row.settings, profileId: 'profile-b' },
            configurationVersion: (row.configurationVersion ?? 0) + 1,
            metaVersion: row.metaVersion + 1,
            summaryVersion: row.summaryVersion + 1,
            updatedAt: 10 + index,
          },
        }
      })
    })

    expect(committed.value.links.removedLinkIds).toEqual([])
    expect(committed.value.links.writtenLinkIds).toHaveLength(2)
    expect(committed.value.links.profileUsageMutations.map(({ profileId }) => profileId)).toEqual([
      'profile-a',
      'profile-b',
    ])
    expect(committed.value.sidebar.mutatedRowIds).toEqual(['receipt-a', 'receipt-b'])
    expect(committed.facts.chatStates.map(({ chatId }) => chatId)).toEqual([
      'receipt-a',
      'receipt-b',
    ])
  })

  it('coalesces repeated linked replacements into one authoritative write', async () => {
    const db = await openDatabase()
    const previous = chat('duplicate-receipt')
    await executeTransitions(db, LINKED_PLAN, [{ kind: 'add-linked', next: previous }])
    const before = await transitionState(db, previous.id)

    const committed = await executeLinkedReplacements(db, async (tx) => {
      const current = await currentChat(tx, previous.id)
      return [
        { previous: current, next: { ...current, title: 'first' } },
        { previous: current, next: { ...current, title: 'final' } },
      ]
    })

    expect(committed.value.chatWrites).toEqual([
      { chatId: previous.id, transition: 'replace-linked' },
    ])
    expect((await db.chats.get(previous.id))?.title).toBe('final')
    expect(await transitionState(db, previous.id)).not.toEqual(before)
  })

  it('rejects a preserving-links lie before any transition in the mixed batch mutates', async () => {
    const db = await openDatabase()
    const previous = chat('preserving-preflight')
    await executeTransitions(db, LINKED_PLAN, [{ kind: 'add-linked', next: previous }])
    const added = chat('must-not-be-added')
    const invalid: Chat = {
      ...previous,
      settings: { ...previous.settings, profileId: 'profile-b' },
    }
    const before = await transitionState(db, previous.id)
    const tablePrototype = Object.getPrototypeOf(db.chats) as typeof db.chats
    const bulkAdd = vi.spyOn(tablePrototype, 'bulkAdd')

    await expect(
      executeTransitions(db, LINKED_PLAN, async (tx) => [
        { kind: 'add-linked', next: added },
        {
          kind: 'replace-preserving-links',
          previous: await currentChat(tx, previous.id),
          next: invalid,
        },
      ]),
    ).rejects.toThrow('SemanticByteOwnerPreservingLinksMismatch:chats')

    expect(tableCallCount(bulkAdd, 'chats')).toBe(0)
    expect(await db.chats.get(added.id)).toBeUndefined()
    expect(await transitionState(db, previous.id)).toEqual(before)
  })

  it('serializes overlapping cold-field writers without losing either update', async () => {
    const db = await openDatabase('chat-row-concurrency')
    const second = createDbForTests(db.name)
    databases.push(second)
    await second.open()
    const previous = chat('overlap')
    await executeTransitions(db, LINKED_PLAN, [{ kind: 'add-linked', next: previous }])
    const results = await Promise.allSettled([
      executeTransitions(db, PRESERVING_PLAN, async (tx) => {
        const current = await currentChat(tx, previous.id)
        return [
          {
            kind: 'replace-preserving-links',
            previous: current,
            next: {
              ...current,
              tokenCalibration: {
                ...current.tokenCalibration,
                left: calibration(1),
              },
            },
          },
        ]
      }),
      executeTransitions(second, PRESERVING_PLAN, async (tx) => {
        const current = await currentChat(tx, previous.id)
        return [
          {
            kind: 'replace-preserving-links',
            previous: current,
            next: {
              ...current,
              tokenCalibration: {
                ...current.tokenCalibration,
                right: calibration(2),
              },
            },
          },
        ]
      }),
    ])

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true)
    const current = await db.chats.get(previous.id)
    expect(current?.tokenCalibration).toEqual({
      left: calibration(1),
      right: calibration(2),
    })
    expect(await db.chatSidebarRows.get(previous.id)).toEqual(
      chatSidebarProjectionRow(current as Chat),
    )
  })

  it('does not use a stale UI snapshot as write eligibility or overwrite current fields', async () => {
    const db = await openDatabase()
    const previous = chat('stale-ui-snapshot')
    await executeTransitions(db, LINKED_PLAN, [{ kind: 'add-linked', next: previous }])
    await executeTransitions(db, PRESERVING_PLAN, async (tx) => {
      const current = await currentChat(tx, previous.id)
      return [
        {
          kind: 'replace-preserving-links',
          previous: current,
          next: { ...current, tokenCalibration: { concurrent: calibration(3) } },
        },
      ]
    })
    const staleUiSnapshot = structuredClone(previous)
    await executeTransitions(db, PRESERVING_PLAN, async (tx) => {
      const current = await currentChat(tx, staleUiSnapshot.id)
      return [
        {
          kind: 'replace-preserving-links',
          previous: current,
          next: { ...current, title: 'accepted current write' },
        },
      ]
    })
    expect(await db.chats.get(previous.id)).toMatchObject({
      title: 'accepted current write',
      tokenCalibration: { concurrent: calibration(3) },
    })
  })

  it('keeps linked additions bounded by pages rather than by a 128-row semantic cap', async () => {
    const db = await openDatabase()
    const rows = Array.from({ length: 256 }, (_, index) =>
      chat(`stress-${String(index).padStart(4, '0')}`, index + 1),
    )
    const tablePrototype = Object.getPrototypeOf(db.chats) as typeof db.chats
    const bulkAdd = vi.spyOn(tablePrototype, 'bulkAdd')

    const added = await executeTransitions(
      db,
      LINKED_PLAN,
      rows.map((next) => ({ kind: 'add-linked' as const, next })),
    )

    expect(tableCallSizes(bulkAdd, 'chats')).toEqual([256])
    const linkPages = tableCallSizes(bulkAdd, 'configurationLinks')
    expect(linkPages).toHaveLength(2)
    expect(linkPages.every((size) => size <= 128)).toBe(true)
    expect(linkPages.reduce((sum, size) => sum + size, 0)).toBe(256)
    expect(added.facts.successfulMutations).toBe(771)
    expect(added.facts.tableNames).toEqual([
      'chatSidebarAggregates',
      'chatSidebarRows',
      'chats',
      'configurationCatalogAggregates',
      'configurationLinks',
      'configurationProfileUsageRows',
    ])
    expect(await db.chats.count()).toBe(256)
    expect(await db.configurationLinks.count()).toBe(256)
    expect(await db.chatSidebarRows.count()).toBe(256)
  }, 30_000)

  it('rolls back earlier configuration pages when the strict prior fails on row 129', async () => {
    const db = await openDatabase()
    const rows = Array.from({ length: 129 }, (_, index) =>
      chat(`late-poison-${String(index).padStart(3, '0')}`, index + 1),
    )
    await executeTransitions(
      db,
      LINKED_PLAN,
      rows.map((next) => ({ kind: 'add-linked' as const, next })),
    )
    const poisoned = rows[128] as Chat
    await db.configurationLinks.where('ownerKey').equals(`chat:${poisoned.id}`).delete()
    const before = await fullTransitionState(db)

    await expect(
      executeTransitions(db, LINKED_PLAN, async (tx) => {
        const current = await currentChats(
          tx,
          rows.map((row) => row.id),
        )
        return current.map((previous) => {
          return {
            kind: 'replace-linked' as const,
            previous,
            next: {
              ...previous,
              settings: { ...previous.settings, profileId: 'profile-b' },
              configurationVersion: (previous.configurationVersion ?? 0) + 1,
            },
          }
        })
      }),
    ).rejects.toThrow(`ConfigurationOwnerLinkPreviousMismatch:chat:${poisoned.id}`)

    expect(await fullTransitionState(db)).toEqual(before)
  }, 30_000)

  it('moves 4,096 rows with one linear canonical and projection transition', async () => {
    const base = chat('linear-base')
    const rows = Array.from(
      { length: 4_096 },
      (_, index): Chat => ({
        ...base,
        id: `linear-${String(index).padStart(4, '0')}`,
        title: `linear ${index}`,
        createdAt: index + 1,
        updatedAt: index + 1,
        lastViewedAt: index + 1,
        lastBranchUpdatedAt: index + 1,
      }),
    )
    const recording = new RecordingChatTransitionTransaction(rows)
    const nextRows = rows.map((previous, index) => ({
      previous,
      next: {
        ...previous,
        folderId: 'folder-a',
        updatedAt: 10_000 + index,
        metaVersion: previous.metaVersion + 1,
      },
    }))
    try {
      const chatMutation = openLinkedChatMutation(recording.transaction)
      await chatMutation.readMany(rows.map((row) => row.id))
      for (const { previous, next } of nextRows) {
        chatMutation.replacePreserving(previous.id, () => next)
      }
      await chatMutation.commit()
    } finally {
      recording.abortForTest()
    }

    expect(recording.callSizes('chats', 'bulkGet')).toEqual([4_096])
    expect(recording.callSizes('chats', 'bulkPut')).toEqual([4_096])
    expect(recording.callSizes('chatSidebarRows', 'bulkGet')).toEqual([4_096])
    expect(recording.callSizes('chatSidebarRows', 'bulkPut')).toEqual([4_096])
    expect(recording.callSizes('chatSidebarAggregates', 'bulkGet')).toEqual([2])
    expect(recording.callSizes('chatSidebarAggregates', 'put')).toEqual([1])
    expect(recording.callSizes('chatSidebarAggregates', 'bulkPut')).toEqual([1])
    expect(recording.calls).toHaveLength(7)
    expect(recording.chatRows.size).toBe(4_096)
    expect(
      [...recording.sidebarRows.values()].filter((row) => row.folderId === 'folder-a'),
    ).toHaveLength(4_096)
    expect(recording.aggregateRows.get('folder:folder-a')).toMatchObject({
      count: 4_096,
      activeCount: 4_096,
    })
  }, 30_000)
})

function chat(id: ChatId, now = 1): Chat {
  return buildChat({
    id,
    title: id,
    now,
    settings: { ...cloneDefaultChatSettings(), profileId: 'profile-a' },
  })
}

async function openDatabase(prefix = 'chat-row-transition'): Promise<NatterDb> {
  const db = createDbForTests(`${prefix}-${crypto.randomUUID()}`)
  databases.push(db)
  await db.open()
  return db
}

async function executeTransitions(
  db: NatterDb,
  plan: PhysicalTransactionPlan,
  transitionInput:
    | readonly TestChatRowWriteTransitionInput[]
    | ((
        tx: Transaction,
      ) =>
        | readonly TestChatRowWriteTransitionInput[]
        | Promise<readonly TestChatRowWriteTransitionInput[]>),
) {
  return db.transaction(
    'rw',
    plan.tableNames.map((tableName) => db.table(tableName)),
    async (raw) => {
      registerPhysicalMutationTransaction(raw)
      const committed = await runBrowserCommandTransaction(raw, async (tx) => {
        const fenced = bindFencedTransaction(tx, plan)
        const transitions =
          typeof transitionInput === 'function' ? await transitionInput(fenced) : transitionInput
        const chatMutation = openLinkedChatMutation(fenced)
        for (const transition of transitions) {
          if (transition.kind === 'add-linked') {
            await chatMutation.add(transition.next)
            continue
          }
          await chatMutation.read(transition.next.id)
          if (transition.kind === 'replace-linked') {
            chatMutation.replaceLinked(transition.next.id, () => transition.next)
          } else {
            chatMutation.replacePreserving(transition.next.id, () => transition.next)
          }
        }
        return chatMutation.commit()
      })
      assertPhysicalTransactionTablesDeclared(plan, committed.facts.tableNames)
      return committed
    },
  )
}

async function executeLinkedReplacements(
  db: NatterDb,
  replacementInput:
    | readonly { readonly previous: Chat; readonly next: Chat }[]
    | ((
        tx: Transaction,
      ) =>
        | readonly { readonly previous: Chat; readonly next: Chat }[]
        | Promise<readonly { readonly previous: Chat; readonly next: Chat }[]>),
) {
  return db.transaction(
    'rw',
    LINKED_PLAN.tableNames.map((tableName) => db.table(tableName)),
    async (raw) => {
      registerPhysicalMutationTransaction(raw)
      const committed = await runBrowserCommandTransaction(raw, async (tx) => {
        const fenced = bindFencedTransaction(tx, LINKED_PLAN)
        const replacements =
          typeof replacementInput === 'function' ? await replacementInput(fenced) : replacementInput
        const chatMutation = openLinkedChatMutation(fenced)
        await chatMutation.readMany(replacements.map(({ next }) => next.id))
        for (const { next } of replacements) {
          chatMutation.replaceLinked(next.id, () => next)
        }
        return chatMutation.commit()
      })
      assertPhysicalTransactionTablesDeclared(LINKED_PLAN, committed.facts.tableNames)
      return committed
    },
  )
}

async function currentChat(tx: Transaction, chatId: ChatId): Promise<Chat> {
  const row = await tx.table<Chat, ChatId>('chats').get(chatId)
  if (!row) throw new Error(`MissingCurrentChat:${chatId}`)
  return row
}

async function currentChats(tx: Transaction, chatIds: readonly ChatId[]): Promise<Chat[]> {
  const rows = await tx.table<Chat, ChatId>('chats').bulkGet([...chatIds])
  return rows.map((row, index) => {
    if (!row) throw new Error(`MissingCurrentChat:${chatIds[index] as ChatId}`)
    return row
  })
}

type TestChatRowWriteTransitionInput =
  | { readonly kind: 'add-linked'; readonly next: Chat }
  | {
      readonly kind: 'replace-linked' | 'replace-preserving-links'
      readonly previous: Chat
      readonly next: Chat
    }

function calibration(updatedAt: number) {
  return {
    totalTextChars: updatedAt * 400,
    totalTextTokens: updatedAt * 100,
    sampleCount: 1,
    updatedAt,
  }
}

async function transitionState(db: NatterDb, chatId: ChatId) {
  const [chatRow, sidebarRow, sidebarAggregates, links, usage, configurationAggregates] =
    await Promise.all([
      db.chats.get(chatId),
      db.chatSidebarRows.get(chatId),
      db.chatSidebarAggregates.toArray(),
      db.configurationLinks.toArray(),
      db.configurationProfileUsageRows.toArray(),
      db.configurationCatalogAggregates.toArray(),
    ])
  return {
    chatRow,
    sidebarRow,
    sidebarAggregates: sortedById(sidebarAggregates),
    links: sortedById(links),
    usage: sortedById(usage),
    configurationAggregates: sortedById(configurationAggregates),
  }
}

async function fullTransitionState(db: NatterDb) {
  const [chats, sidebarRows, sidebarAggregates, links, usage, configurationAggregates] =
    await Promise.all([
      db.chats.toArray(),
      db.chatSidebarRows.toArray(),
      db.chatSidebarAggregates.toArray(),
      db.configurationLinks.toArray(),
      db.configurationProfileUsageRows.toArray(),
      db.configurationCatalogAggregates.toArray(),
    ])
  return {
    chats: sortedById(chats),
    sidebarRows: sortedById(sidebarRows),
    sidebarAggregates: sortedById(sidebarAggregates),
    links: sortedById(links),
    usage: sortedById(usage),
    configurationAggregates: sortedById(configurationAggregates),
  }
}

function sortedById<Row extends { readonly id: string }>(rows: readonly Row[]): Row[] {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id))
}

type TableMethodSpy = {
  readonly mock: {
    readonly calls: readonly (readonly unknown[])[]
    readonly contexts: readonly unknown[]
  }
}

function tableCallCount(spy: TableMethodSpy, tableName: string): number {
  return spy.mock.contexts.filter((context) => (context as Table).name === tableName).length
}

function tableCallSizes(spy: TableMethodSpy, tableName: string): number[] {
  return spy.mock.calls.flatMap((args, index) => {
    const context = spy.mock.contexts[index] as Table | undefined
    if (context?.name !== tableName) return []
    const rows = args[0]
    return [Array.isArray(rows) ? rows.length : 1]
  })
}

interface RecordedTableCall {
  readonly tableName: string
  readonly method: string
  readonly size: number
}

class RecordingChatTransitionTransaction {
  readonly aggregateRows = new Map<string, ChatSidebarAggregateProjectionRow>()
  readonly calls: RecordedTableCall[] = []
  readonly chatRows: Map<ChatId, Chat>
  readonly sidebarRows = new Map<ChatId, ChatSidebarProjectionRow>()
  readonly transaction: Transaction
  private readonly abortListeners: Array<() => void> = []

  constructor(chats: readonly Chat[]) {
    this.chatRows = new Map(chats.map((chat) => [chat.id, chat]))
    const projected = chats.map(chatSidebarProjectionRow)
    for (const row of projected) this.sidebarRows.set(row.id, row)
    const accumulator = createChatSidebarAggregateAccumulator()
    accumulateChatSidebarAggregateRows(accumulator, projected)
    for (const row of materializeChatSidebarAggregateRows(accumulator)) {
      this.aggregateRows.set(row.id, row)
    }
    this.transaction = {
      db: { name: 'recording-chat-transition' },
      idbtrans: {},
      on: (eventName: string, listener: () => void) => {
        if (eventName === 'abort') this.abortListeners.push(listener)
      },
      table: (tableName: string) => this.table(tableName),
    } as unknown as Transaction
  }

  abortForTest(): void {
    for (const listener of this.abortListeners.splice(0)) listener()
  }

  callSizes(tableName: string, method: string): number[] {
    return this.calls.flatMap((call) =>
      call.tableName === tableName && call.method === method ? [call.size] : [],
    )
  }

  private table(tableName: string): unknown {
    if (tableName === 'chats') {
      return {
        bulkGet: async (ids: readonly ChatId[]) => {
          this.record(tableName, 'bulkGet', ids.length)
          return ids.map((id) => this.chatRows.get(id))
        },
        bulkPut: async (rows: readonly Chat[]) => {
          this.record(tableName, 'bulkPut', rows.length)
          for (const row of rows) this.chatRows.set(row.id, row)
        },
      }
    }
    if (tableName === 'chatSidebarRows') {
      return {
        bulkGet: async (ids: readonly ChatId[]) => {
          this.record(tableName, 'bulkGet', ids.length)
          return ids.map((id) => this.sidebarRows.get(id))
        },
        bulkPut: async (rows: readonly ChatSidebarProjectionRow[]) => {
          this.record(tableName, 'bulkPut', rows.length)
          for (const row of rows) this.sidebarRows.set(row.id, row)
        },
      }
    }
    if (tableName === 'chatSidebarAggregates') {
      return {
        bulkGet: async (ids: readonly string[]) => {
          this.record(tableName, 'bulkGet', ids.length)
          return ids.map((id) => this.aggregateRows.get(id))
        },
        put: async (row: ChatSidebarAggregateProjectionRow) => {
          this.record(tableName, 'put', 1)
          this.aggregateRows.set(row.id, row)
        },
        bulkPut: async (rows: readonly ChatSidebarAggregateProjectionRow[]) => {
          this.record(tableName, 'bulkPut', rows.length)
          for (const row of rows) this.aggregateRows.set(row.id, row)
        },
      }
    }
    throw new Error(`RecordingChatTransitionUnexpectedTable:${tableName}`)
  }

  private record(tableName: string, method: string, size: number): void {
    this.calls.push({ tableName, method, size })
  }
}
