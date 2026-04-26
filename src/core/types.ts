// Core domain types. Source of truth for the app; storage and wire shapes derive from here.
// See `plan/02-data-model.md` for rationale and invariants.
//
// Conventions:
// - snake_case on the wire, camelCase internally
// - ULIDs for all ids (monotonic, 26 chars, lexicographically sortable)
// - `undefined` = "not in our domain"; `null` = "explicitly unset on the wire"
// - Append-only for ids/turn metadata; content and a few mutable fields use LWW inside the chat lock

// ---------------------------------------------------------------------------
// Primitive IDs & enum-shaped literal unions
// ---------------------------------------------------------------------------

export type ChatId = string
export type MessageId = string
export type TurnId = string
export type AttachmentId = string
export type ToolDefinitionId = string
export type KeyId = string
export type ProfileId = string
export type PresetId = string
export type PromptPresetId = string
export type FolderId = string
export type TagId = string

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'developer'

export type MessageOrigin = 'user' | 'generated' | 'imported' | 'continued' | 'prefill'

export type ApiVariant = 'auto' | 'chat' | 'responses' | 'text'

export type MessagePhase = 'commentary' | 'final_answer'

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error'

export type DeliveryMethod = 'streaming' | 'buffered'

export type AbortReason = 'user' | 'tab-close' | 'error' | 'network' | 'quota'

export type ContextStrategyKind = 'sliding_window' | 'middle_out_plugin' | 'off'

export type OnOverflow = 'ask' | 'auto_compress' | 'fail'

export type MediaContextStrategy = 'echo-all' | 'echo-last-N' | 'echo-user-only' | 'drop-all'

export type ToolContextStrategy = 'echo-all' | 'summarize-old'

export type UserIdMode = 'omit' | 'stable-hash' | 'chat-id'

export type ServiceTier = 'auto' | 'default' | 'flex' | 'priority' | 'scale'

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

export type EffortLevel = 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none'

export type VerbosityLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// `default` = don't emit the `reasoning` field, let the provider decide.
// `off` = explicit `reasoning.enabled: false`.
// `enabled` = explicit `reasoning.enabled: true` with no effort/budget.
// `effort` / `budget` = the two dimensional knobs when supported.
export type ReasoningMode = 'default' | 'off' | 'enabled' | 'effort' | 'budget'

/** @deprecated Phase 11 replaces this with `ReasoningInclude`. Kept for one
 *  release so legacy chat rows can round-trip through import/export. Readers
 *  should prefer `include` and fall back to migrated values from here. */
export type ReasoningCarryForward = 'off' | 'plaintext' | 'encrypted' | 'auto'

export type ReasoningSummary = 'off' | 'auto' | 'concise' | 'detailed'

/** Three independent flags — maps 1:1 to the three Phase-11.1 UI checkboxes.
 *  - `encrypted`: round-trip the family-native opaque carrier
 *    (OpenAI `encrypted_content`, Anthropic `signature`, Gemini
 *    `thoughtSignature`, xAI Grok).
 *  - `summary`: round-trip visible summary parts (OpenAI reasoning summaries,
 *    Gemini `thought: true` parts).
 *  - `text`: round-trip visible plaintext reasoning (Claude / DeepSeek / Qwen
 *    / Gemma).
 *  Each flag is independently gated by what the current route can actually
 *  round-trip (see `plan/phase11-implementation.md §2`). */
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
  /** @deprecated Use `include`. Preserved for import/export backcompat only. */
  carryForward?: ReasoningCarryForward
}

export type ReasoningFormat =
  | 'unknown'
  | 'openai-responses-v1'
  | 'azure-openai-responses-v1'
  | 'xai-responses-v1'
  | 'anthropic-claude-v1'
  | 'google-gemini-v1'

export type ReasoningDetail =
  | {
      type: 'reasoning.text'
      id?: string
      index?: number
      format?: ReasoningFormat
      text?: string
      signature?: string
      hidden?: boolean
    }
  | {
      type: 'reasoning.summary'
      id?: string
      index?: number
      format?: ReasoningFormat
      summary: string
      hidden?: boolean
    }
  | {
      type: 'reasoning.encrypted'
      id?: string
      index?: number
      format?: ReasoningFormat
      data: string
      hidden?: boolean
    }

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } }

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

