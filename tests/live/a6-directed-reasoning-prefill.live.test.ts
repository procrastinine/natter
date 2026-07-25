import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { splitAssistantStream } from '../../src/api/assistant-lanes'
import {
  type AssistantDispatchPlan,
  type AssistantStreamChunk,
  createAssistantDispatchPlan,
  openAssistantRequestStream,
} from '../../src/api/assistant-stream'
import { fetchEndpoints } from '../../src/api/models'
import { normalizeEndpointsResponse } from '../../src/api/providers'
import { toChatCompletions, toGeminiNative, toResponses } from '../../src/api/request-transforms'
import { sealAssistantAttemptContract } from '../../src/core/api-choice'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  type EffectiveEndpointRouting,
  resolveEffectiveEndpointRouting,
} from '../../src/core/effective-endpoint-routing'
import { ProviderEndpointIndex, providerRoutingRef } from '../../src/core/provider-identity'
import {
  contextRouteFactsFromMessages,
  EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
  resolveAttemptInboundReasoningVisibility,
} from '../../src/core/reasoning'
import {
  projectReasoningPresentation,
  reasoningCarrierPayloadLength,
} from '../../src/core/reasoning-envelope'
import type {
  CapabilityDescriptor,
  ChatSettings,
  ConnectionProfile,
  ContentItem,
  EndpointsDescriptor,
  Message,
  ModelEndpoint,
} from '../../src/core/types'
import { foldStreamLaneEvents } from '../helpers/reasoning-events'

const LIVE = process.env.LIVE === '1'
const MAX_GENERATION_CALLS = 8

type KeyName = 'openrouter' | 'openai' | 'google'

let keys: Record<KeyName, string>
let generationCalls = 0

function loadKeys(): Record<KeyName, string> {
  const raw = readFileSync(resolve(__dirname, '../../../keys.json'), 'utf8')
  const parsed = JSON.parse(raw) as Partial<Record<KeyName, string>>
  return {
    openrouter: requiredKey(parsed, 'openrouter'),
    openai: requiredKey(parsed, 'openai'),
    google: requiredKey(parsed, 'google'),
  }
}

function requiredKey(parsed: Partial<Record<KeyName, string>>, name: KeyName): string {
  const key = parsed[name]
  if (!key) throw new Error(`keys.json missing ${name}`)
  return key
}

function profile(kind: 'openrouter' | 'openai-compatible' | 'google'): ConnectionProfile {
  const baseUrl =
    kind === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : kind === 'google'
        ? 'https://generativelanguage.googleapis.com/v1beta'
        : 'https://api.openai.com/v1'
  return {
    id: `live-${kind}`,
    name: `Live ${kind}`,
    kind,
    baseUrl,
    apiKeyRef: `live-${kind}`,
    defaultHeaders: {},
    appTitle: 'natter-live-probe',
    appUrl: 'http://localhost',
    supportsEndpointsApi: kind === 'openrouter',
    supportsGenerationApi: kind === 'openrouter',
    supportsPrivacyScrape: kind === 'openrouter',
    createdAt: 0,
    updatedAt: 0,
  }
}

function settings(
  connection: ConnectionProfile,
  model: string,
  patch: Partial<ChatSettings> = {},
): ChatSettings {
  const current = cloneDefaultChatSettings()
  current.profileId = connection.id
  current.model = model
  return { ...current, ...patch }
}

function user(id: string, text: string, parentId: string | null = null): Message {
  return message(id, 'user', 'user', [{ type: 'text', text }], parentId)
}

function prefill(id: string, text: string, parentId: string): Message {
  return message(id, 'assistant', 'prefill', [{ type: 'text', text }], parentId)
}

function message(
  id: string,
  role: Message['role'],
  origin: Message['origin'],
  content: ContentItem[],
  parentId: string | null,
): Message {
  return {
    id,
    chatId: 'live-chat',
    parentId,
    siblingIndex: 0,
    turnId: `turn-${id}`,
    turnIndex: 0,
    createdAt: 1,
    role,
    origin,
    content,
    nodeVersion: 0,
    deleted: false,
  }
}

