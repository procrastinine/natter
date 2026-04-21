// Phase 11 live test — Google Gemini native API. Gated behind `LIVE=1`.
// Uses `keys.json.google`. Runs on gemini-3.1-flash-lite-preview (cheap) and
// gemini-2.5-flash (for functionCall thoughtSignature coverage).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { geminiOnce, geminiStream, type GeminiContext } from '../../src/api/gemini-native'
import type { GeminiContent } from '../../src/api/gemini-types'
import { splitGeminiStream, type StreamLaneEvent } from '../../src/api/stream-transforms'
import type { ConnectionProfile } from '../../src/core/types'

const LIVE = process.env.LIVE === '1'

function loadKey(): string {
  const raw = readFileSync(resolve(__dirname, '../../../keys.json'), 'utf8')
  return (JSON.parse(raw) as Record<string, string>).google!
}

async function drain(source: AsyncIterable<StreamLaneEvent>): Promise<StreamLaneEvent[]> {
  const out: StreamLaneEvent[] = []
  for await (const ev of source) out.push(ev)
  return out
}

function profile(): ConnectionProfile {
  return {
    id: 'g',
    name: 'Gemini',
    kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyRef: 'k',
    defaultHeaders: {},
    appTitle: 'natter-live-probe',
    appUrl: '',
    usesResponsesApiByDefault: false,
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 0,
    updatedAt: 0,
    geminiMode: 'native',
  }
}

describe.skipIf(!LIVE)('live — Gemini native generateContent', () => {
  let ctx: GeminiContext

  beforeAll(() => {
    ctx = { profile: profile(), apiKey: loadKey() }
  })

  it('buffered: returns thoughtSignature on final part + thoughtsTokenCount in usage', async () => {
    const result = await geminiOnce(
      ctx,
      {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: 'Find three consecutive integers summing to 30. Walk through the algebra.',
              },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: 2000,
          thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
        },
      },
      'gemini-3.1-flash-lite-preview',
    )
    const cand = result.candidates?.[0]
    expect(cand).toBeDefined()
    // Either STOP (completed) or MAX_TOKENS (truncated) — we only care
    // about the reasoning carrier shape, not the finish reason.
    expect(['STOP', 'MAX_TOKENS']).toContain(cand?.finishReason)

    const parts = cand!.content.parts
    const thoughtSummary = parts.find(
      (p) => 'text' in p && (p as { thought?: boolean }).thought === true,
    )
    expect(thoughtSummary).toBeDefined()

    const signedPart = parts.find((p) => 'thoughtSignature' in (p as object))
    expect(signedPart).toBeDefined()
    const signature = (signedPart as { thoughtSignature?: string }).thoughtSignature
    expect(signature?.length).toBeGreaterThan(100)

    expect(result.usageMetadata?.thoughtsTokenCount ?? 0).toBeGreaterThan(0)
  }, 90_000)

  it('streaming: finishReason + one replaceEncrypted lane event for the sig', async () => {
    const lanes = await drain(
      splitGeminiStream(
        geminiStream(
          ctx,
          {
            contents: [
              {
                role: 'user',
                parts: [{ text: 'Sum 1+1+1 in one sentence.' }],
              },
            ],
            generationConfig: {
              maxOutputTokens: 800,
              thinkingConfig: { thinkingLevel: 'low', includeThoughts: true },
            },
          },
          'gemini-3.1-flash-lite-preview',
        ),
      ),
    )
    const finishLane = lanes.find((l) => l.lane === 'finish') as
      | Extract<StreamLaneEvent, { lane: 'finish' }>
      | undefined
    // `stop` or `length` — either way, one encrypted lane event should fire.
    expect(['stop', 'length']).toContain(finishLane?.finishReason)

    const encryptedLanes = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'reasoning' }> =>
        l.lane === 'reasoning' && l.encryptedDelta !== undefined,
    )
    expect(encryptedLanes.length).toBeGreaterThanOrEqual(1)
    expect(encryptedLanes[encryptedLanes.length - 1]?.replaceEncrypted).toBe(true)
  }, 90_000)

  it('multi-turn: echoed thoughtSignature is accepted on next call', async () => {
    const turn1 = await geminiOnce(
      ctx,
      {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Pick a primary color. One word.' }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 150,
          thinkingConfig: { thinkingLevel: 'low', includeThoughts: true },
        },
      },
      'gemini-3.1-flash-lite-preview',
    )
    const modelParts = turn1.candidates?.[0]?.content.parts ?? []
    const modelTurn: GeminiContent = {
      role: 'model',
      parts: modelParts,
    }
    const turn2 = await geminiOnce(
      ctx,
      {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Pick a primary color. One word.' }],
          },
          modelTurn,
          {
            role: 'user',
            parts: [{ text: 'What color do you get by mixing that with white?' }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 150,
          thinkingConfig: { thinkingLevel: 'low', includeThoughts: true },
        },
      },
      'gemini-3.1-flash-lite-preview',
    )
    expect(turn2.candidates?.[0]?.finishReason).toBe('STOP')
    const promptTokens1 = turn1.usageMetadata?.promptTokenCount ?? 0
    const promptTokens2 = turn2.usageMetadata?.promptTokenCount ?? 0
    expect(promptTokens2).toBeGreaterThan(promptTokens1)
  }, 90_000)

  it('rejects missing thoughtSignature in function-call round-trip', async () => {
    // Set up a tool call (Gemini 3 REQUIRES signature on echoed functionCall parts)
    const tool = {
      functionDeclarations: [
        {
          name: 'lookup',
          description: 'Look up a value',
          parametersJsonSchema: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
          },
        },
      ],
    }
    const turn1 = await geminiOnce(
      ctx,
      {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Use the lookup tool to look up "answer".' }],
          },
        ],
        tools: [tool],
        generationConfig: {
          maxOutputTokens: 200,
          thinkingConfig: { thinkingLevel: 'low', includeThoughts: false },
        },
      },
      'gemini-3.1-flash-lite-preview',
    )
    const call = turn1.candidates?.[0]?.content.parts.find(
      (p) => 'functionCall' in p,
    ) as { functionCall?: { name: string; args?: Record<string, unknown> }; thoughtSignature?: string } | undefined
    if (!call) {
      // Gemini may not call the tool in this sparse setup — gracefully skip.
      return
    }
    expect(call.thoughtSignature).toBeDefined()

    // Now strip the signature and expect HTTP 400.
    const strippedModel: GeminiContent = {
      role: 'model',
      parts: [
        {
          functionCall: call.functionCall!,
          // No thoughtSignature on purpose.
        },
      ],
    }
    await expect(
      geminiOnce(
        ctx,
        {
          contents: [
            {
              role: 'user',
              parts: [{ text: 'Use the lookup tool to look up "answer".' }],
            },
            strippedModel,
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: call.functionCall!.name,
                    response: { result: 42 },
                  },
                },
              ],
            },
          ],
          tools: [tool],
          generationConfig: { maxOutputTokens: 100 },
        },
        'gemini-3.1-flash-lite-preview',
      ),
    ).rejects.toThrow(/thought_signature|thoughtSignature/i)
  }, 120_000)
})
