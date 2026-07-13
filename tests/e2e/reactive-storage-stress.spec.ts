import { expect, type Page, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
  waitForAssistantGenerationFinished,
} from './helpers'

test.describe.configure({ timeout: 60_000 })

test.beforeEach(async ({ page }) => {
  await mockOpenRouterDiscovery(page)
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('reactive storage survives lifecycle churn, abort, reload, and peer writes exactly', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'reactive-seed', content: 'reactive seed reply', finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'reactive seed prompt')
  await expect(page.locator('[data-ui="abort"]')).toHaveCount(0)
  const chatId = await firstChatId(page)
  await waitForAssistantGenerationFinished(page, chatId)

  const peer = await page.context().newPage()
  await peer.goto(`/#/chat/${chatId}`)
  await expect(peer.locator('[data-ui="chat-title-label"]')).toHaveText('Untitled chat')

  for (let cycle = 0; cycle < 16; cycle += 1) {
    await page.evaluate(() => {
      window.location.hash = '#/new'
    })
    await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('New chat')
    await page.evaluate((id) => {
      window.location.hash = `#/chat/${id}`
    }, chatId)
    await expect(page.locator('[data-ui="message"]')).toHaveCount(2)
  }

  await drainAuthoritativeWrites(page)
  await startTitleTransitionRecorder(page)
  const beforePeerTitles = await readReactiveState(page, chatId)
  const peerTitles = ['Peer title 1', 'Peer title 2', 'Peer title 3', 'Peer title 4']
  for (const title of peerTitles) {
    await commitTitle(peer, title)
    await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText(title)
  }
  expect(await stopTitleTransitionRecorder(page)).toEqual(peerTitles)
  const afterPeerTitles = await readReactiveState(page, chatId)
  expect(afterPeerTitles.workspaceMutationCounter - beforePeerTitles.workspaceMutationCounter).toBe(
    peerTitles.length,
  )

  await page.locator('[data-role="chat-title-edit"]').click()
  const concurrentTitle = page.locator('[data-ui="chat-title-editor"]')
  await concurrentTitle.fill('Concurrent title')
  await peer.locator('[data-role="settings-cog"]').click()
  await peer.locator('[data-ui="settings-tab"][data-tab="prompts"]').click()
  await peer.locator('[data-ui="system-prompt-textarea"]').fill('Concurrent system prompt')
  const beforeConcurrentWrites = await readReactiveState(page, chatId)
  await Promise.all([
    concurrentTitle.press('Enter'),
    peer.locator('[data-role="settings-pane-close"]').click(),
  ])
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('Concurrent title')
  await expect
    .poll(async () => (await readReactiveState(page, chatId)).systemPrompt)
    .toBe('Concurrent system prompt')
  const afterConcurrentWrites = await readReactiveState(page, chatId)
  expect(
    afterConcurrentWrites.workspaceMutationCounter -
      beforeConcurrentWrites.workspaceMutationCounter,
  ).toBe(2)

  await peer.locator('[data-role="chat-title-edit"]').click()
  const reloadTitle = peer.locator('[data-ui="chat-title-editor"]')
  await reloadTitle.fill('Reload winner')
  const beforeReloadWrite = await readReactiveState(peer, chatId)
  await Promise.all([page.reload(), reloadTitle.press('Enter')])
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('Reload winner')
  await drainAuthoritativeWrites(page)
  const afterReloadWrite = await readReactiveState(page, chatId)
  expect(afterReloadWrite.metaVersion - beforeReloadWrite.metaVersion).toBe(1)
  expect(afterReloadWrite.workspaceMutationCounter).toBeGreaterThan(
    beforeReloadWrite.workspaceMutationCounter,
  )

  await peer.locator('[data-role="chat-title-edit"]').click()
  const unmountedTitle = peer.locator('[data-ui="chat-title-editor"]')
  await unmountedTitle.fill('Published after unmount')
  await Promise.all([
    page.evaluate(() => {
      window.location.hash = '#/new'
    }),
    unmountedTitle.press('Enter'),
  ])
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('New chat')
  await expect(page.locator('[data-ui="message-list"]')).toHaveCount(0)
  await page.evaluate((id) => {
    window.location.hash = `#/chat/${id}`
  }, chatId)
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('Published after unmount')

  let markAbortRequestSeen!: () => void
  const abortRequestSeen = new Promise<void>((resolve) => {
    markAbortRequestSeen = resolve
  })
  let releaseAbortResponse!: () => void
  const abortResponseGate = new Promise<void>((resolve) => {
    releaseAbortResponse = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
    markAbortRequestSeen()
    await abortResponseGate
    await route
      .fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: buildSseBody([{ id: 'too-late', content: 'must not persist', finish: 'stop' }]),
      })
      .catch(() => {})
  })
  await sendMessage(page, 'abort this reactive stream')
  await abortRequestSeen
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  await page.locator('[data-ui="abort"]').click()
  releaseAbortResponse()
  await expect(page.locator('[data-ui="message-error"][data-role="abort"]')).toBeVisible()
  await expect
    .poll(async () => {
      const state = await readReactiveState(page, chatId)
      return { leases: state.streamLeaseCount, chunks: state.streamChunkCount }
    })
    .toEqual({ leases: 0, chunks: 0 })

  await page.reload()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(4)
  await drainAuthoritativeWrites(page)
  const finalState = await readReactiveState(page, chatId)
  expect(finalState.title).toBe('Published after unmount')
  expect(finalState.systemPrompt).toBe('Concurrent system prompt')
  expect(finalState.messages).toHaveLength(4)
  expect(finalState.messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
  ])
  expect(finalState.messages.at(-1)).toMatchObject({
    role: 'assistant',
    content: [{ type: 'output_text', text: '' }],
    abortReason: 'user',
  })
  expect(finalState.streamLeaseCount).toBe(0)
  expect(finalState.streamChunkCount).toBe(0)
  expect(finalState.metaVersion).toBe(beforePeerTitles.metaVersion + peerTitles.length + 4)
  expect((await readReactiveState(page, chatId)).workspaceMutationCounter).toBe(
    finalState.workspaceMutationCounter,
  )
  await peer.close()
})

