import type { ChatSettingsFieldPatch, SerializedChatSettingsPatch } from '../core/chat-metadata'
import { connectionKindDefaults } from '../core/connection-defaults'
import {
  connectionDispatchFallbackKeyRefs,
  connectionDispatchFallbackKeyRefsIterable,
  connectionDispatchKeyRefs,
} from '../core/connection-dispatch-proof'
import type { RenderingPreferences } from '../core/rendering-preferences'
import type { SidebarSortMode } from '../core/sidebar-sort'
import { isStaticTextTemplateId, type SavedTextTemplate } from '../core/text-templates'
import type {
  Chat,
  ChatId,
  ChatPreset,
  ChatSettings,
  ConfigurationRequestRevision,
  ConnectionKind,
  ConnectionProfile,
  FolderId,
  KeyId,
  KeyRecord,
  PendingModelResolution,
  PresetId,
  ProfileId,
  PromptPreset,
  PromptPresetId,
  PromptPresetKind,
  TextTemplateId,
} from '../core/types'
import { sameValue } from '../lib/same-value'
import { newId } from '../lib/ulid'

export type ConfigurationLinkOwnerKind = 'profile' | 'chat' | 'chat-preset'
export type ConfigurationLinkTargetKind =
  | 'key'
  | 'profile'
  | 'chat-preset'
  | 'prompt-preset'
  | 'text-template'
  | 'model-resolution'

export interface ConfigurationLink {
  readonly id: string
  readonly ownerKind: ConfigurationLinkOwnerKind
  readonly ownerId: string
  readonly ownerKey: string
  readonly targetKind: ConfigurationLinkTargetKind
  readonly targetId: string
  readonly targetKey: string
  readonly slot: string
  readonly ownerActive?: boolean
}

interface ConfigurationCommandBase {
  readonly now: number
}

export interface ConfigurationProfileDraftInput {
  readonly id?: ProfileId
  readonly name: string
  readonly kind: ConnectionKind
  readonly baseUrl: string
  readonly apiKeyRef?: KeyId
  readonly apiKeyFallbackRefs?: KeyId[]
  readonly managementApiKeyRef?: KeyId
  readonly defaultHeaders?: Record<string, string>
  readonly appTitle?: string
  readonly appUrl?: string
  readonly appCategories?: string[]
  readonly supportsEndpointsApi?: boolean
  readonly supportsGenerationApi?: boolean
  readonly supportsPrivacyScrape?: boolean
  readonly capabilityOverrides?: ConnectionProfile['capabilityOverrides']
  readonly debugRequests?: boolean
  readonly now?: number
}

interface ConfigurationConnectionCreateCommand extends ConfigurationCommandBase {
  readonly kind: 'connection.create'
  readonly profile: ConnectionProfile
  readonly key?: KeyRecord
  readonly initialPreset?: ConfigurationChatPresetDraft
}

export interface ConfigurationConnectionEditCommand extends ConfigurationCommandBase {
  readonly kind: 'connection.edit'
  readonly profileId: ProfileId
  readonly patch: Partial<Omit<ConnectionProfile, 'id' | 'createdAt' | 'requestRevision'>>
  readonly replacementKey?: KeyRecord
  readonly expectedRequestRevision?: number
  readonly resetModelChatId?: ChatId
}

interface ConfigurationConnectionDuplicateCommand extends ConfigurationCommandBase {
  readonly kind: 'connection.duplicate'
  readonly sourceId: ProfileId
  readonly copyId: ProfileId
  readonly name?: string
}

interface ConfigurationConnectionTouchCommand extends ConfigurationCommandBase {
  readonly kind: 'connection.touch'
  readonly profileId: ProfileId
}

interface ConfigurationConnectionDeleteCommand extends ConfigurationCommandBase {
  readonly kind: 'connection.delete'
  readonly profileId: ProfileId
  readonly reassignTo?: ProfileId
}

interface ConfigurationKeyPutCommand extends ConfigurationCommandBase {
  readonly kind: 'key.put'
  readonly key: KeyRecord
  readonly expectedMaterialRevision: number | null
}

interface ConfigurationKeyTouchCommand extends ConfigurationCommandBase {
  readonly kind: 'key.touch'
  readonly keyId: KeyId
}

interface ConfigurationKeyMaterialReplaceCommand extends ConfigurationCommandBase {
  readonly kind: 'key.material-replace'
  readonly key: KeyRecord
  readonly expectedMaterialRevision: number
}

interface ConfigurationKeyDeleteCommand extends ConfigurationCommandBase {
  readonly kind: 'key.delete'
  readonly keyId: KeyId
}

export interface ConfigurationChatSwitchCommand extends ConfigurationCommandBase {
  readonly kind: 'chat.switch-profile'
  readonly chatId: ChatId
  readonly profileId: ProfileId
  readonly target: ConfigurationRequestRevision
  readonly api: ChatSettings['api']
  readonly model:
    | { readonly kind: 'resolved'; readonly id: string }
    | {
        readonly kind: 'pending'
        readonly immediateId: string
        readonly resolution: PendingModelResolution
      }
  readonly expectedConfigurationVersion: number
}

