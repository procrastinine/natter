export type ReasoningFormatV2 =
  | 'unknown'
  | 'openai-responses-v1'
  | 'azure-openai-responses-v1'
  | 'xai-responses-v1'
  | 'anthropic-claude-v1'
  | 'google-gemini-v1'

export type ReasoningOriginDialectV2 =
  | 'inline'
  | 'openai-chat'
  | 'openrouter-chat'
  | 'openai-responses'
  | 'openrouter-responses'
  | 'anthropic-messages'
  | 'gemini-native'
  | 'unknown'

export type ReasoningProducerBridgeV2 =
  | 'inline'
  | 'openrouter'
  | 'openai-direct'
  | 'azure-openai'
  | 'anthropic-direct'
  | 'google-direct'
  | 'custom'
  | 'unknown'

export interface ReasoningSourceRefV2 {
  readonly dialect: ReasoningOriginDialectV2
  readonly bridge: ReasoningProducerBridgeV2
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

export interface ReasoningVisiblePartV2 {
  readonly id: string
  readonly groupId: string
  readonly kind: 'text' | 'summary'
  readonly text: string
  readonly format: ReasoningFormatV2
  readonly source: ReasoningSourceRefV2
  readonly hidden?: boolean
}

interface OpaqueReasoningCarrierBaseV2 {
  readonly id: string
  readonly groupId: string
  readonly format: ReasoningFormatV2
  readonly source: ReasoningSourceRefV2
  readonly hidden?: boolean
}

export type OpaqueReasoningCarrierV2 =
  | (OpaqueReasoningCarrierBaseV2 & {
      readonly kind: 'responses-encrypted'
      readonly data: string
    })
  | (OpaqueReasoningCarrierBaseV2 & {
      readonly kind: 'anthropic-signature'
      readonly signature: string
      readonly bindsVisiblePartId: string
    })
  | (OpaqueReasoningCarrierBaseV2 & {
      readonly kind: 'anthropic-redacted'
      readonly data: string
    })
  | (OpaqueReasoningCarrierBaseV2 & {
      readonly kind: 'gemini-thought-signature'
      readonly data: string
      readonly bindsVisiblePartId?: string
    })
  | (OpaqueReasoningCarrierBaseV2 & {
      readonly kind: 'unknown'
      readonly data: string
    })

export type OpaqueReasoningCarrierDescriptorV2 = OpaqueReasoningCarrierV2 extends infer Carrier
  ? Carrier extends OpaqueReasoningCarrierV2
    ? Omit<Carrier, 'data' | 'signature'>
    : never
  : never

export interface ReasoningEnvelopeV2Schema {
  readonly schemaVersion: 2
  readonly visible: ReasoningVisiblePartV2[]
  readonly carriers: OpaqueReasoningCarrierV2[]
}

export type ReasoningEnvelopeMutationV2 =
  | Readonly<{
      kind: 'visible-append'
      part: Omit<ReasoningVisiblePartV2, 'text'>
      delta: string
    }>
  | Readonly<{ kind: 'visible-set'; part: ReasoningVisiblePartV2 }>
  | Readonly<{ kind: 'carrier-set'; carrier: OpaqueReasoningCarrierV2 }>
  | Readonly<{
      kind: 'carrier-append'
      carrier: OpaqueReasoningCarrierDescriptorV2
      delta: string
    }>
  | Readonly<{ kind: 'replace'; envelope: ReasoningEnvelopeV2Schema }>

export type ContentAnnotationSourceV2 =
  | 'openai-responses'
  | 'openai-chat'
  | 'anthropic-messages'
  | 'gemini-native'
  | 'imported'
  | 'unknown'

export type CitationFileIdentityV2 =
  | Readonly<{ kind: 'attachment'; attachmentId: string }>
  | Readonly<{
      kind: 'provider-file'
      provider: ContentAnnotationSourceV2
      fileId: string
      containerId?: string
    }>
  | Readonly<{
      kind: 'document'
      provider: ContentAnnotationSourceV2
      documentIndex: number
    }>
  | Readonly<{ kind: 'unresolved'; provider: ContentAnnotationSourceV2 }>

interface ContentAnnotationBaseV2 {
  startIndex: number
  endIndex: number
  readonly source: ContentAnnotationSourceV2
  readonly providerPayload: Record<string, unknown>
}

export type ContentAnnotationV2 =
  | (ContentAnnotationBaseV2 & {
      readonly type: 'url_citation'
      readonly url: string
      readonly title?: string
    })
  | (ContentAnnotationBaseV2 & {
      readonly type: 'file_citation'
      readonly file: CitationFileIdentityV2
      readonly filename?: string
      readonly title?: string
      readonly citedText?: string
    })
  | (ContentAnnotationBaseV2 & {
      readonly type: 'unknown'
      readonly annotationType: string
    })

type CacheControlV2 = Readonly<{ type: 'ephemeral'; ttl?: '1h' }>
type GeneratedOutputLocatorV2 =
  | Readonly<{ attachmentId: string; url?: never }>
  | Readonly<{ attachmentId?: never; url: string }>
type OptionalContentLocatorV2 =
  | GeneratedOutputLocatorV2
  | Readonly<{ attachmentId?: never; url?: never }>

export type ContentItemV2 =
  | Readonly<{ type: 'text'; text: string; cacheControl?: CacheControlV2 }>
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
  | (Readonly<{ type: 'file'; filename: string; mime: string }> & OptionalContentLocatorV2)
  | Readonly<{ type: 'video_url'; attachmentId?: string; url?: string }>
  | Readonly<{ type: 'output_text'; text: string; annotations?: ContentAnnotationV2[] }>
  | (Readonly<{ type: 'output_image'; prompt?: string }> & GeneratedOutputLocatorV2)
  | (Readonly<{
      type: 'audio_output'
      transcript?: string
      durationMs?: number
      format?: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'pcm16'
    }> &
      OptionalContentLocatorV2)
  | (Readonly<{ type: 'output_video'; prompt?: string }> & GeneratedOutputLocatorV2)

export interface ChatUsageV2 {
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

export interface AttemptIntegrityEntryV2 {
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

export interface GenerationServerToolCallV2 {
  readonly type: string
  readonly source: 'responses-output' | 'stream-status' | 'usage' | 'provider-output'
  readonly id?: string
  readonly status?: string
  readonly outputIndex?: number
  readonly requestCount?: number
}

export type ProviderOutputDialectV2 =
  | 'openai-responses'
  | 'openrouter-responses'
  | 'google-gemini'
  | 'anthropic-claude'
  | 'unknown'

export interface ProviderOutputItemV2 {
  readonly dialect: ProviderOutputDialectV2
  readonly type: string
  readonly captureId?: string
  readonly outputIndex?: number
  readonly hidden?: boolean
  readonly edited?: boolean
  readonly item: unknown
}

export interface ResponsesOutputItemV2 {
  readonly type: string
  readonly id?: string
  readonly [key: string]: unknown
}

export type MessagePhaseV2 = 'commentary' | 'final_answer'

export interface ReasoningMutationStreamEventV2 {
  lane: 'reasoning'
  mutations: readonly ReasoningEnvelopeMutationV2[]
  observed?: Readonly<{ firstAt: number; lastAt: number }>
}

export type GenerationFailureKindV2 =
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

export interface GenerationStreamFailureV2 {
  readonly name?: string
  readonly message: string
  readonly kind: GenerationFailureKindV2
  readonly httpStatus?: number
  readonly code: number | string
  readonly metadata?: Record<string, unknown>
  readonly midStream: boolean
  readonly retryable: boolean
}

export type GenerationStreamIntegrityV2 = AttemptIntegrityEntryV2

export interface ResultSnapshotTextPartV2 {
  readonly text: string
  readonly outputIndex: number
  readonly contentIndex: number
  readonly annotations: readonly ContentAnnotationV2[]
}

export interface ResultSnapshotToolCallV2 {
  readonly index: number
  readonly id?: string
  readonly type?: 'function'
  readonly name?: string
  readonly arguments: string
}

export interface ResultSnapshotReplacementV2 {
  readonly kind: 'replace'
  readonly textParts: readonly ResultSnapshotTextPartV2[]
  readonly reasoningEnvelope: ReasoningEnvelopeV2Schema
  readonly toolCalls: readonly ResultSnapshotToolCallV2[]
  readonly generatedContent: readonly ContentItemV2[]
  readonly serverTools: readonly GenerationServerToolCallV2[]
  readonly providerOutputItems: readonly ProviderOutputItemV2[]
  readonly phase: MessagePhaseV2 | null
}

export type ResultSnapshotPayloadV2 = ResultSnapshotReplacementV2 | Readonly<{ kind: 'retain' }>

export type ResultSnapshotOutcomeV2 =
  | Readonly<{ kind: 'finish'; finishReason: string }>
  | Readonly<{ kind: 'error'; error: GenerationStreamFailureV2 }>

export interface ResultSnapshotStreamEventV2 {
  readonly lane: 'result-snapshot'
  readonly payload: ResultSnapshotPayloadV2
  readonly outcome: ResultSnapshotOutcomeV2
  readonly model?: string
  readonly generationId?: string
  readonly usage?: Partial<ChatUsageV2> & Record<string, unknown>
  readonly integrity?: readonly GenerationStreamIntegrityV2[]
}

export type NonReasoningStreamEventV2 =
  | { lane: 'text'; text: string; chunkId?: string; outputIndex?: number; contentIndex?: number }
  | {
      lane: 'text-annotations'
      annotations: readonly ContentAnnotationV2[]
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
      dialect: Extract<ProviderOutputDialectV2, 'google-gemini' | 'anthropic-claude'>
      itemType: string
      itemId: string
      outputIndex: number
      output: unknown
      status?: string
    }
  | {
      lane: 'content-item'
      item: ContentItemV2
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
      dialect: Extract<ProviderOutputDialectV2, 'openai-responses' | 'openrouter-responses'>
      outputIndex: number
      item: ResponsesOutputItemV2
    }
  | {
      lane: 'output-item-done'
      dialect: Extract<ProviderOutputDialectV2, 'openai-responses' | 'openrouter-responses'>
      outputIndex: number
      item: ResponsesOutputItemV2
    }
  | { lane: 'phase'; phase: MessagePhaseV2 | null; outputIndex: number }
  | ResultSnapshotStreamEventV2
  | { lane: 'usage'; usage: Partial<ChatUsageV2> & Record<string, unknown>; chunkId?: string }
  | { lane: 'finish'; finishReason: string; chunkId?: string }
  | { lane: 'terminal'; evidence: 'done-sentinel' }
  | { lane: 'meta'; model?: string; provider?: string; generationId?: string }
  | { lane: 'keepalive'; comment: string }
  | { lane: 'integrity'; integrity: GenerationStreamIntegrityV2 }
  | { lane: 'error'; error: GenerationStreamFailureV2 }

export type CanonicalStreamEventV2 = NonReasoningStreamEventV2 | ReasoningMutationStreamEventV2
