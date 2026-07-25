export type ReasoningFormatV1 =
  | 'openai-responses-v1'
  | 'azure-openai-responses-v1'
  | 'xai-responses-v1'
  | 'anthropic-claude-v1'
  | 'google-gemini-v1'
  | 'unknown'

export type ReasoningOriginDialectV1 =
  | 'inline'
  | 'openai-chat'
  | 'openrouter-chat'
  | 'openai-responses'
  | 'openrouter-responses'
  | 'anthropic-messages'
  | 'gemini-native'
  | 'unknown'

export interface ReasoningSourceRefV1 {
  readonly dialect: ReasoningOriginDialectV1
  readonly itemId?: string
  readonly detailId?: string
  readonly choiceIndex?: number
  readonly outputIndex?: number
  readonly contentIndex?: number
  readonly summaryIndex?: number
  readonly detailIndex?: number
  readonly detailOrdinal?: number
  readonly candidateIndex?: number
  readonly frameIndex?: number
  readonly partIndex?: number
  readonly blockIndex?: number
}

export interface ReasoningVisiblePartV1 {
  readonly id: string
  readonly groupId: string
  readonly kind: 'text' | 'summary'
  readonly text: string
  readonly format: ReasoningFormatV1
  readonly source: ReasoningSourceRefV1
  readonly hidden?: boolean
}

interface OpaqueReasoningCarrierBaseV1 {
  readonly id: string
  readonly groupId: string
  readonly format: ReasoningFormatV1
  readonly source: ReasoningSourceRefV1
  readonly hidden?: boolean
}

export type OpaqueReasoningCarrierV1 =
  | (OpaqueReasoningCarrierBaseV1 & {
      readonly kind: 'responses-encrypted'
      readonly data: string
    })
  | (OpaqueReasoningCarrierBaseV1 & {
      readonly kind: 'anthropic-signature'
      readonly signature: string
      readonly bindsVisiblePartId: string
    })
  | (OpaqueReasoningCarrierBaseV1 & {
      readonly kind: 'anthropic-redacted'
      readonly data: string
    })
  | (OpaqueReasoningCarrierBaseV1 & {
      readonly kind: 'gemini-thought-signature'
      readonly data: string
      readonly bindsVisiblePartId?: string
    })
  | (OpaqueReasoningCarrierBaseV1 & {
      readonly kind: 'unknown'
      readonly data: string
    })

export type OpaqueReasoningCarrierDescriptorV1 = OpaqueReasoningCarrierV1 extends infer Carrier
  ? Carrier extends OpaqueReasoningCarrierV1
    ? Omit<Carrier, 'data' | 'signature'>
    : never
  : never

export interface ReasoningEnvelopeV1Schema {
  readonly schemaVersion: 1
  readonly visible: ReasoningVisiblePartV1[]
  readonly carriers: OpaqueReasoningCarrierV1[]
}

export type ReasoningEnvelopeMutationV1 =
  | Readonly<{
      kind: 'visible-append'
      part: Omit<ReasoningVisiblePartV1, 'text'>
      delta: string
    }>
  | Readonly<{ kind: 'visible-set'; part: ReasoningVisiblePartV1 }>
  | Readonly<{ kind: 'carrier-set'; carrier: OpaqueReasoningCarrierV1 }>
  | Readonly<{
      kind: 'carrier-append'
      carrier: OpaqueReasoningCarrierDescriptorV1
      delta: string
    }>
  | Readonly<{ kind: 'replace'; envelope: ReasoningEnvelopeV1Schema }>

export type ReasoningEnvelopeIngressV1 =
  | Readonly<{
      kind: 'visible-ensure'
      part: Omit<ReasoningVisiblePartV1, 'text'>
    }>
  | Readonly<{
      kind: 'visible-update'
      mode: 'append' | 'append-section' | 'set' | 'cumulative'
      part: Omit<ReasoningVisiblePartV1, 'text'>
      value: string
    }>
  | Readonly<{
      kind: 'visible-observation'
      relationship: 'exact-frame-mirror' | 'anthropic-suffix-mirror'
      part: Omit<ReasoningVisiblePartV1, 'text'>
      value: string
    }>
  | Readonly<{
      kind: 'carrier-update'
      mode: 'append' | 'set' | 'cumulative'
      carrier: OpaqueReasoningCarrierDescriptorV1
      value: string
    }>
  | Readonly<{ kind: 'carrier-set'; carrier: OpaqueReasoningCarrierV1 }>
  | Readonly<{ kind: 'replace'; envelope: ReasoningEnvelopeV1Schema }>

export type ContentAnnotationSourceV1 =
  | 'openai-responses'
  | 'openai-chat'
  | 'anthropic-messages'
  | 'gemini-native'
  | 'imported'
  | 'unknown'

