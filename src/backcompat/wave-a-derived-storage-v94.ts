import type { Table, Transaction } from 'dexie'
import { compareLiveLeafRecency } from '../core/active-path'
import { childListKey } from '../core/child-list-state'
import type {
  Chat,
  ChatFolder,
  ChatId,
  ChatTitleStatus,
  ChildListState,
  ChildSlotMember,
  FolderId,
  MessageId,
} from '../core/types'
import { sameValue } from '../lib/same-value'
import {
  type BoundedBatchWriter,
  createBoundedBatchWriter,
  forEachBoundedIdbCursorPage,
  openBoundedIdbCursorReader,
} from '../store/bounded-idb-cursor'
import {
  accumulateChatSidebarAggregateRows,
  accumulateChatSidebarFolderRows,
  type ChatSidebarAggregateProjectionRow,
  type ChatSidebarProjectionRow,
  type ChatSidebarWorkspaceAggregateRow,
  chatSidebarFolderAggregateRow,
  chatSidebarFolderKey,
  chatSidebarProjectionRow,
  createChatSidebarAggregateAccumulator,
  emptyChatSidebarAggregateRow,
  materializeChatSidebarAggregateRows,
} from '../store/chat-sidebar-projection'
import { chatStoragePhysicalIndexFields } from '../store/chat-storage-codec'
import { seedEmptyDiscoveryCacheState } from '../store/discovery-cache-storage'
import {
  type MessageHeaderRow,
  type MessageTextPreviewRow,
  previewTextFromStoredProjection,
} from '../store/message-storage'
import { estimateStoredValueBytes } from '../store/storage-size-estimate'
import { migrateLegacySavedTextTemplateRows } from './saved-text-template-rows'
import type { WaveAStorageEpochMigrationCapabilitiesV94 } from './wave-a-storage-capabilities-v94'

const PAGE_MAX_ROWS = 128
const PAGE_MAX_BYTES = 4 * 1024 * 1024
const MESSAGE_TREE_INDEX = '[chatId+treeParentKey+siblingIndex+id]'

export async function migrateWaveADerivedRowsV94(
  tx: Transaction,
  capabilities: WaveAStorageEpochMigrationCapabilitiesV94,
): Promise<void> {
  await migrateLegacySavedTextTemplateRows(tx, {
    recordObsoleteBytes: capabilities.recordObsoleteBytes,
  })
  await rebuildChildSlotsV94(tx, capabilities)
  await rebuildOrganizationAndChatSidebarV94(tx, capabilities)
  await resetDiscoveryCacheV94(tx, capabilities)
}

