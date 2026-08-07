// Most send-pipeline specs use `mockChatCompletions`; timing, concurrency, and
// retention specs retarget a normal connection to the standalone fake provider.
// Neither path burns live quota. Live-API specs live in `*.live.spec.ts` and gate
// on `process.env.RUN_LIVE === '1'`.

import {
  configureWorkspaceThroughUi,
  importPortableChatThroughUi,
  waitForWorkspaceRunning as waitForWorkspaceFixtureRunning,
} from '../../scripts/workspace-provider-fixture.mjs'
import { expect, type Page } from './fixtures'

export interface IndexedDbDump {
  dbName: string
  exportedAt?: string
  stores: Record<string, unknown[]>
}

export async function waitForWorkspaceRunning(page: Page): Promise<void> {
  await waitForWorkspaceFixtureRunning(page)
}

export async function activeWorkspaceDatabaseName(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const knownNames =
      typeof indexedDB.databases === 'function'
        ? (await indexedDB.databases()).flatMap((database) =>
            database.name === undefined ? [] : [database.name],
          )
        : []
    if (!knownNames.includes('natter-control')) return 'natter'
    const control = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('natter-control')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<string>((resolve, reject) => {
        const request = control
          .transaction('manifests', 'readonly')
          .objectStore('manifests')
          .get('workspace')
        request.onsuccess = () => {
          const name = (request.result as { activeDatabaseName?: unknown } | undefined)
            ?.activeDatabaseName
          if (typeof name !== 'string') {
            reject(new Error('BrowserWorkspaceControlManifestInvalid'))
            return
          }
          resolve(name)
        }
        request.onerror = () => reject(request.error)
      })
    } finally {
      control.close()
    }
  })
}

export async function holdIndexedDbStoreGate(
  page: Page,
  storeNames: readonly string[],
): Promise<() => Promise<void>> {
  if (storeNames.length === 0) throw new Error('IndexedDbStoreGateRequiresStore')
  const databaseName = await activeWorkspaceDatabaseName(page)
  const gateId = `indexeddb-store-gate:${Date.now()}:${Math.random()}`
  await page.evaluate(
    async ({ databaseName, gateId, storeNames }) => {
      type Gate = { release(): void; readonly complete: Promise<void> }
      const scope = window as typeof window & {
        __e2eIndexedDbStoreGates?: Map<string, Gate>
      }
      const gates = scope.__e2eIndexedDbStoreGates ?? new Map<string, Gate>()
      scope.__e2eIndexedDbStoreGates = gates
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      let released = false
      let readySettled = false
      let resolveReady: () => void = () => undefined
      let rejectReady: (error: unknown) => void = () => undefined
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      let resolveComplete: () => void = () => undefined
      let rejectComplete: (error: unknown) => void = () => undefined
      const complete = new Promise<void>((resolve, reject) => {
        resolveComplete = resolve
        rejectComplete = reject
      })
      const transaction = database.transaction(storeNames, 'readwrite')
      const fail = (error: unknown) => {
        if (!readySettled) {
          readySettled = true
          rejectReady(error)
        }
        rejectComplete(error)
        database.close()
      }
      transaction.oncomplete = () => {
        resolveComplete()
        database.close()
      }
      transaction.onerror = () => fail(transaction.error ?? new Error('IndexedDbStoreGateError'))
      transaction.onabort = () => fail(transaction.error ?? new Error('IndexedDbStoreGateAbort'))
      const store = transaction.objectStore(storeNames[0] as string)
      const keepAlive = () => {
        const request = store.get('__e2e_gate__')
        request.onsuccess = () => {
          if (!readySettled) {
            readySettled = true
            resolveReady()
          }
          if (!released) keepAlive()
        }
        request.onerror = () => fail(request.error ?? new Error('IndexedDbStoreGateReadError'))
      }
      gates.set(gateId, {
        release: () => {
          released = true
        },
        complete,
      })
      keepAlive()
      await ready
    },
    { databaseName, gateId, storeNames: [...storeNames] },
  )
  let released = false
  return async () => {
    if (released) return
    released = true
    await page.evaluate(async (gateId) => {
      const scope = window as typeof window & {
        __e2eIndexedDbStoreGates?: Map<
          string,
          { release(): void; readonly complete: Promise<void> }
        >
      }
      const gate = scope.__e2eIndexedDbStoreGates?.get(gateId)
      if (!gate) throw new Error(`IndexedDbStoreGateMissing:${gateId}`)
      gate.release()
      try {
        await gate.complete
      } finally {
        scope.__e2eIndexedDbStoreGates?.delete(gateId)
      }
    }, gateId)
  }
}

