import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createVerificationRuntimeInvocation } from './verification-process-execution.mjs'
import { retargetWorkspaceThroughBackupImport } from './workspace-provider-fixture.mjs'

export const FAKE_TEXT_SEED =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer vitae sem sed nulla gravida feugiat. '
export const FAKE_REASONING_SEED =
  'Reasoning fragment for deterministic loopback stream validation and bounded memory profiling. '

export function installProfileDurableReasoningObserver() {
  if (globalThis.__natterProfileDurableReasoningText) return
  globalThis.__natterProfileDurableReasoningText = (body) => {
    if (Object.hasOwn(body ?? {}, 'reasoningDetails')) {
      throw new Error('ProfileLegacyReasoningDetailsPresent')
    }
    const envelope = body?.reasoningEnvelope
    if (envelope === undefined) return ''
    if (envelope?.schemaVersion !== 2 || !Array.isArray(envelope.visible)) {
      throw new Error('ProfileReasoningEnvelopeInvalid')
    }
    return envelope.visible
      .map((item) => {
        if (typeof item?.text !== 'string') throw new Error('ProfileReasoningVisibleItemInvalid')
        return item.text
      })
      .join('')
  }
}

export function assertLoopbackUrl(raw, label) {
  const url = new URL(raw)
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error(`${label} only accepts a loopback URL`)
  }
  return url
}

export async function startPreviewServer({ appUrl, timeoutMs = 10_000 } = {}) {
  const url = assertLoopbackUrl(appUrl, 'preview URL')
  const runtime = verificationRuntimeFromEnvironment(process.env)
  const invocation = createVerificationRuntimeInvocation(
    [
      'pnpm',
      'exec',
      'vite',
      'preview',
      '--host',
      normalizedLoopbackHost(url.hostname),
      '--port',
      url.port || (url.protocol === 'https:' ? '443' : '80'),
      '--strictPort',
    ],
    runtime,
  )
  const child = spawn(invocation.command, invocation.args, {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let diagnostics = ''
  const capture = (chunk) => {
    diagnostics = `${diagnostics}${String(chunk)}`.slice(-32_768)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  const exited = new Promise((_, reject) => {
    child.once('error', (error) => reject(error))
    child.once('exit', (code, signal) => {
      reject(
        new Error(
          `preview exited before readiness (code=${code}, signal=${signal})${diagnostics ? `\n${diagnostics}` : ''}`,
        ),
      )
    })
  })
  try {
    await Promise.race([
      waitUntil(
        async () => {
          const response = await fetch(url).catch(() => null)
          return response?.ok === true
        },
        timeoutMs,
        'preview readiness',
      ),
      exited,
    ])
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  }
  child.removeAllListeners('exit')
  child.removeAllListeners('error')
  child.on('error', capture)
  return {
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      const terminal = once(child, 'exit')
      try {
        await withTimeout(terminal, 5_000, 'preview shutdown')
      } catch {
        child.kill('SIGKILL')
        await once(child, 'exit')
      }
    },
  }
}

function verificationRuntimeFromEnvironment(environment) {
  const nodeExecutablePath = environment.VERIFICATION_NODE_EXECUTABLE
  const pnpmExecutablePath = environment.VERIFICATION_PNPM_EXECUTABLE
  if ((nodeExecutablePath === undefined) !== (pnpmExecutablePath === undefined)) {
    throw new Error('VerificationPreviewRuntimeIncomplete')
  }
  return nodeExecutablePath && pnpmExecutablePath
    ? { nodeExecutablePath, pnpmExecutablePath }
    : null
}

function normalizedLoopbackHost(hostname) {
  return hostname === '[::1]' || hostname === '::1' ? '::1' : hostname
}

export async function activeWorkspaceDatabaseName(page) {
  return page.evaluate(async () => {
    const openDatabase = (name) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(name)
        const clear = () => {
          request.onsuccess = null
          request.onerror = null
        }
        request.onsuccess = () => {
          const database = request.result
          clear()
          resolve(database)
        }
        request.onerror = () => {
          const error = request.error
          clear()
          reject(error)
        }
      })
    const requestResult = (request) =>
      new Promise((resolve, reject) => {
        const clear = () => {
          request.onsuccess = null
          request.onerror = null
        }
        request.onsuccess = () => {
          const result = request.result
          clear()
          resolve(result)
        }
        request.onerror = () => {
          const error = request.error
          clear()
          reject(error)
        }
      })
    const transactionResult = async (transaction, result) => {
      const terminal = new Promise((resolve, reject) => {
        const clear = () => {
          transaction.removeEventListener('complete', complete)
          transaction.removeEventListener('abort', abort)
        }
        const complete = () => {
          clear()
          resolve()
        }
        const abort = () => {
          const error = transaction.error
          clear()
          reject(error)
        }
        transaction.addEventListener('complete', complete)
        transaction.addEventListener('abort', abort)
      })
      try {
        const value = await result
        await terminal
        return value
      } catch (error) {
        await terminal.catch(() => undefined)
        throw error
      }
    }
    const names =
      typeof indexedDB.databases === 'function'
        ? (await indexedDB.databases()).flatMap((database) =>
            database.name === undefined ? [] : [database.name],
          )
        : []
    if (!names.includes('natter-control')) return 'natter'
    const control = await openDatabase('natter-control')
    try {
      const transaction = control.transaction('manifests', 'readonly')
      const manifest = await transactionResult(
        transaction,
        requestResult(transaction.objectStore('manifests').get('workspace')),
      )
      if (typeof manifest?.activeDatabaseName !== 'string') {
        throw new Error('BrowserWorkspaceControlManifestInvalid')
      }
      return manifest.activeDatabaseName
    } finally {
      control.close()
    }
  })
}

