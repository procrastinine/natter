import { describe, expect, it } from 'vitest'
import { normalizeReasoningEnvelopeV92 } from '../../src/backcompat/reasoning-contract-normalizer-v92'
import {
  inspectReasoningEnvelopeState,
  projectReasoningEnvelope,
} from '../../src/core/reasoning-envelope'
import {
  applyReasoningObservationBatch,
  createReasoningObservationCodecState,
  reasoningObservationsFromDetails,
} from '../../src/core/reasoning-observation'
import type { ReasoningDetail } from '../../src/core/types'

function snapshotDetails(details: readonly ReasoningDetail[]) {
  const state = createReasoningObservationCodecState()
  applyReasoningObservationBatch(state, {
    observations: reasoningObservationsFromDetails({
      details,
      mode: 'snapshot',
      dialect: 'openrouter-chat',
      bridge: 'openrouter',
      untypedVisibleKind: 'text',
    }),
  })
  return projectReasoningEnvelope(state.envelope)
}

describe('reasoning detail snapshot ingress', () => {
  it('preserves ambiguous legacy summary snapshots as separate members', () => {
    const details: ReasoningDetail[] = [
      {
        type: 'reasoning.summary',
        index: 0,
        format: 'unknown',
        summary: 'Most CJK characters are often 1 token',
      },
      {
        type: 'reasoning.summary',
        index: 0,
        format: 'unknown',
        summary: 'Most CJK characters are often 1 token in modern BPE tokenizers, but not always.',
      },
    ]

    const envelope = snapshotDetails(details)
    expect(envelope.visible.map((part) => part.text)).toEqual([
      'Most CJK characters are often 1 token',
      'Most CJK characters are often 1 token in modern BPE tokenizers, but not always.',
    ])
    expect(new Set(envelope.visible.map((part) => part.id)).size).toBe(2)
  })

  it('keeps distinct summaries at the same index separate when they are not incremental', () => {
    const envelope = snapshotDetails([
      {
        type: 'reasoning.summary',
        index: 0,
        format: 'unknown',
        summary: 'First thought: enumerate possibilities.',
      },
      {
        type: 'reasoning.summary',
        index: 0,
        format: 'unknown',
        summary: 'Second thought: choose the strongest one.',
      },
    ])

    expect(envelope.visible.map((part) => part.text)).toEqual([
      'First thought: enumerate possibilities.',
      'Second thought: choose the strongest one.',
    ])
  })

  it('does not guess that OpenAI-family summary and text members are mirrors', () => {
    const envelope = snapshotDetails([
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
        format: 'unknown',
        text: 'Most CJK',
      },
    ])

    expect(envelope.visible.map((part) => [part.kind, part.text])).toEqual([
      ['summary', 'Most'],
      ['summary', ' CJK'],
      ['text', 'Most CJK'],
    ])
  })

  it('preserves distinct metadata and signed text while filtering tool carriers', () => {
    const envelope = snapshotDetails([
      {
        type: 'reasoning.text',
        id: 'block-a',
        index: 0,
        format: 'unknown',
        text: 'ends A',
        hidden: true,
      },
      {
        type: 'reasoning.text',
        id: 'tool_call-1',
        index: 0,
        format: 'unknown',
        text: 'tool carrier',
      },
      {
        type: 'reasoning.text',
        id: 'block-b',
        index: 0,
        format: 'anthropic-claude-v1',
        text: 'A starts',
        signature: 'signature-b',
      },
    ])

    expect(envelope.visible).toHaveLength(2)
    expect(envelope.visible.map((part) => part.source.detailId)).toEqual(['block-a', 'block-b'])
    expect(envelope.visible[0]).toMatchObject({ text: 'ends A', hidden: true })
    expect(envelope.carriers).toEqual([
      expect.objectContaining({
        kind: 'anthropic-signature',
        signature: 'signature-b',
        bindsVisiblePartId: envelope.visible[1]?.id,
      }),
    ])
  })

  it('preserves duplicate signed and opaque members without cross-binding them', () => {
    const claude = snapshotDetails([
      {
        type: 'reasoning.text',
        index: 0,
        format: 'anthropic-claude-v1',
        text: 'first',
        signature: 'signature-first',
      },
      {
        type: 'reasoning.text',
        index: 0,
        format: 'anthropic-claude-v1',
        text: 'second',
        signature: 'signature-second',
      },
    ])
    expect(claude.visible.map((part) => part.text)).toEqual(['first', 'second'])
    expect(claude.carriers).toHaveLength(2)
    expect(
      claude.carriers
        .filter((carrier) => carrier.kind === 'anthropic-signature')
        .map((carrier) => carrier.bindsVisiblePartId),
    ).toEqual(claude.visible.map((part) => part.id))

    const gemini = snapshotDetails([
      {
        type: 'reasoning.encrypted',
        index: 0,
        format: 'google-gemini-v1',
        data: 'thought-signature-first',
      },
      {
        type: 'reasoning.encrypted',
        index: 0,
        format: 'google-gemini-v1',
        data: 'thought-signature-second',
      },
    ])
    expect(
      gemini.carriers
        .filter((carrier) => carrier.kind === 'gemini-thought-signature')
        .map((carrier) => carrier.data),
    ).toEqual(['thought-signature-first', 'thought-signature-second'])
  })
})

