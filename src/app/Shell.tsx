import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { ChatId, ChatPreset, ConnectionProfile, CursorMap } from '../core/types'
import { cloneDefaultChatSettings } from '../core/defaults'
import {
  applyBaseFontSizeToDocument,
  applyChatMaxWidthToDocument,
  applyFontFamilyToDocument,
  applyThemeToDocument,
  DEFAULT_GLOBAL_PREFERENCES,
  readGlobalPreferences,
} from '../core/global-settings'
import { recoverOrphans, useChat } from '../hooks/useChat'
import { useBranchUrlSync } from '../hooks/useBranchUrlSync'
import { activePath } from '../core/active-path'
import { loadChatMessages, refreshChatPreview } from '../store/chats'
import { installChatPreviewMaintainer } from '../store/chat-preview-maintainer'
import { resolveKey } from '../store/keys'
import { pickMruPreset, bumpPresetLastUsedAt } from '../store/presets'
import { getProfile, bumpProfileLastUsedAt } from '../store/profiles'
import { createChat } from '../store/chats'
import { getDb } from '../store/db'
import { useStreamStore } from '../store/zustand/streamStore'
import { ChatList } from '../ui/sidebar/ChatList'
import { ChevronIcon, CogIcon, NewChatIcon } from '../ui/icons/Icon'
import { ChatHeader } from '../ui/chat/ChatHeader'
import { Composer } from '../ui/chat/Composer'
import { EmptyState } from '../ui/chat/EmptyState'
import { MessageList } from '../ui/chat/MessageList'
import {
  ScrollRegion,
  type ScrollRegionHandle,
  type ScrollState,
} from '../ui/chat/ScrollRegion'
import { BannerTray } from '../ui/chat/BannerTray'
import { EditTreeToolbar } from '../ui/chat/EditTreeToolbar'
import { FocusModeToggle } from '../ui/chat/FocusModeToggle'
import { ToastTray } from '../ui/chat/ToastTray'
import { ImportModal } from '../ui/chat/ImportModal'
import { ConnectionHeader } from '../ui/header/ConnectionHeader'
import { ChatModelPanel } from '../ui/settings/ChatModelPanel'
import { GlobalSettingsModal } from '../ui/settings/GlobalSettingsModal'
import { useToastStore } from '../store/zustand/toastStore'
import { useUiStore } from '../store/zustand/uiStore'
import {
  homeHref,
  makeAnchorClickHandler,
  navigateHome,
  navigateNew,
  navigateToChat,
  newChatHref,
  useRoute,
} from './router'
import { useChatStore } from '../store/zustand/chatStore'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'natter:sidebar-collapsed'
// Stable empty reference so useSyncExternalStore selectors don't allocate a
// fresh `{}` each render (React 19 flags that as infinite re-render).
const EMPTY_CURSOR: CursorMap = Object.freeze({}) as CursorMap

