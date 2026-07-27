// Core domain types. Source of truth for the app; storage and wire shapes derive from here.
//
// Conventions:
// - snake_case on the wire, camelCase internally
// - ULIDs for all ids (monotonic, 26 chars, lexicographically sortable)
// - `undefined` = "not in the domain"; `null` = "explicitly unset on the wire"
// - Append-only for ids/turn metadata; content and a few mutable fields use LWW inside the chat lock

import type {
  OpaqueReasoningCarrierV2 as FrozenOpaqueReasoningCarrierV2,
  OpaqueReasoningCarrierDescriptorV2 as FrozenOpaqueReasoningCarrierV2Descriptor,
  ReasoningEnvelopeMutationV2 as FrozenReasoningEnvelopeMutationV2,
  ReasoningEnvelopeV2Schema as FrozenReasoningEnvelopeV2,
  ReasoningProducerBridgeV2 as FrozenReasoningProducerBridge,
  ReasoningSourceRefV2 as FrozenReasoningSourceRefV2,
  ReasoningVisiblePartV2 as FrozenReasoningVisiblePartV2,
} from './generation-stream-events'

// ---------------------------------------------------------------------------
// Primitive IDs & enum-shaped literal unions
// ---------------------------------------------------------------------------

export type ChatId = string
export type MessageId = string
type TurnId = string
export type AttachmentId = string
type ToolDefinitionId = string
export type KeyId = string
export type ProfileId = string
export type PresetId = string
export type PromptPresetId = string
export type FolderId = string
export type TagId = string

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'developer'

export type MessageOrigin = 'user' | 'generated' | 'imported' | 'continued' | 'prefill'

export type ApiVariant =
  | 'auto'
  | 'chat'
  | 'responses'
  | 'text'
  | 'gemini-native'
  | 'anthropic-messages'

export type MessagePhase = 'commentary' | 'final_answer'

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error'

type DeliveryMethod = 'streaming' | 'buffered'

export type AbortReason = 'user' | 'tab-close' | 'error' | 'network' | 'quota'

type ContextStrategyKind = 'sliding_window' | 'middle_out_plugin' | 'off'

type OnOverflow = 'ask' | 'auto_compress' | 'fail'

export type MediaContextStrategy = 'echo-all' | 'echo-last-N' | 'echo-user-only' | 'drop-all'

type ToolContextStrategy = 'echo-all' | 'summarize-old'

type UserIdMode = 'omit' | 'stable-hash' | 'chat-id'

type ServiceTier = 'auto' | 'default' | 'flex' | 'priority' | 'scale'

export type ConnectionKind =
  | 'openrouter'
  | 'openai-compatible'
  | 'anthropic'
  | 'google'
  | 'llama-server'
  | 'custom'

// ---------------------------------------------------------------------------
// Sampling / reasoning / verbosity
// ---------------------------------------------------------------------------

export type SamplingKey =
  | 'temperature'
  | 'top_p'
  | 'top_k'
  | 'min_p'
  | 'top_a'
  | 'frequency_penalty'
  | 'presence_penalty'
  | 'repetition_penalty'
  | 'seed'
  | 'logprobs'
  | 'top_logprobs'
  // llama.cpp-only knobs. These ride on /v1/chat/completions and
  // /v1/completions to llama-server. They're surfaced by
  // `capabilities/llama-server.ts` and only render on llama-server
  // profiles; other backends reject them.
  | 'typical_p'
  | 'repeat_penalty'
  | 'repeat_last_n'
  | 'dynatemp_range'
  | 'dynatemp_exponent'
  | 'mirostat'
  | 'mirostat_tau'
  | 'mirostat_eta'
  | 'xtc_probability'
  | 'xtc_threshold'
  | 'dry_multiplier'
  | 'dry_base'
  | 'dry_allowed_length'
  | 'dry_penalty_last_n'
  | 'n_keep'

export type EffortLevel = 'max' | 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none'

export type VerbosityLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// `default` = don't emit the `reasoning` field, let the provider decide.
// `off` = explicit `reasoning.enabled: false`.
// `enabled` = explicit `reasoning.enabled: true` with no effort/budget.
// `effort` / `budget` = the two dimensional knobs when supported.
export type ReasoningMode = 'default' | 'off' | 'enabled' | 'effort' | 'budget'

type ReasoningSummary = 'off' | 'auto' | 'concise' | 'detailed'

/** Three independent flags — maps 1:1 to the three Phase-11.1 UI checkboxes.
 *  - `encrypted`: round-trip the family-native opaque carrier
 *    (OpenAI `encrypted_content`, Anthropic `signature`, Gemini
 *    `thoughtSignature`, xAI Grok).
 *  - `summary`: round-trip visible summary parts (OpenAI reasoning summaries,
 *    Gemini `thought: true` parts).
 *  - `text`: round-trip visible plaintext reasoning (Claude / DeepSeek / Qwen
 *    / Gemma).
 *  Each flag is independently gated by what the current route can round-trip. */
export interface ReasoningInclude {
  encrypted: boolean
  summary: boolean
  text: boolean
}

export interface ReasoningSettings {
  mode: ReasoningMode
  effort?: EffortLevel
  maxTokens?: number
  exclude: boolean
  summary?: ReasoningSummary
  /** Authoritative carry-forward control since Phase 11. */
  include: ReasoningInclude
  /**
   * Universal-compatibility transport for plaintext reasoning carriers on the
   * chat-completions route. When true, kept `reasoning.text` / `reasoning.summary`
   * entries are rewritten into a single `<think>...</think>` block prepended to
   * the assistant message content INSTEAD of being emitted in
   * `reasoning_details[]`. `reasoning.encrypted` entries are opaque and ride the
   * native carrier under `include.encrypted` regardless. Ignored on Responses
   * and Gemini-native routes (those have structured reasoning channels).
   */
  echoAsThinkTags?: boolean
}

export type ReasoningFormat =
  | 'unknown'
  | 'openai-responses-v1'
  | 'azure-openai-responses-v1'
  | 'xai-responses-v1'
  | 'anthropic-claude-v1'
  | 'google-gemini-v1'

export type KnownReasoningFormat = Exclude<ReasoningFormat, 'unknown'>

export type SealedReasoningCarryForward = 'none' | 'visible-only' | 'carrier'

export type PersistedReasoningCarryForward = SealedReasoningCarryForward | 'unknown'

