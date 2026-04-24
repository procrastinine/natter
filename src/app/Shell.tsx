import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { normalizeModelsResponse } from '../api/providers'
import { activePath } from '../core/active-path'
import { computeCutoffPlan } from '../core/context-cutoff'
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
  type PromptSizeEstimateInput,
  tokenizerFromSettings,
  UNLIMITED_CONTEXT,
} from '../core/prompt-size'
import { quirksFor } from '../core/quirks'
import { charsPerToken, readTokenCalibrationGlobal } from '../core/token-calibration'
import type { Chat, ChatId, ChatPreset, ConnectionProfile, CursorMap } from '../core/types'
import { useBranchUrlSync } from '../hooks/useBranchUrlSync'
import { recoverOrphans, useChat } from '../hooks/useChat'
import { useEndpoints } from '../hooks/useEndpoints'
import { useModels } from '../hooks/useModels'
import { useStreamStablePromptEstimate } from '../hooks/useStreamStablePromptEstimate'
import { installChatPreviewMaintainer } from '../store/chat-preview-maintainer'
import {
  createChat,
  getChat,
  loadChatMessages,
  refreshChatPreview,
  updateChatSettings,
} from '../store/chats'
import { resolveKeyIfPresent } from '../store/keys'
import { getCachedModels } from '../store/models-cache'
import { bumpPresetLastUsedAt, getPreset, pickPreferredPreset } from '../store/presets'
import { bumpProfileLastUsedAt, countProfiles, getProfile } from '../store/profiles'
import { useChatStore } from '../store/zustand/chatStore'
import { useStreamStore } from '../store/zustand/streamStore'
import { useToastStore } from '../store/zustand/toastStore'
import { useUiStore } from '../store/zustand/uiStore'
import { BannerTray } from '../ui/chat/BannerTray'
import { ChatHeader } from '../ui/chat/ChatHeader'
import { Composer } from '../ui/chat/Composer'
import { EditTreeToolbar } from '../ui/chat/EditTreeToolbar'
import { EmptyState } from '../ui/chat/EmptyState'
import { FocusModeToggle } from '../ui/chat/FocusModeToggle'
import { ImportModal } from '../ui/chat/ImportModal'
import { MessageList } from '../ui/chat/MessageList'
import { ScrollRegion, type ScrollRegionHandle, type ScrollState } from '../ui/chat/ScrollRegion'
import { ToastTray } from '../ui/chat/ToastTray'
import { ZeroEligibleModal } from '../ui/chat/ZeroEligibleModal'
import {
  ConnectionHeader,
  readActiveSeedState,
  writeActiveSeedState,
} from '../ui/header/ConnectionHeader'
import { ChevronIcon, CogIcon, NewChatIcon } from '../ui/icons/Icon'
import { ChatModelPanel } from '../ui/settings/ChatModelPanel'
import { GlobalSettingsModal } from '../ui/settings/GlobalSettingsModal'
import { ChatList } from '../ui/sidebar/ChatList'
import {
  homeHref,
  makeAnchorClickHandler,
  navigateHome,
  navigateNew,
  navigateToChat,
  newChatHref,
  useRoute,
} from './router'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'natter:sidebar-collapsed'
// Stable empty reference so useSyncExternalStore selectors don't allocate a
// fresh `{}` each render (React 19 flags that as infinite re-render).
const EMPTY_CURSOR: CursorMap = Object.freeze({}) as CursorMap
// Matches ModelPicker's MODELS_QUERY — the cache row is keyed on the query
// signature, so reusing the same one here means the picker and the
// auto-selector share a single /models fetch instead of triggering two.
const MODEL_AUTOSELECT_QUERY = {
  outputModalities: ['text', 'image', 'audio', 'file', 'video'],
} as const

function profileRequiresKey(kind: ConnectionProfile['kind']): boolean {
  return kind !== 'custom' && kind !== 'llama-server'
}

