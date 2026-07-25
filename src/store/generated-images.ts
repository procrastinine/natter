import {
  contentHasUnmaterializedGeneratedOutput,
  generatedOutputContentAttachmentIds,
  generatedOutputLocalizationJob,
  localizedGeneratedOutputFilename,
  withGeneratedOutputLocalizationJob,
  withGeneratedOutputLocalizationState,
} from '../core/generated-output-localization'
import type {
  Attachment,
  AttachmentKind,
  AttachmentRef,
  ContentItem,
  KeyId,
  MessageAttachmentRef,
  MessageId,
  ProfileId,
} from '../core/types'
import { createAttachmentRef, normalizeAttachmentRefs } from './attachment-refs'
import {
  type PreparedAttachmentBundle,
  prepareAttachmentBytes,
  prepareRemoteAttachment,
} from './attachments'
import type { GeneratedOutputPreparedWrite } from './workspace-protocol'

export { contentHasUnmaterializedGeneratedOutput as contentNeedsGeneratedOutputMaterialization } from '../core/generated-output-localization'

type OutputImageItem = Extract<ContentItem, { type: 'output_image' }>
type OutputAudioItem = Extract<ContentItem, { type: 'audio_output' }>
type OutputVideoItem = Extract<ContentItem, { type: 'output_video' }>
type OutputFileItem = Extract<ContentItem, { type: 'file' }>

export type { GeneratedOutputKind } from '../core/generated-output-localization'

interface GeneratedImageReplacement {
  sourceUrl: string
  item: OutputImageItem
  ref: MessageAttachmentRef
}

interface GeneratedOutputReplacement {
  sourceUrl: string
  item: ContentItem
  ref: MessageAttachmentRef
}

interface GeneratedImageMaterialization {
  content: ContentItem[]
  replacements: GeneratedImageReplacement[]
  newRefs: MessageAttachmentRef[]
  changed: boolean
}

interface GeneratedOutputMaterialization {
  content: ContentItem[]
  replacements: GeneratedOutputReplacement[]
  newRefs: MessageAttachmentRef[]
  changed: boolean
}

export interface PreparedGeneratedOutputMaterialization extends GeneratedOutputMaterialization {
  attachmentBundles: PreparedAttachmentBundle[]
}

export function prepareGeneratedOutputRemoteBundle(input: {
  id: string
  url: string
  filename: string
  mime: string
  kind: AttachmentKind
  now: number
  requestCredential?: { profileId: ProfileId; selectedKeyId: KeyId }
}): PreparedAttachmentBundle {
  const prepared = prepareRemoteAttachment({
    id: input.id,
    url: input.url,
    filename: input.filename,
    mime: input.mime,
    kind: input.kind,
    origin: 'generated-output',
    now: input.now,
  })
  return withGeneratedOutputLocalizationJob(prepared, input.now, input.requestCredential)
}

export { localizedGeneratedOutputFilename }

export function generatedOutputAttachmentIds(content: readonly ContentItem[]): Set<string> {
  return generatedOutputContentAttachmentIds(content)
}

export function generatedOutputAttachmentId(
  messageId: MessageId,
  item: OutputImageItem | OutputAudioItem | OutputVideoItem | OutputFileItem,
  index: number,
): string {
  if (item.type === 'output_image') return generatedImageAttachmentId(messageId, index)
  return generatedMediaAttachmentId(
    messageId,
    item.type === 'audio_output' ? 'audio' : item.type === 'output_video' ? 'video' : 'file',
    index,
  )
}

async function materializeGeneratedImageOutputAttachments(input: {
  messageId: MessageId
  content: readonly ContentItem[]
  now?: number
  attachmentBundles: PreparedAttachmentBundle[]
}): Promise<GeneratedImageMaterialization> {
  const now = input.now ?? Date.now()
  const replacements: GeneratedImageReplacement[] = []
  const content: ContentItem[] = []
  for (let index = 0; index < input.content.length; index += 1) {
    const item = input.content[index]
    if (
      item?.type !== 'output_image' ||
      item.attachmentId ||
      typeof item.url !== 'string' ||
      item.url.length === 0
    ) {
      if (item) content.push(structuredClone(item))
      continue
    }
    const materialized = await materializeOneGeneratedImage({
      messageId: input.messageId,
      item,
      index,
      now,
      attachmentBundles: input.attachmentBundles,
    })
    if (!materialized) {
      content.push(structuredClone(item))
      continue
    }
    content.push(materialized.item)
    replacements.push(materialized)
  }
  const newRefs = replacements.map((replacement) => replacement.ref)
  return {
    content,
    replacements,
    newRefs,
    changed: replacements.length > 0,
  }
}

