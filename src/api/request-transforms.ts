// Phase 7 scope: text-only chat (no tools, no attachments, no reasoning echo,
// no cache control, no Responses API). We DO respect the contracts that will
// stay unchanged as other features are bolted on later:
//
// - Envelope fields (`model`, `messages`, `stream`) are NEVER dropped by
//   capability gating. `supportedParameters` only gates OPTIONAL sampling /
//   reasoning / verbosity / response_format / plugins / stop / provider /
//   cache_control keys — the non-negotiable ones pass through.
// - `hiddenFromContext` and tombstoned messages are never sent upstream.
// - A trailing `origin: 'prefill'` assistant message is serialized in place;
//   the transform never appends a synthetic echo.
// - System prompt becomes the first `system`/`developer` message iff non-empty
//   AND the active path doesn't already contain one (e.g. imported transcript).
// - `requestedModel` is the ORIGINAL `settings.model`; the wire `model` goes
//   through `rewriteSlug` if a quirk entry matches. (No slug rewrites are
//   wired in Phase 7 yet — this just reserves the shape so later phases don't
//   have to retouch transform callers.)

import { samplingParameterWireKey } from '../core/capabilities'
import { anthropicWireCitations, responsesWireAnnotations } from '../core/content-annotations'
import { createAppliedMessageView } from '../core/continuation-content'
import type { PrefillPlan } from '../core/effective-endpoint-routing'
import { isFreeModel } from '../core/model-predicates'
import {
  type CompiledResponsesReasoningUnit,
  type OutboundReasoningResolver,
  resolveOutboundReasoningResolver,
} from '../core/outbound-reasoning'
import type { WireProviderPrivacy } from '../core/privacy-filter'
import {
  buildAnthropicServerTools,
  buildGoogleServerTools,
  buildOpenAiServerTools,
  buildOpenRouterServerTools,
  type HostedToolProvider,
} from '../core/provider-hosted-tools'
import {
  type AttemptProviderOutputContract,
  materializeNativeProviderOutput,
  projectProviderOutputForContext,
  renderProviderOutputContextFallback,
} from '../core/provider-tool-context'
import {
  adjustGpt54SamplingGate,
  quirksFor,
  reasoningVisibilityPolicyFromQuirks,
} from '../core/quirks'
import {
  type AnthropicReasoningContract,
  type ChatReasoningContract,
  type GeminiReasoningContract,
  mergeSealedReasoningCarryForward,
  type ReasoningVisibilityEvidence,
  type ResponsesReasoningContract,
  type TextReasoningContract,
} from '../core/reasoning'
import { type RenderedTextPrompt, renderTextPromptProjection } from '../core/text-templates'
import type {
  CapabilityDescriptor,
  ChatSettings,
  ContentItem,
  EffortLevel,
  Message,
  MessageId,
  MessageRole,
  ReasoningCarryForwardEvidence,
  ReasoningDetail,
  SealedReasoningCarryForward,
  TextTemplateConfig,
  ToolCall,
} from '../core/types'
import type {
  AnthropicContentBlock,
  AnthropicMessagesRequestWire,
  AnthropicMessageWire,
} from './anthropic-types'
import type {
  GeminiContent,
  GeminiPart,
  GenerateContentRequestWire,
  GenerationConfig,
  ThinkingConfig,
} from './gemini-types'
import type { TextCompletionRequestWire } from './text-completions'
import type { ChatCompletionRequestWire, ResponsesInputItem, ResponsesRequestWire } from './types'

export interface ChatCompletionsTransformOptions {
  // Live capability descriptor — from `/endpoints` (OpenRouter) or a static
  // capabilities JSON (direct providers). `supportedParameters` gates optional
  // request fields. When omitted, the full superset is sent; the upstream
  // then decides what to accept (matches the "live-first, registry-last" rule).
  capabilities?: CapabilityDescriptor
  prefillPlan: PrefillPlan
  // Override whether to include stream:true in the body. Defaults to `true`
  // because Phase 7's send pipeline always streams. Non-stream buffering goes
  // through `chatCompletionsOnce`, not this transform.
  stream?: boolean
  // Optional slug rewrite (§5.1 step 0). When set, the wire `model` uses the
  // rewritten slug while `generation.requestedModel` keeps the original.
  rewriteSlug?: (slug: string) => string
  // Pre-computed privacy-filter output from `usePrivacyRouting`. When
  // provided, its auto-ignore / only / order / deny / zdr fragments are
  // merged with `settings.providerPrefs` before the wire `provider`
  // block is built.
  privacy?: WireProviderPrivacy
  // OpenRouter-specific provider routing. This must be explicitly enabled by
  // the request planner so direct/custom OpenAI-compatible endpoints never see
  // OpenRouter's `provider` extension.
  allowProviderRouting?: boolean
  // Provider-hosted server tools. Each provider maps to its native wire shape;
  // callers must pass the concrete provider instead of a generic boolean.
  hostedToolsProvider?: HostedToolProvider
  reasoning: ChatReasoningContract
  reasoningResolver?: OutboundReasoningResolver
  providerOutput: Extract<AttemptProviderOutputContract, { captureDialect: null }>
  attachmentPartsByMessageId?: ReadonlyMap<MessageId, readonly unknown[]>
  extraPlugins?: readonly unknown[]
  reasoningCarryForwardByMessageId?: ReadonlyMap<MessageId, SealedReasoningCarryForward>
}

interface ChatCompletionsTransformResult {
  wire: ChatCompletionRequestWire
  // The model id the caller should store on `generation.requestedModel`
  // (before any quirk rewrite). Kept separate so callers don't have to
  // reimplement the rewrite-tracks-original rule.
  requestedModel: string
  reasoningCarryForward: SealedReasoningCarryForward
  reasoningVisibilityEvidence: ReasoningVisibilityEvidence
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'stream',
  'input',
  'instructions',
  'provider',
])

// Sampling keys that can be gated by `supportedParameters`. The internal
// representation in `ChatSettings.sampling` uses the wire names directly
// (SamplingKey is already snake_case for stream/temperature/etc.) so the
// remap is identity for this set.
// Apply prefill-specific path rewrites before wire serialization: trim trailing
// whitespace and merge adjacent prefill/continuation assistant rows. Both are
// wire-only; stored messages keep the user's content verbatim. Returns a new
// array when changes apply, otherwise the input array reference.
export function preparePrefillPathForWire(
  path: readonly Message[],
  prefillPlan: PrefillPlan,
): readonly Message[] {
  if (path.length === 0) return path
  let mutated: Message[] | null = null
  const dropped = new Set<number>()
  for (let i = 0; i < path.length; i += 1) {
    const current = path[i]
    if (current?.role !== 'assistant' || current.origin !== 'prefill') continue
    const next = path[i + 1]
    if (next?.role !== 'assistant' || next.origin === 'prefill') continue
    // Adjacent `prefill → continuation` pair. Merge them into one wire
    // assistant turn on the wire; the upstream API requires strict role
    // alternation and two adjacent assistant messages would be rejected.
    const merged = mergePrefillIntoContinuation(current, next)
    if (!mutated) mutated = path.slice()
    mutated[i + 1] = merged
    dropped.add(i)
  }
  let processed: readonly Message[] = mutated
    ? mutated.filter((_m, index) => !dropped.has(index))
    : path

  // Trailing prefill turn — trim trailing whitespace on the last text part.
  // Anthropic direct hard-rejects (400) on trailing whitespace, and trimming
  // is harmless everywhere. Wire-only; stored content stays verbatim.
  const tail = processed.at(-1)
  if (tail && tail.role === 'assistant' && tail.origin === 'prefill') {
    if (prefillPlan.availability === 'unsupported') {
      throw new Error(`PrefillUnsupported:${prefillPlan.reason}`)
    }
    const trimmed = trimTrailingWhitespaceOnLastText(tail)
    if (trimmed !== tail) {
      processed = [...processed.slice(0, -1), trimmed]
    }
  }
  return processed
}

function assertPrefillSerialization(
  path: readonly Message[],
  plan: PrefillPlan,
  expected: 'assistant-tail' | 'native-model-tail' | 'text-prefix' | 'unsupported',
): void {
  const tail = path.at(-1)
  if (tail?.role !== 'assistant' || tail.origin !== 'prefill') return
  if (plan.availability === 'unsupported') {
    throw new Error(`PrefillUnsupported:${plan.reason}`)
  }
  if (plan.serialization.kind !== expected) {
    throw new Error(`PrefillSerializationRouteMismatch:${plan.serialization.kind}:${expected}`)
  }
}

function mergePrefillIntoContinuation(prefill: Message, continuation: Message): Message {
  const prefillContent = prefill.content
  const contContent = continuation.content
  const prefillPrefix = prefillContent
    .filter(
      (item): item is Extract<ContentItem, { type: 'text' | 'output_text' }> =>
        item.type === 'text' || item.type === 'output_text',
    )
    .map((item) => item.text)
    .join('')
  const prefillNonText = prefillContent.filter(
    (item) => item.type !== 'text' && item.type !== 'output_text',
  )

  const mergedContent: ContentItem[] = []
  mergedContent.push(...prefillNonText)

  const firstContTextIdx = contContent.findIndex(
    (item) => item.type === 'text' || item.type === 'output_text',
  )
  if (prefillPrefix.length === 0) {
    mergedContent.push(...contContent)
  } else if (firstContTextIdx < 0) {
    mergedContent.push({ type: 'text', text: prefillPrefix })
    mergedContent.push(...contContent)
  } else {
    for (let i = 0; i < contContent.length; i += 1) {
      const item = contContent[i]
      if (!item) continue
      if (i === firstContTextIdx && (item.type === 'text' || item.type === 'output_text')) {
        mergedContent.push({ ...item, text: prefillPrefix + item.text })
      } else {
        mergedContent.push(item)
      }
    }
  }
  return trimTrailingWhitespaceOnLastText({ ...continuation, content: mergedContent })
}

function trimTrailingWhitespaceOnLastText(message: Message): Message {
  const items = message.content
  if (items.length === 0) return message
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (!item) continue
    if (item.type === 'text' || item.type === 'output_text') {
      const trimmed = item.text.replace(/[ \t\n\r]+$/, '')
      if (trimmed === item.text) return message
      const next = items.slice()
      if (item.type === 'text') next[i] = { ...item, text: trimmed }
      else next[i] = { ...item, text: trimmed }
      return { ...message, content: next }
    }
  }
  return message
}