async function rebuildChildSlotsV94(
  tx: Transaction,
  capabilities: WaveAStorageEpochMigrationCapabilitiesV94,
): Promise<void> {
  const states = tx.table<ChildListState, string>('childLists')
  const members = tx.table<ChildSlotMember, MessageId>('childSlotMembers')
  await Promise.all([
    clearDerivedTableV94(tx, 'childLists', capabilities),
    clearDerivedTableV94(tx, 'childSlotMembers', capabilities),
  ])
  const stateWriter = boundedWriter<ChildListState, string>(states, 'WaveAChildListStates')
  const memberWriter = boundedWriter<ChildSlotMember, MessageId>(members, 'WaveAChildSlotMembers')
  await forEachBoundedIdbCursorPage<Chat>(
    tx.idbtrans.objectStore('chats'),
    cursorOptions('WaveAChildSlotRoots', capabilities),
    async (page) => {
      for (const { value: chat } of page.entries) {
        await stateWriter.add(emptyChildSlot(chat.id, null, chat.updatedAt))
      }
    },
  )

  const reader = openBoundedIdbCursorReader<MessageHeaderRow>(
    tx.idbtrans.objectStore('messages').index(MESSAGE_TREE_INDEX).openCursor(),
    'WaveAChildSlotHeaders',
  )
  let slotKey: string | null = null
  let slotChatId: ChatId | null = null
  let slotParentId: MessageId | null = null
  let liveCount = 0
  let nextSiblingIndex = 0
  let firstLiveChildId: MessageId | null = null
  let lastLiveChildId: MessageId | null = null
  let pendingMember: ChildSlotMember | null = null
  let processedRows = 0
  let processedBytes = 0

  const flushMember = async (nextMessageId: MessageId | null): Promise<void> => {
    if (!pendingMember) return
    await memberWriter.add({ ...pendingMember, nextMessageId })
    pendingMember = null
  }
  const flushSlot = async (): Promise<void> => {
    if (slotKey === null || slotChatId === null) return
    await flushMember(null)
    await stateWriter.add({
      id: slotKey,
      chatId: slotChatId,
      parentId: slotParentId,
      version: 0,
      updatedAt: capabilities.observedAt,
      liveCount,
      firstLiveChildId,
      lastLiveChildId,
      nextSiblingIndex,
    })
  }

  for (let entry = await reader.next(); entry; entry = await reader.next()) {
    processedRows += 1
    processedBytes = addDerivedBytesV94(processedBytes, entry.estimatedBytes)
    if (processedRows % PAGE_MAX_ROWS === 0) {
      capabilities.reportProgress?.({
        phase: 'derived-state',
        operation: 'rebuild-child-slots',
        processedRows,
        processedBytes,
      })
    }
    const row = entry.value
    const currentSlotKey = childListKey(row.chatId, row.parentId)
    if (currentSlotKey !== slotKey) {
      await flushSlot()
      slotKey = currentSlotKey
      slotChatId = row.chatId
      slotParentId = row.parentId
      liveCount = 0
      nextSiblingIndex = 0
      firstLiveChildId = null
      lastLiveChildId = null
      pendingMember = null
    }
    nextSiblingIndex = Math.max(nextSiblingIndex, row.siblingIndex + 1)
    if (row.deleted) continue
    const member: ChildSlotMember = {
      id: row.id,
      chatId: row.chatId,
      parentId: row.parentId,
      parentKey: currentSlotKey,
      position: liveCount,
      previousMessageId: lastLiveChildId,
      nextMessageId: null,
    }
    await flushMember(member.id)
    pendingMember = member
    firstLiveChildId ??= member.id
    lastLiveChildId = member.id
    liveCount += 1
  }
  capabilities.reportProgress?.({
    phase: 'derived-state',
    operation: 'rebuild-child-slots',
    processedRows,
    processedBytes,
  })
  await flushSlot()
  await Promise.all([stateWriter.flush(), memberWriter.flush()])
}

interface OrganizationSummaryV94 {
  imported: boolean
  earliestUser: MessageHeaderRow | null
  latestLeaf: MessageHeaderRow | null
  totalCostUsd: number
}

type StoredOrganizationChatV94 = Chat & ReturnType<typeof chatStoragePhysicalIndexFields>

