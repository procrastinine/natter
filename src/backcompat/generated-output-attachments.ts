import Dexie, { type Table } from 'dexie'
import {
  generatedOutputLocalizationJob,
  isGeneratedOutputLocalizationJob,
  withGeneratedOutputLocalizationState,
} from '../core/generated-output-localization'
import type {
  Attachment,
  AttachmentBlob,
  AttachmentId,
  AttachmentJob,
  AttachmentKind,
  ContentItem,
  MessageAttachmentRef,
} from '../core/types'
import { sameValue } from '../lib/same-value'
import { type AttachmentHeaderRow, splitAttachmentForStorage } from '../store/attachment-storage'
import type { MessageBodyRow, MessageHeaderRow } from '../store/message-storage'
import { estimateStoredValueBytes } from '../store/storage-size-estimate'

type LegacyGeneratedOutput = Extract<
  ContentItem,
  { type: 'output_image' | 'audio_output' | 'output_video' | 'file' }
> & { attachmentId?: undefined; url: string }

type CanonicalGeneratedOutput = Extract<
  ContentItem,
  { type: 'output_image' | 'audio_output' | 'output_video' | 'file' }
> & { attachmentId: AttachmentId }

type GeneratedOutputWithLocator = LegacyGeneratedOutput | CanonicalGeneratedOutput

interface MaterializedLegacyOutput {
  attachment: Attachment
  blob?: AttachmentBlob
  job?: AttachmentJob
  content: ContentItem
}

export interface GeneratedOutputMessageNormalizationV94 {
  readonly header: MessageHeaderRow
  readonly body: MessageBodyRow
  readonly changed: boolean
  readonly obsoleteBytes: number
}

export async function normalizeGeneratedOutputAttachmentsForMessageV94(input: {
  readonly body: MessageBodyRow
  readonly header: MessageHeaderRow
  readonly attachments: Table<AttachmentHeaderRow, string>
  readonly blobs: Table<AttachmentBlob, string>
  readonly jobs: Table<AttachmentJob, string>
  readonly observedAt: number
}): Promise<GeneratedOutputMessageNormalizationV94> {
  const content = [...input.body.content]
  const refs = [...(input.header.attachmentRefs ?? [])]
  const liveAttachmentIds = new Set(
    refs.filter((ref) => ref.deletedAt === undefined).map((ref) => ref.attachmentId),
  )
  const refIds = new Set(refs.map((ref) => ref.refId))
  let changed = false
  let obsoleteBytes = 0

  for (let index = 0; index < content.length; index += 1) {
    const item = content[index]
    if (!item || !isGeneratedOutputWithLocator(item)) continue
    const legacy = isLegacyGeneratedOutput(item)
    const attachmentId = legacy
      ? await generatedAttachmentId(input.attachments, input.header.id, item, index)
      : item.attachmentId
    const storedAttachmentRow = await input.attachments.get(attachmentId)
    let attachmentRow = storedAttachmentRow
    let materializedJob: AttachmentJob | undefined
    if (!attachmentRow) {
      const materialized = legacy
        ? await materializeLegacyGeneratedOutput(
            input.header.id,
            item,
            index,
            attachmentId,
            input.header.createdAt,
          )
        : missingCanonicalGeneratedOutput(input.header.id, item, index, input.header.createdAt)
      attachmentRow = splitAttachmentForStorage(materialized.attachment)
      materializedJob = materialized.job
      if (materialized.blob) {
        const previousBlob = await input.blobs.get(materialized.blob.id)
        if (!sameValue(previousBlob, materialized.blob)) {
          if (previousBlob) {
            obsoleteBytes = addObsoleteBytes(obsoleteBytes, estimateStoredValueBytes(previousBlob))
          }
          await input.blobs.put(materialized.blob)
        }
      }
      content[index] = materialized.content
      if (legacy) changed = true
    } else if (legacy) {
      content[index] = canonicalContentItem(item, attachmentRow)
      changed = true
    }
    const localizationJob = generatedOutputLocalizationJob(attachmentRow, input.header.createdAt)
    if (localizationJob) {
      const existingJob = await input.jobs.get(localizationJob.id)
      const job =
        isGeneratedOutputLocalizationJob(existingJob) &&
        existingJob.task.expectedSourceUrl === localizationJob.task?.expectedSourceUrl
          ? existingJob
          : (materializedJob ?? localizationJob)
      if (!sameValue(job, existingJob)) {
        if (existingJob) {
          obsoleteBytes = addObsoleteBytes(obsoleteBytes, estimateStoredValueBytes(existingJob))
        }
        await input.jobs.put(job)
      }
      const processing = withGeneratedOutputLocalizationState(attachmentRow.processing, job)
      if (!sameValue(attachmentRow.processing, processing)) {
        attachmentRow = { ...attachmentRow, processing }
      }
    }
    if (!storedAttachmentRow || !sameValue(storedAttachmentRow, attachmentRow)) {
      if (storedAttachmentRow) {
        obsoleteBytes = addObsoleteBytes(
          obsoleteBytes,
          estimateStoredValueBytes(storedAttachmentRow),
        )
      }
      await input.attachments.put(attachmentRow)
    }
    if (!liveAttachmentIds.has(attachmentId)) {
      const ref = generatedAttachmentRef(attachmentId, refIds, input.header.createdAt)
      refs.push(ref)
      refIds.add(ref.refId)
      liveAttachmentIds.add(attachmentId)
      changed = true
    }
  }

  if (!changed) {
    return { header: input.header, body: input.body, changed: false, obsoleteBytes }
  }
  const bodyVersion = input.header.bodyVersion + 1
  const header: MessageHeaderRow = {
    ...input.header,
    attachmentRefs: refs,
    nodeVersion: input.header.nodeVersion + 1,
    requestContextVersion: input.header.requestContextVersion + 1,
    bodyVersion,
  }
  delete header.cachedMediaTokens
  return {
    header,
    body: { ...input.body, content, bodyVersion, updatedAt: input.observedAt },
    changed: true,
    obsoleteBytes,
  }
}