// Translate a `ContentItem[]` into chat-completions wire content parts. For
// text-only Phase 7 this is nearly identity; the typed shape is preserved so
// later phases can bolt on image/audio/file/video without revisiting callers.
function serializeContent(items: ContentItem[], extraParts: readonly unknown[] = []): unknown {
  if (items.length === 0 && extraParts.length === 0) return ''
  if (
    extraParts.length === 0 &&
    items.length === 1 &&
    (items[0]?.type === 'text' || items[0]?.type === 'output_text')
  ) {
    // Collapse a single text/output_text block to a plain string. OpenAI-
    // compatible endpoints accept both string and array content, and echoing
    // an assistant turn as a plain string is what upstreams expect for
    // multi-turn context. Array form is reserved for mixed-modality turns.
    return items[0].text
  }
  const parts: unknown[] = []
  for (const item of items) {
    if (item.type === 'text') {
      parts.push({ type: 'text', text: item.text })
    } else if (item.type === 'output_text') {
      parts.push({ type: 'text', text: item.text })
    }
    // Non-text items are Phase 7 out of scope. Skipping silently matches the
    // "capability gating drops optional fields; never throws" discipline.
  }
  parts.push(...extraParts)
  return parts
}

function toWireRole(role: MessageRole): string {
  // `developer` is OpenAI's newer name for `system`; keep it distinct on the
  // wire when callers opt in. Other roles are identity.
  return role
}

interface BuildChatMessagesOptions {
  prefillPlan: PrefillPlan
  reasoning: ChatReasoningContract
  reasoningResolver?: OutboundReasoningResolver
  providerOutput: Extract<AttemptProviderOutputContract, { captureDialect: null }>
  attachmentPartsByMessageId?: ReadonlyMap<MessageId, readonly unknown[]>
  includeToolCalls?: boolean
  reasoningCarryForwardByMessageId?: ReadonlyMap<MessageId, SealedReasoningCarryForward>
}

type ResolvedBuildChatMessagesOptions = Omit<BuildChatMessagesOptions, 'reasoningResolver'> & {
  reasoningResolver: OutboundReasoningResolver
}

export function buildChatMessages(
  settings: ChatSettings,
  path: readonly Message[],
  opts: BuildChatMessagesOptions,
): unknown[] {
  return projectChatMessages(settings, path, opts).messages
}

interface ChatMessagesProjection {
  messages: unknown[]
  reasoningCarryForward: SealedReasoningCarryForward
}

function projectChatMessages(
  settings: ChatSettings,
  path: readonly Message[],
  opts: BuildChatMessagesOptions,
): ChatMessagesProjection {
  const reasoningResolver = resolveOutboundReasoningResolver(
    { kind: 'chat', contract: opts.reasoning },
    opts.reasoningResolver,
  )
  const rewritten = preparePrefillPathForWire(path, opts.prefillPlan)
  const visible = rewritten.filter((m) => m.hiddenFromContext !== true && !m.deleted)
  const messages: unknown[] = []
  let reasoningCarryForward: SealedReasoningCarryForward = 'none'
  const hasImportedSystem = visible.some((m) => m.role === 'system' || m.role === 'developer')
  if (!hasImportedSystem && settings.systemPrompt.length > 0) {
    messages.push({
      role: settings.systemRole,
      content: settings.systemPrompt,
    })
  }
  for (const [index, message] of visible.entries()) {
    const projected = serializeChatMessage(message, { ...opts, reasoningResolver })
    if (
      index === visible.length - 1 &&
      message.role === 'assistant' &&
      message.origin === 'prefill'
    ) {
      applyChatPrefillMarker(projected.wire, opts.prefillPlan)
    }
    messages.push(projected.wire)
    reasoningCarryForward = mergeSealedReasoningCarryForward(
      reasoningCarryForward,
      projected.reasoningCarryForward,
    )
  }
  return { messages, reasoningCarryForward }
}

function applyChatPrefillMarker(wire: Record<string, unknown>, plan: PrefillPlan): void {
  if (plan.availability === 'unsupported') throw new Error('PrefillUnsupported')
  if (plan.serialization.kind !== 'assistant-tail') {
    throw new Error(`PrefillSerializationRouteMismatch:${plan.serialization.kind}:chat`)
  }
  if (plan.serialization.marker === 'partial') wire.partial = true
  if (plan.serialization.marker === 'prefix') wire.prefix = true
}

// Per-message serializer. Phase 7 handled only `{role, content}`. Phase 11
// adds `reasoning_details` (echo per the include matrix), `tool_calls`
// (on assistant messages), and `tool_call_id` (on tool messages). `phase`
// is intentionally NOT echoed on chat-completions — the wire can't represent
// it because it is a Responses-API field.
function serializeChatMessage(
  message: Message,
  opts: ResolvedBuildChatMessagesOptions,
): { wire: Record<string, unknown>; reasoningCarryForward: SealedReasoningCarryForward } {
  const attachmentParts = opts.attachmentPartsByMessageId?.get(message.id) ?? []
  const appliedView = message.role === 'assistant' ? createAppliedMessageView(message) : undefined
  const providerOutput = appliedView
    ? projectProviderOutputForContext(appliedView, opts.providerOutput, {
        includeToolCalls: opts.includeToolCalls,
      })
    : null
  const unsupportedToolText = providerOutput
    ? renderProviderOutputContextFallback(providerOutput)
    : null
  const contentItems = unsupportedToolText
    ? appendAssistantToolContext(message.content, unsupportedToolText)
    : message.content
  const entry: Record<string, unknown> = {
    role: toWireRole(message.role),
    content: serializeContent(contentItems, attachmentParts),
  }

  if (message.role === 'tool') {
    const toolCallId = message.toolCalls?.[0]?.id
    if (toolCallId) entry.tool_call_id = toolCallId
    // Tool messages never carry reasoning or make tool calls themselves.
    return { wire: entry, reasoningCarryForward: 'none' }
  }

  let reasoningCarryForward: SealedReasoningCarryForward =
    message.role === 'assistant'
      ? (opts.reasoningCarryForwardByMessageId?.get(message.id) ?? 'none')
      : 'none'
  if (appliedView) {
    const compiled = opts.reasoningResolver.compilationFor(message)
    if (compiled.kind !== 'chat') throw new Error(`ReasoningRouteMismatch:chat:${message.id}`)
    reasoningCarryForward = mergeSealedReasoningCarryForward(
      reasoningCarryForward,
      compiled.reasoningCarryForward,
    )
    const native = compiled.attempts.flatMap((attempt) => attempt.units)
    if (native.length > 0 || compiled.inline !== null) {
      // Native reasoning-echo slot (`reasoning_details[]`) only works for
      // carriers the target route actually understands. Unknown-format
      // models (DeepSeek, Qwen, Gemma, Kimi, GLM, MiniMax, anything with
      // `reasoningPreservationFormat: 'unknown'` or unset) — OR strips
      // reasoning_details on input for these, so the echo has no effect.
      // Fall back to wrapping summary+text in a single `<think>…</think>`
      // block prepended to assistant content. Models condition on it the
      // way they'd condition on their own prior inline reasoning.
      //
      // The user can also force this universal-compat mode via the
      // `reasoning.echoAsThinkTags` checkbox even when the route HAS a
      // native carrier — handy for OpenAI-compat shims, custom endpoints,
      // and homogenizing multi-provider chats. Opaque carriers (encrypted
      // blobs and Anthropic signed-text) keep riding `reasoning_details[]`
      // either way; only plaintext text/summary becomes `<think>` content.
      if (compiled.inline) {
        const existing = typeof entry.content === 'string' ? entry.content : ''
        entry.content = existing.length > 0 ? `${compiled.inline}\n\n${existing}` : compiled.inline
      }
      if (native.length > 0) {
        entry.reasoning_details = native.map(toChatReasoningDetail)
      }
    }
    if (appliedView.toolCalls.length > 0) {
      entry.tool_calls = appliedView.toolCalls.map(toWireToolCall)
    }
  }
  return { wire: entry, reasoningCarryForward }
}

// `reasoning.encrypted` is opaque by definition. Anthropic's signed-text
// carrier ALSO rides as opaque: `reasoning.text` with a non-empty
// `.signature` is Anthropic's signed thinking block; the signature is what
// the next turn validates, so the text is never tag-ified out from under it.
// Used to split kept entries into "wrap as <think>" vs "keep on native
// reasoning_details[]" buckets when the universal-compat path is active.
// Assemble a single `<think>…</think>` block from summary + text entries
// (encrypted entries can't be expressed in plaintext; the filter skips them
// when preservationFormat is 'unknown' anyway). Summaries come first as
// "Summary:" lines then text as "Reasoning:" lines so the model can tell
// them apart. Returns `null` when nothing usable remains.
function toWireToolCall(call: ToolCall): Record<string, unknown> {
  return {
    id: call.id,
    type: call.type,
    function: {
      name: call.function.name,
      arguments: call.function.arguments,
    },
  }
}

function appendAssistantToolContext(
  content: readonly ContentItem[],
  toolContextText: string,
): ContentItem[] {
  const next = structuredClone(content) as ContentItem[]
  const suffix = `\n\n${toolContextText}`
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const item = next[i]
    if (!item) continue
    if (item.type === 'text' || item.type === 'output_text') {
      next[i] = { ...item, text: `${item.text}${suffix}` }
      return next
    }
  }
  next.push({ type: 'output_text', text: toolContextText })
  return next
}

interface OpenRouterHostedToolWireBlock {
  tools: unknown[]
  tool_choice?: unknown
  parallel_tool_calls?: boolean
}

function openRouterHostedToolWireBlock(
  settings: ChatSettings,
  gate: (parameter: string) => boolean,
  route: 'chat-completions' | 'responses',
): OpenRouterHostedToolWireBlock | null {
  const tools = buildOpenRouterServerTools(settings, route)
  if (tools.length === 0 || !gate('tools')) return null
  const toolSettings = settings.tools.openrouter
  const block: OpenRouterHostedToolWireBlock = { tools }
  if (toolSettings.toolChoice !== undefined && gate('tool_choice')) {
    block.tool_choice = toolSettings.toolChoice
  }
  if (toolSettings.parallelToolCalls !== undefined && gate('parallel_tool_calls')) {
    block.parallel_tool_calls = toolSettings.parallelToolCalls
  }
  return block
}

