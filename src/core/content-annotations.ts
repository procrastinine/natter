import type { CitationFileIdentity, ContentAnnotation, ContentAnnotationSource } from './types'

interface NormalizeAnnotationOptions {
  readonly source: ContentAnnotationSource
  readonly text: string
}

export interface CitationDisplayTarget {
  readonly token: string
  readonly ordinal: number
  readonly annotation: Exclude<ContentAnnotation, { type: 'unknown' }>
}

export interface CitationDisplayPlan {
  readonly markdown: string
  readonly targets: readonly CitationDisplayTarget[]
}

export function normalizeContentAnnotations(
  values: readonly unknown[] | null | undefined,
  options: NormalizeAnnotationOptions,
): ContentAnnotation[] {
  if (!values || values.length === 0) return []
  const annotations: ContentAnnotation[] = []
  let citedTextSearchFrom = 0
  for (const value of values) {
    const normalized = normalizeContentAnnotation(value, options, citedTextSearchFrom)
    if (!normalized) continue
    annotations.push(normalized)
    if (normalized.endIndex > citedTextSearchFrom) citedTextSearchFrom = normalized.endIndex
  }
  return annotations
}

export function normalizeGeminiGroundingAnnotations(
  value: unknown,
  text: string,
): ContentAnnotation[] {
  if (!isRecord(value)) return []
  const supports: readonly unknown[] = Array.isArray(value.groundingSupports)
    ? (value.groundingSupports as readonly unknown[])
    : []
  const chunks: readonly unknown[] = Array.isArray(value.groundingChunks)
    ? (value.groundingChunks as readonly unknown[])
    : []
  const annotations: ContentAnnotation[] = []
  for (const rawSupport of supports) {
    if (!isRecord(rawSupport)) continue
    const segment = isRecord(rawSupport.segment) ? rawSupport.segment : {}
    const startIndex = normalizedRangeIndex(segment.startIndex, 0, text.length)
    const endIndex = normalizedRangeIndex(segment.endIndex, text.length, text.length)
    const [start, end] = normalizeRange(text, startIndex, endIndex)
    const indices: readonly unknown[] = Array.isArray(rawSupport.groundingChunkIndices)
      ? (rawSupport.groundingChunkIndices as readonly unknown[])
      : []
    for (const rawIndex of indices) {
      if (!Number.isInteger(rawIndex) || (rawIndex as number) < 0) continue
      const chunk = chunks[rawIndex as number]
      if (!isRecord(chunk)) continue
      const web = isRecord(chunk.web) ? chunk.web : undefined
      const uri = stringValue(web?.uri)
      if (!uri) continue
      const title = stringValue(web?.title)
      const providerPayload = cloneRecord({
        type: 'gemini_grounding_support',
        segment,
        groundingChunkIndex: rawIndex,
        web,
      })
      annotations.push({
        type: 'url_citation',
        source: 'gemini-native',
        startIndex: start,
        endIndex: end,
        url: uri,
        ...(title ? { title } : {}),
        providerPayload,
      })
    }
  }
  return deduplicateContentAnnotations(annotations)
}

export function normalizeMessageContentAnnotations<T extends { readonly type: string }>(
  content: readonly T[],
  source: ContentAnnotationSource = 'imported',
): T[] {
  const state = { changed: false }
  const result = content.map((item) => {
    if (item.type !== 'output_text') return item
    const output = item as T & { readonly text?: unknown; readonly annotations?: unknown }
    if (typeof output.text !== 'string' || !Array.isArray(output.annotations)) return item
    const annotations = normalizeContentAnnotations(output.annotations, {
      source,
      text: output.text,
    })
    state.changed = true
    return { ...item, annotations }
  })
  return state.changed ? result : (content as T[])
}

export function responsesWireAnnotations(
  annotations: readonly ContentAnnotation[] | undefined,
): Record<string, unknown>[] | undefined {
  return providerWireAnnotations(annotations, 'openai-responses')
}

export function anthropicWireCitations(
  annotations: readonly ContentAnnotation[] | undefined,
): Record<string, unknown>[] | undefined {
  return providerWireAnnotations(annotations, 'anthropic-messages')
}

