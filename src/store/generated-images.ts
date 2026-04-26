import type {
  Attachment,
  AttachmentRef,
  ContentItem,
  Message,
  MessageAttachmentRef,
  MessageId,
} from '../core/types'
import { createAttachmentRef, normalizeAttachmentRefs } from './attachment-refs'
import {
  attachmentScopes,
  createRemoteAttachment,
  decRefs,
  deleteUnreferencedAttachment,
  incRefs,
  ingestAttachmentBytes,
  replaceAttachmentBytes,
} from './attachments'
import { getBrowserRepository } from './browser-repo'
import { resolveKeyIfPresent } from './keys'
import { getProfile } from './profiles'

type OutputImageItem = Extract<ContentItem, { type: 'output_image' }>
type OutputAudioItem = Extract<ContentItem, { type: 'audio_output' }>
type OutputVideoItem = Extract<ContentItem, { type: 'output_video' }>
type GeneratedOutputKind = 'image' | 'audio' | 'video'

export type GeneratedOutputDownloader = (input: {
  url: string
  kind: GeneratedOutputKind
}) => Promise<Blob | null | undefined>

export type GeneratedVideoUrlResolver = (url: string) => Promise<string[]>

export interface GeneratedImageReplacement {
  sourceUrl: string
  item: OutputImageItem
  ref: MessageAttachmentRef
}

export interface GeneratedOutputReplacement {
  sourceUrl: string
  item: ContentItem
  ref: MessageAttachmentRef
}

export interface GeneratedImageMaterialization {
  content: ContentItem[]
  replacements: GeneratedImageReplacement[]
  newRefs: MessageAttachmentRef[]
  changed: boolean
}

export interface GeneratedOutputMaterialization {
  content: ContentItem[]
  replacements: GeneratedOutputReplacement[]
  newRefs: MessageAttachmentRef[]
  changed: boolean
}

export function contentHasRawGeneratedImageOutput(content: readonly ContentItem[]): boolean {
  return content.some(
    (item) =>
      item.type === 'output_image' &&
      !item.attachmentId &&
      typeof item.url === 'string' &&
      item.url.length > 0,
  )
}

export function generatedImageOutputAttachmentIds(content: readonly ContentItem[]): Set<string> {
  return generatedOutputAttachmentIds(content)
}

export function generatedOutputAttachmentIds(content: readonly ContentItem[]): Set<string> {
  const ids = new Set<string>()
  for (const item of content) {
    if (item.type === 'output_image' && item.attachmentId) ids.add(item.attachmentId)
    if (item.type === 'audio_output' && item.attachmentId) ids.add(item.attachmentId)
    if (item.type === 'output_video' && item.attachmentId) ids.add(item.attachmentId)
  }
  return ids
}

