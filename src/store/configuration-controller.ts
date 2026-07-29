import {
  applyChatSettingsFieldPatches,
  applyChatSettingsPatch,
  applyLocalPromptValue,
  type ChatSettingsFieldPatch,
  type ChatSettingsPatch,
  chatSettingsPromptPresetReferences,
  normalizeChatSettings,
  sameChatSettings,
} from '../core/chat-metadata'
import {
  type ConnectionDispatchProfileProof,
  connectionDispatchKeyRefs,
  connectionDispatchProfileProof,
} from '../core/connection-dispatch-proof'
import { cloneDefaultChatSettings } from '../core/defaults'
import {
  corsProxyConfigFromPrefs,
  GENERATION_GLOBAL_PREFERENCE_KEYS,
  GLOBAL_PREFERENCE_KEYS,
  globalPreferencesWithStoredValue,
} from '../core/global-settings'
import type { KeyDispatchRevision } from '../core/key-dispatch-proof'
import {
  normalizeRenderingPreferences,
  RENDERING_PREFERENCES_KEY,
  type RenderingPreferences,
} from '../core/rendering-preferences'
import {
  normalizeCollapsedSidebarFolderIds,
  parseSidebarSortMode,
  SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
  SIDEBAR_SORT_SETTING_KEY,
} from '../core/sidebar-sort'
import {
  isStaticTextTemplateId,
  normalizeTextTemplateConfig,
  type SavedTextTemplateCatalogRow,
} from '../core/text-templates'
import type {
  Chat,
  ChatId,
  ChatSettings,
  ConfigurationRequestRevision,
  FolderId,
  GlobalTokenCalibration,
  PresetId,
  ProfileId,
  PromptPresetKind,
  TextTemplateConfig,
  TextTemplateId,
} from '../core/types'
import { browserSessionStorage } from '../lib/browser-storage'
import { PersistentStringMap } from '../lib/persistent-string-map'
import {
  ConfigurationDiscoveryCoordinator,
  type ConfigurationDiscoverySnapshot,
  type ConfigurationDiscoverySurface,
} from './configuration-discovery-coordinator'
import {
  chatConfigurationTargetResourceNames,
  configurationRequestRevisionKey,
} from './configuration-domain-contract'
import type { ConversationSnapshot } from './conversation-controller'
import type { GenerationSavedTextTemplateReadProof, WorkspaceFence } from './repository'
import type { WorkspaceEffect } from './workspace-effect-hub'
import type {
  ConfigurationActiveModelKnownPayloads,
  ConfigurationActiveModelProjection,
  ConfigurationActiveModelRead,
  ConfigurationActiveSelectionProjection,
  ConfigurationDiscoveryPayloadProjection,
  ConfigurationDiscoveryPayloadToken,
  ConfigurationModelCatalogProjection,
  ConfigurationModelRoutingProjection,
  ConfigurationPreferencesProjection,
  ConfigurationSelectedPreset,
  ConfigurationSelectedProfile,
  ConfigurationSelectedPromptPreset,
  ConfigurationSelectedTextTemplate,
  ConfigurationSelectionQueryTarget,
  ConfigurationShellProjection,
  PendingChatSettingsFieldIntent,
  PendingChatSettingsReplacementIntent,
  PendingConfigurationAcknowledgement,
  PendingPromptConfiguration,
  PendingPromptConfigurationAcknowledgement,
  PendingPromptFieldIntent,
  PendingTextTemplateConfigIntent,
  PendingWorkspaceSettingIntent,
  WorkspaceDependency,
} from './workspace-protocol'
import { workspaceDependenciesOverlap, workspaceQueryDependencies } from './workspace-protocol'
import { ACTIVE_CONFIGURATION_SEED_KEY, workspaceTabSessionMatches } from './workspace-tab-session'

export interface ActiveConfigurationSeed {
  readonly profileId: ProfileId | null
  readonly presetId: PresetId | null
  readonly settings: ChatSettings | null
}

type ActiveConfigurationSeedState =
  | { readonly kind: 'resolved'; readonly value: ActiveConfigurationSeed }
  | { readonly kind: 'workspace-default'; readonly value: ActiveConfigurationSeed }

export type ActiveConfigurationTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'chat-resolving'; readonly chatId: ChatId }
  | {
      readonly kind: 'new-chat'
      readonly seedKind: ActiveConfigurationSeedState['kind']
      readonly seedRevision: number
      readonly settings: ChatSettings
      readonly profileId: ProfileId | null
      readonly presetId: PresetId | null
    }
  | {
      readonly kind: 'chat'
      readonly chatId: ChatId
      readonly configurationVersion: number
      readonly overlayRevision: number
      readonly settings: ChatSettings
      readonly profileId: ProfileId | null
      readonly presetId: PresetId | null
      readonly configurationLinkProof: {
        readonly expectedResourceNames: readonly string[]
        readonly persistedPresetId: PresetId | null
      }
    }

export type ActiveConfigurationSelectionTarget = Exclude<
  ActiveConfigurationTarget,
  { readonly kind: 'none' } | { readonly kind: 'chat-resolving' }
>

export interface ActiveConfigurationSelection {
  readonly profile: ConfigurationSelectedProfile | null
  readonly preset: ConfigurationSelectedPreset | null
  readonly requestRevision: ConfigurationRequestRevision | null
  readonly dispatchKeyRevisions: readonly KeyDispatchRevision[]
  readonly promptPresets: readonly ConfigurationSelectedPromptPreset[]
  readonly textTemplate: ConfigurationSelectedTextTemplate | null
}

export interface ActiveConfigurationModelTarget {
  readonly profileId: ProfileId
  readonly modelId: string | null
  readonly requestRevision: ConfigurationRequestRevision
  readonly proxy: ConfigurationModelRoutingProjection['proxy']
  readonly profile: ConfigurationSelectedProfile
  readonly settings: ChatSettings
}

export interface ActiveConfigurationModel {
  readonly models?: ConfigurationModelCatalogProjection['models']
  readonly endpoints?: ConfigurationModelRoutingProjection['endpoints']
  readonly privacy?: ConfigurationModelRoutingProjection['privacy']
  readonly proxy: ConfigurationModelRoutingProjection['proxy']
  readonly payloadTokens: ConfigurationActiveModelKnownPayloads
  readonly discovery: ConfigurationDiscoverySnapshot
}

export type ConfigurationFrameRetention<Target, Value> =
  | { readonly kind: 'same-target'; readonly value: Value }
  | { readonly kind: 'previous-target'; readonly target: Target; readonly value: Value }

export type ConfigurationFrameSlot<Target, Value> =
  | { readonly status: 'absent'; readonly revision: number }
  | {
      readonly status: 'pending'
      readonly revision: number
      readonly target: Target
      readonly retained: ConfigurationFrameRetention<Target, Value> | null
    }
  | {
      readonly status: 'ready'
      readonly revision: number
      readonly target: Target
      readonly value: Value
    }
  | {
      readonly status: 'error'
      readonly revision: number
      readonly target: Target
      readonly error: string
      readonly retained: ConfigurationFrameRetention<Target, Value> | null
    }

export type ConfigurationModelFrameSlot =
  | ConfigurationFrameSlot<ActiveConfigurationModelTarget, ActiveConfigurationModel>
  | {
      readonly status: 'blocked'
      readonly revision: number
      readonly retained: {
        readonly target: ActiveConfigurationModelTarget
        readonly value: ActiveConfigurationModel
      } | null
    }

export type ConfigurationSelectionFrameSlot =
  | ConfigurationFrameSlot<ActiveConfigurationSelectionTarget, ActiveConfigurationSelection>
  | {
      readonly status: 'resolving'
      readonly revision: number
      readonly target: Extract<ActiveConfigurationTarget, { readonly kind: 'chat-resolving' }>
      readonly retained: {
        readonly kind: 'previous-target'
        readonly target: ActiveConfigurationSelectionTarget
        readonly value: ActiveConfigurationSelection
      } | null
    }

export type ActiveGenerationConfigurationCapability =
  | 'pending'
  | 'connection-missing'
  | 'configuration-missing'
  | 'failed'
  | 'ready'

export type ActiveGenerationConfigurationRequirement =
  | { readonly kind: 'new-chat' }
  | {
      readonly kind: 'chat'
      readonly chatId: ChatId
      readonly settingsPatch?: ChatSettingsPatch
    }

export interface ActiveGenerationConfigurationClaim {
  readonly settings: ChatSettings
  readonly presetId: PresetId | null
  readonly profile: ConnectionDispatchProfileProof
  readonly requestRevision: ConfigurationRequestRevision
  readonly dispatchKeyRevisions: readonly KeyDispatchRevision[]
  readonly workspaceSettingOverrides: readonly Pick<
    PendingWorkspaceSettingIntent,
    'key' | 'value'
  >[]
  readonly savedTextTemplate?: GenerationSavedTextTemplateReadProof
}

export type ActiveGenerationConfigurationResolution =
  | { readonly capability: Exclude<ActiveGenerationConfigurationCapability, 'ready'> }
  | {
      readonly capability: 'ready'
      readonly kind: 'new-chat'
      readonly claim: ActiveGenerationConfigurationClaim
    }
  | {
      readonly capability: 'ready'
      readonly kind: 'chat'
      readonly chatId: ChatId
      readonly configurationVersion: number
      readonly configurationLinkTransition: {
        readonly expectedResourceNames: readonly string[]
        readonly nextResourceNames: readonly string[]
      }
      readonly claim: ActiveGenerationConfigurationClaim
    }

const SELECTED_GENERATION_CONFIGURATION_CLAIM = Symbol('selected-generation-configuration-claim')

export interface SelectedGenerationConfigurationClaim {
  readonly [SELECTED_GENERATION_CONFIGURATION_CLAIM]: true
  readonly chatId: ChatId
  readonly workspaceId: string
  readonly replacementEpoch: number
}

export interface ActiveGenerationConfigurationFrame {
  readonly workspaceId: string | null
  readonly replacementEpoch: number | null
  resolve(
    requirement: ActiveGenerationConfigurationRequirement,
  ): ActiveGenerationConfigurationResolution
}

export interface ActiveConfigurationFrame {
  readonly workspace: WorkspaceFence | null
  readonly revision: number
  readonly shell: ConfigurationShellProjection | null
  readonly globalTokenCalibration: GlobalTokenCalibration | null
  readonly textTemplates: readonly SavedTextTemplateCatalogRow[] | null
  readonly target: ActiveConfigurationTarget
  readonly selection: ConfigurationSelectionFrameSlot
  readonly model: ConfigurationModelFrameSlot
  readonly generation: ActiveGenerationConfigurationFrame
}

export function currentActiveConfigurationSelection(frame: ActiveConfigurationFrame): {
  readonly target: ActiveConfigurationSelectionTarget
  readonly value: ActiveConfigurationSelection
} | null {
  const slot = frame.selection
  if (slot.status === 'ready') return { target: slot.target, value: slot.value }
  if (
    (slot.status === 'pending' || slot.status === 'error') &&
    slot.retained?.kind === 'same-target'
  ) {
    return { target: slot.target, value: slot.retained.value }
  }
  return null
}

export function readyActiveConfigurationSelection(frame: ActiveConfigurationFrame): {
  readonly target: ActiveConfigurationSelectionTarget
  readonly value: ActiveConfigurationSelection
} | null {
  const slot = frame.selection
  return slot.status === 'ready' ? { target: slot.target, value: slot.value } : null
}

export function previousActiveConfigurationSelection(frame: ActiveConfigurationFrame): {
  readonly target: ActiveConfigurationSelectionTarget
  readonly value: ActiveConfigurationSelection
} | null {
  const slot = frame.selection
  if (slot.status === 'resolving') {
    return slot.retained ? { target: slot.retained.target, value: slot.retained.value } : null
  }
  if (
    (slot.status === 'pending' || slot.status === 'error') &&
    slot.retained?.kind === 'previous-target'
  ) {
    return { target: slot.retained.target, value: slot.retained.value }
  }
  return null
}

export function currentActiveConfigurationModel(frame: ActiveConfigurationFrame): {
  readonly target: ActiveConfigurationModelTarget
  readonly value: ActiveConfigurationModel
} | null {
  const slot = frame.model
  if (slot.status === 'ready') return { target: slot.target, value: slot.value }
  if (slot.status === 'blocked') return slot.retained
  if (
    (slot.status === 'pending' || slot.status === 'error') &&
    slot.retained?.kind === 'same-target'
  ) {
    return { target: slot.target, value: slot.retained.value }
  }
  return null
}

export function previousActiveConfigurationModel(frame: ActiveConfigurationFrame): {
  readonly target: ActiveConfigurationModelTarget
  readonly value: ActiveConfigurationModel
} | null {
  const slot = frame.model
  if (
    (slot.status === 'pending' || slot.status === 'error') &&
    slot.retained?.kind === 'previous-target'
  ) {
    return { target: slot.retained.target, value: slot.retained.value }
  }
  return null
}

export interface ConfigurationIntent {
  readonly workspaceId: string | null
  readonly replacementEpoch: number | null
  readonly revision: number
}

export type ConfigurationProjectionLoadState =
  | { readonly status: 'idle'; readonly revision: number }
  | {
      readonly status: 'loading'
      readonly target: string
      readonly revision: number
      readonly retainedTarget: string | null
      readonly retained: boolean
    }
  | {
      readonly status: 'ready'
      readonly target: string
      readonly revision: number
    }
  | {
      readonly status: 'error'
      readonly target: string
      readonly revision: number
      readonly error: string
      readonly retainedTarget: string | null
      readonly retained: boolean
    }

export interface ConfigurationProjectionLoadStates {
  readonly shell: ConfigurationProjectionLoadState
  readonly globalTokenCalibration: ConfigurationProjectionLoadState
  readonly textTemplates: ConfigurationProjectionLoadState
}

function configurationProjectionValueTarget(
  state: ConfigurationProjectionLoadState,
): string | null {
  if (state.status === 'ready') return state.target
  if (state.status === 'loading' || state.status === 'error') return state.retainedTarget
  return null
}

function configurationProjectionIsRetained(state: ConfigurationProjectionLoadState): boolean {
  return (state.status === 'loading' || state.status === 'error') && state.retained
}

export interface ConfigurationSnapshot {
  readonly revision: number
  readonly workspaceFence: WorkspaceFence | null
  readonly seed: ActiveConfigurationSeed
  readonly discovery: ConfigurationDiscoverySnapshot
  readonly loads: ConfigurationProjectionLoadStates
  readonly ui: ConfigurationUiSession
  readonly frame: ActiveConfigurationFrame
}

interface ConfigurationUiSession {
  readonly sidebarCollapsed: boolean
  readonly composerHeight: number
  readonly composerNormalManualHeight: number | null
  readonly composerFocusManualHeight: number | null
}

type ConfigurationEditDisposition = 'flush' | 'discard'

export interface ConfigurationEditSession {
  readonly chatId: ChatId | null
  readonly ownerKey: string
  readonly fieldKey: string
  track<T>(operation: Promise<T>): Promise<T>
  flush(): Promise<void>
  close(disposition?: ConfigurationEditDisposition): Promise<void>
}

interface ConfigurationEditSessionInput {
  readonly chatId?: ChatId
  readonly ownerKey?: string
  readonly fieldKey: string
  readonly flush: () => Promise<void>
  readonly kind?: 'mounted' | 'detached'
}

interface ConfigurationEditQueueStats {
  readonly chats: number
  readonly sessions: number
  readonly pendingOperations: number
  readonly pendingChats: number
  readonly mountedChats: number
  readonly mountedSessions: number
}

export interface ConfigurationProjectionSource {
  loadShell(signal: AbortSignal): Promise<ConfigurationShellProjection>
  loadGlobalTokenCalibration(signal: AbortSignal): Promise<GlobalTokenCalibration>
  loadTextTemplateCatalog(signal: AbortSignal): Promise<readonly SavedTextTemplateCatalogRow[]>
  loadActiveSelection(
    target: ConfigurationSelectionQueryTarget,
    signal: AbortSignal,
  ): Promise<ConfigurationActiveSelectionProjection>
  loadActiveModel(
    target: ActiveConfigurationModelTarget,
    knownPayloads: ConfigurationActiveModelKnownPayloads,
    includeModels: boolean,
    signal: AbortSignal,
  ): Promise<ConfigurationActiveModelRead>
}

