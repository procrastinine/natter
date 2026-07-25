import type {
  Attachment,
  AttachmentJob,
  AttachmentRef,
  ContentItem,
  KeyId,
  ProfileId,
} from './types'

export const GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID = 'generated-output-localization-v1'

export type GeneratedOutputKind = 'image' | 'audio' | 'video' | 'file'

export interface GeneratedVideoJobSnapshot {
  status: string
  urls: readonly string[]
  failureMessage?: string
}

const GENERATED_VIDEO_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  failed: 'Video generation failed.',
  cancelled: 'Video generation was cancelled.',
  canceled: 'Video generation was canceled.',
  expired: 'Video generation expired.',
}

export function contentHasUnmaterializedGeneratedOutput(content: readonly ContentItem[]): boolean {
  return content.some(
    (item) =>
      (item.type === 'output_image' ||
        item.type === 'audio_output' ||
        item.type === 'output_video' ||
        item.type === 'file') &&
      !item.attachmentId &&
      typeof item.url === 'string' &&
      item.url.length > 0,
  )
}

export function withoutUnmaterializedGeneratedOutput(
  content: readonly ContentItem[],
): ContentItem[] {
  return content
    .filter(
      (item) =>
        !(
          (item.type === 'output_image' ||
            item.type === 'audio_output' ||
            item.type === 'output_video' ||
            item.type === 'file') &&
          !item.attachmentId &&
          typeof item.url === 'string' &&
          item.url.length > 0
        ),
    )
    .map((item) => structuredClone(item))
}

function assertCanonicalGeneratedOutputContent(
  content: readonly ContentItem[],
  ownerId: string,
): void {
  if (contentHasUnmaterializedGeneratedOutput(content)) {
    throw new Error(`GeneratedOutputContentNotCanonical:${ownerId}`)
  }
}

export function generatedOutputContentAttachmentIds(content: readonly ContentItem[]): Set<string> {
  const ids = new Set<string>()
  for (const item of content) {
    if (
      (item.type === 'output_image' ||
        item.type === 'audio_output' ||
        item.type === 'output_video' ||
        item.type === 'file') &&
      item.attachmentId
    ) {
      ids.add(item.attachmentId)
    }
  }
  return ids
}

export function assertCanonicalGeneratedOutputMessage(
  content: readonly ContentItem[],
  attachmentRefs: readonly AttachmentRef[] | undefined,
  ownerId: string,
): void {
  assertCanonicalGeneratedOutputContent(content, ownerId)
  const requiredIds = generatedOutputContentAttachmentIds(content)
  if (requiredIds.size === 0) return
  for (const ref of attachmentRefs ?? []) {
    if (ref.deletedAt === undefined) requiredIds.delete(ref.attachmentId)
  }
  if (requiredIds.size > 0) {
    throw new Error(`GeneratedOutputAttachmentRefMissing:${ownerId}:${[...requiredIds][0]}`)
  }
}

export function generatedOutputLocalizationJob(
  attachment: Pick<Attachment, 'id' | 'storage'>,
  now: number,
  requestCredential?: { profileId: ProfileId; selectedKeyId: KeyId },
): AttachmentJob | undefined {
  if (attachment.storage.kind !== 'remote-url') return undefined
  const expectedSourceUrl = attachment.storage.url
  const inputHashSource = requestCredential
    ? `${expectedSourceUrl}\u0000${requestCredential.profileId}\u0000${requestCredential.selectedKeyId}`
    : expectedSourceUrl
  return {
    id: `${attachment.id}:${GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID}`,
    attachmentId: attachment.id,
    processorId: GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID,
    inputHash: fingerprint(inputHashSource),
    status: 'pending',
    outputArtifactIds: [],
    task: {
      kind: GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID,
      expectedSourceUrl,
      ...(requestCredential ? { requestCredential: { ...requestCredential } } : {}),
    },
    attemptCount: 0,
    nextAttemptAt: now,
    updatedAt: now,
  }
}

export function withGeneratedOutputLocalizationJob<
  Bundle extends {
    attachment: Attachment
    jobs: readonly AttachmentJob[]
  },
>(
  bundle: Bundle,
  now: number,
  requestCredential?: { profileId: ProfileId; selectedKeyId: KeyId },
): Bundle {
  const job = generatedOutputLocalizationJob(bundle.attachment, now, requestCredential)
  if (!job) return bundle
  return {
    ...bundle,
    attachment: {
      ...bundle.attachment,
      processing: withGeneratedOutputLocalizationState(bundle.attachment.processing, job),
    },
    jobs: [...bundle.jobs, job],
  }
}

export function localizedGeneratedOutputFilename(
  filename: string,
  mime: string,
  kind: GeneratedOutputKind,
): string {
  if (kind === 'file') return filename
  const base = filename.replace(/\.[^.\\/]+$/u, '')
  return `${base}.${generatedOutputExtension(mime, kind)}`
}