interface ConfigurationChatResolveModelCommand extends ConfigurationCommandBase {
  readonly kind: 'chat.resolve-model'
  readonly chatId: ChatId
  readonly intentId: string
  readonly target: ConfigurationRequestRevision
  readonly modelId: string
  readonly expectedConfigurationVersion: number
}

interface ConfigurationChatSettingsPatchCommand extends ConfigurationCommandBase {
  readonly kind: 'chat.settings-patch'
  readonly chatId: ChatId
  readonly patch: SerializedChatSettingsPatch
  readonly cancelModelResolution?: boolean
}

interface ConfigurationChatSettingsFieldsPatchCommand extends ConfigurationCommandBase {
  readonly kind: 'chat.settings-fields-patch'
  readonly chatId: ChatId
  readonly patches: readonly ChatSettingsFieldPatch[]
  readonly cancelModelResolution?: boolean
}

interface ConfigurationChatSettingsReplaceCommand extends ConfigurationCommandBase {
  readonly kind: 'chat.settings-replace'
  readonly chatId: ChatId
  readonly settings: ChatSettings
  readonly presetId?: PresetId | null
  readonly cancelModelResolution?: boolean
}

interface ConfigurationImageAllowlistCommandBase extends ConfigurationCommandBase {
  readonly origin: string
}

interface ConfigurationImageAllowlistAddCommand extends ConfigurationImageAllowlistCommandBase {
  readonly kind: 'image-allowlist.add'
}

interface ConfigurationImageAllowlistRemoveCommand extends ConfigurationImageAllowlistCommandBase {
  readonly kind: 'image-allowlist.remove'
}

type ConfigurationImageAllowlistCommand =
  | ConfigurationImageAllowlistAddCommand
  | ConfigurationImageAllowlistRemoveCommand

interface ConfigurationRenderingPatchCommand extends ConfigurationCommandBase {
  readonly kind: 'rendering-preferences.patch'
  readonly patch: Partial<RenderingPreferences>
}

interface ConfigurationSamplePromptsDismissCommand extends ConfigurationCommandBase {
  readonly kind: 'sample-prompts.set-dismissed'
  readonly dismissed: boolean
}

interface ConfigurationInstallSecretEnsureCommand extends ConfigurationCommandBase {
  readonly kind: 'install-secret.ensure'
  readonly fresh: string
}

interface ConfigurationGlobalPreferenceSetCommand extends ConfigurationCommandBase {
  readonly kind: 'global-preference.set'
  readonly key: string
  readonly value: unknown
}

interface ConfigurationGlobalPreferenceDeleteCommand extends ConfigurationCommandBase {
  readonly kind: 'global-preference.delete'
  readonly key: string
}

interface ConfigurationPinnedModelMembershipCommand extends ConfigurationCommandBase {
  readonly kind: 'pinned-model.set-membership'
  readonly modelId: string
  readonly pinned: boolean
}

interface ConfigurationPinnedModelMoveCommand extends ConfigurationCommandBase {
  readonly kind: 'pinned-model.move'
  readonly modelId: string
  readonly delta: -1 | 1
}

interface ConfigurationPinnedModelClearCommand extends ConfigurationCommandBase {
  readonly kind: 'pinned-model.clear'
}

interface ConfigurationRecentModelBumpCommand extends ConfigurationCommandBase {
  readonly kind: 'recent-model.bump'
  readonly modelId: string
  readonly limit: number
}

interface ConfigurationRecentModelClearCommand extends ConfigurationCommandBase {
  readonly kind: 'recent-model.clear'
}

interface ConfigurationSidebarSortCommand extends ConfigurationCommandBase {
  readonly kind: 'sidebar-preference.set-sort'
  readonly mode: SidebarSortMode
}

interface ConfigurationSidebarFolderCommand extends ConfigurationCommandBase {
  readonly kind: 'sidebar-preference.set-folder-collapsed'
  readonly folderId: FolderId
  readonly collapsed: boolean
}

interface ConfigurationTextTemplateCreateCommand extends ConfigurationCommandBase {
  readonly kind: 'text-template.create'
  readonly template: SavedTextTemplate
}

interface ConfigurationTextTemplateUpdateCommand extends ConfigurationCommandBase {
  readonly kind: 'text-template.update'
  readonly templateId: TextTemplateId
  readonly patch: Partial<Omit<SavedTextTemplate, 'id' | 'createdAt' | 'updatedAt'>>
}

interface ConfigurationTextTemplateCreateAndSelectCommand extends ConfigurationCommandBase {
  readonly kind: 'text-template.create-and-select'
  readonly chatId: ChatId
  readonly template: SavedTextTemplate
}

interface ConfigurationTextTemplateDeleteCommand extends ConfigurationCommandBase {
  readonly kind: 'text-template.delete'
  readonly templateId: TextTemplateId
}

interface ConfigurationChatPresetCreateAndLinkCommand extends ConfigurationCommandBase {
  readonly kind: 'chat-preset.create-and-link'
  readonly chatId: ChatId
  readonly preset: ConfigurationChatPresetDraft
}

interface ConfigurationChatPresetCreateCommand extends ConfigurationCommandBase {
  readonly kind: 'chat-preset.create'
  readonly preset: ConfigurationChatPresetDraft
}

interface ConfigurationChatPresetUpdateCommand extends ConfigurationCommandBase {
  readonly kind: 'chat-preset.update'
  readonly presetId: PresetId
  readonly patch: Partial<Pick<ChatPreset, 'name' | 'connectionProfileId' | 'settings'>>
}