export interface ConfigurationCatalogChange extends WorkspaceFence {
  readonly dependencies: readonly WorkspaceDependency[] | 'all'
}

export interface ConfigurationController {
  readonly subscribe: (listener: () => void) => () => void
  readonly waitForSnapshotChange: (
    observed: ConfigurationSnapshot,
    signal?: AbortSignal,
  ) => Promise<void>
  readonly subscribeCatalogChanges: (
    listener: (change: ConfigurationCatalogChange) => void,
  ) => () => void
  readonly getSnapshot: () => ConfigurationSnapshot
  reconcileWorkspace(fence: WorkspaceFence): void
  observeConversation(snapshot: ConversationSnapshot): void
  observeWorkspaceEffect(effect: WorkspaceEffect): void
  recoverWorkspaceEffect(effect: WorkspaceEffect): void
  setProjectionSource(source: ConfigurationProjectionSource | null): Promise<void>
  retryProjection(kind: keyof ConfigurationProjectionLoadStates): void
  demandGlobalTokenCalibration(): () => void
  demandTextTemplateCatalog(): () => void
  observeDiscoverySurface(surface: ConfigurationDiscoverySurface | null): void
  refreshModelCatalogDiscovery(profileId: ProfileId): void
  refreshModelRoutingDiscovery(profileId: ProfileId, modelId: string): void
  rememberSeed(seed: ActiveConfigurationSeed): void
  rememberProfile(profileId: ProfileId | null): void
  setSidebarCollapsed(collapsed: boolean): void
  setComposerHeight(variant: 'fixed' | 'normal' | 'focus', height: number | null): void
  openEditSession(input: ConfigurationEditSessionInput): ConfigurationEditSession
  trackDetachedEdit<T>(chatId: ChatId, operation: Promise<T>): Promise<T>
  flushChatEdits(chatId: ChatId): Promise<void>
  flushWorkspaceEdits(ownerKey: string): Promise<void>
  stageChatSettingsIntent(
    chatId: ChatId,
    fieldKey: string,
    patches: readonly ChatSettingsFieldPatch[],
  ): PendingChatSettingsFieldIntent
  stageChatSettingsFields(
    chatId: ChatId,
    patches: readonly ChatSettingsFieldPatch[],
  ): readonly PendingChatSettingsFieldIntent[]
  stageChatSettingsReplacement(
    chatId: ChatId,
    settings: ChatSettings,
    presetId?: PresetId | null,
  ): PendingChatSettingsReplacementIntent
  stageRenderingPreferences(patch: Partial<RenderingPreferences>): PendingWorkspaceSettingIntent
  stageSidebarFolderCollapsed(folderId: FolderId, collapsed: boolean): PendingWorkspaceSettingIntent
  stageWorkspaceSetting(key: string, value: unknown): PendingWorkspaceSettingIntent
  stageTextTemplateConfig(
    templateId: TextTemplateId,
    config: TextTemplateConfig,
  ): PendingTextTemplateConfigIntent
  pendingWorkspaceSetting(key: string): PendingWorkspaceSettingIntent | undefined
  pendingTextTemplateConfig(templateId: TextTemplateId): PendingTextTemplateConfigIntent | undefined
  projectChatConfiguration(chat: Chat): Chat
  claimSelectedGenerationConfiguration(chatId: ChatId): SelectedGenerationConfigurationClaim
  resolveSelectedGenerationConfiguration(
    claim: SelectedGenerationConfigurationClaim,
  ): ActiveGenerationConfigurationResolution
  cancelSelectedGenerationConfiguration(claim: SelectedGenerationConfigurationClaim): void
  acknowledgePendingConfiguration(
    chatId: ChatId | null,
    acknowledgement: PendingConfigurationAcknowledgement,
  ): void
  rejectPendingConfiguration(
    chatId: ChatId | null,
    acknowledgement: PendingConfigurationAcknowledgement,
  ): void
  discardPendingChatSettingsField(chatId: ChatId, fieldKey: string, revision: number): void
  discardPendingChatSettingsReplacement(chatId: ChatId, revision: number): void
  discardPendingWorkspaceSetting(key: string, revision: number): void
  discardPendingTextTemplateConfig(templateId: TextTemplateId, revision: number): void
  stagePromptField(chatId: ChatId, field: PromptPresetKind, value: string): PendingPromptFieldIntent
  pendingPromptConfiguration(chatId: ChatId): PendingPromptConfiguration | undefined
  acknowledgePendingPromptConfiguration(
    chatId: ChatId,
    acknowledgement: PendingPromptConfigurationAcknowledgement,
  ): void
  discardPendingPromptField(chatId: ChatId, field: PromptPresetKind, revision: number): void
  editQueueStats(): ConfigurationEditQueueStats
  claimIntent(): ConfigurationIntent
  intentIsCurrent(intent: ConfigurationIntent): boolean
}

const EMPTY_SEED: ActiveConfigurationSeed = Object.freeze({
  profileId: null,
  presetId: null,
  settings: null,
})

const DEFAULT_UI_SESSION: ConfigurationUiSession = Object.freeze({
  sidebarCollapsed: false,
  composerHeight: 120,
  composerNormalManualHeight: null,
  composerFocusManualHeight: null,
})

const IDLE_PROJECTION_LOAD: ConfigurationProjectionLoadState = Object.freeze({
  status: 'idle',
  revision: 0,
})

const IDLE_PROJECTION_LOADS: ConfigurationProjectionLoadStates = Object.freeze({
  shell: IDLE_PROJECTION_LOAD,
  globalTokenCalibration: IDLE_PROJECTION_LOAD,
  textTemplates: IDLE_PROJECTION_LOAD,
})

type NonReadyActiveGenerationConfigurationResolution = Extract<
  ActiveGenerationConfigurationResolution,
  { readonly capability: Exclude<ActiveGenerationConfigurationCapability, 'ready'> }
>

const PENDING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION = Object.freeze({
  capability: 'pending' as const,
}) satisfies NonReadyActiveGenerationConfigurationResolution
const CONNECTION_MISSING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION = Object.freeze({
  capability: 'connection-missing' as const,
}) satisfies NonReadyActiveGenerationConfigurationResolution
const CONFIGURATION_MISSING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION = Object.freeze({
  capability: 'configuration-missing' as const,
}) satisfies NonReadyActiveGenerationConfigurationResolution
const FAILED_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION = Object.freeze({
  capability: 'failed' as const,
}) satisfies NonReadyActiveGenerationConfigurationResolution

const PENDING_ACTIVE_GENERATION_CONFIGURATION_FRAME: ActiveGenerationConfigurationFrame =
  Object.freeze({
    workspaceId: null,
    replacementEpoch: null,
    resolve: () => PENDING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION,
  })

interface SelectedGenerationConfigurationClaimState {
  readonly claim: SelectedGenerationConfigurationClaim
  readonly workspace: WorkspaceFence
  target: Extract<ActiveConfigurationTarget, { readonly kind: 'chat' }> | null
  promptFields: readonly PendingPromptFieldIntent[]
  workspaceSettingOverrides: ActiveGenerationConfigurationClaim['workspaceSettingOverrides']
  pendingTextTemplates: PersistentStringMap<TextTemplateConfig>
  readonly pendingKeys: Set<string>
  selection: ActiveConfigurationSelection | null
  selectionRead: AbortController | null
  baseResolution: ActiveGenerationConfigurationResolution
  acceptedConfigurationVersion: number | null
  failed: boolean
  active: boolean
}

function emptyConfigurationFrame(workspace: WorkspaceFence | null): ActiveConfigurationFrame {
  return Object.freeze({
    workspace,
    revision: 0,
    shell: null,
    globalTokenCalibration: null,
    textTemplates: null,
    target: Object.freeze({ kind: 'none' }),
    selection: Object.freeze({ status: 'absent', revision: 0 }),
    model: Object.freeze({ status: 'absent', revision: 0 }),
    generation: PENDING_ACTIVE_GENERATION_CONFIGURATION_FRAME,
  })
}

class TabConfigurationController implements ConfigurationController {
  private readonly listeners = new Set<() => void>()
  private readonly catalogListeners = new Set<(change: ConfigurationCatalogChange) => void>()
  private publicationBatchDepth = 0
  private publicationPending = false
  private readonly discovery = new ConfigurationDiscoveryCoordinator({
    onChange: () => {
      this.frameRevision += 1
      this.publish()
    },
  })
  private source: ConfigurationProjectionSource | null = null
  private workspaceFence: WorkspaceFence | null = null
  private conversationChatId: ChatId | null = null
  private activeConversationChat: Chat | null = null
  private intentRevision = 0
  private projectionLoadRevision = 0
  private activeChatSeed: ActiveConfigurationSeed | null = null
  private discoverySurface: ConfigurationDiscoverySurface | null = null
  private modelCatalogDemanded = false
  private shellRead: AbortController | null = null
  private globalTokenCalibrationRead: AbortController | null = null
  private textTemplateCatalogRead: AbortController | null = null
  private globalTokenCalibrationDemand = 0
  private textTemplateCatalogDemand = 0
  private selectionRead: AbortController | null = null
  private activeModelRead: AbortController | null = null
  private frameRevision = 0
  private seedRevision = 0
  private frameShell: ConfigurationShellProjection | null = null
  private frameGlobalTokenCalibration: GlobalTokenCalibration | null = null
  private frameTextTemplates: readonly SavedTextTemplateCatalogRow[] | null = null
  private frameTarget: ActiveConfigurationTarget = Object.freeze({ kind: 'none' })
  private frameSelection: ConfigurationSelectionFrameSlot = Object.freeze({
    status: 'absent',
    revision: 0,
  })
  private frameModel: ConfigurationModelFrameSlot = Object.freeze({
    status: 'absent',
    revision: 0,
  })
  private readonly editSessions = new Map<ChatId, Map<string, TabConfigurationEditSession>>()
  private readonly workspaceEditSessions = new Map<
    string,
    Map<string, TabConfigurationEditSession>
  >()
  private readonly pendingPromptFields = new Map<
    ChatId,
    Map<PromptPresetKind, PendingPromptFieldIntent>
  >()
  private readonly pendingChatSettingsFields = new Map<
    ChatId,
    Map<string, PendingChatSettingsFieldIntent>
  >()
  private readonly pendingChatSettingsReplacements = new Map<
    ChatId,
    PendingChatSettingsReplacementIntent
  >()
  private readonly pendingWorkspaceSettings = new Map<string, PendingWorkspaceSettingIntent>()
  private readonly acceptedWorkspaceSettings = new Map<string, unknown>()
  private readonly uiFieldsOwnedBeforeSeed = new Set<keyof ConfigurationUiSession>()
  private readonly pendingTextTemplateConfigs = new Map<
    TextTemplateId,
    PendingTextTemplateConfigIntent
  >()
  private readonly selectedGenerationConfigurationClaims =
    new Set<SelectedGenerationConfigurationClaimState>()
  private readonly selectedGenerationConfigurationClaimStates = new WeakMap<
    SelectedGenerationConfigurationClaim,
    SelectedGenerationConfigurationClaimState
  >()
  private pendingGenerationTextTemplates = PersistentStringMap.empty<TextTemplateConfig>()
  private readonly pendingPromptGenerationRevisions = new Map<ChatId, number>()
  private generationWorkspaceSettingsRevision = 0
  private activeGenerationFrameCache: {
    readonly workspace: WorkspaceFence
    readonly target: ActiveConfigurationTarget
    readonly selection: ConfigurationSelectionFrameSlot
    readonly shell: ConfigurationShellProjection | null
    readonly shellLoad: ConfigurationProjectionLoadState
    readonly promptRevision: number
    readonly workspaceSettingsRevision: number
    readonly textTemplates: PersistentStringMap<TextTemplateConfig>
    readonly frame: ActiveGenerationConfigurationFrame
  } | null = null
  private detachedEditRevision = 0
  private pendingConfigurationRevision = 0
  private seedState: ActiveConfigurationSeedState = Object.freeze({
    kind: 'resolved',
    value: EMPTY_SEED,
  })
  private loads: ConfigurationProjectionLoadStates = IDLE_PROJECTION_LOADS
  private uiSeeded = false
  private ui: ConfigurationUiSession = DEFAULT_UI_SESSION
  private snapshot: ConfigurationSnapshot = Object.freeze({
    revision: 0,
    workspaceFence: null,
    seed: EMPTY_SEED,
    discovery: this.discovery.getSnapshot(),
    loads: IDLE_PROJECTION_LOADS,
    ui: DEFAULT_UI_SESSION,
    frame: emptyConfigurationFrame(null),
  })

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly waitForSnapshotChange = (
    observed: ConfigurationSnapshot,
    signal?: AbortSignal,
  ): Promise<void> =>
    new Promise((resolve) => {
      let unsubscribe: () => void = () => undefined
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        unsubscribe()
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      const inspect = () => {
        if (this.snapshot !== observed || signal?.aborted) finish()
      }
      unsubscribe = this.subscribe(inspect)
      signal?.addEventListener('abort', finish, { once: true })
      inspect()
    })

  readonly subscribeCatalogChanges = (
    listener: (change: ConfigurationCatalogChange) => void,
  ): (() => void) => {
    this.catalogListeners.add(listener)
    return () => this.catalogListeners.delete(listener)
  }

  readonly getSnapshot = (): ConfigurationSnapshot => this.snapshot

  reconcileWorkspace(fence: WorkspaceFence): void {
    if (
      this.workspaceFence?.workspaceId === fence.workspaceId &&
      this.workspaceFence.replacementEpoch === fence.replacementEpoch
    ) {
      return
    }
    const uiBeforeReconciliation = this.ui
    this.shellRead?.abort()
    this.shellRead = null
    this.globalTokenCalibrationRead?.abort()
    this.globalTokenCalibrationRead = null
    this.textTemplateCatalogRead?.abort()
    this.textTemplateCatalogRead = null
    this.selectionRead?.abort()
    this.selectionRead = null
    this.activeModelRead?.abort()
    this.activeModelRead = null
    for (const claim of this.selectedGenerationConfigurationClaims) {
      claim.active = false
      claim.selectionRead?.abort()
      claim.selectionRead = null
    }
    this.selectedGenerationConfigurationClaims.clear()
    this.discovery.reset()
    this.closeAllEditSessions('discard')
    this.pendingPromptFields.clear()
    this.pendingChatSettingsFields.clear()
    this.pendingChatSettingsReplacements.clear()
    this.pendingWorkspaceSettings.clear()
    this.acceptedWorkspaceSettings.clear()
    this.pendingTextTemplateConfigs.clear()
    this.pendingGenerationTextTemplates = PersistentStringMap.empty()
    this.pendingPromptGenerationRevisions.clear()
    this.generationWorkspaceSettingsRevision = 0
    this.activeGenerationFrameCache = null
    this.workspaceFence = Object.freeze({ ...fence })
    this.conversationChatId = null
    this.activeConversationChat = null
    this.activeChatSeed = null
    this.discoverySurface = null
    this.modelCatalogDemanded = false
    this.intentRevision += 1
    const rememberedSeed = readRememberedConfigurationSeed(fence)
    this.seedState = rememberedSeed.settings
      ? resolvedConfigurationSeedState(rememberedSeed)
      : workspaceDefaultConfigurationSeedState()
    this.seedRevision += 1
    this.loads = IDLE_PROJECTION_LOADS
    this.ui = Object.freeze({
      sidebarCollapsed: this.uiFieldsOwnedBeforeSeed.has('sidebarCollapsed')
        ? uiBeforeReconciliation.sidebarCollapsed
        : DEFAULT_UI_SESSION.sidebarCollapsed,
      composerHeight: this.uiFieldsOwnedBeforeSeed.has('composerHeight')
        ? uiBeforeReconciliation.composerHeight
        : DEFAULT_UI_SESSION.composerHeight,
      composerNormalManualHeight: this.uiFieldsOwnedBeforeSeed.has('composerNormalManualHeight')
        ? uiBeforeReconciliation.composerNormalManualHeight
        : DEFAULT_UI_SESSION.composerNormalManualHeight,
      composerFocusManualHeight: this.uiFieldsOwnedBeforeSeed.has('composerFocusManualHeight')
        ? uiBeforeReconciliation.composerFocusManualHeight
        : DEFAULT_UI_SESSION.composerFocusManualHeight,
    })
    this.uiSeeded = false
    this.frameRevision = 0
    this.frameShell = null
    this.frameGlobalTokenCalibration = null
    this.frameTextTemplates = null
    this.frameTarget = Object.freeze({ kind: 'none' })
    this.frameSelection = Object.freeze({ status: 'absent', revision: 0 })
    this.frameModel = Object.freeze({ status: 'absent', revision: 0 })
    this.reconcileActiveFrameFromCurrentState()
    this.publish()
  }

