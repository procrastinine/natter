// Phase 11 additions to `core/quirks.ts`:
//   - `reasoningPreservationFormat` per model family
//   - `preferApi` / `requiresResponsesApi` / `requiresPhaseEcho`
//   - `gpt54SamplingGate` + `adjustGpt54SamplingGate`
//   - `hiddenReasoningOnChatApi` (renamed-scoped spelling of `reasoningHidden`)
//   - GPT-5.4 family effort enum excludes `minimal` (verified by live probe 4)

import { describe, expect, it } from 'vitest'
import {
  adjustGpt54SamplingGate,
  allowedEffortFor,
  allowedVerbosityFor,
  emitsEncryptedReasoningFor,
  quirksFor,
  reasoningPreservationFormatFor,
} from '../../src/core/quirks'

describe('reasoningPreservationFormat', () => {
  it('OpenAI GPT-5 family → openai-responses-v1', () => {
    for (const model of [
      'openai/gpt-5.4',
      'openai/gpt-5.4-nano',
      'openai/gpt-5.4-mini',
      'openai/gpt-5.4-pro',
      'openai/gpt-5.3-codex',
      'openai/gpt-5.3',
      'openai/gpt-5.2',
      'openai/gpt-5',
    ]) {
      expect(reasoningPreservationFormatFor(model)).toBe('openai-responses-v1')
    }
  })

  it('OpenAI o-series → openai-responses-v1 on the declared models', () => {
    for (const model of [
      'openai/o1',
      'openai/o1-pro',
      'openai/o3',
      'openai/o3-mini',
      'openai/o4-mini',
    ]) {
      expect(reasoningPreservationFormatFor(model)).toBe('openai-responses-v1')
    }
  })

  it('Anthropic Claude 4.x → anthropic-claude-v1', () => {
    for (const model of [
      'anthropic/claude-opus-4.8',
      'anthropic/claude-opus-4.9',
      'anthropic/claude-fable-5',
      'anthropic/claude-5-fable-20260609',
      'anthropic/claude-opus-4.7',
      'anthropic/claude-opus-4.6',
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-haiku-4.5',
      'anthropic/claude-opus-4.5',
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-opus-4.1',
      'anthropic/claude-opus-4',
      'anthropic/claude-sonnet-3.7',
    ]) {
      expect(reasoningPreservationFormatFor(model)).toBe('anthropic-claude-v1')
    }
  })

  it('Gemini (3.x and 2.5) → google-gemini-v1', () => {
    for (const model of [
      'google/gemini-3.1-pro-preview',
      'google/gemini-3.1-pro-preview-customtools',
      'google/gemini-3.1-flash-lite-preview',
      'google/gemini-3.5-flash',
      'google/gemini-3-pro-preview',
      'google/gemini-3-flash-preview',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'google/gemini-2.5-flash-lite',
    ]) {
      expect(reasoningPreservationFormatFor(model)).toBe('google-gemini-v1')
    }
  })

  it('xAI Grok → xai-responses-v1', () => {
    expect(reasoningPreservationFormatFor('x-ai/grok-4.1')).toBe('xai-responses-v1')
    expect(reasoningPreservationFormatFor('x-ai/grok-4.20')).toBe('xai-responses-v1')
  })

  it('DeepSeek / Qwen / Gemma → unknown', () => {
    expect(reasoningPreservationFormatFor('deepseek/deepseek-v4-pro')).toBe('unknown')
    expect(reasoningPreservationFormatFor('qwen/qwen3.6-plus')).toBe('unknown')
    expect(reasoningPreservationFormatFor('google/gemma-4-31b-it')).toBe('unknown')
  })

  it('unknown models → undefined', () => {
    expect(reasoningPreservationFormatFor('mistral/mistral-large-2411')).toBeUndefined()
  })
})