export function toChatCompletions(
  settings: ChatSettings,
  path: readonly Message[],
  opts: ChatCompletionsTransformOptions,
): ChatCompletionsTransformResult {
  const requestedModel = settings.model
  const wireModel = opts.rewriteSlug ? opts.rewriteSlug(requestedModel) : requestedModel
  const streaming = opts.stream !== false
  const caps = opts.capabilities
  const supported = caps?.supportedParameters

  const messages = projectChatMessages(settings, path, {
    prefillPlan: opts.prefillPlan,
    reasoning: opts.reasoning,
    ...(opts.reasoningResolver ? { reasoningResolver: opts.reasoningResolver } : {}),
    providerOutput: opts.providerOutput,
    ...(opts.attachmentPartsByMessageId
      ? { attachmentPartsByMessageId: opts.attachmentPartsByMessageId }
      : {}),
    includeToolCalls: settings.toolCallContext.include,
    ...(opts.reasoningCarryForwardByMessageId
      ? { reasoningCarryForwardByMessageId: opts.reasoningCarryForwardByMessageId }
      : {}),
  })
  const wire: ChatCompletionRequestWire = {
    model: wireModel,
    messages: messages.messages,
  }
  if (streaming) wire.stream = true

  // Optional knobs — each gate on `supportedParameters` when a capability
  // descriptor is available. `ENVELOPE_KEYS` never filters (never should
  // appear in this block anyway).
  const gate = (param: string): boolean => {
    if (ENVELOPE_KEYS.has(param)) return true
    if (!supported) return true
    return supported.includes(param)
  }

  for (const [key, value] of Object.entries(settings.sampling)) {
    const wireKey = samplingParameterWireKey(key)
    if (!gate(wireKey)) continue
    wire[wireKey] = value
  }

  if (settings.stop && settings.stop.length > 0 && gate('stop')) {
    wire.stop = [...settings.stop]
  }
  if (settings.maxCompletionTokens !== undefined && settings.maxCompletionTokens >= 0) {
    // -1 is the local "unlimited" sentinel; never send it on the wire.
    if (gate('max_completion_tokens')) {
      wire.max_completion_tokens = settings.maxCompletionTokens
    } else if (gate('max_tokens')) {
      wire.max_tokens = settings.maxCompletionTokens
    }
  }
  if (settings.logitBias && gate('logit_bias')) {
    wire.logit_bias = { ...settings.logitBias }
  }
  // llama-server KV-cache reuse. Only emit when explicitly disabled —
  // the server's default is true, so omitting the field keeps the
  // existing behavior for every non-llama backend (they just ignore
  // the key because it's not in their supportedParameters).
  if (settings.cachePrompt === false && gate('cache_prompt')) {
    wire.cache_prompt = false
  }
  const requiresAudioOutput = caps?.architecture?.outputModalities?.includes('audio') === true
  if (requiresAudioOutput) {
    wire.modalities = ['text', 'audio']
    wire.audio = { voice: 'alloy', format: 'pcm16' }
  } else if (settings.modalities && settings.modalities.length > 0 && gate('modalities')) {
    wire.modalities = [...settings.modalities]
  }
  if (settings.responseFormat && gate('response_format')) {
    wire.response_format = toWireResponseFormat(settings.responseFormat)
  }
  if (opts.hostedToolsProvider === 'openrouter') {
    const toolBlock = openRouterHostedToolWireBlock(settings, gate, 'chat-completions')
    if (toolBlock) Object.assign(wire, toolBlock)
  }
  if (settings.serviceTier && settings.serviceTier !== 'auto' && gate('service_tier')) {
    wire.service_tier = settings.serviceTier
  }

  // Reasoning: only emit when explicitly configured AND supported. `off` with
  // no other reasoning knobs stays off the wire entirely so buffered / text
  // models aren't confused by an empty object.
  let reasoningVisibilityEvidence = openAiReasoningVisibilityEvidence(
    opts.reasoning.carrier === 'openrouter-reasoning-details' ? 'openrouter-chat' : 'openai-chat',
    undefined,
    settings.reasoning.summary,
  )
  if (gate('reasoning')) {
    const reasoning = buildReasoning(
      settings,
      opts.reasoning.carrier === 'openrouter-reasoning-details',
    )
    if (reasoning) {
      wire.reasoning = reasoning
      reasoningVisibilityEvidence = openAiReasoningVisibilityEvidence(
        opts.reasoning.carrier === 'openrouter-reasoning-details'
          ? 'openrouter-chat'
          : 'openai-chat',
        reasoning,
        settings.reasoning.summary,
      )
    }
  }
  if (settings.verbosity && gate('verbosity')) {
    wire.verbosity = settings.verbosity
  }

  // Provider preferences are OpenRouter-specific. The planner must opt in;
  // otherwise direct/custom endpoints never receive OpenRouter's extension
  // even when settings happen to contain provider prefs.
  if (opts.allowProviderRouting === true && gate('provider')) {
    const providerBlock = buildProviderBlock(settings, opts.privacy)
    if (providerBlock) wire.provider = providerBlock
  }

  // Context strategy → plugins: only the explicit `middle_out_plugin` case
  // currently affects the wire. `sliding_window` is client-side trimming,
  // `off` is no-op.
  if (settings.contextStrategy.kind === 'middle_out_plugin' && gate('plugins')) {
    wire.plugins = [{ id: 'context-compression' }]
  }
  if (opts.extraPlugins && opts.extraPlugins.length > 0 && gate('plugins')) {
    wire.plugins = [
      ...((Array.isArray(wire.plugins) ? wire.plugins : []) as unknown[]),
      ...opts.extraPlugins,
    ]
  }

  return {
    wire,
    requestedModel,
    reasoningCarryForward: messages.reasoningCarryForward,
    reasoningVisibilityEvidence,
  }
}

// ---------------------------------------------------------------------------
// Text completions (llama-server protocol='text')
// ---------------------------------------------------------------------------

type TextCompletionsPromptSource =
  | {
      readonly kind: 'client-template'
      readonly template: TextTemplateConfig
    }
  | {
      readonly kind: 'server-template'
      readonly rendered: RenderedTextPrompt
    }

interface TextCompletionsTransformOptions {
  capabilities?: CapabilityDescriptor
  prefillPlan: PrefillPlan
  stream?: boolean
  privacy?: WireProviderPrivacy
  allowProviderRouting?: boolean
  reasoningDialect: 'generic-inline' | 'openrouter-text'
  reasoning: TextReasoningContract
  reasoningResolver?: OutboundReasoningResolver
  providerOutput: Extract<AttemptProviderOutputContract, { captureDialect: null }>
  promptSource: TextCompletionsPromptSource
  reasoningCarryForwardByMessageId?: ReadonlyMap<MessageId, SealedReasoningCarryForward>
}

interface TextCompletionsTransformResult {
  wire: TextCompletionRequestWire
  requestedModel: string
  reasoningCarryForwardEvidence: ReasoningCarryForwardEvidence
  reasoningVisibilityEvidence: ReasoningVisibilityEvidence
}

export function toTextCompletions(
  settings: ChatSettings,
  path: readonly Message[],
  opts: TextCompletionsTransformOptions,
): TextCompletionsTransformResult {
  const requestedModel = settings.model
  const streaming = opts.stream !== false
  const caps = opts.capabilities
  const supported = caps?.supportedParameters
  const rewrittenPath = preparePrefillPathForWire(path, opts.prefillPlan)
  assertPrefillSerialization(rewrittenPath, opts.prefillPlan, 'text-prefix')

  const projectedPrompt =
    opts.promptSource.kind === 'server-template'
      ? opts.promptSource.rendered
      : renderTextPromptProjection(
          opts.promptSource.template,
          settings,
          rewrittenPath,
          opts.reasoning,
          opts.providerOutput,
          {
            ...(opts.reasoningCarryForwardByMessageId
              ? { reasoningCarryForwardByMessageId: opts.reasoningCarryForwardByMessageId }
              : {}),
            ...(opts.reasoningResolver ? { reasoningResolver: opts.reasoningResolver } : {}),
          },
        )

  const wire: TextCompletionRequestWire = {
    model: requestedModel,
    prompt: projectedPrompt.prompt,
  }
  if (streaming) wire.stream = true

  const gate = (param: string): boolean => {
    if (!supported) return true
    return supported.includes(param)
  }

  for (const [key, value] of Object.entries(settings.sampling)) {
    const wireKey = samplingParameterWireKey(key)
    if (!gate(wireKey)) continue
    wire[wireKey] = value
  }

  // Merge template stop sequences with user-specified stops. Template
  // stops are critical (they tell the server where the turn ends), so
  // they always ship even when `settings.stop` is empty.
  const templateStops =
    opts.promptSource.kind === 'client-template' ? opts.promptSource.template.stop : []
  const userStops = settings.stop ?? []
  const merged = Array.from(new Set([...userStops, ...templateStops]))
  if (merged.length > 0 && gate('stop')) {
    wire.stop = merged
  }
  if (settings.maxCompletionTokens !== undefined && settings.maxCompletionTokens >= 0) {
    // /v1/completions uses max_tokens. OpenRouter endpoint metadata is
    // chat-oriented here, so do not downgrade to max_completion_tokens.
    wire.max_tokens = settings.maxCompletionTokens
  }
  if (settings.logitBias && gate('logit_bias')) {
    wire.logit_bias = { ...settings.logitBias }
  }
  if (settings.cachePrompt === false && gate('cache_prompt')) {
    wire.cache_prompt = false
  }
  let reasoningBody: Record<string, unknown> | undefined
  if (gate('reasoning')) {
    const reasoning = buildReasoning(settings, opts.reasoningDialect === 'openrouter-text')
    if (reasoning) {
      wire.reasoning = reasoning
      reasoningBody = reasoning
    }
  }
  if (settings.verbosity && gate('verbosity')) {
    wire.verbosity = settings.verbosity
  }
  if (settings.serviceTier && settings.serviceTier !== 'auto' && gate('service_tier')) {
    wire.service_tier = settings.serviceTier
  }
  if (opts.allowProviderRouting === true && gate('provider')) {
    const providerBlock = buildProviderBlock(settings, opts.privacy)
    if (providerBlock) wire.provider = providerBlock
  }

  return {
    wire,
    requestedModel,
    reasoningCarryForwardEvidence: projectedPrompt.reasoning,
    reasoningVisibilityEvidence: inlineReasoningVisibilityEvidence(reasoningBody),
  }
}

