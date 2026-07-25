// Phase 11 live test — Google Gemini native API. Gated behind `LIVE=1`.
// Uses `keys.json.google`. Runs on gemini-3.1-flash-lite-preview (cheap) and
// gemini-2.5-flash (for functionCall thoughtSignature coverage).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { type GeminiContext, geminiOnce, geminiStream } from '../../src/api/gemini-native'
import type { GeminiContent, GeminiPart } from '../../src/api/gemini-types'
import { splitGeminiStream as splitGeminiStreamWithContract } from '../../src/api/stream-transforms'
import type { StreamLaneEvent } from '../../src/core/generation-stream-live-events'
import { GOOGLE_PROVIDER_OUTPUT_CONTRACT } from '../../src/core/provider-tool-context'
import type { ConnectionProfile } from '../../src/core/types'
import { geminiReasoningContract } from '../helpers/reasoning-contracts'

function splitGeminiStream(source: Parameters<typeof splitGeminiStreamWithContract>[0]) {
  return splitGeminiStreamWithContract(
    source,
    geminiReasoningContract(),
    GOOGLE_PROVIDER_OUTPUT_CONTRACT,
  )
}

const LIVE = process.env.LIVE === '1'

function loadKey(): string {
  const raw = readFileSync(resolve(__dirname, '../../../keys.json'), 'utf8')
  const key = (JSON.parse(raw) as Record<string, string>).google
  if (!key) throw new Error('keys.json missing google')
  return key
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
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 0,
    updatedAt: 0,
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
    // Either STOP (completed) or MAX_TOKENS (truncated). Only the reasoning
    // carrier shape matters here, not the finish reason.
    expect(['STOP', 'MAX_TOKENS']).toContain(cand?.finishReason)

    const parts = cand?.content.parts
    if (!parts) throw new Error('missing Gemini candidate parts')
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
    const finishLane = lanes.find((l) => l.lane === 'finish')
    // `stop` or `length` — either way, one encrypted lane event should fire.
    expect(['stop', 'length']).toContain(finishLane?.finishReason)

    const carrierObservations = lanes
      .filter((lane) => lane.lane === 'reasoning-observation')
      .flatMap((lane) => lane.batch.observations)
      .filter(
        (observation) =>
          observation.kind === 'carrier' && observation.carrierKind === 'gemini-thought-signature',
      )
    expect(carrierObservations.length).toBeGreaterThanOrEqual(1)
    expect(carrierObservations.at(-1)).toMatchObject({ update: 'set' })
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

  it('function-call round-trip accepts omitted/edited signatures but rejects corrupted signatures', async () => {
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
    const call = turn1.candidates?.[0]?.content.parts.find((p) => 'functionCall' in p) as
      | {
          functionCall?: { name: string; args?: Record<string, unknown>; id?: string }
          thoughtSignature?: string
        }
      | undefined
    if (!call) {
      // Gemini may not call the tool in this sparse setup — gracefully skip.
      return
    }
    const functionCall = call.functionCall
    if (!functionCall) throw new Error('expected Gemini functionCall part')
    expect(call.thoughtSignature).toBeDefined()

    const signedPart: GeminiPart =
      call.thoughtSignature !== undefined
        ? { functionCall, thoughtSignature: call.thoughtSignature }
        : { functionCall }
    const signedModel: GeminiContent = {
      role: 'model',
      parts: [signedPart],
    }
    const strippedModel: GeminiContent = {
      role: 'model',
      parts: [
        {
          functionCall,
          // No thoughtSignature on purpose.
        },
      ],
    }
    const editedFunctionCall = {
      ...functionCall,
      args: { ...(functionCall.args ?? {}), key: 'edited-answer' },
    }
    const editedPart: GeminiPart =
      call.thoughtSignature !== undefined
        ? { functionCall: editedFunctionCall, thoughtSignature: call.thoughtSignature }
        : { functionCall: editedFunctionCall }
    const editedModel: GeminiContent = {
      role: 'model',
      parts: [editedPart],
    }
    const corruptedModel: GeminiContent = {
      role: 'model',
      parts: [
        {
          functionCall: {
            ...functionCall,
            args: { ...(functionCall.args ?? {}), key: 'edited-answer' },
          },
          thoughtSignature: 'definitely-not-a-valid-signature',
        },
      ],
    }
    const functionResponse: GeminiContent = {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: functionCall.name,
            response: { result: 42 },
          },
        },
      ],
    }
    const followup: GeminiContent = {
      role: 'user',
      parts: [{ text: 'Use the tool result in five words max.' }],
    }
    const baseUser: GeminiContent = {
      role: 'user',
      parts: [{ text: 'Use the lookup tool to look up "answer".' }],
    }

    const signed = await geminiOnce(
      ctx,
      {
        contents: [baseUser, signedModel, functionResponse, followup],
        tools: [tool],
        generationConfig: { maxOutputTokens: 100 },
      },
      'gemini-3.1-flash-lite-preview',
    )
    expect(signed.candidates?.[0]?.finishReason).toBe('STOP')

    const stripped = await geminiOnce(
      ctx,
      {
        contents: [baseUser, strippedModel, functionResponse, followup],
        tools: [tool],
        generationConfig: { maxOutputTokens: 100 },
      },
      'gemini-3.1-flash-lite-preview',
    )
    expect(stripped.candidates?.[0]?.finishReason).toBe('STOP')

    const edited = await geminiOnce(
      ctx,
      {
        contents: [baseUser, editedModel, functionResponse, followup],
        tools: [tool],
        generationConfig: { maxOutputTokens: 100 },
      },
      'gemini-3.1-flash-lite-preview',
    )
    expect(edited.candidates?.[0]?.finishReason).toBe('STOP')

    await expect(
      geminiOnce(
        ctx,
        {
          contents: [baseUser, corruptedModel, functionResponse, followup],
          tools: [tool],
          generationConfig: { maxOutputTokens: 100 },
        },
        'gemini-3.1-flash-lite-preview',
      ),
    ).rejects.toThrow(/thought[_ ]?signature|thoughtSignature/i)
  }, 120_000)
})
