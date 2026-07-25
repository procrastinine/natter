// Tests for the reasoning-include filter (format compatibility, redacted-
// thinking gate) and for empty-echo-item stripping in `toResponses`.
//
// Covers tasks 33 + 34 in the Phase 11 audit:
//   - Empty reasoning items are dropped when `applyIncludeToEchoItem`
//     strips both encrypted_content and summary.
//   - Format-tag mismatches across providers cause drops.
//   - OpenAI / Azure responses formats are interchangeable (OpenRouter
//     proxy flips between them — both should round-trip cleanly).

import { describe, expect, it } from 'vitest'
import { toResponses as toResponsesWithContract } from '../../src/api/request-transforms'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT } from '../../src/core/provider-tool-context'
import type {
  ChatSettings,
  Message,
  ReasoningDetail,
  ReasoningFormat,
  ReasoningInclude,
} from '../../src/core/types'
import {
  compileChatReasoningDetailsForTest,
  responsesReasoningContractForSettings,
  TEST_UNSUPPORTED_PREFILL_PLAN,
} from '../helpers/reasoning-contracts'
import { reasoningEnvelopeFromDetailsForTest } from '../helpers/reasoning-events'

function filterReasoningForInclude(
  details: readonly ReasoningDetail[],
  include: ReasoningInclude,
  targetFormat: ReasoningFormat | undefined,
  options: { acceptsAnthropicRedactedThinking?: boolean } = {},
) {
  return compileChatReasoningDetailsForTest(details, include, targetFormat, options)
}

function toResponses(
  settings: Parameters<typeof toResponsesWithContract>[0],
  path: Parameters<typeof toResponsesWithContract>[1],
) {
  return toResponsesWithContract(settings, path, {
    reasoning: responsesReasoningContractForSettings(settings),
    providerOutput: OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
    prefillPlan: TEST_UNSUPPORTED_PREFILL_PLAN,
  })
}

function detail(d: Partial<ReasoningDetail> & { type: ReasoningDetail['type'] }): ReasoningDetail {
  return d as ReasoningDetail
}

function mkInclude(p: Partial<ReasoningInclude> = {}): ReasoningInclude {
  return { encrypted: true, summary: false, text: false, ...p }
}

describe('filterReasoningForInclude — format compatibility', () => {
  it('drops encrypted when stored format mismatches target (gemini → openai)', () => {
    const kept = filterReasoningForInclude(
      [detail({ type: 'reasoning.encrypted', format: 'google-gemini-v1', data: 'blob' })],
      mkInclude({ encrypted: true }),
      'openai-responses-v1',
    )
    expect(kept).toHaveLength(0)
  })

  it('keeps encrypted when stored format matches target exactly (gpt-5.4 → gpt-5.4-nano)', () => {
    const kept = filterReasoningForInclude(
      [detail({ type: 'reasoning.encrypted', format: 'openai-responses-v1', data: 'blob' })],
      mkInclude({ encrypted: true }),
      'openai-responses-v1',
    )
    expect(kept).toHaveLength(1)
  })

  it('accepts cross-format within OpenAI family (azure ↔ openai, OpenRouter proxy case)', () => {
    // OpenRouter's `/responses` beta rewrites to `azure-openai-responses-v1`.
    // Echoing that back TO OpenAI direct (which emits `openai-responses-v1`)
    // should still carry through — verified by live probe.
    const azureStored = filterReasoningForInclude(
      [detail({ type: 'reasoning.encrypted', format: 'azure-openai-responses-v1', data: 'b' })],
      mkInclude({ encrypted: true }),
      'openai-responses-v1',
    )
    expect(azureStored).toHaveLength(1)

    const openaiStored = filterReasoningForInclude(
      [detail({ type: 'reasoning.encrypted', format: 'openai-responses-v1', data: 'b' })],
      mkInclude({ encrypted: true }),
      'azure-openai-responses-v1',
    )
    expect(openaiStored).toHaveLength(1)
  })

  it('does NOT accept xai-responses-v1 as OpenAI-family compatible (distinct signing key)', () => {
    const kept = filterReasoningForInclude(
      [detail({ type: 'reasoning.encrypted', format: 'xai-responses-v1', data: 'b' })],
      mkInclude({ encrypted: true }),
      'openai-responses-v1',
    )
    expect(kept).toHaveLength(0)
  })

  it('drops encrypted.anthropic-claude-v1 unless acceptsAnthropicRedactedThinking flag set', () => {
    const details = [
      detail({ type: 'reasoning.encrypted', format: 'anthropic-claude-v1', data: 'blob' }),
    ]
    const droppedByDefault = filterReasoningForInclude(
      details,
      mkInclude({ encrypted: true }),
      'anthropic-claude-v1',
    )
    expect(droppedByDefault).toHaveLength(0)
    const keptWithFlag = filterReasoningForInclude(
      details,
      mkInclude({ encrypted: true }),
      'anthropic-claude-v1',
      { acceptsAnthropicRedactedThinking: true },
    )
    expect(keptWithFlag).toHaveLength(1)
  })

  it('drops all encrypted entries when preservationFormat is undefined', () => {
    const kept = filterReasoningForInclude(
      [detail({ type: 'reasoning.encrypted', format: 'openai-responses-v1', data: 'b' })],
      mkInclude({ encrypted: true }),
      undefined,
    )
    expect(kept).toHaveLength(0)
  })

  it('drops encrypted entries when preservationFormat is "unknown" (no round-trip carrier)', () => {
    const kept = filterReasoningForInclude(
      [detail({ type: 'reasoning.encrypted', format: 'unknown', data: 'b' })],
      mkInclude({ encrypted: true }),
      'unknown',
    )
    expect(kept).toHaveLength(0)
  })

  it('drops Anthropic signed-text when target format mismatches', () => {
    // Anthropic carrier = reasoning.text with .signature + format
    // anthropic-claude-v1. If target is OpenAI, drop.
    const kept = filterReasoningForInclude(
      [
        detail({
          type: 'reasoning.text',
          format: 'anthropic-claude-v1',
          text: 'thinking',
          signature: 'sig',
        }),
      ],
      mkInclude({ encrypted: true }),
      'openai-responses-v1',
    )
    expect(kept).toHaveLength(0)
  })

  it('keeps Anthropic signed-text when target is also anthropic-claude-v1', () => {
    const kept = filterReasoningForInclude(
      [
        detail({
          type: 'reasoning.text',
          format: 'anthropic-claude-v1',
          text: 'thinking',
          signature: 'sig',
        }),
      ],
      mkInclude({ encrypted: true }),
      'anthropic-claude-v1',
    )
    expect(kept).toHaveLength(1)
    expect((kept[0] as { signature?: string }).signature).toBe('sig')
  })

  it('keeps plaintext reasoning.text only when include.text is true', () => {
    const details = [detail({ type: 'reasoning.text', text: 'just text' })]
    const dropped = filterReasoningForInclude(
      details,
      mkInclude({ text: false }),
      'openai-responses-v1',
    )
    expect(dropped).toHaveLength(0)
    const kept = filterReasoningForInclude(
      details,
      mkInclude({ text: true }),
      'openai-responses-v1',
    )
    expect(kept).toHaveLength(1)
  })

  it('filters tool_-prefixed id entries as non-reasoning (SillyTavern landmine)', () => {
    const kept = filterReasoningForInclude(
      [
        detail({
          type: 'reasoning.encrypted',
          format: 'openai-responses-v1',
          data: 'x',
          id: 'tool_xyz',
        }),
      ],
      mkInclude({ encrypted: true }),
      'openai-responses-v1',
    )
    expect(kept).toHaveLength(0)
  })
})

