import type Dexie from 'dexie'
import type { Transaction } from 'dexie'
import {
  applyChatSettingsFieldPatches,
  applyLocalPromptValue,
  applySerializedChatSettingsPatch,
  normalizeChatSettings,
  promptPresetSlotForKind,
  sameChatSettings,
} from '../core/chat-metadata'
import {
  advanceRecentModelState,
  emptyRecentModelRecency,
  PINNED_MODELS_KEY,
  RECENT_MODEL_RECENCY_KEY,
  RECENT_MODELS_KEY,
  SAMPLE_PROMPTS_DISMISSED_KEY,
} from '../core/global-settings'
import { customImageOriginsFromStored, IMAGE_ALLOWLIST_KEY } from '../core/image-allowlist'
import { withProfileApiDefaults } from '../core/provider-defaults'
import {
  normalizeRenderingPreferences,
  RENDERING_PREFERENCES_KEY,
} from '../core/rendering-preferences'
import { normalizeTextTemplateConfig, type SavedTextTemplate } from '../core/text-templates'
import type {
  Chat,
  ChatId,
  ChatPreset,
  ChatSettings,
  ConfigurationRequestRevision,
  ConnectionProfile,
  KeyId,
  KeyRecord,
  PresetId,
  ProfileId,
  PromptPreset,
  PromptPresetId,
  TextTemplateId,
} from '../core/types'
import { recordBrowserCommandInvalidation } from './browser-command-mutation-journal'
import type { BrowserCommandSessionPort } from './browser-domain-mutations'
import {
  addLinkedSemanticByteOwner,
  addSemanticByteOwner,
  addTextTemplateByteOwner,
  deleteLinkedSemanticByteOwner,
  deletePhysicalStorageCollection,
  deleteSemanticByteOwner,
  deleteTextTemplateByteOwner,
  deleteUserSettingByteOwner,
  putSemanticByteOwner,
  putUserSettingByteOwner,
  putUserSettingByteOwners,
  replaceLinkedSemanticByteOwner,
  replaceLinkedSemanticByteOwnerBatch,
  replaceSemanticByteOwner,
  replaceTextTemplateByteOwner,
} from './byte-owner-mutation'
import {
  applyChatRowWriteTransitions,
  CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
} from './chat-row-transition'
import {
  CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY,
  CONFIGURATION_PRESET_RECENCY_TRANSACTION_CAPABILITY,
  CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY,
  CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY,
  CONFIGURATION_PROMPT_PRESET_RECENCY_TRANSACTION_CAPABILITY,
  deleteConfigurationPresetCatalogProjection,
  deleteConfigurationProfileCatalogProjection,
  deleteConfigurationPromptPresetCatalogProjection,
  putConfigurationPresetCatalogProjection,
  putConfigurationPresetRecencyCatalogProjection,
  putConfigurationProfileCatalogProjection,
  putConfigurationPromptPresetCatalogProjection,
  putConfigurationPromptPresetRecencyCatalogProjection,
  readDefaultConfigurationProfileId,
} from './configuration-catalog-projection'
import {
  applyConnectionProfilePatch,
  type ConfigurationDomainCommand,
  type ConfigurationDomainHandlerMap,
  type ConfigurationDomainResult,
  type ConfigurationLink,
  type ConfigurationLinkOwnerKind,
  configurationLinksForChat,
  configurationLinksForPreset,
  configurationLinksForProfile,
  configurationOwnerKey,
  configurationRequestRevisionFor,
  configurationTargetKey,
  configurationTargetResourceNamesForLinks,
  sameConfigurationValue,
} from './configuration-domain-contract'
import {
  CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
  CONFIGURATION_LINK_ROWS_TRANSACTION_CAPABILITY,
  type ConfigurationProfileUsageProjectionRow,
  configurationProfileUsageResourceNamesForLinks,
  emptyConfigurationProfileUsageProjectionRow,
} from './configuration-profile-usage-projection'
import {
  clearDiscoveryCacheProfileRows,
  DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY,
} from './discovery-cache-storage'
import {
  type FencedTransaction,
  type PhysicalStorageTableName,
  type PhysicalTransactionCapability,
  type PhysicalTransactionPlan,
  physicalStorageTables,
  physicalTransactionPlan,
} from './physical-storage-tables'
import {
  appendPresetOrderEntry,
  movePresetOrderEntry,
  PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY,
  removePresetOrderEntry,
} from './preset-order'
import { TransactionChatUpdateClock } from './transaction-order'

type ConfigurationCommandMetaPort = BrowserCommandSessionPort
type ConfigurationDirectTableName = Exclude<PhysicalStorageTableName, 'configurationLinks'>

class ConfigurationPlanChangedError extends Error {}

function configurationTransaction(
  ...entries: readonly (ConfigurationDirectTableName | PhysicalTransactionCapability)[]
): PhysicalTransactionPlan<PhysicalStorageTableName> {
  const tableNames: PhysicalStorageTableName[] = []
  const capabilities: PhysicalTransactionCapability[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') tableNames.push(entry)
    else capabilities.push(entry)
  }
  return physicalTransactionPlan(physicalStorageTables(...tableNames), ...capabilities)
}

type ConfigurationPlanRevalidation<Current, Result> =
  | { readonly kind: 'ready'; readonly current: Current }
  | { readonly kind: 'return'; readonly result: Result }
  | { readonly kind: 'retry' }

interface RevalidatedConfigurationPlan<Current, Result> {
  readonly lockNames: readonly string[]
  readonly transaction: PhysicalTransactionPlan<PhysicalStorageTableName>
  revalidate(
    tx: FencedTransaction<PhysicalStorageTableName>,
  ): Promise<ConfigurationPlanRevalidation<Current, Result>>
  commit(tx: FencedTransaction<PhysicalStorageTableName>, current: Current): Promise<Result>
}

type PreparedConfigurationCommand<Current, Result> =
  | { readonly kind: 'return'; readonly result: Result }
  | {
      readonly kind: 'plan'
      readonly plan: RevalidatedConfigurationPlan<Current, Result>
    }

function preparedConfigurationResult<Result>(
  result: Result,
): PreparedConfigurationCommand<never, Result> {
  return { kind: 'return', result }
}

function preparedConfigurationPlan<Current, Result>(
  plan: RevalidatedConfigurationPlan<Current, NoInfer<Result>>,
): PreparedConfigurationCommand<Current, Result> {
  return { kind: 'plan', plan }
}

function configurationPlanReady<Current>(
  current: Current,
): ConfigurationPlanRevalidation<Current, never> {
  return { kind: 'ready', current }
}

function configurationPlanReturn<Result>(
  result: Result,
): ConfigurationPlanRevalidation<never, Result> {
  return { kind: 'return', result }
}

function configurationPlanRetry(): ConfigurationPlanRevalidation<never, never> {
  return { kind: 'retry' }
}

async function executeRevalidatedConfigurationPlan<Current, Result>(
  _db: Dexie,
  commandMeta: ConfigurationCommandMetaPort,
  prepare: () => Promise<PreparedConfigurationCommand<Current, Result>>,
): Promise<Result> {
  for (;;) {
    const prepared = await prepare()
    if (prepared.kind === 'return') return prepared.result
    try {
      const { plan } = prepared
      return await commandMeta.withLocks(sortedUnique(plan.lockNames), (locked) =>
        locked.runTransaction(plan.transaction, async (tx) => {
          const revalidated = await plan.revalidate(tx)
          if (revalidated.kind === 'retry') throw new ConfigurationPlanChangedError()
          if (revalidated.kind === 'return') return revalidated.result
          return plan.commit(tx, revalidated.current)
        }),
      )
    } catch (error) {
      if (error instanceof ConfigurationPlanChangedError) continue
      throw error
    }
  }
}

function executeDirectConfigurationTransaction<Result>(
  db: Dexie,
  commandMeta: ConfigurationCommandMetaPort,
  lockNames: readonly string[],
  transaction: PhysicalTransactionPlan<PhysicalStorageTableName>,
  commit: (tx: FencedTransaction<PhysicalStorageTableName>) => Promise<Result>,
): Promise<Result> {
  return executeRevalidatedConfigurationPlan<undefined, Result>(db, commandMeta, () =>
    Promise.resolve(
      preparedConfigurationPlan({
        lockNames,
        transaction,
        revalidate: () => Promise.resolve(configurationPlanReady(undefined)),
        commit,
      }),
    ),
  )
}

const configurationDomainHandlers = {
  'connection.create': createConnection,
  'connection.edit': editConnection,
  'connection.duplicate': duplicateConnection,
  'connection.touch': touchConnection,
  'connection.delete': deleteConnection,
  'key.put': putKey,
  'key.touch': touchKey,
  'key.material-replace': replaceKeyMaterial,
  'key.delete': deleteKey,
  'chat.switch-profile': switchChatProfile,
  'chat.resolve-model': resolveChatModel,
  'chat.settings-patch': (db, command, commandMeta) =>
    mutateChatConfiguration(
      db,
      command.chatId,
      command.now,
      [],
      [],
      (chat) =>
        withModelResolutionCancellation(
          {
            ...chat,
            settings: applySerializedChatSettingsPatch(chat.settings, command.patch),
          },
          command.cancelModelResolution,
        ),
      commandMeta,
    ),
  'chat.settings-fields-patch': (db, command, commandMeta) =>
    mutateChatConfiguration(
      db,
      command.chatId,
      command.now,
      [],
      [],
      (chat) =>
        withModelResolutionCancellation(
          {
            ...chat,
            settings: applyChatSettingsFieldPatches(chat.settings, command.patches),
          },
          command.cancelModelResolution,
        ),
      commandMeta,
    ),
  'chat.settings-replace': (db, command, commandMeta) =>
    mutateChatConfiguration(
      db,
      command.chatId,
      command.now,
      [],
      [],
      (chat) => {
        const next = withModelResolutionCancellation(
          {
            ...chat,
            settings: normalizeChatSettings(structuredClone(command.settings)),
          },
          command.cancelModelResolution,
        )
        if (command.presetId === null) delete next.presetId
        else if (command.presetId !== undefined) next.presetId = command.presetId
        return next
      },
      commandMeta,
    ),
  'image-allowlist.add': mutateImageAllowlist,
  'image-allowlist.remove': mutateImageAllowlist,
  'rendering-preferences.patch': patchRenderingPreferences,
  'sample-prompts.set-dismissed': (db, command, commandMeta) =>
    saveWorkspaceSetting(db, SAMPLE_PROMPTS_DISMISSED_KEY, command.dismissed, commandMeta),
  'install-secret.ensure': (db, command, commandMeta) =>
    mutateWorkspaceSetting(
      db,
      'install-secret',
      (current) => (typeof current === 'string' && current ? current : command.fresh),
      commandMeta,
    ),
  'global-preference.set': (db, command, commandMeta) =>
    isRecentModelSettingKey(command.key)
      ? Promise.resolve({ kind: 'invalid', reason: 'coupled-setting-command-required' })
      : saveWorkspaceSetting(db, command.key, command.value, commandMeta),
  'global-preference.delete': (db, command, commandMeta) =>
    command.key === RECENT_MODELS_KEY
      ? clearRecentModelState(db, commandMeta)
      : command.key === RECENT_MODEL_RECENCY_KEY
        ? Promise.resolve({ kind: 'invalid', reason: 'coupled-setting-command-required' })
        : deleteWorkspaceSetting(db, command.key, commandMeta),
  'pinned-model.set-membership': (db, command, commandMeta) =>
    mutateWorkspaceSetting<string[]>(
      db,
      PINNED_MODELS_KEY,
      (current) => {
        const ids = normalizeStringIds(current)
        if (command.pinned) return ids.includes(command.modelId) ? ids : [...ids, command.modelId]
        return ids.filter((id) => id !== command.modelId)
      },
      commandMeta,
    ),
  'pinned-model.move': (db, command, commandMeta) =>
    mutateWorkspaceSetting<string[]>(
      db,
      PINNED_MODELS_KEY,
      (current) => {
        const ids = normalizeStringIds(current)
        const from = ids.indexOf(command.modelId)
        if (from < 0) return ids
        const to = Math.max(0, Math.min(ids.length - 1, from + command.delta))
        if (to === from) return ids
        const next = [...ids]
        next.splice(from, 1)
        next.splice(to, 0, command.modelId)
        return next
      },
      commandMeta,
    ),
  'pinned-model.clear': (db, _command, commandMeta) =>
    mutateWorkspaceSetting<string[]>(db, PINNED_MODELS_KEY, () => [], commandMeta),
  'recent-model.bump': bumpRecentModel,
  'recent-model.clear': (db, _command, commandMeta) => clearRecentModelState(db, commandMeta),
  'sidebar-preference.set-sort': (db, command, commandMeta) =>
    saveWorkspaceSetting(db, 'sidebar:sort-key', command.mode, commandMeta),
  'sidebar-preference.set-folder-collapsed': (db, command, commandMeta) =>
    mutateWorkspaceSetting<string[]>(
      db,
      'sidebar:collapsed-folders',
      (current) => {
        const ids = normalizeStringIds(current)
        const next = command.collapsed
          ? [...ids.filter((id) => id !== command.folderId), command.folderId]
          : ids.filter((id) => id !== command.folderId)
        return [...new Set(next)].sort()
      },
      commandMeta,
    ),
  'text-template.create': createTextTemplate,
  'text-template.create-and-select': createAndSelectTextTemplate,
  'text-template.update': updateTextTemplate,
  'text-template.delete': deleteTextTemplate,
  'chat-preset.create': createChatPreset,
  'chat-preset.create-and-link': createAndLinkChatPreset,
  'chat-preset.update': updateChatPreset,
  'chat-preset.duplicate': duplicateChatPreset,
  'chat-preset.move': moveChatPreset,
  'chat-preset.set-archived': setChatPresetArchived,
  'chat-preset.touch': touchChatPreset,
  'chat-preset.delete': deleteChatPreset,
  'chat-preset.apply': applyChatPreset,
  'chat-preset.save': saveChatPreset,
  'prompt-preset.local-commit': commitLocalPrompt,
  'prompt-preset.load-and-pin': loadAndPinPrompt,
  'prompt-preset.overwrite-and-pin': overwriteAndPinPrompt,
  'prompt-preset.create-and-pin': createAndPinPrompt,
  'prompt-preset.put': putPromptPreset,
  'prompt-preset.update': updatePromptPreset,
  'prompt-preset.rename': renamePromptPreset,
  'prompt-preset.touch': touchPromptPreset,
  'prompt-preset.delete': deletePromptPreset,
} satisfies ConfigurationDomainHandlerMap<Dexie, ConfigurationCommandMetaPort>