interface SeedOptions {
  apiKey?: string
  model?: string
  disablePrivacyFilter?: boolean
  corsProxyUrl?: string
}

const DEFAULT_E2E_MODEL = 'google/gemini-3.5-flash'

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
  await configureWorkspaceThroughUi(page, {
    model,
    ...(opts.disablePrivacyFilter === false ? {} : { paretoFilter: false }),
    ...(opts.corsProxyUrl === undefined
      ? {}
      : { workspaceSettings: { 'global:cors-proxy-url': opts.corsProxyUrl } }),
  })
  await createChatAndOpen(page)
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
  const composer = interactiveComposer(page)
  await expect(composer).toBeVisible()
  await composer.locator('[data-ui="composer-input"]').fill(text)
  const materializesChat = await page.evaluate(() => window.location.hash === '#/new')
  await composer.locator('[data-ui="send"]').click()
  if (materializesChat) await expect(page).toHaveURL(/#\/chat\/[^/]+\/message\/[^/]+$/)
}

export function interactiveComposer(page: Page) {
  return page.locator('form[data-ui="composer"]:not([data-presentation-only])')
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
    textForIndex?: (index: number) => string
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
  const messages = Array.from({ length: input.messageCount }, (_, index) => {
    const id = `msg-${String(index).padStart(3, '0')}`
    const role = index % 2 === 0 ? 'user' : 'assistant'
    const message = {
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
          text: input.textForIndex?.(index) ?? `${textPrefix} ${index}`,
        },
      ],
    }
    parentId = id
    return message
  })
  const imported = await importPortableChatThroughUi(page, {
    sourceChatId: chatId,
    title,
    createdAt: now,
    updatedAt: now + messages.length,
    messages,
    ...(input.settings === undefined ? {} : { workspaceSettings: input.settings }),
  })
  return imported.chatId
}

// Read a chat's messages table via the page's IndexedDB and reconstruct
// deterministic tree order; a non-unique IDB index has no conversational order.
export async function readMessages(
  page: Page,
  chatId: string,
): Promise<Array<Record<string, unknown>>> {
  const databaseName = await activeWorkspaceDatabaseName(page)
  const rows = await page.evaluate(
    async ({ databaseName, id }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(databaseName)
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
    },
    { databaseName, id: chatId },
  )
  return orderStoredMessageRows(rows)
}

function orderStoredMessageRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const byParent = new Map<string | null, Array<Record<string, unknown>>>()
  for (const row of rows) {
    const parentId = typeof row.parentId === 'string' ? row.parentId : null
    const siblings = byParent.get(parentId)
    if (siblings) siblings.push(row)
    else byParent.set(parentId, [row])
  }
  const compare = (left: Record<string, unknown>, right: Record<string, unknown>) =>
    numericRowField(left.siblingIndex) - numericRowField(right.siblingIndex) ||
    numericRowField(left.createdAt) - numericRowField(right.createdAt) ||
    (typeof left.id === 'string' ? left.id : '').localeCompare(
      typeof right.id === 'string' ? right.id : '',
    )
  for (const siblings of byParent.values()) siblings.sort(compare)

  const ordered: Array<Record<string, unknown>> = []
  const visited = new Set<string>()
  const visit = (row: Record<string, unknown>) => {
    const id = typeof row.id === 'string' ? row.id : null
    if (id && visited.has(id)) return
    if (id) visited.add(id)
    ordered.push(row)
    if (id) for (const child of byParent.get(id) ?? []) visit(child)
  }
  for (const root of byParent.get(null) ?? []) visit(root)
  for (const row of [...rows].sort(compare)) {
    if (typeof row.id !== 'string' || !visited.has(row.id)) visit(row)
  }
  return ordered
}

function numericRowField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

interface TranscriptContinuityState {
  anchor: Element
  anchorRemoved: boolean
  commonPrefix: Array<{ element: Element; messageId: string }>
  commonPrefixDisconnectedIds: Set<string>
  commonPrefixReplacedIds: Set<string>
  content: Element
  expectedCommonPrefixCount: number | null
  list: Element
  listRemoved: boolean
  listReplaced: boolean
  loadingSeen: boolean
  branchControlCounts: number[]
  renderedMessageCounts: number[]
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
  messageCountDecreased: boolean
  messageCountsIncludeZero: boolean
  minimumMessageCount: number
  minimumBranchControlCount: number
  commonPrefixDisconnectedIds?: string[]
  commonPrefixReplacedIds?: string[]
  messageCountBelowExpectedCommonPrefix?: boolean
}

