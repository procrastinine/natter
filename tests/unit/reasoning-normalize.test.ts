import { describe, expect, it } from 'vitest'
import { normalizeReasoningDetails } from '../../src/core/reasoning'
import type { ReasoningDetail } from '../../src/core/types'

describe('normalizeReasoningDetails', () => {
  it('collapses legacy incremental summary snapshots into one row', () => {
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

    expect(normalizeReasoningDetails(details)).toEqual([
      {
        type: 'reasoning.summary',
        index: 0,
        summary: 'Most CJK characters are often 1 token in modern BPE tokenizers, but not always.',
      },
    ])
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

  it('collapses OpenAI-family summary fragments and drops mirrored reasoning.text', () => {
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

    expect(normalizeReasoningDetails(details)).toEqual([
      {
        type: 'reasoning.summary',
        index: 0,
        format: 'azure-openai-responses-v1',
        summary: 'Most CJK',
      },
    ])
  })
})
