import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type GeminiContext, geminiOnce, geminiStream } from '../../src/api/gemini-native'
import type { GeminiStreamChunk, GenerateContentResponseWire } from '../../src/api/gemini-types'
import type { ConnectionProfile } from '../../src/core/types'
import { geminiBufferedResult, geminiStreamSse } from '../helpers/protocol-fixtures'

const PROBE8 = resolve(__dirname, '../../../plan/phase11-probes/08-gemini-native-stream.sse')
const PROBE3 = resolve(__dirname, '../../../plan/phase11-probes/03-gemini-native.json')

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'g',
    name: 'Gemini',
    kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyRef: 'k',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function ctx(): GeminiContext {
  return { profile: profile(), apiKey: 'AQ.Ab8RN6test' }
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

describe('geminiStream — URL & headers', () => {
  it('constructs the URL as {base}/models/{modelId}:streamGenerateContent?alt=sse', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, headers: init.headers as Record<string, string> })
        return sseResponse('')
      }),
    )
    for await (const _ of geminiStream(
      ctx(),
      { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      'gemini-3.1-flash-lite-preview',
    )) {
      // drain
    }
    expect(seen[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:streamGenerateContent?alt=sse',
    )
    expect(seen[0]?.headers['x-goog-api-key']).toBe('AQ.Ab8RN6test')
    expect(seen[0]?.headers.Authorization).toBeUndefined()
  })

  it('strips provider-prefix slugs on the URL (google/…)', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url)
        return sseResponse('')
      }),
    )
    for await (const _ of geminiStream(
      ctx(),
      { contents: [] },
      'google/gemini-3.1-flash-lite-preview',
    )) {
      // drain
    }
    expect(seen[0]).toContain('/models/gemini-3.1-flash-lite-preview:')
    expect(seen[0]).not.toContain('google/gemini')
  })

  it('non-streaming URL uses :generateContent', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url)
        return jsonResponse({ candidates: [] })
      }),
    )
    await geminiOnce(ctx(), { contents: [] }, 'gemini-3.1-flash-lite-preview')
    expect(seen[0]).toMatch(/:generateContent$/)
  })
})

describe('geminiStream — representative round-trip', () => {
  it('parses SSE into typed chunks with a final thoughtSignature', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(geminiStreamSse)),
    )

    const chunks: GeminiStreamChunk[] = []
    for await (const ch of geminiStream(
      ctx(),
      { contents: [{ role: 'user', parts: [{ text: 'x' }] }] },
      'gemini-3.1-flash-lite-preview',
    )) {
      chunks.push(ch)
    }
    expect(chunks.every((c) => c.type === 'chunk')).toBe(true)
    const lastChunk = chunks[chunks.length - 1] as {
      type: 'chunk'
      chunk: GenerateContentResponseWire
    }
    // The final part in the captured fixture has thoughtSignature + empty text +
    // finishReason: STOP — this is the Gemini 3 "signature on last part" rule.
    const lastPart = lastChunk.chunk.candidates?.[0]?.content.parts.slice(-1)[0]
    const signature = (lastPart as { thoughtSignature?: string }).thoughtSignature
    expect(signature).toBeDefined()
    expect(signature?.length).toBeGreaterThan(100)
    expect(lastChunk.chunk.candidates?.[0]?.finishReason).toBe('STOP')
    expect(lastChunk.chunk.usageMetadata?.thoughtsTokenCount).toBeGreaterThan(0)
  })
})

describe('geminiOnce — representative buffered response', () => {
  it('returns the full GenerateContentResponseWire body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(geminiBufferedResult)),
    )
    const result = await geminiOnce(ctx(), { contents: [] }, 'gemini-3.1-flash-lite-preview')
    expect(result).toEqual(geminiBufferedResult)
  })

  it('surfaces pre-response 4xx errors normalized to ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 400,
              message: 'Function call "x" in the 0 content block is missing a thought_signature.',
              status: 'INVALID_ARGUMENT',
            },
          },
          400,
        ),
      ),
    )
    await expect(
      geminiOnce(ctx(), { contents: [] }, 'gemini-3.1-flash-lite-preview'),
    ).rejects.toThrow(/thought_signature/i)
  })
})

if (existsSync(PROBE8)) {
  describe('geminiStream — full local stream capture', () => {
    it('parses the complete capture with its final thought signature', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => sseResponse(readFileSync(PROBE8, 'utf8'))),
      )
      const chunks: GeminiStreamChunk[] = []
      for await (const chunk of geminiStream(
        ctx(),
        { contents: [{ role: 'user', parts: [{ text: 'x' }] }] },
        'gemini-3.1-flash-lite-preview',
      )) {
        chunks.push(chunk)
      }
      const final = chunks.at(-1)
      expect(final?.type).toBe('chunk')
      if (final?.type !== 'chunk') throw new Error('expected final Gemini chunk')
      const part = final.chunk.candidates?.[0]?.content.parts.at(-1)
      expect(part && 'thoughtSignature' in part ? part.thoughtSignature : undefined).toBeDefined()
    })
  })
}

if (existsSync(PROBE3)) {
  describe('geminiOnce — full local buffered capture', () => {
    it('returns the complete captured response', async () => {
      const buffered = JSON.parse(readFileSync(PROBE3, 'utf8')) as GenerateContentResponseWire
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(buffered)),
      )
      await expect(
        geminiOnce(ctx(), { contents: [] }, 'gemini-3.1-flash-lite-preview'),
      ).resolves.toEqual(buffered)
    })
  })
}
