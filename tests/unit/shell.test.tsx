import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Message } from '../../src/core/types'
import { archiveChat, createChat } from '../../src/store/chats'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { createFolder } from '../../src/store/folders'
import { __resetKeyCacheForTests, createKey } from '../../src/store/keys'
import { createPreset } from '../../src/store/presets'
import { createProfile } from '../../src/store/profiles'
import { __resetSearchSessionRunnerForTests } from '../../src/store/search-session'
import { createTag } from '../../src/store/tags'
import { __resetSearchStoreForTests } from '../../src/store/zustand/searchStore'
import { readActiveSeedState } from '../../src/ui/header/ConnectionHeader'
import { App } from '../../src/app/App'

describe('shell smoke render', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  const DB_NAME = 'natter'

  async function resetAll() {
    __resetBroadcastForTests()
    __resetKeyCacheForTests()
    __resetSearchSessionRunnerForTests()
    __resetSearchStoreForTests()
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
    cleanup()
    await new Promise((resolve) => setTimeout(resolve, 0))
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

  it('hides the focus-mode toggle on storage pages', () => {
    window.location.hash = '#/storage'
    const { container } = render(<App />)

    expect(container.querySelector('[data-ui="storage-view"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="focus-mode-toggle"]')).not.toBeInTheDocument()
  })

  it('keeps the focus-mode toggle on chat pages', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    window.location.hash = `#/chat/${chat.id}`
    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="focus-mode-toggle"]')).toBeInTheDocument()
    })
  })

  it('auto-closes the chat settings panel on storage routes', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    window.location.hash = `#/chat/${chat.id}`
    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-role="settings-cog"]')).toBeInTheDocument()
    })
    fireEvent.click(container.querySelector('[data-role="settings-cog"]') as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="chat-model-panel"]')).toBeInTheDocument()
      expect(container.querySelector('[data-ui="app-shell"]')).toHaveAttribute(
        'data-chat-model-panel',
        'open',
      )
    })

    fireEvent.click(container.querySelector('[data-ui="open-storage"]') as HTMLAnchorElement)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="storage-view"]')).toBeInTheDocument()
      expect(container.querySelector('[data-ui="chat-model-panel"]')).not.toBeInTheDocument()
      expect(container.querySelector('[data-ui="app-shell"]')).toHaveAttribute(
        'data-chat-model-panel',
        'closed',
      )
    })
  })

  it('shows newly created folders in the sidebar without a refresh', async () => {
    const { findByText } = render(<App />)

    await createFolder({ id: 'folder-live-sidebar', name: 'Live folder', now: 1 })

    expect(await findByText('Live folder')).toBeInTheDocument()
  })

  it('searches tag and folder metadata from the sidebar', async () => {
    const folder = await createFolder({ id: 'folder-search', name: 'Research Folder', now: 1 })
    const tag = await createTag({ id: 'tag-search', name: 'ResearchTag', now: 1 })
    const chat = await createChat({
      title: 'Tagged Chat',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'original preview',
      folderId: folder.id,
      tags: [tag.id],
      updatedAt: 2,
    })

    const { container } = render(<App />)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="chat-row"]')).toBeInTheDocument()
    })

    fireEvent.change(
      container.querySelector('[data-ui="sidebar-search-input"]') as HTMLInputElement,
      {
        target: { value: 'researchtag' },
      },
    )

    await waitFor(() => {
      expect(container.querySelector('[data-search-hit]')?.textContent).toBe('ResearchTag')
    })

    fireEvent.change(
      container.querySelector('[data-ui="sidebar-search-input"]') as HTMLInputElement,
      {
        target: { value: 'folder:"Research Folder"' },
      },
    )

    await waitFor(() => {
      expect(container.querySelector('[data-ui="chat-row-title"]')?.textContent).toContain(
        'Tagged Chat',
      )
    })
  })

  it('uses sidebar tag pills as search filters while the surrounding tag strip opens the chat', async () => {
    const tag = await createTag({ id: 'tag-row-clicks', name: 'ResearchTag', now: 1 })
    const chat = await createChat({
      title: 'Tagged Row Clicks',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'tag row preview',
      tags: [tag.id],
      updatedAt: 2,
    })

    const { container } = render(<App />)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="chat-row-tag"]')).toBeInTheDocument()
    })

    fireEvent.click(container.querySelector('[data-ui="chat-row-tag"]') as HTMLButtonElement)
    expect(container.querySelector('[data-ui="sidebar-search-input"]')).toHaveValue('')
    expect(container.querySelector('[data-ui="sidebar-search-filters"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="sidebar-search-filter-heading"]')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(
      container.querySelector('[data-ui="sidebar-search-chip-row"] [data-filter-state="include"]'),
    ).toHaveTextContent('ResearchTag')

    fireEvent.click(
      container.querySelector('[data-ui="sidebar-search-clear"]') as HTMLButtonElement,
    )
    await waitFor(() => {
      expect(container.querySelector('[data-ui="chat-row-tags-link"]')).toBeInTheDocument()
    })
    fireEvent.click(container.querySelector('[data-ui="chat-row-tags-link"]') as HTMLAnchorElement)

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${chat.id}`)
    })
  })

  it('uses default search results as last-updated-branch deep links', async () => {
    const chat = await createChat({
      title: 'Default Branch Search',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    const root: Message = {
      id: 'default-search-root',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'default-search-root',
      turnIndex: 0,
      createdAt: 2,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'root prompt' }],
      nodeVersion: 0,
      deleted: false,
    }
    const older: Message = {
      ...root,
      id: 'default-search-older',
      parentId: root.id,
      siblingIndex: 0,
      turnId: 'default-search-older',
      createdAt: 3,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'older branch answer' }],
    }
    const latest: Message = {
      ...older,
      id: 'default-search-latest',
      siblingIndex: 1,
      turnId: 'default-search-latest',
      createdAt: 4,
      content: [{ type: 'output_text', text: 'fresh branch answer' }],
    }
    await getDb().messages.bulkPut([root, older, latest])
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'root prompt',
      lastUpdatedLeafId: latest.id,
      lastBranchUpdatedAt: 5,
      updatedAt: 5,
    })

    const { container } = render(<App />)
    fireEvent.change(
      container.querySelector('[data-ui="sidebar-search-input"]') as HTMLInputElement,
      {
        target: { value: 'fresh' },
      },
    )

    await waitFor(() => {
      expect(container.querySelector('[data-ui="chat-row-link"]')?.getAttribute('href')).toBe(
        `#/chat/${chat.id}/message/${latest.id}`,
      )
    })
  })

  it('uses all-branches search results as deep links without writing branch cache rows', async () => {
    const chat = await createChat({
      title: 'Branch Search',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    const root: Message = {
      id: 'search-root',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'search-root',
      turnIndex: 0,
      createdAt: 2,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'root prompt' }],
      nodeVersion: 0,
      deleted: false,
    }
    const older: Message = {
      ...root,
      id: 'search-older',
      parentId: root.id,
      siblingIndex: 0,
      turnId: 'search-older',
      createdAt: 3,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'ancient branch answer' }],
    }
    const latest: Message = {
      ...older,
      id: 'search-latest',
      siblingIndex: 1,
      turnId: 'search-latest',
      createdAt: 4,
      content: [{ type: 'output_text', text: 'fresh branch answer' }],
    }
    await getDb().messages.bulkPut([root, older, latest])
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'root prompt',
      lastUpdatedLeafId: latest.id,
      lastBranchUpdatedAt: 5,
      updatedAt: 5,
    })

    const { container } = render(<App />)
    fireEvent.focus(container.querySelector('[data-ui="sidebar-search-input"]') as HTMLInputElement)
    fireEvent.click(
      Array.from(container.querySelectorAll('[data-ui="sidebar-search-filters"] label')).find(
        (label) => label.textContent === 'Branches',
      ) as HTMLLabelElement,
    )
    fireEvent.change(
      container.querySelector('[data-ui="sidebar-search-input"]') as HTMLInputElement,
      {
        target: { value: 'ancient' },
      },
    )

    await waitFor(() => {
      expect(container.querySelector('[data-ui="chat-row-link"]')?.getAttribute('href')).toBe(
        `#/chat/${chat.id}/message/${older.id}`,
      )
    })
    expect(await getDb().chatBranchCache.get(chat.id)).toBeUndefined()

    fireEvent.click(container.querySelector('[data-ui="chat-row-link"]') as HTMLAnchorElement)

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${chat.id}/message/${older.id}`)
    })
  })

  it('keeps expanded search filters open while toggling controls', async () => {
    await createFolder({ id: 'folder-durable-search', name: 'Durable folder', now: 1 })
    await createTag({ id: 'tag-durable-search', name: 'Durable tag', now: 1 })
    const chat = await createChat({
      title: 'Durable search chat',
      settings: cloneDefaultChatSettings(),
      now: 2,
    })
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'durable search preview',
      updatedAt: 3,
    })
    const { container } = render(<App />)
    const input = container.querySelector('[data-ui="sidebar-search-input"]') as HTMLInputElement

    expect(container.querySelector('[data-ui="sidebar-search-filter-toggle"]')).toBeNull()
    fireEvent.click(container.querySelector('[data-ui="sidebar-sort-button"]') as HTMLButtonElement)
    expect(container.querySelector('[data-ui="sidebar-search-filters"]')).not.toBeInTheDocument()
    fireEvent.focus(input)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="sidebar-search-filters"]')).toBeInTheDocument()
    })
    fireEvent.blur(input, { relatedTarget: document.body })
    expect(container.querySelector('[data-ui="sidebar-search-filters"]')).not.toBeInTheDocument()
    fireEvent.focus(input)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="sidebar-search-filters"]')).toBeInTheDocument()
    })
    expect(container.querySelectorAll('[data-ui="sidebar-search-chip-row"]')).toHaveLength(0)
    const filterToggles = container.querySelector(
      '[data-ui="sidebar-search-filter-toggles"]',
    ) as HTMLDivElement
    fireEvent.mouseDown(filterToggles)
    fireEvent.blur(input, { relatedTarget: document.body })
    expect(container.querySelector('[data-ui="sidebar-search-filters"]')).toBeInTheDocument()
    let rowLink: HTMLAnchorElement | null = null
    await waitFor(() => {
      rowLink =
        Array.from(container.querySelectorAll<HTMLAnchorElement>('[data-ui="chat-row-link"]')).find(
          (link) => link.getAttribute('href') === `#/chat/${chat.id}`,
        ) ?? null
      expect(rowLink).toBeInTheDocument()
    })
    if (!rowLink) throw new Error('Expected chat row link')
    const selectedRowLink = rowLink
    fireEvent.mouseDown(selectedRowLink)
    fireEvent.blur(input, { relatedTarget: selectedRowLink })
    fireEvent.click(selectedRowLink)
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${chat.id}`)
    })
    expect(container.querySelector('[data-ui="sidebar-search-filters"]')).toBeInTheDocument()
    fireEvent.mouseDown(container.querySelector('[data-ui="main-pane"]') as HTMLElement)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="sidebar-search-filters"]')).not.toBeInTheDocument()
    })
    fireEvent.focus(input)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="sidebar-search-filters"]')).toBeInTheDocument()
    })
    fireEvent.click(container.querySelector('[data-ui="sidebar-sort-button"]') as HTMLButtonElement)
    expect(container.querySelector('[data-ui="sidebar-search-filters"]')).toBeInTheDocument()
    const branches = Array.from(
      container.querySelectorAll('[data-ui="sidebar-search-filter-toggles"] label'),
    ).find((label) => label.textContent === 'Branches') as HTMLLabelElement
    fireEvent.click(branches)

    expect(container.querySelector('[data-ui="sidebar-search-filters"]')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-ui="sidebar-search-filter-group"]')).toHaveLength(2)
    fireEvent.change(input, { target: { value: 'durable' } })
    await waitFor(() => {
      expect(container.querySelector('[data-ui="sidebar-search-clear"]')).toBeInTheDocument()
    })
    fireEvent.click(
      container.querySelector('[data-ui="sidebar-search-clear"]') as HTMLButtonElement,
    )
    expect(container.querySelector('[data-ui="sidebar-search-filters"]')).not.toBeInTheDocument()
  })

  it('opens archived chats from the archive section while keeping them out of the sidebar', async () => {
    const chat = await createChat({
      title: 'Archived chat',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    await archiveChat(chat.id, 2)
    window.location.hash = '#/storage/archive'
    const { container, findByText } = render(<App />)

    fireEvent.click(await findByText('Archived chat'))

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${chat.id}`)
      expect(container.querySelector('[data-ui="chat-title-bar"]')).toBeInTheDocument()
    })
    expect(container.querySelector('[data-ui="chat-row"]')).not.toBeInTheDocument()
  })

  it('uploads files dropped onto the active chat pane', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    window.location.hash = `#/chat/${chat.id}`
    const { container, findByText } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="main-pane"]')).toBeInTheDocument()
    })
    const mainPane = container.querySelector('[data-ui="main-pane"]') as HTMLElement
    const file = new File(['drop upload body'], 'drop-note.txt', { type: 'text/plain' })
    const dataTransfer = {
      types: ['Files'],
      files: [file],
      dropEffect: 'none',
    }

    fireEvent.dragOver(mainPane, { dataTransfer })
    fireEvent.drop(mainPane, { dataTransfer })

    expect(await findByText('drop-note.txt')).toBeInTheDocument()
    await waitFor(() => {
      expect(
        container.querySelector('[data-ui="attachment-file-card"][data-storage="local"]'),
      ).toBeInTheDocument()
    })
  })

  it('downloads sidebar rows from the last-updated branch without leaving the chat route', async () => {
    const chat = await createChat({
      title: 'Export Me',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    const root: Message = {
      id: 'root',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'root',
      turnIndex: 0,
      createdAt: 2,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'root prompt' }],
      nodeVersion: 0,
      deleted: false,
    }
    const older: Message = {
      ...root,
      id: 'older',
      parentId: root.id,
      siblingIndex: 0,
      turnId: 'older',
      createdAt: 3,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'older answer' }],
    }
    const latest: Message = {
      ...older,
      id: 'latest',
      siblingIndex: 1,
      turnId: 'latest',
      createdAt: 4,
      content: [{ type: 'output_text', text: 'latest answer' }],
    }
    await getDb().messages.bulkPut([root, older, latest])
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'root prompt',
      lastUpdatedLeafId: latest.id,
      lastBranchUpdatedAt: 5,
      updatedAt: 5,
    })
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createdBlobs: Blob[] = []
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        createdBlobs.push(blob)
        return 'blob:natter-export'
      }),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      window.location.hash = `#/chat/${chat.id}`

      const { container } = render(<App />)
      await waitFor(() => {
        expect(container.querySelector('[data-ui="chat-row-menu-button"]')).toBeInTheDocument()
      })
      fireEvent.click(
        container.querySelector('[data-ui="chat-row-menu-button"]') as HTMLButtonElement,
      )
      fireEvent.click(container.querySelector('[data-ui="chat-row-download"]') as HTMLButtonElement)

      await waitFor(() => {
        expect(clickSpy).toHaveBeenCalled()
      })
      expect(window.location.hash).toMatch(new RegExp(`^#/chat/${chat.id}(?:/message/[^/]+)?$`))
      expect(createdBlobs).toHaveLength(1)
      const text = await (createdBlobs[0] as Blob).text()
      expect(text).toContain('latest answer')
      expect(text).not.toContain('older answer')
    } finally {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectURL,
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectURL,
      })
    }
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

  it('loading a preset replaces provider routing sort and clears the edited marker', async () => {
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
    presetASettings.providerPrefs = { sort: 'throughput' }
    const presetA = await createPreset({
      name: 'Throughput preset',
      connectionProfileId: profile.id,
      settings: presetASettings,
    })
    const presetBSettings = cloneDefaultChatSettings()
    presetBSettings.profileId = profile.id
    presetBSettings.model = 'anthropic/claude-opus-4.7'
    presetBSettings.providerPrefs = { sort: 'price' }
    const presetB = await createPreset({
      name: 'Price preset',
      connectionProfileId: profile.id,
      settings: presetBSettings,
    })
    const chat = await createChat({
      settings: structuredClone(presetA.settings),
      presetId: presetA.id,
    })

    window.location.hash = `#/chat/${chat.id}`
    const { container } = render(<App />)
    await waitFor(() => {
      expect(container.querySelector('[data-role="settings-cog"]')).toBeInTheDocument()
    })
    fireEvent.click(container.querySelector('[data-role="settings-cog"]') as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="preset-breadcrumb-button"]')).toBeInTheDocument()
    })
    fireEvent.click(
      container.querySelector('[data-ui="preset-breadcrumb-button"]') as HTMLButtonElement,
    )
    let loadButton: HTMLButtonElement | undefined
    await waitFor(() => {
      loadButton = Array.from(
        container.querySelectorAll<HTMLButtonElement>('[data-ui="preset-menu-load"]'),
      ).find((button) => button.textContent?.includes('Price preset'))
      expect(loadButton).toBeDefined()
    })
    fireEvent.click(loadButton as HTMLButtonElement)

    await waitFor(async () => {
      const row = await getDb().chats.get(chat.id)
      expect(row?.presetId).toBe(presetB.id)
      expect(row?.settings.providerPrefs).toEqual({ sort: 'price' })
      expect(container.querySelector('[data-ui="preset-diverged"]')).toBeNull()
    })
  })
})
