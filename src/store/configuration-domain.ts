import { normalizeModelsResponse } from '../api/providers'
import { listBundledEntries } from '../capabilities'
import {
  type ChatSettingsFieldPatch,
  type ChatSettingsPatch,
  type SerializedChatSettingsPatch,
  serializeChatSettingsPatch,
} from '../core/chat-metadata'
import { cloneDefaultChatSettings } from '../core/defaults'
import {
  CORS_PROXY_SECRET_KEY,
  CORS_PROXY_URL_KEY,
  TOKEN_CALIBRATION_MODE_KEY,
} from '../core/global-settings'
import {
  forceEquivalentModelIdForConnection,
  resolveModelIdFromCatalog,
} from '../core/model-selection'
import { defaultApiForProfile, withProfileApiDefaults } from '../core/provider-defaults'
import { RENDERING_PREFERENCES_KEY } from '../core/rendering-preferences'
import {
  SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
  SIDEBAR_SORT_SETTING_KEY,
} from '../core/sidebar-sort'
import {
  EMPTY_TEXT_TEMPLATE,
  normalizeTextTemplateConfig,
  type SavedTextTemplate,
} from '../core/text-templates'
import type {
  ChatId,
  ChatSettings,
  ConnectionProfile,
  PresetId,
  ProfileId,
  PromptPresetId,
  PromptPresetKind,
} from '../core/types'
import { newId } from '../lib/ulid'
import type { ConfigurationController } from './configuration-controller'
import {
  buildConnectionProfile,
  type ConfigurationChatSwitchCommand,
  type ConfigurationDomainCommand,
  type ConfigurationDomainPort,
  type ConfigurationDomainResult,
  type ConfigurationProfileDraftInput,
} from './configuration-domain-contract'
import type { CreateKeyInput, PreparedEncryptedKey } from './key-preparation-contract'
import type {
  ConfigurationProfileSwitchPlan,
  PendingChatSettingsFieldIntent,
  PendingConfigurationAcknowledgement,
} from './workspace-protocol'

class ConfigurationDomainError extends Error {
  readonly result: ConfigurationDomainResult

  constructor(result: ConfigurationDomainResult) {
    super(configurationErrorMessage(result))
    this.name = 'ConfigurationDomainError'
    this.result = result
  }
}

export interface CreateConnectionIntent
  extends Omit<ConfigurationProfileDraftInput, 'id' | 'apiKeyRef' | 'now'> {
  readonly profileId?: ProfileId
  readonly plaintextKey?: string
  readonly keyName?: string
  readonly passphrase?: string
  readonly passphraseHint?: string
  readonly initialPresetName?: string
  readonly initialPresetModel?: string
  readonly now?: number
}

interface EditConnectionIntent {
  readonly profile: ConnectionProfile
  readonly patch: Partial<
    Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt' | 'requestRevision'>
  >
  readonly plaintextKey?: string
  readonly expectedKeyMaterialRevision?: number
  readonly resetModelChatId?: ChatId
  readonly passphrase?: string
  readonly passphraseHint?: string
  readonly now?: number
}

export interface ConfigurationApplicationDependencies {
  readonly port: ConfigurationDomainPort
  readonly prepareKey: (input: CreateKeyInput) => Promise<PreparedEncryptedKey>
  readonly loadProfileSwitchPlan: (
    chatId: ChatId,
    profileId: ProfileId,
  ) => Promise<ConfigurationProfileSwitchPlan | undefined>
  readonly pendingConfiguration?: Pick<
    ConfigurationController,
    | 'stageChatSettingsFields'
    | 'stageChatSettingsReplacement'
    | 'stageRenderingPreferences'
    | 'stageSidebarFolderCollapsed'
    | 'stageWorkspaceSetting'
    | 'stageTextTemplateConfig'
    | 'stagePromptField'
    | 'flushWorkspaceEdits'
    | 'acknowledgePendingConfiguration'
    | 'rejectPendingConfiguration'
  >
}