function addObsoleteBytes(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

async function generatedAttachmentId(
  attachments: Table<AttachmentHeaderRow, string>,
  messageId: string,
  item: LegacyGeneratedOutput,
  index: number,
): Promise<AttachmentId> {
  const kind = generatedOutputKind(item)
  const primary =
    kind === 'image'
      ? `generated:${messageId}:${index + 1}`
      : `generated:${messageId}:${kind}:${index + 1}`
  const existing = await attachments.get(primary)
  if (!existing || existing.origin === 'generated-output') return primary
  const legacy = `${primary}:legacy-v35`
  const legacyExisting = await attachments.get(legacy)
  if (!legacyExisting || legacyExisting.origin === 'generated-output') return legacy
  throw new Error(`GeneratedOutputAttachmentIdCollision:${messageId}:${index}`)
}

async function materializeLegacyGeneratedOutput(
  messageId: string,
  item: LegacyGeneratedOutput,
  index: number,
  attachmentId: AttachmentId,
  createdAt: number,
): Promise<MaterializedLegacyOutput> {
  const payload = generatedDataPayload(item)
  const metadata = generatedMetadata(messageId, item, index, payload?.mime)
  if (payload) {
    const contentHash = await sha256Hex(payload.bytes)
    const blobId = `${attachmentId}:original`
    const buffer = new ArrayBuffer(payload.bytes.byteLength)
    new Uint8Array(buffer).set(payload.bytes)
    const blob = new Blob([buffer], { type: payload.mime })
    const attachment: Attachment = {
      id: attachmentId,
      contentHash,
      kind: metadata.kind,
      mime: payload.mime,
      filename: metadata.filename,
      ...(metadata.extension ? { extension: metadata.extension } : {}),
      sizeBytes: blob.size,
      origin: 'generated-output',
      createdAt,
      updatedAt: createdAt,
      storage: { kind: 'local-blob', blobId },
      artifacts: [],
      processing: [],
      refCount: 0,
    }
    return {
      attachment,
      blob: {
        id: blobId,
        attachmentId,
        role: 'original',
        mime: payload.mime,
        contentHash,
        sizeBytes: blob.size,
        blob,
        createdAt,
      },
      content: canonicalContentItem(item, attachment),
    }
  }

  const remote = httpUrl(item.url)
  let attachment: Attachment = {
    id: attachmentId,
    kind: metadata.kind,
    mime: metadata.mime,
    filename: metadata.filename,
    ...(metadata.extension ? { extension: metadata.extension } : {}),
    origin: 'generated-output',
    ...(remote ? { sourceUrl: remote } : {}),
    createdAt,
    updatedAt: createdAt,
    storage: remote
      ? { kind: 'remote-url', url: remote }
      : { kind: 'missing', reason: 'blob-not-found', missingSince: createdAt },
    artifacts: [],
    processing: [],
    refCount: 0,
  }
  const job = generatedOutputLocalizationJob(attachment, createdAt)
  if (job) {
    attachment = {
      ...attachment,
      processing: withGeneratedOutputLocalizationState(attachment.processing, job),
    }
  }
  return { attachment, ...(job ? { job } : {}), content: canonicalContentItem(item, attachment) }
}

function missingCanonicalGeneratedOutput(
  messageId: string,
  item: CanonicalGeneratedOutput,
  index: number,
  createdAt: number,
): MaterializedLegacyOutput {
  const metadata = canonicalGeneratedMetadata(messageId, item, index)
  const attachment: Attachment = {
    id: item.attachmentId,
    kind: metadata.kind,
    mime: metadata.mime,
    filename: metadata.filename,
    ...(metadata.extension ? { extension: metadata.extension } : {}),
    origin: 'generated-output',
    createdAt,
    updatedAt: createdAt,
    storage: { kind: 'missing', reason: 'blob-not-found', missingSince: createdAt },
    artifacts: [],
    processing: [],
    refCount: 0,
  }
  return { attachment, content: structuredClone(item) }
}

function canonicalContentItem(
  item: LegacyGeneratedOutput,
  attachment: Pick<Attachment, 'id' | 'filename' | 'mime'>,
): ContentItem {
  if (item.type === 'output_image') {
    return {
      type: 'output_image',
      attachmentId: attachment.id,
      ...(item.prompt ? { prompt: item.prompt } : {}),
    }
  }
  if (item.type === 'audio_output') {
    return {
      type: 'audio_output',
      attachmentId: attachment.id,
      ...(item.transcript ? { transcript: item.transcript } : {}),
      ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
      ...(item.format ? { format: item.format } : {}),
    }
  }
  if (item.type === 'output_video') {
    return {
      type: 'output_video',
      attachmentId: attachment.id,
      ...(item.prompt ? { prompt: item.prompt } : {}),
    }
  }
  return {
    type: 'file',
    attachmentId: attachment.id,
    filename: attachment.filename,
    mime: attachment.mime,
  }
}

function generatedAttachmentRef(
  attachmentId: AttachmentId,
  refIds: ReadonlySet<string>,
  createdAt: number,
): MessageAttachmentRef {
  const base = `${attachmentId}:ref`
  let refId = base
  let suffix = 1
  while (refIds.has(refId)) {
    refId = `${base}:${suffix}`
    suffix += 1
  }
  return {
    refId,
    attachmentId,
    includeInContext: true,
    presentation: {},
    createdAt,
    updatedAt: createdAt,
  }
}

function isLegacyGeneratedOutput(item: ContentItem): item is LegacyGeneratedOutput {
  return (
    (item.type === 'output_image' ||
      item.type === 'audio_output' ||
      item.type === 'output_video' ||
      item.type === 'file') &&
    !item.attachmentId &&
    typeof item.url === 'string' &&
    item.url.length > 0
  )
}

function isCanonicalGeneratedOutput(item: ContentItem): item is CanonicalGeneratedOutput {
  return (
    (item.type === 'output_image' ||
      item.type === 'audio_output' ||
      item.type === 'output_video' ||
      item.type === 'file') &&
    typeof item.attachmentId === 'string' &&
    item.attachmentId.length > 0
  )
}

function isGeneratedOutputWithLocator(item: ContentItem): item is GeneratedOutputWithLocator {
  return isLegacyGeneratedOutput(item) || isCanonicalGeneratedOutput(item)
}

function generatedOutputKind(item: LegacyGeneratedOutput): 'image' | 'audio' | 'video' | 'file' {
  if (item.type === 'output_image') return 'image'
  if (item.type === 'audio_output') return 'audio'
  if (item.type === 'output_video') return 'video'
  return 'file'
}

function generatedDataPayload(
  item: LegacyGeneratedOutput,
): { bytes: Uint8Array; mime: string } | null {
  const parsed = parseDataUrl(item.url)
  if (parsed) {
    if (item.type === 'output_image' && !parsed.mime.startsWith('image/')) return null
    if (item.type === 'audio_output' && !parsed.mime.startsWith('audio/')) return null
    if (item.type === 'output_video' && !parsed.mime.startsWith('video/')) return null
    return parsed
  }
  if (item.type !== 'output_image' || item.url.includes('://') || item.url.startsWith('blob:')) {
    return null
  }
  return decodeBase64(item.url, 'image/png')
}

function parseDataUrl(value: string): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:([^,;]+)?((?:;[^,]*)*),(.*)$/iu.exec(value.trim())
  if (!match) return null
  const mime = (match[1] || 'application/octet-stream').toLowerCase()
  const params = match[2] ?? ''
  const payload = match[3] ?? ''
  if (params.split(';').some((param) => param.toLowerCase() === 'base64')) {
    return decodeBase64(payload, mime)
  }
  try {
    return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime }
  } catch {
    return null
  }
}