function assistantFromFinal(
  id: string,
  parentId: string,
  final: ReturnType<typeof foldStreamLaneEvents>['final'],
): Message {
  return {
    ...message(id, 'assistant', 'generated', final.content, parentId),
    ...(final.reasoningEnvelope ? { reasoningEnvelope: final.reasoningEnvelope } : {}),
    ...(final.providerOutputItems ? { providerOutputItems: final.providerOutputItems } : {}),
    ...(final.toolCalls ? { toolCalls: final.toolCalls } : {}),
    ...(final.phase !== undefined ? { phase: final.phase } : {}),
  }
}

async function openRouterRouting(
  connection: ConnectionProfile,
  chatSettings: ChatSettings,
  providerRefs?: readonly string[],
  path: readonly Message[] = [],
): Promise<Readonly<{ descriptor: EndpointsDescriptor; routing: EffectiveEndpointRouting }>> {
  const raw = await fetchEndpoints(
    { profile: connection, apiKey: keys.openrouter },
    chatSettings.model,
    { timeoutMs: 30_000 },
  )
  const descriptor = normalizeEndpointsResponse(raw)
  if (!descriptor) throw new Error(`LiveEndpointsInvalid:${chatSettings.model}`)
  const providerWire =
    providerRefs && providerRefs.length > 0
      ? {
          only: [...providerRefs],
          order: [...providerRefs],
          zeroEligible: false,
        }
      : undefined
  return {
    descriptor,
    routing: resolveEffectiveEndpointRouting({
      profile: connection,
      settings: chatSettings,
      contextFacts:
        path.length === 0 ? EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS : contextRouteFactsFromMessages(path),
      descriptor,
      ...(providerWire ? { providerWire } : {}),
    }),
  }
}

function directRouting(
  connection: ConnectionProfile,
  chatSettings: ChatSettings,
  capability: CapabilityDescriptor,
  path: readonly Message[] = [],
): EffectiveEndpointRouting {
  return resolveEffectiveEndpointRouting({
    profile: connection,
    settings: chatSettings,
    contextFacts:
      path.length === 0 ? EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS : contextRouteFactsFromMessages(path),
    capability,
  })
}

function chatPlan(
  routing: EffectiveEndpointRouting,
  chatSettings: ChatSettings,
  path: readonly Message[],
  stream = true,
): Readonly<{
  request: ReturnType<typeof toChatCompletions>
  plan: AssistantDispatchPlan
}> {
  if (routing.route.transport !== 'openai-chat') throw new Error('ExpectedChatRoute')
  const request = toChatCompletions(chatSettings, path, {
    ...(routing.requestCapability ? { capabilities: routing.requestCapability } : {}),
    prefillPlan: routing.prefillPlan,
    stream,
    ...(routing.providerWire ? { privacy: routing.providerWire } : {}),
    allowProviderRouting: true,
    reasoning: routing.route.reasoning,
    providerOutput: routing.route.providerOutput,
  })
  const attempt = sealAssistantAttemptContract(
    routing.route,
    resolveAttemptInboundReasoningVisibility(
      routing.route.reasoning.visibilityPolicy,
      request.reasoningVisibilityEvidence,
    ),
  )
  return {
    request,
    plan: createAssistantDispatchPlan({
      ...attempt,
      requestedModel: request.requestedModel,
      wire: { ...request.wire },
    }),
  }
}

function responsesPlan(
  routing: EffectiveEndpointRouting,
  chatSettings: ChatSettings,
  path: readonly Message[],
  connection: ConnectionProfile,
): Readonly<{
  request: ReturnType<typeof toResponses>
  plan: AssistantDispatchPlan
}> {
  if (routing.route.transport !== 'openai-responses') throw new Error('ExpectedResponsesRoute')
  const request = toResponses(chatSettings, path, {
    ...(routing.requestCapability ? { capabilities: routing.requestCapability } : {}),
    prefillPlan: routing.prefillPlan,
    stream: false,
    ...(routing.providerWire ? { privacy: routing.providerWire } : {}),
    allowProviderRouting: connection.kind === 'openrouter',
    allowOpenRouterExtensions: connection.kind === 'openrouter',
    reasoning: routing.route.reasoning,
    providerOutput: routing.route.providerOutput,
  })
  const attempt = sealAssistantAttemptContract(
    routing.route,
    resolveAttemptInboundReasoningVisibility(
      routing.route.reasoning.visibilityPolicy,
      request.reasoningVisibilityEvidence,
    ),
  )
  return {
    request,
    plan: createAssistantDispatchPlan({
      ...attempt,
      requestedModel: request.requestedModel,
      wire: { ...request.wire },
    }),
  }
}