export interface ConfigurationApplication {
  createConnection(
    intent: CreateConnectionIntent,
  ): Promise<ConfigurationDomainResult<'connection.create'>>
  editConnection(
    intent: EditConnectionIntent,
  ): Promise<ConfigurationDomainResult<'connection.edit'>>
  duplicateConnection(
    profileId: ProfileId,
    options?: { name?: string; now?: number },
  ): Promise<ConfigurationDomainResult<'connection.duplicate'>>
  archiveConnection(
    profileId: ProfileId,
    now?: number,
  ): Promise<ConfigurationDomainResult<'connection.edit'>>
  unarchiveConnection(
    profileId: ProfileId,
    now?: number,
  ): Promise<ConfigurationDomainResult<'connection.edit'>>
  deleteConnection(
    profileId: ProfileId,
    options?: { reassignTo?: ProfileId; now?: number },
  ): Promise<ConfigurationDomainResult<'connection.delete'>>
  execute<Command extends ConfigurationDomainCommand>(
    command: Command,
  ): Promise<ConfigurationDomainResult<Command['kind']>>
  addImageOrigin(
    origin: string,
    now?: number,
  ): Promise<ConfigurationDomainResult<'image-allowlist.add'>>
  removeImageOrigin(
    origin: string,
    now?: number,
  ): Promise<ConfigurationDomainResult<'image-allowlist.remove'>>
  patchRenderingPreferences(
    patch: Extract<ConfigurationDomainCommand, { kind: 'rendering-preferences.patch' }>['patch'],
    now?: number,
  ): Promise<ConfigurationDomainResult<'rendering-preferences.patch'>>
  setSamplePromptsDismissed(
    dismissed: boolean,
    now?: number,
  ): Promise<ConfigurationDomainResult<'sample-prompts.set-dismissed'>>
  patchChatSettings(
    chatId: ChatId,
    patch: ChatSettingsPatch,
    options?: { now?: number; cancelModelResolution?: boolean },
  ): Promise<boolean>
  patchChatSettingsFields(
    chatId: ChatId,
    patches: readonly ChatSettingsFieldPatch[],
    options?: { now?: number; cancelModelResolution?: boolean },
  ): Promise<boolean>
  replaceChatSettings(
    chatId: ChatId,
    settings: ChatSettings,
    options?: { now?: number; presetId?: PresetId | null; cancelModelResolution?: boolean },
  ): Promise<boolean>
  switchChatProfile(input: {
    chatId: ChatId
    profileId: ProfileId
    isCurrent?: () => boolean
    now?: number
  }): Promise<
    | ConfigurationDomainResult<'chat.switch-profile'>
    | Extract<ConfigurationDomainResult, { kind: 'configuration-noop' }>
  >
  createAndLinkChatPreset(input: {
    chatId: ChatId
    name: string
    profileId: ProfileId
    settings: ChatSettings
    lastUsedAt?: number
    now?: number
  }): Promise<ConfigurationDomainResult<'chat-preset.create-and-link'>>
  createChatPreset(input: {
    presetId?: PresetId
    name: string
    profileId: ProfileId
    settings: ChatSettings
    lastUsedAt?: number
    now?: number
  }): Promise<ConfigurationDomainResult<'chat-preset.create'>>
  duplicateChatPreset(
    sourceId: PresetId,
    options?: { copyId?: PresetId; name?: string; now?: number },
  ): Promise<ConfigurationDomainResult<'chat-preset.duplicate'>>
  applyChatPreset(chatId: ChatId, presetId: PresetId, now?: number): Promise<boolean>
  saveChatPreset(input: {
    presetId: PresetId
    settings: ChatSettings
    chatModel?: { chatId: ChatId; modelId: string }
    now?: number
  }): Promise<ConfigurationDomainResult<'chat-preset.save'>>
  renameChatPreset(
    presetId: PresetId,
    name: string,
    now?: number,
  ): Promise<ConfigurationDomainResult<'chat-preset.update'>>
  moveChatPreset(
    presetId: PresetId,
    afterPresetId: PresetId | null,
    now?: number,
  ): Promise<ConfigurationDomainResult<'chat-preset.move'>>
  archiveChatPreset(
    presetId: PresetId,
    now?: number,
  ): Promise<ConfigurationDomainResult<'chat-preset.set-archived'>>
  unarchiveChatPreset(
    presetId: PresetId,
    now?: number,
  ): Promise<ConfigurationDomainResult<'chat-preset.set-archived'>>
  deleteChatPreset(
    presetId: PresetId,
    now?: number,
  ): Promise<ConfigurationDomainResult<'chat-preset.delete'>>
  createTextTemplate(input: {
    name: string
    config?: SavedTextTemplate['config']
    now?: number
  }): Promise<SavedTextTemplate>
  createAndSelectTextTemplate(input: {
    chatId: ChatId
    name: string
    config?: SavedTextTemplate['config']
    now?: number
  }): Promise<SavedTextTemplate>
  updateTextTemplate(
    templateId: SavedTextTemplate['id'],
    patch: Partial<Pick<SavedTextTemplate, 'name' | 'config'>>,
    now?: number,
  ): Promise<void>
  deleteTextTemplate(templateId: SavedTextTemplate['id'], now?: number): Promise<void>
  commitPromptText(
    chatId: ChatId,
    slot: PromptPresetKind,
    text: string,
    now?: number,
  ): Promise<ConfigurationDomainResult<'prompt-preset.local-commit'>>
  loadPromptPreset(
    chatId: ChatId,
    presetId: PromptPresetId,
    now?: number,
  ): Promise<ConfigurationDomainResult<'prompt-preset.load-and-pin'>>
  overwriteAndPinPromptPreset(
    chatId: ChatId,
    presetId: PromptPresetId,
    text: string,
    now?: number,
  ): Promise<ConfigurationDomainResult<'prompt-preset.overwrite-and-pin'>>
  createAndPinPromptPreset(input: {
    chatId: ChatId
    presetId?: PromptPresetId
    kind: PromptPresetKind
    name: string
    text: string
    now?: number
  }): Promise<ConfigurationDomainResult<'prompt-preset.create-and-pin'>>
  renamePromptPreset(
    presetId: PromptPresetId,
    name: string,
    now?: number,
  ): Promise<ConfigurationDomainResult<'prompt-preset.rename'>>
  deletePromptPreset(
    presetId: PromptPresetId,
    now?: number,
  ): Promise<ConfigurationDomainResult<'prompt-preset.delete'>>
}

