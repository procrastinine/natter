import {
  GENERIC_FILE_TOKEN_FALLBACK,
  imageTokenEstimate,
  type MediaTokenEstimateOptions,
  type PdfMeta,
  pdfTokenEstimate,
} from './media-tokens'
import { safeContent } from './token-guards'
import type { TokenizerFamily } from './tokens'
import type { Attachment, AttachmentId, AttachmentRef, Message } from './types'

export type AttachmentResolver = (id: AttachmentId) => Attachment | undefined

export function mediaTokensForContent(
  content: unknown,
  family: TokenizerFamily,
  resolver?: AttachmentResolver,
  options?: MediaTokenEstimateOptions,
): number {
  let tokens = 0
  for (const item of safeContent(content)) {
    if (item.type === 'image_url' || item.type === 'output_image') {
      tokens += imageTokensForItem(item.attachmentId, family, resolver, options)
    } else if (item.type === 'file') {
      tokens += fileTokensForItem(item.attachmentId, item.mime, family, resolver)
    } else if (
      item.type === 'input_audio' ||
      item.type === 'audio_output' ||
      item.type === 'video_url'
    ) {
      tokens += genericMediaTokensForItem(item.attachmentId, resolver)
    }
  }
  return tokens
}

export function attachmentTokenCountFor(
  attachmentId: AttachmentId,
  family: TokenizerFamily,
  resolver?: AttachmentResolver,
  ref?: AttachmentRef,
  options?: MediaTokenEstimateOptions,
): number {
  const att = resolver?.(attachmentId)
  if (att?.storage.kind === 'missing') return 0
  if (att?.kind === 'image') return imageTokensForAttachment(att, family, options)
  if (att?.kind === 'pdf') return pdfTokensForAttachment(att, family, ref)
  return GENERIC_FILE_TOKEN_FALLBACK
}

export function mediaTokensForMessage(
  message: Message,
  family: TokenizerFamily,
  resolver: AttachmentResolver | undefined,
  contextRefs: readonly AttachmentRef[] | undefined,
  options?: MediaTokenEstimateOptions,
): number {
  const refsAreAuthoritative = message.attachmentRefs !== undefined
  const visibleRefs = visibleAttachmentRefs(contextRefs ?? message.attachmentRefs)
  const visibleIds = refsAreAuthoritative
    ? new Set(visibleRefs.map((ref) => attachmentRefId(ref)))
    : undefined
  const contentTokens = mediaTokensForContentWithVisibility(
    message.content,
    family,
    resolver,
    visibleIds,
    options,
  )
  const idsInContent = attachmentIdsInContent(message.content)
  const refTokens = visibleRefs
    .filter((ref) => !idsInContent.has(attachmentRefId(ref)))
    .reduce(
      (sum, ref) =>
        sum + attachmentTokenCountFor(attachmentRefId(ref), family, resolver, ref, options),
      0,
    )
  return contentTokens + refTokens
}

function mediaTokensForContentWithVisibility(
  content: unknown,
  family: TokenizerFamily,
  resolver: AttachmentResolver | undefined,
  visibleIds: ReadonlySet<AttachmentId> | undefined,
  options: MediaTokenEstimateOptions | undefined,
): number {
  let tokens = 0
  for (const item of safeContent(content)) {
    const attachmentId = 'attachmentId' in item ? item.attachmentId : undefined
    if (attachmentId && visibleIds && !visibleIds.has(attachmentId)) continue
    if (item.type === 'image_url' || item.type === 'output_image') {
      tokens += imageTokensForItem(item.attachmentId, family, resolver, options)
    } else if (item.type === 'file') {
      tokens += fileTokensForItem(item.attachmentId, item.mime, family, resolver)
    } else if (
      item.type === 'input_audio' ||
      item.type === 'audio_output' ||
      item.type === 'video_url'
    ) {
      tokens += genericMediaTokensForItem(item.attachmentId, resolver)
    }
  }
  return tokens
}

