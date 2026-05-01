// Shared e2e helpers. See `plan/13-delivery.md §13.3.0 Track B`.
//
// Every spec that hits the send pipeline uses `mockChatCompletions` to stub
// `/api/v1/chat/completions` to avoid burning live quota on deterministic
// assertions. Live-API specs live in `*.live.spec.ts` and gate on
// `process.env.RUN_LIVE === '1'`.

import type { Page } from '@playwright/test'

export interface IndexedDbDump {
  dbName: string
  exportedAt?: string
  stores: Record<string, unknown[]>
}

interface SeedOptions {
  apiKey?: string
  model?: string
  disablePrivacyFilter?: boolean
}

const DEFAULT_E2E_MODEL = 'google/gemini-3.1-flash-lite-preview:free'

// Open the first-run Add connection action and submit a stub key. `apiKey`
// defaults to a harmless placeholder because the route-mocked specs never hit
// OpenRouter. Use `seedReal(page)` when the spec needs the real key from
// `key.txt`.
export async function seedFirstRun(page: Page, opts: SeedOptions = {}): Promise<void> {
  const apiKey = opts.apiKey ?? 'sk-or-v1-test-00000000000000000000000000000000000000000000'
  const model = opts.model ?? DEFAULT_E2E_MODEL
  await page.goto('/')
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

// Navigate to the blank-chat surface (`#/new`) and wait for its temporary
// chat row to materialize. The row owns draft settings while active, stays
// hidden from the sidebar until first send, and is discarded if the user
// navigates away without messages.
export async function createChatAndOpen(page: Page): Promise<void> {
  await page.locator('[data-role="new-chat"]').click()
  await page.locator('[data-ui="composer"]').waitFor({ state: 'visible' })
  await page.waitForFunction(() => /^#\/chat\//.test(window.location.hash))
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
  await createChatAndOpen(page)
  await sendMessage(page, text)
  await page.locator('[data-ui="chat-row"]').first().waitFor({ state: 'visible' })
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
  await page.evaluate(async () => {
    window.sessionStorage.removeItem('natter:active-seed')
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('natter')
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
      req.onblocked = () => resolve()
    })
  })
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
