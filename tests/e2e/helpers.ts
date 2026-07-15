// Most send-pipeline specs use `mockChatCompletions`; timing, concurrency, and
// retention specs retarget a normal connection to the standalone fake provider.
// Neither path burns live quota. Live-API specs live in `*.live.spec.ts` and gate
// on `process.env.RUN_LIVE === '1'`.

import type { Message } from '../../src/core/types'
import {
  previewTextFromStoredProjection,
  splitMessageForStorage,
} from '../../src/store/message-storage'
import { expect, type Page } from './fixtures'

export interface IndexedDbDump {
  dbName: string
  exportedAt?: string
  stores: Record<string, unknown[]>
}

interface SeedOptions {
  apiKey?: string
  model?: string
  disablePrivacyFilter?: boolean
  corsProxyUrl?: string
}

const DEFAULT_E2E_MODEL = 'google/gemini-3.1-flash-lite-preview:free'

// Open the first-run Add connection action and submit a stub key. `apiKey`
// defaults to a harmless placeholder because the route-mocked specs never hit
// OpenRouter. Use `seedReal(page)` when the spec needs the real key from
// `key.txt`.
export async function seedFirstRun(page: Page, opts: SeedOptions = {}): Promise<void> {
  const apiKey = opts.apiKey ?? 'sk-or-v1-test-00000000000000000000000000000000000000000000'
  const model = opts.model ?? DEFAULT_E2E_MODEL
  const currentUrl = new URL(page.url())
  if (currentUrl.pathname !== '/' || currentUrl.hash) await page.goto('/')
  await page.locator('[data-ui="connection-add"]').click()
  const input = page.locator('[data-ui="connection-setup-key"]')
  await input.fill(apiKey)
  await page.locator('[data-ui="connection-setup-submit"]').click()
  // The modal closes automatically once the seed completes; wait for it.
  await page.locator('[data-ui="connection-setup-modal"]').waitFor({ state: 'detached' })
  // Once configured, the first-run Add connection action disappears; active
  // chats expose connection editing through the provider icon in the title row.
  await page.locator('[data-ui="connection-empty-action"]').waitFor({
    state: 'detached',
  })
  if (opts.corsProxyUrl !== undefined) {
    await page.evaluate(async (corsProxyUrl) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('natter')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('settings', 'readwrite')
          tx.objectStore('settings').put({ key: 'global:cors-proxy-url', value: corsProxyUrl })
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } finally {
        db.close()
      }
    }, opts.corsProxyUrl)
    await page.reload()
    await page.locator('[data-role="new-chat"]').waitFor({ state: 'visible' })
  }
  if (opts.disablePrivacyFilter === false) return
  await page.evaluate(
    async ({ model }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('natter')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(['presets', 'chats'], 'readwrite')
          const presets = tx.objectStore('presets')
          const chats = tx.objectStore('chats')
          const presetsReq = presets.getAll()
          presetsReq.onsuccess = () => {
            for (const preset of presetsReq.result as Array<Record<string, unknown>>) {
              const settings = (preset.settings ?? {}) as Record<string, unknown>
              const privacy = (settings.privacy ?? {}) as Record<string, unknown>
              preset.settings = {
                ...settings,
                ...(model ? { model } : {}),
                privacy: { ...privacy, paretoFilter: false },
              }
              presets.put(preset)
            }
            const chatsReq = chats.getAll()
            chatsReq.onsuccess = () => {
              for (const chat of chatsReq.result as Array<Record<string, unknown>>) {
                const settings = (chat.settings ?? {}) as Record<string, unknown>
                const privacy = (settings.privacy ?? {}) as Record<string, unknown>
                chat.settings = {
                  ...settings,
                  ...(model ? { model } : {}),
                  privacy: { ...privacy, paretoFilter: false },
                }
                chats.put(chat)
              }
            }
          }
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } finally {
        db.close()
      }
      const raw = window.sessionStorage.getItem('natter:active-seed')
      if (!raw) return
      try {
        const parsed = JSON.parse(raw) as {
          profileId?: string | null
          presetId?: string | null
          settings?: Record<string, unknown> | null
        }
        const settings = parsed.settings ?? {}
        const privacy = (settings.privacy ?? {}) as Record<string, unknown>
        window.sessionStorage.setItem(
          'natter:active-seed',
          JSON.stringify({
            ...parsed,
            settings: {
              ...settings,
              ...(model ? { model } : {}),
              privacy: { ...privacy, paretoFilter: false },
            },
          }),
        )
      } catch {
        // Ignore malformed session state in tests; IDB preset updates above are sufficient.
      }
    },
    { model },
  )
}

