import type { IndexableType, Table, Transaction } from 'dexie'
import { childListKey } from '../core/child-list-state'
import type {
  AttachmentId,
  AttachmentReferenceEdge,
  Chat,
  ChatId,
  ChatPreset,
  ChildListState,
  ChildSlotMember,
  ConnectionProfile,
  DraftRow,
  MessageId,
  PresetId,
  ProfileId,
  PromptPreset,
  PromptPresetId,
  PromptPresetKind,
} from '../core/types'
import {
  type AttachmentCatalogAggregateRow,
  type AttachmentCatalogProjectionRow,
  accumulateAttachmentCatalogProjection,
  attachmentCatalogProjectionRow,
  attachmentReferenceSummaryFromEdges,
  emptyAttachmentCatalogAggregateRow,
} from './attachment-catalog-projection'
import { completedAttachmentIntegrityState } from './attachment-integrity-maintenance'
import { edgesForOwner, reconcileAttachmentReferenceCount } from './attachment-reference-edges'
import type { AttachmentHeaderRow } from './attachment-storage'
import { emptyBrowserWriterLockRow } from './browser-lock-record'
import { rebuildChatSidebarProjectionRowsInTransaction } from './chat-sidebar-projection'
import {
  type ConfigurationCatalogMetadataRow,
  type ConfigurationPresetCatalogProjectionRow,
  type ConfigurationProfileCatalogProjectionRow,
  type ConfigurationPromptPresetCatalogProjectionRow,
  configurationCatalogMetadataRowsFromCounts,
  configurationPresetCatalogProjectionRow,
  configurationProfileCatalogProjectionRow,
  configurationPromptPresetCatalogProjectionRow,
} from './configuration-catalog-projection'
import {
  type ConfigurationLink,
  configurationLinksForChat,
  configurationLinksForPreset,
  configurationLinksForProfile,
} from './configuration-domain-contract'
import {
  type ConfigurationProfileUsageProjectionRow,
  emptyConfigurationProfileUsageProjectionRow,
} from './configuration-profile-usage-projection'
import { seedEmptyDiscoveryCacheState } from './discovery-cache-storage'
import {
  type MessageBodyRow,
  type MessageHeaderRow,
  type MessageTextPreviewRow,
  projectMessageTextPreview,
} from './message-storage'
import { physicalStorageTables } from './physical-storage-tables'
import { rebuildPresetOrderMembership } from './preset-order'

const REBUILD_PAGE_ROWS = 64
const MESSAGE_TREE_INDEX = '[chatId+treeParentKey+siblingIndex+id]'

export const ATTACHMENT_DERIVED_REPAIR_TRANSACTION_CAPABILITY = physicalStorageTables(
  'messages',
  'drafts',
  'attachments',
  'attachmentRefEdges',
  'attachmentCatalogRows',
  'attachmentCatalogAggregate',
  'attachmentIntegrityState',
)

export const CHILD_SLOT_DERIVED_REPAIR_TRANSACTION_CAPABILITY = physicalStorageTables(
  'chats',
  'messages',
  'childLists',
  'childSlotMembers',
)

export const MESSAGE_PREVIEW_DERIVED_REPAIR_TRANSACTION_CAPABILITY = physicalStorageTables(
  'messages',
  'messageBodies',
  'messagePreviews',
)

export const CHAT_SIDEBAR_DERIVED_REPAIR_TRANSACTION_CAPABILITY = physicalStorageTables(
  'chats',
  'chatSidebarRows',
  'chatSidebarAggregates',
)

export const CONFIGURATION_DERIVED_REPAIR_TRANSACTION_CAPABILITY = physicalStorageTables(
  'profiles',
  'presets',
  'chats',
  'promptPresets',
  'configurationLinks',
  'configurationCatalogAggregates',
  'configurationProfileCatalogRows',
  'configurationPresetCatalogRows',
  'configurationPromptPresetCatalogRows',
  'configurationProfileUsageRows',
)

export const PRESET_ORDER_DERIVED_REPAIR_TRANSACTION_CAPABILITY = physicalStorageTables(
  'presetOrderBlocks',
  'presetOrderMembership',
)

export const RUNTIME_SEED_DERIVED_REPAIR_TRANSACTION_CAPABILITY = physicalStorageTables(
  'browserLocks',
  'models',
  'endpoints',
  'privacyPolicies',
  'discoveryPayloads',
  'discoveryPayloadMetadata',
  'discoveryCacheState',
)