export function planCitationDisplay(
  text: string,
  annotations: readonly ContentAnnotation[] | undefined,
  tokenPrefix = 'c',
  ordinalOffset = 0,
): CitationDisplayPlan {
  if (!annotations || annotations.length === 0) return { markdown: text, targets: [] }
  const targets: CitationDisplayTarget[] = []
  const byBoundary = new Map<number, CitationDisplayTarget[]>()
  for (const annotation of annotations) {
    if (annotation.type === 'unknown') continue
    if (annotation.type === 'url_citation' && !safeCitationUrl(annotation.url)) continue
    const ordinal = ordinalOffset + targets.length + 1
    const target = {
      token: `${tokenPrefix}-${ordinal - 1}`,
      ordinal,
      annotation,
    } satisfies CitationDisplayTarget
    targets.push(target)
    const boundary = safeUtf16Boundary(text, annotation.endIndex)
    const group = byBoundary.get(boundary)
    if (group) group.push(target)
    else byBoundary.set(boundary, [target])
  }
  if (targets.length === 0) return { markdown: text, targets }
  const boundaries = [...byBoundary.keys()].sort((left, right) => left - right)
  const parts: string[] = []
  let offset = 0
  for (const boundary of boundaries) {
    parts.push(text.slice(offset, boundary))
    const group = byBoundary.get(boundary) ?? []
    for (const target of group) {
      parts.push(` [${target.ordinal}](#natter-citation-${target.token})`)
    }
    offset = boundary
  }
  parts.push(text.slice(offset))
  return { markdown: parts.join(''), targets }
}

export function safeCitationUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function deduplicateContentAnnotations(
  annotations: readonly ContentAnnotation[],
): ContentAnnotation[] {
  const seen = new Set<string>()
  const result: ContentAnnotation[] = []
  for (const annotation of annotations) {
    const identity = annotationIdentity(annotation)
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push(annotation)
  }
  return result
}

function normalizeContentAnnotation(
  value: unknown,
  options: NormalizeAnnotationOptions,
  citedTextSearchFrom: number,
): ContentAnnotation | null {
  if (!isRecord(value)) return null
  if (isCanonicalAnnotation(value)) {
    return cloneCanonicalAnnotation(value as unknown as ContentAnnotation, options.text)
  }
  const annotationType = stringValue(value.type) ?? 'unknown'
  const citedText = stringValue(value.cited_text) ?? stringValue(value.text)
  const explicitStart = firstFiniteInteger(value.startIndex, value.start_index, value.index)
  const explicitEnd = firstFiniteInteger(value.endIndex, value.end_index)
  const located = locateCitedText(options.text, citedText, citedTextSearchFrom)
  const [startIndex, endIndex] = normalizeRange(
    options.text,
    explicitStart ?? located.start,
    explicitEnd ?? located.end,
  )
  const providerPayload = cloneRecord(value)
  const nestedUrl = isRecord(value.url_citation) ? stringValue(value.url_citation.url) : undefined
  const url =
    stringValue(value.url) ??
    nestedUrl ??
    (annotationType === 'search_result_location' ? stringValue(value.source) : undefined)
  if (
    annotationType === 'url_citation' ||
    annotationType === 'web_search_result_location' ||
    (annotationType === 'search_result_location' && url !== undefined)
  ) {
    if (!url) return unknownAnnotation(annotationType, options.source, startIndex, endIndex, value)
    const title =
      stringValue(value.title) ??
      (isRecord(value.url_citation) ? stringValue(value.url_citation.title) : undefined)
    return {
      type: 'url_citation',
      source: options.source,
      startIndex,
      endIndex,
      url,
      ...(title ? { title } : {}),
      providerPayload,
    }
  }
  if (isFileAnnotationType(annotationType)) {
    const nestedFileCitation = isRecord(value.file_citation) ? value.file_citation : undefined
    const fileId = stringValue(value.file_id) ?? stringValue(nestedFileCitation?.file_id)
    const attachmentId = stringValue(value.attachmentId) ?? stringValue(value.attachment_id)
    const containerId = stringValue(value.container_id)
    const documentIndex = finiteInteger(value.document_index)
    const filename =
      stringValue(value.filename) ??
      stringValue(value.document_title) ??
      stringValue(nestedFileCitation?.filename)
    const title = stringValue(value.title)
    const file = citationFileIdentity({
      source: options.source,
      ...(attachmentId ? { attachmentId } : {}),
      ...(fileId ? { fileId } : {}),
      ...(containerId ? { containerId } : {}),
      ...(documentIndex !== undefined ? { documentIndex } : {}),
    })
    return {
      type: 'file_citation',
      source: options.source,
      startIndex,
      endIndex,
      file,
      ...(filename ? { filename } : {}),
      ...(title ? { title } : {}),
      ...(citedText ? { citedText } : {}),
      providerPayload,
    }
  }
  return unknownAnnotation(annotationType, options.source, startIndex, endIndex, value)
}

function isCanonicalAnnotation(value: Record<string, unknown>): boolean {
  if (
    !isContentAnnotationSource(value.source) ||
    !Number.isInteger(value.startIndex) ||
    !Number.isInteger(value.endIndex) ||
    !isRecord(value.providerPayload)
  ) {
    return false
  }
  if (value.type === 'url_citation') {
    return typeof value.url === 'string' && isOptionalString(value.title)
  }
  if (value.type === 'file_citation') {
    return (
      isCitationFileIdentity(value.file) &&
      isOptionalString(value.filename) &&
      isOptionalString(value.title) &&
      isOptionalString(value.citedText)
    )
  }
  return value.type === 'unknown' && typeof value.annotationType === 'string'
}