export function mediaTokensForRefs(
  refs: readonly AttachmentRef[] | undefined,
  family: TokenizerFamily,
  resolver: AttachmentResolver | undefined,
  options?: MediaTokenEstimateOptions,
): number {
  return visibleAttachmentRefs(refs).reduce(
    (sum, ref) =>
      sum + attachmentTokenCountFor(attachmentRefId(ref), family, resolver, ref, options),
    0,
  )
}

export function visibleAttachmentRefs(refs: readonly AttachmentRef[] | undefined): AttachmentRef[] {
  if (!refs) return []
  const out: AttachmentRef[] = []
  for (const ref of refs) {
    if (typeof ref === 'string') {
      out.push(ref)
      continue
    }
    if (ref.deletedAt !== undefined || ref.includeInContext === false) continue
    out.push(ref)
  }
  return out
}

export function attachmentIdsInContent(content: unknown): Set<AttachmentId> {
  const ids = new Set<AttachmentId>()
  for (const item of safeContent(content)) {
    const attachmentId = 'attachmentId' in item ? item.attachmentId : undefined
    if (attachmentId) ids.add(attachmentId)
  }
  return ids
}

function imageTokensForItem(
  attachmentId: AttachmentId | undefined,
  family: TokenizerFamily,
  resolver: AttachmentResolver | undefined,
  options: MediaTokenEstimateOptions | undefined,
): number {
  const att = attachmentId ? resolver?.(attachmentId) : undefined
  if (att?.storage.kind === 'missing') return 0
  if (att?.kind === 'image') return imageTokensForAttachment(att, family, options)
  return imageTokenEstimate(family, {}, options)
}

function fileTokensForItem(
  attachmentId: AttachmentId | undefined,
  mime: string,
  family: TokenizerFamily,
  resolver: AttachmentResolver | undefined,
): number {
  const att = attachmentId ? resolver?.(attachmentId) : undefined
  if (att?.storage.kind === 'missing') return 0
  if (att?.kind === 'pdf') return pdfTokensForAttachment(att, family)
  if (mime === 'application/pdf') return pdfTokenEstimate(family, { tier: 'server-parser' })
  return GENERIC_FILE_TOKEN_FALLBACK
}

function genericMediaTokensForItem(
  attachmentId: AttachmentId | undefined,
  resolver: AttachmentResolver | undefined,
): number {
  const att = attachmentId ? resolver?.(attachmentId) : undefined
  if (att?.storage.kind === 'missing') return 0
  return GENERIC_FILE_TOKEN_FALLBACK
}

function imageTokensForAttachment(
  att: Attachment,
  family: TokenizerFamily,
  options: MediaTokenEstimateOptions | undefined,
): number {
  return imageTokenEstimate(
    family,
    {
      ...(att.dimensions?.width !== undefined ? { width: att.dimensions.width } : {}),
      ...(att.dimensions?.height !== undefined ? { height: att.dimensions.height } : {}),
      ...(att.sizeBytes !== undefined ? { sizeBytes: att.sizeBytes } : {}),
    },
    options,
  )
}

function pdfTokensForAttachment(
  att: Attachment,
  family: TokenizerFamily,
  ref?: AttachmentRef,
): number {
  const meta: PdfMeta = {}
  if (att.pageCount !== undefined) meta.pageCount = att.pageCount
  if (att.sizeBytes !== undefined) meta.sizeBytes = att.sizeBytes
  meta.tier = pdfTierForRef(ref)
  return pdfTokenEstimate(family, meta)
}

function attachmentRefId(ref: AttachmentRef): AttachmentId {
  return typeof ref === 'string' ? ref : ref.attachmentId
}

function pdfTierForRef(ref: AttachmentRef | undefined): NonNullable<PdfMeta['tier']> {
  if (typeof ref === 'object') {
    if (ref.presentation.pdfTier === 'native') return 'native'
    if (ref.presentation.pdfTier === 'client') return 'client-extract'
  }
  return 'server-parser'
}