const DERIVED_REPAIR_STAGES = Object.freeze([
  {
    capability: ATTACHMENT_DERIVED_REPAIR_TRANSACTION_CAPABILITY,
    rebuild: rebuildAttachmentDerivedState,
  },
  {
    capability: CHILD_SLOT_DERIVED_REPAIR_TRANSACTION_CAPABILITY,
    rebuild: rebuildChildSlotDerivedState,
  },
  {
    capability: MESSAGE_PREVIEW_DERIVED_REPAIR_TRANSACTION_CAPABILITY,
    rebuild: rebuildMessagePreviewDerivedState,
  },
  {
    capability: CHAT_SIDEBAR_DERIVED_REPAIR_TRANSACTION_CAPABILITY,
    rebuild: rebuildChatSidebarProjectionRowsInTransaction,
  },
  {
    capability: CONFIGURATION_DERIVED_REPAIR_TRANSACTION_CAPABILITY,
    rebuild: rebuildConfigurationDerivedState,
  },
  {
    capability: PRESET_ORDER_DERIVED_REPAIR_TRANSACTION_CAPABILITY,
    rebuild: rebuildPresetOrderMembership,
  },
  {
    capability: RUNTIME_SEED_DERIVED_REPAIR_TRANSACTION_CAPABILITY,
    rebuild: resetRuntimeDerivedState,
  },
] as const)

export async function rebuildCurrentBrowserWorkspaceDerivedStateInTransaction(
  tx: Transaction,
): Promise<void> {
  for (const stage of DERIVED_REPAIR_STAGES) await stage.rebuild(tx)
}

async function rebuildAttachmentDerivedState(tx: Transaction): Promise<void> {
  const edgeTable = tx.table<
    AttachmentReferenceEdge,
    [AttachmentReferenceEdge['ownerKind'], string, string]
  >('attachmentRefEdges')
  const catalog = tx.table<AttachmentCatalogProjectionRow, AttachmentId>('attachmentCatalogRows')
  const aggregateTable = tx.table<AttachmentCatalogAggregateRow, string>(
    'attachmentCatalogAggregate',
  )
  await Promise.all([
    edgeTable.clear(),
    catalog.clear(),
    aggregateTable.clear(),
    tx.table('attachmentIntegrityState').clear(),
  ])

  await forEachPrimaryPage(tx.table<MessageHeaderRow, MessageId>('messages'), async (messages) => {
    const edges = messages.flatMap((message) =>
      edgesForOwner({
        ownerKind: 'message',
        ownerId: message.id,
        chatId: message.chatId,
        refs: message.attachmentRefs,
      }),
    )
    await assertAttachmentTargets(tx, edges)
    if (edges.length > 0) await edgeTable.bulkPut(edges)
  })
  await forEachPrimaryPage(tx.table<DraftRow, string>('drafts'), async (drafts) => {
    const edges = drafts.flatMap((draft) =>
      edgesForOwner({
        ownerKind: 'draft',
        ownerId: draft.chatId,
        chatId: draft.chatId,
        refs: draft.attachmentRefs,
      }),
    )
    await assertAttachmentTargets(tx, edges)
    if (edges.length > 0) await edgeTable.bulkPut(edges)
  })

  const aggregate = emptyAttachmentCatalogAggregateRow()
  const observedAt = Date.now()
  await forEachPrimaryPage(
    tx.table<AttachmentHeaderRow, AttachmentId>('attachments'),
    async (attachments) => {
      const ids = attachments.map((attachment) => attachment.id)
      const edges = await edgeTable.where('attachmentId').anyOf(ids).toArray()
      const edgesByAttachment = new Map<AttachmentId, AttachmentReferenceEdge[]>()
      for (const edge of edges) {
        const current = edgesByAttachment.get(edge.attachmentId)
        if (current) current.push(edge)
        else edgesByAttachment.set(edge.attachmentId, [edge])
      }
      const repaired = attachments.map((attachment) =>
        reconcileAttachmentReferenceCount(
          attachment,
          edgesByAttachment.get(attachment.id)?.length ?? 0,
          observedAt,
        ),
      )
      const changedHeaders = repaired.filter((header, index) => header !== attachments[index])
      if (changedHeaders.length > 0) {
        await tx.table<AttachmentHeaderRow, AttachmentId>('attachments').bulkPut(changedHeaders)
      }
      const projected = repaired.map((attachment) =>
        attachmentCatalogProjectionRow(
          attachment,
          attachmentReferenceSummaryFromEdges(edgesByAttachment.get(attachment.id) ?? []),
        ),
      )
      for (const row of projected) accumulateAttachmentCatalogProjection(aggregate, row)
      if (projected.length > 0) await catalog.bulkPut(projected)
    },
  )
  await Promise.all([
    aggregateTable.put(aggregate),
    tx.table('attachmentIntegrityState').put(completedAttachmentIntegrityState()),
  ])
}