function decodeBase64(value: string, mime: string): { bytes: Uint8Array; mime: string } | null {
  const normalized = value.replace(/\s+/gu, '').replace(/-/gu, '+').replace(/_/gu, '/')
  if (normalized.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) return null
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return { bytes, mime }
  } catch {
    return null
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  const digest = await Dexie.waitFor(globalThis.crypto.subtle.digest('SHA-256', input))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function generatedMetadata(
  messageId: string,
  item: LegacyGeneratedOutput,
  index: number,
  dataMime?: string,
): { kind: AttachmentKind; mime: string; filename: string; extension?: string } {
  const remoteExtension = extensionFromUrl(item.url)
  if (item.type === 'output_image') {
    const mime = dataMime ?? mimeForExtension(remoteExtension) ?? 'image/png'
    const extension = extensionForMime(mime, 'png')
    return {
      kind: 'image',
      mime,
      filename: `generated-${messageId}-${index + 1}.${extension}`,
      extension,
    }
  }
  if (item.type === 'audio_output') {
    const fallbackMime = item.format ? mimeForAudioFormat(item.format) : 'audio/wav'
    const mime = dataMime ?? mimeForExtension(remoteExtension) ?? fallbackMime
    const extension = extensionForMime(
      mime,
      item.format === 'pcm16' ? 'wav' : (item.format ?? 'wav'),
    )
    return {
      kind: 'audio',
      mime,
      filename: `generated-${messageId}-audio-${index + 1}.${extension}`,
      extension,
    }
  }
  if (item.type === 'output_video') {
    const mime = dataMime ?? mimeForExtension(remoteExtension) ?? 'video/mp4'
    const extension = extensionForMime(mime, 'mp4')
    return {
      kind: 'video',
      mime,
      filename: `generated-${messageId}-video-${index + 1}.${extension}`,
      extension,
    }
  }
  const mime = dataMime ?? item.mime
  const extension = filenameExtension(item.filename) ?? extensionForMime(mime)
  return {
    kind: attachmentKindForMime(mime, item.filename),
    mime,
    filename: item.filename || `generated-${messageId}-file-${index + 1}`,
    ...(extension ? { extension } : {}),
  }
}

function canonicalGeneratedMetadata(
  messageId: string,
  item: CanonicalGeneratedOutput,
  index: number,
): { kind: AttachmentKind; mime: string; filename: string; extension?: string } {
  if (item.type === 'output_image') {
    return {
      kind: 'image',
      mime: 'image/png',
      filename: `generated-${messageId}-${index + 1}.png`,
      extension: 'png',
    }
  }
  if (item.type === 'audio_output') {
    const mime = item.format ? mimeForAudioFormat(item.format) : 'audio/wav'
    const extension = extensionForMime(
      mime,
      item.format === 'pcm16' ? 'wav' : (item.format ?? 'wav'),
    )
    return {
      kind: 'audio',
      mime,
      filename: `generated-${messageId}-audio-${index + 1}.${extension}`,
      extension,
    }
  }
  if (item.type === 'output_video') {
    return {
      kind: 'video',
      mime: 'video/mp4',
      filename: `generated-${messageId}-video-${index + 1}.mp4`,
      extension: 'mp4',
    }
  }
  const extension = filenameExtension(item.filename) ?? extensionForMime(item.mime)
  return {
    kind: attachmentKindForMime(item.mime, item.filename),
    mime: item.mime,
    filename: item.filename || `generated-${messageId}-file-${index + 1}`,
    ...(extension ? { extension } : {}),
  }
}

function attachmentKindForMime(mime: string, filename: string): AttachmentKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('text/')) {
    return /\.(?:js|jsx|ts|tsx|py|rb|rs|go|java|c|cc|cpp|h|hpp|css|html|json|ya?ml)$/iu.test(
      filename,
    )
      ? 'code'
      : 'plaintext'
  }
  return 'other'
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function extensionFromUrl(value: string): string | undefined {
  try {
    return filenameExtension(new URL(value).pathname)
  } catch {
    return undefined
  }
}

function filenameExtension(value: string): string | undefined {
  const filename = value.split(/[\\/]/u).pop() ?? value
  const dot = filename.lastIndexOf('.')
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : undefined
}

function mimeForAudioFormat(format: string): string {
  if (format === 'mp3') return 'audio/mpeg'
  if (format === 'flac') return 'audio/flac'
  if (format === 'ogg') return 'audio/ogg'
  if (format === 'm4a') return 'audio/mp4'
  return 'audio/wav'
}

function mimeForExtension(extension: string | undefined): string | undefined {
  if (!extension) return undefined
  const value: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    pdf: 'application/pdf',
    txt: 'text/plain',
    json: 'application/json',
  }
  return value[extension]
}

function extensionForMime(mime: string, fallback: string): string
function extensionForMime(mime: string, fallback?: string): string | undefined
function extensionForMime(mime: string, fallback?: string): string | undefined {
  const value: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/flac': 'flac',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'application/json': 'json',
  }
  return value[mime] ?? fallback
}