async function rebuildOrganizationAndChatSidebarV94(
  tx: Transaction,
  capabilities: WaveAStorageEpochMigrationCapabilitiesV94,
): Promise<void> {
  const chats = tx.table<StoredOrganizationChatV94, ChatId>('chats')
  const messages = tx.table<MessageHeaderRow, MessageId>('messages')
  const childLists = tx.table<ChildListState, string>('childLists')
  const previews = tx.table<MessageTextPreviewRow, MessageId>('messagePreviews')
  const sidebarRows = tx.table<ChatSidebarProjectionRow, ChatId>('chatSidebarRows')
  const sidebarAggregates = tx.table<ChatSidebarAggregateProjectionRow, string>(
    'chatSidebarAggregates',
  )
  await Promise.all([
    clearDerivedTableV94(tx, 'chatSidebarRows', capabilities),
    clearDerivedTableV94(tx, 'chatSidebarAggregates', capabilities),
  ])
  const folders = tx.table<ChatFolder, FolderId>('folders')
  const chatWriter = boundedWriter<StoredOrganizationChatV94, ChatId>(
    chats,
    'WaveAOrganizationChats',
  )
  const sidebarRowWriter = boundedWriter<ChatSidebarProjectionRow, ChatId>(
    sidebarRows,
    'WaveAChatSidebarRows',
  )
  const workspaceAggregate = emptyChatSidebarAggregateRow()
  const chatReader = openBoundedIdbCursorReader<StoredOrganizationChatV94>(
    tx.idbtrans.objectStore('chats').openCursor(),
    'WaveAOrganizationChatInput',
  )
  let chatEntry = await chatReader.next()
  const messageReader = openBoundedIdbCursorReader<MessageHeaderRow>(
    tx.idbtrans.objectStore('messages').index('[chatId+createdAt+id]').openCursor(),
    'WaveAOrganizationMessageInput',
  )
  let messageEntry = await messageReader.next()
  let processedRows = 0
  let processedBytes = 0
  const branchProgress = { processedRows: 0, processedBytes: 0 }
  while (chatEntry) {
    const chat = chatEntry.value
    while (messageEntry && indexedDB.cmp(messageEntry.value.chatId, chat.id) < 0) {
      messageEntry = await messageReader.next()
    }
    const summary: OrganizationSummaryV94 = {
      imported: false,
      earliestUser: null,
      latestLeaf: null,
      totalCostUsd: 0,
    }
    while (messageEntry && messageEntry.value.chatId === chat.id) {
      const page: MessageHeaderRow[] = []
      let pageBytes = 0
      while (messageEntry && messageEntry.value.chatId === chat.id && page.length < PAGE_MAX_ROWS) {
        if (page.length > 0 && pageBytes + messageEntry.estimatedBytes > PAGE_MAX_BYTES) {
          break
        }
        page.push(messageEntry.value)
        pageBytes = Math.min(Number.MAX_SAFE_INTEGER, pageBytes + messageEntry.estimatedBytes)
        processedRows += 1
        processedBytes = addDerivedBytesV94(processedBytes, messageEntry.estimatedBytes)
        messageEntry = await messageReader.next()
      }
      capabilities.reportProgress?.({
        phase: 'derived-state',
        operation: 'rebuild-organization-and-sidebar',
        processedRows,
        processedBytes,
      })
      const states = await childLists.bulkGet(
        page.map((header) => childListKey(header.chatId, header.id)),
      )
      for (let index = 0; index < page.length; index += 1) {
        const header = page[index] as MessageHeaderRow
        if (header.deleted) continue
        summary.imported ||= header.origin === 'imported'
        if (header.role === 'user' && summary.earliestUser === null) {
          summary.earliestUser = header
        }
        const cost = header.generation?.cost
        if (typeof cost === 'number' && Number.isFinite(cost)) summary.totalCostUsd += cost
        const childState = states[index]
        if (!childState || childState.liveCount === 0) {
          if (
            summary.latestLeaf === null ||
            compareLiveLeafRecency(header, summary.latestLeaf) > 0
          ) {
            summary.latestLeaf = header
          }
        }
      }
    }
    const preview = summary.earliestUser ? await previews.get(summary.earliestUser.id) : undefined
    const previewText =
      preview &&
      preview.chatId === chat.id &&
      preview.bodyVersion === summary.earliestUser?.bodyVersion
        ? previewTextFromStoredProjection(preview.text)
        : ''
    const wordCount = await branchWordCountV94(
      messages,
      summary.latestLeaf,
      capabilities,
      branchProgress,
    )
    const folderId =
      typeof chat.folderId === 'string' && (await folders.get(chat.folderId)) !== undefined
        ? chat.folderId
        : null
    const next: Chat = {
      ...chat,
      folderId,
      tags:
        Array.isArray(chat.tags) && chat.tags.every((tag) => typeof tag === 'string')
          ? chat.tags
          : [],
      titleStatus: validTitleStatusV94(chat.titleStatus)
        ? chat.titleStatus
        : inferTitleStatusV94(chat.title, summary.imported),
      lastViewedAt: finiteNumberV94(chat.lastViewedAt)
        ? chat.lastViewedAt
        : finiteNumberV94(chat.updatedAt)
          ? chat.updatedAt
          : 0,
      lastUpdatedLeafId: summary.latestLeaf?.id ?? null,
      previewText,
      lastBranchUpdatedAt: finiteNumberV94(chat.lastBranchUpdatedAt) ? chat.lastBranchUpdatedAt : 0,
      wordCount,
      totalCostUsd: summary.totalCostUsd,
    }
    if (!sameValue(chat, next)) {
      await chatWriter.add({ ...next, ...chatStoragePhysicalIndexFields(next) })
      capabilities.recordObsoleteBytes(chatEntry.estimatedBytes)
    }
    const sidebarRow = chatSidebarProjectionRow(next)
    await sidebarRowWriter.add(sidebarRow)
    addWorkspaceRow(workspaceAggregate, sidebarRow)
    processedRows += 1
    processedBytes = addDerivedBytesV94(processedBytes, chatEntry.estimatedBytes)
    if (processedRows % PAGE_MAX_ROWS === 0) {
      capabilities.reportProgress?.({
        phase: 'derived-state',
        operation: 'rebuild-organization-and-sidebar',
        processedRows,
        processedBytes,
      })
    }
    chatEntry = await chatReader.next()
  }
  capabilities.reportProgress?.({
    phase: 'derived-state',
    operation: 'rebuild-organization-and-sidebar',
    processedRows,
    processedBytes,
  })
  capabilities.reportProgress?.({
    phase: 'derived-state',
    operation: 'rebuild-branch-word-count',
    processedRows: branchProgress.processedRows,
    processedBytes: branchProgress.processedBytes,
  })
  await Promise.all([chatWriter.flush(), sidebarRowWriter.flush()])
  await sidebarAggregates.put(workspaceAggregate)
  await rebuildFolderSidebarAggregatesV94(tx, folders, sidebarAggregates, capabilities)
}

