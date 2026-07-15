#!/usr/bin/env node

import { createServer } from 'node:http'

const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 4174,
  targetChars: 2,
  reasoningChars: 0,
  chunkChars: 128,
  reasoningChunkChars: 128,
  initialDelayMs: 0,
  delayMs: 0,
})

const LIMITS = Object.freeze({
  bodyBytes: 4 * 1024 * 1024,
  bufferedChars: 1024 * 1024,
  targetChars: 10 * 1024 * 1024,
  reasoningChars: 10 * 1024 * 1024,
  chunkChars: 1024 * 1024,
  delayMs: 60_000,
  scenarios: 512,
  scenarioBytes: 32 * 1024 * 1024,
  scenarioRequests: 64,
  scenarioIdChars: 128,
  scenarioTtlMs: 30 * 60_000,
})

const MODEL_ID = 'natter/fake-stream'
const TEXT_SEED =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer vitae sem sed nulla gravida feugiat. '
const REASONING_SEED =
  'Reasoning fragment for deterministic loopback stream validation and bounded memory profiling. '
const SCENARIO_ID_PATTERN = /^[A-Za-z0-9._~-]+$/u

let options
try {
  options = parseCli(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

if (options.help) {
  process.stdout.write(helpText())
  process.exit(0)
}

const scenarios = new Map()
let requestSequence = 0
let storedScenarioBytes = 0

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    if (response.headersSent || response.destroyed) {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const status = error instanceof HttpError ? error.status : 500
    sendJson(response, status, {
      error: {
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
        message: error instanceof Error ? error.message : String(error),
      },
    })
  })
})

server.requestTimeout = 0
server.headersTimeout = 30_000
server.keepAliveTimeout = 5_000

server.listen(options.port, options.host, () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : options.port
  process.stdout.write(
    `${JSON.stringify({
      event: 'listening',
      host: options.host,
      port,
      url: originFor(options.host, port),
      model: MODEL_ID,
    })}\n`,
  )
})

server.on('error', (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    const forcedExit = setTimeout(() => {
      server.closeAllConnections()
      process.exit(1)
    }, 5_000)
    forcedExit.unref()
    server.close(() => {
      clearTimeout(forcedExit)
      process.exit(0)
    })
  })
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? '/', 'http://loopback.invalid')
  if (request.method === 'GET' && url.pathname === '/healthz') {
    sendJson(response, 200, { ok: true, model: MODEL_ID })
    return
  }

  const control = parseControlRoute(url.pathname)
  if (control) {
    await handleControlRequest(request, response, control.scenarioId)
    return
  }

  const provider = parseProviderRoute(url.pathname)
  if (!provider) throw new HttpError(404, 'Route not found')
  setProviderCorsHeaders(request, response)
  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  const selected = selectScenario(request, url, provider.scenarioId)
  const method = request.method ?? 'GET'
  const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(request)
  const requestId = `fake-${Date.now().toString(36)}-${(++requestSequence).toString(36)}`
  const requestRecord = summarizeRequest(requestId, method, provider.relativePath, body)
  if (selected.entry) recordScenarioRequest(selected.entry, requestRecord)

  const scripted = selected.entry
    ? takeScriptedResponse(selected.entry, method, provider.relativePath)
    : undefined
  if (scripted) {
    await sendScriptedResponse(request, response, requestId, selected, scripted)
    return
  }

  if (provider.relativePath === '/models' || provider.relativePath === '/openai/models') {
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed')
    sendJson(
      response,
      200,
      {
        object: 'list',
        data: [
          {
            id: MODEL_ID,
            object: 'model',
            created: 0,
            owned_by: 'natter',
          },
        ],
      },
      providerCorsHeaders(request),
    )
    return
  }
  if (provider.relativePath !== '/chat/completions') {
    throw new HttpError(409, `No scripted response remains for ${method} ${provider.relativePath}`)
  }
  if (method !== 'POST') throw new HttpError(405, 'Method not allowed')

  const config = { ...selected.config }
  if (body.stream === false) {
    sendBufferedCompletion(request, response, requestId, body, config, selected.scenarioId)
    return
  }
  await sendStreamingCompletion(request, response, requestId, body, config, selected)
}