describe('API routing hints', () => {
  it('GPT-5.4-pro requires Responses; GPT-5.4 family persists phase', () => {
    // gpt-5.4-pro is the only hard-required-Responses member of the family.
    expect(quirksFor('openai/gpt-5.4-pro').requiresResponsesApi).toBe(true)
    expect(quirksFor('openai/gpt-5.3-codex').requiresResponsesApi).toBe(true)
    for (const m of [
      'openai/gpt-5.4',
      'openai/gpt-5.4-nano',
      'openai/gpt-5.4-mini',
      'openai/gpt-5.4-pro',
      'openai/gpt-5.3-codex',
    ]) {
      const q = quirksFor(m)
      expect(q.requiresPhaseEcho).toBe(true)
      expect(q.gpt54SamplingGate).toBe(true)
    }
  })

  it('GPT-5.5 inherits GPT-5.4 Responses and encrypted-reasoning behavior', () => {
    const q = quirksFor('openai/gpt-5.5')
    expect(q).toMatchObject({
      preferApi: 'responses',
      persistsResponsesPhase: true,
      requiresPhaseEcho: true,
      gpt54SamplingGate: true,
      reasoningPreservationFormat: 'openai-responses-v1',
    })
    expect(quirksFor('openai/gpt-5.5-pro').requiresResponsesApi).toBe(true)
    expect(allowedEffortFor('openai/gpt-5.5')).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(allowedVerbosityFor('openai/gpt-5.5')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(emitsEncryptedReasoningFor('openai/gpt-5.5')).toBe('always')
    expect(reasoningPreservationFormatFor('openai/gpt-5.5-2026-05-08')).toBe('openai-responses-v1')
    expect(reasoningPreservationFormatFor('openai/gpt-5.5-llama')).toBeUndefined()
  })

  it('Gemini 3.x Flash releases inherit encrypted reasoning without a registry row', () => {
    expect(reasoningPreservationFormatFor('google/gemini-3.5-flash')).toBe('google-gemini-v1')
    expect(emitsEncryptedReasoningFor('google/gemini-3.5-flash')).toBe('always')
    expect(emitsEncryptedReasoningFor('google/gemini-2.5-flash')).toBe('never')
  })

  it('o-series prefers Responses for encrypted reasoning', () => {
    // o1-pro is 'responses-only' so it doesn't need preferApi (step 3 of
    // chooseApi fires first). The remaining o-series still use preferApi.
    for (const m of ['openai/o1', 'openai/o3', 'openai/o3-mini', 'openai/o4-mini']) {
      const q = quirksFor(m)
      expect(q.preferApi).toBe('responses')
      expect(q.hiddenReasoningOnChatApi).toBe(true)
    }
    expect(quirksFor('openai/o1-pro').requiresResponsesApi).toBe(true)
  })

  it('GPT-5 / 5.2 / 5.3 prefer Responses but do NOT require it', () => {
    for (const m of ['openai/gpt-5', 'openai/gpt-5.2', 'openai/gpt-5.3']) {
      const q = quirksFor(m)
      expect(q.preferApi).toBe('responses')
      expect(q.requiresResponsesApi).toBeUndefined()
    }
  })
})

describe('Effort enums (live-probe verified)', () => {
  it('GPT-5.4 family: none|low|medium|high|xhigh — NO minimal (live probe 4)', () => {
    for (const m of ['openai/gpt-5.4', 'openai/gpt-5.4-nano', 'openai/gpt-5.4-mini']) {
      expect(allowedEffortFor(m)).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    }
    // gpt-5.4-pro shares the same effort enum.
    expect(allowedEffortFor('openai/gpt-5.4-pro')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })

  it('gpt-5.3-codex: low/medium/high/xhigh (Responses-only; no none/minimal)', () => {
    expect(allowedEffortFor('openai/gpt-5.3-codex')).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('GPT-5.4 verbosity: low/medium/high/xhigh (no max — Claude-only)', () => {
    expect(allowedVerbosityFor('openai/gpt-5.4')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(allowedVerbosityFor('openai/gpt-5.3-codex')).toEqual([])
  })
})

describe('adjustGpt54SamplingGate', () => {
  it('strips temperature/top_p/logprobs/top_k when effort is non-none on gated models', () => {
    const req: Record<string, unknown> = {
      reasoning: { effort: 'medium' },
      temperature: 0.7,
      top_p: 0.9,
      logprobs: 1,
      top_k: 50,
    }
    adjustGpt54SamplingGate(req, 'openai/gpt-5.4-nano')
    expect(req).toEqual({ reasoning: { effort: 'medium' } })
  })

  it('keeps sampling params when effort === "none"', () => {
    const req: Record<string, unknown> = {
      reasoning: { effort: 'none' },
      temperature: 0.7,
      top_p: 0.9,
    }
    adjustGpt54SamplingGate(req, 'openai/gpt-5.4')
    expect(req).toEqual({
      reasoning: { effort: 'none' },
      temperature: 0.7,
      top_p: 0.9,
    })
  })

  it('keeps sampling params when reasoning is absent (treated as none)', () => {
    const req: Record<string, unknown> = { temperature: 0.5 }
    adjustGpt54SamplingGate(req, 'openai/gpt-5.4-nano')
    expect(req).toEqual({ temperature: 0.5 })
  })

  it('is a no-op on non-gated models', () => {
    const req: Record<string, unknown> = {
      reasoning: { effort: 'high' },
      temperature: 0.5,
      top_p: 0.9,
    }
    adjustGpt54SamplingGate(req, 'anthropic/claude-haiku-4.5')
    expect(req).toEqual({
      reasoning: { effort: 'high' },
      temperature: 0.5,
      top_p: 0.9,
    })
  })

  it('is a no-op when passed the QuirksEntry directly with gpt54SamplingGate=false', () => {
    const req: Record<string, unknown> = {
      reasoning: { effort: 'medium' },
      temperature: 0.5,
    }
    adjustGpt54SamplingGate(req, {})
    expect(req).toEqual({
      reasoning: { effort: 'medium' },
      temperature: 0.5,
    })
  })
})