export function executeConfigurationCommandInBrowser<Command extends ConfigurationDomainCommand>(
  db: Dexie,
  command: Command,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<Command['kind']>> {
  const handler = configurationDomainHandlers[command.kind] as unknown as (
    context: Dexie,
    exactCommand: Command,
    meta: ConfigurationCommandMetaPort,
  ) => Promise<ConfigurationDomainResult<Command['kind']>>
  return handler(db, command, commandMeta)
}

function withModelResolutionCancellation(
  chat: Chat,
  cancelModelResolution: boolean | undefined,
): Chat {
  if (cancelModelResolution === false || chat.modelResolution === undefined) return chat
  const next = { ...chat }
  delete next.modelResolution
  return next
}

async function createConnection(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'connection.create' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'connection.create'>> {
  const { profile, key, initialPreset } = command
  if (key && profile.apiKeyRef !== key.id) {
    return { kind: 'invalid', reason: 'profile-key-mismatch' }
  }
  if (
    initialPreset &&
    (initialPreset.connectionProfileId !== profile.id ||
      initialPreset.settings.profileId !== profile.id)
  ) {
    return { kind: 'invalid', reason: 'preset-profile-mismatch' }
  }
  const profileLinks = configurationLinksForProfile(profile)
  const presetLinks = initialPreset
    ? configurationLinksForPreset({
        ...initialPreset,
        createdAt: command.now,
        updatedAt: command.now,
      })
    : []
  const lockNames = configurationLockNames(
    ['profile-catalog', ...(initialPreset ? ['preset-catalog'] : []), `profile:${profile.id}`],
    [...profileLinks, ...presetLinks],
  )
  return executeDirectConfigurationTransaction(
    db,
    commandMeta,
    lockNames,
    configurationTransaction(
      CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
      CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY,
      CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY,
      'keys',
      'presets',
      PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY,
      'profiles',
    ),
    async (tx) => {
      const profiles = tx.table<ConnectionProfile, ProfileId>('profiles')
      if (await profiles.get(profile.id)) {
        return { kind: 'conflict', reason: 'profile-request-revision' } as const
      }
      const keys = tx.table<KeyRecord, KeyId>('keys')
      if (
        profile.apiKeyRef &&
        profile.apiKeyRef !== key?.id &&
        !(await keys.get(profile.apiKeyRef))
      ) {
        return { kind: 'missing', entity: 'key', id: profile.apiKeyRef } as const
      }
      const presets = tx.table<ChatPreset, PresetId>('presets')
      if (initialPreset && (await presets.get(initialPreset.id))) {
        return { kind: 'conflict', reason: 'link-changed' } as const
      }
      if (key) {
        if (await keys.get(key.id)) {
          return { kind: 'conflict', reason: 'key-material-revision' } as const
        }
        await addSemanticByteOwner(tx, 'keys', {
          ...structuredClone(key),
          materialRevision: key.materialRevision ?? 0,
        })
      }
      const writtenProfile: ConnectionProfile = {
        ...structuredClone(profile),
        requestRevision: profile.requestRevision ?? 0,
      }
      await addLinkedSemanticByteOwner(tx, 'profiles', writtenProfile)
      await putConfigurationProfileCatalogProjection(tx, writtenProfile)

      let writtenPreset: ChatPreset | undefined
      if (initialPreset) {
        writtenPreset = {
          ...structuredClone(initialPreset),
          createdAt: command.now,
          updatedAt: command.now,
        }
        await addLinkedSemanticByteOwner(tx, 'presets', writtenPreset)
        await appendPresetOrderEntry(tx, writtenPreset.id)
        await putConfigurationPresetCatalogProjection(tx, writtenPreset)
      }
      return {
        kind: 'connection-saved',
        profile: writtenProfile,
        ...(key ? { key: structuredClone(key) } : {}),
        ...(writtenPreset ? { initialPreset: writtenPreset } : {}),
      } as const
    },
  )
}

async function editConnection(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'connection.edit' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'connection.edit'>> {
  type Current = {
    readonly profile: ConnectionProfile
    readonly resetChat: Chat | undefined
  }
  return executeRevalidatedConfigurationPlan<Current, ConfigurationDomainResult<'connection.edit'>>(
    db,
    commandMeta,
    async () => {
      const [profile, ownerLinks] = await Promise.all([
        db.table<ConnectionProfile, ProfileId>('profiles').get(command.profileId),
        readOwnerLinks(db, 'profile', command.profileId),
      ])
      if (!profile) {
        return preparedConfigurationResult({
          kind: 'missing',
          entity: 'profile',
          id: command.profileId,
        } as const)
      }
      const [resetChat, resetChatOwnerLinks] = command.resetModelChatId
        ? await Promise.all([
            db.table<Chat, ChatId>('chats').get(command.resetModelChatId),
            readOwnerLinks(db, 'chat', command.resetModelChatId),
          ])
        : [undefined, []]
      if (
        command.expectedRequestRevision !== undefined &&
        (profile.requestRevision ?? 0) !== command.expectedRequestRevision
      ) {
        return preparedConfigurationResult({
          kind: 'conflict',
          reason: 'profile-request-revision',
          currentVersion: profile.requestRevision ?? 0,
        } as const)
      }
      const next = applyConnectionProfilePatch(profile, command.patch, command.now)
      const discoveryChanged = (next.requestRevision ?? 0) !== (profile.requestRevision ?? 0)
      if (command.replacementKey && next.apiKeyRef !== command.replacementKey.id) {
        return preparedConfigurationResult({
          kind: 'invalid',
          reason: 'profile-key-mismatch',
        } as const)
      }
      const nextLinks = configurationLinksForProfile(next)
      const plannedResetChat =
        resetChat?.settings.profileId === profile.id
          ? withModelResolutionCancellation(
              { ...resetChat, settings: { ...resetChat.settings, model: '' } },
              true,
            )
          : undefined
      const lockNames = configurationLockNames(
        [
          `profile:${profile.id}`,
          ...(command.resetModelChatId ? [`chat-meta:${command.resetModelChatId}`] : []),
          ...(discoveryChanged
            ? [
                'discovery-cache:retention',
                `discovery-cache:models:${profile.id}`,
                `discovery-cache:endpoints:${profile.id}`,
                `discovery-cache:privacyPolicies:${profile.id}`,
              ]
            : []),
        ],
        [
          ...ownerLinks,
          ...nextLinks,
          ...resetChatOwnerLinks,
          ...(plannedResetChat ? configurationLinksForChat(plannedResetChat) : []),
        ],
      )
      return preparedConfigurationPlan<Current, ConfigurationDomainResult<'connection.edit'>>({
        lockNames,
        transaction: configurationTransaction(
          CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
          CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY,
          'keys',
          'profiles',
          ...(discoveryChanged ? [DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY] : []),
          ...(command.resetModelChatId ? [CHAT_ROW_LINKED_TRANSACTION_CAPABILITY] : []),
        ),
        async revalidate(tx) {
          const profiles = tx.table<ConnectionProfile, ProfileId>('profiles')
          const current = await profiles.get(profile.id)
          if (!current) {
            return configurationPlanReturn({
              kind: 'missing',
              entity: 'profile',
              id: profile.id,
            } as const)
          }
          if ((current.requestRevision ?? 0) !== (profile.requestRevision ?? 0)) {
            return configurationPlanRetry()
          }
          const currentProfileLinks = await readOwnerLinksFromTransaction(tx, 'profile', profile.id)
          if (!sameLinkIds(ownerLinks, currentProfileLinks)) return configurationPlanRetry()
          let currentResetChat: Chat | undefined
          if (command.resetModelChatId) {
            currentResetChat = await tx.table<Chat, ChatId>('chats').get(command.resetModelChatId)
            if (
              Boolean(currentResetChat) !== Boolean(resetChat) ||
              (currentResetChat &&
                resetChat &&
                (currentResetChat.configurationVersion ?? 0) !==
                  (resetChat.configurationVersion ?? 0)) ||
              Boolean(currentResetChat?.settings.profileId === current.id) !==
                Boolean(plannedResetChat)
            ) {
              return configurationPlanRetry()
            }
            const currentResetLinks = await readOwnerLinksFromTransaction(
              tx,
              'chat',
              command.resetModelChatId,
            )
            if (!sameLinkIds(resetChatOwnerLinks, currentResetLinks)) {
              return configurationPlanRetry()
            }
          }
          return configurationPlanReady({ profile: current, resetChat: currentResetChat })
        },
        async commit(tx, currentState) {
          const current = currentState.profile
          const currentResetChat = currentState.resetChat
          const written = applyConnectionProfilePatch(current, command.patch, command.now)
          const keys = tx.table<KeyRecord, KeyId>('keys')
          if (command.replacementKey) {
            const existing = await keys.get(command.replacementKey.id)
            const expectedRevision = command.replacementKey.materialRevision ?? 0
            if (
              (existing && (existing.materialRevision ?? 0) + 1 !== expectedRevision) ||
              (!existing && expectedRevision !== 0)
            ) {
              return {
                kind: 'conflict',
                reason: 'key-material-revision',
                currentVersion: existing?.materialRevision ?? 0,
              } as const
            }
            await putSemanticByteOwner(
              tx,
              'keys',
              structuredClone(command.replacementKey),
              existing,
            )
          } else if (written.apiKeyRef && !(await keys.get(written.apiKeyRef))) {
            return { kind: 'missing', entity: 'key', id: written.apiKeyRef } as const
          }
          await replaceLinkedSemanticByteOwner(tx, 'profiles', written, current)
          await putConfigurationProfileCatalogProjection(tx, written)
          const fallbackProfileId =
            current.archived !== true && written.archived === true
              ? await readDefaultConfigurationProfileId(tx)
              : undefined
          if (discoveryChanged) await clearProfileDiscoveryRows(tx, written.id)
          const affectedChatIds: ChatId[] = []
          if (currentResetChat?.settings.profileId === written.id) {
            const reset = withModelResolutionCancellation(
              {
                ...currentResetChat,
                settings: { ...currentResetChat.settings, model: '' },
              },
              true,
            )
            if (chatConfigurationChanged(currentResetChat, reset)) {
              const writtenChat = await configuredChat(tx, currentResetChat, reset, command.now)
              await applyChatRowWriteTransitions(tx, [
                { kind: 'replace-linked', previous: currentResetChat, next: writtenChat },
              ])

              affectedChatIds.push(writtenChat.id)
            }
          }
          return {
            kind: 'connection-saved',
            profile: written,
            ...(fallbackProfileId === undefined ? {} : { fallbackProfileId }),
            ...(affectedChatIds.length > 0 ? { affectedChatIds } : {}),
            ...(command.replacementKey
              ? {
                  key: structuredClone(command.replacementKey),
                }
              : {}),
          } as const
        },
      })
    },
  )
}

async function duplicateConnection(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'connection.duplicate' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'connection.duplicate'>> {
  return executeRevalidatedConfigurationPlan<
    ConnectionProfile,
    ConfigurationDomainResult<'connection.duplicate'>
  >(db, commandMeta, async () => {
    const [source, ownerLinks] = await Promise.all([
      db.table<ConnectionProfile, ProfileId>('profiles').get(command.sourceId),
      readOwnerLinks(db, 'profile', command.sourceId),
    ])
    if (!source) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'profile',
        id: command.sourceId,
      } as const)
    }
    const projected = duplicateConnectionProfile(source, command.copyId, command.name, command.now)
    return preparedConfigurationPlan<
      ConnectionProfile,
      ConfigurationDomainResult<'connection.duplicate'>
    >({
      lockNames: configurationLockNames(
        ['profile-catalog', `profile:${source.id}`, `profile:${command.copyId}`],
        [...ownerLinks, ...configurationLinksForProfile(projected)],
      ),
      transaction: configurationTransaction(
        CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
        CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY,
        'profiles',
      ),
      async revalidate(tx) {
        const profiles = tx.table<ConnectionProfile, ProfileId>('profiles')
        const current = await profiles.get(source.id)
        if (!current) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'profile',
            id: source.id,
          } as const)
        }
        if (!sameValue(current, source)) return configurationPlanRetry()
        const currentLinks = await readOwnerLinksFromTransaction(tx, 'profile', source.id)
        if (!sameLinkIds(ownerLinks, currentLinks)) return configurationPlanRetry()
        return configurationPlanReady(current)
      },
      async commit(tx, current) {
        const profiles = tx.table<ConnectionProfile, ProfileId>('profiles')
        if (await profiles.get(command.copyId)) {
          return { kind: 'conflict', reason: 'link-changed' } as const
        }
        const profile = duplicateConnectionProfile(
          current,
          command.copyId,
          command.name,
          command.now,
        )
        await addLinkedSemanticByteOwner(tx, 'profiles', profile)
        await putConfigurationProfileCatalogProjection(tx, profile)

        return { kind: 'connection-saved', profile } as const
      },
    })
  })
}

function duplicateConnectionProfile(
  source: ConnectionProfile,
  copyId: ProfileId,
  name: string | undefined,
  now: number,
): ConnectionProfile {
  const profile: ConnectionProfile = {
    ...structuredClone(source),
    id: copyId,
    name: name ?? `${source.name} (copy)`,
    requestRevision: source.requestRevision ?? 0,
    createdAt: now,
    updatedAt: now,
    archived: false,
  }
  delete profile.lastUsedAt
  return profile
}

