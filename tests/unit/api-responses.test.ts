// Phase 11: `api/responses.ts` adapter tests. Drives the adapter with the
// captured SSE probe fixture (probe 5) through a mocked fetch. See
// `plan/phase11-implementation.md §4.2`.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ResponsesContext, responses, responsesOnce } from '../../src/api/responses'
import type {
  ResponsesEventWire,
  ResponsesResultWire,
  ResponsesStreamChunk,
} from '../../src/api/types'
import type { ConnectionProfile } from '../../src/core/types'

const PROBE5_PATH = resolve(
  __dirname,
  '../../../plan/phase11-probes/05-openai-responses-stream-reasoning.sse',
)
const PROBE6_PATH = resolve(
  __dirname,
  '../../../plan/phase11-probes/06-openrouter-responses-openai.json',
)

function makeProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'prof',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyRef: 'key',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    usesResponsesApiByDefault: true,
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function ctx(): ResponsesContext {
  return { profile: makeProfile(), apiKey: 'sk-test' }
}

function sseResponse(body: string, extraHeaders: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...extraHeaders },
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => vi.restoreAllMocks())

describe('responses() streaming', () => {
  it('rejects non-streaming bodies (use responsesOnce instead)', async () => {
    await expect(async () => {
      const iter = responses(ctx(), { model: 'gpt-5.4-nano', input: 'hi', stream: false })
      await iter.next()
    }).rejects.toThrow(/stream:true/)
  })

  it('parses the probe 5 SSE fixture into typed events', async () => {
    const body = readFileSync(PROBE5_PATH, 'utf8')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(body, { 'x-generation-id': 'gen-probe-5' })),
    )

    const events: ResponsesEventWire[] = []
    const generationIds = new Set<string>()
    for await (const chunk of responses(ctx(), {
      model: 'gpt-5.4-nano',
      input: 'x',
      stream: true,
    })) {
      if (chunk.type === 'event') {
        events.push(chunk.event)
        if (chunk.generationId) generationIds.add(chunk.generationId)
      }
    }

    // Known structure of probe 5: response.created + in_progress + reasoning
    // output item (added + summary deltas + done) + message output item
    // (added + content_part.added + output_text deltas + content_part.done +
    // output_item.done) + response.completed.
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('response.created')
    expect(types).toContain('response.in_progress')
    expect(types).toContain('response.output_item.added')
    expect(types).toContain('response.reasoning_summary_text.delta')
    expect(types).toContain('response.output_text.delta')
    expect(types).toContain('response.output_item.done')
    expect(types[types.length - 1]).toBe('response.completed')

    // Spot-check a reasoning event has a populated encrypted_content somewhere.
    const reasoningItemAdded = events.find(
      (e) =>
        e.type === 'response.output_item.added' &&
        (e as { item?: { type?: string } }).item?.type === 'reasoning',
    ) as
      | (ResponsesEventWire & { item?: { encrypted_content?: string } })
      | undefined
    expect(reasoningItemAdded?.item?.encrypted_content).toMatch(/^gAAA/)

    // `output_item.done` for the reasoning item should carry the FINAL
    // encrypted_content (different value than `added` because it grows).
    const reasoningItemDone = events.find(
      (e) =>
        e.type === 'response.output_item.done' &&
        (e as { item?: { type?: string } }).item?.type === 'reasoning',
    ) as
      | (ResponsesEventWire & { item?: { encrypted_content?: string } })
      | undefined
    expect(reasoningItemDone?.item?.encrypted_content).toBeDefined()
    expect(reasoningItemDone?.item?.encrypted_content?.length).toBeGreaterThan(0)

    expect(generationIds).toEqual(new Set(['gen-probe-5']))
  })

  it('yields a buffered_result when the upstream answers JSON despite stream:true', async () => {
    const buffered = JSON.parse(readFileSync(PROBE6_PATH, 'utf8'))
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(buffered)))

    const chunks: ResponsesStreamChunk[] = []
    for await (const chunk of responses(ctx(), {
      model: 'openai/gpt-5.4-nano',
      input: 'x',
      stream: true,
    })) {
      chunks.push(chunk)
    }
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.type).toBe('buffered_result')
    const result = (chunks[0] as { result: ResponsesResultWire }).result
    expect(result.status).toBe('completed')
    expect(result.output?.length).toBe(2)
    expect(result.output?.[0]?.type).toBe('reasoning')
    expect(result.output?.[1]?.type).toBe('message')
  })

  it('constructs the URL as `<base>/responses`', async () => {
    const seenUrls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seenUrls.push(url)
        return sseResponse('')
      }),
    )
    for await (const _ of responses(ctx(), { model: 'm', input: 'x', stream: true })) {
      // drain
    }
    expect(seenUrls).toEqual(['https://api.openai.com/v1/responses'])
  })

  it('surfaces pre-response 4xx errors with normalized shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 'unsupported_value',
              message: "Unsupported value: 'minimal' is not supported with the 'gpt-5.4-nano' model.",
            },
          },
          400,
        ),
      ),
    )
    await expect(async () => {
      const iter = responses(ctx(), { model: 'gpt-5.4-nano', input: 'x', stream: true })
      await iter.next()
    }).rejects.toThrow(/Unsupported value/i)
  })
})

describe('responsesOnce', () => {
  it('forces stream:false and returns the JSON body', async () => {
    const seenBodies: string[] = []
    const buffered = { id: 'resp_1', status: 'completed', output: [] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        if (typeof init.body === 'string') seenBodies.push(init.body)
        return jsonResponse(buffered)
      }),
    )
    const result = await responsesOnce(ctx(), { model: 'm', input: 'x', stream: true })
    expect(result).toEqual(buffered)
    expect(JSON.parse(seenBodies[0] ?? '{}').stream).toBe(false)
  })
})
