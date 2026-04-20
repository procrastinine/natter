import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { activePath } from '../core/active-path'
import { estimatePromptSize, tokenizerFromSettings } from '../core/prompt-size'
import { cloneDefaultChatSettings } from '../core/defaults'
import { resolvePrivacyForSend } from '../core/privacy-request'
import {
  applyBaseFontSizeToDocument,
  applyChatMaxWidthToDocument,
  applyFontFamilyToDocument,
  applyThemeToDocument,
  bumpRecentModel,
  DEFAULT_GLOBAL_PREFERENCES,
  readGlobalPreferences,
} from '../core/global-settings'
import type { Chat, ChatId, ChatPreset, ConnectionProfile, CursorMap } from '../core/types'
import { useBranchUrlSync } from '../hooks/useBranchUrlSync'
import { recoverOrphans, useChat } from '../hooks/useChat'
import { useEndpoints } from '../hooks/useEndpoints'
import { useModels } from '../hooks/useModels'
import { normalizeModelsResponse } from '../api/providers'
import { installChatPreviewMaintainer } from '../store/chat-preview-maintainer'
import {
  createChat,
  getChat,
  loadChatMessages,
  refreshChatPreview,
  updateChatSettings,
} from '../store/chats'
import { resolveKey } from '../store/keys'
import { getCachedModels } from '../store/models-cache'
import { bumpPresetLastUsedAt, pickMruPreset } from '../store/presets'
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
import { ZeroEligibleModal } from '../ui/chat/ZeroEligibleModal'
import { ScrollRegion, type ScrollRegionHandle, type ScrollState } from '../ui/chat/ScrollRegion'
import { ToastTray } from '../ui/chat/ToastTray'
import { ConnectionHeader, readActiveProfileId } from '../ui/header/ConnectionHeader'
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

