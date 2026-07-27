import {
  chatTagNameLower,
  createChatRow,
  nextChatCalibrationGeneration,
  sameOrderedIds,
  uniqueChatTagNames,
} from '../core/chat-metadata'
import { fixedConversationSelectionTarget } from '../core/messages'
import { tokenCalibrationKeyForStoredRecordKey } from '../core/model-ids'
import { compareChatFolders } from '../core/sidebar-sort'
import {
  aggregateCalibrationSamples,
  clearAllCalibrationFromGlobalRecord,
  clearCalibrationFamilyFromGlobalRecord,
  GLOBAL_TOKEN_CALIBRATION_KEY,
  subtractCalibrationSamplesFromGlobalRecord,
} from '../core/token-calibration'
import type {
  Chat,
  ChatFolder,
  ChatId,
  ChatTag,
  ChatVersions,
  FolderId,
  TagId,
  TokenCalibrationSample,
} from '../core/types'
import { sameOrderedValues, stableStringify } from '../lib/same-value'
import { newId } from '../lib/ulid'
import type {
  BrowserCommandSessionPort,
  BrowserMutationCommandPort,
  BrowserMutationRunnerPort,
  BrowserSemanticCommandPort,
} from './browser-domain-mutations'
import { boundedMaintenanceLimit } from './browser-workspace-maintenance-contract'
import {
  CONFIGURATION_OWNER_LINK_BATCH_SIZE,
  deleteChatFolderByteOwner,
  deleteChatTagByteOwners,
  putChatFolderByteOwner,
  putChatTagByteOwners,
  putTokenCalibrationSettingByteOwner,
} from './byte-owner-mutation'
import {
  applyChatRowWriteTransitions,
  CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
  CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
  type ChatRowWriteMutationReceipt,
} from './chat-row-transition'
import {
  CHAT_SIDEBAR_FOLDER_EXTREMA_READ_REQUEST_LIMIT,
  type ChatSidebarProjectionRow,
} from './chat-sidebar-projection'
import {
  readAllCurrentChatsForTransaction,
  readArchivedChatIdPage,
  readCurrentChatForTransaction,
  readCurrentChatsInFolderForTransaction,
  readOptionalCurrentChatRowsForTransaction,
  type TransactionCurrentChat,
} from './chat-storage-codec'
import {
  CHAT_CLOSURE_BATCH_LIMIT,
  CHAT_CLOSURE_TRANSACTION_CAPABILITY,
  deleteArchivedChatClosure,
  deleteEligibleEmptyDraftChatClosure,
} from './chat-storage-ownership'
import {
  CHAT_CONFIGURATION_LINK_SLOT_LIMIT,
  type ConfigurationLink,
  chatConfigurationTargetResourceNames,
  configurationOwnerKey,
  configurationTargetResourceNamesForLinks,
} from './configuration-domain-contract'
import type { SettingsRow } from './db-rows'
import { normalizeNamedLocks } from './locks'
import {
  type CapabilityTables,
  type FencedTransaction,
  type PhysicalStorageTableName,
  physicalStorageTables,
  physicalTransactionPlan,
} from './physical-storage-tables'
import type {
  CreateFolderInput,
  DeleteFolderResult,
  EnsureFolderAndMoveChatsInput,
  EnsureFolderAndMoveChatsResult,
  UpdateFolderInput,
} from './repository'
import {
  absorbSemanticOperationReceiptFragment,
  boundSemanticOperationExactReceiptAccumulator,
  type SemanticOperationDescriptor,
  type SemanticOperationExactPhysicalRead,
  type SemanticOperationExactPlan,
  type SemanticOperationExactReceipt,
  type SemanticOperationReceiptFragment,
  semanticOperationCallerSingleAttemptReplayContract,
  semanticOperationDescriptor,
  semanticOperationExactPlan,
  semanticOperationExactReceipt,
  semanticOperationExactReceiptContracts,
  semanticOperationExecution,
} from './semantic-operation-capability'
import { TransactionChatUpdateClock } from './transaction-order'
import {
  type ChatCalibrationEverywhereResult,
  type ChatMetadataWriteResult,
  type ChatTagAssignmentResult,
  type DeleteArchivedChatMetadataResult,
  normalizeWorkspaceDependencies,
  type WorkspaceCommand,
} from './workspace-protocol'

interface ChatMetadataResourceInput {
  readonly chatIds: readonly ChatId[]
  readonly linkedResourceNames: readonly string[]
}

const chatSetArchivedPlanBrand: unique symbol = Symbol('ChatSetArchivedPlan')
const chatMoveToFolderPlanBrand: unique symbol = Symbol('ChatMoveToFolderPlan')

interface ChatSetArchivedPlan extends ChatMetadataResourceInput {
  readonly archived: boolean
  readonly now: number
  readonly configurationLinkCount: number
  readonly exactPlan: SemanticOperationExactPlan
  readonly [chatSetArchivedPlanBrand]: true
}

interface ChatMoveToFolderPlan extends ChatMetadataResourceInput {
  readonly folderId: FolderId | null
  readonly now: number
  readonly exactPlan: SemanticOperationExactPlan
  readonly [chatMoveToFolderPlanBrand]: true
}

interface SingleChatMetadataResourceInput {
  readonly chatId: ChatId
}

function chatMetadataResourceNames(input: ChatMetadataResourceInput): readonly string[] {
  return [...input.chatIds.map((chatId) => `chat-meta:${chatId}`), ...input.linkedResourceNames]
}

function singleChatMetadataResourceNames(
  input: SingleChatMetadataResourceInput,
): readonly string[] {
  return [`chat-meta:${input.chatId}`]
}

const SINGLE_CHAT_METADATA_EXACT_PLAN = semanticOperationExactPlan({
  replay: {
    kind: 'single-attempt',
    reason: 'unfenced-relative-update',
  },
  bounds: {
    reads: {
      maxRequests: 28,
      maxRows: 29,
      maxBatchRows: 2,
      maxBytes: Number.MAX_SAFE_INTEGER,
    },
    writes: {
      maxRequests: 3,
      maxRows: 3,
      maxBatchRows: 1,
      maxBytes: Number.MAX_SAFE_INTEGER,
    },
  },
})

const CHAT_TOUCH_VIEWED_OPERATION = semanticOperationDescriptor({
  operationKind: 'chat.touch-viewed',
  transaction: CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
  resources: singleChatMetadataResourceNames,
  permittedWrites: CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['chats'],
  ...semanticOperationExactReceiptContracts<
    SingleChatMetadataResourceInput,
    PhysicalStorageTableName
  >(),
  replay: semanticOperationCallerSingleAttemptReplayContract('unfenced-relative-update'),
})

const CHAT_SET_MANUAL_TITLE_OPERATION = semanticOperationDescriptor({
  operationKind: 'chat.set-manual-title',
  transaction: CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
  resources: singleChatMetadataResourceNames,
  permittedWrites: CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['chats'],
  ...semanticOperationExactReceiptContracts<
    SingleChatMetadataResourceInput,
    PhysicalStorageTableName
  >(),
  replay: semanticOperationCallerSingleAttemptReplayContract('unfenced-relative-update'),
})

const CHAT_SET_ARCHIVED_OPERATION = semanticOperationDescriptor({
  operationKind: 'chat.set-archived',
  transaction: CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
  resources: chatMetadataResourceNames,
  permittedWrites: CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['chats'],
  ...semanticOperationExactReceiptContracts<ChatSetArchivedPlan, PhysicalStorageTableName>(),
  replay: semanticOperationCallerSingleAttemptReplayContract('unfenced-relative-update'),
})
const CHAT_SET_ARCHIVED_PREFLIGHT_TRANSACTION_CAPABILITY =
  physicalStorageTables('configurationLinks')
const CHAT_SET_ARCHIVED_PREFLIGHT_TRANSACTION_PLAN = physicalTransactionPlan(
  CHAT_SET_ARCHIVED_PREFLIGHT_TRANSACTION_CAPABILITY,
)
const CHAT_FOLDER_TRANSACTION_CAPABILITY = physicalStorageTables(
  ...CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY.tableNames,
  'folders',
)
const CHAT_MOVE_TO_FOLDER_PREFLIGHT_TRANSACTION_CAPABILITY =
  physicalStorageTables('chatSidebarRows')