export async function prepareGeneratedOutputAttachments(input: {
  messageId: MessageId
  content: readonly ContentItem[]
  now?: number
}): Promise<PreparedGeneratedOutputMaterialization> {
  const attachmentBundles: PreparedAttachmentBundle[] = []
  const imageMaterialized = await materializeGeneratedImageOutputAttachments({
    ...input,
    attachmentBundles,
  })
  const mediaMaterialized = await materializeGeneratedAudioVideoOutputAttachments({
    ...input,
    content: imageMaterialized.content,
    attachmentBundles,
  })
  return {
    content: mediaMaterialized.content,
    replacements: [...imageMaterialized.replacements, ...mediaMaterialized.replacements],
    newRefs: [...imageMaterialized.newRefs, ...mediaMaterialized.newRefs],
    changed: imageMaterialized.changed || mediaMaterialized.changed,
    attachmentBundles,
  }
}

async function prepareGeneratedOutputForTerminal(input: {
  messageId: MessageId
  content: readonly ContentItem[]
  now?: number
}): Promise<PreparedGeneratedOutputMaterialization> {
  return prepareGeneratedOutputAttachments(input)
}

export async function prepareGeneratedOutputTerminalWrite(input: {
  messageId: MessageId
  content: readonly ContentItem[]
  attachmentRefs: readonly AttachmentRef[] | undefined
  now: number
  requestCredential?: { profileId: ProfileId; selectedKeyId: KeyId }
}): Promise<GeneratedOutputPreparedWrite | undefined> {
  if (!contentHasUnmaterializedGeneratedOutput(input.content)) return undefined
  const prepared = await prepareGeneratedOutputForTerminal(input)
  if (!prepared.changed || contentHasUnmaterializedGeneratedOutput(prepared.content)) {
    throw new Error(`GeneratedOutputMaterializationFailed:${input.messageId}`)
  }
  const merged = mergeGeneratedImageAttachmentRefs(
    input.attachmentRefs,
    prepared.newRefs,
    input.messageId,
    input.now,
  )
  const requestCredential = input.requestCredential
  return {
    content: prepared.content,
    attachmentRefs: merged.refs,
    attachmentBundles: requestCredential
      ? prepared.attachmentBundles.map((bundle) =>
          bindGeneratedOutputRequestCredential(bundle, requestCredential, input.now),
        )
      : prepared.attachmentBundles,
  }
}

function bindGeneratedOutputRequestCredential(
  bundle: PreparedAttachmentBundle,
  requestCredential: { profileId: ProfileId; selectedKeyId: KeyId },
  now: number,
): PreparedAttachmentBundle {
  const job = generatedOutputLocalizationJob(bundle.attachment, now, requestCredential)
  if (!job) return bundle
  return {
    ...bundle,
    attachment: {
      ...bundle.attachment,
      processing: withGeneratedOutputLocalizationState(bundle.attachment.processing, job),
    },
    jobs: [...bundle.jobs.filter((candidate) => candidate.processorId !== job.processorId), job],
  }
}

async function materializeGeneratedAudioVideoOutputAttachments(input: {
  messageId: MessageId
  content: readonly ContentItem[]
  now?: number
  attachmentBundles: PreparedAttachmentBundle[]
}): Promise<GeneratedOutputMaterialization> {
  const now = input.now ?? Date.now()
  const replacements: GeneratedOutputReplacement[] = []
  const content: ContentItem[] = []
  for (let index = 0; index < input.content.length; index += 1) {
    const item = input.content[index]
    if (
      !item ||
      (item.type !== 'audio_output' && item.type !== 'output_video' && item.type !== 'file') ||
      item.attachmentId ||
      typeof item.url !== 'string' ||
      item.url.length === 0
    ) {
      if (item) content.push(structuredClone(item))
      continue
    }
    const materialized =
      item.type === 'audio_output'
        ? await materializeOneGeneratedAudio({
            messageId: input.messageId,
            item,
            index,
            now,
            attachmentBundles: input.attachmentBundles,
          })
        : item.type === 'output_video'
          ? await materializeOneGeneratedVideo({
              messageId: input.messageId,
              item,
              index,
              now,
              attachmentBundles: input.attachmentBundles,
            })
          : await materializeOneGeneratedFile({
              messageId: input.messageId,
              item,
              index,
              now,
              attachmentBundles: input.attachmentBundles,
            })
    if (!materialized) {
      content.push(structuredClone(item))
      continue
    }
    content.push(materialized.item)
    replacements.push(materialized)
  }
  const newRefs = replacements.map((replacement) => replacement.ref)
  return { content, replacements, newRefs, changed: replacements.length > 0 }
}

