// Internal → Chat Completions wire transform. See `plan/05-transforms-and-quirks.md §5.1`.
//
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

import type {
  AnthropicContentBlock,
  AnthropicMessagesRequestWire,
  AnthropicMessageWire,
} from '../api/anthropic-types'
import type {
  GeminiContent,
  GeminiPart,
  GenerateContentRequestWire,
  GenerationConfig,
  ThinkingConfig,
} from '../api/gemini-types'
import type { TextCompletionRequestWire } from '../api/text-completions'
import type {
  ChatCompletionRequestWire,
  ResponsesInputItem,
  ResponsesRequestWire,
} from '../api/types'
import { isFreeModel } from './model-predicates'
import type { WireProviderPrivacy } from './privacy-filter'
import {
  buildAnthropicServerTools,
  buildGoogleServerTools,
  buildOpenAiServerTools,
  buildOpenRouterServerTools,
  type HostedToolProvider,
} from './provider-hosted-tools'
import {
  nativeAnthropicToolBlocksForMessage,
  nativeGeminiToolPartsForMessage,
  nativeResponsesToolItemsForMessage,
  type ProviderToolContextTarget,
  unsupportedToolContextTextForMessage,
} from './provider-tool-context'
import { adjustGpt54SamplingGate, quirksFor } from './quirks'
import { filterReasoningForInclude } from './reasoning'
import { renderTextPrompt } from './text-templates'
import type {
  CapabilityDescriptor,
  ChatSettings,
  ContentItem,
  EffortLevel,
  Message,
  MessageId,
  MessageRole,
  ReasoningDetail,
  ReasoningFormat,
  SamplingKey,
  TextTemplateConfig,
  ToolCall,
} from './types'

export interface ChatCompletionsTransformOptions {
  // Live capability descriptor — from `/endpoints` (OpenRouter) or a static
  // capabilities JSON (direct providers). `supportedParameters` gates optional
  // request fields. When omitted, the full superset is sent; the upstream
  // then decides what to accept (matches the "live-first, registry-last" rule).
  capabilities?: CapabilityDescriptor
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
  // block is built. See `plan/09-privacy.md §9.9`.
  privacy?: WireProviderPrivacy
  // OpenRouter-specific provider routing. This must be explicitly enabled by
  // the request planner so direct/custom OpenAI-compatible endpoints never see
  // OpenRouter's `provider` extension.
  allowProviderRouting?: boolean
  // Provider-hosted server tools. Each provider maps to its native wire shape;
  // callers must pass the concrete provider instead of a generic boolean.
  hostedToolsProvider?: HostedToolProvider
  // The carrier format the current route can round-trip for reasoning echo
  // (e.g. `anthropic-claude-v1` when sending to Claude; `openai-responses-v1`
  // for OpenAI Responses). Determined by `caps.quirks.reasoningPreservationFormat`
  // on Phase-11-aware callers; when undefined, encrypted reasoning entries
  // are dropped on echo (plaintext / summary still flow per the include
  // flags). See `plan/phase11-implementation.md §2`.
  reasoningPreservationFormat?: ReasoningFormat
  attachmentPartsByMessageId?: ReadonlyMap<MessageId, readonly unknown[]>
  extraPlugins?: readonly unknown[]
}