interface ConfigurationChatPresetDuplicateCommand extends ConfigurationCommandBase {
  readonly kind: 'chat-preset.duplicate'
  readonly sourceId: PresetId
  readonly copyId: PresetId
  readonly name?: string
}

interface ConfigurationChatPresetMoveCommand extends ConfigurationCommandBase {
  readonly kind: 'chat-preset.move'
  readonly presetId: PresetId
  readonly afterPresetId: PresetId | null
}

interface ConfigurationChatPresetSetArchivedCommand extends ConfigurationCommandBase {
  readonly kind: 'chat-preset.set-archived'
  readonly presetId: PresetId
  readonly archived: boolean
}

interface ConfigurationChatPresetTouchCommand extends ConfigurationCommandBase {
  readonly kind: 'chat-preset.touch'
  readonly presetId: PresetId
}

interface ConfigurationChatPresetDeleteCommand extends ConfigurationCommandBase {
  readonly kind: 'chat-preset.delete'
  readonly presetId: PresetId
}

interface ConfigurationChatPresetDraft {
  readonly id: PresetId
  readonly name: string
  readonly connectionProfileId: ProfileId
  readonly settings: ChatSettings
  readonly lastUsedAt?: number
}

interface ConfigurationChatPresetApplyCommand extends ConfigurationCommandBase {
  readonly kind: 'chat-preset.apply'
  readonly chatId: ChatId
  readonly presetId: PresetId
}

interface ConfigurationChatPresetSaveCommand extends ConfigurationCommandBase {
  readonly kind: 'chat-preset.save'
  readonly presetId: PresetId
  readonly settings: ChatSettings
  readonly chatModel?: {
    readonly chatId: ChatId
    readonly modelId: string
  }
}

interface ConfigurationPromptLocalCommitCommand extends ConfigurationCommandBase {
  readonly kind: 'prompt-preset.local-commit'
  readonly chatId: ChatId
  readonly slot: PromptPresetKind
  readonly text: string
}

interface ConfigurationPromptLoadAndPinCommand extends ConfigurationCommandBase {
  readonly kind: 'prompt-preset.load-and-pin'
  readonly chatId: ChatId
  readonly presetId: PromptPresetId
}

interface ConfigurationPromptOverwriteAndPinCommand extends ConfigurationCommandBase {
  readonly kind: 'prompt-preset.overwrite-and-pin'
  readonly chatId: ChatId
  readonly presetId: PromptPresetId
  readonly text: string
}

interface ConfigurationPromptCreateAndPinCommand extends ConfigurationCommandBase {
  readonly kind: 'prompt-preset.create-and-pin'
  readonly chatId: ChatId
  readonly preset: PromptPreset
}

interface ConfigurationPromptRenameCommand extends ConfigurationCommandBase {
  readonly kind: 'prompt-preset.rename'
  readonly presetId: PromptPresetId
  readonly name: string
}

interface ConfigurationPromptPutCommand extends ConfigurationCommandBase {
  readonly kind: 'prompt-preset.put'
  readonly preset: PromptPreset
}

interface ConfigurationPromptUpdateCommand extends ConfigurationCommandBase {
  readonly kind: 'prompt-preset.update'
  readonly presetId: PromptPresetId
  readonly patch: {
    readonly name?: string
    readonly text?: string
  }
}

interface ConfigurationPromptTouchCommand extends ConfigurationCommandBase {
  readonly kind: 'prompt-preset.touch'
  readonly presetId: PromptPresetId
}

interface ConfigurationPromptDeleteCommand extends ConfigurationCommandBase {
  readonly kind: 'prompt-preset.delete'
  readonly presetId: PromptPresetId
}

type ConfigurationDomainCommandUnion =
  | ConfigurationConnectionCreateCommand
  | ConfigurationConnectionEditCommand
  | ConfigurationConnectionDuplicateCommand
  | ConfigurationConnectionTouchCommand
  | ConfigurationConnectionDeleteCommand
  | ConfigurationKeyPutCommand
  | ConfigurationKeyTouchCommand
  | ConfigurationKeyMaterialReplaceCommand
  | ConfigurationKeyDeleteCommand
  | ConfigurationChatSwitchCommand
  | ConfigurationChatResolveModelCommand
  | ConfigurationChatSettingsPatchCommand
  | ConfigurationChatSettingsFieldsPatchCommand
  | ConfigurationChatSettingsReplaceCommand
  | ConfigurationImageAllowlistCommand
  | ConfigurationRenderingPatchCommand
  | ConfigurationSamplePromptsDismissCommand
  | ConfigurationInstallSecretEnsureCommand
  | ConfigurationGlobalPreferenceSetCommand
  | ConfigurationGlobalPreferenceDeleteCommand
  | ConfigurationPinnedModelMembershipCommand
  | ConfigurationPinnedModelMoveCommand
  | ConfigurationPinnedModelClearCommand
  | ConfigurationRecentModelBumpCommand
  | ConfigurationRecentModelClearCommand
  | ConfigurationSidebarSortCommand
  | ConfigurationSidebarFolderCommand
  | ConfigurationTextTemplateCreateCommand
  | ConfigurationTextTemplateCreateAndSelectCommand
  | ConfigurationTextTemplateUpdateCommand
  | ConfigurationTextTemplateDeleteCommand
  | ConfigurationChatPresetCreateCommand
  | ConfigurationChatPresetCreateAndLinkCommand
  | ConfigurationChatPresetUpdateCommand
  | ConfigurationChatPresetDuplicateCommand
  | ConfigurationChatPresetMoveCommand
  | ConfigurationChatPresetSetArchivedCommand
  | ConfigurationChatPresetTouchCommand
  | ConfigurationChatPresetDeleteCommand
  | ConfigurationChatPresetApplyCommand
  | ConfigurationChatPresetSaveCommand
  | ConfigurationPromptLocalCommitCommand
  | ConfigurationPromptLoadAndPinCommand
  | ConfigurationPromptOverwriteAndPinCommand
  | ConfigurationPromptCreateAndPinCommand
  | ConfigurationPromptPutCommand
  | ConfigurationPromptUpdateCommand
  | ConfigurationPromptRenameCommand
  | ConfigurationPromptTouchCommand
  | ConfigurationPromptDeleteCommand