const CHAT_MOVE_TO_FOLDER_PREFLIGHT_TRANSACTION_PLAN = physicalTransactionPlan(
  CHAT_MOVE_TO_FOLDER_PREFLIGHT_TRANSACTION_CAPABILITY,
)
const CHAT_FOLDER_LINK_TRANSACTION_CAPABILITY = physicalStorageTables(
  ...CHAT_ROW_LINKED_TRANSACTION_CAPABILITY.tableNames,
  'folders',
)
const CHAT_TAG_TRANSACTION_CAPABILITY = physicalStorageTables(
  ...CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY.tableNames,
  'tags',
)
const CHAT_MOVE_TO_FOLDER_OPERATION = semanticOperationDescriptor({
  operationKind: 'chat.move-to-folder',
  transaction: CHAT_FOLDER_TRANSACTION_CAPABILITY,
  resources: chatMetadataResourceNames,
  permittedWrites: CHAT_FOLDER_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['chats'],
  ...semanticOperationExactReceiptContracts<ChatMoveToFolderPlan, PhysicalStorageTableName>(),
  replay: semanticOperationCallerSingleAttemptReplayContract('unfenced-relative-update'),
})
const CHAT_SET_TAGS_FROM_NAMES_OPERATION = semanticOperationDescriptor({
  operationKind: 'chat.set-tags-from-names',
  transaction: CHAT_TAG_TRANSACTION_CAPABILITY,
  resources: chatMetadataResourceNames,
  permittedWrites: CHAT_TAG_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['chats'],
  effects: {
    kind: 'effect-kinds',
    permitted: ['chat', 'sidebar', 'tag'],
    requiredWhenMutated: (tableNames) => [
      'chat',
      'sidebar',
      ...(tableNames.has('tags') ? (['tag'] as const) : []),
    ],
  },
})
const CHAT_CALIBRATION_TRANSACTION_CAPABILITY = physicalStorageTables(
  ...CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY.tableNames,
  'settings',
)
type ChatCalibrationTransaction = FencedTransaction<
  CapabilityTables<typeof CHAT_CALIBRATION_TRANSACTION_CAPABILITY>
>

interface ChatCalibrationResourceInput {
  readonly chatIds: readonly ChatId[]
}

function chatCalibrationResourceNames(input: ChatCalibrationResourceInput): readonly string[] {
  return [
    `setting:${GLOBAL_TOKEN_CALIBRATION_KEY}`,
    ...input.chatIds.map((chatId) => `chat-meta:${chatId}`),
  ]
}

const CHAT_CALIBRATION_CLEAR_OPERATION = semanticOperationDescriptor({
  operationKind: 'chat.calibration.clear',
  transaction: CHAT_CALIBRATION_TRANSACTION_CAPABILITY,
  resources: chatCalibrationResourceNames,
  permittedWrites: CHAT_CALIBRATION_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['chats', 'settings'],
  ...semanticOperationExactReceiptContracts<
    ChatCalibrationResourceInput,
    PhysicalStorageTableName
  >(),
  replay: semanticOperationCallerSingleAttemptReplayContract('unfenced-relative-update'),
})

const CHAT_CALIBRATION_CLEAR_FAMILY_OPERATION = semanticOperationDescriptor({
  operationKind: 'chat.calibration.clear-family',
  transaction: CHAT_CALIBRATION_TRANSACTION_CAPABILITY,
  resources: chatCalibrationResourceNames,
  permittedWrites: CHAT_CALIBRATION_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['settings'],
  ...semanticOperationExactReceiptContracts<
    ChatCalibrationResourceInput,
    PhysicalStorageTableName
  >(),
  replay: semanticOperationCallerSingleAttemptReplayContract('unfenced-relative-update'),
})

const CHAT_CALIBRATION_CLEAR_ALL_OPERATION = semanticOperationDescriptor({
  operationKind: 'chat.calibration.clear-all',
  transaction: CHAT_CALIBRATION_TRANSACTION_CAPABILITY,
  resources: chatCalibrationResourceNames,
  permittedWrites: CHAT_CALIBRATION_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['settings'],
  ...semanticOperationExactReceiptContracts<
    ChatCalibrationResourceInput,
    PhysicalStorageTableName
  >(),
  replay: semanticOperationCallerSingleAttemptReplayContract('unfenced-relative-update'),
})

const CHAT_CALIBRATION_CLEAR_EXACT_PLAN = semanticOperationExactPlan({
  replay: {
    kind: 'single-attempt',
    reason: 'unfenced-relative-update',
  },
  bounds: {
    reads: {
      maxRequests: 2,
      maxRows: 2,
      maxBatchRows: 1,
      maxBytes: Number.MAX_SAFE_INTEGER,
    },
    writes: {
      maxRequests: 2,
      maxRows: 2,
      maxBatchRows: 1,
      maxBytes: Number.MAX_SAFE_INTEGER,
    },
  },
})

const CHAT_CALIBRATION_FANOUT_EXACT_PLAN = semanticOperationExactPlan({
  replay: {
    kind: 'single-attempt',
    reason: 'unfenced-relative-update',
  },
  bounds: {
    reads: {
      maxRequests: Number.MAX_SAFE_INTEGER,
      maxRows: Number.MAX_SAFE_INTEGER,
      maxBatchRows: Number.MAX_SAFE_INTEGER,
      maxBytes: Number.MAX_SAFE_INTEGER,
    },
    writes: {
      maxRequests: Number.MAX_SAFE_INTEGER,
      maxRows: Number.MAX_SAFE_INTEGER,
      maxBatchRows: Number.MAX_SAFE_INTEGER,
      maxBytes: Number.MAX_SAFE_INTEGER,
    },
  },
})

interface ChatClosureResourceInput {
  readonly chatIds: readonly ChatId[]
}

interface EmptyArchiveResourceInput {
  readonly afterChatId?: ChatId
}

function chatClosureResourceNames(input: ChatClosureResourceInput): readonly string[] {
  return [
    `setting:${GLOBAL_TOKEN_CALIBRATION_KEY}`,
    ...input.chatIds.flatMap((chatId) => [`chat-meta:${chatId}`, `draft:${chatId}`]),
  ]
}

function emptyArchiveResourceNames(input: EmptyArchiveResourceInput): readonly string[] {
  return [
    `chat-archive-page:${input.afterChatId ?? 'start'}`,
    `setting:${GLOBAL_TOKEN_CALIBRATION_KEY}`,
  ]
}

const CHAT_CLOSURE_EFFECTS = {
  kind: 'effect-kinds',
  permitted: ['attachment', 'chat', 'draft', 'profile', 'setting', 'sidebar', 'stream-chunks'],
  requiredWhenMutated: () => ['chat', 'sidebar'] as const,
} as const

const CHAT_DISCARD_EMPTY_DRAFTS_OPERATION = semanticOperationDescriptor({
  operationKind: 'chat.discard-empty-drafts',
  transaction: CHAT_CLOSURE_TRANSACTION_CAPABILITY,
  resources: chatClosureResourceNames,
  permittedWrites: CHAT_CLOSURE_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['chats'],
  effects: CHAT_CLOSURE_EFFECTS,
})

const CHAT_DELETE_ARCHIVED_OPERATION = semanticOperationDescriptor({
  operationKind: 'chat.delete-archived',
  transaction: CHAT_CLOSURE_TRANSACTION_CAPABILITY,
  resources: chatClosureResourceNames,
  permittedWrites: CHAT_CLOSURE_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['chats'],
  effects: CHAT_CLOSURE_EFFECTS,
})

const CHAT_EMPTY_ARCHIVE_OPERATION = semanticOperationDescriptor({
  operationKind: 'chat.empty-archive',
  transaction: CHAT_CLOSURE_TRANSACTION_CAPABILITY,
  resources: emptyArchiveResourceNames,
  permittedWrites: CHAT_CLOSURE_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['chats'],
  effects: CHAT_CLOSURE_EFFECTS,
})

const FOLDER_TRANSACTION_CAPABILITY = physicalStorageTables('folders')

interface FolderRowResourceInput {
  readonly folderId: FolderId
}

interface EnsureFolderResourceInput extends FolderRowResourceInput {
  readonly chatIds: readonly ChatId[]
  readonly nameKey: string
}

function folderRowResourceNames(input: FolderRowResourceInput): readonly string[] {
  return [`folder:${input.folderId}`]
}

function ensureFolderResourceNames(input: EnsureFolderResourceInput): readonly string[] {
  return [
    `folder:${input.folderId}`,
    folderMembershipResourceName(input.folderId),
    `folder-name:${input.nameKey}`,
    ...input.chatIds.map((chatId) => `chat-meta:${chatId}`),
  ]
}

function deleteFolderResourceNames(input: FolderRowResourceInput): readonly string[] {
  return [`folder:${input.folderId}`, folderMembershipResourceName(input.folderId)]
}

function folderMembershipResourceName(folderId: FolderId | null): string {
  return folderId === null ? 'root-folder-membership' : `folder-membership:${folderId}`
}