export async function materializeGeneratedImageOutputAttachments(input: {
  messageId: MessageId
  content: readonly ContentItem[]
  now?: number
  downloader?: GeneratedOutputDownloader
}): Promise<GeneratedImageMaterialization> {
  const now = input.now ?? Date.now()
  const replacements: GeneratedImageReplacement[] = []
  const content: ContentItem[] = []
  for (let index = 0; index < input.content.length; index += 1) {
    const item = input.content[index]
    if (
      !item ||
      item.type !== 'output_image' ||
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
      ...(input.downloader ? { downloader: input.downloader } : {}),
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

export async function materializeGeneratedOutputAttachments(input: {
  messageId: MessageId
  content: readonly ContentItem[]
  now?: number
  downloader?: GeneratedOutputDownloader
}): Promise<GeneratedOutputMaterialization> {
  const imageMaterialized = await materializeGeneratedImageOutputAttachments(input)
  const mediaMaterialized = await materializeGeneratedAudioVideoOutputAttachments({
    ...input,
    content: imageMaterialized.content,
  })
  return {
    content: mediaMaterialized.content,
    replacements: [...imageMaterialized.replacements, ...mediaMaterialized.replacements],
    newRefs: [...imageMaterialized.newRefs, ...mediaMaterialized.newRefs],
    changed: imageMaterialized.changed || mediaMaterialized.changed,
  }
}

async function materializeGeneratedAudioVideoOutputAttachments(input: {
  messageId: MessageId
  content: readonly ContentItem[]
  now?: number
  downloader?: GeneratedOutputDownloader
}): Promise<GeneratedOutputMaterialization> {
  const now = input.now ?? Date.now()
  const replacements: GeneratedOutputReplacement[] = []
  const content: ContentItem[] = []
  for (let index = 0; index < input.content.length; index += 1) {
    const item = input.content[index]
    if (
      !item ||
      (item.type !== 'audio_output' && item.type !== 'output_video') ||
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
            ...(input.downloader ? { downloader: input.downloader } : {}),
          })
        : await materializeOneGeneratedVideo({
            messageId: input.messageId,
            item,
            index,
            now,
            ...(input.downloader ? { downloader: input.downloader } : {}),
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

export async function migrateGeneratedImageOutputAttachments(messageId: MessageId): Promise<void> {
  await migrateGeneratedOutputAttachments(messageId)
}

export async function migrateGeneratedOutputAttachments(messageId: MessageId): Promise<void> {
  const repo = getBrowserRepository()
  const existing = await repo.getMessage(messageId)
  if (!existing || existing.deleted) return
  const migrationContext = await generatedOutputMigrationContext(existing)
  const expanded = await expandLegacyVideoPollingOutputs(existing.content, migrationContext)
  const materialized = await materializeGeneratedImageOutputAttachments({
    messageId,
    content: expanded.content,
    now: Date.now(),
    ...(migrationContext?.downloader ? { downloader: migrationContext.downloader } : {}),
  })
  const mediaMaterialized = await materializeGeneratedAudioVideoOutputAttachments({
    messageId,
    content: materialized.content,
    now: Date.now(),
    ...(migrationContext?.downloader ? { downloader: migrationContext.downloader } : {}),
  })
  const combined: GeneratedOutputMaterialization = {
    content: mediaMaterialized.content,
    replacements: [...materialized.replacements, ...mediaMaterialized.replacements],
    newRefs: [...materialized.newRefs, ...mediaMaterialized.newRefs],
    changed: expanded.changed || materialized.changed || mediaMaterialized.changed,
  }
  if (!combined.changed) {
    await localizeReferencedGeneratedOutputAttachments(existing, migrationContext)
    return
  }
  const originalContent = JSON.stringify(existing.content)
  await repo.runMutation(
    [{ kind: 'message', messageId }, ...attachmentScopes(combined.newRefs)],
    async (ctx) => {
      const current = await ctx.getMessage(messageId)
      if (!current || current.deleted) return
      if (JSON.stringify(current.content) !== originalContent) return
      const merged = mergeGeneratedImageAttachmentRefs(
        current.attachmentRefs,
        combined.newRefs,
        messageId,
        Date.now(),
      )
      const next: Message = {
        ...current,
        content: combined.content,
        attachmentRefs: merged.refs,
      }
      delete next.cachedMediaTokens
      await incRefs(ctx, merged.addedRefs)
      await ctx.putMessage(next, { touchChatSummary: false, broadcast: true })
    },
  )
  await localizeReferencedGeneratedOutputAttachments(
    { ...existing, content: combined.content },
    migrationContext,
  )
  await normalizeGeneratedImageOutputAttachmentRefs(messageId)
}

async function generatedOutputMigrationContext(message: Message): Promise<
  | {
      downloader: GeneratedOutputDownloader
      videoUrlResolver: GeneratedVideoUrlResolver
    }
  | undefined
> {
  const repo = getBrowserRepository()
  const chat = await repo.getChat(message.chatId)
  if (!chat?.settings.profileId) return undefined
  const profile = await getProfile(chat.settings.profileId)
  if (!profile) return undefined
  let apiKey: string | null = null
  if (profile.kind === 'openrouter') {
    try {
      apiKey = await resolveKeyIfPresent(profile.apiKeyRef)
    } catch {
      apiKey = null
    }
  }
  const headersFor = (url: string): Record<string, string> => {
    if (!apiKey || !shouldAuthorizeOpenRouterVideoUrl(url, profile.baseUrl)) return {}
    return { Authorization: `Bearer ${apiKey}` }
  }
  const downloader: GeneratedOutputDownloader = async ({ url }) => {
    const response = await fetch(url, { headers: headersFor(url) })
    if (!response.ok) return null
    return response.blob()
  }
  const videoUrlResolver: GeneratedVideoUrlResolver = async (url) => {
    if (!apiKey || !isOpenRouterVideoPollingUrl(url, profile.baseUrl)) return []
    const response = await fetch(url, { headers: headersFor(url) })
    if (!response.ok) return []
    const body = await response.json().catch(() => null)
    return videoContentUrlsFromJob(body)
  }
  return { downloader, videoUrlResolver }
}

async function expandLegacyVideoPollingOutputs(
  content: readonly ContentItem[],
  context:
    | {
        videoUrlResolver: GeneratedVideoUrlResolver
      }
    | undefined,
): Promise<{ content: ContentItem[]; changed: boolean }> {
  if (!context) return { content: structuredClone([...content]), changed: false }
  const next: ContentItem[] = []
  let changed = false
  for (const item of content) {
    if (item.type !== 'output_video') {
      next.push(structuredClone(item))
      continue
    }
    const sourceUrl = await sourceUrlForOutputVideo(item)
    if (!sourceUrl) {
      next.push(structuredClone(item))
      continue
    }
    const urls = await context.videoUrlResolver(sourceUrl)
    if (urls.length === 0) {
      next.push(structuredClone(item))
      continue
    }
    changed = true
    for (const url of urls) {
      const replacement: OutputVideoItem = { type: 'output_video', url }
      if (item.prompt) replacement.prompt = item.prompt
      next.push(replacement)
    }
  }
  return { content: next, changed }
}

async function sourceUrlForOutputVideo(item: OutputVideoItem): Promise<string | null> {
  if (typeof item.url === 'string' && item.url.length > 0) return item.url
  if (!item.attachmentId) return null
  const bundle = await getBrowserRepository().getAttachmentBundle(item.attachmentId)
  const attachment = bundle?.attachment
  if (!attachment || attachment.origin !== 'generated-output') return null
  if (attachment.storage.kind === 'remote-url') return attachment.storage.url
  return attachment.sourceUrl ?? null
}

async function localizeReferencedGeneratedOutputAttachments(
  message: Message,
  context:
    | {
        downloader: GeneratedOutputDownloader
        videoUrlResolver: GeneratedVideoUrlResolver
      }
    | undefined,
): Promise<void> {
  if (!context) return
  const repo = getBrowserRepository()
  const seen = new Set<string>()
  for (const item of message.content) {
    if (
      (item.type !== 'output_image' &&
        item.type !== 'audio_output' &&
        item.type !== 'output_video') ||
      !item.attachmentId ||
      seen.has(item.attachmentId)
    ) {
      continue
    }
    seen.add(item.attachmentId)
    const bundle = await repo.getAttachmentBundle(item.attachmentId)
    const attachment = bundle?.attachment
    if (!attachment || attachment.origin !== 'generated-output') continue
    if (attachment.storage.kind !== 'remote-url') continue
    const kind =
      item.type === 'output_image' ? 'image' : item.type === 'audio_output' ? 'audio' : 'video'
    const sourceUrl = attachment.storage.url
    if (kind === 'video') {
      const urls = await context.videoUrlResolver(sourceUrl)
      if (urls.length > 0) continue
    }
    const blob = await downloadGeneratedBlob(sourceUrl, kind, context.downloader)
    if (!blob) continue
    const mime =
      blob.type ||
      (kind === 'image'
        ? remoteImage(sourceUrl)?.mime
        : remoteMedia(sourceUrl, kind as 'audio' | 'video')?.mime) ||
      attachment.mime
    const filename =
      kind === 'image'
        ? replaceFilenameExtension(attachment.filename, extensionForMime(mime))
        : replaceFilenameExtension(attachment.filename, extensionForMediaMime(mime))
    await replaceAttachmentBytes({
      attachmentId: attachment.id,
      blob,
      filename,
      declaredMime: mime,
      origin: 'generated-output',
      sourceUrl,
      now: Date.now(),
    })
  }
}

export async function normalizeGeneratedImageOutputAttachmentRefs(
  messageId: MessageId,
): Promise<void> {
  const repo = getBrowserRepository()
  const existing = await repo.getMessage(messageId)
  const outputIds = existing
    ? generatedImageOutputAttachmentIds(existing.content)
    : new Set<string>()
  if (!existing || existing.deleted || outputIds.size === 0 || !existing.attachmentRefs) return
  const refs = normalizeAttachmentRefs(existing.attachmentRefs, {
    messageId,
    createdAt: existing.createdAt,
  })
  const attachments = await Promise.all(
    refs.map(
      async (ref) => [ref.attachmentId, await repo.getAttachment(ref.attachmentId)] as const,
    ),
  )
  const generatedIds = new Set<string>()
  for (const [attachmentId, attachment] of attachments) {
    if (attachment?.origin === 'generated-output') generatedIds.add(attachmentId)
  }
  if (generatedIds.size === 0) return

  const planned = pruneGeneratedImageRefs(refs, outputIds, generatedIds)
  if (planned.removed.length === 0) return
  await repo.runMutation(
    [{ kind: 'message', messageId }, ...attachmentScopes(planned.removed)],
    async (ctx) => {
      const current = await ctx.getMessage(messageId)
      if (!current || current.deleted || !current.attachmentRefs) return
      const currentOutputIds = generatedImageOutputAttachmentIds(current.content)
      if (currentOutputIds.size === 0) return
      const currentRefs = normalizeAttachmentRefs(current.attachmentRefs, {
        messageId,
        createdAt: current.createdAt,
      })
      const currentPlan = pruneGeneratedImageRefs(currentRefs, currentOutputIds, generatedIds)
      if (currentPlan.removed.length === 0) return
      const next: Message = {
        ...current,
        attachmentRefs: currentPlan.kept,
      }
      delete next.cachedMediaTokens
      await decRefs(ctx, currentPlan.removed)
      await ctx.putMessage(next, { touchChatSummary: false, broadcast: true })
    },
  )
  for (const attachmentId of new Set(planned.removed.map((ref) => ref.attachmentId))) {
    await deleteUnreferencedAttachment(attachmentId)
  }
}

export function mergeGeneratedImageAttachmentRefs(
  existingRefs: readonly AttachmentRef[] | undefined,
  newRefs: readonly MessageAttachmentRef[],
  messageId: MessageId,
  now = Date.now(),
): { refs: MessageAttachmentRef[]; addedRefs: MessageAttachmentRef[] } {
  const refs = normalizeAttachmentRefs(existingRefs, { messageId, createdAt: now })
  const existingIds = new Set(refs.map((ref) => ref.attachmentId))
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
  downloader?: GeneratedOutputDownloader
}): Promise<GeneratedImageReplacement | null> {
  const sourceUrl = input.item.url
  if (!sourceUrl) return null
  try {
    const attachment = await createGeneratedImageAttachment({
      id: generatedImageAttachmentId(input.messageId, input.index),
      sourceUrl,
      filenameStem: `generated-${input.messageId}-${input.index + 1}`,
      now: input.now,
      ...(input.downloader ? { downloader: input.downloader } : {}),
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
  downloader?: GeneratedOutputDownloader
}): Promise<GeneratedOutputReplacement | null> {
  const sourceUrl = input.item.url
  if (!sourceUrl) return null
  try {
    const attachment = await createGeneratedAudioAttachment({
      id: generatedMediaAttachmentId(input.messageId, 'audio', input.index),
      sourceUrl,
      filenameStem: `generated-${input.messageId}-audio-${input.index + 1}`,
      now: input.now,
      ...(input.downloader ? { downloader: input.downloader } : {}),
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
  downloader?: GeneratedOutputDownloader
}): Promise<GeneratedOutputReplacement | null> {
  const sourceUrl = input.item.url
  if (!sourceUrl) return null
  try {
    const attachment = await createGeneratedVideoAttachment({
      id: generatedMediaAttachmentId(input.messageId, 'video', input.index),
      sourceUrl,
      filenameStem: `generated-${input.messageId}-video-${input.index + 1}`,
      now: input.now,
      ...(input.downloader ? { downloader: input.downloader } : {}),
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

async function createGeneratedImageAttachment(input: {
  id: string
  sourceUrl: string
  filenameStem: string
  now: number
  downloader?: GeneratedOutputDownloader
}): Promise<Attachment> {
  const parsed = parseImagePayload(input.sourceUrl)
  if (parsed) {
    const buffer = new ArrayBuffer(parsed.bytes.byteLength)
    new Uint8Array(buffer).set(parsed.bytes)
    const bundle = await ingestAttachmentBytes({
      blob: new Blob([buffer], { type: parsed.mime }),
      filename: `${input.filenameStem}.${extensionForMime(parsed.mime)}`,
      declaredMime: parsed.mime,
      origin: 'generated-output',
      id: input.id,
      now: input.now,
    })
    return bundle.attachment
  }
  const remote = remoteImage(input.sourceUrl)
  if (!remote) throw new Error('UnsupportedGeneratedImageUrl')
  const downloaded = await downloadGeneratedBlob(input.sourceUrl, 'image', input.downloader)
  if (downloaded) {
    const mime = downloaded.type || remote.mime
    const bundle = await ingestAttachmentBytes({
      blob: downloaded,
      filename: `${input.filenameStem}.${extensionForMime(mime)}`,
      declaredMime: mime,
      origin: 'generated-output',
      sourceUrl: input.sourceUrl,
      id: input.id,
      now: input.now,
    })
    return bundle.attachment
  }
  return createRemoteAttachment({
    url: input.sourceUrl,
    filename: `${input.filenameStem}.${remote.extension}`,
    mime: remote.mime,
    kind: 'image',
    origin: 'generated-output',
    id: input.id,
    now: input.now,
  })
}

async function createGeneratedAudioAttachment(input: {
  id: string
  sourceUrl: string
  filenameStem: string
  now: number
  downloader?: GeneratedOutputDownloader
}): Promise<Attachment> {
  const parsed = parseMediaDataUrl(input.sourceUrl, 'audio/')
  if (parsed) {
    const buffer = new ArrayBuffer(parsed.bytes.byteLength)
    new Uint8Array(buffer).set(parsed.bytes)
    const bundle = await ingestAttachmentBytes({
      blob: new Blob([buffer], { type: parsed.mime }),
      filename: `${input.filenameStem}.${extensionForMediaMime(parsed.mime)}`,
      declaredMime: parsed.mime,
      origin: 'generated-output',
      id: input.id,
      now: input.now,
    })
    return bundle.attachment
  }
  const remote = remoteMedia(input.sourceUrl, 'audio')
  if (!remote) throw new Error('UnsupportedGeneratedAudioUrl')
  const downloaded = await downloadGeneratedBlob(input.sourceUrl, 'audio', input.downloader)
  if (downloaded) {
    const mime = downloaded.type || remote.mime
    const bundle = await ingestAttachmentBytes({
      blob: downloaded,
      filename: `${input.filenameStem}.${extensionForMediaMime(mime)}`,
      declaredMime: mime,
      origin: 'generated-output',
      sourceUrl: input.sourceUrl,
      id: input.id,
      now: input.now,
    })
    return bundle.attachment
  }
  return createRemoteAttachment({
    url: input.sourceUrl,
    filename: `${input.filenameStem}.${remote.extension}`,
    mime: remote.mime,
    kind: 'audio',
    origin: 'generated-output',
    id: input.id,
    now: input.now,
  })
}

async function createGeneratedVideoAttachment(input: {
  id: string
  sourceUrl: string
  filenameStem: string
  now: number
  downloader?: GeneratedOutputDownloader
}): Promise<Attachment> {
  const parsed = parseMediaDataUrl(input.sourceUrl, 'video/')
  if (parsed) {
    const buffer = new ArrayBuffer(parsed.bytes.byteLength)
    new Uint8Array(buffer).set(parsed.bytes)
    const bundle = await ingestAttachmentBytes({
      blob: new Blob([buffer], { type: parsed.mime }),
      filename: `${input.filenameStem}.${extensionForMediaMime(parsed.mime)}`,
      declaredMime: parsed.mime,
      origin: 'generated-output',
      id: input.id,
      now: input.now,
    })
    return bundle.attachment
  }
  const remote = remoteMedia(input.sourceUrl, 'video')
  if (!remote) throw new Error('UnsupportedGeneratedVideoUrl')
  const downloaded = await downloadGeneratedBlob(input.sourceUrl, 'video', input.downloader)
  if (downloaded) {
    const mime = downloaded.type || remote.mime
    const bundle = await ingestAttachmentBytes({
      blob: downloaded,
      filename: `${input.filenameStem}.${extensionForMediaMime(mime)}`,
      declaredMime: mime,
      origin: 'generated-output',
      sourceUrl: input.sourceUrl,
      id: input.id,
      now: input.now,
    })
    return bundle.attachment
  }
  return createRemoteAttachment({
    url: input.sourceUrl,
    filename: `${input.filenameStem}.${remote.extension}`,
    mime: remote.mime,
    kind: 'video',
    origin: 'generated-output',
    id: input.id,
    now: input.now,
  })
}

function generatedImageAttachmentId(messageId: MessageId, index: number): string {
  return `generated:${messageId}:${index + 1}`
}

function generatedMediaAttachmentId(
  messageId: MessageId,
  kind: 'audio' | 'video',
  index: number,
): string {
  return `generated:${messageId}:${kind}:${index + 1}`
}

function pruneGeneratedImageRefs(
  refs: readonly MessageAttachmentRef[],
  outputIds: ReadonlySet<string>,
  generatedIds: ReadonlySet<string>,
): { kept: MessageAttachmentRef[]; removed: MessageAttachmentRef[] } {
  const kept: MessageAttachmentRef[] = []
  const removed: MessageAttachmentRef[] = []
  const seenInlineGenerated = new Set<string>()
  for (const ref of refs) {
    if (!generatedIds.has(ref.attachmentId)) {
      kept.push(ref)
      continue
    }
    if (!outputIds.has(ref.attachmentId) || seenInlineGenerated.has(ref.attachmentId)) {
      removed.push(ref)
      continue
    }
    kept.push(ref)
    seenInlineGenerated.add(ref.attachmentId)
  }
  return { kept, removed }
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

async function downloadGeneratedBlob(
  url: string,
  kind: GeneratedOutputKind,
  downloader: GeneratedOutputDownloader | undefined,
): Promise<Blob | null> {
  if (!downloader) return null
  try {
    const blob = await downloader({ url, kind })
    return blob instanceof Blob ? blob : null
  } catch {
    return null
  }
}

function shouldAuthorizeOpenRouterVideoUrl(url: string, baseUrl: string): boolean {
  let target: URL
  let base: URL
  try {
    target = new URL(url)
    base = new URL(baseUrl)
  } catch {
    return false
  }
  if (target.origin !== base.origin) return false
  const basePath = base.pathname.replace(/\/+$/u, '')
  return target.pathname.startsWith(`${basePath}/videos/`)
}

function isOpenRouterVideoPollingUrl(url: string, baseUrl: string): boolean {
  if (!shouldAuthorizeOpenRouterVideoUrl(url, baseUrl)) return false
  try {
    const target = new URL(url)
    return /\/videos\/[^/]+\/?$/u.test(target.pathname)
  } catch {
    return false
  }
}

function videoContentUrlsFromJob(value: unknown): string[] {
  const root =
    value && typeof value === 'object' && 'data' in value
      ? (value as { data?: unknown }).data
      : value
  const out = new Set<string>()
  if (root && typeof root === 'object') {
    const record = root as {
      unsigned_urls?: unknown
      urls?: unknown
      output?: unknown
      data?: unknown
    }
    collectVideoContentUrls(out, record.unsigned_urls)
    collectVideoContentUrls(out, record.urls)
    collectVideoContentUrls(out, record.output)
    collectVideoContentUrls(out, record.data)
  }
  return [...out].filter((url) => !/\/videos\/[^/]+\/?$/u.test(safeUrlPathname(url)))
}

function collectVideoContentUrls(out: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    if (value.length > 0) out.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectVideoContentUrls(out, item)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as {
    url?: unknown
    content_url?: unknown
    video_url?: unknown
    unsigned_url?: unknown
    unsigned_urls?: unknown
  }
  collectVideoContentUrls(out, record.url)
  collectVideoContentUrls(out, record.content_url)
  collectVideoContentUrls(out, record.video_url)
  collectVideoContentUrls(out, record.unsigned_url)
  collectVideoContentUrls(out, record.unsigned_urls)
}

function safeUrlPathname(value: string): string {
  try {
    return new URL(value).pathname
  } catch {
    return ''
  }
}

function replaceFilenameExtension(filename: string, extension: string): string {
  const base = filename.replace(/\.[^.\\/]+$/u, '')
  return `${base}.${extension}`
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