// Seed settings for a new chat: start from the MRU preset (if any), then
// override `profileId` with the user's most-specific recent intent —
//   1. the currently-displayed chat's connection (highest signal — "I'm
//      reading an OpenRouter thread, new chat should stay on OpenRouter"),
//   2. else the workspace-active connection (last header dropdown pick),
//   3. else whatever the preset carried.
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
  const { send, sendFrom, abort } = useChat()
  const streamingOnActiveChat = useStreamStore((s) =>
    activeChatId ? s.hasStreamForChat(activeChatId) : false,
  )
  const profileCount = useLiveQuery(
    () => countProfiles({ includeArchived: true }),
    [],
    0,
  )
  const hasConnection = profileCount > 0
  const [chatModelOpen, setChatModelOpen] = useState(false)
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false)
  const [composerSeed, setComposerSeed] = useState<string | null>(null)
  const [scrollState, setScrollState] = useState<ScrollState>('follow')
  const [importAtEndOpen, setImportAtEndOpen] = useState(false)
  const editTreeMode = useUiStore((s) => s.editTreeMode)
  const setEditTreeMode = useUiStore((s) => s.setEditTreeMode)
  const focusMode = useUiStore((s) => s.focusMode)
  const pushBanner = useToastStore((s) => s.pushBanner)
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
  const activeMessages = useLiveQuery(
    async () => (activeChatId ? await loadChatMessages(activeChatId) : []),
    [activeChatId],
    [],
  )
  const activeEndpoints = useEndpoints(
    activeChatRow?.settings.profileId ?? null,
    activeChatRow?.settings.model || null,
    { strict: activeChatRow?.settings.strictProviderRouting === true },
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
  const activeProfileId = activeChatRow?.settings.profileId ?? null
  useModels(activeProfileId, {
    query: MODEL_AUTOSELECT_QUERY,
    enabled: !!activeChatRow && !activeChatRow.settings.model,
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
    if (!activeChatRow) return
    if (activeChatRow.settings.model) return
    if (!autoSelectRow) return
    if (autoSelectRow.profileId !== activeChatRow.settings.profileId) return
    const rows = normalizeModelsResponse(autoSelectRow.payload)
    if (rows.length !== 1) return
    const only = rows[0]
    if (!only) return
    void (async () => {
      // Re-read through the store layer (not getDb directly) so this lookup
      // migrates cleanly to the daemon WorkspaceRepository — whichever backend
      // is wired up, getChat() returns the same Chat shape.
      const latest = await getChat(activeChatRow.id)
      if (!latest || latest.settings.model) return
      if (latest.settings.profileId !== activeChatRow.settings.profileId) return
      await updateChatSettings(activeChatRow.id, { model: only.id })
    })()
  }, [activeChatRow, autoSelectRow])
  const activePathMemo = useMemo(
    () => activePath(activeMessages ?? [], activeCursor),
    [activeMessages, activeCursor],
  )
  const trailingLeaf = useMemo(() => activePathMemo.at(-1) ?? null, [activePathMemo])
  const trailingUserMessage = trailingLeaf?.role === 'user' ? trailingLeaf : null
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
    if (!activeChatRow) return undefined
    const providerCap = activeCapability?.maxPromptTokens ?? activeCapability?.contextLength
    const modelCap = activeChatRow.settings.customMaxContext ?? providerCap
    if (modelCap === undefined) return undefined
    const providerCompletionCap =
      activeCapability?.maxCompletionTokens ?? activeCapability?.contextLength ?? modelCap
    const maxCompletion =
      activeChatRow.settings.maxCompletionTokens ?? Math.min(4096, providerCompletionCap)
    const budget = Math.max(0, modelCap - maxCompletion)
    const est = estimatePromptSize({
      systemPrompt: activeChatRow.settings.systemPrompt,
      activePathMessages: activePathMemo,
      draftText: '',
      tokenizer: tokenizerFromSettings(activeChatRow.settings, null),
    })
    return { used: est.total, budget }
  }, [activeChatRow, activePathMemo, activeCapability])
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
  })
  const scrollRef = useRef<ScrollRegionHandle>(null)
  const prefs = useLiveQuery(readGlobalPreferences, [], DEFAULT_GLOBAL_PREFERENCES)

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
      const preset = await pickMruPreset()
      if (cancelled) return
      const seedSettings = seedSettingsForNewChat(
        preset?.settings,
        activeChatRow?.settings.profileId ?? readActiveProfileId(),
      )
      const chat = await createChat({
        settings: seedSettings,
        ...(preset ? { presetId: preset.id } : {}),
      })
      if (cancelled) return
      navigateToChat(chat.id)
    })()
    return () => {
      cancelled = true
    }
  }, [onNewChatSurface])

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

  const materializeChatFromComposer = useCallback(
    async (text: string) => {
      const preset = await pickMruPreset()
      const settings = seedSettingsForNewChat(
        preset?.settings,
        activeChatRow?.settings.profileId ?? readActiveProfileId(),
      )
      const chat = await createChat({
        settings,
        ...(preset ? { presetId: preset.id } : {}),
      })
      navigateToChat(chat.id)
      return { chat, seedText: text }
    },
    [activeChatRow?.settings.profileId],
  )

  const handleSubmit = useCallback(
    async (text: string) => {
      if (!activeChatId) return
      const chat = await getChat(activeChatId)
      if (!chat) {
        console.error('send: chat row missing', { chatId: activeChatId })
        return
      }
      if (!chat.settings.profileId) {
        console.error(
          'send: chat.settings.profileId is empty — create the chat from a seeded preset',
        )
        return
      }
      if (!chat.settings.model) {
        console.error('send: chat.settings.model is empty — no model selected')
        return
      }
      const profile = await getProfile(chat.settings.profileId)
      if (!profile) {
        console.error('send: connection profile missing', { profileId: chat.settings.profileId })
        return
      }
      let apiKey: string
      try {
        apiKey = await resolveKey(profile.apiKeyRef)
      } catch (err) {
        console.error('send: resolveKey failed', err)
        return
      }
      const privacy = await resolvePrivacyForSend({ chat, profile })
      if (privacy.filter?.zeroEligible) {
        // Every endpoint was hard-denied or Pareto-excluded for this
        // model. Surface the §10.13.1 modal so the user can pick a
        // recovery action rather than silently sending to a training
        // provider. The composer keeps the draft text in place so the
        // modal can retry-send after the user resolves it.
        useUiStore.getState().setZeroEligibleChatId(activeChatId)
        return
      }
      try {
        const result = await send({
          chatId: activeChatId,
          connection: profile,
          apiKey,
          content: [{ type: 'text', text }],
          ...(privacy.wire ? { transform: { privacy: privacy.wire } } : {}),
        })
        if (result.outcome !== 'done') {
          console.info('send: stream ended with outcome', result.outcome, result.error?.kind)
        }
      } catch (err) {
        console.error('send: pipeline threw', err)
        return
      }
      await bumpProfileLastUsedAt(profile.id)
      if (chat.presetId) await bumpPresetLastUsedAt(chat.presetId)
      await bumpRecentModel(chat.settings.model)
    },
    [activeChatId, send],
  )

  const handleNewChatSubmit = useCallback(
    async (text: string) => {
      const { chat } = await materializeChatFromComposer(text)
      const profile = await getProfile(chat.settings.profileId)
      if (!profile) {
        console.error('send: connection profile missing', { profileId: chat.settings.profileId })
        return
      }
      let apiKey: string
      try {
        apiKey = await resolveKey(profile.apiKeyRef)
      } catch (err) {
        console.error('send: resolveKey failed', err)
        return
      }
      const privacy = await resolvePrivacyForSend({ chat, profile })
      if (privacy.filter?.zeroEligible) {
        useUiStore.getState().setZeroEligibleChatId(chat.id)
        return
      }
      try {
        const result = await send({
          chatId: chat.id,
          connection: profile,
          apiKey,
          content: [{ type: 'text', text }],
          ...(privacy.wire ? { transform: { privacy: privacy.wire } } : {}),
        })
        if (result.outcome !== 'done') {
          console.info('send: stream ended with outcome', result.outcome, result.error?.kind)
        }
      } catch (err) {
        console.error('send: pipeline threw', err)
        return
      }
      await bumpProfileLastUsedAt(profile.id)
      if (chat.presetId) await bumpPresetLastUsedAt(chat.presetId)
      await bumpRecentModel(chat.settings.model)
    },
    [materializeChatFromComposer, send],
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
        abort()
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
  }, [streamingOnActiveChat, abort, activeChatId, setEditTreeMode])

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
          activeChatProfileId={activeChatRow?.settings.profileId ?? null}
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
                hasConnection={hasConnection}
                {...(activeCapability ? { capability: activeCapability } : {})}
              />
              {focusMode ? (
                <Composer
                  onSubmit={handleSubmit}
                  disabled={streamingOnActiveChat}
                  streaming={streamingOnActiveChat}
                  onAbort={abort}
                  autoSize
                  autoSizeVariant="focus"
                  {...(hasConnection
                    ? {}
                    : { sendBlockedReason: 'Add a connection to send messages.' })}
                  seed={composerSeed}
                  onSeedConsumed={() => setComposerSeed(null)}
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
                            const apiKey = await resolveKey(profile.apiKeyRef)
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
                disabled={streamingOnActiveChat}
                streaming={streamingOnActiveChat}
                onAbort={abort}
                autoSize
                {...(hasConnection
                  ? {}
                  : { sendBlockedReason: 'Add a connection to send messages.' })}
                seed={composerSeed}
                onSeedConsumed={() => setComposerSeed(null)}
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
                          const apiKey = await resolveKey(profile.apiKeyRef)
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
                  const preset = await pickMruPreset()
                  const settings = seedSettingsForNewChat(
                    preset?.settings,
                    activeChatRow?.settings.profileId ?? readActiveProfileId(),
                  )
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
            const preset = await pickMruPreset()
            const settings = seedSettingsForNewChat(
              preset?.settings,
              activeChatRow?.settings.profileId ?? readActiveProfileId(),
            )
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
