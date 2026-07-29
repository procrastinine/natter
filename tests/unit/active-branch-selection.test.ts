// @vitest-environment node

import type { Transaction } from 'dexie'
import { describe, expect, it } from 'vitest'
import type { ActiveBranchSelection } from '../../src/core/active-branch-spine'
import { buildChildSlotProjection } from '../../src/core/child-list-state'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { treeParentKey } from '../../src/core/message-tree-index'
import { resolvingConversationSelectionTarget } from '../../src/core/messages'
import { EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS } from '../../src/core/reasoning'
import type { Chat, MessageId } from '../../src/core/types'
import {
  createBranchSelectionReadMeasurement,
  readConversationOpenInitialReceiptInTransaction,
  resolveConversationOpenReceipt,
} from '../../src/store/browser-active-branch-spine'
import type { MessageHeaderRow } from '../../src/store/message-storage'

const CHAT_ID = 'selection-chat'

function header(
  id: MessageId,
  parentId: MessageId | null,
  siblingIndex: number,
  createdAt: number,
): MessageHeaderRow {
  return {
    id,
    chatId: CHAT_ID,
    parentId,
    siblingIndex,
    turnId: `turn-${id}`,
    turnIndex: createdAt,
    createdAt,
    role: createdAt % 2 === 0 ? 'assistant' : 'user',
    origin: createdAt % 2 === 0 ? 'generated' : 'user',
    nodeVersion: 0,
    deleted: false,
    attachmentRefs: [],
    requestContextVersion: 0,
    bodyVersion: 1,
    bodyWordCount: 1,
    bodyTextCharCount: 1,
    bodyMediaCount: 0,
    bodyRenderCost: 1,
    contextRouteFacts: EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
    treeParentKey: treeParentKey(parentId),
    treeLive: 1,
  }
}

