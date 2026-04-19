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
export type FolderId = string
export type TagId = string

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'developer'

export type MessageOrigin = 'user' | 'generated' | 'imported' | 'continued' | 'prefill'

export type ApiVariant = 'auto' | 'chat' | 'responses'

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

export type ConnectionKind = 'openrouter' | 'openai-compatible' | 'anthropic' | 'google' | 'custom'

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

export type EffortLevel = 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none'

export type VerbosityLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// `default` = don't emit the `reasoning` field, let the provider decide.
// `off` = explicit `reasoning.enabled: false`.
// `enabled` = explicit `reasoning.enabled: true` with no effort/budget.
// `effort` / `budget` = the two dimensional knobs when supported.
export type ReasoningMode = 'default' | 'off' | 'enabled' | 'effort' | 'budget'

export type ReasoningCarryForward = 'off' | 'plaintext' | 'encrypted' | 'auto'

export type ReasoningSummary = 'off' | 'auto' | 'concise' | 'detailed'

export interface ReasoningSettings {
  mode: ReasoningMode
  effort?: EffortLevel
  maxTokens?: number
  exclude: boolean
  summary?: ReasoningSummary
  carryForward: ReasoningCarryForward
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
    }
  | {
      type: 'reasoning.summary'
      id?: string
      index?: number
      format?: ReasoningFormat
      summary: string
    }
  | {
      type: 'reasoning.encrypted'
      id?: string
      index?: number
      format?: ReasoningFormat
      data: string
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

export type ServerToolId = 'web-search' | 'datetime' | 'image-generation'

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
  allowFallbacks?: boolean
  requireParameters?: boolean
  dataCollection?: 'allow' | 'deny'
  zdr?: boolean
  only?: string[]
  ignore?: string[]
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
  systemRole: 'system' | 'developer'
  sampling: Partial<Record<SamplingKey, number>>
  stop?: string[]
  modalities?: Array<'text' | 'image' | 'audio'>
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
  attachmentRefs: AttachmentId[]
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
      attachmentId: AttachmentId
      transcript?: string
      durationMs?: number
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

export interface GenerationMeta {
  id: string
  model: string
  requestedModel: string
  requestedModels?: string[]
  provider?: string
  apiUsed: 'chat' | 'responses'
  delivery: DeliveryMethod
  usage?: ChatUsage
  cost?: number
  costSource: 'stream' | 'generation-endpoint' | 'estimated'
  startedAt: number
  finishedAt?: number
  finishReason?: FinishReason
  nativeFinishReason?: string
  error?: ApiError
  abortReason?: AbortReason
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
  attachmentRefs?: AttachmentId[]
  approval?: MessageApproval
  nodeVersion: number
  pinCache?: boolean
  hiddenFromContext?: boolean
  deleted: boolean
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export type AttachmentKind = 'image' | 'pdf' | 'audio' | 'video' | 'file'

export interface Attachment {
  id: AttachmentId
  contentHash: string
  kind: AttachmentKind
  mime: string
  filename: string
  sizeBytes: number
  createdAt: number
  blob: Blob
  dimensions?: { width: number; height: number }
  durationMs?: number
  pageCount?: number
  thumbnailB64?: string
  refCount: number
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
    outputModalities?: Array<'text' | 'image' | 'audio'>
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
  provider_name: string
  supported_parameters: string[]
  context_length: number
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
  attachmentRefs?: AttachmentId[]
  overrides?: Partial<ChatSettings>
  composeOverrides?: ComposeOverrides
  prefillContent?: ContentItem[]
}
