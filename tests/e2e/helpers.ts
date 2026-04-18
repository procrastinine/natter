// Shared e2e helpers. See `plan/13-delivery.md §13.3.0 Track B`.
//
// Every spec that hits the send pipeline uses `mockChatCompletions` to stub
// `/api/v1/chat/completions` so we don't burn live quota on deterministic
// assertions. Live-API specs live in `*.live.spec.ts` and gate on
// `process.env.RUN_LIVE === '1'`.

import type { Page } from '@playwright/test'

export interface SeedOptions {
  apiKey?: string
  model?: string
}

// Walk the first-run form. `apiKey` defaults to a harmless placeholder because
// the route-mocked specs never hit OpenRouter. Use `seedReal(page)` when the
// spec needs the real key from `key.txt`.
export async function seedFirstRun(page: Page, opts: SeedOptions = {}): Promise<void> {
  const apiKey = opts.apiKey ?? 'sk-or-v1-test-00000000000000000000000000000000000000000000'
  await page.goto('/')
  const input = page.locator('[data-ui="first-run-key"]')
  await input.fill(apiKey)
  await page.locator('[data-ui="first-run-submit"]').click()
  // Empty state appears when profileCount advances from 0 to 1.
  await page.locator('[data-ui="empty-state"]').waitFor({ state: 'visible' })
}

export async function createChatAndOpen(page: Page): Promise<void> {
  await page.locator('[data-ui="new-chat"]').click()
  await page.locator('[data-ui="composer"]').waitFor({ state: 'visible' })
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  await page.locator('[data-ui="composer-input"]').fill(text)
  await page.locator('[data-ui="send"]').click()
}

export interface SseDelta {
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
export function buildSseBody(
  frames: SseDelta[],
  options: { noDone?: boolean } = {},
): string {
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
      body.choices = [{ delta, ...(frame.finish !== undefined ? { finish_reason: frame.finish } : {}) }]
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

export interface MockChatOptions {
  body?: string
  status?: number
  json?: unknown
  headers?: Record<string, string>
  delayMs?: number
}

// Intercept `/api/v1/chat/completions` on the given page and return a canned
// SSE or JSON response. Returns an unroute handle the caller can await to
// remove the interception (rarely needed — specs usually run once per page).
export async function mockChatCompletions(
  page: Page,
  options: MockChatOptions,
): Promise<void> {
  const {
    body,
    status = 200,
    json,
    headers = {},
    delayMs,
  } = options
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
        const tx = db.transaction('messages', 'readonly')
        const store = tx.objectStore('messages')
        const index = store.index('chatId')
        const req = index.getAll(id)
        req.onsuccess = () => resolve(req.result as Array<Record<string, unknown>>)
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
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('natter')
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
      req.onblocked = () => resolve()
    })
  })
}