export function mergeGeneratedImageAttachmentRefs(
  existingRefs: readonly AttachmentRef[] | undefined,
  newRefs: readonly MessageAttachmentRef[],
  messageId: MessageId,
  now = Date.now(),
): { refs: MessageAttachmentRef[]; addedRefs: MessageAttachmentRef[] } {
  const refs = normalizeAttachmentRefs(existingRefs, { messageId, createdAt: now })
  const existingIds = new Set(
    refs.filter((ref) => ref.deletedAt === undefined).map((ref) => ref.attachmentId),
  )
  const addedRefs: MessageAttachmentRef[] = []
  for (const ref of newRefs) {
    if (existingIds.has(ref.attachmentId)) continue
    refs.push(ref)
    addedRefs.push(ref)
    existingIds.add(ref.attachmentId)
  }
  return { refs, addedRefs }
}

async function materializeOneGeneratedImage(input: {
  messageId: MessageId
  item: OutputImageItem
  index: number
  now: number
  attachmentBundles: PreparedAttachmentBundle[]
}): Promise<GeneratedImageReplacement | null> {
  const sourceUrl = input.item.url
  if (!sourceUrl) return null
  try {
    const attachment = await createGeneratedImageAttachment({
      id: generatedOutputAttachmentId(input.messageId, input.item, input.index),
      sourceUrl,
      filenameStem: `generated-${input.messageId}-${input.index + 1}`,
      now: input.now,
      attachmentBundles: input.attachmentBundles,
    })
    const ref = createAttachmentRef(attachment.id, {
      messageId: input.messageId,
      createdAt: input.now,
    })
    const item: OutputImageItem = {
      type: 'output_image',
      attachmentId: attachment.id,
      ...(input.item.prompt ? { prompt: input.item.prompt } : {}),
    }
    return { sourceUrl, item, ref }
  } catch {
    return null
  }
}

async function materializeOneGeneratedAudio(input: {
  messageId: MessageId
  item: OutputAudioItem
  index: number
  now: number
  attachmentBundles: PreparedAttachmentBundle[]
}): Promise<GeneratedOutputReplacement | null> {
  const sourceUrl = input.item.url
  if (!sourceUrl) return null
  try {
    const attachment = await createGeneratedAudioAttachment({
      id: generatedOutputAttachmentId(input.messageId, input.item, input.index),
      sourceUrl,
      filenameStem: `generated-${input.messageId}-audio-${input.index + 1}`,
      now: input.now,
      attachmentBundles: input.attachmentBundles,
    })
    const ref = createAttachmentRef(attachment.id, {
      messageId: input.messageId,
      createdAt: input.now,
    })
    const item: OutputAudioItem = {
      type: 'audio_output',
      attachmentId: attachment.id,
      ...(input.item.transcript ? { transcript: input.item.transcript } : {}),
      ...(input.item.durationMs !== undefined ? { durationMs: input.item.durationMs } : {}),
      ...(input.item.format ? { format: input.item.format } : {}),
    }
    return { sourceUrl, item, ref }
  } catch {
    return null
  }
}

async function materializeOneGeneratedVideo(input: {
  messageId: MessageId
  item: OutputVideoItem
  index: number
  now: number
  attachmentBundles: PreparedAttachmentBundle[]
}): Promise<GeneratedOutputReplacement | null> {
  const sourceUrl = input.item.url
  if (!sourceUrl) return null
  try {
    const attachment = await createGeneratedVideoAttachment({
      id: generatedOutputAttachmentId(input.messageId, input.item, input.index),
      sourceUrl,
      filenameStem: `generated-${input.messageId}-video-${input.index + 1}`,
      now: input.now,
      attachmentBundles: input.attachmentBundles,
    })
    const ref = createAttachmentRef(attachment.id, {
      messageId: input.messageId,
      createdAt: input.now,
    })
    const item: OutputVideoItem = {
      type: 'output_video',
      attachmentId: attachment.id,
      ...(input.item.prompt ? { prompt: input.item.prompt } : {}),
    }
    return { sourceUrl, item, ref }
  } catch {
    return null
  }
}