function chat(lastUpdatedLeafId: MessageId): Chat {
  return {
    id: CHAT_ID,
    title: 'Selection test',
    titleStatus: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 1,
    configurationVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

async function openSelection(
  rows: readonly MessageHeaderRow[],
  lastUpdatedLeafId: MessageId,
  selection: ActiveBranchSelection,
  measurement = createBranchSelectionReadMeasurement(),
  tx: Transaction = transaction(rows),
) {
  const target = resolvingConversationSelectionTarget(selection)
  const selectedChat = chat(lastUpdatedLeafId)
  const receipt = await readConversationOpenInitialReceiptInTransaction(
    tx,
    CHAT_ID,
    selectedChat,
    target,
    undefined,
    measurement,
  )
  return resolveConversationOpenReceipt(
    {
      runFrame: async (_stores, read) => ({ kind: 'ready', value: await read(tx) }),
    },
    receipt,
    'none',
    undefined,
    undefined,
    measurement,
  )
}

describe('proof-bearing active branch selection', () => {
  const root = header('root', null, 0, 1)
  const target = header('target', root.id, 0, 2)
  const observed = header('observed', target.id, 0, 3)
  const remoteExtension = header('remote-extension', observed.id, 0, 20)
  const newerTargetLeaf = header('newer-target-leaf', target.id, 1, 10)
  const canonical = header('canonical', root.id, 1, 30)
  const rows = [root, target, observed, remoteExtension, newerTargetLeaf, canonical]

  it('resolves an off-canonical interior target through bounded descendant pages', async () => {
    const work = createBranchSelectionReadMeasurement()
    const result = await openSelection(
      rows,
      canonical.id,
      { kind: 'message', messageId: target.id },
      work,
    )

    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') throw new Error('ExpectedReadySelection')
    expect(result.proof.tipId).toBe(remoteExtension.id)
    expect(result.proof.pathHeaders.map((row) => row.id)).toEqual([
      root.id,
      target.id,
      observed.id,
      remoteExtension.id,
    ])
    expect(work.descendantRowsRead).toBe(3)
    expect(work.peakTraversalRows).toBeLessThanOrEqual(6)
  })

  it('validates and preserves an observed terminal even after a remote extension', async () => {
    const work = createBranchSelectionReadMeasurement()
    const result = await openSelection(
      rows,
      canonical.id,
      { kind: 'message', messageId: target.id, observedTipId: observed.id },
      work,
    )

    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') throw new Error('ExpectedReadySelection')
    expect(result.proof.tipId).toBe(observed.id)
    expect(result.proof.pathHeaders.map((row) => row.id)).toEqual([root.id, target.id, observed.id])
    expect(work.descendantPageReads).toBe(0)
  })

  it('rejects a non-descendant observed tip and resolves from the requested target', async () => {
    const work = createBranchSelectionReadMeasurement()
    const result = await openSelection(
      rows,
      canonical.id,
      { kind: 'message', messageId: target.id, observedTipId: canonical.id },
      work,
    )

    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') throw new Error('ExpectedReadySelection')
    expect(result.proof.tipId).toBe(remoteExtension.id)
    expect(work.descendantRowsRead).toBe(3)
  })

  it('keeps default and exact-tip reads independent of unrelated chat width', async () => {
    for (const selection of [
      { kind: 'default' as const },
      { kind: 'tip' as const, messageId: observed.id },
    ]) {
      const work = createBranchSelectionReadMeasurement()
      const result = await openSelection(rows, canonical.id, selection, work)
      expect(result.kind).toBe('ready')
      expect(work.descendantPageReads).toBe(0)
      expect(work.physicalHeaderRowsRead).toBeLessThanOrEqual(4)
    }
  })

  it('visits a 100k-wide unresolved subtree in linear row work with bounded retained traversal', async () => {
    const wideRoot = header('wide-root', null, 0, 1)
    const wideTarget = header('wide-target', wideRoot.id, 0, 2)
    const leafCount = 100_000
    const leaves = Array.from({ length: leafCount }, (_, index) =>
      header(`leaf-${index.toString().padStart(6, '0')}`, wideTarget.id, index, index + 3),
    )
    const wideCanonical = header('wide-canonical', wideRoot.id, 1, leafCount + 10)
    const wideRows = [wideRoot, wideTarget, ...leaves, wideCanonical]
    const work = createBranchSelectionReadMeasurement()

    const result = await openSelection(
      wideRows,
      wideCanonical.id,
      { kind: 'message', messageId: wideTarget.id },
      work,
    )

    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') throw new Error('ExpectedReadySelection')
    expect(result.proof.tipId).toBe(leaves.at(-1)?.id)
    expect(work.descendantRowsRead).toBe(leafCount)
    expect(work.peakTraversalRows).toBeLessThanOrEqual(66)
  }, 30_000)

  it('scores only live descendant leaves and breaks equal timestamps by leaf id', async () => {
    const globalRoot = header('score-root', null, 0, 1)
    const scoreTarget = header('score-target', globalRoot.id, 0, 2)
    const newerInterior = header('newer-interior', scoreTarget.id, 0, 1_000)
    const olderLeaf = header('older-leaf', newerInterior.id, 0, 3)
    const tiedLower = header('tie-a', scoreTarget.id, 1, 50)
    const tiedHigher = header('tie-z', scoreTarget.id, 2, 50)
    const deletedNewest = { ...header('deleted-newest', scoreTarget.id, 3, 5_000), deleted: true }
    const offTargetCanonical = header('off-target-canonical', globalRoot.id, 1, 6_000)
    const scoreRows = [
      globalRoot,
      scoreTarget,
      newerInterior,
      olderLeaf,
      tiedLower,
      tiedHigher,
      deletedNewest,
      offTargetCanonical,
    ]
    const result = await openSelection(scoreRows, offTargetCanonical.id, {
      kind: 'message',
      messageId: scoreTarget.id,
    })

    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') throw new Error('ExpectedReadySelection')
    expect(result.proof.tipId).toBe(tiedHigher.id)
    expect(result.proof.pathHeaders.map((row) => row.id)).toEqual([
      globalRoot.id,
      scoreTarget.id,
      tiedHigher.id,
    ])
  })

  it('produces terminal hints for default and exact tips but not unresolved interiors', async () => {
    const tx = transaction(rows)
    const selectedChat = chat(canonical.id)
    const defaultReceipt = await readConversationOpenInitialReceiptInTransaction(
      tx,
      CHAT_ID,
      selectedChat,
      resolvingConversationSelectionTarget({ kind: 'default' }),
    )
    const tipReceipt = await readConversationOpenInitialReceiptInTransaction(
      tx,
      CHAT_ID,
      selectedChat,
      resolvingConversationSelectionTarget({ kind: 'tip', messageId: observed.id }),
    )
    const interiorReceipt = await readConversationOpenInitialReceiptInTransaction(
      tx,
      CHAT_ID,
      selectedChat,
      resolvingConversationSelectionTarget({ kind: 'message', messageId: target.id }),
    )

    expect(defaultReceipt.kind === 'ready' && defaultReceipt.terminalHint.kind).toBe('fixed')
    expect(tipReceipt.kind === 'ready' && tipReceipt.terminalHint.kind).toBe('fixed')
    expect(interiorReceipt.kind === 'ready' && interiorReceipt.terminalHint.kind).toBe('candidate')
  })

  it('publishes an exact tip point while a deeper ancestry frame is blocked', async () => {
    const blocked = blockMessageGet(transaction(rows), target.id)
    const selectionTarget = resolvingConversationSelectionTarget({
      kind: 'tip',
      messageId: observed.id,
    })
    const receipt = await readConversationOpenInitialReceiptInTransaction(
      blocked.transaction,
      CHAT_ID,
      chat(canonical.id),
      selectionTarget,
    )
    const points: MessageId[] = []
    let publishPoint!: () => void
    const pointPublished = new Promise<void>((resolve) => {
      publishPoint = resolve
    })
    let selectionSettled = false
    const selectionRead = resolveConversationOpenReceipt(
      {
        runFrame: async (_stores, read) => ({
          kind: 'ready',
          value: await read(blocked.transaction),
        }),
      },
      receipt,
      'terminal',
      (point) => {
        if (point.kind === 'tip-header-point') {
          points.push(point.header.id)
          publishPoint()
        }
      },
    ).finally(() => {
      selectionSettled = true
    })

    await pointPublished
    expect(points).toEqual([observed.id])
    expect(selectionSettled).toBe(false)
    blocked.release()
    expect((await selectionRead).kind).toBe('ready')
  })
})

function blockMessageGet(transaction: Transaction, blockedId: MessageId) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    transaction: {
      table(name: string) {
        const table = transaction.table(name)
        if (name !== 'messages') return table
        return {
          ...table,
          async get(messageId: MessageId) {
            if (messageId === blockedId) await gate
            return table.get(messageId) as Promise<MessageHeaderRow | undefined>
          },
        }
      },
    } as unknown as Transaction,
    release,
  }
}

