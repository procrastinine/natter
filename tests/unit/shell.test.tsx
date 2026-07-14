import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import type { ChatStreamChunk } from '../../src/api/types'
import { App } from '../../src/app/App'
import {
  __composeKnownBranchPageForTests,
  __rebaseBranchSnapshotForTests,
} from '../../src/app/Shell'
import { cursorKeyOf } from '../../src/core/active-path'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, ConnectionProfile, Message } from '../../src/core/types'
import { sendText } from '../../src/hooks/useChat'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { getBrowserRepository } from '../../src/store/browser-repo'
import { rebuildChatSidebarProjection } from '../../src/store/chat-sidebar-projection'
import { archiveChat, createChat, updateChatSettings } from '../../src/store/chats'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { createFolder } from '../../src/store/folders'
import { exportChat } from '../../src/store/import-export'
import { __resetKeyCacheForTests, createKey } from '../../src/store/keys'
import { type MessageHeaderRow, splitMessageForStorage } from '../../src/store/message-storage'
import { putCachedModels } from '../../src/store/models-cache'
import { createPreset, getPreset } from '../../src/store/presets'
import { createProfile } from '../../src/store/profiles'
import type { ActiveBranchPageSnapshot } from '../../src/store/repository'
import { __resetSearchSessionRunnerForTests } from '../../src/store/search-session'
import { setSetting } from '../../src/store/settings'
import {
  __resetStreamLeasesForTests,
  __setStreamLockManagerForTests,
  STREAM_LEASE_TTL_MS,
} from '../../src/store/stream-leases'
import { createTag } from '../../src/store/tags'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { __resetSearchStoreForTests } from '../../src/store/zustand/searchStore'
import { useStreamStore } from '../../src/store/zustand/streamStore'
import { useUiStore } from '../../src/store/zustand/uiStore'
import { readActiveSeedState } from '../../src/ui/header/ConnectionHeader'
import { putTestMessageHeaderOnly, putTestMessages } from '../helpers/message-storage'

function pageHeader(id: string, parentId: string | null, index: number): MessageHeaderRow {
  return {
    id,
    chatId: 'page-chat',
    parentId,
    siblingIndex: 0,
    turnId: id,
    turnIndex: index,
    createdAt: index,
    role: index % 2 === 0 ? 'user' : 'assistant',
    origin: index % 2 === 0 ? 'user' : 'generated',
    bodyVersion: 7,
    bodyWordCount: 1,
    textPreview: id,
    nodeVersion: 0,
    deleted: false,
  }
}

function pageMessage(header: MessageHeaderRow): Message {
  return {
    id: header.id,
    chatId: header.chatId,
    parentId: header.parentId,
    siblingIndex: header.siblingIndex,
    turnId: header.turnId,
    turnIndex: header.turnIndex,
    createdAt: header.createdAt,
    role: header.role,
    origin: header.origin,
    content: [{ type: 'text', text: `Body ${header.id}` }],
    nodeVersion: header.nodeVersion,
    deleted: header.deleted,
  }
}

describe('active branch page composition', () => {
  it('rebases structural headers without copying bodies and rejects a changed body version', () => {
    const pageRow = pageHeader('page-root', null, 0)
    const body = pageMessage(pageRow)
    const authoritative = { ...pageRow, siblingIndex: 3, nodeVersion: 1 }
    const authoritativePath = [authoritative]
    const page: ActiveBranchPageSnapshot = {
      chatId: pageRow.chatId,
      pageMessages: [body],
      pageHeaders: [pageRow],
      pageOffset: 0,
      pageLimit: 1,
      branchLength: 1,
    }
    const composed = __composeKnownBranchPageForTests(
      pageRow.chatId,
      [pageRow.id],
      authoritativePath,
      new Map([[authoritative.id, authoritative]]),
      page,
    )

    expect(composed?.branchHeaders[0]).toBe(authoritative)
    expect(composed?.branchWindow[0]?.siblingIndex).toBe(3)
    expect(composed?.branchWindow[0]?.content).toBe(body.content)
    expect(composed?.branchWindow[0]).not.toHaveProperty('bodyVersion')
    expect(composed?.branchWindow[0]).not.toHaveProperty('bodyWordCount')
    expect(composed?.branchWindow[0]).not.toHaveProperty('textPreview')
    expect(
      __rebaseBranchSnapshotForTests(composed as NonNullable<typeof composed>, authoritativePath),
    ).toBe(composed)

    const changedBody = { ...authoritative, bodyVersion: authoritative.bodyVersion + 1 }
    expect(
      __composeKnownBranchPageForTests(
        pageRow.chatId,
        [pageRow.id],
        [changedBody],
        new Map([[changedBody.id, changedBody]]),
        page,
      ),
    ).toBeNull()
  })

  it('validates only the requested window when the exact path is already known', () => {
    const length = 10_000
    const windowSize = 16
    const headers = Array.from({ length }, (_, index) =>
      pageHeader(`page-${index}`, index === 0 ? null : `page-${index - 1}`, index),
    )
    let indexedHeaderReads = 0
    const knownPath = new Proxy(headers, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/u.test(key)) indexedHeaderReads += 1
        return Reflect.get(target, key, receiver) as unknown
      },
    })
    const pageHeaders = headers.slice(-windowSize)
    const page: ActiveBranchPageSnapshot = {
      chatId: 'page-chat',
      pageMessages: pageHeaders.map(pageMessage),
      pageHeaders,
      pageOffset: length - windowSize,
      pageLimit: windowSize,
      branchLength: length,
    }
    const result = __composeKnownBranchPageForTests(
      'page-chat',
      headers.map((header) => header.id),
      knownPath,
      new Map(pageHeaders.map((header) => [header.id, header])),
      page,
    )

    expect(result?.branchWindow).toHaveLength(windowSize)
    expect(indexedHeaderReads).toBe(windowSize * 2)
  })
})