export function generatedVideoJobSnapshot(value: unknown): GeneratedVideoJobSnapshot {
  const job = generatedVideoJobRecord(value)
  const status = typeof job.status === 'string' ? job.status : 'pending'
  const failureMessage = GENERATED_VIDEO_FAILURE_MESSAGES[status]
  return {
    status,
    urls: generatedVideoContentUrls(job),
    ...(failureMessage
      ? { failureMessage: generatedVideoErrorMessage(job.error) ?? failureMessage }
      : {}),
  }
}

export function isGeneratedOutputLocalizationJob(
  job: AttachmentJob | undefined,
): job is AttachmentJob & {
  task: {
    kind: 'generated-output-localization-v1'
    expectedSourceUrl: string
    requestCredential?: { profileId: ProfileId; selectedKeyId: KeyId }
  }
  attemptCount: number
} {
  const requestCredential = job?.task?.requestCredential
  const attemptCount = job?.attemptCount
  return (
    job?.processorId === GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID &&
    job.task?.kind === GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID &&
    typeof job.task.expectedSourceUrl === 'string' &&
    (requestCredential === undefined ||
      (typeof requestCredential.profileId === 'string' &&
        typeof requestCredential.selectedKeyId === 'string')) &&
    typeof attemptCount === 'number' &&
    Number.isSafeInteger(attemptCount) &&
    attemptCount >= 0 &&
    (job.status !== 'pending' || Number.isFinite(job.nextAttemptAt))
  )
}

function generatedOutputLocalizationProcessingState(
  job: AttachmentJob,
): Attachment['processing'][number] {
  return {
    processorId: job.processorId,
    inputHash: job.inputHash,
    status: job.status,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.error === undefined ? {} : { error: { ...job.error } }),
    outputArtifactIds: [...job.outputArtifactIds],
  }
}

export function withGeneratedOutputLocalizationState(
  processing: ReadonlyArray<Attachment['processing'][number]>,
  job: AttachmentJob,
): Attachment['processing'] {
  return [
    ...processing.filter(
      (state) => state.processorId !== GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID,
    ),
    generatedOutputLocalizationProcessingState(job),
  ]
}

function generatedOutputExtension(
  mime: string,
  kind: Exclude<GeneratedOutputKind, 'file'>,
): string {
  if (kind === 'image') {
    if (mime === 'image/jpeg') return 'jpg'
    if (mime === 'image/webp') return 'webp'
    if (mime === 'image/gif') return 'gif'
    if (mime === 'image/bmp') return 'bmp'
    if (mime === 'image/svg+xml') return 'svg'
    return 'png'
  }
  if (mime === 'audio/mpeg') return 'mp3'
  if (mime === 'audio/flac') return 'flac'
  if (mime === 'audio/ogg') return 'ogg'
  if (mime === 'audio/mp4') return 'm4a'
  if (mime === 'video/webm') return 'webm'
  if (mime === 'video/quicktime') return 'mov'
  if (mime === 'video/mp4' || mime.startsWith('video/')) return 'mp4'
  return 'wav'
}

function generatedVideoJobRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  return typeof value.status !== 'string' && isRecord(value.data) ? value.data : value
}

function generatedVideoContentUrls(job: Record<string, unknown>): string[] {
  const out = new Set<string>()
  collectGeneratedVideoUrls(out, job.unsigned_urls)
  collectGeneratedVideoUrls(out, job.urls)
  collectGeneratedVideoUrls(out, job.output)
  collectGeneratedVideoUrls(out, job.data)
  return [...out].filter((url) => !isGeneratedVideoPollingUrl(url))
}

function collectGeneratedVideoUrls(out: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    if (value.length > 0) out.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectGeneratedVideoUrls(out, item)
    return
  }
  if (!isRecord(value)) return
  collectGeneratedVideoUrls(out, value.url)
  collectGeneratedVideoUrls(out, value.content_url)
  collectGeneratedVideoUrls(out, value.video_url)
  collectGeneratedVideoUrls(out, value.unsigned_url)
  collectGeneratedVideoUrls(out, value.unsigned_urls)
}

function generatedVideoErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error
  if (!isRecord(error)) return undefined
  return typeof error.message === 'string' ? error.message : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function profileAuthorizesGeneratedVideoUrl(url: string, baseUrl: string): boolean {
  try {
    const target = new URL(url)
    const base = new URL(baseUrl)
    const basePath = base.pathname.replace(/\/+$/u, '')
    return target.origin === base.origin && target.pathname.startsWith(`${basePath}/videos/`)
  } catch {
    return false
  }
}

export function isGeneratedVideoPollingUrl(url: string): boolean {
  try {
    return /\/videos\/[^/]+\/?$/u.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}