export type ServerToolId = 'web-search' | 'datetime' | 'web-fetch' | 'image-generation'

export type PluginId = 'context-compression'

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

export type SortPartition = 'model' | 'none'

export type ProviderSort = SortBy | { by: SortBy; partition: SortPartition }

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
  dataCollection?: 'allow' | 'deny'
  zdr?: boolean
  only?: string[]
  ignore?: string[]
  // True once the user clicks any provider checkbox. Signals that
  // `ignore` is the authoritative disallowed list — the wire builder
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
  usePreferredOrdering: boolean
  ignoreProviders: string[]
  onlyProviders: string[]
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

export type CacheControl = { type: 'ephemeral'; ttl?: '1h' }

// ---------------------------------------------------------------------------
// ChatSettings
// ---------------------------------------------------------------------------

export interface ContextStrategy {
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
  // remains after we trim locally.
  useOpenRouterMiddleOut?: boolean
}

export interface ChatSettings {
  profileId: ProfileId
  model: string
  fallbackModels?: string[]
  systemPrompt: string
  // Optional pin back to a PromptPreset (`kind: 'system'`). When set AND the
  // preset still exists, the preset is the canonical source — edits to the
  // preset propagate to `systemPrompt` via `prompt-presets.ts`. Editing the
  // text locally clears the pin; deleting the preset clears the pin but
  // preserves the last propagated text. See `plan/02-data-model.md §2.6b`.
  systemPromptPresetId?: PromptPresetId
  systemRole: 'system' | 'developer'
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
  // means "start empty". Prefill research §P.8: shown above the continue
  // prompts in the generation tab.
  defaultPrefill?: string
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
  // undefined, we use the model's advertised cap.
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
  enabledToolIds: ToolDefinitionId[]
  enabledServerToolIds: ServerToolId[]
  enabledPluginIds: PluginId[]
  trustedToolIds: ToolDefinitionId[]
  autoContinueToolLoop: boolean
  toolChoice?: ToolChoice
  parallelToolCalls?: boolean
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
  // template; 'custom' remains a per-chat legacy escape hatch via
  // `customTextTemplate`.
  textTemplate?: TextTemplateId
  // Only read when `textTemplate === 'custom'`. The shape matches the
  // bundled templates so the renderer can use one code path. Empty strings
  // are legitimate (any prefix/suffix may be omitted).
  customTextTemplate?: TextTemplateConfig
  // OpenAI Responses-API-specific knobs. Seeded from
  // `ConnectionProfile.responsesDefaults` at new-chat creation. Only read
  // on the `responses` route — chat-completions ignores the block entirely.
  responses?: ResponsesChatSettings
  // Gemini-specific knobs. Seeded from `ConnectionProfile.geminiDefaults`.
  gemini?: GeminiChatSettings
}

export interface ResponsesChatSettings {
  /** Emit `include: ['reasoning.encrypted_content']` on the request. Default
   *  `true` when `reasoning.include.encrypted` is also `true`. Independent
   *  escape hatch so the user can suppress the include without flipping the
   *  per-chat reasoning checkbox. */
  includeEncrypted: boolean
  /** Pass through to OpenAI. Our default is `false` (stateless, privacy). */
  store: boolean
}

