import { useCallback, useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { ChatId, ChatPreset, ConnectionProfile } from '../core/types'
import { cloneDefaultChatSettings, runFirstRunSeed } from '../core/defaults'
import { recoverOrphans, useChat } from '../hooks/useChat'
import { resolveKey } from '../store/keys'
import { pickMruPreset, bumpPresetLastUsedAt } from '../store/presets'
import { getProfile, bumpProfileLastUsedAt } from '../store/profiles'
import { createChat } from '../store/chats'
import { getDb } from '../store/db'
import { useUiStore } from '../store/zustand/uiStore'
import { ChatList } from '../ui/sidebar/ChatList'
import { Composer } from '../ui/chat/Composer'
import { MessageList } from '../ui/chat/MessageList'

export function Shell() {
  const activeChatId = useUiStore((s) => s.activeChatId)
  const setActiveChatId = useUiStore((s) => s.setActiveChatId)
  const { send, abort, isStreaming } = useChat()
  const profileCount = useLiveQuery(() => getDb().profiles.count(), [], 0)
  const needsSeed = profileCount === 0

  useEffect(() => {
    // Fire once on boot: mark any orphan in-flight messages as tab-close.
    void recoverOrphans()
  }, [])

  const createAndSelect = useCallback(async () => {
    const preset = await pickMruPreset()
    const settings = preset ? preset.settings : cloneDefaultChatSettings()
    const chat = await createChat({
      settings: { ...settings },
      ...(preset ? { presetId: preset.id } : {}),
    })
    setActiveChatId(chat.id)
  }, [setActiveChatId])

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
          console.error('send: stream ended with outcome', result.outcome, result.error)
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

  return (
    <div data-ui="app-shell">
      <aside data-ui="sidebar" aria-label="Chats">
        <ChatList
          activeChatId={activeChatId}
          onSelect={setActiveChatId}
          onCreate={() => void createAndSelect()}
        />
      </aside>
      <header data-ui="header">
        {isStreaming() ? (
          <button type="button" data-ui="abort" onClick={abort}>
            Stop
          </button>
        ) : null}
      </header>
      <main data-ui="main-pane">
        {needsSeed ? (
          <FirstRunForm />
        ) : activeChatId ? (
          <>
            <MessageList chatId={activeChatId} />
            <Composer onSubmit={handleSubmit} disabled={isStreaming()} />
          </>
        ) : (
          <div data-ui="empty-state">Pick or start a chat.</div>
        )}
      </main>
      <div data-ui="settings-overlay" role="dialog" aria-hidden="true" hidden />
    </div>
  )
}

function FirstRunForm() {
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = useCallback(async () => {
    if (!apiKey || busy) return
    setBusy(true)
    setError(null)
    try {
      await runFirstRunSeed({ apiKey, model: 'google/gemini-3.1-flash-lite-preview' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [apiKey, busy])
  return (
    <form
      data-ui="first-run"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label htmlFor="first-run-key">Paste your OpenRouter API key</label>
      <input
        id="first-run-key"
        data-ui="first-run-key"
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <button type="submit" data-ui="first-run-submit" disabled={busy || !apiKey}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {error ? <p data-ui="first-run-error">{error}</p> : null}
    </form>
  )
}

// Dev-only: useful when other files want to reference the full profile/preset
// union without re-declaring. Not currently consumed outside the shell.
export type { ChatId, ChatPreset, ConnectionProfile }