function cloneCanonicalAnnotation(annotation: ContentAnnotation, text: string): ContentAnnotation {
  const [startIndex, endIndex] = normalizeRange(text, annotation.startIndex, annotation.endIndex)
  return {
    ...structuredClone(annotation),
    startIndex,
    endIndex,
    providerPayload: cloneRecord(annotation.providerPayload),
  }
}

function unknownAnnotation(
  annotationType: string,
  source: ContentAnnotationSource,
  startIndex: number,
  endIndex: number,
  payload: Record<string, unknown>,
): ContentAnnotation {
  return {
    type: 'unknown',
    annotationType,
    source,
    startIndex,
    endIndex,
    providerPayload: cloneRecord(payload),
  }
}

function providerWireAnnotations(
  annotations: readonly ContentAnnotation[] | undefined,
  source: ContentAnnotationSource,
): Record<string, unknown>[] | undefined {
  if (!annotations) return undefined
  const result = annotations
    .filter((annotation) => annotation.source === source)
    .map((annotation) => cloneRecord(annotation.providerPayload))
  return result.length > 0 ? result : undefined
}

function citationFileIdentity(input: {
  source: ContentAnnotationSource
  attachmentId?: string
  fileId?: string
  containerId?: string
  documentIndex?: number
}): CitationFileIdentity {
  if (input.attachmentId) return { kind: 'attachment', attachmentId: input.attachmentId }
  if (input.fileId) {
    return {
      kind: 'provider-file',
      provider: input.source,
      fileId: input.fileId,
      ...(input.containerId ? { containerId: input.containerId } : {}),
    }
  }
  if (input.documentIndex !== undefined) {
    return { kind: 'document', provider: input.source, documentIndex: input.documentIndex }
  }
  return { kind: 'unresolved', provider: input.source }
}

function isFileAnnotationType(type: string): boolean {
  return (
    type === 'file_citation' ||
    type === 'container_file_citation' ||
    type === 'file_path' ||
    type === 'char_location' ||
    type === 'page_location' ||
    type === 'content_block_location' ||
    type === 'search_result_location'
  )
}

function locateCitedText(
  text: string,
  citedText: string | undefined,
  searchFrom: number,
): { start: number; end: number } {
  if (!citedText) return { start: text.length, end: text.length }
  let start = text.indexOf(citedText, Math.min(searchFrom, text.length))
  if (start < 0) start = text.indexOf(citedText)
  if (start < 0) return { start: text.length, end: text.length }
  return { start, end: start + citedText.length }
}

function normalizeRange(text: string, rawStart: number, rawEnd: number): [number, number] {
  const start = safeUtf16Boundary(text, normalizedRangeIndex(rawStart, 0, text.length))
  const end = safeUtf16Boundary(text, normalizedRangeIndex(rawEnd, text.length, text.length))
  return start <= end ? [start, end] : [end, end]
}

function normalizedRangeIndex(value: unknown, fallback: number, max: number): number {
  const integer = finiteInteger(value)
  if (integer === undefined) return fallback
  return Math.max(0, Math.min(max, integer))
}

function safeUtf16Boundary(text: string, rawIndex: number): number {
  const index = Math.max(0, Math.min(text.length, Math.trunc(rawIndex)))
  if (index <= 0 || index >= text.length) return index
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
    ? index + 1
    : index
}

function firstFiniteInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const integer = finiteInteger(value)
    if (integer !== undefined) return integer
  }
  return undefined
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isContentAnnotationSource(value: unknown): value is ContentAnnotationSource {
  return (
    value === 'openai-responses' ||
    value === 'openai-chat' ||
    value === 'anthropic-messages' ||
    value === 'gemini-native' ||
    value === 'imported' ||
    value === 'unknown'
  )
}

function isCitationFileIdentity(value: unknown): value is CitationFileIdentity {
  if (!isRecord(value)) return false
  if (value.kind === 'attachment') return typeof value.attachmentId === 'string'
  if (value.kind === 'provider-file') {
    return (
      isContentAnnotationSource(value.provider) &&
      typeof value.fileId === 'string' &&
      isOptionalString(value.containerId)
    )
  }
  if (value.kind === 'document') {
    return (
      isContentAnnotationSource(value.provider) &&
      Number.isInteger(value.documentIndex) &&
      (value.documentIndex as number) >= 0
    )
  }
  return value.kind === 'unresolved' && isContentAnnotationSource(value.provider)
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value)
}

function annotationIdentity(annotation: ContentAnnotation): string {
  const target =
    annotation.type === 'url_citation'
      ? annotation.url
      : annotation.type === 'file_citation'
        ? JSON.stringify(annotation.file)
        : annotation.annotationType
  return `${annotation.source}:${annotation.type}:${annotation.startIndex}:${annotation.endIndex}:${target}`
}
