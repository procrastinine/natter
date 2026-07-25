import { decodeProviderReasoningDetails } from '../../src/api/provider-json-boundary'
import type { AssistantAttemptContract } from '../../src/core/api-choice'
import { createAppliedMessageView } from '../../src/core/continuation-content'
import type { PrefillPlan } from '../../src/core/effective-endpoint-routing'
import { compileAppliedMessageReasoning } from '../../src/core/outbound-reasoning'
import {
  ANTHROPIC_PROVIDER_OUTPUT_CONTRACT,
  GOOGLE_PROVIDER_OUTPUT_CONTRACT,
  OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
  TEXT_PROVIDER_OUTPUT_CONTRACT,
} from '../../src/core/provider-tool-context'
import type {
  AttemptAnthropicReasoningContract,
  AttemptChatReasoningContract,
  AttemptGeminiReasoningContract,
  AttemptResponsesReasoningContract,
  AttemptTextReasoningContract,
} from '../../src/core/reasoning'
import { reasoningPolicyForSettings } from '../../src/core/reasoning'
import type {
  ChatSettings,
  Message,
  ReasoningDetail,
  ReasoningFormat,
  ReasoningInclude,
} from '../../src/core/types'
import { reasoningEnvelopeFromDetailsForTest } from './reasoning-events'

interface ReasoningPolicyOverrides {
  include?: Partial<ReasoningInclude>
  echoAsThinkTags?: boolean
  acceptsAnthropicRedactedThinking?: boolean
}

export function compileChatReasoningDetailsForTest(
  details: readonly unknown[],
  include: ReasoningInclude,
  targetFormat: ReasoningFormat | undefined,
  options: { acceptsAnthropicRedactedThinking?: boolean } = {},
): ReasoningDetail[] {
  const routeFormat = targetFormat === undefined || targetFormat === 'unknown' ? null : targetFormat
  const decoded = decodeProviderReasoningDetails(details, routeFormat)
  const message: Message = {
    id: 'reasoning-contract-fixture',
    chatId: 'chat',
    parentId: null,
    siblingIndex: 0,
    turnId: 'turn',
    turnIndex: 0,
    createdAt: 1,
    role: 'assistant',
    origin: 'generated',
    content: [],
    reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(decoded.details, 'openrouter-chat'),
    nodeVersion: 0,
    deleted: false,
  }
  const compiled = compileAppliedMessageReasoning(createAppliedMessageView(message), {
    kind: 'chat',
    contract: chatReasoningContract({
      include,
      targetFormat: routeFormat,
      carrier: 'openrouter-reasoning-details',
      ...options,
    }),
  })
  return compiled.attempts.flatMap((attempt) => attempt.units)
}

function policy(overrides: ReasoningPolicyOverrides) {
  return {
    include: {
      encrypted: overrides.include?.encrypted ?? true,
      summary: overrides.include?.summary ?? false,
      text: overrides.include?.text ?? false,
    },
    echoAsThinkTags: overrides.echoAsThinkTags ?? false,
    acceptsAnthropicRedactedThinking: overrides.acceptsAnthropicRedactedThinking ?? false,
  }
}

function attemptIdentity(
  originDialect:
    | AttemptChatReasoningContract['originDialect']
    | AttemptResponsesReasoningContract['originDialect']
    | AttemptAnthropicReasoningContract['originDialect']
    | AttemptGeminiReasoningContract['originDialect']
    | AttemptTextReasoningContract['originDialect'],
) {
  if (originDialect === 'openrouter-chat' || originDialect === 'openrouter-responses') {
    const visibleKind = originDialect === 'openrouter-responses' ? 'summary' : 'text'
    return attemptIdentityFields('openrouter', visibleKind)
  }
  if (originDialect === 'openai-chat' || originDialect === 'openai-responses') {
    const visibleKind = originDialect === 'openai-responses' ? 'summary' : 'text'
    return attemptIdentityFields('openai-direct', visibleKind)
  }
  if (originDialect === 'anthropic-messages') {
    return attemptIdentityFields('anthropic-direct', 'text')
  }
  if (originDialect === 'gemini-native') {
    return attemptIdentityFields('google-direct', 'summary')
  }
  return attemptIdentityFields('inline', 'text')
}

function attemptIdentityFields(
  producerBridge: 'openrouter' | 'openai-direct' | 'anthropic-direct' | 'google-direct' | 'inline',
  visibleKind: 'text' | 'summary',
) {
  return {
    producerBridge,
    visibilityPolicy: { kind: 'uniform' as const, visibleKind },
    inboundVisibility: { disclosure: 'visible' as const, visibleKind },
  }
}