export async function startMessageCountRecorder(
  page: Page,
  options: { commonPrefixMessageIds?: readonly string[] } = {},
): Promise<void> {
  await page.evaluate((input) => {
    const win = window as TranscriptContinuityWindow
    win.__stopMessageCountSamples?.()
    const content = document.querySelector('[data-ui="scroll-content"]')
    const list = content?.querySelector('[data-ui="message-list"]')
    if (!content || !list) throw new Error('Mounted transcript not found')
    const messages = list.querySelectorAll('[data-ui="message"]')
    const commonPrefix = (input.commonPrefixMessageIds ?? []).map((messageId) => {
      const element = Array.from(messages).find(
        (message) => message.getAttribute('data-message-id') === messageId,
      )
      if (!element) throw new Error(`Common-prefix message is not mounted: ${messageId}`)
      return { element, messageId }
    })
    const state: TranscriptContinuityState = {
      anchor: commonPrefix.at(-1)?.element ?? messages.item(Math.max(0, messages.length - 2)),
      anchorRemoved: false,
      commonPrefix,
      commonPrefixDisconnectedIds: new Set(),
      commonPrefixReplacedIds: new Set(),
      content,
      expectedCommonPrefixCount: commonPrefix.length > 0 ? commonPrefix.length : null,
      list,
      listRemoved: false,
      listReplaced: false,
      loadingSeen: false,
      branchControlCounts: [],
      renderedMessageCounts: [],
    }
    const sample = () => {
      const currentList = state.content.querySelector('[data-ui="message-list"]')
      const currentMessages = Array.from(
        currentList?.querySelectorAll('[data-ui="message"][data-message-id]') ?? [],
      )
      const currentMessagesById = new Map(
        currentMessages.map((message) => [message.getAttribute('data-message-id'), message]),
      )
      const renderedCount = Number(currentList?.getAttribute('data-rendered-count'))
      state.renderedMessageCounts.push(
        Number.isInteger(renderedCount) && renderedCount >= 0
          ? renderedCount
          : currentMessages.length,
      )
      state.branchControlCounts.push(
        currentList?.querySelectorAll('[data-ui="branch-controls"]').length ?? 0,
      )
      state.listRemoved ||= !state.list.isConnected
      state.listReplaced ||= currentList !== state.list
      state.anchorRemoved ||= !state.anchor.isConnected
      state.loadingSeen ||= state.content.querySelector('[data-ui="surface-loading"]') !== null
      for (const tracked of state.commonPrefix) {
        if (!tracked.element.isConnected) {
          state.commonPrefixDisconnectedIds.add(tracked.messageId)
        }
        const current = currentMessagesById.get(tracked.messageId)
        if (current !== tracked.element) state.commonPrefixReplacedIds.add(tracked.messageId)
      }
    }
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const removed of record.removedNodes) {
          for (const tracked of state.commonPrefix) {
            if (
              removed === tracked.element ||
              (removed instanceof Element && removed.contains(tracked.element))
            ) {
              state.commonPrefixDisconnectedIds.add(tracked.messageId)
            }
          }
        }
      }
      sample()
    })
    observer.observe(content, { childList: true, subtree: true })
    sample()
    win.__messageCountSamples = state
    win.__stopMessageCountSamples = () => observer.disconnect()
  }, options)
}

