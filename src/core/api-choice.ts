// Phase 11 API router. See `plan/phase11-implementation.md §1` for the
// 10-step decision matrix. Callers:
//   - the send-pipeline (picks transport + wire shape)
//   - the UI (surfaces the resolved route in the API-mode hint)
//
// The route is a discriminated union carrying both a kind (for UI / logging)
// and a transport (for the send pipeline). Multi-step reasoning about the
// route is fully pure — no I/O, no live capability fetch — so the same
// function is safe to call from memoized selectors.
//
// Inputs
//   - `profile`: a ConnectionProfile; the transport depends on `kind` +
//     `geminiMode` + `usesResponsesApiByDefault`.
//   - `settings`: the effective ChatSettings for this turn. The user's
//     explicit `settings.api` pin wins over every model-derived heuristic.
//   - `path`: the active branch (root → leaf). We check for prior Responses-
//     API artifacts (e.g. encrypted reasoning, server-tool outputs) that
//     would be lost on chat-completions.
//   - `caps`: the resolved capability descriptor, carrying the quirks entry
//     (`reasoningPreservationFormat`, `preferApi`, `requiresResponsesApi`).

import { isTextCompletionsSelectableFor, responsesSupportFor } from './quirks'
import { normalizeReasoningSettings } from './reasoning'
import type { ApiVariant, ChatSettings, ConnectionProfile, Message, ReasoningFormat } from './types'

export type ApiRouteKind =
  | 'chat-completions'
  | 'text-completions'
  | 'responses'
  | 'gemini-generate'
  | 'anthropic-messages'

export type ApiTransport =
  | 'openai-chat'
  | 'openai-text'
  | 'openai-responses'
  | 'gemini-native'
  | 'anthropic'

export interface ApiRoute {
  kind: ApiRouteKind
  transport: ApiTransport
  // Human-readable rationale tag — the UI uses this to label "Auto — chat
  // completions" vs "Auto — Responses (required by gpt-5.4)".
  reason: string
}

// Minimal capability surface the router needs. Real callers pass
// `EffectiveCapability` which satisfies this shape via structural typing.
export interface RouterCapabilities {
  quirks: {
    requiresResponsesApi?: boolean
    preferApi?: 'chat' | 'responses'
    reasoningPreservationFormat?: ReasoningFormat
    reasoningHidden?: boolean
    hiddenReasoningOnChatApi?: boolean
  }
}

export function chooseApi(
  profile: ConnectionProfile,
  settings: ChatSettings,
  path: readonly Message[],
  caps: RouterCapabilities,
): ApiRoute {
  // Defensive read: imported chats / older builds may have a partial
  // `reasoning` block; normalize so step 6 below can read `include.encrypted`
  // without exploding. See `core/reasoning.ts:normalizeReasoningSettings`.
  const reasoning = normalizeReasoningSettings(settings.reasoning)
  const pin: ApiVariant = settings.api
  const support = responsesSupportFor(settings.model)

  // Step 1 — user-pinned chat completions. Wins over everything EXCEPT a
  // model that 404s on chat-completions (`responsesSupport: 'responses-only'`
  // or the legacy `requiresResponsesApi` flag).
  const responsesOnly = support === 'responses-only' || caps.quirks.requiresResponsesApi === true
  if (pin === 'text' && canRunTextCompletions(profile, settings.model) && !responsesOnly) {
    return openAiText('user pinned Text completions')
  }
  if (pin === 'chat' && !responsesOnly) {
    return openAiChat('user pinned chat completions')
  }

  // Step 2 — user-pinned responses. Wins over everything except connection
  // kinds that have no Responses surface (Gemini native, Anthropic future).
  if (pin === 'responses' && canRunResponses(profile)) {
    return openAiResponses('user pinned Responses')
  }

  // Step 3 — model requires Responses (supports ONLY /responses).
  if (responsesOnly && canRunResponses(profile)) {
    return openAiResponses('model requires Responses API')
  }

  // Step 4 — model quirk prefers Responses. Still switchable by pinning chat
  // (step 1 handles that above).
  if (caps.quirks.preferApi === 'responses' && canRunResponses(profile)) {
    return openAiResponses('model prefers Responses for encrypted reasoning')
  }

  // Step 5 — prior server-tool output on the path (web_search_call, etc.).
  // Chat completions can't round-trip those items, so we must stay on
  // Responses for continuity.
  if (hasResponsesServerToolArtifact(path) && canRunResponses(profile)) {
    return openAiResponses('prior server-tool output requires Responses for round-trip')
  }

  // Step 6 — prior encrypted reasoning on the path in an OpenAI-family format
  // AND the user wants to include it. Only meaningful on OpenAI-compatible
  // endpoints; Gemini's encrypted carrier rides on native, not Responses.
  if (
    reasoning.include.encrypted &&
    canRunResponses(profile) &&
    hasPriorOpenAiEncryptedReasoning(path) &&
    isOpenAiResponsesFormat(caps.quirks.reasoningPreservationFormat)
  ) {
    return openAiResponses('prior encrypted reasoning requires Responses to round-trip')
  }

  // Step 7 — Gemini native unless the user explicitly opted into the compat
  // shim. The pin already handled `responses`/`chat` overrides above; this
  // step is the Gemini-kind default.
  if (profile.kind === 'google' && profile.geminiMode !== 'openai-compat') {
    return geminiNative('Gemini native (generateContent)')
  }

  // Step 8 — Anthropic Messages API (reserved). Drops through to chat for
  // now since the adapter doesn't exist yet; a future phase flips this.
  if (profile.kind === 'anthropic') {
    // TODO (future phase): switch to anthropic-messages when the adapter
    // lands. Until then, fall through to OpenAI-compat chat with the
    // browser-origin opt-in (handled by buildHeaders).
    return openAiChat(
      'Anthropic direct — using OpenAI-compat shim until native Messages adapter ships',
    )
  }

  // Step 9 — profile default (OpenAI direct sets this true).
  if (profile.usesResponsesApiByDefault && canRunResponses(profile)) {
    return openAiResponses('profile default is Responses')
  }

  // Step 10 — OpenRouter default for OpenAI-family models. Per user
  // directive: on an OpenRouter connection, default to Responses whenever
  // the model is an OpenAI-family model that supports Responses. Non-OpenAI
  // models (Claude, Gemini, DeepSeek, etc.) stay on chat-completions since
  // /responses on OR just relays to chat anyway and adds no value.
  if (profile.kind === 'openrouter' && support === 'both') {
    return openAiResponses('OpenRouter: OpenAI-family model defaults to Responses')
  }

  // Step 11 — default.
  return openAiChat('default (chat completions)')
}