export function chatReasoningContract(
  overrides: ReasoningPolicyOverrides &
    Partial<Pick<AttemptChatReasoningContract, 'carrier' | 'originDialect' | 'targetFormat'>> = {},
): AttemptChatReasoningContract {
  const carrier = overrides.carrier ?? 'plaintext-only'
  const originDialect =
    overrides.originDialect ??
    (carrier === 'openrouter-reasoning-details' ? 'openrouter-chat' : 'openai-chat')
  if (carrier === 'openrouter-reasoning-details') {
    if (originDialect !== 'openrouter-chat') throw new Error('ChatReasoningContractMismatch')
    return {
      ...policy(overrides),
      targetFormat: overrides.targetFormat ?? null,
      carrier,
      originDialect,
      ...attemptIdentity(originDialect),
    }
  }
  if (originDialect !== 'openai-chat') throw new Error('ChatReasoningContractMismatch')
  return {
    ...policy(overrides),
    targetFormat: overrides.targetFormat ?? null,
    carrier,
    originDialect,
    ...attemptIdentity(originDialect),
  }
}

export function responsesReasoningContract(
  overrides: ReasoningPolicyOverrides &
    Partial<Pick<AttemptResponsesReasoningContract, 'targetFormat'>> = {},
): AttemptResponsesReasoningContract & { readonly originDialect: 'openai-responses' } {
  return {
    ...policy(overrides),
    targetFormat: overrides.targetFormat ?? 'openai-responses-v1',
    carrier: 'responses-items',
    originDialect: 'openai-responses',
    ...attemptIdentity('openai-responses'),
  }
}

export function anthropicReasoningContract(
  overrides: ReasoningPolicyOverrides = {},
): AttemptAnthropicReasoningContract {
  return {
    ...policy(overrides),
    targetFormat: 'anthropic-claude-v1',
    carrier: 'anthropic-blocks',
    originDialect: 'anthropic-messages',
    ...attemptIdentity('anthropic-messages'),
  }
}

export function geminiReasoningContract(
  overrides: ReasoningPolicyOverrides = {},
): AttemptGeminiReasoningContract {
  return {
    ...policy(overrides),
    targetFormat: 'google-gemini-v1',
    carrier: 'gemini-parts',
    originDialect: 'gemini-native',
    ...attemptIdentity('gemini-native'),
  }
}

export function textReasoningContract(
  overrides: ReasoningPolicyOverrides = {},
): AttemptTextReasoningContract {
  return {
    ...policy(overrides),
    targetFormat: null,
    carrier: 'plaintext-only',
    originDialect: 'inline',
    ...attemptIdentity('inline'),
  }
}

export function chatRouteContract(
  overrides: Parameters<typeof chatReasoningContract>[0] = {},
): Extract<AssistantAttemptContract, { transport: 'openai-chat' }> {
  const reasoning = chatReasoningContract(overrides)
  if (reasoning.carrier === 'plaintext-only') {
    return {
      kind: 'chat-completions',
      transport: 'openai-chat',
      reason: 'test chat route',
      reasoning,
      providerOutput: TEXT_PROVIDER_OUTPUT_CONTRACT,
    }
  }
  return {
    kind: 'chat-completions',
    transport: 'openai-chat',
    reason: 'test chat route',
    reasoning,
    providerOutput: TEXT_PROVIDER_OUTPUT_CONTRACT,
  }
}

export function responsesRouteContract(
  overrides: Parameters<typeof responsesReasoningContract>[0] = {},
): Extract<
  AssistantAttemptContract,
  { transport: 'openai-responses'; reasoning: { originDialect: 'openai-responses' } }
> {
  return {
    kind: 'responses',
    transport: 'openai-responses',
    reason: 'test Responses route',
    reasoning: responsesReasoningContract(overrides),
    providerOutput: OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
  }
}

export function geminiRouteContract(
  overrides: Parameters<typeof geminiReasoningContract>[0] = {},
): Extract<AssistantAttemptContract, { transport: 'gemini-native' }> {
  return {
    kind: 'gemini-generate',
    transport: 'gemini-native',
    reason: 'test Gemini route',
    reasoning: geminiReasoningContract(overrides),
    providerOutput: GOOGLE_PROVIDER_OUTPUT_CONTRACT,
  }
}

export function anthropicRouteContract(
  overrides: Parameters<typeof anthropicReasoningContract>[0] = {},
): Extract<AssistantAttemptContract, { transport: 'anthropic' }> {
  return {
    kind: 'anthropic-messages',
    transport: 'anthropic',
    reason: 'test Anthropic route',
    reasoning: anthropicReasoningContract(overrides),
    providerOutput: ANTHROPIC_PROVIDER_OUTPUT_CONTRACT,
  }
}

export function textRouteContract(
  overrides: Parameters<typeof textReasoningContract>[0] = {},
): Extract<AssistantAttemptContract, { transport: 'openai-text' }> {
  return {
    kind: 'text-completions',
    transport: 'openai-text',
    reason: 'test text route',
    reasoning: textReasoningContract(overrides),
    providerOutput: TEXT_PROVIDER_OUTPUT_CONTRACT,
  }
}