export type ConfigurationDomainCommandKind = ConfigurationDomainCommandUnion['kind']

export type ConfigurationDomainCommand<
  Kind extends ConfigurationDomainCommandKind = ConfigurationDomainCommandKind,
> = Extract<ConfigurationDomainCommandUnion, { readonly kind: Kind }>

type ConfigurationMissingEntity =
  | 'chat'
  | 'profile'
  | 'key'
  | 'chat-preset'
  | 'prompt-preset'
  | 'text-template'

type ConfigurationDomainResultUnion =
  | {
      readonly kind: 'configuration-noop'
    }
  | {
      readonly kind: 'connection-saved'
      readonly profile: ConnectionProfile
      readonly key?: KeyRecord
      readonly initialPreset?: ChatPreset
      readonly affectedChatIds?: readonly ChatId[]
      readonly fallbackProfileId?: ProfileId | null
    }
  | {
      readonly kind: 'connection-delete-blocked'
      readonly profileId: ProfileId
      readonly presetCount: number
      readonly chatCount: number
    }
  | {
      readonly kind: 'connection-deleted'
      readonly profileId: ProfileId
      readonly affectedPresetIds: readonly PresetId[]
      readonly affectedChatIds: readonly ChatId[]
      readonly deletedKeyIds: readonly KeyId[]
      readonly fallbackProfileId: ProfileId | null
    }
  | {
      readonly kind: 'key-saved'
      readonly keyId: KeyId
      readonly key?: KeyRecord
      readonly changed: boolean
      readonly deleted: boolean
    }
  | {
      readonly kind: 'chat-updated'
      readonly chatId: ChatId
      readonly chat: Chat
      readonly changed: boolean
      readonly configurationVersion: number
      readonly pendingModelResolution?: PendingModelResolution
      readonly affectedProfileIds?: readonly ProfileId[]
    }
  | {
      readonly kind: 'workspace-setting-saved'
      readonly key: string
      readonly value: unknown
      readonly changed: boolean
      readonly affectedChatIds?: readonly ChatId[]
      readonly affectedPresetIds?: readonly PresetId[]
    }
  | {
      readonly kind: 'text-template-saved'
      readonly templateId: TextTemplateId
      readonly changed: boolean
      readonly deleted?: boolean
      readonly affectedChatIds?: readonly ChatId[]
      readonly affectedPresetIds?: readonly PresetId[]
    }
  | {
      readonly kind: 'chat-preset-saved'
      readonly preset: ChatPreset
      readonly chatId?: ChatId
      readonly chatChanged?: boolean
      readonly configurationVersion?: number
      readonly affectedPresetIds?: readonly PresetId[]
      readonly affectedChatIds?: readonly ChatId[]
    }
  | {
      readonly kind: 'prompt-preset-saved'
      readonly preset?: PromptPreset
      readonly chatId?: ChatId
      readonly configurationVersion?: number
      readonly affectedChatCount?: number
      readonly affectedPresetCount?: number
      readonly affectedChatIds?: readonly ChatId[]
      readonly affectedPresetIds?: readonly PresetId[]
    }
  | {
      readonly kind: 'missing'
      readonly entity: ConfigurationMissingEntity
      readonly id: string
    }
  | {
      readonly kind: 'conflict'
      readonly reason:
        | 'configuration-version'
        | 'profile-request-revision'
        | 'key-material-revision'
        | 'model-resolution-intent'
        | 'link-changed'
      readonly currentVersion?: number
    }
  | {
      readonly kind: 'invalid'
      readonly reason:
        | 'profile-key-mismatch'
        | 'profile-reassign-self'
        | 'profile-reassign-archived'
        | 'preset-profile-mismatch'
        | 'prompt-kind-mismatch'
        | 'model-resolution-target-mismatch'
        | 'coupled-setting-command-required'
        | 'preset-order-anchor-self'
        | 'preset-order-target-archived'
        | 'preset-order-anchor-archived'
    }

type ResultOfKind<Kind extends ConfigurationDomainResultUnion['kind']> = Extract<
  ConfigurationDomainResultUnion,
  { readonly kind: Kind }
>