  observeConversation(snapshot: ConversationSnapshot): void {
    if (
      this.workspaceFence === null ||
      snapshot.workspaceId !== this.workspaceFence.workspaceId ||
      snapshot.workspaceEpoch !== this.workspaceFence.replacementEpoch
    ) {
      return
    }
    const nextChatId = snapshot.activeChatId
    const nextActiveChat =
      nextChatId !== null && snapshot.active?.chatId === nextChatId ? snapshot.active.chat : null
    const nextActiveSeed = nextActiveChat ? activeSeedFromChat(nextActiveChat) : null
    const routeChanged = nextChatId !== this.conversationChatId
    const activeSeedChanged = !sameOptionalSeed(this.activeChatSeed, nextActiveSeed)
    const rememberedSeedChanged = nextActiveSeed !== null && !sameSeed(this.seed, nextActiveSeed)
    if (!routeChanged && !activeSeedChanged && !rememberedSeedChanged) return
    const previousChatId = this.conversationChatId
    this.conversationChatId = nextChatId
    this.activeConversationChat = nextActiveChat
    this.activeChatSeed = nextActiveSeed
    if (rememberedSeedChanged) {
      this.seedState = resolvedConfigurationSeedState(nextActiveSeed)
      this.seedRevision += 1
      this.persistSeed()
    }
    this.intentRevision += 1
    if (routeChanged && previousChatId) this.closeChatEditSessions(previousChatId, 'flush')
    this.withPublicationBatch(() => {
      this.reconcileActiveFrameTarget(snapshot)
      this.publish()
    })
  }

  observeWorkspaceEffect(effect: WorkspaceEffect): void {
    if (!this.matchesWorkspace(effect) || effect.kind === 'replace') return
    this.withPublicationBatch(() => {
      this.invalidateAcceptedWorkspaceSettings(effect.impact)
      this.reloadActiveFrameForDependencies(effect.impact)
    })
    this.publishCatalogChange(effect.impact)
  }

  recoverWorkspaceEffect(effect: WorkspaceEffect): void {
    if (!this.matchesWorkspace(effect)) return
    this.withPublicationBatch(() => {
      this.acceptedWorkspaceSettings.clear()
      this.reloadActiveFrameForDependencies('all')
    })
    this.publishCatalogChange('all')
  }

  setProjectionSource(source: ConfigurationProjectionSource | null): Promise<void>
  setProjectionSource(source: ConfigurationProjectionSource | null): Promise<void> {
    if (this.source === source) {
      return source ? this.awaitProjectionReady('shell', source) : Promise.resolve()
    }
    this.source = source
    this.shellRead?.abort()
    this.shellRead = null
    this.globalTokenCalibrationRead?.abort()
    this.globalTokenCalibrationRead = null
    this.textTemplateCatalogRead?.abort()
    this.textTemplateCatalogRead = null
    this.selectionRead?.abort()
    this.selectionRead = null
    this.activeModelRead?.abort()
    this.activeModelRead = null
    if (source) {
      this.withPublicationBatch(() => {
        void this.loadShell()
        if (this.globalTokenCalibrationDemand > 0) void this.loadGlobalTokenCalibration()
        if (this.textTemplateCatalogDemand > 0) void this.loadTextTemplateCatalog()
        this.loadActiveSelection(true, true)
      })
      return this.awaitProjectionReady('shell', source)
    }
    this.retainProjectionLoadsAcrossSourceGap()
    this.publish()
    return Promise.resolve()
  }