// Navigate to the blank-chat surface (`#/new`) and wait for the composer.
// A no-op visit stays IDB-cold; sending/importing/settings materializes
// a chat row only when needed.
export async function createChatAndOpen(page: Page): Promise<void> {
  await page.locator('[data-role="new-chat"]').click()
  await page.locator('[data-ui="composer"]').waitFor({ state: 'visible' })
  await page.waitForFunction(() => window.location.hash === '#/new')
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  await page.locator('[data-ui="composer-input"]').fill(text)
  await page.locator('[data-ui="send"]').click()
}

// Goes through the full new-chat-then-send flow: navigates to `#/new`, fills
// the composer, sends, and waits for the chat row to materialize in the
// sidebar. Useful for tests that just need any chat to exist before exercising
// some other feature (title editing, settings drawer, etc.).
export async function createChatAndSend(page: Page, text: string): Promise<void> {
  const expectedRows = (await page.locator('[data-ui="chat-row"]').count()) + 1
  await createChatAndOpen(page)
  await sendMessage(page, text)
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(expectedRows)
  const chatId = await firstChatId(page)
  expect(chatId).not.toBe('')
  await waitForAssistantGenerationFinished(page, chatId)
  await expect(page.locator('[data-ui="abort"]')).toHaveCount(0)
}

interface SseDelta {
  id?: string
  model?: string
  provider?: string
  content?: string
  reasoning?: string
  finish?: string
  usage?: Record<string, unknown>
  error?: { code: number | string; message: string; metadata?: Record<string, unknown> }
}