async function handleControlRequest(request, response, scenarioId) {
  pruneScenarios()
  if (request.method === 'PUT') {
    const body = await readJsonBody(request)
    const definition = parseScenarioDefinition(body)
    const existing = scenarios.get(scenarioId)
    if (!existing && scenarios.size >= LIMITS.scenarios) {
      throw new HttpError(429, `Scenario limit reached (${LIMITS.scenarios})`)
    }
    const now = Date.now()
    const nextStoredScenarioBytes =
      storedScenarioBytes - (existing?.storedBytes ?? 0) + definition.storedBytes
    if (nextStoredScenarioBytes > LIMITS.scenarioBytes) {
      throw new HttpError(429, `Stored scenario data exceeds ${LIMITS.scenarioBytes} bytes`)
    }
    const entry = existing ?? {
      scenarioId,
      config: definition.config,
      scriptedResponses: definition.scriptedResponses,
      storedBytes: definition.storedBytes,
      createdAt: now,
      updatedAt: now,
      lastTouchedAt: now,
      activeStreams: 0,
      requestCount: 0,
      requests: [],
    }
    entry.config = definition.config
    entry.scriptedResponses = definition.scriptedResponses
    entry.storedBytes = definition.storedBytes
    entry.updatedAt = now
    entry.lastTouchedAt = now
    entry.requestCount = 0
    entry.requests = []
    storedScenarioBytes = nextStoredScenarioBytes
    scenarios.set(scenarioId, entry)
    sendJson(response, existing ? 200 : 201, controlSnapshot(entry))
    return
  }
  if (request.method === 'GET') {
    const entry = scenarios.get(scenarioId)
    if (!entry) throw new HttpError(404, `Unknown scenario: ${scenarioId}`)
    entry.lastTouchedAt = Date.now()
    sendJson(response, 200, controlSnapshot(entry))
    return
  }
  if (request.method === 'DELETE') {
    const entry = scenarios.get(scenarioId)
    const deleted = scenarios.delete(scenarioId)
    if (deleted && entry) storedScenarioBytes -= entry.storedBytes
    sendJson(response, deleted ? 200 : 404, { deleted, scenarioId })
    return
  }
  throw new HttpError(405, 'Method not allowed')
}

function parseControlRoute(pathname) {
  const match = /^\/__control\/scenarios\/([^/]+)$/u.exec(pathname)
  if (!match) return null
  return { scenarioId: parseScenarioId(match[1]) }
}

function parseProviderRoute(pathname) {
  if (pathname.startsWith('/v1/')) {
    return { relativePath: pathname.slice('/v1'.length), scenarioId: null }
  }
  const match = /^\/scenarios\/([^/]+)\/v1(\/.*)$/u.exec(pathname)
  if (!match || match[2] === '/') return null
  return {
    relativePath: match[2],
    scenarioId: parseScenarioId(match[1]),
  }
}

function selectScenario(request, url, pathScenarioId) {
  const headerValue = request.headers['x-natter-fake-scenario']
  const headerScenarioId =
    typeof headerValue === 'string' ? parseScenarioId(headerValue) : undefined
  const queryValue = url.searchParams.get('scenario')
  const queryScenarioId = queryValue === null ? undefined : parseScenarioId(queryValue)
  const candidates = [pathScenarioId ?? undefined, queryScenarioId, headerScenarioId].filter(
    (value) => value !== undefined,
  )
  const scenarioId = candidates[0]
  if (candidates.some((candidate) => candidate !== scenarioId)) {
    throw new HttpError(400, 'Conflicting fake-provider scenario selectors')
  }
  if (scenarioId === undefined) {
    return { scenarioId: 'default', config: options.defaults, entry: null }
  }
  const entry = scenarios.get(scenarioId)
  if (!entry) throw new HttpError(404, `Unknown scenario: ${scenarioId}`)
  entry.lastTouchedAt = Date.now()
  return { scenarioId, config: entry.config, entry }
}

