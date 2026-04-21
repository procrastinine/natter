// Context-estimation invariants. See `src/core/prompt-size.ts` for the
// implementation and `plan/14-details.md §14.15` + `CLAUDE.md` "auto memory:
// Screenshot-first on visual CSS bugs" (no bearing — this suite is pure).
//
// The Composer's budget indicator and the Context-tab gauge both read from
// `estimatePromptSize`, so every edge case here directly affects what the
// user sees. We over-report before we ever under-report — the final number
// is `max(fallback, calibrated)` and the baseline subtracts systemTokens
// carefully to avoid negative values.

import { describe, expect, it } from 'vitest'
import { estimatePromptSize, tokenizerFromSettings } from '../../src/core/prompt-size'
import type { ChatUsage, GenerationMeta, Message, MessageRole } from '../../src/core/types'

const DEFAULT_TOKENIZER = 'gpt' as const

function makeMessage(partial: Partial<Message> & { role: MessageRole; text?: string }): Message {
  const content = partial.content
    ? partial.content
    : partial.text !== undefined
      ? [
          {
            type: partial.role === 'assistant' ? 'output_text' : 'text',
            text: partial.text,
          } as const,
        ]
      : []
  return {
    id: partial.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
    chatId: partial.chatId ?? 'chat-1',
    parentId: partial.parentId ?? null,
    siblingIndex: partial.siblingIndex ?? 0,
    turnId: partial.turnId ?? 'turn-1',
    turnIndex: partial.turnIndex ?? 0,
    createdAt: partial.createdAt ?? 1,
    role: partial.role,
    origin: partial.origin ?? (partial.role === 'user' ? 'user' : 'generated'),
    content: content as Message['content'],
    nodeVersion: partial.nodeVersion ?? 1,
    deleted: partial.deleted ?? false,
    ...(partial.hiddenFromContext !== undefined
      ? { hiddenFromContext: partial.hiddenFromContext }
      : {}),
    ...(partial.generation ? { generation: partial.generation } : {}),
    ...(partial.reasoningDetails ? { reasoningDetails: partial.reasoningDetails } : {}),
  }
}

function withUsage(promptTokens: number): GenerationMeta {
  const usage: ChatUsage = {
    prompt_tokens: promptTokens,
    completion_tokens: 0,
    total_tokens: promptTokens,
  }
  return {
    id: 'gen',
    model: 'openai/gpt-4o',
    requestedModel: 'openai/gpt-4o',
    apiUsed: 'chat',
    delivery: 'streaming',
    usage,
    costSource: 'stream',
    startedAt: 1,
  }
}

