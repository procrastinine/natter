import type { Transaction } from 'dexie'
import type { WorkspaceDependency } from './workspace-protocol'

export const PHYSICAL_STORAGE_TABLE_NAMES = [
  'attachmentArtifacts',
  'attachmentBlobs',
  'attachmentCatalogAggregate',
  'attachmentCatalogRows',
  'attachmentIntegrityState',
  'attachmentJobs',
  'attachmentRefEdges',
  'attachments',
  'browserLocks',
  'chatSidebarAggregates',
  'chatSidebarRows',
  'chats',
  'childLists',
  'childSlotMembers',
  'configurationLinks',
  'configurationCatalogAggregates',
  'configurationPresetCatalogRows',
  'configurationProfileCatalogRows',
  'configurationProfileUsageRows',
  'configurationPromptPresetCatalogRows',
  'discoveryCacheState',
  'discoveryPayloadMetadata',
  'discoveryPayloads',
  'drafts',
  'endpoints',
  'folders',
  'keys',
  'messageBodies',
  'messagePreviews',
  'messages',
  'models',
  'presets',
  'presetOrderBlocks',
  'presetOrderMembership',
  'presetOrderState',
  'privacyPolicies',
  'profiles',
  'promptPresets',
  'settings',
  'storageRetentionState',
  'streamChunks',
  'streamLeases',
  'tags',
  'textTemplates',
  'workspaceFence',
] as const

export type PhysicalStorageTableName = (typeof PHYSICAL_STORAGE_TABLE_NAMES)[number]

export function encodePhysicalStorageKey(value: unknown): string {
  if (typeof value === 'string') return `s:${value.length}:${value}`
  if (typeof value === 'number') return `n:${Object.is(value, -0) ? '-0' : String(value)}`
  if (value instanceof Date) return `d:${value.getTime()}`
  if (Array.isArray(value)) return `a:[${value.map(encodePhysicalStorageKey).join(',')}]`
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    let encoded = 'b:'
    for (const byte of bytes) encoded += byte.toString(16).padStart(2, '0')
    return encoded
  }
  throw new Error('PhysicalStorageKeyInvalid')
}

export function physicalStorageMutationAddress(
  tableName: PhysicalStorageTableName,
  key: unknown,
): string {
  return `${tableName}\u0000${encodePhysicalStorageKey(key)}`
}

export type PhysicalStorageSchemaClass = 'canonical' | 'repairable'
export type PhysicalStorageDataClass =
  | 'authoritative'
  | 'journal'
  | 'derived'
  | 'cache'
  | 'ephemeral'
export type PhysicalStorageCompactionAction =
  | 'copy'
  | 'filtered-copy'
  | 'drop'
  | 'seed'
  | 'preserve-destination'
export type PhysicalStorageInterchangeAction = 'portable' | 'rebuild' | 'omit' | 'seed'

export interface PhysicalStoragePolicy {
  readonly schema: PhysicalStorageSchemaClass
  readonly data: PhysicalStorageDataClass
  readonly compaction: PhysicalStorageCompactionAction
  readonly interchange: PhysicalStorageInterchangeAction
  readonly effectKinds: readonly WorkspaceDependency['kind'][]
  readonly groupEffectKinds: readonly WorkspaceDependency['kind'][]
}