  private awaitProjectionReady(
    kind: keyof ConfigurationProjectionLoadStates,
    source: ConfigurationProjectionSource,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let unsubscribe: () => void = () => undefined
      const inspect = () => {
        if (this.source !== source) {
          unsubscribe()
          reject(new Error('ConfigurationProjectionSourceSuperseded'))
          return
        }
        const load = this.loads[kind]
        if (load.status === 'ready') {
          unsubscribe()
          resolve()
          return
        }
        if (load.status === 'error') {
          unsubscribe()
          reject(new Error(load.error))
        }
      }
      unsubscribe = this.subscribe(inspect)
      inspect()
    })
  }

  retryProjection(kind: keyof ConfigurationProjectionLoadStates): void {
    if (kind === 'shell') void this.loadShell()
    if (kind === 'globalTokenCalibration') void this.loadGlobalTokenCalibration()
    if (kind === 'textTemplates') void this.loadTextTemplateCatalog()
  }

  demandGlobalTokenCalibration(): () => void {
    this.globalTokenCalibrationDemand += 1
    if (
      this.globalTokenCalibrationDemand === 1 &&
      !this.globalTokenCalibrationRead &&
      !this.frameGlobalTokenCalibration
    ) {
      void this.loadGlobalTokenCalibration()
    }
    return this.releaseDemand('globalTokenCalibration')
  }

  demandTextTemplateCatalog(): () => void {
    this.textTemplateCatalogDemand += 1
    if (
      this.textTemplateCatalogDemand === 1 &&
      !this.textTemplateCatalogRead &&
      !this.frameTextTemplates
    ) {
      void this.loadTextTemplateCatalog()
    }
    return this.releaseDemand('textTemplates')
  }

  private releaseDemand(kind: 'globalTokenCalibration' | 'textTemplates'): () => void {
    let active = true
    return () => {
      if (!active) return
      active = false
      if (kind === 'globalTokenCalibration') this.globalTokenCalibrationDemand -= 1
      else this.textTemplateCatalogDemand -= 1
      queueMicrotask(() => {
        const demanded =
          kind === 'globalTokenCalibration'
            ? this.globalTokenCalibrationDemand
            : this.textTemplateCatalogDemand
        if (demanded > 0) return
        if (kind === 'globalTokenCalibration') {
          this.globalTokenCalibrationRead?.abort()
          this.globalTokenCalibrationRead = null
          if (
            !this.frameGlobalTokenCalibration &&
            this.loads.globalTokenCalibration.status === 'idle'
          ) {
            return
          }
          this.frameGlobalTokenCalibration = null
        } else {
          this.textTemplateCatalogRead?.abort()
          this.textTemplateCatalogRead = null
          if (!this.frameTextTemplates && this.loads.textTemplates.status === 'idle') return
          this.frameTextTemplates = null
        }
        this.finishProjectionLoad(kind, {
          status: 'idle',
          revision: ++this.projectionLoadRevision,
        })
        this.frameRevision += 1
        this.publish()
      })
    }
  }

  observeDiscoverySurface(surface: ConfigurationDiscoverySurface | null): void {
    const next = surface ? Object.freeze({ ...surface }) : null
    if (
      this.discoverySurface?.profileId === next?.profileId &&
      this.discoverySurface?.modelId === next?.modelId &&
      this.discoverySurface?.modelsDemanded === next?.modelsDemanded
    ) {
      return
    }
    this.discoverySurface = next
    const demanded = next?.modelsDemanded ?? false
    const demandStarted = demanded && !this.modelCatalogDemanded
    this.modelCatalogDemanded = demanded
    if (demandStarted) {
      this.reconcileActiveModelTarget(true)
      return
    }
    this.publish()
  }

  refreshModelCatalogDiscovery(profileId: ProfileId): void {
    if (this.discoverySurface?.profileId !== profileId) return
    this.discovery.requestModels(profileId)
  }

  refreshModelRoutingDiscovery(profileId: ProfileId, modelId: string): void {
    if (
      this.discoverySurface?.profileId !== profileId ||
      this.discoverySurface.modelId !== modelId
    ) {
      return
    }
    this.discovery.requestRouting(profileId, modelId)
  }

  rememberSeed(seed: ActiveConfigurationSeed): void {
    const next = freezeSeed(seed)
    if (this.seedState.kind === 'resolved' && sameSeed(this.seed, next)) return
    this.seedState = resolvedConfigurationSeedState(next)
    this.seedRevision += 1
    this.intentRevision += 1
    this.persistSeed()
    this.withPublicationBatch(() => {
      this.reconcileActiveFrameFromCurrentState()
      this.publish()
    })
  }

  rememberProfile(profileId: ProfileId | null): void {
    if (!this.replaceRememberedProfile(profileId)) return
    this.withPublicationBatch(() => {
      this.reconcileActiveFrameFromCurrentState()
      this.publish()
    })
  }

  private replaceRememberedProfile(profileId: ProfileId | null): boolean {
    if (!profileId) {
      if (this.seedState.kind === 'resolved' && sameSeed(this.seed, EMPTY_SEED)) return false
      this.seedState = resolvedConfigurationSeedState(EMPTY_SEED)
    } else {
      const settings = this.seed.settings
        ? structuredClone(this.seed.settings)
        : cloneDefaultChatSettings()
      const previousProfileId = settings.profileId || this.seed.profileId
      settings.profileId = profileId
      if (previousProfileId && previousProfileId !== profileId) settings.model = ''
      const next = freezeSeed({ profileId, presetId: null, settings })
      if (this.seedState.kind === 'resolved' && sameSeed(this.seed, next)) return false
      this.seedState = resolvedConfigurationSeedState(next)
    }
    this.seedRevision += 1
    this.intentRevision += 1
    this.persistSeed()
    return true
  }

  setSidebarCollapsed(collapsed: boolean): void {
    if (!this.uiSeeded) this.uiFieldsOwnedBeforeSeed.add('sidebarCollapsed')
    if (this.ui.sidebarCollapsed === collapsed) return
    this.ui = Object.freeze({ ...this.ui, sidebarCollapsed: collapsed })
    this.publish()
  }

  setComposerHeight(variant: 'fixed' | 'normal' | 'focus', height: number | null): void {
    const key =
      variant === 'fixed'
        ? 'composerHeight'
        : variant === 'normal'
          ? 'composerNormalManualHeight'
          : 'composerFocusManualHeight'
    const normalized =
      variant === 'fixed'
        ? Math.min(600, Math.max(80, Math.round(height ?? 120)))
        : height === null
          ? null
          : Math.min(600, Math.max(1, Math.round(height)))
    if (!this.uiSeeded) this.uiFieldsOwnedBeforeSeed.add(key)
    if (this.ui[key] === normalized) return
    this.ui = Object.freeze({ ...this.ui, [key]: normalized })
    this.publish()
  }

  openEditSession(input: ConfigurationEditSessionInput): ConfigurationEditSession {
    if (input.chatId === undefined && input.ownerKey === undefined) {
      throw new Error('ConfigurationEditOwnerRequired')
    }
    const ownerKey = input.ownerKey ?? `chat:${input.chatId}`
    const owners = input.chatId === undefined ? this.workspaceEditSessions : this.editSessions
    const ownerId = input.chatId ?? ownerKey
    let sessions = owners.get(ownerId)
    if (!sessions) {
      sessions = new Map()
      owners.set(ownerId, sessions)
    }
    const previous = sessions.get(input.fieldKey)
    const session = new TabConfigurationEditSession({ ...input, ownerKey }, () =>
      this.releaseEditSession(session),
    )
    sessions.set(input.fieldKey, session)
    if (previous) void previous.close('flush').catch(() => undefined)
    return session
  }

  trackDetachedEdit<T>(chatId: ChatId, operation: Promise<T>): Promise<T> {
    const session = this.openEditSession({
      chatId,
      fieldKey: `detached:${++this.detachedEditRevision}`,
      flush: () => Promise.resolve(),
      kind: 'detached',
    })
    const tracked = session.track(operation)
    void tracked.then(
      () => session.close('discard'),
      () => session.close('discard'),
    )
    return tracked
  }

  async flushChatEdits(chatId: ChatId): Promise<void> {
    const sessions = [...(this.editSessions.get(chatId)?.values() ?? [])]
    if (sessions.length === 0) return
    const results = await Promise.allSettled(sessions.map((session) => session.flush()))
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failed) throw failed.reason
  }

  async flushWorkspaceEdits(ownerKey: string): Promise<void> {
    const sessions = [...(this.workspaceEditSessions.get(ownerKey)?.values() ?? [])]
    if (sessions.length === 0) return
    const results = await Promise.allSettled(sessions.map((session) => session.flush()))
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failed) throw failed.reason
  }

  stageChatSettingsIntent(
    chatId: ChatId,
    fieldKey: string,
    patches: readonly ChatSettingsFieldPatch[],
  ): PendingChatSettingsFieldIntent {
    const previousTarget = this.frameTarget
    const intent = this.storeChatSettingsIntent(chatId, fieldKey, patches)
    this.publishPendingConfigurationChange(previousTarget)
    return intent
  }

  stageChatSettingsFields(
    chatId: ChatId,
    patches: readonly ChatSettingsFieldPatch[],
  ): readonly PendingChatSettingsFieldIntent[] {
    const previousTarget = this.frameTarget
    const intents = patches.map((patch) =>
      this.storeChatSettingsIntent(chatId, chatSettingsFieldKey(patch), [patch]),
    )
    this.publishPendingConfigurationChange(previousTarget)
    return intents
  }

  private storeChatSettingsIntent(
    chatId: ChatId,
    fieldKey: string,
    patches: readonly ChatSettingsFieldPatch[],
  ): PendingChatSettingsFieldIntent {
    const intent = Object.freeze({
      fieldKey,
      patches: Object.freeze(patches.map(cloneChatSettingsFieldPatch)),
      revision: ++this.pendingConfigurationRevision,
    })
    let fields = this.pendingChatSettingsFields.get(chatId)
    if (!fields) {
      fields = new Map()
      this.pendingChatSettingsFields.set(chatId, fields)
    }
    fields.set(fieldKey, intent)
    return intent
  }

  stageChatSettingsReplacement(
    chatId: ChatId,
    settings: ChatSettings,
    presetId?: PresetId | null,
  ): PendingChatSettingsReplacementIntent {
    const previousTarget = this.frameTarget
    const intent = Object.freeze({
      settings: structuredClone(settings),
      ...(presetId === undefined ? {} : { presetId }),
      revision: ++this.pendingConfigurationRevision,
    })
    this.clearPendingPromptFields(chatId)
    this.pendingChatSettingsFields.delete(chatId)
    this.pendingChatSettingsReplacements.set(chatId, intent)
    this.publishPendingConfigurationChange(previousTarget)
    return intent
  }

  stageRenderingPreferences(patch: Partial<RenderingPreferences>): PendingWorkspaceSettingIntent {
    const pending = this.pendingWorkspaceSettings.get(RENDERING_PREFERENCES_KEY)
    const current =
      pending?.value ??
      this.acceptedWorkspaceSettings.get(RENDERING_PREFERENCES_KEY) ??
      this.frameShell?.preferences.rendering
    return this.stageWorkspaceSetting(
      RENDERING_PREFERENCES_KEY,
      normalizeRenderingPreferences({
        ...normalizeRenderingPreferences(current),
        ...patch,
      }),
    )
  }

  stageSidebarFolderCollapsed(
    folderId: FolderId,
    collapsed: boolean,
  ): PendingWorkspaceSettingIntent {
    const pending = this.pendingWorkspaceSettings.get(SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY)
    const current = normalizeCollapsedSidebarFolderIds(
      pending?.value ??
        this.acceptedWorkspaceSettings.get(SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY) ??
        this.frameShell?.preferences.collapsedFolderIds,
    )
    const next = collapsed
      ? [...current.filter((id) => id !== folderId), folderId]
      : current.filter((id) => id !== folderId)
    return this.stageWorkspaceSetting(
      SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
      normalizeCollapsedSidebarFolderIds(next),
    )
  }

  stageWorkspaceSetting(key: string, value: unknown): PendingWorkspaceSettingIntent {
    const intent = Object.freeze({
      key,
      value: deepFreezeActiveGenerationValue(structuredClone(value)),
      revision: ++this.pendingConfigurationRevision,
    })
    this.storePendingWorkspaceSetting(intent)
    this.publish()
    return intent
  }

  stageTextTemplateConfig(
    templateId: TextTemplateId,
    config: TextTemplateConfig,
  ): PendingTextTemplateConfigIntent {
    const intent = Object.freeze({
      templateId,
      config: deepFreezeActiveGenerationValue(normalizeTextTemplateConfig(config)),
      revision: ++this.pendingConfigurationRevision,
    })
    this.storePendingTextTemplateConfig(intent)
    this.publish()
    return intent
  }

  private storePendingWorkspaceSetting(intent: PendingWorkspaceSettingIntent): void {
    this.pendingWorkspaceSettings.set(intent.key, intent)
    if (GENERATION_GLOBAL_PREFERENCE_KEYS.includes(intent.key as never)) {
      this.generationWorkspaceSettingsRevision += 1
    }
  }

  private removePendingWorkspaceSetting(key: string, revision: number): boolean {
    if (this.pendingWorkspaceSettings.get(key)?.revision !== revision) return false
    this.pendingWorkspaceSettings.delete(key)
    if (GENERATION_GLOBAL_PREFERENCE_KEYS.includes(key as never)) {
      this.generationWorkspaceSettingsRevision += 1
    }
    return true
  }

  private storePendingTextTemplateConfig(intent: PendingTextTemplateConfigIntent): void {
    this.pendingTextTemplateConfigs.set(intent.templateId, intent)
    this.pendingGenerationTextTemplates = this.pendingGenerationTextTemplates.set(
      intent.templateId,
      intent.config,
    )
  }

  private removePendingTextTemplateConfig(templateId: TextTemplateId, revision: number): boolean {
    if (this.pendingTextTemplateConfigs.get(templateId)?.revision !== revision) return false
    this.pendingTextTemplateConfigs.delete(templateId)
    this.pendingGenerationTextTemplates = this.pendingGenerationTextTemplates.delete(templateId)
    return true
  }

  pendingWorkspaceSetting(key: string): PendingWorkspaceSettingIntent | undefined {
    const intent = this.pendingWorkspaceSettings.get(key)
    return intent ? Object.freeze({ ...intent, value: structuredClone(intent.value) }) : undefined
  }

  pendingTextTemplateConfig(
    templateId: TextTemplateId,
  ): PendingTextTemplateConfigIntent | undefined {
    const intent = this.pendingTextTemplateConfigs.get(templateId)
    return intent ? Object.freeze({ ...intent, config: structuredClone(intent.config) }) : undefined
  }

  projectChatConfiguration(chat: Chat): Chat {
    const replacement = this.pendingChatSettingsReplacements.get(chat.id)
    const settings = this.projectChatSettings(chat.id, chat.settings)
    const presetId = replacement
      ? replacement.presetId === undefined
        ? chat.presetId
        : replacement.presetId
      : chat.presetId
    if (settings === chat.settings && presetId === chat.presetId) return chat
    const projected: Chat = { ...chat, settings }
    if (presetId === null || presetId === undefined) delete projected.presetId
    else projected.presetId = presetId
    return projected
  }

  claimSelectedGenerationConfiguration(chatId: ChatId): SelectedGenerationConfigurationClaim {
    const workspace = this.workspaceFence
    if (!workspace) throw new Error('SelectedGenerationConfigurationWorkspaceUnavailable')
    const claim = Object.freeze({
      [SELECTED_GENERATION_CONFIGURATION_CLAIM]: true as const,
      chatId,
      workspaceId: workspace.workspaceId,
      replacementEpoch: workspace.replacementEpoch,
    })
    const state: SelectedGenerationConfigurationClaimState = {
      claim,
      workspace,
      target: null,
      promptFields: Object.freeze([]),
      workspaceSettingOverrides: Object.freeze([]),
      pendingTextTemplates: PersistentStringMap.empty(),
      pendingKeys: new Set(),
      selection: null,
      selectionRead: null,
      baseResolution: PENDING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION,
      acceptedConfigurationVersion: null,
      failed: false,
      active: true,
    }
    this.selectedGenerationConfigurationClaimStates.set(claim, state)
    this.selectedGenerationConfigurationClaims.add(state)
    this.captureSelectedGenerationConfigurationTarget(state)
    return claim
  }

  resolveSelectedGenerationConfiguration(
    claim: SelectedGenerationConfigurationClaim,
  ): ActiveGenerationConfigurationResolution {
    const state = this.selectedGenerationConfigurationClaimStates.get(claim)
    if (!state?.active || !this.matchesFence(state.workspace)) {
      return FAILED_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
    }
    if (!state.target) this.captureSelectedGenerationConfigurationTarget(state)
    this.refreshSelectedGenerationConfiguration(state)
    if (state.failed) return FAILED_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
    if (state.pendingKeys.size > 0) {
      return PENDING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
    }
    const resolution = state.baseResolution
    if (
      resolution.capability !== 'ready' ||
      resolution.kind !== 'chat' ||
      state.acceptedConfigurationVersion === null
    ) {
      return resolution
    }
    return Object.freeze({
      ...resolution,
      configurationVersion: state.acceptedConfigurationVersion,
    })
  }

  cancelSelectedGenerationConfiguration(claim: SelectedGenerationConfigurationClaim): void {
    const state = this.selectedGenerationConfigurationClaimStates.get(claim)
    if (!state?.active) return
    state.active = false
    state.selectionRead?.abort()
    state.selectionRead = null
    this.selectedGenerationConfigurationClaims.delete(state)
  }

  private captureSelectedGenerationConfigurationTarget(
    state: SelectedGenerationConfigurationClaimState,
  ): void {
    const target = this.frameTarget
    if (target.kind !== 'chat' || target.chatId !== state.claim.chatId) return
    state.target = target
    state.promptFields = Object.freeze(
      [...(this.pendingPromptFields.get(target.chatId)?.values() ?? [])]
        .sort((left, right) => left.field.localeCompare(right.field))
        .map((intent) => Object.freeze({ ...intent })),
    )
    state.workspaceSettingOverrides = Object.freeze(
      GENERATION_GLOBAL_PREFERENCE_KEYS.flatMap((key) => {
        const pending = this.pendingWorkspaceSettings.get(key)
        return pending
          ? [Object.freeze({ key: pending.key, value: structuredClone(pending.value) })]
          : []
      }),
    )
    state.pendingTextTemplates = this.pendingGenerationTextTemplates
    for (const key of this.selectedGenerationPendingKeys(target)) state.pendingKeys.add(key)
    state.baseResolution = this.activeGenerationConfigurationFrame().resolve({
      kind: 'chat',
      chatId: target.chatId,
    })
    if (
      this.frameSelection.status === 'ready' &&
      sameActiveConfigurationTarget(this.frameSelection.target, target)
    ) {
      state.selection = this.frameSelection.value
    }
    this.refreshSelectedGenerationConfiguration(state)
  }

  private selectedGenerationPendingKeys(
    target: Extract<ActiveConfigurationTarget, { readonly kind: 'chat' }>,
  ): readonly string[] {
    const keys: string[] = []
    const replacement = this.pendingChatSettingsReplacements.get(target.chatId)
    if (replacement) keys.push(selectedGenerationReplacementKey(replacement.revision))
    for (const intent of this.pendingChatSettingsFields.get(target.chatId)?.values() ?? []) {
      keys.push(selectedGenerationChatFieldKey(intent.fieldKey, intent.revision))
    }
    for (const intent of this.pendingPromptFields.get(target.chatId)?.values() ?? []) {
      keys.push(selectedGenerationPromptFieldKey(intent.field, intent.revision))
    }
    for (const key of GENERATION_GLOBAL_PREFERENCE_KEYS) {
      const pending = this.pendingWorkspaceSettings.get(key)
      if (pending) keys.push(selectedGenerationWorkspaceSettingKey(pending.key, pending.revision))
    }
    const textTemplateId = target.settings.textTemplate
    if (textTemplateId && !isStaticTextTemplateId(textTemplateId)) {
      const pending = this.pendingTextTemplateConfigs.get(textTemplateId)
      if (pending)
        keys.push(selectedGenerationTextTemplateKey(pending.templateId, pending.revision))
    }
    return keys
  }

  private refreshSelectedGenerationConfiguration(
    state: SelectedGenerationConfigurationClaimState,
  ): void {
    const target = state.target
    if (!target || state.failed || state.baseResolution.capability === 'ready') return
    if (!state.selection) {
      const slot = this.frameSelection
      if (slot.status === 'ready' && sameActiveConfigurationTarget(slot.target, target)) {
        state.selection = slot.value
      } else {
        this.loadSelectedGenerationConfigurationSelection(state)
        return
      }
    }
    const selection = state.selection
    state.baseResolution = createActiveGenerationConfigurationFrame({
      workspace: state.workspace,
      target,
      selection: Object.freeze({
        status: 'ready',
        revision: 0,
        target,
        value: selection,
      }),
      shell: this.frameShell,
      shellLoad: this.loads.shell,
      promptFields: state.promptFields,
      workspaceSettingOverrides: state.workspaceSettingOverrides,
      pendingTextTemplates: state.pendingTextTemplates,
    }).resolve({ kind: 'chat', chatId: target.chatId })
  }

  private loadSelectedGenerationConfigurationSelection(
    state: SelectedGenerationConfigurationClaimState,
  ): void {
    const source = this.source
    const target = state.target
    if (!source || !target || state.selectionRead) return
    const controller = new AbortController()
    state.selectionRead = controller
    void source
      .loadActiveSelection(configurationSelectionQueryTarget(target), controller.signal)
      .then((projection) => {
        if (
          !state.active ||
          state.selectionRead !== controller ||
          controller.signal.aborted ||
          !this.matchesFence(state.workspace)
        ) {
          return
        }
        state.selectionRead = null
        state.selection = freezeActiveConfigurationSelection({
          profile: projection.profile,
          preset: projection.preset,
          requestRevision: projection.requestRevision,
          dispatchKeyRevisions: projection.dispatchKeyRevisions,
          promptPresets: projection.promptPresets,
          textTemplate: projection.textTemplate,
        })
        this.refreshSelectedGenerationConfiguration(state)
        this.publish()
      })
      .catch(() => {
        if (!state.active || state.selectionRead !== controller || controller.signal.aborted) {
          return
        }
        state.selectionRead = null
        state.failed = true
        this.publish()
      })
  }

  acknowledgePendingConfiguration(
    chatId: ChatId | null,
    acknowledgement: PendingConfigurationAcknowledgement,
  ): void {
    this.settlePendingConfiguration(chatId, acknowledgement, true)
  }

  rejectPendingConfiguration(
    chatId: ChatId | null,
    acknowledgement: PendingConfigurationAcknowledgement,
  ): void {
    this.settlePendingConfiguration(chatId, acknowledgement, false)
  }

  private settlePendingConfiguration(
    chatId: ChatId | null,
    acknowledgement: PendingConfigurationAcknowledgement,
    accept: boolean,
  ): void {
    const previousTarget = this.frameTarget
    this.settleSelectedGenerationConfigurationClaims(chatId, acknowledgement, accept)
    if (chatId) this.removeAcknowledgedPromptConfiguration(chatId, acknowledgement)
    if (
      chatId &&
      acknowledgement.chatSettingsReplacement &&
      this.pendingChatSettingsReplacements.get(chatId)?.revision ===
        acknowledgement.chatSettingsReplacement.revision
    ) {
      this.pendingChatSettingsReplacements.delete(chatId)
    }
    const chatFields = chatId ? this.pendingChatSettingsFields.get(chatId) : undefined
    for (const receipt of acknowledgement.chatSettingsFields ?? []) {
      if (chatFields?.get(receipt.fieldKey)?.revision === receipt.revision) {
        chatFields.delete(receipt.fieldKey)
      }
    }
    if (chatId && chatFields?.size === 0) this.pendingChatSettingsFields.delete(chatId)
    for (const receipt of acknowledgement.workspaceSettings ?? []) {
      const pending = this.pendingWorkspaceSettings.get(receipt.key)
      if (accept && pending?.revision === receipt.revision && receipt.accepted) {
        const value = deepFreezeActiveGenerationValue(structuredClone(receipt.accepted.value))
        this.acceptedWorkspaceSettings.set(receipt.key, value)
        if (this.frameShell) {
          this.frameShell = configurationShellWithWorkspaceSetting(
            this.frameShell,
            receipt.key,
            value,
          )
          this.frameRevision += 1
        }
      }
      this.removePendingWorkspaceSetting(receipt.key, receipt.revision)
    }
    for (const receipt of acknowledgement.textTemplateConfigs ?? []) {
      this.removePendingTextTemplateConfig(receipt.templateId, receipt.revision)
    }
    this.publishPendingConfigurationChange(previousTarget)
  }

  private settleSelectedGenerationConfigurationClaims(
    chatId: ChatId | null,
    acknowledgement: PendingConfigurationAcknowledgement,
    accept: boolean,
  ): void {
    const keys = new Set<string>()
    if (acknowledgement.chatSettingsReplacement) {
      keys.add(selectedGenerationReplacementKey(acknowledgement.chatSettingsReplacement.revision))
    }
    for (const receipt of acknowledgement.chatSettingsFields ?? []) {
      keys.add(selectedGenerationChatFieldKey(receipt.fieldKey, receipt.revision))
    }
    for (const receipt of acknowledgement.promptFields) {
      keys.add(selectedGenerationPromptFieldKey(receipt.field, receipt.revision))
    }
    for (const receipt of acknowledgement.workspaceSettings ?? []) {
      keys.add(selectedGenerationWorkspaceSettingKey(receipt.key, receipt.revision))
    }
    for (const receipt of acknowledgement.textTemplateConfigs ?? []) {
      keys.add(selectedGenerationTextTemplateKey(receipt.templateId, receipt.revision))
    }
    if (keys.size === 0) return
    for (const state of this.selectedGenerationConfigurationClaims) {
      if (!state.active || (chatId !== null && state.claim.chatId !== chatId)) continue
      let matched = false
      for (const key of keys) {
        if (state.pendingKeys.delete(key)) matched = true
      }
      if (!matched) continue
      if (!accept) state.failed = true
      else if (acknowledgement.acceptedChatConfigurationVersion !== undefined) {
        state.acceptedConfigurationVersion = acknowledgement.acceptedChatConfigurationVersion
      }
    }
  }

  discardPendingChatSettingsField(chatId: ChatId, fieldKey: string, revision: number): void {
    const fields = this.pendingChatSettingsFields.get(chatId)
    if (fields?.get(fieldKey)?.revision !== revision) return
    const previousTarget = this.frameTarget
    fields.delete(fieldKey)
    if (fields.size === 0) this.pendingChatSettingsFields.delete(chatId)
    this.publishPendingConfigurationChange(previousTarget)
  }

  discardPendingChatSettingsReplacement(chatId: ChatId, revision: number): void {
    if (this.pendingChatSettingsReplacements.get(chatId)?.revision === revision) {
      const previousTarget = this.frameTarget
      this.pendingChatSettingsReplacements.delete(chatId)
      this.publishPendingConfigurationChange(previousTarget)
    }
  }

  discardPendingWorkspaceSetting(key: string, revision: number): void {
    if (this.removePendingWorkspaceSetting(key, revision)) this.publish()
  }

  discardPendingTextTemplateConfig(templateId: TextTemplateId, revision: number): void {
    if (this.removePendingTextTemplateConfig(templateId, revision)) this.publish()
  }

  stagePromptField(
    chatId: ChatId,
    field: PromptPresetKind,
    value: string,
  ): PendingPromptFieldIntent {
    const intent = Object.freeze({
      field,
      value,
      revision: ++this.pendingConfigurationRevision,
    })
    this.storePendingPromptField(chatId, intent)
    this.publish()
    return intent
  }

  private storePendingPromptField(chatId: ChatId, intent: PendingPromptFieldIntent): void {
    let fields = this.pendingPromptFields.get(chatId)
    if (!fields) {
      fields = new Map()
      this.pendingPromptFields.set(chatId, fields)
    }
    fields.set(intent.field, intent)
    this.bumpPromptGenerationRevision(chatId)
  }

  private clearPendingPromptFields(chatId: ChatId): void {
    if (!this.pendingPromptFields.delete(chatId)) return
    this.pendingPromptGenerationRevisions.delete(chatId)
  }

  private removePendingPromptField(
    chatId: ChatId,
    field: PromptPresetKind,
    revision: number,
  ): boolean {
    const fields = this.pendingPromptFields.get(chatId)
    if (fields?.get(field)?.revision !== revision) return false
    fields.delete(field)
    if (fields.size === 0) this.clearPendingPromptFields(chatId)
    else this.bumpPromptGenerationRevision(chatId)
    return true
  }

  pendingPromptConfiguration(chatId: ChatId): PendingPromptConfiguration | undefined {
    const fields = this.pendingPromptFields.get(chatId)
    if (!fields || fields.size === 0) return undefined
    return Object.freeze({
      promptFields: Object.freeze(
        [...fields.values()]
          .sort((left, right) => left.field.localeCompare(right.field))
          .map((intent) => Object.freeze({ ...intent })),
      ),
    })
  }

  acknowledgePendingPromptConfiguration(
    chatId: ChatId,
    acknowledgement: PendingPromptConfigurationAcknowledgement,
  ): void {
    if (this.removeAcknowledgedPromptConfiguration(chatId, acknowledgement)) {
      this.publish()
    }
  }

  private removeAcknowledgedPromptConfiguration(
    chatId: ChatId,
    acknowledgement: PendingPromptConfigurationAcknowledgement,
  ): boolean {
    let changed = false
    for (const receipt of acknowledgement.promptFields) {
      changed = this.removePendingPromptField(chatId, receipt.field, receipt.revision) || changed
    }
    return changed
  }

  discardPendingPromptField(chatId: ChatId, field: PromptPresetKind, revision: number): void {
    if (this.removePendingPromptField(chatId, field, revision)) this.publish()
  }

  private bumpPromptGenerationRevision(chatId: ChatId): void {
    this.pendingPromptGenerationRevisions.set(
      chatId,
      (this.pendingPromptGenerationRevisions.get(chatId) ?? 0) + 1,
    )
  }

  editQueueStats(): ConfigurationEditQueueStats {
    let sessions = 0
    let pendingOperations = 0
    const pendingChats = new Set<ChatId>()
    const mountedChats = new Set<ChatId>()
    let mountedSessions = 0
    for (const [chatId, byField] of this.editSessions) {
      sessions += byField.size
      for (const session of byField.values()) {
        pendingOperations += session.pendingOperationCount
        if (session.pendingOperationCount > 0) pendingChats.add(chatId)
        if (session.kind === 'mounted') {
          mountedChats.add(chatId)
          mountedSessions += 1
        }
      }
    }
    return {
      chats: this.editSessions.size,
      sessions,
      pendingOperations,
      pendingChats: pendingChats.size,
      mountedChats: mountedChats.size,
      mountedSessions,
    }
  }

  claimIntent(): ConfigurationIntent {
    return Object.freeze({
      workspaceId: this.workspaceFence?.workspaceId ?? null,
      replacementEpoch: this.workspaceFence?.replacementEpoch ?? null,
      revision: this.intentRevision,
    })
  }

  intentIsCurrent(intent: ConfigurationIntent): boolean {
    if (intent.revision !== this.intentRevision) return false
    if (intent.workspaceId === null || intent.replacementEpoch === null) return true
    return (
      this.workspaceFence !== null &&
      intent.workspaceId === this.workspaceFence.workspaceId &&
      intent.replacementEpoch === this.workspaceFence.replacementEpoch
    )
  }

  private reconcileActiveFrameTarget(_snapshot: ConversationSnapshot): void {
    this.reconcileActiveFrameFromCurrentState()
  }

  private reconcileActiveFrameFromCurrentState(): void {
    this.setActiveFrameTarget(this.activeFrameTargetFromCurrentState())
  }

  private activeFrameTargetFromCurrentState(): ActiveConfigurationTarget {
    const chat = this.activeConversationChat
    if (this.conversationChatId) {
      if (!chat) {
        return Object.freeze({ kind: 'chat-resolving', chatId: this.conversationChatId })
      }
      const settings = this.projectChatSettings(chat.id, chat.settings)
      const replacement = this.pendingChatSettingsReplacements.get(chat.id)
      return freezeActiveConfigurationTarget({
        kind: 'chat',
        chatId: chat.id,
        configurationVersion: chat.configurationVersion ?? 0,
        overlayRevision: activeChatOverlayRevision(
          this.pendingChatSettingsReplacements.get(chat.id),
          this.pendingChatSettingsFields.get(chat.id),
        ),
        settings,
        profileId: settings.profileId || null,
        presetId:
          replacement?.presetId === undefined ? (chat.presetId ?? null) : replacement.presetId,
        configurationLinkProof: {
          expectedResourceNames: chatConfigurationTargetResourceNames(chat),
          persistedPresetId: chat.presetId ?? null,
        },
      })
    }
    if (!this.seed.settings) return Object.freeze({ kind: 'none' })
    return freezeActiveConfigurationTarget({
      kind: 'new-chat',
      seedKind: this.seedState.kind,
      seedRevision: this.seedRevision,
      settings: this.seed.settings,
      profileId: this.seed.settings.profileId || this.seed.profileId || null,
      presetId: this.seed.presetId,
    })
  }

  private setActiveFrameTarget(next: ActiveConfigurationTarget): void {
    if (sameActiveConfigurationTarget(this.frameTarget, next)) return
    const previousSelection = readyConfigurationSelection(this.frameSelection)
    this.frameTarget = next
    this.frameRevision += 1
    this.selectionRead?.abort()
    this.selectionRead = null

    if (next.kind === 'none') {
      this.frameSelection = Object.freeze({
        status: 'absent',
        revision: ++this.frameRevision,
      })
      this.clearActiveModelFrame()
      return
    }
    if (next.kind === 'chat-resolving') {
      this.frameSelection = Object.freeze({
        status: 'resolving',
        revision: ++this.frameRevision,
        target: next,
        retained: previousSelection
          ? Object.freeze({
              kind: 'previous-target',
              target: previousSelection.target,
              value: previousSelection.value,
            })
          : null,
      })
      this.blockActiveModelFrame()
      return
    }

    if (previousSelection && sameActiveConfigurationSelectionKey(previousSelection.target, next)) {
      this.frameSelection = Object.freeze({
        status: 'ready',
        revision: ++this.frameRevision,
        target: next,
        value: previousSelection.value,
      })
      this.reconcileActiveModelTarget()
      return
    }

    this.frameSelection = Object.freeze({
      status: 'pending',
      revision: ++this.frameRevision,
      target: next,
      retained: previousSelection
        ? Object.freeze({
            kind: 'previous-target',
            target: previousSelection.target,
            value: previousSelection.value,
          })
        : null,
    })
    this.blockActiveModelFrame()
    this.loadActiveSelection()
  }

  private loadActiveSelection(force = false, reloadModel = false): void {
    const source = this.source
    const target = concreteActiveConfigurationTarget(this.frameTarget)
    if (!source || !target) return
    if (!force && this.frameSelection.status === 'ready' && this.frameSelection.target === target) {
      return
    }
    this.selectionRead?.abort()
    this.blockActiveModelFrame()
    const controller = new AbortController()
    this.selectionRead = controller
    const previous = readyConfigurationSelection(this.frameSelection)
    const revision = ++this.frameRevision
    this.frameSelection = Object.freeze({
      status: 'pending',
      revision,
      target,
      retained: previous
        ? sameActiveConfigurationTarget(previous.target, target)
          ? Object.freeze({ kind: 'same-target', value: previous.value })
          : Object.freeze({
              kind: 'previous-target',
              target: previous.target,
              value: previous.value,
            })
        : null,
    })
    this.publish()
    void Promise.resolve()
      .then(() =>
        source.loadActiveSelection(configurationSelectionQueryTarget(target), controller.signal),
      )
      .then((projection) => {
        if (
          this.selectionRead !== controller ||
          controller.signal.aborted ||
          !sameActiveConfigurationTarget(this.frameTarget, target)
        ) {
          return
        }
        const value = freezeActiveConfigurationSelection({
          profile: projection.profile,
          preset: projection.preset,
          requestRevision: projection.requestRevision,
          dispatchKeyRevisions: projection.dispatchKeyRevisions,
          promptPresets: projection.promptPresets,
          textTemplate: projection.textTemplate,
        })
        const resolvedSeed =
          target.kind === 'new-chat' && target.seedKind === 'workspace-default'
            ? workspaceDefaultConfigurationSeed(projection)
            : target.kind === 'new-chat'
              ? resolvedNewChatSeed(target, projection)
              : null
        this.selectionRead = null
        if (
          resolvedSeed &&
          target.kind === 'new-chat' &&
          (target.seedKind === 'workspace-default' || !sameSeed(this.seed, resolvedSeed))
        ) {
          this.seedState = resolvedConfigurationSeedState(resolvedSeed)
          this.seedRevision += 1
          this.persistSeed()
          const resolvedTarget = freezeActiveConfigurationTarget({
            kind: 'new-chat',
            seedKind: 'resolved',
            seedRevision: this.seedRevision,
            settings: resolvedSeed.settings,
            profileId: resolvedSeed.profileId,
            presetId: resolvedSeed.presetId,
          })
          this.withPublicationBatch(() => {
            this.frameTarget = resolvedTarget
            this.frameSelection = Object.freeze({
              status: 'ready',
              revision: ++this.frameRevision,
              target: resolvedTarget,
              value,
            })
            this.reconcileActiveModelTarget(reloadModel)
            this.publish()
          })
          return
        }
        this.withPublicationBatch(() => {
          this.frameSelection = Object.freeze({
            status: 'ready',
            revision: ++this.frameRevision,
            target,
            value,
          })
          this.reconcileActiveModelTarget(reloadModel)
          this.publish()
        })
      })
      .catch((error: unknown) => {
        if (this.selectionRead !== controller || controller.signal.aborted) return
        this.selectionRead = null
        const projectionError = configurationProjectionError(error)
        const retained =
          this.frameSelection.status === 'pending' ? this.frameSelection.retained : null
        this.frameSelection = Object.freeze({
          status: 'error',
          revision: ++this.frameRevision,
          target,
          error: projectionError,
          retained,
        })
        this.publish()
      })
  }

  private reconcileActiveModelTarget(force = false): void {
    const selection = this.frameSelection.status === 'ready' ? this.frameSelection : null
    const profile = selection?.value.profile
    const revision = selection?.value.requestRevision
    const modelId = selection?.target.settings.model || null
    const shell = this.frameShell
    if (!profile || !revision || !shell) {
      this.clearActiveModelFrame()
      return
    }
    const target: ActiveConfigurationModelTarget = Object.freeze({
      profileId: profile.id,
      modelId,
      requestRevision: Object.freeze(structuredClone(revision)),
      proxy: Object.freeze({ ...corsProxyConfigFromPrefs(shell.preferences.global) }),
      profile,
      settings: selection.target.settings,
    })
    if (
      !force &&
      this.frameModel.status === 'ready' &&
      sameActiveConfigurationModelTarget(this.frameModel.target, target)
    ) {
      if (
        this.frameModel.target.profile !== target.profile ||
        this.frameModel.target.settings !== target.settings
      ) {
        this.frameModel = Object.freeze({ ...this.frameModel, target })
      }
      return
    }
    this.loadActiveModel(target)
  }

  private loadActiveModel(explicitTarget?: ActiveConfigurationModelTarget): void {
    const source = this.source
    if (!source) return
    const target =
      explicitTarget ?? activeModelTargetFromSelection(this.frameSelection, this.frameShell)
    if (!target) {
      this.clearActiveModelFrame()
      return
    }
    this.activeModelRead?.abort()
    const controller = new AbortController()
    this.activeModelRead = controller
    const previous = readyConfigurationModel(this.frameModel)
    const previousMatchesProfileRevision =
      previous?.target.profileId === target.profileId &&
      configurationRequestRevisionKey(previous.target.requestRevision) ===
        configurationRequestRevisionKey(target.requestRevision)
    const includeModels =
      this.modelCatalogDemanded ||
      (previousMatchesProfileRevision && previous.value.models !== undefined)
    const knownPayloads = knownActiveModelPayloads(previous, target, includeModels)
    const revision = ++this.frameRevision
    this.frameModel = Object.freeze({
      status: 'pending',
      revision,
      target,
      retained: previous
        ? sameActiveConfigurationModelTarget(previous.target, target)
          ? Object.freeze({ kind: 'same-target', value: previous.value })
          : Object.freeze({
              kind: 'previous-target',
              target: previous.target,
              value: previous.value,
            })
        : null,
    })
    this.publish()
    void Promise.resolve()
      .then(() => source.loadActiveModel(target, knownPayloads, includeModels, controller.signal))
      .then((result) => {
        if (
          this.activeModelRead !== controller ||
          controller.signal.aborted ||
          !sameActiveConfigurationModelTarget(
            activeModelTargetFromSelection(this.frameSelection, this.frameShell),
            target,
          )
        ) {
          return
        }
        if (result.kind !== 'ready') {
          this.activeModelRead = null
          this.loadActiveSelection(true)
          return
        }
        const projection = result.projection
        if (
          projection.modelId !== target.modelId ||
          configurationRequestRevisionKey(projection.revision) !==
            configurationRequestRevisionKey(target.requestRevision)
        ) {
          this.activeModelRead = null
          this.loadActiveSelection(true)
          return
        }
        const value = mergeActiveConfigurationModel(
          target,
          projection,
          previous,
          this.discovery.getSnapshot(),
        )
        this.activeModelRead = null
        this.frameModel = Object.freeze({
          status: 'ready',
          revision: ++this.frameRevision,
          target,
          value,
        })
        this.publish()
      })
      .catch((error: unknown) => {
        if (this.activeModelRead !== controller || controller.signal.aborted) return
        this.activeModelRead = null
        const retained = this.frameModel.status === 'pending' ? this.frameModel.retained : null
        this.frameModel = Object.freeze({
          status: 'error',
          revision: ++this.frameRevision,
          target,
          error: configurationProjectionError(error),
          retained,
        })
        this.publish()
      })
  }

  private clearActiveModelFrame(): void {
    this.activeModelRead?.abort()
    this.activeModelRead = null
    if (this.frameModel.status === 'absent') return
    this.frameModel = Object.freeze({
      status: 'absent',
      revision: ++this.frameRevision,
    })
  }

  private blockActiveModelFrame(): void {
    this.activeModelRead?.abort()
    this.activeModelRead = null
    if (this.frameModel.status === 'blocked' || this.frameModel.status === 'absent') return
    const retained = readyConfigurationModel(this.frameModel)
    this.frameModel = Object.freeze({
      status: 'blocked',
      revision: ++this.frameRevision,
      retained: retained ? Object.freeze(retained) : null,
    })
  }

  private loadShell(): Promise<void> {
    return this.loadProjection({
      kind: 'shell',
      target: 'workspace-shell',
      current: () => this.frameShell,
      owner: () => this.shellRead,
      setOwner: (owner) => {
        this.shellRead = owner
      },
      load: (source, signal) => source.loadShell(signal),
      accept: (projection) => {
        let shell = freezeConfigurationShell(projection)
        for (const [key, value] of this.acceptedWorkspaceSettings) {
          shell = configurationShellWithWorkspaceSetting(shell, key, value)
        }
        this.frameShell = shell
        if (!this.uiSeeded) {
          this.uiSeeded = true
          const global = this.frameShell.preferences.global
          this.ui = Object.freeze({
            sidebarCollapsed: this.uiFieldsOwnedBeforeSeed.has('sidebarCollapsed')
              ? this.ui.sidebarCollapsed
              : global.sidebarCollapsed,
            composerHeight: this.uiFieldsOwnedBeforeSeed.has('composerHeight')
              ? this.ui.composerHeight
              : global.composerHeight,
            composerNormalManualHeight: this.uiFieldsOwnedBeforeSeed.has(
              'composerNormalManualHeight',
            )
              ? this.ui.composerNormalManualHeight
              : global.composerNormalManualHeight,
            composerFocusManualHeight: this.uiFieldsOwnedBeforeSeed.has('composerFocusManualHeight')
              ? this.ui.composerFocusManualHeight
              : global.composerFocusManualHeight,
          })
          this.uiFieldsOwnedBeforeSeed.clear()
        }
        this.reconcileActiveModelTarget()
      },
    })
  }

  private loadGlobalTokenCalibration(): Promise<void> {
    if (this.globalTokenCalibrationDemand === 0) return Promise.resolve()
    return this.loadProjection({
      kind: 'globalTokenCalibration',
      target: 'global-token-calibration',
      current: () => this.frameGlobalTokenCalibration,
      owner: () => this.globalTokenCalibrationRead,
      setOwner: (owner) => {
        this.globalTokenCalibrationRead = owner
      },
      load: (source, signal) => source.loadGlobalTokenCalibration(signal),
      accept: (projection) => {
        this.frameGlobalTokenCalibration = freezeGlobalTokenCalibration(projection)
      },
    })
  }

  private loadTextTemplateCatalog(): Promise<void> {
    if (this.textTemplateCatalogDemand === 0) return Promise.resolve()
    return this.loadProjection({
      kind: 'textTemplates',
      target: 'text-template-catalog',
      current: () => this.frameTextTemplates,
      owner: () => this.textTemplateCatalogRead,
      setOwner: (owner) => {
        this.textTemplateCatalogRead = owner
      },
      load: (source, signal) => source.loadTextTemplateCatalog(signal),
      accept: (projection) => {
        this.frameTextTemplates = Object.freeze(
          projection.map((template) => Object.freeze({ ...template })),
        )
      },
    })
  }

  private loadProjection<Value>(input: {
    readonly kind: keyof ConfigurationProjectionLoadStates
    readonly target: string
    readonly current: () => Value | null
    readonly owner: () => AbortController | null
    readonly setOwner: (owner: AbortController | null) => void
    readonly load: (source: ConfigurationProjectionSource, signal: AbortSignal) => Promise<Value>
    readonly accept: (value: Value) => void
  }): Promise<void> {
    const source = this.source
    const fence = this.workspaceFence
    if (!source || !fence) return Promise.resolve()
    input.owner()?.abort()
    const controller = new AbortController()
    input.setOwner(controller)
    const revision = this.beginProjectionLoad(input.kind, input.target)
    return Promise.resolve()
      .then(() => input.load(source, controller.signal))
      .then(
        (value) => {
          if (
            input.owner() !== controller ||
            controller.signal.aborted ||
            this.source !== source ||
            !this.matchesFence(fence)
          ) {
            return
          }
          this.withPublicationBatch(() => {
            input.setOwner(null)
            input.accept(value)
            this.frameRevision += 1
            this.finishProjectionLoad(input.kind, {
              status: 'ready',
              target: input.target,
              revision,
            })
            this.publish()
          })
        },
        (error: unknown) => {
          if (input.owner() !== controller || controller.signal.aborted) return
          input.setOwner(null)
          const retained = input.current() !== null
          this.finishProjectionLoad(input.kind, {
            status: 'error',
            target: input.target,
            revision,
            error: configurationProjectionError(error),
            retainedTarget: retained ? input.target : null,
            retained,
          })
          this.publish()
        },
      )
  }

  private reloadActiveFrameForDependencies(
    dependencies: readonly WorkspaceDependency[] | 'all',
  ): void {
    if (
      workspaceDependenciesOverlap(
        workspaceQueryDependencies({ kind: 'configuration.shell' }),
        dependencies,
      )
    ) {
      void this.loadShell()
    }
    if (
      this.globalTokenCalibrationDemand > 0 &&
      workspaceDependenciesOverlap(
        workspaceQueryDependencies({ kind: 'configuration.global-token-calibration' }),
        dependencies,
      )
    ) {
      void this.loadGlobalTokenCalibration()
    }
    if (
      this.textTemplateCatalogDemand > 0 &&
      workspaceDependenciesOverlap(
        workspaceQueryDependencies({ kind: 'configuration.text-template-catalog' }),
        dependencies,
      )
    ) {
      void this.loadTextTemplateCatalog()
    }
    const selectionTarget = concreteActiveConfigurationTarget(this.frameTarget)
    if (
      selectionTarget &&
      workspaceDependenciesOverlap(
        activeSelectionWorkspaceDependencies(selectionTarget, this.frameSelection),
        dependencies,
      )
    ) {
      this.loadActiveSelection(true)
      return
    }
    const modelTarget = activeModelTargetFromSelection(this.frameSelection, this.frameShell)
    if (
      modelTarget &&
      workspaceDependenciesOverlap(
        workspaceQueryDependencies({
          kind: 'configuration.active-model',
          profileId: modelTarget.profileId,
          modelId: modelTarget.modelId,
          revision: modelTarget.requestRevision,
          includeModels:
            this.modelCatalogDemanded ||
            currentModelFromSlot(this.frameModel)?.value.models !== undefined,
        }),
        dependencies,
      )
    ) {
      this.reconcileActiveModelTarget(true)
    }
  }

  private invalidateAcceptedWorkspaceSettings(
    dependencies: readonly WorkspaceDependency[] | 'all',
  ): void {
    if (
      dependencies === 'all' ||
      dependencies.some(
        (dependency) =>
          dependency.kind === 'workspace' ||
          (dependency.kind === 'setting' && dependency.keys === undefined),
      )
    ) {
      this.acceptedWorkspaceSettings.clear()
      return
    }
    for (const dependency of dependencies) {
      if (dependency.kind !== 'setting') continue
      for (const key of dependency.keys ?? []) this.acceptedWorkspaceSettings.delete(key)
    }
  }

  private beginProjectionLoad(
    kind: keyof ConfigurationProjectionLoadStates,
    target: string,
  ): number {
    const revision = ++this.projectionLoadRevision
    const current = this.loads[kind]
    const retainedTarget = configurationProjectionValueTarget(current)
    this.finishProjectionLoad(kind, {
      status: 'loading',
      target,
      revision,
      retainedTarget,
      retained:
        retainedTarget !== null &&
        (configurationProjectionIsRetained(current) || retainedTarget !== target),
    })
    this.publish()
    return revision
  }

  private retainProjectionLoadsAcrossSourceGap(): void {
    this.loads = Object.freeze({
      shell: this.retainProjectionLoad(
        this.loads.shell,
        this.frameShell ? 'workspace-shell' : null,
      ),
      globalTokenCalibration: this.retainProjectionLoad(
        this.loads.globalTokenCalibration,
        this.frameGlobalTokenCalibration ? 'global-token-calibration' : null,
      ),
      textTemplates: this.retainProjectionLoad(
        this.loads.textTemplates,
        this.frameTextTemplates ? 'text-template-catalog' : null,
      ),
    })
  }

  private retainProjectionLoad(
    current: ConfigurationProjectionLoadState,
    valueTarget: string | null,
  ): ConfigurationProjectionLoadState {
    const retainedTarget = configurationProjectionValueTarget(current) ?? valueTarget
    if (retainedTarget === null) return IDLE_PROJECTION_LOAD
    return Object.freeze({
      status: 'loading',
      target: current.status === 'idle' ? retainedTarget : current.target,
      revision: ++this.projectionLoadRevision,
      retainedTarget,
      retained: true,
    })
  }

  private activeGenerationConfigurationFrame(): ActiveGenerationConfigurationFrame {
    const workspace = this.workspaceFence
    if (!workspace) return PENDING_ACTIVE_GENERATION_CONFIGURATION_FRAME
    const target = this.frameTarget
    const selection = this.frameSelection
    const needsShell =
      selection.status === 'ready' &&
      selection.target === target &&
      selection.value.profile === null
    const shell = needsShell ? this.frameShell : null
    const shellLoad = needsShell ? this.loads.shell : IDLE_PROJECTION_LOAD
    const promptRevision =
      target.kind === 'chat' ? (this.pendingPromptGenerationRevisions.get(target.chatId) ?? 0) : 0
    const textTemplates = this.pendingGenerationTextTemplates
    const cached = this.activeGenerationFrameCache
    if (
      cached?.workspace === workspace &&
      cached.target === target &&
      cached.selection === selection &&
      cached.shell === shell &&
      cached.shellLoad === shellLoad &&
      cached.promptRevision === promptRevision &&
      cached.workspaceSettingsRevision === this.generationWorkspaceSettingsRevision &&
      cached.textTemplates === textTemplates
    ) {
      return cached.frame
    }
    const promptFields =
      target.kind === 'chat'
        ? Object.freeze(
            [...(this.pendingPromptFields.get(target.chatId)?.values() ?? [])]
              .sort((left, right) => left.field.localeCompare(right.field))
              .map((intent) => Object.freeze({ ...intent })),
          )
        : Object.freeze([])
    const workspaceSettingOverrides = Object.freeze(
      GENERATION_GLOBAL_PREFERENCE_KEYS.flatMap((key) => {
        const pending = this.pendingWorkspaceSettings.get(key)
        return pending
          ? [Object.freeze({ key: pending.key, value: structuredClone(pending.value) })]
          : []
      }),
    )
    const resolvedFrame = createActiveGenerationConfigurationFrame({
      workspace,
      target,
      selection,
      shell,
      shellLoad,
      promptFields,
      workspaceSettingOverrides,
      pendingTextTemplates: textTemplates,
    })
    const frame =
      target.kind === 'chat' && this.selectedGenerationPendingKeys(target).length > 0
        ? Object.freeze({
            workspaceId: resolvedFrame.workspaceId,
            replacementEpoch: resolvedFrame.replacementEpoch,
            resolve: (requirement: ActiveGenerationConfigurationRequirement) =>
              requirement.kind === 'chat' && requirement.chatId === target.chatId
                ? PENDING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
                : resolvedFrame.resolve(requirement),
          })
        : resolvedFrame
    this.activeGenerationFrameCache = {
      workspace,
      target,
      selection,
      shell,
      shellLoad,
      promptRevision,
      workspaceSettingsRevision: this.generationWorkspaceSettingsRevision,
      textTemplates,
      frame,
    }
    return frame
  }

  private withPublicationBatch<T>(work: () => T): T {
    this.publicationBatchDepth += 1
    try {
      return work()
    } finally {
      this.publicationBatchDepth -= 1
      if (this.publicationBatchDepth === 0 && this.publicationPending) {
        this.publicationPending = false
        this.publishSnapshot()
      }
    }
  }

  private finishProjectionLoad(
    kind: keyof ConfigurationProjectionLoadStates,
    state: ConfigurationProjectionLoadState,
  ): void {
    this.loads = Object.freeze({ ...this.loads, [kind]: Object.freeze(state) })
  }

  private projectChatSettings(chatId: ChatId, canonical: ChatSettings): ChatSettings {
    const replacement = this.pendingChatSettingsReplacements.get(chatId)
    let settings = replacement
      ? normalizeChatSettings(structuredClone(replacement.settings))
      : canonical
    const fields = this.pendingChatSettingsFields.get(chatId)
    if (!fields || fields.size === 0) return settings
    const ordered = [...fields.values()].sort((left, right) => left.revision - right.revision)
    for (const intent of ordered) {
      settings = applyChatSettingsFieldPatches(settings, intent.patches)
    }
    return settings
  }

  private publishPendingConfigurationChange(previous: ActiveConfigurationTarget): void {
    const next = this.activeFrameTargetFromCurrentState()
    if (!sameActiveConfigurationRoutingTarget(previous, next)) this.intentRevision += 1
    this.withPublicationBatch(() => {
      this.setActiveFrameTarget(next)
      this.publish()
    })
  }

  private matchesWorkspace(change: WorkspaceFence): boolean {
    const fence = this.workspaceFence
    if (!fence) return false
    return (
      change.workspaceId === fence.workspaceId && change.replacementEpoch === fence.replacementEpoch
    )
  }

  private matchesFence(fence: WorkspaceFence): boolean {
    return (
      this.workspaceFence !== null &&
      this.workspaceFence.workspaceId === fence.workspaceId &&
      this.workspaceFence.replacementEpoch === fence.replacementEpoch
    )
  }

  private releaseEditSession(session: TabConfigurationEditSession): void {
    const owners = session.chatId === null ? this.workspaceEditSessions : this.editSessions
    const ownerId = session.chatId ?? session.ownerKey
    const sessions = owners.get(ownerId)
    if (sessions?.get(session.fieldKey) !== session) return
    sessions.delete(session.fieldKey)
    if (sessions.size === 0) owners.delete(ownerId)
  }

  private closeChatEditSessions(chatId: ChatId, disposition: ConfigurationEditDisposition): void {
    const sessions = [...(this.editSessions.get(chatId)?.values() ?? [])]
    for (const session of sessions) void session.close(disposition).catch(() => undefined)
  }

  private closeAllEditSessions(disposition: ConfigurationEditDisposition): void {
    const sessions = [
      ...this.editSessions.values(),
      ...this.workspaceEditSessions.values(),
    ].flatMap((byField) => [...byField.values()])
    for (const session of sessions) void session.close(disposition).catch(() => undefined)
  }

  private persistSeed(): void {
    const storage = browserSessionStorage()
    if (!storage) return
    try {
      if (this.seed.profileId || this.seed.presetId || this.seed.settings) {
        storage.setItem(ACTIVE_CONFIGURATION_SEED_KEY, JSON.stringify(this.seed))
      } else {
        storage.removeItem(ACTIVE_CONFIGURATION_SEED_KEY)
      }
    } catch {
      // Session persistence is a reload convenience; the in-memory intent remains authoritative.
    }
  }

  private get seed(): ActiveConfigurationSeed {
    return this.seedState.value
  }

  private publishCatalogChange(dependencies: readonly WorkspaceDependency[] | 'all'): void {
    const fence = this.workspaceFence
    if (!fence) return
    const change = Object.freeze({ ...fence, dependencies })
    for (const listener of [...this.catalogListeners]) listener(change)
  }

  private publish(): void {
    if (this.publicationBatchDepth > 0) {
      this.publicationPending = true
      return
    }
    this.publishSnapshot()
  }

  private publishSnapshot(): void {
    this.discovery.reconcile({
      enabled: this.source !== null && this.workspaceFence !== null,
      surface: this.discoverySurface,
      modelCatalog: activeConfigurationModelCatalogProjection(this.frameSelection, this.frameModel),
      modelRouting: activeConfigurationModelRoutingProjection(this.frameModel),
    })
    const discovery = this.discovery.getSnapshot()
    const shell = configurationShellWithPendingWorkspaceSettings(
      this.frameShell,
      this.pendingWorkspaceSettings,
    )
    const frame = Object.freeze({
      workspace: this.workspaceFence,
      revision: this.frameRevision,
      shell,
      globalTokenCalibration: this.frameGlobalTokenCalibration,
      textTemplates: this.frameTextTemplates,
      target: this.frameTarget,
      selection: this.frameSelection,
      model: configurationModelSlotWithDiscovery(this.frameModel, discovery),
      generation: this.activeGenerationConfigurationFrame(),
    })
    this.snapshot = Object.freeze({
      revision: this.intentRevision,
      workspaceFence: this.workspaceFence,
      seed: this.seed,
      discovery,
      loads: this.loads,
      ui: this.ui,
      frame,
    })
    for (const listener of [...this.listeners]) listener()
  }
}

