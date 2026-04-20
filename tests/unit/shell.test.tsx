import { render, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { createChat } from '../../src/store/chats'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { __resetKeyCacheForTests, createKey } from '../../src/store/keys'
import { createPreset } from '../../src/store/presets'
import { createProfile } from '../../src/store/profiles'
import { readActiveSeedState } from '../../src/ui/header/ConnectionHeader'
import { App } from '../../src/app/App'

describe('shell smoke render', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  const DB_NAME = 'natter'

  async function resetAll() {
    __resetBroadcastForTests()
    __resetKeyCacheForTests()
    __resetDbForTests()
    window.localStorage.clear()
    window.sessionStorage.clear()
    window.location.hash = '#/'
    await Dexie.delete(DB_NAME)
  }

  beforeEach(async () => {
    ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
    await resetAll()
    await openDb()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(async () => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    await resetAll()
  })

  it('mounts sidebar, connection-header, and main-pane regions', () => {
    const { container } = render(<App />)
    expect(container.querySelector('[data-ui="app-shell"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="sidebar"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="main-pane"]')).toBeInTheDocument()
    // Connection header sits at the top of main-pane (above the chat-title
    // bar), regardless of whether a connection is configured. This is the
    // entry point users use to add or edit credentials, so it must always be
    // mounted.
    expect(container.querySelector('[data-ui="connection-header"]')).toBeInTheDocument()
    // The shell no longer renders a separate top-of-shell <header> region —
    // the chat title row (only present when a chat is active) is `[data-ui=
    // "chat-title-bar"]` inside main-pane.
    expect(container.querySelector('[data-ui="header"]')).toBeNull()
  })

  it('does NOT render the chat-model panel or global-settings modal by default', () => {
    const { container } = render(<App />)
    expect(container.querySelector('[data-ui="chat-model-panel"]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-ui="global-settings-overlay"]')).not.toBeInTheDocument()
    // The shell exposes the chat-model panel state via a data attribute so
    // CSS can grow / shrink the grid columns without remounting.
    expect(container.querySelector('[data-ui="app-shell"]')).toHaveAttribute(
      'data-chat-model-panel',
      'closed',
    )
  })

  it('boots without console errors or warnings', () => {
    render(<App />)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('updates the remembered new-chat seed when switching to an unedited preset-backed chat', async () => {
    const key = await createKey({ name: 'OpenRouter', plaintextKey: 'sk-or-v1-test' })
    const profile = await createProfile({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: key.id,
    })

    const presetASettings = cloneDefaultChatSettings()
    presetASettings.profileId = profile.id
    presetASettings.model = 'openai/gpt-4o-mini'
    const presetA = await createPreset({
      name: 'Edited preset source',
      connectionProfileId: profile.id,
      settings: presetASettings,
    })
    const chatASettings = cloneDefaultChatSettings()
    chatASettings.profileId = profile.id
    chatASettings.model = 'openai/gpt-4.1-mini'
    const chatA = await createChat({
      settings: chatASettings,
      presetId: presetA.id,
    })

    const presetBSettings = cloneDefaultChatSettings()
    presetBSettings.profileId = profile.id
    presetBSettings.model = 'anthropic/claude-opus-4.7'
    const presetB = await createPreset({
      name: 'Unedited preset source',
      connectionProfileId: profile.id,
      settings: presetBSettings,
    })
    const chatB = await createChat({
      settings: structuredClone(presetB.settings),
      presetId: presetB.id,
    })

    window.location.hash = `#/chat/${chatA.id}`
    render(<App />)
    await waitFor(() => {
      expect(readActiveSeedState().settings?.model).toBe('openai/gpt-4.1-mini')
    })

    window.location.hash = `#/chat/${chatB.id}`
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await waitFor(() => {
      expect(readActiveSeedState().presetId).toBe(presetB.id)
      expect(readActiveSeedState().settings?.model).toBe('anthropic/claude-opus-4.7')
    })
  })
})