// Build an SSE body from a list of lane-tagged frames. Each `SseDelta` is one
// `data:` frame; `[DONE]` is appended automatically unless `options.noDone`.
export function buildSseBody(frames: SseDelta[], options: { noDone?: boolean } = {}): string {
  const lines: string[] = []
  for (const frame of frames) {
    const body: Record<string, unknown> = {}
    if (frame.id !== undefined) body.id = frame.id
    if (frame.model !== undefined) body.model = frame.model
    if (frame.provider !== undefined) body.provider = frame.provider
    if (frame.error) {
      body.error = frame.error
      body.choices = [{ finish_reason: 'error' }]
    } else {
      const delta: Record<string, unknown> = {}
      if (frame.content !== undefined) delta.content = frame.content
      if (frame.reasoning !== undefined) delta.reasoning = frame.reasoning
      body.choices = [
        { delta, ...(frame.finish !== undefined ? { finish_reason: frame.finish } : {}) },
      ]
    }
    if (frame.usage !== undefined) body.usage = frame.usage
    lines.push(`data: ${JSON.stringify(body)}`)
    lines.push('')
  }
  if (!options.noDone) {
    lines.push('data: [DONE]')
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

interface MockChatOptions {
  body?: string
  status?: number
  json?: unknown
  headers?: Record<string, string>
  delayMs?: number
}

// Intercept `/api/v1/chat/completions` on the given page and return a canned
// SSE or JSON response. Returns an unroute handle the caller can await to
// remove the interception (rarely needed — specs usually run once per page).
export async function mockChatCompletions(page: Page, options: MockChatOptions): Promise<void> {
  const { body, status = 200, json, headers = {}, delayMs } = options
  await page.route('**/api/v1/chat/completions', async (route) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    if (json !== undefined) {
      await route.fulfill({
        status,
        contentType: 'application/json',
        headers,
        body: JSON.stringify(json),
      })
      return
    }
    await route.fulfill({
      status,
      contentType: headers['content-type'] ?? 'text/event-stream',
      headers,
      body: body ?? '',
    })
  })
}

export async function seedLinearChat(
  page: Page,
  input: {
    messageCount: number
    settings?: Record<string, unknown>
    chatId?: string
    title?: string
    textPrefix?: string
    assistantContentType?: 'text' | 'output_text'
  },
): Promise<string> {
  if (!Number.isSafeInteger(input.messageCount) || input.messageCount < 1) {
    throw new Error('seedLinearChat requires a positive integer messageCount')
  }
  const now = Date.now()
  const chatId = input.chatId ?? 'linear-window-chat'
  const title = input.title ?? 'Linear window chat'
  const textPrefix = input.textPrefix ?? 'window message'
  const assistantContentType = input.assistantContentType ?? 'text'
  let parentId: string | null = null
  const storedMessages = Array.from({ length: input.messageCount }, (_, index) => {
    const id = `msg-${String(index).padStart(3, '0')}`
    const role = index % 2 === 0 ? 'user' : 'assistant'
    const message: Message = {
      id,
      chatId,
      parentId,
      siblingIndex: 0,
      turnId: `turn-${String(index).padStart(3, '0')}`,
      turnIndex: index,
      createdAt: now + index,
      role,
      origin: role === 'user' ? 'user' : 'generated',
      nodeVersion: 0,
      deleted: false,
      content: [
        {
          type: role === 'assistant' ? assistantContentType : 'text',
          text: `${textPrefix} ${index}`,
        },
      ],
    }
    parentId = id
    return splitMessageForStorage(message)
  })
  const chatWordCount = storedMessages.reduce(
    (total, stored) => total + stored.header.bodyWordCount,
    0,
  )
  const firstHeader = storedMessages[0]?.header
  if (!firstHeader) throw new Error('seedLinearChat did not construct a first message')
  const lastMessageId = storedMessages.at(-1)?.header.id
  if (!lastMessageId) throw new Error('seedLinearChat did not construct a last message')

  await page.evaluate(
    async (seed) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('natter')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(
            ['presets', 'settings', 'chats', 'messages', 'messageBodies'],
            'readwrite',
          )
          const presets = tx.objectStore('presets')
          const settingsStore = tx.objectStore('settings')
          const chats = tx.objectStore('chats')
          const messages = tx.objectStore('messages')
          const messageBodies = tx.objectStore('messageBodies')
          const presetsReq = presets.getAll()
          presetsReq.onsuccess = () => {
            const preset = (presetsReq.result as Array<{ id?: string; settings?: unknown }>)[0]
            const chatSettings = structuredClone(preset?.settings ?? {})
            for (const [key, value] of Object.entries(seed.settings)) {
              settingsStore.put({ key, value })
            }
            chats.put({
              id: seed.chatId,
              title: seed.title,
              titleStatus: 'manual',
              createdAt: seed.now,
              updatedAt: seed.now + seed.storedMessages.length,
              lastViewedAt: seed.now + seed.storedMessages.length,
              wordCount: seed.chatWordCount,
              totalCostUsd: 0,
              metaVersion: 0,
              summaryVersion: 0,
              settings: chatSettings,
              presetId: preset?.id,
              lastUpdatedLeafId: seed.lastMessageId,
              lastBranchUpdatedAt: seed.now + seed.storedMessages.length,
              archived: false,
              pinned: false,
              folderId: null,
              tags: [],
              previewText: seed.previewText,
            })
            for (const stored of seed.storedMessages) {
              messages.put(stored.header)
              messageBodies.put(stored.body)
            }
          }
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } finally {
        db.close()
      }
    },
    {
      chatId,
      chatWordCount,
      lastMessageId,
      now,
      previewText: previewTextFromStoredProjection(firstHeader.textPreview),
      settings: input.settings ?? {},
      storedMessages,
      title,
    },
  )
  await rebuildSidebarProjection(page)
  return chatId
}