async function touchConnection(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'connection.touch' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'connection.touch'>> {
  return executeDirectConfigurationTransaction(
    db,
    commandMeta,
    [`profile:${command.profileId}`],
    configurationTransaction(CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY, 'profiles'),
    async (tx) => {
      const profiles = tx.table<ConnectionProfile, ProfileId>('profiles')
      const current = await profiles.get(command.profileId)
      if (!current) return { kind: 'missing', entity: 'profile', id: command.profileId }
      const lastUsedAt = Math.max(current.lastUsedAt ?? 0, command.now)
      if (lastUsedAt === current.lastUsedAt) return { kind: 'connection-saved', profile: current }
      const profile = { ...current, lastUsedAt }
      await replaceLinkedSemanticByteOwner(tx, 'profiles', profile, current)
      await putConfigurationProfileCatalogProjection(tx, profile)
      return { kind: 'connection-saved', profile }
    },
  )
}

async function deleteConnection(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'connection.delete' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'connection.delete'>> {
  if (command.reassignTo === command.profileId) {
    return { kind: 'invalid', reason: 'profile-reassign-self' }
  }
  const replacementProfileId = command.reassignTo
  const sourceTargetKey = configurationTargetKey('profile', command.profileId)
  type Current = {
    readonly profile: ConnectionProfile
    readonly presets: readonly ChatPreset[]
    readonly chats: readonly Chat[]
    readonly presetIds: readonly PresetId[]
    readonly chatIds: readonly ChatId[]
  }
  return executeRevalidatedConfigurationPlan<
    Current,
    ConfigurationDomainResult<'connection.delete'>
  >(db, commandMeta, async () => {
    const [profile, ownerLinks, usage, dependentLinks] = await Promise.all([
      db.table<ConnectionProfile, ProfileId>('profiles').get(command.profileId),
      readOwnerLinks(db, 'profile', command.profileId),
      db
        .table<ConfigurationProfileUsageProjectionRow, ProfileId>('configurationProfileUsageRows')
        .get(command.profileId),
      replacementProfileId
        ? readTargetLinks(db, 'profile', command.profileId)
        : Promise.resolve([]),
    ])
    if (!profile) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'profile',
        id: command.profileId,
      } as const)
    }
    const keyIds = sortedUnique(
      ownerLinks.filter((link) => link.targetKind === 'key').map((link) => link.targetId),
    )
    const lockNames = configurationLockNames(
      [
        'profile-catalog',
        `profile:${profile.id}`,
        'discovery-cache:retention',
        `discovery-cache:models:${profile.id}`,
        `discovery-cache:endpoints:${profile.id}`,
        `discovery-cache:privacyPolicies:${profile.id}`,
        ...(replacementProfileId ? [`profile:${replacementProfileId}`] : []),
        `configuration-target:${sourceTargetKey}`,
        ...(replacementProfileId
          ? [`configuration-target:${configurationTargetKey('profile', replacementProfileId)}`]
          : []),
        ...dependentLinks.map((link) => configurationOwnerLockName(link.ownerKind, link.ownerId)),
        ...keyIds.flatMap((keyId) => [
          `key:${keyId}`,
          `configuration-target:${configurationTargetKey('key', keyId)}`,
        ]),
      ],
      ownerLinks,
    )
    return preparedConfigurationPlan({
      lockNames,
      transaction: replacementProfileId
        ? configurationTransaction(
            CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
            CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
            CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY,
            CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY,
            DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY,
            'keys',
            'presets',
            'profiles',
          )
        : configurationTransaction(
            CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
            CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY,
            DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY,
            'keys',
            'profiles',
          ),
      async revalidate(tx) {
        const profiles = tx.table<ConnectionProfile, ProfileId>('profiles')
        const current = await profiles.get(profile.id)
        if (!current) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'profile',
            id: profile.id,
          } as const)
        }
        if (!sameValue(current, profile)) return configurationPlanRetry()
        const currentOwnerLinks = await readOwnerLinksFromTransaction(tx, 'profile', profile.id)
        if (!sameLinkIds(ownerLinks, currentOwnerLinks)) return configurationPlanRetry()
        const currentUsage =
          (await tx
            .table<ConfigurationProfileUsageProjectionRow, ProfileId>(
              'configurationProfileUsageRows',
            )
            .get(profile.id)) ?? emptyConfigurationProfileUsageProjectionRow(profile.id)
        const plannedUsage = usage ?? emptyConfigurationProfileUsageProjectionRow(profile.id)
        if (!sameValue(plannedUsage, currentUsage)) return configurationPlanRetry()
        if (!replacementProfileId && (currentUsage.presetCount > 0 || currentUsage.chatCount > 0)) {
          return configurationPlanReturn({
            kind: 'connection-delete-blocked',
            profileId: profile.id,
            presetCount: currentUsage.presetCount,
            chatCount: currentUsage.chatCount,
          } as const)
        }
        const replacement = replacementProfileId
          ? await profiles.get(replacementProfileId)
          : undefined
        if (replacementProfileId && !replacement) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'profile',
            id: replacementProfileId,
          } as const)
        }
        if (replacement?.archived === true) {
          return configurationPlanReturn({
            kind: 'invalid',
            reason: 'profile-reassign-archived',
          } as const)
        }
        const currentDependentLinks = replacementProfileId
          ? await readTargetLinksFromTransaction(tx, 'profile', profile.id)
          : []
        if (replacementProfileId && !sameLinkIds(dependentLinks, currentDependentLinks)) {
          return configurationPlanRetry()
        }

        const presetIds = sortedUnique(
          currentDependentLinks
            .filter((link) => link.ownerKind === 'chat-preset')
            .map((link) => link.ownerId),
        )
        const chatIds = sortedUnique(
          currentDependentLinks
            .filter((link) => link.ownerKind === 'chat')
            .map((link) => link.ownerId),
        )
        if (
          currentUsage.presetCount !== presetIds.length ||
          currentUsage.chatCount !== chatIds.length
        ) {
          throw new Error(`ConfigurationProfileUsageIntegrityError:${profile.id}`)
        }
        const [presets, chats] = replacementProfileId
          ? await Promise.all([
              tx.table<ChatPreset, PresetId>('presets').bulkGet(presetIds),
              tx.table<Chat, ChatId>('chats').bulkGet(chatIds),
            ])
          : [[], []]
        if (presets.some((preset) => !preset) || chats.some((chat) => !chat)) {
          return configurationPlanRetry()
        }
        return configurationPlanReady({
          profile: current,
          presets: presets as ChatPreset[],
          chats: chats as Chat[],
          presetIds,
          chatIds,
        })
      },
      async commit(tx, current) {
        const { profile, presets, chats, presetIds, chatIds } = current
        if (replacementProfileId) {
          const nextPresets = presets.map(
            (preset): ChatPreset => ({
              ...preset,
              connectionProfileId: replacementProfileId,
              settings: { ...preset.settings, profileId: replacementProfileId },
              updatedAt: command.now,
            }),
          )
          await replaceLinkedSemanticByteOwnerBatch(tx, 'presets', nextPresets, presets)
          for (const next of nextPresets) {
            await putConfigurationPresetCatalogProjection(tx, next)
          }
          const nextChats: Chat[] = []
          const chatClock = new TransactionChatUpdateClock()
          for (const chat of chats) {
            nextChats.push(
              await configuredChat(
                tx,
                chat,
                withModelResolutionCancellation(
                  {
                    ...chat,
                    settings: { ...chat.settings, profileId: replacementProfileId },
                  },
                  true,
                ),
                command.now,
                chatClock,
              ),
            )
          }
          await applyChatRowWriteTransitions(
            tx,
            nextChats.map((next, index) => ({
              kind: 'replace-linked',
              previous: chats[index] as Chat,
              next,
            })),
          )
        }

        await deleteLinkedSemanticByteOwner(tx, 'profiles', profile.id, profile)
        await deleteConfigurationProfileCatalogProjection(tx, profile.id)
        const fallbackProfileId =
          replacementProfileId ?? (await readDefaultConfigurationProfileId(tx))
        await clearProfileDiscoveryRows(tx, profile.id)
        const deletedKeyIds: KeyId[] = []
        const keys = tx.table<KeyRecord, KeyId>('keys')
        for (const keyId of keyIds) {
          const remainingLinks = await tx
            .table<ConfigurationLink, string>('configurationLinks')
            .where('targetKey')
            .equals(configurationTargetKey('key', keyId))
            .toArray()
          if (remainingLinks.some((link) => link.ownerKind === 'profile')) continue
          const key = await keys.get(keyId)
          if (key) {
            await deleteSemanticByteOwner(tx, 'keys', keyId, key)
            deletedKeyIds.push(keyId)
          }
        }
        return {
          kind: 'connection-deleted',
          profileId: profile.id,
          affectedPresetIds: presetIds,
          affectedChatIds: chatIds,
          deletedKeyIds,
          fallbackProfileId,
        } as const
      },
    })
  })
}

async function clearProfileDiscoveryRows(tx: Transaction, profileId: ProfileId): Promise<void> {
  await clearDiscoveryCacheProfileRows(tx, ['models', 'endpoints', 'privacyPolicies'], profileId)
}

async function putKey(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'key.put' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'key.put'>> {
  return writeKeyMaterial(db, command.key, command.expectedMaterialRevision, commandMeta)
}

async function replaceKeyMaterial(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'key.material-replace' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'key.material-replace'>> {
  return writeKeyMaterial(db, command.key, command.expectedMaterialRevision, commandMeta)
}

async function writeKeyMaterial(
  db: Dexie,
  key: KeyRecord,
  expectedMaterialRevision: number | null,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'key.put'>> {
  const targetKey = configurationTargetKey('key', key.id)
  return executeRevalidatedConfigurationPlan<
    KeyRecord | undefined,
    ConfigurationDomainResult<'key.put'>
  >(db, commandMeta, async () => {
    const targetLinks = await readTargetLinks(db, 'key', key.id)
    return preparedConfigurationPlan({
      lockNames: [`configuration-target:${targetKey}`, `key:${key.id}`],
      transaction: configurationTransaction(CONFIGURATION_LINK_ROWS_TRANSACTION_CAPABILITY, 'keys'),
      async revalidate(tx) {
        const currentLinks = await readTargetLinksFromTransaction(tx, 'key', key.id)
        if (!sameLinkIds(targetLinks, currentLinks)) return configurationPlanRetry()
        const keys = tx.table<KeyRecord, KeyId>('keys')
        const current = await keys.get(key.id)
        const currentRevision = current?.materialRevision ?? null
        if (currentRevision !== expectedMaterialRevision) {
          return configurationPlanReturn({
            kind: 'conflict',
            reason: 'key-material-revision',
            ...(currentRevision === null ? {} : { currentVersion: currentRevision }),
          } as const)
        }
        const expectedNextRevision = (expectedMaterialRevision ?? -1) + 1
        if ((key.materialRevision ?? 0) !== expectedNextRevision) {
          return configurationPlanReturn({
            kind: 'conflict',
            reason: 'key-material-revision',
            ...(currentRevision === null ? {} : { currentVersion: currentRevision }),
          } as const)
        }
        return configurationPlanReady(current)
      },
      async commit(tx, current) {
        const next = structuredClone(key)
        await putSemanticByteOwner(tx, 'keys', next, current)
        return keySavedResult(next.id, next, true, false)
      },
    })
  })
}

async function touchKey(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'key.touch' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'key.touch'>> {
  const targetKey = configurationTargetKey('key', command.keyId)
  return executeRevalidatedConfigurationPlan<KeyRecord, ConfigurationDomainResult<'key.touch'>>(
    db,
    commandMeta,
    async () => {
      const targetLinks = await readTargetLinks(db, 'key', command.keyId)
      return preparedConfigurationPlan({
        lockNames: [`configuration-target:${targetKey}`, `key:${command.keyId}`],
        transaction: configurationTransaction(
          CONFIGURATION_LINK_ROWS_TRANSACTION_CAPABILITY,
          'keys',
        ),
        async revalidate(tx) {
          const currentLinks = await readTargetLinksFromTransaction(tx, 'key', command.keyId)
          if (!sameLinkIds(targetLinks, currentLinks)) return configurationPlanRetry()
          const keys = tx.table<KeyRecord, KeyId>('keys')
          const current = await keys.get(command.keyId)
          if (!current) {
            return configurationPlanReturn({
              kind: 'missing',
              entity: 'key',
              id: command.keyId,
            } as const)
          }
          return configurationPlanReady(current)
        },
        async commit(tx, current) {
          const lastUsedAt = Math.max(current.lastUsedAt ?? 0, command.now)
          if (lastUsedAt === current.lastUsedAt) {
            return keySavedResult(current.id, current, false, false)
          }
          const key = { ...current, lastUsedAt }
          await replaceSemanticByteOwner(tx, 'keys', key, current)
          return keySavedResult(key.id, key, true, false)
        },
      })
    },
  )
}

async function deleteKey(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'key.delete' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'key.delete'>> {
  const targetKey = configurationTargetKey('key', command.keyId)
  return executeRevalidatedConfigurationPlan<
    KeyRecord | undefined,
    ConfigurationDomainResult<'key.delete'>
  >(db, commandMeta, async () => {
    const targetLinks = await readTargetLinks(db, 'key', command.keyId)
    return preparedConfigurationPlan({
      lockNames: [`configuration-target:${targetKey}`, `key:${command.keyId}`],
      transaction: configurationTransaction(CONFIGURATION_LINK_ROWS_TRANSACTION_CAPABILITY, 'keys'),
      async revalidate(tx) {
        const currentLinks = await readTargetLinksFromTransaction(tx, 'key', command.keyId)
        if (!sameLinkIds(targetLinks, currentLinks)) return configurationPlanRetry()
        const keys = tx.table<KeyRecord, KeyId>('keys')
        const current = await keys.get(command.keyId)
        return configurationPlanReady(current)
      },
      async commit(tx, current) {
        if (!current) {
          return keySavedResult(command.keyId, undefined, false, true)
        }
        await deleteSemanticByteOwner(tx, 'keys', command.keyId, current)
        return keySavedResult(command.keyId, undefined, true, true)
      },
    })
  })
}

function keySavedResult(
  keyId: KeyId,
  key: KeyRecord | undefined,
  changed: boolean,
  deleted: boolean,
): Extract<ConfigurationDomainResult, { kind: 'key-saved' }> {
  return {
    kind: 'key-saved',
    keyId,
    ...(key ? { key } : {}),
    changed,
    deleted,
  }
}

interface PlannedConfigurationRequestTarget {
  readonly profile: ConnectionProfile
  readonly keyId: KeyId | undefined
}

type RevalidatedConfigurationRequestTarget =
  | {
      readonly kind: 'ready'
      readonly profile: ConnectionProfile
      readonly key: KeyRecord | undefined
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'retry' }

async function planConfigurationRequestTarget(
  db: Dexie,
  profileId: ProfileId,
): Promise<PlannedConfigurationRequestTarget | undefined> {
  const profile = await db.table<ConnectionProfile, ProfileId>('profiles').get(profileId)
  return profile ? { profile, keyId: profile.apiKeyRef } : undefined
}

function configurationRequestTargetLocks(
  planned: PlannedConfigurationRequestTarget,
  target: ConfigurationRequestRevision,
): string[] {
  const keyIds = sortedUnique([
    ...(planned.keyId ? [planned.keyId] : []),
    ...(target.key.kind === 'material' ? [target.key.keyId] : []),
  ])
  return [
    `profile:${planned.profile.id}`,
    `configuration-target:${configurationTargetKey('profile', planned.profile.id)}`,
    ...keyIds.flatMap((keyId) => [
      `key:${keyId}`,
      `configuration-target:${configurationTargetKey('key', keyId)}`,
    ]),
  ]
}

async function revalidateConfigurationRequestTarget(
  tx: Transaction,
  planned: PlannedConfigurationRequestTarget,
): Promise<RevalidatedConfigurationRequestTarget> {
  const profile = await tx.table<ConnectionProfile, ProfileId>('profiles').get(planned.profile.id)
  if (!profile) return { kind: 'missing' }
  if (
    (profile.requestRevision ?? 0) !== (planned.profile.requestRevision ?? 0) ||
    profile.apiKeyRef !== planned.keyId
  ) {
    return { kind: 'retry' }
  }
  const key = planned.keyId
    ? await tx.table<KeyRecord, KeyId>('keys').get(planned.keyId)
    : undefined
  return { kind: 'ready', profile, key }
}

async function switchChatProfile(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'chat.switch-profile' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat.switch-profile'>> {
  if (
    command.target.profileId !== command.profileId ||
    (command.model.kind === 'pending' &&
      !sameValue(command.target, command.model.resolution.target))
  ) {
    return { kind: 'invalid', reason: 'model-resolution-target-mismatch' }
  }
  type Current = {
    readonly chat: Chat
    readonly profile: ConnectionProfile
    readonly key: KeyRecord | undefined
  }
  return executeRevalidatedConfigurationPlan<
    Current,
    ConfigurationDomainResult<'chat.switch-profile'>
  >(db, commandMeta, async () => {
    const [targetPlan, chat, ownerLinks] = await Promise.all([
      planConfigurationRequestTarget(db, command.profileId),
      db.table<Chat, ChatId>('chats').get(command.chatId),
      readOwnerLinks(db, 'chat', command.chatId),
    ])
    if (!targetPlan) {
      return preparedConfigurationResult({
        kind: 'invalid',
        reason: 'model-resolution-target-mismatch',
      } as const)
    }
    if (!chat) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'chat',
        id: command.chatId,
      } as const)
    }
    const projected = switchedProfileChat(chat, command)
    return preparedConfigurationPlan({
      lockNames: configurationLockNames(
        [`chat-meta:${chat.id}`, ...configurationRequestTargetLocks(targetPlan, command.target)],
        [...ownerLinks, ...configurationLinksForChat(projected)],
      ),
      transaction: configurationTransaction(
        CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
        CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY,
        'keys',
        'profiles',
      ),
      async revalidate(tx) {
        const currentTarget = await revalidateConfigurationRequestTarget(tx, targetPlan)
        if (currentTarget.kind === 'retry') return configurationPlanRetry()
        if (currentTarget.kind === 'missing') {
          return configurationPlanReturn({
            kind: 'invalid',
            reason: 'model-resolution-target-mismatch',
          } as const)
        }
        const currentChat = await tx.table<Chat, ChatId>('chats').get(chat.id)
        if (!currentChat) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'chat',
            id: chat.id,
          } as const)
        }
        if ((currentChat.configurationVersion ?? 0) !== (chat.configurationVersion ?? 0)) {
          return configurationPlanRetry()
        }
        const currentLinks = await readOwnerLinksFromTransaction(tx, 'chat', chat.id)
        if (!sameLinkIds(ownerLinks, currentLinks)) return configurationPlanRetry()
        return configurationPlanReady({
          chat: currentChat,
          profile: currentTarget.profile,
          key: currentTarget.key,
        })
      },
      async commit(tx, current) {
        if (
          !sameValue(configurationRequestRevisionFor(current.profile, current.key), command.target)
        ) {
          return { kind: 'invalid', reason: 'model-resolution-target-mismatch' }
        }
        const currentVersion = current.chat.configurationVersion ?? 0
        if (currentVersion !== command.expectedConfigurationVersion) {
          return {
            kind: 'conflict',
            reason: 'configuration-version',
            currentVersion,
          }
        }
        const transformedChat = switchedProfileChat(current.chat, command)
        const changed = chatConfigurationChanged(current.chat, transformedChat)
        const written = changed
          ? await configuredChat(tx, current.chat, transformedChat, command.now)
          : current.chat
        if (changed) {
          await applyChatRowWriteTransitions(tx, [
            { kind: 'replace-linked', previous: current.chat, next: written },
          ])
        }
        const lastUsedAt = Math.max(current.profile.lastUsedAt ?? 0, command.now)
        const profileTouched = lastUsedAt !== current.profile.lastUsedAt
        if (profileTouched) {
          const touched = { ...current.profile, lastUsedAt }
          await replaceLinkedSemanticByteOwner(tx, 'profiles', touched, current.profile)
          await putConfigurationProfileCatalogProjection(tx, touched)
        }
        return {
          ...chatUpdatedResult(written, changed),
          ...(profileTouched ? { affectedProfileIds: [current.profile.id] } : {}),
        }
      },
    })
  })
}

