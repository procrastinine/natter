import { describe, expect, it } from 'vitest'
import { createAppliedMessageView } from '../../src/core/continuation-content'
import {
  compileAppliedMessageReasoning,
  createOutboundReasoningCompiler,
  resolveOutboundReasoningResolver,
} from '../../src/core/outbound-reasoning'
import { messageContextRouteFacts } from '../../src/core/reasoning'
import {
  applyReasoningCarrierUpdate,
  applyReasoningEnvelopeMutation,
  applyReasoningVisibleUpdate,
  createReasoningEnvelopeState,
  inspectReasoningEnvelopeState,
  isReasoningEnvelope,
  isReasoningEnvelopeMutation,
  projectReasoningEnvelope,
  projectReasoningEnvelopeLive,
  projectReasoningPresentation,
  reasoningEnvelopeHasPresentation,
  releaseReasoningEnvelopeState,
} from '../../src/core/reasoning-envelope'
import {
  applyCanonicalReasoningMutation,
  applyReasoningObservationBatch,
  createReasoningObservationCodecState,
  reasoningObservationsFromDetails,
} from '../../src/core/reasoning-observation'
import type {
  Message,
  ReasoningDetail,
  ReasoningEnvelopeV2,
  ReasoningOriginDialect,
  ReasoningProducerBridge,
  ReasoningSourceRefV2,
} from '../../src/core/types'
import {
  anthropicReasoningContract,
  geminiReasoningContract,
  responsesReasoningContract,
} from '../helpers/reasoning-contracts'

const anthropicSource = {
  dialect: 'anthropic-messages',
  bridge: 'anthropic-direct',
  itemId: 'thinking-0',
  outputIndex: 0,
} as const satisfies ReasoningSourceRefV2

function stateFromDetails(input: {
  details: readonly ReasoningDetail[]
  dialect: ReasoningOriginDialect
  bridge: ReasoningProducerBridge
  untypedVisibleKind: 'text' | 'summary'
}) {
  const codec = createReasoningObservationCodecState()
  applyReasoningObservationBatch(codec, {
    observations: reasoningObservationsFromDetails({
      ...input,
      mode: 'snapshot',
    }),
  })
  return codec.envelope
}