async function materializeOneGeneratedFile(input: {
  messageId: MessageId
  item: OutputFileItem
  index: number
  now: number
  attachmentBundles: PreparedAttachmentBundle[]
}): Promise<GeneratedOutputReplacement | null> {
  const sourceUrl = input.item.url
  if (!sourceUrl) return null
  try {
    const attachment = await createGeneratedFileAttachment({
      id: generatedOutputAttachmentId(input.messageId, input.item, input.index),
      sourceUrl,
      filename: input.item.filename || `generated-${input.messageId}-file-${input.index + 1}`,
      mime: input.item.mime || 'application/octet-stream',
      now: input.now,
      attachmentBundles: input.attachmentBundles,
    })
    const ref = createAttachmentRef(attachment.id, {
      messageId: input.messageId,
      createdAt: input.now,
    })
    const item: OutputFileItem = {
      type: 'file',
      attachmentId: attachment.id,
      filename: attachment.filename,
      mime: attachment.mime,
    }
    return { sourceUrl, item, ref }
  } catch {
    return null
  }
}

async function createGeneratedImageAttachment(input: {
  id: string
  sourceUrl: string
  filenameStem: string
  now: number
  attachmentBundles: PreparedAttachmentBundle[]
}): Promise<Attachment> {
  const parsed = parseImagePayload(input.sourceUrl)
  if (parsed) {
    const buffer = new ArrayBuffer(parsed.bytes.byteLength)
    new Uint8Array(buffer).set(parsed.bytes)
    const bundle = await ingestOrPrepareGeneratedAttachment(
      {
        blob: new Blob([buffer], { type: parsed.mime }),
        filename: `${input.filenameStem}.${extensionForMime(parsed.mime)}`,
        declaredMime: parsed.mime,
        origin: 'generated-output',
        id: input.id,
        now: input.now,
      },
      input.attachmentBundles,
    )
    return bundle.attachment
  }
  const remote = remoteImage(input.sourceUrl)
  if (!remote) throw new Error('UnsupportedGeneratedImageUrl')
  return createOrPrepareGeneratedRemoteAttachment(
    {
      url: input.sourceUrl,
      filename: `${input.filenameStem}.${remote.extension}`,
      mime: remote.mime,
      kind: 'image',
      origin: 'generated-output',
      id: input.id,
      now: input.now,
    },
    input.attachmentBundles,
  )
}

async function createGeneratedAudioAttachment(input: {
  id: string
  sourceUrl: string
  filenameStem: string
  now: number
  attachmentBundles: PreparedAttachmentBundle[]
}): Promise<Attachment> {
  const parsed = parseMediaDataUrl(input.sourceUrl, 'audio/')
  if (parsed) {
    const buffer = new ArrayBuffer(parsed.bytes.byteLength)
    new Uint8Array(buffer).set(parsed.bytes)
    const bundle = await ingestOrPrepareGeneratedAttachment(
      {
        blob: new Blob([buffer], { type: parsed.mime }),
        filename: `${input.filenameStem}.${extensionForMediaMime(parsed.mime)}`,
        declaredMime: parsed.mime,
        origin: 'generated-output',
        id: input.id,
        now: input.now,
      },
      input.attachmentBundles,
    )
    return bundle.attachment
  }
  const remote = remoteMedia(input.sourceUrl, 'audio')
  if (!remote) throw new Error('UnsupportedGeneratedAudioUrl')
  return createOrPrepareGeneratedRemoteAttachment(
    {
      url: input.sourceUrl,
      filename: `${input.filenameStem}.${remote.extension}`,
      mime: remote.mime,
      kind: 'audio',
      origin: 'generated-output',
      id: input.id,
      now: input.now,
    },
    input.attachmentBundles,
  )
}