function geminiPlan(
  routing: EffectiveEndpointRouting,
  chatSettings: ChatSettings,
  path: readonly Message[],
): Readonly<{
  request: ReturnType<typeof toGeminiNative>
  plan: AssistantDispatchPlan
}> {
  if (routing.route.transport !== 'gemini-native') throw new Error('ExpectedGeminiRoute')
  const request = toGeminiNative(chatSettings, path, {
    ...(routing.requestCapability ? { capabilities: routing.requestCapability } : {}),
    prefillPlan: routing.prefillPlan,
    reasoning: routing.route.reasoning,
    providerOutput: routing.route.providerOutput,
  })
  const attempt = sealAssistantAttemptContract(
    routing.route,
    resolveAttemptInboundReasoningVisibility(
      routing.route.reasoning.visibilityPolicy,
      request.reasoningVisibilityEvidence,
    ),
  )
  return {
    request,
    plan: createAssistantDispatchPlan({
      ...attempt,
      requestedModel: request.requestedModel,
      geminiModelId: request.modelId,
      wire: { ...request.wire },
    }),
  }
}

async function runPlan(connection: ConnectionProfile, key: string, plan: AssistantDispatchPlan) {
  if (generationCalls >= MAX_GENERATION_CALLS) {
    throw new Error(`A6LiveGenerationBudgetExceeded:${generationCalls}`)
  }
  generationCalls += 1
  const rawChatReasoningDetailTypes = new Set<string>()
  const lanes = []
  for await (const lane of splitAssistantStream(
    observeRawAssistantStream(
      openAssistantRequestStream({
        connection,
        apiKey: key,
        requestPlan: plan,
      }),
      rawChatReasoningDetailTypes,
    ),
    plan,
  )) {
    lanes.push(lane)
  }
  return {
    ...foldStreamLaneEvents(lanes),
    rawChatReasoningDetailTypes: [...rawChatReasoningDetailTypes].sort(),
  }
}

async function* observeRawAssistantStream(
  source: AsyncIterable<AssistantStreamChunk>,
  chatReasoningDetailTypes: Set<string>,
): AsyncGenerator<AssistantStreamChunk> {
  for await (const chunk of source) {
    if (chunk.type === 'delta') {
      for (const choice of chunk.chunk.choices ?? []) {
        collectRawChatReasoningDetailTypes(
          choice.delta?.reasoning_details,
          chatReasoningDetailTypes,
        )
      }
    } else if (chunk.type === 'buffered_result') {
      const choices = (chunk.result as { choices?: unknown }).choices
      for (const choice of Array.isArray(choices) ? choices : []) {
        collectRawChatReasoningDetailTypes(
          (choice as { message?: { reasoning_details?: unknown } }).message?.reasoning_details,
          chatReasoningDetailTypes,
        )
      }
    }
    yield chunk
  }
}

function collectRawChatReasoningDetailTypes(input: unknown, target: Set<string>): void {
  if (!Array.isArray(input)) return
  for (const detail of input) {
    if (!detail || typeof detail !== 'object') continue
    const type = (detail as { type?: unknown }).type
    if (typeof type === 'string') target.add(type)
  }
}

function reasoningPresentation(final: ReturnType<typeof foldStreamLaneEvents>['final']) {
  return projectReasoningPresentation({
    kind: 'durable',
    owner: { kind: 'generation' },
    ...(final.reasoningEnvelope ? { envelope: final.reasoningEnvelope } : {}),
  })
}

function reasoningShape(final: ReturnType<typeof foldStreamLaneEvents>['final']): string {
  return JSON.stringify({
    visible:
      final.reasoningEnvelope?.visible.map((part) => ({
        kind: part.kind,
        format: part.format,
        length: part.text.length,
      })) ?? [],
    carriers:
      final.reasoningEnvelope?.carriers.map((carrier) => ({
        kind: carrier.kind,
        format: carrier.format,
        length: reasoningCarrierPayloadLength(carrier),
        binding: 'bindsVisiblePartId' in carrier ? (carrier.bindsVisiblePartId ?? null) : null,
      })) ?? [],
  })
}