function transaction(rows: readonly MessageHeaderRow[]): Transaction {
  const messages = new Map(rows.map((row) => [row.id, row] as const))
  const rowsByTreeParentKey = new Map<string, MessageHeaderRow[]>()
  for (const row of rows) {
    const bucket = rowsByTreeParentKey.get(row.treeParentKey)
    if (bucket) bucket.push(row)
    else rowsByTreeParentKey.set(row.treeParentKey, [row])
  }
  for (const bucket of rowsByTreeParentKey.values()) {
    bucket.sort(
      (left, right) =>
        left.siblingIndex - right.siblingIndex ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
  }
  const projection = buildChildSlotProjection(CHAT_ID, rows, { updatedAt: 1 })
  const states = new Map(projection.states.map((row) => [row.id, row] as const))
  const members = new Map(projection.members.map((row) => [row.id, row] as const))

  const tables = {
    messages: {
      get: async (messageId: MessageId) => messages.get(messageId),
      where: (index: string) => {
        if (index !== '[chatId+treeParentKey+siblingIndex+id]') {
          throw new Error(`UnexpectedMessageIndex:${index}`)
        }
        return {
          between: (
            lower: readonly [string, string, number?, MessageId?],
            _upper: readonly unknown[],
            includeLower: boolean,
          ) => ({
            limit: (limit: number) => ({
              toArray: async () =>
                (rowsByTreeParentKey.get(lower[1]) ?? [])
                  .filter((row) => row.chatId === lower[0])
                  .filter((row) => {
                    if (includeLower || lower[2] === undefined || lower[3] === undefined)
                      return true
                    return (
                      row.siblingIndex > lower[2] ||
                      (row.siblingIndex === lower[2] && row.id > lower[3])
                    )
                  })
                  .slice(0, limit),
            }),
          }),
        }
      },
    },
    childLists: {
      get: async (id: string) => states.get(id),
      bulkGet: async (ids: readonly string[]) => ids.map((id) => states.get(id)),
    },
    childSlotMembers: {
      bulkGet: async (ids: readonly MessageId[]) => ids.map((id) => members.get(id)),
      where: (index: string) => {
        if (index !== '[chatId+parentKey+position]') {
          throw new Error(`UnexpectedChildMemberIndex:${index}`)
        }
        return {
          equals: (key: readonly [string, string, number]) => ({
            first: async () =>
              [...members.values()].find(
                (member) =>
                  member.chatId === key[0] &&
                  member.parentKey === key[1] &&
                  member.position === key[2],
              ),
          }),
        }
      },
    },
  }
  return {
    table: (name: keyof typeof tables) => tables[name],
  } as unknown as Transaction
}