export type ReasoningVisibleKind = 'text' | 'summary'

export type InboundReasoningVisibility =
  | Readonly<{
      disclosure: 'visible'
      visibleKind: ReasoningVisibleKind
    }>
  | Readonly<{
      disclosure: 'absent'
      unexpectedVisibleKind: ReasoningVisibleKind
      reason: 'api-mode' | 'request-display' | 'provider-default' | 'disabled'
    }>

export type PersistedInboundReasoningVisibility =
  | InboundReasoningVisibility
  | Readonly<{ disclosure: 'unknown' }>

export type ReasoningCarryForwardEvidence =
  | {
      readonly certainty: 'sealed'
      readonly value: SealedReasoningCarryForward
    }
  | {
      readonly certainty: 'opaque'
      readonly possible: Exclude<SealedReasoningCarryForward, 'none'>
    }

type ReasoningDetailMetadata = {
  id?: string
  index?: number
  hidden?: boolean
  providerItemId?: string
  providerOutputIndex?: number
  providerSummaryIndex?: number
}

export type ReasoningDetail = (
  | {
      type: 'reasoning.text'
      format: ReasoningFormat
      text?: string
      signature?: never
    }
  | {
      type: 'reasoning.text'
      format: ReasoningFormat
      text?: string
      signature: string
    }
  | {
      type: 'reasoning.summary'
      format: ReasoningFormat
      summary: string
    }
  | {
      type: 'reasoning.encrypted'
      format: ReasoningFormat
      data: string
    }
) &
  ReasoningDetailMetadata

export type ReasoningOriginDialect =
  | 'inline'
  | 'openai-chat'
  | 'openrouter-chat'
  | 'openai-responses'
  | 'openrouter-responses'
  | 'anthropic-messages'
  | 'gemini-native'
  | 'unknown'

export interface ReasoningSourceRef {
  dialect: ReasoningOriginDialect
  itemId?: string
  detailId?: string
  choiceIndex?: number
  outputIndex?: number
  contentIndex?: number
  summaryIndex?: number
  detailIndex?: number
  detailOrdinal?: number
  candidateIndex?: number
  frameIndex?: number
  partIndex?: number
  blockIndex?: number
}

export interface ReasoningVisiblePart {
  id: string
  groupId: string
  kind: 'text' | 'summary'
  text: string
  format: ReasoningFormat
  source: ReasoningSourceRef
  hidden?: boolean
}

interface OpaqueReasoningCarrierBase {
  id: string
  groupId: string
  format: ReasoningFormat
  source: ReasoningSourceRef
  hidden?: boolean
}

export type OpaqueReasoningCarrier =
  | (OpaqueReasoningCarrierBase & {
      kind: 'responses-encrypted'
      data: string
    })
  | (OpaqueReasoningCarrierBase & {
      kind: 'anthropic-signature'
      signature: string
      bindsVisiblePartId: string
    })
  | (OpaqueReasoningCarrierBase & {
      kind: 'anthropic-redacted'
      data: string
    })
  | (OpaqueReasoningCarrierBase & {
      kind: 'gemini-thought-signature'
      data: string
      bindsVisiblePartId?: string
    })
  | (OpaqueReasoningCarrierBase & {
      kind: 'unknown'
      data: string
    })

export type OpaqueReasoningCarrierDescriptor = OpaqueReasoningCarrier extends infer Carrier
  ? Carrier extends OpaqueReasoningCarrier
    ? Omit<Carrier, 'data' | 'signature'>
    : never
  : never

export type ReasoningProducerBridge = FrozenReasoningProducerBridge
export type ReasoningSourceRefV2 = FrozenReasoningSourceRefV2
export type ReasoningVisiblePartV2 = FrozenReasoningVisiblePartV2
export type OpaqueReasoningCarrierV2 = FrozenOpaqueReasoningCarrierV2
export type OpaqueReasoningCarrierV2Descriptor = FrozenOpaqueReasoningCarrierV2Descriptor
export type ReasoningEnvelopeV2 = FrozenReasoningEnvelopeV2
export type ReasoningEnvelopeMutationV2 = FrozenReasoningEnvelopeMutationV2

export type MessageAttemptOwner =
  | Readonly<{ kind: 'generation' }>
  | Readonly<{ kind: 'continuation'; streamId: string }>

export type ReasoningMemberRef =
  | { readonly owner: MessageAttemptOwner; readonly kind: 'visible'; readonly id: string }
  | { readonly owner: MessageAttemptOwner; readonly kind: 'carrier'; readonly id: string }

export interface ProviderOutputMemberRef {
  readonly owner: MessageAttemptOwner
  readonly itemIndex: number
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type ToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } }

export type ToolExecution =
  | { kind: 'manual' }
  | {
      kind: 'fetch'
      url: string
      method?: 'GET' | 'POST'
      headersTemplate?: string
      bodyTemplate?: string
      allowedOrigins?: string[]
    }
  | {
      kind: 'javascript'
      body: string
      timeoutMs: number
      allowedOrigins?: string[]
    }
  | { kind: 'server-tool'; serverId: string }

export interface ToolDefinition {
  id: ToolDefinitionId
  name: string
  description: string
  parameters: Record<string, unknown>
  execution: ToolExecution
  requiresApproval?: boolean
  createdAt: number
  updatedAt: number
}

export type OpenRouterServerToolId = 'web-search' | 'datetime' | 'web-fetch' | 'image-generation'
export type OpenAiServerToolId = 'web-search' | 'image-generation' | 'code-interpreter' | 'shell'
export type AnthropicServerToolId = 'web-search' | 'web-fetch' | 'code-execution' | 'advisor'
export type GoogleServerToolId = 'google-search' | 'url-context' | 'code-execution' | 'google-maps'

interface ApproximateLocation {
  country?: string
  region?: string
  city?: string
  timezone?: string
}

interface OpenAiToolConfigById {
  'web-search': {
    searchContextSize?: 'low' | 'medium' | 'high'
    allowedDomains?: string[]
    includeSources?: boolean
    userLocation?: ApproximateLocation
  }
  'image-generation': {
    model?: 'gpt-image-1' | 'gpt-image-1-mini' | 'gpt-image-1.5'
    size?: 'auto' | '1024x1024' | '1024x1536' | '1536x1024'
    quality?: 'auto' | 'low' | 'medium' | 'high'
    format?: 'png' | 'jpeg' | 'webp'
    partialImages?: number
  }
  'code-interpreter': {
    maxOutputLength?: number
  }
  shell: {
    networkPolicy?: { type: 'disabled' } | { type: 'allowlist'; allowedDomains: string[] }
    maxOutputLength?: number
  }
}