describe('reasoning envelope reducer', () => {
  it('projects durable and live snapshots through one classification contract', () => {
    const state = stateFromDetails({
      details: [
        {
          type: 'reasoning.summary',
          format: 'google-gemini-v1',
          id: 'summary-0',
          providerItemId: 'thought-0',
          summary: 'visible summary',
        },
        {
          type: 'reasoning.encrypted',
          format: 'google-gemini-v1',
          id: 'signature-0',
          providerItemId: 'thought-0',
          data: 'opaque-signature',
        },
      ],
      dialect: 'gemini-native',
      bridge: 'google-direct',
      untypedVisibleKind: 'summary',
    })

    const durable = projectReasoningPresentation({
      kind: 'durable',
      owner: { kind: 'generation' },
      envelope: projectReasoningEnvelope(state),
    })
    const liveProjection = projectReasoningEnvelopeLive(state)
    const live = projectReasoningPresentation({
      kind: 'live',
      owner: { kind: 'generation' },
      projection: liveProjection,
    })

    expect(live).toMatchObject({
      kind: durable.kind,
      rowCount: durable.rowCount,
      textCharCount: durable.textCharCount,
      summaryCharCount: durable.summaryCharCount,
      opaqueCarrierBytes: durable.opaqueCarrierBytes,
      authenticationCarrierBytes: durable.authenticationCarrierBytes,
    })
    expect(live.summary[0]?.valueSections).toBe(liveProjection.visible[0]?.valueSections)
    expect(live.opaque[0]?.carrier).not.toHaveProperty('data')
  })

  it('classifies bound Claude signatures as authentication, not encrypted rows', () => {
    const state = stateFromDetails({
      details: [
        {
          type: 'reasoning.text',
          format: 'anthropic-claude-v1',
          id: 'thinking-0',
          text: 'visible thought',
          signature: 'opaque-signature',
        },
      ],
      dialect: 'anthropic-messages',
      bridge: 'anthropic-direct',
      untypedVisibleKind: 'text',
    })

    const presentation = projectReasoningPresentation({
      kind: 'durable',
      owner: { kind: 'generation' },
      envelope: projectReasoningEnvelope(state),
    })
    expect(presentation).toMatchObject({
      kind: 'plaintext',
      rowCount: 1,
      opaque: [],
      authenticationCarrierBytes: 'opaque-signature'.length,
    })
    expect(presentation.authentication).toHaveLength(1)
  })

  it('uses bound Claude text visibility for both route facts and signed replay', () => {
    const state = stateFromDetails({
      details: [
        {
          type: 'reasoning.text',
          format: 'anthropic-claude-v1',
          id: 'thinking-0',
          text: 'visible thought',
          signature: 'opaque-signature',
        },
      ],
      dialect: 'anthropic-messages',
      bridge: 'anthropic-direct',
      untypedVisibleKind: 'text',
    })
    const envelope = projectReasoningEnvelope(state)
    const signature = envelope.carriers[0]
    const visible = envelope.visible[0]
    if (signature?.kind !== 'anthropic-signature' || !visible) {
      throw new Error('SignedReasoningFixtureMissing')
    }
    const hiddenSignatureEnvelope: ReasoningEnvelopeV2 = {
      ...envelope,
      carriers: envelope.carriers.map((carrier) =>
        carrier.id === signature.id ? { ...carrier, hidden: true } : carrier,
      ),
    }
    const contract = {
      include: { encrypted: true, summary: true, text: true },
      echoAsThinkTags: false,
      acceptsAnthropicRedactedThinking: false,
      targetFormat: 'anthropic-claude-v1',
      carrier: 'anthropic-blocks',
      producerBridge: 'anthropic-direct',
    } as const
    const message: Message = {
      id: 'assistant',
      chatId: 'chat',
      parentId: null,
      siblingIndex: 0,
      turnId: 'turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'answer' }],
      reasoningEnvelope: hiddenSignatureEnvelope,
      nodeVersion: 0,
      deleted: false,
    }

    expect(
      messageContextRouteFacts({ content: [], reasoningEnvelope: hiddenSignatureEnvelope })
        .reasoningCarriers,
    ).toHaveLength(1)
    expect(
      compileAppliedMessageReasoning(createAppliedMessageView(message), {
        kind: 'anthropic',
        contract,
      }).attempts.flatMap((attempt) => attempt.units),
    ).toEqual([
      expect.objectContaining({
        kind: 'thinking-authenticated',
        text: 'visible thought',
        signature: 'opaque-signature',
      }),
    ])

    const hiddenVisibleEnvelope: ReasoningEnvelopeV2 = {
      ...hiddenSignatureEnvelope,
      visible: hiddenSignatureEnvelope.visible.map((part) =>
        part.id === visible.id ? { ...part, hidden: true } : part,
      ),
    }
    expect(
      messageContextRouteFacts({ content: [], reasoningEnvelope: hiddenVisibleEnvelope })
        .reasoningCarriers,
    ).toEqual([expect.objectContaining({ binding: 'missing' })])
    expect(
      compileAppliedMessageReasoning(
        createAppliedMessageView({ ...message, reasoningEnvelope: hiddenVisibleEnvelope }),
        {
          kind: 'anthropic',
          contract,
        },
      ).attempts,
    ).toEqual([])
  })

  it('uses payload-bearing members as the scalar presentation predicate', () => {
    expect(reasoningEnvelopeHasPresentation({ schemaVersion: 2, visible: [], carriers: [] })).toBe(
      false,
    )
    expect(
      reasoningEnvelopeHasPresentation({
        schemaVersion: 2,
        visible: [
          {
            id: 'empty',
            groupId: 'empty',
            kind: 'text',
            text: '',
            format: 'unknown',
            source: { dialect: 'unknown', bridge: 'unknown' },
          },
        ],
        carriers: [],
      }),
    ).toBe(false)
  })

  it('keeps visible Claude thinking distinct when its signature arrives', () => {
    const state = createReasoningEnvelopeState()
    applyReasoningEnvelopeMutation(state, {
      kind: 'visible-append',
      part: {
        id: 'visible:thinking-0',
        groupId: 'group:thinking-0',
        kind: 'text',
        format: 'anthropic-claude-v1',
        source: anthropicSource,
      },
      delta: 'visible thought',
    })
    applyReasoningEnvelopeMutation(state, {
      kind: 'carrier-set',
      carrier: {
        id: 'carrier:thinking-0',
        groupId: 'group:thinking-0',
        kind: 'anthropic-signature',
        format: 'anthropic-claude-v1',
        source: anthropicSource,
        signature: 'opaque-signature',
        bindsVisiblePartId: 'visible:thinking-0',
      },
    })

    expect(projectReasoningEnvelope(state)).toEqual({
      schemaVersion: 2,
      visible: [
        {
          id: 'visible:thinking-0',
          groupId: 'group:thinking-0',
          kind: 'text',
          text: 'visible thought',
          format: 'anthropic-claude-v1',
          source: anthropicSource,
        },
      ],
      carriers: [
        {
          id: 'carrier:thinking-0',
          groupId: 'group:thinking-0',
          kind: 'anthropic-signature',
          format: 'anthropic-claude-v1',
          source: anthropicSource,
          signature: 'opaque-signature',
          bindsVisiblePartId: 'visible:thinking-0',
        },
      ],
    })
  })

  it('namespaces visible and carrier identity even when a provider reuses one bare id', () => {
    const state = createReasoningEnvelopeState()
    const source = {
      dialect: 'openrouter-chat',
      bridge: 'openrouter',
      itemId: 'shared-provider-id',
      outputIndex: 0,
    } as const satisfies ReasoningSourceRefV2
    applyReasoningEnvelopeMutation(state, {
      kind: 'visible-set',
      part: {
        id: 'shared-provider-id',
        groupId: 'group:shared-provider-id',
        kind: 'summary',
        text: 'summary',
        format: 'google-gemini-v1',
        source,
      },
    })
    applyReasoningEnvelopeMutation(state, {
      kind: 'carrier-set',
      carrier: {
        id: 'shared-provider-id',
        groupId: 'group:shared-provider-id',
        kind: 'gemini-thought-signature',
        format: 'google-gemini-v1',
        source,
        data: 'opaque',
        bindsVisiblePartId: 'shared-provider-id',
      },
    })

    expect(projectReasoningEnvelope(state)).toMatchObject({
      visible: [{ id: 'shared-provider-id', text: 'summary' }],
      carriers: [{ id: 'shared-provider-id', data: 'opaque' }],
    })
  })

  it('updates one exact carrier in place and keeps byte accounting exact', () => {
    const state = createReasoningEnvelopeState()
    const carrier = {
      id: 'carrier:response-0',
      groupId: 'group:response-0',
      kind: 'responses-encrypted',
      format: 'openai-responses-v1',
      source: {
        dialect: 'openai-responses',
        bridge: 'openai-direct',
        itemId: 'response-0',
        outputIndex: 0,
      },
      data: 'first',
    } as const
    expect(applyReasoningEnvelopeMutation(state, { kind: 'carrier-set', carrier })).toBe(true)
    expect(applyReasoningEnvelopeMutation(state, { kind: 'carrier-set', carrier })).toBe(false)
    expect(
      applyReasoningEnvelopeMutation(state, {
        kind: 'carrier-set',
        carrier: { ...carrier, data: 'replacement' },
      }),
    ).toBe(true)
    expect(inspectReasoningEnvelopeState(state)).toMatchObject({
      carriers: 1,
      carrierByteLength: 'replacement'.length,
    })
  })

  it('journals bridge-only refinements and conflicts as replayable metadata changes', () => {
    const part = {
      id: 'visible:bridge',
      groupId: 'group:bridge',
      kind: 'summary',
      format: 'google-gemini-v1',
      source: {
        dialect: 'openrouter-chat',
        bridge: 'unknown',
        choiceIndex: 0,
      },
    } as const
    const state = createReasoningEnvelopeState()
    const journal = [
      ...applyReasoningVisibleUpdate(state, { part, mode: 'append', value: 'summary' }),
      ...applyReasoningVisibleUpdate(state, {
        part: { ...part, source: { ...part.source, bridge: 'openrouter' } },
        mode: 'append',
        value: '',
      }),
      ...applyReasoningVisibleUpdate(state, {
        part: { ...part, source: { ...part.source, bridge: 'google-direct' } },
        mode: 'append',
        value: '',
      }),
    ]

    expect(journal).toHaveLength(3)
    expect(journal.every(isReasoningEnvelopeMutation)).toBe(true)
    expect(journal.slice(1)).toEqual([
      expect.objectContaining({ kind: 'visible-append', delta: '' }),
      expect.objectContaining({ kind: 'visible-append', delta: '' }),
    ])
    expect(projectReasoningEnvelope(state).visible[0]?.source.bridge).toBe('unknown')

    const replay = createReasoningEnvelopeState()
    for (const mutation of journal) applyReasoningEnvelopeMutation(replay, mutation)
    expect(projectReasoningEnvelope(replay)).toEqual(projectReasoningEnvelope(state))
  })

  it('does not mutate state when incoming metadata has conflicting coordinates', () => {
    const state = createReasoningEnvelopeState()
    const part = {
      id: 'visible:atomic-conflict',
      groupId: 'group:atomic-conflict',
      kind: 'summary',
      format: 'google-gemini-v1',
      source: {
        dialect: 'gemini-native',
        bridge: 'google-direct',
        candidateIndex: 0,
      },
    } as const
    applyReasoningVisibleUpdate(state, { part, mode: 'append', value: 'before' })
    const before = projectReasoningEnvelope(state)

    expect(() =>
      applyReasoningVisibleUpdate(state, {
        part: {
          ...part,
          hidden: true,
          source: { ...part.source, bridge: 'openrouter', candidateIndex: 1 },
        },
        mode: 'append',
        value: 'after',
      }),
    ).toThrow('ReasoningSourceCoordinateConflict:visible:atomic-conflict:candidateIndex')
    expect(projectReasoningEnvelope(state)).toEqual(before)
  })

  it('owns ingress and live-projection metadata without exposing reducer state', () => {
    const state = createReasoningEnvelopeState()
    const part = {
      id: 'visible:owned',
      groupId: 'group:owned',
      kind: 'text',
      format: 'anthropic-claude-v1',
      source: { ...anthropicSource },
    } as const
    applyReasoningVisibleUpdate(state, { part, mode: 'set', value: 'private text' })
    ;(part.source as { bridge: ReasoningProducerBridge }).bridge = 'unknown'

    const live = projectReasoningEnvelopeLive(state)
    const liveVisible = live.visible[0]
    expect(liveVisible).toBeDefined()
    if (!liveVisible) throw new Error('Expected live reasoning projection')
    ;(liveVisible.part.source as { bridge: ReasoningProducerBridge }).bridge = 'custom'
    ;(liveVisible.valueSections as string[]).push('foreign text')

    expect(projectReasoningEnvelope(state).visible[0]).toMatchObject({
      text: 'private text',
      source: { bridge: 'anthropic-direct' },
    })
  })

  it('validates replacement before release and treats an exact V2 replacement as a no-op', () => {
    const envelope: ReasoningEnvelopeV2 = {
      schemaVersion: 2,
      visible: [
        {
          id: 'visible:replace',
          groupId: 'group:replace',
          kind: 'text',
          text: 'kept',
          format: 'anthropic-claude-v1',
          source: anthropicSource,
        },
      ],
      carriers: [],
    }
    const state = createReasoningEnvelopeState(envelope)
    expect(applyReasoningEnvelopeMutation(state, { kind: 'replace', envelope })).toBe(false)

    expect(() =>
      applyReasoningEnvelopeMutation(state, {
        kind: 'replace',
        envelope: { ...envelope, schemaVersion: 1 },
      } as never),
    ).toThrow('ReasoningEnvelopeInvalid')
    expect(projectReasoningEnvelope(state)).toEqual(envelope)
    const visible = envelope.visible[0]
    if (!visible) throw new Error('ReasoningReplacementFixtureMissing')

    expect(
      applyReasoningEnvelopeMutation(state, {
        kind: 'replace',
        envelope: {
          ...envelope,
          visible: [
            {
              ...visible,
              source: { ...anthropicSource, bridge: 'unknown' },
            },
          ],
        },
      }),
    ).toBe(true)
  })

  it('keeps empty carrier updates out of the durable state and journal', () => {
    const state = createReasoningEnvelopeState()
    const carrier = {
      id: 'carrier:empty-update',
      groupId: 'group:empty-update',
      kind: 'responses-encrypted',
      format: 'openai-responses-v1',
      source: {
        dialect: 'openai-responses',
        bridge: 'openai-direct',
        itemId: 'reasoning-0',
        outputIndex: 0,
      },
    } as const
    expect(applyReasoningCarrierUpdate(state, { carrier, mode: 'set', value: '' })).toEqual([])
    applyReasoningCarrierUpdate(state, { carrier, mode: 'set', value: 'opaque' })
    expect(applyReasoningCarrierUpdate(state, { carrier, mode: 'cumulative', value: '' })).toEqual(
      [],
    )
    expect(projectReasoningEnvelope(state).carriers[0]).toMatchObject({ data: 'opaque' })
  })

  it('journals carrier metadata refinement without replaying opaque payload bytes', () => {
    const state = createReasoningEnvelopeState()
    const carrier = {
      id: 'carrier:metadata-only',
      groupId: 'group:metadata-only',
      kind: 'responses-encrypted',
      format: 'openai-responses-v1',
      source: {
        dialect: 'openai-responses',
        bridge: 'unknown',
        outputIndex: 0,
      },
    } as const
    applyReasoningCarrierUpdate(state, { carrier, mode: 'set', value: 'opaque' })
    const mutations = applyReasoningCarrierUpdate(state, {
      carrier: { ...carrier, source: { ...carrier.source, bridge: 'openai-direct' } },
      mode: 'set',
      value: 'opaque',
    })

    expect(mutations).toEqual([expect.objectContaining({ kind: 'carrier-append', delta: '' })])
    expect(mutations).not.toEqual([expect.objectContaining({ kind: 'carrier-set' })])
    expect(projectReasoningEnvelope(state).carriers[0]).toMatchObject({
      data: 'opaque',
      source: { bridge: 'openai-direct' },
    })
  })

  it('retains set snapshots by immutable reference and releases all owned state', () => {
    const state = createReasoningEnvelopeState()
    const text = 'x'.repeat(100_000)
    applyReasoningVisibleUpdate(state, {
      mode: 'set',
      part: {
        id: 'visible:snapshot',
        groupId: 'group:snapshot',
        kind: 'text',
        format: 'unknown',
        source: { dialect: 'inline', bridge: 'inline' },
      },
      value: text,
    })
    expect(inspectReasoningEnvelopeState(state)).toMatchObject({
      visibleTextLength: 100_000,
      retainedTextSegments: 1,
    })
    expect(projectReasoningEnvelope(state).visible[0]?.text).toBe(text)

    releaseReasoningEnvelopeState(state)
    expect(inspectReasoningEnvelopeState(state)).toEqual({
      visibleParts: 0,
      carriers: 0,
      visibleTextLength: 0,
      carrierByteLength: 0,
      retainedTextSegments: 0,
      retainedCarrierSegments: 0,
    })
  })

  it('accepts readable historical bindings while leaving replay safety to route compilation', () => {
    expect(
      isReasoningEnvelope({
        schemaVersion: 2,
        visible: [
          {
            id: 'visible:historical',
            groupId: 'group:historical',
            kind: 'summary',
            text: 'readable summary',
            format: 'google-gemini-v1',
            source: {
              dialect: 'gemini-native',
              bridge: 'google-direct',
              itemId: 'thought-0',
              candidateIndex: 0,
              frameIndex: 0,
              partIndex: 0,
            },
          },
        ],
        carriers: [
          {
            id: 'carrier:historical',
            groupId: 'group:historical',
            kind: 'gemini-thought-signature',
            data: 'opaque',
            format: 'google-gemini-v1',
            source: {
              dialect: 'gemini-native',
              bridge: 'openrouter',
              itemId: 'thought-0',
              candidateIndex: 0,
              frameIndex: 4,
              partIndex: 9,
            },
            bindsVisiblePartId: 'visible:historical',
          },
        ],
      }),
    ).toBe(true)
  })

  it('retains append text in page-bounded geometric segments', () => {
    const state = createReasoningEnvelopeState()
    for (let index = 0; index < 100_000; index += 1) {
      applyReasoningEnvelopeMutation(state, {
        kind: 'visible-append',
        part: {
          id: 'visible:long',
          groupId: 'group:long',
          kind: 'text',
          format: 'unknown',
          source: { dialect: 'inline', bridge: 'inline' },
        },
        delta: 'x',
      })
    }

    expect(inspectReasoningEnvelopeState(state)).toMatchObject({
      visibleParts: 1,
      visibleTextLength: 100_000,
    })
    expect(inspectReasoningEnvelopeState(state).retainedTextSegments).toBeLessThan(4_120)
    expect(projectReasoningEnvelope(state).visible[0]?.text).toHaveLength(100_000)
  })

  it('rejects one identity changing source coordinates mid-attempt', () => {
    const state = createReasoningEnvelopeState()
    const base = {
      id: 'visible:stable',
      groupId: 'group:stable',
      kind: 'summary',
      format: 'google-gemini-v1',
    } as const
    applyReasoningEnvelopeMutation(state, {
      kind: 'visible-append',
      part: {
        ...base,
        source: {
          dialect: 'gemini-native',
          bridge: 'google-direct',
          candidateIndex: 0,
          partIndex: 0,
        },
      },
      delta: 'a',
    })
    expect(() =>
      applyReasoningEnvelopeMutation(state, {
        kind: 'visible-append',
        part: {
          ...base,
          source: {
            dialect: 'gemini-native',
            bridge: 'google-direct',
            candidateIndex: 1,
            partIndex: 0,
          },
        },
        delta: 'b',
      }),
    ).toThrow('ReasoningSourceCoordinateConflict:visible:stable:candidateIndex')
  })

  it('rejects one identity changing its provider detail id mid-attempt', () => {
    const state = createReasoningEnvelopeState()
    const base = {
      id: 'visible:detail-stable',
      groupId: 'group:detail-stable',
      kind: 'summary',
      format: 'google-gemini-v1',
    } as const
    applyReasoningEnvelopeMutation(state, {
      kind: 'visible-append',
      part: {
        ...base,
        source: { dialect: 'openrouter-chat', bridge: 'openrouter', detailId: 'detail-a' },
      },
      delta: 'a',
    })
    expect(() =>
      applyReasoningEnvelopeMutation(state, {
        kind: 'visible-append',
        part: {
          ...base,
          source: { dialect: 'openrouter-chat', bridge: 'openrouter', detailId: 'detail-b' },
        },
        delta: 'b',
      }),
    ).toThrow('ReasoningSourceCoordinateConflict:visible:detail-stable:detailId')
  })

  it('replaces non-prefix cumulative snapshots instead of duplicating reasoning', () => {
    const state = createReasoningEnvelopeState()
    const part = {
      id: 'visible:cumulative',
      groupId: 'group:cumulative',
      kind: 'text',
      format: 'anthropic-claude-v1',
      source: anthropicSource,
    } as const

    expect(
      applyReasoningVisibleUpdate(state, {
        mode: 'cumulative',
        part,
        value: 'base',
      }),
    ).toMatchObject([{ kind: 'visible-set' }])
    expect(
      applyReasoningVisibleUpdate(state, {
        mode: 'cumulative',
        part,
        value: 'tail',
      }),
    ).toMatchObject([{ kind: 'visible-set', part: { text: 'tail' } }])
    expect(
      applyReasoningVisibleUpdate(state, {
        mode: 'cumulative',
        part,
        value: 'tailX',
      }),
    ).toMatchObject([{ kind: 'visible-append', delta: 'X' }])
    expect(projectReasoningEnvelope(state).visible[0]?.text).toBe('tailX')
  })

  it('merges Anthropic suffix observations without replaying overlap and refines unknown format', () => {
    const state = createReasoningEnvelopeState()
    const base = {
      id: 'visible:stream-observation',
      groupId: 'group:stream-observation',
      kind: 'text',
      format: 'unknown',
      source: {
        dialect: 'openrouter-chat',
        bridge: 'openrouter',
        choiceIndex: 0,
        detailIndex: 0,
      },
    } as const
    applyReasoningVisibleUpdate(state, {
      mode: 'append',
      part: base,
      value: 'EARLY ',
    })
    expect(
      applyReasoningVisibleUpdate(state, {
        mode: 'append-overlap',
        part: { ...base, format: 'anthropic-claude-v1' },
        value: 'LATER tail',
      }),
    ).toMatchObject([{ kind: 'visible-append', delta: 'LATER tail' }])
    expect(
      applyReasoningVisibleUpdate(state, {
        mode: 'append-overlap',
        part: { ...base, format: 'anthropic-claude-v1' },
        value: 'LATER tail END',
      }),
    ).toMatchObject([{ kind: 'visible-append', delta: ' END' }])
    expect(projectReasoningEnvelope(state).visible).toEqual([
      expect.objectContaining({
        format: 'anthropic-claude-v1',
        text: 'EARLY LATER tail END',
      }),
    ])
  })

  it('rejects a known-format change on one reasoning identity', () => {
    const state = createReasoningEnvelopeState()
    const part = {
      id: 'visible:format-conflict',
      groupId: 'group:format-conflict',
      kind: 'text',
      format: 'anthropic-claude-v1',
      source: {
        dialect: 'openrouter-chat',
        bridge: 'openrouter',
        choiceIndex: 0,
        detailIndex: 0,
      },
    } as const
    applyReasoningVisibleUpdate(state, {
      mode: 'append',
      part,
      value: 'a',
    })
    expect(() =>
      applyReasoningVisibleUpdate(state, {
        mode: 'append',
        part: { ...part, format: 'google-gemini-v1' },
        value: 'b',
      }),
    ).toThrow('ReasoningFormatConflict')
  })

  it('journals metadata-only updates and separates adjacent summary sections once', () => {
    const state = createReasoningEnvelopeState()
    const base = {
      id: 'visible:summary',
      groupId: 'group:summary',
      kind: 'summary',
      format: 'google-gemini-v1',
      source: {
        dialect: 'gemini-native',
        bridge: 'google-direct',
        candidateIndex: 0,
        frameIndex: 0,
        partIndex: 0,
      },
    } as const
    applyReasoningVisibleUpdate(state, {
      mode: 'append-section',
      part: base,
      value: 'first',
    })
    applyReasoningVisibleUpdate(state, {
      mode: 'append-section',
      part: base,
      value: 'second',
    })
    expect(
      applyReasoningVisibleUpdate(state, {
        mode: 'append',
        part: { ...base, hidden: true },
        value: '',
      }),
    ).toMatchObject([{ kind: 'visible-append', delta: '' }])
    expect(projectReasoningEnvelope(state).visible[0]).toMatchObject({
      text: 'first\n\nsecond',
      hidden: true,
    })
  })

  it('segments streamed opaque carriers and preserves cumulative chunks linearly', () => {
    const state = createReasoningEnvelopeState()
    const carrier = {
      id: 'carrier:reasoning-0',
      groupId: 'group:reasoning-0',
      kind: 'responses-encrypted',
      format: 'openai-responses-v1',
      source: {
        dialect: 'openai-responses',
        bridge: 'openai-direct',
        itemId: 'reasoning-0',
        outputIndex: 0,
      },
    } as const
    expect(
      applyReasoningCarrierUpdate(state, { carrier, mode: 'cumulative', value: 'base' }),
    ).toMatchObject([{ kind: 'carrier-set', carrier: { data: 'base' } }])
    expect(
      applyReasoningCarrierUpdate(state, {
        carrier,
        mode: 'cumulative',
        value: 'base-tail',
      }),
    ).toMatchObject([{ kind: 'carrier-append', delta: '-tail' }])
    for (let index = 0; index < 100_000; index += 1) {
      applyReasoningCarrierUpdate(state, {
        carrier,
        mode: 'append',
        value: 'x',
      })
    }
    expect(inspectReasoningEnvelopeState(state)).toMatchObject({
      carrierByteLength: 100_009,
    })
    expect(inspectReasoningEnvelopeState(state).retainedCarrierSegments).toBeLessThan(4_120)
    expect(projectReasoningEnvelope(state).carriers[0]).toMatchObject({
      data: `base-tail${'x'.repeat(100_000)}`,
    })
  })

  it('derives distinct stable members inside one provider reasoning group', () => {
    const envelope = projectReasoningEnvelope(
      stateFromDetails({
        details: [
          {
            type: 'reasoning.summary',
            format: 'openai-responses-v1',
            providerItemId: 'reasoning-item',
            providerOutputIndex: 0,
            providerSummaryIndex: 0,
            summary: 'one',
          },
          {
            type: 'reasoning.summary',
            format: 'openai-responses-v1',
            providerItemId: 'reasoning-item',
            providerOutputIndex: 0,
            providerSummaryIndex: 1,
            summary: 'two',
          },
        ],
        dialect: 'openai-responses',
        bridge: 'openai-direct',
        untypedVisibleKind: 'summary',
      }),
    )
    const [first, second] = envelope.visible
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first?.groupId).toBe(second?.groupId)
    expect(first?.id).not.toBe(second?.id)
  })

  it('binds one Gemini summary and carrier by stable provider group regardless of order', () => {
    const details = [
      {
        type: 'reasoning.summary' as const,
        format: 'google-gemini-v1' as const,
        id: 'summary-1',
        providerItemId: 'thought-1',
        summary: 'visible summary',
      },
      {
        type: 'reasoning.encrypted' as const,
        format: 'google-gemini-v1' as const,
        id: 'carrier-1',
        providerItemId: 'thought-1',
        data: 'opaque-signature',
      },
    ]
    const project = (ordered: typeof details) =>
      projectReasoningEnvelope(
        stateFromDetails({
          details: ordered,
          dialect: 'gemini-native',
          bridge: 'google-direct',
          untypedVisibleKind: 'summary',
        }),
      )

    const forward = project(details)
    const reversed = project([...details].reverse())
    expect(isReasoningEnvelope(forward)).toBe(true)
    expect(projectReasoningEnvelope(createReasoningEnvelopeState(forward))).toEqual(forward)
    expect(forward.carriers[0]).toMatchObject({
      kind: 'gemini-thought-signature',
      bindsVisiblePartId: forward.visible[0]?.id,
    })
    expect(reversed.carriers[0]).toMatchObject({
      kind: 'gemini-thought-signature',
      bindsVisiblePartId: reversed.visible[0]?.id,
    })
    expect(reversed.visible[0]?.id).toBe(forward.visible[0]?.id)
    expect(reversed.carriers[0]?.id).toBe(forward.carriers[0]?.id)
  })

  it('leaves ambiguous Gemini carriers unbound without duplicating the visible summary', () => {
    const details = [
      {
        type: 'reasoning.summary' as const,
        format: 'google-gemini-v1' as const,
        id: 'summary-1',
        providerItemId: 'thought-1',
        summary: 'visible summary',
      },
      {
        type: 'reasoning.encrypted' as const,
        format: 'google-gemini-v1' as const,
        id: 'carrier-1',
        providerItemId: 'thought-1',
        data: 'opaque-one',
      },
      {
        type: 'reasoning.encrypted' as const,
        format: 'google-gemini-v1' as const,
        id: 'carrier-2',
        providerItemId: 'thought-1',
        data: 'opaque-two',
      },
    ]
    const envelope = projectReasoningEnvelope(
      stateFromDetails({
        details,
        dialect: 'openrouter-chat',
        bridge: 'openrouter',
        untypedVisibleKind: 'summary',
      }),
    )

    expect(envelope.visible).toHaveLength(1)
    expect(envelope.carriers).toHaveLength(2)
    expect(envelope.carriers.every((carrier) => !('bindsVisiblePartId' in carrier))).toBe(true)
  })

  it('never lets a reused weak detail index steal a strong provider identity', () => {
    const run = (order: readonly ['a' | 'b', 'a' | 'b']) => {
      const codec = createReasoningObservationCodecState()
      const observe = (id: 'a' | 'b', value: string) =>
        applyReasoningObservationBatch(codec, {
          observations: [
            {
              kind: 'visible',
              visibleKind: 'text',
              update: 'append',
              value,
              format: 'anthropic-claude-v1',
              source: {
                dialect: 'openrouter-chat',
                bridge: 'openrouter',
                choiceIndex: 0,
                detailId: id,
                detailIndex: 0,
              },
              groupAliases: [{ kind: 'chat-choice', choiceIndex: 0, memberKind: 'text' }],
              memberAliases: [
                { kind: 'detail-id', memberKind: 'text', id, choiceIndex: 0 },
                { kind: 'detail-index', memberKind: 'text', index: 0, choiceIndex: 0 },
              ],
            },
          ],
        })
      for (const id of order) observe(id, id.toUpperCase())
      observe('a', '1')
      observe('b', '2')
      return projectReasoningEnvelope(codec.envelope)
        .visible.map((part) => [part.source.detailId, part.text] as const)
        .sort(([left], [right]) => (left ?? '').localeCompare(right ?? ''))
    }

    expect(run(['a', 'b'])).toEqual([
      ['a', 'A1'],
      ['b', 'B2'],
    ])
    expect(run(['b', 'a'])).toEqual([
      ['a', 'A1'],
      ['b', 'B2'],
    ])
  })

  it('refines late provider coordinates after canonical replay without duplicating a member', () => {
    const beforeReplay = createReasoningObservationCodecState()
    const first = applyReasoningObservationBatch(beforeReplay, {
      observations: reasoningObservationsFromDetails({
        details: [
          {
            type: 'reasoning.text',
            format: 'anthropic-claude-v1',
            index: 0,
            text: 'first ',
          },
        ],
        mode: 'delta',
        dialect: 'openrouter-chat',
        bridge: 'unknown',
        untypedVisibleKind: 'text',
        source: { choiceIndex: 0 },
      }),
    })
    const resumed = createReasoningObservationCodecState()
    for (const mutation of first) applyCanonicalReasoningMutation(resumed, mutation)
    applyReasoningObservationBatch(resumed, {
      observations: reasoningObservationsFromDetails({
        details: [
          {
            type: 'reasoning.text',
            format: 'anthropic-claude-v1',
            id: 'provider-thinking-0',
            index: 0,
            providerItemId: 'item-0',
            providerOutputIndex: 0,
            text: 'second',
          },
        ],
        mode: 'delta',
        dialect: 'openrouter-chat',
        bridge: 'openrouter',
        untypedVisibleKind: 'text',
        source: { choiceIndex: 0 },
      }),
    })

    const envelope = projectReasoningEnvelope(resumed.envelope)
    expect(envelope.visible).toHaveLength(1)
    expect(envelope.visible[0]).toMatchObject({
      text: 'first second',
      source: {
        bridge: 'openrouter',
        detailId: 'provider-thinking-0',
        itemId: 'item-0',
        outputIndex: 0,
      },
    })
  })

  it('refines an unbound Gemini carrier once and rejects a conflicting binding atomically', () => {
    const codec = createReasoningObservationCodecState()
    const source = {
      dialect: 'gemini-native',
      bridge: 'google-direct',
      candidateIndex: 0,
      frameIndex: 0,
      partIndex: 0,
    } as const
    const groupAliases = [
      { kind: 'gemini-part', candidateIndex: 0, frameIndex: 0, partIndex: 0 } as const,
    ]
    const carrier = {
      kind: 'carrier' as const,
      carrierKind: 'gemini-thought-signature' as const,
      update: 'set' as const,
      value: 'signature',
      format: 'google-gemini-v1' as const,
      source,
      groupAliases,
      memberAliases: [
        {
          kind: 'gemini-member' as const,
          candidateIndex: 0,
          frameIndex: 0,
          partIndex: 0,
          member: 'signature' as const,
        },
      ],
    }
    applyReasoningObservationBatch(codec, { observations: [carrier] })

    const binding = {
      visibleKind: 'summary' as const,
      format: 'google-gemini-v1' as const,
      source,
      groupAliases,
      memberAliases: [
        {
          kind: 'gemini-member' as const,
          candidateIndex: 0,
          frameIndex: 0,
          partIndex: 0,
          member: 'summary' as const,
        },
      ],
    }
    applyReasoningObservationBatch(codec, {
      observations: [{ ...carrier, binding }],
    })
    const refined = projectReasoningEnvelope(codec.envelope)
    expect(refined.carriers[0]).toMatchObject({
      bindsVisiblePartId: refined.visible[0]?.id,
    })

    const beforeConflict = structuredClone(refined)
    expect(() =>
      applyReasoningObservationBatch(codec, {
        observations: [
          {
            ...carrier,
            binding: {
              ...binding,
              memberAliases: [{ kind: 'detail-id', memberKind: 'summary', id: 'other-summary' }],
            },
          },
        ],
      }),
    ).toThrow(/ReasoningCarrierBindingConflict/)
    expect(projectReasoningEnvelope(codec.envelope)).toEqual(beforeConflict)
  })

  it('rejects cross-group and wrong-kind bindings before mutating the envelope', () => {
    const codec = createReasoningObservationCodecState()
    const carrier = {
      kind: 'carrier' as const,
      carrierKind: 'anthropic-signature' as const,
      update: 'set' as const,
      value: 'signature',
      format: 'anthropic-claude-v1' as const,
      source: {
        dialect: 'anthropic-messages' as const,
        bridge: 'anthropic-direct' as const,
        blockIndex: 0,
      },
      groupAliases: [{ kind: 'anthropic-block' as const, blockIndex: 0 }],
      memberAliases: [
        { kind: 'anthropic-member' as const, blockIndex: 0, member: 'signature' as const },
      ],
    }
    const before = projectReasoningEnvelope(codec.envelope)
    expect(() =>
      applyReasoningObservationBatch(codec, {
        observations: [
          {
            ...carrier,
            carrierKind: 'gemini-thought-signature',
            binding: {
              visibleKind: 'text',
              format: 'anthropic-claude-v1',
              source: {
                dialect: 'anthropic-messages',
                bridge: 'anthropic-direct',
                blockIndex: 0,
              },
              groupAliases: [{ kind: 'anthropic-block', blockIndex: 0 }],
              memberAliases: [{ kind: 'anthropic-member', blockIndex: 0, member: 'thinking' }],
            },
          },
        ],
      }),
    ).toThrow(/ReasoningObservationBindingKindInvalid/)
    expect(projectReasoningEnvelope(codec.envelope)).toEqual(before)

    expect(() =>
      applyReasoningObservationBatch(codec, {
        observations: [
          {
            ...carrier,
            binding: {
              visibleKind: 'text',
              format: 'anthropic-claude-v1',
              source: {
                dialect: 'anthropic-messages',
                bridge: 'anthropic-direct',
                blockIndex: 1,
              },
              groupAliases: [{ kind: 'anthropic-block', blockIndex: 1 }],
              memberAliases: [{ kind: 'anthropic-member', blockIndex: 1, member: 'thinking' }],
            },
          },
        ],
      }),
    ).toThrow(/ReasoningCarrierVisibleBindingInvalid/)
    expect(projectReasoningEnvelope(codec.envelope)).toEqual(before)
  })
})

