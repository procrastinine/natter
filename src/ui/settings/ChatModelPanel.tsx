// Tabs:
// 1. "Model & Provider"  — inline model picker + (OpenRouter only) provider
//                          picker shell
// 2. "Generation"        — ParamForm (sampling, reasoning, verbosity, stop,
//                          response format, logit-bias, system prompt)
// 3. "Caching"           — CachingPanel
//
// Above the tabs, the preset breadcrumb surfaces the "model + provider +
// generation settings as a profile" concept: shows the current preset name
// and a "Save to preset…" affordance. Picking a model + editing params
// diverges the chat from its seed preset; the breadcrumb lets the user
// write those edits back to the preset (update or save-as-new).

import {
  type ChangeEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { type LlamaServerProps, probeLlamaServer } from '../../api/probe'
import {
  requestPresentationConfirmation,
  requestPresentationText,
} from '../../app/presentation-dialog'
import {
  configurationWriteInteraction,
  configurationWriteTarget,
  definePresentationInteraction,
} from '../../app/presentation-interactions'
import {
  attachmentContextIds,
  attachmentContextPolicyForSettings,
} from '../../core/attachments/context'
import type { EffectiveCapability } from '../../core/capabilities'
import {
  PREFILL_UNAVAILABLE_PLAN,
  rebaseEffectiveEndpointRouting,
} from '../../core/effective-endpoint-routing'
import { modelLooksForeignForProfile } from '../../core/model-selection'
import {
  buildSettingsPromptSizeEstimateInput,
  type PromptSizeEstimate,
  type PromptSizeEstimateInput,
  UNLIMITED_CONTEXT,
} from '../../core/prompt-size'
import { isOpenAiDirectProfile } from '../../core/provider-hosted-tools'
import { isTextCompletionsSelectableFor } from '../../core/quirks'
import {
  EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
  mergeMessageContextRouteFacts,
} from '../../core/reasoning'
import { relevantGlobalTokenCalibration } from '../../core/token-calibration'
import type {
  Chat,
  ChatPreset,
  ConnectionKind,
  ConnectionProfile,
  Message,
  MessageId,
  PresetId,
} from '../../core/types'
import { useChatPresetCatalog } from '../../hooks/useConfigurationCatalog'
import { useConversationFrame } from '../../hooks/useConversationFrame'
import type { UseModelCatalogResult } from '../../hooks/useModelCatalog'
import { usePresentationInteraction } from '../../hooks/usePresentationInteraction'
import { usePromptEstimateContext } from '../../hooks/usePromptEstimateContext'
import {
  useDeferredStreamStablePromptEstimate,
  useStreamStableBranchPath,
} from '../../hooks/useStreamStablePromptEstimate'
import { useAttemptExecutionsForChat } from '../../store/attempt-controller'
import { configurationApplication } from '../../store/configuration-application'
import {
  configurationController,
  currentActiveConfigurationSelection,
  previousActiveConfigurationSelection,
} from '../../store/configuration-controller'
import { currentConversationDestinationSpine } from '../../store/conversation-controller'
import { interchangeApplication } from '../../store/interchange-application'
import type {
  ConfigurationPresetCatalogRow,
  ConversationChatSnapshot,
  MessageHeaderRow,
} from '../../store/presentation-contracts'
import { useToastStore } from '../../store/zustand/toastStore'
import { useAttachmentResolverForContext } from '../attachments/useAttachmentResolver'
import { CloseIcon, DownloadIcon, GripVerticalIcon, UploadIcon } from '../icons/Icon'
import {
  importExportErrorMessage,
  natterJsonFilename,
  readJsonFile,
  triggerJsonDownload,
} from '../import-export/json-file'
import { Button, IconButton } from '../primitives/Button'
import { CachingPanel } from './CachingPanel'
import { ContextPanel } from './ContextPanel'
import { InfoDisclosure } from './InfoDisclosure'
import { LlamaServerSection } from './LlamaServerSection'
import { ModelPicker } from './ModelPicker'
import { ApiModeSection, ParamForm, ReasoningIncludeControls } from './ParamForm'
import { PromptsTab } from './PromptsTab'
import { ProviderPicker } from './ProviderPicker'

interface ChatModelPanelProps {
  chatSnapshot: Chat
  profileSnapshot?: ConnectionProfile | null
  modelCatalog: UseModelCatalogResult
  onClose: () => void
}

type Tab = 'model' | 'context' | 'prompts' | 'generation'
const EMPTY_MESSAGES: readonly Message[] = Object.freeze([])
const EMPTY_MESSAGE_HEADERS: readonly MessageHeaderRow[] = Object.freeze([])
const EMPTY_PRESET_CATALOG_ROWS: readonly ConfigurationPresetCatalogRow[] = Object.freeze([])

export function acceptedSettingsContextPath(frame: ConversationChatSnapshot | null | undefined) {
  if (!frame) return null
  const spine = currentConversationDestinationSpine(frame.destination)
  if (!spine) return null
  if (frame.selectionTargetId && !spine.path.has(frame.selectionTargetId)) return null
  return spine.path
}

export function settingsContextPathQueryIdentity(
  pathAccepted: boolean,
  messageIds: readonly string[],
  attachmentIds: readonly string[],
): string {
  return pathAccepted ? JSON.stringify([messageIds, attachmentIds]) : 'pending'
}

export function ChatModelPanel({
  chatSnapshot,
  profileSnapshot = null,
  modelCatalog,
  onClose,
}: ChatModelPanelProps) {
  const chat = chatSnapshot

  const profile = profileSnapshot?.id === chat.settings.profileId ? profileSnapshot : undefined
  const configuration = useSyncExternalStore(
    (listener) => configurationController.subscribe(listener),
    () => configurationController.getSnapshot(),
    () => configurationController.getSnapshot(),
  )
  const [tab, setTab] = useState<Tab>('model')
  useEffect(() => {
    if (tab !== 'context') return
    return configurationController.demandGlobalTokenCalibration()
  }, [tab])
  const pushToast = useToastStore((state) => state.push)
  const [llamaProps, setLlamaProps] = useState<LlamaServerProps | null>(null)
  useEffect(() => {
    if (profile?.kind !== 'llama-server') {
      setLlamaProps(null)
      return
    }
    let cancelled = false
    void probeLlamaServer({ baseUrl: profile.baseUrl }).then((result) => {
      if (cancelled) return
      setLlamaProps(result.kind === 'ok' ? result.props : null)
    })
    return () => {
      cancelled = true
    }
  }, [profile?.kind, profile?.baseUrl])

  const currentSelection = currentActiveConfigurationSelection(configuration.frame)
  const previousSelection = previousActiveConfigurationSelection(configuration.frame)
  const calibrationEvidence = useMemo(() => {
    const calibration = configuration.frame.globalTokenCalibration
    const preferences = configuration.frame.shell?.preferences
    return calibration && preferences
      ? Object.freeze({
          global: calibration,
          mode: preferences.global.tokenCalibrationMode,
        })
      : null
  }, [configuration.frame.globalTokenCalibration, configuration.frame.shell?.preferences])
  const calibrationQueryIdentity = useMemo(
    () =>
      calibrationEvidence
        ? JSON.stringify([
            calibrationEvidence.mode,
            relevantGlobalTokenCalibration(calibrationEvidence.global, chat.settings.model),
          ])
        : 'pending',
    [calibrationEvidence, chat.settings.model],
  )
  const selectedPreset =
    currentSelection?.target.kind === 'chat' && currentSelection.target.chatId === chat.id
      ? currentSelection.value.preset
      : previousSelection?.value.preset
  const preset = selectedPreset && selectedPreset.id === chat.presetId ? selectedPreset : undefined
  const routing = modelCatalog.routing
  const capabilityPresentation = routing.capabilityPresentation
  const { capability, descriptor } = capabilityPresentation
  const presentationProfile = capabilityPresentation.profile
  const promptPresentationOnly =
    capabilityPresentation.retained &&
    (capabilityPresentation.profileId !== chat.settings.profileId ||
      capabilityPresentation.modelId !== (chat.settings.model || null))
  const presentationChat = useMemo(
    () =>
      capabilityPresentation.settings && capabilityPresentation.settings !== chat.settings
        ? { ...chat, settings: capabilityPresentation.settings }
        : chat,
    [capabilityPresentation.settings, chat],
  )
  const modelPresentationChat = useMemo(
    () =>
      modelCatalog.models.presentation.settings &&
      modelCatalog.models.presentation.settings !== chat.settings
        ? { ...chat, settings: modelCatalog.models.presentation.settings }
        : chat,
    [chat, modelCatalog.models.presentation.settings],
  )
  const modelPresentationProfile = modelCatalog.models.presentation.profile
  const modelAvailable = modelCatalog.models.presentation.modelAvailable
  const presentationIsOpenRouter = presentationProfile?.kind === 'openrouter'
  const privacyPresentationIsOpenRouter = routing.privacyPresentation.profile?.kind === 'openrouter'
  const endpointTokenizer = descriptor?.architecture?.tokenizer ?? null
  const needsPromptEstimate = tab === 'context'
  const needsConversationPath = tab === 'model' || needsPromptEstimate
  const routingReadyForChat =
    !capabilityPresentation.retained && capabilityPresentation.modelId === chat.settings.model
  const canEstimatePrompt =
    needsPromptEstimate &&
    routingReadyForChat &&
    !!capability &&
    (capability.contextLength !== undefined ||
      capability.maxPromptTokens !== undefined ||
      capability.maxCompletionTokens !== undefined)
  const conversationFrame = useConversationFrame({
    chatId: needsConversationPath ? chat.id : null,
  })
  const currentAcceptedPath = acceptedSettingsContextPath(conversationFrame)
  const activeChatAttempts = useAttemptExecutionsForChat(chat.id, needsConversationPath)
  const activePathAttemptIds = useMemo(() => {
    const messageIds = currentAcceptedPath?.messageIds
    return activeChatAttempts
      .map((attempt) => attempt.messageId)
      .filter((messageId): messageId is MessageId =>
        Boolean(messageId && messageIds?.has(messageId)),
      )
      .sort()
  }, [activeChatAttempts, currentAcceptedPath?.messageIds])
  const streamActivityKey = activePathAttemptIds.join('|')
  const acceptedPath = useStreamStableBranchPath(currentAcceptedPath, streamActivityKey.length > 0)
  const acceptedPathHeaders = useMemo(
    () => acceptedPath?.materializeNodes() ?? EMPTY_MESSAGE_HEADERS,
    [acceptedPath],
  )
  const acceptedPathMessageIds = useMemo(() => {
    if (activePathAttemptIds.length === 0) {
      return acceptedPathHeaders.map((header) => header.id)
    }
    const excluded = new Set(activePathAttemptIds)
    return acceptedPathHeaders.flatMap((header) => (excluded.has(header.id) ? [] : [header.id]))
  }, [acceptedPathHeaders, activePathAttemptIds])
  const apiModeContextFacts = useMemo(() => {
    if (!acceptedPath) return EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS
    const includedIds = new Set(acceptedPathMessageIds)
    return mergeMessageContextRouteFacts(
      acceptedPathHeaders.flatMap((header) =>
        includedIds.has(header.id) && !header.deleted && header.hiddenFromContext !== true
          ? [header.contextRouteFacts]
          : [],
      ),
    )
  }, [acceptedPath, acceptedPathHeaders, acceptedPathMessageIds])
  const effectiveRouting = useMemo(() => {
    if (capabilityPresentation.retained) return capabilityPresentation.effectiveRouting
    return profile && routing.effectiveRouting
      ? rebaseEffectiveEndpointRouting(routing.effectiveRouting, apiModeContextFacts)
      : null
  }, [
    apiModeContextFacts,
    profile,
    routing.effectiveRouting,
    capabilityPresentation.effectiveRouting,
    capabilityPresentation.retained,
  ])
  const assistantRouting = effectiveRouting?.route ?? null
  const prefillPlan = effectiveRouting?.prefillPlan ?? PREFILL_UNAVAILABLE_PLAN
  const acceptedPathAttachmentIds = useMemo(() => {
    const includedIds = new Set(acceptedPathMessageIds)
    return attachmentContextIds({
      messages: acceptedPathHeaders
        .filter((header) => includedIds.has(header.id))
        .map((header) => ({ ...header, content: [] })),
      policy: attachmentContextPolicyForSettings(chat.settings),
    })
  }, [acceptedPathHeaders, acceptedPathMessageIds, chat.settings])
  const acceptedPathQueryId = useMemo(
    () =>
      settingsContextPathQueryIdentity(
        acceptedPath !== null,
        acceptedPathMessageIds,
        acceptedPathAttachmentIds,
      ),
    [acceptedPath, acceptedPathAttachmentIds, acceptedPathMessageIds],
  )
  const activeSendContextTarget = useMemo(
    () =>
      canEstimatePrompt && acceptedPath && calibrationEvidence && assistantRouting
        ? {
            key: JSON.stringify([
              chat.id,
              chat.metaVersion,
              chat.settings,
              acceptedPathQueryId,
              capability,
              assistantRouting,
              calibrationQueryIdentity,
            ]),
            chat,
            branchHeaders: acceptedPathHeaders,
            excludedMessageIds: activePathAttemptIds,
            attachmentIds: acceptedPathAttachmentIds,
            capabilities: capability,
            routing: assistantRouting,
            calibrationEvidence,
          }
        : null,
    [
      acceptedPath,
      acceptedPathAttachmentIds,
      acceptedPathHeaders,
      acceptedPathQueryId,
      activePathAttemptIds,
      canEstimatePrompt,
      calibrationEvidence,
      calibrationQueryIdentity,
      capability,
      assistantRouting,
      chat,
    ],
  )
  const activeSendContext = usePromptEstimateContext(activeSendContextTarget)
  const activePathMessages = canEstimatePrompt
    ? (activeSendContext?.pathMessages ?? EMPTY_MESSAGES)
    : EMPTY_MESSAGES
  const attachmentResolver = useAttachmentResolverForContext({
    settings: chat.settings,
    messages: activePathMessages,
    baseAttachments: activeSendContext?.attachmentTokenEvidence,
    enabled: canEstimatePrompt,
  })
  const promptEstimateInput = useMemo<PromptSizeEstimateInput | null>(() => {
    if (!canEstimatePrompt || !acceptedPath || !activeSendContext) return null
    return buildSettingsPromptSizeEstimateInput(
      chat.settings,
      activePathMessages,
      '',
      endpointTokenizer,
      capability.maxPromptTokens ?? capability.contextLength ?? null,
      attachmentResolver,
      {
        chatTokenCalibration: chat.tokenCalibration,
        globalCalibration: activeSendContext.calibrationEvidence.global,
        mode: activeSendContext.calibrationEvidence.mode,
      },
      undefined,
      activeSendContext.preCutAttachmentIds,
      assistantRouting ?? undefined,
      {
        contextAlreadySelected: true,
        reasoningResolver: activeSendContext.reasoningResolver,
      },
    )
  }, [
    chat,
    canEstimatePrompt,
    acceptedPath,
    activePathMessages,
    endpointTokenizer,
    capability,
    attachmentResolver,
    activeSendContext,
    assistantRouting,
  ])
  const promptEstimate = useDeferredStreamStablePromptEstimate(
    chat.id,
    promptEstimateInput,
    streamActivityKey,
  )
  const providerNeededTokens = useMemo(() => {
    if (!promptEstimate) return null
    const reserveRaw = chat.settings.maxCompletionTokens
    const reserve = reserveRaw === UNLIMITED_CONTEXT ? 0 : (reserveRaw ?? 0)
    return promptEstimate.total + reserve
  }, [chat, promptEstimate])

  const handleModelPick = useCallback(
    async (modelId: string) => {
      if (chat.settings.model === modelId) return
      try {
        await configurationApplication.patchChatSettings(chat.id, { model: modelId })
      } catch (error) {
        console.error('Failed to select model', error)
        pushToast({ level: 'danger', text: 'Could not select that model. Try again.' })
      }
    },
    [chat, pushToast],
  )

  const handleModelPickForPreset = useCallback(
    async (modelId: string) => {
      if (!chat.presetId) return
      if (!preset || preset.id !== chat.presetId) return
      await configurationApplication.saveChatPreset({
        presetId: preset.id,
        settings: {
          ...preset.settings,
          model: modelId,
          profileId: preset.connectionProfileId,
        },
        chatModel: { chatId: chat.id, modelId },
      })
    },
    [chat, preset],
  )

  const textTemplateMode =
    presentationIsOpenRouter &&
    presentationChat.settings.api === 'text' &&
    isTextCompletionsSelectableFor(presentationChat.settings.model)
      ? 'openrouter'
      : presentationProfile?.kind === 'llama-server' &&
          (presentationChat.settings.protocol ?? 'chat') === 'text'
        ? 'llama-server'
        : null

  // Two distinct "no usable model" states, one banner either way:
  // 1. The chat has a model but the current connection doesn't serve it
  //    (e.g., gemma on an OpenRouter connection). Shows what's wrong.
  // 2. The chat has no model at all (fresh chat, or just cleared on
  //    a connection switch). Shows a generic prompt.
  // When `modelAvailable === null` /models is still loading and the
  // banner is suppressed to avoid flicker.
  const profileModelMismatch =
    !!modelPresentationProfile &&
    !!modelPresentationChat.settings.model &&
    modelLooksForeignForProfile(modelPresentationProfile.kind, modelPresentationChat.settings.model)
  const noModel =
    !modelPresentationChat.settings.model ||
    profileModelMismatch ||
    (modelPresentationProfile?.kind === 'llama-server' && modelAvailable === false)
  const unavailableModel =
    modelAvailable === false &&
    !profileModelMismatch &&
    modelPresentationProfile?.kind !== 'llama-server'
      ? modelPresentationChat.settings.model
      : null

  return (
    <aside data-ui="chat-model-panel" aria-label="Chat settings">
      <PanelHeader onClose={onClose} title="Chat settings" />
      <PresetBreadcrumb chat={chat} preset={preset} />
      <div role="tablist" data-ui="settings-tabs" data-ui-panel-tabs>
        {(
          [
            ['model', 'Model'],
            ['context', 'Context'],
            ['prompts', 'Prompts'],
            ['generation', 'Generation'],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            type="button"
            role="tab"
            data-ui="settings-tab"
            data-tab={value}
            aria-selected={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {unavailableModel ? (
        <div data-ui="notice-banner" role="status" data-tone="warning">
          <span>
            <strong>{unavailableModel}</strong> isn't served on{' '}
            <em>{modelPresentationProfile?.name ?? 'this connection'}</em>. Pick a different model
            below.
          </span>
        </div>
      ) : noModel ? (
        <div data-ui="notice-banner" role="status" data-tone="info">
          <span>
            Pick a model for <em>{modelPresentationProfile?.name ?? 'this connection'}</em>.
          </span>
        </div>
      ) : null}
      <div role="tabpanel" data-ui="settings-panel" data-active-tab={tab}>
        {tab === 'model' ? (
          <>
            <div
              data-model-presentation={
                modelCatalog.models.presentation.retained ? 'retained' : 'current'
              }
              inert={modelCatalog.models.presentation.retained ? true : undefined}
            >
              <ModelPicker
                chat={modelPresentationChat}
                modelsResult={modelCatalog.models}
                onPick={handleModelPick}
                onPickForPreset={handleModelPickForPreset}
              />
            </div>
            <div
              data-ui="model-routing-dependent"
              data-routing-presentation={capabilityPresentation.retained ? 'retained' : 'current'}
              aria-busy={routing.loading}
              inert={capabilityPresentation.retained ? true : undefined}
            >
              {capability ? (
                <ApiModeSection
                  chat={presentationChat}
                  capability={capability}
                  profile={presentationProfile}
                  routing={assistantRouting}
                />
              ) : null}
            </div>
            {profile && isOpenAiDirectProfile(profile) ? (
              <OpenAiResponsesStoreSection chat={chat} />
            ) : null}
            {privacyPresentationIsOpenRouter ? (
              <ProviderPicker chat={chat} routing={routing} neededTokens={providerNeededTokens} />
            ) : null}
            {presentationProfile?.kind === 'llama-server' ? (
              <LlamaServerSection chat={presentationChat} profile={presentationProfile} />
            ) : null}
          </>
        ) : null}
        {tab === 'context' ? (
          <div
            data-ui="context-routing-dependent"
            data-routing-presentation={capabilityPresentation.retained ? 'retained' : 'current'}
            aria-busy={routing.loading || capabilityPresentation.retained}
            inert={capabilityPresentation.retained ? true : undefined}
          >
            <ContextTab
              chat={presentationChat}
              capability={capability}
              promptEstimate={promptEstimate}
              isOpenRouter={presentationIsOpenRouter}
              connectionKind={presentationProfile?.kind ?? 'custom'}
            />
          </div>
        ) : null}
        {tab === 'prompts' ? (
          <div
            data-routing-presentation={capabilityPresentation.retained ? 'retained' : 'current'}
            inert={promptPresentationOnly ? true : undefined}
          >
            <PromptsTab
              chat={chat}
              {...(presentationProfile ? { profile: presentationProfile } : {})}
              prefillPlan={prefillPlan}
            />
          </div>
        ) : null}
        {tab === 'generation' ? (
          <div
            data-routing-presentation={capabilityPresentation.retained ? 'retained' : 'current'}
            inert={capabilityPresentation.retained ? true : undefined}
          >
            <ParamForm
              chat={presentationChat}
              capability={capability}
              assistantRouteKind={assistantRouting?.kind}
              textTemplateMode={textTemplateMode}
              llamaProps={llamaProps}
              connectionKind={presentationProfile?.kind ?? 'custom'}
              connectionProfile={presentationProfile}
              textCompletionsActive={textTemplateMode !== null}
            />
          </div>
        ) : null}
      </div>
    </aside>
  )
}

function OpenAiResponsesStoreSection({ chat }: { chat: Chat }) {
  const { run: runConfigurationWrite } = usePresentationInteraction(configurationWriteInteraction, {
    observePending: false,
  })
  const responses = chat.settings.responses ?? { store: false }
  return (
    <section data-ui="settings-section" data-ui-section="openai-responses-store">
      <label data-ui="reasoning-checkbox">
        <input
          type="checkbox"
          checked={responses.store}
          onChange={(event) =>
            runConfigurationWrite({
              target: configurationWriteTarget(chat.id, 'responses.store'),
              action: () =>
                configurationApplication.patchChatSettingsFields(chat.id, [
                  { path: ['responses', 'store'], value: event.target.checked },
                ]),
            })
          }
        />
        <span>
          Pass <code>store: true</code> upstream
        </span>
        <InfoDisclosure title="OpenAI may retain the response for 30 days. Required for previous_response_id flows; disabled by default so this chat stays stateless unless you opt in." />
      </label>
    </section>
  )
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <header data-ui="settings-pane-header">
      <span data-ui="settings-pane-title">{title}</span>
      <IconButton
        type="button"
        data-ui="icon-button"
        data-role="settings-pane-close"
        onClick={onClose}
        aria-label="Close settings pane"
      >
        <CloseIcon size={16} />
      </IconButton>
    </header>
  )
}

// Preset control: shows the current preset + picker menu for load / save /
// rename / delete / new. Chat settings diverge freely; the preset is the
// shared snapshot the user can write back to or swap from.
interface PresetDragState {
  draggedId: PresetId
  targetPrecedingId: PresetId | null | undefined
  originPrecedingId: PresetId | null | undefined
  commandCommitted: boolean
  settleAfterSnapshotRevision?: number
  pointerId?: number
  status: 'dragging' | 'settling'
}

const createPresetInteractionCapability = definePresentationInteraction<string>({
  id: 'chat-preset.create',
  label: 'Create preset',
  concurrency: 'reject',
  lifetime: 'workspace-tab',
})

function PresetBreadcrumb({ chat, preset }: { chat: Chat; preset: ChatPreset | undefined }) {
  const pushToast = useToastStore((s) => s.push)
  const createPresetInteraction = usePresentationInteraction(createPresetInteractionCapability)
  const runCreatePreset = createPresetInteraction.run
  const [dragState, setDragState] = useState<PresetDragState | null>(null)
  const dragStateRef = useRef<PresetDragState | null>(null)
  const presetItemRefs = useRef(new Map<PresetId, HTMLLIElement>())
  const presetListRef = useRef<HTMLUListElement | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const addressedPresetIds = useMemo(() => {
    const ids = [preset?.id, dragState?.draggedId].filter((id): id is PresetId => id !== undefined)
    return [...new Set(ids)]
  }, [dragState?.draggedId, preset?.id])
  const presetCatalogResult = useChatPresetCatalog(pickerOpen, addressedPresetIds)
  const presetCatalog = presetCatalogResult.snapshot
  const presets = presetCatalog?.page.rows ?? EMPTY_PRESET_CATALOG_ROWS
  const presetCatalogInteractive =
    presetCatalog?.interactive === true && presetCatalog.status === 'ready'
  const draggedPreset =
    dragState === null
      ? null
      : (presets.find((candidate) => candidate.id === dragState.draggedId) ??
        presetCatalog?.page.addressedRows.find((candidate) => candidate.id === dragState.draggedId)
          ?.row ??
        null)
  const visiblePresets = useMemo(
    () => orderPresetsForDragPreview(presets, draggedPreset, dragState),
    [dragState, draggedPreset, presets],
  )
  const importInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    dragStateRef.current = dragState
  }, [dragState])

  useEffect(() => {
    if (dragState?.status !== 'settling') return
    if (!dragState.commandCommitted) return
    if (!presetCatalogInteractive) return
    if (presetCatalog.revision <= (dragState.settleAfterSnapshotRevision ?? 0)) return
    dragStateRef.current = null
    setDragState(null)
  }, [dragState, presetCatalog?.revision, presetCatalogInteractive])

  const diverged = useMemo(() => {
    if (!preset) return true
    return !settingsMatch(chat.settings, preset.settings)
  }, [chat.settings, preset])

  const closePicker = useCallback(() => setPickerOpen(false), [])

  const loadPreset = useCallback(
    async (targetId: string) => {
      const intent = configurationController.claimIntent()
      closePicker()
      await configurationApplication.applyChatPreset(chat.id, targetId, undefined, () =>
        configurationController.intentIsCurrent(intent),
      )
    },
    [chat.id, closePicker],
  )

  const saveToExisting = useCallback(
    async (targetId: string) => {
      const target = presets.find((candidate) => candidate.id === targetId)
      if (!target) return
      await configurationApplication.saveChatPreset({
        presetId: target.id,
        settings: { ...chat.settings, profileId: target.connectionProfileId },
      })
      pushToast({
        level: 'info',
        text: `Saved settings to "${target.name}".`,
        durationMs: 2500,
      })
      closePicker()
    },
    [chat.settings, presets, pushToast, closePicker],
  )

  const saveAsNew = useCallback(() => {
    runCreatePreset({
      target: chat.id,
      action: async () => {
        const name = await requestPresentationText({
          title: 'New preset',
          inputLabel: 'Preset name',
          confirmLabel: 'Save',
        })
        if (!name?.trim()) return null
        return configurationApplication.createAndLinkChatPreset({
          chatId: chat.id,
          name: name.trim(),
          profileId: chat.settings.profileId,
          settings: { ...chat.settings },
        })
      },
      commit: (result) => {
        if (result?.kind !== 'chat-preset-saved') return
        const preset = result.preset
        pushToast({ level: 'info', text: `Created preset "${preset.name}".`, durationMs: 2500 })
        closePicker()
      },
    })
  }, [chat.id, chat.settings, pushToast, closePicker, runCreatePreset])

  const exportPresetJson = useCallback(
    async (targetId: string, name: string) => {
      try {
        const envelope = await interchangeApplication.exportChatPreset(targetId)
        triggerJsonDownload(natterJsonFilename('chat-preset', name, targetId), envelope)
        pushToast({ level: 'success', text: 'Exported preset JSON.', durationMs: 2500 })
      } catch (error) {
        console.error('Failed to export preset JSON', error)
        pushToast({ level: 'danger', text: importExportErrorMessage(error) })
      }
    },
    [pushToast],
  )

  const importPresetJson = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget
      const file = input.files?.[0] ?? null
      input.value = ''
      if (!file) return
      try {
        const value = await readJsonFile(file)
        const result = await interchangeApplication.importChatPreset(value)
        pushToast({
          level: 'success',
          text: result.profileMatched
            ? 'Imported preset.'
            : 'Imported preset with a missing connection.',
          durationMs: 3000,
        })
        closePicker()
      } catch (error) {
        console.error('Failed to import preset JSON', error)
        pushToast({ level: 'danger', text: importExportErrorMessage(error) })
      }
    },
    [closePicker, pushToast],
  )

  const renamePreset = useCallback(async (targetId: string, currentName: string) => {
    const name = await requestPresentationText({
      title: 'Rename preset',
      inputLabel: 'Preset name',
      initialValue: currentName,
      confirmLabel: 'Rename',
    })
    if (!name?.trim() || name === currentName) return
    await configurationApplication.renameChatPreset(targetId, name.trim())
  }, [])

  const deletePresetWithConfirm = useCallback(async (targetId: string, name: string) => {
    if (
      !(await requestPresentationConfirmation({
        title: 'Delete preset?',
        message: `Delete preset "${name}"? Chats stay; their preset link will clear.`,
        confirmLabel: 'Delete',
        tone: 'danger',
      }))
    ) {
      return
    }
    await configurationApplication.deleteChatPreset(targetId)
  }, [])

  const beginPresetDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>, presetId: PresetId) => {
      if (event.button !== 0 || !presetCatalogInteractive) return
      event.preventDefault()
      const captureTarget: Partial<Pick<HTMLButtonElement, 'setPointerCapture'>> =
        event.currentTarget
      captureTarget.setPointerCapture?.(event.pointerId)
      const originIndex = presets.findIndex((candidate) => candidate.id === presetId)
      const originPrecedingId =
        originIndex > 0
          ? presets[originIndex - 1]?.id
          : presetCatalog.page.atStart === true
            ? null
            : undefined
      const nextState: PresetDragState = {
        draggedId: presetId,
        targetPrecedingId: originPrecedingId,
        originPrecedingId,
        commandCommitted: false,
        pointerId: event.pointerId,
        status: 'dragging',
      }
      dragStateRef.current = nextState
      setDragState(nextState)
    },
    [presetCatalog?.page.atStart, presetCatalogInteractive, presets],
  )

  const updatePresetDragPosition = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const current = dragStateRef.current
      if (current?.status !== 'dragging' || current.pointerId !== event.pointerId) return
      event.preventDefault()
      const listRect = presetListRef.current?.getBoundingClientRect()
      if (listRect && event.clientY <= listRect.top + 28 && presetCatalog?.page.previousCursor) {
        const firstId = visiblePresets.find((candidate) => candidate.id !== current.draggedId)?.id
        if (firstId !== undefined && current.targetPrecedingId !== firstId) {
          const nextState = { ...current, targetPrecedingId: firstId }
          dragStateRef.current = nextState
          setDragState(nextState)
        }
        presetCatalogResult.demandBefore()
        return
      }
      if (listRect && event.clientY >= listRect.bottom - 28 && presetCatalog?.page.nextCursor) {
        let lastId: PresetId | undefined
        for (let index = visiblePresets.length - 1; index >= 0; index -= 1) {
          const candidate = visiblePresets[index]
          if (candidate && candidate.id !== current.draggedId) {
            lastId = candidate.id
            break
          }
        }
        if (lastId !== undefined && current.targetPrecedingId !== lastId) {
          const nextState = { ...current, targetPrecedingId: lastId }
          dragStateRef.current = nextState
          setDragState(nextState)
        }
        presetCatalogResult.demandAfter()
        return
      }
      const targetPrecedingId = precedingPresetIdForPointer(
        visiblePresets.map((candidate) => candidate.id),
        current.draggedId,
        event.clientY,
        presetItemRefs.current,
        presetCatalog?.page.atStart === true,
      )
      if (targetPrecedingId === undefined || targetPrecedingId === current.targetPrecedingId) {
        return
      }
      const nextState = { ...current, targetPrecedingId }
      dragStateRef.current = nextState
      setDragState(nextState)
    },
    [
      presetCatalog?.page.nextCursor,
      presetCatalog?.page.previousCursor,
      presetCatalog?.page.atStart,
      presetCatalogResult,
      visiblePresets,
    ],
  )

  const commitPresetDrag = useCallback(async () => {
    const current = dragStateRef.current
    if (current?.status !== 'dragging') return
    if (
      current.targetPrecedingId === undefined ||
      current.targetPrecedingId === current.originPrecedingId
    ) {
      dragStateRef.current = null
      setDragState(null)
      return
    }
    const settlingState: PresetDragState = {
      ...current,
      commandCommitted: false,
      status: 'settling',
    }
    dragStateRef.current = settlingState
    setDragState(settlingState)
    try {
      await configurationApplication.moveChatPreset(current.draggedId, current.targetPrecedingId)
      const committedState: PresetDragState = {
        ...settlingState,
        commandCommitted: true,
        settleAfterSnapshotRevision: presetCatalogResult.refresh(),
      }
      dragStateRef.current = committedState
      setDragState(committedState)
    } catch (error) {
      dragStateRef.current = null
      setDragState(null)
      console.error('Failed to reorder presets', error)
      pushToast({ level: 'danger', text: 'Could not save preset order.' })
    }
  }, [presetCatalogResult, pushToast])

  const endPresetDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const current = dragStateRef.current
      event.preventDefault()
      if (current?.pointerId !== event.pointerId) return
      const captureTarget: Partial<Pick<HTMLButtonElement, 'releasePointerCapture'>> =
        event.currentTarget
      captureTarget.releasePointerCapture?.(event.pointerId)
      void commitPresetDrag()
    },
    [commitPresetDrag],
  )

  return (
    <div data-ui="preset-breadcrumb">
      <Button
        type="button"
        data-ui="preset-breadcrumb-button"
        aria-expanded={pickerOpen}
        onClick={() => setPickerOpen((v) => !v)}
      >
        <span>
          Preset: <strong>{preset ? preset.name : 'none'}</strong>
          {diverged ? <span data-ui="preset-diverged"> · edited</span> : null}
        </span>
        <span data-ui="preset-breadcrumb-chevron" aria-hidden="true">
          ▾
        </span>
      </Button>
      {pickerOpen ? (
        <div data-ui="preset-breadcrumb-menu" role="menu">
          {presets.length === 0 ? (
            <p data-ui="helper">
              {presetCatalog?.interactive === true ? 'No presets yet.' : 'Loading presets…'}
            </p>
          ) : (
            <ul ref={presetListRef}>
              {presetCatalog?.page.previousCursor ? (
                <li data-ui="configuration-catalog-boundary">
                  <Button
                    type="button"
                    data-ui="field-inline-action"
                    disabled={!presetCatalogInteractive}
                    onClick={presetCatalogResult.demandBefore}
                  >
                    Earlier presets…
                  </Button>
                </li>
              ) : null}
              {visiblePresets.map((p) => {
                const isCurrent = preset?.id === p.id
                const isDragging = dragState?.draggedId === p.id
                return (
                  <li
                    key={p.id}
                    ref={(node) => {
                      if (node) presetItemRefs.current.set(p.id, node)
                      else presetItemRefs.current.delete(p.id)
                    }}
                    data-ui="preset-menu-item"
                    data-preset-id={p.id}
                    data-current={isCurrent ? 'true' : undefined}
                    data-dragging={isDragging ? 'true' : undefined}
                    data-settling={
                      dragState?.status === 'settling' && dragState.draggedId === p.id
                        ? 'true'
                        : undefined
                    }
                  >
                    <IconButton
                      type="button"
                      data-ui="preset-drag-handle"
                      aria-label={`Drag preset "${p.name}" to reorder`}
                      title={presetCatalogInteractive ? 'Drag to reorder' : 'Loading presets…'}
                      disabled={!presetCatalogInteractive && !isDragging}
                      onClick={(event) => event.preventDefault()}
                      onPointerDown={(event) => beginPresetDrag(event, p.id)}
                      onPointerMove={updatePresetDragPosition}
                      onPointerUp={endPresetDrag}
                      onPointerCancel={endPresetDrag}
                    >
                      <GripVerticalIcon size={14} />
                    </IconButton>
                    <Button
                      type="button"
                      data-ui="preset-menu-load"
                      onClick={() => void loadPreset(p.id)}
                      title={isCurrent ? 'Already loaded' : 'Load preset'}
                    >
                      {p.name}
                    </Button>
                    <div data-ui="preset-menu-actions">
                      <Button
                        type="button"
                        data-ui="field-inline-action"
                        onClick={() => void saveToExisting(p.id)}
                        title={
                          isCurrent
                            ? 'Save current settings to this preset'
                            : `Overwrite "${p.name}" with current settings`
                        }
                      >
                        save
                      </Button>
                      <Button
                        type="button"
                        data-ui="field-inline-action"
                        onClick={() => void renamePreset(p.id, p.name)}
                        title="Rename"
                      >
                        rename
                      </Button>
                      <IconButton
                        type="button"
                        data-ui="icon-button"
                        data-compact
                        data-tone="danger"
                        onClick={() => void deletePresetWithConfirm(p.id, p.name)}
                        title="Delete preset"
                        aria-label="Delete preset"
                      >
                        <TrashIcon />
                      </IconButton>
                      <IconButton
                        type="button"
                        data-ui="icon-button"
                        data-compact
                        data-tone="accent"
                        data-role="preset-export"
                        onClick={() => void exportPresetJson(p.id, p.name)}
                        title="Export preset JSON"
                        aria-label={`Export preset "${p.name}" JSON`}
                      >
                        <DownloadIcon size={13} />
                      </IconButton>
                    </div>
                  </li>
                )
              })}
              {presetCatalog?.page.nextCursor ? (
                <li data-ui="configuration-catalog-boundary">
                  <Button
                    type="button"
                    data-ui="field-inline-action"
                    disabled={!presetCatalogInteractive}
                    onClick={presetCatalogResult.demandAfter}
                  >
                    More presets…
                  </Button>
                </li>
              ) : null}
            </ul>
          )}
          <div data-ui="preset-menu-footer">
            <span data-ui="preset-menu-footer-primary">
              <Button
                type="button"
                data-ui="field-inline-action"
                disabled={createPresetInteraction.isPending(chat.id)}
                onClick={saveAsNew}
              >
                + Save as new…
              </Button>
              <input
                ref={importInputRef}
                data-ui="preset-import-input"
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(event) => void importPresetJson(event)}
              />
              <IconButton
                type="button"
                data-ui="icon-button"
                data-compact
                data-tone="accent"
                onClick={() => importInputRef.current?.click()}
                aria-label="Import preset JSON"
                title="Import preset JSON"
              >
                <UploadIcon size={13} />
              </IconButton>
            </span>
            <IconButton
              type="button"
              data-ui="icon-button"
              data-compact
              onClick={closePicker}
              aria-label="Close"
              title="Close"
            >
              <CloseGlyph />
            </IconButton>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="13" height="13">
      <path
        d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.5a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.5M6.8 7v4M9.2 7v4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="13" height="13">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function orderPresetsForDragPreview(
  presets: readonly ConfigurationPresetCatalogRow[],
  draggedPreset: ConfigurationPresetCatalogRow | null,
  dragState: PresetDragState | null,
): ConfigurationPresetCatalogRow[] {
  if (!dragState || !draggedPreset || dragState.targetPrecedingId === undefined) {
    return [...presets]
  }
  const withoutDragged = presets.filter((preset) => preset.id !== dragState.draggedId)
  if (dragState.targetPrecedingId === null) return [draggedPreset, ...withoutDragged]
  const precedingIndex = withoutDragged.findIndex(
    (preset) => preset.id === dragState.targetPrecedingId,
  )
  if (precedingIndex < 0) return [...presets]
  return [
    ...withoutDragged.slice(0, precedingIndex + 1),
    draggedPreset,
    ...withoutDragged.slice(precedingIndex + 1),
  ]
}

function precedingPresetIdForPointer(
  visibleIds: readonly PresetId[],
  draggedId: PresetId,
  clientY: number,
  itemRefs: ReadonlyMap<PresetId, HTMLLIElement>,
  atStart: boolean,
): PresetId | null | undefined {
  const withoutDragged = visibleIds.filter((id) => id !== draggedId)
  let insertAt = withoutDragged.length
  for (const [index, id] of withoutDragged.entries()) {
    const node = itemRefs.get(id)
    if (!node) continue
    const rect = node.getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) {
      insertAt = index
      break
    }
  }
  if (insertAt === 0) return atStart ? null : undefined
  return withoutDragged[insertAt - 1]
}

function settingsMatch(a: Chat['settings'], b: Chat['settings']): boolean {
  // A ChatPreset is a full ChatSettings snapshot, including provider buckets
  // that may be hidden for the current connection. The edited marker must use
  // that same whole-settings contract, not a visible-controls subset.
  return stableSettingsString(a) === stableSettingsString(b)
}

function stableSettingsString(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value))
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (child !== undefined) out[key] = sortObjectKeys(child)
  }
  return out
}

// The Context tab bundles three related controls: the running token gauge,
// the max-context / truncation knobs, and caching (which lives here because
// caching is a context-management concern — deciding which prefix to cache
// and for how long). Caching is hidden entirely when the model uses implicit
// caching or doesn't support caching at all; it only appears when there's
// something for the user to configure.
function ContextTab({
  chat,
  capability,
  promptEstimate,
  isOpenRouter,
  connectionKind,
}: {
  chat: Chat
  capability: EffectiveCapability | null
  promptEstimate: PromptSizeEstimate | null
  isOpenRouter: boolean
  connectionKind: ConnectionKind
}) {
  return (
    <>
      <ContextPanel
        chat={chat}
        capability={capability}
        estimateOverride={promptEstimate}
        showMiddleOut={isOpenRouter}
      />
      {chat.settings.model ? (
        <ReasoningIncludeControls chat={chat} capability={capability} />
      ) : null}
      <CachingPanel chat={chat} capability={capability} connectionKind={connectionKind} />
    </>
  )
}