function toWireResponseFormat(format: ChatSettings['responseFormat']): unknown {
  if (!format) return undefined
  if (format.type === 'text' || format.type === 'json_object') {
    return { type: format.type }
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: format.jsonSchema.name,
      schema: format.jsonSchema.schema,
      ...(format.jsonSchema.strict !== undefined ? { strict: format.jsonSchema.strict } : {}),
    },
  }
}

// Merge the user's manual `providerPrefs` with the privacy-filter's
// wire fragment, then apply the free-model exception. Returns
// `undefined` when neither side has anything to contribute (keeps the
// wire envelope clean for non-OpenRouter endpoints).
function buildProviderBlock(
  settings: ChatSettings,
  privacy: WireProviderPrivacy | undefined,
): Record<string, unknown> | undefined {
  const base = settings.providerPrefs ? toWireProviderPrefs(settings.providerPrefs) : {}
  if (privacy) {
    // Auto-ignore wins additively: user-ignored + Pareto-excluded + hard-
    // denied are unioned. `only` from the resolver is normalized to routing
    // refs, so it replaces raw stored settings instead of leaking display
    // names. `order` remains exclusively user-owned via `providerPrefs`.
    // `data_collection` / `zdr` come from `privacy.*`.
    if (privacy.ignore) base.ignore = privacy.ignore
    if (privacy.only) base.only = privacy.only
    if (privacy.order) base.order = privacy.order
    if (privacy.data_collection) base.data_collection = privacy.data_collection
    if (privacy.zdr) base.zdr = privacy.zdr
  }
  // `allowFallbacks` is a top-level ChatSettings knob (stored separately
  // from `providerPrefs` because it's not a provider preference — it's a
  // "may OpenRouter retry another allowed provider for this model?"
  // decision).
  if (settings.allowFallbacks === false) base.allow_fallbacks = false
  if (isFreeModel(settings.model)) {
    // Free-model exception. OpenRouter ignores these fields on `*:free`
    // models, so sending them is just noise.
    delete base.data_collection
    delete base.zdr
    delete base.only
    delete base.ignore
    delete base.order
  }
  return Object.keys(base).length > 0 ? base : undefined
}

function toWireProviderPrefs(
  prefs: NonNullable<ChatSettings['providerPrefs']>,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {}
  if (prefs.order) wire.order = [...prefs.order]
  if (prefs.requireParameters !== undefined) {
    wire.require_parameters = prefs.requireParameters
  }
  if (prefs.only) wire.only = [...prefs.only]
  if (prefs.ignore) wire.ignore = [...prefs.ignore]
  if (prefs.quantizations) wire.quantizations = [...prefs.quantizations]
  if (prefs.sort !== undefined) wire.sort = prefs.sort
  if (prefs.preferredMinThroughput !== undefined) {
    wire.preferred_min_throughput = prefs.preferredMinThroughput
  }
  if (prefs.preferredMaxLatency !== undefined) {
    wire.preferred_max_latency = prefs.preferredMaxLatency
  }
  if (prefs.maxPrice) wire.max_price = { ...prefs.maxPrice }
  return wire
}

function buildReasoning(
  settings: ChatSettings,
  allowIndependentDisplay = false,
): Record<string, unknown> | undefined {
  const reasoning = settings.reasoning
  if (reasoning.mode === 'default') {
    if (!allowIndependentDisplay) return undefined
    const body: Record<string, unknown> = {}
    if (reasoning.exclude) body.exclude = true
    else if (reasoning.summary && reasoning.summary !== 'off') body.summary = reasoning.summary
    return Object.keys(body).length > 0 ? body : undefined
  }
  if (reasoning.mode === 'off') {
    // Explicit "don't think". Providers that default-enable reasoning
    // (Claude 4.7 adaptive) need this form to actually stand down.
    return { enabled: false }
  }
  // Build the body from whichever knobs are set. `enabled: true` is
  // always emitted for non-default, non-off modes so the provider knows
  // reasoning is wanted. Summary and exclude ride along independently.
  const body: Record<string, unknown> = { enabled: true }
  if (reasoning.effort !== undefined) body.effort = reasoning.effort
  if (reasoning.maxTokens !== undefined) body.max_tokens = reasoning.maxTokens
  if (reasoning.exclude) body.exclude = true
  else if (reasoning.summary && reasoning.summary !== 'off') body.summary = reasoning.summary
  return body
}

function openAiReasoningVisibilityEvidence(
  dialect: Extract<ReasoningVisibilityEvidence, { kind: 'openai-family' }>['dialect'],
  body?: Readonly<Record<string, unknown>>,
  requestedSummary?: ChatSettings['reasoning']['summary'],
): Extract<ReasoningVisibilityEvidence, { kind: 'openai-family' }> {
  if (body?.enabled === false || body?.effort === 'none') {
    return Object.freeze({ kind: 'openai-family', dialect, activation: 'disabled' })
  }
  if (body?.exclude === true) {
    return Object.freeze({ kind: 'openai-family', dialect, activation: 'excluded' })
  }
  const providerDefaultsToVisible =
    dialect === 'openai-chat' || dialect === 'openrouter-chat' || dialect === 'openrouter-responses'
  return Object.freeze({
    kind: 'openai-family',
    dialect,
    activation: 'active',
    display:
      providerDefaultsToVisible || typeof body?.summary === 'string'
        ? 'available'
        : requestedSummary === 'off'
          ? 'request-omitted'
          : 'provider-default-omitted',
  })
}

function inlineReasoningVisibilityEvidence(
  body?: Readonly<Record<string, unknown>>,
): Extract<ReasoningVisibilityEvidence, { kind: 'inline' }> {
  return Object.freeze({
    kind: 'inline',
    activation:
      body?.enabled === false || body?.effort === 'none'
        ? 'disabled'
        : body?.exclude === true
          ? 'excluded'
          : 'active',
  })
}

// ---------------------------------------------------------------------------
// OpenAI Responses API transform.
// ---------------------------------------------------------------------------

export interface ResponsesTransformOptions {
  capabilities?: CapabilityDescriptor
  prefillPlan: PrefillPlan
  stream?: boolean
  rewriteSlug?: (slug: string) => string
  privacy?: WireProviderPrivacy
  allowProviderRouting?: boolean
  allowOpenRouterExtensions?: boolean
  hostedToolsProvider?: HostedToolProvider
  reasoning: ResponsesReasoningContract
  reasoningResolver?: OutboundReasoningResolver
  providerOutput: Extract<
    AttemptProviderOutputContract,
    { captureDialect: 'openai-responses' | 'openrouter-responses' }
  >
  reasoningCarryForwardByMessageId?: ReadonlyMap<MessageId, SealedReasoningCarryForward>
}

interface ResponsesTransformResult {
  wire: ResponsesRequestWire
  requestedModel: string
  reasoningCarryForward: SealedReasoningCarryForward
  reasoningVisibilityEvidence: ReasoningVisibilityEvidence
}

const RESPONSES_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'model',
  'input',
  'instructions',
  'stream',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'include',
  'store',
  'max_output_tokens',
  'provider',
])