async function branchWordCountV94(
  messages: Table<MessageHeaderRow, MessageId>,
  leaf: MessageHeaderRow | null,
  capabilities: WaveAStorageEpochMigrationCapabilitiesV94,
  progress: { processedRows: number; processedBytes: number },
): Promise<number> {
  let current = leaf
  let wordCount = 0
  let cycleAnchor = current
  let cyclePower = 1
  let cycleLength = 0
  while (current && !current.deleted) {
    if (Number.isFinite(current.bodyWordCount) && current.bodyWordCount > 0) {
      wordCount += current.bodyWordCount
    }
    progress.processedRows += 1
    progress.processedBytes = addDerivedBytesV94(
      progress.processedBytes,
      estimateStoredValueBytes(current),
    )
    if (progress.processedRows % PAGE_MAX_ROWS === 0) {
      capabilities.reportProgress?.({
        phase: 'derived-state',
        operation: 'rebuild-branch-word-count',
        processedRows: progress.processedRows,
        processedBytes: progress.processedBytes,
      })
    }
    const next = current.parentId === null ? null : ((await messages.get(current.parentId)) ?? null)
    cycleLength += 1
    if (next && cycleAnchor?.id === next.id) {
      throw new Error(`WaveAMessageParentCycle:${next.id}`)
    }
    if (cycleLength === cyclePower) {
      cycleAnchor = next
      cyclePower = Math.min(Number.MAX_SAFE_INTEGER, cyclePower * 2)
      cycleLength = 0
    }
    current = next
  }
  return wordCount
}

async function rebuildFolderSidebarAggregatesV94(
  tx: Transaction,
  folders: Table<ChatFolder, FolderId>,
  aggregates: Table<ChatSidebarAggregateProjectionRow, string>,
  capabilities: WaveAStorageEpochMigrationCapabilitiesV94,
): Promise<void> {
  await forEachBoundedIdbCursorPage<ChatFolder>(
    tx.idbtrans.objectStore('folders'),
    cursorOptions('rebuild-sidebar-folder-seeds', capabilities),
    async (page) => {
      await aggregates.bulkPut(
        page.entries.map(({ value: folder }) => chatSidebarFolderAggregateRow(folder)),
      )
    },
  )
  const rootFolderKey = chatSidebarFolderKey(null)
  const rowReader = openBoundedIdbCursorReader<ChatSidebarProjectionRow>(
    tx.idbtrans.objectStore('chatSidebarRows').index('folderKey').openCursor(),
    'WaveASidebarFolderChatInput',
  )
  let activeFolderKey: string | null = null
  let accumulator: ReturnType<typeof createChatSidebarAggregateAccumulator> | null = null
  let processedRows = 0
  let processedBytes = 0
  const flush = async (): Promise<void> => {
    if (!accumulator || activeFolderKey === null) return
    const aggregate = materializeChatSidebarAggregateRows(accumulator).find(
      (candidate) => candidate.kind === 'folder',
    )
    if (!aggregate) {
      throw new Error(`WaveAChatSidebarFolderAggregateMissing:${activeFolderKey}`)
    }
    await aggregates.put(aggregate)
  }
  for (let entry = await rowReader.next(); entry; entry = await rowReader.next()) {
    const row = entry.value
    if (row.folderKey === rootFolderKey) continue
    if (row.folderKey !== activeFolderKey) {
      await flush()
      const folder = await folders.get(row.folderKey)
      if (!folder) throw new Error(`WaveAChatSidebarFolderMissing:${row.folderKey}`)
      activeFolderKey = row.folderKey
      accumulator = createChatSidebarAggregateAccumulator()
      accumulateChatSidebarFolderRows(accumulator, [folder])
    }
    if (!accumulator) throw new Error('WaveAChatSidebarFolderAccumulatorMissing')
    accumulateChatSidebarAggregateRows(accumulator, [row])
    processedRows += 1
    processedBytes = addDerivedBytesV94(processedBytes, entry.estimatedBytes)
    if (processedRows % PAGE_MAX_ROWS === 0) {
      reportFolderAggregateProgress(capabilities, processedRows, processedBytes)
    }
  }
  await flush()
  reportFolderAggregateProgress(capabilities, processedRows, processedBytes)
}