async function commitTitle(page: Page, title: string): Promise<void> {
  await page.locator('[data-role="chat-title-edit"]').click()
  const editor = page.locator('[data-ui="chat-title-editor"]')
  await editor.fill(title)
  await editor.press('Enter')
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText(title)
}

async function mockOpenRouterDiscovery(page: Page): Promise<void> {
  const modelId = 'google/gemini-3.1-flash-lite-preview:free'
  const supportedParameters = ['provider', 'temperature', 'max_completion_tokens']
  const architecture = {
    input_modalities: ['text'],
    output_modalities: ['text'],
    tokenizer: 'gemini',
  }
  await page.context().route('https://openrouter.ai/api/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: modelId,
            name: modelId,
            context_length: 131_072,
            architecture,
            pricing: { prompt: '0', completion: '0' },
            supported_parameters: supportedParameters,
          },
        ],
      }),
    })
  })
  await page.context().route('https://openrouter.ai/api/v1/models/**/endpoints', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: modelId,
          name: modelId,
          context_length: 131_072,
          architecture,
          endpoints: [
            {
              provider_name: 'Deterministic fixture',
              supported_parameters: supportedParameters,
              context_length: 131_072,
              max_prompt_tokens: 131_072,
              max_completion_tokens: 4096,
              pricing: { prompt: '0', completion: '0' },
            },
          ],
        },
      }),
    })
  })
}

async function drainAuthoritativeWrites(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.locks.request('workspace:authoritative', { mode: 'exclusive' }, () => undefined)
  })
}

async function startTitleTransitionRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const label = document.querySelector('[data-ui="chat-title-label"]')
    if (!label) throw new Error('chat title label missing')
    const win = window as Window & {
      __titleTransitions?: string[]
      __titleTransitionObserver?: MutationObserver
    }
    win.__titleTransitions = []
    win.__titleTransitionObserver?.disconnect()
    win.__titleTransitionObserver = new MutationObserver(() => {
      const title = label.textContent
      const transitions = win.__titleTransitions ?? []
      if (transitions.at(-1) !== title) transitions.push(title)
    })
    win.__titleTransitionObserver.observe(label, {
      childList: true,
      characterData: true,
      subtree: true,
    })
  })
}

async function stopTitleTransitionRecorder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const win = window as Window & {
      __titleTransitions?: string[]
      __titleTransitionObserver?: MutationObserver
    }
    win.__titleTransitionObserver?.disconnect()
    const transitions = win.__titleTransitions ?? []
    delete win.__titleTransitions
    delete win.__titleTransitionObserver
    return transitions
  })
}

async function readReactiveState(
  page: Page,
  chatId: string,
): Promise<{
  title: string
  systemPrompt: string | undefined
  metaVersion: number
  summaryVersion: number
  workspaceMutationCounter: number
  streamLeaseCount: number
  streamChunkCount: number
  messages: Array<{
    role: string
    content: unknown
    abortReason: string | undefined
  }>
}> {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('natter')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const readRow = (storeName: string, key: IDBValidKey) =>
      new Promise<unknown>((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly')
        const request = transaction.objectStore(storeName).get(key)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const readRows = (storeName: string, indexName: string, key: IDBValidKey) =>
      new Promise<unknown[]>((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly')
        const request = transaction.objectStore(storeName).index(indexName).getAll(key)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    try {
      const [chat, headers, bodies, workspaceMeta, leases, chunks] = await Promise.all([
        readRow('chats', id),
        readRows('messages', 'chatId', id),
        readRows('messageBodies', 'chatId', id),
        readRow('settings', 'workspace-meta'),
        readRows('streamLeases', 'chatId', id),
        readRows('streamChunks', 'chatId', id),
      ])
      const chatRow = chat as {
        title: string
        settings?: { systemPrompt?: string }
        metaVersion: number
        summaryVersion: number
      }
      const bodyById = new Map(
        (bodies as Array<{ id: string; content?: unknown }>).map((body) => [body.id, body]),
      )
      const messages = (
        headers as Array<{
          id: string
          role: string
          createdAt: number
          generation?: { abortReason?: string }
        }>
      )
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((header) => ({
          role: header.role,
          content: bodyById.get(header.id)?.content,
          abortReason: header.generation?.abortReason,
        }))
      return {
        title: chatRow.title,
        systemPrompt: chatRow.settings?.systemPrompt,
        metaVersion: chatRow.metaVersion,
        summaryVersion: chatRow.summaryVersion,
        workspaceMutationCounter: Number(
          (workspaceMeta as { value?: { mutationCounter?: number } } | undefined)?.value
            ?.mutationCounter ?? 0,
        ),
        streamLeaseCount: leases.length,
        streamChunkCount: chunks.length,
        messages,
      }
    } finally {
      db.close()
    }
  }, chatId)
}
