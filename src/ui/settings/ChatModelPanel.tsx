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
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type LlamaServerProps, probeLlamaServer } from '../../api/probe'
import type { EffectiveCapability } from '../../core/capabilities'
import { DEFAULT_GLOBAL_PREFERENCES, readGlobalPreferences } from '../../core/global-settings'
import { modelLooksForeignForProfile } from '../../core/model-selection'
import {
  buildSettingsPromptSizeEstimateInput,
  type PromptSizeEstimate,
  type PromptSizeEstimateInput,
  UNLIMITED_CONTEXT,
} from '../../core/prompt-size'
import { isOpenAiDirectProfile } from '../../core/provider-hosted-tools'
import { isTextCompletionsSelectableFor } from '../../core/quirks'
import { readTokenCalibrationGlobal } from '../../core/token-calibration'
import type {
  Chat,
  ChatPreset,
  ConnectionKind,
  ConnectionProfile,
  Message,
  PresetId,
} from '../../core/types'
import { usePrivacyRouting } from '../../hooks/usePrivacyRouting'
import { useStreamStablePromptEstimate } from '../../hooks/useStreamStablePromptEstimate'
import { applyChatPreset, setChatPreset, updateChatSettings } from '../../store/chats'
import { exportChatPreset, importChatPreset } from '../../store/import-export'
import {
  createPreset,
  deletePreset,
  getPreset,
  listPresets,
  reorderPresets,
  updatePreset,
} from '../../store/presets'
import { getProfile } from '../../store/profiles'
import {
  allTable,
  chatMessageDependencies,
  GLOBAL_PREFERENCES_DEPENDENCIES,
  GLOBAL_TOKEN_CALIBRATION_DEPENDENCIES,
  primaryKeys,
} from '../../store/reactive-dependencies'
import { useRepositoryQuery } from '../../store/reactive-query'
import { loadActiveBranchHeaderSnapshot, loadSendContextForBranch } from '../../store/send-context'
import { useChatStore } from '../../store/zustand/chatStore'
import { useStreamStore } from '../../store/zustand/streamStore'
import { useToastStore } from '../../store/zustand/toastStore'
import { useAttachmentResolverForContext } from '../attachments/useAttachmentResolver'
import { CloseIcon, DownloadIcon, GripVerticalIcon, UploadIcon } from '../icons/Icon'
import {
  importExportErrorMessage,
  natterJsonFilename,
  readJsonFile,
  triggerJsonDownload,
} from '../import-export/json-file'
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
  onClose: () => void
}

type Tab = 'model' | 'context' | 'prompts' | 'generation'
const EMPTY_CURSOR = Object.freeze({}) as Readonly<Record<string, string>>
const EMPTY_MESSAGES: Message[] = []