interface AnthropicToolConfigById {
  'web-search': {
    version?: 'web_search_20250305' | 'web_search_20260209'
    maxUses?: number
    allowedDomains?: string[]
    blockedDomains?: string[]
    userLocation?: ApproximateLocation
    allowedCallers?: 'direct-only' | 'dynamic-filtering'
  }
  'web-fetch': {
    version?: 'web_fetch_20250910' | 'web_fetch_20260209'
    maxUses?: number
    allowedDomains?: string[]
    blockedDomains?: string[]
    citationsEnabled?: boolean
    maxContentTokens?: number
    allowedCallers?: 'direct-only' | 'dynamic-filtering'
  }
  'code-execution': {
    version?: 'code_execution_20250825' | 'code_execution_20260120'
  }
  advisor: {
    advisorModel: 'claude-opus-4-7'
  }
}

interface GoogleToolConfigById {
  'google-search': {
    renderSearchEntryPoint?: boolean
  }
  'url-context': {
    maxUrls?: number
  }
  'code-execution': Record<string, never>
  'google-maps': {
    enableWidget?: boolean
    location?: { latitude: number; longitude: number }
  }
}

interface ProviderToolSettings<
  TServerToolId extends string,
  TConfigById extends Partial<Record<TServerToolId, unknown>>,
> {
  enabledServerToolIds: TServerToolId[]
  toolChoice?: ToolChoice
  parallelToolCalls?: boolean
  config?: Partial<TConfigById>
}

export interface ChatProviderToolSettings {
  openrouter: ProviderToolSettings<OpenRouterServerToolId, Record<string, never>>
  openai: ProviderToolSettings<OpenAiServerToolId, OpenAiToolConfigById>
  anthropic: ProviderToolSettings<AnthropicServerToolId, AnthropicToolConfigById>
  google: ProviderToolSettings<GoogleServerToolId, GoogleToolConfigById>
}

type PluginId = 'context-compression'

// ---------------------------------------------------------------------------
// Response format / structured output
// ---------------------------------------------------------------------------

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | {
      type: 'json_schema'
      jsonSchema: {
        name: string
        schema: Record<string, unknown>
        strict?: boolean
      }
    }

// ---------------------------------------------------------------------------
// Provider preferences / privacy
// ---------------------------------------------------------------------------

export type SortBy = 'price' | 'throughput' | 'latency'

type SortPartition = 'model' | 'none'

type ProviderSort = SortBy | { by: SortBy; partition: SortPartition }

export type PercentileBucket = {
  p50?: number
  p75?: number
  p90?: number
  p95?: number
  p99?: number
}

export interface ProviderPreferences {
  order?: string[]
  requireParameters?: boolean
  only?: string[]
  ignore?: string[]
  // True once the user clicks any provider checkbox. Signals that
  // `ignore` is the authoritative disallowed list; the wire builder
  // and picker both skip the filter's auto-exclusion when this is set.
  // Stays set even when `ignore` happens to be empty (e.g. user
  // re-enabled every filter-excluded row), so "touched" is distinct
  // from "trust the filter." Reset clears it back to `false`.
  ignoreOverridesFilter?: boolean
  quantizations?: string[]
  sort?: ProviderSort
  preferredMinThroughput?: number | PercentileBucket
  preferredMaxLatency?: number | PercentileBucket
  maxPrice?: {
    prompt?: number
    completion?: number
    request?: number
    image?: number
    audio?: number
  }
}

export interface PrivacyPrefs {
  denyDataCollection: boolean
  zdrOnly: boolean
  paretoFilter: boolean
  byokEnabled: boolean
}

export interface DataPolicy {
  training: boolean
  trainingOpenRouter: boolean
  retainsPrompts: boolean
  retentionDays?: number
  canPublish: boolean
  requiresUserIDs?: boolean
  termsOfServiceURL: string
  privacyPolicyURL: string
}

// ---------------------------------------------------------------------------
// Trace metadata
// ---------------------------------------------------------------------------