function folderRowExactPlan(
  reason: 'random-identity' | 'unfenced-relative-update',
): SemanticOperationExactPlan {
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason },
    bounds: {
      reads: {
        maxRequests: 1,
        maxRows: 1,
        maxBatchRows: 1,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
      writes: {
        maxRequests: 1,
        maxRows: 1,
        maxBatchRows: 1,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
    },
  })
}

const FOLDER_CREATE_EXACT_PLAN = folderRowExactPlan('random-identity')
const FOLDER_UPDATE_EXACT_PLAN = folderRowExactPlan('unfenced-relative-update')

const FOLDER_CREATE_OPERATION = semanticOperationDescriptor({
  operationKind: 'folder.create',
  transaction: FOLDER_TRANSACTION_CAPABILITY,
  resources: folderRowResourceNames,
  permittedWrites: FOLDER_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['folders'],
  ...semanticOperationExactReceiptContracts<FolderRowResourceInput, 'folders'>(),
  replay: semanticOperationCallerSingleAttemptReplayContract('random-identity'),
})

const FOLDER_UPDATE_OPERATION = semanticOperationDescriptor({
  operationKind: 'folder.update',
  transaction: FOLDER_TRANSACTION_CAPABILITY,
  resources: folderRowResourceNames,
  permittedWrites: FOLDER_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['folders'],
  ...semanticOperationExactReceiptContracts<FolderRowResourceInput, 'folders'>(),
  replay: semanticOperationCallerSingleAttemptReplayContract('unfenced-relative-update'),
})

const FOLDER_ENSURE_AND_MOVE_CHATS_OPERATION = semanticOperationDescriptor({
  operationKind: 'folder.ensure-and-move-chats',
  transaction: CHAT_FOLDER_TRANSACTION_CAPABILITY,
  resources: ensureFolderResourceNames,
  permittedWrites: CHAT_FOLDER_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: [],
  effects: {
    kind: 'effect-kinds',
    permitted: ['chat', 'folder', 'sidebar'],
    requiredWhenMutated: (tableNames) => [
      ...(tableNames.has('folders') ? (['folder'] as const) : []),
      ...(tableNames.has('chats') ? (['chat', 'sidebar'] as const) : []),
    ],
  },
})

const FOLDER_DELETE_MOVE_TOP_LEVEL_OPERATION = semanticOperationDescriptor({
  operationKind: 'folder.delete',
  transaction: CHAT_FOLDER_TRANSACTION_CAPABILITY,
  resources: deleteFolderResourceNames,
  permittedWrites: CHAT_FOLDER_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['folders'],
  effects: {
    kind: 'effect-kinds',
    permitted: ['chat', 'folder', 'sidebar'],
    requiredWhenMutated: (tableNames) => [
      'folder',
      ...(tableNames.has('chats') ? (['chat', 'sidebar'] as const) : []),
    ],
  },
})

const FOLDER_DELETE_ARCHIVE_OPERATION = semanticOperationDescriptor({
  operationKind: 'folder.delete',
  transaction: CHAT_FOLDER_LINK_TRANSACTION_CAPABILITY,
  resources: deleteFolderResourceNames,
  permittedWrites: CHAT_FOLDER_LINK_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['folders'],
  effects: {
    kind: 'effect-kinds',
    permitted: ['chat', 'folder', 'preset', 'profile', 'prompt-preset', 'sidebar', 'text-template'],
    requiredWhenMutated: (tableNames) => [
      'folder',
      ...(tableNames.has('chats') ? (['chat', 'sidebar'] as const) : []),
      ...(tableNames.has('configurationProfileUsageRows') ? (['profile'] as const) : []),
    ],
  },
})

export class ChatSetArchivedLinkPlanChangedError extends Error {}
export class ChatMoveToFolderPlanChangedError extends Error {}

function calibrationRecordWithoutFamily(
  samples: Record<string, TokenCalibrationSample> | undefined,
  calibrationKey: string,
): { changed: boolean; samples: Record<string, TokenCalibrationSample> } {
  const retained: Record<string, TokenCalibrationSample> = {}
  let changed = false
  for (const [storedKey, sample] of Object.entries(samples ?? {})) {
    if (tokenCalibrationKeyForStoredRecordKey(storedKey) === calibrationKey) {
      changed = true
      continue
    }
    retained[storedKey] = sample
  }
  return { changed, samples: aggregateCalibrationSamples(retained) }
}

function normalizeName(value: string, kind: 'Folder' | 'Tag'): string {
  const name = value.trim()
  if (name.length === 0) throw new Error(`${kind}NameRequired`)
  return name
}

function organizationNameKey(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase()
}

function patchOptionalString<T extends object>(
  row: T,
  key: keyof T,
  value: string | null | undefined,
): void {
  if (value === null || value === undefined || value.trim().length === 0) {
    delete row[key]
    return
  }
  row[key] = value as T[keyof T]
}

function patchOptionalNumber<T extends object>(
  row: T,
  key: keyof T,
  value: number | null | undefined,
): void {
  if (value === null || value === undefined) {
    delete row[key]
    return
  }
  row[key] = value as T[keyof T]
}

export async function materializeTemporaryChat(
  mutationPort: BrowserMutationRunnerPort,
  input: Extract<WorkspaceCommand, { kind: 'chat.materialize-temporary' }>['input'],
  replacementEpoch: number,
  commit: BrowserMutationCommandPort,
) {
  const chat = createChatRow({
    id: input.chatId,
    settings: input.settings,
    ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
    temporary: true,
    now: input.now,
  })
  const result = await mutationPort.runMutation(
    [{ kind: 'chat-meta', chatId: chat.id }],
    (_ctx, mutation) => {
      mutation.requestStorageMaintenance('prune-empty-drafts')
    },
    {
      initialChat: chat,
      workspaceFence: { replacementEpoch },
      storageMaintenanceTasks: ['prune-empty-drafts'],
    },
    commit,
    async (ctx) => {
      const committedChat = await ctx.getFinalChat(chat.id)
      if (!committedChat) throw new Error(`TemporaryChatCommitMissing:${chat.id}`)
      return {
        destination: await ctx.sealExactConversationDestination({
          chat: committedChat,
          target: fixedConversationSelectionTarget({ kind: 'default' }, null),
          tipId: null,
          exactPathHeaders: Object.freeze([]),
        }),
      }
    },
  )
  return result.value
}

export async function discardEmptyDraftChats(
  input: {
    chatIds: readonly ChatId[]
    now?: number
    staleBefore?: number
  },
  commit: BrowserSemanticCommandPort<'chat.discard-empty-drafts'>,
): Promise<DeleteArchivedChatMetadataResult> {
  const chatIds = [...new Set(input.chatIds)].sort()
  if (chatIds.length > CHAT_CLOSURE_BATCH_LIMIT) {
    throw new Error('ChatClosureBatchLimitExceeded')
  }
  const now = input.now ?? Date.now()
  const closure = await commit.executeSemanticOperation(
    CHAT_DISCARD_EMPTY_DRAFTS_OPERATION,
    { chatIds },
    (tx) => deleteEligibleEmptyDraftChatClosure(tx, chatIds, input.staleBefore, now),
  )
  return {
    deletedChatIds: closure.deletedChatIds,
    affectedAttachmentIds: closure.affectedAttachmentIds,
  }
}

function chatSetArchivedExactPlan(chatCount: number): SemanticOperationExactPlan {
  if (chatCount === 0) {
    return semanticOperationExactPlan({
      replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
      bounds: {
        reads: { maxRequests: 0, maxRows: 0, maxBatchRows: 0, maxBytes: 0 },
        writes: { maxRequests: 0, maxRows: 0, maxBatchRows: 0, maxBytes: 0 },
      },
    })
  }
  const ownerBatches = Math.ceil(chatCount / CONFIGURATION_OWNER_LINK_BATCH_SIZE)
  const maxLinkBatchRows =
    CHAT_CONFIGURATION_LINK_SLOT_LIMIT * Math.min(CONFIGURATION_OWNER_LINK_BATCH_SIZE, chatCount)
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
    bounds: {
      reads: {
        maxRequests:
          5 + 3 * ownerBatches + CHAT_SIDEBAR_FOLDER_EXTREMA_READ_REQUEST_LIMIT * chatCount,
        maxRows: (29 + 2 * CHAT_CONFIGURATION_LINK_SLOT_LIMIT) * chatCount + 3,
        maxBatchRows: Math.max(chatCount + 1, maxLinkBatchRows),
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
      writes: {
        maxRequests: 6 + 4 * ownerBatches,
        maxRows: (4 + 2 * CHAT_CONFIGURATION_LINK_SLOT_LIMIT) * chatCount + 2,
        maxBatchRows: Math.max(chatCount, maxLinkBatchRows),
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
    },
  })
}