export async function stopMessageCountRecorder(page: Page): Promise<TranscriptContinuityResult> {
  return page.evaluate(() => {
    const win = window as TranscriptContinuityWindow
    const state = win.__messageCountSamples
    if (!state) throw new Error('Transcript continuity recorder not started')
    const currentList = state.content.querySelector('[data-ui="message-list"]')
    const finalRenderedCount = Number(currentList?.getAttribute('data-rendered-count'))
    state.renderedMessageCounts.push(
      Number.isInteger(finalRenderedCount) && finalRenderedCount >= 0
        ? finalRenderedCount
        : (currentList?.querySelectorAll('[data-ui="message"]').length ?? 0),
    )
    state.branchControlCounts.push(
      currentList?.querySelectorAll('[data-ui="branch-controls"]').length ?? 0,
    )
    state.listRemoved ||= !state.list.isConnected
    state.listReplaced ||= currentList !== state.list
    state.anchorRemoved ||= !state.anchor.isConnected
    state.loadingSeen ||= state.content.querySelector('[data-ui="surface-loading"]') !== null
    win.__stopMessageCountSamples?.()
    delete win.__messageCountSamples
    delete win.__stopMessageCountSamples
    const initialMessageCount = state.renderedMessageCounts[0] ?? 0
    const expectedCommonPrefixCount = state.expectedCommonPrefixCount
    return {
      anchorRemoved: state.anchorRemoved,
      listRemoved: state.listRemoved,
      listReplaced: state.listReplaced,
      loadingSeen: state.loadingSeen,
      messageCountDecreased: state.renderedMessageCounts.some(
        (count) => count < initialMessageCount,
      ),
      messageCountsIncludeZero: state.renderedMessageCounts.includes(0),
      minimumMessageCount: Math.min(...state.renderedMessageCounts),
      minimumBranchControlCount: Math.min(...state.branchControlCounts),
      ...(expectedCommonPrefixCount === null
        ? {}
        : {
            commonPrefixDisconnectedIds: [...state.commonPrefixDisconnectedIds],
            commonPrefixReplacedIds: [...state.commonPrefixReplacedIds],
            messageCountBelowExpectedCommonPrefix: state.renderedMessageCounts.some(
              (count) => count < expectedCommonPrefixCount,
            ),
          }),
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

export async function waitForMessageGenerationFinished(
  page: Page,
  chatId: string,
  messageId: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const generation = (await readMessages(page, chatId)).find(
        (row) => row.id === messageId,
      )?.generation
      return generation && typeof generation === 'object'
        ? typeof (generation as { finishedAt?: unknown }).finishedAt
        : 'undefined'
    })
    .toBe('number')
}

export async function firstChatId(page: Page): Promise<string> {
  const databaseName = await activeWorkspaceDatabaseName(page)
  let chatId = ''
  await expect
    .poll(async () => {
      chatId = await page.evaluate(async (databaseName) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open(databaseName)
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
      }, databaseName)
      return chatId
    })
    .not.toBe('')
  return chatId
}

export async function readChatRow(page: Page, chatId: string): Promise<Record<string, unknown>> {
  const databaseName = await activeWorkspaceDatabaseName(page)
  return page.evaluate(
    async ({ chatId, databaseName }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        return await new Promise<Record<string, unknown>>((resolve, reject) => {
          const request = db.transaction('chats', 'readonly').objectStore('chats').get(chatId)
          request.onsuccess = () => resolve(request.result as Record<string, unknown>)
          request.onerror = () => reject(request.error)
        })
      } finally {
        db.close()
      }
    },
    { chatId, databaseName },
  )
}

export async function clearIndexedDb(page: Page): Promise<void> {
  const resetRoute = '**/__e2e-reset__'
  await page.route(resetRoute, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reset</title>' }),
  )
  try {
    await page.goto(absolutePageUrl(page, '/__e2e-reset__'))
  } finally {
    await page.unroute(resetRoute)
  }
  await page.evaluate(async () => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    const names = new Set(['natter', 'natter-control', 'natter-workspace-a', 'natter-workspace-b'])
    if (typeof indexedDB.databases === 'function') {
      for (const database of await indexedDB.databases()) {
        if (database.name) names.add(database.name)
      }
    }
    for (const name of [...names].sort()) {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(name)
        req.onsuccess = () => resolve()
        req.onerror = () => reject(req.error)
        req.onblocked = () => reject(new Error(`IndexedDBDeleteBlocked:${name}`))
      })
    }
  })
  await page.goto(absolutePageUrl(page, '/'))
  await page.locator('#root > *').first().waitFor()
}

export async function importIndexedDbDump(page: Page, dump: IndexedDbDump): Promise<void> {
  await page.goto(absolutePageUrl(page, '/'))
  const databaseName = await activeWorkspaceDatabaseName(page)
  await page.evaluate(
    async ({ databaseName, dump }) => {
      const req = indexedDB.open(databaseName)
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
    },
    { databaseName, dump },
  )
  await page.reload()
}

function absolutePageUrl(page: Page, path: string): string {
  if (page.url() === 'about:blank') return path
  return new URL(path, page.url()).href
}