export interface TraceMetadata {
  traceId?: string
  traceName?: string
  spanName?: string
  generationName?: string
  parentSpanId?: string
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export interface AnthropicCacheSettings {
  mode: 'off' | 'automatic' | 'manual'
  ttl: '5m' | '1h'
  // Message index to place the final cache breakpoint at. Negative values
  // count back from the latest turn: -2 caches up to the second-to-last
  // message (so regenerating the last assistant turn is a cache hit), -1
  // caches through the last message. Positive values: pin exactly the first
  // N messages. 0 is a no-op (equivalent to mode=off). Default -2.
  breakpointIndex?: number
}

type CacheControl = { type: 'ephemeral'; ttl?: '1h' }

// ---------------------------------------------------------------------------
// ChatSettings
// ---------------------------------------------------------------------------

interface ContextStrategy {
  kind: ContextStrategyKind
  reservedForCompletion: number
  onOverflow: OnOverflow
  // Pin the first N user+assistant pairs at the top of the chat. The
  // sliding-window path always keeps as-many-recent-as-fit; the user's
  // knob is whether to ALSO keep a handful of anchor turns at the start
  // (useful for lore / setup / important early context). 0 = pure
  // sliding window (drop oldest).
  keepFirstPairs?: number
  // When true, send OpenRouter's `plugins: [{id: 'context-compression'}]`
  // alongside client-side trimming. Server-side middle-out compresses what
  // remains after the local trim.
  useOpenRouterMiddleOut?: boolean
}

export interface ChatSettings {
  profileId: ProfileId
  model: string
  fallbackModels?: string[]
  systemPrompt: string
  // Optional pin back to a PromptPreset (`kind: 'system'`). When set AND the
  // preset still exists, the preset is the canonical source — configuration
  // commands propagate preset edits to `systemPrompt`. Editing the
  // text locally clears the pin; deleting the preset clears the pin but
  // preserves the last propagated text.
  systemPromptPresetId?: PromptPresetId
  systemRole: 'system' | 'developer'
  // Silently appended to the LAST user message on the wire (regular send,
  // regenerate, save-and-send). Stripped from history so older turns never
  // accumulate it. During non-prefill continue the synthetic continue-user
  // wrapper is skipped and the append rides on the previous (real) user
  // turn instead. Whitespace is preserved verbatim — leading newlines are
  // a feature, not a bug. Empty = no append.
  appendPrompt: string
  appendPromptPresetId?: PromptPresetId
  // Continue-in-place overrides. Template; `[SYSTEM_PROMPT]` expands to the
  // chat's own `systemPrompt` verbatim. Empty = send no system message
  // during continue. See `core/global-settings.ts` for the template helper.
  continueSystemPrompt: string
  continueSystemPromptPresetId?: PromptPresetId
  // Synthetic trailing user message appended during continue-in-place.
  // Empty = fall back to the double-assistant shape (worse on some models).
  continueUserPrompt: string
  continueUserPromptPresetId?: PromptPresetId
  // Default prefill text seeded into the prefill box whenever the user opens
  // prefill on this chat (composer or Edit-and-Send, NOT Continue). Blank
  // means "start empty". Shown above the continue prompts in the generation
  // tab. Optional pin back to a `PromptPreset`
  // (`kind: 'prefill'`) follows the same propagation rules as the other
  // prompt slots.
  defaultPrefill?: string
  defaultPrefillPresetId?: PromptPresetId
  // Continue-in-place mode. When true, Continue sends the history with the
  // target assistant message as a real prefill (trailing `role: 'assistant'`,
  // no synthetic double-assistant shape). When false (default), Continue
  // uses the continueSystemPrompt + continueUserPrompt template flow. The
  // continue-prompt textareas hide in settings when this is true.
  continuePrefill?: boolean
  sampling: Partial<Record<SamplingKey, number>>
  stop?: string[]
  modalities?: Array<'text' | 'image' | 'audio' | 'video'>
  reasoning: ReasoningSettings
  verbosity?: VerbosityLevel
  maxCompletionTokens?: number
  // User-imposed ceiling on prompt tokens. Never exceeds the model's own
  // cap, but lets the user trim down for cost / latency / behaviour. When
  // undefined, the model's advertised cap is used.
  customMaxContext?: number
  // When true, route only to providers that support every set parameter
  // (wire: `provider.require_parameters: true`) and restrict the UI to the
  // intersection of retained-provider capabilities. Default false: show the
  // union so UI controls are discoverable; providers silently drop
  // parameters they don't support.
  strictProviderRouting?: boolean
  contextStrategy: ContextStrategy
  allowFallbacks: boolean
  mediaContextStrategy: MediaContextStrategy
  mediaEchoN?: number
  cacheRemoteImages: boolean
  stripExifOnUpload: boolean
  toolContextStrategy: ToolContextStrategy
  toolContextSummarizeAfterN?: number
  toolCallContext: {
    include: boolean
  }
  enabledToolIds: ToolDefinitionId[]
  // Provider-hosted server tools. Each active provider bucket owns its native
  // wire mapping and must not reuse another provider's request carrier.
  tools: ChatProviderToolSettings
  enabledPluginIds: PluginId[]
  trustedToolIds: ToolDefinitionId[]
  autoContinueToolLoop: boolean
  responseFormat?: ResponseFormat
  logitBias?: Record<string, number>
  anthropicCache: AnthropicCacheSettings
  providerPrefs?: ProviderPreferences
  privacy: PrivacyPrefs
  api: ApiVariant
  sessionId?: string
  userIdMode: UserIdMode
  metadata?: Record<string, string>
  trace?: TraceMetadata
  serviceTier?: ServiceTier
  // llama-server only — reuse the server-side KV cache across requests.
  // The wire default (when omitted) is true. Set false to force a fresh
  // prompt evaluation (useful when the shared prefix changed and the
  // server's slot-similarity heuristic is too permissive).
  cachePrompt?: boolean
  // llama-server only — which wire protocol to use. 'chat' posts to
  // /v1/chat/completions (server-side template application); 'text' posts
  // to /v1/completions with a pre-rendered prompt string. Undefined on
  // non-llama profiles. See `capabilities/llama-server.ts`.
  protocol?: 'chat' | 'text'
  // Template id for text-completions prompt rendering. For llama-server,
  // 'default' delegates to the GGUF/server chat_template via /apply-template.
  // OpenRouter has no per-model embedded template surface, so 'default' is
  // not offered there and stale values fall back to a client-rendered template.
  // Built-in ids and user-defined global-template ids are resolved through
  // `core/text-templates.ts`; 'raw' is a Jinja-style plaintext continuation
  // template; 'custom' remains a per-chat escape hatch via
  // `customTextTemplate`.
  textTemplate?: TextTemplateId
  // Only read when `textTemplate === 'custom'`. The shape matches the
  // bundled templates so the renderer can use one code path. Empty strings
  // are legitimate (any prefix/suffix may be omitted).
  customTextTemplate?: TextTemplateConfig
  // OpenAI Responses-API-specific knobs. Only read on the `responses` route;
  // chat-completions ignores the block entirely.
  responses?: ResponsesChatSettings
  // Gemini-specific knobs.
  gemini?: GeminiChatSettings
}

interface ResponsesChatSettings {
  /** Pass through to OpenAI. Default is `false` (stateless, privacy). */
  store: boolean
}

interface GeminiChatSettings {
  /** When set, `cachedContents/<name>` passed as `cachedContent` on the
   *  request. Phase 14 wires the management UI; preserved here for round-trip. */
  cachedContentName?: string
}

export type TextTemplateId = string

// Shape of a client-rendered text-completion template. `template`, when set,
// is the Jinja-style plaintext source rendered into the `/completions` prompt.
// Prefix/suffix fields are kept so old saved templates and built-ins can
// round-trip; UI edits save template source.
//
// See `SillyTavern/default/content/presets/instruct/*.json` for the
// schema this is modeled on (trimmed to the essentials).
export interface TextTemplateConfig {
  template?: string
  includeSystemPrompt?: boolean
  userPrefix: string
  userSuffix: string
  assistantPrefix: string
  assistantSuffix: string
  systemPrefix: string
  systemSuffix: string
  bos: string
  stop: string[]
}

interface ComposeOverrides {
  enabledToolIds?: ToolDefinitionId[]
  tools?: Partial<ChatProviderToolSettings>
  enabledPluginIds?: PluginId[]
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

interface ChatDraft {
  text: string
  attachmentRefs: MessageAttachmentRef[]
  composeOverrides?: ComposeOverrides
  overrides?: Partial<ChatSettings>
  prefillEnabled?: boolean
  cachePinEnabled?: boolean
  updatedAt: number
}

export interface DraftRow extends ChatDraft {
  chatId: ChatId
}

// ---------------------------------------------------------------------------
// Chat + organization
// ---------------------------------------------------------------------------

export type ChatTitleStatus = 'untitled' | 'pending' | 'auto' | 'manual' | 'auto-failed'

export interface ConfigurationRequestRevision {
  profileId: ProfileId
  requestRevision: number
  key:
    | { kind: 'missing' }
    | {
        kind: 'material'
        keyId: KeyId
        materialRevision: number
      }
}

export interface PendingModelResolution {
  intentId: string
  target: ConfigurationRequestRevision
  sourceModelId: string
  expectedConfigurationVersion: number
}

export interface Chat {
  id: ChatId
  title: string
  titleStatus: ChatTitleStatus
  createdAt: number
  updatedAt: number
  lastViewedAt: number
  wordCount: number
  totalCostUsd: number
  metaVersion: number
  summaryVersion: number
  structuralVersion: number
  configurationVersion?: number
  settings: ChatSettings
  presetId?: PresetId
  modelResolution?: PendingModelResolution
  lastUpdatedLeafId: MessageId | null
  lastBranchUpdatedAt: number
  archived: boolean
  pinned: boolean
  color?: string
  folderId: FolderId | null
  tags: TagId[]
  favoriteModels?: string[]
  recentModels?: string[]
  // Temporary rows exist only after `#/new` needs a real chat owner for
  // send/import/settings. If they never receive messages, they are discarded
  // on navigation.
  temporary?: boolean
  // Denormalized sidebar preview: plaintext of the earliest live user
  // message, trimmed to a generous single-line cap. Maintained atomically
  // whenever a user message is created, edited, or deleted. The sidebar
  // reads this directly off the chat row so listing N chats never has to
  // touch the `messages` table (critical once a workspace holds
  // thousands of chats). Optional because old rows are backfilled before
  // app render.
  previewText?: string
  // Running-sum calibration for chars-per-token. Keyed by the durable
  // calibration bucket: shared-tokenizer family key when known, otherwise the
  // canonicalized structural model key. Updated on every successful stream
  // completion in this chat. Optional for backcompat; absence falls through
  // to global + hardcoded tiers.
  tokenCalibration?: Record<string, TokenCalibrationSample>
  // Monotonic fence for optional post-commit calibration work. Explicit
  // calibration clears advance it even when the sample map is already empty.
  tokenCalibrationGeneration?: number
}

export type ChatSidebarRow = Pick<
  Chat,
  | 'id'
  | 'title'
  | 'titleStatus'
  | 'createdAt'
  | 'updatedAt'
  | 'lastViewedAt'
  | 'wordCount'
  | 'totalCostUsd'
  | 'lastUpdatedLeafId'
  | 'lastBranchUpdatedAt'
  | 'archived'
  | 'pinned'
  | 'folderId'
  | 'tags'
  | 'previewText'
>

// One per (chat, calibration-bucket) pair. Running sums; new samples add
// directly.
// Ratio at any point is `totalTextChars / totalTextTokens`; that ratio is
// automatically weighted by sample size (a 300-token completion
// contributes 60× more than a 5-token user message), so no explicit
// weighting is needed.
export interface TokenCalibrationSample {
  totalTextChars: number
  totalTextTokens: number
  sampleCount: number
  lastRatio?: number
  updatedAt: number
}

// Global calibration rollup. Stored in the settings table under key
// `global:token-calibration`. It is a materialized sum of per-chat
// calibration samples: accepted samples add one delta, chat clears subtract
// the removed samples, and whole-family clears scan only for that explicit
// operation. Normal reads stay O(number of calibrated families), not
// O(totalChats).
export interface GlobalTokenCalibration {
  version: 1
  updatedAt: number
  // Explicit clears advance this fence so an older deferred rollup cannot
  // repopulate data after the clear.
  clearGeneration?: number
  // Same keying contract as `Chat.tokenCalibration`.
  byModel: Record<string, TokenCalibrationSample>
}

export interface ChatFolder {
  id: FolderId
  name: string
  color?: string
  sortIndex: number
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

export interface ChatTag {
  id: TagId
  name: string
  nameLower: string
  color?: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

export interface ChildListState {
  id: string
  chatId: ChatId
  parentId: MessageId | null
  version: number
  updatedAt: number
  liveCount: number
  firstLiveChildId: MessageId | null
  lastLiveChildId: MessageId | null
  nextSiblingIndex: number
}

export interface ChildSlotMember {
  id: MessageId
  chatId: ChatId
  parentId: MessageId | null
  parentKey: string
  position: number
  previousMessageId: MessageId | null
  nextMessageId: MessageId | null
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

type GeneratedOutputLocator =
  | { attachmentId: AttachmentId; url?: never }
  | { attachmentId?: never; url: string }

type OptionalContentLocator = GeneratedOutputLocator | { attachmentId?: never; url?: never }

export type ContentItem =
  | { type: 'text'; text: string; cacheControl?: CacheControl }
  | {
      type: 'image_url'
      attachmentId?: AttachmentId
      url?: string
      detail?: 'low' | 'high' | 'auto'
    }
  | {
      type: 'input_audio'
      attachmentId?: AttachmentId
      format: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a'
    }
  | ({
      type: 'file'
      filename: string
      mime: string
    } & OptionalContentLocator)
  | { type: 'video_url'; attachmentId?: AttachmentId; url?: string }
  | { type: 'output_text'; text: string; annotations?: ContentAnnotation[] }
  | ({
      type: 'output_image'
      prompt?: string
    } & GeneratedOutputLocator)
  | ({
      type: 'audio_output'
      transcript?: string
      durationMs?: number
      format?: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'pcm16'
    } & OptionalContentLocator)
  | ({
      type: 'output_video'
      prompt?: string
    } & GeneratedOutputLocator)

export type ContentAnnotationSource =
  | 'openai-responses'
  | 'openai-chat'
  | 'anthropic-messages'
  | 'gemini-native'
  | 'imported'
  | 'unknown'

export type CitationFileIdentity =
  | { kind: 'attachment'; attachmentId: AttachmentId }
  | {
      kind: 'provider-file'
      provider: ContentAnnotationSource
      fileId: string
      containerId?: string
    }
  | { kind: 'document'; provider: ContentAnnotationSource; documentIndex: number }
  | { kind: 'unresolved'; provider: ContentAnnotationSource }

interface ContentAnnotationBase {
  startIndex: number
  endIndex: number
  source: ContentAnnotationSource
  providerPayload: Record<string, unknown>
}

export type ContentAnnotation =
  | (ContentAnnotationBase & {
      type: 'url_citation'
      url: string
      title?: string
    })
  | (ContentAnnotationBase & {
      type: 'file_citation'
      file: CitationFileIdentity
      filename?: string
      title?: string
      citedText?: string
    })
  | (ContentAnnotationBase & {
      type: 'unknown'
      annotationType: string
    })

export interface MessageApproval {
  state: 'pending' | 'approved' | 'denied'
  approvedAt?: number
  approvedBy?: string
}

// Wire-shape usage payload held verbatim for round-trip fidelity.
export interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  server_tool_use?: Record<string, number>
  prompt_tokens_details?: {
    cached_tokens?: number
    audio_tokens?: number
    image_tokens?: number
  }
  completion_tokens_details?: {
    reasoning_tokens?: number
    audio_tokens?: number
    accepted_prediction_tokens?: number
    rejected_prediction_tokens?: number
  }
  cost?: number
  cost_details?: {
    upstream_inference_cost?: number
    upstream_inference_prompt_cost?: number
    upstream_inference_completions_cost?: number
  }
  cache_creation_input_tokens?: number
}

export type AttemptFailureCategory =
  | 'abort'
  | 'network'
  | 'protocol'
  | 'provider'
  | 'storage'
  | 'integrity'
  | 'internal'

export interface PersistedAttemptFailure {
  category: AttemptFailureCategory
  code: string
  message: string
  statusCode?: number
  provider?: string
  retryable?: boolean
  midStream?: boolean
}

export type AttemptIntegrityState = 'clean' | 'degraded' | 'failed'

export interface AttemptIntegrityEntry {
  category: 'malformed-json-frame' | 'malformed-event-shape'
  adapter:
    | 'chat-completions'
    | 'responses'
    | 'gemini-native'
    | 'anthropic-messages'
    | 'text-completions'
  eventType: string
  count: number
  fingerprint: string
  characterCount: number
}

export interface AttemptIntegritySummary {
  count: number
  characterCount: number
  entries: AttemptIntegrityEntry[]
}

export interface GenerationServerToolCall {
  type: string
  source: 'responses-output' | 'stream-status' | 'usage' | 'provider-output'
  id?: string
  status?: string
  outputIndex?: number
  requestCount?: number
}

interface GenerationTokenCalibration {
  sampleId: string
  modelId: string
  calibrationKey: string
  promptSample: boolean
  completionSample: boolean
  sampleCount: number
  appliedAt: number
}

export type ProviderOutputDialect =
  | 'openai-responses'
  | 'openrouter-responses'
  | 'google-gemini'
  | 'anthropic-claude'
  | 'unknown'

export interface ProviderOutputItem {
  dialect: ProviderOutputDialect
  type: string
  captureId?: string
  outputIndex?: number
  hidden?: boolean
  edited?: boolean
  item: unknown
}

export interface GenerationMeta {
  id?: string
  model?: string
  requestedModel?: string
  requestedModels?: string[]
  provider?: string
  apiUsed?:
    | 'chat'
    | 'responses'
    | 'gemini-native'
    | 'anthropic-messages'
    | 'completion'
    | 'video-generation'
  delivery?: DeliveryMethod
  status?: 'preparing' | 'streaming' | 'done' | 'error' | 'abort' | 'interrupted'
  integrity?: AttemptIntegrityState
  integritySummary?: AttemptIntegritySummary
  usage?: ChatUsage
  cost?: number
  costSource?: 'stream' | 'generation-endpoint' | 'estimated'
  startedAt: number
  firstTextAt?: number
  reasoningStartedAt?: number
  reasoningFinishedAt?: number
  finishedAt?: number
  finishReason?: FinishReason
  nativeFinishReason?: string
  error?: PersistedAttemptFailure
  abortReason?: AbortReason
  serverTools?: GenerationServerToolCall[]
  tokenCalibration?: GenerationTokenCalibration
  reasoningCarryForward: PersistedReasoningCarryForward
  reasoningVisibility: PersistedInboundReasoningVisibility
}

export interface DispatchedGenerationMeta {
  model: string
  requestedModel: string
  apiUsed: NonNullable<GenerationMeta['apiUsed']>
  delivery: DeliveryMethod
  status: 'streaming'
  integrity: 'clean'
  costSource: 'stream'
  startedAt: number
  reasoningCarryForward: PersistedReasoningCarryForward
  reasoningVisibility: InboundReasoningVisibility
}

export type ContinuationStrategy = 'prompt' | 'prefill'

export type ContinuationAttemptStrategy = ContinuationStrategy | 'unknown'

export type ContinuationAttemptStatus = 'done' | 'error' | 'abort' | 'interrupted'

export type ContinuationAttemptApplication =
  | Readonly<{ kind: 'applied' }>
  | Readonly<{ kind: 'unapplied'; reason: 'base-version-changed' }>

export interface ContinuationAttemptDraft {
  streamId: string
  strategy: ContinuationAttemptStrategy
  status: ContinuationAttemptStatus
  integrity?: AttemptIntegrityState
  integritySummary?: AttemptIntegritySummary
  requestedModel?: string
  model?: string
  apiUsed?: GenerationMeta['apiUsed']
  provider?: string
  generationId?: string
  startedAt: number
  firstTextAt?: number
  reasoningStartedAt?: number
  reasoningFinishedAt?: number
  finishedAt: number
  usage?: ChatUsage
  cost?: number
  costSource?: GenerationMeta['costSource']
  finishReason?: FinishReason
  nativeFinishReason?: string
  error?: PersistedAttemptFailure
  abortReason?: AbortReason
  reasoningEnvelope?: ReasoningEnvelopeV2
  toolCalls?: ToolCall[]
  phase?: MessagePhase
  providerOutputItems?: ProviderOutputItem[]
  reasoningCarryForward: PersistedReasoningCarryForward
  reasoningVisibility: PersistedInboundReasoningVisibility
}

export type ContinuationAttempt = ContinuationAttemptDraft &
  (
    | Readonly<{ application: Readonly<{ kind: 'applied' }> }>
    | Readonly<{
        application: Readonly<{ kind: 'unapplied'; reason: 'base-version-changed' }>
        unappliedText?: string
        unappliedAnnotations?: ContentAnnotation[]
      }>
  )

// Minimal echo envelope for a Responses API output item. The full variant list
// lives in transforms; this shape stays open so callers can round-trip unknown
// item types without losing data.
export interface ResponsesOutputItem {
  type: string
  id?: string
  [key: string]: unknown
}

export interface Message {
  id: MessageId
  chatId: ChatId
  parentId: MessageId | null
  siblingIndex: number
  turnId: TurnId
  turnIndex: number
  createdAt: number
  editedAt?: number
  role: MessageRole
  origin: MessageOrigin
  generation?: GenerationMeta
  content: ContentItem[]
  reasoningEnvelope?: ReasoningEnvelopeV2
  toolCalls?: ToolCall[]
  refusal?: string
  phase?: MessagePhase
  providerOutputItems?: ProviderOutputItem[]
  continuationAttempts?: ContinuationAttempt[]
  attachmentRefs?: MessageAttachmentRef[]
  approval?: MessageApproval
  nodeVersion: number
  pinCache?: boolean
  hiddenFromContext?: boolean
  deleted: boolean

