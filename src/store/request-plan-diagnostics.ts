import { createAppliedMessageView } from '../core/continuation-content'
import { providerDisplayName, providerRoutingRef } from '../core/provider-identity'
import type { ChatSettings, ConnectionProfile } from '../core/types'
import {
  logRequestPlanDebug,
  logStreamDebug,
  requestPlanDebugEnabled,
  streamDebugEnabled,
} from '../lib/debug-streams'
import type { MessagePresentation } from './message-storage'
import type { AssistantRequestPlan } from './request-planning'
import type { ResolvePrivacyForSendResult } from './request-privacy-planning'

interface RequestPrivacyPlanDiagnostic {
  neededTokens?: number
  privacy: ResolvePrivacyForSendResult
}

export function logPreparedAssistantRequestPlan(
  source: string,
  chatId: string,
  connection: ConnectionProfile,
  inputMessageCount: number,
  requestPlan: AssistantRequestPlan,
  privacyPlan: RequestPrivacyPlanDiagnostic,
  diagnosticId?: string,
): void {
  if (!requestPlanDebugEnabled()) return
  logRequestPlanDebug('prepared', {
    source,
    ...(diagnosticId ? { diagnosticId } : {}),
    chatId,
    profile: {
      id: connection.id,
      name: connection.name,
      kind: connection.kind,
      baseUrl: connection.baseUrl,
    },
    model: {
      settings: requestPlan.settings.model,
      requested: requestPlan.requestedModel,
      wire: typeof requestPlan.wire.model === 'string' ? requestPlan.wire.model : undefined,
    },
    route: {
      kind: requestPlan.kind,
      transport: requestPlan.transport,
      reason: requestPlan.reason,
    },
    effectiveEndpointRouting: {
      selected: summarizeSelectedEndpoints(requestPlan.effectiveRouting.selectedEndpoints),
      availability: requestPlan.effectiveRouting.endpointAvailability,
      providerWire: requestPlan.effectiveRouting.providerWire,
      prefill: {
        availability: requestPlan.prefillPlan.availability,
        basis: requestPlan.prefillPlan.basis,
        serialization: requestPlan.prefillPlan.serialization,
        semanticRetry: requestPlan.prefillPlan.semanticRetry,
      },
    },
    reasoningCarryForward: requestPlan.reasoningCarryForwardEvidence,
    tokens: {
      needed: privacyPlan.neededTokens,
      inputMessages: inputMessageCount,
      outboundMessages: requestPlan.outboundPath.length,
      removedByContext: Math.max(0, inputMessageCount - requestPlan.outboundPath.length),
      customMaxContext: requestPlan.settings.customMaxContext,
      maxCompletionTokens: requestPlan.settings.maxCompletionTokens,
    },
    provider: {
      prefs: summarizeProviderPrefs(requestPlan.settings.providerPrefs),
      wire: summarizeWireProvider(requestPlan.wire.provider),
      contextIgnored: privacyPlan.privacy.contextIgnoredProviders,
      privacy: summarizePrivacy(privacyPlan.privacy),
    },
    request: requestPlan.wire,
    wireShape: summarizeWireShape(requestPlan.wire),
  })
}

export function logCanonicalGenerationFinalized(
  streamId: string,
  outcome: string,
  canonicalOutcome: string,
  presentation: MessagePresentation | undefined,
): void {
  if (!streamDebugEnabled()) return
  logStreamDebug(streamId, 'message.finalize', {
    messageId: presentation?.header.id,
    outcome,
    canonicalOutcome,
    reasoningAttempts: presentation
      ? createAppliedMessageView(presentation.message).attempts.map((attempt) => ({
          owner: attempt.owner,
          visibility: attempt.reasoningVisibility,
          reasoningEnvelope: attempt.reasoningEnvelope,
        }))
      : [],
    content: presentation?.message.content ?? [],
    generation: presentation?.message.generation,
  })
}

function summarizeSelectedEndpoints(
  endpoints: AssistantRequestPlan['effectiveRouting']['selectedEndpoints'],
): unknown {
  const limit = 64
  return {
    count: endpoints.length,
    rows: endpoints.slice(0, limit).map((endpoint) => ({
      provider: providerDisplayName(endpoint),
      ref: providerRoutingRef(endpoint),
    })),
    truncated: endpoints.length > limit,
  }
}

function summarizeProviderPrefs(prefs: ChatSettings['providerPrefs']): unknown {
  if (!prefs) return null
  return {
    sort: prefs.sort,
    only: prefs.only,
    ignore: prefs.ignore,
    order: prefs.order,
    ignoreOverridesFilter: prefs.ignoreOverridesFilter,
    requireParameters: prefs.requireParameters,
  }
}

function summarizeWireProvider(provider: unknown): unknown {
  if (!provider || typeof provider !== 'object') return null
  const value = provider as Record<string, unknown>
  return {
    allow_fallbacks: value.allow_fallbacks,
    data_collection: value.data_collection,
    zdr: value.zdr,
    sort: value.sort,
    only: value.only,
    ignore: value.ignore,
    order: value.order,
    require_parameters: value.require_parameters,
  }
}

function summarizePrivacy(privacy: ResolvePrivacyForSendResult): unknown {
  const filter = privacy.filter
  return {
    applicable: privacy.applicable,
    zeroEligible: filter?.zeroEligible ?? false,
    kept:
      filter?.kept.map((row) => ({
        provider: providerDisplayName(row.endpoint),
        ref: providerRoutingRef(row.endpoint),
      })) ?? [],
    excluded:
      filter?.excluded.map((row) => ({
        provider: providerDisplayName(row.endpoint),
        ref: providerRoutingRef(row.endpoint),
        reasons: row.reasons,
      })) ?? [],
  }
}

function summarizeWireShape(wire: Record<string, unknown>): unknown {
  const prompt = textPreview(wire.prompt)
  const instructions = textPreview(wire.instructions)
  return {
    hasProvider: wire.provider !== undefined,
    hasMessages: Array.isArray(wire.messages),
    messages: Array.isArray(wire.messages) ? wire.messages.length : undefined,
    hasInput: Array.isArray(wire.input),
    input: Array.isArray(wire.input) ? wire.input.length : undefined,
    hasPrompt: typeof wire.prompt === 'string',
    ...(prompt ? { prompt } : {}),
    hasInstructions: typeof wire.instructions === 'string',
    ...(instructions ? { instructions } : {}),
    hasSystemInstruction: wire.systemInstruction !== undefined,
    stream: wire.stream,
  }
}

function textPreview(value: unknown): { length: number; preview: string } | undefined {
  if (typeof value !== 'string') return undefined
  const limit = 240
  if (value.length <= limit) return { length: value.length, preview: value }
  return {
    length: value.length,
    preview: `${value.slice(0, limit - 1)}…`,
  }
}