interface ChatCompletionsTransformResult {
  wire: ChatCompletionRequestWire
  // The model id the caller should store on `generation.requestedModel`
  // (before any quirk rewrite). Kept separate so callers don't have to
  // reimplement the rewrite-tracks-original rule.
  requestedModel: string
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
const SAMPLING_WIRE_KEY: Readonly<Record<SamplingKey, string>> = Object.freeze({
  temperature: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  min_p: 'min_p',
  top_a: 'top_a',
  frequency_penalty: 'frequency_penalty',
  presence_penalty: 'presence_penalty',
  repetition_penalty: 'repetition_penalty',
  seed: 'seed',
  logprobs: 'logprobs',
  top_logprobs: 'top_logprobs',
  // llama.cpp-only keys. Wire names match llama-server's expected JSON.
  typical_p: 'typical_p',
  repeat_penalty: 'repeat_penalty',
  repeat_last_n: 'repeat_last_n',
  dynatemp_range: 'dynatemp_range',
  dynatemp_exponent: 'dynatemp_exponent',
  mirostat: 'mirostat',
  mirostat_tau: 'mirostat_tau',
  mirostat_eta: 'mirostat_eta',
  xtc_probability: 'xtc_probability',
  xtc_threshold: 'xtc_threshold',
  dry_multiplier: 'dry_multiplier',
  dry_base: 'dry_base',
  dry_allowed_length: 'dry_allowed_length',
  dry_penalty_last_n: 'dry_penalty_last_n',
  n_keep: 'n_keep',
})

// Apply prefill-specific path rewrites before any wire serialization. See
// `plan/prefill-research.md §P.8.5` (trailing-whitespace trim) and §P.8.6
// (merge adjacent prefill+continuation assistant rows). Both are wire-only;
// stored messages keep the user's content verbatim. Returns a new array
// when changes apply, else the input array reference.
function applyPrefillWireRewrites(path: readonly Message[]): readonly Message[] {
  if (path.length === 0) return path
  let mutated: Message[] | null = null
  const dropped = new Set<number>()
  for (let i = 0; i < path.length; i += 1) {
    const current = path[i]
    if (!current || current.role !== 'assistant' || current.origin !== 'prefill') continue
    const next = path[i + 1]
    if (!next || next.role !== 'assistant' || next.origin === 'prefill') continue
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
    const trimmed = trimTrailingWhitespaceOnLastText(tail)
    if (trimmed !== tail) {
      processed = [...processed.slice(0, -1), trimmed]
    }
  }
  return processed
}

function mergePrefillIntoContinuation(prefill: Message, continuation: Message): Message {
  const prefillContent = prefill.content ?? []
  const contContent = continuation.content ?? []
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
  if (!items || items.length === 0) return message
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
  reasoningPreservationFormat?: ReasoningFormat
  acceptsAnthropicRedactedThinking?: boolean
  attachmentPartsByMessageId?: ReadonlyMap<MessageId, readonly unknown[]>
  toolContextTarget?: ProviderToolContextTarget
  includeToolCalls?: boolean
}

export function buildChatMessages(
  settings: ChatSettings,
  path: readonly Message[],
  opts: BuildChatMessagesOptions = {},
): unknown[] {
  const rewritten = applyPrefillWireRewrites(path)
  const visible = rewritten.filter((m) => m.hiddenFromContext !== true && !m.deleted)
  const messages: unknown[] = []
  const hasImportedSystem = visible.some((m) => m.role === 'system' || m.role === 'developer')
  if (!hasImportedSystem && settings.systemPrompt.length > 0) {
    messages.push({
      role: settings.systemRole,
      content: settings.systemPrompt,
    })
  }
  const quirks = quirksFor(settings.model)
  const resolvedAcceptsRedacted =
    opts.acceptsAnthropicRedactedThinking ?? quirks.acceptsAnthropicRedactedThinking
  const resolvedOpts: BuildChatMessagesOptions = {
    ...opts,
    ...(resolvedAcceptsRedacted !== undefined
      ? { acceptsAnthropicRedactedThinking: resolvedAcceptsRedacted }
      : {}),
  }
  for (const message of visible) {
    messages.push(serializeChatMessage(message, settings, resolvedOpts))
  }
  return messages
}

// Per-message serializer. Phase 7 handled only `{role, content}`. Phase 11
// adds `reasoning_details` (echo per the include matrix), `tool_calls`
// (on assistant messages), and `tool_call_id` (on tool messages). `phase`
// is intentionally NOT echoed on chat-completions — the wire can't represent
// it; it's a Responses-API field. See `plan/phase11-implementation.md §4.5b`.
function serializeChatMessage(
  message: Message,
  settings: ChatSettings,
  opts: BuildChatMessagesOptions,
): Record<string, unknown> {
  const attachmentParts = opts.attachmentPartsByMessageId?.get(message.id) ?? []
  const unsupportedToolText =
    message.role === 'assistant'
      ? unsupportedToolContextTextForMessage(message, opts.toolContextTarget ?? 'text', {
          includeToolCalls: opts.includeToolCalls,
        })
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
    return entry
  }

  if (message.role === 'assistant') {
    if (message.reasoningDetails && message.reasoningDetails.length > 0) {
      const kept = filterReasoningForInclude(
        message.reasoningDetails,
        settings.reasoning.include,
        opts.reasoningPreservationFormat,
        opts.acceptsAnthropicRedactedThinking !== undefined
          ? { acceptsAnthropicRedactedThinking: opts.acceptsAnthropicRedactedThinking }
          : {},
      )
      if (kept.length > 0) {
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
        const knownFormat =
          opts.reasoningPreservationFormat && opts.reasoningPreservationFormat !== 'unknown'
        const useThinkFallback = !knownFormat || settings.reasoning.echoAsThinkTags === true
        if (useThinkFallback) {
          const plainKept = kept.filter((d) => !isOpaqueReasoningCarrier(d))
          const opaqueKept = kept.filter((d) => isOpaqueReasoningCarrier(d))
          const thinkBlock = wrapReasoningAsThinkTag(plainKept)
          if (thinkBlock) {
            const existing = typeof entry.content === 'string' ? entry.content : ''
            entry.content = existing.length > 0 ? `${thinkBlock}\n\n${existing}` : thinkBlock
          }
          if (opaqueKept.length > 0) {
            entry.reasoning_details = opaqueKept.map(stripTmpReasoningId)
          }
        } else {
          entry.reasoning_details = kept.map(stripTmpReasoningId)
        }
      }
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      entry.tool_calls = message.toolCalls.map(toWireToolCall)
    }
  }
  return entry
}