export async function startFakeProvider({ providerUrl, timeoutMs = 10_000 } = {}) {
  if (providerUrl) {
    const explicit = assertLoopbackUrl(providerUrl, 'provider URL')
    const origin = explicit.origin
    await waitUntil(
      async () => {
        const response = await fetch(`${origin}/healthz`).catch(() => null)
        return response?.ok === true
      },
      timeoutMs,
      'fake provider health check',
    )
    return { origin, owned: false, stop: async () => undefined }
  }

  const scriptPath = fileURLToPath(new URL('./fake-stream-server.mjs', import.meta.url))
  const child = spawn(process.execPath, [scriptPath, '--host', '127.0.0.1', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-32_768)
  })
  const lines = createInterface({ input: child.stdout })
  const listening = new Promise((resolve, reject) => {
    const onExit = (code, signal) => {
      reject(
        new Error(
          `fake provider exited before listening (code=${code}, signal=${signal})${stderr ? `\n${stderr}` : ''}`,
        ),
      )
    }
    child.once('exit', onExit)
    lines.on('line', (line) => {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event?.event !== 'listening' || typeof event.url !== 'string') return
      child.off('exit', onExit)
      resolve(event)
    })
  })
  let event
  try {
    event = await withTimeout(listening, timeoutMs, 'fake provider startup')
  } catch (error) {
    child.kill('SIGTERM')
    throw error
  }
  const origin = assertLoopbackUrl(event.url, 'spawned provider URL').origin
  return {
    origin,
    owned: true,
    async stop() {
      lines.close()
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      const exited = once(child, 'exit')
      try {
        await withTimeout(exited, 5_000, 'fake provider shutdown')
      } catch {
        child.kill('SIGKILL')
        await once(child, 'exit')
      }
    },
  }
}

export async function createProviderScenario(providerOrigin, config) {
  const scenarioId = `profile-${process.pid}-${randomUUID()}`
  const controlUrl = `${providerOrigin}/__control/scenarios/${scenarioId}`
  const initial = await requestScenario(controlUrl, 'PUT', config)
  return {
    scenarioId,
    providerBaseUrl: initial.providerBaseUrl,
    update: (next) => requestScenario(controlUrl, 'PUT', next),
    snapshot: () => requestScenario(controlUrl, 'GET'),
    hold: () => requestScenario(`${controlUrl}/hold`, 'POST'),
    release: () => requestScenario(`${controlUrl}/release`, 'POST'),
    async dispose() {
      const response = await fetch(controlUrl, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) {
        throw new Error(`fake provider scenario delete failed: ${response.status}`)
      }
    },
  }
}

async function requestScenario(controlUrl, method, config) {
  const response = await fetch(controlUrl, {
    method,
    ...(config
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(config),
        }
      : {}),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`fake provider control ${method} failed: ${response.status} ${body}`)
  }
  const snapshot = await response.json()
  if (
    typeof snapshot?.providerBaseUrl !== 'string' ||
    typeof snapshot?.activeStreams !== 'number' ||
    typeof snapshot?.requestCount !== 'number' ||
    !Array.isArray(snapshot?.requests)
  ) {
    throw new Error('fake provider returned an invalid control snapshot')
  }
  return snapshot
}

