// Google Gemini native API — wire shapes. See `plan/phase11-implementation.md §4.1`
// and `gemini_docs/`.
//
// Unlike the OpenAI family, the wire shape is camelCase end-to-end. Our
// internal types stay camelCase, so the transform is nearly identity on
// property names. Auth uses `x-goog-api-key`, NOT `Authorization: Bearer`.

export interface GenerateContentRequestWire {
  contents: GeminiContent[]
  systemInstruction?: GeminiContent
  tools?: unknown[]
  toolConfig?: unknown
  safetySettings?: unknown[]
  generationConfig?: GenerationConfig
  // Reference to a cachedContents/<name> entity (Gemini context caching).
  cachedContent?: string
  [extra: string]: unknown
}

export interface GeminiContent {
  role?: 'user' | 'model' | 'system'
  parts: GeminiPart[]
}

// One part per content chunk. Multiple part variants exist; the shape stays
// open so adapters can round-trip unknown parts (new modalities etc.).
export type GeminiPart =
  | {
      text: string
      thought?: boolean
      thoughtSignature?: string
      [extra: string]: unknown
    }
  | {
      inlineData: { mimeType: string; data: string }
      thought?: boolean
      thoughtSignature?: string
      [extra: string]: unknown
    }
  | {
      fileData: { mimeType: string; fileUri: string }
      thought?: boolean
      thoughtSignature?: string
      [extra: string]: unknown
    }
  | {
      functionCall: { name: string; args?: Record<string, unknown>; id?: string }
      thoughtSignature?: string
      [extra: string]: unknown
    }
  | {
      functionResponse: {
        name: string
        response: Record<string, unknown>
        id?: string
      }
      [extra: string]: unknown
    }

export interface ThinkingConfig {
  // Gemini 3+: 'minimal' | 'low' | 'medium' | 'high' (default 'high').
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
  // Gemini 2.5: integer budget; 0 disables on Flash only; -1 = dynamic.
  thinkingBudget?: number
  // Ask the model to emit a human-visible summary. `thought: true` parts arrive
  // inline with content parts when enabled.
  includeThoughts?: boolean
  [extra: string]: unknown
}

export interface GenerationConfig {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  responseMimeType?: string
  // Legacy. Prefer `responseJsonSchema` when both are supported.
  responseSchema?: unknown
  responseJsonSchema?: unknown
  thinkingConfig?: ThinkingConfig
  [extra: string]: unknown
}

export interface GenerateContentResponseWire {
  candidates?: Array<{
    content: GeminiContent
    finishReason?: string
    index?: number
    safetyRatings?: unknown[]
    [extra: string]: unknown
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    thoughtsTokenCount?: number
    cachedContentTokenCount?: number
    promptTokensDetails?: Array<{ modality: string; tokenCount: number }>
    [extra: string]: unknown
  }
  modelVersion?: string
  responseId?: string
  error?: { code?: string | number; message?: string; status?: string }
  [extra: string]: unknown
}

// Wire chunk yielded from `geminiStream()`. Mirrors the ChatStreamChunk /
// ResponsesStreamChunk tagged unions.
export type GeminiStreamChunk =
  | {
      type: 'chunk'
      chunk: GenerateContentResponseWire
      generationId?: string
    }
  | { type: 'keepalive'; comment: string }
  | {
      type: 'buffered_result'
      result: GenerateContentResponseWire
      generationId?: string
    }