function parseScenarioId(raw) {
  let value
  try {
    value = decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, 'Scenario id is not valid URL encoding')
  }
  if (
    value.length === 0 ||
    value.length > LIMITS.scenarioIdChars ||
    !SCENARIO_ID_PATTERN.test(value)
  ) {
    throw new HttpError(400, 'Scenario id must use 1-128 URL-safe characters')
  }
  return value
}

function parseScenarioDefinition(value) {
  if (!isRecord(value)) throw new HttpError(400, 'Scenario body must be a JSON object')
  const allowed = new Set([
    'targetChars',
    'reasoningChars',
    'chunkChars',
    'reasoningChunkChars',
    'initialDelayMs',
    'delayMs',
    'responses',
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new HttpError(400, `Unknown scenario option: ${key}`)
  }
  const chunkChars = boundedInteger(
    value.chunkChars ?? options.defaults.chunkChars,
    'chunkChars',
    1,
    LIMITS.chunkChars,
  )
  const defaultReasoningChunkChars =
    value.chunkChars === undefined ? options.defaults.reasoningChunkChars : chunkChars
  const config = {
    targetChars: boundedInteger(
      value.targetChars ?? options.defaults.targetChars,
      'targetChars',
      0,
      LIMITS.targetChars,
    ),
    reasoningChars: boundedInteger(
      value.reasoningChars ?? options.defaults.reasoningChars,
      'reasoningChars',
      0,
      LIMITS.reasoningChars,
    ),
    chunkChars,
    reasoningChunkChars: boundedInteger(
      value.reasoningChunkChars ?? defaultReasoningChunkChars,
      'reasoningChunkChars',
      1,
      LIMITS.chunkChars,
    ),
    initialDelayMs: boundedInteger(
      value.initialDelayMs ?? options.defaults.initialDelayMs,
      'initialDelayMs',
      0,
      LIMITS.delayMs,
    ),
    delayMs: boundedInteger(
      value.delayMs ?? options.defaults.delayMs,
      'delayMs',
      0,
      LIMITS.delayMs,
    ),
  }
  const rawResponses = value.responses ?? []
  if (!Array.isArray(rawResponses)) throw new HttpError(400, 'responses must be an array')
  const scriptedResponses = rawResponses.map(parseScriptedResponse)
  return {
    config,
    scriptedResponses,
    storedBytes: scriptedResponses.reduce((sum, scripted) => sum + scripted.storedBytes, 0),
  }
}

function parseScriptedResponse(value, index) {
  if (!isRecord(value)) throw new HttpError(400, `responses[${index}] must be an object`)
  const allowed = new Set([
    'method',
    'path',
    'status',
    'headers',
    'json',
    'body',
    'sseFrames',
    'rawChunks',
    'delayMs',
    'close',
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new HttpError(400, `Unknown responses[${index}] option: ${key}`)
  }
  const method = typeof value.method === 'string' ? value.method.toUpperCase() : 'POST'
  if (!/^[A-Z]+$/u.test(method)) throw new HttpError(400, `responses[${index}].method is invalid`)
  if (
    typeof value.path !== 'string' ||
    !value.path.startsWith('/') ||
    value.path.includes('?') ||
    value.path.length > 1024
  ) {
    throw new HttpError(
      400,
      `responses[${index}].path must be a pathname beginning with / and without a query`,
    )
  }
  const payloadKeys = ['json', 'body', 'sseFrames', 'rawChunks'].filter((key) => key in value)
  if (payloadKeys.length > 1) {
    throw new HttpError(400, `responses[${index}] may define only one response payload`)
  }
  if ('body' in value && typeof value.body !== 'string') {
    throw new HttpError(400, `responses[${index}].body must be a string`)
  }
  const headers = parseScriptedHeaders(value.headers, index)
  const sseFrames = 'sseFrames' in value ? parseSseFrames(value.sseFrames, index) : undefined
  const rawChunks = 'rawChunks' in value ? parseRawChunks(value.rawChunks, index) : undefined
  const storedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  return {
    method,
    path: value.path,
    status: boundedInteger(value.status ?? 200, `responses[${index}].status`, 200, 599),
    headers,
    ...(payloadKeys[0] === 'json' ? { json: value.json } : {}),
    ...(payloadKeys[0] === 'body' ? { body: value.body } : {}),
    ...(sseFrames ? { sseFrames } : {}),
    ...(rawChunks ? { rawChunks } : {}),
    delayMs: boundedInteger(value.delayMs ?? 0, `responses[${index}].delayMs`, 0, LIMITS.delayMs),
    close: value.close === true,
    storedBytes,
  }
}

function parseScriptedHeaders(value, responseIndex) {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw new HttpError(400, `responses[${responseIndex}].headers must be an object`)
  }
  const entries = Object.entries(value)
  if (entries.length > 64) {
    throw new HttpError(400, `responses[${responseIndex}].headers exceeds 64 entries`)
  }
  const headers = {}
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) || typeof rawValue !== 'string') {
      throw new HttpError(400, `responses[${responseIndex}].headers contains an invalid entry`)
    }
    if (['connection', 'content-length', 'transfer-encoding'].includes(name)) {
      throw new HttpError(400, `responses[${responseIndex}].headers cannot set ${name}`)
    }
    headers[name] = rawValue
  }
  return headers
}