describe('reasoning text reducer modes', () => {
  it('preserves full cumulative replacement for large reasoning text', () => {
    const state = createReasoningObservationCodecState()
    const existing = `start ${'a'.repeat(10_000)}`
    const incoming = `${existing} done`
    for (const value of [existing, incoming]) {
      applyReasoningObservationBatch(state, {
        observations: reasoningObservationsFromDetails({
          details: [{ type: 'reasoning.text', id: 'large', format: 'unknown', text: value }],
          mode: 'cumulative',
          dialect: 'openrouter-chat',
          bridge: 'openrouter',
          untypedVisibleKind: 'text',
        }),
      })
    }

    expect(projectReasoningEnvelope(state.envelope).visible[0]?.text).toBe(incoming)
    expect(inspectReasoningEnvelopeState(state.envelope).retainedTextSegments).toBeGreaterThan(1)
  })

  it('appends ambiguous delta boundary overlaps byte-for-byte', () => {
    const state = createReasoningObservationCodecState()
    const overlap = 'x'.repeat(1024)
    const existing = `${'a'.repeat(80_000)}${overlap}`
    const incoming = `${overlap}${'b'.repeat(80_000)}`
    for (const value of [existing, incoming]) {
      applyReasoningObservationBatch(state, {
        observations: reasoningObservationsFromDetails({
          details: [{ type: 'reasoning.text', id: 'overlap', format: 'unknown', text: value }],
          mode: 'delta',
          dialect: 'openrouter-chat',
          bridge: 'openrouter',
          untypedVisibleKind: 'text',
        }),
      })
    }

    expect(projectReasoningEnvelope(state.envelope).visible[0]?.text).toBe(`${existing}${incoming}`)
  })
})

describe('historical reasoning normalization', () => {
  it('retains an incompatible carrier payload as inert unknown evidence', () => {
    const normalized = normalizeReasoningEnvelopeV92(
      {
        schemaVersion: 2,
        visible: [],
        carriers: [
          {
            id: 'legacy-carrier',
            groupId: 'legacy-group',
            kind: 'anthropic-signature',
            signature: 'legacy-signature',
            format: 'google-gemini-v1',
            bindsVisiblePartId: 'missing-visible',
            source: {
              dialect: 'gemini-native',
              bridge: 'google-direct',
              itemId: 'legacy-item',
            },
          },
        ],
      },
      {
        apiUsed: 'gemini-native',
        profile: { kind: 'google' },
      },
    )

    expect(normalized?.carriers).toEqual([
      {
        id: 'legacy-carrier',
        groupId: 'legacy-group',
        kind: 'unknown',
        data: 'legacy-signature',
        format: 'unknown',
        source: {
          dialect: 'unknown',
          bridge: 'unknown',
          itemId: 'legacy-item',
        },
      },
    ])
  })
})