export function toResponses(
  settings: ChatSettings,
  path: readonly Message[],
  opts: ResponsesTransformOptions,
): ResponsesTransformResult {
  const requestedModel = settings.model
  const wireModel = opts.rewriteSlug ? opts.rewriteSlug(requestedModel) : requestedModel
  const streaming = opts.stream !== false
  const caps = opts.capabilities
  const supported = caps?.supportedParameters
  const quirks = quirksFor(requestedModel)

  const rewritten = preparePrefillPathForWire(path, opts.prefillPlan)
  assertPrefillSerialization(rewritten, opts.prefillPlan, 'unsupported')
  const visible = rewritten.filter((m) => m.hiddenFromContext !== true && !m.deleted)
  const reasoningResolver = resolveOutboundReasoningResolver(
    { kind: 'responses', contract: opts.reasoning },
    opts.reasoningResolver,
  )
  const input: ResponsesInputItem[] = []
  let reasoningCarryForward: SealedReasoningCarryForward = 'none'

  // System prompt handling. The Responses API has a dedicated `instructions`
  // field; the first system/developer message goes there, and any SECOND
  // system message (rare but possible in imported transcripts) becomes a
  // `message` input item with role=system.
  const systemMessages = visible.filter((m) => m.role === 'system' || m.role === 'developer')
  let instructions: string | undefined
  if (systemMessages.length > 0) {
    instructions = systemMessages
      .flatMap((m) => m.content)
      .filter((c): c is Extract<ContentItem, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('\n\n')
  } else if (settings.systemPrompt.length > 0) {
    instructions = settings.systemPrompt
  }

  for (const message of visible) {
    if (message.role === 'system' || message.role === 'developer') continue
    const projected = messageToResponsesItems(
      message,
      opts.providerOutput,
      settings.toolCallContext.include,
      opts.reasoningCarryForwardByMessageId?.get(message.id) ?? 'none',
      reasoningResolver,
    )
    input.push(...projected.items)
    reasoningCarryForward = mergeSealedReasoningCarryForward(
      reasoningCarryForward,
      projected.reasoningCarryForward,
    )
  }

  const wire: ResponsesRequestWire = { model: wireModel, input }
  if (instructions !== undefined && instructions.length > 0) wire.instructions = instructions
  if (streaming) wire.stream = true

  // `supported` for non-OpenRouter endpoints is usually undefined → superset.
  const gate = (param: string): boolean => {
    if (RESPONSES_ENVELOPE_KEYS.has(param)) return true
    if (!supported) return true
    return supported.includes(param)
  }

  // Sampling (subject to gpt54SamplingGate below).
  for (const [key, value] of Object.entries(settings.sampling)) {
    if (!gate(key)) continue
    wire[key] = value
  }

  if (
    settings.maxCompletionTokens !== undefined &&
    settings.maxCompletionTokens >= 0 &&
    gate('max_output_tokens')
  ) {
    wire.max_output_tokens = settings.maxCompletionTokens
  }

  // Reasoning: build the sub-object if mode !== 'default'. (Same rule as chat.)
  let reasoningVisibilityEvidence = openAiReasoningVisibilityEvidence(
    opts.allowOpenRouterExtensions === true ? 'openrouter-responses' : 'openai-responses',
    undefined,
    settings.reasoning.summary,
  )
  if (gate('reasoning')) {
    const reasoningBody = buildResponsesReasoning(settings, opts.allowOpenRouterExtensions === true)
    if (reasoningBody) {
      wire.reasoning = reasoningBody
      reasoningVisibilityEvidence = openAiReasoningVisibilityEvidence(
        opts.allowOpenRouterExtensions === true ? 'openrouter-responses' : 'openai-responses',
        reasoningBody,
        settings.reasoning.summary,
      )
    }
  }

  if (gate('verbosity') && settings.verbosity !== undefined) {
    wire.text = { verbosity: settings.verbosity }
  }

  if (opts.allowProviderRouting === true && gate('provider')) {
    const providerBlock = buildProviderBlock(settings, opts.privacy)
    if (providerBlock) wire.provider = providerBlock
  }

  // `include: ['reasoning.encrypted_content']` — required for stateless
  // (`store: false`) Responses to get encrypted_content back. Only emit when
  // the carrier format is OpenAI-family AND the user wants encrypted carry-
  // forward.
  const responses = settings.responses
  if (opts.reasoning.include.encrypted) {
    wire.include = ['reasoning.encrypted_content']
  }

  // `store`: privacy default is `false` (stateless). User-exposed override
  // on `chat.settings.responses.store`.
  wire.store = responses?.store ?? false

  // Response format (OpenAI uses `text.format` on Responses, not `response_format`).
  if (settings.responseFormat && gate('response_format')) {
    const format = toResponsesTextFormat(settings.responseFormat)
    if (format !== undefined) {
      wire.text = { ...(wire.text ?? {}), format }
    }
  }

  if (opts.hostedToolsProvider === 'openrouter') {
    const toolBlock = openRouterHostedToolWireBlock(settings, gate, 'responses')
    if (toolBlock) Object.assign(wire, toolBlock)
  } else if (opts.hostedToolsProvider === 'openai') {
    const { tools, include } = buildOpenAiServerTools(settings)
    if (tools.length > 0 && gate('tools')) {
      const toolSettings = settings.tools.openai
      wire.tools = tools
      if (include.length > 0) wire.include = uniqueStrings([...(wire.include ?? []), ...include])
      if (toolSettings.toolChoice !== undefined && gate('tool_choice')) {
        wire.tool_choice = toolSettings.toolChoice
      }
      if (toolSettings.parallelToolCalls !== undefined && gate('parallel_tool_calls')) {
        wire.parallel_tool_calls = toolSettings.parallelToolCalls
      }
    }
  }

  // GPT-5.4 sampling gate — strip temp/top_p/logprobs when effort != none.
  adjustGpt54SamplingGate(wire, quirks)

  return { wire, requestedModel, reasoningCarryForward, reasoningVisibilityEvidence }
}

function buildResponsesReasoning(
  settings: ChatSettings,
  allowOpenRouterExtensions: boolean,
): ResponsesRequestWire['reasoning'] | undefined {
  const r = settings.reasoning
  if (r.mode === 'default') {
    const body: NonNullable<ResponsesRequestWire['reasoning']> = {}
    if (allowOpenRouterExtensions && r.exclude) body.exclude = true
    else if (r.summary && r.summary !== 'off') body.summary = r.summary
    return Object.keys(body).length > 0 ? body : undefined
  }
  if (r.mode === 'off') {
    return allowOpenRouterExtensions ? { enabled: false } : { effort: 'none' }
  }
  const body: NonNullable<ResponsesRequestWire['reasoning']> = {}
  if (allowOpenRouterExtensions) body.enabled = true
  if (r.effort !== undefined) body.effort = r.effort
  if (allowOpenRouterExtensions && r.exclude) body.exclude = true
  else if (r.summary && r.summary !== 'off') body.summary = r.summary
  return Object.keys(body).length > 0 ? body : undefined
}

function toResponsesTextFormat(
  format: ChatSettings['responseFormat'],
): { type: string; [k: string]: unknown } | undefined {
  if (!format) return undefined
  if (format.type === 'text' || format.type === 'json_object') return { type: format.type }
  return {
    type: 'json_schema',
    name: format.jsonSchema.name,
    schema: format.jsonSchema.schema,
    ...(format.jsonSchema.strict !== undefined ? { strict: format.jsonSchema.strict } : {}),
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

// Translate ONE `Message` into one or more Responses input items. Rules:
//   - user → single `{type:'message', role:'user', content}` item.
//   - assistant with text + optional reasoning → canonical reasoning item first
//     (if any include flags are true), then a message item.
//   - assistant with tool calls → one `{type:'function_call', …}` item per call.
//   - tool (role:'tool') → `{type:'function_call_output', call_id, output}`.
function messageToResponsesItems(
  message: Message,
  providerOutput: Extract<
    AttemptProviderOutputContract,
    { captureDialect: 'openai-responses' | 'openrouter-responses' }
  >,
  includeToolCalls: boolean,
  rewrittenReasoningCarryForward: SealedReasoningCarryForward,
  reasoningResolver: OutboundReasoningResolver,
): { items: ResponsesInputItem[]; reasoningCarryForward: SealedReasoningCarryForward } {
  if (message.role === 'tool') {
    const callId = message.toolCalls?.[0]?.id ?? ''
    const output = message.content
      .filter((c): c is Extract<ContentItem, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('')
    return {
      items: [{ type: 'function_call_output', call_id: callId, output }],
      reasoningCarryForward: 'none',
    }
  }

  if (message.role === 'user') {
    return {
      items: [
        {
          type: 'message',
          role: 'user',
          content: buildUserContentParts(message.content),
        },
      ],
      reasoningCarryForward: 'none',
    }
  }

  if (message.role === 'assistant') {
    const appliedView = createAppliedMessageView(message)
    const items: ResponsesInputItem[] = []
    const projectedProviderOutput = projectProviderOutputForContext(appliedView, providerOutput, {
      includeToolCalls,
    })
    items.push(
      ...(materializeNativeProviderOutput(projectedProviderOutput) as ResponsesInputItem[]),
    )
    const unsupportedToolText = renderProviderOutputContextFallback(projectedProviderOutput)

    const compiledReasoning = reasoningResolver.compilationFor(message)
    if (compiledReasoning.kind !== 'responses') {
      throw new Error(`ReasoningRouteMismatch:responses:${message.id}`)
    }
    items.push(
      ...responsesReasoningInputItems(
        compiledReasoning.attempts.flatMap((attempt) => attempt.units),
      ),
    )
    const reasoningCarryForward = mergeSealedReasoningCarryForward(
      compiledReasoning.reasoningCarryForward,
      rewrittenReasoningCarryForward,
    )

    const outputContent = responsesOutputTextParts(message.content)
    const reasoningFallback = compiledReasoning.inline
    if (reasoningFallback) {
      const first = outputContent[0]
      if (first && typeof first.text === 'string') {
        first.text = `${reasoningFallback}\n\n${first.text}`
      } else {
        outputContent.unshift({ type: 'output_text', text: reasoningFallback })
      }
    }
    if (unsupportedToolText) {
      const last = outputContent.at(-1)
      if (last && typeof last.text === 'string')
        last.text = `${last.text}\n\n${unsupportedToolText}`
      else outputContent.push({ type: 'output_text', text: unsupportedToolText })
    }
    if (outputContent.length > 0 || appliedView.toolCalls.length === 0) {
      const item: ResponsesInputItem = {
        type: 'message',
        role: 'assistant',
        content: outputContent.length > 0 ? outputContent : [{ type: 'output_text', text: '' }],
      }
      if (appliedView.phase !== undefined) item.phase = appliedView.phase
      items.push(item)
    }

    // Tool calls ride as separate function_call items regardless of echo item.
    for (const call of appliedView.toolCalls) {
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })
    }

    return { items, reasoningCarryForward }
  }

  // Unknown role — pass through as a message item so nothing is dropped.
  return {
    items: [
      {
        type: 'message',
        role: message.role,
        content: buildUserContentParts(message.content),
      },
    ],
    reasoningCarryForward: 'none',
  }
}

function responsesReasoningInputItems(
  units: readonly CompiledResponsesReasoningUnit[],
): ResponsesInputItem[] {
  return units.map((unit) => ({
    type: 'reasoning',
    summary: unit.summaries.map((summary) => ({
      type: 'summary_text',
      text: summary.text,
    })),
    ...(unit.providerItemId ? { id: unit.providerItemId } : {}),
    ...(unit.encryptedContent !== undefined ? { encrypted_content: unit.encryptedContent } : {}),
  }))
}

function buildUserContentParts(items: ContentItem[]): unknown[] {
  const out: unknown[] = []
  for (const item of items) {
    if (item.type === 'text') {
      out.push({ type: 'input_text', text: item.text })
    } else if (item.type === 'output_text') {
      out.push({ type: 'input_text', text: item.text })
    } else if (item.type === 'image_url' && item.url) {
      const part: { type: string; image_url: string; detail?: string } = {
        type: 'input_image',
        image_url: item.url,
      }
      if (item.detail) part.detail = item.detail
      out.push(part)
    } else if (item.type === 'file' && (item.url || item.filename)) {
      out.push({
        type: 'input_file',
        ...(item.url ? { file_url: item.url } : {}),
        filename: item.filename,
      })
    }
    // Non-text/image/file items are Phase 12+ territory; Phase 11 drops silently.
  }
  return out
}

function toChatReasoningDetail(detail: ReasoningDetail): ReasoningDetail {
  const {
    providerItemId: _providerItemId,
    providerOutputIndex: _providerOutputIndex,
    providerSummaryIndex: _providerSummaryIndex,
    ...wire
  } = detail
  if (typeof wire.id === 'string' && /^(rs|msg)_tmp_/.test(wire.id)) {
    const { id: _id, ...withoutTemporaryId } = wire
    return withoutTemporaryId
  }
  return wire
}

// ---------------------------------------------------------------------------
// Anthropic Messages API transform.
// ---------------------------------------------------------------------------

export interface AnthropicMessagesTransformOptions {
  capabilities?: CapabilityDescriptor
  prefillPlan: PrefillPlan
  stream?: boolean
  rewriteSlug?: (slug: string) => string
  reasoning: AnthropicReasoningContract
  reasoningResolver?: OutboundReasoningResolver
  providerOutput: Extract<AttemptProviderOutputContract, { captureDialect: 'anthropic-claude' }>
  hostedToolsProvider?: HostedToolProvider
  reasoningCarryForwardByMessageId?: ReadonlyMap<MessageId, SealedReasoningCarryForward>
}

interface AnthropicMessagesTransformResult {
  wire: AnthropicMessagesRequestWire
  requestedModel: string
  modelId: string
  reasoningCarryForward: SealedReasoningCarryForward
  reasoningVisibilityEvidence: ReasoningVisibilityEvidence
}

export function toAnthropicMessages(
  settings: ChatSettings,
  path: readonly Message[],
  opts: AnthropicMessagesTransformOptions,
): AnthropicMessagesTransformResult {
  const requestedModel = settings.model
  const rewritten = opts.rewriteSlug ? opts.rewriteSlug(requestedModel) : requestedModel
  const modelId = normalizeAnthropicModelId(rewritten)
  const streaming = opts.stream !== false
  const supported = opts.capabilities?.supportedParameters
  const gate = (param: string): boolean => {
    if (!supported) return true
    return supported.includes(param)
  }

  const rewrittenPath = preparePrefillPathForWire(path, opts.prefillPlan)
  assertPrefillSerialization(rewrittenPath, opts.prefillPlan, 'assistant-tail')
  const visible = rewrittenPath.filter((m) => m.hiddenFromContext !== true && !m.deleted)
  const reasoningResolver = resolveOutboundReasoningResolver(
    { kind: 'anthropic', contract: opts.reasoning },
    opts.reasoningResolver,
  )
  const messages: AnthropicMessageWire[] = []
  let reasoningCarryForward: SealedReasoningCarryForward = 'none'

  const systemMessages = visible.filter((m) => m.role === 'system' || m.role === 'developer')
  let systemText = ''
  if (systemMessages.length > 0) {
    systemText = systemMessages
      .flatMap((m) => m.content)
      .filter(
        (c): c is Extract<ContentItem, { type: 'text' | 'output_text' }> =>
          c.type === 'text' || c.type === 'output_text',
      )
      .map((c) => c.text)
      .join('\n\n')
  } else if (settings.systemPrompt.length > 0) {
    systemText = settings.systemPrompt
  }

  for (const message of visible) {
    if (message.role === 'system' || message.role === 'developer') continue
    const projected = messageToAnthropicMessages(
      message,
      settings.toolCallContext.include,
      opts.providerOutput,
      opts.reasoningCarryForwardByMessageId?.get(message.id) ?? 'none',
      reasoningResolver,
    )
    messages.push(...projected.messages)
    reasoningCarryForward = mergeSealedReasoningCarryForward(
      reasoningCarryForward,
      projected.reasoningCarryForward,
    )
  }

  const wire: AnthropicMessagesRequestWire = {
    model: modelId,
    max_tokens:
      settings.maxCompletionTokens !== undefined && settings.maxCompletionTokens > 0
        ? settings.maxCompletionTokens
        : 4096,
    messages,
  }
  if (streaming) wire.stream = true
  if (systemText.length > 0) wire.system = systemText

  if (settings.sampling.temperature !== undefined && gate('temperature')) {
    wire.temperature = settings.sampling.temperature
  }
  if (settings.sampling.top_p !== undefined && gate('top_p')) wire.top_p = settings.sampling.top_p
  if (settings.sampling.top_k !== undefined && gate('top_k')) wire.top_k = settings.sampling.top_k
  if (settings.stop && settings.stop.length > 0 && gate('stop_sequences')) {
    wire.stop_sequences = [...settings.stop]
  }

  let reasoningVisibilityEvidence = anthropicReasoningVisibilityEvidence()
  if (gate('thinking')) {
    const thinking = buildAnthropicThinking(settings)
    if (thinking) {
      wire.thinking = thinking
      reasoningVisibilityEvidence = anthropicReasoningVisibilityEvidence(thinking)
    }
  }
  if (settings.verbosity !== undefined && gate('verbosity')) {
    wire.output_config = { effort: settings.verbosity }
  }

  if (opts.hostedToolsProvider === 'anthropic') {
    const tools = buildAnthropicServerTools(settings)
    if (tools.length > 0) {
      wire.tools = tools
      const toolChoice = anthropicToolChoice(settings.tools.anthropic.toolChoice)
      if (toolChoice !== undefined) wire.tool_choice = toolChoice
    }
  }

  return {
    wire,
    requestedModel,
    modelId,
    reasoningCarryForward,
    reasoningVisibilityEvidence,
  }
}

function normalizeAnthropicModelId(modelId: string): string {
  const slash = modelId.indexOf('/')
  return (slash >= 0 ? modelId.slice(slash + 1) : modelId).replace(/(\d)\.(\d)(?=-|$)/g, '$1-$2')
}

function buildAnthropicThinking(settings: ChatSettings): Record<string, unknown> | undefined {
  const r = settings.reasoning
  if (r.mode === 'default') return undefined
  if (r.mode === 'off') return { type: 'disabled' }

  const quirks = quirksFor(settings.model)
  const supportsDisplay = reasoningVisibilityPolicyFromQuirks(quirks).kind === 'anthropic-summary'
  if (quirks.adaptiveReasoningOnly === true) return anthropicAdaptiveThinking(r, supportsDisplay)

  const modelId = normalizeAnthropicModelId(settings.model)
  const isClaude46 = /^claude-(?:opus|sonnet)-4-6(?:-|$)/u.test(modelId)

  if (isClaude46 && r.mode !== 'budget') return anthropicAdaptiveThinking(r, supportsDisplay)
  if (isClaude46 && r.maxTokens === undefined) return anthropicAdaptiveThinking(r, supportsDisplay)

  const out: Record<string, unknown> = { type: 'enabled' }
  if (r.maxTokens !== undefined) out.budget_tokens = r.maxTokens
  const display = supportsDisplay ? anthropicThinkingDisplay(r) : undefined
  if (display) out.display = display
  return out
}

function anthropicAdaptiveThinking(
  r: ChatSettings['reasoning'],
  supportsDisplay: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = { type: 'adaptive' }
  const display = supportsDisplay ? anthropicThinkingDisplay(r) : undefined
  if (display) out.display = display
  return out
}

function anthropicThinkingDisplay(
  r: ChatSettings['reasoning'],
): 'summarized' | 'omitted' | undefined {
  if (r.exclude || r.summary === 'off') return 'omitted'
  if (r.summary !== undefined) return 'summarized'
  return undefined
}

function anthropicReasoningVisibilityEvidence(
  thinking?: Readonly<Record<string, unknown>>,
): Extract<ReasoningVisibilityEvidence, { kind: 'anthropic' }> {
  const display =
    thinking?.type === 'disabled'
      ? 'disabled'
      : thinking?.display === 'summarized'
        ? 'summarized'
        : thinking?.display === 'omitted'
          ? 'omitted'
          : 'provider-default'
  return Object.freeze({ kind: 'anthropic', display })
}

function anthropicToolChoice(choice: ChatSettings['tools']['anthropic']['toolChoice']): unknown {
  if (choice === undefined) return undefined
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'none') return { type: 'none' }
  if (choice === 'required') return { type: 'any' }
  return { type: 'tool', name: choice.function.name }
}

function messageToAnthropicMessages(
  message: Message,
  includeToolCalls: boolean,
  providerOutput: Extract<AttemptProviderOutputContract, { captureDialect: 'anthropic-claude' }>,
  rewrittenReasoningCarryForward: SealedReasoningCarryForward,
  reasoningResolver: OutboundReasoningResolver,
): { messages: AnthropicMessageWire[]; reasoningCarryForward: SealedReasoningCarryForward } {
  if (message.role === 'tool') {
    const call = message.toolCalls?.[0]
    const contentText = message.content
      .filter(
        (c): c is Extract<ContentItem, { type: 'text' | 'output_text' }> =>
          c.type === 'text' || c.type === 'output_text',
      )
      .map((c) => c.text)
      .join('')
    return {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: call?.id ?? '',
              content: contentText,
            },
          ],
        },
      ],
      reasoningCarryForward: 'none',
    }
  }

  if (message.role === 'user') {
    return {
      messages: [{ role: 'user', content: buildAnthropicUserBlocks(message.content) }],
      reasoningCarryForward: 'none',
    }
  }

  if (message.role === 'assistant') {
    const appliedView = createAppliedMessageView(message)
    const content: AnthropicContentBlock[] = []
    const projectedProviderOutput = projectProviderOutputForContext(appliedView, providerOutput, {
      includeToolCalls,
    })
    const unsupportedToolText = renderProviderOutputContextFallback(projectedProviderOutput)

    const compiledReasoning = reasoningResolver.compilationFor(message)
    if (compiledReasoning.kind !== 'anthropic') {
      throw new Error(`ReasoningRouteMismatch:anthropic:${message.id}`)
    }
    const reasoningCarryForward = mergeSealedReasoningCarryForward(
      rewrittenReasoningCarryForward,
      compiledReasoning.reasoningCarryForward,
    )
    for (const attempt of compiledReasoning.attempts) {
      for (const unit of attempt.units) {
        if (unit.kind === 'thinking-authenticated') {
          content.push({
            type: 'thinking',
            thinking: unit.text,
            signature: unit.signature,
          })
        } else {
          content.push({ type: 'redacted_thinking', data: unit.data })
        }
      }
    }

    const reasoningFallback = compiledReasoning.inline
    if (reasoningFallback) {
      content.push({ type: 'text', text: reasoningFallback })
    }

    content.push(
      ...(materializeNativeProviderOutput(projectedProviderOutput) as AnthropicContentBlock[]),
    )

    for (const item of message.content) {
      if (item.type !== 'text' && item.type !== 'output_text') continue
      const citations =
        item.type === 'output_text' ? anthropicWireCitations(item.annotations) : undefined
      content.push({
        type: 'text',
        text: item.text,
        ...(citations ? { citations } : {}),
      })
    }
    if (unsupportedToolText) {
      let lastText: AnthropicContentBlock | undefined
      for (let index = content.length - 1; index >= 0; index -= 1) {
        if (content[index]?.type !== 'text') continue
        lastText = content[index]
        break
      }
      if (lastText && typeof lastText.text === 'string') {
        lastText.text = `${lastText.text}\n\n${unsupportedToolText}`
      } else content.push({ type: 'text', text: unsupportedToolText })
    }

    for (const call of appliedView.toolCalls) {
      let input: Record<string, unknown> | undefined
      try {
        const parsed: unknown = JSON.parse(call.function.arguments)
        input =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined
      } catch {
        input = undefined
      }
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: input ?? { arguments: call.function.arguments },
      })
    }

    return {
      messages: content.length > 0 ? [{ role: 'assistant', content }] : [],
      reasoningCarryForward,
    }
  }

  return { messages: [], reasoningCarryForward: 'none' }
}