function switchedProfileChat(
  chat: Chat,
  command: Extract<ConfigurationDomainCommand, { kind: 'chat.switch-profile' }>,
): Chat {
  const settings: ChatSettings = {
    ...chat.settings,
    profileId: command.profileId,
    api: command.api,
    model: command.model.kind === 'resolved' ? command.model.id : command.model.immediateId,
  }
  const transformed = withModelResolutionCancellation({ ...chat, settings }, true)
  if (command.model.kind === 'pending') {
    transformed.modelResolution = {
      ...structuredClone(command.model.resolution),
      expectedConfigurationVersion: (chat.configurationVersion ?? 0) + 1,
    }
  }
  return transformed
}

async function resolveChatModel(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'chat.resolve-model' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat.resolve-model'>> {
  type Current = {
    readonly chat: Chat
    readonly profile: ConnectionProfile
    readonly key: KeyRecord | undefined
  }
  return executeRevalidatedConfigurationPlan<
    Current,
    ConfigurationDomainResult<'chat.resolve-model'>
  >(db, commandMeta, async () => {
    const [targetPlan, chat, ownerLinks] = await Promise.all([
      planConfigurationRequestTarget(db, command.target.profileId),
      db.table<Chat, ChatId>('chats').get(command.chatId),
      readOwnerLinks(db, 'chat', command.chatId),
    ])
    if (!targetPlan) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'profile',
        id: command.target.profileId,
      } as const)
    }
    if (!chat) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'chat',
        id: command.chatId,
      } as const)
    }
    const lockNames = configurationLockNames(
      [`chat-meta:${chat.id}`, ...configurationRequestTargetLocks(targetPlan, command.target)],
      ownerLinks,
    )
    return preparedConfigurationPlan<Current, ConfigurationDomainResult<'chat.resolve-model'>>({
      lockNames,
      transaction: configurationTransaction(
        CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
        'keys',
        'profiles',
      ),
      async revalidate(tx) {
        const currentTarget = await revalidateConfigurationRequestTarget(tx, targetPlan)
        if (currentTarget.kind === 'retry') return configurationPlanRetry()
        if (currentTarget.kind === 'missing') {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'profile',
            id: targetPlan.profile.id,
          } as const)
        }
        const currentChat = await tx.table<Chat, ChatId>('chats').get(chat.id)
        if (!currentChat) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'chat',
            id: chat.id,
          } as const)
        }
        if ((currentChat.configurationVersion ?? 0) !== (chat.configurationVersion ?? 0)) {
          return configurationPlanRetry()
        }
        const currentLinks = await readOwnerLinksFromTransaction(tx, 'chat', chat.id)
        if (!sameLinkIds(ownerLinks, currentLinks)) return configurationPlanRetry()
        return configurationPlanReady({
          chat: currentChat,
          profile: currentTarget.profile,
          key: currentTarget.key,
        })
      },
      async commit(tx, current) {
        if (
          !sameValue(configurationRequestRevisionFor(current.profile, current.key), command.target)
        ) {
          return { kind: 'invalid', reason: 'model-resolution-target-mismatch' }
        }
        const { chat: currentChat } = current
        const currentVersion = currentChat.configurationVersion ?? 0
        if (currentVersion !== command.expectedConfigurationVersion) {
          return {
            kind: 'conflict',
            reason: 'configuration-version',
            currentVersion,
          }
        }
        const pending = currentChat.modelResolution
        if (!pending || pending.intentId !== command.intentId) {
          return { kind: 'conflict', reason: 'model-resolution-intent' }
        }
        if (!sameValue(pending.target, command.target)) {
          return { kind: 'invalid', reason: 'model-resolution-target-mismatch' }
        }
        const transformed = withModelResolutionCancellation(
          {
            ...currentChat,
            settings: { ...currentChat.settings, model: command.modelId },
          },
          true,
        )
        if (!chatConfigurationChanged(currentChat, transformed)) {
          return chatUpdatedResult(currentChat, false)
        }
        const written = await configuredChat(tx, currentChat, transformed, command.now)
        await applyChatRowWriteTransitions(tx, [
          { kind: 'replace-linked', previous: currentChat, next: written },
        ])

        return chatUpdatedResult(written, true)
      },
    })
  })
}

type ChatConfigurationTransformResult =
  | Chat
  | Extract<ConfigurationDomainResult, { kind: 'conflict' | 'invalid' }>

type ConfigurationMutationFailure = Extract<
  ConfigurationDomainResult,
  { kind: 'missing' | 'conflict' | 'invalid' }
>

async function mutateChatConfiguration(
  db: Dexie,
  chatId: ChatId,
  now: number,
  extraLockNames: readonly string[],
  extraTables: readonly (ConfigurationDirectTableName | PhysicalTransactionCapability)[],
  transform: (chat: Chat) => ChatConfigurationTransformResult,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat.settings-patch'>> {
  return executeRevalidatedConfigurationPlan(db, commandMeta, async () => {
    const [chat, ownerLinks] = await Promise.all([
      db.table<Chat, ChatId>('chats').get(chatId),
      readOwnerLinks(db, 'chat', chatId),
    ])
    if (!chat) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'chat',
        id: chatId,
      } as const)
    }
    const projected = transform(structuredClone(chat))
    if (isConfigurationErrorResult(projected)) return preparedConfigurationResult(projected)
    const nextLinks = configurationLinksForChat(projected)
    const lockNames = configurationLockNames(
      [`chat-meta:${chatId}`, ...extraLockNames],
      [...ownerLinks, ...nextLinks],
    )
    return preparedConfigurationPlan<Chat, ConfigurationDomainResult<'chat.settings-patch'>>({
      lockNames,
      transaction: configurationTransaction(CHAT_ROW_LINKED_TRANSACTION_CAPABILITY, ...extraTables),
      async revalidate(tx) {
        const current = await tx.table<Chat, ChatId>('chats').get(chatId)
        if (!current) {
          return configurationPlanReturn({ kind: 'missing', entity: 'chat', id: chatId } as const)
        }
        if ((current.configurationVersion ?? 0) !== (chat.configurationVersion ?? 0)) {
          return configurationPlanRetry()
        }
        const currentLinks = await readOwnerLinksFromTransaction(tx, 'chat', chatId)
        if (!sameLinkIds(ownerLinks, currentLinks)) return configurationPlanRetry()
        return configurationPlanReady(current)
      },
      async commit(tx, current) {
        const transformed = transform(structuredClone(current))
        if (isConfigurationErrorResult(transformed)) return transformed
        if (!chatConfigurationChanged(current, transformed)) {
          return chatUpdatedResult(current, false)
        }
        const written = await configuredChat(tx, current, transformed, now)
        await applyChatRowWriteTransitions(tx, [
          { kind: 'replace-linked', previous: current, next: written },
        ])

        return chatUpdatedResult(written, true)
      },
    })
  })
}