export function ChatModelPanel({
  chatSnapshot,
  profileSnapshot = null,
  onClose,
}: ChatModelPanelProps) {
  const chat = chatSnapshot

  const snapshotProfile = profileSnapshot?.id === chat.settings.profileId ? profileSnapshot : null
  const liveProfile = useRepositoryQuery(
    JSON.stringify(['profile-fallback', chat.settings.profileId, snapshotProfile?.id]),
    () => (!snapshotProfile ? getProfile(chat.settings.profileId) : Promise.resolve(undefined)),
    undefined,
    primaryKeys('profiles', !snapshotProfile ? chat.settings.profileId : undefined),
  )
  const profileCacheRef = useRef(new Map<string, ConnectionProfile>())
  useEffect(() => {
    if (!liveProfile) return
    profileCacheRef.current.set(liveProfile.id, liveProfile)
  }, [liveProfile])
  const profile =
    snapshotProfile ??
    liveProfile ??
    (chat.settings.profileId ? profileCacheRef.current.get(chat.settings.profileId) : undefined)
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

  const livePreset = useRepositoryQuery(
    JSON.stringify(['preset', chat.presetId]),
    () => (chat.presetId ? getPreset(chat.presetId) : Promise.resolve(undefined)),
    undefined,
    primaryKeys('presets', chat.presetId),
  )
  const presetCacheRef = useRef(new Map<string, ChatPreset>())
  useEffect(() => {
    if (!livePreset) return
    presetCacheRef.current.set(livePreset.id, livePreset)
  }, [livePreset])
  const preset =
    livePreset ?? (chat.presetId ? presetCacheRef.current.get(chat.presetId) : undefined)
  const routing = usePrivacyRouting(chat)
  const { capability, descriptor, modelAvailable } = routing
  const endpointTokenizer = descriptor?.architecture?.tokenizer ?? null
  const [tab, setTab] = useState<Tab>('model')
  const needsPromptEstimate = tab === 'context'
  const canEstimatePrompt =
    needsPromptEstimate &&
    !!capability &&
    (capability.contextLength !== undefined ||
      capability.maxPromptTokens !== undefined ||
      capability.maxCompletionTokens !== undefined)
  const cursor = useChatStore((s) =>
    canEstimatePrompt ? (s.cursors[chat.id] ?? EMPTY_CURSOR) : EMPTY_CURSOR,
  )
  const activeSendContext = useRepositoryQuery(
    JSON.stringify([
      'active-send-context',
      chat.id,
      chat.metaVersion,
      chat.summaryVersion,
      canEstimatePrompt,
      cursor,
      capability,
    ]),
    async () => {
      if (!canEstimatePrompt) return null
      const branch = await loadActiveBranchHeaderSnapshot(chat.id, cursor)
      return loadSendContextForBranch({
        chat,
        branchHeaders: branch.branchHeaders,
        capabilities: capability,
      })
    },
    null,
    canEstimatePrompt
      ? [
          ...chatMessageDependencies(chat.id),
          ...GLOBAL_PREFERENCES_DEPENDENCIES,
          ...GLOBAL_TOKEN_CALIBRATION_DEPENDENCIES,
          ...allTable('attachments', 'attachmentArtifacts'),
        ]
      : [],
  )
  const prefs = useRepositoryQuery(
    `global-preferences:context:${canEstimatePrompt ? 'enabled' : 'disabled'}`,
    () =>
      canEstimatePrompt ? readGlobalPreferences() : Promise.resolve(DEFAULT_GLOBAL_PREFERENCES),
    DEFAULT_GLOBAL_PREFERENCES,
    canEstimatePrompt ? GLOBAL_PREFERENCES_DEPENDENCIES : [],
  )
  const globalCalibration = useRepositoryQuery(
    `token-calibration-global:${canEstimatePrompt ? 'enabled' : 'disabled'}`,
    () => (canEstimatePrompt ? readTokenCalibrationGlobal() : Promise.resolve(null)),
    null,
    canEstimatePrompt ? GLOBAL_TOKEN_CALIBRATION_DEPENDENCIES : [],
  )
  const streamActivityKey = useStreamStore((s) =>
    canEstimatePrompt
      ? Object.values(s.activeByStreamId)
          .filter((stream) => stream.chatId === chat.id)
          .map((stream) => (stream.messageId ? `m:${stream.messageId}` : `s:${stream.streamId}`))
          .sort()
          .join('|')
      : '',
  )
  const activePathMessages = canEstimatePrompt
    ? (activeSendContext?.pathMessages ?? EMPTY_MESSAGES)
    : EMPTY_MESSAGES
  const attachmentResolver = useAttachmentResolverForContext({
    settings: chat.settings,
    messages: activePathMessages,
    enabled: canEstimatePrompt,
  })
  const promptEstimateInput = useMemo<PromptSizeEstimateInput | null>(() => {
    if (!canEstimatePrompt) return null
    return buildSettingsPromptSizeEstimateInput(
      chat.settings,
      activePathMessages,
      '',
      endpointTokenizer,
      capability.maxPromptTokens ?? capability.contextLength ?? null,
      attachmentResolver,
      {
        chatTokenCalibration: chat.tokenCalibration,
        globalCalibration,
        mode: prefs.tokenCalibrationMode,
      },
      undefined,
      activeSendContext?.preCutAttachmentIds,
    )
  }, [
    chat,
    canEstimatePrompt,
    activePathMessages,
    endpointTokenizer,
    capability,
    attachmentResolver,
    globalCalibration,
    prefs,
    activeSendContext,
  ])
  const deferredPromptEstimateInput = useDeferredValue(promptEstimateInput)
  const promptEstimate = useStreamStablePromptEstimate(
    chat.id,
    deferredPromptEstimateInput,
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
      await updateChatSettings(chat.id, { model: modelId })
    },
    [chat],
  )

  const handleModelPickForPreset = useCallback(
    async (modelId: string) => {
      if (!chat.presetId) return
      const p = await getPreset(chat.presetId)
      if (!p) return
      await updatePreset(p.id, {
        settings: { ...p.settings, model: modelId, profileId: p.connectionProfileId },
      })
      await updateChatSettings(chat.id, { model: modelId })
    },
    [chat],
  )

  const isOpenRouter = profile?.kind === 'openrouter'
  const textTemplateMode =
    isOpenRouter &&
    chat.settings.api === 'text' &&
    isTextCompletionsSelectableFor(chat.settings.model)
      ? 'openrouter'
      : profile?.kind === 'llama-server' && (chat.settings.protocol ?? 'chat') === 'text'
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
    !!profile &&
    !!chat.settings.model &&
    modelLooksForeignForProfile(profile.kind, chat.settings.model)
  const noModel =
    !chat.settings.model ||
    profileModelMismatch ||
    (profile?.kind === 'llama-server' && modelAvailable === false)
  const unavailableModel =
    modelAvailable === false && !profileModelMismatch && profile?.kind !== 'llama-server'
      ? chat.settings.model
      : null

  return (
    <aside data-ui="chat-model-panel" aria-label="Chat settings">
      <PanelHeader onClose={onClose} title="Chat settings" />
      <PresetBreadcrumb chat={chat} preset={preset ?? undefined} />
      {unavailableModel ? (
        <div data-ui="notice-banner" role="status" data-tone="warning">
          <span>
            <strong>{unavailableModel}</strong> isn't served on{' '}
            <em>{profile?.name ?? 'this connection'}</em>. Pick a different model below.
          </span>
        </div>
      ) : noModel ? (
        <div data-ui="notice-banner" role="status" data-tone="info">
          <span>
            Pick a model for <em>{profile?.name ?? 'this connection'}</em>.
          </span>
        </div>
      ) : null}
      <div role="tablist" data-ui="settings-tabs" data-ui-panel-tabs>
        {(
          [
            ['model', 'Model'],
            ['context', 'Context'],
            ['prompts', 'Prompts'],
            ['generation', 'Generation'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            data-ui="settings-tab"
            data-tab={value}
            aria-selected={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" data-ui="settings-panel" data-active-tab={tab}>
        {tab === 'model' ? (
          <>
            <ModelPicker
              chat={chat}
              profileKind={profile?.kind ?? 'custom'}
              onPick={handleModelPick}
              onPickForPreset={handleModelPickForPreset}
            />
            {capability ? (
              <ApiModeSection
                chat={chat}
                capability={capability}
                profile={profile ?? null}
                activePathMessages={activePathMessages}
              />
            ) : null}
            {profile && isOpenAiDirectProfile(profile) ? (
              <OpenAiResponsesStoreSection chat={chat} />
            ) : null}
            {isOpenRouter ? (
              <ProviderPicker chat={chat} routing={routing} neededTokens={providerNeededTokens} />
            ) : null}
            {profile?.kind === 'llama-server' ? (
              <LlamaServerSection chat={chat} profile={profile} />
            ) : null}
          </>
        ) : null}
        {tab === 'context' ? (
          <ContextTab
            chat={chat}
            capability={capability}
            endpointTokenizer={endpointTokenizer}
            promptEstimate={promptEstimate}
            isOpenRouter={isOpenRouter}
            connectionKind={profile?.kind ?? 'custom'}
          />
        ) : null}
        {tab === 'prompts' ? (
          <PromptsTab chat={chat} prefillRecommendationEndpoints={routing.endpoints} />
        ) : null}
        {tab === 'generation' ? (
          <ParamForm
            chat={chat}
            capability={capability}
            endpointTokenizer={endpointTokenizer}
            textTemplateMode={textTemplateMode}
            llamaProps={llamaProps}
            connectionKind={profile?.kind ?? 'custom'}
            connectionProfile={profile}
            textCompletionsActive={textTemplateMode !== null}
          />
        ) : null}
      </div>
    </aside>
  )
}

function OpenAiResponsesStoreSection({ chat }: { chat: Chat }) {
  const responses = chat.settings.responses ?? { store: false }
  return (
    <section data-ui="settings-section" data-ui-section="openai-responses-store">
      <label data-ui="reasoning-checkbox">
        <input
          type="checkbox"
          checked={responses.store}
          onChange={(event) =>
            void updateChatSettings(chat.id, {
              responses: { ...responses, store: event.target.checked },
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
      <button
        type="button"
        data-ui="icon-button"
        data-role="settings-pane-close"
        onClick={onClose}
        aria-label="Close settings pane"
      >
        <CloseIcon size={16} />
      </button>
    </header>
  )
}

// Preset control: shows the current preset + picker menu for load / save /
// rename / delete / new. Chat settings diverge freely; the preset is the
// shared snapshot the user can write back to or swap from.
interface PresetDragState {
  draggedId: PresetId | null
  orderedIds: PresetId[]
  pointerId?: number
  status: 'dragging' | 'settling'
}

function PresetBreadcrumb({ chat, preset }: { chat: Chat; preset: ChatPreset | undefined }) {
  const pushToast = useToastStore((s) => s.push)
  const presets = useRepositoryQuery('presets:all', () => listPresets(), [], allTable('presets'))
  const [dragState, setDragState] = useState<PresetDragState | null>(null)
  const dragStateRef = useRef<PresetDragState | null>(null)
  const presetItemRefs = useRef(new Map<PresetId, HTMLLIElement>())
  const [pickerOpen, setPickerOpen] = useState(false)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const visiblePresets = useMemo(
    () => orderPresetsForDragPreview(presets, dragState?.orderedIds),
    [presets, dragState?.orderedIds],
  )

  useEffect(() => {
    dragStateRef.current = dragState
  }, [dragState])

  useEffect(() => {
    if (dragState?.status !== 'settling') return
    if (
      !sameOrderedIds(
        dragState.orderedIds,
        presets.map((p) => p.id),
      )
    )
      return
    dragStateRef.current = null
    setDragState(null)
  }, [dragState, presets])

  const diverged = useMemo(() => {
    if (!preset) return true
    return !settingsMatch(chat.settings, preset.settings)
  }, [chat.settings, preset])

  const closePicker = useCallback(() => setPickerOpen(false), [])

  const loadPreset = useCallback(
    async (targetId: string) => {
      const target = await getPreset(targetId)
      if (!target) return
      await applyChatPreset(chat.id, target.id, {
        ...target.settings,
        profileId: target.connectionProfileId,
      })
      closePicker()
    },
    [chat.id, closePicker],
  )

  const saveToExisting = useCallback(
    async (targetId: string) => {
      const target = await getPreset(targetId)
      if (!target) return
      await updatePreset(target.id, {
        settings: { ...chat.settings, profileId: target.connectionProfileId },
      })
      pushToast({
        level: 'info',
        text: `Saved settings to "${target.name}".`,
        durationMs: 2500,
      })
      closePicker()
    },
    [chat.settings, pushToast, closePicker],
  )

  const saveAsNew = useCallback(async () => {
    const name = window.prompt('Name for new preset:')
    if (!name?.trim()) return
    const p = await createPreset({
      name: name.trim(),
      connectionProfileId: chat.settings.profileId,
      settings: { ...chat.settings },
    })
    await setChatPreset(chat.id, p.id)
    pushToast({ level: 'info', text: `Created preset "${p.name}".`, durationMs: 2500 })
    closePicker()
  }, [chat.id, chat.settings, pushToast, closePicker])

  const exportPresetJson = useCallback(
    async (targetId: string, name: string) => {
      try {
        const envelope = await exportChatPreset(targetId)
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
        const result = await importChatPreset(value)
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
    const name = window.prompt('Rename preset:', currentName)
    if (!name?.trim() || name === currentName) return
    await updatePreset(targetId, { name: name.trim() })
  }, [])

  const deletePresetWithConfirm = useCallback(async (targetId: string, name: string) => {
    if (!window.confirm(`Delete preset "${name}"? Chats stay; their preset link will clear.`)) {
      return
    }
    await deletePreset(targetId)
  }, [])

  const beginPresetDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>, presetId: PresetId) => {
      if (event.button !== 0) return
      event.preventDefault()
      const captureTarget: Partial<Pick<HTMLButtonElement, 'setPointerCapture'>> =
        event.currentTarget
      captureTarget.setPointerCapture?.(event.pointerId)
      const nextState: PresetDragState = {
        draggedId: presetId,
        orderedIds: visiblePresets.map((p) => p.id),
        pointerId: event.pointerId,
        status: 'dragging',
      }
      dragStateRef.current = nextState
      setDragState(nextState)
    },
    [visiblePresets],
  )

  const updatePresetDragPosition = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const current = dragStateRef.current
    if (
      current?.status !== 'dragging' ||
      current.draggedId === null ||
      current.pointerId !== event.pointerId
    ) {
      return
    }
    event.preventDefault()
    const orderedIds = reorderPresetIdsForPointer(
      current.orderedIds,
      current.draggedId,
      event.clientY,
      presetItemRefs.current,
    )
    if (orderedIds === current.orderedIds) return
    const nextState: PresetDragState = { ...current, orderedIds }
    dragStateRef.current = nextState
    setDragState(nextState)
  }, [])

  const commitPresetDrag = useCallback(async () => {
    const current = dragStateRef.current
    if (current?.status !== 'dragging') return
    const liveIds = presets.map((p) => p.id)
    const liveIdSet = new Set(liveIds)
    const orderedIds = current.orderedIds.filter((id) => liveIdSet.has(id))
    const unchanged = orderedIds.length !== liveIds.length || sameOrderedIds(orderedIds, liveIds)
    if (unchanged) {
      dragStateRef.current = null
      setDragState(null)
      return
    }
    const settlingState: PresetDragState = { draggedId: null, orderedIds, status: 'settling' }
    dragStateRef.current = settlingState
    setDragState(settlingState)
    try {
      await reorderPresets(orderedIds)
    } catch (error) {
      dragStateRef.current = null
      setDragState(null)
      console.error('Failed to reorder presets', error)
      pushToast({ level: 'danger', text: 'Could not save preset order.' })
    }
  }, [presets, pushToast])

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
      <button
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
      </button>
      {pickerOpen ? (
        <div data-ui="preset-breadcrumb-menu" role="menu">
          {presets.length === 0 ? (
            <p data-ui="helper">No presets yet.</p>
          ) : (
            <ul>
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
                      dragState?.status === 'settling' && dragState.orderedIds.includes(p.id)
                        ? 'true'
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      data-ui="preset-drag-handle"
                      aria-label={`Drag preset "${p.name}" to reorder`}
                      title="Drag to reorder"
                      onClick={(event) => event.preventDefault()}
                      onPointerDown={(event) => beginPresetDrag(event, p.id)}
                      onPointerMove={updatePresetDragPosition}
                      onPointerUp={endPresetDrag}
                      onPointerCancel={endPresetDrag}
                    >
                      <GripVerticalIcon size={14} />
                    </button>
                    <button
                      type="button"
                      data-ui="preset-menu-load"
                      onClick={() => void loadPreset(p.id)}
                      title={isCurrent ? 'Already loaded' : 'Load preset'}
                    >
                      {p.name}
                    </button>
                    <div data-ui="preset-menu-actions">
                      <button
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
                      </button>
                      <button
                        type="button"
                        data-ui="field-inline-action"
                        onClick={() => void renamePreset(p.id, p.name)}
                        title="Rename"
                      >
                        rename
                      </button>
                      <button
                        type="button"
                        data-ui="icon-button"
                        data-compact
                        data-tone="danger"
                        onClick={() => void deletePresetWithConfirm(p.id, p.name)}
                        title="Delete preset"
                        aria-label="Delete preset"
                      >
                        <TrashIcon />
                      </button>
                      <button
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
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          <div data-ui="preset-menu-footer">
            <span data-ui="preset-menu-footer-primary">
              <button type="button" data-ui="field-inline-action" onClick={() => void saveAsNew()}>
                + Save as new…
              </button>
              <input
                ref={importInputRef}
                data-ui="preset-import-input"
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(event) => void importPresetJson(event)}
              />
              <button
                type="button"
                data-ui="icon-button"
                data-compact
                data-tone="accent"
                onClick={() => importInputRef.current?.click()}
                aria-label="Import preset JSON"
                title="Import preset JSON"
              >
                <UploadIcon size={13} />
              </button>
            </span>
            <button
              type="button"
              data-ui="icon-button"
              data-compact
              onClick={closePicker}
              aria-label="Close"
              title="Close"
            >
              <CloseGlyph />
            </button>
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
  presets: readonly ChatPreset[],
  orderedIds: readonly PresetId[] | undefined,
): ChatPreset[] {
  if (!orderedIds) return [...presets]
  const byId = new Map(presets.map((p) => [p.id, p]))
  const ordered: ChatPreset[] = []
  for (const id of orderedIds) {
    const preset = byId.get(id)
    if (preset) ordered.push(preset)
  }
  const seen = new Set(ordered.map((p) => p.id))
  for (const preset of presets) {
    if (!seen.has(preset.id)) ordered.push(preset)
  }
  return ordered
}

function reorderPresetIdsForPointer(
  orderedIds: readonly PresetId[],
  draggedId: PresetId,
  clientY: number,
  itemRefs: ReadonlyMap<PresetId, HTMLLIElement>,
): PresetId[] {
  const withoutDragged = orderedIds.filter((id) => id !== draggedId)
  if (withoutDragged.length === orderedIds.length) return orderedIds as PresetId[]
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
  const next = [...withoutDragged.slice(0, insertAt), draggedId, ...withoutDragged.slice(insertAt)]
  return sameOrderedIds(next, orderedIds) ? (orderedIds as PresetId[]) : next
}

function sameOrderedIds(left: readonly PresetId[], right: readonly PresetId[]): boolean {
  if (left.length !== right.length) return false
  return left.every((id, index) => id === right[index])
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
  endpointTokenizer,
  promptEstimate,
  isOpenRouter,
  connectionKind,
}: {
  chat: Chat
  capability: EffectiveCapability | null
  endpointTokenizer: string | null
  promptEstimate: PromptSizeEstimate | null
  isOpenRouter: boolean
  connectionKind: ConnectionKind
}) {
  return (
    <>
      <ContextPanel
        chat={chat}
        capability={capability}
        endpointTokenizer={endpointTokenizer}
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