interface ActiveGenerationConfigurationFrameInput {
  readonly workspace: WorkspaceFence
  readonly target: ActiveConfigurationTarget
  readonly selection: ConfigurationSelectionFrameSlot
  readonly shell: ConfigurationShellProjection | null
  readonly shellLoad: ConfigurationProjectionLoadState
  readonly promptFields: readonly PendingPromptFieldIntent[]
  readonly workspaceSettingOverrides: ActiveGenerationConfigurationClaim['workspaceSettingOverrides']
  readonly pendingTextTemplates: {
    get(templateId: TextTemplateId): TextTemplateConfig | undefined
  }
}

function createActiveGenerationConfigurationFrame({
  workspace,
  target,
  selection,
  shell,
  shellLoad,
  promptFields,
  workspaceSettingOverrides,
  pendingTextTemplates,
}: ActiveGenerationConfigurationFrameInput): ActiveGenerationConfigurationFrame {
  if (target.kind !== 'new-chat' && target.kind !== 'chat') {
    return Object.freeze({
      workspaceId: workspace.workspaceId,
      replacementEpoch: workspace.replacementEpoch,
      resolve: () => PENDING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION,
    })
  }
  const terminal = activeGenerationConfigurationTerminal(target, selection, shell, shellLoad)
  if (terminal.capability !== 'ready') {
    return Object.freeze({
      workspaceId: workspace.workspaceId,
      replacementEpoch: workspace.replacementEpoch,
      resolve: () => terminal,
    })
  }
  const selected = terminal.selection
  const profile = terminal.profile
  const requestRevision = terminal.requestRevision
  const baseSettings = target.settings
  const presetId = target.presetId

  const resolveClaim = (
    settingsPatch?: ChatSettingsPatch,
  ): ActiveGenerationConfigurationResolution => {
    let settings = settingsPatch
      ? applyChatSettingsPatch(baseSettings, settingsPatch)
      : baseSettings
    for (const prompt of promptFields) {
      settings = applyLocalPromptValue(settings, prompt.field, prompt.value)
    }
    if (!settings.profileId || !settings.model || settings.profileId !== profile.id) {
      return CONFIGURATION_MISSING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
    }
    let dispatchProfile: ReturnType<typeof connectionDispatchProfileProof>
    try {
      dispatchProfile = connectionDispatchProfileProof(profile, settings.model)
    } catch {
      return FAILED_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
    }
    const dispatchKeyIds = [
      dispatchProfile.apiKeyRef,
      ...dispatchProfile.apiKeyFallbackRefs,
    ].filter((keyId): keyId is string => keyId !== null)
    if (
      dispatchKeyIds.length !== selected.dispatchKeyRevisions.length ||
      dispatchKeyIds.some((keyId, index) => selected.dispatchKeyRevisions[index]?.keyId !== keyId)
    ) {
      return FAILED_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
    }
    const savedTextTemplate = activeGenerationSavedTextTemplate(
      settings.textTemplate,
      selected.textTemplate,
      pendingTextTemplates,
    )
    if (savedTextTemplate === null) {
      return CONFIGURATION_MISSING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
    }
    const claim = deepFreezeActiveGenerationValue({
      settings,
      presetId,
      profile: dispatchProfile,
      requestRevision,
      dispatchKeyRevisions: selected.dispatchKeyRevisions,
      workspaceSettingOverrides,
      ...(savedTextTemplate ? { savedTextTemplate } : {}),
    }) satisfies ActiveGenerationConfigurationClaim
    return target.kind === 'chat'
      ? Object.freeze({
          capability: 'ready' as const,
          kind: 'chat' as const,
          chatId: target.chatId,
          configurationVersion: target.configurationVersion,
          configurationLinkTransition: Object.freeze({
            expectedResourceNames: target.configurationLinkProof.expectedResourceNames,
            nextResourceNames: Object.freeze(
              chatConfigurationTargetResourceNames({
                id: target.chatId,
                settings,
                ...(target.configurationLinkProof.persistedPresetId
                  ? { presetId: target.configurationLinkProof.persistedPresetId }
                  : {}),
              }),
            ),
          }),
          claim,
        })
      : Object.freeze({
          capability: 'ready' as const,
          kind: 'new-chat' as const,
          claim,
        })
  }
  const base = resolveClaim()
  return Object.freeze({
    workspaceId: workspace.workspaceId,
    replacementEpoch: workspace.replacementEpoch,
    resolve: (requirement: ActiveGenerationConfigurationRequirement) => {
      if (
        (target.kind === 'new-chat' && requirement.kind !== 'new-chat') ||
        (target.kind === 'chat' &&
          (requirement.kind !== 'chat' || requirement.chatId !== target.chatId))
      ) {
        return PENDING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
      }
      if (requirement.kind === 'chat' && requirement.settingsPatch) {
        return resolveClaim(requirement.settingsPatch)
      }
      return base
    },
  })
}