export function videoRouteContract(
  overrides: Parameters<typeof textReasoningContract>[0] = {},
): Extract<AssistantAttemptContract, { transport: 'openrouter-video' }> {
  return {
    kind: 'video-generation',
    transport: 'openrouter-video',
    reason: 'test video route',
    reasoning: textReasoningContract(overrides),
    providerOutput: TEXT_PROVIDER_OUTPUT_CONTRACT,
  }
}

export function chatReasoningContractForSettings(
  settings: Pick<ChatSettings, 'reasoning'>,
  overrides: Partial<Pick<AttemptChatReasoningContract, 'carrier' | 'targetFormat'>> &
    Pick<ReasoningPolicyOverrides, 'acceptsAnthropicRedactedThinking'> = {},
): AttemptChatReasoningContract {
  const carrier = overrides.carrier ?? 'openrouter-reasoning-details'
  if (carrier === 'plaintext-only') {
    return {
      ...reasoningPolicyForSettings(settings, overrides),
      targetFormat: overrides.targetFormat ?? null,
      carrier,
      originDialect: 'openai-chat',
      ...attemptIdentity('openai-chat'),
    }
  }
  return {
    ...reasoningPolicyForSettings(settings, overrides),
    targetFormat: overrides.targetFormat ?? null,
    carrier,
    originDialect: 'openrouter-chat',
    ...attemptIdentity('openrouter-chat'),
  }
}

export function responsesReasoningContractForSettings(
  settings: Pick<ChatSettings, 'reasoning'>,
  targetFormat: AttemptResponsesReasoningContract['targetFormat'] = 'openai-responses-v1',
): AttemptResponsesReasoningContract & { readonly originDialect: 'openai-responses' } {
  return {
    ...reasoningPolicyForSettings(settings),
    targetFormat,
    carrier: 'responses-items',
    originDialect: 'openai-responses',
    ...attemptIdentity('openai-responses'),
  }
}

export const TEST_ASSISTANT_TAIL_PREFILL_PLAN: PrefillPlan = Object.freeze({
  availability: 'supported',
  continueStrategy: 'prefill',
  request: 'send-once',
  semanticRetry: 'never',
  serialization: Object.freeze({ kind: 'assistant-tail' as const, marker: 'none' as const }),
  basis: 'transport',
})

export const TEST_NATIVE_MODEL_TAIL_PREFILL_PLAN: PrefillPlan = Object.freeze({
  availability: 'supported',
  continueStrategy: 'prefill',
  request: 'send-once',
  semanticRetry: 'never',
  serialization: Object.freeze({ kind: 'native-model-tail' as const }),
  basis: 'transport',
})

export const TEST_TEXT_PREFIX_PREFILL_PLAN: PrefillPlan = Object.freeze({
  availability: 'supported',
  continueStrategy: 'prefill',
  request: 'send-once',
  semanticRetry: 'never',
  serialization: Object.freeze({ kind: 'text-prefix' as const }),
  basis: 'transport',
})

export const TEST_UNSUPPORTED_PREFILL_PLAN: PrefillPlan = Object.freeze({
  availability: 'unsupported',
  continueStrategy: 'prompt',
  request: 'reject',
  semanticRetry: 'never',
  serialization: Object.freeze({ kind: 'unsupported' as const }),
  basis: 'transport',
  reason: 'The selected test route does not support assistant prefill.',
})

export function anthropicReasoningContractForSettings(
  settings: Pick<ChatSettings, 'reasoning'>,
  acceptsAnthropicRedactedThinking = false,
): AttemptAnthropicReasoningContract {
  return {
    ...reasoningPolicyForSettings(settings, { acceptsAnthropicRedactedThinking }),
    targetFormat: 'anthropic-claude-v1',
    carrier: 'anthropic-blocks',
    originDialect: 'anthropic-messages',
    ...attemptIdentity('anthropic-messages'),
  }
}

export function geminiReasoningContractForSettings(
  settings: Pick<ChatSettings, 'reasoning'>,
): AttemptGeminiReasoningContract {
  return {
    ...reasoningPolicyForSettings(settings),
    targetFormat: 'google-gemini-v1',
    carrier: 'gemini-parts',
    originDialect: 'gemini-native',
    ...attemptIdentity('gemini-native'),
  }
}

export function textReasoningContractForSettings(
  settings: Pick<ChatSettings, 'reasoning'>,
): AttemptTextReasoningContract {
  return {
    ...reasoningPolicyForSettings(settings),
    targetFormat: null,
    carrier: 'plaintext-only',
    originDialect: 'inline',
    ...attemptIdentity('inline'),
  }
}
