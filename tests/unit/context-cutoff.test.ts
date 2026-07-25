// Head+tail cutoff invariants. See `src/core/context-cutoff.ts`.
//
// The algorithm groups the active path into preamble + user-anchored
// pairs, keeps the first N (possibly reduced) pairs as an anchor, then
// greedily fills the tail with the most recent pairs that fit the
// remaining budget. These tests cover: pair grouping edge cases
// (leading orphan assistants, system-in-mid, multiple users in a row),
// the head-reduction rule, the greedy-tail stopping rule, the draft +
// reserve budget subtractions, and the unlimited-cutoff short-circuit.

import { describe, expect, it } from 'vitest'
import { applyContextCutoff, computeCutoffPlan } from '../../src/core/context-cutoff'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { tokenCalibrationKey } from '../../src/core/model-ids'
import type { Attachment, ChatSettings, Message, MessageRole } from '../../src/core/types'

const TOKENIZER = 'gpt' as const

// 3.5 chars/token for `gpt`: a 35-char string is 10 tokens, a 17-char
// string is 5. The tests pick string lengths deliberately so pair costs
// land on round numbers.

let nextId = 0
function makeMessage(role: MessageRole, text: string, partial: Partial<Message> = {}): Message {
  nextId += 1
  const id = partial.id ?? `m-${nextId}`
  return {
    id,
    chatId: 'chat-1',
    parentId: partial.parentId ?? null,
    siblingIndex: partial.siblingIndex ?? 0,
    turnId: partial.turnId ?? 'turn-1',
    turnIndex: partial.turnIndex ?? 0,
    createdAt: partial.createdAt ?? nextId,
    role,
    origin: partial.origin ?? (role === 'user' ? 'user' : 'generated'),
    content: [
      {
        type: role === 'assistant' ? 'output_text' : 'text',
        text,
      } as const,
    ],
    nodeVersion: 1,
    deleted: partial.deleted ?? false,
    ...(partial.hiddenFromContext !== undefined
      ? { hiddenFromContext: partial.hiddenFromContext }
      : {}),
    ...(partial.generation ? { generation: partial.generation } : {}),
    ...(partial.reasoningEnvelope ? { reasoningEnvelope: partial.reasoningEnvelope } : {}),
  }
}

function storedAttachment(
  partial: Partial<Attachment> & Pick<Attachment, 'id' | 'kind' | 'mime' | 'filename'>,
): Attachment {
  return {
    origin: 'system-fixture',
    createdAt: 1,
    updatedAt: 1,
    storage: { kind: 'local-blob', blobId: `${partial.id}:blob` },
    artifacts: [],
    processing: [],
    refCount: 1,
    ...partial,
  }
}

function settings(overrides: {
  keepFirstPairs?: number
  customMaxContext?: number
  maxCompletionTokens?: number
  systemPrompt?: string
  model?: string
}): ChatSettings {
  const s = cloneDefaultChatSettings()
  s.model = overrides.model ?? 'openai/gpt-4o-mini'
  s.profileId = 'profile-1'
  s.systemPrompt = overrides.systemPrompt ?? ''
  s.contextStrategy = {
    ...s.contextStrategy,
    kind: 'sliding_window',
    keepFirstPairs: overrides.keepFirstPairs ?? 0,
  }
  if (overrides.customMaxContext !== undefined) {
    s.customMaxContext = overrides.customMaxContext
  }
  if (overrides.maxCompletionTokens !== undefined) {
    s.maxCompletionTokens = overrides.maxCompletionTokens
  }
  return s
}