function responsesOutputTextParts(content: readonly ContentItem[]): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = []
  for (const item of content) {
    if (item.type !== 'text' && item.type !== 'output_text') continue
    const annotations =
      item.type === 'output_text' ? responsesWireAnnotations(item.annotations) : undefined
    parts.push({
      type: 'output_text',
      text: item.text,
      ...(annotations ? { annotations } : {}),
    })
  }
  return parts
}

function buildAnthropicUserBlocks(items: ContentItem[]): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = []
  for (const item of items) {
    if (item.type === 'text' || item.type === 'output_text') {
      blocks.push({ type: 'text', text: item.text })
    } else if (item.type === 'image_url' && item.url) {
      const source = anthropicImageSource(item.url)
      if (source) {
        blocks.push({
          type: 'image',
          source,
        })
      }
    }
  }
  return blocks
}

function anthropicImageSource(
  url: string,
): { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } | null {
  if (/^data:/u.test(url)) {
    const match = /^data:([^;]+);base64,(.+)$/u.exec(url)
    if (!match?.[1] || !match[2]) return null
    return { type: 'base64', media_type: match[1], data: match[2] }
  }
  if (/^https?:/iu.test(url)) return { type: 'url', url }
  return null
}

// ---------------------------------------------------------------------------
// Google Gemini native generateContent transform.
// ---------------------------------------------------------------------------

