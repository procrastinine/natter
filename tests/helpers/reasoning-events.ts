import { decodeProviderReasoningDetails } from '../../src/api/provider-json-boundary'
import type { CanonicalStreamEventV2 } from '../../src/core/generation-stream-events'
import type { StreamLaneEvent } from '../../src/core/generation-stream-live-events'
import { isReasoningFormat } from '../../src/core/reasoning'
import {
  projectReasoningEnvelope,
  projectReasoningEnvelopeLive,
} from '../../src/core/reasoning-envelope'
import {
  applyReasoningObservationBatch,
  createReasoningObservationCodecState,
  type ReasoningObservation,
  reasoningObservationsFromDetails,
} from '../../src/core/reasoning-observation'
import {
  createStreamAccumulator,
  foldStreamAccumulatorEvent,
  projectStreamAccumulatorFinal,
} from '../../src/core/stream-accumulator'
import type {
  ContentItem,
  ReasoningDetail,
  ReasoningEnvelopeV2,
  ReasoningOriginDialect,
  ReasoningProducerBridge,
} from '../../src/core/types'

export function reasoningEnvelopeFromDetailsForTest(
  details: readonly unknown[],
  dialect: ReasoningOriginDialect,
): ReasoningEnvelopeV2 {
  const state = createReasoningObservationCodecState()
  const decoded = canonicalReasoningDetails(details, dialect)
  applyReasoningObservationBatch(state, {
    observations: reasoningObservationsFromDetails({
      details: decoded,
      mode: 'snapshot',
      dialect,
      bridge: bridgeForDialect(dialect),
      untypedVisibleKind: dialect === 'gemini-native' ? 'summary' : 'text',
    }),
  })
  return projectReasoningEnvelope(state.envelope)
}

export function liveReasoningFromDetailsForTest(
  details: readonly unknown[],
  dialect: ReasoningOriginDialect,
) {
  const state = createReasoningObservationCodecState()
  const decoded = canonicalReasoningDetails(details, dialect)
  applyReasoningObservationBatch(state, {
    observations: reasoningObservationsFromDetails({
      details: decoded,
      mode: 'snapshot',
      dialect,
      bridge: bridgeForDialect(dialect),
      untypedVisibleKind: dialect === 'gemini-native' ? 'summary' : 'text',
    }),
  })
  return projectReasoningEnvelopeLive(state.envelope)
}

export function collectReasoningObservations(
  events: readonly StreamLaneEvent[],
): ReasoningObservation[] {
  return events.flatMap((event) =>
    event.lane === 'reasoning-observation' ? [...event.batch.observations] : [],
  )
}

export function foldStreamLaneEvents(
  events: readonly StreamLaneEvent[],
  options: Readonly<{ initialContent?: ContentItem[]; now?: number }> = {},
) {
  const now = options.now ?? 0
  const accumulator = createStreamAccumulator({
    initialContent: options.initialContent ?? [],
    now,
  })
  const canonical: CanonicalStreamEventV2[] = []
  for (const [index, event] of events.entries()) {
    canonical.push(foldStreamAccumulatorEvent(accumulator, event, now + index + 1))
  }
  return {
    accumulator,
    canonical,
    final: projectStreamAccumulatorFinal(accumulator),
  }
}

function bridgeForDialect(dialect: ReasoningOriginDialect): ReasoningProducerBridge {
  if (dialect === 'inline') return 'inline'
  if (dialect === 'openrouter-chat' || dialect === 'openrouter-responses') return 'openrouter'
  if (dialect === 'openai-chat' || dialect === 'openai-responses') return 'openai-direct'
  if (dialect === 'anthropic-messages') return 'anthropic-direct'
  if (dialect === 'gemini-native') return 'google-direct'
  return 'unknown'
}

function targetFormatForDialect(
  dialect: ReasoningOriginDialect,
): Exclude<ReasoningDetail['format'], 'unknown'> | null {
  if (dialect === 'openai-responses' || dialect === 'openrouter-responses') {
    return 'openai-responses-v1'
  }
  if (dialect === 'anthropic-messages') return 'anthropic-claude-v1'
  if (dialect === 'gemini-native') return 'google-gemini-v1'
  return null
}

function canonicalReasoningDetails(
  details: readonly unknown[],
  dialect: ReasoningOriginDialect,
): readonly ReasoningDetail[] {
  if (
    details.every(
      (detail) =>
        detail !== null &&
        typeof detail === 'object' &&
        !Array.isArray(detail) &&
        isReasoningFormat((detail as { format?: unknown }).format),
    )
  ) {
    return details as readonly ReasoningDetail[]
  }
  return decodeProviderReasoningDetails(details, targetFormatForDialect(dialect)).details
}