function chatSetArchivedPreflightPhysicalReads(
  chatCount: number,
  rowCount: number,
): readonly SemanticOperationExactPhysicalRead[] {
  if (rowCount > CHAT_CONFIGURATION_LINK_SLOT_LIMIT * chatCount) {
    throw new Error('ChatSetArchivedPreflightLinkLimitExceeded')
  }
  const ownerQueryRequests = Math.ceil(chatCount / CONFIGURATION_OWNER_LINK_BATCH_SIZE)
  return Object.freeze(
    ownerQueryRequests === 0
      ? []
      : [
          Object.freeze({
            tableName: 'configurationLinks' as const,
            indexKind: 'secondary' as const,
            indexName: 'ownerKey',
            operation: 'open-cursor' as const,
            requestCount: ownerQueryRequests,
            rowCount,
          }),
        ],
  )
}

async function readChatSetArchivedPlan(
  commit: BrowserCommandSessionPort,
  chatIds: readonly ChatId[],
  archived: boolean,
  now: number,
): Promise<ChatSetArchivedPlan> {
  const uniqueChatIds = [...new Set(chatIds)].sort()
  const links =
    uniqueChatIds.length === 0
      ? []
      : await commit.readSemanticOperationPreflight(
          CHAT_SET_ARCHIVED_PREFLIGHT_TRANSACTION_PLAN,
          async (tx) => {
            const rows: ConfigurationLink[] = []
            const table = tx.table<ConfigurationLink, string>('configurationLinks')
            for (
              let offset = 0;
              offset < uniqueChatIds.length;
              offset += CONFIGURATION_OWNER_LINK_BATCH_SIZE
            ) {
              const ownerKeys = uniqueChatIds
                .slice(offset, offset + CONFIGURATION_OWNER_LINK_BATCH_SIZE)
                .map((chatId) => configurationOwnerKey('chat', chatId))
              rows.push(...(await table.where('ownerKey').anyOf(ownerKeys).toArray()))
            }
            return rows
          },
        )
  const linkedResourceNames = normalizeNamedLocks(configurationTargetResourceNamesForLinks(links))
  return Object.freeze({
    chatIds: Object.freeze(uniqueChatIds),
    archived,
    now,
    linkedResourceNames: Object.freeze(linkedResourceNames),
    configurationLinkCount: links.length,
    exactPlan: chatSetArchivedExactPlan(uniqueChatIds.length),
    [chatSetArchivedPlanBrand]: true as const,
  })
}

function chatSetArchivedReceipt(
  plan: ChatSetArchivedPlan,
  transition: ChatRowWriteMutationReceipt | undefined,
  updatedAtClockRead: boolean,
): SemanticOperationExactReceipt<PhysicalStorageTableName> {
  if (
    plan[chatSetArchivedPlanBrand] !== true ||
    !Number.isSafeInteger(plan.configurationLinkCount) ||
    plan.configurationLinkCount < 0
  ) {
    throw new Error('ChatSetArchivedPlanInvalid')
  }
  const fragment = transition?.fragment
  return semanticOperationExactReceipt(plan.exactPlan, {
    dependencies: fragment?.dependencies ?? [],
    physicalMutations: fragment?.physicalMutations ?? [],
    physicalReads: [
      ...chatSetArchivedPreflightPhysicalReads(plan.chatIds.length, plan.configurationLinkCount),
      ...(plan.chatIds.length > 0
        ? [
            {
              tableName: 'chats' as const,
              indexKind: 'primary' as const,
              operation: 'get-many' as const,
              requestCount: 1,
              rowCount: plan.chatIds.length,
            },
          ]
        : []),
      ...(updatedAtClockRead
        ? [
            {
              tableName: 'chats' as const,
              indexKind: 'secondary' as const,
              indexName: 'updatedAt',
              operation: 'query' as const,
              requestCount: 1,
              rowCount: 1,
            },
          ]
        : []),
      ...(fragment?.physicalReads ?? []),
    ],
  })
}