async function assertAttachmentTargets(
  tx: Transaction,
  edges: readonly AttachmentReferenceEdge[],
): Promise<void> {
  const ids = [...new Set(edges.map((edge) => edge.attachmentId))]
  if (ids.length === 0) return
  const targets = await tx.table<AttachmentHeaderRow, AttachmentId>('attachments').bulkGet(ids)
  for (let index = 0; index < ids.length; index += 1) {
    if (!targets[index]) throw new Error(`AttachmentMissing:${ids[index]}`)
  }
}

export async function rebuildChildSlotDerivedState(
  tx: Transaction,
  options: {
    readonly rebuiltAt?: number
    readonly checkpoint?: () => void
  } = {},
): Promise<void> {
  const checkpoint = options.checkpoint ?? (() => undefined)
  const chats = tx.table<Chat, ChatId>('chats')
  const messages = tx.table<MessageHeaderRow, MessageId>('messages')
  const states = tx.table<ChildListState, string>('childLists')
  const members = tx.table<ChildSlotMember, MessageId>('childSlotMembers')
  await Promise.all([states.clear(), members.clear()])
  await forEachPrimaryPage(chats, async (page) => {
    checkpoint()
    await states.bulkPut(
      page.map((chat) => ({
        id: childListKey(chat.id, null),
        chatId: chat.id,
        parentId: null,
        version: 0,
        updatedAt: chat.updatedAt,
        liveCount: 0,
        firstLiveChildId: null,
        lastLiveChildId: null,
        nextSiblingIndex: 0,
      })),
    )
  })

  const rebuiltAt = options.rebuiltAt ?? Date.now()
  let slotKey: string | null = null
  let slotChatId: ChatId | null = null
  let slotParentId: MessageId | null = null
  let slotLiveCount = 0
  let slotNextSiblingIndex = 0
  let slotFirstId: MessageId | null = null
  let slotLastId: MessageId | null = null
  let pendingMember: ChildSlotMember | null = null
  const stateBuffer: ChildListState[] = []
  const memberBuffer: ChildSlotMember[] = []
  const drainStateBuffer = async (): Promise<void> => {
    if (stateBuffer.length < REBUILD_PAGE_ROWS) return
    await states.bulkPut(stateBuffer.splice(0))
  }
  const drainMemberBuffer = async (): Promise<void> => {
    if (memberBuffer.length < REBUILD_PAGE_ROWS) return
    await members.bulkPut(memberBuffer.splice(0))
  }
  const flushMember = async (nextMessageId: MessageId | null): Promise<void> => {
    if (!pendingMember) return
    memberBuffer.push({ ...pendingMember, nextMessageId })
    pendingMember = null
    await drainMemberBuffer()
  }
  const flushSlot = async (): Promise<void> => {
    if (slotKey === null || slotChatId === null) return
    await flushMember(null)
    stateBuffer.push({
      id: slotKey,
      chatId: slotChatId,
      parentId: slotParentId,
      version: 0,
      updatedAt: rebuiltAt,
      liveCount: slotLiveCount,
      firstLiveChildId: slotFirstId,
      lastLiveChildId: slotLastId,
      nextSiblingIndex: slotNextSiblingIndex,
    })
    await drainStateBuffer()
  }

  let after: IndexableType | undefined
  for (;;) {
    checkpoint()
    const rows: MessageHeaderRow[] = []
    let lastKey: IndexableType | undefined
    const collection =
      after === undefined
        ? messages.orderBy(MESSAGE_TREE_INDEX)
        : messages.where(MESSAGE_TREE_INDEX).above(after)
    await collection.limit(REBUILD_PAGE_ROWS).each((row, cursor) => {
      rows.push(row)
      lastKey = cursor.key
    })
    if (rows.length === 0) break
    for (const row of rows) {
      const currentSlotKey = childListKey(row.chatId, row.parentId)
      if (slotKey !== currentSlotKey) {
        await flushSlot()
        slotKey = currentSlotKey
        slotChatId = row.chatId
        slotParentId = row.parentId
        slotLiveCount = 0
        slotNextSiblingIndex = 0
        slotFirstId = null
        slotLastId = null
        pendingMember = null
      }
      slotNextSiblingIndex = Math.max(slotNextSiblingIndex, row.siblingIndex + 1)
      if (row.deleted) continue
      const member: ChildSlotMember = {
        id: row.id,
        chatId: row.chatId,
        parentId: row.parentId,
        parentKey: currentSlotKey,
        position: slotLiveCount,
        previousMessageId: slotLastId,
        nextMessageId: null,
      }
      if (pendingMember) await flushMember(member.id)
      pendingMember = member
      slotFirstId ??= member.id
      slotLastId = member.id
      slotLiveCount += 1
    }
    if (rows.length < REBUILD_PAGE_ROWS) break
    if (lastKey === undefined) throw new Error('MessageTreeProjectionPrimaryKeyMissing')
    after = lastKey
  }
  await flushSlot()
  if (memberBuffer.length > 0) await members.bulkPut(memberBuffer)
  if (stateBuffer.length > 0) await states.bulkPut(stateBuffer)
}