function activeGenerationConfigurationTerminal(
  target: ActiveConfigurationSelectionTarget,
  selection: ConfigurationSelectionFrameSlot,
  shell: ConfigurationShellProjection | null,
  shellLoad: ConfigurationProjectionLoadState,
):
  | NonReadyActiveGenerationConfigurationResolution
  | {
      readonly capability: 'ready'
      readonly selection: ActiveConfigurationSelection
      readonly profile: ConfigurationSelectedProfile
      readonly requestRevision: ConfigurationRequestRevision
    } {
  if (selection.status === 'error') return FAILED_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
  if (selection.status !== 'ready' || selection.target !== target) {
    return PENDING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
  }
  const selected = selection.value
  if (!selected.profile) {
    if (shellLoad.status === 'error') return FAILED_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
    if (shellLoad.status !== 'ready' || !shell) {
      return PENDING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
    }
    return shell.totalProfileCount === 0
      ? CONNECTION_MISSING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
      : CONFIGURATION_MISSING_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
  }
  if (!selected.requestRevision || selected.requestRevision.profileId !== selected.profile.id) {
    return FAILED_ACTIVE_GENERATION_CONFIGURATION_RESOLUTION
  }
  return Object.freeze({
    capability: 'ready',
    selection: selected,
    profile: selected.profile,
    requestRevision: selected.requestRevision,
  })
}

