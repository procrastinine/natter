import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { attachmentsDisabledByTextProtocol } from '../core/attachments/context'
import { cloneDefaultChatSettings } from '../core/defaults'
import {
  applyBaseFontSizeToDocument,
  applyChatMaxWidthToDocument,
  applyFontFamilyToDocument,
  applyThemeToDocument,
  bumpRecentModel,
  DEFAULT_GLOBAL_PREFERENCES,
  readGlobalPreferences,
} from '../core/global-settings'
import {
  buildSettingsPromptSizeEstimateInput,
  type PromptSizeEstimateInput,
  UNLIMITED_CONTEXT,
} from '../core/prompt-size'
import { prefillClassFor } from '../core/quirks'
import { modelLooksForeignForProfile, pickEquivalentModelId } from '../core/model-selection'
import { withProfileApiDefaults } from '../core/provider-defaults'
import { DEFAULT_SIDEBAR_SORT_MODE } from '../core/sidebar-sort'
import { readTokenCalibrationGlobal } from '../core/token-calibration'
import type {
  Chat,
  ChatId,
  ConnectionProfile,
  CursorMap,
  MessageAttachmentRef,
} from '../core/types'
import { useBranchUrlSync } from '../hooks/useBranchUrlSync'
import { recoverOrphans, useChat } from '../hooks/useChat'
import { useEndpoints } from '../hooks/useEndpoints'
import { useModels } from '../hooks/useModels'
import { useStreamStablePromptEstimate } from '../hooks/useStreamStablePromptEstimate'
import { newId } from '../lib/ulid'
import { installChatPreviewMaintainer } from '../store/chat-preview-maintainer'
import { createChat, getChat, loadActiveBranchSnapshot, updateChatSettings } from '../store/chats'
import { resolveKeyIfPresent } from '../store/keys'
import { bumpPresetLastUsedAt, getPreset, pickPreferredPreset } from '../store/presets'
import { bumpProfileLastUsedAt, countProfiles, getProfile } from '../store/profiles'
import { installPersistenceRequestOnFirstInteraction } from '../store/quota'
import type { ActiveBranchSnapshot } from '../store/repository'
import { readSidebarSortMode } from '../store/sidebar-preferences'
import { installStreamLeaseListener, requestAbortForChat } from '../store/stream-leases'
import { useChatStore } from '../store/zustand/chatStore'
import { useStreamStore } from '../store/zustand/streamStore'
import { useToastStore } from '../store/zustand/toastStore'
import { useUiStore } from '../store/zustand/uiStore'
import { useAttachmentResolverForContext } from '../ui/attachments/useAttachmentResolver'
import { BannerTray } from '../ui/chat/BannerTray'
import { ChatHeader } from '../ui/chat/ChatHeader'
import { Composer, type ComposerDroppedFiles } from '../ui/chat/Composer'
import { EditTreeToolbar } from '../ui/chat/EditTreeToolbar'
import { EmptyState } from '../ui/chat/EmptyState'
import { FocusModeToggle } from '../ui/chat/FocusModeToggle'
import { ImportModal } from '../ui/chat/ImportModal'
import { MessageList } from '../ui/chat/MessageList'
import { PrefillSettingsPrompt } from '../ui/chat/PrefillSettingsPrompt'
import { ScrollRegion, type ScrollRegionHandle, type ScrollState } from '../ui/chat/ScrollRegion'
import { ToastTray } from '../ui/chat/ToastTray'
import { ZeroEligibleModal } from '../ui/chat/ZeroEligibleModal'
import {
  ConnectionHeader,
  readActiveSeedState,
  writeActiveSeedState,
} from '../ui/header/ConnectionHeader'
import { ChevronIcon, CogIcon, DatabaseIcon, NewChatIcon } from '../ui/icons/Icon'
import { ChatModelPanel } from '../ui/settings/ChatModelPanel'
import { GlobalSettingsModal } from '../ui/settings/GlobalSettingsModal'
import { ChatList } from '../ui/sidebar/ChatList'
import { StorageView } from '../ui/storage/StorageView'
import {
  homeHref,
  makeAnchorClickHandler,
  navigateHome,
  navigateNew,
  navigateToChat,
  newChatHref,
  storageHref,
  useRoute,
} from './router'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'natter:sidebar-collapsed'
// Stable empty reference so useSyncExternalStore selectors don't allocate a
// fresh `{}` each render (React 19 flags that as infinite re-render).
const EMPTY_CURSOR: CursorMap = Object.freeze({})
// Matches ModelPicker's MODELS_QUERY — the cache row is keyed on the query
// signature, so reusing the same one here means the picker and the
// auto-selector share a single /models fetch instead of triggering two.
const MODEL_AUTOSELECT_QUERY = {
  outputModalities: ['text', 'image', 'audio', 'file', 'video'],
} as const
const DIRECT_MODEL_AUTOSELECT_QUERY = {} as const

interface ActiveModelState {
  chatId: ChatId
  profileId: string
  model: string
}

interface PendingEquivalentModel {
  chatId: ChatId
  profileId: string
  sourceModel: string
}

function cursorCacheKey(chatId: ChatId, cursor: CursorMap): string {
  const entries = Object.entries(cursor).sort(([left], [right]) => left.localeCompare(right))
  return JSON.stringify([chatId, entries])
}

function profileRequiresKey(kind: ConnectionProfile['kind']): boolean {
  return kind !== 'custom' && kind !== 'llama-server'
}