export async function rebuildSidebarProjection(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('natter')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(['chats', 'chatSidebarRows', 'settings'], 'readwrite')
        const rows = transaction.objectStore('chatSidebarRows')
        const settings = transaction.objectStore('settings')
        rows.clear()
        const chatsRequest = transaction.objectStore('chats').getAll()
        chatsRequest.onsuccess = () => {
          const chats = chatsRequest.result as Array<Record<string, unknown>>
          for (const chat of chats) {
            const row: Record<string, unknown> = {
              id: chat.id,
              title: chat.title,
              titleStatus: chat.titleStatus,
              createdAt: chat.createdAt,
              updatedAt: chat.updatedAt,
              lastViewedAt: chat.lastViewedAt,
              wordCount: chat.wordCount,
              totalCostUsd: chat.totalCostUsd,
              lastUpdatedLeafId: chat.lastUpdatedLeafId,
              lastBranchUpdatedAt: chat.lastBranchUpdatedAt,
              archived: chat.archived,
              pinned: chat.pinned,
              folderId: chat.folderId,
              tags: structuredClone(chat.tags),
              ...(chat.previewText === undefined ? {} : { previewText: chat.previewText }),
            }
            const serialized = JSON.stringify([
              row.id,
              row.title,
              row.titleStatus,
              row.createdAt,
              row.updatedAt,
              row.lastViewedAt,
              row.wordCount,
              row.totalCostUsd,
              row.lastUpdatedLeafId,
              row.lastBranchUpdatedAt,
              row.archived,
              row.pinned,
              row.folderId,
              row.tags,
              row.previewText ?? null,
            ])
            let hash = 0x811c9dc5
            for (let index = 0; index < serialized.length; index += 1) {
              hash ^= serialized.charCodeAt(index)
              hash = Math.imul(hash, 0x01000193)
            }
            rows.put({
              ...row,
              projectionVersion: 1,
              checksum: (hash >>> 0).toString(16).padStart(8, '0'),
            })
          }
          settings.put({ key: 'backfill:chat-sidebar-projection-v1', value: 1 })
          settings.put({
            key: 'projection:chat-sidebar-v1',
            value: { projectionVersion: 1, expectedCount: chats.length },
          })
        }
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      db.close()
    }
  })
}

// Read a chat's messages table via the page's IndexedDB. Returns the
// promoted-to-top-of-type array so tests can filter / assert by role.
export async function readMessages(
  page: Page,
  chatId: string,
): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const tx = db.transaction(['messages', 'messageBodies'], 'readonly')
        const messageStore = tx.objectStore('messages')
        const bodyStore = tx.objectStore('messageBodies')
        const index = messageStore.index('chatId')
        const req = index.getAll(id)
        req.onsuccess = () => {
          const headers = req.result as Array<Record<string, unknown>>
          if (headers.length === 0) {
            resolve([])
            return
          }
          const bodyReq = bodyStore.getAll()
          bodyReq.onsuccess = () => {
            const byId = new Map(
              (bodyReq.result as Array<Record<string, unknown>>).map((row) => [row.id, row]),
            )
            resolve(
              headers.map((header) => {
                const body = byId.get(header.id)
                return body ? { ...header, ...body, nodeVersion: header.nodeVersion } : header
              }),
            )
          }
          bodyReq.onerror = () => reject(bodyReq.error)
        }
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  }, chatId)
}

interface TranscriptContinuityState {
  anchor: Element
  anchorRemoved: boolean
  content: Element
  list: Element
  listRemoved: boolean
  listReplaced: boolean
  loadingSeen: boolean
  messageCounts: number[]
}

interface TranscriptContinuityWindow extends Window {
  __messageCountSamples?: TranscriptContinuityState
  __stopMessageCountSamples?: () => void
}

export interface TranscriptContinuityResult {
  anchorRemoved: boolean
  listRemoved: boolean
  listReplaced: boolean
  loadingSeen: boolean
  messageCountsIncludeZero: boolean
}

