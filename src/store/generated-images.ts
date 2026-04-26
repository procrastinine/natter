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
} from './attachments'
import { getBrowserRepository } from './browser-repo'

type OutputImageItem = Extract<ContentItem, { type: 'output_image' }>

export interface GeneratedImageReplacement {
  sourceUrl: string
  item: OutputImageItem
  ref: MessageAttachmentRef
}

export interface GeneratedImageMaterialization {
  content: ContentItem[]
  replacements: GeneratedImageReplacement[]
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
  const ids = new Set<string>()
  for (const item of content) {
    if (item.type === 'output_image' && item.attachmentId) ids.add(item.attachmentId)
  }
  return ids
}

export async function materializeGeneratedImageOutputAttachments(input: {
  messageId: MessageId
  content: readonly ContentItem[]
  now?: number
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

export async function migrateGeneratedImageOutputAttachments(messageId: MessageId): Promise<void> {
  const repo = getBrowserRepository()
  const existing = await repo.getMessage(messageId)
  if (!existing || existing.deleted || !contentHasRawGeneratedImageOutput(existing.content)) return
  const materialized = await materializeGeneratedImageOutputAttachments({
    messageId,
    content: existing.content,
    now: Date.now(),
  })
  if (!materialized.changed) return
  await repo.runMutation(
    [{ kind: 'message', messageId }, ...attachmentScopes(materialized.newRefs)],
    async (ctx) => {
      const current = await ctx.getMessage(messageId)
      if (!current || current.deleted) return
      const replaced = applyGeneratedImageOutputReplacements(
        current.content,
        materialized.replacements,
      )
      if (!replaced.changed) return
      const merged = mergeGeneratedImageAttachmentRefs(
        current.attachmentRefs,
        replaced.used.map((replacement) => replacement.ref),
        messageId,
        Date.now(),
      )
      const next: Message = {
        ...current,
        content: replaced.content,
        attachmentRefs: merged.refs,
      }
      delete next.cachedMediaTokens
      await incRefs(ctx, merged.addedRefs)
      await ctx.putMessage(next, { touchChatSummary: false, broadcast: true })
    },
  )
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

function applyGeneratedImageOutputReplacements(
  content: readonly ContentItem[],
  replacements: readonly GeneratedImageReplacement[],
): { content: ContentItem[]; used: GeneratedImageReplacement[]; changed: boolean } {
  if (replacements.length === 0) {
    return { content: structuredClone([...content]), used: [], changed: false }
  }
  const remaining = replacements.slice()
  const used: GeneratedImageReplacement[] = []
  const next = content.map((item) => {
    if (
      item.type !== 'output_image' ||
      item.attachmentId ||
      typeof item.url !== 'string' ||
      item.url.length === 0
    ) {
      return structuredClone(item)
    }
    const index = remaining.findIndex((replacement) => replacement.sourceUrl === item.url)
    if (index < 0) return structuredClone(item)
    const [replacement] = remaining.splice(index, 1)
    used.push(replacement as GeneratedImageReplacement)
    return structuredClone((replacement as GeneratedImageReplacement).item)
  })
  return { content: next, used, changed: used.length > 0 }
}

async function materializeOneGeneratedImage(input: {
  messageId: MessageId
  item: OutputImageItem
  index: number
  now: number
}): Promise<GeneratedImageReplacement | null> {
  const sourceUrl = input.item.url
  if (!sourceUrl) return null
  try {
    const attachment = await createGeneratedImageAttachment({
      id: generatedImageAttachmentId(input.messageId, input.index),
      sourceUrl,
      filenameStem: `generated-${input.messageId}-${input.index + 1}`,
      now: input.now,
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

async function createGeneratedImageAttachment(input: {
  id: string
  sourceUrl: string
  filenameStem: string
  now: number
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

function generatedImageAttachmentId(messageId: MessageId, index: number): string {
  return `generated:${messageId}:${index + 1}`
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