function parseSseFrames(value, responseIndex) {
  if (!Array.isArray(value)) {
    throw new HttpError(400, `responses[${responseIndex}].sseFrames must be an array`)
  }
  if (value.length > 10_000) {
    throw new HttpError(400, `responses[${responseIndex}].sseFrames exceeds 10000 frames`)
  }
  return value.map((frame, frameIndex) => {
    if (typeof frame === 'string') return { data: frame, delayMs: 0 }
    if (!isRecord(frame) || !('data' in frame)) {
      throw new HttpError(
        400,
        `responses[${responseIndex}].sseFrames[${frameIndex}] must be a string or data object`,
      )
    }
    const allowed = new Set(['data', 'event', 'id', 'delayMs'])
    for (const key of Object.keys(frame)) {
      if (!allowed.has(key)) {
        throw new HttpError(
          400,
          `Unknown responses[${responseIndex}].sseFrames[${frameIndex}] option: ${key}`,
        )
      }
    }
    for (const key of ['event', 'id']) {
      const metadata = frame[key]
      if (
        metadata !== undefined &&
        (typeof metadata !== 'string' || metadata.length > 1024 || /[\r\n]/u.test(metadata))
      ) {
        throw new HttpError(
          400,
          `responses[${responseIndex}].sseFrames[${frameIndex}].${key} is invalid`,
        )
      }
    }
    return {
      data: frame.data,
      ...(frame.event === undefined ? {} : { event: frame.event }),
      ...(frame.id === undefined ? {} : { id: frame.id }),
      delayMs: boundedInteger(
        frame.delayMs ?? 0,
        `responses[${responseIndex}].sseFrames[${frameIndex}].delayMs`,
        0,
        LIMITS.delayMs,
      ),
    }
  })
}