export function createConfigurationApplication(
  dependencies: ConfigurationApplicationDependencies,
): ConfigurationApplication {
  const execute = async <Command extends ConfigurationDomainCommand>(
    command: Command,
  ): Promise<ConfigurationDomainResult<Command['kind']>> => {
    const pending = stagePendingConfigurationCommand(command, dependencies.pendingConfiguration)
    try {
      const result = await dependencies.port.execute(command)
      if (result.kind === 'missing' || result.kind === 'conflict' || result.kind === 'invalid') {
        throw new ConfigurationDomainError(result)
      }
      acknowledgePendingConfigurationCommand(pending, result, dependencies.pendingConfiguration)
      return result
    } catch (error) {
      rejectPendingConfigurationCommand(pending, dependencies.pendingConfiguration)
      throw error
    }
  }

  const application: ConfigurationApplication = {
    execute,
    addImageOrigin(origin, now = Date.now()) {
      return execute({ kind: 'image-allowlist.add', origin, now })
    },
    removeImageOrigin(origin, now = Date.now()) {
      return execute({ kind: 'image-allowlist.remove', origin, now })
    },
    patchRenderingPreferences(patch, now = Date.now()) {
      return execute({ kind: 'rendering-preferences.patch', patch, now })
    },
    setSamplePromptsDismissed(dismissed, now = Date.now()) {
      return execute({ kind: 'sample-prompts.set-dismissed', dismissed, now })
    },
    async createConnection(intent: CreateConnectionIntent) {
      const now = intent.now ?? Date.now()
      const prepared = await prepareOptionalKey(dependencies, {
        ...(intent.plaintextKey === undefined ? {} : { plaintextKey: intent.plaintextKey }),
        name: intent.keyName ?? intent.name,
        ...(intent.passphrase === undefined ? {} : { passphrase: intent.passphrase }),
        ...(intent.passphraseHint === undefined ? {} : { passphraseHint: intent.passphraseHint }),
        now,
      })
      const profile = buildConnectionProfile({
        ...intent,
        id: intent.profileId ?? newId(),
        ...(prepared ? { apiKeyRef: prepared.record.id } : {}),
        now,
      })
      const initialPreset = intent.initialPresetName
        ? buildInitialPreset(
            profile,
            intent.initialPresetName,
            intent.initialPresetModel ?? '',
            now,
          )
        : undefined
      const result = await execute({
        kind: 'connection.create',
        profile,
        ...(prepared ? { key: prepared.record } : {}),
        ...(initialPreset ? { initialPreset } : {}),
        now,
      })
      if (prepared && result.kind === 'connection-saved') prepared.retainWrapperKey()
      return result
    },
    async editConnection(intent: EditConnectionIntent) {
      const now = intent.now ?? Date.now()
      const keyId = intent.profile.apiKeyRef ?? newId()
      const prepared = await prepareOptionalKey(dependencies, {
        ...(intent.plaintextKey === undefined ? {} : { plaintextKey: intent.plaintextKey }),
        name: intent.patch.name ?? intent.profile.name,
        id: keyId,
        materialRevision: (intent.expectedKeyMaterialRevision ?? -1) + 1,
        ...(intent.passphrase === undefined ? {} : { passphrase: intent.passphrase }),
        ...(intent.passphraseHint === undefined ? {} : { passphraseHint: intent.passphraseHint }),
        now,
      })
      const result = await execute({
        kind: 'connection.edit',
        profileId: intent.profile.id,
        patch: {
          ...intent.patch,
          ...(prepared ? { apiKeyRef: prepared.record.id } : {}),
        },
        ...(prepared ? { replacementKey: prepared.record } : {}),
        ...(intent.resetModelChatId === undefined
          ? {}
          : { resetModelChatId: intent.resetModelChatId }),
        expectedRequestRevision: intent.profile.requestRevision ?? 0,
        now,
      })
      if (prepared && result.kind === 'connection-saved') prepared.retainWrapperKey()
      return result
    },
    duplicateConnection(profileId, options = {}) {
      return execute({
        kind: 'connection.duplicate',
        sourceId: profileId,
        copyId: newId(),
        ...(options.name === undefined ? {} : { name: options.name }),
        now: options.now ?? Date.now(),
      })
    },
    archiveConnection(profileId, now = Date.now()) {
      return execute({ kind: 'connection.edit', profileId, patch: { archived: true }, now })
    },
    unarchiveConnection(profileId, now = Date.now()) {
      return execute({ kind: 'connection.edit', profileId, patch: { archived: false }, now })
    },
    deleteConnection(profileId, options = {}) {
      return execute({
        kind: 'connection.delete',
        profileId,
        ...(options.reassignTo === undefined ? {} : { reassignTo: options.reassignTo }),
        now: options.now ?? Date.now(),
      })
    },
    async patchChatSettings(chatId, patch, options = {}) {
      if (Object.keys(patch).length === 0) return false
      const serializedPatch = serializeChatSettingsPatch(patch)
      const result = await execute({
        kind: 'chat.settings-patch',
        chatId,
        patch: serializedPatch,
        ...(options.cancelModelResolution === undefined
          ? {}
          : { cancelModelResolution: options.cancelModelResolution }),
        now: options.now ?? Date.now(),
      })
      return result.kind === 'chat-updated' && result.changed
    },
    async patchChatSettingsFields(chatId, patches, options = {}) {
      if (patches.length === 0) return false
      const commandPatches = cloneFieldPatches(patches)
      const result = await execute({
        kind: 'chat.settings-fields-patch',
        chatId,
        patches: commandPatches,
        ...(options.cancelModelResolution === undefined
          ? {}
          : { cancelModelResolution: options.cancelModelResolution }),
        now: options.now ?? Date.now(),
      })
      return result.kind === 'chat-updated' && result.changed
    },
    async replaceChatSettings(chatId, settings, options = {}) {
      const result = await execute({
        kind: 'chat.settings-replace',
        chatId,
        settings: structuredClone(settings),
        ...(options.presetId === undefined ? {} : { presetId: options.presetId }),
        ...(options.cancelModelResolution === undefined
          ? {}
          : { cancelModelResolution: options.cancelModelResolution }),
        now: options.now ?? Date.now(),
      })
      return result.kind === 'chat-updated' && result.changed
    },
    async switchChatProfile(input) {
      for (const canRebase of PROFILE_SWITCH_PLAN_ATTEMPTS) {
        if (input.isCurrent && !input.isCurrent()) {
          return { kind: 'configuration-noop' } as const
        }
        const plan = await dependencies.loadProfileSwitchPlan(input.chatId, input.profileId)
        if (!plan) {
          throw new ConfigurationDomainError({
            kind: 'missing',
            entity: 'chat',
            id: input.chatId,
          })
        }
        if (input.isCurrent && !input.isCurrent()) {
          return { kind: 'configuration-noop' } as const
        }
        const model = profileSwitchModel(plan)
        const command: ConfigurationChatSwitchCommand = {
          kind: 'chat.switch-profile',
          chatId: input.chatId,
          profileId: input.profileId,
          requestKeyId: plan.requestKeyId,
          previousProfileId: plan.chat.settings.profileId,
          previousModelResolutionTarget: plan.chat.modelResolution?.target ?? null,
          target: plan.target,
          api: defaultApiForProfile(plan.profile),
          model,
          expectedConfigurationVersion: plan.chat.configurationVersion ?? 0,
          now: input.now ?? Date.now(),
        }
        const pending = stagePendingConfigurationCommand(command, dependencies.pendingConfiguration)
        let result: ConfigurationDomainResult<'chat.switch-profile'>
        try {
          result = await dependencies.port.execute(command)
        } catch (error) {
          rejectPendingConfigurationCommand(pending, dependencies.pendingConfiguration)
          throw error
        }
        if (
          result.kind === 'missing' ||
          (result.kind === 'invalid' && result.reason !== 'model-resolution-target-mismatch')
        ) {
          rejectPendingConfigurationCommand(pending, dependencies.pendingConfiguration)
          throw new ConfigurationDomainError(result)
        }
        acknowledgePendingConfigurationCommand(pending, result, dependencies.pendingConfiguration)
        if (canRebase && profileSwitchNeedsFreshPlan(result)) continue
        return result
      }
      throw new Error('ProfileSwitchAttemptSequenceExhausted')
    },
    createAndLinkChatPreset(input) {
      const now = input.now ?? Date.now()
      return execute({
        kind: 'chat-preset.create-and-link',
        chatId: input.chatId,
        preset: {
          id: newId(),
          name: input.name,
          connectionProfileId: input.profileId,
          settings: structuredClone(input.settings),
          ...(input.lastUsedAt === undefined ? {} : { lastUsedAt: input.lastUsedAt }),
        },
        now,
      })
    },
    createChatPreset(input) {
      const now = input.now ?? Date.now()
      return execute({
        kind: 'chat-preset.create',
        preset: {
          id: input.presetId ?? newId(),
          name: input.name,
          connectionProfileId: input.profileId,
          settings: structuredClone(input.settings),
          ...(input.lastUsedAt === undefined ? {} : { lastUsedAt: input.lastUsedAt }),
        },
        now,
      })
    },
    duplicateChatPreset(sourceId, options = {}) {
      return execute({
        kind: 'chat-preset.duplicate',
        sourceId,
        copyId: options.copyId ?? newId(),
        ...(options.name === undefined ? {} : { name: options.name }),
        now: options.now ?? Date.now(),
      })
    },
    async applyChatPreset(chatId, presetId, now = Date.now()) {
      const result = await execute({ kind: 'chat-preset.apply', chatId, presetId, now })
      return result.kind === 'chat-preset-saved' && result.chatChanged === true
    },
    saveChatPreset(input) {
      return execute({
        kind: 'chat-preset.save',
        presetId: input.presetId,
        settings: structuredClone(input.settings),
        ...(input.chatModel ? { chatModel: input.chatModel } : {}),
        now: input.now ?? Date.now(),
      })
    },
    renameChatPreset(presetId, name, now = Date.now()) {
      return execute({ kind: 'chat-preset.update', presetId, patch: { name }, now })
    },
    moveChatPreset(presetId, afterPresetId, now = Date.now()) {
      return execute({
        kind: 'chat-preset.move',
        presetId,
        afterPresetId,
        now,
      })
    },
    archiveChatPreset(presetId, now = Date.now()) {
      return execute({ kind: 'chat-preset.set-archived', presetId, archived: true, now })
    },
    unarchiveChatPreset(presetId, now = Date.now()) {
      return execute({ kind: 'chat-preset.set-archived', presetId, archived: false, now })
    },
    deleteChatPreset(presetId, now = Date.now()) {
      return execute({ kind: 'chat-preset.delete', presetId, now })
    },
    async createTextTemplate(input) {
      const now = input.now ?? Date.now()
      const template = buildSavedTextTemplate(input, now)
      await execute({ kind: 'text-template.create', template, now })
      return template
    },
    async createAndSelectTextTemplate(input) {
      const now = input.now ?? Date.now()
      const template = buildSavedTextTemplate(input, now)
      await execute({
        kind: 'text-template.create-and-select',
        chatId: input.chatId,
        template,
        now,
      })
      return template
    },
    async updateTextTemplate(templateId, patch, now = Date.now()) {
      await execute({
        kind: 'text-template.update',
        templateId,
        patch: {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.config === undefined
            ? {}
            : { config: normalizeTextTemplateConfig(patch.config) }),
        },
        now,
      })
    },
    async deleteTextTemplate(templateId, now = Date.now()) {
      await dependencies.pendingConfiguration?.flushWorkspaceEdits(`text-template:${templateId}`)
      await execute({ kind: 'text-template.delete', templateId, now })
    },
    commitPromptText(chatId, slot, text, now = Date.now()) {
      return execute({ kind: 'prompt-preset.local-commit', chatId, slot, text, now })
    },
    loadPromptPreset(chatId, presetId, now = Date.now()) {
      return execute({ kind: 'prompt-preset.load-and-pin', chatId, presetId, now })
    },
    overwriteAndPinPromptPreset(chatId, presetId, text, now = Date.now()) {
      return execute({
        kind: 'prompt-preset.overwrite-and-pin',
        chatId,
        presetId,
        text,
        now,
      })
    },
    createAndPinPromptPreset(input) {
      const now = input.now ?? Date.now()
      return execute({
        kind: 'prompt-preset.create-and-pin',
        chatId: input.chatId,
        preset: {
          id: input.presetId ?? newId(),
          kind: input.kind,
          name: input.name,
          text: input.text,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: now,
        },
        now,
      })
    },
    renamePromptPreset(presetId, name, now = Date.now()) {
      return execute({ kind: 'prompt-preset.rename', presetId, name, now })
    },
    deletePromptPreset(presetId, now = Date.now()) {
      return execute({ kind: 'prompt-preset.delete', presetId, now })
    },
  }
  return Object.freeze(application)
}