async function resetWorkspace(page, appUrl) {
  const resetUrl = new URL('/__natter-profile-reset__', appUrl).href
  await page.route(resetUrl, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Reset</title>' }),
  )
  try {
    await page.goto(resetUrl, { waitUntil: 'domcontentloaded' })
  } finally {
    await page.unroute(resetUrl)
  }
  await page.evaluate(async () => {
    localStorage.clear()
    sessionStorage.clear()
    const names = new Set(['natter', 'natter-control', 'natter-workspace-a', 'natter-workspace-b'])
    if (typeof indexedDB.databases === 'function') {
      for (const database of await indexedDB.databases()) {
        if (database.name) names.add(database.name)
      }
    }
    for (const name of [...names].sort()) {
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
        request.onblocked = () => reject(new Error(`${name} database deletion was blocked`))
      })
    }
  })
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
}

export async function seedAndRetargetWorkspace(page, { appUrl, providerBaseUrl }) {
  await resetWorkspace(page, appUrl)
  const addConnection = page.locator('[data-ui="connection-add"]')
  await addConnection.waitFor({ state: 'visible' })
  await addConnection.click()
  await page.locator('[data-ui="connection-setup-key"]').fill('sk-profile-loopback-placeholder')
  await page.locator('[data-ui="connection-setup-submit"]').click()
  await page.locator('[data-ui="connection-setup-modal"]').waitFor({ state: 'detached' })
  await retargetWorkspaceThroughBackupImport(page, providerBaseUrl, {
    name: 'Loopback profiling provider',
    paretoFilter: false,
  })
}

export async function prepareAdditionalPage(page, { appUrl }) {
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('#root > *').first().waitFor({ state: 'visible' })
}

export async function openNewChat(page) {
  const newChat = page.locator('[data-role="new-chat"]')
  await newChat.waitFor({ state: 'visible' })
  await newChat.click()
  await page.locator('[data-ui="composer"]').waitFor({ state: 'visible' })
  await page.waitForFunction(() => location.hash === '#/new')
}

export async function navigateToChat(page, chatId, leafId) {
  const hash = `#/chat/${chatId}/message/${leafId}`
  await page.evaluate((nextHash) => {
    location.hash = nextHash
  }, hash)
  await page.waitForFunction((expected) => location.hash === expected, hash)
  await page
    .locator(`[data-ui="message"][data-message-id="${leafId}"]`)
    .waitFor({ state: 'visible' })
  await page.locator('[data-ui="composer"]').waitFor({ state: 'visible' })
}

export async function startComposerSend(page, prompt) {
  const previous = parseChatRoute(await page.evaluate(() => location.hash))
  await page.locator('[data-ui="composer-input"]').fill(prompt)
  await page.locator('[data-ui="send"]').click()
  const route = await waitForNewAssistantRoute(page, previous?.assistantMessageId)
  const header = await waitForMessageHeader(page, route.assistantMessageId)
  if (typeof header.parentId !== 'string') {
    throw new Error(`assistant ${route.assistantMessageId} has no user parent`)
  }
  return {
    chatId: route.chatId,
    userMessageId: header.parentId,
    assistantMessageId: route.assistantMessageId,
  }
}

export async function startRegenerate(page, sourceAssistantId) {
  const source = page.locator(`[data-ui="message"][data-message-id="${sourceAssistantId}"]`)
  await source.waitFor({ state: 'visible' })
  await source.locator('[data-action="regenerate"]').click()
  const route = await waitForNewAssistantRoute(page, sourceAssistantId)
  const header = await waitForMessageHeader(page, route.assistantMessageId)
  if (typeof header.parentId !== 'string') {
    throw new Error(`regenerated assistant ${route.assistantMessageId} has no user parent`)
  }
  return {
    chatId: route.chatId,
    userMessageId: header.parentId,
    assistantMessageId: route.assistantMessageId,
  }
}