describe('computeCutoffPlan — grouping', () => {
  it('groups messages into one user-anchored pair per user message', () => {
    const path = [
      makeMessage('user', 'u1'),
      makeMessage('assistant', 'a1'),
      makeMessage('user', 'u2'),
      makeMessage('assistant', 'a2'),
    ]
    const plan = computeCutoffPlan({
      messages: path,
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    expect(plan.totalPairCount).toBe(2)
    expect(plan.kept.length).toBe(4)
  })

  it('treats leading system / assistant messages before the first user as preamble', () => {
    const path = [
      makeMessage('system', 'sys-body'),
      makeMessage('assistant', 'orphan'),
      makeMessage('user', 'u1'),
      makeMessage('assistant', 'a1'),
    ]
    const plan = computeCutoffPlan({
      messages: path,
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    // Both preamble messages + the one pair's two messages = 4 kept.
    expect(plan.totalPairCount).toBe(1)
    expect(plan.kept.length).toBe(4)
    // Preamble cost > 0 when leading messages carry text.
    expect(plan.preambleTokens).toBeGreaterThan(0)
  })

  it('groups multiple consecutive assistants into one pair', () => {
    const path = [
      makeMessage('user', 'u1'),
      makeMessage('assistant', 'a1a'),
      makeMessage('assistant', 'a1b'),
      makeMessage('tool', 't1'),
      makeMessage('user', 'u2'),
      makeMessage('assistant', 'a2'),
    ]
    const plan = computeCutoffPlan({
      messages: path,
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    expect(plan.totalPairCount).toBe(2)
  })

  it('gives each user in a user/user/user sequence its own pair', () => {
    const path = [makeMessage('user', 'u1'), makeMessage('user', 'u2'), makeMessage('user', 'u3')]
    const plan = computeCutoffPlan({
      messages: path,
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    expect(plan.totalPairCount).toBe(3)
  })
})

describe('computeCutoffPlan — unlimited cutoff', () => {
  it('returns the full path when no local cap is set and no provider cap is known', () => {
    const path = [
      makeMessage('user', 'u'.repeat(10000)),
      makeMessage('assistant', 'a'.repeat(10000)),
    ]
    const plan = computeCutoffPlan({
      messages: path,
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    expect(plan.kept.length).toBe(2)
    expect(plan.excludedIds.size).toBe(0)
    expect(plan.applied).toBe(false)
    expect(plan.cutoff).toBe(Number.POSITIVE_INFINITY)
  })

  it('treats customMaxContext = -1 as unlimited regardless of providerCap', () => {
    const path = [makeMessage('user', 'u'.repeat(1000)), makeMessage('assistant', 'a'.repeat(1000))]
    const plan = computeCutoffPlan({
      messages: path,
      settings: settings({ customMaxContext: -1 }),
      tokenizer: TOKENIZER,
      providerCap: 100, // tiny cap; -1 overrides
    })
    expect(plan.applied).toBe(false)
    expect(plan.cutoff).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('computeCutoffPlan — head + greedy tail', () => {
  // Each pair text of length 35 → 10 tokens. With customMaxContext=50 and
  // reserve=0, available = 50; 5 pairs fit. `keepFirstPairs=1`
  // anchors pair 0 plus the last 4 pairs (0, 6, 7, 8, 9 for 10 pairs).
  function tenEqualPairs(): Message[] {
    const path: Message[] = []
    for (let i = 0; i < 10; i += 1) {
      path.push(makeMessage('user', 'u'.repeat(17))) // 17 chars → 5 tokens
      path.push(makeMessage('assistant', 'a'.repeat(17))) // 17 chars → 5 tokens
    }
    return path // 10 pairs, each 10 tokens → 100 tokens total
  }

  it('greedily accumulates the most recent pairs until one would overflow', () => {
    const plan = computeCutoffPlan({
      messages: tenEqualPairs(),
      settings: settings({ keepFirstPairs: 0, customMaxContext: 50 }),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    // available = 50 − 0 system − 0 preamble − 0 draft − 0 reserve = 50
    // tail walk: takes 10-token pairs while accumulator ≤ 50 → 5 pairs
    expect(plan.headPairCount).toBe(0)
    expect(plan.tailPairCount).toBe(5)
    expect(plan.applied).toBe(true)
    // Kept = last 5 pairs (2 messages each) = 10 messages.
    expect(plan.kept.length).toBe(10)
  })

  it('keeps the terminal pair when mandatory input alone exceeds the budget', () => {
    const first = [makeMessage('user', 'first'), makeMessage('assistant', 'answer')]
    const terminal = [makeMessage('user', 'u'.repeat(400)), makeMessage('assistant', 'prefill')]
    const plan = computeCutoffPlan({
      messages: [...first, ...terminal],
      settings: settings({ keepFirstPairs: 0, customMaxContext: 1 }),
      tokenizer: TOKENIZER,
      providerCap: null,
    })

    expect(plan.kept).toEqual(terminal)
    expect(plan.headPairCount).toBe(0)
    expect(plan.tailPairCount).toBe(1)
    expect(plan.available).toBe(1)
  })

  it('anchors keepFirstPairs at the top and fills the tail with what is left', () => {
    const plan = computeCutoffPlan({
      messages: tenEqualPairs(),
      settings: settings({ keepFirstPairs: 1, customMaxContext: 50 }),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    // available = 50; head = 10; remaining = 40; tail fits 4 pairs.
    expect(plan.headPairCount).toBe(1)
    expect(plan.tailPairCount).toBe(4)
    // Kept pairs = pair[0] + pair[6..9] → 5 pairs × 2 messages = 10 msgs.
    expect(plan.kept.length).toBe(10)
  })

  it('subtracts draftTokens from the available budget', () => {
    const plan = computeCutoffPlan({
      messages: tenEqualPairs(),
      settings: settings({ keepFirstPairs: 0, customMaxContext: 50 }),
      tokenizer: TOKENIZER,
      providerCap: null,
      // 35 chars → 10 draft tokens; available drops from 50 to 40.
      draftText: 'x'.repeat(35),
    })
    expect(plan.tailPairCount).toBe(4)
  })

  it('subtracts reserveTokens (maxCompletionTokens) from available', () => {
    const plan = computeCutoffPlan({
      messages: tenEqualPairs(),
      settings: settings({ keepFirstPairs: 0, customMaxContext: 50, maxCompletionTokens: 10 }),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    // available = 50 − 10 reserve = 40 → 4 pairs.
    expect(plan.tailPairCount).toBe(4)
  })

  it('treats maxCompletionTokens = -1 as zero reserve (no local completion cap)', () => {
    const plan = computeCutoffPlan({
      messages: tenEqualPairs(),
      settings: settings({ keepFirstPairs: 0, customMaxContext: 50, maxCompletionTokens: -1 }),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    // available = 50 − 0 reserve = 50 → 5 pairs (full budget available).
    expect(plan.tailPairCount).toBe(5)
  })
})

describe('computeCutoffPlan — head reduction', () => {
  it('reduces head when the first N pairs alone would overflow the budget', () => {
    const path: Message[] = []
    // 3 "big" head pairs, 1 tiny trailing pair.
    for (let i = 0; i < 3; i += 1) {
      path.push(makeMessage('user', 'u'.repeat(35))) // 10 tokens
      path.push(makeMessage('assistant', 'a'.repeat(35))) // 10 tokens
    }
    path.push(makeMessage('user', 'x'))
    path.push(makeMessage('assistant', 'y'))

    const plan = computeCutoffPlan({
      messages: path,
      settings: settings({ keepFirstPairs: 3, customMaxContext: 25 }),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    // keepFirstPairs=3 → 60 tokens > 25 available. Shrink head until it
    // fits: 2×20=40 > 25; 1×20=20 ≤ 25; keep 1 head pair.
    expect(plan.headPairCount).toBe(1)
  })

  it('drops head entirely when even the first pair exceeds available', () => {
    const path = [
      makeMessage('user', 'u'.repeat(100)), // ~29 tokens
      makeMessage('assistant', 'a'.repeat(100)), // ~29 tokens
      makeMessage('user', 'last'),
      makeMessage('assistant', 'end'),
    ]
    const plan = computeCutoffPlan({
      messages: path,
      settings: settings({ keepFirstPairs: 1, customMaxContext: 30 }),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    // First pair costs ~58 tokens > 30 → head reduces to 0.
    expect(plan.headPairCount).toBe(0)
    // Tail still takes the last small pair.
    expect(plan.tailPairCount).toBeGreaterThanOrEqual(1)
  })
})

describe('computeCutoffPlan — filtering & strategy', () => {
  it('skips hiddenFromContext and deleted messages when grouping', () => {
    const path = [
      makeMessage('user', 'u1', { id: 'U1' }),
      makeMessage('assistant', 'a1', { id: 'A1', hiddenFromContext: true }),
      makeMessage('user', 'u2', { id: 'U2', deleted: true }),
      makeMessage('user', 'u3', { id: 'U3' }),
      makeMessage('assistant', 'a3', { id: 'A3' }),
    ]
    const plan = computeCutoffPlan({
      messages: path,
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    // U1 stands alone as a pair (A1 was hidden → not in any pair).
    // U2 was deleted so it's skipped entirely.
    // U3 + A3 is the second pair.
    expect(plan.totalPairCount).toBe(2)
    const keptIds = new Set(plan.kept.map((m) => m.id))
    expect(keptIds.has('U1')).toBe(true)
    expect(keptIds.has('A1')).toBe(false) // hidden from context
    expect(keptIds.has('U2')).toBe(false) // deleted
    expect(keptIds.has('U3')).toBe(true)
    expect(keptIds.has('A3')).toBe(true)
  })

  it('short-circuits when contextStrategy.kind is "off"', () => {
    const base = settings({ customMaxContext: 10 })
    base.contextStrategy = { ...base.contextStrategy, kind: 'off' }
    const plan = computeCutoffPlan({
      messages: [makeMessage('user', 'u'.repeat(100)), makeMessage('assistant', 'a'.repeat(100))],
      settings: base,
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    // Cutoff would normally fire (100 chars >> 10), but strategy=off
    // keeps everything.
    expect(plan.applied).toBe(false)
    expect(plan.kept.length).toBe(2)
  })

  it('short-circuits when contextStrategy.kind is "middle_out_plugin"', () => {
    const base = settings({ customMaxContext: 10 })
    base.contextStrategy = { ...base.contextStrategy, kind: 'middle_out_plugin' }
    const plan = computeCutoffPlan({
      messages: [makeMessage('user', 'u'.repeat(100)), makeMessage('assistant', 'a'.repeat(100))],
      settings: base,
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    expect(plan.applied).toBe(false)
  })
})

describe('computeCutoffPlan — preamble stays fixed', () => {
  it('keeps the preamble (system + orphan assistants) even under tight budget', () => {
    const sysText = 'S'.repeat(70) // 20 tokens
    const path = [
      makeMessage('system', sysText),
      makeMessage('user', 'u1'),
      makeMessage('assistant', 'a1'),
      makeMessage('user', 'u2'),
      makeMessage('assistant', 'a2'),
    ]
    const plan = computeCutoffPlan({
      messages: path,
      settings: settings({ customMaxContext: 25 }),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    // Preamble takes ~20 tokens; available after preamble = 5.
    // Optional history is removed, but the terminal pair remains mandatory.
    expect(plan.kept.some((m) => m.role === 'system')).toBe(true)
    expect(plan.kept.slice(-2)).toEqual(path.slice(-2))
    expect(plan.preambleTokens).toBeGreaterThan(15)
  })
})

describe('computeCutoffPlan — LibreChat-style media heuristics', () => {
  it('uses OpenAI dims-based formula for images with attachmentResolver', () => {
    const msgWithImage: Message = {
      ...makeMessage('user', ''),
      content: [{ type: 'image_url', attachmentId: 'att-1' }] as Message['content'],
    }
    const plan = computeCutoffPlan({
      messages: [msgWithImage],
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
      attachmentResolver: (id) => {
        if (id === 'att-1') {
          return storedAttachment({
            id: 'att-1',
            contentHash: '',
            kind: 'image',
            mime: 'image/png',
            filename: 'x.png',
            sizeBytes: 0,
            dimensions: { width: 512, height: 512 },
          })
        }
        return undefined
      },
    })
    // (512 × 512) / 512 + 85 = 597 × 1.05 = 626.85 → ceil 627.
    expect(plan.historyMediaTokens).toBe(627)
  })

  it('image with no resolver uses default OpenRouter image cap', () => {
    const msgWithImage: Message = {
      ...makeMessage('user', ''),
      content: [{ type: 'image_url' }] as Message['content'],
    }
    const plan = computeCutoffPlan({
      messages: [msgWithImage],
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    expect(plan.historyMediaTokens).toBe(1000)
  })

  it('threads currentModelId into cutoff media costs for Kimi/Moonshot', () => {
    const msgWithImage: Message = {
      ...makeMessage('user', ''),
      content: [{ type: 'image_url', attachmentId: 'att-1' }] as Message['content'],
    }
    const plan = computeCutoffPlan({
      messages: [msgWithImage],
      settings: settings({ model: 'moonshotai/kimi-k2.6' }),
      tokenizer: 'unknown',
      providerCap: null,
      currentModelId: 'moonshotai/kimi-k2.6',
      attachmentResolver: (id) => {
        if (id === 'att-1') {
          return storedAttachment({
            id: 'att-1',
            contentHash: '',
            kind: 'image',
            mime: 'image/jpeg',
            filename: 'large.jpg',
            sizeBytes: 3_500_000,
            dimensions: { width: 3500, height: 3500 },
          })
        }
        return undefined
      },
    })
    expect(plan.historyMediaTokens).toBe(4000)
  })

  it('PDF attachment with pageCount uses OpenRouter file-parser tier', () => {
    const msg: Message = {
      ...makeMessage('user', ''),
      content: [
        { type: 'file', attachmentId: 'pdf-1', filename: 'doc.pdf', mime: 'application/pdf' },
      ] as Message['content'],
    }
    const plan = computeCutoffPlan({
      messages: [msg],
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
      attachmentResolver: () =>
        storedAttachment({
          id: 'pdf-1',
          contentHash: '',
          kind: 'pdf',
          mime: 'application/pdf',
          filename: 'doc.pdf',
          sizeBytes: 0,
          pageCount: 4,
        }),
    })
    // 4 × 500 × 1.05 = 2100
    expect(plan.historyMediaTokens).toBe(2100)
  })
})

describe('computeCutoffPlan — per-message cache (Phase B)', () => {
  it('uses cachedTokenEstimate when originalModelId matches currentModelId', () => {
    const m: Message = {
      ...makeMessage('user', 'a'.repeat(35)),
      originalModelId: 'openai/gpt-4o',
      cachedTokenEstimate: 999,
      cachedMediaTokens: 0,
    }
    const plan = computeCutoffPlan({
      messages: [m],
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
      currentModelId: 'openai/gpt-4o',
    })
    expect(plan.historyTextTokens).toBe(999)
  })

  it('uses originalTokenEstimate + edit delta when same-model calibration is provided', () => {
    const m: Message = {
      ...makeMessage('user', 'a'.repeat(70)),
      originalCharCount: 35,
      originalTokenEstimate: 10,
      originalModelId: 'openai/gpt-4o',
      charCountDelta: 35,
      cachedTokenEstimate: 999,
    }
    const plan = computeCutoffPlan({
      messages: [m],
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
      currentModelId: 'openai/gpt-4o',
      currentTextCharsPerToken: 3,
    })
    expect(plan.historyTextTokens).toBe(22)
  })

  it('treats exact model switches inside the same tokenizer family as same-bucket', () => {
    const m: Message = {
      ...makeMessage('user', 'a'.repeat(70)),
      originalCharCount: 35,
      originalTokenEstimate: 10,
      originalModelId: 'google/gemini-2.5-pro-preview',
      originalCalibrationKey: tokenCalibrationKey('google/gemini-2.5-pro-preview'),
      charCountDelta: 35,
      cachedTokenEstimate: 999,
    }
    const plan = computeCutoffPlan({
      messages: [m],
      settings: settings({}),
      tokenizer: 'gemini',
      providerCap: null,
      currentModelId: 'google/gemini-2.5-pro-preview-05-06',
      currentTextCharsPerToken: 3,
    })
    expect(plan.historyTextTokens).toBe(22)
  })

  it('ignores cache when models differ (cross-model message)', () => {
    const m: Message = {
      ...makeMessage('user', 'a'.repeat(35)),
      originalModelId: 'openai/gpt-4o',
      cachedTokenEstimate: 999,
    }
    const plan = computeCutoffPlan({
      messages: [m],
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
      currentModelId: 'anthropic/claude-opus-4.7',
    })
    // Fresh path: 35 / 3.5 = 10
    expect(plan.historyTextTokens).toBe(10)
  })

  it('recomputes cross-model rows against the current model ratio when provided', () => {
    const m: Message = {
      ...makeMessage('user', 'a'.repeat(35)),
      originalCharCount: 35,
      originalTokenEstimate: 10,
      originalModelId: 'openai/gpt-4o',
      charCountDelta: 0,
      cachedTokenEstimate: 999,
    }
    const plan = computeCutoffPlan({
      messages: [m],
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
      currentModelId: 'anthropic/claude-opus-4.7',
      currentTextCharsPerToken: 3,
    })
    expect(plan.historyTextTokens).toBe(12)
  })

  it('recomputes legacy cached rows against the current model ratio when provided', () => {
    const m: Message = {
      ...makeMessage('user', 'a'.repeat(35)),
      cachedTokenEstimate: 999,
    }
    const plan = computeCutoffPlan({
      messages: [m],
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
      currentModelId: 'openai/gpt-4o',
      currentTextCharsPerToken: 3,
    })
    expect(plan.historyTextTokens).toBe(12)
  })
})

describe('computeCutoffPlan — robustness guards', () => {
  it('does not crash when a message.content is null/undefined', () => {
    const path = [
      makeMessage('user', 'u1'),
      {
        ...makeMessage('assistant', 'a1'),
        content: null as unknown as Message['content'],
      },
    ]
    expect(() =>
      computeCutoffPlan({
        messages: path,
        settings: settings({}),
        tokenizer: TOKENIZER,
        providerCap: null,
      }),
    ).not.toThrow()
  })

  it('clamps negative maxCompletionTokens so the reserve cannot backdoor-expand budget', () => {
    // If the guard were missing, reserve = -999 → available += 999,
    // pairs would fit that shouldn't. With the clamp, reserve = 0.
    const path = [
      makeMessage('user', 'u1'.repeat(30)), // ~20 tokens
      makeMessage('assistant', 'a1'.repeat(30)),
      makeMessage('user', 'u2'.repeat(30)),
      makeMessage('assistant', 'a2'.repeat(30)),
    ]
    const plan = computeCutoffPlan({
      messages: path,
      settings: settings({ customMaxContext: 30, maxCompletionTokens: -999 }),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    expect(plan.reserveTokens).toBe(0)
    // reserve = 0, available ≈ 30 tokens; only one pair fits.
    expect(plan.applied).toBe(true)
  })

  it('treats -1 maxCompletionTokens as unlimited (reserve = 0)', () => {
    const plan = computeCutoffPlan({
      messages: [makeMessage('user', 'hi'), makeMessage('assistant', 'ok')],
      settings: settings({ maxCompletionTokens: -1, customMaxContext: 100 }),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    expect(plan.reserveTokens).toBe(0)
  })

  it('returns finite non-negative token fields even when everything is empty', () => {
    const plan = computeCutoffPlan({
      messages: [],
      settings: settings({}),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    expect(Number.isFinite(plan.systemTokens)).toBe(true)
    expect(Number.isFinite(plan.draftTokens)).toBe(true)
    expect(Number.isFinite(plan.historyTokens)).toBe(true)
    expect(Number.isFinite(plan.total)).toBe(true)
    expect(plan.total).toBe(0)
  })
})

describe('applyContextCutoff — helper', () => {
  it('returns the kept-messages array directly', () => {
    const path = [
      makeMessage('user', 'u1'),
      makeMessage('assistant', 'a1'),
      makeMessage('user', 'u2'),
      makeMessage('assistant', 'a2'),
    ]
    const cut = applyContextCutoff({
      messages: path,
      settings: settings({ keepFirstPairs: 0, customMaxContext: 10 }),
      tokenizer: TOKENIZER,
      providerCap: null,
    })
    // Each pair ≈ 2 tokens; budget=10; fits all 2 pairs.
    expect(cut.length).toBe(4)
  })
})