function activeGenerationSavedTextTemplate(
  templateId: TextTemplateId | undefined,
  selected: ActiveConfigurationSelection['textTemplate'],
  pending: { get(templateId: TextTemplateId): TextTemplateConfig | undefined },
): ActiveGenerationConfigurationClaim['savedTextTemplate'] | null | undefined {
  if (!templateId || isStaticTextTemplateId(templateId)) return undefined
  const pendingConfig = pending.get(templateId)
  if (pendingConfig) {
    return Object.freeze({
      templateId,
      config: normalizeTextTemplateConfig(pendingConfig),
    })
  }
  if (selected?.templateId !== templateId) return null
  return Object.freeze({
    templateId,
    config: selected.config ? normalizeTextTemplateConfig(selected.config) : null,
  })
}

function deepFreezeActiveGenerationValue<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  for (const child of Object.values(value)) deepFreezeActiveGenerationValue(child)
  return Object.isFrozen(value) ? value : Object.freeze(value)
}

function concreteActiveConfigurationTarget(
  target: ActiveConfigurationTarget,
): ActiveConfigurationSelectionTarget | null {
  return target.kind === 'chat' || target.kind === 'new-chat' ? target : null
}

function sameActiveConfigurationTarget(
  left: ActiveConfigurationTarget,
  right: ActiveConfigurationTarget,
): boolean {
  if (left === right) return true
  if (left.kind !== right.kind) return false
  if (left.kind === 'none' || right.kind === 'none') return true
  if (left.kind === 'chat-resolving' && right.kind === 'chat-resolving') {
    return left.chatId === right.chatId
  }
  if (left.kind === 'new-chat' && right.kind === 'new-chat') {
    return (
      left.seedKind === right.seedKind &&
      left.seedRevision === right.seedRevision &&
      left.profileId === right.profileId &&
      left.presetId === right.presetId &&
      sameChatSettings(left.settings, right.settings)
    )
  }
  if (left.kind === 'chat' && right.kind === 'chat') {
    return (
      left.chatId === right.chatId &&
      left.configurationVersion === right.configurationVersion &&
      left.overlayRevision === right.overlayRevision &&
      left.profileId === right.profileId &&
      left.presetId === right.presetId &&
      left.configurationLinkProof.persistedPresetId ===
        right.configurationLinkProof.persistedPresetId &&
      sameStringArray(
        left.configurationLinkProof.expectedResourceNames,
        right.configurationLinkProof.expectedResourceNames,
      ) &&
      sameChatSettings(left.settings, right.settings)
    )
  }
  return false
}

export function sameActiveConfigurationRoutingTarget(
  left: ActiveConfigurationTarget,
  right: ActiveConfigurationTarget,
): boolean {
  const leftConcrete = concreteActiveConfigurationTarget(left)
  const rightConcrete = concreteActiveConfigurationTarget(right)
  return (
    leftConcrete?.profileId === rightConcrete?.profileId &&
    (leftConcrete?.settings.model || null) === (rightConcrete?.settings.model || null)
  )
}

function sameActiveConfigurationSelectionKey(
  left: ActiveConfigurationSelectionTarget,
  right: ActiveConfigurationSelectionTarget,
): boolean {
  if (left.profileId !== right.profileId || left.presetId !== right.presetId) return false
  const leftPrompts = chatSettingsPromptPresetReferences(left.settings)
  const rightPrompts = chatSettingsPromptPresetReferences(right.settings)
  return (
    (left.settings.textTemplate ?? null) === (right.settings.textTemplate ?? null) &&
    leftPrompts.length === rightPrompts.length &&
    leftPrompts.every((reference, index) => {
      const counterpart = rightPrompts[index] as (typeof rightPrompts)[number]
      return reference.id === counterpart.id && reference.kind === counterpart.kind
    })
  )
}

function sameActiveConfigurationModelTarget(
  left: ActiveConfigurationModelTarget | null,
  right: ActiveConfigurationModelTarget | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.profileId === right.profileId &&
      left.modelId === right.modelId &&
      left.proxy.url === right.proxy.url &&
      left.proxy.secret === right.proxy.secret &&
      configurationRequestRevisionKey(left.requestRevision) ===
        configurationRequestRevisionKey(right.requestRevision))
  )
}