export function Shell() {
  const route = useRoute()
  const activeChatId = route.kind === 'chat' ? route.chatId : null
  const onNewChatSurface = route.kind === 'new'
  useBranchUrlSync(activeChatId)
  const { send, sendFrom, abort } = useChat()
  const streamingOnActiveChat = useStreamStore((s) =>
    activeChatId ? s.hasStreamForChat(activeChatId) : false,
  )
  const profileCount = useLiveQuery(() => getDb().profiles.count(), [], 0)
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
  // Resolve the trailing message on the active path so the composer's
  // Send button can switch to "Reply" when the chat ends on a user turn.
  // The chat-row dependency keeps us live across mutations.
  const trailingLeaf = useLiveQuery(
    async () => {
      if (!activeChatId) return null
      const msgs = await loadChatMessages(activeChatId)
      const path = activePath(msgs, activeCursor)
      return path.at(-1) ?? null
    },
    [activeChatId, activeCursor],
    null,
  )
  const trailingUserMessage =
    trailingLeaf?.role === 'user' ? trailingLeaf : null
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
  })
  const scrollRef = useRef<ScrollRegionHandle>(null)
  const prefs = useLiveQuery(
    readGlobalPreferences,
    [],
    DEFAULT_GLOBAL_PREFERENCES,
  )

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
      const chat = await getDb().chats.get(activeChatId)
      if (!chat) return
      if (chat.previewText !== undefined) return
      await refreshChatPreview(activeChatId)
    })()
  }, [activeChatId])

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

  useEffect(() => {
    if (!activeChatId) setChatModelOpen(false)
  }, [activeChatId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      sidebarCollapsed ? '1' : '0',
    )
  }, [sidebarCollapsed])

  // Chat-not-found banner: if the route refers to a chat id that doesn't
  // resolve (deleted, never existed, or pasted from another workspace),
  // surface the banner per §10.13.1 Route table. Live-query guarantees we
  // re-evaluate when the chats table changes.
  const routedChatExists = useLiveQuery(
    () =>
      activeChatId
        ? getDb().chats.get(activeChatId).then((c) => !!c)
        : Promise.resolve(true),
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
      const settings = preset ? preset.settings : cloneDefaultChatSettings()
      const chat = await createChat({
        settings: { ...settings },
        ...(preset ? { presetId: preset.id } : {}),
      })
      navigateToChat(chat.id)
      return { chat, seedText: text }
    },
    [],
  )

  const handleSubmit = useCallback(
    async (text: string) => {
      if (!activeChatId) return
      const chat = await getDb().chats.get(activeChatId)
      if (!chat) {
        console.error('send: chat row missing', { chatId: activeChatId })
        return
      }
      if (!chat.settings.profileId) {
        console.error('send: chat.settings.profileId is empty — create the chat from a seeded preset')
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
        console.error('send: pipeline threw', err)
        return
      }
      await bumpProfileLastUsedAt(profile.id)
      if (chat.presetId) await bumpPresetLastUsedAt(chat.presetId)
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
        console.error('send: pipeline threw', err)
        return
      }
      await bumpProfileLastUsedAt(profile.id)
      if (chat.presetId) await bumpPresetLastUsedAt(chat.presetId)
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
      if (
        e.key === '.' &&
        (e.metaKey || e.ctrlKey) &&
        streamingOnActiveChat
      ) {
        e.preventDefault()
        abort()
      }
      // Edit-tree mode toggle (§10.14). Works globally; scoped by chat only
      // because the mode visually affects rows — the store field itself is
      // app-wide.
      if (
        e.key === 'E' &&
        e.shiftKey &&
        (e.metaKey || e.ctrlKey) &&
        !isTyping
      ) {
        e.preventDefault()
        setEditTreeMode(!useUiStore.getState().editTreeMode)
      }
      // Import-at-end modal shortcut (§10.14). Only meaningful on an active
      // chat; we swallow the keystroke either way so DevTools bindings
      // (`Ctrl+Shift+I`) don't stomp us.
      if (
        e.key === 'V' &&
        e.shiftKey &&
        (e.metaKey || e.ctrlKey) &&
        activeChatId &&
        !isTyping
      ) {
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

  const showChatModelPanel = chatModelOpen && activeChatId

  return (
    <div
      data-ui="app-shell"
      data-chat-model-panel={showChatModelPanel ? 'open' : 'closed'}
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}
      data-focus-mode={focusMode ? 'on' : 'off'}
    >
      <aside
        data-ui="sidebar"
        data-collapsed={sidebarCollapsed}
        aria-label="Chats"
      >
        <div data-ui="sidebar-header">
          {sidebarCollapsed ? null : (
            <a
              data-ui="brand"
              href={homeHref()}
              onClick={makeAnchorClickHandler(homeHref())}
            >
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
            <ChevronIcon
              size={16}
              rotate={sidebarCollapsed ? 0 : 180}
            />
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
        <ChatList
          activeChatId={activeChatId}
          collapsed={sidebarCollapsed}
        />
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
        <ConnectionHeader />
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
              />
              {focusMode ? (
                <Composer
                  onSubmit={handleSubmit}
                  disabled={streamingOnActiveChat}
                  streaming={streamingOnActiveChat}
                  onAbort={abort}
                  autoSize
                  autoSizeVariant="focus"
                  {...(hasConnection ? {} : { sendBlockedReason: 'Add a connection to send messages.' })}
                  seed={composerSeed}
                  onSeedConsumed={() => setComposerSeed(null)}
                  sendShortcut={prefs.sendShortcut}
                  onImportAtEnd={() => setImportAtEndOpen(true)}
                  trailingUserMessage={Boolean(trailingUserMessage)}
                  {...(trailingUserMessage && hasConnection
                    ? {
                        onReplyToTrailingUser: async () => {
                          const chat = await getDb().chats.get(activeChatId)
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
                {...(hasConnection ? {} : { sendBlockedReason: 'Add a connection to send messages.' })}
                seed={composerSeed}
                onSeedConsumed={() => setComposerSeed(null)}
                sendShortcut={prefs.sendShortcut}
                onImportAtEnd={() => setImportAtEndOpen(true)}
                trailingUserMessage={Boolean(trailingUserMessage)}
                {...(trailingUserMessage && hasConnection
                  ? {
                      onReplyToTrailingUser: async () => {
                        const chat = await getDb().chats.get(activeChatId)
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
                      onClick={() =>
                        scrollRef.current?.scrollToBottom({ smooth: true })
                      }
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
                  const settings = preset
                    ? preset.settings
                    : cloneDefaultChatSettings()
                  const chat = await createChat({
                    settings: { ...settings },
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
              {...(hasConnection ? {} : { sendBlockedReason: 'Add a connection to send messages.' })}
              seed={composerSeed}
              onSeedConsumed={() => setComposerSeed(null)}
              sendShortcut={prefs.sendShortcut}
              onImportAtEnd={() => setImportAtEndOpen(true)}
            />
          </>
        ) : (
          <EmptyState onPick={(text) => setComposerSeed(text)} />
        )}
      </main>
      {showChatModelPanel && activeChatId ? (
        <ChatModelPanel
          chatId={activeChatId}
          onClose={() => setChatModelOpen(false)}
        />
      ) : null}
      <GlobalSettingsModal
        open={globalSettingsOpen}
        onClose={() => setGlobalSettingsOpen(false)}
      />
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
            const settings = preset
              ? preset.settings
              : cloneDefaultChatSettings()
            const chat = await createChat({
              settings: { ...settings },
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

export type { ChatId, ChatPreset, ConnectionProfile }