async function rebuildMessagePreviewDerivedState(tx: Transaction): Promise<void> {
  const messages = tx.table<MessageHeaderRow, MessageId>('messages')
  const bodies = tx.table<MessageBodyRow, MessageId>('messageBodies')
  const previews = tx.table<MessageTextPreviewRow, MessageId>('messagePreviews')
  await previews.clear()
  await forEachPrimaryPage(messages, async (headers) => {
    const storedBodies = await bodies.bulkGet(headers.map((header) => header.id))
    const projected = headers.map((header, index) => {
      const body = storedBodies[index]
      if (!body) throw new Error(`MessageBodyMissing:${header.id}`)
      return projectMessageTextPreview(header, body)
    })
    if (projected.length > 0) await previews.bulkPut(projected)
  })
}

async function rebuildConfigurationDerivedState(tx: Transaction): Promise<void> {
  const links = tx.table<ConfigurationLink, string>('configurationLinks')
  const profileRows = tx.table<ConfigurationProfileCatalogProjectionRow, ProfileId>(
    'configurationProfileCatalogRows',
  )
  const presetRows = tx.table<ConfigurationPresetCatalogProjectionRow, PresetId>(
    'configurationPresetCatalogRows',
  )
  const promptPresetRows = tx.table<ConfigurationPromptPresetCatalogProjectionRow, PromptPresetId>(
    'configurationPromptPresetCatalogRows',
  )
  const usageRows = tx.table<ConfigurationProfileUsageProjectionRow, ProfileId>(
    'configurationProfileUsageRows',
  )
  const aggregateRows = tx.table<ConfigurationCatalogMetadataRow, string>(
    'configurationCatalogAggregates',
  )
  await Promise.all([
    links.clear(),
    profileRows.clear(),
    presetRows.clear(),
    promptPresetRows.clear(),
    usageRows.clear(),
    aggregateRows.clear(),
  ])

  let totalProfileCount = 0
  let activeProfileCount = 0
  const promptPresetCounts: Record<PromptPresetKind, number> = {
    system: 0,
    append: 0,
    'continue-system': 0,
    'continue-user': 0,
    prefill: 0,
  }
  await forEachPrimaryPage(tx.table<ConnectionProfile, ProfileId>('profiles'), async (profiles) => {
    totalProfileCount += profiles.length
    for (const profile of profiles) if (profile.archived !== true) activeProfileCount += 1
    await Promise.all([
      profileRows.bulkPut(profiles.map(configurationProfileCatalogProjectionRow)),
      putConfigurationLinks(links, profiles.flatMap(configurationLinksForProfile)),
    ])
  })
  await forEachPrimaryPage(tx.table<ChatPreset, PresetId>('presets'), async (presets) => {
    await Promise.all([
      presetRows.bulkPut(presets.map(configurationPresetCatalogProjectionRow)),
      putConfigurationLinks(links, presets.flatMap(configurationLinksForPreset)),
      applyConfigurationProfileUsagePage(
        usageRows,
        presets.map((preset) => ({
          profileId: preset.connectionProfileId,
          presetCount: 1,
          activePresetCount: preset.archived === true ? 0 : 1,
          chatCount: 0,
          activeChatCount: 0,
        })),
      ),
    ])
  })
  await forEachPrimaryPage(tx.table<Chat, ChatId>('chats'), async (chats) => {
    await Promise.all([
      putConfigurationLinks(links, chats.flatMap(configurationLinksForChat)),
      applyConfigurationProfileUsagePage(
        usageRows,
        chats.map((chat) => ({
          profileId: chat.settings.profileId,
          presetCount: 0,
          activePresetCount: 0,
          chatCount: 1,
          activeChatCount: chat.archived === true ? 0 : 1,
        })),
      ),
    ])
  })
  await forEachPrimaryPage(
    tx.table<PromptPreset, PromptPresetId>('promptPresets'),
    async (promptPresets) => {
      for (const preset of promptPresets) promptPresetCounts[preset.kind] += 1
      await promptPresetRows.bulkPut(
        promptPresets.map(configurationPromptPresetCatalogProjectionRow),
      )
    },
  )
  await aggregateRows.bulkPut(
    configurationCatalogMetadataRowsFromCounts({
      totalProfileCount,
      activeProfileCount,
      promptPresetCounts,
    }),
  )
}