// `reasoning.encrypted` is opaque by definition. Anthropic's signed-text
// carrier ALSO rides as opaque: `reasoning.text` with a non-empty
// `.signature` is Anthropic's signed thinking block; the signature is what
// the next turn validates, so the text is never tag-ified out from under it.
// Used to split kept entries into "wrap as <think>" vs "keep on native
// reasoning_details[]" buckets when the universal-compat path is active.
function isOpaqueReasoningCarrier(d: ReasoningDetail): boolean {
  if (d.type === 'reasoning.encrypted') return true
  if (d.type === 'reasoning.text' && typeof d.signature === 'string' && d.signature.length > 0) {
    return true
  }
  return false
}

// Assemble a single `<think>…</think>` block from summary + text entries
// (encrypted entries can't be expressed in plaintext; the filter skips them
// when preservationFormat is 'unknown' anyway). Summaries come first as
// "Summary:" lines then text as "Reasoning:" lines so the model can tell
// them apart. Returns `null` when nothing usable remains.
function wrapReasoningAsThinkTag(kept: readonly ReasoningDetail[]): string | null {
  const parts: string[] = []
  for (const d of kept) {
    if (d.type === 'reasoning.summary' && d.summary) {
      parts.push(`Summary: ${d.summary}`)
    } else if (d.type === 'reasoning.text' && d.text) {
      parts.push(d.text)
    }
  }
  if (parts.length === 0) return null
  return `<think>\n${parts.join('\n\n')}\n</think>`
}

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

