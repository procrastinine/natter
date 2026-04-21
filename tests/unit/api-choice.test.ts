// Phase 11 `chooseApi` matrix. See `plan/phase11-implementation.md §1`.

import { describe, expect, it } from 'vitest'
import {
  chooseApi,
  isGeminiNative,
  isResponsesCapable,
  responsesExplanationFor,
  type RouterCapabilities,
} from '../../src/core/api-choice'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type {
  ApiVariant,
  ConnectionKind,
  ConnectionProfile,
  Message,
  ReasoningDetail,
  ReasoningFormat,
} from '../../src/core/types'

function makeProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'prof',
    name: 'p',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'k',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    usesResponsesApiByDefault: false,
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function makeSettings(
  api: ApiVariant,
  encryptedInclude = true,
  model = 'openai/gpt-5.4-nano',
) {
  const s = cloneDefaultChatSettings()
  s.profileId = 'prof'
  s.model = model
  s.api = api
  s.reasoning = {
    ...s.reasoning,
    include: { encrypted: encryptedInclude, summary: false, text: false },
  }
  return s
}

function makeCaps(overrides: Partial<RouterCapabilities['quirks']> = {}): RouterCapabilities {
  return { quirks: overrides }
}

function assistantWithEncrypted(id: string, format: ReasoningFormat | undefined): Message {
  const details: ReasoningDetail[] = [
    format === undefined
      ? { type: 'reasoning.encrypted', id: 'r_e', data: 'blob' }
      : { type: 'reasoning.encrypted', id: 'r_e', data: 'blob', format },
  ]
  return {
    id,
    chatId: 'c',
    parentId: null,
    siblingIndex: 0,
    turnId: `${id}-t`,
    turnIndex: 0,
    createdAt: 1,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'text', text: '' }],
    reasoningDetails: details,
    nodeVersion: 0,
    deleted: false,
  }
}

function assistantWithResponsesItem(itemType: string): Message {
  return {
    id: 'a1',
    chatId: 'c',
    parentId: null,
    siblingIndex: 0,
    turnId: 'a1-t',
    turnIndex: 0,
    createdAt: 1,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'text', text: '' }],
    responsesEchoItem: { type: itemType },
    nodeVersion: 0,
    deleted: false,
  }
}