  // ---- Token-calibration fields ----
  // All optional for backcompat; rehydrated old rows fall through to the
  // fresh/cross-model path.

  // Character count at message creation (text content only, no media). For
  // assistant messages in the inline-`<think>` family, also includes the
  // lifted reasoning-text chars; those were billed as completion tokens on
  // the wire, so calibration should see them. Encrypted / signed reasoning
  // (out-of-band reasoning_tokens) is NOT included. Immutable once set.
  originalCharCount?: number
  // Text-token estimate at creation time using the then-current calibration
  // ratio. Used for same-bucket delta estimates. Immutable once set.
  originalTokenEstimate?: number
  // Model ID at creation time, e.g. `openai/gpt-4o`. Exact provenance only;
  // the calibration bucket is tracked separately.
  originalModelId?: string
  // Calibration bucket at creation time. Usually the tokenizer-family key; if
  // no family is known, the canonicalized structural model key. Preserving
  // this separately keeps future family-table updates from changing the
  // meaning of newly-created rows.
  originalCalibrationKey?: string
  // Running delta from `originalCharCount` after in-place edits (+/-).
  // Starts at 0; updated on every edit. Stays 0 if the message is never
  // edited.
  charCountDelta?: number
  // Cached text-token estimate under the chat's CURRENT model + calibration
  // ratio at time of last write. Gauge path prefers this over fresh; only
  // stale until the next edit of THIS message (or discrete refresh event).
  cachedTokenEstimate?: number
  // Cached attachment cost (image / PDF / file heuristic) for the message's
  // current content array. Invalidated only when media items change.
  cachedMediaTokens?: number
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export type AttachmentKind =
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'plaintext'
  | 'code'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'other'
  /** @deprecated Legacy pre-Phase-12 catch-all. New rows use `other`. */
  | 'file'

export type AttachmentOrigin =
  | 'user-upload'
  | 'user-remote-url'
  | 'generated-output'
  | 'server-tool-peel'
  | 'import'
  | 'system-fixture'

export type AttachmentMissingReason =
  | 'quota'
  | 'deleted'
  | 'import-missing'
  | 'integrity-failed'
  | 'processing-error'
  | 'blob-not-found'

export type AttachmentStorage =
  | { kind: 'local-blob'; blobId: string }
  | { kind: 'remote-url'; url: string }
  | {
      kind: 'missing'
      reason: AttachmentMissingReason
      missingSince: number
      lastKnownBlobId?: string
    }

export interface AttachmentTokenEstimate {
  modelKey: string
  modality: AttachmentKind
  contextForm:
    | 'native-image'
    | 'native-audio'
    | 'native-video'
    | 'native-file'
    | 'openrouter-file-parser'
    | 'client-extracted-text'
    | 'remote-url'
    | 'omitted'
  tokens: number
  source: 'server-usage' | 'heuristic' | 'calibrated-text' | 'manual-zero'
  computedAt: number
  processorId?: string
}

export type AttachmentArtifact =
  | {
      kind: 'text'
      artifactId: string
      attachmentId: AttachmentId
      processorId: string
      text: string
      charCount: number
      tokenEstimate?: AttachmentTokenEstimate
      createdAt: number
    }
  | {
      kind: 'json'
      artifactId: string
      attachmentId: AttachmentId
      processorId: string
      value: unknown
      createdAt: number
    }
  | {
      kind: 'blob'
      artifactId: string
      attachmentId: AttachmentId
      processorId: string
      blobId: string
      createdAt: number
    }

type AttachmentProcessingStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

interface AttachmentProcessingState {
  processorId: string
  inputHash: string
  status: AttachmentProcessingStatus
  startedAt?: number
  finishedAt?: number
  error?: { code: string; message: string }
  outputArtifactIds: string[]
}

export interface GeneratedOutputLocalizationTask {
  kind: 'generated-output-localization-v1'
  expectedSourceUrl: string
  requestCredential?: {
    profileId: ProfileId
    selectedKeyId: KeyId
  }
}

export interface AttachmentJob extends AttachmentProcessingState {
  id: string
  attachmentId: AttachmentId
  task?: GeneratedOutputLocalizationTask
  attemptCount?: number
  nextAttemptAt?: number
  leaseId?: string
  leaseExpiresAt?: number
  updatedAt: number
}

export interface AttachmentBlob {
  id: string
  attachmentId: AttachmentId
  role: 'original' | 'thumbnail' | 'image-resize' | 'normalized' | 'tool-peel'
  mime: string
  contentHash: string
  sizeBytes: number
  blob: Blob
  createdAt: number
}

export interface MessageAttachmentRef {
  refId: string
  attachmentId: AttachmentId
  includeInContext: boolean
  presentation: {
    label?: string
    imageDetail?: 'low' | 'high' | 'auto'
    pdfTier?: 'native' | 'plugin' | 'client'
    preferredArtifactId?: string
  }
  tokenEstimate?: AttachmentTokenEstimate
  missingResolution?: {
    promptedAt: number
    action: 'reupload-later' | 'exclude-from-context' | 'use-text-artifact'
  }
  createdAt: number
  updatedAt: number
  deletedAt?: number
}

export type AttachmentRef = MessageAttachmentRef

export interface AttachmentReferenceEdge {
  ownerKind: 'message' | 'draft'
  ownerId: string
  chatId: ChatId
  refId: string
  attachmentId: AttachmentId
  ordinal: number
  includeInContext: boolean
  refUpdatedAt: number
}

export interface Attachment {
  id: AttachmentId
  contentHash?: string
  kind: AttachmentKind
  mime: string
  filename: string
  extension?: string
  sizeBytes?: number
  origin: AttachmentOrigin
  sourceUrl?: string
  createdAt: number
  updatedAt: number
  storage: AttachmentStorage
  dimensions?: { width: number; height: number }
  durationMs?: number
  pageCount?: number
  textCharCount?: number
  languageHint?: string
  scannedLike?: boolean
  thumbnailBlobId?: string
  artifacts: AttachmentArtifact[]
  processing: AttachmentProcessingState[]
  refCount: number
  deletedAt?: number
  supersededByAttachmentId?: string
  lastIntegrityCheckAt?: number
}

// ---------------------------------------------------------------------------
// Connections, presets, keys
// ---------------------------------------------------------------------------

export type EndpointPrefillCapability =
  | { kind: 'unsupported' }
  | { kind: 'assistant-tail'; marker: 'none' | 'partial' | 'prefix' }
  | { kind: 'native-model-tail' }
  | { kind: 'text-prefix' }

export interface CapabilityDescriptor {
  supportedParameters: string[]
  streaming: 'supported' | 'buffered-only' | 'unsupported'
  contextLength?: number
  maxPromptTokens?: number
  maxCompletionTokens?: number
  pricing?: {
    prompt?: string
    completion?: string
    reasoning?: string
    image?: string
    audio?: string
  }
  architecture?: {
    inputModalities?: Array<'text' | 'image' | 'audio' | 'video' | 'file'>
    outputModalities?: Array<'text' | 'image' | 'audio' | 'video'>
  }
  prefill?: EndpointPrefillCapability
}

type CapabilityOverride = Partial<CapabilityDescriptor>

export interface ConnectionProfile {
  id: ProfileId
  name: string
  kind: ConnectionKind
  baseUrl: string
  apiKeyRef?: KeyId
  apiKeyFallbackRefs?: KeyId[]
  managementApiKeyRef?: KeyId
  defaultHeaders: Record<string, string>
  appTitle: string
  appUrl: string
  appCategories?: string[]
  supportsEndpointsApi: boolean
  supportsGenerationApi: boolean
  supportsPrivacyScrape: boolean
  capabilityOverrides?: Record<string, CapabilityOverride>
  debugRequests?: boolean
  requestRevision?: number
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  archived?: boolean
}

export type ConnectionHttpProfile = Pick<
  ConnectionProfile,
  'kind' | 'baseUrl' | 'defaultHeaders' | 'appTitle' | 'appUrl' | 'appCategories'
>

export interface ChatPreset {
  id: PresetId
  name: string
  connectionProfileId: ProfileId
  settings: ChatSettings
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  archived?: boolean
}

// Prompt slot a PromptPreset fills. Each ChatSettings has one pin slot per
// kind. Storage is keyed by `id` alone; `kind` filters the picker.
export type PromptPresetKind = 'system' | 'append' | 'continue-system' | 'continue-user' | 'prefill'

// A named, workspace-global prompt snapshot. Unlike ChatPreset (per-profile
// bundle of the full ChatSettings), PromptPresets are kind-scoped and hold
// just a label + text.
export interface PromptPreset {
  id: PromptPresetId
  kind: PromptPresetKind
  name: string
  text: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

export interface KeyRecord {
  id: KeyId
  name: string
  ciphertext: string
  iv: string
  salt: string
  algorithm: 'AES-GCM-256'
  kdf: { name: 'PBKDF2'; iterations: 200000; hash: 'SHA-256' }
  passphraseHint?: string
  obscuredPreview: string
  materialRevision?: number
  createdAt: number
  lastUsedAt?: number
}

export type MutationScope =
  | { kind: 'chat-meta'; chatId: ChatId }
  | { kind: 'chat-topology'; chatId: ChatId }
  | { kind: 'message'; messageId: MessageId; access?: 'presentation' }
  | { kind: 'children'; chatId: ChatId; parentId: MessageId | null }
  | { kind: 'draft'; chatId: ChatId }
  | { kind: 'attachment'; attachmentId: AttachmentId }

export interface ChatVersions {
  metaVersion: number
  summaryVersion: number
  structuralVersion: number
}

// ---------------------------------------------------------------------------
// /models + /endpoints cache shapes
// ---------------------------------------------------------------------------

export interface ModelEndpoint {
  id?: string
  provider_name: string
  provider_display_name?: string
  provider_slug?: string
  provider_model_id?: string
  supported_parameters: string[]
  context_length: number
  data_policy?: DataPolicy
  max_prompt_tokens?: number
  max_completion_tokens?: number
  pricing: {
    prompt?: string
    completion?: string
    [extra: string]: string | undefined
  }
  supports_implicit_caching?: boolean
  quantization?: string
  status?: string
  uptime_last_5m?: number
  uptime_last_30m?: number
  uptime_last_1d?: number
  latency_last_30m?: PercentileBucket
  throughput_last_30m?: Record<string, unknown>
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
    tokenizer?: string
  }
}

export interface ModelListEntry {
  id: string
  canonicalSlug?: string
  name?: string
  description?: string
  created?: number
  contextLength?: number
  architecture?: {
    inputModalities?: string[]
    outputModalities?: string[]
    tokenizer?: string
  }
  pricing?: Record<string, string | undefined>
  topProvider?: Record<string, unknown>
  perRequestLimits?: Record<string, unknown>
  supportedParameters?: string[]
  defaultParameters?: Record<string, number>
  expirationDate?: string
  knowledgeCutoff?: string
  huggingFaceId?: string
  links?: { details?: string }
}

export interface EndpointsDescriptor {
  modelId: string
  name?: string
  description?: string
  contextLength?: number
  architecture?: ModelEndpoint['architecture']
  endpoints: ModelEndpoint[]
}

export interface ModelsQuery {
  outputModalities?: readonly string[]
  supportedParameters?: readonly string[]
}