async function mutateImageAllowlist(
  db: Dexie,
  command: Extract<
    ConfigurationDomainCommand,
    { kind: 'image-allowlist.add' | 'image-allowlist.remove' }
  >,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'image-allowlist.add'>> {
  const key = IMAGE_ALLOWLIST_KEY
  return mutateWorkspaceSetting<string[]>(
    db,
    key,
    (current) => {
      const values = customImageOriginsFromStored(current)
      if (command.kind === 'image-allowlist.add') {
        return values.includes(command.origin) ? values : [...values, command.origin]
      }
      return values.filter((value) => value !== command.origin)
    },
    commandMeta,
  )
}

async function patchRenderingPreferences(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'rendering-preferences.patch' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'rendering-preferences.patch'>> {
  return mutateWorkspaceSetting(
    db,
    RENDERING_PREFERENCES_KEY,
    (current) =>
      normalizeRenderingPreferences({
        ...normalizeRenderingPreferences(current),
        ...command.patch,
      }),
    commandMeta,
  )
}

async function saveWorkspaceSetting(
  db: Dexie,
  key: string,
  value: unknown,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'global-preference.set'>> {
  return mutateWorkspaceSetting(db, key, () => structuredClone(value), commandMeta)
}

async function deleteWorkspaceSetting(
  db: Dexie,
  key: string,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'global-preference.delete'>> {
  return executeDirectConfigurationTransaction(
    db,
    commandMeta,
    [`setting:${key}`],
    configurationTransaction('settings'),
    async (tx) => {
      const table = tx.table<{ key: string; value: unknown }, string>('settings')
      const current = await table.get(key)
      if (!current) {
        return { kind: 'workspace-setting-saved', key, value: undefined, changed: false }
      }
      await deleteUserSettingByteOwner(tx, current)
      return { kind: 'workspace-setting-saved', key, value: undefined, changed: true }
    },
  )
}

async function mutateWorkspaceSetting<T>(
  db: Dexie,
  key: string,
  mutate: (current: unknown) => T,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'global-preference.set'>> {
  return executeDirectConfigurationTransaction(
    db,
    commandMeta,
    [`setting:${key}`],
    configurationTransaction('settings'),
    async (tx) => {
      const table = tx.table<{ key: string; value: unknown }, string>('settings')
      const current = await table.get(key)
      const value = mutate(current?.value)
      if (current && sameValue(current.value, value)) {
        return { kind: 'workspace-setting-saved', key, value, changed: false }
      }
      await putUserSettingByteOwner(tx, { key, value }, current)
      return { kind: 'workspace-setting-saved', key, value, changed: true }
    },
  )
}

async function bumpRecentModel(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'recent-model.bump' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'recent-model.bump'>> {
  return mutateRecentModelState(
    db,
    {
      modelId: command.modelId,
      usedAt: command.now,
      streamId: `command:${command.modelId}`,
    },
    command.limit,
    commandMeta,
  )
}

async function clearRecentModelState(
  db: Dexie,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'recent-model.clear'>> {
  return mutateRecentModelState(db, null, 0, commandMeta)
}

async function mutateRecentModelState(
  db: Dexie,
  candidate: {
    readonly modelId: string
    readonly usedAt: number
    readonly streamId: string
  } | null,
  limit: number,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'recent-model.bump' | 'recent-model.clear'>> {
  return executeDirectConfigurationTransaction(
    db,
    commandMeta,
    [`setting:${RECENT_MODELS_KEY}`, `setting:${RECENT_MODEL_RECENCY_KEY}`],
    configurationTransaction('settings'),
    async (tx) => {
      const table = tx.table<{ key: string; value: unknown }, string>('settings')
      const [publicRow, recencyRow] = await Promise.all([
        table.get(RECENT_MODELS_KEY),
        table.get(RECENT_MODEL_RECENCY_KEY),
      ])
      const next = candidate
        ? advanceRecentModelState(publicRow?.value, recencyRow?.value, candidate, limit)
        : {
            changed:
              !publicRow ||
              !recencyRow ||
              !sameValue(publicRow.value, []) ||
              !sameValue(recencyRow.value, emptyRecentModelRecency()),
            models: [],
            recency: emptyRecentModelRecency(),
          }
      if (!next.changed) {
        return {
          kind: 'workspace-setting-saved',
          key: RECENT_MODELS_KEY,
          value: next.models,
          changed: false,
        }
      }
      await putUserSettingByteOwners(
        tx,
        [
          { key: RECENT_MODEL_RECENCY_KEY, value: next.recency },
          { key: RECENT_MODELS_KEY, value: next.models },
        ],
        [recencyRow, publicRow],
      )
      recordBrowserCommandInvalidation(tx, {
        kind: 'setting',
        keys: [RECENT_MODEL_RECENCY_KEY],
      })
      return {
        kind: 'workspace-setting-saved',
        key: RECENT_MODELS_KEY,
        value: next.models,
        changed: true,
      }
    },
  )
}

function isRecentModelSettingKey(key: string): boolean {
  return key === RECENT_MODELS_KEY || key === RECENT_MODEL_RECENCY_KEY
}

async function createTextTemplate(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'text-template.create' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'text-template.create'>> {
  const targetKey = configurationTargetKey('text-template', command.template.id)
  return executeDirectConfigurationTransaction(
    db,
    commandMeta,
    [`configuration-target:${targetKey}`],
    configurationTransaction('textTemplates'),
    async (tx) => {
      const table = tx.table<SavedTextTemplate, TextTemplateId>('textTemplates')
      if (await table.get(command.template.id)) {
        return { kind: 'conflict', reason: 'link-changed' } as const
      }
      await addTextTemplateByteOwner(tx, structuredClone(command.template))
      return {
        kind: 'text-template-saved',
        templateId: command.template.id,
        changed: true,
      } as const
    },
  )
}

async function updateTextTemplate(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'text-template.update' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'text-template.update'>> {
  const targetKey = configurationTargetKey('text-template', command.templateId)
  return executeDirectConfigurationTransaction(
    db,
    commandMeta,
    [`configuration-target:${targetKey}`],
    configurationTransaction('textTemplates'),
    async (tx) => {
      const table = tx.table<SavedTextTemplate, TextTemplateId>('textTemplates')
      const current = await table.get(command.templateId)
      if (!current) {
        return { kind: 'missing', entity: 'text-template', id: command.templateId } as const
      }
      const next: SavedTextTemplate = {
        ...current,
        ...(command.patch.name === undefined
          ? {}
          : { name: command.patch.name.trim() || current.name }),
        ...(command.patch.config === undefined
          ? {}
          : { config: normalizeTextTemplateConfig(command.patch.config) }),
        updatedAt: command.now,
      }
      if (sameValue(current, { ...next, updatedAt: current.updatedAt })) {
        return {
          kind: 'text-template-saved',
          templateId: command.templateId,
          changed: false,
        } as const
      }
      await replaceTextTemplateByteOwner(tx, next, current)
      return {
        kind: 'text-template-saved',
        templateId: command.templateId,
        changed: true,
      } as const
    },
  )
}

async function createAndSelectTextTemplate(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'text-template.create-and-select' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'text-template.create-and-select'>> {
  const targetKey = configurationTargetKey('text-template', command.template.id)
  return mutateChatConfigurationWithTables(
    db,
    command.chatId,
    command.now,
    [`configuration-target:${targetKey}`],
    ['textTemplates'],
    async (tx, chat) => {
      const table = tx.table<SavedTextTemplate, TextTemplateId>('textTemplates')
      if (await table.get(command.template.id)) {
        return { kind: 'conflict', reason: 'link-changed' }
      }
      await addTextTemplateByteOwner(tx, structuredClone(command.template))
      return {
        chat: withModelResolutionCancellation(
          {
            ...chat,
            settings: { ...chat.settings, textTemplate: command.template.id },
          },
          true,
        ),
        wroteExternal: true,
        result: (written) => ({
          kind: 'text-template-saved',
          templateId: command.template.id,
          changed: true,
          affectedChatIds: [written.id],
        }),
      }
    },
    commandMeta,
  )
}

async function deleteTextTemplate(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'text-template.delete' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'text-template.delete'>> {
  const targetKey = configurationTargetKey('text-template', command.templateId)
  return executeRevalidatedConfigurationPlan<
    readonly ConfigurationLink[],
    ConfigurationDomainResult<'text-template.delete'>
  >(db, commandMeta, async () => {
    const targetLinks = await readTargetLinks(db, 'text-template', command.templateId)
    const ownerLocks = targetLinks.map((link) =>
      configurationOwnerLockName(link.ownerKind, link.ownerId),
    )
    return preparedConfigurationPlan({
      lockNames: [`configuration-target:${targetKey}`, ...ownerLocks],
      transaction: configurationTransaction(
        CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
        CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
        'presets',
        'textTemplates',
      ),
      async revalidate(tx) {
        const currentLinks = await readTargetLinksFromTransaction(
          tx,
          'text-template',
          command.templateId,
        )
        return sameLinkIds(targetLinks, currentLinks)
          ? configurationPlanReady(currentLinks)
          : configurationPlanRetry()
      },
      async commit(tx, currentLinks) {
        const table = tx.table<SavedTextTemplate, TextTemplateId>('textTemplates')
        const previousTemplate = await table.get(command.templateId)
        const catalogChanged = previousTemplate !== undefined
        const affectedChatIds: ChatId[] = []
        const affectedPresetIds: PresetId[] = []
        const chatWrites: Array<{ previous: Chat; next: Chat }> = []
        const configuredChatIds = new Set<ChatId>()
        const chatClock = new TransactionChatUpdateClock()
        for (const link of currentLinks) {
          if (link.ownerKind === 'chat') {
            const chatId = link.ownerId
            if (configuredChatIds.has(chatId)) continue
            configuredChatIds.add(chatId)
            const chat = await tx.table<Chat, ChatId>('chats').get(chatId)
            if (!chat) throw new Error(`ConfigurationLinkOwnerMissing:${link.ownerKey}`)
            const written = await configuredChat(
              tx,
              chat,
              withModelResolutionCancellation(
                {
                  ...chat,
                  settings: { ...chat.settings, textTemplate: 'chatml' },
                },
                true,
              ),
              command.now,
              chatClock,
            )
            chatWrites.push({ previous: chat, next: written })
            affectedChatIds.push(written.id)
            continue
          }
          if (link.ownerKind === 'chat-preset') {
            const preset = await tx.table<ChatPreset, PresetId>('presets').get(link.ownerId)
            if (!preset) throw new Error(`ConfigurationLinkOwnerMissing:${link.ownerKey}`)
            const written: ChatPreset = {
              ...preset,
              settings: { ...preset.settings, textTemplate: 'chatml' },
              updatedAt: command.now,
            }
            await replaceLinkedSemanticByteOwner(tx, 'presets', written, preset)

            affectedPresetIds.push(written.id)
            continue
          }
          throw new Error(`ConfigurationLinkOwnerInvalid:${link.ownerKey}`)
        }
        await applyChatRowWriteTransitions(
          tx,
          chatWrites.map(({ previous, next }) => ({
            kind: 'replace-linked',
            previous,
            next,
          })),
        )
        if (catalogChanged) {
          await deleteTextTemplateByteOwner(tx, command.templateId, previousTemplate)
        }
        const changed = catalogChanged || currentLinks.length > 0
        return {
          kind: 'text-template-saved',
          templateId: command.templateId,
          changed,
          deleted: catalogChanged,
          affectedChatIds,
          affectedPresetIds,
        } as const
      },
    })
  })
}

async function createChatPreset(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.create' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.create'>> {
  const profileId = command.preset.connectionProfileId
  const provisional: ChatPreset = {
    ...structuredClone(command.preset),
    settings: { ...normalizeChatSettings(command.preset.settings), profileId },
    createdAt: command.now,
    updatedAt: command.now,
  }
  return executeDirectConfigurationTransaction(
    db,
    commandMeta,
    configurationLockNames(
      ['preset-catalog', `preset:${provisional.id}`, `profile:${profileId}`],
      configurationLinksForPreset(provisional),
    ),
    configurationTransaction(
      CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
      CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY,
      'presets',
      PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY,
      'profiles',
    ),
    async (tx) => {
      const currentProfile = await tx.table<ConnectionProfile, ProfileId>('profiles').get(profileId)
      if (!currentProfile) {
        return { kind: 'missing', entity: 'profile', id: profileId } as const
      }
      const presets = tx.table<ChatPreset, PresetId>('presets')
      if (await presets.get(provisional.id)) {
        return { kind: 'conflict', reason: 'link-changed' } as const
      }
      const preset: ChatPreset = {
        ...provisional,
        settings: withProfileApiDefaults(
          { ...normalizeChatSettings(command.preset.settings), profileId: currentProfile.id },
          currentProfile,
        ),
      }
      await addLinkedSemanticByteOwner(tx, 'presets', preset)
      await appendPresetOrderEntry(tx, preset.id)
      await putConfigurationPresetCatalogProjection(tx, preset)

      return {
        kind: 'chat-preset-saved',
        preset,
        affectedPresetIds: [preset.id],
      } as const
    },
  )
}

async function updateChatPreset(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.update' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.update'>> {
  type Current = { readonly preset: ChatPreset; readonly profile: ConnectionProfile }
  return executeRevalidatedConfigurationPlan<
    Current,
    ConfigurationDomainResult<'chat-preset.update'>
  >(db, commandMeta, async () => {
    const [preset, ownerLinks] = await Promise.all([
      db.table<ChatPreset, PresetId>('presets').get(command.presetId),
      readOwnerLinks(db, 'chat-preset', command.presetId),
    ])
    if (!preset) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'chat-preset',
        id: command.presetId,
      } as const)
    }
    const profileId = command.patch.connectionProfileId ?? preset.connectionProfileId
    const profile = await db.table<ConnectionProfile, ProfileId>('profiles').get(profileId)
    if (!profile) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'profile',
        id: profileId,
      } as const)
    }
    const projected = configuredPreset(preset, command.patch, profile, command.now)
    const nextLinks = configurationLinksForPreset(projected)
    return preparedConfigurationPlan({
      lockNames: configurationLockNames(
        [`preset:${preset.id}`, `profile:${profile.id}`],
        [...ownerLinks, ...nextLinks],
      ),
      transaction: configurationTransaction(
        CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
        CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY,
        'presets',
        'profiles',
      ),
      async revalidate(tx) {
        const current = await tx.table<ChatPreset, PresetId>('presets').get(preset.id)
        if (!current) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'chat-preset',
            id: preset.id,
          } as const)
        }
        if (!sameValue(current, preset)) return configurationPlanRetry()
        const currentLinks = await readOwnerLinksFromTransaction(tx, 'chat-preset', preset.id)
        if (!sameLinkIds(ownerLinks, currentLinks)) return configurationPlanRetry()
        const currentProfile = await tx
          .table<ConnectionProfile, ProfileId>('profiles')
          .get(profile.id)
        if (!currentProfile) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'profile',
            id: profile.id,
          } as const)
        }
        if (!sameValue(currentProfile, profile)) return configurationPlanRetry()
        return configurationPlanReady({ preset: current, profile: currentProfile })
      },
      async commit(tx, current) {
        const next = configuredPreset(current.preset, command.patch, current.profile, command.now)
        await replaceLinkedSemanticByteOwner(tx, 'presets', next, current.preset)
        await putConfigurationPresetCatalogProjection(tx, next)

        return {
          kind: 'chat-preset-saved',
          preset: next,
          affectedPresetIds: [next.id],
        } as const
      },
    })
  })
}

async function duplicateChatPreset(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.duplicate' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.duplicate'>> {
  return executeRevalidatedConfigurationPlan<
    ChatPreset,
    ConfigurationDomainResult<'chat-preset.duplicate'>
  >(db, commandMeta, async () => {
    const [source, ownerLinks] = await Promise.all([
      db.table<ChatPreset, PresetId>('presets').get(command.sourceId),
      readOwnerLinks(db, 'chat-preset', command.sourceId),
    ])
    if (!source) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'chat-preset',
        id: command.sourceId,
      } as const)
    }
    const copy: ChatPreset = {
      ...structuredClone(source),
      id: command.copyId,
      name: command.name ?? `${source.name} (copy)`,
      createdAt: command.now,
      updatedAt: command.now,
      archived: false,
    }
    delete copy.lastUsedAt
    const nextLinks = configurationLinksForPreset(copy)
    return preparedConfigurationPlan({
      lockNames: configurationLockNames(
        ['preset-catalog', `preset:${source.id}`, `preset:${copy.id}`],
        [...ownerLinks, ...nextLinks],
      ),
      transaction: configurationTransaction(
        CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
        CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY,
        'presets',
        PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY,
      ),
      async revalidate(tx) {
        const presets = tx.table<ChatPreset, PresetId>('presets')
        const current = await presets.get(source.id)
        if (!current) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'chat-preset',
            id: source.id,
          } as const)
        }
        if (!sameValue(current, source)) return configurationPlanRetry()
        const currentLinks = await readOwnerLinksFromTransaction(tx, 'chat-preset', source.id)
        if (!sameLinkIds(ownerLinks, currentLinks)) return configurationPlanRetry()
        return configurationPlanReady(current)
      },
      async commit(tx, current) {
        const presets = tx.table<ChatPreset, PresetId>('presets')
        if (await presets.get(copy.id)) {
          return { kind: 'conflict', reason: 'link-changed' } as const
        }
        const preset = {
          ...current,
          id: command.copyId,
          name: command.name ?? `${current.name} (copy)`,
          createdAt: command.now,
          updatedAt: command.now,
          archived: false,
        }
        delete preset.lastUsedAt
        await addLinkedSemanticByteOwner(tx, 'presets', preset)
        await appendPresetOrderEntry(tx, preset.id)
        await putConfigurationPresetCatalogProjection(tx, preset)

        return {
          kind: 'chat-preset-saved',
          preset,
          affectedPresetIds: [preset.id],
        } as const
      },
    })
  })
}

