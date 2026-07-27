import type { Transaction } from 'dexie'
import type {
  Chat,
  ChatPreset,
  ChatSettings,
  ConnectionProfile,
  PresetId,
  ProfileId,
  PromptPreset,
  PromptPresetKind,
} from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { runBrowserCommandTransaction } from '../../src/store/browser-command-mutation-journal'
import { addSemanticByteOwner } from '../../src/store/byte-owner-mutation'
import { configurationApplication } from '../../src/store/configuration-application'
import {
  applyConfigurationPromptPresetCatalogProjectionTransition,
  CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY,
} from '../../src/store/configuration-catalog-projection'
import { executeConfigurationCommand } from '../../src/store/configuration-command-client'
import {
  buildConnectionProfile,
  type ConfigurationProfileDraftInput,
  chatConfigurationTargetResourceNames,
} from '../../src/store/configuration-domain-contract'
import { getDb } from '../../src/store/db'
import {
  assertPhysicalTransactionTablesDeclared,
  bindFencedTransaction,
  physicalStorageTables,
  physicalTransactionPlan,
} from '../../src/store/physical-storage-tables'
import { readPresetOrderIds } from '../../src/store/preset-order'
import { registerPhysicalMutationTransaction } from '../../src/store/storage-compaction-state'
import type { WorkspaceWriteAuthority } from '../../src/store/workspace-protocol'

const TEST_PROMPT_PRESET_WRITE_PLAN = physicalTransactionPlan(
  physicalStorageTables('promptPresets'),
  CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY,
)

export function testChatConfigurationLinkTransition(
  chat: Chat,
  settings: ChatSettings = chat.settings,
): {
  readonly expectedResourceNames: readonly string[]
  readonly nextResourceNames: readonly string[]
} {
  return {
    expectedResourceNames: chatConfigurationTargetResourceNames(chat),
    nextResourceNames: chatConfigurationTargetResourceNames({
      id: chat.id,
      settings,
      ...(chat.presetId ? { presetId: chat.presetId } : {}),
    }),
  }
}

export async function createConfigurationProfile(
  input: ConfigurationProfileDraftInput,
  authority?: WorkspaceWriteAuthority,
): Promise<ConnectionProfile> {
  const now = input.now ?? Date.now()
  const profile = buildConnectionProfile({ ...input, now })
  const result = await executeConfigurationCommand(
    { kind: 'connection.create', profile, now },
    authority,
  )
  if (result.kind !== 'connection-saved') throw new Error(`ProfileCreateFailed:${profile.id}`)
  return result.profile
}

export function getConfigurationProfile(
  profileId: ProfileId,
): Promise<ConnectionProfile | undefined> {
  return getDb().profiles.get(profileId)
}

export async function listConfigurationProfiles(
  includeArchived = false,
): Promise<ConnectionProfile[]> {
  const profiles = await getDb().profiles.toArray()
  return includeArchived ? profiles : profiles.filter((profile) => profile.archived !== true)
}

export async function createConfigurationChatPreset(input: {
  id?: PresetId
  name: string
  connectionProfileId: ProfileId
  settings: ChatSettings
  sortIndex?: number
  lastUsedAt?: number
  now?: number
}): Promise<ChatPreset> {
  const id = input.id ?? newId()
  const now = input.now ?? Date.now()
  const result = await configurationApplication.createChatPreset({
    presetId: id,
    name: input.name,
    profileId: input.connectionProfileId,
    settings: input.settings,
    ...(input.lastUsedAt === undefined ? {} : { lastUsedAt: input.lastUsedAt }),
    now,
  })
  if (result.kind !== 'chat-preset-saved') throw new Error(`ChatPresetCreateFailed:${id}`)
  if (input.sortIndex !== undefined) {
    const ordered = await listConfigurationChatPresets()
    const currentIndex = ordered.findIndex((preset) => preset.id === id)
    if (currentIndex < 0) throw new Error(`ChatPresetOrderEntryMissing:${id}`)
    const targetIndex = Math.max(0, Math.min(Math.trunc(input.sortIndex), ordered.length - 1))
    if (targetIndex !== currentIndex) {
      const withoutCurrent = ordered.filter((preset) => preset.id !== id)
      const afterPresetId = targetIndex === 0 ? null : withoutCurrent[targetIndex - 1]?.id
      const moved = await configurationApplication.moveChatPreset(id, afterPresetId ?? null, now)
      if (moved.kind !== 'chat-preset-saved' && moved.kind !== 'configuration-noop') {
        throw new Error(`ChatPresetMoveFailed:${id}`)
      }
    }
  }
  return result.preset
}

export async function updateConfigurationChatPreset(
  presetId: PresetId,
  patch: Partial<Omit<ChatPreset, 'id' | 'createdAt' | 'updatedAt'>>,
  now = Date.now(),
): Promise<ChatPreset> {
  const result = await configurationApplication.execute({
    kind: 'chat-preset.update',
    presetId,
    patch,
    now,
  })
  if (result.kind !== 'chat-preset-saved') {
    throw new Error(`ChatPresetUpdateFailed:${presetId}`)
  }
  return result.preset
}

export async function listConfigurationChatPresets(includeArchived = false): Promise<ChatPreset[]> {
  const db = getDb()
  const activeIds = await db.transaction('r', [db.presetOrderState, db.presetOrderBlocks], (tx) =>
    readPresetOrderIds(tx),
  )
  const activeRows = await db.presets.bulkGet([...activeIds])
  const active = activeRows.map((preset, index) => {
    const presetId = activeIds[index]
    if (!preset || preset.id !== presetId) throw new Error(`ChatPresetOrderRowMissing:${presetId}`)
    if (preset.archived === true) throw new Error(`ChatPresetOrderRowArchived:${preset.id}`)
    return preset
  })
  if (!includeArchived) return active
  const archived = (await db.presets.toArray())
    .filter((preset) => preset.archived === true)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  return [...active, ...archived]
}

export async function createConfigurationPromptPreset(input: {
  id?: string
  kind: PromptPresetKind
  name: string
  text: string
  lastUsedAt?: number
  now?: number
}): Promise<PromptPreset> {
  const now = input.now ?? Date.now()
  const preset: PromptPreset = {
    id: input.id ?? newId(),
    kind: input.kind,
    name: input.name,
    text: input.text,
    createdAt: now,
    updatedAt: now,
    ...(input.lastUsedAt === undefined ? {} : { lastUsedAt: input.lastUsedAt }),
  }
  await runTestPromptPresetWrite(async (tx) => {
    await addSemanticByteOwner(tx, 'promptPresets', preset)
    await applyConfigurationPromptPresetCatalogProjectionTransition(tx, undefined, preset)
  })
  return preset
}

async function runTestPromptPresetWrite(operation: (tx: Transaction) => Promise<void>) {
  const db = getDb()
  await db.transaction(
    'rw',
    TEST_PROMPT_PRESET_WRITE_PLAN.tableNames.map((tableName) => db.table(tableName)),
    async (raw) => {
      registerPhysicalMutationTransaction(raw)
      const committed = await runBrowserCommandTransaction(raw, (tx) =>
        operation(bindFencedTransaction(tx, TEST_PROMPT_PRESET_WRITE_PLAN)),
      )
      assertPhysicalTransactionTablesDeclared(
        TEST_PROMPT_PRESET_WRITE_PLAN,
        committed.facts.tableNames,
      )
    },
  )
}
