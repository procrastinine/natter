import type {
  CanonicalStreamEventV1,
  OpaqueReasoningCarrierV1,
  ReasoningEnvelopeMutationV1,
  ReasoningFormatV1,
  ReasoningSourceRefV1,
  ReasoningVisiblePartV1,
} from './generation-stream-events-v1'
import {
  type OpaqueReasoningCarrierV92,
  type ReasoningAttemptV92Context,
  type ReasoningProducerBridgeV92,
  type ReasoningSourceRefV92,
  type ReasoningVisiblePartV92,
  upgradeReasoningEnvelopeV1ToV2Frozen,
} from './reasoning-contract-normalizer-v92'

type StoredRecord = Record<string, unknown>

type ReasoningBridgeContext = ReasoningAttemptV92Context

export function upgradeReasoningEnvelopeV1ToV2(
  value: unknown,
  context: ReasoningBridgeContext = {},
): unknown {
  if (record(value)?.schemaVersion === 2) return value
  return upgradeReasoningEnvelopeV1ToV2Frozen(value, context)
}

export function upgradeCanonicalStreamEventV1ToV2(
  event: CanonicalStreamEventV1,
  context: ReasoningBridgeContext = {},
): unknown {
  if (event.lane === 'reasoning') {
    return {
      ...event,
      mutations: event.mutations.map((mutation) => upcastMutation(mutation, context)),
    }
  }
  if (event.lane === 'result-snapshot' && event.payload.kind === 'replace') {
    return {
      ...event,
      payload: {
        ...event.payload,
        reasoningEnvelope: upgradeReasoningEnvelopeV1ToV2(
          event.payload.reasoningEnvelope,
          context,
        ) ?? { schemaVersion: 2, visible: [], carriers: [] },
      },
    }
  }
  return event
}

function upcastVisiblePart(
  part: ReasoningVisiblePartV1,
  context: ReasoningBridgeContext,
): ReasoningVisiblePartV92 {
  return { ...part, source: upcastSource(part.source, part.format, context) }
}

function upcastCarrier(
  carrier: OpaqueReasoningCarrierV1,
  context: ReasoningBridgeContext,
): OpaqueReasoningCarrierV92 {
  return {
    ...carrier,
    source: upcastSource(carrier.source, carrier.format, context),
  }
}

function upcastMutation(
  mutation: ReasoningEnvelopeMutationV1,
  context: ReasoningBridgeContext,
): unknown {
  if (mutation.kind === 'replace') {
    return {
      kind: 'replace',
      envelope: upgradeReasoningEnvelopeV1ToV2(mutation.envelope, context) ?? {
        schemaVersion: 2,
        visible: [],
        carriers: [],
      },
    }
  }
  if (mutation.kind === 'visible-set') {
    return { kind: 'visible-set', part: upcastVisiblePart(mutation.part, context) }
  }
  if (mutation.kind === 'visible-append') {
    return {
      kind: 'visible-append',
      part: {
        ...mutation.part,
        source: upcastSource(mutation.part.source, mutation.part.format, context),
      },
      delta: mutation.delta,
    }
  }
  if (mutation.kind === 'carrier-set') {
    return { kind: 'carrier-set', carrier: upcastCarrier(mutation.carrier, context) }
  }
  return {
    kind: 'carrier-append',
    carrier: {
      ...mutation.carrier,
      source: upcastSource(mutation.carrier.source, mutation.carrier.format, context),
    },
    delta: mutation.delta,
  }
}

function upcastSource(
  source: ReasoningSourceRefV1,
  format: ReasoningFormatV1,
  context: ReasoningBridgeContext,
): ReasoningSourceRefV92 {
  return { ...source, bridge: reasoningProducerBridge(source, format, context) }
}

function reasoningProducerBridge(
  source: ReasoningSourceRefV1,
  format: ReasoningFormatV1,
  context: ReasoningBridgeContext,
): ReasoningProducerBridgeV92 {
  if (source.dialect === 'inline') return 'inline'
  if (source.dialect === 'openrouter-chat' || source.dialect === 'openrouter-responses') {
    return 'openrouter'
  }
  if (source.dialect === 'anthropic-messages') return 'anthropic-direct'
  if (source.dialect === 'gemini-native') return 'google-direct'
  if (format === 'azure-openai-responses-v1') return 'azure-openai'
  if (source.dialect === 'openai-responses' || source.dialect === 'openai-chat') {
    if (isOfficialOpenAiProfile(context.profile)) return 'openai-direct'
    return context.profile ? 'custom' : 'unknown'
  }
  if (context.profile?.kind === 'openrouter') return 'openrouter'
  if (context.apiUsed === 'gemini-native') return 'google-direct'
  if (context.apiUsed === 'anthropic-messages') return 'anthropic-direct'
  if (context.apiUsed === 'completion') return 'inline'
  return context.profile ? 'custom' : 'unknown'
}

function isOfficialOpenAiProfile(profile: ReasoningBridgeContext['profile']): boolean {
  if (profile?.kind !== 'openai-compatible' || typeof profile.baseUrl !== 'string') {
    return false
  }
  try {
    return new URL(profile.baseUrl).hostname === 'api.openai.com'
  } catch {
    return false
  }
}

function record(value: unknown): StoredRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as StoredRecord)
    : undefined
}