export async function startMessageCountRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as TranscriptContinuityWindow
    win.__stopMessageCountSamples?.()
    const content = document.querySelector('[data-ui="scroll-content"]')
    const list = content?.querySelector('[data-ui="message-list"]')
    if (!content || !list) throw new Error('Mounted transcript not found')
    const messages = list.querySelectorAll('[data-ui="message"]')
    const state: TranscriptContinuityState = {
      anchor: messages.item(Math.max(0, messages.length - 2)),
      anchorRemoved: false,
      content,
      list,
      listRemoved: false,
      listReplaced: false,
      loadingSeen: false,
      messageCounts: [],
    }
    const sample = () => {
      const currentList = state.content.querySelector('[data-ui="message-list"]')
      state.messageCounts.push(currentList?.querySelectorAll('[data-ui="message"]').length ?? 0)
      state.listRemoved ||= !state.list.isConnected
      state.listReplaced ||= currentList !== state.list
      state.anchorRemoved ||= !state.anchor.isConnected
      state.loadingSeen ||= state.content.querySelector('[data-ui="surface-loading"]') !== null
    }
    const observer = new MutationObserver(sample)
    observer.observe(content, { childList: true, subtree: true })
    sample()
    win.__messageCountSamples = state
    win.__stopMessageCountSamples = () => observer.disconnect()
  })
}

export async function stopMessageCountRecorder(page: Page): Promise<TranscriptContinuityResult> {
  return page.evaluate(() => {
    const win = window as TranscriptContinuityWindow
    const state = win.__messageCountSamples
    if (!state) throw new Error('Transcript continuity recorder not started')
    const currentList = state.content.querySelector('[data-ui="message-list"]')
    state.messageCounts.push(currentList?.querySelectorAll('[data-ui="message"]').length ?? 0)
    state.listRemoved ||= !state.list.isConnected
    state.listReplaced ||= currentList !== state.list
    state.anchorRemoved ||= !state.anchor.isConnected
    state.loadingSeen ||= state.content.querySelector('[data-ui="surface-loading"]') !== null
    win.__stopMessageCountSamples?.()
    delete win.__messageCountSamples
    delete win.__stopMessageCountSamples
    return {
      anchorRemoved: state.anchorRemoved,
      listRemoved: state.listRemoved,
      listReplaced: state.listReplaced,
      loadingSeen: state.loadingSeen,
      messageCountsIncludeZero: state.messageCounts.includes(0),
    }
  })
}

export async function waitForAssistantGenerationFinished(
  page: Page,
  chatId: string,
  assistantIndex = 0,
): Promise<void> {
  await expect
    .poll(async () => {
      const assistants = (await readMessages(page, chatId)).filter(
        (row) => row.role === 'assistant',
      )
      const generation = assistants[assistantIndex]?.generation
      return generation && typeof generation === 'object'
        ? typeof (generation as { finishedAt?: unknown }).finishedAt
        : 'undefined'
    })
    .toBe('number')
}

export async function firstChatId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<string>((resolve, reject) => {
        const tx = db.transaction('chats', 'readonly')
        const store = tx.objectStore('chats')
        const req = store.getAll()
        req.onsuccess = () => {
          const rows = (req.result as Array<{ id: string; updatedAt: number }>).sort(
            (a, b) => b.updatedAt - a.updatedAt,
          )
          resolve(rows[0]?.id ?? '')
        }
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  })
}

export async function clearIndexedDb(page: Page): Promise<void> {
  const resetRoute = '**/__e2e-reset__'
  await page.route(resetRoute, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reset</title>' }),
  )
  try {
    await page.goto('/__e2e-reset__')
  } finally {
    await page.unroute(resetRoute)
  }
  await page.evaluate(async () => {
    window.sessionStorage.removeItem('natter:active-seed')
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('natter')
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('IndexedDBDeleteBlocked:natter'))
    })
  })
  await page.goto('/')
  await page.locator('#root > *').first().waitFor()
}

export async function importIndexedDbDump(page: Page, dump: IndexedDbDump): Promise<void> {
  await page.goto('/')
  await page.evaluate(async (dump) => {
    const req = indexedDB.open(dump.dbName || 'natter')
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      const storeNames = Array.from(db.objectStoreNames)
      const writableStores = Object.keys(dump.stores).filter((name) => storeNames.includes(name))
      if (writableStores.length === 0) return
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(writableStores, 'readwrite')
        for (const storeName of writableStores) {
          const store = tx.objectStore(storeName)
          store.clear()
          const rows = dump.stores[storeName] ?? []
          for (const row of rows) store.put(row)
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }, dump)
  await page.reload()
}