export interface GeminiNativeTransformOptions {
  capabilities?: CapabilityDescriptor
  prefillPlan: PrefillPlan
  rewriteSlug?: (slug: string) => string
  reasoning: GeminiReasoningContract
  reasoningResolver?: OutboundReasoningResolver
  providerOutput: Extract<AttemptProviderOutputContract, { captureDialect: 'google-gemini' }>
  hostedToolsProvider?: HostedToolProvider
  reasoningCarryForwardByMessageId?: ReadonlyMap<MessageId, SealedReasoningCarryForward>
}

interface GeminiNativeTransformResult {
  wire: GenerateContentRequestWire
  // The model id the caller should pass to `geminiStream()` /
  // `geminiOnce()` — stripped of any provider prefix.
  modelId: string
  requestedModel: string
  reasoningCarryForward: SealedReasoningCarryForward
  reasoningVisibilityEvidence: ReasoningVisibilityEvidence
}

// Per-family thinkingBudget tables for Gemini 2.5. Only `gemini-2.5-flash`
// accepts `thinkingBudget: 0` (soft disable). `2.5-pro` floor is 128 (can't
// disable); `2.5-flash-lite` floor is 512 (can't disable, off by default
// anyway). Max budgets also differ — Pro caps at 32768, the two Flash
// tiers cap at 24576. See Google's Vertex thinking docs.
const BUDGET_TABLE_GEMINI_2_5_FLASH: Partial<Record<EffortLevel, number>> = {
  minimal: 128,
  low: 512,
  medium: 2048,
  high: 8192,
  xhigh: 24576,
  max: 24576,
  none: 0,
}
const BUDGET_TABLE_GEMINI_2_5_PRO: Partial<Record<EffortLevel, number>> = {
  // Pro floor is 128; `none` / `minimal` both clamp to the floor.
  minimal: 128,
  low: 512,
  medium: 2048,
  high: 8192,
  xhigh: 32768,
  max: 32768,
}
const BUDGET_TABLE_GEMINI_2_5_FLASH_LITE: Partial<Record<EffortLevel, number>> = {
  // Flash-Lite floor is 512; minimal clamps up to the floor.
  minimal: 512,
  low: 512,
  medium: 2048,
  high: 8192,
  xhigh: 24576,
  max: 24576,
}

type GeminiFamily =
  | 'gemini-3-pro'
  | 'gemini-3-flash'
  | 'gemini-2.5-pro'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-flash-lite'
  | null