type ConfigurationMissingResult = ResultOfKind<'missing'>
type ConfigurationConflictResult = ResultOfKind<'conflict'>
type ConfigurationInvalidResult = ResultOfKind<'invalid'>
type ConfigurationCommandFailure =
  | ConfigurationMissingResult
  | ConfigurationConflictResult
  | ConfigurationInvalidResult
type ConnectionSavedResult = ResultOfKind<'connection-saved'>
type KeySavedResult = ResultOfKind<'key-saved'>
type ChatUpdatedResult = ResultOfKind<'chat-updated'>
type WorkspaceSettingSavedResult = ResultOfKind<'workspace-setting-saved'>
type TextTemplateSavedResult = ResultOfKind<'text-template-saved'>
type ChatPresetSavedResult = ResultOfKind<'chat-preset-saved'>
type PromptPresetSavedResult = ResultOfKind<'prompt-preset-saved'>

interface ConfigurationDomainCommandMap {
  'connection.create': ConfigurationConnectionCreateCommand
  'connection.edit': ConfigurationConnectionEditCommand
  'connection.duplicate': ConfigurationConnectionDuplicateCommand
  'connection.touch': ConfigurationConnectionTouchCommand
  'connection.delete': ConfigurationConnectionDeleteCommand
  'key.put': ConfigurationKeyPutCommand
  'key.touch': ConfigurationKeyTouchCommand
  'key.material-replace': ConfigurationKeyMaterialReplaceCommand
  'key.delete': ConfigurationKeyDeleteCommand
  'chat.switch-profile': ConfigurationChatSwitchCommand
  'chat.resolve-model': ConfigurationChatResolveModelCommand
  'chat.settings-patch': ConfigurationChatSettingsPatchCommand
  'chat.settings-fields-patch': ConfigurationChatSettingsFieldsPatchCommand
  'chat.settings-replace': ConfigurationChatSettingsReplaceCommand
  'image-allowlist.add': ConfigurationImageAllowlistAddCommand
  'image-allowlist.remove': ConfigurationImageAllowlistRemoveCommand
  'rendering-preferences.patch': ConfigurationRenderingPatchCommand
  'sample-prompts.set-dismissed': ConfigurationSamplePromptsDismissCommand
  'install-secret.ensure': ConfigurationInstallSecretEnsureCommand
  'global-preference.set': ConfigurationGlobalPreferenceSetCommand
  'global-preference.delete': ConfigurationGlobalPreferenceDeleteCommand
  'pinned-model.set-membership': ConfigurationPinnedModelMembershipCommand
  'pinned-model.move': ConfigurationPinnedModelMoveCommand
  'pinned-model.clear': ConfigurationPinnedModelClearCommand
  'recent-model.bump': ConfigurationRecentModelBumpCommand
  'recent-model.clear': ConfigurationRecentModelClearCommand
  'sidebar-preference.set-sort': ConfigurationSidebarSortCommand
  'sidebar-preference.set-folder-collapsed': ConfigurationSidebarFolderCommand
  'text-template.create': ConfigurationTextTemplateCreateCommand
  'text-template.update': ConfigurationTextTemplateUpdateCommand
  'text-template.create-and-select': ConfigurationTextTemplateCreateAndSelectCommand
  'text-template.delete': ConfigurationTextTemplateDeleteCommand
  'chat-preset.create-and-link': ConfigurationChatPresetCreateAndLinkCommand
  'chat-preset.create': ConfigurationChatPresetCreateCommand
  'chat-preset.update': ConfigurationChatPresetUpdateCommand
  'chat-preset.duplicate': ConfigurationChatPresetDuplicateCommand
  'chat-preset.move': ConfigurationChatPresetMoveCommand
  'chat-preset.set-archived': ConfigurationChatPresetSetArchivedCommand
  'chat-preset.touch': ConfigurationChatPresetTouchCommand
  'chat-preset.delete': ConfigurationChatPresetDeleteCommand
  'chat-preset.apply': ConfigurationChatPresetApplyCommand
  'chat-preset.save': ConfigurationChatPresetSaveCommand
  'prompt-preset.local-commit': ConfigurationPromptLocalCommitCommand
  'prompt-preset.load-and-pin': ConfigurationPromptLoadAndPinCommand
  'prompt-preset.overwrite-and-pin': ConfigurationPromptOverwriteAndPinCommand
  'prompt-preset.create-and-pin': ConfigurationPromptCreateAndPinCommand
  'prompt-preset.rename': ConfigurationPromptRenameCommand
  'prompt-preset.put': ConfigurationPromptPutCommand
  'prompt-preset.update': ConfigurationPromptUpdateCommand
  'prompt-preset.touch': ConfigurationPromptTouchCommand
  'prompt-preset.delete': ConfigurationPromptDeleteCommand
}