async function createGeneratedVideoAttachment(input: {
  id: string
  sourceUrl: string
  filenameStem: string
  now: number
  attachmentBundles: PreparedAttachmentBundle[]
}): Promise<Attachment> {
  const parsed = parseMediaDataUrl(input.sourceUrl, 'video/')
  if (parsed) {
    const buffer = new ArrayBuffer(parsed.bytes.byteLength)
    new Uint8Array(buffer).set(parsed.bytes)
    const bundle = await ingestOrPrepareGeneratedAttachment(
      {
        blob: new Blob([buffer], { type: parsed.mime }),
        filename: `${input.filenameStem}.${extensionForMediaMime(parsed.mime)}`,
        declaredMime: parsed.mime,
        origin: 'generated-output',
        id: input.id,
        now: input.now,
      },
      input.attachmentBundles,
    )
    return bundle.attachment
  }
  const remote = remoteMedia(input.sourceUrl, 'video')
  if (!remote) throw new Error('UnsupportedGeneratedVideoUrl')
  return createOrPrepareGeneratedRemoteAttachment(
    {
      url: input.sourceUrl,
      filename: `${input.filenameStem}.${remote.extension}`,
      mime: remote.mime,
      kind: 'video',
      origin: 'generated-output',
      id: input.id,
      now: input.now,
    },
    input.attachmentBundles,
  )
}

async function createGeneratedFileAttachment(input: {
  id: string
  sourceUrl: string
  filename: string
  mime: string
  now: number
  attachmentBundles: PreparedAttachmentBundle[]
}): Promise<Attachment> {
  const parsed = parseGenericDataUrl(input.sourceUrl)
  if (parsed) {
    const buffer = new ArrayBuffer(parsed.bytes.byteLength)
    new Uint8Array(buffer).set(parsed.bytes)
    const bundle = await ingestOrPrepareGeneratedAttachment(
      {
        blob: new Blob([buffer], { type: parsed.mime }),
        filename: input.filename,
        declaredMime: parsed.mime,
        origin: 'generated-output',
        id: input.id,
        now: input.now,
      },
      input.attachmentBundles,
    )
    return bundle.attachment
  }
  if (!remoteFile(input.sourceUrl)) throw new Error('UnsupportedGeneratedFileUrl')
  return createOrPrepareGeneratedRemoteAttachment(
    {
      url: input.sourceUrl,
      filename: input.filename,
      mime: input.mime,
      kind: 'other',
      origin: 'generated-output',
      id: input.id,
      now: input.now,
    },
    input.attachmentBundles,
  )
}

async function ingestOrPrepareGeneratedAttachment(
  input: Parameters<typeof prepareAttachmentBytes>[0],
  attachmentBundles: PreparedAttachmentBundle[],
): Promise<PreparedAttachmentBundle> {
  const bundle = await prepareAttachmentBytes(input)
  attachmentBundles.push(bundle)
  return bundle
}

function createOrPrepareGeneratedRemoteAttachment(
  input: Parameters<typeof prepareRemoteAttachment>[0],
  attachmentBundles: PreparedAttachmentBundle[],
): Promise<Attachment> {
  const bundle = prepareGeneratedOutputRemoteBundle({
    id: input.id,
    url: input.url,
    filename: input.filename,
    mime: input.mime ?? 'application/octet-stream',
    kind: input.kind ?? 'other',
    now: input.now ?? Date.now(),
  })
  attachmentBundles.push(bundle)
  return Promise.resolve(bundle.attachment)
}

function generatedImageAttachmentId(messageId: MessageId, index: number): string {
  return `generated:${messageId}:${index + 1}`
}

function generatedMediaAttachmentId(
  messageId: MessageId,
  kind: 'audio' | 'video' | 'file',
  index: number,
): string {
  return `generated:${messageId}:${kind}:${index + 1}`
}

function parseImagePayload(value: string): { bytes: Uint8Array; mime: string } | null {
  const trimmed = value.trim()
  const data = parseImageDataUrl(trimmed)
  if (data) return data
  if (trimmed.includes('://') || trimmed.startsWith('blob:')) return null
  return decodeBase64Image(trimmed, 'image/png')
}

function parseImageDataUrl(value: string): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:([^,;]+)?((?:;[^,]*)*),(.*)$/iu.exec(value)
  if (!match) return null
  const mime = normalizeImageMime(match[1] || 'image/png')
  if (!mime) return null
  const params = match[2] ?? ''
  const payload = match[3] ?? ''
  if (params.split(';').some((param) => param.toLowerCase() === 'base64')) {
    return decodeBase64Image(payload, mime)
  }
  try {
    return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime }
  } catch {
    return null
  }
}