function responseText(final: ReturnType<typeof foldStreamLaneEvents>['final']): string {
  return final.content
    .filter(
      (item): item is Extract<ContentItem, { type: 'text' | 'output_text' }> =>
        item.type === 'text' || item.type === 'output_text',
    )
    .map((item) => item.text)
    .join('')
}

function endpointMaxCost(
  endpoint: ModelEndpoint,
  promptTokens: number,
  completionTokens: number,
): number {
  return (
    Number(endpoint.pricing.prompt ?? 0) * promptTokens +
    Number(endpoint.pricing.completion ?? 0) * completionTokens
  )
}

describe.skipIf(!LIVE).sequential('A6 directed reasoning and prefill live matrix', () => {
  beforeAll(() => {
    keys = loadKeys()
  })

  it('keeps streamed Claude text plaintext after its late authentication signature', async () => {
    const connection = profile('openrouter')
    const chatSettings = settings(connection, 'anthropic/claude-haiku-4.5', {
      maxCompletionTokens: 1_400,
      reasoning: {
        mode: 'enabled',
        maxTokens: 1_024,
        exclude: false,
        summary: 'auto',
        include: { encrypted: true, summary: false, text: false },
      },
    })
    const path = [
      user(
        'claude-user',
        'Find two consecutive odd integers summing to 16. Explain the arithmetic, then answer.',
      ),
    ]
    const { routing } = await openRouterRouting(connection, chatSettings)
    const { plan } = chatPlan(routing, chatSettings, path)
    const result = await runPlan(connection, keys.openrouter, plan)
    const presentation = reasoningPresentation(result.final)

    expect(presentation.kind).toBe('plaintext')
    expect(presentation.textCharCount).toBeGreaterThan(0)
    expect(presentation.authentication).toHaveLength(1)
    expect(presentation.authentication[0]?.carrier.kind).toBe('anthropic-signature')
    expect(presentation.opaque).toEqual([])
  }, 120_000)

  it('keeps OpenRouter Gemini summary and opaque carrier in one final envelope', async () => {
    const connection = profile('openrouter')
    const chatSettings = settings(connection, 'google/gemini-3.5-flash-lite', {
      maxCompletionTokens: 1_200,
      reasoning: {
        mode: 'enabled',
        effort: 'high',
        exclude: false,
        summary: 'detailed',
        include: { encrypted: true, summary: false, text: false },
      },
    })
    const path = [
      user(
        'or-gemini-user',
        'How many distinct positive divisors does 720 have? Derive the result from its prime factorization before answering.',
      ),
    ]
    const { routing } = await openRouterRouting(connection, chatSettings)
    const request = chatPlan(routing, chatSettings, path)
    expect(request.request.wire.reasoning).toMatchObject({
      enabled: true,
      effort: 'high',
      summary: 'detailed',
    })
    const result = await runPlan(connection, keys.openrouter, request.plan)
    const presentation = reasoningPresentation(result.final)

    expect(presentation.summaryCharCount, reasoningShape(result.final)).toBeGreaterThan(0)
    const upstreamHasCarrier = result.rawChatReasoningDetailTypes.includes('reasoning.encrypted')
    expect(
      presentation.opaque.some((row) => row.carrier.format === 'google-gemini-v1'),
      reasoningShape(result.final),
    ).toBe(upstreamHasCarrier)
    expect(
      new Set(result.final.reasoningEnvelope?.carriers.map((carrier) => carrier.id)).size,
    ).toBe(result.final.reasoningEnvelope?.carriers.length)
  }, 120_000)

  it('round-trips Gemini native summary and thought signature through the app compiler', async () => {
    const connection = profile('google')
    const capability: CapabilityDescriptor = {
      supportedParameters: ['reasoning', 'max_tokens'],
      streaming: 'supported',
    }
    const chatSettings = settings(connection, 'google/gemini-3.5-flash-lite', {
      maxCompletionTokens: 1_200,
      reasoning: {
        mode: 'enabled',
        effort: 'high',
        exclude: false,
        summary: 'detailed',
        include: { encrypted: true, summary: false, text: false },
      },
    })
    const firstPath = [
      user(
        'native-gemini-user-1',
        'How many distinct positive divisors does 720 have? Derive the result from its prime factorization before answering.',
      ),
    ]
    const firstRouting = directRouting(connection, chatSettings, capability)
    const first = geminiPlan(firstRouting, chatSettings, firstPath)
    expect(first.request.wire.generationConfig?.thinkingConfig).toMatchObject({
      includeThoughts: true,
      thinkingLevel: 'high',
    })
    const firstResult = await runPlan(connection, keys.google, first.plan)
    const firstPresentation = reasoningPresentation(firstResult.final)

    expect(firstPresentation.summaryCharCount, reasoningShape(firstResult.final)).toBeGreaterThan(0)
    expect(
      firstPresentation.opaque.some((row) => row.carrier.kind === 'gemini-thought-signature'),
    ).toBe(true)

    const assistant = assistantFromFinal(
      'native-gemini-assistant-1',
      'native-gemini-user-1',
      firstResult.final,
    )
    const secondPath = [
      ...firstPath,
      assistant,
      user('native-gemini-user-2', 'Name another primary color.', assistant.id),
    ]
    const secondRouting = directRouting(connection, chatSettings, capability, secondPath)
    const second = geminiPlan(secondRouting, chatSettings, secondPath)
    const echoedModelTurn = second.request.wire.contents.find(
      (content) =>
        content.role === 'model' && content.parts.some((part) => 'thoughtSignature' in part),
    )

    expect(second.request.reasoningCarryForward).toBe('carrier')
    expect(echoedModelTurn).toBeDefined()
    const secondResult = await runPlan(connection, keys.google, second.plan)
    expect(responseText(secondResult.final).trim().length).toBeGreaterThan(0)
  }, 180_000)

  it('round-trips an OpenRouter Responses carrier through the same bridge without raw rewrites', async () => {
    const openRouter = profile('openrouter')
    const firstSettings = settings(openRouter, 'openai/gpt-5.6-luna', {
      api: 'responses',
      maxCompletionTokens: 600,
      reasoning: {
        mode: 'enabled',
        effort: 'high',
        exclude: false,
        summary: 'detailed',
        include: { encrypted: true, summary: false, text: false },
      },
    })
    const firstPath = [
      user(
        'responses-user-1',
        'How many distinct positive divisors does 720 have? Derive the result from its prime factorization before answering.',
      ),
    ]
    const { routing: firstRouting } = await openRouterRouting(openRouter, firstSettings)
    const first = responsesPlan(firstRouting, firstSettings, firstPath, openRouter)
    expect(first.request.wire.reasoning).toMatchObject({
      effort: 'high',
      summary: 'detailed',
    })
    expect(first.request.wire.include).toEqual(['reasoning.encrypted_content'])
    const firstResult = await runPlan(openRouter, keys.openrouter, first.plan)
    const firstPresentation = reasoningPresentation(firstResult.final)

    expect(firstPresentation.summaryCharCount, reasoningShape(firstResult.final)).toBeGreaterThan(0)
    expect(firstPresentation.opaque.some((row) => row.carrier.kind === 'responses-encrypted')).toBe(
      true,
    )

    const assistant = assistantFromFinal(
      'responses-assistant-1',
      'responses-user-1',
      firstResult.final,
    )
    const secondPath = [
      ...firstPath,
      assistant,
      user('responses-user-2', 'Double that integer. Give only the result.', assistant.id),
    ]
    const secondSettings = settings(openRouter, 'openai/gpt-5.6-luna', {
      api: 'responses',
      maxCompletionTokens: 128,
      reasoning: {
        mode: 'enabled',
        effort: 'low',
        exclude: false,
        summary: 'auto',
        include: { encrypted: true, summary: false, text: false },
      },
    })
    const { routing: secondRouting } = await openRouterRouting(
      openRouter,
      secondSettings,
      undefined,
      secondPath,
    )
    const second = responsesPlan(secondRouting, secondSettings, secondPath, openRouter)
    const input = second.request.wire.input
    if (!Array.isArray(input)) throw new Error('ExpectedResponsesInputItems')
    const reasoningItem = input.find(
      (item) => item.type === 'reasoning' && typeof item.encrypted_content === 'string',
    )

    expect(second.request.reasoningCarryForward).toBe('carrier')
    expect(reasoningItem).toBeDefined()
    const secondResult = await runPlan(openRouter, keys.openrouter, second.plan)
    expect(responseText(secondResult.final).trim().length).toBeGreaterThan(0)
  }, 180_000)

  it('pins GLM prefill to the live Fireworks endpoint and performs one continuation', async () => {
    const connection = profile('openrouter')
    const baseSettings = settings(connection, 'z-ai/glm-5.2', {
      allowFallbacks: false,
      maxCompletionTokens: 16,
      reasoning: {
        mode: 'off',
        exclude: false,
        summary: 'off',
        include: { encrypted: true, summary: false, text: false },
      },
    })
    const unpinned = await openRouterRouting(connection, baseSettings)
    const endpoint = unpinned.descriptor.endpoints.find(
      (candidate) => providerRoutingRef(candidate) === 'fireworks',
    )
    if (!endpoint) throw new Error('LiveFireworksEndpointMissing:z-ai/glm-5.2')
    const providerRef = providerRoutingRef(endpoint)
    expect(endpointMaxCost(endpoint, 512, 16)).toBeLessThan(0.02)

    const chatSettings = {
      ...baseSettings,
      providerPrefs: {
        only: [providerRef],
        order: [providerRef],
        ignoreOverridesFilter: true,
      },
    }
    const { routing } = await openRouterRouting(connection, chatSettings, [providerRef])
    expect(routing.selectedEndpoints).toEqual([endpoint])
    expect(routing.prefillPlan).toMatchObject({
      availability: 'supported',
      request: 'send-once',
      semanticRetry: 'never',
      basis: 'transport',
      serialization: { kind: 'assistant-tail', marker: 'none' },
    })

    const first = user(
      'glm-prefill-user',
      'Complete the assistant message with the single hexadecimal digit after A.',
    )
    const path = [first, prefill('glm-prefill-assistant', 'The requested digit is ', first.id)]
    const request = chatPlan(routing, chatSettings, path)
    expect(request.request.wire.provider).toMatchObject({
      only: [providerRef],
      order: [providerRef],
      allow_fallbacks: false,
    })
    const result = await runPlan(connection, keys.openrouter, request.plan)

    expect(result.accumulator.provider).toMatch(/fireworks/i)
    expect(
      new ProviderEndpointIndex(unpinned.descriptor.endpoints).matches(
        endpoint,
        result.accumulator.provider ?? '',
      ),
    ).toBe(true)
    expect(responseText(result.final).trim()).toMatch(/\bB\b/i)
  }, 120_000)

  it('keeps Gemini 3.5 Flash native prefill supported and sends one model-tail continuation', async () => {
    const connection = profile('google')
    const capability: CapabilityDescriptor = {
      supportedParameters: ['max_tokens'],
      streaming: 'supported',
    }
    const chatSettings = settings(connection, 'google/gemini-3.5-flash', {
      maxCompletionTokens: 16,
      reasoning: {
        mode: 'off',
        exclude: false,
        summary: 'off',
        include: { encrypted: true, summary: false, text: false },
      },
    })
    const routing = directRouting(connection, chatSettings, capability)
    expect(routing.prefillPlan).toMatchObject({
      availability: 'supported',
      request: 'send-once',
      semanticRetry: 'never',
      serialization: { kind: 'native-model-tail' },
    })

    const first = user(
      'gemini-prefill-user',
      'Complete the model message with the single hexadecimal digit after A.',
    )
    const path = [first, prefill('gemini-prefill-assistant', 'The requested digit is ', first.id)]
    const request = geminiPlan(routing, chatSettings, path)
    expect(request.request.wire.contents.at(-1)).toEqual({
      role: 'model',
      parts: [{ text: 'The requested digit is' }],
    })
    const result = await runPlan(connection, keys.google, request.plan)

    expect(responseText(result.final).trim()).toMatch(/^(?:\*\*|__|`)?B(?:\*\*|__|`)?[.!]?$/i)
    expect(generationCalls).toBe(MAX_GENERATION_CALLS)
  }, 120_000)
})