// "Responses capable" covers OpenRouter (beta `/responses` proxy),
// OpenAI-compatible endpoints (OpenAI direct, Azure OpenAI, GMI, etc.),
// and any `custom` kind that the user opted into. Gemini native and
// Anthropic's dedicated APIs are excluded — their Responses-equivalents
// are their own transports.
function canRunResponses(profile: ConnectionProfile): boolean {
  return (
    profile.kind === 'openrouter' ||
    profile.kind === 'openai-compatible' ||
    profile.kind === 'custom'
  )
}

function canRunTextCompletions(profile: ConnectionProfile, modelId: string): boolean {
  return profile.kind === 'openrouter' && isTextCompletionsSelectableFor(modelId)
}

function isOpenAiResponsesFormat(fmt: ReasoningFormat | undefined): boolean {
  return (
    fmt === 'openai-responses-v1' ||
    fmt === 'azure-openai-responses-v1' ||
    fmt === 'xai-responses-v1'
  )
}

// True when the path carries any assistant message with a
// `responsesEchoItem.type` outside the standard `message` | `reasoning` pair
// — that means the prior turn used a server tool (web_search_call,
// file_search_call, image_generation_call, code_interpreter_call,
// computer_call, mcp_tool_call) whose output can't be expressed on
// chat-completions.
function hasResponsesServerToolArtifact(path: readonly Message[]): boolean {
  for (const m of path) {
    const itemType = m.responsesEchoItem?.type
    if (
      itemType &&
      itemType !== 'message' &&
      itemType !== 'reasoning' &&
      itemType !== 'function_call' &&
      itemType !== 'function_call_output'
    ) {
      return true
    }
  }
  return false
}

function hasPriorOpenAiEncryptedReasoning(path: readonly Message[]): boolean {
  for (const m of path) {
    if (!m.reasoningDetails) continue
    for (const d of m.reasoningDetails) {
      if (d.type !== 'reasoning.encrypted') continue
      // Accept any OpenAI-family carrier; the router only asks "should we
      // stay on Responses to round-trip it?" — the transform decides the
      // exact `include:` list from `format`.
      if (isOpenAiResponsesFormat(d.format)) return true
      // If the carrier has no `format`, assume compatible (the ingest path
      // may have dropped it). Better to preserve than to discard.
      if (!d.format) return true
    }
  }
  return false
}

function openAiChat(reason: string): ApiRoute {
  return { kind: 'chat-completions', transport: 'openai-chat', reason }
}

function openAiText(reason: string): ApiRoute {
  return { kind: 'text-completions', transport: 'openai-text', reason }
}

function openAiResponses(reason: string): ApiRoute {
  return { kind: 'responses', transport: 'openai-responses', reason }
}

function geminiNative(reason: string): ApiRoute {
  return { kind: 'gemini-generate', transport: 'gemini-native', reason }
}

// Convenience predicates used by the UI to decide whether to enable the
// "API mode" segmented control's Responses button.
export function isResponsesCapable(profile: ConnectionProfile): boolean {
  return canRunResponses(profile)
}

export function isTextCompletionsCapable(profile: ConnectionProfile, modelId: string): boolean {
  return canRunTextCompletions(profile, modelId)
}

export function isGeminiNative(profile: ConnectionProfile): boolean {
  return profile.kind === 'google' && profile.geminiMode !== 'openai-compat'
}

// Short explanation suitable for a UI tooltip.
export function responsesExplanationFor(
  route: ApiRoute,
  profile: ConnectionProfile,
  caps: RouterCapabilities,
): string {
  if (caps.quirks.requiresResponsesApi) {
    return 'Responses API is required by this model to preserve phase metadata and chain-of-thought.'
  }
  if (caps.quirks.preferApi === 'responses') {
    return 'Responses API is recommended: it preserves encrypted reasoning across turns.'
  }
  if (profile.kind === 'openrouter' && route.kind === 'responses') {
    return 'OpenRouter’s /responses beta proxy. Item ids are rewritten; keep a chat on this route for best results.'
  }
  if (profile.kind === 'openai-compatible' && profile.usesResponsesApiByDefault) {
    return 'OpenAI direct: the Responses API is the default transport.'
  }
  return 'Responses API: preserves encrypted reasoning and multi-item output (phase, server tools).'
}