describe('outbound reasoning compiler', () => {
  it('accepts equivalent route contracts and rejects same-kind semantic reuse', () => {
    const message = assistantWithReasoning(responsesEnvelope('route', 'summary'))
    const contract = responsesReasoningContract({
      include: { encrypted: true, summary: true, text: false },
    })
    const resolver = createOutboundReasoningCompiler({ kind: 'responses', contract }).retain([
      message,
    ])

    expect(() =>
      resolveOutboundReasoningResolver(
        { kind: 'responses', contract: { ...contract, include: { ...contract.include } } },
        resolver,
      ),
    ).not.toThrow()
    expect(() =>
      resolveOutboundReasoningResolver(
        {
          kind: 'responses',
          contract: { ...contract, include: { ...contract.include, encrypted: false } },
        },
        resolver,
      ),
    ).toThrow(/OutboundReasoningRouteMismatch/)
  })

  it('treats Claude text and its signature as one atomic replay unit', () => {
    const envelope = {
      schemaVersion: 2,
      visible: [
        {
          id: 'visible:claude',
          groupId: 'group:claude',
          kind: 'text',
          text: 'visible thought',
          format: 'anthropic-claude-v1',
          source: anthropicSource,
        },
      ],
      carriers: [
        {
          id: 'carrier:claude',
          groupId: 'group:claude',
          kind: 'anthropic-signature',
          signature: 'opaque-signature',
          bindsVisiblePartId: 'visible:claude',
          format: 'anthropic-claude-v1',
          source: anthropicSource,
        },
      ],
    } as const satisfies ReasoningEnvelopeV2
    const view = createAppliedMessageView(assistantWithReasoning(envelope))

    expect(
      compileAppliedMessageReasoning(view, {
        kind: 'anthropic',
        contract: anthropicReasoningContract({
          include: { encrypted: true, summary: false, text: false },
        }),
      }).attempts,
    ).toEqual([
      {
        owner: { kind: 'generation' },
        units: [
          {
            kind: 'thinking-authenticated',
            text: 'visible thought',
            signature: 'opaque-signature',
          },
        ],
      },
    ])
    expect(
      compileAppliedMessageReasoning(view, {
        kind: 'anthropic',
        contract: anthropicReasoningContract({
          include: { encrypted: false, summary: false, text: true },
        }),
      }),
    ).toMatchObject({ attempts: [], inline: null, reasoningCarryForward: 'none' })
  })

  it('omits every conflicting Claude signature without leaking unsigned bound text', () => {
    const source = { ...anthropicSource, itemId: 'conflict' }
    const envelope = {
      schemaVersion: 2,
      visible: [
        {
          id: 'visible:conflict',
          groupId: 'group:conflict',
          kind: 'text',
          text: 'must stay atomic',
          format: 'anthropic-claude-v1',
          source,
        },
      ],
      carriers: ['first', 'second'].map((signature, index) => ({
        id: `carrier:conflict:${index}`,
        groupId: 'group:conflict',
        kind: 'anthropic-signature' as const,
        signature,
        bindsVisiblePartId: 'visible:conflict',
        format: 'anthropic-claude-v1' as const,
        source,
      })),
    } satisfies ReasoningEnvelopeV2
    const compiled = compileAppliedMessageReasoning(
      createAppliedMessageView(assistantWithReasoning(envelope)),
      {
        kind: 'anthropic',
        contract: anthropicReasoningContract({
          include: { encrypted: true, summary: false, text: true },
        }),
      },
    )

    expect(compiled.attempts).toEqual([])
    expect(compiled.inline).toBeNull()
    expect(messageContextRouteFacts({ content: [], reasoningEnvelope: envelope })).toEqual({
      reasoningCarriers: [],
      hasOpenAiResponsesProviderOutput: false,
    })
    expect(compiled.reasoningCarryForward).toBe('none')
  })

  it('omits conflicting Responses carriers from both route facts and wire compilation', () => {
    const source = {
      dialect: 'openrouter-responses',
      bridge: 'openrouter',
      itemId: 'reasoning-conflict',
      outputIndex: 0,
    } as const
    const envelope = {
      schemaVersion: 2,
      visible: [],
      carriers: ['first', 'second'].map((data, index) => ({
        id: `carrier:responses-conflict:${index}`,
        groupId: 'group:responses-conflict',
        kind: 'responses-encrypted' as const,
        data,
        format: 'openai-responses-v1' as const,
        source,
      })),
    } satisfies ReasoningEnvelopeV2
    const compiled = compileAppliedMessageReasoning(
      createAppliedMessageView(assistantWithReasoning(envelope)),
      {
        kind: 'responses',
        contract: responsesReasoningContract({
          include: { encrypted: true, summary: false, text: false },
        }),
      },
    )

    expect(messageContextRouteFacts({ content: [], reasoningEnvelope: envelope })).toEqual({
      reasoningCarriers: [],
      hasOpenAiResponsesProviderOutput: false,
    })
    expect(compiled.attempts).toEqual([])
    expect(compiled.reasoningCarryForward).toBe('none')
  })

  it('keeps Gemini bound-thought visibility and carrier replay independently selectable', () => {
    const source = {
      dialect: 'gemini-native',
      bridge: 'google-direct',
      itemId: 'thought-0',
      candidateIndex: 0,
      partIndex: 0,
    } as const
    const envelope = {
      schemaVersion: 2,
      visible: [
        {
          id: 'visible:gemini',
          groupId: 'group:gemini',
          kind: 'summary',
          text: 'visible summary',
          format: 'google-gemini-v1',
          source,
        },
      ],
      carriers: [
        {
          id: 'carrier:gemini',
          groupId: 'group:gemini',
          kind: 'gemini-thought-signature',
          data: 'thought-signature',
          bindsVisiblePartId: 'visible:gemini',
          format: 'google-gemini-v1',
          source,
        },
      ],
    } as const satisfies ReasoningEnvelopeV2
    const view = createAppliedMessageView(assistantWithReasoning(envelope))

    expect(
      compileAppliedMessageReasoning(view, {
        kind: 'gemini',
        contract: geminiReasoningContract({
          include: { encrypted: true, summary: false, text: false },
        }),
      }).attempts[0]?.units,
    ).toEqual([{ kind: 'bound-thought', text: 'visible summary', signature: 'thought-signature' }])
    expect(
      compileAppliedMessageReasoning(view, {
        kind: 'gemini',
        contract: geminiReasoningContract({
          include: { encrypted: false, summary: true, text: false },
        }),
      }).attempts[0]?.units,
    ).toEqual([{ kind: 'visible-thought', text: 'visible summary' }])
  })

  it('never merges Responses reasoning groups across applied attempts', () => {
    const message = assistantWithReasoning(responsesEnvelope('root', 'root-summary'))
    message.continuationAttempts = [
      continuationWithReasoning('applied', responsesEnvelope('continued', 'continued-summary')),
      {
        ...continuationWithReasoning('unapplied', responsesEnvelope('ignored', 'ignored-summary')),
        application: { kind: 'unapplied', reason: 'base-version-changed' },
      },
    ]
    const compiled = compileAppliedMessageReasoning(createAppliedMessageView(message), {
      kind: 'responses',
      contract: responsesReasoningContract({
        include: { encrypted: true, summary: true, text: false },
      }),
    })

    expect(compiled.attempts).toEqual([
      {
        owner: { kind: 'generation' },
        units: [
          {
            providerItemId: 'shared-provider-item',
            encryptedContent: 'root',
            summaries: [{ index: 0, text: 'root-summary' }],
          },
        ],
      },
      {
        owner: { kind: 'continuation', streamId: 'applied' },
        units: [
          {
            providerItemId: 'shared-provider-item',
            encryptedContent: 'continued',
            summaries: [{ index: 0, text: 'continued-summary' }],
          },
        ],
      },
    ])
  })

  it('compiles 4,096 applied attempts in exact order without cross-attempt regrouping', () => {
    const message = assistantWithReasoning(undefined)
    message.continuationAttempts = Array.from({ length: 4_096 }, (_, index) =>
      continuationWithReasoning(
        `stream-${index}`,
        responsesEnvelope(undefined, `summary-${index}`),
      ),
    )
    const compiled = compileAppliedMessageReasoning(createAppliedMessageView(message), {
      kind: 'responses',
      contract: responsesReasoningContract({
        include: { encrypted: false, summary: true, text: false },
      }),
    })

    expect(compiled.attempts).toHaveLength(4_096)
    expect(compiled.attempts[0]).toMatchObject({
      owner: { kind: 'continuation', streamId: 'stream-0' },
      units: [{ summaries: [{ text: 'summary-0' }] }],
    })
    expect(compiled.attempts[4_095]).toMatchObject({
      owner: { kind: 'continuation', streamId: 'stream-4095' },
      units: [{ summaries: [{ text: 'summary-4095' }] }],
    })
  })
})