function buildSavedTextTemplate(
  input: { name: string; config?: SavedTextTemplate['config'] },
  now: number,
): SavedTextTemplate {
  return {
    id: `user:${newId()}`,
    name: input.name.trim() || 'Untitled template',
    config: normalizeTextTemplateConfig(input.config ?? EMPTY_TEXT_TEMPLATE),
    createdAt: now,
    updatedAt: now,
  }
}

function fieldPatchesFromSerialized(patch: SerializedChatSettingsPatch): ChatSettingsFieldPatch[] {
  return [
    ...patch.clear.map((key) => ({ path: [key] as const })),
    ...(Object.keys(patch.set) as Array<keyof ChatSettings>).map((key) => ({
      path: [key] as const,
      value: structuredClone(patch.set[key]),
    })),
  ]
}

function cloneFieldPatches(patches: readonly ChatSettingsFieldPatch[]): ChatSettingsFieldPatch[] {
  return patches.map((patch) => ({
    path: [...patch.path],
    ...(patch.membership
      ? {
          membership: {
            member: structuredClone(patch.membership.member),
            present: patch.membership.present,
          },
        }
      : patch.value === undefined
        ? {}
        : { value: structuredClone(patch.value) }),
  }))
}

type PendingConfigurationPort = NonNullable<
  ConfigurationApplicationDependencies['pendingConfiguration']