export type CitationFileIdentityV1 =
  | Readonly<{ kind: 'attachment'; attachmentId: string }>
  | Readonly<{
      kind: 'provider-file'
      provider: ContentAnnotationSourceV1
      fileId: string
      containerId?: string
    }>
  | Readonly<{
      kind: 'document'
      provider: ContentAnnotationSourceV1
      documentIndex: number
    }>
  | Readonly<{ kind: 'unresolved'; provider: ContentAnnotationSourceV1 }>

interface ContentAnnotationBaseV1 {
  startIndex: number
  endIndex: number
  readonly source: ContentAnnotationSourceV1
  readonly providerPayload: Record<string, unknown>
}

export type ContentAnnotationV1 =
  | (ContentAnnotationBaseV1 & {
      readonly type: 'url_citation'
      readonly url: string
      readonly title?: string
    })
  | (ContentAnnotationBaseV1 & {
      readonly type: 'file_citation'
      readonly file: CitationFileIdentityV1
      readonly filename?: string
      readonly title?: string
      readonly citedText?: string
    })
  | (ContentAnnotationBaseV1 & {
      readonly type: 'unknown'
      readonly annotationType: string
    })

type CacheControlV1 = Readonly<{ type: 'ephemeral'; ttl?: '1h' }>
type GeneratedOutputLocatorV1 =
  | Readonly<{ attachmentId: string; url?: never }>
  | Readonly<{ attachmentId?: never; url: string }>
type OptionalContentLocatorV1 =
  | GeneratedOutputLocatorV1
  | Readonly<{ attachmentId?: never; url?: never }>

export type ContentItemV1 =
  | Readonly<{ type: 'text'; text: string; cacheControl?: CacheControlV1 }>
  | Readonly<{
      type: 'image_url'
      attachmentId?: string
      url?: string
      detail?: 'low' | 'high' | 'auto'
    }>
  | Readonly<{
      type: 'input_audio'
      attachmentId?: string
      format: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a'
    }>
  | (Readonly<{ type: 'file'; filename: string; mime: string }> & OptionalContentLocatorV1)
  | Readonly<{ type: 'video_url'; attachmentId?: string; url?: string }>
  | Readonly<{ type: 'output_text'; text: string; annotations?: ContentAnnotationV1[] }>
  | (Readonly<{ type: 'output_image'; prompt?: string }> & GeneratedOutputLocatorV1)
  | (Readonly<{
      type: 'audio_output'
      transcript?: string
      durationMs?: number
      format?: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'pcm16'
    }> &
      OptionalContentLocatorV1)
  | (Readonly<{ type: 'output_video'; prompt?: string }> & GeneratedOutputLocatorV1)

export interface ChatUsageV1 {
  readonly prompt_tokens: number
  readonly completion_tokens: number
  readonly total_tokens: number
  readonly server_tool_use?: Record<string, number>
  readonly prompt_tokens_details?: Readonly<{
    cached_tokens?: number
    audio_tokens?: number
    image_tokens?: number
  }>
  readonly completion_tokens_details?: Readonly<{
    reasoning_tokens?: number
    audio_tokens?: number
    accepted_prediction_tokens?: number
    rejected_prediction_tokens?: number
  }>
  readonly cost?: number
  readonly cost_details?: Readonly<{
    upstream_inference_cost?: number
    upstream_inference_prompt_cost?: number
    upstream_inference_completions_cost?: number
  }>
  readonly cache_creation_input_tokens?: number
}

export interface AttemptIntegrityEntryV1 {
  readonly category: 'malformed-json-frame' | 'malformed-event-shape'
  readonly adapter:
    | 'chat-completions'
    | 'responses'
    | 'gemini-native'
    | 'anthropic-messages'
    | 'text-completions'
  readonly eventType: string
  readonly count: number
  readonly fingerprint: string
  readonly characterCount: number
}

export interface GenerationServerToolCallV1 {
  readonly type: string
  readonly source: 'responses-output' | 'stream-status' | 'usage' | 'provider-output'
  readonly id?: string
  readonly status?: string
  readonly outputIndex?: number
  readonly requestCount?: number
}

export type ProviderOutputDialectV1 =
  | 'openai-responses'
  | 'openrouter-responses'
  | 'google-gemini'
  | 'anthropic-claude'
  | 'unknown'

export interface ProviderOutputItemV1 {
  readonly dialect: ProviderOutputDialectV1
  readonly type: string
  readonly captureId?: string
  readonly outputIndex?: number
  readonly hidden?: boolean
  readonly edited?: boolean
  readonly item: unknown
}

export interface ResponsesOutputItemV1 {
  readonly type: string
  readonly id?: string
  readonly [key: string]: unknown
}

export type MessagePhaseV1 = 'commentary' | 'final_answer'

export interface ReasoningMutationStreamEventV1 {
  lane: 'reasoning'
  mutations: readonly ReasoningEnvelopeMutationV1[]
  observed?: Readonly<{ firstAt: number; lastAt: number }>
}

