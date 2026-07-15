import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

interface ReadyMessage {
  event: 'listening'
  url: string
}

interface StartedServer {
  child: ChildProcessWithoutNullStreams
  url: string
}

const children = new Set<ChildProcessWithoutNullStreams>()

afterEach(async () => {
  await Promise.all([...children].map(stopServer))
  children.clear()
})

describe('fake stream server', () => {
  it('isolates bounded scenarios and streams exact reasoning and content lengths', async () => {
    const server = await startServer()
    const [scenarioA, scenarioB] = await Promise.all([
      putScenario(server.url, 'worker-a', {
        targetChars: 11,
        reasoningChars: 7,
        chunkChars: 4,
        reasoningChunkChars: 3,
        initialDelayMs: 250,
        delayMs: 0,
      }),
      putScenario(server.url, 'worker-b', {
        targetChars: 5,
        reasoningChars: 3,
        chunkChars: 2,
        delayMs: 0,
      }),
    ])

    const models = await fetch(`${server.url}/v1/models`, {
      headers: { Origin: 'http://127.0.0.1:4173' },
    })
    expect(models.status).toBe(200)
    expect(models.headers.get('access-control-allow-origin')).toBe('*')
    await expect(models.json()).resolves.toMatchObject({
      data: [{ id: 'natter/fake-stream' }],
    })
    const geminiCompatibleModels = await fetch(`${server.url}/v1/openai/models`)
    expect(geminiCompatibleModels.status).toBe(200)
    await expect(geminiCompatibleModels.json()).resolves.toMatchObject({
      data: [{ id: 'natter/fake-stream' }],
    })

    const streamAPromise = requestStream(scenarioA.providerBaseUrl, 'first prompt')
    await expect.poll(async () => (await getScenario(server.url, 'worker-a')).activeStreams).toBe(1)
    const [streamA, streamB] = await Promise.all([
      streamAPromise,
      requestStream(scenarioB.providerBaseUrl, 'second prompt'),
    ])
    expect(streamA).toMatchObject({
      contentLength: 11,
      reasoningLength: 7,
      maxContentDeltaLength: 4,
      maxReasoningDeltaLength: 3,
      finishReason: 'stop',
      done: true,
    })
    expect(streamB).toMatchObject({
      contentLength: 5,
      reasoningLength: 3,
      maxContentDeltaLength: 2,
      maxReasoningDeltaLength: 2,
      finishReason: 'stop',
      done: true,
    })

    const [stateA, stateB] = await Promise.all([
      getScenario(server.url, 'worker-a'),
      getScenario(server.url, 'worker-b'),
    ])
    expect(stateA).toMatchObject({
      activeStreams: 0,
      requestCount: 1,
      requests: [{ promptChars: 12, stream: true }],
    })
    expect(stateB).toMatchObject({
      activeStreams: 0,
      requestCount: 1,
      requests: [{ promptChars: 13, stream: true }],
    })

    const rejected = await fetch(`${server.url}/__control/scenarios/too-large`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetChars: 11 * 1024 * 1024 }),
    })
    expect(rejected.status).toBe(400)

    const fixtures = await putScenario(server.url, 'provider-fixtures', {
      responses: [
        {
          method: 'POST',
          path: '/responses',
          json: { id: 'resp_fixture', status: 'completed', output: [] },
        },
        {
          method: 'POST',
          path: '/messages',
          headers: { 'x-fixture-kind': 'anthropic' },
          sseFrames: [{ event: 'message_start', data: { type: 'message_start' } }, '[DONE]'],
        },
        {
          method: 'POST',
          path: '/raw-fragments',
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          rawChunks: [
            'da',
            { body: 'ta: ', delayMs: 1 },
            '{"ok":true}\n\n',
            { body: 'data: [DONE]\n\n' },
          ],
        },
      ],
    })
    await expect(getScenario(server.url, 'provider-fixtures')).resolves.toMatchObject({
      queuedResponses: [
        { path: '/responses', kind: 'json' },
        { path: '/messages', kind: 'sseFrames', frameCount: 2 },
        { path: '/raw-fragments', kind: 'rawChunks', chunkCount: 4 },
      ],
    })
    const buffered = await fetch(`${fixtures.providerBaseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture', stream: true }),
    })
    await expect(buffered.json()).resolves.toEqual({
      id: 'resp_fixture',
      status: 'completed',
      output: [],
    })
    const scriptedSse = await fetch(`${fixtures.providerBaseUrl}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture', stream: true }),
    })
    expect(scriptedSse.headers.get('x-fixture-kind')).toBe('anthropic')
    await expect(scriptedSse.text()).resolves.toContain('event: message_start')
    const rawFragments = await fetch(`${fixtures.providerBaseUrl}/raw-fragments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fixture', stream: true }),
    })
    expect(rawFragments.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    await expect(rawFragments.text()).resolves.toBe('data: {"ok":true}\n\ndata: [DONE]\n\n')
    await expect(getScenario(server.url, 'provider-fixtures')).resolves.toMatchObject({
      requestCount: 3,
      queuedResponses: [],
      storedBytes: 0,
    })
  })
})

async function startServer(): Promise<StartedServer> {
  const child = spawn(process.execPath, [resolve('scripts/fake-stream-server.mjs'), '--port=0'], {
    cwd: resolve('.'),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let stderr = ''
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const ready = await new Promise<ReadyMessage>((resolveReady, reject) => {
    let stdout = ''
    const timeout = setTimeout(() => {
      reject(new Error(`fake stream server did not become ready: ${stderr}`))
    }, 5_000)
    const onExit = (code: number | null) => {
      clearTimeout(timeout)
      reject(new Error(`fake stream server exited with ${code}: ${stderr}`))
    }
    const onData = (chunk: string) => {
      stdout += chunk
      const newline = stdout.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timeout)
      child.off('exit', onExit)
      child.stdout.off('data', onData)
      try {
        resolveReady(JSON.parse(stdout.slice(0, newline)) as ReadyMessage)
      } catch (error) {
        reject(error)
      }
    }
    child.once('exit', onExit)
    child.stdout.on('data', onData)
  })
  expect(ready.event).toBe('listening')
  return { child, url: ready.url }
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  children.delete(child)
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('fake stream server did not stop')), 5_000),
    ),
  ])
}

async function putScenario(
  serverUrl: string,
  scenarioId: string,
  config: Record<string, unknown>,
): Promise<{ providerBaseUrl: string }> {
  const response = await fetch(`${serverUrl}/__control/scenarios/${scenarioId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { providerBaseUrl: string }
}

async function getScenario(
  serverUrl: string,
  scenarioId: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${serverUrl}/__control/scenarios/${scenarioId}`)
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

async function requestStream(providerBaseUrl: string, prompt: string) {
  const response = await fetch(`${providerBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: 'http://127.0.0.1:4173',
    },
    body: JSON.stringify({
      model: 'natter/fake-stream',
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    }),
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('access-control-allow-origin')).toBe('*')
  const body = await response.text()
  let contentLength = 0
  let reasoningLength = 0
  let maxContentDeltaLength = 0
  let maxReasoningDeltaLength = 0
  let finishReason: string | null = null
  let done = false
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const data = line.slice('data: '.length)
    if (data === '[DONE]') {
      done = true
      continue
    }
    const frame = JSON.parse(data) as {
      choices?: Array<{
        delta?: { content?: string; reasoning?: string }
        finish_reason?: string | null
      }>
    }
    const choice = frame.choices?.[0]
    const content = choice?.delta?.content ?? ''
    const reasoning = choice?.delta?.reasoning ?? ''
    contentLength += content.length
    reasoningLength += reasoning.length
    maxContentDeltaLength = Math.max(maxContentDeltaLength, content.length)
    maxReasoningDeltaLength = Math.max(maxReasoningDeltaLength, reasoning.length)
    finishReason = choice?.finish_reason ?? finishReason
  }
  return {
    contentLength,
    reasoningLength,
    maxContentDeltaLength,
    maxReasoningDeltaLength,
    finishReason,
    done,
  }
}