export const PHYSICAL_STORAGE_POLICY = Object.freeze({
  attachmentArtifacts: policy('canonical', 'authoritative', 'filtered-copy', 'portable', [
    'attachment',
  ]),
  attachmentBlobs: policy('canonical', 'authoritative', 'filtered-copy', 'portable', [
    'attachment',
  ]),
  attachmentCatalogAggregate: policy(
    'repairable',
    'derived',
    'copy',
    'rebuild',
    ['attachment'],
    ['attachment'],
  ),
  attachmentCatalogRows: policy('repairable', 'derived', 'copy', 'rebuild', ['attachment']),
  attachmentIntegrityState: policy('repairable', 'derived', 'seed', 'seed', [
    'attachment',
    'storage-maintenance',
  ]),
  attachmentJobs: policy('canonical', 'journal', 'filtered-copy', 'portable', [
    'attachment-job',
    'attachment',
  ]),
  attachmentRefEdges: policy('repairable', 'derived', 'copy', 'rebuild', ['attachment']),
  attachments: policy('canonical', 'authoritative', 'copy', 'portable', ['attachment']),
  browserLocks: policy('repairable', 'ephemeral', 'seed', 'omit', ['workspace']),
  chatSidebarAggregates: policy(
    'repairable',
    'derived',
    'copy',
    'rebuild',
    ['sidebar'],
    ['sidebar'],
  ),
  chatSidebarRows: policy('repairable', 'derived', 'copy', 'rebuild', ['sidebar']),
  chats: policy('canonical', 'authoritative', 'copy', 'portable', ['chat', 'sidebar']),
  childLists: policy('repairable', 'derived', 'copy', 'rebuild', ['child-slot']),
  childSlotMembers: policy('repairable', 'derived', 'copy', 'rebuild', ['child-slot']),
  configurationLinks: policy('repairable', 'derived', 'copy', 'rebuild', [
    'chat',
    'profile',
    'preset',
    'prompt-preset',
    'text-template',
    'key',
  ]),
  configurationCatalogAggregates: policy(
    'repairable',
    'derived',
    'copy',
    'rebuild',
    ['profile', 'preset', 'prompt-preset'],
    ['profile', 'preset', 'prompt-preset'],
  ),
  configurationPresetCatalogRows: policy('repairable', 'derived', 'copy', 'rebuild', ['preset']),
  configurationProfileCatalogRows: policy('repairable', 'derived', 'copy', 'rebuild', ['profile']),
  configurationProfileUsageRows: policy('repairable', 'derived', 'copy', 'rebuild', ['profile']),
  configurationPromptPresetCatalogRows: policy('repairable', 'derived', 'copy', 'rebuild', [
    'prompt-preset',
  ]),
  discoveryCacheState: policy(
    'repairable',
    'cache',
    'seed',
    'seed',
    ['discovery-cache'],
    ['discovery-cache'],
  ),
  discoveryPayloadMetadata: policy(
    'repairable',
    'cache',
    'drop',
    'omit',
    ['discovery-cache'],
    ['discovery-cache'],
  ),
  discoveryPayloads: policy(
    'repairable',
    'cache',
    'drop',
    'omit',
    ['discovery-cache'],
    ['discovery-cache'],
  ),
  drafts: policy('canonical', 'authoritative', 'copy', 'portable', ['draft']),
  endpoints: policy('repairable', 'cache', 'drop', 'omit', ['discovery-cache']),
  folders: policy('canonical', 'authoritative', 'copy', 'portable', ['folder']),
  keys: policy('canonical', 'authoritative', 'copy', 'portable', ['key']),
  messageBodies: policy('canonical', 'authoritative', 'copy', 'portable', ['message-body']),
  messagePreviews: policy('repairable', 'derived', 'copy', 'rebuild', ['message-preview']),
  messages: policy('canonical', 'authoritative', 'copy', 'portable', ['message-header']),
  models: policy('repairable', 'cache', 'drop', 'omit', ['discovery-cache']),
  presets: policy('canonical', 'authoritative', 'copy', 'portable', ['preset']),
  presetOrderBlocks: policy(
    'canonical',
    'authoritative',
    'copy',
    'portable',
    ['preset'],
    ['preset'],
  ),
  presetOrderMembership: policy('repairable', 'derived', 'copy', 'rebuild', ['preset'], ['preset']),
  presetOrderState: policy(
    'canonical',
    'authoritative',
    'copy',
    'portable',
    ['preset'],
    ['preset'],
  ),
  privacyPolicies: policy('repairable', 'cache', 'drop', 'omit', ['discovery-cache']),
  profiles: policy('canonical', 'authoritative', 'copy', 'portable', ['profile']),
  promptPresets: policy('canonical', 'authoritative', 'copy', 'portable', ['prompt-preset']),
  settings: policy('canonical', 'authoritative', 'filtered-copy', 'portable', ['setting']),
  storageRetentionState: policy('canonical', 'journal', 'copy', 'seed', []),
  streamChunks: policy('canonical', 'journal', 'copy', 'omit', ['stream-chunks']),
  streamLeases: policy('canonical', 'journal', 'copy', 'omit', ['stream-lease', 'stream-chunks']),
  tags: policy('canonical', 'authoritative', 'copy', 'portable', ['tag']),
  textTemplates: policy('canonical', 'authoritative', 'copy', 'portable', ['text-template']),
  workspaceFence: policy('canonical', 'authoritative', 'preserve-destination', 'seed', [
    'workspace',
  ]),
} satisfies Record<PhysicalStorageTableName, PhysicalStoragePolicy>)

export const CANONICAL_PHYSICAL_STORAGE_TABLE_NAMES = physicalStorageTableNamesWith(
  (entry) => entry.schema === 'canonical',
)

export const REPAIRABLE_PHYSICAL_STORAGE_TABLE_NAMES = physicalStorageTableNamesWith(
  (entry) => entry.schema === 'repairable',
)

export type SettingsCompactionDisposition = 'copy' | 'rebuild' | 'drop' | 'unknown'

export function settingsCompactionDisposition(key: string): SettingsCompactionDisposition {
  if (key === 'backfill:chat-sidebar-aggregate-v1') return 'rebuild'
  if (
    key.startsWith('global:') ||
    key.startsWith('sidebar:') ||
    key.startsWith('backfill:') ||
    key === 'install-secret' ||
    key === 'rendering-preferences' ||
    key === 'sample-prompts:dismissed' ||
    key === 'stream-admission-sequence'
  ) {
    return 'copy'
  }
  return 'unknown'
}

function policy(
  schema: PhysicalStorageSchemaClass,
  data: PhysicalStorageDataClass,
  compaction: PhysicalStorageCompactionAction,
  interchange: PhysicalStorageInterchangeAction,
  effectKinds: readonly WorkspaceDependency['kind'][],
  groupEffectKinds: readonly WorkspaceDependency['kind'][] = [],
): PhysicalStoragePolicy {
  return Object.freeze({
    schema,
    data,
    compaction,
    interchange,
    effectKinds: Object.freeze([...effectKinds]),
    groupEffectKinds: Object.freeze([...groupEffectKinds]),
  })
}