function reportFolderAggregateProgress(
  capabilities: WaveAStorageEpochMigrationCapabilitiesV94,
  processedRows: number,
  processedBytes: number,
): void {
  capabilities.reportProgress?.({
    phase: 'derived-state',
    operation: 'rebuild-sidebar-folder-aggregates',
    processedRows,
    processedBytes,
  })
}

function validTitleStatusV94(value: unknown): value is ChatTitleStatus {
  return (
    value === 'untitled' ||
    value === 'pending' ||
    value === 'auto' ||
    value === 'manual' ||
    value === 'auto-failed'
  )
}

function inferTitleStatusV94(title: unknown, imported: boolean): ChatTitleStatus {
  const value = typeof title === 'string' ? title.trim() : ''
  return imported || value.length === 0 || value === 'Untitled chat' ? 'untitled' : 'auto'
}

function finiteNumberV94(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function addWorkspaceRow(
  workspace: ChatSidebarWorkspaceAggregateRow,
  row: ChatSidebarProjectionRow,
): void {
  workspace.totalCount += 1
  workspace.activeCount += Number(!row.archived)
  workspace.archivedCount += Number(row.archived)
  workspace.pinnedCount += Number(row.pinned)
  workspace.visibleCount += Number(row.visibleKey === 1)
  workspace.visiblePinnedCount += Number(row.visibleKey === 1 && row.pinned)
  if (row.folderKey !== chatSidebarFolderKey(null)) return
  workspace.rootCount += 1
  workspace.rootVisibleCount += Number(row.visibleKey === 1)
  workspace.rootVisiblePinnedCount += Number(row.visibleKey === 1 && row.pinned)
}

async function resetDiscoveryCacheV94(
  tx: Transaction,
  capabilities: WaveAStorageEpochMigrationCapabilitiesV94,
): Promise<void> {
  await Promise.all(
    [
      'models',
      'endpoints',
      'privacyPolicies',
      'discoveryPayloads',
      'discoveryPayloadMetadata',
      'discoveryCacheState',
    ].map((tableName) => clearDerivedTableV94(tx, tableName, capabilities)),
  )
  await seedEmptyDiscoveryCacheState(tx)
}

async function clearDerivedTableV94(
  tx: Transaction,
  tableName: string,
  capabilities: WaveAStorageEpochMigrationCapabilitiesV94,
): Promise<void> {
  capabilities.reportProgress?.({
    phase: 'derived-state',
    operation: `WaveAClear:${tableName}`,
    processedRows: 0,
    processedBytes: 0,
  })
  await forEachBoundedIdbCursorPage<unknown>(
    tx.idbtrans.objectStore(tableName),
    cursorOptions(`WaveAClear:${tableName}`, capabilities),
    (page) => {
      capabilities.recordObsoleteBytes(page.estimatedBytes)
      return Promise.resolve()
    },
  )
  await tx.table(tableName).clear()
}

function emptyChildSlot(
  chatId: ChatId,
  parentId: MessageId | null,
  updatedAt: number,
): ChildListState {
  return {
    id: childListKey(chatId, parentId),
    chatId,
    parentId,
    version: 0,
    updatedAt,
    liveCount: 0,
    firstLiveChildId: null,
    lastLiveChildId: null,
    nextSiblingIndex: 0,
  }
}

function cursorOptions(
  operation: string,
  capabilities: WaveAStorageEpochMigrationCapabilitiesV94,
): {
  readonly maxRows: number
  readonly maxBytes: number
  readonly operation: string
  readonly onPageVisited: (page: {
    readonly entries: readonly unknown[]
    readonly estimatedBytes: number
  }) => void
} {
  let processedRows = 0
  let processedBytes = 0
  return {
    maxRows: PAGE_MAX_ROWS,
    maxBytes: PAGE_MAX_BYTES,
    operation,
    onPageVisited: (page) => {
      processedRows += page.entries.length
      processedBytes = addDerivedBytesV94(processedBytes, page.estimatedBytes)
      capabilities.reportProgress?.({
        phase: 'derived-state',
        operation,
        processedRows,
        processedBytes,
      })
    },
  }
}

function addDerivedBytesV94(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function boundedWriter<Row, Key>(
  table: Table<Row, Key>,
  operation: string,
): BoundedBatchWriter<Row> {
  return createBoundedBatchWriter({
    maxRows: PAGE_MAX_ROWS,
    maxBytes: PAGE_MAX_BYTES,
    operation,
    write: (page) => table.bulkPut([...page]).then(() => undefined),
  })
}