function freezeActiveConfigurationTarget<T extends ActiveConfigurationTarget>(target: T): T {
  if (target.kind !== 'chat' && target.kind !== 'new-chat') return Object.freeze({ ...target })
  return Object.freeze({
    ...target,
    settings: normalizeChatSettings(structuredClone(target.settings)),
    ...(target.kind === 'chat'
      ? {
          configurationLinkProof: Object.freeze({
            ...target.configurationLinkProof,
            expectedResourceNames: Object.freeze([
              ...target.configurationLinkProof.expectedResourceNames,
            ]),
          }),
        }
      : {}),
  }) as T
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function freezeActiveConfigurationSelection(
  selection: ActiveConfigurationSelection,
): ActiveConfigurationSelection {
  return Object.freeze({
    profile: selection.profile ? Object.freeze(structuredClone(selection.profile)) : null,
    preset: selection.preset ? Object.freeze(structuredClone(selection.preset)) : null,
    requestRevision: selection.requestRevision
      ? Object.freeze(structuredClone(selection.requestRevision))
      : null,
    dispatchKeyRevisions: Object.freeze(
      selection.dispatchKeyRevisions.map((revision) => Object.freeze({ ...revision })),
    ),
    promptPresets: Object.freeze(
      selection.promptPresets.map((preset) => Object.freeze({ ...preset })),
    ),
    textTemplate: selection.textTemplate
      ? Object.freeze({
          templateId: selection.textTemplate.templateId,
          config: selection.textTemplate.config
            ? structuredClone(selection.textTemplate.config)
            : null,
        })
      : null,
  })
}

function freezeConfigurationShell(
  projection: ConfigurationShellProjection,
): ConfigurationShellProjection {
  return Object.freeze({
    preferences: freezePreferencesProjection(projection.preferences),
    totalProfileCount: projection.totalProfileCount,
  })
}

function freezeGlobalTokenCalibration(calibration: GlobalTokenCalibration): GlobalTokenCalibration {
  const value = structuredClone(calibration)
  for (const sample of Object.values(value.byModel)) Object.freeze(sample)
  Object.freeze(value.byModel)
  return Object.freeze(value)
}

function readyConfigurationSelection(slot: ConfigurationSelectionFrameSlot): {
  readonly target: ActiveConfigurationSelectionTarget
  readonly value: ActiveConfigurationSelection
} | null {
  if (slot.status === 'ready') return { target: slot.target, value: slot.value }
  if (slot.status === 'pending' || slot.status === 'error') {
    if (!slot.retained) return null
    return slot.retained.kind === 'same-target'
      ? { target: slot.target, value: slot.retained.value }
      : { target: slot.retained.target, value: slot.retained.value }
  }
  if (slot.status === 'resolving' && slot.retained) {
    return { target: slot.retained.target, value: slot.retained.value }
  }
  return null
}

function readyConfigurationModel(slot: ConfigurationModelFrameSlot): {
  readonly target: ActiveConfigurationModelTarget
  readonly value: ActiveConfigurationModel
} | null {
  if (slot.status === 'ready') return { target: slot.target, value: slot.value }
  if (slot.status === 'blocked') return slot.retained
  if ((slot.status === 'pending' || slot.status === 'error') && slot.retained) {
    return slot.retained.kind === 'same-target'
      ? { target: slot.target, value: slot.retained.value }
      : { target: slot.retained.target, value: slot.retained.value }
  }
  return null
}

function configurationSelectionQueryTarget(
  target: ActiveConfigurationSelectionTarget,
): ConfigurationSelectionQueryTarget {
  return target.kind === 'chat'
    ? {
        kind: 'chat',
        profileId: target.profileId,
        presetId: target.presetId,
        promptPresets: chatSettingsPromptPresetReferences(target.settings),
        textTemplateId: target.settings.textTemplate ?? null,
      }
    : {
        kind: 'new-chat',
        profileId: target.profileId,
        presetId: target.presetId,
        fallback: target.seedKind === 'workspace-default' ? 'full' : 'missing-profile',
        promptPresets: chatSettingsPromptPresetReferences(target.settings),
        textTemplateId: target.settings.textTemplate ?? null,
      }
}

function workspaceDefaultConfigurationSeed(
  projection?: ConfigurationActiveSelectionProjection,
): ActiveConfigurationSeed & { readonly settings: ChatSettings } {
  const profileId = projection?.profile?.id ?? projection?.preset?.connectionProfileId ?? null
  if (projection?.preset) {
    return freezeSeed({
      profileId,
      presetId: projection.preset.id,
      settings: projection.preset.settings,
    })
  }
  const settings = cloneDefaultChatSettings()
  settings.profileId = profileId ?? ''
  return freezeSeed({ profileId, presetId: null, settings })
}

function resolvedNewChatSeed(
  target: Extract<ActiveConfigurationTarget, { readonly kind: 'new-chat' }>,
  projection: ConfigurationActiveSelectionProjection,
): ActiveConfigurationSeed & { readonly settings: ChatSettings } {
  const profileId = projection.profile?.id ?? null
  const settings = structuredClone(target.settings)
  const previousProfileId = settings.profileId || target.profileId
  settings.profileId = profileId ?? ''
  if (previousProfileId && previousProfileId !== profileId) settings.model = ''
  return freezeSeed({ profileId, presetId: projection.preset?.id ?? null, settings })
}

function resolvedConfigurationSeedState(
  value: ActiveConfigurationSeed,
): ActiveConfigurationSeedState {
  return Object.freeze({ kind: 'resolved', value })
}

function workspaceDefaultConfigurationSeedState(): ActiveConfigurationSeedState {
  return Object.freeze({ kind: 'workspace-default', value: workspaceDefaultConfigurationSeed() })
}

function activeModelTargetFromSelection(
  slot: ConfigurationSelectionFrameSlot,
  shell: ConfigurationShellProjection | null,
): ActiveConfigurationModelTarget | null {
  if (slot.status !== 'ready') return null
  const profile = slot.value.profile
  const revision = slot.value.requestRevision
  const modelId = slot.target.settings.model || null
  if (!profile || !revision || !shell) return null
  return {
    profileId: profile.id,
    modelId,
    requestRevision: revision,
    proxy: corsProxyConfigFromPrefs(shell.preferences.global),
    profile,
    settings: slot.target.settings,
  }
}

function activeChatOverlayRevision(
  replacement: PendingChatSettingsReplacementIntent | undefined,
  fields: ReadonlyMap<string, PendingChatSettingsFieldIntent> | undefined,
): number {
  let revision = replacement?.revision ?? 0
  for (const field of fields?.values() ?? []) revision = Math.max(revision, field.revision)
  return revision
}

function knownActiveModelPayloads(
  previous: ReturnType<typeof readyConfigurationModel>,
  target: ActiveConfigurationModelTarget,
  includeModels: boolean,
): ConfigurationActiveModelKnownPayloads {
  if (!previous) return {}
  const sameRevision =
    previous.target.profileId === target.profileId &&
    configurationRequestRevisionKey(previous.target.requestRevision) ===
      configurationRequestRevisionKey(target.requestRevision)
  if (!sameRevision) return {}
  const sameModel = previous.target.modelId === target.modelId
  return Object.freeze({
    ...(includeModels && previous.value.models && previous.value.payloadTokens.models
      ? { models: previous.value.payloadTokens.models }
      : {}),
    ...(sameModel && previous.value.endpoints && previous.value.payloadTokens.endpoints
      ? { endpoints: previous.value.payloadTokens.endpoints }
      : {}),
    ...(sameModel && previous.value.privacy && previous.value.payloadTokens.privacy
      ? { privacy: previous.value.payloadTokens.privacy }
      : {}),
  })
}

function sameDiscoveryPayloadToken(
  left: ConfigurationDiscoveryPayloadToken | undefined,
  right: ConfigurationDiscoveryPayloadToken,
): boolean {
  return (
    left !== undefined &&
    left.profileRevision === right.profileRevision &&
    left.payloadId === right.payloadId &&
    left.payloadByteLength === right.payloadByteLength
  )
}

function mergeActiveConfigurationPayload<Row>(
  projection: ConfigurationDiscoveryPayloadProjection<Row>,
  previousRow: Row | undefined,
  previousToken: ConfigurationDiscoveryPayloadToken | undefined,
): { readonly row?: Row; readonly token?: ConfigurationDiscoveryPayloadToken } {
  if (projection.kind === 'not-requested') {
    return previousRow && previousToken ? { row: previousRow, token: previousToken } : {}
  }
  if (projection.kind === 'missing') return {}
  if (projection.kind === 'loaded') {
    return { row: Object.freeze(projection.row), token: Object.freeze(projection.token) }
  }
  if (!previousRow || !sameDiscoveryPayloadToken(previousToken, projection.token)) {
    throw new Error('ConfigurationActiveModelPayloadBodyMissing')
  }
  return { row: previousRow, token: projection.token }
}

function mergeActiveConfigurationModel(
  target: ActiveConfigurationModelTarget,
  projection: ConfigurationActiveModelProjection,
  previous: ReturnType<typeof readyConfigurationModel>,
  discovery: ConfigurationDiscoverySnapshot,
): ActiveConfigurationModel {
  const sameRevision =
    previous?.target.profileId === target.profileId &&
    configurationRequestRevisionKey(previous.target.requestRevision) ===
      configurationRequestRevisionKey(target.requestRevision)
  const sameModel = sameRevision && previous.target.modelId === target.modelId
  const models = mergeActiveConfigurationPayload(
    projection.models,
    sameRevision ? previous.value.models : undefined,
    sameRevision ? previous.value.payloadTokens.models : undefined,
  )
  const endpoints = mergeActiveConfigurationPayload(
    projection.endpoints,
    sameModel ? previous.value.endpoints : undefined,
    sameModel ? previous.value.payloadTokens.endpoints : undefined,
  )
  const privacy = mergeActiveConfigurationPayload(
    projection.privacy,
    sameModel ? previous.value.privacy : undefined,
    sameModel ? previous.value.payloadTokens.privacy : undefined,
  )
  return Object.freeze({
    ...(models.row ? { models: models.row } : {}),
    ...(endpoints.row ? { endpoints: endpoints.row } : {}),
    ...(privacy.row ? { privacy: privacy.row } : {}),
    proxy: Object.freeze({ ...target.proxy }),
    payloadTokens: Object.freeze({
      ...(models.token ? { models: models.token } : {}),
      ...(endpoints.token ? { endpoints: endpoints.token } : {}),
      ...(privacy.token ? { privacy: privacy.token } : {}),
    }),
    discovery,
  })
}

function configurationModelSlotWithDiscovery(
  slot: ConfigurationModelFrameSlot,
  discovery: ConfigurationDiscoverySnapshot,
): ConfigurationModelFrameSlot {
  const withDiscovery = (value: ActiveConfigurationModel): ActiveConfigurationModel =>
    value.discovery === discovery ? value : Object.freeze({ ...value, discovery })
  if (slot.status === 'ready') {
    return Object.freeze({ ...slot, value: withDiscovery(slot.value) })
  }
  if (slot.status === 'blocked' && slot.retained) {
    return Object.freeze({
      ...slot,
      retained: Object.freeze({
        target: slot.retained.target,
        value: withDiscovery(slot.retained.value),
      }),
    })
  }
  if ((slot.status === 'pending' || slot.status === 'error') && slot.retained) {
    return Object.freeze({
      ...slot,
      retained:
        slot.retained.kind === 'same-target'
          ? Object.freeze({ kind: 'same-target', value: withDiscovery(slot.retained.value) })
          : Object.freeze({
              kind: 'previous-target',
              target: slot.retained.target,
              value: withDiscovery(slot.retained.value),
            }),
    })
  }
  return slot
}

function activeConfigurationModelCatalogProjection(
  selectionSlot: ConfigurationSelectionFrameSlot,
  modelSlot: ConfigurationModelFrameSlot,
): ConfigurationModelCatalogProjection | null {
  const selection = currentSelectionFromSlot(selectionSlot)
  const model = currentModelFromSlot(modelSlot)
  if (
    !selection?.value.profile ||
    !model ||
    selection.value.profile.id !== model.target.profileId
  ) {
    return null
  }
  return {
    profile: selection.value.profile,
    revision: model.target.requestRevision,
    ...(model.value.models ? { models: model.value.models } : {}),
  }
}

function activeConfigurationModelRoutingProjection(
  modelSlot: ConfigurationModelFrameSlot,
): ConfigurationModelRoutingProjection | null {
  const model = currentModelFromSlot(modelSlot)
  if (!model?.target.modelId) return null
  return {
    profileId: model.target.profileId,
    revision: model.target.requestRevision,
    modelId: model.target.modelId,
    ...(model.value.endpoints ? { endpoints: model.value.endpoints } : {}),
    ...(model.value.privacy ? { privacy: model.value.privacy } : {}),
    proxy: model.value.proxy,
  }
}

function currentSelectionFromSlot(
  slot: ConfigurationSelectionFrameSlot,
): ReturnType<typeof currentActiveConfigurationSelection> {
  if (slot.status === 'ready') return { target: slot.target, value: slot.value }
  if (
    (slot.status === 'pending' || slot.status === 'error') &&
    slot.retained?.kind === 'same-target'
  ) {
    return { target: slot.target, value: slot.retained.value }
  }
  return null
}

function activeSelectionWorkspaceDependencies(
  target: ActiveConfigurationSelectionTarget,
  slot: ConfigurationSelectionFrameSlot,
): readonly WorkspaceDependency[] {
  const dependencies = workspaceQueryDependencies({
    kind: 'configuration.active-selection',
    target: configurationSelectionQueryTarget(target),
  })
  const selection = currentSelectionFromSlot(slot)
  if (!selection) {
    return [...dependencies, { kind: 'key', facets: ['request-material'] }]
  }
  const keyIds = selection.value.profile ? connectionDispatchKeyRefs(selection.value.profile) : []
  return keyIds.length === 0
    ? dependencies
    : [...dependencies, { kind: 'key', keyIds, facets: ['request-material'] }]
}

function currentModelFromSlot(
  slot: ConfigurationModelFrameSlot,
): ReturnType<typeof currentActiveConfigurationModel> {
  if (slot.status === 'ready') return { target: slot.target, value: slot.value }
  if (slot.status === 'blocked') return slot.retained
  if (
    (slot.status === 'pending' || slot.status === 'error') &&
    slot.retained?.kind === 'same-target'
  ) {
    return { target: slot.target, value: slot.retained.value }
  }
  return null
}

class TabConfigurationEditSession implements ConfigurationEditSession {
  readonly chatId: ChatId | null
  readonly ownerKey: string
  readonly fieldKey: string
  readonly kind: 'mounted' | 'detached'
  private readonly flushPendingValue: () => Promise<void>
  private readonly release: () => void
  private readonly pending = new Set<Promise<unknown>>()
  private flushInFlight: Promise<void> | null = null
  private closeInFlight: Promise<void> | null = null
  private accepting = true

  constructor(
    input: ConfigurationEditSessionInput & { readonly ownerKey: string },
    release: () => void,
  ) {
    this.chatId = input.chatId ?? null
    this.ownerKey = input.ownerKey
    this.fieldKey = input.fieldKey
    this.kind = input.kind ?? 'mounted'
    this.flushPendingValue = input.flush
    this.release = release
  }

  get pendingOperationCount(): number {
    return this.pending.size
  }

  track<T>(operation: Promise<T>): Promise<T> {
    if (!this.accepting) return operation
    const tracked = operation.finally(() => this.pending.delete(tracked))
    this.pending.add(tracked)
    return tracked
  }

  flush(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight
    const flush = this.flushUntilSettled().finally(() => {
      if (this.flushInFlight === flush) this.flushInFlight = null
    })
    this.flushInFlight = flush
    return flush
  }

  close(disposition: ConfigurationEditDisposition = 'flush'): Promise<void> {
    if (this.closeInFlight) return this.closeInFlight
    if (disposition === 'discard') {
      this.accepting = false
      this.release()
      return Promise.resolve()
    }
    const close = this.flush().finally(() => {
      this.accepting = false
      this.release()
    })
    this.closeInFlight = close
    return close
  }

  private async flushUntilSettled(): Promise<void> {
    await this.flushPendingValue()
    for (;;) {
      const pending = [...this.pending]
      if (pending.length === 0) return
      const results = await Promise.allSettled(pending)
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (failed) throw failed.reason
    }
  }
}

function cloneChatSettingsFieldPatch(patch: ChatSettingsFieldPatch): ChatSettingsFieldPatch {
  const path = [...patch.path] as ChatSettingsFieldPatch['path']
  if (patch.membership) {
    return Object.freeze({
      path,
      membership: Object.freeze({
        member: structuredClone(patch.membership.member),
        present: patch.membership.present,
      }),
    })
  }
  return Object.freeze({
    path,
    ...(patch.value === undefined ? {} : { value: structuredClone(patch.value) }),
  })
}

function chatSettingsFieldKey(patch: ChatSettingsFieldPatch): string {
  return JSON.stringify([
    patch.path,
    patch.membership ? canonicalJsonValue(patch.membership.member) : null,
  ])
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
  )
}

function configurationProjectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.trim() || 'Configuration projection failed').slice(0, 500)
}

function readPersistedSeed(): ActiveConfigurationSeed {
  const storage = browserSessionStorage()
  if (!storage) return EMPTY_SEED
  try {
    const raw = storage.getItem(ACTIVE_CONFIGURATION_SEED_KEY)
    if (!raw) return EMPTY_SEED
    const parsed = normalizeSeed(JSON.parse(raw))
    if (parsed) return parsed
    storage.removeItem(ACTIVE_CONFIGURATION_SEED_KEY)
  } catch {
    try {
      storage.removeItem(ACTIVE_CONFIGURATION_SEED_KEY)
    } catch {
      // Ignore storage cleanup failures.
    }
  }
  return EMPTY_SEED
}

function normalizeSeed(value: unknown): ActiveConfigurationSeed | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { profileId?: unknown; presetId?: unknown; settings?: unknown }
  const profileId = typeof candidate.profileId === 'string' ? candidate.profileId : null
  const presetId = typeof candidate.presetId === 'string' ? candidate.presetId : null
  const settings =
    candidate.settings && typeof candidate.settings === 'object'
      ? (structuredClone(candidate.settings) as ChatSettings)
      : null
  if (!profileId && !presetId && !settings) return null
  return { profileId, presetId, settings }
}

function freezeSeed(
  seed: ActiveConfigurationSeed & { readonly settings: ChatSettings },
): ActiveConfigurationSeed & { readonly settings: ChatSettings }
function freezeSeed(seed: ActiveConfigurationSeed): ActiveConfigurationSeed
function freezeSeed(seed: ActiveConfigurationSeed): ActiveConfigurationSeed {
  return Object.freeze({
    profileId: seed.profileId ?? null,
    presetId: seed.presetId ?? null,
    settings: seed.settings ? structuredClone(seed.settings) : null,
  })
}

function activeSeedFromChat(chat: Chat): ActiveConfigurationSeed {
  return freezeSeed({
    profileId: chat.settings.profileId || null,
    presetId: chat.presetId ?? null,
    settings: chat.settings,
  })
}

function sameSeed(a: ActiveConfigurationSeed, b: ActiveConfigurationSeed): boolean {
  return (
    a.profileId === b.profileId &&
    a.presetId === b.presetId &&
    (a.settings === b.settings ||
      (a.settings !== null && b.settings !== null && sameChatSettings(a.settings, b.settings)))
  )
}

function sameOptionalSeed(
  a: ActiveConfigurationSeed | null,
  b: ActiveConfigurationSeed | null,
): boolean {
  return a === b || (a !== null && b !== null && sameSeed(a, b))
}

function freezePreferencesProjection(
  projection: ConfigurationPreferencesProjection,
): ConfigurationPreferencesProjection {
  const global = structuredClone(projection.global)
  Object.freeze(global.pinnedModels)
  Object.freeze(global.recentModels)
  return Object.freeze({
    global: Object.freeze(global),
    rendering: Object.freeze(structuredClone(projection.rendering)),
    sidebarSortMode: projection.sidebarSortMode,
    collapsedFolderIds: Object.freeze([...projection.collapsedFolderIds]),
    imageAllowlist: Object.freeze([...projection.imageAllowlist]),
    samplePromptsDismissed: projection.samplePromptsDismissed,
  })
}

function configurationShellWithPendingWorkspaceSettings(
  shell: ConfigurationShellProjection | null,
  pendingWorkspaceSettings: ReadonlyMap<string, PendingWorkspaceSettingIntent>,
): ConfigurationShellProjection | null {
  if (!shell) return null
  let preferences = shell.preferences
  for (const key of [
    ...GLOBAL_PREFERENCE_KEYS,
    RENDERING_PREFERENCES_KEY,
    SIDEBAR_SORT_SETTING_KEY,
    SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
  ]) {
    const pending = pendingWorkspaceSettings.get(key)
    if (pending) preferences = preferencesWithWorkspaceSetting(preferences, key, pending.value)
  }
  if (preferences === shell.preferences) return shell
  return Object.freeze({
    ...shell,
    preferences,
  })
}

function configurationShellWithWorkspaceSetting(
  shell: ConfigurationShellProjection,
  key: string,
  value: unknown,
): ConfigurationShellProjection {
  const preferences = preferencesWithWorkspaceSetting(shell.preferences, key, value)
  if (preferences === shell.preferences) return shell
  return Object.freeze({
    ...shell,
    preferences,
  })
}

function preferencesWithWorkspaceSetting(
  preferences: ConfigurationPreferencesProjection,
  key: string,
  value: unknown,
): ConfigurationPreferencesProjection {
  if (GLOBAL_PREFERENCE_KEYS.includes(key as (typeof GLOBAL_PREFERENCE_KEYS)[number])) {
    return freezePreferencesProjection({
      ...preferences,
      global: globalPreferencesWithStoredValue(preferences.global, key, value),
    })
  }
  if (key === RENDERING_PREFERENCES_KEY) {
    return freezePreferencesProjection({
      ...preferences,
      rendering: normalizeRenderingPreferences(value),
    })
  }
  if (key === SIDEBAR_SORT_SETTING_KEY) {
    return freezePreferencesProjection({
      ...preferences,
      sidebarSortMode: parseSidebarSortMode(value),
    })
  }
  if (key === SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY) {
    return freezePreferencesProjection({
      ...preferences,
      collapsedFolderIds: normalizeCollapsedSidebarFolderIds(value),
    })
  }
  return preferences
}

function selectedGenerationReplacementKey(revision: number): string {
  return `replacement:${revision}`
}

function selectedGenerationChatFieldKey(fieldKey: string, revision: number): string {
  return `chat-field:${fieldKey}:${revision}`
}

function selectedGenerationPromptFieldKey(field: PromptPresetKind, revision: number): string {
  return `prompt-field:${field}:${revision}`
}

function selectedGenerationWorkspaceSettingKey(key: string, revision: number): string {
  return `workspace-setting:${key}:${revision}`
}

function selectedGenerationTextTemplateKey(templateId: TextTemplateId, revision: number): string {
  return `text-template:${templateId}:${revision}`
}

export const configurationController: ConfigurationController = new TabConfigurationController()

export function readRememberedConfigurationSeed(fence?: WorkspaceFence): ActiveConfigurationSeed {
  if (fence && !workspaceTabSessionMatches(fence)) return EMPTY_SEED
  return freezeSeed(readPersistedSeed())
}