// Detect Gemini family for thinking-config branching. Per Google's thinking
// docs:
//   - Gemini 3.x uses `thinkingLevel` (enum): Pro = low/med/high;
//     Flash/Flash-Lite = minimal/low/med/high.
//   - Gemini 2.5 uses `thinkingBudget` (int); Pro can't disable, Flash can
//     disable via 0, Flash-Lite can't disable (floor 512).
// Gemini 3 Flash-Lite intentionally shares the Flash enum path; for 2.5,
// check `flash-lite` before `flash` since the former's slug also matches
// the latter's prefix.
function geminiFamily(modelId: string): GeminiFamily {
  const slash = modelId.indexOf('/')
  const stripped = (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase()
  if (/^gemini-3(?:[.-]\d+)?-pro(?:$|-)/u.test(stripped)) return 'gemini-3-pro'
  if (/^gemini-3(?:[.-]\d+)?-flash(?:$|-)/u.test(stripped)) return 'gemini-3-flash'
  if (stripped.startsWith('gemini-2.5-flash-lite')) return 'gemini-2.5-flash-lite'
  if (stripped.startsWith('gemini-2.5-flash')) return 'gemini-2.5-flash'
  if (stripped.startsWith('gemini-2.5-pro')) return 'gemini-2.5-pro'
  return null
}

function isGemini3(modelId: string): boolean {
  const fam = geminiFamily(modelId)
  return fam === 'gemini-3-pro' || fam === 'gemini-3-flash'
}

export function toGeminiNative(
  settings: ChatSettings,
  path: readonly Message[],
  opts: GeminiNativeTransformOptions,
): GeminiNativeTransformResult {
  const requestedModel = settings.model
  const rewritten = opts.rewriteSlug ? opts.rewriteSlug(requestedModel) : requestedModel
  const slash = rewritten.indexOf('/')
  const modelId = slash >= 0 ? rewritten.slice(slash + 1) : rewritten

  const prefillRewritten = preparePrefillPathForWire(path, opts.prefillPlan)
  assertPrefillSerialization(prefillRewritten, opts.prefillPlan, 'native-model-tail')
  const visible = prefillRewritten.filter((m) => m.hiddenFromContext !== true && !m.deleted)
  const reasoningResolver = resolveOutboundReasoningResolver(
    { kind: 'gemini', contract: opts.reasoning },
    opts.reasoningResolver,
  )
  const contents: GeminiContent[] = []
  let reasoningCarryForward: SealedReasoningCarryForward = 'none'

  // System messages → `systemInstruction`. Any leading system/developer
  // messages are concatenated with a blank-line separator. If the chat has
  // a `settings.systemPrompt` and the path doesn't already carry a system
  // message, the prompt becomes the systemInstruction.
  const systemMessages = visible.filter((m) => m.role === 'system' || m.role === 'developer')
  let systemText = ''
  if (systemMessages.length > 0) {
    systemText = systemMessages
      .flatMap((m) => m.content)
      .filter((c): c is Extract<ContentItem, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('\n\n')
  } else if (settings.systemPrompt.length > 0) {
    systemText = settings.systemPrompt
  }

  for (const message of visible) {
    if (message.role === 'system' || message.role === 'developer') continue
    const projected = messageToGeminiContents(
      message,
      settings.toolCallContext.include,
      opts.providerOutput,
      opts.reasoningCarryForwardByMessageId?.get(message.id) ?? 'none',
      reasoningResolver,
    )
    contents.push(...projected.contents)
    reasoningCarryForward = mergeSealedReasoningCarryForward(
      reasoningCarryForward,
      projected.reasoningCarryForward,
    )
  }

  const wire: GenerateContentRequestWire = { contents }
  if (systemText.length > 0) {
    wire.systemInstruction = { role: 'system', parts: [{ text: systemText }] }
  }

  const generationConfig: GenerationConfig = {}
  if (settings.sampling.temperature !== undefined)
    generationConfig.temperature = settings.sampling.temperature
  if (settings.sampling.top_p !== undefined) generationConfig.topP = settings.sampling.top_p
  if (settings.sampling.top_k !== undefined) generationConfig.topK = settings.sampling.top_k
  if (settings.maxCompletionTokens !== undefined && settings.maxCompletionTokens >= 0) {
    // -1 is the local "unlimited" sentinel; never send it on the wire.
    // Matches the chat-completions gate above.
    generationConfig.maxOutputTokens = settings.maxCompletionTokens
  }
  if (settings.stop && settings.stop.length > 0) {
    generationConfig.stopSequences = [...settings.stop]
  }

  // Response format → Gemini native responseMimeType + responseJsonSchema.
  if (settings.responseFormat) {
    if (settings.responseFormat.type === 'json_object') {
      generationConfig.responseMimeType = 'application/json'
    } else if (settings.responseFormat.type === 'json_schema') {
      generationConfig.responseMimeType = 'application/json'
      generationConfig.responseJsonSchema = settings.responseFormat.jsonSchema.schema
    }
  }

  const thinkingConfig = buildThinkingConfig(settings, modelId, BUDGET_TABLE_GEMINI_2_5_FLASH)
  if (thinkingConfig !== undefined) generationConfig.thinkingConfig = thinkingConfig
  const reasoningVisibilityEvidence = geminiReasoningVisibilityEvidence(
    thinkingConfig,
    settings.reasoning.exclude || settings.reasoning.summary === 'off',
  )

  if (Object.keys(generationConfig).length > 0) wire.generationConfig = generationConfig

  if (settings.gemini?.cachedContentName) {
    wire.cachedContent = settings.gemini.cachedContentName
  }
  if (opts.hostedToolsProvider === 'google') {
    const { tools, toolConfig } = buildGoogleServerTools(settings, {
      urlContextText: geminiRequestText(wire),
    })
    if (tools.length > 0) {
      wire.tools = tools
      if (toolConfig !== undefined) wire.toolConfig = toolConfig
    }
  }

  return {
    wire,
    modelId,
    requestedModel,
    reasoningCarryForward,
    reasoningVisibilityEvidence,
  }
}

function geminiReasoningVisibilityEvidence(
  thinking: ThinkingConfig | undefined,
  displayDisabled: boolean,
): Extract<ReasoningVisibilityEvidence, { kind: 'gemini' }> {
  if (thinking?.thinkingBudget === 0) {
    return Object.freeze({ kind: 'gemini', thoughts: 'omitted', omittedReason: 'disabled' })
  }
  if (thinking?.includeThoughts === true) {
    return Object.freeze({
      kind: 'gemini',
      thoughts: 'included',
      omittedReason: 'provider-default',
    })
  }
  return Object.freeze({
    kind: 'gemini',
    thoughts: 'omitted',
    omittedReason: displayDisabled ? 'request-display' : 'provider-default',
  })
}

function geminiRequestText(wire: GenerateContentRequestWire): string {
  const parts = [wire.systemInstruction, ...wire.contents]
  return parts
    .flatMap((content) => content?.parts ?? [])
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

function buildThinkingConfig(
  settings: ChatSettings,
  modelId: string,
  budgetTable: Partial<Record<EffortLevel, number>>,
): ThinkingConfig | undefined {
  const r = settings.reasoning
  const out: ThinkingConfig = {}
  const family = geminiFamily(modelId)
  // `includeThoughts` flips on whenever the user wants a visible summary —
  // that's `settings.reasoning.summary !== 'off'`. When undefined, defer to
  // the provider's default (don't emit includeThoughts).
  if (!r.exclude && r.summary && r.summary !== 'off') out.includeThoughts = true

  if (r.mode === 'off') {
    // Per Google thinking docs: only Gemini 2.5 Flash supports disabling
    // (thinkingBudget: 0). Gemini 3 Pro / 2.5 Pro / 2.5 Flash-Lite CANNOT
    // be disabled — emit nothing (provider default) rather than an invalid
    // value. Gemini 3 Flash soft-disables via thinkingLevel: 'minimal'.
    if (family === 'gemini-2.5-flash') {
      out.thinkingBudget = 0
    } else if (family === 'gemini-3-flash') {
      out.thinkingLevel = 'minimal'
    }
    // else: 'off' has no valid wire representation — leave unset so the
    // provider uses its default (which is typically dynamic/high anyway).
  } else if (r.mode !== 'default' && r.effort !== undefined) {
    if (family === 'gemini-3-pro') {
      // Pro has no `minimal` — clamp minimal/none up to low.
      out.thinkingLevel = mapEffortToThinkingLevelPro(r.effort)
    } else if (family === 'gemini-3-flash') {
      out.thinkingLevel = mapEffortToThinkingLevelFlash(r.effort)
    } else if (family === 'gemini-2.5-flash') {
      const budget = BUDGET_TABLE_GEMINI_2_5_FLASH[r.effort] ?? budgetTable[r.effort]
      if (budget !== undefined) out.thinkingBudget = budget
    } else if (family === 'gemini-2.5-pro') {
      const budget = BUDGET_TABLE_GEMINI_2_5_PRO[r.effort]
      // Pro can't disable — if the map doesn't have a value (e.g. 'none'),
      // omit the field rather than sending an invalid budget.
      if (budget !== undefined) out.thinkingBudget = budget
    } else if (family === 'gemini-2.5-flash-lite') {
      const budget = BUDGET_TABLE_GEMINI_2_5_FLASH_LITE[r.effort]
      if (budget !== undefined) out.thinkingBudget = budget
    } else {
      // Unknown Gemini family — fall back to the caller-supplied table.
      // Preserves the option override for future models / tests.
      const budget = budgetTable[r.effort]
      if (budget !== undefined) out.thinkingBudget = budget
    }
  } else if (r.maxTokens !== undefined && !isGemini3(modelId)) {
    // User explicitly set a budget on a 2.5 family model.
    out.thinkingBudget = r.maxTokens
  }

  return Object.keys(out).length > 0 ? out : undefined
}

// Gemini 3 Pro / 3.1 Pro — enum low/medium/high (NO minimal per Google docs).
// Pro models cannot be disabled; `none` and `minimal` clamp to `low` since
// `low` is the weakest valid setting.
function mapEffortToThinkingLevelPro(effort: EffortLevel): 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high'
    default:
      return 'medium'
  }
}

// Gemini 3 Flash / 3.1 Flash(-Lite) — enum minimal/low/medium/high.
// `minimal` is the soft-disable; `xhigh` clamps to `high`.
function mapEffortToThinkingLevelFlash(effort: EffortLevel): 'minimal' | 'low' | 'medium' | 'high' {
  switch (effort) {
    case 'none':
    case 'minimal':
      return 'minimal'
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high'
    default:
      return 'medium'
  }
}

// Translate one `Message` into one or more GeminiContent entries. Rules:
//   - user message → one `{role:'user', parts}` entry.
//   - assistant message → one `{role:'model', parts}` entry. Reasoning
//     summary parts (thought:true) come FIRST, then answer parts, then the
//     thoughtSignature attaches to the LAST part (Gemini 3 rule).
//   - tool message (role:'tool') → `{role:'user', parts: [{functionResponse}]}`
//     per `gemini_docs/guides/function-calling.md`.
function messageToGeminiContents(
  message: Message,
  includeToolCalls: boolean,
  providerOutput: Extract<AttemptProviderOutputContract, { captureDialect: 'google-gemini' }>,
  rewrittenReasoningCarryForward: SealedReasoningCarryForward,
  reasoningResolver: OutboundReasoningResolver,
): { contents: GeminiContent[]; reasoningCarryForward: SealedReasoningCarryForward } {
  if (message.role === 'tool') {
    const call = message.toolCalls?.[0]
    const responseText = message.content
      .filter((c): c is Extract<ContentItem, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('')
    let response: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(responseText)
      response =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { result: responseText }
    } catch {
      response = { result: responseText }
    }
    return {
      contents: [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: call?.function.name ?? 'tool',
                response,
                ...(call?.id ? { id: call.id } : {}),
              },
            },
          ],
        },
      ],
      reasoningCarryForward: 'none',
    }
  }

  if (message.role === 'user') {
    return {
      contents: [{ role: 'user', parts: buildGeminiUserParts(message.content) }],
      reasoningCarryForward: 'none',
    }
  }

  if (message.role === 'assistant') {
    const appliedView = createAppliedMessageView(message)
    const parts: GeminiPart[] = []
    const projectedProviderOutput = projectProviderOutputForContext(appliedView, providerOutput, {
      includeToolCalls,
    })
    const unsupportedToolText = renderProviderOutputContextFallback(projectedProviderOutput)
    const compiledReasoning = reasoningResolver.compilationFor(message)
    if (compiledReasoning.kind !== 'gemini') {
      throw new Error(`ReasoningRouteMismatch:gemini:${message.id}`)
    }
    const reasoningCarryForward = mergeSealedReasoningCarryForward(
      rewrittenReasoningCarryForward,
      compiledReasoning.reasoningCarryForward,
    )
    const unboundThoughtSignatures: string[] = []
    const visibleOnlyThoughts: string[] = []
    const flushVisibleOnlyThoughts = () => {
      if (visibleOnlyThoughts.length === 0) return
      parts.push({ text: visibleOnlyThoughts.join('\n\n'), thought: true })
      visibleOnlyThoughts.length = 0
    }
    for (const attempt of compiledReasoning.attempts) {
      for (const unit of attempt.units) {
        if (unit.kind === 'bound-thought') {
          flushVisibleOnlyThoughts()
          parts.push({
            text: unit.text,
            thought: true,
            thoughtSignature: unit.signature,
          })
        } else if (unit.kind === 'unbound-signature') {
          flushVisibleOnlyThoughts()
          unboundThoughtSignatures.push(unit.signature)
        } else {
          visibleOnlyThoughts.push(unit.text)
        }
      }
    }
    flushVisibleOnlyThoughts()
    const reasoningPartCount = parts.length

    parts.push(...(materializeNativeProviderOutput(projectedProviderOutput) as GeminiPart[]))

    // 3. The answer text.
    const answerText = message.content
      .filter(
        (c): c is Extract<ContentItem, { type: 'text' | 'output_text' }> =>
          c.type === 'text' || c.type === 'output_text',
      )
      .map((c) => c.text)
      .join('')
    const outputText =
      unsupportedToolText && answerText.length > 0
        ? `${answerText}\n\n${unsupportedToolText}`
        : (unsupportedToolText ?? answerText)
    if (outputText.length > 0) {
      parts.push({ text: outputText })
    }

    // 4. Tool calls → functionCall parts.
    for (const call of appliedView.toolCalls) {
      let args: Record<string, unknown> | undefined
      try {
        const parsed: unknown = JSON.parse(call.function.arguments)
        args =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined
      } catch {
        args = undefined
      }
      const functionCall: GeminiPart = {
        functionCall: {
          name: call.function.name,
          ...(args ? { args } : {}),
          ...(call.id ? { id: call.id } : {}),
        },
      }
      parts.push(functionCall)
    }

    if (unboundThoughtSignatures.length === 1) {
      if (parts.length === 0) parts.push({ text: '' })
      const anchor = geminiThoughtSignatureAnchor(parts)
      if (anchor) anchor.thoughtSignature = unboundThoughtSignatures[0] as string
    } else if (unboundThoughtSignatures.length > 1) {
      parts.splice(
        reasoningPartCount,
        0,
        ...unboundThoughtSignatures.map((thoughtSignature) => ({
          text: '',
          thoughtSignature,
        })),
      )
    }

    // Gemini 3 validates echoed functionCall history more strictly than plain
    // text history: native Gemini either has the real signature above or needs
    // Google's documented import-compatible sentinel.
    if (
      parts.some((p) => 'functionCall' in p) &&
      !parts.some((p) => 'thoughtSignature' in (p as object))
    ) {
      const anchor = geminiThoughtSignatureAnchor(parts)
      if (anchor) anchor.thoughtSignature = 'skip_thought_signature_validator'
    }

    return {
      contents: parts.length > 0 ? [{ role: 'model', parts }] : [],
      reasoningCarryForward,
    }
  }

  return { contents: [], reasoningCarryForward: 'none' }
}

function geminiThoughtSignatureAnchor(
  parts: GeminiPart[],
): (GeminiPart & { thoughtSignature?: string }) | undefined {
  const firstFunctionCall = parts.find((part) => 'functionCall' in part)
  if (firstFunctionCall) return firstFunctionCall
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part && !('functionCall' in part)) return part
  }
  return undefined
}

function buildGeminiUserParts(items: ContentItem[]): GeminiPart[] {
  const parts: GeminiPart[] = []
  for (const item of items) {
    if (item.type === 'text') {
      parts.push({ text: item.text })
    } else if (item.type === 'output_text') {
      parts.push({ text: item.text })
    } else if (item.type === 'image_url' && item.url) {
      // Inline base64 URLs only for Phase 11; file-uri resolution is Phase 12.
      if (/^data:/.test(item.url)) {
        const match = /^data:([^;]+);base64,(.+)$/.exec(item.url)
        if (match?.[1] && match[2]) {
          parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
        }
      } else {
        parts.push({ fileData: { mimeType: 'application/octet-stream', fileUri: item.url } })
      }
    }
    // Phase 12: audio/file/video.
  }
  return parts
}