describe('chooseApi matrix', () => {
  describe('step 1 — user pinned chat', () => {
    it('wins over quirk preferApi: responses', () => {
      const r = chooseApi(
        makeProfile(),
        makeSettings('chat'),
        [],
        makeCaps({ preferApi: 'responses' }),
      )
      expect(r.kind).toBe('chat-completions')
    })

    it('does NOT win over requiresResponsesApi', () => {
      const r = chooseApi(
        makeProfile(),
        makeSettings('chat'),
        [],
        makeCaps({ requiresResponsesApi: true }),
      )
      expect(r.kind).toBe('responses')
    })
  })

  describe('step 2 — user pinned responses', () => {
    it('OpenRouter with pin: responses → responses', () => {
      const r = chooseApi(makeProfile(), makeSettings('responses'), [], makeCaps())
      expect(r.kind).toBe('responses')
    })

    it('Gemini native with pin: responses — fallback to gemini (no Responses surface)', () => {
      const r = chooseApi(
        makeProfile({ kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
        makeSettings('responses'),
        [],
        makeCaps(),
      )
      expect(r.kind).toBe('gemini-generate')
    })
  })

  describe('step 3 — quirk.requiresResponsesApi', () => {
    it('forces responses regardless of pin', () => {
      const r = chooseApi(
        makeProfile(),
        makeSettings('auto'),
        [],
        makeCaps({ requiresResponsesApi: true }),
      )
      expect(r.kind).toBe('responses')
    })
  })

  describe('step 4 — quirk.preferApi', () => {
    it("'responses' preference upgrades auto to responses", () => {
      const r = chooseApi(
        makeProfile(),
        makeSettings('auto'),
        [],
        makeCaps({ preferApi: 'responses' }),
      )
      expect(r.kind).toBe('responses')
    })
  })

  describe('step 5 — prior server-tool output', () => {
    it('keeps route on responses when path has a web_search_call', () => {
      const r = chooseApi(
        makeProfile(),
        makeSettings('auto'),
        [assistantWithResponsesItem('web_search_call')],
        makeCaps(),
      )
      expect(r.kind).toBe('responses')
    })

    it('ordinary message / reasoning items do NOT trigger the upgrade', () => {
      // Non-OpenAI model to isolate step 5 from step 10 (OR default-to-Responses
      // for OpenAI-family models).
      const r = chooseApi(
        makeProfile(),
        makeSettings('auto', true, 'anthropic/claude-haiku-4.5'),
        [assistantWithResponsesItem('message'), assistantWithResponsesItem('reasoning')],
        makeCaps(),
      )
      expect(r.kind).toBe('chat-completions')
    })
  })

  describe('step 6 — prior OpenAI-family encrypted reasoning', () => {
    it('upgrades when include.encrypted is true AND format is OpenAI-family', () => {
      const r = chooseApi(
        makeProfile(),
        makeSettings('auto', true),
        [assistantWithEncrypted('a1', 'openai-responses-v1')],
        makeCaps({ reasoningPreservationFormat: 'openai-responses-v1' }),
      )
      expect(r.kind).toBe('responses')
    })

    it('does NOT upgrade when include.encrypted is false (non-OpenAI model to isolate step 6)', () => {
      // On OpenAI models, step 10 (OR → Responses for OpenAI family) would
      // upgrade regardless; use anthropic to isolate step 6 behavior.
      const r = chooseApi(
        makeProfile(),
        makeSettings('auto', false, 'anthropic/claude-haiku-4.5'),
        [assistantWithEncrypted('a1', 'openai-responses-v1')],
        makeCaps({ reasoningPreservationFormat: 'openai-responses-v1' }),
      )
      expect(r.kind).toBe('chat-completions')
    })

    it('does NOT upgrade for anthropic-claude-v1 (not an OpenAI-family format)', () => {
      const r = chooseApi(
        makeProfile(),
        makeSettings('auto', true, 'anthropic/claude-haiku-4.5'),
        [assistantWithEncrypted('a1', 'anthropic-claude-v1')],
        makeCaps({ reasoningPreservationFormat: 'anthropic-claude-v1' }),
      )
      expect(r.kind).toBe('chat-completions')
    })
  })

  describe('step 7 — Gemini native default', () => {
    it("kind: 'google' + geminiMode: 'native' → gemini-generate", () => {
      const r = chooseApi(
        makeProfile({ kind: 'google', geminiMode: 'native', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
        makeSettings('auto'),
        [],
        makeCaps(),
      )
      expect(r.transport).toBe('gemini-native')
    })

    it("kind: 'google' + geminiMode: 'openai-compat' → chat-completions", () => {
      const r = chooseApi(
        makeProfile({ kind: 'google', geminiMode: 'openai-compat', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
        makeSettings('auto'),
        [],
        makeCaps(),
      )
      expect(r.transport).toBe('openai-chat')
    })

    it("kind: 'google' with no geminiMode defaults to native (undefined !== 'openai-compat')", () => {
      const r = chooseApi(
        makeProfile({ kind: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
        makeSettings('auto'),
        [],
        makeCaps(),
      )
      expect(r.transport).toBe('gemini-native')
    })
  })

  describe('step 9 — profile default', () => {
    it('OpenAI direct: usesResponsesApiByDefault=true → responses', () => {
      const r = chooseApi(
        makeProfile({
          kind: 'openai-compatible',
          baseUrl: 'https://api.openai.com/v1',
          usesResponsesApiByDefault: true,
        }),
        makeSettings('auto'),
        [],
        makeCaps(),
      )
      expect(r.kind).toBe('responses')
    })
  })

  describe('step 10 — OR default-to-Responses for OpenAI-family', () => {
    it('OpenRouter + OpenAI-family model with no other hints → responses', () => {
      // gpt-5.4-nano on OR hits step 10 (responsesSupport==='both' AND OR).
      const r = chooseApi(
        makeProfile({ kind: 'openrouter' }),
        makeSettings('auto'),
        [],
        makeCaps(),
      )
      expect(r.kind).toBe('responses')
      expect(r.reason).toMatch(/OpenRouter/i)
    })

    it('OpenRouter + non-OpenAI-family model → chat-completions', () => {
      // Anthropic/Gemini/DeepSeek default chat-only on OR.
      const r = chooseApi(
        makeProfile({ kind: 'openrouter' }),
        makeSettings('auto', true, 'anthropic/claude-haiku-4.5'),
        [],
        makeCaps(),
      )
      expect(r.kind).toBe('chat-completions')
    })
  })

  describe('step 11 — default', () => {
    const kinds: ConnectionKind[] = ['openai-compatible', 'llama-server', 'custom']
    for (const kind of kinds) {
      it(`${kind} with no hints → chat-completions`, () => {
        const r = chooseApi(
          makeProfile({ kind }),
          makeSettings('auto', true, 'anthropic/claude-haiku-4.5'),
          [],
          makeCaps(),
        )
        expect(r.kind).toBe('chat-completions')
      })
    }
  })
})

describe('isResponsesCapable', () => {
  it('yes on openrouter / openai-compatible / custom', () => {
    for (const kind of ['openrouter', 'openai-compatible', 'custom'] as ConnectionKind[]) {
      expect(isResponsesCapable(makeProfile({ kind }))).toBe(true)
    }
  })

  it('no on google / anthropic / llama-server', () => {
    for (const kind of ['google', 'anthropic', 'llama-server'] as ConnectionKind[]) {
      expect(isResponsesCapable(makeProfile({ kind }))).toBe(false)
    }
  })
})

describe('isGeminiNative', () => {
  it('true only when google AND not opted into openai-compat', () => {
    expect(isGeminiNative(makeProfile({ kind: 'google' }))).toBe(true)
    expect(isGeminiNative(makeProfile({ kind: 'google', geminiMode: 'native' }))).toBe(true)
    expect(isGeminiNative(makeProfile({ kind: 'google', geminiMode: 'openai-compat' }))).toBe(false)
    expect(isGeminiNative(makeProfile({ kind: 'openai-compatible' }))).toBe(false)
  })
})

describe('responsesExplanationFor', () => {
  it('gpt-5.4 hard requirement text', () => {
    const route = { kind: 'responses' as const, transport: 'openai-responses' as const, reason: 'x' }
    expect(responsesExplanationFor(route, makeProfile(), makeCaps({ requiresResponsesApi: true }))).toMatch(
      /required by this model/i,
    )
  })

  it('preferApi recommendation text', () => {
    const route = { kind: 'responses' as const, transport: 'openai-responses' as const, reason: 'x' }
    expect(responsesExplanationFor(route, makeProfile(), makeCaps({ preferApi: 'responses' }))).toMatch(
      /preserves encrypted reasoning/i,
    )
  })
})