export function toChatCompletions(
  settings: ChatSettings,
  path: readonly Message[],
  opts: ChatCompletionsTransformOptions = {},
): ChatCompletionsTransformResult {
  const requestedModel = settings.model
  const wireModel = opts.rewriteSlug ? opts.rewriteSlug(requestedModel) : requestedModel
  const streaming = opts.stream !== false
  const caps = opts.capabilities
  const supported = caps?.supportedParameters

  const wire: ChatCompletionRequestWire = {
    model: wireModel,
    messages: buildChatMessages(settings, path, {
      ...(opts.reasoningPreservationFormat !== undefined
        ? { reasoningPreservationFormat: opts.reasoningPreservationFormat }
        : {}),
      ...(opts.attachmentPartsByMessageId
        ? { attachmentPartsByMessageId: opts.attachmentPartsByMessageId }
        : {}),
      includeToolCalls: settings.toolCallContext.include,
    }),
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
    if (value === undefined) continue
    const wireKey = SAMPLING_WIRE_KEY[key as SamplingKey] ?? key
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
    const tools = buildOpenRouterServerTools(settings)
    if (tools.length > 0 && gate('tools')) {
      const toolSettings = settings.tools.openrouter
      wire.tools = tools
      if (toolSettings.toolChoice !== undefined && gate('tool_choice')) {
        wire.tool_choice = toolSettings.toolChoice
      }
      if (toolSettings.parallelToolCalls !== undefined && gate('parallel_tool_calls')) {
        wire.parallel_tool_calls = toolSettings.parallelToolCalls
      }
    }
  }
  if (settings.serviceTier && settings.serviceTier !== 'auto' && gate('service_tier')) {
    wire.service_tier = settings.serviceTier
  }

  // Reasoning: only emit when explicitly configured AND supported. `off` with
  // no other reasoning knobs stays off the wire entirely so buffered / text
  // models aren't confused by an empty object.
  if (gate('reasoning')) {
    const reasoning = buildReasoning(settings)
    if (reasoning) wire.reasoning = reasoning
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

  return { wire, requestedModel }
}

// ---------------------------------------------------------------------------
// Text completions (llama-server protocol='text')
// ---------------------------------------------------------------------------

interface TextCompletionsTransformOptions {
  capabilities?: CapabilityDescriptor
  stream?: boolean
  privacy?: WireProviderPrivacy
  allowProviderRouting?: boolean
  // Resolved template config for the branch. When the chat's selected
  // template id is 'default', the caller is responsible for calling
  // `applyServerTemplate()` and passing the returned prompt via
  // `prerenderedPrompt` — this transform doesn't do the server round-trip.
  template: TextTemplateConfig | null
  // Escape hatch for the 'default' template: skip client-side rendering
  // and use this prompt string as-is.
  prerenderedPrompt?: string
}

interface TextCompletionsTransformResult {
  wire: TextCompletionRequestWire
  requestedModel: string
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

  const prompt =
    opts.prerenderedPrompt ??
    (opts.template
      ? renderTextPrompt(opts.template, settings, path)
      : fallbackRawPrompt(path, settings.toolCallContext.include))

  const wire: TextCompletionRequestWire = {
    model: requestedModel,
    prompt,
  }
  if (streaming) wire.stream = true

  const gate = (param: string): boolean => {
    if (!supported) return true
    return supported.includes(param)
  }

  for (const [key, value] of Object.entries(settings.sampling)) {
    if (value === undefined) continue
    const wireKey = SAMPLING_WIRE_KEY[key as SamplingKey] ?? key
    if (!gate(wireKey)) continue
    wire[wireKey] = value
  }

  // Merge template stop sequences with user-specified stops. Template
  // stops are critical (they tell the server where the turn ends), so
  // they always ship even when `settings.stop` is empty.
  const templateStops = opts.template?.stop ?? []
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
  if (gate('reasoning')) {
    const reasoning = buildReasoning(settings)
    if (reasoning) wire.reasoning = reasoning
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

  return { wire, requestedModel }
}

// Walk the visible branch without a template. This is a literal
// continuation fallback, so the chat-level system prompt is not imported.
function fallbackRawPrompt(path: readonly Message[], includeToolCalls: boolean): string {
  const parts: string[] = []
  for (const msg of path) {
    if (msg.hiddenFromContext === true || msg.deleted) continue
    for (const item of msg.content) {
      if (item.type === 'text' || item.type === 'output_text') parts.push(item.text)
    }
    if (msg.role === 'assistant') {
      const toolText = unsupportedToolContextTextForMessage(msg, 'text', { includeToolCalls })
      if (toolText) parts.push(toolText)
    }
  }
  return parts.join('')
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
    // models; sending them is just noise. See plan/05 §5.4 and
    // plan/09-privacy.md §9.9.
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

function buildReasoning(settings: ChatSettings): Record<string, unknown> | undefined {
  const reasoning = settings.reasoning
  if (reasoning.mode === 'default') {
    // Don't emit the `reasoning` field — let the provider pick. Distinct
    // from `off`, which explicitly disables thinking.
    return undefined
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
  if (reasoning.summary && reasoning.summary !== 'off') body.summary = reasoning.summary
  return body
}

// ---------------------------------------------------------------------------
// Phase 11: `toResponses` — the OpenAI Responses API transform.
// See `plan/phase11-implementation.md §4.5`.
// ---------------------------------------------------------------------------

export interface ResponsesTransformOptions {
  capabilities?: CapabilityDescriptor
  stream?: boolean
  rewriteSlug?: (slug: string) => string
  privacy?: WireProviderPrivacy
  allowProviderRouting?: boolean
  hostedToolsProvider?: HostedToolProvider
  // Informs the reasoning-carry-forward filter about which encrypted format the
  // current route round-trips. For Responses the map is:
  //   OpenAI direct       → `openai-responses-v1`
  //   OpenRouter /responses (OpenAI model) → `azure-openai-responses-v1`
  //   Azure OpenAI        → `azure-openai-responses-v1`
  //   xAI Grok (/responses) → `xai-responses-v1`
  reasoningPreservationFormat?: ReasoningFormat
}

interface ResponsesTransformResult {
  wire: ResponsesRequestWire
  requestedModel: string
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
  opts: ResponsesTransformOptions = {},
): ResponsesTransformResult {
  const requestedModel = settings.model
  const wireModel = opts.rewriteSlug ? opts.rewriteSlug(requestedModel) : requestedModel
  const streaming = opts.stream !== false
  const caps = opts.capabilities
  const supported = caps?.supportedParameters
  const quirks = quirksFor(requestedModel)
  const preservationFormat = opts.reasoningPreservationFormat ?? quirks.reasoningPreservationFormat

  const rewritten = applyPrefillWireRewrites(path)
  const visible = rewritten.filter((m) => m.hiddenFromContext !== true && !m.deleted)
  const input: ResponsesInputItem[] = []

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

  const toolContextTarget =
    opts.hostedToolsProvider === 'openrouter' ? 'openrouter-responses' : 'openai-responses'
  for (const message of visible) {
    if (message.role === 'system' || message.role === 'developer') continue
    const items = messageToResponsesItems(
      message,
      settings.reasoning.include,
      preservationFormat,
      toolContextTarget,
      settings.toolCallContext.include,
    )
    input.push(...items)
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
    if (value === undefined) continue
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
  if (gate('reasoning')) {
    const reasoningBody = buildResponsesReasoning(settings)
    if (reasoningBody) wire.reasoning = reasoningBody
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
  const isOpenAiFamily =
    preservationFormat === 'openai-responses-v1' ||
    preservationFormat === 'azure-openai-responses-v1' ||
    preservationFormat === 'xai-responses-v1'
  if (settings.reasoning.include.encrypted && isOpenAiFamily) {
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
    const tools = buildOpenRouterServerTools(settings)
    if (tools.length > 0 && gate('tools')) {
      const toolSettings = settings.tools.openrouter
      wire.tools = tools
      if (toolSettings.toolChoice !== undefined && gate('tool_choice')) {
        wire.tool_choice = toolSettings.toolChoice
      }
      if (toolSettings.parallelToolCalls !== undefined && gate('parallel_tool_calls')) {
        wire.parallel_tool_calls = toolSettings.parallelToolCalls
      }
    }
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

  return { wire, requestedModel }
}

function buildResponsesReasoning(
  settings: ChatSettings,
): ResponsesRequestWire['reasoning'] | undefined {
  const r = settings.reasoning
  if (r.mode === 'default') return undefined
  if (r.mode === 'off') return { enabled: false }
  const body: NonNullable<ResponsesRequestWire['reasoning']> = { enabled: true }
  if (r.effort !== undefined) body.effort = r.effort
  if (r.exclude) body.exclude = true
  if (r.summary && r.summary !== 'off') body.summary = r.summary
  return body
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
//   - assistant with text + optional reasoning → reasoning item first (if any
//     include flags are true) then a message item. When a `responsesEchoItem`
//     exists, that gets emitted verbatim (preserving its id/phase), BUT with
//     `encrypted_content` stripped if `include.encrypted === false`.
//   - assistant with tool calls → one `{type:'function_call', …}` item per call.
//   - tool (role:'tool') → `{type:'function_call_output', call_id, output}`.
function messageToResponsesItems(
  message: Message,
  include: ChatSettings['reasoning']['include'],
  preservationFormat: ReasoningFormat | undefined,
  toolContextTarget: Extract<
    ProviderToolContextTarget,
    'openai-responses' | 'openrouter-responses'
  >,
  includeToolCalls: boolean,
): ResponsesInputItem[] {
  if (message.role === 'tool') {
    const callId = message.toolCalls?.[0]?.id ?? ''
    const output = message.content
      .filter((c): c is Extract<ContentItem, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('')
    return [{ type: 'function_call_output', call_id: callId, output }]
  }

  if (message.role === 'user') {
    return [
      {
        type: 'message',
        role: 'user',
        content: buildUserContentParts(message.content),
      },
    ]
  }

  if (message.role === 'assistant') {
    const items: ResponsesInputItem[] = []
    items.push(
      ...(nativeResponsesToolItemsForMessage(message, toolContextTarget, {
        includeToolCalls,
      }) as ResponsesInputItem[]),
    )
    const unsupportedToolText = unsupportedToolContextTextForMessage(message, toolContextTarget, {
      includeToolCalls,
    })

    // Prefer the verbatim echo item if one was stored.
    if (message.responsesEchoItem) {
      const echoed = appendToolTextToResponsesItem(
        applyIncludeToEchoItem(message.responsesEchoItem, include, preservationFormat),
        unsupportedToolText,
      )
      // When stripping leaves a `reasoning` item with no `encrypted_content`
      // AND no `summary`, the item is empty: nothing of value for the next
      // turn. Skip it so a naked `{type:'reasoning'}` envelope is not sent.
      // Non-reasoning items (message/function_call/server-tool)
      // always ride through verbatim.
      const isEmptyReasoning =
        echoed.type === 'reasoning' &&
        echoed.encrypted_content === undefined &&
        (echoed.summary === undefined ||
          (Array.isArray(echoed.summary) && echoed.summary.length === 0))
      if (!isEmptyReasoning) items.push(echoed)
    } else {
      // Synthesize a reasoning item if reasoning details have been kept.
      const filtered = message.reasoningDetails
        ? filterReasoningForInclude(message.reasoningDetails, include, preservationFormat)
        : []
      const encrypted = filtered.find((d) => d.type === 'reasoning.encrypted')
      const summaries = filtered.filter(
        (d): d is Extract<(typeof filtered)[number], { type: 'reasoning.summary' }> =>
          d.type === 'reasoning.summary',
      )
      if (encrypted || summaries.length > 0) {
        // OpenAI /responses requires the `summary` field on reasoning
        // input items — empty `[]` is fine but missing triggers 400
        // `Missing required parameter: 'input[N].summary'`. Always emit it.
        const item: ResponsesInputItem = {
          type: 'reasoning',
          summary:
            summaries.length > 0
              ? summaries.map((s) => ({ type: 'summary_text', text: s.summary }))
              : [],
        }
        if (encrypted) item.encrypted_content = encrypted.data
        items.push(item)
      }

      // The message item itself.
      const textContent = message.content
        .filter(
          (c): c is Extract<ContentItem, { type: 'text' | 'output_text' }> =>
            c.type === 'text' || c.type === 'output_text',
        )
        .map((c) => c.text)
        .join('')
      const outputText =
        unsupportedToolText && textContent.length > 0
          ? `${textContent}\n\n${unsupportedToolText}`
          : (unsupportedToolText ?? textContent)
      if (outputText.length > 0 || !message.toolCalls?.length) {
        const item: ResponsesInputItem = {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: outputText }],
        }
        if (message.phase !== undefined) item.phase = message.phase
        items.push(item)
      }
    }

    // Tool calls ride as separate function_call items regardless of echo item.
    for (const call of message.toolCalls ?? []) {
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })
    }

    return items
  }

  // Unknown role — pass through as a message item so nothing is dropped.
  return [
    {
      type: 'message',
      role: message.role,
      content: buildUserContentParts(message.content),
    },
  ]
}

function appendToolTextToResponsesItem(
  item: ResponsesInputItem,
  toolText: string | null,
): ResponsesInputItem {
  if (!toolText || item.type !== 'message') return item
  const content = Array.isArray(item.content) ? [...item.content] : []
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const part = content[i]
    if (!part || typeof part !== 'object') continue
    const record = part as { type?: unknown; text?: unknown }
    if (record.type === 'output_text' && typeof record.text === 'string') {
      content[i] = { ...record, text: `${record.text}\n\n${toolText}` }
      return { ...item, content }
    }
  }
  content.push({ type: 'output_text', text: toolText })
  return { ...item, content }
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

function applyIncludeToEchoItem(
  item: Message['responsesEchoItem'] & object,
  include: ChatSettings['reasoning']['include'],
  preservationFormat: ReasoningFormat | undefined,
): ResponsesInputItem {
  // `responsesEchoItem` carries the verbatim wire shape from the previous
  // turn. For reasoning items, `encrypted_content` is optionally stripped
  // per the include flags. Message items ride verbatim (including `phase`).
  if (item.type !== 'reasoning') {
    const next = { ...(item as ResponsesInputItem) } as ResponsesInputItem & { id?: string }
    if (typeof next.id === 'string' && /^(rs|msg)_tmp_/.test(next.id)) delete next.id
    return next
  }
  const next = { ...(item as ResponsesInputItem) } as ResponsesInputItem & { id?: string }
  delete next.status
  delete next.format
  // OpenRouter rewrites item ids to `rs_tmp_*` / `msg_tmp_*` on its proxy.
  // Echoing those back to Azure makes the upstream reject with
  // `Encrypted content item_id did not match the target item id.`; strip
  // those synthetic ids and let the upstream pair `encrypted_content` by
  // content rather than id. Real upstream ids (`rs_01...`) round-trip fine
  // only while the encrypted blob is still present.
  if (typeof next.id === 'string' && /^(rs|msg)_tmp_/.test(next.id)) delete next.id
  // Drop encrypted_content when the include flag is off OR the target route
  // can't round-trip it. OpenAI/Azure Responses accept `encrypted_content`
  // (OpenRouter proxy rewrites between `openai-responses-v1` and
  // `azure-openai-responses-v1`, both work). xAI Grok also accepts its own
  // format on /responses. Anthropic + Gemini have NO `encrypted_content`
  // slot on this wire shape, so it is always stripped for those targets.
  if (
    !include.encrypted ||
    !preservationFormat ||
    preservationFormat === 'unknown' ||
    preservationFormat === 'anthropic-claude-v1' ||
    preservationFormat === 'google-gemini-v1'
  ) {
    delete next.encrypted_content
  }
  if (next.encrypted_content === undefined && typeof next.id === 'string') {
    delete next.id
  }
  // OpenAI /responses requires `summary` to be present on `{type:'reasoning'}`
  // input items (empty `[]` is fine). Per live probe R2: dropping summary
  // entirely returns 400 `Missing required parameter: 'input[N].summary'`.
  if (!include.summary) {
    next.summary = []
  }
  return next
}

function stripTmpReasoningId<T extends { id?: string }>(detail: T): T {
  if (typeof detail.id === 'string' && /^(rs|msg)_tmp_/.test(detail.id)) {
    const { id: _id, ...rest } = detail
    return rest as T
  }
  return detail
}

// ---------------------------------------------------------------------------
// Anthropic Messages API transform.
// ---------------------------------------------------------------------------

export interface AnthropicMessagesTransformOptions {
  capabilities?: CapabilityDescriptor
  stream?: boolean
  rewriteSlug?: (slug: string) => string
  reasoningPreservationFormat?: ReasoningFormat
  hostedToolsProvider?: HostedToolProvider
}

interface AnthropicMessagesTransformResult {
  wire: AnthropicMessagesRequestWire
  requestedModel: string
  modelId: string
}

export function toAnthropicMessages(
  settings: ChatSettings,
  path: readonly Message[],
  opts: AnthropicMessagesTransformOptions = {},
): AnthropicMessagesTransformResult {
  const requestedModel = settings.model
  const rewritten = opts.rewriteSlug ? opts.rewriteSlug(requestedModel) : requestedModel
  const modelId = normalizeAnthropicModelId(rewritten)
  const streaming = opts.stream !== false
  const quirks = quirksFor(requestedModel)
  const preservationFormat = opts.reasoningPreservationFormat ?? quirks.reasoningPreservationFormat
  const supported = opts.capabilities?.supportedParameters
  const gate = (param: string): boolean => {
    if (!supported) return true
    return supported.includes(param)
  }

  const rewrittenPath = applyPrefillWireRewrites(path)
  const visible = rewrittenPath.filter((m) => m.hiddenFromContext !== true && !m.deleted)
  const messages: AnthropicMessageWire[] = []

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
    const wireMessages = messageToAnthropicMessages(
      message,
      settings.reasoning.include,
      preservationFormat,
      settings.toolCallContext.include,
    )
    messages.push(...wireMessages)
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

  if (gate('thinking')) {
    const thinking = buildAnthropicThinking(settings)
    if (thinking) wire.thinking = thinking
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

  return { wire, requestedModel, modelId }
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
  if (quirks.adaptiveReasoningOnly === true) return anthropicAdaptiveThinking(r)

  const modelId = normalizeAnthropicModelId(settings.model)
  const isClaude46 = /^claude-(?:opus|sonnet)-4-6(?:-|$)/u.test(modelId)

  if (isClaude46 && r.mode !== 'budget') return anthropicAdaptiveThinking(r)
  if (isClaude46 && r.maxTokens === undefined) return anthropicAdaptiveThinking(r)

  const out: Record<string, unknown> = { type: 'enabled' }
  if (r.maxTokens !== undefined) out.budget_tokens = r.maxTokens
  const display = anthropicThinkingDisplay(r)
  if (display) out.display = display
  return out
}

function anthropicAdaptiveThinking(r: ChatSettings['reasoning']): Record<string, unknown> {
  const out: Record<string, unknown> = { type: 'adaptive' }
  const display = anthropicThinkingDisplay(r)
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

function anthropicToolChoice(choice: ChatSettings['tools']['anthropic']['toolChoice']): unknown {
  if (choice === undefined) return undefined
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'none') return { type: 'none' }
  if (choice === 'required') return { type: 'any' }
  return { type: 'tool', name: choice.function.name }
}

function messageToAnthropicMessages(
  message: Message,
  include: ChatSettings['reasoning']['include'],
  preservationFormat: ReasoningFormat | undefined,
  includeToolCalls: boolean,
): AnthropicMessageWire[] {
  if (message.role === 'tool') {
    const call = message.toolCalls?.[0]
    const contentText = message.content
      .filter(
        (c): c is Extract<ContentItem, { type: 'text' | 'output_text' }> =>
          c.type === 'text' || c.type === 'output_text',
      )
      .map((c) => c.text)
      .join('')
    return [
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
    ]
  }

  if (message.role === 'user') {
    return [{ role: 'user', content: buildAnthropicUserBlocks(message.content) }]
  }

  if (message.role === 'assistant') {
    const content: AnthropicContentBlock[] = []
    const unsupportedToolText = unsupportedToolContextTextForMessage(message, 'anthropic-claude', {
      includeToolCalls,
    })

    if (message.reasoningDetails) {
      const kept = filterReasoningForInclude(message.reasoningDetails, include, preservationFormat)
      for (const d of kept) {
        if (d.type === 'reasoning.text') {
          if (d.signature && d.text) {
            content.push({
              type: 'thinking',
              thinking: d.text,
              signature: d.signature,
            })
          } else if (include.text && d.text) {
            content.push({ type: 'thinking', thinking: d.text })
          }
        } else if (d.type === 'reasoning.encrypted') {
          content.push({ type: 'redacted_thinking', data: d.data })
        }
      }
    }

    content.push(
      ...(nativeAnthropicToolBlocksForMessage(message, {
        includeToolCalls,
      }) as AnthropicContentBlock[]),
    )

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
    if (outputText.length > 0) content.push({ type: 'text', text: outputText })

    for (const call of message.toolCalls ?? []) {
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

    return content.length > 0 ? [{ role: 'assistant', content }] : []
  }

  return []
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
// Phase 11: `toGeminiNative` — the Google Gemini native generateContent transform.
// See `plan/phase11-implementation.md §4.5`.
// ---------------------------------------------------------------------------

export interface GeminiNativeTransformOptions {
  capabilities?: CapabilityDescriptor
  // Whether the pipeline will stream — affects nothing on the wire (the
  // URL differs instead — see `api/gemini-native.ts`), but kept for symmetry.
  stream?: boolean
  rewriteSlug?: (slug: string) => string
  // The quirks-derived carrier format. Defaults to `google-gemini-v1` for
  // Gemini models; callers pass it explicitly if they want to override
  // (e.g. tests).
  reasoningPreservationFormat?: ReasoningFormat
  // Gemini 2.5 budget table used when the model quirks entry is missing a
  // custom mapping. Overridable for tests / future model tables.
  thinkingBudgetByEffort?: Partial<Record<EffortLevel, number>>
  hostedToolsProvider?: HostedToolProvider
}

interface GeminiNativeTransformResult {
  wire: GenerateContentRequestWire
  // The model id the caller should pass to `geminiStream()` /
  // `geminiOnce()` — stripped of any provider prefix.
  modelId: string
  requestedModel: string
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
  none: 0,
}
const BUDGET_TABLE_GEMINI_2_5_PRO: Partial<Record<EffortLevel, number>> = {
  // Pro floor is 128; `none` / `minimal` both clamp to the floor.
  minimal: 128,
  low: 512,
  medium: 2048,
  high: 8192,
  xhigh: 32768,
}
const BUDGET_TABLE_GEMINI_2_5_FLASH_LITE: Partial<Record<EffortLevel, number>> = {
  // Flash-Lite floor is 512; minimal clamps up to the floor.
  minimal: 512,
  low: 512,
  medium: 2048,
  high: 8192,
  xhigh: 24576,
}

// Kept for back-compat with callers that passed a single table via
// `GeminiNativeTransformOptions.thinkingBudgetByEffort`. New code should let
// the transform pick the per-family table from `geminiFamily(modelId)`.
const DEFAULT_THINKING_BUDGETS: Partial<Record<EffortLevel, number>> = BUDGET_TABLE_GEMINI_2_5_FLASH

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
  opts: GeminiNativeTransformOptions = {},
): GeminiNativeTransformResult {
  const requestedModel = settings.model
  const rewritten = opts.rewriteSlug ? opts.rewriteSlug(requestedModel) : requestedModel
  const slash = rewritten.indexOf('/')
  const modelId = slash >= 0 ? rewritten.slice(slash + 1) : rewritten
  const quirks = quirksFor(requestedModel)
  const preservationFormat = opts.reasoningPreservationFormat ?? quirks.reasoningPreservationFormat

  const prefillRewritten = applyPrefillWireRewrites(path)
  const visible = prefillRewritten.filter((m) => m.hiddenFromContext !== true && !m.deleted)
  const contents: GeminiContent[] = []

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
    const entries = messageToGeminiContents(
      message,
      settings.reasoning.include,
      preservationFormat,
      settings.toolCallContext.include,
    )
    contents.push(...entries)
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

  const thinkingConfig = buildThinkingConfig(
    settings,
    modelId,
    opts.thinkingBudgetByEffort ?? DEFAULT_THINKING_BUDGETS,
  )
  if (thinkingConfig !== undefined) generationConfig.thinkingConfig = thinkingConfig

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

  return { wire, modelId, requestedModel }
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
  if (r.summary && r.summary !== 'off') out.includeThoughts = true

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
  include: ChatSettings['reasoning']['include'],
  preservationFormat: ReasoningFormat | undefined,
  includeToolCalls: boolean,
): GeminiContent[] {
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
    return [
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
    ]
  }

  if (message.role === 'user') {
    return [{ role: 'user', parts: buildGeminiUserParts(message.content) }]
  }

  if (message.role === 'assistant') {
    const parts: GeminiPart[] = []
    const unsupportedToolText = unsupportedToolContextTextForMessage(message, 'google-gemini', {
      includeToolCalls,
    })
    // Visible thought summary + plaintext reasoning, coalesced into ONE
    // `{text, thought: true}` part. Earlier passes pushed one part per
    // `reasoning.summary` / `reasoning.text` entry, which produced a noisy
    // multi-part echo when Gemini's stream had emitted N summary parts (one
    // per `summaryIndex`) or when OR-repackaged Gemini split summary into
    // multiple `reasoning.text` chunks. Concatenating into a single part
    // matches Gemini's own typical "one thought, then answer" turn shape and
    // mirrors the chat-completions wrapper's single-`<think>` behavior.
    if (message.reasoningDetails && (include.summary || include.text)) {
      const thoughtPieces: string[] = []
      if (include.summary) {
        for (const d of message.reasoningDetails) {
          if (d.type !== 'reasoning.summary') continue
          if (d.id?.startsWith('tool_')) continue
          if (typeof d.summary !== 'string' || d.summary.length === 0) continue
          thoughtPieces.push(d.summary)
        }
      }
      if (include.text) {
        for (const d of message.reasoningDetails) {
          if (d.type !== 'reasoning.text') continue
          if (d.id?.startsWith('tool_')) continue
          if (typeof d.text !== 'string' || d.text.length === 0) continue
          // Skip entries that are Anthropic-signature carriers — they're not
          // plaintext reasoning, they ride as encrypted.
          if (typeof d.signature === 'string' && d.signature.length > 0) continue
          thoughtPieces.push(d.text)
        }
      }
      if (thoughtPieces.length > 0) {
        parts.push({ text: thoughtPieces.join('\n\n'), thought: true })
      }
    }

    parts.push(...(nativeGeminiToolPartsForMessage(message, { includeToolCalls }) as GeminiPart[]))

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
    for (const call of message.toolCalls ?? []) {
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

    // 5. Attach `thoughtSignature` to the LAST part (Gemini 3 rule) when
    //    `include.encrypted` is true AND a compatible `reasoning.encrypted`
    //    detail with format `google-gemini-v1` exists.
    if (
      include.encrypted &&
      parts.length > 0 &&
      preservationFormat === 'google-gemini-v1' &&
      message.reasoningDetails
    ) {
      const encrypted = message.reasoningDetails.find(
        (d) =>
          d.type === 'reasoning.encrypted' &&
          (d.format === 'google-gemini-v1' || d.format === undefined),
      )
      if (encrypted && encrypted.type === 'reasoning.encrypted') {
        const lastPart = parts[parts.length - 1] as GeminiPart
        ;(lastPart as { thoughtSignature?: string }).thoughtSignature = encrypted.data
      }
    }

    // Gemini 3 validates echoed functionCall history more strictly than plain
    // text history: native Gemini either has the real signature above or needs
    // Google's documented import-compatible sentinel.
    if (
      preservationFormat === 'google-gemini-v1' &&
      parts.some((p) => 'functionCall' in p) &&
      !parts.some((p) => 'thoughtSignature' in (p as object))
    ) {
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const part = parts[i]
        if (part && 'functionCall' in part) {
          ;(part as { thoughtSignature: string }).thoughtSignature =
            'skip_thought_signature_validator'
          break
        }
      }
    }

    return parts.length > 0 ? [{ role: 'model', parts }] : []
  }

  return []
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