function parseMediaDataUrl(
  value: string,
  mimePrefix: 'audio/' | 'video/',
): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:([^,;]+)?((?:;[^,]*)*),(.*)$/iu.exec(value.trim())
  if (!match) return null
  const mime = (match[1] || `${mimePrefix}mpeg`).toLowerCase()
  if (!mime.startsWith(mimePrefix)) return null
  const params = match[2] ?? ''
  const payload = match[3] ?? ''
  if (params.split(';').some((param) => param.toLowerCase() === 'base64')) {
    const decoded = decodeBase64Image(payload, mime)
    return decoded
  }
  try {
    return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime }
  } catch {
    return null
  }
}

function parseGenericDataUrl(value: string): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:([^,;]+)?((?:;[^,]*)*),(.*)$/iu.exec(value.trim())
  if (!match) return null
  const mime = (match[1] || 'application/octet-stream').toLowerCase()
  const params = match[2] ?? ''
  const payload = match[3] ?? ''
  if (params.split(';').some((param) => param.toLowerCase() === 'base64')) {
    return decodeBase64Image(payload, mime)
  }
  try {
    return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime }
  } catch {
    return null
  }
}

function decodeBase64Image(
  value: string,
  mime: string,
): { bytes: Uint8Array; mime: string } | null {
  const normalized = value.replace(/\s+/gu, '').replace(/-/gu, '+').replace(/_/gu, '/')
  if (normalized.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) return null
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return { bytes, mime }
  } catch {
    return null
  }
}

function remoteImage(value: string): { mime: string; extension: string } | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const extension = extensionFromPath(url.pathname)
  const mime = extension ? mimeForExtension(extension) : undefined
  return {
    mime: mime ?? 'image/png',
    extension: extension ?? 'png',
  }
}

function remoteMedia(
  value: string,
  kind: 'audio' | 'video',
): { mime: string; extension: string } | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const extension = extensionFromPath(url.pathname)
  const mime = extension ? mimeForExtension(extension) : undefined
  if (kind === 'audio') {
    return {
      mime: mime?.startsWith('audio/') ? mime : 'audio/wav',
      extension: mime?.startsWith('audio/') && extension ? extension : 'wav',
    }
  }
  return {
    mime: mime?.startsWith('video/') ? mime : 'video/mp4',
    extension: mime?.startsWith('video/') && extension ? extension : 'mp4',
  }
}

function remoteFile(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeImageMime(mime: string): string | null {
  const lower = mime.toLowerCase()
  if (!lower.startsWith('image/')) return null
  if (lower === 'image/jpg') return 'image/jpeg'
  return lower
}

function extensionFromPath(pathname: string): string | undefined {
  const match = /\.([a-z0-9]+)$/iu.exec(pathname)
  if (!match) return undefined
  const extension = match[1]?.toLowerCase()
  return extension && mimeForExtension(extension) ? extension : undefined
}

function mimeForExtension(extension: string): string | undefined {
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'bmp') return 'image/bmp'
  if (extension === 'svg') return 'image/svg+xml'
  if (extension === 'wav') return 'audio/wav'
  if (extension === 'mp3') return 'audio/mpeg'
  if (extension === 'flac') return 'audio/flac'
  if (extension === 'ogg') return 'audio/ogg'
  if (extension === 'm4a') return 'audio/mp4'
  if (extension === 'mp4') return 'video/mp4'
  if (extension === 'webm') return 'video/webm'
  if (extension === 'mov') return 'video/quicktime'
  return undefined
}

function extensionForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/gif') return 'gif'
  if (mime === 'image/bmp') return 'bmp'
  if (mime === 'image/svg+xml') return 'svg'
  return 'png'
}

function extensionForMediaMime(mime: string): string {
  if (mime === 'audio/mpeg') return 'mp3'
  if (mime === 'audio/flac') return 'flac'
  if (mime === 'audio/ogg') return 'ogg'
  if (mime === 'audio/mp4') return 'm4a'
  if (mime === 'video/webm') return 'webm'
  if (mime === 'video/quicktime') return 'mov'
  if (mime === 'video/mp4') return 'mp4'
  if (mime.startsWith('video/')) return 'mp4'
  return 'wav'
}