export interface GeminiChatSettings {
  /** Imported chats without `thoughtSignature` values on prior turns bypass
   *  the 400-error validator when this is `true` (we pass
   *  `"skip_thought_signature_validator"` as the signature). Default `false`
   *  — surface a banner on first stale-reasoning rejection instead. */
  allowImportedWithoutSignature?: boolean
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
// schema we modeled this on (ours is trimmed to the essentials).
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

export interface ComposeOverrides {
  enabledToolIds?: ToolDefinitionId[]
  enabledServerToolIds?: ServerToolId[]
  enabledPluginIds?: PluginId[]
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface ChatDraft {
  text: string
  attachmentRefs: AttachmentRef[]
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
  settings: ChatSettings
  presetId?: PresetId
  lastUpdatedLeafId: MessageId | null
  lastBranchUpdatedAt: number
  archived: boolean
  pinned: boolean
  color?: string
  folderId: FolderId | null
  tags: TagId[]
  favoriteModels?: string[]
  recentModels?: string[]
  // Denormalized sidebar preview — plaintext of the earliest live user
  // message, trimmed to ~80 chars. Populated by `refreshChatPreview`
  // whenever a user message is created, edited, or deleted. The sidebar
  // reads this directly off the chat row so listing N chats never has to
  // touch the `messages` table (critical once a workspace holds
  // thousands of chats). Optional for backward-compat with pre-existing
  // chat rows; legacy rows are lazily backfilled on first open.
  previewText?: string
  // Running-sum calibration for chars-per-token. Keyed by the durable
  // calibration bucket: shared-tokenizer family key when known, otherwise the
  // canonicalized structural model key. Updated on every successful stream
  // completion in this chat. Optional for backcompat — absence falls through
  // to global + hardcoded tiers.
  tokenCalibration?: Record<string, TokenCalibrationSample>
}

// One per (chat, calibration-bucket) pair. Running sums — new samples add
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
// `tokenCalibrationGlobal`. Updated incrementally per send so the cost
// is O(1) per sample, not O(totalChats). See `plan/03-storage.md` for
// the settings-table contract.
export interface GlobalTokenCalibration {
  version: 1
  updatedAt: number
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

export interface ChatBranchCache {
  chatId: ChatId
  branchLeafId: MessageId | null
  generatedAt: number
  textContent: string
  previewText: string
  messageCount: number
  wordCount: number
  messageTimestamps: Array<{
    id: MessageId
    createdAt: number
    editedAt: number
  }>
}

export interface ChildListState {
  id: string
  chatId: ChatId
  parentId: MessageId | null
  version: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

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
  | {
      type: 'file'
      attachmentId?: AttachmentId
      filename: string
      mime: string
      url?: string
    }
  | { type: 'video_url'; attachmentId?: AttachmentId; url?: string }
  | { type: 'output_text'; text: string; annotations?: Annotation[] }
  | {
      type: 'output_image'
      attachmentId?: AttachmentId
      url?: string
      prompt?: string
    }
  | {
      type: 'audio_output'
      attachmentId?: AttachmentId
      url?: string
      transcript?: string
      durationMs?: number
      format?: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'pcm16'
    }
  | {
      type: 'output_video'
      attachmentId?: AttachmentId
      url?: string
      prompt?: string
    }

export interface Annotation {
  type: 'url_citation' | 'file_citation'
  [key: string]: unknown
}

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

export interface ApiError {
  code: string
  message: string
  statusCode?: number
  provider?: string
  raw?: unknown
}

export interface GenerationServerToolCall {
  type: string
  source: 'responses-output' | 'stream-status' | 'usage'
  id?: string
  status?: string
  outputIndex?: number
  requestCount?: number
  output?: unknown
}

export interface GenerationMeta {
  id: string
  model: string
  requestedModel: string
  requestedModels?: string[]
  provider?: string
  apiUsed:
    | 'chat'
    | 'responses'
    | 'gemini-native'
    | 'anthropic-messages'
    | 'completion'
    | 'video-generation'
  delivery: DeliveryMethod
  usage?: ChatUsage
  cost?: number
  costSource: 'stream' | 'generation-endpoint' | 'estimated'
  startedAt: number
  firstTextAt?: number
  reasoningStartedAt?: number
  reasoningFinishedAt?: number
  finishedAt?: number
  finishReason?: FinishReason
  nativeFinishReason?: string
  error?: ApiError
  abortReason?: AbortReason
  serverTools?: GenerationServerToolCall[]
}

// Minimal echo envelope for a Responses API output item. The full variant list
// lives in transforms; here we keep it open so callers can round-trip unknown
// item types without losing data. See `plan/15-non-text-in-context.md` and
// `plan/02-data-model.md §2.9` for the canonical set.
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
  reasoningDetails?: ReasoningDetail[]
  toolCalls?: ToolCall[]
  refusal?: string
  phase?: MessagePhase
  responsesEchoItem?: ResponsesOutputItem
  attachmentRefs?: AttachmentRef[]
  approval?: MessageApproval
  nodeVersion: number
  pinCache?: boolean
  hiddenFromContext?: boolean
  deleted: boolean

  // ---- Token-calibration fields (Phase B) ----
  // All optional for backcompat; rehydrated old rows fall through to the
  // fresh/cross-model path. See `plan/token-counting-audit.md` Phase B.