describe('shell smoke render', () => {
  let errorSpy: MockInstance<typeof console.error>
  let warnSpy: MockInstance<typeof console.warn>
  const DB_NAME = 'natter'
  const DIRECT_MODEL_AUTOSELECT_QUERY = {} as const

  async function resetAll() {
    __resetBroadcastForTests()
    __resetKeyCacheForTests()
    __resetSearchSessionRunnerForTests()
    __resetSearchStoreForTests()
    __resetStreamLeasesForTests()
    useChatStore.getState().reset()
    useStreamStore.getState().reset()
    useUiStore.getState().reset()
    __resetWorkspaceRepositoryForTests()
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

  it('mounts sidebar, first-run connection action, and main-pane regions', async () => {
    const { container } = render(<App />)
    expect(container.querySelector('[data-ui="app-shell"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="sidebar"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="main-pane"]')).toBeInTheDocument()
    // With no saved profiles, the old full-width connection header is gone;
    // only the first-run Add connection action remains.
    await waitFor(() => {
      expect(container.querySelector('[data-ui="connection-empty-action"]')).toBeInTheDocument()
    })
    expect(container.querySelector('[data-ui="connection-header"]')).not.toBeInTheDocument()
    // The shell no longer renders a separate top-of-shell <header> region —
    // the chat title row (only present when a chat is active) is `[data-ui=
    // "chat-title-bar"]` inside main-pane.
    expect(container.querySelector('[data-ui="header"]')).toBeNull()
  })

  it('keeps the sidebar on the storage chats page', async () => {
    window.location.hash = '#/storage/chats'

    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="storage-chats"]')).toBeInTheDocument()
    })
    expect(container.querySelector('[data-ui="app-shell"]')).not.toHaveAttribute(
      'data-sidebar-hidden',
    )
    expect(container.querySelector('[data-ui="sidebar"]')).toBeInTheDocument()
  })

  it('imports a chat from the sidebar toolbar', async () => {
    const source = await createChat({ id: 'chat-alpha', title: 'Alpha', now: 1000 })
    const envelope = await exportChat(source.id)
    window.location.hash = '#/'

    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="sidebar-import-chat"]')).toBeInTheDocument()
    })
    const input = container.querySelector<HTMLInputElement>('[data-ui="sidebar-chat-import-input"]')
    expect(input).toBeTruthy()

    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [new File([JSON.stringify(envelope)], 'chat.json', { type: 'application/json' })],
      },
    })

    await waitFor(async () => {
      const chats = await getDb().chats.orderBy('createdAt').toArray()
      expect(chats).toHaveLength(2)
      expect(chats[1]?.id).not.toBe(source.id)
      expect(window.location.hash).toMatch(/^#\/chat\//)
    })
  })

  it('keeps no-op new-chat visits out of IndexedDB', async () => {
    window.location.hash = '#/new'

    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="composer"]')).toBeInTheDocument()
    })
    expect(window.location.hash).toBe('#/new')
    expect(await getDb().chats.count()).toBe(0)
    expect(await getDb().messages.count()).toBe(0)

    window.location.hash = '#/new'
    window.dispatchEvent(new HashChangeEvent('hashchange'))

    await waitFor(() => {
      expect(container.querySelector('[data-ui="composer"]')).toBeInTheDocument()
    })
    expect(await getDb().chats.count()).toBe(0)

    window.location.hash = '#/'
    window.dispatchEvent(new HashChangeEvent('hashchange'))

    await waitFor(() => {
      expect(window.location.hash).toBe('#/')
    })
    expect(await getDb().chats.count()).toBe(0)
  })

  it('updates lastViewedAt when a chat route opens', async () => {
    const chat = await createChat({ id: 'chat-viewed', title: 'Viewed', now: 1000 })
    await getDb().chats.update(chat.id, {
      previewText: 'Viewed preview',
      updatedAt: 5000,
      lastViewedAt: 1000,
    })
    window.location.hash = `#/chat/${chat.id}`

    render(<App />)

    await waitFor(async () => {
      const stored = await getDb().chats.get(chat.id)
      expect(stored?.lastViewedAt).toBeGreaterThan(1000)
      expect(stored?.updatedAt).toBe(5000)
    })
  })

  it('retries a fresh no-Web-Locks orphan when its lease TTL expires', async () => {
    __setStreamLockManagerForTests(null)
    const chat = await createChat({ id: 'chat-orphan-retry', title: 'Orphan retry' })
    const meta = await getDb().settings.get('workspace-meta')
    const replacementEpoch = (meta?.value as { replacementEpoch?: number } | undefined)
      ?.replacementEpoch
    expect(replacementEpoch).toBeTypeOf('number')
    await getDb().streamLeases.put({
      streamId: 'fresh-message-less-orphan',
      chatId: chat.id,
      ownerClientId: 'closed-tab',
      fenceToken: 'closed-tab-fence',
      replacementEpoch: replacementEpoch as number,
      startedAt: Date.now() - STREAM_LEASE_TTL_MS,
      heartbeatAt: Date.now() - STREAM_LEASE_TTL_MS + 300,
      attemptKind: 'generation',
    })
    window.location.hash = `#/chat/${chat.id}`

    render(<App />)

    await waitFor(
      async () => {
        expect(await getDb().streamLeases.get('fresh-message-less-orphan')).toBeUndefined()
      },
      { timeout: 2_000 },
    )
  })

  it('does not rewrite an existing chat model just because the chat route opens', async () => {
    const openAiKey = await createKey({ name: 'OpenAI', plaintextKey: 'sk-test' })
    const openAi = await createProfile({
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyRef: openAiKey.id,
    })
    await putCachedModels(openAi.id, DIRECT_MODEL_AUTOSELECT_QUERY, {
      data: [{ id: 'gpt-5.4' }],
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = openAi.id
    settings.model = 'openai/gpt-5.4'
    const chat = await createChat({ id: 'chat-model-viewed', title: 'Viewed model', settings })
    await getDb().chats.update(chat.id, {
      updatedAt: 5000,
      lastViewedAt: 1000,
    })
    window.location.hash = `#/chat/${chat.id}`

    render(<App />)

    await waitFor(async () => {
      const stored = await getDb().chats.get(chat.id)
      expect(stored?.lastViewedAt).toBeGreaterThan(1000)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const stored = await getDb().chats.get(chat.id)
    expect(stored?.settings.model).toBe('openai/gpt-5.4')
    expect(stored?.updatedAt).toBe(5000)
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

  it('opens chat settings synchronously without mounting an empty transcript', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    window.location.hash = `#/chat/${chat.id}`
    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-role="settings-cog"]')).toBeInTheDocument()
    })
    expect(container.querySelector('[data-ui="message-list"]')).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('Loading conversation…')

    fireEvent.click(container.querySelector('[data-role="settings-cog"]') as HTMLButtonElement)

    expect(container.querySelector('[data-ui="chat-model-panel"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="app-shell"]')).toHaveAttribute(
      'data-chat-model-panel',
      'open',
    )
    expect(container).not.toHaveTextContent('Loading chat settings…')
    expect(container.querySelector('[data-ui="message-list"]')).not.toBeInTheDocument()
  })

  it('renders configured connection access beside the active chat title', async () => {
    const key = await createKey({
      name: 'OpenRouter',
      plaintextKey: 'sk-or-v1-test-0000000000000000000000000000',
    })
    const profile = await createProfile({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: key.id,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    const chat = await createChat({ settings })
    window.location.hash = `#/chat/${chat.id}`

    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="connection-provider-button"]')).toBeInTheDocument()
    })
    expect(
      container.querySelector(
        '[data-ui="main-pane"] > [data-ui="connection-header"][data-state="configured"]',
      ),
    ).not.toBeInTheDocument()
    expect(
      container.querySelector('[data-ui="connection-provider-button"][data-kind="openrouter"]'),
    ).toBeInTheDocument()

    fireEvent.click(container.querySelector('[data-ui="connection-provider-button"]') as Element)
    await waitFor(() => {
      expect(
        container.querySelector(
          '[data-ui="connection-header"][data-state="configured"][data-variant="popover"]',
        ),
      ).toBeInTheDocument()
    })
  })

  it('auto-selects the crosswalk-equivalent model when switching connections', async () => {
    const openRouterKey = await createKey({ name: 'OpenRouter', plaintextKey: 'sk-or-v1-test' })
    const openAiKey = await createKey({ name: 'OpenAI', plaintextKey: 'sk-test' })
    const openRouter = await createProfile({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: openRouterKey.id,
    })
    const openAi = await createProfile({
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyRef: openAiKey.id,
    })
    await putCachedModels(openAi.id, DIRECT_MODEL_AUTOSELECT_QUERY, {
      data: [{ id: 'gpt-5.4' }, { id: 'gpt-4o' }],
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = openRouter.id
    settings.model = 'openai/gpt-5.4'
    const chat = await createChat({ settings })
    window.location.hash = `#/chat/${chat.id}`

    const { container } = render(<App />)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="connection-provider-button"]')).toBeInTheDocument()
    })
    fireEvent.click(container.querySelector('[data-ui="connection-provider-button"]') as Element)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="connection-profile-select"]')).toBeInTheDocument()
    })
    fireEvent.change(container.querySelector('[data-ui="connection-profile-select"]') as Element, {
      target: { value: openAi.id },
    })

    await waitFor(async () => {
      const stored = await getDb().chats.get(chat.id)
      expect(stored?.settings.profileId).toBe(openAi.id)
      expect(stored?.settings.model).toBe('gpt-5.4')
    })
  })

  it('leaves the model unselected when the switched connection has no equivalent model', async () => {
    const openRouterKey = await createKey({ name: 'OpenRouter', plaintextKey: 'sk-or-v1-test' })
    const anthropicKey = await createKey({ name: 'Anthropic', plaintextKey: 'sk-ant-test' })
    const openRouter = await createProfile({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: openRouterKey.id,
    })
    const anthropic = await createProfile({
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKeyRef: anthropicKey.id,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = openRouter.id
    settings.model = 'openai/gpt-5.4'
    const chat = await createChat({ settings })
    window.location.hash = `#/chat/${chat.id}`

    const { container } = render(<App />)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="connection-provider-button"]')).toBeInTheDocument()
    })
    fireEvent.click(container.querySelector('[data-ui="connection-provider-button"]') as Element)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="connection-profile-select"]')).toBeInTheDocument()
    })
    fireEvent.change(container.querySelector('[data-ui="connection-profile-select"]') as Element, {
      target: { value: anthropic.id },
    })

    await waitFor(async () => {
      const stored = await getDb().chats.get(chat.id)
      expect(stored?.settings.profileId).toBe(anthropic.id)
      expect(stored?.settings.model).toBe('')
    })
  })

  it('auto-selects an Anthropic direct model from bundled rows when switching from OpenRouter', async () => {
    const openRouterKey = await createKey({ name: 'OpenRouter', plaintextKey: 'sk-or-v1-test' })
    const anthropicKey = await createKey({ name: 'Anthropic', plaintextKey: 'sk-ant-test' })
    const openRouter = await createProfile({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: openRouterKey.id,
    })
    const anthropic = await createProfile({
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKeyRef: anthropicKey.id,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = openRouter.id
    settings.model = 'anthropic/claude-opus-4.7'
    const chat = await createChat({ settings })
    window.location.hash = `#/chat/${chat.id}`

    const { container } = render(<App />)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="connection-provider-button"]')).toBeInTheDocument()
    })
    fireEvent.click(container.querySelector('[data-ui="connection-provider-button"]') as Element)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="connection-profile-select"]')).toBeInTheDocument()
    })
    fireEvent.change(container.querySelector('[data-ui="connection-profile-select"]') as Element, {
      target: { value: anthropic.id },
    })

    await waitFor(async () => {
      const stored = await getDb().chats.get(chat.id)
      expect(stored?.settings.profileId).toBe(anthropic.id)
      expect(stored?.settings.model).toBe('claude-opus-4.7')
    })
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

  it('returns from tree view immediately when the chat has no messages', async () => {
    const chat = await createChat({ title: 'Empty tree', settings: cloneDefaultChatSettings() })
    window.location.hash = `#/chat/${chat.id}`
    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-role="chat-branch-tree"]')).toBeInTheDocument()
      expect(container.querySelector('[data-ui="composer"]')).toBeInTheDocument()
    })
    const treeButton = container.querySelector(
      '[data-role="chat-branch-tree"]',
    ) as HTMLButtonElement

    fireEvent.click(treeButton)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="branch-tree-view"]')).toBeVisible()
    })

    fireEvent.click(treeButton)
    await waitFor(() => {
      expect(useUiStore.getState().treeViewChatId).toBeNull()
      expect(container.querySelector('[data-ui="branch-tree-view"]')).not.toBeVisible()
      expect(container.querySelector('[data-ui="composer"]')).toBeVisible()
    })
  })

  it('opens a header-only tree without mounting the transcript, composer, or message bodies', async () => {
    const chat = await createChat({ title: 'Cold tree', settings: cloneDefaultChatSettings() })
    const root: Message = {
      id: 'cold-tree-root',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'cold-tree-root',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'poison body must stay cold' }],
      nodeVersion: 0,
      deleted: false,
    }
    const child: Message = {
      ...root,
      id: 'cold-tree-child',
      parentId: root.id,
      turnId: 'cold-tree-child',
      createdAt: 2,
      role: 'assistant',
      origin: 'generated',
    }
    await putTestMessageHeaderOnly(root)
    await putTestMessageHeaderOnly(child)
    await getDb().chats.put({ ...chat, lastUpdatedLeafId: child.id })
    useUiStore.getState().setEditTreeMode(true)
    useUiStore.getState().setTreeViewChatId(chat.id)
    window.location.hash = `#/chat/${chat.id}`

    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="branch-tree-view"]')).toBeInTheDocument()
      expect(container.querySelectorAll('[data-ui="branch-tree-node"]')).toHaveLength(2)
      expect(container.querySelector('[data-role="chat-branch-tree"]')).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    })
    expect(container.querySelector('[data-ui="message-list"]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-ui="composer"]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-ui="focus-mode-toggle"]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-ui="tree-density-toggle"]')).toBeInTheDocument()
    expect(
      container.querySelector(
        '[data-ui="branch-tree-canvas-pane"] [data-ui="tree-density-toggle"]',
      ),
    ).toBeInTheDocument()
    expect(container.querySelector('[data-connector-hit]')).toBeInTheDocument()
    const editTreeButton = container.querySelector(
      '[data-role="chat-edit-tree"]',
    ) as HTMLButtonElement
    expect(editTreeButton).toBeDisabled()
    expect(editTreeButton).toHaveAttribute('title', 'Return to conversation to edit the tree')
    fireEvent.click(editTreeButton)
    expect(container.querySelector('[data-ui="edit-tree-toolbar"]')).not.toBeInTheDocument()
    await waitFor(() => expect(useUiStore.getState().editTreeMode).toBe(false))
  })

  it('keeps the branch cursor and tree workspace state across view roundtrips', async () => {
    const chat = await createChat({
      id: 'chat-retained-tree-view',
      title: 'Retained tree view',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    const root: Message = {
      id: 'retained-tree-root',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'retained-tree-root',
      turnIndex: 0,
      createdAt: 2,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'retained tree prompt' }],
      nodeVersion: 0,
      deleted: false,
    }
    const selectedLeaf: Message = {
      ...root,
      id: 'retained-tree-selected-leaf',
      parentId: root.id,
      siblingIndex: 0,
      turnId: 'retained-tree-selected-leaf',
      createdAt: 4,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'selected branch answer' }],
    }
    const inspectedSibling: Message = {
      ...selectedLeaf,
      id: 'retained-tree-inspected-sibling',
      siblingIndex: 1,
      turnId: 'retained-tree-inspected-sibling',
      createdAt: 3,
      content: [{ type: 'output_text', text: 'inspected sibling answer' }],
    }
    await putTestMessages([root, selectedLeaf, inspectedSibling])
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      lastUpdatedLeafId: selectedLeaf.id,
      lastBranchUpdatedAt: selectedLeaf.createdAt,
      updatedAt: selectedLeaf.createdAt,
    })
    window.location.hash = `#/chat/${chat.id}/message/${selectedLeaf.id}`

    const { container, findByText } = render(<App />)

    expect(await findByText('selected branch answer')).toBeInTheDocument()
    await waitFor(() => {
      expect(useChatStore.getState().getCursor(chat.id)).toEqual({
        [cursorKeyOf(null)]: root.id,
        [cursorKeyOf(root.id)]: selectedLeaf.id,
      })
    })
    const cursorBeforeToggle = { ...useChatStore.getState().getCursor(chat.id) }
    const treeButton = container.querySelector(
      '[data-role="chat-branch-tree"]',
    ) as HTMLButtonElement

    fireEvent.click(treeButton)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="branch-tree-view"]')).toBeVisible()
    })
    fireEvent.click(
      container.querySelector(`[data-message-id="${inspectedSibling.id}"]`) as Element,
    )
    await waitFor(() => {
      expect(container.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        inspectedSibling.id,
      )
    })
    const searchInput = container.querySelector(
      '[data-ui="branch-tree-search-input"]',
    ) as HTMLInputElement
    fireEvent.change(searchInput, { target: { value: 'state-retention-query' } })
    expect(searchInput).toHaveValue('state-retention-query')
    expect(useChatStore.getState().getCursor(chat.id)).toEqual(cursorBeforeToggle)

    fireEvent.click(treeButton)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="message-list"]')).toBeVisible()
      expect(container.querySelector('[data-ui="branch-tree-view"]')).not.toBeVisible()
    })
    expect(useChatStore.getState().getCursor(chat.id)).toEqual(cursorBeforeToggle)

    fireEvent.click(treeButton)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="branch-tree-view"]')).toBeVisible()
    })
    expect(container.querySelector('[data-ui="branch-tree-search-input"]')).toHaveValue(
      'state-retention-query',
    )
    expect(container.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      inspectedSibling.id,
    )
    expect(useChatStore.getState().getCursor(chat.id)).toEqual(cursorBeforeToggle)

    fireEvent.click(container.querySelector(`[data-message-id="${selectedLeaf.id}"]`) as Element)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        selectedLeaf.id,
      )
    })
    fireEvent.click(
      container.querySelector(
        '[data-ui="branch-tree-inspector"] [data-action="toggle-visible"]',
      ) as Element,
    )
    await waitFor(() => {
      expect(
        container.querySelector(
          `[data-ui="branch-tree-node"][data-message-id="${selectedLeaf.id}"]`,
        ),
      ).toHaveAttribute('data-hidden-from-context', 'true')
    })

    fireEvent.click(treeButton)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="message-list"]')).toBeVisible()
    })
    const activeMessage = container.querySelector(
      `[data-ui="message"][data-message-id="${selectedLeaf.id}"]`,
    )
    expect(activeMessage?.querySelector('[data-action="toggle-visible"]')).toHaveAttribute(
      'aria-label',
      'Show in context (send to model)',
    )
    expect(useChatStore.getState().getCursor(chat.id)).toEqual(cursorBeforeToggle)
  })

  it('returns to the active streaming branch when tree view interrupts its reload', async () => {
    const chat = await createChat({
      id: 'chat-stream-tree-handoff',
      title: 'Streaming tree handoff',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    const root: Message = {
      id: 'stream-tree-root',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'stream-tree-root',
      turnIndex: 0,
      createdAt: 2,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'stream tree prompt' }],
      nodeVersion: 0,
      deleted: false,
    }
    const originalLeaf: Message = {
      ...root,
      id: 'stream-tree-original',
      parentId: root.id,
      turnId: 'stream-tree-original',
      createdAt: 3,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'stable answer before stream' }],
    }
    const streamingLeaf: Message = {
      ...originalLeaf,
      id: 'stream-tree-live',
      siblingIndex: 1,
      turnId: 'stream-tree-live',
      createdAt: 4,
      content: [{ type: 'output_text', text: '' }],
    }
    await putTestMessages([root, originalLeaf])
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      lastUpdatedLeafId: originalLeaf.id,
      lastBranchUpdatedAt: 3,
      updatedAt: 3,
    })
    window.location.hash = `#/chat/${chat.id}`

    const { container, findByText, queryByText } = render(<App />)

    expect(await findByText('stable answer before stream')).toBeInTheDocument()

    await putTestMessages([streamingLeaf])
    await getDb().chats.update(chat.id, {
      lastUpdatedLeafId: streamingLeaf.id,
      lastBranchUpdatedAt: 4,
      updatedAt: 4,
    })
    act(() => {
      useChatStore.getState().navigateToCursor(chat.id, {
        [cursorKeyOf(null)]: root.id,
        [cursorKeyOf(root.id)]: streamingLeaf.id,
      })
      useStreamStore.getState().setActive({
        streamId: 'stream-tree-handoff',
        replacementEpoch: 0,
        chatId: chat.id,
        messageId: streamingLeaf.id,
        startedAt: 4,
        ownerClientId: 'test-client',
      })
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'stream-tree-handoff',
        replacementEpoch: 0,
        chatId: chat.id,
        messageId: streamingLeaf.id,
        content: [{ type: 'output_text', text: 'live answer in progress' }],
        textLength: 23,
        reasoningLength: 0,
        updatedAt: 5,
      })
    })

    const treeButton = container.querySelector(
      '[data-role="chat-branch-tree"]',
    ) as HTMLButtonElement
    fireEvent.click(treeButton)
    expect(treeButton).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(treeButton)

    const staleAnswer = queryByText('stable answer before stream')
    if (staleAnswer) expect(staleAnswer).not.toBeVisible()
    await waitFor(() => {
      expect(container.querySelector('[data-ui="message-list"]')).toBeVisible()
    })
    const transcript = container.querySelector('[data-ui="message-list"]')
    expect(transcript).toBeInTheDocument()
    expect(
      await within(transcript as HTMLElement).findByText('live answer in progress'),
    ).toBeVisible()
    expect(transcript?.querySelector('[data-ui="message"]')).toBeInTheDocument()
    expect(transcript).not.toHaveTextContent('stable answer before stream')
  })

  it('does not let a never-settling branch presentation read block generation', async () => {
    const settings = cloneDefaultChatSettings()
    settings.profileId = 'presentation-profile'
    settings.model = 'gpt-4o-mini'
    settings.api = 'chat'
    const chat = await createChat({
      id: 'chat-presentation-read-liveness',
      title: 'Presentation read liveness',
      settings,
      now: 1,
    })
    const connection: ConnectionProfile = {
      id: settings.profileId,
      name: 'OpenAI test',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      appTitle: 'natter',
      appUrl: 'http://localhost:5173',
      apiKeyRef: 'presentation-key',
      defaultHeaders: {},
      supportsEndpointsApi: false,
      supportsGenerationApi: false,
      supportsPrivacyScrape: false,
      createdAt: 1,
      updatedAt: 1,
    }
    window.location.hash = `#/chat/${chat.id}`

    const browserRepo = getBrowserRepository()
    let markPresentationReadStarted!: () => void
    const presentationReadStarted = new Promise<void>((resolve) => {
      markPresentationReadStarted = resolve
    })
    let markStructuralReadStarted!: () => void
    const structuralReadStarted = new Promise<void>((resolve) => {
      markStructuralReadStarted = resolve
    })
    const neverSettlingPresentationRead = new Promise<never>(() => {})
    const neverSettlingStructuralRead = new Promise<never>(() => {})
    const getKnownBranchPageSnapshot = vi.fn(() => {
      markPresentationReadStarted()
      return neverSettlingPresentationRead
    })
    __setWorkspaceRepositoryForTests(
      new Proxy(browserRepo, {
        get(target, property) {
          if (property === 'getKnownBranchPageSnapshot') return getKnownBranchPageSnapshot
          if (property === 'listMessageHeaders') {
            return () => {
              markStructuralReadStarted()
              return neverSettlingStructuralRead
            }
          }
          const value = Reflect.get(target, property) as unknown
          if (typeof value !== 'function') return value
          const callable = value as (...args: unknown[]) => unknown
          return (...args: unknown[]) => callable.apply(target, args)
        },
      }),
    )

    render(<App />)
    await waitFor(() => {
      expect(useUiStore.getState().activeChatId).toBe(chat.id)
    })

    let targetAtProviderOpen: string | undefined
    let persistedTargetAtProviderRead: string | undefined
    const openStream = vi.fn(() => {
      targetAtProviderOpen = useStreamStore.getState().listByChat(chat.id)[0]?.messageId
      return (async function* () {
        await Promise.all([presentationReadStarted, structuralReadStarted])
        persistedTargetAtProviderRead = (await getDb().streamLeases.toArray())[0]?.messageId
        yield {
          type: 'delta',
          chunk: {
            id: 'presentation-independent-generation',
            model: settings.model,
            choices: [{ delta: { content: 'generation survived' }, finish_reason: 'stop' }],
          },
        } satisfies ChatStreamChunk
      })()
    })

    const result = await sendText({
      chatId: chat.id,
      connection,
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'do not wait for presentation' }],
      openStream,
    })

    expect(getKnownBranchPageSnapshot).toHaveBeenCalled()
    expect(openStream).toHaveBeenCalledOnce()
    expect(targetAtProviderOpen).toBe(result.assistantMessageId)
    expect(persistedTargetAtProviderRead).toBe(result.assistantMessageId)
    expect(result.outcome).toBe('done')
    expect(useStreamStore.getState().hasStreamForChat(chat.id)).toBe(false)
    expect(await getDb().streamLeases.count()).toBe(0)
    expect(await browserRepo.getMessage(result.assistantMessageId)).toMatchObject({
      content: [{ type: 'output_text', text: 'generation survived' }],
      generation: { status: 'done' },
    })
  })

  it('keeps a structurally exact retained stream interactive while its body read lags', async () => {
    const chat = await createChat({
      id: 'chat-retained-stream-exact-path',
      title: 'Retained stream exact path',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    const root: Message = {
      id: 'retained-stream-root',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'retained-stream-root',
      turnIndex: 0,
      createdAt: 2,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'retained stream prompt' }],
      nodeVersion: 0,
      deleted: false,
    }
    const assistant: Message = {
      ...root,
      id: 'retained-stream-assistant',
      parentId: root.id,
      turnId: 'retained-stream-assistant',
      createdAt: 3,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'persisted stream prefix' }],
    }
    await putTestMessages([root, assistant])
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      lastUpdatedLeafId: assistant.id,
      lastBranchUpdatedAt: assistant.createdAt,
      updatedAt: assistant.createdAt,
    })
    window.location.hash = `#/chat/${chat.id}`

    const { container, findByText } = render(<App />)
    expect(await findByText('persisted stream prefix')).toBeInTheDocument()

    const browserRepo = getBrowserRepository()
    let markLaggingReadStarted!: () => void
    const laggingReadStarted = new Promise<void>((resolve) => {
      markLaggingReadStarted = resolve
    })
    __setWorkspaceRepositoryForTests(
      new Proxy(browserRepo, {
        get(target, property) {
          if (property === 'getKnownBranchPageSnapshot') {
            return () => {
              markLaggingReadStarted()
              return new Promise<never>(() => {})
            }
          }
          const value = Reflect.get(target, property) as unknown
          if (typeof value !== 'function') return value
          const callable = value as (...args: unknown[]) => unknown
          return (...args: unknown[]) => callable.apply(target, args)
        },
      }),
    )

    await act(async () => {
      await putTestMessages([
        {
          ...assistant,
          nodeVersion: 1,
          generation: {
            id: '',
            model: 'stream-model',
            requestedModel: 'stream-model',
            apiUsed: 'chat',
            delivery: 'streaming',
            status: 'streaming',
            integrity: 'clean',
            costSource: 'stream',
            startedAt: 4,
          },
        },
      ])
      useStreamStore.getState().setActive({
        streamId: 'retained-structure-stream',
        replacementEpoch: 0,
        chatId: chat.id,
        messageId: assistant.id,
        startedAt: 4,
        ownerClientId: 'test-client',
      })
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'retained-structure-stream',
        replacementEpoch: 0,
        chatId: chat.id,
        messageId: assistant.id,
        content: [{ type: 'output_text', text: 'live retained stream content' }],
        textLength: 28,
        reasoningLength: 0,
        updatedAt: 5,
      })
    })
    await laggingReadStarted

    await waitFor(() => {
      expect(container.querySelector('[data-ui="message-list"]')).not.toHaveAttribute('inert')
      expect(
        container.querySelector(`[data-ui="message"][data-message-id="${assistant.id}"]`),
      ).toHaveAttribute('aria-busy', 'true')
    })
    expect(await findByText('live retained stream content')).toBeInTheDocument()
    expect(
      container.querySelector(`[data-message-id="${assistant.id}"] [data-ui="markdown-segment"]`),
    ).toHaveAttribute('data-mode', 'streaming')
  })

  it('keeps the loaded branch interactive while geometric older pages resolve', async () => {
    await setSetting('global:message-render-window-size', 10)
    await setSetting('global:message-render-window-load-mode', 'manual')
    const chat = await createChat({
      id: 'chat-geometric-body-pages',
      title: 'Geometric body pages',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    const messages: Message[] = []
    for (let index = 0; index < 35; index += 1) {
      const id = `geometric-message-${index}`
      const role = index % 2 === 0 ? 'user' : 'assistant'
      messages.push({
        id,
        chatId: chat.id,
        parentId: messages.at(-1)?.id ?? null,
        siblingIndex: 0,
        turnId: id,
        turnIndex: index,
        createdAt: index + 2,
        role,
        origin: role === 'user' ? 'user' : 'generated',
        content: [
          role === 'user'
            ? { type: 'text', text: `geometric body ${index}` }
            : { type: 'output_text', text: `geometric body ${index}` },
        ],
        nodeVersion: 0,
        deleted: false,
      })
    }
    await putTestMessages(messages)
    const leaf = messages.at(-1) as Message
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      lastUpdatedLeafId: leaf.id,
      lastBranchUpdatedAt: leaf.createdAt,
      updatedAt: leaf.createdAt,
    })

    const browserRepo = getBrowserRepository()
    const requestedLimits: number[] = []
    const releases: Array<() => void> = []
    __setWorkspaceRepositoryForTests(
      new Proxy(browserRepo, {
        get(target, property) {
          if (property === 'getKnownBranchPageSnapshot') {
            return async (...args: Parameters<typeof target.getKnownBranchPageSnapshot>) => {
              const page = args[2]
              requestedLimits.push(page.limit)
              if (page.limit > 10) {
                await new Promise<void>((resolve) => releases.push(resolve))
              }
              return target.getKnownBranchPageSnapshot(...args)
            }
          }
          const value = Reflect.get(target, property) as unknown
          if (typeof value !== 'function') return value
          const callable = value as (...args: unknown[]) => unknown
          return (...args: unknown[]) => callable.apply(target, args)
        },
      }),
    )
    window.location.hash = `#/chat/${chat.id}`
    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelectorAll('[data-ui="message"]')).toHaveLength(10)
    })
    fireEvent.click(container.querySelector('[data-ui="load-more-messages"]') as Element)
    await waitFor(() => expect(requestedLimits).toContain(20))
    expect(container.querySelectorAll('[data-ui="message"]')).toHaveLength(10)
    expect(container.querySelector('[data-ui="message-list"]')).not.toHaveAttribute('inert')
    expect(container.querySelector('[data-ui="composer"] textarea')).not.toBeDisabled()

    releases.shift()?.()
    await waitFor(() => {
      expect(container.querySelectorAll('[data-ui="message"]')).toHaveLength(20)
    })
    fireEvent.click(container.querySelector('[data-ui="load-more-messages"]') as Element)
    await waitFor(() => expect(requestedLimits).toContain(35))
    expect(container.querySelectorAll('[data-ui="message"]')).toHaveLength(20)
    expect(container.querySelector('[data-ui="message-list"]')).not.toHaveAttribute('inert')

    releases.shift()?.()
    await waitFor(() => {
      expect(container.querySelectorAll('[data-ui="message"]')).toHaveLength(35)
      expect(container.querySelector('[data-ui="load-more-messages"]')).not.toBeInTheDocument()
    })
    expect(requestedLimits).toEqual([10, 20, 35])
  })

  it('renders the active chat without hydrating irrelevant chat or branch bodies', async () => {
    const active = await createChat({
      title: 'Active huge-safe',
      settings: cloneDefaultChatSettings(),
    })
    const other = await createChat({ title: 'Other poison', settings: cloneDefaultChatSettings() })
    const root: Message = {
      id: 'ui-root',
      chatId: active.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'ui-root',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'visible active prompt' }],
      nodeVersion: 0,
      deleted: false,
    }
    const activeLeaf: Message = {
      ...root,
      id: 'ui-active-leaf',
      parentId: root.id,
      turnId: 'ui-active-leaf',
      createdAt: 3,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'visible active answer' }],
    }
    const offBranch: Message = {
      ...activeLeaf,
      id: 'ui-off-branch-poison',
      siblingIndex: 1,
      createdAt: 2,
      content: [{ type: 'output_text', text: 'off branch body should not load' }],
    }
    const otherMessage: Message = {
      ...root,
      id: 'ui-other-chat-poison',
      chatId: other.id,
      content: [{ type: 'text', text: 'other chat body should not load' }],
    }
    await putTestMessages([root, activeLeaf])
    await putTestMessageHeaderOnly(offBranch)
    await putTestMessageHeaderOnly(otherMessage)
    await getDb().chats.bulkPut([
      {
        ...active,
        titleStatus: 'manual',
        previewText: 'visible active prompt',
        lastUpdatedLeafId: activeLeaf.id,
      },
      {
        ...other,
        titleStatus: 'manual',
        previewText: 'poison preview',
        lastUpdatedLeafId: otherMessage.id,
      },
    ])
    window.location.hash = `#/chat/${active.id}`

    const { findByText } = render(<App />)

    expect(await findByText('visible active prompt')).toBeInTheDocument()
    expect(await findByText('visible active answer')).toBeInTheDocument()
  })

  it('keeps an open default branch pinned when a newer sibling leaf arrives', async () => {
    const chat = await createChat({
      title: 'Pinned Branch',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    const root: Message = {
      id: 'pin-root',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'pin-root',
      turnIndex: 0,
      createdAt: 2,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'pin prompt' }],
      nodeVersion: 0,
      deleted: false,
    }
    const originalLeaf: Message = {
      ...root,
      id: 'pin-original-leaf',
      parentId: root.id,
      siblingIndex: 0,
      turnId: 'pin-original-leaf',
      createdAt: 3,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'original branch answer' }],
    }
    const newerSibling: Message = {
      ...originalLeaf,
      id: 'pin-newer-sibling',
      siblingIndex: 1,
      turnId: 'pin-newer-sibling',
      createdAt: 4,
      content: [{ type: 'output_text', text: 'newer sibling answer' }],
    }
    await putTestMessages([root, originalLeaf])
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'pin prompt',
      lastUpdatedLeafId: originalLeaf.id,
      lastBranchUpdatedAt: 3,
      updatedAt: 3,
    })
    window.location.hash = `#/chat/${chat.id}`

    const { container, findByText, queryByText } = render(<App />)

    expect(await findByText('original branch answer')).toBeInTheDocument()
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${chat.id}/message/${originalLeaf.id}`)
    })

    await putTestMessages([newerSibling])
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'pin prompt',
      lastUpdatedLeafId: newerSibling.id,
      lastBranchUpdatedAt: 4,
      updatedAt: 4,
    })

    await waitFor(() => {
      expect(container.querySelector('[data-ui="branch-count"]')).toHaveTextContent('1 / 2')
      expect(window.location.hash).toBe(`#/chat/${chat.id}/message/${originalLeaf.id}`)
      expect(queryByText('original branch answer')).toBeInTheDocument()
      expect(queryByText('newer sibling answer')).not.toBeInTheDocument()
    })
  })

  it('honors a repeated arrival at a message URL in the same mounted tab', async () => {
    const chat = await createChat({ title: 'Repeated route', now: 1 })
    const root: Message = {
      id: 'repeat-route-root',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'repeat-route-root',
      turnIndex: 0,
      createdAt: 2,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'repeat route prompt' }],
      nodeVersion: 0,
      deleted: false,
    }
    const first: Message = {
      ...root,
      id: 'repeat-route-first',
      parentId: root.id,
      turnId: 'repeat-route-first',
      createdAt: 3,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'first route answer' }],
    }
    const second: Message = {
      ...first,
      id: 'repeat-route-second',
      siblingIndex: 1,
      turnId: 'repeat-route-second',
      createdAt: 4,
      content: [{ type: 'output_text', text: 'second route answer' }],
    }
    await putTestMessages([root, first, second])
    await getDb().chats.put({
      ...chat,
      lastUpdatedLeafId: second.id,
      lastBranchUpdatedAt: 4,
      updatedAt: 4,
    })
    window.location.hash = `#/chat/${chat.id}/message/${first.id}`

    const { findByText, queryByText } = render(<App />)
    expect(await findByText('first route answer')).toBeInTheDocument()

    act(() => {
      window.location.hash = `#/chat/${chat.id}/message/${second.id}`
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(await findByText('second route answer')).toBeInTheDocument()
    expect(queryByText('first route answer')).not.toBeInTheDocument()

    act(() => {
      window.location.hash = `#/chat/${chat.id}/message/${first.id}`
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(await findByText('first route answer')).toBeInTheDocument()
    expect(queryByText('second route answer')).not.toBeInTheDocument()
  })

  it('keeps the retained branch painted but inert while a repeated message URL is resolving', async () => {
    const chat = await createChat({ title: 'Delayed repeated route', now: 1 })
    const root: Message = {
      id: 'delayed-route-root',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'delayed-route-root',
      turnIndex: 0,
      createdAt: 2,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'delayed route prompt' }],
      nodeVersion: 0,
      deleted: false,
    }
    const first: Message = {
      ...root,
      id: 'delayed-route-first',
      parentId: root.id,
      turnId: 'delayed-route-first',
      createdAt: 3,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'retained route answer' }],
    }
    const second: Message = {
      ...first,
      id: 'delayed-route-second',
      siblingIndex: 1,
      turnId: 'delayed-route-second',
      createdAt: 4,
      content: [{ type: 'output_text', text: 'resolved route answer' }],
    }
    await putTestMessages([root, first, second])
    await getDb().chats.put({
      ...chat,
      lastUpdatedLeafId: second.id,
      lastBranchUpdatedAt: 4,
      updatedAt: 4,
    })
    window.location.hash = `#/chat/${chat.id}/message/${first.id}`

    const { container, findByText, queryByText } = render(<App />)
    expect(await findByText('retained route answer')).toBeInTheDocument()

    const browserRepo = getBrowserRepository()
    let resolveFreshHeaders!: (
      headers: Awaited<ReturnType<typeof browserRepo.listMessageHeaders>>,
    ) => void
    const freshHeaders = new Promise<Awaited<ReturnType<typeof browserRepo.listMessageHeaders>>>(
      (resolve) => {
        resolveFreshHeaders = resolve
      },
    )
    __setWorkspaceRepositoryForTests(
      new Proxy(browserRepo, {
        get(target, property) {
          if (property === 'listMessageHeaders') return () => freshHeaders
          const value = Reflect.get(target, property) as unknown
          if (typeof value !== 'function') return value
          const callable = value as (...args: unknown[]) => unknown
          return (...args: unknown[]) => callable.apply(target, args)
        },
      }),
    )

    act(() => {
      window.location.hash = `#/chat/${chat.id}/message/${second.id}`
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    await waitFor(() => {
      expect(container.querySelector('[data-ui="message-list"]')).toHaveAttribute(
        'data-presentation-only',
        'true',
      )
    })
    expect(queryByText('retained route answer')).toBeInTheDocument()
    expect(queryByText('resolved route answer')).not.toBeInTheDocument()
    expect(container.querySelector('[data-ui="message-list"]')).toHaveAttribute('inert')
    expect(container.querySelector('[data-ui="composer-input"]')).toBeDisabled()
    expect(container.querySelector('[data-ui="composer-import-at-end"]')).toBeDisabled()

    fireEvent.keyDown(window, { key: 'V', shiftKey: true, metaKey: true })
    expect(container.querySelector('[data-ui="import-modal"]')).not.toBeInTheDocument()

    const rows = [root, first, second].map((message) => splitMessageForStorage(message).header)
    await act(async () => {
      resolveFreshHeaders(rows)
      await freshHeaders
    })

    expect(await findByText('resolved route answer')).toBeInTheDocument()
    await waitFor(() => {
      expect(container.querySelector('[data-ui="message-list"]')).not.toHaveAttribute(
        'data-presentation-only',
      )
    })
    expect(queryByText('retained route answer')).not.toBeInTheDocument()
    expect(container.querySelector('[data-ui="composer-input"]')).not.toBeDisabled()
    expect(container.querySelector('[data-ui="composer-import-at-end"]')).not.toBeDisabled()
  })

  it('canonicalizes a loaded chat URL whose message target does not exist', async () => {
    const chat = await createChat({ title: 'Missing route target', now: 1 })
    const root: Message = {
      id: 'missing-route-root',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'missing-route-root',
      turnIndex: 0,
      createdAt: 2,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'missing route prompt' }],
      nodeVersion: 0,
      deleted: false,
    }
    const leaf: Message = {
      ...root,
      id: 'missing-route-leaf',
      parentId: root.id,
      turnId: 'missing-route-leaf',
      createdAt: 3,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'canonical route answer' }],
    }
    await putTestMessages([root, leaf])
    await getDb().chats.put({
      ...chat,
      lastUpdatedLeafId: leaf.id,
      lastBranchUpdatedAt: 3,
      updatedAt: 3,
    })
    window.location.hash = `#/chat/${chat.id}/message/not-a-message`

    const { container, findByText } = render(<App />)

    expect(await findByText('canonical route answer')).toBeInTheDocument()
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${chat.id}/message/${leaf.id}`)
    })
    expect(container.querySelector('[data-ui="message-list"]')).not.toHaveAttribute(
      'data-presentation-only',
    )
    expect(container.querySelector('[data-ui="composer-input"]')).not.toBeDisabled()
  })

  it('pins a remotely extended path before a newer sibling can replace it', async () => {
    const chat = await createChat({
      title: 'Sticky Extension',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    const root: Message = {
      id: 'sticky-root',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'sticky-root',
      turnIndex: 0,
      createdAt: 2,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'sticky prompt' }],
      nodeVersion: 0,
      deleted: false,
    }
    const initialLeaf: Message = {
      ...root,
      id: 'sticky-initial-leaf',
      parentId: root.id,
      turnId: 'sticky-initial-leaf',
      createdAt: 3,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'initial sticky answer' }],
    }
    const remoteUser: Message = {
      ...root,
      id: 'sticky-remote-user',
      parentId: initialLeaf.id,
      turnId: 'sticky-remote-turn',
      createdAt: 4,
      content: [{ type: 'text', text: 'remote linear extension' }],
    }
    const acceptedLeaf: Message = {
      ...initialLeaf,
      id: 'sticky-accepted-leaf',
      parentId: remoteUser.id,
      turnId: 'sticky-remote-turn',
      createdAt: 5,
      content: [{ type: 'output_text', text: 'accepted remote answer' }],
    }
    const newerSibling: Message = {
      ...acceptedLeaf,
      id: 'sticky-newer-sibling',
      siblingIndex: 1,
      turnId: 'sticky-newer-sibling',
      createdAt: 6,
      content: [{ type: 'output_text', text: 'newer remote sibling' }],
    }
    await putTestMessages([root, initialLeaf])
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'sticky prompt',
      lastUpdatedLeafId: initialLeaf.id,
      lastBranchUpdatedAt: 3,
      updatedAt: 3,
    })
    window.location.hash = `#/chat/${chat.id}`

    const { container, findByText, queryByText } = render(<App />)

    expect(await findByText('initial sticky answer')).toBeInTheDocument()
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${chat.id}/message/${initialLeaf.id}`)
    })
    const originalList = container.querySelector('[data-ui="message-list"]')
    expect(originalList).toBeInTheDocument()

    await putTestMessages([remoteUser, acceptedLeaf])
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'remote linear extension',
      lastUpdatedLeafId: acceptedLeaf.id,
      lastBranchUpdatedAt: 5,
      updatedAt: 5,
    })

    expect(await findByText('accepted remote answer')).toBeInTheDocument()
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${chat.id}/message/${acceptedLeaf.id}`)
      expect(useChatStore.getState().getCursor(chat.id)?.[cursorKeyOf(initialLeaf.id)]).toBe(
        remoteUser.id,
      )
      expect(useChatStore.getState().getCursor(chat.id)?.[cursorKeyOf(remoteUser.id)]).toBe(
        acceptedLeaf.id,
      )
    })
    expect(container.querySelector('[data-ui="message-list"]')).toBe(originalList)

    await putTestMessages([newerSibling])
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'newer remote sibling',
      lastUpdatedLeafId: newerSibling.id,
      lastBranchUpdatedAt: 6,
      updatedAt: 6,
    })

    await waitFor(() => {
      expect(container.querySelector('[data-ui="branch-count"]')).toHaveTextContent('1 / 2')
      expect(window.location.hash).toBe(`#/chat/${chat.id}/message/${acceptedLeaf.id}`)
      expect(queryByText('accepted remote answer')).toBeInTheDocument()
      expect(queryByText('newer remote sibling')).not.toBeInTheDocument()
    })
    expect(useChatStore.getState().getCursor(chat.id)?.[cursorKeyOf(remoteUser.id)]).toBe(
      acceptedLeaf.id,
    )
    expect(container.querySelector('[data-ui="message-list"]')).toBe(originalList)
    expect(container.querySelector('[data-ui="surface-loading"]')).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('Loading conversation…')
  })

  it('does not overwrite a local cursor advance before the new leaf is observable', async () => {
    const chat = await createChat({
      title: 'Local Advance',
      settings: cloneDefaultChatSettings(),
      now: 1,
    })
    const root: Message = {
      id: 'advance-root',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'advance-root',
      turnIndex: 0,
      createdAt: 2,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'advance prompt' }],
      nodeVersion: 0,
      deleted: false,
    }
    const originalLeaf: Message = {
      ...root,
      id: 'advance-original-leaf',
      parentId: root.id,
      siblingIndex: 0,
      turnId: 'advance-original-leaf',
      createdAt: 3,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'old local answer' }],
    }
    const localLeaf: Message = {
      ...originalLeaf,
      id: 'advance-local-leaf',
      siblingIndex: 1,
      turnId: 'advance-local-leaf',
      createdAt: 4,
      content: [{ type: 'output_text', text: 'new local answer' }],
    }
    await putTestMessages([root, originalLeaf])
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'advance prompt',
      lastUpdatedLeafId: originalLeaf.id,
      lastBranchUpdatedAt: 3,
      updatedAt: 3,
    })
    window.location.hash = `#/chat/${chat.id}`

    const { container, findByText, queryByText } = render(<App />)

    expect(await findByText('old local answer')).toBeInTheDocument()
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${chat.id}/message/${originalLeaf.id}`)
    })
    const originalList = container.querySelector('[data-ui="message-list"]')
    expect(originalList).toBeInTheDocument()

    act(() => {
      const store = useChatStore.getState()
      const intent = store.beginNavigationIntent(chat.id)
      store.selectPathForIntent(
        chat.id,
        intent,
        {
          [cursorKeyOf(null)]: root.id,
          [cursorKeyOf(root.id)]: localLeaf.id,
        },
        [root.id, localLeaf.id],
      )
    })

    expect(useChatStore.getState().getCursor(chat.id)?.[cursorKeyOf(root.id)]).toBe(localLeaf.id)
    expect(container.querySelector('[data-ui="message-list"]')).toBe(originalList)
    expect(container.querySelector('[data-ui="surface-loading"]')).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('Loading conversation…')
    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${chat.id}/message/${localLeaf.id}`)
    })

    const { header, body } = splitMessageForStorage(localLeaf)
    const db = getDb()
    await db.transaction('rw', db.messages, db.messageBodies, async () => {
      await db.messages.put(header)
      await db.messageBodies.put(body)
    })
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'advance prompt',
      lastUpdatedLeafId: localLeaf.id,
      lastBranchUpdatedAt: 4,
      updatedAt: 4,
    })

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${chat.id}/message/${localLeaf.id}`)
      expect(queryByText('new local answer')).toBeInTheDocument()
    })
    expect(container.querySelector('[data-ui="message-list"]')).toBe(originalList)
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

  it('keeps the chat settings panel attached when new chat is clicked while it is open', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    window.location.hash = `#/chat/${chat.id}`
    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-role="settings-cog"]')).toBeInTheDocument()
    })
    fireEvent.click(container.querySelector('[data-role="settings-cog"]') as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="settings-pane-title"]')).toHaveTextContent(
        'Chat settings',
      )
    })

    fireEvent.click(container.querySelector('[data-role="new-chat"]') as HTMLAnchorElement)

    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/chat\//)
      expect(window.location.hash).not.toBe(`#/chat/${chat.id}`)
      expect(container.querySelector('[data-ui="settings-pane-title"]')).toHaveTextContent(
        'Chat settings',
      )
      expect(container.querySelector('[data-ui="model-picker"]')).toBeInTheDocument()
    })
    const newChatId = window.location.hash.replace('#/chat/', '')
    await waitFor(async () => {
      const stored = await getDb().chats.get(newChatId)
      expect(stored?.temporary).toBe(true)
    })
  })

  it('leaves Cmd/Ctrl+N to the browser and uses Cmd/Ctrl+Shift+O for new chat', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    window.location.hash = `#/chat/${chat.id}`
    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-role="new-chat"]')).toBeInTheDocument()
    })
    const originalHash = window.location.hash
    const browserNewWindow = new KeyboardEvent('keydown', {
      key: 'n',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    await act(async () => {
      window.dispatchEvent(browserNewWindow)
    })
    expect(browserNewWindow.defaultPrevented).toBe(false)
    expect(window.location.hash).toBe(originalHash)

    const browserNewWindowCtrl = new KeyboardEvent('keydown', {
      key: 'n',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    await act(async () => {
      window.dispatchEvent(browserNewWindowCtrl)
    })
    expect(browserNewWindowCtrl.defaultPrevented).toBe(false)
    expect(window.location.hash).toBe(originalHash)

    const natterNewChat = new KeyboardEvent('keydown', {
      key: 'O',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    await act(async () => {
      window.dispatchEvent(natterNewChat)
    })
    expect(natterNewChat.defaultPrevented).toBe(true)
    await waitFor(() => expect(window.location.hash).toBe('#/new'))
  })

  it('focus mode keeps an open chat settings panel visible', async () => {
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

    fireEvent.click(container.querySelector('[data-ui="focus-mode-toggle"]') as HTMLButtonElement)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="app-shell"]')).toHaveAttribute(
        'data-focus-mode',
        'on',
      )
      expect(container.querySelector('[data-ui="chat-model-panel"]')).toBeInTheDocument()
      expect(container.querySelector('[data-ui="app-shell"]')).toHaveAttribute(
        'data-chat-model-panel',
        'open',
      )
    })

    fireEvent.click(container.querySelector('[data-ui="focus-mode-toggle"]') as HTMLButtonElement)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="app-shell"]')).toHaveAttribute(
        'data-focus-mode',
        'off',
      )
      expect(container.querySelector('[data-ui="chat-model-panel"]')).toBeInTheDocument()
      expect(container.querySelector('[data-ui="app-shell"]')).toHaveAttribute(
        'data-chat-model-panel',
        'open',
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
    await rebuildChatSidebarProjection(getDb())

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
    await rebuildChatSidebarProjection(getDb())

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

  it('virtualizes large folder-backed sidebar lists while preserving tag chips', async () => {
    const folder = await createFolder({ id: 'folder-virtualized', name: 'Virtualized', now: 1 })
    const tag = await createTag({ id: 'tag-virtualized', name: 'VirtualTag', now: 1 })
    const baseSettings = cloneDefaultChatSettings()
    const chats: Chat[] = Array.from({ length: 225 }, (_, index) => ({
      id: `virtual-chat-${index}`,
      title: index === 224 ? 'Virtual tagged chat' : `Virtual chat ${index}`,
      titleStatus: 'manual',
      createdAt: index + 1,
      updatedAt: index + 1,
      lastViewedAt: index + 1,
      wordCount: 0,
      totalCostUsd: 0,
      metaVersion: 0,
      summaryVersion: 0,
      settings: structuredClone(baseSettings),
      lastUpdatedLeafId: null,
      lastBranchUpdatedAt: index + 1,
      archived: false,
      pinned: false,
      folderId: folder.id,
      tags: index === 224 ? [tag.id] : [],
      previewText: `preview ${index}`,
    }))
    await getDb().chats.bulkPut(chats)
    await rebuildChatSidebarProjection(getDb())
    await setSetting('global:sidebar-render-window-size', 250)

    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="chat-list"]')).toHaveAttribute(
        'data-virtualized',
        'true',
      )
    })
    expect(container.querySelector('[data-ui="folder-header"]')).toHaveTextContent('Virtualized')
    expect(container.querySelector('[data-ui="chat-row-title"]')).toHaveTextContent(
      'Virtual tagged chat',
    )
    expect(container.querySelector('[data-ui="chat-row-tag"]')).toHaveTextContent('VirtualTag')
    expect(container.querySelectorAll('[data-ui="chat-row"]').length).toBeLessThan(80)
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
    await putTestMessages([root, older, latest])
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
    await putTestMessages([root, older, latest])
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
    await rebuildChatSidebarProjection(getDb())
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
    const rowLink = await waitFor(() => {
      const found = Array.from(
        container.querySelectorAll<HTMLAnchorElement>('[data-ui="chat-row-link"]'),
      ).find((link) => link.getAttribute('href') === `#/chat/${chat.id}`)
      if (!found) throw new Error('Expected chat row link')
      return found
    })
    fireEvent.mouseDown(rowLink)
    fireEvent.blur(input, { relatedTarget: rowLink })
    fireEvent.click(rowLink)
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
    await putTestMessages([root, older, latest])
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

  it('marks presets edited for visible context toggles and hidden provider tool buckets', async () => {
    const key = await createKey({ name: 'OpenRouter', plaintextKey: 'sk-or-v1-test' })
    const profile = await createProfile({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: key.id,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    settings.model = 'openai/gpt-5.4-nano'
    const preset = await createPreset({
      name: 'Unified settings preset',
      connectionProfileId: profile.id,
      settings,
    })
    const chat = await createChat({
      settings: structuredClone(preset.settings),
      presetId: preset.id,
    })

    window.location.hash = `#/chat/${chat.id}`
    const { container } = render(<App />)
    await waitFor(() => {
      expect(container.querySelector('[data-role="settings-cog"]')).toBeInTheDocument()
    })
    fireEvent.click(container.querySelector('[data-role="settings-cog"]') as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="preset-breadcrumb-button"]')).toBeInTheDocument()
      expect(container.querySelector('[data-ui="preset-diverged"]')).toBeNull()
    })

    fireEvent.click(container.querySelector('[data-tab="context"]') as HTMLButtonElement)
    await waitFor(() => {
      expect(findLabel(container, 'Tool calls')).toBeTruthy()
    })
    fireEvent.click(findLabel(container, 'Tool calls').querySelector('input') as HTMLInputElement)

    await waitFor(async () => {
      expect((await getDb().chats.get(chat.id))?.settings.toolCallContext.include).toBe(false)
      expect(container.querySelector('[data-ui="preset-diverged"]')).toBeInTheDocument()
    })

    await saveCurrentSettingsToCurrentPreset(container)
    await waitFor(async () => {
      expect((await getPreset(preset.id))?.settings.toolCallContext.include).toBe(false)
      expect(container.querySelector('[data-ui="preset-diverged"]')).toBeNull()
    })

    const stored = await getDb().chats.get(chat.id)
    if (!stored) throw new Error('Expected chat')
    await updateChatSettings(chat.id, {
      tools: {
        ...stored.settings.tools,
        openai: {
          ...stored.settings.tools.openai,
          enabledServerToolIds: ['web-search'],
        },
      },
    })

    await waitFor(() => {
      expect(container.querySelector('[data-ui="preset-diverged"]')).toBeInTheDocument()
    })
    await saveCurrentSettingsToCurrentPreset(container)
    await waitFor(async () => {
      const saved = await getPreset(preset.id)
      expect(saved?.settings.tools.openai.enabledServerToolIds).toEqual(['web-search'])
      expect(container.querySelector('[data-ui="preset-diverged"]')).toBeNull()
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
      ).find((button) => button.textContent.includes('Price preset'))
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

  it('loading a saved preset from another connection applies its model in one click', async () => {
    const openRouterKey = await createKey({ name: 'OpenRouter', plaintextKey: 'sk-or-v1-test' })
    const googleKey = await createKey({ name: 'Google', plaintextKey: 'sk-google-test' })
    const openRouter = await createProfile({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: openRouterKey.id,
    })
    const google = await createProfile({
      name: 'Google',
      kind: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKeyRef: googleKey.id,
    })

    const googleSettings = cloneDefaultChatSettings()
    googleSettings.profileId = google.id
    googleSettings.model = 'google/gemini-3.1-flash-lite-preview'
    const googlePreset = await createPreset({
      name: 'Google preset',
      connectionProfileId: google.id,
      settings: googleSettings,
    })
    const openRouterSettings = cloneDefaultChatSettings()
    openRouterSettings.profileId = openRouter.id
    openRouterSettings.model = 'openai/gpt-5.4-nano'
    const openRouterPreset = await createPreset({
      name: 'OpenRouter preset',
      connectionProfileId: openRouter.id,
      settings: openRouterSettings,
    })
    const chat = await createChat({
      settings: structuredClone(googlePreset.settings),
      presetId: googlePreset.id,
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
      ).find((button) => button.textContent.includes('OpenRouter preset'))
      expect(loadButton).toBeDefined()
    })
    fireEvent.click(loadButton as HTMLButtonElement)

    await waitFor(async () => {
      const row = await getDb().chats.get(chat.id)
      expect(row?.presetId).toBe(openRouterPreset.id)
      expect(row?.settings.profileId).toBe(openRouter.id)
      expect(row?.settings.model).toBe('openai/gpt-5.4-nano')
      expect(container.querySelector('[data-ui="preset-diverged"]')).toBeNull()
      expect(container.textContent).not.toContain('Pick a model for OpenRouter')
    })
  })
})

function findLabel(container: HTMLElement, text: string): HTMLLabelElement {
  const label = Array.from(container.querySelectorAll<HTMLLabelElement>('label')).find((item) =>
    item.textContent.includes(text),
  )
  if (!label) throw new Error(`Expected label: ${text}`)
  return label
}

async function saveCurrentSettingsToCurrentPreset(container: HTMLElement): Promise<void> {
  const button = container.querySelector(
    '[data-ui="preset-breadcrumb-button"]',
  ) as HTMLButtonElement
  fireEvent.click(button)
  let saveButton: HTMLButtonElement | undefined
  await waitFor(() => {
    const menu = container.querySelector('[data-ui="preset-breadcrumb-menu"]')
    expect(menu).toBeInTheDocument()
    saveButton = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('[data-ui="field-inline-action"]') ?? [],
    ).find((item) => item.textContent === 'save')
    expect(saveButton).toBeDefined()
  })
  fireEvent.click(saveButton as HTMLButtonElement)
}