async function moveChatPreset(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.move' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.move'>> {
  if (command.afterPresetId === command.presetId) {
    return { kind: 'invalid', reason: 'preset-order-anchor-self' }
  }
  return executeDirectConfigurationTransaction(
    db,
    commandMeta,
    [
      'preset-catalog',
      `preset:${command.presetId}`,
      ...(command.afterPresetId ? [`preset:${command.afterPresetId}`] : []),
    ],
    configurationTransaction('presets', PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY),
    async (tx) => {
      const table = tx.table<ChatPreset, PresetId>('presets')
      const [current, after] = await Promise.all([
        table.get(command.presetId),
        command.afterPresetId ? table.get(command.afterPresetId) : undefined,
      ])
      if (!current) {
        return { kind: 'missing', entity: 'chat-preset', id: command.presetId }
      }
      if (current.archived === true) {
        return { kind: 'invalid', reason: 'preset-order-target-archived' }
      }
      if (command.afterPresetId && !after) {
        return { kind: 'missing', entity: 'chat-preset', id: command.afterPresetId }
      }
      if (after?.archived === true) {
        return { kind: 'invalid', reason: 'preset-order-anchor-archived' }
      }
      const changed = await movePresetOrderEntry(tx, current.id, command.afterPresetId)
      if (!changed) return { kind: 'configuration-noop' }
      return {
        kind: 'chat-preset-saved',
        preset: current,
        affectedPresetIds: [current.id],
      }
    },
  )
}

async function setChatPresetArchived(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.set-archived' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.set-archived'>> {
  return executeRevalidatedConfigurationPlan<
    ChatPreset | undefined,
    ConfigurationDomainResult<'chat-preset.set-archived'>
  >(db, commandMeta, async () => {
    const planned = await db.table<ChatPreset, PresetId>('presets').get(command.presetId)
    const usageResources = planned
      ? configurationProfileUsageResourceNamesForLinks(configurationLinksForPreset(planned))
      : []
    return preparedConfigurationPlan({
      lockNames: ['preset-catalog', `preset:${command.presetId}`, ...usageResources],
      transaction: configurationTransaction(
        CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
        CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY,
        'presets',
        PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY,
      ),
      async revalidate(tx) {
        const current = await tx.table<ChatPreset, PresetId>('presets').get(command.presetId)
        if (current?.connectionProfileId !== planned?.connectionProfileId) {
          return configurationPlanRetry()
        }
        return configurationPlanReady(current)
      },
      async commit(tx, current) {
        if (!current) {
          return { kind: 'missing', entity: 'chat-preset', id: command.presetId }
        }
        if ((current.archived === true) === command.archived) {
          return { kind: 'configuration-noop' }
        }
        const preset: ChatPreset = {
          ...current,
          archived: command.archived,
          updatedAt: command.now,
        }
        await replaceLinkedSemanticByteOwner(tx, 'presets', preset, current)
        if (command.archived) {
          await removePresetOrderEntry(tx, preset.id)
        } else {
          await appendPresetOrderEntry(tx, preset.id)
        }
        await putConfigurationPresetCatalogProjection(tx, preset)

        return {
          kind: 'chat-preset-saved',
          preset,
          affectedPresetIds: [preset.id],
        }
      },
    })
  })
}

async function touchChatPreset(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.touch' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.touch'>> {
  return executeDirectConfigurationTransaction(
    db,
    commandMeta,
    [`preset:${command.presetId}`],
    configurationTransaction(CONFIGURATION_PRESET_RECENCY_TRANSACTION_CAPABILITY, 'presets'),
    async (tx) => {
      const table = tx.table<ChatPreset, PresetId>('presets')
      const current = await table.get(command.presetId)
      if (!current) return { kind: 'missing', entity: 'chat-preset', id: command.presetId }
      const lastUsedAt = Math.max(current.lastUsedAt ?? 0, command.now)
      if (lastUsedAt === current.lastUsedAt) {
        return { kind: 'chat-preset-saved', preset: current, affectedPresetIds: [] }
      }
      const preset = { ...current, lastUsedAt }
      await replaceLinkedSemanticByteOwner(tx, 'presets', preset, current)
      await putConfigurationPresetRecencyCatalogProjection(tx, preset)
      return { kind: 'chat-preset-saved', preset, affectedPresetIds: [preset.id] }
    },
  )
}

async function deleteChatPreset(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.delete' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.delete'>> {
  const targetKey = configurationTargetKey('chat-preset', command.presetId)
  type Current = {
    readonly preset: ChatPreset
    readonly targetLinks: readonly ConfigurationLink[]
  }
  return executeRevalidatedConfigurationPlan<
    Current,
    ConfigurationDomainResult<'chat-preset.delete'>
  >(db, commandMeta, async () => {
    const [preset, ownerLinks, targetLinks] = await Promise.all([
      db.table<ChatPreset, PresetId>('presets').get(command.presetId),
      readOwnerLinks(db, 'chat-preset', command.presetId),
      readTargetLinks(db, 'chat-preset', command.presetId),
    ])
    if (!preset) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'chat-preset',
        id: command.presetId,
      } as const)
    }
    const chatIds = targetLinks.flatMap((link) => (link.ownerKind === 'chat' ? [link.ownerId] : []))
    return preparedConfigurationPlan({
      lockNames: [
        'preset-catalog',
        `configuration-target:${targetKey}`,
        `preset:${preset.id}`,
        ...chatIds.map((chatId) => `chat-meta:${chatId}`),
        ...ownerLinks.map((link) => `configuration-target:${link.targetKey}`),
      ],
      transaction: configurationTransaction(
        CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
        CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
        CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY,
        'presets',
        PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY,
      ),
      async revalidate(tx) {
        const currentPreset = await tx.table<ChatPreset, PresetId>('presets').get(preset.id)
        if (!currentPreset) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'chat-preset',
            id: preset.id,
          } as const)
        }
        if (!sameValue(currentPreset, preset)) return configurationPlanRetry()
        const currentOwnerLinks = await readOwnerLinksFromTransaction(tx, 'chat-preset', preset.id)
        if (!sameLinkIds(ownerLinks, currentOwnerLinks)) return configurationPlanRetry()
        const currentTargetLinks = await readTargetLinksFromTransaction(
          tx,
          'chat-preset',
          preset.id,
        )
        if (!sameLinkIds(targetLinks, currentTargetLinks)) return configurationPlanRetry()
        return configurationPlanReady({ preset: currentPreset, targetLinks: currentTargetLinks })
      },
      async commit(tx, current) {
        const affectedChatIds: ChatId[] = []
        const chatWrites: Array<{ previous: Chat; next: Chat }> = []
        const configuredChatIds = new Set<ChatId>()
        const chatClock = new TransactionChatUpdateClock()
        for (const link of current.targetLinks) {
          if (link.ownerKind !== 'chat') continue
          const chatId = link.ownerId
          if (configuredChatIds.has(chatId)) continue
          configuredChatIds.add(chatId)
          const chat = await tx.table<Chat, ChatId>('chats').get(chatId)
          if (!chat) throw new Error(`ConfigurationLinkOwnerMissing:${link.ownerKey}`)
          const transformed = { ...chat }
          delete transformed.presetId
          const written = await configuredChat(tx, chat, transformed, command.now, chatClock)
          chatWrites.push({ previous: chat, next: written })
          affectedChatIds.push(written.id)
        }
        await applyChatRowWriteTransitions(
          tx,
          chatWrites.map(({ previous, next }) => ({
            kind: 'replace-linked',
            previous,
            next,
          })),
        )
        if (current.preset.archived !== true) {
          await removePresetOrderEntry(tx, current.preset.id)
        }
        await deleteLinkedSemanticByteOwner(tx, 'presets', preset.id, current.preset)
        await deleteConfigurationPresetCatalogProjection(tx, preset.id)

        await deletePhysicalStorageCollection(
          tx,
          'configurationLinks',
          tx
            .table<ConfigurationLink, string>('configurationLinks')
            .where('targetKey')
            .equals(targetKey),
        )
        return {
          kind: 'chat-preset-saved',
          preset: current.preset,
          affectedPresetIds: [current.preset.id],
          affectedChatIds,
          ...(affectedChatIds.length === 1
            ? { chatId: affectedChatIds[0], chatChanged: true }
            : {}),
        } as const
      },
    })
  })
}

function configuredPreset(
  current: ChatPreset,
  patch: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.update' }>['patch'],
  profile: ConnectionProfile,
  now: number,
): ChatPreset {
  const next: ChatPreset = {
    ...current,
    ...structuredClone(patch),
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: now,
  }
  if (patch.connectionProfileId !== undefined || patch.settings !== undefined) {
    next.connectionProfileId = profile.id
    next.settings = withProfileApiDefaults(
      { ...normalizeChatSettings(next.settings), profileId: profile.id },
      profile,
    )
  }
  return next
}

async function createAndLinkChatPreset(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.create-and-link' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.create-and-link'>> {
  if (command.preset.connectionProfileId !== command.preset.settings.profileId) {
    return { kind: 'invalid', reason: 'preset-profile-mismatch' }
  }
  type Current = { readonly chat: Chat; readonly profile: ConnectionProfile }
  return executeRevalidatedConfigurationPlan<
    Current,
    ConfigurationDomainResult<'chat-preset.create-and-link'>
  >(db, commandMeta, async () => {
    const [profile, chat, chatLinks] = await Promise.all([
      db.table<ConnectionProfile, ProfileId>('profiles').get(command.preset.connectionProfileId),
      db.table<Chat, ChatId>('chats').get(command.chatId),
      readOwnerLinks(db, 'chat', command.chatId),
    ])
    if (!profile) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'profile',
        id: command.preset.connectionProfileId,
      } as const)
    }
    if (!chat) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'chat',
        id: command.chatId,
      } as const)
    }
    const projectedChat = withModelResolutionCancellation(
      { ...chat, presetId: command.preset.id },
      true,
    )
    const provisionalPreset: ChatPreset = {
      ...structuredClone(command.preset),
      settings: withProfileApiDefaults(
        normalizeChatSettings(structuredClone(command.preset.settings)),
        profile,
      ),
      createdAt: command.now,
      updatedAt: command.now,
    }
    const nextLinks = [
      ...configurationLinksForChat(projectedChat),
      ...configurationLinksForPreset(provisionalPreset),
    ]
    return preparedConfigurationPlan({
      lockNames: configurationLockNames(
        [
          'preset-catalog',
          `chat-meta:${chat.id}`,
          `preset:${command.preset.id}`,
          `profile:${profile.id}`,
        ],
        [...chatLinks, ...nextLinks],
      ),
      transaction: configurationTransaction(
        CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
        CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
        CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY,
        'presets',
        PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY,
        'profiles',
      ),
      async revalidate(tx) {
        const currentProfile = await tx
          .table<ConnectionProfile, ProfileId>('profiles')
          .get(profile.id)
        if (!currentProfile) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'profile',
            id: profile.id,
          } as const)
        }
        if (!sameValue(currentProfile, profile)) return configurationPlanRetry()
        const current = await tx.table<Chat, ChatId>('chats').get(chat.id)
        if (!current) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'chat',
            id: chat.id,
          } as const)
        }
        if ((current.configurationVersion ?? 0) !== (chat.configurationVersion ?? 0)) {
          return configurationPlanRetry()
        }
        const currentLinks = await readOwnerLinksFromTransaction(tx, 'chat', chat.id)
        if (!sameLinkIds(chatLinks, currentLinks)) return configurationPlanRetry()
        return configurationPlanReady({ chat: current, profile: currentProfile })
      },
      async commit(tx, current) {
        const presets = tx.table<ChatPreset, PresetId>('presets')
        if (await presets.get(command.preset.id)) {
          return { kind: 'conflict', reason: 'link-changed' } as const
        }
        const preset: ChatPreset = {
          ...structuredClone(command.preset),
          settings: withProfileApiDefaults(
            normalizeChatSettings(structuredClone(command.preset.settings)),
            current.profile,
          ),
          createdAt: command.now,
          updatedAt: command.now,
        }
        const writtenChat = await configuredChat(
          tx,
          current.chat,
          withModelResolutionCancellation({ ...current.chat, presetId: preset.id }, true),
          command.now,
        )
        await addLinkedSemanticByteOwner(tx, 'presets', preset)
        await appendPresetOrderEntry(tx, preset.id)
        await putConfigurationPresetCatalogProjection(tx, preset)
        await applyChatRowWriteTransitions(tx, [
          { kind: 'replace-linked', previous: current.chat, next: writtenChat },
        ])

        return {
          kind: 'chat-preset-saved',
          preset,
          chatId: writtenChat.id,
          chatChanged: true,
          configurationVersion: writtenChat.configurationVersion ?? 0,
          affectedPresetIds: [preset.id],
        } as const
      },
    })
  })
}

async function applyChatPreset(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.apply' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.apply'>> {
  type Current = { readonly chat: Chat; readonly preset: ChatPreset }
  return executeRevalidatedConfigurationPlan<
    Current,
    ConfigurationDomainResult<'chat-preset.apply'>
  >(db, commandMeta, async () => {
    const [preset, chat, chatLinks] = await Promise.all([
      db.table<ChatPreset, PresetId>('presets').get(command.presetId),
      db.table<Chat, ChatId>('chats').get(command.chatId),
      readOwnerLinks(db, 'chat', command.chatId),
    ])
    if (!preset) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'chat-preset',
        id: command.presetId,
      } as const)
    }
    if (!chat) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'chat',
        id: command.chatId,
      } as const)
    }
    const projected = withModelResolutionCancellation(
      {
        ...chat,
        settings: normalizeChatSettings(structuredClone(preset.settings)),
        presetId: preset.id,
      },
      true,
    )
    const lockNames = configurationLockNames(
      [`chat-meta:${chat.id}`, `preset:${preset.id}`, `profile:${preset.connectionProfileId}`],
      [...chatLinks, ...configurationLinksForChat(projected)],
    )
    return preparedConfigurationPlan<Current, ConfigurationDomainResult<'chat-preset.apply'>>({
      lockNames,
      transaction: configurationTransaction(CHAT_ROW_LINKED_TRANSACTION_CAPABILITY, 'presets'),
      async revalidate(tx) {
        const currentPreset = await tx.table<ChatPreset, PresetId>('presets').get(preset.id)
        if (!currentPreset) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'chat-preset',
            id: preset.id,
          } as const)
        }
        if (!sameValue(currentPreset, preset)) return configurationPlanRetry()
        const currentChat = await tx.table<Chat, ChatId>('chats').get(chat.id)
        if (!currentChat) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'chat',
            id: chat.id,
          } as const)
        }
        if ((currentChat.configurationVersion ?? 0) !== (chat.configurationVersion ?? 0)) {
          return configurationPlanRetry()
        }
        const currentLinks = await readOwnerLinksFromTransaction(tx, 'chat', chat.id)
        if (!sameLinkIds(chatLinks, currentLinks)) return configurationPlanRetry()
        return configurationPlanReady({ chat: currentChat, preset: currentPreset })
      },
      async commit(tx, current) {
        const transformed = withModelResolutionCancellation(
          {
            ...current.chat,
            settings: normalizeChatSettings(structuredClone(current.preset.settings)),
            presetId: current.preset.id,
          },
          true,
        )
        const changed = chatConfigurationChanged(current.chat, transformed)
        const written = changed
          ? await configuredChat(tx, current.chat, transformed, command.now)
          : current.chat
        if (changed) {
          await applyChatRowWriteTransitions(tx, [
            { kind: 'replace-linked', previous: current.chat, next: written },
          ])
        }
        return {
          kind: 'chat-preset-saved',
          preset: current.preset,
          chatId: written.id,
          chatChanged: changed,
          configurationVersion: written.configurationVersion ?? 0,
          affectedPresetIds: [current.preset.id],
        }
      },
    })
  })
}

async function saveChatPreset(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'chat-preset.save' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'chat-preset.save'>> {
  type Current = {
    readonly preset: ChatPreset
    readonly profile: ConnectionProfile
    readonly chat: Chat | undefined
  }
  return executeRevalidatedConfigurationPlan<
    Current,
    ConfigurationDomainResult<'chat-preset.save'>
  >(db, commandMeta, async () => {
    const [preset, presetLinks, profile, chat, chatLinks] = await Promise.all([
      db.table<ChatPreset, PresetId>('presets').get(command.presetId),
      readOwnerLinks(db, 'chat-preset', command.presetId),
      db.table<ConnectionProfile, ProfileId>('profiles').get(command.settings.profileId),
      command.chatModel
        ? db.table<Chat, ChatId>('chats').get(command.chatModel.chatId)
        : Promise.resolve(undefined),
      command.chatModel
        ? readOwnerLinks(db, 'chat', command.chatModel.chatId)
        : Promise.resolve([]),
    ])
    if (!preset) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'chat-preset',
        id: command.presetId,
      } as const)
    }
    if (preset.connectionProfileId !== command.settings.profileId) {
      return preparedConfigurationResult({
        kind: 'invalid',
        reason: 'preset-profile-mismatch',
      } as const)
    }
    if (!profile) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'profile',
        id: command.settings.profileId,
      } as const)
    }
    if (command.chatModel && !chat) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'chat',
        id: command.chatModel.chatId,
      } as const)
    }
    const writtenPreset: ChatPreset = {
      ...preset,
      settings: withProfileApiDefaults(
        normalizeChatSettings(structuredClone(command.settings)),
        profile,
      ),
      updatedAt: command.now,
    }
    const projectedChat =
      chat && command.chatModel
        ? withModelResolutionCancellation(
            {
              ...chat,
              settings: { ...chat.settings, model: command.chatModel.modelId },
            },
            true,
          )
        : undefined
    const nextLinks = [
      ...configurationLinksForPreset(writtenPreset),
      ...(projectedChat ? configurationLinksForChat(projectedChat) : []),
    ]
    return preparedConfigurationPlan({
      lockNames: configurationLockNames(
        [`preset:${preset.id}`, `profile:${profile.id}`, ...(chat ? [`chat-meta:${chat.id}`] : [])],
        [...presetLinks, ...chatLinks, ...nextLinks],
      ),
      transaction: configurationTransaction(
        CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
        'presets',
        'profiles',
      ),
      async revalidate(tx) {
        const currentProfile = await tx
          .table<ConnectionProfile, ProfileId>('profiles')
          .get(profile.id)
        if (!currentProfile) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'profile',
            id: profile.id,
          } as const)
        }
        if (!sameValue(currentProfile, profile)) return configurationPlanRetry()
        const currentPreset = await tx.table<ChatPreset, PresetId>('presets').get(preset.id)
        if (!currentPreset) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'chat-preset',
            id: preset.id,
          } as const)
        }
        if (!sameValue(currentPreset, preset)) return configurationPlanRetry()
        const currentPresetLinks = await readOwnerLinksFromTransaction(tx, 'chat-preset', preset.id)
        if (!sameLinkIds(presetLinks, currentPresetLinks)) return configurationPlanRetry()
        let currentChat: Chat | undefined
        if (chat && command.chatModel) {
          currentChat = await tx.table<Chat, ChatId>('chats').get(chat.id)
          if (!currentChat) {
            return configurationPlanReturn({
              kind: 'missing',
              entity: 'chat',
              id: chat.id,
            } as const)
          }
          if ((currentChat.configurationVersion ?? 0) !== (chat.configurationVersion ?? 0)) {
            return configurationPlanRetry()
          }
          const currentChatLinks = await readOwnerLinksFromTransaction(tx, 'chat', chat.id)
          if (!sameLinkIds(chatLinks, currentChatLinks)) return configurationPlanRetry()
        }
        return configurationPlanReady({
          preset: currentPreset,
          profile: currentProfile,
          chat: currentChat,
        })
      },
      async commit(tx, current) {
        const nextPreset: ChatPreset = {
          ...current.preset,
          settings: withProfileApiDefaults(
            normalizeChatSettings(structuredClone(command.settings)),
            current.profile,
          ),
          updatedAt: command.now,
        }
        await replaceLinkedSemanticByteOwner(tx, 'presets', nextPreset, current.preset)

        let writtenChat: Chat | undefined
        if (current.chat && command.chatModel) {
          const transformed = withModelResolutionCancellation(
            {
              ...current.chat,
              settings: { ...current.chat.settings, model: command.chatModel.modelId },
            },
            true,
          )
          if (chatConfigurationChanged(current.chat, transformed)) {
            writtenChat = await configuredChat(tx, current.chat, transformed, command.now)
            await applyChatRowWriteTransitions(tx, [
              { kind: 'replace-linked', previous: current.chat, next: writtenChat },
            ])
          }
        }
        return {
          kind: 'chat-preset-saved',
          preset: nextPreset,
          ...(writtenChat
            ? {
                chatId: writtenChat.id,
                chatChanged: true,
                configurationVersion: writtenChat.configurationVersion ?? 0,
              }
            : {}),
          affectedPresetIds: [nextPreset.id],
        } as const
      },
    })
  })
}