function parseRawChunks(value, responseIndex) {
  if (!Array.isArray(value)) {
    throw new HttpError(400, `responses[${responseIndex}].rawChunks must be an array`)
  }
  if (value.length > 10_000) {
    throw new HttpError(400, `responses[${responseIndex}].rawChunks exceeds 10000 chunks`)
  }
  return value.map((chunk, chunkIndex) => {
    if (typeof chunk === 'string') return { body: chunk, delayMs: 0, close: false }
    if (!isRecord(chunk) || typeof chunk.body !== 'string') {
      throw new HttpError(
        400,
        `responses[${responseIndex}].rawChunks[${chunkIndex}] must be a string or body object`,
      )
    }
    const allowed = new Set(['body', 'delayMs', 'close'])
    for (const key of Object.keys(chunk)) {
      if (!allowed.has(key)) {
        throw new HttpError(
          400,
          `Unknown responses[${responseIndex}].rawChunks[${chunkIndex}] option: ${key}`,
        )
      }
    }
    return {
      body: chunk.body,
      delayMs: boundedInteger(
        chunk.delayMs ?? 0,
        `responses[${responseIndex}].rawChunks[${chunkIndex}].delayMs`,
        0,
        LIMITS.delayMs,
      ),
      close: chunk.close === true,
    }
  })
}

function takeScriptedResponse(entry, method, relativePath) {
  const index = entry.scriptedResponses.findIndex(
    (scripted) => scripted.method === method && scripted.path === relativePath,
  )
  if (index < 0) return undefined
  const [scripted] = entry.scriptedResponses.splice(index, 1)
  entry.storedBytes -= scripted.storedBytes
  storedScenarioBytes -= scripted.storedBytes
  return scripted
}

async function sendScriptedResponse(request, response, requestId, selected, scripted) {
  const abortController = new AbortController()
  const abort = () => abortController.abort()
  request.once('aborted', abort)
  response.once('close', abort)
  selected.entry.activeStreams += 1
  try {
    await abortableDelay(scripted.delayMs, abortController.signal)
    if (abortController.signal.aborted) return
    const responseHeaders = {
      ...providerCorsHeaders(request),
      'cache-control': 'no-store',
      'x-natter-fake-request': requestId,
      'x-natter-fake-scenario': selected.scenarioId,
      ...scripted.headers,
    }
    if ('json' in scripted) {
      sendJson(response, scripted.status, scripted.json, responseHeaders)
      return
    }
    if (scripted.rawChunks) {
      response.writeHead(scripted.status, {
        'content-type': 'application/octet-stream',
        ...responseHeaders,
      })
      response.flushHeaders()
      for (const chunk of scripted.rawChunks) {
        if (abortController.signal.aborted) return
        if (!(await writeResponseChunk(response, chunk.body))) return
        if (chunk.close) {
          response.destroy()
          return
        }
        await abortableDelay(chunk.delayMs, abortController.signal)
      }
      if (scripted.close) {
        response.destroy()
      } else {
        response.end()
      }
      return
    }
    if (scripted.sseFrames) {
      response.writeHead(scripted.status, {
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
        ...responseHeaders,
      })
      response.flushHeaders()
      for (const frame of scripted.sseFrames) {
        if (abortController.signal.aborted) return
        if (!(await writeResponseChunk(response, formatSseFrame(frame)))) return
        await abortableDelay(frame.delayMs, abortController.signal)
      }
      if (scripted.close) {
        response.destroy()
      } else {
        response.end()
      }
      return
    }
    response.writeHead(scripted.status, {
      'content-type': 'text/plain; charset=utf-8',
      ...responseHeaders,
    })
    if (scripted.body !== undefined) await writeResponseChunk(response, scripted.body)
    if (scripted.close) {
      response.destroy()
    } else {
      response.end()
    }
  } finally {
    request.off('aborted', abort)
    response.off('close', abort)
    selected.entry.activeStreams = Math.max(0, selected.entry.activeStreams - 1)
    selected.entry.lastTouchedAt = Date.now()
  }
}