function physicalStorageTableNamesWith(
  predicate: (entry: PhysicalStoragePolicy) => boolean,
): readonly PhysicalStorageTableName[] {
  return Object.freeze(
    PHYSICAL_STORAGE_TABLE_NAMES.filter((name) => predicate(PHYSICAL_STORAGE_POLICY[name])),
  )
}

const PHYSICAL_TRANSACTION_CAPABILITY = Symbol('PhysicalTransactionCapability')
const PHYSICAL_TRANSACTION_PLAN = Symbol('PhysicalTransactionPlan')
declare const FENCED_TRANSACTION_TABLES: unique symbol
const physicalTransactionPlanTableNames = new WeakMap<
  object,
  ReadonlySet<PhysicalStorageTableName>
>()

export interface PhysicalTransactionCapability<
  Tables extends PhysicalStorageTableName = PhysicalStorageTableName,
> {
  readonly tableNames: readonly Tables[]
  readonly [PHYSICAL_TRANSACTION_CAPABILITY]: true
}

export interface PhysicalTransactionPlan<
  Tables extends PhysicalStorageTableName = PhysicalStorageTableName,
> {
  readonly tableNames: readonly Tables[]
  readonly [PHYSICAL_TRANSACTION_PLAN]: true
}

export type FencedTransaction<Tables extends PhysicalStorageTableName = PhysicalStorageTableName> =
  Transaction & {
    readonly [FENCED_TRANSACTION_TABLES]: Readonly<Record<Tables, true>>
  }

export type CapabilityTables<Capability> =
  Capability extends PhysicalTransactionCapability<infer Tables> ? Tables : never

export function physicalStorageTables<const Tables extends readonly PhysicalStorageTableName[]>(
  ...tableNames: Tables
): PhysicalTransactionCapability<Tables[number]> {
  return Object.freeze({
    tableNames: Object.freeze([...new Set(tableNames)]),
    [PHYSICAL_TRANSACTION_CAPABILITY]: true,
  }) as PhysicalTransactionCapability<Tables[number]>
}

export function physicalTransactionPlan<
  const Capabilities extends readonly PhysicalTransactionCapability[],
>(...capabilities: Capabilities): PhysicalTransactionPlan<CapabilityTables<Capabilities[number]>> {
  const tableNames: PhysicalStorageTableName[] = []
  const included = new Set<PhysicalStorageTableName>()
  for (const capability of capabilities) {
    for (const tableName of capability.tableNames) {
      if (included.has(tableName)) continue
      included.add(tableName)
      tableNames.push(tableName)
    }
  }
  const plan = Object.freeze({
    tableNames: Object.freeze(tableNames),
    [PHYSICAL_TRANSACTION_PLAN]: true,
  }) as PhysicalTransactionPlan<CapabilityTables<Capabilities[number]>>
  physicalTransactionPlanTableNames.set(plan, included)
  return plan
}

export function bindFencedTransaction<Tables extends PhysicalStorageTableName>(
  transaction: Transaction,
  plan: PhysicalTransactionPlan<Tables>,
): FencedTransaction<Tables> {
  const declared = physicalTransactionPlanTableNames.get(plan)
  if (!declared) throw new Error('PhysicalTransactionPlanInvalid')
  const table = transaction.table.bind(transaction)
  return new Proxy(transaction, {
    get(target, property): unknown {
      if (property === 'db') throw new Error('PhysicalTransactionDatabaseAccessForbidden')
      if (property === 'table') {
        return (name: string) => {
          if (!declared.has(name as PhysicalStorageTableName)) {
            throw new Error(`PhysicalTransactionStoreUndeclared:${name}`)
          }
          return table(name)
        }
      }
      return Reflect.get(target, property, target) as unknown
    },
  }) as FencedTransaction<Tables>
}

export function assertPhysicalTransactionTablesDeclared<Tables extends PhysicalStorageTableName>(
  plan: PhysicalTransactionPlan<Tables>,
  tableNames: Iterable<string>,
): void {
  const declared = physicalTransactionPlanTableNames.get(plan)
  if (!declared) throw new Error('PhysicalTransactionPlanInvalid')
  for (const tableName of tableNames) {
    if (!declared.has(tableName as PhysicalStorageTableName)) {
      throw new Error(`PhysicalTransactionMutationUndeclared:${tableName}`)
    }
  }
}

export const PHYSICAL_STORAGE_BOUNDARY_FILES = {
  'store/browser-import-export.ts': 'atomic import, restore, and workspace-replacement boundary',
  'store/browser-workspace-derived-repair.ts':
    'version-gated current-schema derived reconstruction boundary',
  'store/browser-workspace-compaction.ts': 'physical copy boundary',
  'store/db.ts': 'versioned schema migration and run-once backfill boundary',
} as const