async function waitForNewAssistantRoute(page, previousAssistantId) {
  const handle = await page.waitForFunction((previous) => {
    const match = /^#\/chat\/([^/]+)\/message\/([^/?#]+)$/u.exec(location.hash)
    if (!match?.[1] || !match[2] || match[2] === previous) return null
    const message = document.querySelector(
      `[data-ui="message"][data-role="assistant"][data-message-id="${match[2]}"]`,
    )
    return message ? { chatId: match[1], assistantMessageId: match[2] } : null
  }, previousAssistantId ?? null)
  return handle.jsonValue()
}

function parseChatRoute(hash) {
  const match = /^#\/chat\/([^/]+)\/message\/([^/?#]+)$/u.exec(hash)
  return match?.[1] && match[2] ? { chatId: match[1], assistantMessageId: match[2] } : null
}

async function waitForMessageHeader(page, messageId) {
  let header
  const databaseName = await activeWorkspaceDatabaseName(page)
  await waitUntil(
    async () => {
      header = await page.evaluate(
        async ({ databaseName, id }) => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(databaseName)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
          try {
            return await new Promise((resolve, reject) => {
              const request = db.transaction('messages', 'readonly').objectStore('messages').get(id)
              request.onsuccess = () => resolve(request.result ?? null)
              request.onerror = () => reject(request.error)
            })
          } finally {
            db.close()
          }
        },
        { databaseName, id: messageId },
      )
      return header !== null && header !== undefined
    },
    30_000,
    `message header ${messageId}`,
  )
  return header
}

export async function waitForWorkspaceStreamQuiescence(page, assistantIds, timeoutMs) {
  if (assistantIds.length === 0) return []
  let snapshot
  await waitUntil(
    async () => {
      snapshot = await readWorkspaceStreamState(page, assistantIds)
      return (
        snapshot.leaseCount === 0 &&
        snapshot.chunkCount === 0 &&
        snapshot.states.every(
          (state) => state.status !== 'streaming' && typeof state.finishedAt === 'number',
        )
      )
    },
    timeoutMs,
    'workspace streams to quiesce',
  )
  return snapshot.states
}

async function readWorkspaceStreamState(page, assistantIds) {
  const databaseName = await activeWorkspaceDatabaseName(page)
  return page.evaluate(
    async ({ databaseName, ids }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        const transaction = db.transaction(['messages', 'streamLeases', 'streamChunks'], 'readonly')
        const requestResult = (request) =>
          new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
        const messageStore = transaction.objectStore('messages')
        const [rows, leaseCount, chunkCount] = await Promise.all([
          Promise.all(ids.map((id) => requestResult(messageStore.get(id)))),
          requestResult(transaction.objectStore('streamLeases').count()),
          requestResult(transaction.objectStore('streamChunks').count()),
        ])
        return {
          states: rows.map((row, index) => ({
            id: ids[index],
            status: row?.generation?.status ?? 'missing',
            integrity: row?.generation?.integrity ?? null,
            finishedAt: row?.generation?.finishedAt ?? null,
          })),
          leaseCount,
          chunkCount,
        }
      } finally {
        db.close()
      }
    },
    { databaseName, ids: assistantIds },
  )
}

export async function waitForProviderIdle(scenario, timeoutMs) {
  await waitUntil(
    async () => (await scenario.snapshot()).activeStreams === 0,
    timeoutMs,
    'fake provider streams to finish',
  )
}

export function monitorScenario(scenario, intervalMs = 10) {
  let running = true
  let maxActiveStreams = 0
  let samples = 0
  let failure
  const loop = (async () => {
    while (running) {
      try {
        const snapshot = await scenario.snapshot()
        maxActiveStreams = Math.max(maxActiveStreams, snapshot.activeStreams)
        samples += 1
      } catch (error) {
        failure = error
        running = false
        break
      }
      await delay(intervalMs)
    }
  })()
  return {
    async stop() {
      running = false
      await loop
      if (failure) throw failure
      const final = await scenario.snapshot()
      maxActiveStreams = Math.max(maxActiveStreams, final.activeStreams)
      return { maxActiveStreams, samples, final }
    },
  }
}

export function repeatedSeedText(seed, size) {
  if (size === 0) return ''
  return seed.repeat(Math.ceil(size / seed.length)).slice(0, size)
}

async function waitUntil(predicate, timeoutMs, label, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await delay(intervalMs)
  }
  throw new Error(`${label} exceeded ${timeoutMs} ms${lastError ? `: ${lastError}` : ''}`)
}

async function withTimeout(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