function formatSseFrame(frame) {
  const lines = []
  if (frame.event !== undefined) lines.push(`event: ${frame.event}`)
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`)
  const data = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)
  for (const line of data.split(/\r?\n/u)) lines.push(`data: ${line}`)
  return `${lines.join('\n')}\n\n`
}

async function sendStreamingCompletion(request, response, requestId, body, config, selected) {
  const model = typeof body.model === 'string' ? body.model : MODEL_ID
  const abortController = new AbortController()
  const abort = () => abortController.abort()
  request.once('aborted', abort)
  response.once('close', abort)
  if (selected.entry) selected.entry.activeStreams += 1

  response.writeHead(200, {
    ...providerCorsHeaders(request),
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-accel-buffering': 'no',
    'x-natter-fake-request': requestId,
    'x-natter-fake-scenario': selected.scenarioId,
  })
  response.flushHeaders()

  try {
    await abortableDelay(config.initialDelayMs, abortController.signal)
    if (abortController.signal.aborted) return
    let chunkIndex = 0
    chunkIndex = await streamLane({
      response,
      signal: abortController.signal,
      requestId,
      model,
      lane: 'reasoning',
      seed: REASONING_SEED,
      totalChars: config.reasoningChars,
      chunkChars: config.reasoningChunkChars,
      delayMs: config.delayMs,
      chunkIndex,
    })
    await streamLane({
      response,
      signal: abortController.signal,
      requestId,
      model,
      lane: 'content',
      seed: TEXT_SEED,
      totalChars: config.targetChars,
      chunkChars: config.chunkChars,
      delayMs: config.delayMs,
      chunkIndex,
    })
    if (abortController.signal.aborted) return
    const finalFrame = {
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: completionUsage(config),
    }
    if (!(await writeResponseChunk(response, `data: ${JSON.stringify(finalFrame)}\n\n`))) return
    if (!(await writeResponseChunk(response, 'data: [DONE]\n\n'))) return
    response.end()
  } finally {
    request.off('aborted', abort)
    response.off('close', abort)
    if (selected.entry) {
      selected.entry.activeStreams = Math.max(0, selected.entry.activeStreams - 1)
      selected.entry.lastTouchedAt = Date.now()
    }
  }
}

async function streamLane(input) {
  let emitted = 0
  let chunkIndex = input.chunkIndex
  while (emitted < input.totalChars && !input.signal.aborted) {
    const size = Math.min(input.chunkChars, input.totalChars - emitted)
    const text = seededChunk(input.seed, emitted, size)
    const delta = input.lane === 'reasoning' ? { reasoning: text } : { content: text }
    const frame = {
      id: input.requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: input.model,
      choices: [{ index: 0, delta, finish_reason: null }],
      natter_fake_chunk_index: chunkIndex,
    }
    if (!(await writeResponseChunk(input.response, `data: ${JSON.stringify(frame)}\n\n`))) break
    emitted += size
    chunkIndex += 1
    if (input.delayMs > 0 && emitted < input.totalChars) {
      await abortableDelay(input.delayMs, input.signal)
    }
  }
  return chunkIndex
}

function sendBufferedCompletion(request, response, requestId, body, config, scenarioId) {
  if (config.targetChars + config.reasoningChars > LIMITS.bufferedChars) {
    throw new HttpError(
      413,
      `Buffered fake responses are limited to ${LIMITS.bufferedChars} total characters`,
    )
  }
  const model = typeof body.model === 'string' ? body.model : MODEL_ID
  sendJson(
    response,
    200,
    {
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: seededChunk(TEXT_SEED, 0, config.targetChars),
            ...(config.reasoningChars > 0
              ? { reasoning: seededChunk(REASONING_SEED, 0, config.reasoningChars) }
              : {}),
          },
          finish_reason: 'stop',
        },
      ],
      usage: completionUsage(config),
    },
    {
      ...providerCorsHeaders(request),
      'x-natter-fake-request': requestId,
      'x-natter-fake-scenario': scenarioId,
    },
  )
}

function completionUsage(config) {
  const promptTokens = 8
  const completionTokens = Math.ceil(config.targetChars / 4)
  const reasoningTokens = Math.ceil(config.reasoningChars / 4)
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    completion_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: promptTokens + completionTokens + reasoningTokens,
  }
}

function summarizeRequest(requestId, method, path, body) {
  return {
    requestId,
    receivedAt: Date.now(),
    method,
    path,
    model: typeof body.model === 'string' ? body.model : null,
    stream: typeof body.stream === 'boolean' ? body.stream : null,
    promptChars: promptCharacterCount(body.messages),
    bodyBytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
  }
}

function promptCharacterCount(messages) {
  if (!Array.isArray(messages)) return 0
  let count = 0
  for (const message of messages) {
    if (!isRecord(message)) continue
    if (typeof message.content === 'string') {
      count += message.content.length
      continue
    }
    if (!Array.isArray(message.content)) continue
    for (const item of message.content) {
      if (isRecord(item) && typeof item.text === 'string') count += item.text.length
    }
  }
  return count
}

function recordScenarioRequest(entry, requestRecord) {
  entry.requestCount += 1
  entry.requests.push(requestRecord)
  if (entry.requests.length > LIMITS.scenarioRequests) {
    entry.requests.splice(0, entry.requests.length - LIMITS.scenarioRequests)
  }
  entry.lastTouchedAt = Date.now()
}

function controlSnapshot(entry) {
  return {
    scenarioId: entry.scenarioId,
    config: entry.config,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    activeStreams: entry.activeStreams,
    requestCount: entry.requestCount,
    requests: entry.requests,
    storedBytes: entry.storedBytes,
    queuedResponses: entry.scriptedResponses.map((scripted) => ({
      method: scripted.method,
      path: scripted.path,
      status: scripted.status,
      kind:
        'json' in scripted
          ? 'json'
          : scripted.sseFrames
            ? 'sseFrames'
            : scripted.rawChunks
              ? 'rawChunks'
              : 'body' in scripted
                ? 'body'
                : 'empty',
      storedBytes: scripted.storedBytes,
      ...(scripted.sseFrames ? { frameCount: scripted.sseFrames.length } : {}),
      ...(scripted.rawChunks ? { chunkCount: scripted.rawChunks.length } : {}),
    })),
    providerBaseUrl: `${originFor(options.host, server.address()?.port ?? options.port)}/scenarios/${encodeURIComponent(entry.scenarioId)}/v1`,
  }
}

function pruneScenarios(now = Date.now()) {
  for (const [scenarioId, entry] of scenarios) {
    if (entry.activeStreams === 0 && now - entry.lastTouchedAt > LIMITS.scenarioTtlMs) {
      scenarios.delete(scenarioId)
      storedScenarioBytes -= entry.storedBytes
    }
  }
}

async function readJsonBody(request) {
  let bytes = 0
  const chunks = []
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    bytes += chunk.byteLength
    if (bytes > LIMITS.bodyBytes) {
      throw new HttpError(413, `Request body exceeds ${LIMITS.bodyBytes} bytes`)
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
    if (!isRecord(parsed)) throw new Error('body is not an object')
    return parsed
  } catch (error) {
    throw new HttpError(
      400,
      `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function setProviderCorsHeaders(request, response) {
  for (const [name, value] of Object.entries(providerCorsHeaders(request))) {
    response.setHeader(name, value)
  }
}

function providerCorsHeaders(request) {
  return {
    'access-control-allow-headers':
      request.headers['access-control-request-headers'] ??
      'anthropic-beta, anthropic-version, authorization, content-type, http-referer, x-api-key, x-goog-api-key, x-natter-fake-scenario, x-openrouter-title',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'x-natter-fake-request, x-natter-fake-scenario',
  }
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  })
  response.end(`${JSON.stringify(value)}\n`)
}