function chatMoveToFolderExactPlan(chatCount: number): SemanticOperationExactPlan {
  if (chatCount === 0) {
    return semanticOperationExactPlan({
      replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
      bounds: {
        reads: { maxRequests: 0, maxRows: 0, maxBatchRows: 0, maxBytes: 0 },
        writes: { maxRequests: 0, maxRows: 0, maxBatchRows: 0, maxBytes: 0 },
      },
    })
  }
  return semanticOperationExactPlan({
    replay: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
    bounds: {
      reads: {
        maxRequests: 6 + CHAT_SIDEBAR_FOLDER_EXTREMA_READ_REQUEST_LIMIT * chatCount,
        maxRows: 28 * chatCount + 4,
        maxBatchRows: chatCount + 2,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
      writes: {
        maxRequests: 6,
        maxRows: 3 * chatCount + 2,
        maxBatchRows: chatCount + 1,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
    },
  })
}

function chatMoveToFolderLinkedResourceNames(
  rows: readonly (Pick<Chat, 'folderId'> | undefined)[],
  folderId: FolderId | null,
): readonly string[] {
  const pending = rows.filter(
    (row): row is Pick<Chat, 'folderId'> =>
      row !== undefined && (row.folderId ?? null) !== folderId,
  )
  if (pending.length === 0) return []
  return normalizeNamedLocks([
    ...(folderId === null ? [] : [`folder:${folderId}`]),
    folderMembershipResourceName(folderId),
    ...pending.map((row) => folderMembershipResourceName(row.folderId ?? null)),
  ])
}

async function readChatMoveToFolderPlan(
  commit: BrowserCommandSessionPort,
  chatIds: readonly ChatId[],
  folderId: FolderId | null,
  now: number,
): Promise<ChatMoveToFolderPlan> {
  const uniqueChatIds = [...new Set(chatIds)].sort()
  const rows =
    uniqueChatIds.length === 0
      ? []
      : await commit.readSemanticOperationPreflight(
          CHAT_MOVE_TO_FOLDER_PREFLIGHT_TRANSACTION_PLAN,
          (tx) =>
            tx.table<ChatSidebarProjectionRow, ChatId>('chatSidebarRows').bulkGet(uniqueChatIds),
        )
  return Object.freeze({
    chatIds: Object.freeze(uniqueChatIds),
    folderId,
    now,
    linkedResourceNames: Object.freeze(chatMoveToFolderLinkedResourceNames(rows, folderId)),
    exactPlan: chatMoveToFolderExactPlan(uniqueChatIds.length),
    [chatMoveToFolderPlanBrand]: true as const,
  })
}

function chatMoveToFolderReceipt(
  plan: ChatMoveToFolderPlan,
  fragment: SemanticOperationReceiptFragment<PhysicalStorageTableName> | undefined,
  reads: {
    readonly chats: boolean
    readonly destinationFolder: boolean
    readonly updatedAtClock: boolean
  },
): SemanticOperationExactReceipt<PhysicalStorageTableName> {
  if (plan[chatMoveToFolderPlanBrand] !== true) {
    throw new Error('ChatMoveToFolderPlanInvalid')
  }
  return semanticOperationExactReceipt(plan.exactPlan, {
    dependencies: fragment?.dependencies ?? [],
    physicalMutations: fragment?.physicalMutations ?? [],
    physicalReads: [
      ...(plan.chatIds.length > 0
        ? [
            {
              tableName: 'chatSidebarRows' as const,
              indexKind: 'primary' as const,
              operation: 'get-many' as const,
              requestCount: 1,
              rowCount: plan.chatIds.length,
            },
          ]
        : []),
      ...(reads.chats
        ? [
            {
              tableName: 'chats' as const,
              indexKind: 'primary' as const,
              operation: 'get-many' as const,
              requestCount: 1,
              rowCount: plan.chatIds.length,
            },
          ]
        : []),
      ...(reads.destinationFolder
        ? [
            {
              tableName: 'folders' as const,
              indexKind: 'primary' as const,
              operation: 'get' as const,
              requestCount: 1,
              rowCount: 1,
            },
          ]
        : []),
      ...(reads.updatedAtClock
        ? [
            {
              tableName: 'chats' as const,
              indexKind: 'secondary' as const,
              indexName: 'updatedAt',
              operation: 'query' as const,
              requestCount: 1,
              rowCount: 1,
            },
          ]
        : []),
      ...(fragment?.physicalReads ?? []),
    ],
  })
}

function chatMoveToFolderResult(changedChats: readonly Chat[]): ChatMetadataWriteResult<boolean> {
  const chatVersions: Record<ChatId, ChatVersions> = {}
  for (const chat of changedChats) chatVersions[chat.id] = chatVersionsFor(chat)
  return {
    value: changedChats.length > 0,
    affectedChatIds: changedChats.map((chat) => chat.id),
    chatVersions,
  }
}

function chatMetadataWriteResult(
  changedChats: readonly Chat[],
): ChatMetadataWriteResult<readonly ChatId[]> {
  const chatVersions: Record<ChatId, ChatVersions> = {}
  for (const chat of changedChats) {
    chatVersions[chat.id] = {
      metaVersion: chat.metaVersion,
      summaryVersion: chat.summaryVersion,
      structuralVersion: chat.structuralVersion,
    }
  }
  return {
    value: changedChats.map((chat) => chat.id),
    affectedChatIds: changedChats.map((chat) => chat.id),
    chatVersions,
  }
}

function singleChatMetadataReceipt(
  transition: ChatRowWriteMutationReceipt | undefined,
  updatedAtClockRead: boolean,
): SemanticOperationExactReceipt<PhysicalStorageTableName> {
  const fragment = transition?.fragment
  return semanticOperationExactReceipt(SINGLE_CHAT_METADATA_EXACT_PLAN, {
    dependencies: fragment?.dependencies ?? [],
    physicalMutations: fragment?.physicalMutations ?? [],
    physicalReads: [
      {
        tableName: 'chats',
        indexKind: 'primary',
        operation: 'get',
        requestCount: 1,
        rowCount: 1,
      },
      ...(updatedAtClockRead
        ? [
            {
              tableName: 'chats' as const,
              indexKind: 'secondary' as const,
              indexName: 'updatedAt',
              operation: 'query' as const,
              requestCount: 1,
              rowCount: 1,
            },
          ]
        : []),
      ...(fragment?.physicalReads ?? []),
    ],
  })
}

function chatCalibrationReceipt(
  plan: SemanticOperationExactPlan,
  chatRead: {
    readonly operation: 'get' | 'query'
    readonly rowCount: number
  },
  transition: ChatRowWriteMutationReceipt | undefined,
  settingRead: boolean,
): SemanticOperationExactReceipt<PhysicalStorageTableName> {
  const fragment = transition?.fragment
  const settingTouched = settingRead
  return semanticOperationExactReceipt(plan, {
    dependencies: normalizeWorkspaceDependencies([
      ...(fragment?.dependencies ?? []),
      ...(settingTouched
        ? [{ kind: 'setting' as const, keys: [GLOBAL_TOKEN_CALIBRATION_KEY] }]
        : []),
    ]),
    physicalMutations: [
      ...(fragment?.physicalMutations ?? []),
      ...(settingTouched
        ? [
            {
              tableName: 'settings' as const,
              operation: 'write' as const,
              key: GLOBAL_TOKEN_CALIBRATION_KEY,
            },
          ]
        : []),
    ],
    physicalReads: [
      {
        tableName: 'chats' as const,
        indexKind: 'primary' as const,
        operation: chatRead.operation,
        requestCount: 1,
        rowCount: chatRead.rowCount,
      },
      ...(fragment?.physicalReads ?? []),
      ...(settingTouched
        ? [
            {
              tableName: 'settings' as const,
              indexKind: 'primary' as const,
              operation: 'get' as const,
              requestCount: 1,
              rowCount: 1,
            },
          ]
        : []),
    ],
  })
}

async function patchSingleChatMetadataRow<
  Kind extends 'chat.touch-viewed' | 'chat.set-manual-title',
  Tables extends PhysicalStorageTableName,
>(
  descriptor: SemanticOperationDescriptor<
    Kind,
    Tables,
    SingleChatMetadataResourceInput,
    SemanticOperationExactReceipt<PhysicalStorageTableName>
  >,
  chatId: ChatId,
  now: number,
  commit: BrowserSemanticCommandPort<Kind>,
  patch: (chat: Chat) =>
    | {
        chat: Chat
        touchMeta: boolean
        touchSummary: boolean
      }
    | undefined,
): Promise<ChatMetadataWriteResult<boolean>> {
  const changed = await commit.executeSemanticOperation(descriptor, { chatId }, async (tx) => {
    const current = await readCurrentChatForTransaction(tx, chatId)
    if (!current) {
      return semanticOperationExecution(undefined, singleChatMetadataReceipt(undefined, false))
    }
    const change = patch(current)
    if (!change) {
      return semanticOperationExecution(undefined, singleChatMetadataReceipt(undefined, false))
    }
    const updatedAtClockRead = change.touchSummary
    const updatedAt = updatedAtClockRead
      ? await new TransactionChatUpdateClock().next(tx, now)
      : change.chat.updatedAt
    const next: Chat = {
      ...change.chat,
      metaVersion: current.metaVersion + (change.touchMeta ? 1 : 0),
      summaryVersion: current.summaryVersion + (change.touchSummary ? 1 : 0),
      updatedAt,
    }
    const transition = await applyChatRowWriteTransitions(tx, [
      {
        kind: 'replace-preserving-links',
        previous: current,
        next,
      },
    ])
    return semanticOperationExecution(
      next,
      singleChatMetadataReceipt(transition, updatedAtClockRead),
    )
  })
  return {
    value: changed !== undefined,
    affectedChatIds: changed ? [changed.id] : [],
    chatVersions: changed
      ? {
          [changed.id]: {
            metaVersion: changed.metaVersion,
            summaryVersion: changed.summaryVersion,
            structuralVersion: changed.structuralVersion,
          },
        }
      : {},
  }
}

export async function setChatsArchived(
  chatIds: readonly ChatId[],
  archived: boolean,
  now: number,
  commit: BrowserCommandSessionPort,
): Promise<ChatMetadataWriteResult<readonly ChatId[]>> {
  const plan = await readChatSetArchivedPlan(commit, chatIds, archived, now)
  if (plan.chatIds.length === 0) {
    const emptyReceipt = chatSetArchivedReceipt(plan, undefined, false)
    await commit.completeSemanticOperation(
      CHAT_SET_ARCHIVED_OPERATION,
      plan,
      undefined,
      emptyReceipt,
    )
    return chatMetadataWriteResult([])
  }
  const changedChats = await commit.executeSemanticOperation(
    CHAT_SET_ARCHIVED_OPERATION,
    plan,
    async (tx) => {
      const rows = await readOptionalCurrentChatRowsForTransaction(tx, plan.chatIds)
      const currentResourceNames: string[] = []
      const pending: Array<{
        readonly current: TransactionCurrentChat
        readonly projected: Chat
      }> = []
      for (const current of rows) {
        if (!current) continue
        currentResourceNames.push(...chatConfigurationTargetResourceNames(current))
        if (current.archived === plan.archived) continue
        const projected = { ...current, archived: plan.archived }
        currentResourceNames.push(...chatConfigurationTargetResourceNames(projected))
        pending.push({ current, projected })
      }
      if (!sameOrderedValues(plan.linkedResourceNames, normalizeNamedLocks(currentResourceNames))) {
        throw new ChatSetArchivedLinkPlanChangedError()
      }
      const updatedAtClock = new TransactionChatUpdateClock()
      const writes: Array<{ readonly current: TransactionCurrentChat; readonly next: Chat }> = []
      for (const { current, projected } of pending) {
        writes.push({
          current,
          next: {
            ...projected,
            metaVersion: current.metaVersion + 1,
            summaryVersion: current.summaryVersion + 1,
            updatedAt: await updatedAtClock.next(tx, plan.now),
          },
        })
      }
      const transition = await applyChatRowWriteTransitions(
        tx,
        writes.map(({ current, next }) => ({
          kind: 'replace-linked' as const,
          previous: current,
          next,
        })),
      )
      return semanticOperationExecution(
        writes.map(({ next }) => next),
        chatSetArchivedReceipt(plan, transition, writes.length > 0),
      )
    },
  )
  return chatMetadataWriteResult(changedChats)
}

export async function touchChatViewed(
  chatId: ChatId,
  now: number,
  commit: BrowserCommandSessionPort,
): Promise<ChatMetadataWriteResult<boolean>> {
  return patchSingleChatMetadataRow(CHAT_TOUCH_VIEWED_OPERATION, chatId, now, commit, (chat) => {
    if (chat.lastViewedAt >= now) return undefined
    return {
      chat: { ...chat, lastViewedAt: now },
      touchMeta: false,
      touchSummary: false,
    }
  })
}

export async function setChatManualTitle(
  chatId: ChatId,
  title: string,
  now: number,
  commit: BrowserCommandSessionPort,
): Promise<ChatMetadataWriteResult<boolean>> {
  const trimmed = title.trim()
  return patchSingleChatMetadataRow(
    CHAT_SET_MANUAL_TITLE_OPERATION,
    chatId,
    now,
    commit,
    (chat) => {
      if (trimmed.length === 0 || (chat.title === trimmed && chat.titleStatus === 'manual')) {
        return undefined
      }
      return {
        chat: { ...chat, title: trimmed, titleStatus: 'manual', updatedAt: now },
        touchMeta: true,
        touchSummary: true,
      }
    },
  )
}

export async function moveChatRowsToFolder(
  chatIds: readonly ChatId[],
  folderId: FolderId | null,
  now: number,
  commit: BrowserCommandSessionPort,
): Promise<ChatMetadataWriteResult<boolean>> {
  const plan = await readChatMoveToFolderPlan(commit, chatIds, folderId, now)
  if (plan.chatIds.length === 0) {
    const receipt = chatMoveToFolderReceipt(plan, undefined, {
      chats: false,
      destinationFolder: false,
      updatedAtClock: false,
    })
    return commit.completeSemanticOperation(
      CHAT_MOVE_TO_FOLDER_OPERATION,
      plan,
      chatMoveToFolderResult([]),
      receipt,
    )
  }
  return commit.executeSemanticOperation(CHAT_MOVE_TO_FOLDER_OPERATION, plan, async (tx) => {
    const rows = await readOptionalCurrentChatRowsForTransaction(tx, plan.chatIds)
    if (
      !sameOrderedValues(
        plan.linkedResourceNames,
        chatMoveToFolderLinkedResourceNames(rows, plan.folderId),
      )
    ) {
      throw new ChatMoveToFolderPlanChangedError()
    }
    const pending = rows.filter(
      (row): row is TransactionCurrentChat =>
        row !== undefined && (row.folderId ?? null) !== plan.folderId,
    )
    if (pending.length === 0) {
      const accumulator =
        boundSemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>(tx)
      if (!accumulator) throw new Error('ChatMoveToFolderReceiptAccumulatorMissing')
      return semanticOperationExecution(
        chatMoveToFolderResult([]),
        chatMoveToFolderReceipt(plan, accumulator.snapshotFragment(), {
          chats: true,
          destinationFolder: false,
          updatedAtClock: false,
        }),
      )
    }
    const folder =
      plan.folderId === null
        ? undefined
        : await tx.table<ChatFolder, FolderId>('folders').get(plan.folderId)
    if (plan.folderId !== null && !folder) {
      const accumulator =
        boundSemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>(tx)
      if (!accumulator) throw new Error('ChatMoveToFolderReceiptAccumulatorMissing')
      return semanticOperationExecution(
        chatMoveToFolderResult([]),
        chatMoveToFolderReceipt(plan, accumulator.snapshotFragment(), {
          chats: true,
          destinationFolder: true,
          updatedAtClock: false,
        }),
      )
    }
    const changedChats: Chat[] = []
    const updatedAtClock = new TransactionChatUpdateClock()
    const writes: Array<{ previous: TransactionCurrentChat; next: Chat }> = []
    for (const row of pending) {
      const next: Chat = {
        ...row,
        folderId: plan.folderId,
        updatedAt: await updatedAtClock.next(tx, plan.now),
        metaVersion: row.metaVersion + 1,
        summaryVersion: row.summaryVersion + 1,
      }
      writes.push({ previous: row, next })
      changedChats.push(next)
    }
    const transition = await applyChatRowWriteTransitions(
      tx,
      writes.map(({ previous, next }) => ({
        kind: 'replace-preserving-links',
        previous,
        next,
      })),
    )
    absorbSemanticOperationReceiptFragment(tx, transition.fragment)
    if (folder) {
      const touchedFolder = {
        ...folder,
        lastUsedAt: Math.max(folder.lastUsedAt ?? 0, plan.now),
        updatedAt: Math.max(folder.updatedAt, plan.now),
      }
      if (stableStringify(folder) !== stableStringify(touchedFolder)) {
        await putChatFolderByteOwner(tx, touchedFolder, folder)
      }
    }
    const accumulator = boundSemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>(tx)
    if (!accumulator) throw new Error('ChatMoveToFolderReceiptAccumulatorMissing')
    return semanticOperationExecution(
      chatMoveToFolderResult(changedChats),
      chatMoveToFolderReceipt(plan, accumulator.snapshotFragment(), {
        chats: true,
        destinationFolder: plan.folderId !== null,
        updatedAtClock: true,
      }),
    )
  })
}

export async function setChatRowsTagsFromNames(
  chatIds: readonly ChatId[],
  names: readonly string[],
  now: number,
  commit: BrowserSemanticCommandPort<'chat.set-tags-from-names'>,
): Promise<ChatTagAssignmentResult> {
  const uniqueChatIds = [...new Set(chatIds)].sort()
  const normalizedNames = uniqueChatTagNames(names)
  const nameKeys = normalizedNames.map(chatTagNameLower)
  return commit.executeSemanticOperation(
    CHAT_SET_TAGS_FROM_NAMES_OPERATION,
    {
      chatIds: uniqueChatIds,
      linkedResourceNames: nameKeys.map((nameKey) => `tag-name:${nameKey}`),
    },
    async (tx) => {
      const emptyResult = (): ChatTagAssignmentResult => ({
        value: [],
        affectedChatIds: [],
        chatVersions: {},
        affectedTagIds: [],
        deletedTagIds: [],
      })
      if (uniqueChatIds.length === 0) return emptyResult()
      const targets = (await readOptionalCurrentChatRowsForTransaction(tx, uniqueChatIds)).filter(
        (chat): chat is TransactionCurrentChat => chat !== undefined,
      )
      if (targets.length === 0) return emptyResult()

      const chats = tx.table<Chat, ChatId>('chats')
      const tags = tx.table<ChatTag, TagId>('tags')
      const requestedExisting =
        nameKeys.length === 0 ? [] : await tags.where('nameLower').anyOf(nameKeys).toArray()
      const byLower = new Map(requestedExisting.map((tag) => [tag.nameLower, tag]))
      const byId = new Map(requestedExisting.map((tag) => [tag.id, tag]))
      const previousById = new Map(requestedExisting.map((tag) => [tag.id, tag]))
      const affectedTagIds = new Set<TagId>()
      const selectedTagIds: TagId[] = []
      for (const [index, name] of normalizedNames.entries()) {
        const lower = nameKeys[index]
        if (!lower) throw new Error('NormalizedTagNameKeyMissing')
        let tag = byLower.get(lower)
        if (!tag) {
          tag = {
            id: newId(),
            name,
            nameLower: lower,
            createdAt: now,
            updatedAt: now,
          }
          byLower.set(lower, tag)
          byId.set(tag.id, tag)
          affectedTagIds.add(tag.id)
        }
        selectedTagIds.push(tag.id)
      }

      const changedChats: Chat[] = []
      const candidateTagIds = new Set<TagId>()
      const writes: Array<{ previous: TransactionCurrentChat; next: Chat }> = []
      const selectedTagIdSet = new Set(selectedTagIds)
      for (const row of targets) {
        if (sameOrderedIds(row.tags, selectedTagIds)) continue
        for (const tagId of row.tags) {
          if (!selectedTagIdSet.has(tagId)) candidateTagIds.add(tagId)
        }
        const next: Chat = {
          ...row,
          tags: [...selectedTagIds],
          metaVersion: row.metaVersion + 1,
        }
        writes.push({ previous: row, next })
        changedChats.push(next)
      }
      await applyChatRowWriteTransitions(
        tx,
        writes.map(({ previous, next }) => ({
          kind: 'replace-preserving-links',
          previous,
          next,
        })),
      )

      if (changedChats.length > 0) {
        for (const tagId of selectedTagIds) {
          const tag = byId.get(tagId)
          if (!tag) continue
          const touched = {
            ...tag,
            lastUsedAt: Math.max(tag.lastUsedAt ?? 0, now),
            updatedAt: Math.max(tag.updatedAt, now),
          }
          byLower.set(touched.nameLower, touched)
          byId.set(touched.id, touched)
          affectedTagIds.add(touched.id)
        }
      }

      const candidateIds = [...candidateTagIds].sort()
      const usedCandidateIds = new Set(
        candidateIds.length === 0
          ? []
          : ((await chats.where('tags').anyOf(candidateIds).uniqueKeys()) as TagId[]),
      )
      const deletableIds = candidateIds.filter((tagId) => !usedCandidateIds.has(tagId))
      const missingCandidateRows = deletableIds.filter((tagId) => !byId.has(tagId))
      const candidateRows =
        missingCandidateRows.length === 0 ? [] : await tags.bulkGet(missingCandidateRows)
      for (const tag of candidateRows) {
        if (!tag) continue
        byId.set(tag.id, tag)
        previousById.set(tag.id, tag)
      }
      const deletedTags = deletableIds
        .map((tagId) => byId.get(tagId))
        .filter((tag): tag is ChatTag => tag !== undefined)
      const deletedTagIds = deletedTags.map((tag) => tag.id)

      const deleted = new Set(deletedTagIds)
      const tagsToPut = [...affectedTagIds]
        .filter((tagId) => !deleted.has(tagId))
        .map((tagId) => byId.get(tagId))
        .filter((tag): tag is ChatTag => tag !== undefined)
      await putChatTagByteOwners(
        tx,
        tagsToPut,
        tagsToPut.flatMap((tag) => {
          const previous = previousById.get(tag.id)
          return previous ? [previous] : []
        }),
      )
      await deleteChatTagByteOwners(tx, deletedTags)
      const chatVersions: Record<ChatId, ChatVersions> = {}
      for (const chat of changedChats) chatVersions[chat.id] = chatVersionsFor(chat)
      return {
        value: selectedTagIds,
        affectedChatIds: changedChats.map((chat) => chat.id),
        chatVersions,
        affectedTagIds: [...affectedTagIds],
        deletedTagIds,
      }
    },
  )
}

export async function clearChatCalibration(
  command: Extract<WorkspaceCommand, { kind: 'chat.calibration.clear' }>,
  commit: BrowserSemanticCommandPort<'chat.calibration.clear'>,
): Promise<ChatMetadataWriteResult<boolean>> {
  return commit.executeSemanticOperation(
    CHAT_CALIBRATION_CLEAR_OPERATION,
    { chatIds: [command.chatId] },
    async (tx) => {
      const current = await readCurrentChatForTransaction(tx, command.chatId)
      if (!current) {
        return semanticOperationExecution(
          {
            value: false,
            affectedChatIds: [],
            chatVersions: {},
          },
          chatCalibrationReceipt(
            CHAT_CALIBRATION_CLEAR_EXACT_PLAN,
            { operation: 'get', rowCount: 1 },
            undefined,
            false,
          ),
        )
      }
      let changed: boolean
      let removed: Record<string, TokenCalibrationSample>
      let tokenCalibration: Record<string, TokenCalibrationSample>
      if (command.calibrationKey === undefined) {
        removed = current.tokenCalibration ?? {}
        tokenCalibration = {}
        changed = Object.keys(removed).length > 0
      } else {
        const retained = calibrationRecordWithoutFamily(
          current.tokenCalibration,
          command.calibrationKey,
        )
        changed = retained.changed
        tokenCalibration = retained.samples
        removed = Object.fromEntries(
          Object.entries(current.tokenCalibration ?? {}).filter(
            ([storedKey]) =>
              tokenCalibrationKeyForStoredRecordKey(storedKey) === command.calibrationKey,
          ),
        )
      }
      const nextChat = {
        ...current,
        tokenCalibration,
        tokenCalibrationGeneration: nextChatCalibrationGeneration(current),
      }
      const transition = await applyChatRowWriteTransitions(tx, [
        { kind: 'replace-preserving-links', previous: current, next: nextChat },
      ])
      const settings = tx.table<SettingsRow, string>('settings')
      const global = await settings.get(GLOBAL_TOKEN_CALIBRATION_KEY)
      await putTokenCalibrationSettingByteOwner(
        tx,
        {
          key: GLOBAL_TOKEN_CALIBRATION_KEY,
          value: subtractCalibrationSamplesFromGlobalRecord(global?.value, removed, command.now),
        },
        global,
      )
      return semanticOperationExecution(
        {
          value: changed,
          affectedChatIds: [nextChat.id],
          chatVersions: {
            [nextChat.id]: chatVersionsFor(nextChat),
          },
        },
        chatCalibrationReceipt(
          CHAT_CALIBRATION_CLEAR_EXACT_PLAN,
          { operation: 'get', rowCount: 1 },
          transition,
          true,
        ),
      )
    },
  )
}

export async function clearCalibrationEverywhere(
  command: Extract<
    WorkspaceCommand,
    { kind: 'chat.calibration.clear-family' | 'chat.calibration.clear-all' }
  >,
  commit: BrowserSemanticCommandPort<
    'chat.calibration.clear-family' | 'chat.calibration.clear-all'
  >,
): Promise<ChatCalibrationEverywhereResult> {
  const input = { chatIds: [] }
  if (command.kind === 'chat.calibration.clear-all') {
    return commit.executeSemanticOperation(CHAT_CALIBRATION_CLEAR_ALL_OPERATION, input, (tx) =>
      clearCalibrationEverywhereTransaction(tx, command),
    )
  }
  return commit.executeSemanticOperation(CHAT_CALIBRATION_CLEAR_FAMILY_OPERATION, input, (tx) =>
    clearCalibrationEverywhereTransaction(tx, command),
  )
}

async function clearCalibrationEverywhereTransaction(
  tx: ChatCalibrationTransaction,
  command: Extract<
    WorkspaceCommand,
    { kind: 'chat.calibration.clear-family' | 'chat.calibration.clear-all' }
  >,
) {
  const rows = await readAllCurrentChatsForTransaction(tx)
  let chatCount = 0
  const changedChats = rows.map((row) => {
    const cleared =
      command.kind === 'chat.calibration.clear-all'
        ? {
            changed: Object.keys(row.tokenCalibration ?? {}).length > 0,
            samples: {},
          }
        : calibrationRecordWithoutFamily(row.tokenCalibration, command.calibrationKey)
    if (cleared.changed) chatCount += 1
    return {
      ...row,
      tokenCalibration: cleared.samples,
      tokenCalibrationGeneration: nextChatCalibrationGeneration(row),
    }
  })
  const transition = await applyChatRowWriteTransitions(
    tx,
    changedChats.map((next, index) => ({
      kind: 'replace-preserving-links' as const,
      previous: rows[index] as TransactionCurrentChat,
      next,
    })),
  )
  const settings = tx.table<SettingsRow, string>('settings')
  const stored = await settings.get(GLOBAL_TOKEN_CALIBRATION_KEY)
  const clearedGlobal =
    command.kind === 'chat.calibration.clear-all'
      ? clearAllCalibrationFromGlobalRecord(stored?.value, command.now)
      : clearCalibrationFamilyFromGlobalRecord(stored?.value, command.calibrationKey, command.now)
  await putTokenCalibrationSettingByteOwner(
    tx,
    { key: GLOBAL_TOKEN_CALIBRATION_KEY, value: clearedGlobal.value },
    stored,
  )
  const chatVersions: Record<ChatId, ChatVersions> = {}
  for (const chat of changedChats) {
    chatVersions[chat.id] = chatVersionsFor(chat)
  }
  return semanticOperationExecution(
    {
      value: { globalChanged: clearedGlobal.changed, chatCount },
      affectedChatIds: changedChats.map((chat) => chat.id),
      chatVersions,
    } satisfies ChatCalibrationEverywhereResult,
    chatCalibrationReceipt(
      CHAT_CALIBRATION_FANOUT_EXACT_PLAN,
      { operation: 'query', rowCount: rows.length },
      transition,
      true,
    ),
  )
}

function chatVersionsFor(chat: Chat): ChatVersions {
  return {
    metaVersion: chat.metaVersion,
    summaryVersion: chat.summaryVersion,
    structuralVersion: chat.structuralVersion,
  }
}

export async function deleteArchivedChatRows(
  chatIds: readonly ChatId[],
  now: number,
  commit: BrowserSemanticCommandPort<'chat.delete-archived'>,
): Promise<DeleteArchivedChatMetadataResult> {
  const uniqueChatIds = [...new Set(chatIds)].sort()
  if (uniqueChatIds.length > CHAT_CLOSURE_BATCH_LIMIT) {
    throw new Error('ChatClosureBatchLimitExceeded')
  }
  const result = await commit.executeSemanticOperation(
    CHAT_DELETE_ARCHIVED_OPERATION,
    { chatIds: uniqueChatIds },
    (tx) => deleteArchivedChatClosure(tx, uniqueChatIds, now),
  )
  return {
    deletedChatIds: result.deletedChatIds,
    affectedAttachmentIds: result.affectedAttachmentIds,
  }
}

export async function emptyArchivedChatRows(
  input: { afterChatId?: ChatId; limit: number; now: number },
  commit: BrowserSemanticCommandPort<'chat.empty-archive'>,
) {
  const limit = Math.min(boundedMaintenanceLimit(input.limit), CHAT_CLOSURE_BATCH_LIMIT)
  return commit.executeSemanticOperation(
    CHAT_EMPTY_ARCHIVE_OPERATION,
    input.afterChatId === undefined ? {} : { afterChatId: input.afterChatId },
    async (tx) => {
      const page = await readArchivedChatIdPage(tx, {
        ...(input.afterChatId === undefined ? {} : { afterChatId: input.afterChatId }),
        limit,
      })
      const result = await deleteArchivedChatClosure(tx, page.chatIds, input.now)
      return {
        deletedChatIds: result.deletedChatIds,
        affectedAttachmentIds: result.affectedAttachmentIds,
        scannedChatIds: page.chatIds.length,
        ...(page.nextAfterChatId === undefined ? {} : { nextAfterChatId: page.nextAfterChatId }),
        done: page.done,
      }
    },
  )
}

function folderRowExactReceipt(
  tx: FencedTransaction<'folders'>,
  plan: SemanticOperationExactPlan,
): SemanticOperationExactReceipt<'folders'> {
  const accumulator = boundSemanticOperationExactReceiptAccumulator<'folders'>(tx)
  if (!accumulator) throw new Error('FolderRowExactReceiptAccumulatorMissing')
  const fragment = accumulator.snapshotFragment()
  return semanticOperationExactReceipt(plan, {
    dependencies: fragment.dependencies,
    physicalMutations: fragment.physicalMutations,
    physicalReads: [
      ...fragment.physicalReads,
      {
        tableName: 'folders',
        indexKind: 'primary',
        operation: 'get',
        requestCount: 1,
        rowCount: 1,
      },
    ],
  })
}

export async function createFolder(
  input: CreateFolderInput,
  commit: BrowserSemanticCommandPort<'folder.create'>,
): Promise<ChatFolder> {
  const now = input.now ?? Date.now()
  const folder: ChatFolder = {
    id: input.id ?? newId(),
    name: normalizeName(input.name, 'Folder'),
    sortIndex: input.sortIndex ?? now,
    createdAt: now,
    updatedAt: now,
  }
  if (input.color) folder.color = input.color

  return commit.executeSemanticOperation(
    FOLDER_CREATE_OPERATION,
    { folderId: folder.id },
    async (tx) => {
      const table = tx.table<ChatFolder, FolderId>('folders')
      await putChatFolderByteOwner(tx, folder, await table.get(folder.id))
      return semanticOperationExecution(folder, folderRowExactReceipt(tx, FOLDER_CREATE_EXACT_PLAN))
    },
  )
}

export async function updateFolder(
  folderId: FolderId,
  patch: UpdateFolderInput,
  commit: BrowserSemanticCommandPort<'folder.update'>,
): Promise<ChatFolder | undefined> {
  const now = patch.now ?? Date.now()
  return commit.executeSemanticOperation(FOLDER_UPDATE_OPERATION, { folderId }, async (tx) => {
    const table = tx.table<ChatFolder, FolderId>('folders')
    const current = await table.get(folderId)
    if (!current) {
      return semanticOperationExecution(
        undefined,
        folderRowExactReceipt(tx, FOLDER_UPDATE_EXACT_PLAN),
      )
    }
    const next = { ...current }
    if (patch.name !== undefined) next.name = normalizeName(patch.name, 'Folder')
    if (patch.color !== undefined) patchOptionalString(next, 'color', patch.color)
    if (patch.sortIndex !== undefined) next.sortIndex = patch.sortIndex
    if (patch.lastUsedAt !== undefined) {
      patchOptionalNumber(next, 'lastUsedAt', patch.lastUsedAt)
    }
    if (stableStringify(current) === stableStringify(next)) {
      return semanticOperationExecution(
        current,
        folderRowExactReceipt(tx, FOLDER_UPDATE_EXACT_PLAN),
      )
    }
    next.updatedAt = now
    await putChatFolderByteOwner(tx, next, current)
    return semanticOperationExecution(next, folderRowExactReceipt(tx, FOLDER_UPDATE_EXACT_PLAN))
  })
}

export async function ensureFolderAndMoveChats(
  input: EnsureFolderAndMoveChatsInput,
  commit: BrowserSemanticCommandPort<'folder.ensure-and-move-chats'>,
): Promise<EnsureFolderAndMoveChatsResult> {
  const now = input.now ?? Date.now()
  const name = normalizeName(input.name, 'Folder')
  const nameKey = organizationNameKey(name)
  const uniqueChatIds = [...new Set(input.chatIds)].sort()
  const createdFolderId = input.id ?? newId()
  return commit.executeSemanticOperation(
    FOLDER_ENSURE_AND_MOVE_CHATS_OPERATION,
    { folderId: createdFolderId, nameKey, chatIds: uniqueChatIds },
    async (tx) => {
      const folders = tx.table<ChatFolder, FolderId>('folders')
      let matched: ChatFolder | undefined
      await folders.each((candidate) => {
        if (organizationNameKey(candidate.name) !== nameKey) return
        if (!matched || compareChatFolders(candidate, matched) < 0) matched = candidate
      })
      if (!matched && (await folders.get(createdFolderId))) {
        throw new Error(`FolderIdAlreadyExists:${createdFolderId}`)
      }
      let folder: ChatFolder = matched ?? {
        id: createdFolderId,
        name,
        sortIndex: input.sortIndex ?? now,
        createdAt: now,
        updatedAt: now,
        ...(input.color ? { color: input.color } : {}),
      }
      const created = matched === undefined
      const rows = await readOptionalCurrentChatRowsForTransaction(tx, uniqueChatIds)
      const changes: EnsureFolderAndMoveChatsResult['changes'] = []
      const updatedAtClock = new TransactionChatUpdateClock()
      const writes: Array<{ previous: TransactionCurrentChat; next: Chat }> = []
      for (const row of rows) {
        if (!row || (row.folderId ?? null) === folder.id) continue
        const next: Chat = {
          ...row,
          folderId: folder.id,
          updatedAt: await updatedAtClock.next(tx, now),
          metaVersion: row.metaVersion + 1,
          summaryVersion: row.summaryVersion + 1,
        }
        writes.push({ previous: row, next })
        changes.push({
          chatId: row.id,
          previousFolderId: row.folderId ?? null,
          nextFolderId: folder.id,
          previousArchived: row.archived,
          nextArchived: row.archived,
        })
      }
      await applyChatRowWriteTransitions(
        tx,
        writes.map(({ previous, next }) => ({
          kind: 'replace-preserving-links',
          previous,
          next,
        })),
      )
      const touchedFolder: ChatFolder = {
        ...folder,
        lastUsedAt: Math.max(folder.lastUsedAt ?? 0, now),
        updatedAt: Math.max(folder.updatedAt, now),
      }
      if (created || stableStringify(folder) !== stableStringify(touchedFolder)) {
        await putChatFolderByteOwner(tx, touchedFolder, matched)
        folder = touchedFolder
      }
      return {
        folder,
        created,
        affectedChatIds: changes.map((change) => change.chatId),
        changes,
      }
    },
  )
}

export async function deleteFolder(
  folderId: FolderId,
  chatDisposition: 'move-top-level' | 'archive',
  now: number,
  commit: BrowserSemanticCommandPort<'folder.delete'>,
): Promise<DeleteFolderResult> {
  const descriptor =
    chatDisposition === 'archive'
      ? FOLDER_DELETE_ARCHIVE_OPERATION
      : FOLDER_DELETE_MOVE_TOP_LEVEL_OPERATION
  return commit.executeSemanticOperation(descriptor, { folderId }, async (tx) => {
    const folders = tx.table<ChatFolder, FolderId>('folders')
    const folder = await folders.get(folderId)
    if (!folder) return { deleted: false, affectedChatIds: [], changes: [] }
    const rows = [...(await readCurrentChatsInFolderForTransaction(tx, folderId))]
    rows.sort((left, right) => left.id.localeCompare(right.id))
    await deleteChatFolderByteOwner(tx, folder)
    const changedChats: Chat[] = []
    const changes: DeleteFolderResult['changes'] = []
    const updatedAtClock = new TransactionChatUpdateClock()
    const writes: Array<{ previous: TransactionCurrentChat; next: Chat }> = []
    for (const row of rows) {
      const archived = chatDisposition === 'archive' ? true : row.archived
      const next: Chat = {
        ...row,
        folderId: null,
        archived,
        updatedAt: await updatedAtClock.next(tx, now),
        metaVersion: row.metaVersion + 1,
        summaryVersion: row.summaryVersion + 1,
      }
      writes.push({ previous: row, next })
      changedChats.push(next)
      changes.push({
        chatId: row.id,
        previousFolderId: row.folderId,
        nextFolderId: null,
        previousArchived: row.archived,
        nextArchived: archived,
      })
    }
    await applyChatRowWriteTransitions(
      tx,
      writes.map(({ previous, next }) => ({
        kind:
          chatDisposition === 'archive'
            ? ('replace-linked' as const)
            : ('replace-preserving-links' as const),
        previous,
        next,
      })),
    )
    return {
      deleted: true,
      affectedChatIds: changedChats.map((chat) => chat.id),
      changes,
    }
  })
}