interface ConfigurationDomainResultMap {
  'connection.create': ConnectionSavedResult | ConfigurationCommandFailure
  'connection.edit': ConnectionSavedResult | ConfigurationCommandFailure
  'connection.duplicate':
    | ConnectionSavedResult
    | ConfigurationMissingResult
    | ConfigurationConflictResult
  'connection.touch': ConnectionSavedResult | ConfigurationMissingResult
  'connection.delete':
    | ResultOfKind<'connection-delete-blocked' | 'connection-deleted'>
    | ConfigurationMissingResult
    | ConfigurationInvalidResult
  'key.put': KeySavedResult | ConfigurationMissingResult | ConfigurationConflictResult
  'key.touch': KeySavedResult | ConfigurationMissingResult | ConfigurationConflictResult
  'key.material-replace': KeySavedResult | ConfigurationMissingResult | ConfigurationConflictResult
  'key.delete': KeySavedResult | ConfigurationMissingResult | ConfigurationConflictResult
  'chat.switch-profile': ChatUpdatedResult | ConfigurationCommandFailure
  'chat.resolve-model': ChatUpdatedResult | ConfigurationCommandFailure
  'chat.settings-patch': ChatUpdatedResult | ConfigurationCommandFailure
  'chat.settings-fields-patch': ChatUpdatedResult | ConfigurationCommandFailure
  'chat.settings-replace': ChatUpdatedResult | ConfigurationCommandFailure
  'image-allowlist.add': WorkspaceSettingSavedResult | ConfigurationCommandFailure
  'image-allowlist.remove': WorkspaceSettingSavedResult | ConfigurationCommandFailure
  'rendering-preferences.patch': WorkspaceSettingSavedResult | ConfigurationCommandFailure
  'sample-prompts.set-dismissed': WorkspaceSettingSavedResult | ConfigurationCommandFailure
  'install-secret.ensure': WorkspaceSettingSavedResult | ConfigurationCommandFailure
  'global-preference.set': WorkspaceSettingSavedResult | ConfigurationCommandFailure
  'global-preference.delete': WorkspaceSettingSavedResult | ConfigurationCommandFailure
  'pinned-model.set-membership': WorkspaceSettingSavedResult | ConfigurationCommandFailure
  'pinned-model.move': WorkspaceSettingSavedResult | ConfigurationCommandFailure
  'pinned-model.clear': WorkspaceSettingSavedResult | ConfigurationCommandFailure
  'recent-model.bump': WorkspaceSettingSavedResult | ConfigurationCommandFailure
  'recent-model.clear': WorkspaceSettingSavedResult | ConfigurationCommandFailure
  'sidebar-preference.set-sort': WorkspaceSettingSavedResult | ConfigurationCommandFailure
  'sidebar-preference.set-folder-collapsed':
    | WorkspaceSettingSavedResult
    | ConfigurationCommandFailure
  'text-template.create': TextTemplateSavedResult | ConfigurationCommandFailure
  'text-template.update': TextTemplateSavedResult | ConfigurationCommandFailure
  'text-template.create-and-select': TextTemplateSavedResult | ConfigurationCommandFailure
  'text-template.delete': TextTemplateSavedResult | ConfigurationCommandFailure
  'chat-preset.create-and-link':
    | ChatPresetSavedResult
    | ResultOfKind<'configuration-noop'>
    | ConfigurationCommandFailure
  'chat-preset.create':
    | ChatPresetSavedResult
    | ResultOfKind<'configuration-noop'>
    | ConfigurationCommandFailure
  'chat-preset.update':
    | ChatPresetSavedResult
    | ResultOfKind<'configuration-noop'>
    | ConfigurationCommandFailure
  'chat-preset.duplicate':
    | ChatPresetSavedResult
    | ResultOfKind<'configuration-noop'>
    | ConfigurationCommandFailure
  'chat-preset.move':
    | ChatPresetSavedResult
    | ResultOfKind<'configuration-noop'>
    | ConfigurationCommandFailure
  'chat-preset.set-archived':
    | ChatPresetSavedResult
    | ResultOfKind<'configuration-noop'>
    | ConfigurationCommandFailure
  'chat-preset.touch':
    | ChatPresetSavedResult
    | ResultOfKind<'configuration-noop'>
    | ConfigurationCommandFailure
  'chat-preset.delete':
    | ChatPresetSavedResult
    | ResultOfKind<'configuration-noop'>
    | ConfigurationCommandFailure
  'chat-preset.apply':
    | ChatPresetSavedResult
    | ResultOfKind<'configuration-noop'>
    | ConfigurationCommandFailure
  'chat-preset.save':
    | ChatPresetSavedResult
    | ResultOfKind<'configuration-noop'>
    | ConfigurationCommandFailure
  'prompt-preset.local-commit': PromptPresetSavedResult | ConfigurationCommandFailure
  'prompt-preset.load-and-pin': PromptPresetSavedResult | ConfigurationCommandFailure
  'prompt-preset.overwrite-and-pin': PromptPresetSavedResult | ConfigurationCommandFailure
  'prompt-preset.create-and-pin': PromptPresetSavedResult | ConfigurationCommandFailure
  'prompt-preset.rename': PromptPresetSavedResult | ConfigurationCommandFailure
  'prompt-preset.put': PromptPresetSavedResult | ConfigurationCommandFailure
  'prompt-preset.update': PromptPresetSavedResult | ConfigurationCommandFailure
  'prompt-preset.touch': PromptPresetSavedResult | ConfigurationCommandFailure
  'prompt-preset.delete': PromptPresetSavedResult | ConfigurationCommandFailure
}

type AssertSameKeys<Left, Right> =
  Exclude<keyof Left, keyof Right> extends never
    ? Exclude<keyof Right, keyof Left> extends never
      ? true
      : never
    : never