function writeResponseChunk(response, chunk) {
  if (response.destroyed || response.writableEnded) return Promise.resolve(false)
  if (response.write(chunk)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const cleanup = () => {
      response.off('drain', onDrain)
      response.off('close', onClose)
      response.off('error', onClose)
    }
    const onDrain = () => {
      cleanup()
      resolve(true)
    }
    const onClose = () => {
      cleanup()
      resolve(false)
    }
    response.once('drain', onDrain)
    response.once('close', onClose)
    response.once('error', onClose)
  })
}

function abortableDelay(ms, signal) {
  if (signal.aborted || ms === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    const onAbort = () => done()
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function seededChunk(seed, offset, size) {
  if (size === 0) return ''
  const start = offset % seed.length
  const needed = start + size
  return seed.repeat(Math.ceil(needed / seed.length)).slice(start, needed)
}

function parseCli(args) {
  const values = new Map()
  let help = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
    const equals = arg.indexOf('=')
    const name = equals >= 0 ? arg.slice(2, equals) : arg.slice(2)
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined
    const value = inline ?? args[++index]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`)
    }
    if (values.has(name)) throw new Error(`Duplicate option: --${name}`)
    values.set(name, value)
  }
  const allowed = new Set([
    'host',
    'port',
    'target-chars',
    'reasoning-chars',
    'chunk-chars',
    'reasoning-chunk-chars',
    'initial-delay-ms',
    'delay-ms',
  ])
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`Unknown option: --${name}`)
  }
  const host = values.get('host') ?? DEFAULTS.host
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('--host must resolve to the local loopback interface')
  }
  const chunkChars = boundedInteger(
    values.get('chunk-chars') ?? DEFAULTS.chunkChars,
    'chunk-chars',
    1,
    LIMITS.chunkChars,
  )
  return {
    help,
    host,
    port: boundedInteger(values.get('port') ?? DEFAULTS.port, 'port', 0, 65_535),
    defaults: {
      targetChars: boundedInteger(
        values.get('target-chars') ?? DEFAULTS.targetChars,
        'target-chars',
        0,
        LIMITS.targetChars,
      ),
      reasoningChars: boundedInteger(
        values.get('reasoning-chars') ?? DEFAULTS.reasoningChars,
        'reasoning-chars',
        0,
        LIMITS.reasoningChars,
      ),
      chunkChars,
      reasoningChunkChars: boundedInteger(
        values.get('reasoning-chunk-chars') ?? chunkChars,
        'reasoning-chunk-chars',
        1,
        LIMITS.chunkChars,
      ),
      initialDelayMs: boundedInteger(
        values.get('initial-delay-ms') ?? DEFAULTS.initialDelayMs,
        'initial-delay-ms',
        0,
        LIMITS.delayMs,
      ),
      delayMs: boundedInteger(
        values.get('delay-ms') ?? DEFAULTS.delayMs,
        'delay-ms',
        0,
        LIMITS.delayMs,
      ),
    },
  }
}

function boundedInteger(value, name, minimum, maximum) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, `${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

function originFor(host, port) {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function helpText() {
  return `Usage: node scripts/fake-stream-server.mjs [options]\n\nOptions:\n  --host <host>                    Loopback host (default: ${DEFAULTS.host})\n  --port <port>                    Listening port; 0 selects a free port (default: ${DEFAULTS.port})\n  --target-chars <count>           Default streamed text characters (default: ${DEFAULTS.targetChars})\n  --reasoning-chars <count>        Default streamed reasoning characters (default: ${DEFAULTS.reasoningChars})\n  --chunk-chars <count>            Text characters per SSE delta (default: ${DEFAULTS.chunkChars})\n  --reasoning-chunk-chars <count>  Reasoning characters per SSE delta (default: text chunk size)\n  --initial-delay-ms <milliseconds> Delay before the first SSE delta (default: ${DEFAULTS.initialDelayMs})\n  --delay-ms <milliseconds>        Delay between deltas (default: ${DEFAULTS.delayMs})\n  --help                           Show this help\n\nProvider routes:\n  GET  /v1/models\n  POST /v1/chat/completions\n  GET|POST /scenarios/<id>/v1/...\n\nScenario control (loopback test process only; no CORS):\n  PUT    /__control/scenarios/<id>\n  GET    /__control/scenarios/<id>\n  DELETE /__control/scenarios/<id>\n`
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