function assistantWithReasoning(reasoningEnvelope: ReasoningEnvelopeV2 | undefined): Message {
  return {
    id: 'assistant-compiler',
    chatId: 'chat',
    parentId: null,
    siblingIndex: 0,
    turnId: 'turn',
    turnIndex: 0,
    createdAt: 1,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'output_text', text: 'answer' }],
    ...(reasoningEnvelope ? { reasoningEnvelope } : {}),
    nodeVersion: 0,
    deleted: false,
  }
}

function continuationWithReasoning(streamId: string, reasoningEnvelope: ReasoningEnvelopeV2) {
  return {
    streamId,
    strategy: 'prompt' as const,
    status: 'done' as const,
    startedAt: 2,
    finishedAt: 3,
    application: { kind: 'applied' as const },
    reasoningEnvelope,
    reasoningCarryForward: 'carrier' as const,
    reasoningVisibility: { disclosure: 'visible' as const, visibleKind: 'summary' as const },
  }
}

function responsesEnvelope(
  encryptedContent: string | undefined,
  summary: string,
): ReasoningEnvelopeV2 {
  const source = {
    dialect: 'openai-responses',
    bridge: 'openai-direct',
    itemId: 'shared-provider-item',
    outputIndex: 0,
  } as const
  return {
    schemaVersion: 2,
    visible: [
      {
        id: `visible:${summary}`,
        groupId: 'group:responses',
        kind: 'summary',
        text: summary,
        format: 'openai-responses-v1',
        source: { ...source, summaryIndex: 0 },
      },
    ],
    carriers:
      encryptedContent === undefined
        ? []
        : [
            {
              id: `carrier:${encryptedContent}`,
              groupId: 'group:responses',
              kind: 'responses-encrypted',
              data: encryptedContent,
              format: 'openai-responses-v1',
              source,
            },
          ],
  }
}