async function commitLocalPrompt(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.local-commit' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.local-commit'>> {
  const result = await mutateChatConfiguration(
    db,
    command.chatId,
    command.now,
    [],
    [],
    (chat) => ({
      ...chat,
      settings: applyLocalPromptValue(chat.settings, command.slot, command.text),
    }),
    commandMeta,
  )
  if (result.kind !== 'chat-updated') return result
  return {
    kind: 'prompt-preset-saved',
    chatId: result.chatId,
    configurationVersion: result.configurationVersion,
    affectedChatIds: result.changed ? [result.chatId] : [],
    affectedChatCount: result.changed ? 1 : 0,
  }
}

async function loadAndPinPrompt(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.load-and-pin' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.load-and-pin'>> {
  return mutateChatConfigurationWithTables(
    db,
    command.chatId,
    command.now,
    [
      `configuration-target:${configurationTargetKey('prompt-preset', command.presetId)}`,
      `prompt-preset:${command.presetId}`,
    ],
    [CONFIGURATION_PROMPT_PRESET_RECENCY_TRANSACTION_CAPABILITY, 'promptPresets'],
    async (tx, chat) => {
      const currentPreset = await tx
        .table<PromptPreset, PromptPresetId>('promptPresets')
        .get(command.presetId)
      if (!currentPreset) {
        return { kind: 'missing', entity: 'prompt-preset', id: command.presetId } as const
      }
      const slot = promptPresetSlotForKind(currentPreset.kind)
      const settings = { ...chat.settings }
      ;(settings as unknown as Record<string, unknown>)[slot.textKey] = currentPreset.text
      ;(settings as unknown as Record<string, unknown>)[slot.pinKey] = currentPreset.id
      const touched =
        (currentPreset.lastUsedAt ?? 0) >= command.now
          ? currentPreset
          : { ...currentPreset, lastUsedAt: command.now }
      if (touched !== currentPreset) {
        await replaceSemanticByteOwner(tx, 'promptPresets', touched, currentPreset)
        await putConfigurationPromptPresetRecencyCatalogProjection(tx, touched)
      }
      const transformedChat = withModelResolutionCancellation({ ...chat, settings }, true)
      return {
        chat: transformedChat,
        wroteExternal: touched !== currentPreset,
        result: (written: Chat, changed: boolean) => ({
          kind: 'prompt-preset-saved' as const,
          preset: touched,
          chatId: written.id,
          configurationVersion: written.configurationVersion ?? 0,
          affectedChatIds: changed ? [written.id] : [],
          affectedChatCount: changed ? 1 : 0,
        }),
      }
    },
    commandMeta,
  )
}

async function overwriteAndPinPrompt(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.overwrite-and-pin' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.overwrite-and-pin'>> {
  return mutatePromptTargetLinks(
    db,
    command.presetId,
    command.chatId,
    commandMeta,
    async (tx, preset, links) => {
      const slot = promptPresetSlotForKind(preset.kind)
      const nextPreset: PromptPreset = {
        ...preset,
        text: command.text,
        updatedAt: command.now,
        lastUsedAt: command.now,
      }
      await replaceSemanticByteOwner(tx, 'promptPresets', nextPreset, preset)
      await putConfigurationPromptPresetCatalogProjection(tx, nextPreset)
      const affectedChatIds = new Set<ChatId>()
      const affectedPresetIds = new Set<PresetId>()
      const stagedChats = new Map<ChatId, { previous: Chat; transformed: Chat }>()
      for (const link of links) {
        if (link.ownerKind === 'chat') {
          const chatId = link.ownerId
          const stored = await tx.table<Chat, ChatId>('chats').get(chatId)
          if (!stored) throw new Error(`ConfigurationLinkOwnerMissing:${link.ownerKey}`)
          const current = stagedChats.get(chatId)?.transformed ?? stored
          const settings = { ...current.settings }
          ;(settings as unknown as Record<string, unknown>)[slot.textKey] = command.text
          const transformed = withModelResolutionCancellation({ ...current, settings }, true)
          if (!chatConfigurationChanged(current, transformed)) continue
          stagedChats.set(chatId, {
            previous: stagedChats.get(chatId)?.previous ?? stored,
            transformed,
          })
          affectedChatIds.add(chatId)
        } else if (link.ownerKind === 'chat-preset') {
          const chatPreset = await tx.table<ChatPreset, PresetId>('presets').get(link.ownerId)
          if (!chatPreset) throw new Error(`ConfigurationLinkOwnerMissing:${link.ownerKey}`)
          const settings = { ...chatPreset.settings }
          ;(settings as unknown as Record<string, unknown>)[slot.textKey] = command.text
          const nextChatPreset: ChatPreset = {
            ...chatPreset,
            settings,
            updatedAt: command.now,
          }
          await replaceLinkedSemanticByteOwner(tx, 'presets', nextChatPreset, chatPreset)
          affectedPresetIds.add(chatPreset.id)
        }
      }
      const storedCurrentChat = await tx.table<Chat, ChatId>('chats').get(command.chatId)
      if (!storedCurrentChat) return { kind: 'missing', entity: 'chat', id: command.chatId }
      const currentChat = stagedChats.get(command.chatId)?.transformed ?? storedCurrentChat
      const settings = { ...currentChat.settings }
      ;(settings as unknown as Record<string, unknown>)[slot.textKey] = command.text
      ;(settings as unknown as Record<string, unknown>)[slot.pinKey] = preset.id
      const transformed = withModelResolutionCancellation({ ...currentChat, settings }, true)
      let configurationVersion = currentChat.configurationVersion ?? 0
      if (chatConfigurationChanged(currentChat, transformed)) {
        stagedChats.set(command.chatId, {
          previous: stagedChats.get(command.chatId)?.previous ?? storedCurrentChat,
          transformed,
        })
        affectedChatIds.add(command.chatId)
      }
      const chatClock = new TransactionChatUpdateClock()
      const chatWrites: Array<{ previous: Chat; next: Chat }> = []
      for (const { previous, transformed: next } of stagedChats.values()) {
        const written = await configuredChat(tx, previous, next, command.now, chatClock)
        chatWrites.push({ previous, next: written })
        if (written.id === command.chatId) {
          configurationVersion = written.configurationVersion ?? 0
        }
      }
      await applyChatRowWriteTransitions(
        tx,
        chatWrites.map(({ previous, next }) => ({
          kind: 'replace-linked',
          previous,
          next,
        })),
      )
      return {
        kind: 'prompt-preset-saved',
        preset: nextPreset,
        chatId: command.chatId,
        configurationVersion,
        affectedChatIds: [...affectedChatIds],
        affectedPresetIds: [...affectedPresetIds],
        affectedChatCount: affectedChatIds.size,
        affectedPresetCount: affectedPresetIds.size,
      }
    },
  )
}

async function createAndPinPrompt(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.create-and-pin' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.create-and-pin'>> {
  const slot = promptPresetSlotForKind(command.preset.kind)
  return mutateChatConfigurationWithTables(
    db,
    command.chatId,
    command.now,
    [
      `configuration-target:${configurationTargetKey('prompt-preset', command.preset.id)}`,
      `prompt-preset:${command.preset.id}`,
    ],
    [CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY, 'promptPresets'],
    async (tx, chat) => {
      const prompts = tx.table<PromptPreset, PromptPresetId>('promptPresets')
      if (await prompts.get(command.preset.id)) {
        return { kind: 'conflict', reason: 'link-changed' } as const
      }
      const preset = structuredClone(command.preset)
      await addSemanticByteOwner(tx, 'promptPresets', preset)
      await putConfigurationPromptPresetCatalogProjection(tx, preset)
      const settings = { ...chat.settings }
      ;(settings as unknown as Record<string, unknown>)[slot.textKey] = preset.text
      ;(settings as unknown as Record<string, unknown>)[slot.pinKey] = preset.id
      return {
        chat: withModelResolutionCancellation({ ...chat, settings }, true),
        wroteExternal: true,
        result: (written: Chat) => ({
          kind: 'prompt-preset-saved' as const,
          preset,
          chatId: written.id,
          configurationVersion: written.configurationVersion ?? 0,
          affectedChatIds: [written.id],
          affectedChatCount: 1,
        }),
      }
    },
    commandMeta,
  )
}

async function renamePromptPreset(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.rename' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.rename'>> {
  return executeDirectConfigurationTransaction(
    db,
    commandMeta,
    [`prompt-preset:${command.presetId}`],
    configurationTransaction(
      CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY,
      'promptPresets',
    ),
    async (tx) => {
      const table = tx.table<PromptPreset, PromptPresetId>('promptPresets')
      const preset = await table.get(command.presetId)
      if (!preset) return { kind: 'missing', entity: 'prompt-preset', id: command.presetId }
      const name = command.name.trim()
      if (preset.name === name) return { kind: 'prompt-preset-saved', preset }
      const next = { ...preset, name, updatedAt: command.now }
      await replaceSemanticByteOwner(tx, 'promptPresets', next, preset)
      await putConfigurationPromptPresetCatalogProjection(tx, next)
      return { kind: 'prompt-preset-saved', preset: next }
    },
  )
}

async function putPromptPreset(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.put' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.put'>> {
  return executeDirectConfigurationTransaction(
    db,
    commandMeta,
    [`prompt-preset:${command.preset.id}`],
    configurationTransaction(
      CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY,
      'promptPresets',
    ),
    async (tx) => {
      const table = tx.table<PromptPreset, PromptPresetId>('promptPresets')
      const current = await table.get(command.preset.id)
      const preset = structuredClone(command.preset)
      if (sameValue(current, preset)) return { kind: 'prompt-preset-saved', preset }
      await putSemanticByteOwner(tx, 'promptPresets', preset, current)
      await putConfigurationPromptPresetCatalogProjection(tx, preset)
      return { kind: 'prompt-preset-saved', preset }
    },
  )
}

async function updatePromptPreset(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.update' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.update'>> {
  type Current =
    | { readonly kind: 'metadata'; readonly preset: PromptPreset }
    | {
        readonly kind: 'propagate'
        readonly preset: PromptPreset
        readonly links: readonly ConfigurationLink[]
      }
  const targetKey = configurationTargetKey('prompt-preset', command.presetId)
  return executeRevalidatedConfigurationPlan<
    Current,
    ConfigurationDomainResult<'prompt-preset.update'>
  >(db, commandMeta, async () => {
    const preset = await db
      .table<PromptPreset, PromptPresetId>('promptPresets')
      .get(command.presetId)
    if (!preset) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'prompt-preset',
        id: command.presetId,
      } as const)
    }
    const propagatesText = command.patch.text !== undefined && command.patch.text !== preset.text
    if (!propagatesText) {
      return preparedConfigurationPlan({
        lockNames: [`prompt-preset:${preset.id}`],
        transaction: configurationTransaction(
          CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY,
          'promptPresets',
        ),
        async revalidate(tx) {
          const current = await tx
            .table<PromptPreset, PromptPresetId>('promptPresets')
            .get(preset.id)
          if (!current) {
            return configurationPlanReturn({
              kind: 'missing',
              entity: 'prompt-preset',
              id: preset.id,
            } as const)
          }
          return sameValue(current, preset)
            ? configurationPlanReady({ kind: 'metadata', preset: current } as const)
            : configurationPlanRetry()
        },
        async commit(tx, current) {
          const name = command.patch.name ?? current.preset.name
          if (name === current.preset.name) {
            return { kind: 'prompt-preset-saved', preset: current.preset }
          }
          const next = { ...current.preset, name, updatedAt: command.now }
          await replaceSemanticByteOwner(tx, 'promptPresets', next, current.preset)
          await putConfigurationPromptPresetCatalogProjection(tx, next)
          return { kind: 'prompt-preset-saved', preset: next }
        },
      })
    }
    const links = await readTargetLinks(db, 'prompt-preset', preset.id)
    const ownerLocks = links.map((link) => configurationOwnerLockName(link.ownerKind, link.ownerId))
    return preparedConfigurationPlan({
      lockNames: [`configuration-target:${targetKey}`, `prompt-preset:${preset.id}`, ...ownerLocks],
      transaction: configurationTransaction(
        CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
        CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
        CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY,
        'presets',
        'promptPresets',
      ),
      async revalidate(tx) {
        const currentPreset = await tx
          .table<PromptPreset, PromptPresetId>('promptPresets')
          .get(preset.id)
        if (!currentPreset) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'prompt-preset',
            id: preset.id,
          } as const)
        }
        if (!sameValue(currentPreset, preset)) return configurationPlanRetry()
        const currentLinks = await readTargetLinksFromTransaction(tx, 'prompt-preset', preset.id)
        if (!sameLinkIds(links, currentLinks)) return configurationPlanRetry()
        return configurationPlanReady({
          kind: 'propagate',
          preset: currentPreset,
          links: currentLinks,
        } as const)
      },
      async commit(tx, current) {
        const slot = promptPresetSlotForKind(current.preset.kind)
        const nextPreset: PromptPreset = {
          ...current.preset,
          ...(command.patch.name === undefined ? {} : { name: command.patch.name }),
          text: command.patch.text as string,
          updatedAt: command.now,
        }
        await replaceSemanticByteOwner(tx, 'promptPresets', nextPreset, current.preset)
        await putConfigurationPromptPresetCatalogProjection(tx, nextPreset)
        const affectedChatIds: ChatId[] = []
        const affectedPresetIds: PresetId[] = []
        const chatWrites: Array<{ previous: Chat; next: Chat }> = []
        const configuredChatIds = new Set<ChatId>()
        const chatClock = new TransactionChatUpdateClock()
        for (const link of current.links) {
          if (link.ownerKind === 'chat') {
            const chatId = link.ownerId
            if (configuredChatIds.has(chatId)) continue
            configuredChatIds.add(chatId)
            const chat = await tx.table<Chat, ChatId>('chats').get(chatId)
            if (!chat) throw new Error(`ConfigurationLinkOwnerMissing:${link.ownerKey}`)
            const settings = { ...chat.settings }
            ;(settings as unknown as Record<string, unknown>)[slot.textKey] = nextPreset.text
            const transformed = withModelResolutionCancellation({ ...chat, settings }, true)
            if (!chatConfigurationChanged(chat, transformed)) continue
            const written = await configuredChat(tx, chat, transformed, command.now, chatClock)
            chatWrites.push({ previous: chat, next: written })
            affectedChatIds.push(written.id)
          } else if (link.ownerKind === 'chat-preset') {
            const chatPreset = await tx.table<ChatPreset, PresetId>('presets').get(link.ownerId)
            if (!chatPreset) throw new Error(`ConfigurationLinkOwnerMissing:${link.ownerKey}`)
            const settings = { ...chatPreset.settings }
            ;(settings as unknown as Record<string, unknown>)[slot.textKey] = nextPreset.text
            const nextChatPreset: ChatPreset = {
              ...chatPreset,
              settings,
              updatedAt: command.now,
            }
            await replaceLinkedSemanticByteOwner(tx, 'presets', nextChatPreset, chatPreset)
            affectedPresetIds.push(chatPreset.id)
          }
        }
        await applyChatRowWriteTransitions(
          tx,
          chatWrites.map(({ previous, next }) => ({
            kind: 'replace-linked',
            previous,
            next,
          })),
        )
        return {
          kind: 'prompt-preset-saved',
          preset: nextPreset,
          affectedChatIds,
          affectedPresetIds,
          affectedChatCount: affectedChatIds.length,
          affectedPresetCount: affectedPresetIds.length,
        }
      },
    })
  })
}

async function touchPromptPreset(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.touch' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.touch'>> {
  return executeDirectConfigurationTransaction(
    db,
    commandMeta,
    [`prompt-preset:${command.presetId}`],
    configurationTransaction(
      CONFIGURATION_PROMPT_PRESET_RECENCY_TRANSACTION_CAPABILITY,
      'promptPresets',
    ),
    async (tx) => {
      const table = tx.table<PromptPreset, PromptPresetId>('promptPresets')
      const current = await table.get(command.presetId)
      if (!current) return { kind: 'missing', entity: 'prompt-preset', id: command.presetId }
      const lastUsedAt = Math.max(current.lastUsedAt ?? 0, command.now)
      if (lastUsedAt === current.lastUsedAt) {
        return { kind: 'prompt-preset-saved', preset: current }
      }
      const preset = { ...current, lastUsedAt }
      await replaceSemanticByteOwner(tx, 'promptPresets', preset, current)
      await putConfigurationPromptPresetRecencyCatalogProjection(tx, preset)
      return { kind: 'prompt-preset-saved', preset }
    },
  )
}

async function deletePromptPreset(
  db: Dexie,
  command: Extract<ConfigurationDomainCommand, { kind: 'prompt-preset.delete' }>,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<ConfigurationDomainResult<'prompt-preset.delete'>> {
  return mutatePromptTargetLinks(
    db,
    command.presetId,
    undefined,
    commandMeta,
    async (tx, preset, links) => {
      const slot = promptPresetSlotForKind(preset.kind)
      const affectedChatIds: ChatId[] = []
      const affectedPresetIds: PresetId[] = []
      const chatWrites: Array<{ previous: Chat; next: Chat }> = []
      const configuredChatIds = new Set<ChatId>()
      const chatClock = new TransactionChatUpdateClock()
      for (const link of links) {
        if (link.ownerKind === 'chat') {
          const chatId = link.ownerId
          if (configuredChatIds.has(chatId)) continue
          configuredChatIds.add(chatId)
          const chat = await tx.table<Chat, ChatId>('chats').get(chatId)
          if (!chat) throw new Error(`ConfigurationLinkOwnerMissing:${link.ownerKey}`)
          const settings = { ...chat.settings }
          delete (settings as Partial<ChatSettings>)[slot.pinKey]
          const written = await configuredChat(
            tx,
            chat,
            withModelResolutionCancellation({ ...chat, settings }, true),
            command.now,
            chatClock,
          )
          chatWrites.push({ previous: chat, next: written })
          affectedChatIds.push(written.id)
        } else if (link.ownerKind === 'chat-preset') {
          const chatPreset = await tx.table<ChatPreset, PresetId>('presets').get(link.ownerId)
          if (!chatPreset) throw new Error(`ConfigurationLinkOwnerMissing:${link.ownerKey}`)
          const settings = { ...chatPreset.settings }
          delete (settings as Partial<ChatSettings>)[slot.pinKey]
          const nextChatPreset: ChatPreset = {
            ...chatPreset,
            settings,
            updatedAt: command.now,
          }
          await replaceLinkedSemanticByteOwner(tx, 'presets', nextChatPreset, chatPreset)
          affectedPresetIds.push(chatPreset.id)
        }
      }
      await applyChatRowWriteTransitions(
        tx,
        chatWrites.map(({ previous, next }) => ({
          kind: 'replace-linked',
          previous,
          next,
        })),
      )
      await deleteSemanticByteOwner(tx, 'promptPresets', preset.id, preset)
      await deleteConfigurationPromptPresetCatalogProjection(tx, preset.id)
      await deletePhysicalStorageCollection(
        tx,
        'configurationLinks',
        tx
          .table<ConfigurationLink, string>('configurationLinks')
          .where('targetKey')
          .equals(configurationTargetKey('prompt-preset', preset.id)),
      )
      return {
        kind: 'prompt-preset-saved',
        affectedChatIds,
        affectedPresetIds,
        affectedChatCount: affectedChatIds.length,
        affectedPresetCount: affectedPresetIds.length,
      }
    },
  )
}

async function mutatePromptTargetLinks(
  db: Dexie,
  presetId: PromptPresetId,
  additionalChatId: ChatId | undefined,
  commandMeta: ConfigurationCommandMetaPort,
  mutate: (
    tx: Transaction,
    preset: PromptPreset,
    links: readonly ConfigurationLink[],
  ) => Promise<ConfigurationDomainResult<'prompt-preset.update'>>,
): Promise<ConfigurationDomainResult<'prompt-preset.update'>> {
  const targetKey = configurationTargetKey('prompt-preset', presetId)
  type Current = {
    readonly preset: PromptPreset
    readonly links: readonly ConfigurationLink[]
  }
  return executeRevalidatedConfigurationPlan<
    Current,
    ConfigurationDomainResult<'prompt-preset.update'>
  >(db, commandMeta, async () => {
    const [preset, links] = await Promise.all([
      db.table<PromptPreset, PromptPresetId>('promptPresets').get(presetId),
      readTargetLinks(db, 'prompt-preset', presetId),
    ])
    if (!preset) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'prompt-preset',
        id: presetId,
      } as const)
    }
    const ownerLocks = links.map((link) => configurationOwnerLockName(link.ownerKind, link.ownerId))
    if (additionalChatId) ownerLocks.push(`chat-meta:${additionalChatId}`)
    return preparedConfigurationPlan({
      lockNames: [`configuration-target:${targetKey}`, `prompt-preset:${preset.id}`, ...ownerLocks],
      transaction: configurationTransaction(
        CHAT_ROW_LINKED_TRANSACTION_CAPABILITY,
        CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY,
        CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY,
        'presets',
        'promptPresets',
      ),
      async revalidate(tx) {
        const currentPreset = await tx
          .table<PromptPreset, PromptPresetId>('promptPresets')
          .get(preset.id)
        if (!currentPreset) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'prompt-preset',
            id: preset.id,
          } as const)
        }
        if (!sameValue(currentPreset, preset)) return configurationPlanRetry()
        const currentLinks = await readTargetLinksFromTransaction(tx, 'prompt-preset', preset.id)
        if (!sameLinkIds(links, currentLinks)) return configurationPlanRetry()
        return configurationPlanReady({ preset: currentPreset, links: currentLinks })
      },
      async commit(tx, current) {
        return mutate(tx, current.preset, current.links)
      },
    })
  })
}