// Minimal settings/message builder for the echo-item test.
function baseSettings(): ChatSettings {
  const settings = cloneDefaultChatSettings()
  settings.model = 'openai/gpt-5.4-nano'
  settings.profileId = 'p1'
  settings.systemPrompt = ''
  settings.reasoning = {
    mode: 'off',
    exclude: false,
    summary: 'off',
    include: { encrypted: false, summary: false, text: false },
  }
  return settings
}

function baseAssistantMessage(): Message {
  return {
    id: 'm1',
    chatId: 'c1',
    turnId: 't1',
    turnIndex: 0,
    parentId: null,
    siblingIndex: 0,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'output_text', text: 'hi' }],
    createdAt: 0,
    reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
      [
        {
          type: 'reasoning.encrypted',
          format: 'openai-responses-v1',
          data: 'blob',
          providerItemId: 'rs_123',
          providerOutputIndex: 0,
        },
        {
          type: 'reasoning.summary',
          format: 'openai-responses-v1',
          summary: 'visible reasoning summary',
          providerItemId: 'rs_123',
          providerOutputIndex: 0,
          providerSummaryIndex: 0,
        },
      ],
      'openai-responses',
    ),
    nodeVersion: 0,
    deleted: false,
  }
}

describe('toResponses — empty echo-item stripping', () => {
  it('drops naked reasoning item when include flags strip all carrier fields', () => {
    const settings = baseSettings()
    const msg = baseAssistantMessage()
    const { wire } = toResponses(settings, [msg])
    const reasoningItems = (
      (Array.isArray(wire.input) ? wire.input : []) as Array<{
        type?: string
        [k: string]: unknown
      }>
    ).filter((i) => i.type === 'reasoning')
    expect(reasoningItems).toHaveLength(0)
  })

  it('keeps reasoning item when include.encrypted is true AND format compatible', () => {
    const settings: ChatSettings = {
      ...baseSettings(),
      reasoning: {
        ...baseSettings().reasoning,
        include: { encrypted: true, summary: false, text: false },
      },
      responses: { store: false },
    }
    const msg = baseAssistantMessage()
    const { wire } = toResponses(settings, [msg])
    const reasoningItems = (
      (Array.isArray(wire.input) ? wire.input : []) as Array<{
        type?: string
        [k: string]: unknown
      }>
    ).filter((i) => i.type === 'reasoning')
    expect(reasoningItems).toHaveLength(1)
    expect((reasoningItems[0] as { encrypted_content?: string }).encrypted_content).toBe('blob')
    // OpenAI /v1/responses requires `summary` to be present on reasoning
    // input items (empty [] is fine). Dropping the field entirely triggers
    // 400 `Missing required parameter: 'input[N].summary'`.
    expect((reasoningItems[0] as { summary?: unknown }).summary).toEqual([])
  })

  it('keeps reasoning item with only summary when include.summary is true + encrypted false', () => {
    const settings: ChatSettings = {
      ...baseSettings(),
      reasoning: {
        ...baseSettings().reasoning,
        include: { encrypted: false, summary: true, text: false },
      },
    }
    const msg = baseAssistantMessage()
    const { wire } = toResponses(settings, [msg])
    const reasoningItems = (
      (Array.isArray(wire.input) ? wire.input : []) as Array<{
        type?: string
        [k: string]: unknown
      }>
    ).filter((i) => i.type === 'reasoning')
    expect(reasoningItems).toHaveLength(1)
    // Encrypted stripped.
    expect((reasoningItems[0] as { encrypted_content?: string }).encrypted_content).toBeUndefined()
    expect((reasoningItems[0] as { summary?: unknown[] }).summary).toHaveLength(1)
  })
})
