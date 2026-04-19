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
//   we never append a synthetic echo.
// - System prompt becomes the first `system`/`developer` message iff non-empty
//   AND the active path doesn't already contain one (e.g. imported transcript).
// - `requestedModel` is the ORIGINAL `settings.model`; the wire `model` goes
//   through `rewriteSlug` if a quirk entry matches. (No slug rewrites are
//   wired in Phase 7 yet — this just reserves the shape so later phases don't
//   have to retouch transform callers.)

import type { ChatCompletionRequestWire } from '../api/types'
import { isFreeModel } from './model-predicates'
import type { WireProviderPrivacy } from './privacy-filter'
import type {
  CapabilityDescriptor,
  ChatSettings,
  ContentItem,
  Message,
  MessageRole,
  SamplingKey,
} from './types'

export interface ChatCompletionsTransformOptions {
  // Live capability descriptor — from `/endpoints` (OpenRouter) or a static
  // capabilities JSON (direct providers). `supportedParameters` gates optional
  // request fields. When omitted we send the full superset; the upstream then
  // decides what to accept (matches the "live-first, registry-last" rule).
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
}

export interface ChatCompletionsTransformResult {
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
})

// Translate a `ContentItem[]` into chat-completions wire content parts. For
// text-only Phase 7 this is nearly identity; we preserve the typed shape so
// later phases can bolt on image/audio/file/video without revisiting callers.
function serializeContent(items: ContentItem[]): unknown {
  if (items.length === 0) return ''
  if (items.length === 1 && (items[0]?.type === 'text' || items[0]?.type === 'output_text')) {
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
  return parts
}

function toWireRole(role: MessageRole): string {
  // `developer` is OpenAI's newer name for `system`; keep it distinct on the
  // wire when callers opt in. Other roles are identity.
  return role
}

export function buildChatMessages(settings: ChatSettings, path: readonly Message[]): unknown[] {
  const visible = path.filter((m) => m.hiddenFromContext !== true && !m.deleted)
  const messages: unknown[] = []
  const hasImportedSystem = visible.some((m) => m.role === 'system' || m.role === 'developer')
  if (!hasImportedSystem && settings.systemPrompt.length > 0) {
    messages.push({
      role: settings.systemRole,
      content: settings.systemPrompt,
    })
  }
  for (const message of visible) {
    const entry: Record<string, unknown> = {
      role: toWireRole(message.role),
      content: serializeContent(message.content),
    }
    if (message.role === 'tool') {
      const toolCallId = message.toolCalls?.[0]?.id
      if (toolCallId) entry.tool_call_id = toolCallId
    }
    messages.push(entry)
  }
  return messages
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
    messages: buildChatMessages(settings, path),
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
  if (settings.maxCompletionTokens !== undefined && gate('max_completion_tokens')) {
    wire.max_completion_tokens = settings.maxCompletionTokens
  }
  if (settings.logitBias && gate('logit_bias')) {
    wire.logit_bias = { ...settings.logitBias }
  }
  if (settings.modalities && settings.modalities.length > 0 && gate('modalities')) {
    wire.modalities = [...settings.modalities]
  }
  if (settings.responseFormat && gate('response_format')) {
    wire.response_format = toWireResponseFormat(settings.responseFormat)
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

  // Provider preferences (OpenRouter-specific). For Phase 7 we pass them
  // through only when the endpoint advertises the `provider` key; other
  // providers would reject it. In practice direct endpoints lack `/endpoints`
  // data so `supported` is undefined and the knob ships.
  if (gate('provider')) {
    const providerBlock = buildProviderBlock(settings, opts.privacy)
    if (providerBlock) wire.provider = providerBlock
  }

  // Context strategy → plugins: only the explicit `middle_out_plugin` case
  // currently affects the wire. `sliding_window` is client-side trimming,
  // `off` is no-op.
  if (settings.contextStrategy.kind === 'middle_out_plugin' && gate('plugins')) {
    wire.plugins = [{ id: 'context-compression' }]
  }

  return { wire, requestedModel }
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
    // denied are unioned. `only` from the filter replaces the user's
    // `only` (the filter already applied it and trimmed to kept-set
    // survivors; sending both would be redundant). `order` follows the
    // same rule. `data_collection` / `zdr` come from `privacy.*`.
    if (privacy.ignore) base.ignore = privacy.ignore
    if (privacy.only) base.only = privacy.only
    if (privacy.order) base.order = privacy.order
    if (privacy.data_collection) base.data_collection = privacy.data_collection
    if (privacy.zdr) base.zdr = privacy.zdr
  }
  // `allowFallbacks` is a top-level ChatSettings knob (stored separately
  // from `providerPrefs` because it's not a routing preference — it's a
  // "may my request be served by the model I didn't pick?" decision).
  // Emit it unconditionally when the user has set one.
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
  if (prefs.allowFallbacks !== undefined) wire.allow_fallbacks = prefs.allowFallbacks
  if (prefs.requireParameters !== undefined) {
    wire.require_parameters = prefs.requireParameters
  }
  if (prefs.dataCollection) wire.data_collection = prefs.dataCollection
  if (prefs.zdr !== undefined) wire.zdr = prefs.zdr
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
  // we want reasoning. Summary and exclude ride along independently.
  const body: Record<string, unknown> = { enabled: true }
  if (reasoning.effort !== undefined) body.effort = reasoning.effort
  if (reasoning.maxTokens !== undefined) body.max_tokens = reasoning.maxTokens
  if (reasoning.exclude) body.exclude = true
  if (reasoning.summary && reasoning.summary !== 'off') body.summary = reasoning.summary
  return body
}