function putConfigurationLinks(
  table: Table<ConfigurationLink, string>,
  links: readonly ConfigurationLink[],
): Promise<unknown> {
  return links.length === 0 ? Promise.resolve() : table.bulkPut(links)
}

interface ConfigurationProfileUsageContribution {
  readonly profileId: ProfileId
  readonly presetCount: number
  readonly activePresetCount: number
  readonly chatCount: number
  readonly activeChatCount: number
}

async function applyConfigurationProfileUsagePage(
  table: Table<ConfigurationProfileUsageProjectionRow, ProfileId>,
  contributions: readonly ConfigurationProfileUsageContribution[],
): Promise<void> {
  const page = new Map<ProfileId, ConfigurationProfileUsageProjectionRow>()
  for (const contribution of contributions) {
    const current =
      page.get(contribution.profileId) ??
      emptyConfigurationProfileUsageProjectionRow(contribution.profileId)
    page.set(contribution.profileId, {
      id: contribution.profileId,
      presetCount: current.presetCount + contribution.presetCount,
      activePresetCount: current.activePresetCount + contribution.activePresetCount,
      chatCount: current.chatCount + contribution.chatCount,
      activeChatCount: current.activeChatCount + contribution.activeChatCount,
    })
  }
  const ids = [...page.keys()]
  if (ids.length === 0) return
  const previous = await table.bulkGet(ids)
  await table.bulkPut(
    ids.map((id, index) => {
      const current = previous[index] ?? emptyConfigurationProfileUsageProjectionRow(id)
      const delta = page.get(id) as ConfigurationProfileUsageProjectionRow
      return {
        id,
        presetCount: current.presetCount + delta.presetCount,
        activePresetCount: current.activePresetCount + delta.activePresetCount,
        chatCount: current.chatCount + delta.chatCount,
        activeChatCount: current.activeChatCount + delta.activeChatCount,
      }
    }),
  )
}

async function resetRuntimeDerivedState(tx: Transaction): Promise<void> {
  await Promise.all([
    tx.table('browserLocks').clear(),
    tx.table('models').clear(),
    tx.table('endpoints').clear(),
    tx.table('privacyPolicies').clear(),
    tx.table('discoveryPayloads').clear(),
    tx.table('discoveryPayloadMetadata').clear(),
    tx.table('discoveryCacheState').clear(),
  ])
  await Promise.all([
    tx.table('browserLocks').put(emptyBrowserWriterLockRow()),
    seedEmptyDiscoveryCacheState(tx),
  ])
}

async function forEachPrimaryPage<Row, Key extends IndexableType>(
  table: Table<Row, Key>,
  visit: (rows: readonly Row[]) => Promise<void>,
): Promise<void> {
  let after: Key | undefined
  for (;;) {
    const rows: Row[] = []
    let lastPrimaryKey: Key | undefined
    const collection = after === undefined ? table.orderBy(':id') : table.where(':id').above(after)
    await collection.limit(REBUILD_PAGE_ROWS).each((row, cursor) => {
      rows.push(row)
      lastPrimaryKey = cursor.primaryKey
    })
    if (rows.length === 0) return
    await visit(rows)
    if (rows.length < REBUILD_PAGE_ROWS) return
    if (lastPrimaryKey === undefined) {
      throw new Error(`DerivedRepairPrimaryKeyMissing:${table.name}`)
    }
    after = lastPrimaryKey
  }
}