const configurationDomainContractKeysAreExact: AssertSameKeys<
  ConfigurationDomainCommandMap,
  ConfigurationDomainResultMap
> = true
void configurationDomainContractKeysAreExact

export type ConfigurationDomainResult<
  Kind extends ConfigurationDomainCommandKind = ConfigurationDomainCommandKind,
> = ConfigurationDomainResultMap[Kind]

export type ConfigurationDomainHandlerMap<Context, Meta> = {
  readonly [Kind in ConfigurationDomainCommandKind]: (
    context: Context,
    command: ConfigurationDomainCommandMap[Kind],
    meta: Meta,
  ) => Promise<ConfigurationDomainResultMap[Kind]>
}

export interface ConfigurationDomainPort {
  execute<Command extends ConfigurationDomainCommand>(
    command: Command,
  ): Promise<ConfigurationDomainResultMap[Command['kind']]>
}

export function buildConnectionProfile(input: ConfigurationProfileDraftInput): ConnectionProfile {
  const now = input.now ?? Date.now()
  const defaults = connectionKindDefaults(input.kind, input.baseUrl)
  const profile: ConnectionProfile = {
    id: input.id ?? newId(),
    name: input.name,
    kind: input.kind,
    baseUrl: input.baseUrl,
    defaultHeaders: { ...(input.defaultHeaders ?? {}) },
    appTitle: input.appTitle ?? 'llm-api-frontend',
    appUrl: input.appUrl ?? '',
    supportsEndpointsApi: input.supportsEndpointsApi ?? defaults.supportsEndpointsApi,
    supportsGenerationApi: input.supportsGenerationApi ?? defaults.supportsGenerationApi,
    supportsPrivacyScrape: input.supportsPrivacyScrape ?? defaults.supportsPrivacyScrape,
    requestRevision: 0,
    createdAt: now,
    updatedAt: now,
  }
  if (input.apiKeyRef !== undefined) profile.apiKeyRef = input.apiKeyRef
  const fallbackRefs = connectionDispatchFallbackKeyRefs(input)
  if (fallbackRefs.length > 0) profile.apiKeyFallbackRefs = fallbackRefs
  if (input.managementApiKeyRef !== undefined) {
    profile.managementApiKeyRef = input.managementApiKeyRef
  }
  if (input.appCategories?.length) profile.appCategories = [...input.appCategories]
  if (input.capabilityOverrides !== undefined) {
    profile.capabilityOverrides = structuredClone(input.capabilityOverrides)
  }
  if (input.debugRequests !== undefined) profile.debugRequests = input.debugRequests
  return profile
}

export function configurationOwnerKey(kind: ConfigurationLinkOwnerKind, id: string): string {
  return `${kind}:${id}`
}

export function configurationTargetKey(kind: ConfigurationLinkTargetKind, id: string): string {
  return `${kind}:${id}`
}

export function configurationTargetResourceNamesForLinks(
  links: readonly ConfigurationLink[],
): string[] {
  return [...new Set(links.map((link) => `configuration-target:${link.targetKey}`))].sort()
}

export function configurationLinksForProfile(profile: ConnectionProfile): ConfigurationLink[] {
  return [...configurationLinksForProfileIterable(profile)]
}

export function* configurationLinksForProfileIterable(
  profile: ConnectionProfile,
): Iterable<ConfigurationLink> {
  if (profile.apiKeyRef) {
    yield configurationLink('profile', profile.id, 'key', profile.apiKeyRef, 'primary-key')
  }
  let fallbackIndex = 0
  for (const keyId of connectionDispatchFallbackKeyRefsIterable(profile)) {
    yield configurationLink('profile', profile.id, 'key', keyId, `fallback-key:${fallbackIndex}`)
    fallbackIndex += 1
  }
  if (profile.managementApiKeyRef) {
    yield configurationLink(
      'profile',
      profile.id,
      'key',
      profile.managementApiKeyRef,
      'management-key',
    )
  }
}

export function configurationRequestRevisionFor(
  profile: ConnectionProfile,
  key: KeyRecord | undefined,
): ConfigurationRequestRevision {
  return {
    profileId: profile.id,
    requestRevision: profile.requestRevision ?? 0,
    key:
      profile.apiKeyRef && key?.id === profile.apiKeyRef
        ? {
            kind: 'material',
            keyId: key.id,
            materialRevision: key.materialRevision ?? 0,
          }
        : { kind: 'missing' },
  }
}

export function configurationRequestRevisionKey(revision: ConfigurationRequestRevision): string {
  return JSON.stringify(
    revision.key.kind === 'material'
      ? [
          revision.profileId,
          revision.requestRevision,
          revision.key.keyId,
          revision.key.materialRevision,
        ]
      : [revision.profileId, revision.requestRevision, null],
  )
}