>

interface StagedPendingConfigurationCommand {
  readonly chatId: ChatId | null
  readonly acknowledgement: PendingConfigurationAcknowledgement
}

const REQUEST_PREPARATION_SETTING_KEYS = new Set<string>([
  TOKEN_CALIBRATION_MODE_KEY,
  CORS_PROXY_URL_KEY,
  CORS_PROXY_SECRET_KEY,
])
const PROFILE_SWITCH_PLAN_ATTEMPTS = [true, false] as const

type PendingConfigurationCommand = Extract<
  ConfigurationDomainCommand,
  {
    readonly kind:
      | 'chat.settings-patch'
      | 'chat.settings-fields-patch'
      | 'chat.settings-replace'
      | 'chat.switch-profile'
      | 'prompt-preset.local-commit'
      | 'text-template.update'
      | 'text-template.create-and-select'
      | 'rendering-preferences.patch'
      | 'sidebar-preference.set-sort'
      | 'sidebar-preference.set-folder-collapsed'
      | 'global-preference.set'
  }
>

function stagePendingConfigurationCommand(
  command: ConfigurationDomainCommand,
  pending: PendingConfigurationPort | undefined,
): StagedPendingConfigurationCommand | null {
  if (!pending || !isPendingConfigurationCommand(command)) return null
  switch (command.kind) {
    case 'chat.settings-patch': {
      const staged = pending.stageChatSettingsFields(
        command.chatId,
        fieldPatchesFromSerialized(command.patch),
      )
      return stagedChatFieldAcknowledgement(command.chatId, staged)
    }
    case 'chat.settings-fields-patch': {
      const staged = pending.stageChatSettingsFields(command.chatId, command.patches)
      return stagedChatFieldAcknowledgement(command.chatId, staged)
    }
    case 'chat.settings-replace': {
      const staged = pending.stageChatSettingsReplacement(
        command.chatId,
        command.settings,
        command.presetId,
      )
      return {
        chatId: command.chatId,
        acknowledgement: {
          promptFields: [],
          chatSettingsReplacement: { revision: staged.revision },
        },
      }
    }
    case 'chat.switch-profile': {
      const staged = pending.stageChatSettingsFields(command.chatId, [
        { path: ['profileId'], value: command.profileId },
        { path: ['api'], value: command.api },
        {
          path: ['model'],
          value: command.model.kind === 'resolved' ? command.model.id : command.model.immediateId,
        },
      ])
      return stagedChatFieldAcknowledgement(command.chatId, staged)
    }
    case 'prompt-preset.local-commit': {
      const staged = pending.stagePromptField(command.chatId, command.slot, command.text)
      return {
        chatId: command.chatId,
        acknowledgement: {
          promptFields: [{ field: staged.field, revision: staged.revision }],
        },
      }
    }
    case 'text-template.update': {
      if (!command.patch.config) return null
      const staged = pending.stageTextTemplateConfig(command.templateId, command.patch.config)
      return {
        chatId: null,
        acknowledgement: {
          promptFields: [],
          textTemplateConfigs: [{ templateId: staged.templateId, revision: staged.revision }],
        },
      }
    }
    case 'text-template.create-and-select': {
      const fields = pending.stageChatSettingsFields(command.chatId, [
        { path: ['textTemplate'], value: command.template.id },
      ])
      const template = pending.stageTextTemplateConfig(command.template.id, command.template.config)
      return {
        chatId: command.chatId,
        acknowledgement: {
          promptFields: [],
          chatSettingsFields: fields.map(({ fieldKey, revision }) => ({ fieldKey, revision })),
          textTemplateConfigs: [{ templateId: template.templateId, revision: template.revision }],
        },
      }
    }
    case 'rendering-preferences.patch': {
      const staged = pending.stageRenderingPreferences(command.patch)
      return {
        chatId: null,
        acknowledgement: {
          promptFields: [],
          workspaceSettings: [
            {
              key: RENDERING_PREFERENCES_KEY,
              revision: staged.revision,
            },
          ],
        },
      }
    }
    case 'sidebar-preference.set-sort': {
      const staged = pending.stageWorkspaceSetting(SIDEBAR_SORT_SETTING_KEY, command.mode)
      return {
        chatId: null,
        acknowledgement: {
          promptFields: [],
          workspaceSettings: [
            {
              key: SIDEBAR_SORT_SETTING_KEY,
              revision: staged.revision,
            },
          ],
        },
      }
    }
    case 'sidebar-preference.set-folder-collapsed': {
      const staged = pending.stageSidebarFolderCollapsed(command.folderId, command.collapsed)
      return {
        chatId: null,
        acknowledgement: {
          promptFields: [],
          workspaceSettings: [
            {
              key: SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
              revision: staged.revision,
            },
          ],
        },
      }
    }
    case 'global-preference.set': {
      if (!REQUEST_PREPARATION_SETTING_KEYS.has(command.key)) return null
      const staged = pending.stageWorkspaceSetting(command.key, command.value)
      return {
        chatId: null,
        acknowledgement: {
          promptFields: [],
          workspaceSettings: [{ key: staged.key, revision: staged.revision }],
        },
      }
    }
  }
}

