import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { ChatId, ChatPreset, ConnectionProfile } from '../core/types'
import { cloneDefaultChatSettings } from '../core/defaults'
import {
  applyChatMaxWidthToDocument,
  applyThemeToDocument,
  DEFAULT_GLOBAL_PREFERENCES,
  readGlobalPreferences,
} from '../core/global-settings'
import { recoverOrphans, useChat } from '../hooks/useChat'
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
import { ConnectionHeader } from '../ui/header/ConnectionHeader'
import { ChatModelPanel } from '../ui/settings/ChatModelPanel'
import { GlobalSettingsModal } from '../ui/settings/GlobalSettingsModal'
import {
  homeHref,
  makeAnchorClickHandler,
  navigateNew,
  navigateToChat,
  newChatHref,
  useRoute,
} from './router'

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'natter:sidebar-collapsed'

export function Shell() {
  const route = useRoute()
  const activeChatId = route.kind === 'chat' ? route.chatId : null
  const onNewChatSurface = route.kind === 'new'
  const { send, abort } = useChat()
  const streamingOnActiveChat = useStreamStore((s) =>
    activeChatId
      ? Object.values(s.activeByStreamId).some((row) => row.chatId === activeChatId)
      : false,
  )
  const profileCount = useLiveQuery(() => getDb().profiles.count(), [], 0)
  const hasConnection = profileCount > 0
  const [chatModelOpen, setChatModelOpen] = useState(false)
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false)
  const [composerSeed, setComposerSeed] = useState<string | null>(null)
  const [scrollState, setScrollState] = useState<ScrollState>('follow')
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
  }, [])

  useEffect(() => {
    applyThemeToDocument(prefs.theme)
  }, [prefs.theme])

  useEffect(() => {
    applyChatMaxWidthToDocument(prefs.chatMaxWidth)
  }, [prefs.chatMaxWidth])

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
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [streamingOnActiveChat, abort])

  const showChatModelPanel = chatModelOpen && activeChatId

  return (
    <div
      data-ui="app-shell"
      data-chat-model-panel={showChatModelPanel ? 'open' : 'closed'}
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}
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
              />
            </div>
            <ScrollRegion
              ref={scrollRef}
              onStateChange={setScrollState}
            >
              <MessageList chatId={activeChatId} />
            </ScrollRegion>
            <Composer
              onSubmit={handleSubmit}
              disabled={streamingOnActiveChat}
              streaming={streamingOnActiveChat}
              onAbort={abort}
              {...(hasConnection ? {} : { sendBlockedReason: 'Add a connection to send messages.' })}
              seed={composerSeed}
              onSeedConsumed={() => setComposerSeed(null)}
              sendShortcut={prefs.sendShortcut}
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
              {...(hasConnection ? {} : { sendBlockedReason: 'Add a connection to send messages.' })}
              seed={composerSeed}
              onSeedConsumed={() => setComposerSeed(null)}
              sendShortcut={prefs.sendShortcut}
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
    </div>
  )
}

export type { ChatId, ChatPreset, ConnectionProfile }