describe('estimatePromptSize — fallback branch', () => {
  it('returns zero-total when everything is empty', () => {
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: [],
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    expect(est.total).toBe(0)
    expect(est.systemTokens).toBe(0)
    expect(est.historyTokens).toBe(0)
    expect(est.draftTokens).toBe(0)
    expect(est.mediaTokens).toBe(0)
  })

  it('sums system + history + draft when no baseline usage is present', () => {
    const path = [
      makeMessage({ role: 'user', text: 'hello world hello world' }),
      makeMessage({ role: 'assistant', text: 'hi' }),
    ]
    const est = estimatePromptSize({
      systemPrompt: 'be kind',
      activePathMessages: path,
      draftText: 'draft',
      tokenizer: DEFAULT_TOKENIZER,
    })
    expect(est.systemTokens).toBeGreaterThan(0)
    expect(est.historyTokens).toBeGreaterThan(0)
    expect(est.draftTokens).toBeGreaterThan(0)
    expect(est.total).toBe(est.systemTokens + est.historyTokens + est.draftTokens + est.mediaTokens)
  })

  it('skips hiddenFromContext messages in both branches', () => {
    const path = [
      makeMessage({ role: 'user', text: 'visible visible visible' }),
      makeMessage({
        role: 'assistant',
        text: 'hidden'.repeat(1000),
        hiddenFromContext: true,
      }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    // The visible user message is small; the hidden assistant one is
    // enormous. If hidden messages were included we'd see thousands of
    // tokens. Assert we stay small.
    expect(est.historyTokens).toBeLessThan(20)
  })

  it('skips deleted (tombstoned) messages', () => {
    const path = [
      makeMessage({ role: 'user', text: 'hello' }),
      makeMessage({
        role: 'assistant',
        text: 'deleted'.repeat(500),
        deleted: true,
      }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    expect(est.historyTokens).toBeLessThan(20)
  })

  it('accumulates media tokens per image using fallback when dimensions unknown', () => {
    // Without an attachment resolver, images fall back to ~1024 * 1.05 = 1076.
    const path = [
      makeMessage({
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,y' } },
        ] as Message['content'],
      }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    // 2 images × (1024 × 1.05 → ceil = 1076) = 2152
    expect(est.mediaTokens).toBe(1076 * 2)
  })

  it('uses OpenAI dims-based formula when attachment dims are known', () => {
    // (512 × 512) / 512 + 85 = 512 + 85 = 597 × 1.05 → 627
    const path = [
      makeMessage({
        role: 'user',
        content: [{ type: 'image_url', attachmentId: 'att-1' }] as Message['content'],
      }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
      attachmentResolver: (id) => {
        if (id === 'att-1')
          return {
            id: 'att-1',
            contentHash: '',
            kind: 'image',
            mime: 'image/png',
            filename: 'x.png',
            sizeBytes: 0,
            createdAt: 1,
            blob: new Blob(),
            dimensions: { width: 512, height: 512 },
            refCount: 1,
          }
        return undefined
      },
    })
    expect(est.mediaTokens).toBe(627)
  })

  it('uses Claude dims-based formula when family = claude', () => {
    // (512 × 512) / 750 = 349.52 → ceil = 350 × 1.05 → 368
    const path = [
      makeMessage({
        role: 'user',
        content: [{ type: 'image_url', attachmentId: 'att-1' }] as Message['content'],
      }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: 'claude',
      attachmentResolver: (id) => {
        if (id === 'att-1')
          return {
            id: 'att-1',
            contentHash: '',
            kind: 'image',
            mime: 'image/png',
            filename: 'x.png',
            sizeBytes: 0,
            createdAt: 1,
            blob: new Blob(),
            dimensions: { width: 512, height: 512 },
            refCount: 1,
          }
        return undefined
      },
    })
    // (512*512)/750 = 349.52 → ceil 350 × 1.05 = 367.5 → ceil 368
    expect(est.mediaTokens).toBe(368)
  })

  it('PDF attachment: pages × per-family rate (GPT = 1500)', () => {
    // 3 pages × 1500 × 1.05 = 4725
    const path = [
      makeMessage({
        role: 'user',
        content: [
          { type: 'file', attachmentId: 'pdf-1', filename: 'doc.pdf', mime: 'application/pdf' },
        ] as Message['content'],
      }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
      attachmentResolver: (id) => {
        if (id === 'pdf-1')
          return {
            id: 'pdf-1',
            contentHash: '',
            kind: 'pdf',
            mime: 'application/pdf',
            filename: 'doc.pdf',
            sizeBytes: 200_000,
            createdAt: 1,
            blob: new Blob(),
            pageCount: 3,
            refCount: 1,
          }
        return undefined
      },
    })
    expect(est.mediaTokens).toBe(4725)
  })

  it('PDF ContentItem without resolver uses pdf fallback (1 page × 1500 × 1.05)', () => {
    const path = [
      makeMessage({
        role: 'user',
        content: [
          { type: 'file', filename: 'doc.pdf', mime: 'application/pdf' },
        ] as Message['content'],
      }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    // 1 × 1500 × 1.05 = 1575
    expect(est.mediaTokens).toBe(1575)
  })

  it('non-PDF file falls back to GENERIC_FILE_TOKEN_FALLBACK (1000)', () => {
    const path = [
      makeMessage({
        role: 'user',
        content: [{ type: 'file', filename: 'data.csv', mime: 'text/csv' }] as Message['content'],
      }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    expect(est.mediaTokens).toBe(1000)
  })
})

describe('estimatePromptSize — calibrated branch', () => {
  it('uses the latest assistant usage as a baseline', () => {
    const baselineTokens = 1000
    const path = [
      makeMessage({ role: 'user', text: 'prompt body' }),
      makeMessage({
        role: 'assistant',
        text: 'response body',
        generation: withUsage(baselineTokens),
      }),
    ]
    const est = estimatePromptSize({
      systemPrompt: 'be kind',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    // Baseline scenarios overshoot fallback because promptTokens covers
    // invisible overhead the char/4 heuristic misses.
    expect(est.historyTokens).toBeGreaterThanOrEqual(baselineTokens - est.systemTokens)
  })

  it('adds tokens for messages after the baseline', () => {
    const baselineTokens = 500
    const path = [
      makeMessage({ role: 'user', text: 'turn 1 user' }),
      makeMessage({
        role: 'assistant',
        text: 'turn 1 assistant',
        generation: withUsage(baselineTokens),
      }),
      makeMessage({ role: 'user', text: 'turn 2 user longer text here' }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    // baseline + turn-1 echoed content + turn-2 user text
    expect(est.historyTokens).toBeGreaterThan(baselineTokens)
  })

  it('clamps promptTokens - systemTokens to 0 when system grew post-send', () => {
    // System prompt is larger than the baseline's prompt_tokens. Without
    // the Math.max guard, history would go negative.
    const path = [
      makeMessage({ role: 'user', text: 'hi' }),
      makeMessage({ role: 'assistant', text: 'there', generation: withUsage(10) }),
    ]
    const longSystem = 'x'.repeat(10_000)
    const est = estimatePromptSize({
      systemPrompt: longSystem,
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    expect(est.historyTokens).toBeGreaterThanOrEqual(0)
    expect(est.systemTokens).toBeGreaterThan(0)
  })

  it('returns max(fallback, calibrated) so edits that grew text stay honest', () => {
    // Baseline says 100 tokens; but the user has edited the assistant
    // message to contain 50,000 characters. Fallback must override.
    const bigText = 'hello '.repeat(10_000)
    const path = [
      makeMessage({ role: 'user', text: 'hi' }),
      makeMessage({
        role: 'assistant',
        text: bigText,
        generation: withUsage(100),
      }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    // bigText is ~60k chars → ~15k tokens via char/4. Way above baseline 100.
    expect(est.historyTokens).toBeGreaterThan(5000)
  })

  it('ignores baseline usage with promptTokens <= 0', () => {
    const path = [
      makeMessage({ role: 'user', text: 'hi' }),
      makeMessage({
        role: 'assistant',
        text: 'there',
        generation: withUsage(0),
      }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    // Falls through to fallback; both messages contribute a few tokens.
    expect(est.historyTokens).toBeGreaterThan(0)
    expect(est.historyTokens).toBeLessThan(20)
  })

  it('ignores hidden baseline message when picking the baseline', () => {
    const path = [
      makeMessage({ role: 'user', text: 'hi' }),
      makeMessage({
        role: 'assistant',
        text: 'ignored',
        generation: withUsage(10_000),
        hiddenFromContext: true,
      }),
      makeMessage({ role: 'user', text: 'continue' }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    // Hidden baseline must not anchor the estimate; fallback-only path
    // stays small.
    expect(est.historyTokens).toBeLessThan(30)
  })
})

describe('estimatePromptSize — reasoning echo accounting', () => {
  it('adds reasoning.encrypted bytes/3 when include.encrypted is on AND format matches', () => {
    const path = [
      makeMessage({ role: 'user', text: 'hi' }),
      makeMessage({
        role: 'assistant',
        text: 'reply',
        reasoningDetails: [
          { type: 'reasoning.encrypted', data: 'A'.repeat(300), format: 'openai-responses-v1' },
        ],
      } as never),
    ]
    const withInclude = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
      reasoningInclude: { encrypted: true, summary: false, text: false },
      reasoningPreservationFormat: 'openai-responses-v1',
    })
    const withoutInclude = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
      reasoningInclude: { encrypted: false, summary: false, text: false },
      reasoningPreservationFormat: 'openai-responses-v1',
    })
    expect(withInclude.reasoningTokens).toBe(100) // 300 bytes / 3
    expect(withoutInclude.reasoningTokens).toBe(0)
    expect(withInclude.total - withoutInclude.total).toBe(100)
  })

  it('skips reasoning blocks marked hidden: true even when include flag is on', () => {
    const path = [
      makeMessage({
        role: 'assistant',
        text: 'reply',
        reasoningDetails: [
          {
            type: 'reasoning.summary',
            summary: 'A'.repeat(70),
            hidden: true,
          },
          {
            type: 'reasoning.summary',
            summary: 'B'.repeat(70),
          },
        ],
      } as never),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
      reasoningInclude: { encrypted: false, summary: true, text: false },
      reasoningPreservationFormat: 'openai-responses-v1',
    })
    // Only the non-hidden summary counts (70 / 3.5 = 20).
    expect(est.reasoningTokens).toBe(20)
  })

  it('omits reasoning tokens entirely when caller does not pass include flags', () => {
    const path = [
      makeMessage({
        role: 'assistant',
        text: 'reply',
        reasoningDetails: [{ type: 'reasoning.summary', summary: 'A'.repeat(70) }],
      } as never),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    expect(est.reasoningTokens).toBe(0)
  })
})

describe('estimatePromptSize — per-message cache (Phase B)', () => {
  it('uses cachedTokenEstimate when same model', () => {
    // Message has 35 chars of text (→ 10 tokens via 3.5 cpt fresh), but
    // cachedTokenEstimate = 999. With currentModelId matching, cache wins.
    const m: Message = {
      ...makeMessage({ role: 'user', text: 'a'.repeat(35) }),
      originalCharCount: 35,
      originalTokenEstimate: 10,
      originalModelId: 'openai/gpt-4o',
      charCountDelta: 0,
      cachedTokenEstimate: 999,
      cachedMediaTokens: 0,
    }
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: [m],
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
      currentModelId: 'openai/gpt-4o',
    })
    expect(est.historyTokens).toBe(999)
  })

  it('ignores cache when originalModelId differs from currentModelId', () => {
    // Message was created under gpt-4o but chat switched to claude.
    const m: Message = {
      ...makeMessage({ role: 'user', text: 'a'.repeat(35) }),
      originalCharCount: 35,
      originalTokenEstimate: 999,
      originalModelId: 'openai/gpt-4o',
      charCountDelta: 0,
      cachedTokenEstimate: 999,
    }
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: [m],
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
      currentModelId: 'anthropic/claude-opus-4.7',
    })
    // Fresh path: 35 chars / 3.5 = 10 tokens.
    expect(est.historyTokens).toBe(10)
  })

  it('uses cache when originalModelId is absent (pre-Phase-B row)', () => {
    const m: Message = {
      ...makeMessage({ role: 'user', text: 'a'.repeat(35) }),
      cachedTokenEstimate: 500,
      // No originalModelId — treat as "same model" and use cache.
    }
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: [m],
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
      currentModelId: 'openai/gpt-4o',
    })
    expect(est.historyTokens).toBe(500)
  })

  it('uses fresh path when currentModelId is omitted AND no cache present', () => {
    const m: Message = {
      ...makeMessage({ role: 'user', text: 'a'.repeat(35) }),
      // No cached fields at all — old row.
    }
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: [m],
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    expect(est.historyTokens).toBe(10) // fresh: 35/3.5
  })
})

describe('estimatePromptSize — robustness guards', () => {
  it('does not crash when a message.content is null/undefined (corrupt row)', () => {
    const path = [
      makeMessage({ role: 'user', text: 'hi' }),
      {
        ...makeMessage({ role: 'assistant', text: 'ok' }),
        content: null as unknown as Message['content'],
      },
    ]
    expect(() =>
      estimatePromptSize({
        systemPrompt: '',
        activePathMessages: path,
        draftText: '',
        tokenizer: DEFAULT_TOKENIZER,
      }),
    ).not.toThrow()
  })

  it('treats negative baseline prompt_tokens as invalid (fallback wins)', () => {
    const path = [
      makeMessage({ role: 'user', text: 'hello world hello world' }),
      makeMessage({
        role: 'assistant',
        text: 'there',
        generation: withUsage(-500),
      }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    // Baseline rejected → fallback path: a small count from char heuristic.
    expect(est.historyTokens).toBeGreaterThan(0)
    expect(est.historyTokens).toBeLessThan(100)
  })

  it('caps a corrupt gigantic baseline at MAX_PLAUSIBLE_TOKENS', () => {
    const path = [
      makeMessage({ role: 'user', text: 'hello' }),
      makeMessage({
        role: 'assistant',
        text: 'ok',
        generation: withUsage(1e12),
      }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    expect(est.historyTokens).toBeLessThanOrEqual(100_000_000)
    expect(est.total).toBeLessThanOrEqual(100_000_000)
  })

  it('caps NaN/Infinity baseline by returning undefined (fallback)', () => {
    const path = [
      makeMessage({ role: 'user', text: 'hello' }),
      makeMessage({
        role: 'assistant',
        text: 'ok',
        generation: withUsage(Number.NaN as unknown as number),
      }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    expect(Number.isFinite(est.historyTokens)).toBe(true)
    expect(Number.isFinite(est.total)).toBe(true)
  })
})

describe('estimatePromptSize — send-from-intermediate', () => {
  it('walks only the supplied active path (no siblings)', () => {
    // Caller already restricted to ancestors+self of the chosen leaf.
    const path = [
      makeMessage({ role: 'user', text: 'root' }),
      makeMessage({ role: 'assistant', text: 'first reply' }),
    ]
    const est = estimatePromptSize({
      systemPrompt: '',
      activePathMessages: path,
      draftText: '',
      tokenizer: DEFAULT_TOKENIZER,
    })
    expect(est.historyTokens).toBeGreaterThan(0)
  })
})

describe('tokenizerFromSettings', () => {
  it('prefers the endpoint tokenizer when provided', () => {
    const fam = tokenizerFromSettings(
      { model: 'anything', systemPrompt: '' } as never,
      'cl100k_base',
    )
    expect(fam).toBe('gpt')
  })

  it('falls back to the model id keyword when no endpoint tokenizer', () => {
    expect(tokenizerFromSettings({ model: 'anthropic/claude-opus-4.7' } as never, null)).toBe(
      'claude',
    )
    expect(tokenizerFromSettings({ model: 'google/gemini-3.1-flash' } as never, null)).toBe(
      'gemini',
    )
    expect(tokenizerFromSettings({ model: 'openai/gpt-5.4' } as never, null)).toBe('gpt')
    expect(tokenizerFromSettings({ model: 'unknown/weird' } as never, null)).toBe('unknown')
  })
})