function isPendingConfigurationCommand(
  command: ConfigurationDomainCommand,
): command is PendingConfigurationCommand {
  return (
    command.kind === 'chat.settings-patch' ||
    command.kind === 'chat.settings-fields-patch' ||
    command.kind === 'chat.settings-replace' ||
    command.kind === 'chat.switch-profile' ||
    command.kind === 'prompt-preset.local-commit' ||
    command.kind === 'text-template.update' ||
    command.kind === 'text-template.create-and-select' ||
    command.kind === 'rendering-preferences.patch' ||
    command.kind === 'sidebar-preference.set-sort' ||
    command.kind === 'sidebar-preference.set-folder-collapsed' ||
    command.kind === 'global-preference.set'
  )
}

function stagedChatFieldAcknowledgement(
  chatId: ChatId,
  staged: readonly PendingChatSettingsFieldIntent[],
): StagedPendingConfigurationCommand {
  return {
    chatId,
    acknowledgement: {
      promptFields: [],
      chatSettingsFields: staged.map(({ fieldKey, revision }) => ({ fieldKey, revision })),
    },
  }
}

function acknowledgePendingConfigurationCommand(
  staged: StagedPendingConfigurationCommand | null,
  result: ConfigurationDomainResult,
  pending: PendingConfigurationPort | undefined,
): void {
  if (!staged || !pending) return
  const workspaceSettings =
    result.kind === 'workspace-setting-saved'
      ? staged.acknowledgement.workspaceSettings?.map((receipt) =>
          receipt.key === result.key
            ? {
                ...receipt,
                accepted: {
                  value: result.value,
                },
              }
            : receipt,
        )
      : staged.acknowledgement.workspaceSettings
  pending.acknowledgePendingConfiguration(staged.chatId, {
    ...staged.acknowledgement,
    ...((result.kind === 'chat-updated' || result.kind === 'prompt-preset-saved') &&
    result.configurationVersion !== undefined
      ? { acceptedChatConfigurationVersion: result.configurationVersion }
      : {}),
    ...(workspaceSettings ? { workspaceSettings } : {}),
  })
}