// Seed settings for a new chat from this tab's remembered default first,
// then fall back to the workspace-global MRU preset. The remembered seed
// tracks the most recently viewed chat in this tab (including preset-backed
// chats with no local edits), plus explicit new-chat/profile-switch actions.
// We still override `profileId` with the preferred profile so an explicit
// connection choice can win even when we had to fall back to a different
// preset for the rest of the seed settings.
// If the chosen profileId differs from the preset's, clear the model —
// the preset's model is almost certainly not served on the new connection,
// and the Shell-level auto-selector will fill it in if the new connection
// has exactly one model.
function seedSettingsForNewChat(
  presetSettings: Chat['settings'] | undefined,
  preferredProfileId: string | null,
): Chat['settings'] {
  const base = presetSettings ? { ...presetSettings } : cloneDefaultChatSettings()
  const targetId = preferredProfileId ?? base.profileId
  if (targetId && targetId !== base.profileId) {
    return { ...base, profileId: targetId, model: '' }
  }
  return base
}

export function Shell() {
  const route = useRoute()
  const activeChatId = route.kind === 'chat' ? route.chatId : null
  const onNewChatSurface = route.kind === 'new'
  useBranchUrlSync(activeChatId)
  const { send, sendFrom } = useChat()
  const streamingOnActiveChat = useStreamStore((s) =>
    activeChatId ? s.hasStreamForChat(activeChatId) : false,
  )
  const profileCount = useLiveQuery(() => countProfiles({ includeArchived: true }), [], 0)
  const hasConnection = profileCount > 0
  const [chatModelOpen, setChatModelOpen] = useState(false)
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false)
  const [composerSeed, setComposerSeed] = useState<string | null>(null)
  const [composerDraft, setComposerDraft] = useState('')
  const [scrollState, setScrollState] = useState<ScrollState>('follow')
  const [importAtEndOpen, setImportAtEndOpen] = useState(false)
  const editTreeMode = useUiStore((s) => s.editTreeMode)
  const setEditTreeMode = useUiStore((s) => s.setEditTreeMode)
  const focusMode = useUiStore((s) => s.focusMode)
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
  const activeMessages = useLiveQuery(
    async () => (activeChatId ? await loadChatMessages(activeChatId) : []),
    [activeChatId],
    [],
  )
  const activeEndpoints = useEndpoints(
    resolvedActiveChatRow?.settings.profileId ?? null,
    resolvedActiveChatRow?.settings.model || null,
    { strict: resolvedActiveChatRow?.settings.strictProviderRouting === true },
  )
  const activeCapability = activeEndpoints.capability
  // Keep the chat's model coherent with its connection: if the connection
  // serves exactly one model and the chat has no model picked, auto-select
  // it. This kicks in right after `switchProfile` clears the model on a
  // connection switch (e.g., OpenRouter → llama-server auto-picks gemma
  // because llama-server's /v1/models only returns one entry). For
  // connections with many models the chat stays unselected until the user
  // picks, and the Chat Settings panel surfaces a "select a model" banner.
  //
  // `useModels` powers the fetch half — mounting it here triggers a /v1/models
  // request for whichever profile the chat points at, whether or not the
  // Model tab is open. For the read half we go through `useLiveQuery` →
  // `getCachedModels` keyed on the CURRENT profileId directly (rather than
  // reading `useModels.models` which is a derived, slightly-delayed view).
  // This avoids a race where the chat's profileId has already flipped to
  // test-or but the cached row is still the old llama-server list, which
  // would auto-pick gemma back onto the OpenRouter chat.
  const activeProfileId = resolvedActiveChatRow?.settings.profileId ?? null
  useModels(activeProfileId, {
    query: MODEL_AUTOSELECT_QUERY,
    enabled: !!resolvedActiveChatRow && !resolvedActiveChatRow.settings.model,
  })
  const autoSelectRow = useLiveQuery(
    () =>
      activeProfileId
        ? getCachedModels(activeProfileId, MODEL_AUTOSELECT_QUERY)
        : Promise.resolve(undefined),
    [activeProfileId],
    undefined,
  )
  useEffect(() => {
    if (!resolvedActiveChatRow) return
    if (resolvedActiveChatRow.settings.model) return
    if (!autoSelectRow) return
    if (autoSelectRow.profileId !== resolvedActiveChatRow.settings.profileId) return
    const rows = normalizeModelsResponse(autoSelectRow.payload)
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
  }, [resolvedActiveChatRow, autoSelectRow])
  const activePathMemo = useMemo(
    () => activePath(activeMessages ?? [], activeCursor),
    [activeMessages, activeCursor],
  )
  const prefs = useLiveQuery(readGlobalPreferences, [], DEFAULT_GLOBAL_PREFERENCES)
  const globalCalibration = useLiveQuery(readTokenCalibrationGlobal, [], null)
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
    const quirks = quirksFor(resolvedActiveChatRow.settings.model)
    const tokenizer = tokenizerFromSettings(resolvedActiveChatRow.settings, null)
    const currentTextCharsPerToken = resolvedActiveChatRow.settings.model
      ? charsPerToken(
          resolvedActiveChatRow.settings.model,
          resolvedActiveChatRow,
          globalCalibration,
          prefs.tokenCalibrationMode,
        )
      : undefined
    const cutPlan = computeCutoffPlan({
      messages: activePathMemo,
      settings: resolvedActiveChatRow.settings,
      tokenizer,
      providerCap: composerProviderCap,
      reasoningOpts: {
        family: tokenizer,
        reasoningInclude: resolvedActiveChatRow.settings.reasoning.include,
        reasoningExcluded: resolvedActiveChatRow.settings.reasoning.exclude === true,
        ...(quirks.reasoningPreservationFormat !== undefined
          ? { reasoningPreservationFormat: quirks.reasoningPreservationFormat }
          : {}),
      },
      currentModelId: resolvedActiveChatRow.settings.model,
      ...(currentTextCharsPerToken !== undefined ? { currentTextCharsPerToken } : {}),
    })
    const input: PromptSizeEstimateInput = {
      systemPrompt: resolvedActiveChatRow.settings.systemPrompt,
      activePathMessages: cutPlan.kept,
      draftText: composerDraft,
      tokenizer,
      reasoningInclude: resolvedActiveChatRow.settings.reasoning.include,
      reasoningExcluded: resolvedActiveChatRow.settings.reasoning.exclude === true,
      currentModelId: resolvedActiveChatRow.settings.model,
      ...(currentTextCharsPerToken !== undefined ? { currentTextCharsPerToken } : {}),
    }
    if (quirks.reasoningPreservationFormat !== undefined) {
      input.reasoningPreservationFormat = quirks.reasoningPreservationFormat
    }
    return input
  }, [
    resolvedActiveChatRow,
    activePathMemo,
    composerDraft,
    composerProviderCap,
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
  //      custom cap, we return `undefined` so the Composer hides the
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
      // Fall through with a large modelCap but we'll still cap it via max
      // completion below; the composer checks `budget <= used ? undefined
      // : budget - used` so we just feed an effectively unbounded number.
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
    useStreamStore.getState().abortChat(activeChatId)
  }, [activeChatId])

  useEffect(() => {
    void recoverOrphans()
    installChatPreviewMaintainer()
  }, [])

  // Lazy backfill: legacy chat rows may lack `previewText` because they
  // predate the denormalization. Compute + write once per chat on open.
  // Skips chats that already have the field set (including the empty
  // string — a chat with no user messages legitimately has '' as preview).
  useEffect(() => {
    if (!activeChatId) return
    void (async () => {
      const chat = await getChat(activeChatId)
      if (!chat) return
      if (chat.previewText !== undefined) return
      await refreshChatPreview(activeChatId)
    })()
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
        settings: structuredClone(remembered.settings) as Chat['settings'],
      }
    }
    const preset = await pickPreferredPreset({
      presetId: remembered.presetId,
      profileId: rememberedProfile ? rememberedProfile.id : null,
    })
    const settings = seedSettingsForNewChat(
      preset?.settings,
      rememberedProfile ? rememberedProfile.id : null,
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

  // Persist the panel's open/closed state across route transitions —
  // in particular, navigating to /new or between chats shouldn't auto-
  // collapse the settings pane the user explicitly opened.

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  // Chat-not-found banner: if the route refers to a chat id that doesn't
  // resolve (deleted, never existed, or pasted from another workspace),
  // surface the banner per §10.13.1 Route table. Live-query guarantees we
  // re-evaluate when the chats table changes.
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

  const handleSubmit = useCallback(
    async (text: string) => {
      if (!activeChatId) failSend('send: no active chat')
      const chat = await getChat(activeChatId)
      if (!chat) {
        failSend('send: chat row missing', { chatId: activeChatId })
      }
      if (!chat.settings.profileId) {
        failSend('send: chat.settings.profileId is empty — create the chat from a seeded preset')
      }
      if (!chat.settings.model) {
        failSend('send: chat.settings.model is empty — no model selected')
      }
      const profile = await getProfile(chat.settings.profileId)
      if (!profile) {
        failSend('send: connection profile missing', { profileId: chat.settings.profileId })
      }
      let apiKey = ''
      try {
        apiKey = (await resolveKeyIfPresent(profile.apiKeyRef)) ?? ''
        if (profileRequiresKey(profile.kind) && !apiKey) {
          throw new Error('missing key')
        }
      } catch (err) {
        failSend('send: resolveKey failed', err)
      }
      try {
        const result = await send({
          chatId: activeChatId,
          connection: profile,
          apiKey,
          content: [{ type: 'text', text }],
        })
        if (result.outcome !== 'done') {
          console.info('send: stream ended with outcome', result.outcome, result.error?.kind)
        }
      } catch (err) {
        failSend('send: pipeline threw', err)
      }
      await bumpProfileLastUsedAt(profile.id)
      if (chat.presetId) await bumpPresetLastUsedAt(chat.presetId)
      await bumpRecentModel(chat.settings.model)
    },
    [activeChatId, failSend, send],
  )

  const handleNewChatSubmit = useCallback(
    async (text: string) => {
      const { preset, settings } = await resolveNewChatSeed()
      if (!settings.profileId) failSend('send: chat.settings.profileId is empty — no profile selected')
      if (!settings.model) failSend('send: chat.settings.model is empty — no model selected')
      const profile = await getProfile(settings.profileId)
      if (!profile) {
        failSend('send: connection profile missing', { profileId: settings.profileId })
      }
      let apiKey = ''
      try {
        apiKey = (await resolveKeyIfPresent(profile.apiKeyRef)) ?? ''
        if (profileRequiresKey(profile.kind) && !apiKey) {
          throw new Error('missing key')
        }
      } catch (err) {
        failSend('send: resolveKey failed', err)
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
        const result = await send({
          chatId: chat.id,
          connection: profile,
          apiKey,
          content: [{ type: 'text', text }],
        })
        if (result.outcome !== 'done') {
          console.info('send: stream ended with outcome', result.outcome, result.error?.kind)
        }
      } catch (err) {
        failSend('send: pipeline threw', err)
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
      // chat; we swallow the keystroke either way so DevTools bindings
      // (`Ctrl+Shift+I`) don't stomp us.
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
  // of whether a chat is active. On /new we still render the shell so the
  // transition out of /new (after materializing a chat) doesn't make the
  // panel jump in from nowhere. The panel component itself no-ops when
  // chatId is null.
  const showChatModelPanel = chatModelOpen

  return (
    <div
      data-ui="app-shell"
      data-chat-model-panel={showChatModelPanel ? 'open' : 'closed'}
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}
      data-focus-mode={focusMode ? 'on' : 'off'}
    >
      <aside data-ui="sidebar" data-collapsed={sidebarCollapsed} aria-label="Chats">
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
        </div>
      </aside>
      <main data-ui="main-pane">
        <ConnectionHeader
          activeChatId={activeChatId}
          activeChatProfileId={resolvedActiveChatRow?.settings.profileId ?? null}
        />
        {activeChatId ? (
          <>
            <div data-ui="chat-title-bar">
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
              ref={scrollRef}
              autoScrollOnOpen={prefs.autoScrollOnOpen}
              autoScrollOnStream={prefs.autoScrollOnStream}
              streamActive={streamingOnActiveChat}
              resetKey={activeChatId}
              onStateChange={setScrollState}
            >
              <MessageList
                chatId={activeChatId}
                chatSettings={resolvedActiveChatRow?.settings ?? cloneDefaultChatSettings()}
                hasConnection={hasConnection}
                {...(activeCapability ? { capability: activeCapability } : {})}
              />
              {focusMode ? (
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
                  sendShortcut={prefs.sendShortcut}
                  onImportAtEnd={() => setImportAtEndOpen(true)}
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
            {focusMode ? null : (
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
                sendShortcut={prefs.sendShortcut}
                onImportAtEnd={() => setImportAtEndOpen(true)}
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
              sendShortcut={prefs.sendShortcut}
              onImportAtEnd={() => setImportAtEndOpen(true)}
              {...(tokenBudgetIndicator ? { tokenBudget: tokenBudgetIndicator } : {})}
            />
          </>
        ) : (
          <EmptyState onPick={(text) => setComposerSeed(text)} />
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
      <FocusModeToggle />
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

export type { ChatId, ChatPreset, ConnectionProfile }