async function mutateChatConfigurationWithTables<Result extends ConfigurationDomainResult>(
  db: Dexie,
  chatId: ChatId,
  now: number,
  extraLockNames: readonly string[],
  extraTables: readonly (ConfigurationDirectTableName | PhysicalTransactionCapability)[],
  transform: (
    tx: Transaction,
    chat: Chat,
  ) => Promise<
    | {
        chat: Chat
        wroteExternal?: boolean
        result: (written: Chat, changed: boolean) => Result
      }
    | ConfigurationMutationFailure
  >,
  commandMeta: ConfigurationCommandMetaPort,
): Promise<Result | ConfigurationMutationFailure> {
  return executeRevalidatedConfigurationPlan(db, commandMeta, async () => {
    const [chat, ownerLinks] = await Promise.all([
      db.table<Chat, ChatId>('chats').get(chatId),
      readOwnerLinks(db, 'chat', chatId),
    ])
    if (!chat) {
      return preparedConfigurationResult({
        kind: 'missing',
        entity: 'chat',
        id: chatId,
      } as const)
    }
    return preparedConfigurationPlan<Chat, Result | ConfigurationMutationFailure>({
      lockNames: configurationLockNames([`chat-meta:${chat.id}`, ...extraLockNames], ownerLinks),
      transaction: configurationTransaction(CHAT_ROW_LINKED_TRANSACTION_CAPABILITY, ...extraTables),
      async revalidate(tx) {
        const current = await tx.table<Chat, ChatId>('chats').get(chat.id)
        if (!current) {
          return configurationPlanReturn({
            kind: 'missing',
            entity: 'chat',
            id: chat.id,
          } as const)
        }
        if ((current.configurationVersion ?? 0) !== (chat.configurationVersion ?? 0)) {
          return configurationPlanRetry()
        }
        const currentLinks = await readOwnerLinksFromTransaction(tx, 'chat', chat.id)
        if (!sameLinkIds(ownerLinks, currentLinks)) return configurationPlanRetry()
        return configurationPlanReady(current)
      },
      async commit(tx, current) {
        const transformed = await transform(tx, current)
        if (isConfigurationMutationFailureResult(transformed)) return transformed
        const changed = chatConfigurationChanged(current, transformed.chat)
        const written = changed ? await configuredChat(tx, current, transformed.chat, now) : current
        if (changed) {
          await applyChatRowWriteTransitions(tx, [
            { kind: 'replace-linked', previous: current, next: written },
          ])
        }
        return transformed.result(written, changed)
      },
    })
  })
}

async function configuredChat(
  tx: Transaction,
  current: Chat,
  transformed: Chat,
  now: number,
  clock: TransactionChatUpdateClock = new TransactionChatUpdateClock(),
): Promise<Chat> {
  return {
    ...transformed,
    id: current.id,
    createdAt: current.createdAt,
    settings: normalizeChatSettings(structuredClone(transformed.settings)),
    configurationVersion: (current.configurationVersion ?? 0) + 1,
    metaVersion: current.metaVersion + 1,
    summaryVersion: current.summaryVersion + 1,
    updatedAt: await clock.next(tx, now),
  }
}

function chatConfigurationChanged(current: Chat, next: Chat): boolean {
  return (
    !sameChatSettings(current.settings, next.settings) ||
    current.presetId !== next.presetId ||
    !sameValue(current.modelResolution, next.modelResolution)
  )
}

function chatUpdatedResult(
  chat: Chat,
  changed: boolean,
): Extract<ConfigurationDomainResult<'chat.settings-patch'>, { kind: 'chat-updated' }> {
  return {
    kind: 'chat-updated',
    chatId: chat.id,
    chat: structuredClone(chat),
    changed,
    configurationVersion: chat.configurationVersion ?? 0,
    ...(chat.modelResolution ? { pendingModelResolution: chat.modelResolution } : {}),
  }
}

async function readOwnerLinks(
  db: Dexie,
  kind: ConfigurationLinkOwnerKind,
  id: string,
): Promise<ConfigurationLink[]> {
  return db
    .table<ConfigurationLink, string>('configurationLinks')
    .where('ownerKey')
    .equals(configurationOwnerKey(kind, id))
    .toArray()
}

async function readOwnerLinksFromTransaction(
  tx: Transaction,
  kind: ConfigurationLinkOwnerKind,
  id: string,
): Promise<ConfigurationLink[]> {
  return tx
    .table<ConfigurationLink, string>('configurationLinks')
    .where('ownerKey')
    .equals(configurationOwnerKey(kind, id))
    .toArray()
}

async function readTargetLinks(
  db: Dexie,
  kind: ConfigurationLink['targetKind'],
  id: string,
): Promise<ConfigurationLink[]> {
  return db
    .table<ConfigurationLink, string>('configurationLinks')
    .where('targetKey')
    .equals(configurationTargetKey(kind, id))
    .toArray()
}

async function readTargetLinksFromTransaction(
  tx: Transaction,
  kind: ConfigurationLink['targetKind'],
  id: string,
): Promise<ConfigurationLink[]> {
  return tx
    .table<ConfigurationLink, string>('configurationLinks')
    .where('targetKey')
    .equals(configurationTargetKey(kind, id))
    .toArray()
}

function configurationLockNames(
  base: readonly string[],
  links: readonly ConfigurationLink[],
): string[] {
  return sortedUnique([
    ...base,
    ...configurationTargetResourceNamesForLinks(links),
    ...configurationProfileUsageResourceNamesForLinks(links),
  ])
}

function configurationOwnerLockName(kind: ConfigurationLinkOwnerKind, id: string): string {
  if (kind === 'chat') return `chat-meta:${id}`
  if (kind === 'chat-preset') return `preset:${id}`
  return `profile:${id}`
}

function sameLinkIds(
  left: readonly ConfigurationLink[],
  right: readonly ConfigurationLink[],
): boolean {
  const leftIds = left.map((link) => link.id).sort()
  const rightIds = right.map((link) => link.id).sort()
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index])
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function normalizeStringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))]
}

function sameValue(left: unknown, right: unknown): boolean {
  return sameConfigurationValue(left, right)
}

function isConfigurationErrorResult(
  value: unknown,
): value is Extract<ConfigurationDomainResult, { kind: 'conflict' | 'invalid' }> {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'conflict' || kind === 'invalid'
}

function isConfigurationMutationFailureResult(
  value: unknown,
): value is ConfigurationMutationFailure {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'missing' || kind === 'conflict' || kind === 'invalid'
}