function rejectPendingConfigurationCommand(
  staged: StagedPendingConfigurationCommand | null,
  pending: PendingConfigurationPort | undefined,
): void {
  if (!staged || !pending) return
  pending.rejectPendingConfiguration(staged.chatId, staged.acknowledgement)
}

function profileSwitchNeedsFreshPlan(
  result:
    | ConfigurationDomainResult<'chat.switch-profile'>
    | Extract<ConfigurationDomainResult, { kind: 'configuration-noop' }>,
): boolean {
  return (
    result.kind === 'conflict' ||
    (result.kind === 'invalid' && result.reason === 'model-resolution-target-mismatch')
  )
}

function profileSwitchModel(
  plan: ConfigurationProfileSwitchPlan,
): ConfigurationChatSwitchCommand['model'] {
  const sourceModelId = plan.chat.settings.model
  const cachedCandidates = plan.cachedModels
    ? normalizeModelsResponse(plan.cachedModels.payload)
    : null
  const candidates =
    cachedCandidates ?? listBundledEntries(plan.profile.kind).map((entry) => ({ id: entry.id }))
  if (cachedCandidates) {
    return {
      kind: 'resolved',
      id: resolveModelIdFromCatalog(sourceModelId, plan.profile.kind, candidates),
    }
  }
  const equivalent = sourceModelId
    ? forceEquivalentModelIdForConnection(sourceModelId, plan.profile.kind, candidates)
    : null
  if (equivalent) return { kind: 'resolved', id: equivalent }
  if (candidates.length === 1 && candidates[0]) {
    return { kind: 'resolved', id: candidates[0].id }
  }
  return {
    kind: 'pending',
    immediateId: '',
    resolution: {
      intentId: newId(),
      target: structuredClone(plan.target),
      sourceModelId,
      expectedConfigurationVersion: (plan.chat.configurationVersion ?? 0) + 1,
    },
  }
}

async function prepareOptionalKey(
  dependencies: ConfigurationApplicationDependencies,
  input: Omit<CreateKeyInput, 'plaintextKey'> & { plaintextKey?: string },
): Promise<PreparedEncryptedKey | undefined> {
  if (!input.plaintextKey?.trim()) return undefined
  return dependencies.prepareKey({ ...input, plaintextKey: input.plaintextKey.trim() })
}

function buildInitialPreset(profile: ConnectionProfile, name: string, model: string, now: number) {
  const settings = cloneDefaultChatSettings()
  settings.profileId = profile.id
  settings.model = model
  return {
    id: newId(),
    name,
    connectionProfileId: profile.id,
    settings: withProfileApiDefaults(settings, profile),
    lastUsedAt: now,
  }
}

function configurationErrorMessage(result: ConfigurationDomainResult): string {
  if (result.kind === 'missing') return `ConfigurationMissing:${result.entity}:${result.id}`
  if (result.kind === 'conflict') return `ConfigurationConflict:${result.reason}`
  if (result.kind === 'invalid') return `ConfigurationInvalid:${result.reason}`
  return 'ConfigurationDomainError'
}