export function applyConnectionProfilePatch(
  profile: ConnectionProfile,
  patch: ConfigurationConnectionEditCommand['patch'],
  now: number,
): ConnectionProfile {
  const kindChanged = patch.kind !== undefined && patch.kind !== profile.kind
  const kindDefaults = kindChanged
    ? connectionKindDefaults(
        patch.kind as ConnectionProfile['kind'],
        patch.baseUrl ?? profile.baseUrl,
      )
    : null
  const next: ConnectionProfile = {
    ...profile,
    ...patch,
    ...(kindDefaults && patch.supportsEndpointsApi === undefined
      ? { supportsEndpointsApi: kindDefaults.supportsEndpointsApi }
      : {}),
    ...(kindDefaults && patch.supportsGenerationApi === undefined
      ? { supportsGenerationApi: kindDefaults.supportsGenerationApi }
      : {}),
    ...(kindDefaults && patch.supportsPrivacyScrape === undefined
      ? { supportsPrivacyScrape: kindDefaults.supportsPrivacyScrape }
      : {}),
    id: profile.id,
    createdAt: profile.createdAt,
    updatedAt: now,
  }
  const fallbackRefs = connectionDispatchFallbackKeyRefs(next)
  if (fallbackRefs.length > 0) next.apiKeyFallbackRefs = fallbackRefs
  else delete next.apiKeyFallbackRefs
  next.requestRevision =
    (profile.requestRevision ?? 0) + (profileRequestMaterialChanged(profile, next) ? 1 : 0)
  return next
}

export function profileRequestMaterialChanged(
  current: ConnectionProfile,
  next: ConnectionProfile,
): boolean {
  return !sameConfigurationValue(profileRequestMaterial(current), profileRequestMaterial(next))
}

export function configurationLinksForChat(chat: Chat): ConfigurationLink[] {
  const links = configurationLinksForSettings(
    'chat',
    chat.id,
    chat.settings,
    chat.presetId,
    undefined,
    chat.archived !== true,
  )
  if (chat.modelResolution) {
    links.push(
      configurationLink(
        'chat',
        chat.id,
        'model-resolution',
        configurationRequestRevisionKey(chat.modelResolution.target),
        'model-resolution',
      ),
    )
  }
  return links
}

export function chatConfigurationTargetResourceNames(chat: Chat): string[] {
  return configurationTargetResourceNamesForLinks(configurationLinksForChat(chat))
}

export function configurationLinksForPreset(preset: ChatPreset): ConfigurationLink[] {
  return configurationLinksForSettings(
    'chat-preset',
    preset.id,
    preset.settings,
    undefined,
    preset.connectionProfileId,
    preset.archived !== true,
  )
}

function configurationLinksForSettings(
  ownerKind: 'chat' | 'chat-preset',
  ownerId: string,
  settings: ChatSettings,
  presetId?: PresetId,
  profileId = settings.profileId,
  ownerActive = true,
): ConfigurationLink[] {
  const links = [
    configurationLink(ownerKind, ownerId, 'profile', profileId, 'profile', ownerActive),
  ]
  if (ownerKind === 'chat' && presetId) {
    links.push(configurationLink(ownerKind, ownerId, 'chat-preset', presetId, 'breadcrumb'))
  }
  const pins: Array<[string, PromptPresetId | undefined]> = [
    ['system-prompt', settings.systemPromptPresetId],
    ['append-prompt', settings.appendPromptPresetId],
    ['continue-system-prompt', settings.continueSystemPromptPresetId],
    ['continue-user-prompt', settings.continueUserPromptPresetId],
    ['prefill-prompt', settings.defaultPrefillPresetId],
  ]
  for (const [slot, promptPresetId] of pins) {
    if (promptPresetId) {
      links.push(configurationLink(ownerKind, ownerId, 'prompt-preset', promptPresetId, slot))
    }
  }
  const textTemplateId = settings.textTemplate
  if (textTemplateId && !isStaticTextTemplateId(textTemplateId)) {
    links.push(
      configurationLink(ownerKind, ownerId, 'text-template', textTemplateId, 'text-template'),
    )
  }
  return links
}

function configurationLink(
  ownerKind: ConfigurationLinkOwnerKind,
  ownerId: string,
  targetKind: ConfigurationLinkTargetKind,
  targetId: string,
  slot: string,
  ownerActive?: boolean,
): ConfigurationLink {
  const ownerKey = configurationOwnerKey(ownerKind, ownerId)
  const targetKey = configurationTargetKey(targetKind, targetId)
  return {
    id: `${ownerKey}:${slot}`,
    ownerKind,
    ownerId,
    ownerKey,
    targetKind,
    targetId,
    targetKey,
    slot,
    ...(ownerActive === undefined ? {} : { ownerActive }),
  }
}

function profileRequestMaterial(profile: ConnectionProfile): unknown {
  return {
    kind: profile.kind,
    baseUrl: profile.baseUrl,
    apiKeyRef: profile.apiKeyRef ?? null,
    apiKeyFallbackRefs: connectionDispatchKeyRefs(profile).filter(
      (ref) => ref !== profile.apiKeyRef,
    ),
    managementApiKeyRef: profile.managementApiKeyRef ?? null,
    defaultHeaders: profile.defaultHeaders,
    appTitle: profile.appTitle,
    appUrl: profile.appUrl,
    appCategories: profile.appCategories ?? [],
    supportsEndpointsApi: profile.supportsEndpointsApi,
    supportsGenerationApi: profile.supportsGenerationApi,
    supportsPrivacyScrape: profile.supportsPrivacyScrape,
    capabilityOverrides: profile.capabilityOverrides ?? null,
  }
}

export function sameConfigurationValue(left: unknown, right: unknown): boolean {
  return sameValue(left, right)
}