function hasFileTransfer(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

// Seed settings for a new chat from this tab's remembered default first,
// then fall back to the workspace-global MRU preset. The remembered seed
// tracks the most recently viewed chat in this tab (including preset-backed
// chats with no local edits), plus explicit new-chat/profile-switch actions.
// `profileId` is still overridden with the preferred profile so an explicit
// connection choice can win even when a different preset had to be used
// for the rest of the seed settings.
// If the chosen profileId differs from the preset's, clear the model —
// the preset's model is almost certainly not served on the new connection,
// and the Shell-level auto-selector will fill it in if the new connection
// has exactly one model.
function seedSettingsForNewChat(
  presetSettings: Chat['settings'] | undefined,
  preferredProfile: ConnectionProfile | null,
): Chat['settings'] {
  const base = presetSettings ? { ...presetSettings } : cloneDefaultChatSettings()
  const targetId = preferredProfile?.id ?? base.profileId
  let next = base
  if (targetId && targetId !== base.profileId) {
    next = { ...base, profileId: targetId, model: '' }
  }
  return preferredProfile ? withProfileApiDefaults(next, preferredProfile) : next
}

export function Shell() {
  const route = useRoute()
  const activeChatId = route.kind === 'chat' ? route.chatId : null
  const activeStorageRoute = route.kind === 'storage' ? route.storage : null
  const focusModeAvailable = !activeStorageRoute
  const onNewChatSurface = route.kind === 'new'
  useBranchUrlSync(activeChatId)
  const { send, sendFrom } = useChat()
  const streamingOnActiveChat = useStreamStore((s) =>
    activeChatId ? s.hasStreamForChat(activeChatId) : false,
  )
  const profileCount = useLiveQuery(
    () => countProfiles({ includeArchived: true }),
    [],
    undefined,
  )
  const connectionKnown = profileCount !== undefined
  const hasConnection = connectionKnown && profileCount > 0
  const [chatModelOpen, setChatModelOpen] = useState(false)
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false)
  const [composerSeed, setComposerSeed] = useState<string | null>(null)
  const [composerDraft, setComposerDraft] = useState('')
  const [composerPrefillDraft, setComposerPrefillDraft] = useState('')
  const [composerAttachmentRefs, setComposerAttachmentRefs] = useState<MessageAttachmentRef[]>([])
  const [composerDroppedFiles, setComposerDroppedFiles] = useState<ComposerDroppedFiles | null>(
    null,
  )
  const [scrollState, setScrollState] = useState<ScrollState>('follow')
  const [importAtEndOpen, setImportAtEndOpen] = useState(false)
  const editTreeMode = useUiStore((s) => s.editTreeMode)
  const setEditTreeMode = useUiStore((s) => s.setEditTreeMode)
  const focusMode = useUiStore((s) => s.focusMode)
  const effectiveFocusMode = focusMode && focusModeAvailable
  const pushBanner = useToastStore((s) => s.pushBanner)
  const pushToast = useToastStore((s) => s.push)
  const clearBannersByKind = useToastStore((s) => s.clearBannersByKind)
  const activeCursor = useChatStore((s) =>
    activeChatId ? (s.cursors[activeChatId] ?? EMPTY_CURSOR) : EMPTY_CURSOR,
  )
  // Single subscriptions for the active chat's row + message set. Earlier
  // there were three overlapping `useLiveQuery` calls (trailingLeaf,
  // activeChatRow, tokenBudgetIndicator) each loading the chat/messages
  // on its own. Now downstream derivations share one observable per
  // table, cutting redundant IDB reads and observer lifecycles.
  const activeChatRow = useLiveQuery(
    async () => (activeChatId ? await getChat(activeChatId) : undefined),
    [activeChatId],
    undefined,
  )
  const chatSnapshotCacheRef = useRef(new Map<ChatId, Chat>())
  useEffect(() => {
    if (!activeChatRow) return
    chatSnapshotCacheRef.current.set(activeChatRow.id, activeChatRow)
  }, [activeChatRow])
  const resolvedActiveChatRow =
    activeChatRow ?? (activeChatId ? chatSnapshotCacheRef.current.get(activeChatId) : undefined)
  const activeBranchSnapshot = useLiveQuery(
    () =>
      activeChatId ? loadActiveBranchSnapshot(activeChatId, activeCursor) : Promise.resolve(null),
    [activeChatId, activeCursor],
    null,
  )
  const activeCursorCacheKey = activeChatId ? cursorCacheKey(activeChatId, activeCursor) : null
  const branchSnapshotCacheRef = useRef(new Map<string, ActiveBranchSnapshot>())
  useEffect(() => {
    if (!activeBranchSnapshot) return
    if (activeBranchSnapshot.chatId !== activeChatId) return
    branchSnapshotCacheRef.current.set(
      cursorCacheKey(activeBranchSnapshot.chatId, activeCursor),
      activeBranchSnapshot,
    )
  }, [activeBranchSnapshot, activeChatId, activeCursor])
  const resolvedActiveBranchSnapshot =
    activeBranchSnapshot?.chatId === activeChatId
      ? activeBranchSnapshot
      : activeCursorCacheKey
        ? (branchSnapshotCacheRef.current.get(activeCursorCacheKey) ?? null)
        : null
  const activeEndpoints = useEndpoints(
    resolvedActiveChatRow?.settings.profileId ?? null,
    resolvedActiveChatRow?.settings.model || null,
    { strict: resolvedActiveChatRow?.settings.strictProviderRouting === true },
  )
  const activeCapability = activeEndpoints.capability
  // Keep the chat's model coherent with its connection. If a profile switch
  // cleared a model, first try to select the equivalent model from the new
  // connection's /models list. Fresh no-model chats still get the old
  // single-model convenience fallback.
  //
  // `useModels` powers both the fetch and read halves so this code sees the
  // same merged direct-provider list as ModelPicker. That matters for direct
  // Anthropic/Google, whose live /models rows can be sparse or unavailable
  // while bundled capability rows are still valid picker choices.
  const activeProfileId = resolvedActiveChatRow?.settings.profileId ?? null
  const activeProfileForModelList = useLiveQuery(
    () => (activeProfileId ? getProfile(activeProfileId) : Promise.resolve(undefined)),
    [activeProfileId],
    undefined,
  )
  const previousActiveModelRef = useRef<ActiveModelState | null>(null)
  const pendingEquivalentModelRef = useRef<PendingEquivalentModel | null>(null)
  const activeModelState = useMemo<ActiveModelState | null>(() => {
    if (!resolvedActiveChatRow?.settings.profileId) return null
    return {
      chatId: resolvedActiveChatRow.id,
      profileId: resolvedActiveChatRow.settings.profileId,
      model: resolvedActiveChatRow.settings.model,
    }
  }, [
    resolvedActiveChatRow?.id,
    resolvedActiveChatRow?.settings.profileId,
    resolvedActiveChatRow?.settings.model,
  ])
  useEffect(() => {
    const previous = previousActiveModelRef.current
    if (!activeModelState) {
      previousActiveModelRef.current = null
      pendingEquivalentModelRef.current = null
      return
    }
    const pending = pendingEquivalentModelRef.current
    if (
      previous &&
      previous.chatId === activeModelState.chatId &&
      previous.profileId !== activeModelState.profileId &&
      previous.model
    ) {
      pendingEquivalentModelRef.current = {
        chatId: activeModelState.chatId,
        profileId: activeModelState.profileId,
        sourceModel: activeModelState.model || previous.model,
      }
    } else if (activeModelState.model) {
      if (pending?.chatId === activeModelState.chatId) pendingEquivalentModelRef.current = null
    } else if (
      pending &&
      (pending.chatId !== activeModelState.chatId ||
        pending.profileId !== activeModelState.profileId)
    ) {
      pendingEquivalentModelRef.current = null
    }
    previousActiveModelRef.current = activeModelState
  }, [activeModelState])
  const autoSelectModelsQuery =
    activeProfileForModelList?.kind === 'openrouter'
      ? MODEL_AUTOSELECT_QUERY
      : DIRECT_MODEL_AUTOSELECT_QUERY
  const autoSelectModels = useModels(activeProfileId, {
    query: autoSelectModelsQuery,
    enabled: !!resolvedActiveChatRow && !!activeProfileForModelList,
  })
  useEffect(() => {
    if (!resolvedActiveChatRow) return
    if (activeProfileId !== resolvedActiveChatRow.settings.profileId) return
    const rows = autoSelectModels.models
    const pendingEquivalent = pendingEquivalentModelRef.current
    if (resolvedActiveChatRow.settings.model) {
      if (rows.length === 0) return
      const equivalentModelId = pickEquivalentModelId(resolvedActiveChatRow.settings.model, rows)
      if (equivalentModelId && equivalentModelId !== resolvedActiveChatRow.settings.model) {
        pendingEquivalentModelRef.current = null
        void updateChatSettings(resolvedActiveChatRow.id, { model: equivalentModelId })
        return
      }
      if (
        (pendingEquivalent ||
          (activeProfileForModelList &&
            modelLooksForeignForProfile(
              activeProfileForModelList.kind,
              resolvedActiveChatRow.settings.model,
            ))) &&
        !equivalentModelId
      ) {
        pendingEquivalentModelRef.current = null
        void updateChatSettings(resolvedActiveChatRow.id, { model: '' })
        return
      }
      if (!pendingEquivalent) return
    }
    if (
      pendingEquivalent &&
      pendingEquivalent.chatId === resolvedActiveChatRow.id &&
      pendingEquivalent.profileId === resolvedActiveChatRow.settings.profileId
    ) {
      if (rows.length === 0) return
      const equivalentModelId = pickEquivalentModelId(pendingEquivalent.sourceModel, rows)
      pendingEquivalentModelRef.current = null
      void (async () => {
        const latest = await getChat(resolvedActiveChatRow.id)
        if (!latest) return
        if (latest.settings.profileId !== resolvedActiveChatRow.settings.profileId) return
        const nextModel = equivalentModelId ?? ''
        if (latest.settings.model === nextModel) return
        await updateChatSettings(resolvedActiveChatRow.id, { model: nextModel })
      })()
      return
    }
    if (resolvedActiveChatRow.settings.model) return
    if (rows.length !== 1) return
    const only = rows[0]
    if (!only) return
    void (async () => {
      // Re-read through the store layer (not getDb directly) so this lookup
      // migrates cleanly to the daemon WorkspaceRepository — whichever backend
      // is wired up, getChat() returns the same Chat shape.
      const latest = await getChat(resolvedActiveChatRow.id)
      if (!latest || latest.settings.model) return
      if (latest.settings.profileId !== resolvedActiveChatRow.settings.profileId) return
      await updateChatSettings(resolvedActiveChatRow.id, { model: only.id })
    })()
  }, [resolvedActiveChatRow, activeProfileId, activeProfileForModelList, autoSelectModels.models])
  const activePathMemo = resolvedActiveBranchSnapshot?.branch ?? []
  const composerAttachmentResolver = useAttachmentResolverForContext({
    settings: resolvedActiveChatRow?.settings,
    messages: activePathMemo,
    draftAttachmentRefs: composerAttachmentRefs,
  })
  const prefs = useLiveQuery(readGlobalPreferences, [], DEFAULT_GLOBAL_PREFERENCES)
  const globalCalibration = useLiveQuery(readTokenCalibrationGlobal, [], null)
  const sidebarSortMode = useLiveQuery(readSidebarSortMode, [], DEFAULT_SIDEBAR_SORT_MODE)
  const trailingLeaf = useMemo(() => activePathMemo.at(-1) ?? null, [activePathMemo])
  const trailingUserMessage = trailingLeaf?.role === 'user' ? trailingLeaf : null
  const streamActivityKey = useStreamStore((s) =>
    activeChatId
      ? Object.values(s.activeByStreamId)
          .filter((stream) => stream.chatId === activeChatId)
          .map((stream) => (stream.messageId ? `m:${stream.messageId}` : `s:${stream.streamId}`))
          .sort()
          .join('|')
      : '',
  )
  // Pre-cut the active path via the head+tail cutoff so the composer
  // gauge reflects what will actually be sent (matches the Context-tab
  // gauge). `providerCap` lets the cutoff resolve even when the user
  // hasn't typed a `customMaxContext`; null until capability loads, then
  // the memo re-runs.
  const composerProviderCap =
    activeCapability?.maxPromptTokens ?? activeCapability?.contextLength ?? null
  const tokenEstimateInput = useMemo<PromptSizeEstimateInput | null>(() => {
    if (!resolvedActiveChatRow) return null
    // Roll the prefill draft into `draftText` so the token gauge reflects
    // both inputs the user is about to send. The wire transform sends the
    // prefill as a separate assistant turn but token-wise it's just bytes;
    // adding to draftText is the cheapest accurate accounting.
    const combinedDraft =
      composerPrefillDraft.length > 0 ? `${composerDraft}\n${composerPrefillDraft}` : composerDraft
    return buildSettingsPromptSizeEstimateInput(
      resolvedActiveChatRow.settings,
      activePathMemo,
      combinedDraft,
      null,
      composerProviderCap,
      composerAttachmentResolver,
      {
        chatTokenCalibration: resolvedActiveChatRow.tokenCalibration,
        globalCalibration,
        mode: prefs.tokenCalibrationMode,
      },
      composerAttachmentRefs,
    )
  }, [
    resolvedActiveChatRow,
    activePathMemo,
    composerDraft,
    composerPrefillDraft,
    composerAttachmentRefs,
    composerProviderCap,
    composerAttachmentResolver,
    globalCalibration,
    prefs.tokenCalibrationMode,
  ])
  const deferredTokenEstimateInput = useDeferredValue(tokenEstimateInput)
  const tokenEstimate = useStreamStablePromptEstimate(
    resolvedActiveChatRow?.id,
    deferredTokenEstimateInput,
    streamActivityKey,
  )
  // Token indicator for the composer. Shares `estimatePromptSize` with
  // the Context tab's gauge, so the number the user sees in the composer
  // matches the Context tab exactly — including the provider-calibrated
  // baseline, the hiddenFromContext filtering, and the edit-aware
  // fallback. Budget resolution:
  //
  //   1. Prefer the user's `customMaxContext` — it's explicit intent.
  //   2. Otherwise use the provider-derived cap from live /endpoints.
  //   3. If the capability hasn't loaded yet AND the user hasn't set a
  //      custom cap, return `undefined` so the Composer hides the
  //      indicator entirely instead of collapsing to a bogus 128k
  //      default. Transient flickers from "894k → 104k" during a model
  //      switch were the bug driving this.
  const tokenBudgetIndicator = useMemo(() => {
    if (!resolvedActiveChatRow) return undefined
    const providerCap = activeCapability?.maxPromptTokens ?? activeCapability?.contextLength
    const customMaxStored = resolvedActiveChatRow.settings.customMaxContext
    // `-1` is the "no local cap" sentinel — hide the composer gauge budget
    // (the label renders just the used count) rather than pretending the
    // provider cap applies when the user explicitly opted out.
    if (customMaxStored === UNLIMITED_CONTEXT) {
      // Fall through with a large modelCap but it will still be capped via max
      // completion below; the composer checks `budget <= used ? undefined
      // : budget - used` so an effectively unbounded number is fed in.
    }
    const modelCapRaw = customMaxStored === UNLIMITED_CONTEXT ? undefined : customMaxStored
    const modelCap = modelCapRaw ?? providerCap
    if (modelCap === undefined && customMaxStored !== UNLIMITED_CONTEXT) return undefined
    const providerCompletionCap =
      activeCapability?.maxCompletionTokens ?? activeCapability?.contextLength ?? modelCap ?? 0
    const maxCompletionStored = resolvedActiveChatRow.settings.maxCompletionTokens
    const maxCompletion =
      maxCompletionStored === UNLIMITED_CONTEXT
        ? 0
        : (maxCompletionStored ?? Math.min(4096, providerCompletionCap))
    const budget =
      customMaxStored === UNLIMITED_CONTEXT
        ? Number.POSITIVE_INFINITY
        : Math.max(0, (modelCap ?? 0) - maxCompletion)
    if (!tokenEstimate) return undefined
    return { used: tokenEstimate.total, budget }
  }, [resolvedActiveChatRow, activeCapability, tokenEstimate])
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
  })
  const scrollRef = useRef<ScrollRegionHandle>(null)
  const abortActiveChat = useCallback(() => {
    if (!activeChatId) return
    const aborted = requestAbortForChat(activeChatId)
    if (aborted === 0) {
      pushToast({ level: 'warning', text: 'No active stream was found for this chat.' })
    }
  }, [activeChatId, pushToast])

  useEffect(() => {
    if (activeStorageRoute && chatModelOpen) setChatModelOpen(false)
  }, [activeStorageRoute, chatModelOpen])

  useEffect(() => {
    installChatPreviewMaintainer()
    installStreamLeaseListener()
  }, [])

  useEffect(() => {
    if (!activeChatId) return
    void recoverOrphans(Date.now(), activeChatId).catch(() => {})
  }, [activeChatId])

  const lastSeedSignatureRef = useRef<string>('')

  useEffect(() => {
    if (!resolvedActiveChatRow) return
    const nextSeed = {
      profileId: resolvedActiveChatRow.settings.profileId || null,
      presetId: resolvedActiveChatRow.presetId ?? null,
      settings: resolvedActiveChatRow.settings,
    }
    const signature = JSON.stringify({
      presetId: nextSeed.presetId,
      settings: nextSeed.settings,
    })
    if (signature === lastSeedSignatureRef.current) return
    lastSeedSignatureRef.current = signature
    writeActiveSeedState(nextSeed)
  }, [resolvedActiveChatRow])

  const resolveNewChatSeed = useCallback(async () => {
    const remembered = readActiveSeedState()
    const rememberedProfileId = remembered.settings?.profileId || remembered.profileId
    const rememberedProfile = rememberedProfileId
      ? await getProfile(rememberedProfileId)
      : undefined
    if (remembered.settings && rememberedProfile) {
      const preset = remembered.presetId ? await getPreset(remembered.presetId) : undefined
      return {
        preset,
        settings: withProfileApiDefaults(structuredClone(remembered.settings), rememberedProfile),
      }
    }
    const preset = await pickPreferredPreset({
      presetId: remembered.presetId,
      profileId: rememberedProfile ? rememberedProfile.id : null,
    })
    const settings = seedSettingsForNewChat(
      preset?.settings,
      rememberedProfile ?? null,
    )
    return {
      preset,
      settings,
    }
  }, [])

  // Auto-materialize a chat when the user lands on /new. Eager creation
  // means the settings panel always has a real Chat row to edit, so every
  // control on the right pane (model / context / generation) works before
  // the first message is even typed. Empty chats are hidden from the
  // sidebar (see ChatList — filters out rows with no previewText), so
  // this doesn't litter the workspace with Untitled rows even if the
  // user bails without sending.
  useEffect(() => {
    if (!onNewChatSurface) return
    let cancelled = false
    void (async () => {
      const { preset, settings } = await resolveNewChatSeed()
      if (cancelled) return
      writeActiveSeedState({
        profileId: settings.profileId || null,
        presetId: preset?.id ?? null,
        settings,
      })
      const chat = await createChat({
        settings,
        ...(preset ? { presetId: preset.id } : {}),
      })
      if (cancelled) return
      navigateToChat(chat.id)
    })()
    return () => {
      cancelled = true
    }
  }, [onNewChatSurface, resolveNewChatSeed])

  useEffect(() => {
    applyThemeToDocument(prefs.theme)
  }, [prefs.theme])

  useEffect(() => {
    applyChatMaxWidthToDocument(prefs.chatMaxWidth)
  }, [prefs.chatMaxWidth])

  useEffect(() => {
    applyFontFamilyToDocument(prefs.fontFamily)
  }, [prefs.fontFamily])

  useEffect(() => {
    applyBaseFontSizeToDocument(prefs.baseFontSize)
  }, [prefs.baseFontSize])

  useEffect(() => installPersistenceRequestOnFirstInteraction(), [])

  // Persist the panel's open/closed state across route transitions —
  // in particular, navigating to /new or between chats shouldn't auto-
  // collapse the settings pane the user explicitly opened.

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  // Chat-not-found banner: if the route refers to a chat id that doesn't
  // resolve (deleted, never existed, or pasted from another workspace),
  // surface the banner per §10.13.1 Route table. Live-query guarantees
  // re-evaluation when the chats table changes.
  const routedChatExists = useLiveQuery(
    () => (activeChatId ? getChat(activeChatId).then((c) => !!c) : Promise.resolve(true)),
    [activeChatId],
    true,
  )
  useEffect(() => {
    clearBannersByKind('chat-not-found')
    if (!activeChatId) return
    if (routedChatExists) return
    pushBanner({
      kind: 'chat-not-found',
      text: 'Chat not found in this workspace.',
      primary: { label: 'Return to home', action: () => navigateHome() },
      secondary: {
        label: 'Dismiss',
        action: () => clearBannersByKind('chat-not-found'),
      },
    })
  }, [activeChatId, routedChatExists, pushBanner, clearBannersByKind])

  const failSend = useCallback(
    (message: string, err?: unknown): never => {
      console.error(message, err)
      pushToast({ level: 'danger', text: message.replace(/^send: /, 'Send failed: ') })
      throw err instanceof Error ? err : new Error(message)
    },
    [pushToast],
  )

  const activePrefillClass = resolvedActiveChatRow?.settings.model
    ? prefillClassFor(resolvedActiveChatRow.settings.model)
    : null
  const showPrefillButton = activePrefillClass !== null && activePrefillClass !== 'unsupported'
  const activeDefaultPrefill = resolvedActiveChatRow?.settings.defaultPrefill ?? ''
  const attachmentsDisabledForActiveChat = resolvedActiveChatRow
    ? attachmentsDisabledByTextProtocol(resolvedActiveChatRow.settings)
    : false
  const handleDroppedFilesConsumed = useCallback((id: string) => {
    setComposerDroppedFiles((current) => (current?.id === id ? null : current))
  }, [])

  const handleSubmit = useCallback(
    async (
      text: string,
      opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
    ) => {
      if (!activeChatId) return failSend('send: no active chat')
      const chat = await getChat(activeChatId)
      if (!chat) return failSend('send: chat row missing', { chatId: activeChatId })
      if (!chat.settings.profileId) {
        return failSend(
          'send: chat.settings.profileId is empty — create the chat from a seeded preset',
        )
      }
      if (!chat.settings.model) {
        return failSend('send: chat.settings.model is empty — no model selected')
      }
      const profile = await getProfile(chat.settings.profileId)
      if (!profile) {
        return failSend('send: connection profile missing', { profileId: chat.settings.profileId })
      }
      let apiKey = ''
      try {
        apiKey = (await resolveKeyIfPresent(profile.apiKeyRef)) ?? ''
        if (profileRequiresKey(profile.kind) && !apiKey) {
          throw new Error('missing key')
        }
      } catch (err) {
        return failSend('send: resolveKey failed', err)
      }
      try {
        const prefillText = opts?.prefillText ?? ''
        const result = await send({
          chatId: activeChatId,
          connection: profile,
          apiKey,
          content: [{ type: 'text', text }],
          ...(opts?.attachmentRefs ? { attachmentRefs: opts.attachmentRefs } : {}),
          ...(prefillText.length > 0
            ? { prefillContent: [{ type: 'text', text: prefillText }] }
            : {}),
        })
        if (result.outcome !== 'done') {
          console.info('send: stream ended with outcome', result.outcome, result.error?.kind)
        }
      } catch (err) {
        return failSend('send: pipeline threw', err)
      }
      await bumpProfileLastUsedAt(profile.id)
      if (chat.presetId) await bumpPresetLastUsedAt(chat.presetId)
      await bumpRecentModel(chat.settings.model)
    },
    [activeChatId, failSend, send],
  )

  const handleNewChatSubmit = useCallback(
    async (
      text: string,
      opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
    ) => {
      const { preset, settings } = await resolveNewChatSeed()
      if (!settings.profileId) {
        return failSend('send: chat.settings.profileId is empty — no profile selected')
      }
      if (!settings.model) {
        return failSend('send: chat.settings.model is empty — no model selected')
      }
      const profile = await getProfile(settings.profileId)
      if (!profile) {
        return failSend('send: connection profile missing', { profileId: settings.profileId })
      }
      let apiKey = ''
      try {
        apiKey = (await resolveKeyIfPresent(profile.apiKeyRef)) ?? ''
        if (profileRequiresKey(profile.kind) && !apiKey) {
          throw new Error('missing key')
        }
      } catch (err) {
        return failSend('send: resolveKey failed', err)
      }
      writeActiveSeedState({
        profileId: settings.profileId || null,
        presetId: preset?.id ?? null,
        settings,
      })
      const chat = await createChat({
        settings,
        ...(preset ? { presetId: preset.id } : {}),
      })
      navigateToChat(chat.id)
      try {
        const prefillText = opts?.prefillText ?? ''
        const result = await send({
          chatId: chat.id,
          connection: profile,
          apiKey,
          content: [{ type: 'text', text }],
          ...(opts?.attachmentRefs ? { attachmentRefs: opts.attachmentRefs } : {}),
          ...(prefillText.length > 0
            ? { prefillContent: [{ type: 'text', text: prefillText }] }
            : {}),
        })
        if (result.outcome !== 'done') {
          console.info('send: stream ended with outcome', result.outcome, result.error?.kind)
        }
      } catch (err) {
        return failSend('send: pipeline threw', err)
      }
      await bumpProfileLastUsedAt(profile.id)
      if (chat.presetId) await bumpPresetLastUsedAt(chat.presetId)
      await bumpRecentModel(chat.settings.model)
    },
    [failSend, resolveNewChatSeed, send],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const activeTag = (document.activeElement?.tagName ?? '').toLowerCase()
      const isTyping = activeTag === 'input' || activeTag === 'textarea'
      if (e.key === 'n' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !isTyping) {
        e.preventDefault()
        navigateNew()
      }
      if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setGlobalSettingsOpen((v) => !v)
      }
      if (e.key === '.' && (e.metaKey || e.ctrlKey) && streamingOnActiveChat) {
        e.preventDefault()
        abortActiveChat()
      }
      // Edit-tree mode toggle (§10.14). Works globally; scoped by chat only
      // because the mode visually affects rows — the store field itself is
      // app-wide.
      if (e.key === 'E' && e.shiftKey && (e.metaKey || e.ctrlKey) && !isTyping) {
        e.preventDefault()
        setEditTreeMode(!useUiStore.getState().editTreeMode)
      }
      // Import-at-end modal shortcut (§10.14). Only meaningful on an active
      // chat; the keystroke is swallowed either way so DevTools bindings
      // (`Ctrl+Shift+I`) don't stomp on it.
      if (e.key === 'V' && e.shiftKey && (e.metaKey || e.ctrlKey) && activeChatId && !isTyping) {
        e.preventDefault()
        setImportAtEndOpen(true)
      }
      if (e.key === 'Escape') {
        if (useUiStore.getState().editTreeMode) {
          e.preventDefault()
          setEditTreeMode(false)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [streamingOnActiveChat, abortActiveChat, activeChatId, setEditTreeMode])

  // Keep the panel slot reserved whenever the user opened it, regardless
  // of whether a chat is active or focus mode is on. On /new the shell still
  // renders so the transition out of /new (after materializing a chat)
  // doesn't make the panel jump in from nowhere. The panel component itself
  // no-ops when chatId is null.
  const showChatModelPanel = chatModelOpen && !activeStorageRoute

  return (
    <div
      data-ui="app-shell"
      data-chat-model-panel={showChatModelPanel ? 'open' : 'closed'}
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}
      data-focus-mode={effectiveFocusMode ? 'on' : 'off'}
    >
      <aside
        data-ui="sidebar"
        data-collapsed={sidebarCollapsed}
        data-sort-key={sidebarSortMode}
        aria-label="Chats"
      >
        <div data-ui="sidebar-header">
          {sidebarCollapsed ? null : (
            <a data-ui="brand" href={homeHref()} onClick={makeAnchorClickHandler(homeHref())}>
              natter
            </a>
          )}
          <button
            type="button"
            data-ui="icon-button"
            data-role="sidebar-toggle"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setSidebarCollapsed((v) => !v)}
          >
            <ChevronIcon size={16} rotate={sidebarCollapsed ? 0 : 180} />
          </button>
          <a
            data-ui="icon-button"
            data-role="new-chat"
            href={newChatHref()}
            rel="noopener"
            aria-label="New chat"
            title="New chat"
            onClick={makeAnchorClickHandler(newChatHref())}
          >
            <NewChatIcon size={18} />
          </a>
        </div>
        <ChatList activeChatId={activeChatId} collapsed={sidebarCollapsed} />
        <div data-ui="sidebar-footer">
          <button
            type="button"
            data-ui="open-global-settings"
            aria-label="Open settings"
            title="Settings (⌘,)"
            onClick={() => setGlobalSettingsOpen(true)}
          >
            <CogIcon size={18} />
            {sidebarCollapsed ? null : <span>Settings</span>}
          </button>
          <a
            href={storageHref()}
            data-ui="open-storage"
            aria-label="Open storage"
            title="Storage"
            onClick={makeAnchorClickHandler(storageHref())}
          >
            <DatabaseIcon size={18} />
          </a>
        </div>
      </aside>
      <main
        data-ui="main-pane"
        onDragOver={(event) => {
          if (activeStorageRoute || (!activeChatId && !onNewChatSurface)) return
          if (!hasFileTransfer(event.dataTransfer)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={(event) => {
          if (activeStorageRoute || (!activeChatId && !onNewChatSurface)) return
          if (!hasFileTransfer(event.dataTransfer)) return
          const files = Array.from(event.dataTransfer.files ?? [])
          if (files.length === 0) return
          event.preventDefault()
          setComposerDroppedFiles({ id: newId(), files })
        }}
      >
        {activeStorageRoute ? (
          <StorageView route={activeStorageRoute} />
        ) : (
          <>
            {connectionKnown && !hasConnection ? (
              <ConnectionHeader
                activeChatId={activeChatId}
                activeChatProfileId={resolvedActiveChatRow?.settings.profileId ?? null}
              />
            ) : null}
            {activeChatId ? (
              <>
                <div data-ui="chat-title-bar">
                  <ConnectionHeader
                    variant="title-icon"
                    activeChatId={activeChatId}
                    activeChatProfileId={resolvedActiveChatRow?.settings.profileId ?? null}
                  />
                  <ChatHeader
                    chatId={activeChatId}
                    settingsOpen={chatModelOpen}
                    onToggleSettings={() => setChatModelOpen((v) => !v)}
                    editTreeActive={editTreeMode}
                    onToggleEditTree={() => setEditTreeMode(!editTreeMode)}
                  />
                </div>
                <EditTreeToolbar />
                <BannerTray />
                <ScrollRegion
                  key={activeChatId}
                  ref={scrollRef}
                  autoScrollOnStream={prefs.autoScrollOnStream}
                  streamActive={streamingOnActiveChat}
                  resetKey={activeChatId}
                  onStateChange={setScrollState}
                >
                  <MessageList
                    chatId={activeChatId}
                    chatSettings={resolvedActiveChatRow?.settings ?? cloneDefaultChatSettings()}
                    hasConnection={hasConnection}
                    branchSnapshot={resolvedActiveBranchSnapshot}
                    {...(activeCapability ? { capability: activeCapability } : {})}
                    prefillRecommendationEndpoints={activeEndpoints.endpoints}
                    longMessageDisplayMode={prefs.longMessageDisplayMode}
                    messageRenderWindowSize={prefs.messageRenderWindowSize}
                    messageRenderWindowLoadMode={prefs.messageRenderWindowLoadMode}
                  />
                  {effectiveFocusMode ? (
                    <Composer
                      onSubmit={handleSubmit}
                      streaming={streamingOnActiveChat}
                      onAbort={abortActiveChat}
                      autoSize
                      autoSizeVariant="focus"
                      {...(hasConnection
                        ? {}
                        : { sendBlockedReason: 'Add a connection to send messages.' })}
                      seed={composerSeed}
                      onSeedConsumed={() => setComposerSeed(null)}
                      onDraftChange={setComposerDraft}
                      onPrefillDraftChange={setComposerPrefillDraft}
                      attachmentScopeKey={activeChatId}
                      onAttachmentDraftChange={setComposerAttachmentRefs}
                      attachmentsDisabled={attachmentsDisabledForActiveChat}
                      attachmentsDisabledReason="Attachments are unavailable with Text completions."
                      droppedFiles={composerDroppedFiles}
                      onDroppedFilesConsumed={handleDroppedFilesConsumed}
                      sendShortcut={prefs.sendShortcut}
                      onImportAtEnd={() => setImportAtEndOpen(true)}
                      {...(showPrefillButton
                        ? {
                            showPrefillButton: true,
                            defaultPrefill: activeDefaultPrefill,
                            prefillScopeKey: activeChatId,
                            prefillSettingsPrompt: resolvedActiveChatRow ? (
                              <PrefillSettingsPrompt
                                chatId={resolvedActiveChatRow.id}
                                settings={resolvedActiveChatRow.settings}
                                endpoints={activeEndpoints.endpoints}
                              />
                            ) : null,
                          }
                        : {})}
                      {...(tokenBudgetIndicator ? { tokenBudget: tokenBudgetIndicator } : {})}
                      trailingUserMessage={Boolean(trailingUserMessage)}
                      {...(trailingUserMessage && hasConnection
                        ? {
                            onReplyToTrailingUser: async () => {
                              const chat = await getChat(activeChatId)
                              if (!chat) return
                              const profile = await getProfile(chat.settings.profileId)
                              if (!profile) return
                              try {
                                const apiKey = (await resolveKeyIfPresent(profile.apiKeyRef)) ?? ''
                                if (profileRequiresKey(profile.kind) && !apiKey) return
                                await sendFrom({
                                  chatId: activeChatId,
                                  connection: profile,
                                  apiKey,
                                  parentMessageId: trailingUserMessage.id,
                                })
                                await bumpProfileLastUsedAt(profile.id)
                                if (chat.presetId) {
                                  await bumpPresetLastUsedAt(chat.presetId)
                                }
                              } catch (err) {
                                console.error('reply-to-trailing failed', err)
                              }
                            },
                          }
                        : {})}
                    />
                  ) : null}
                </ScrollRegion>
                {effectiveFocusMode ? null : (
                  <Composer
                    onSubmit={handleSubmit}
                    streaming={streamingOnActiveChat}
                    onAbort={abortActiveChat}
                    autoSize
                    {...(hasConnection
                      ? {}
                      : { sendBlockedReason: 'Add a connection to send messages.' })}
                    seed={composerSeed}
                    onSeedConsumed={() => setComposerSeed(null)}
                    onDraftChange={setComposerDraft}
                    onPrefillDraftChange={setComposerPrefillDraft}
                    attachmentScopeKey={activeChatId}
                    onAttachmentDraftChange={setComposerAttachmentRefs}
                    attachmentsDisabled={attachmentsDisabledForActiveChat}
                    attachmentsDisabledReason="Attachments are unavailable with Text completions."
                    droppedFiles={composerDroppedFiles}
                    onDroppedFilesConsumed={handleDroppedFilesConsumed}
                    sendShortcut={prefs.sendShortcut}
                    onImportAtEnd={() => setImportAtEndOpen(true)}
                    {...(showPrefillButton
                      ? {
                          showPrefillButton: true,
                          defaultPrefill: activeDefaultPrefill,
                          prefillScopeKey: activeChatId,
                          prefillSettingsPrompt: resolvedActiveChatRow ? (
                            <PrefillSettingsPrompt
                              chatId={resolvedActiveChatRow.id}
                              settings={resolvedActiveChatRow.settings}
                              endpoints={activeEndpoints.endpoints}
                            />
                          ) : null,
                        }
                      : {})}
                    {...(tokenBudgetIndicator ? { tokenBudget: tokenBudgetIndicator } : {})}
                    trailingUserMessage={Boolean(trailingUserMessage)}
                    {...(trailingUserMessage && hasConnection
                      ? {
                          onReplyToTrailingUser: async () => {
                            const chat = await getChat(activeChatId)
                            if (!chat) return
                            const profile = await getProfile(chat.settings.profileId)
                            if (!profile) return
                            try {
                              const apiKey = (await resolveKeyIfPresent(profile.apiKeyRef)) ?? ''
                              if (profileRequiresKey(profile.kind) && !apiKey) return
                              await sendFrom({
                                chatId: activeChatId,
                                connection: profile,
                                apiKey,
                                parentMessageId: trailingUserMessage.id,
                              })
                              await bumpProfileLastUsedAt(profile.id)
                              if (chat.presetId) {
                                await bumpPresetLastUsedAt(chat.presetId)
                              }
                            } catch (err) {
                              console.error('reply-to-trailing failed', err)
                            }
                          },
                        }
                      : {})}
                    floatingAccessory={
                      scrollState === 'pinned' ? (
                        <button
                          type="button"
                          data-ui="jump-to-latest"
                          onClick={() => scrollRef.current?.scrollToBottom({ smooth: true })}
                        >
                          ↓ Jump to latest
                        </button>
                      ) : null
                    }
                  />
                )}
              </>
            ) : onNewChatSurface ? (
              <>
                {/* The new-chat surface still gets a chat-title-bar so the cog
                 * (model panel), download, and chat-info actions are reachable
                 * before the chat row materializes. Clicking the cog
                 * pre-creates the chat from the MRU preset and opens the
                 * model panel against the now-real chat. */}
                <div data-ui="chat-title-bar">
                  <ConnectionHeader variant="title-icon" />
                  <span data-ui="chat-title" data-title-status="untitled">
                    <span data-ui="chat-title-label">New chat</span>
                  </span>
                  <span data-ui="header-spacer" />
                  <button
                    type="button"
                    data-ui="icon-button"
                    data-role="settings-cog"
                    aria-label="Open model panel"
                    title="Model settings"
                    onClick={async () => {
                      const { preset, settings } = await resolveNewChatSeed()
                      writeActiveSeedState({
                        profileId: settings.profileId || null,
                        presetId: preset?.id ?? null,
                        settings,
                      })
                      const chat = await createChat({
                        settings,
                        ...(preset ? { presetId: preset.id } : {}),
                      })
                      navigateToChat(chat.id)
                      setChatModelOpen(true)
                    }}
                  >
                    <CogIcon size={20} />
                  </button>
                </div>
                <EmptyState onPick={(text) => setComposerSeed(text)} />
                <Composer
                  onSubmit={handleNewChatSubmit}
                  autoSize
                  {...(hasConnection
                    ? {}
                    : { sendBlockedReason: 'Add a connection to send messages.' })}
                  seed={composerSeed}
                  onSeedConsumed={() => setComposerSeed(null)}
                  onDraftChange={setComposerDraft}
                  onPrefillDraftChange={setComposerPrefillDraft}
                  attachmentScopeKey="new"
                  onAttachmentDraftChange={setComposerAttachmentRefs}
                  droppedFiles={composerDroppedFiles}
                  onDroppedFilesConsumed={handleDroppedFilesConsumed}
                  sendShortcut={prefs.sendShortcut}
                  onImportAtEnd={() => setImportAtEndOpen(true)}
                  {...(tokenBudgetIndicator ? { tokenBudget: tokenBudgetIndicator } : {})}
                />
              </>
            ) : (
              <EmptyState onPick={(text) => setComposerSeed(text)} />
            )}
          </>
        )}
      </main>
      {showChatModelPanel ? (
        <ChatModelPanel
          chatId={activeChatId}
          chatSnapshot={resolvedActiveChatRow ?? null}
          onClose={() => setChatModelOpen(false)}
        />
      ) : null}
      <GlobalSettingsModal open={globalSettingsOpen} onClose={() => setGlobalSettingsOpen(false)} />
      <ZeroEligibleModalHost />
      {importAtEndOpen && activeChatId ? (
        <ImportModal
          chatId={activeChatId}
          slot={{ kind: 'at-end' }}
          cursor={activeCursor}
          onClose={() => setImportAtEndOpen(false)}
          onDone={() => setImportAtEndOpen(false)}
        />
      ) : null}
      {importAtEndOpen && !activeChatId && onNewChatSurface ? (
        <ImportModal
          chatId={null}
          slot={{ kind: 'at-end' }}
          cursor={EMPTY_CURSOR}
          materializeChat={async () => {
            // Fire ONLY when the user clicks Import. Cancel leaves the
            // workspace untouched — no empty "untitled chat" rows.
            const { preset, settings } = await resolveNewChatSeed()
            writeActiveSeedState({
              profileId: settings.profileId || null,
              presetId: preset?.id ?? null,
              settings,
            })
            const chat = await createChat({
              settings,
              ...(preset ? { presetId: preset.id } : {}),
            })
            navigateToChat(chat.id)
            return chat.id
          }}
          onClose={() => setImportAtEndOpen(false)}
          onDone={() => setImportAtEndOpen(false)}
        />
      ) : null}
      <ToastTray />
      {focusModeAvailable ? <FocusModeToggle /> : null}
    </div>
  )
}

// Tiny wrapper that only renders the modal when `zeroEligibleChatId` is
// set. Having this as its own component lets Shell subscribe via
// Zustand without forcing the modal to mount all the time.
function ZeroEligibleModalHost() {
  const chatId = useUiStore((s) => s.zeroEligibleChatId)
  if (!chatId) return null
  return <ZeroEligibleModal chatId={chatId} />
}
