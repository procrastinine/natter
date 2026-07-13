import { describe, expect, it } from 'vitest'
import {
  chooseApi,
  isGeminiNative,
  isResponsesCapable,
  type RouterCapabilities,
  responsesExplanationFor,
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
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function makeSettings(api: ApiVariant, encryptedInclude = true, model = 'openai/gpt-5.4-nano') {
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

function makeCapsWithOutput(outputModalities: readonly string[]): RouterCapabilities {
  return { quirks: {}, outputModalities: new Set(outputModalities) }
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
  describe('media-output locks', () => {
    it('routes OpenRouter video-output models to the video generation API', () => {
      const r = chooseApi(
        makeProfile(),
        makeSettings('chat', true, 'google/veo-3.1-lite'),
        [],
        makeCapsWithOutput(['video']),
      )
      expect(r.kind).toBe('video-generation')
      expect(r.transport).toBe('openrouter-video')
    })

    it('routes OpenRouter audio-output models to chat-completions streaming', () => {
      const r = chooseApi(
        makeProfile(),
        makeSettings('responses', true, 'openai/gpt-audio-mini'),
        [],
        makeCapsWithOutput(['text', 'audio']),
      )
      expect(r.kind).toBe('chat-completions')
      expect(r.transport).toBe('openai-chat')
    })
  })

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
        makeProfile({
          kind: 'google',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        }),
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

    it('direct OpenAI hosted tools force Responses over a chat pin', () => {
      const settings = makeSettings('chat', true, 'gpt-5.4-nano')
      settings.tools.openai.enabledServerToolIds = ['web-search']
      const r = chooseApi(
        makeProfile({
          kind: 'openai-compatible',
          baseUrl: 'https://api.openai.com/v1',
        }),
        settings,
        [],
        makeCaps(),
      )
      expect(r.kind).toBe('responses')
      expect(r.reason).toBe('OpenAI hosted tools require Responses API')
    })

    it('Google hosted tools use Gemini native when the chat is in native mode', () => {
      const settings = makeSettings('gemini-native', true, 'google/gemini-3.1-flash-lite-preview')
      settings.tools.google.enabledServerToolIds = ['google-search']
      const r = chooseApi(
        makeProfile({
          kind: 'google',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        }),
        settings,
        [],
        makeCaps(),
      )
      expect(r.kind).toBe('gemini-generate')
      expect(r.reason).toBe('Gemini native required for Google hosted tools')
    })

    it('Anthropic direct uses native Messages when the chat is in Messages mode', () => {
      const settings = makeSettings('anthropic-messages', true, 'claude-haiku-4.5')
      settings.tools.anthropic.enabledServerToolIds = ['web-search']
      const r = chooseApi(
        makeProfile({
          kind: 'anthropic',
          baseUrl: 'https://api.anthropic.com/v1',
        }),
        settings,
        [],
        makeCaps(),
      )
      expect(r.kind).toBe('anthropic-messages')
      expect(r.transport).toBe('anthropic')
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

    it('does not upgrade from a tool-prefixed encrypted row', () => {
      const assistant = assistantWithEncrypted('a1', 'openai-responses-v1')
      const detail = assistant.reasoningDetails?.[0]
      if (detail) detail.id = 'tool_call-1'
      const r = chooseApi(
        makeProfile(),
        makeSettings('auto', true, 'anthropic/claude-haiku-4.5'),
        [assistant],
        makeCaps({ reasoningPreservationFormat: 'openai-responses-v1' }),
      )
      expect(r.kind).toBe('chat-completions')
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

  describe('step 7 — direct provider chat settings modes', () => {
    it("kind: 'google' + api: 'gemini-native' → gemini-generate", () => {
      const r = chooseApi(
        makeProfile({
          kind: 'google',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        }),
        makeSettings('gemini-native'),
        [],
        makeCaps(),
      )
      expect(r.transport).toBe('gemini-native')
    })

    it("kind: 'google' + api: 'chat' → chat-completions", () => {
      const r = chooseApi(
        makeProfile({
          kind: 'google',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        }),
        makeSettings('chat'),
        [],
        makeCaps(),
      )
      expect(r.transport).toBe('openai-chat')
    })

    it("kind: 'google' + api: 'auto' defaults to native", () => {
      const r = chooseApi(
        makeProfile({
          kind: 'google',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        }),
        makeSettings('auto'),
        [],
        makeCaps(),
      )
      expect(r.transport).toBe('gemini-native')
    })

    it("kind: 'anthropic' + api: 'chat' → chat-completions", () => {
      const r = chooseApi(
        makeProfile({
          kind: 'anthropic',
          baseUrl: 'https://api.anthropic.com/v1',
        }),
        makeSettings('chat', true, 'claude-haiku-4.5'),
        [],
        makeCaps(),
      )
      expect(r.transport).toBe('openai-chat')
    })
  })

  describe('step 9 — chat settings default', () => {
    it("OpenAI direct + api: 'responses' → responses", () => {
      const r = chooseApi(
        makeProfile({
          kind: 'openai-compatible',
          baseUrl: 'https://api.openai.com/v1',
        }),
        makeSettings('responses'),
        [],
        makeCaps(),
      )
      expect(r.kind).toBe('responses')
    })
  })

  describe('step 10 — OR default-to-Responses for OpenAI-family', () => {
    it('OpenRouter + OpenAI-family model with no other hints → responses', () => {
      // gpt-5.4-nano on OR hits step 10 (responsesSupport==='both' AND OR).
      const r = chooseApi(makeProfile({ kind: 'openrouter' }), makeSettings('auto'), [], makeCaps())
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
  it("true only when google AND chat settings aren't OpenAI-compat", () => {
    expect(isGeminiNative(makeProfile({ kind: 'google' }), makeSettings('auto'))).toBe(true)
    expect(isGeminiNative(makeProfile({ kind: 'google' }), makeSettings('gemini-native'))).toBe(
      true,
    )
    expect(isGeminiNative(makeProfile({ kind: 'google' }), makeSettings('chat'))).toBe(false)
    expect(isGeminiNative(makeProfile({ kind: 'openai-compatible' }), makeSettings('auto'))).toBe(
      false,
    )
  })
})

describe('responsesExplanationFor', () => {
  it('gpt-5.4 hard requirement text', () => {
    const route = {
      kind: 'responses' as const,
      transport: 'openai-responses' as const,
      reason: 'x',
    }
    expect(
      responsesExplanationFor(route, makeProfile(), makeCaps({ requiresResponsesApi: true })),
    ).toMatch(/required by this model/i)
  })

  it('preferApi recommendation text', () => {
    const route = {
      kind: 'responses' as const,
      transport: 'openai-responses' as const,
      reason: 'x',
    }
    expect(
      responsesExplanationFor(route, makeProfile(), makeCaps({ preferApi: 'responses' })),
    ).toMatch(/preserves encrypted reasoning/i)
  })
})