  // Character count at message creation (text content only, no media). For
  // assistant messages in the inline-`<think>` family, also includes the
  // lifted reasoning-text chars — those were billed as completion tokens on
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

export type AttachmentProcessingStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

export interface AttachmentProcessingState {
  processorId: string
  inputHash: string
  status: AttachmentProcessingStatus
  startedAt?: number
  finishedAt?: number
  error?: { code: string; message: string }
  outputArtifactIds: string[]
}

export interface AttachmentJob extends AttachmentProcessingState {
  id: string
  attachmentId: AttachmentId
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

export type AttachmentRef = AttachmentId | MessageAttachmentRef

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
}

export type CapabilityOverride = Partial<CapabilityDescriptor>

export interface ConnectionProfile {
  id: ProfileId
  name: string
  kind: ConnectionKind
  baseUrl: string
  apiKeyRef: KeyId
  apiKeyFallbackRefs?: KeyId[]
  managementApiKeyRef?: KeyId
  defaultHeaders: Record<string, string>
  appTitle: string
  appUrl: string
  appCategories?: string[]
  usesResponsesApiByDefault: boolean
  supportsEndpointsApi: boolean
  supportsGenerationApi: boolean
  supportsPrivacyScrape: boolean
  capabilityOverrides?: Record<string, CapabilityOverride>
  debugRequests?: boolean
  privacyScrapeProxy?: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  archived?: boolean
  /** Google Gemini transport selector. Only meaningful when `kind === 'google'`.
   *  `native` (default) dispatches to `:generateContent` /
   *  `:streamGenerateContent?alt=sse` with `x-goog-api-key`. `openai-compat`
   *  falls back to Gemini's OpenAI-compatible shim at `/v1beta/openai/…`,
   *  which strips `thoughtSignature` outside tool flows. See
   *  `plan/phase11-implementation.md §1`. */
  geminiMode?: 'native' | 'openai-compat'
  /** Per-profile defaults copied into `chat.settings.responses` at new-chat
   *  creation. Users edit these from the Connection editor; per-chat overrides
   *  in `chat.settings.responses` win at send time. */
  responsesDefaults?: {
    store: boolean
    includeEncrypted: boolean
  }
  /** Per-profile Gemini defaults copied into `chat.settings.gemini`. */
  geminiDefaults?: {
    allowImportedWithoutSignature: boolean
  }
}

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
export type PromptPresetKind = 'system' | 'continue-system' | 'continue-user'

// A named, workspace-global prompt snapshot. Unlike ChatPreset (per-profile
// bundle of the full ChatSettings), PromptPresets are kind-scoped and hold
// just a label + text. See `plan/02-data-model.md §2.6b`.
export interface PromptPreset {
  id: PromptPresetId
  kind: PromptPresetKind
  name: string
  text: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
}

export interface PresetResolution {
  profileId: ProfileId
  presetSlug: string
  resolvedModel: string
  fetchedAt: number
  sourceGenerationId?: string
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
  createdAt: number
  lastUsedAt?: number
}

// ---------------------------------------------------------------------------
// Branching / cursor
// ---------------------------------------------------------------------------

// Root key is `'__root__'` so `Record` lookup can represent "which child of the
// virtual root is the active top-level message."
export type CursorMap = Record<string, MessageId>

export type MutationScope =
  | { kind: 'chat-meta'; chatId: ChatId }
  | { kind: 'message'; messageId: MessageId }
  | { kind: 'children'; chatId: ChatId; parentId: MessageId | null }
  | { kind: 'draft'; chatId: ChatId }
  | { kind: 'attachment'; attachmentId: AttachmentId }

export interface ChatVersions {
  metaVersion: number
  summaryVersion: number
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

export interface ModelsQuery {
  outputModalities?: readonly string[]
  supportedParameters?: readonly string[]
}

// ---------------------------------------------------------------------------
// Envelope for send pipeline
// ---------------------------------------------------------------------------

export interface SendPayload {
  chatId: ChatId
  content: ContentItem[]
  attachmentRefs?: AttachmentRef[]
  overrides?: Partial<ChatSettings>
  composeOverrides?: ComposeOverrides
  prefillContent?: ContentItem[]
}