export type GenerationFailureKindV1 =
  | 'network'
  | 'timeout'
  | 'abort'
  | 'bad_request'
  | 'unauthorized'
  | 'payment_required'
  | 'moderation'
  | 'rate_limited'
  | 'provider_error'
  | 'no_provider_available'
  | 'validation'
  | 'protocol'
  | 'storage'
  | 'integrity'
  | 'internal'

export interface GenerationStreamFailureV1 {
  readonly name?: string
  readonly message: string
  readonly kind: GenerationFailureKindV1
  readonly httpStatus?: number
  readonly code: number | string
  readonly metadata?: Record<string, unknown>
  readonly midStream: boolean
  readonly retryable: boolean
}

export type GenerationStreamIntegrityV1 = AttemptIntegrityEntryV1

export interface ResultSnapshotTextPartV1 {
  readonly text: string
  readonly outputIndex: number
  readonly contentIndex: number
  readonly annotations: readonly ContentAnnotationV1[]
}

export interface ResultSnapshotToolCallV1 {
  readonly index: number
  readonly id?: string
  readonly type?: 'function'
  readonly name?: string
  readonly arguments: string
}

export interface ResultSnapshotReplacementV1 {
  readonly kind: 'replace'
  readonly textParts: readonly ResultSnapshotTextPartV1[]
  readonly reasoningEnvelope: ReasoningEnvelopeV1Schema
  readonly toolCalls: readonly ResultSnapshotToolCallV1[]
  readonly generatedContent: readonly ContentItemV1[]
  readonly serverTools: readonly GenerationServerToolCallV1[]
  readonly providerOutputItems: readonly ProviderOutputItemV1[]
  readonly phase: MessagePhaseV1 | null
}

export type ResultSnapshotPayloadV1 = ResultSnapshotReplacementV1 | Readonly<{ kind: 'retain' }>

export type ResultSnapshotOutcomeV1 =
  | Readonly<{ kind: 'finish'; finishReason: string }>
  | Readonly<{ kind: 'error'; error: GenerationStreamFailureV1 }>

export type NonReasoningStreamEventV1 =
  | { lane: 'text'; text: string; chunkId?: string; outputIndex?: number; contentIndex?: number }
  | {
      lane: 'text-annotations'
      annotations: readonly ContentAnnotationV1[]
      ownerTextLength: number
      outputIndex?: number
      contentIndex?: number
    }
  | {
      lane: 'tool-call'
      index: number
      id?: string
      type?: 'function'
      name?: string
      argumentsDelta?: string
      argumentsSnapshot?: string
      chunkId?: string
      outputIndex?: number
    }
  | {
      lane: 'server-tool'
      itemType: string
      status: 'in_progress' | 'searching' | 'completed'
      itemId: string
      outputIndex: number
      partialImageB64?: string
    }
  | {
      lane: 'server-tool-output'
      dialect: Extract<ProviderOutputDialectV1, 'google-gemini' | 'anthropic-claude'>
      itemType: string
      itemId: string
      outputIndex: number
      output: unknown
      status?: string
    }
  | {
      lane: 'content-item'
      item: ContentItemV1
      chunkId?: string
      outputIndex?: number
      itemId?: string
    }
  | {
      lane: 'audio-output'
      dataDelta?: string
      transcriptDelta?: string
      format?: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'pcm16'
      chunkId?: string
    }
  | {
      lane: 'output-item-added'
      dialect: Extract<ProviderOutputDialectV1, 'openai-responses' | 'openrouter-responses'>
      outputIndex: number
      item: ResponsesOutputItemV1
    }
  | {
      lane: 'output-item-done'
      dialect: Extract<ProviderOutputDialectV1, 'openai-responses' | 'openrouter-responses'>
      outputIndex: number
      item: ResponsesOutputItemV1
    }
  | { lane: 'phase'; phase: MessagePhaseV1 | null; outputIndex: number }
  | {
      lane: 'result-snapshot'
      payload: ResultSnapshotPayloadV1
      outcome: ResultSnapshotOutcomeV1
      model?: string
      generationId?: string
      usage?: Partial<ChatUsageV1> & Record<string, unknown>
      integrity?: readonly GenerationStreamIntegrityV1[]
    }
  | { lane: 'usage'; usage: Partial<ChatUsageV1> & Record<string, unknown>; chunkId?: string }
  | { lane: 'finish'; finishReason: string; chunkId?: string }
  | { lane: 'terminal'; evidence: 'done-sentinel' }
  | { lane: 'meta'; model?: string; provider?: string; generationId?: string }
  | { lane: 'keepalive'; comment: string }
  | { lane: 'integrity'; integrity: GenerationStreamIntegrityV1 }
  | { lane: 'error'; error: GenerationStreamFailureV1 }

export type CanonicalStreamEventV1 = NonReasoningStreamEventV1 | ReasoningMutationStreamEventV1
