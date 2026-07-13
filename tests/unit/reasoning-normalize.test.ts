import { describe, expect, it } from 'vitest'
import { mergeReasoningText, normalizeReasoningDetails } from '../../src/core/reasoning'
import type { ReasoningDetail } from '../../src/core/types'

describe('normalizeReasoningDetails', () => {
  it('preserves ambiguous legacy summary snapshots as separate rows', () => {
    const details: ReasoningDetail[] = [
      {
        type: 'reasoning.summary',
        index: 0,
        summary: 'Most CJK characters are often 1 token',
      },
      {
        type: 'reasoning.summary',
        index: 0,
        summary: 'Most CJK characters are often 1 token in modern BPE tokenizers, but not always.',
      },
    ]

    expect(normalizeReasoningDetails(details)).toEqual(details)
  })

  it('keeps distinct summaries at the same index separate when they are not incremental', () => {
    const details: ReasoningDetail[] = [
      {
        type: 'reasoning.summary',
        index: 0,
        summary: 'First thought: enumerate possibilities.',
      },
      {
        type: 'reasoning.summary',
        index: 0,
        summary: 'Second thought: choose the strongest one.',
      },
    ]

    expect(normalizeReasoningDetails(details)).toEqual(details)
  })

  it('does not guess that OpenAI-family summary and text rows are mirrors', () => {
    const details: ReasoningDetail[] = [
      {
        type: 'reasoning.summary',
        index: 0,
        format: 'azure-openai-responses-v1',
        summary: 'Most',
      },
      {
        type: 'reasoning.summary',
        index: 0,
        format: 'azure-openai-responses-v1',
        summary: ' CJK',
      },
      {
        type: 'reasoning.text',
        index: 0,
        text: 'Most CJK',
      },
    ]

    expect(normalizeReasoningDetails(details)).toEqual(details)
  })

  it('preserves distinct ids, metadata, tool rows, and overlap-looking bytes', () => {
    const details: ReasoningDetail[] = [
      {
        type: 'reasoning.text',
        id: 'block-a',
        index: 0,
        format: 'unknown',
        text: 'ends A',
        hidden: true,
      },
      { type: 'reasoning.text', id: 'tool_call-1', index: 0, text: 'tool carrier' },
      {
        type: 'reasoning.text',
        id: 'block-b',
        index: 0,
        format: 'anthropic-claude-v1',
        text: 'A starts',
        signature: 'signature-b',
      },
    ]

    expect(normalizeReasoningDetails(details)).toEqual(details)
  })
})

describe('mergeReasoningText', () => {
  it('preserves full-snapshot replacement for large reasoning text', () => {
    const existing = `start ${'a'.repeat(10_000)}`
    const incoming = `${existing} done`

    expect(mergeReasoningText(existing, incoming)).toBe(incoming)
  })

  it('appends ambiguous boundary overlaps byte-for-byte', () => {
    const overlap = 'x'.repeat(1024)
    const existing = `${'a'.repeat(80_000)}${overlap}`
    const incoming = `${overlap}${'b'.repeat(80_000)}`

    expect(mergeReasoningText(existing, incoming)).toBe(`${existing}${incoming}`)
  })
})
