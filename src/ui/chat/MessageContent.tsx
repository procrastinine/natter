import { useMemo } from 'react'
import type { AttachmentBlob, AttachmentRef, ContentItem, MessageId } from '../../core/types'
import { liveAttachmentRefs } from '../../store/attachment-refs'
import type { MessageAttachmentRefMutation } from '../../store/attachments'
import { attachmentBundleDependencies } from '../../store/reactive-dependencies'
import { useRepositoryQuery } from '../../store/reactive-query'
import type { AttachmentBundle } from '../../store/repository'
import { getWorkspaceRepository } from '../../store/workspace-repository'
import { EyeIcon, EyeOffIcon } from '../icons/Icon'
import { Button } from '../primitives/Button'
import { MarkdownView } from './MarkdownView'
import type { MessageCollapseMode } from './MessageStreamOverflow'

interface MessageContentProps {
  content: ContentItem[]
  text: string
  textSegments?: readonly string[] | undefined
  streaming?: boolean
  collapseMode?: MessageCollapseMode
  messageId?: MessageId | undefined
  attachmentRefs?: readonly AttachmentRef[] | undefined
  onMutateAttachmentRef?:
    | ((mutation: MessageAttachmentRefMutation) => void | Promise<void>)
    | undefined
}

const COMPACT_PREVIEW_CHARS = 8_000
const PEEK_PREVIEW_CHARS = 160
const MAX_OUTPUT_OBJECT_URL_CACHE = 128

const outputObjectUrlCache = new Map<
  string,
  { url: string; contentHash: string; sizeBytes: number }
>()
const outputObjectUrlApi: Partial<Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>> = URL

export function messageTextSegmentsFromContent(content: readonly ContentItem[]): string[] {
  if (content.length === 1) {
    const only = content[0]
    return only && (only.type === 'text' || only.type === 'output_text') ? [only.text] : []
  }
  const segments: string[] = []
  for (const item of content) {
    if (item.type === 'text' || item.type === 'output_text') segments.push(item.text)
  }
  return segments
}

export function MessageContent({
  content,
  text,
  textSegments,
  streaming = false,
  collapseMode = 'full',
  messageId,
  attachmentRefs,
  onMutateAttachmentRef,
}: MessageContentProps) {
  const markdownSegments = textSegments && textSegments.length > 0 ? textSegments : undefined
  const textLength = markdownSegments
    ? markdownSegments.reduce((sum, segment) => sum + segment.length, 0)
    : text.length
  const images = useMemo(() => outputImagesFromContent(content), [content])
  const audios = useMemo(() => outputAudiosFromContent(content), [content])
  const videos = useMemo(() => outputVideosFromContent(content), [content])
  const mediaRefs = useMemo(() => liveAttachmentRefs(attachmentRefs), [attachmentRefs])
  const compactText = useMemo(
    () =>
      collapseMode === 'compact'
        ? markdownSegments
          ? previewSliceFromSegments(markdownSegments, COMPACT_PREVIEW_CHARS)
          : previewSlice(text, COMPACT_PREVIEW_CHARS)
        : '',
    [collapseMode, text, markdownSegments],
  )
  const peekText = useMemo(
    () =>
      collapseMode === 'peek'
        ? markdownSegments
          ? previewFirstLineFromSegments(
              markdownSegments,
              images.length + audios.length + videos.length,
            )
          : previewFirstLine(text, images.length + audios.length + videos.length)
        : '',
    [collapseMode, text, markdownSegments, images.length, audios.length, videos.length],
  )
  if (collapseMode === 'peek') {
    return (
      <div data-ui="message-body" data-role="text" data-overflow="peek">
        <p data-ui="message-body-peek">{peekText}</p>
      </div>
    )
  }
  if (collapseMode === 'compact') {
    return (
      <div data-ui="message-body" data-role="content" data-overflow="compact">
        {compactText.length > 0 ? (
          <MarkdownView content={compactText} streaming={streaming} />
        ) : null}
        <OutputImages
          images={images}
          messageId={messageId}
          attachmentRefs={mediaRefs}
          onMutateAttachmentRef={onMutateAttachmentRef}
        />
        <OutputAudios
          audios={audios}
          messageId={messageId}
          attachmentRefs={mediaRefs}
          onMutateAttachmentRef={onMutateAttachmentRef}
        />
        <OutputVideos
          videos={videos}
          messageId={messageId}
          attachmentRefs={mediaRefs}
          onMutateAttachmentRef={onMutateAttachmentRef}
        />
      </div>
    )
  }
  return (
    <div data-ui="message-body" data-role="content">
      {textLength > 0 ? (
        <MarkdownView content={text} contentSegments={markdownSegments} streaming={streaming} />
      ) : null}
      <OutputImages
        images={images}
        messageId={messageId}
        attachmentRefs={mediaRefs}
        onMutateAttachmentRef={onMutateAttachmentRef}
      />
      <OutputAudios
        audios={audios}
        messageId={messageId}
        attachmentRefs={mediaRefs}
        onMutateAttachmentRef={onMutateAttachmentRef}
      />
      <OutputVideos
        videos={videos}
        messageId={messageId}
        attachmentRefs={mediaRefs}
        onMutateAttachmentRef={onMutateAttachmentRef}
      />
    </div>
  )
}

function previewSliceFromSegments(segments: readonly string[], maxChars: number): string {
  let out = ''
  for (const segment of segments) {
    if (out.length >= maxChars) break
    out += segment.slice(0, maxChars - out.length)
  }
  return previewSlice(out, maxChars)
}

function previewFirstLineFromSegments(segments: readonly string[], mediaCount: number): string {
  let out = ''
  for (const segment of segments) {
    const newline = segment.indexOf('\n')
    if (newline >= 0) {
      out += segment.slice(0, newline)
      break
    }
    out += segment
    if (out.length > PEEK_PREVIEW_CHARS) break
  }
  return previewFirstLine(out, mediaCount)
}

function previewSlice(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const boundary = text.lastIndexOf(' ', maxChars)
  const safeEnd = boundary >= Math.floor(maxChars * 0.6) ? boundary : maxChars
  return `${text.slice(0, safeEnd).trimEnd()}\n\n...`
}

function outputImagesFromContent(content: readonly ContentItem[]) {
  return content.filter(
    (item): item is Extract<ContentItem, { type: 'output_image' }> =>
      item.type === 'output_image' &&
      ((typeof item.url === 'string' && item.url.length > 0) || Boolean(item.attachmentId)),
  )
}

function outputAudiosFromContent(content: readonly ContentItem[]) {
  return content.filter(
    (item): item is Extract<ContentItem, { type: 'audio_output' }> =>
      item.type === 'audio_output' &&
      ((typeof item.url === 'string' && item.url.length > 0) || Boolean(item.attachmentId)),
  )
}

function outputVideosFromContent(content: readonly ContentItem[]) {
  return content.filter(
    (item): item is Extract<ContentItem, { type: 'output_video' }> =>
      item.type === 'output_video' &&
      ((typeof item.url === 'string' && item.url.length > 0) || Boolean(item.attachmentId)),
  )
}

function OutputImages({
  images,
  messageId,
  attachmentRefs,
  onMutateAttachmentRef,
}: {
  images: Array<Extract<ContentItem, { type: 'output_image' }>>
  messageId?: MessageId | undefined
  attachmentRefs: ReturnType<typeof liveAttachmentRefs>
  onMutateAttachmentRef?:
    | ((mutation: MessageAttachmentRefMutation) => void | Promise<void>)
    | undefined
}) {
  if (images.length === 0) return null
  return (
    <div data-ui="message-output-images">
      {images.map((image, index) => {
        const ref = image.attachmentId
          ? attachmentRefs.find((candidate) => candidate.attachmentId === image.attachmentId)
          : undefined
        return (
          <OutputImage
            key={image.attachmentId ?? image.url}
            image={image}
            index={index}
            messageId={messageId}
            attachmentRef={ref}
            onMutateAttachmentRef={onMutateAttachmentRef}
          />
        )
      })}
    </div>
  )
}

function OutputAudios({
  audios,
  messageId,
  attachmentRefs,
  onMutateAttachmentRef,
}: {
  audios: Array<Extract<ContentItem, { type: 'audio_output' }>>
  messageId?: MessageId | undefined
  attachmentRefs: ReturnType<typeof liveAttachmentRefs>
  onMutateAttachmentRef?:
    | ((mutation: MessageAttachmentRefMutation) => void | Promise<void>)
    | undefined
}) {
  if (audios.length === 0) return null
  return (
    <div data-ui="message-output-media-list" data-media="audio">
      {audios.map((audio, index) => {
        const ref = audio.attachmentId
          ? attachmentRefs.find((candidate) => candidate.attachmentId === audio.attachmentId)
          : undefined
        return (
          <OutputAudio
            key={audio.attachmentId ?? audio.url}
            audio={audio}
            index={index}
            messageId={messageId}
            attachmentRef={ref}
            onMutateAttachmentRef={onMutateAttachmentRef}
          />
        )
      })}
    </div>
  )
}

function OutputVideos({
  videos,
  messageId,
  attachmentRefs,
  onMutateAttachmentRef,
}: {
  videos: Array<Extract<ContentItem, { type: 'output_video' }>>
  messageId?: MessageId | undefined
  attachmentRefs: ReturnType<typeof liveAttachmentRefs>
  onMutateAttachmentRef?:
    | ((mutation: MessageAttachmentRefMutation) => void | Promise<void>)
    | undefined
}) {
  if (videos.length === 0) return null
  return (
    <div data-ui="message-output-media-list" data-media="video">
      {videos.map((video, index) => {
        const ref = video.attachmentId
          ? attachmentRefs.find((candidate) => candidate.attachmentId === video.attachmentId)
          : undefined
        return (
          <OutputVideo
            key={video.attachmentId ?? video.url}
            video={video}
            index={index}
            messageId={messageId}
            attachmentRef={ref}
            onMutateAttachmentRef={onMutateAttachmentRef}
          />
        )
      })}
    </div>
  )
}

function OutputImage({
  image,
  index,
  messageId,
  attachmentRef,
  onMutateAttachmentRef,
}: {
  image: Extract<ContentItem, { type: 'output_image' }>
  index: number
  messageId?: MessageId | undefined
  attachmentRef?: ReturnType<typeof liveAttachmentRefs>[number] | undefined
  onMutateAttachmentRef?:
    | ((mutation: MessageAttachmentRefMutation) => void | Promise<void>)
    | undefined
}) {
  const bundle = useRepositoryQuery(
    JSON.stringify(['attachment-bundle', image.attachmentId ?? null]),
    async () => {
      if (!image.attachmentId) return undefined
      return getWorkspaceRepository().getAttachmentBundle(image.attachmentId)
    },
    undefined,
    attachmentBundleDependencies(image.attachmentId),
  )
  const blob = useMemo(() => selectOutputImageBlob(bundle), [bundle])
  const objectUrl = useMemo(() => objectUrlForOutputBlob(blob), [blob])

  const remoteUrl = remoteAttachmentUrl(bundle)
  const src = objectUrl ?? remoteUrl ?? image.url
  const alt = image.prompt ?? bundle?.attachment.filename ?? `Generated image ${index + 1}`
  return (
    <figure
      data-ui="message-output-image"
      data-context={attachmentRef?.includeInContext === false ? 'excluded' : 'included'}
      data-has-context-toggle={messageId && attachmentRef ? 'true' : undefined}
    >
      {src ? <img src={src} alt={alt} /> : <span data-ui="message-output-image-missing" />}
      {messageId && attachmentRef ? (
        <OutputMediaContextToggle
          attachmentRef={attachmentRef}
          noun="image"
          onMutateAttachmentRef={onMutateAttachmentRef}
        />
      ) : null}
    </figure>
  )
}

function OutputAudio({
  audio,
  messageId,
  attachmentRef,
  onMutateAttachmentRef,
}: {
  audio: Extract<ContentItem, { type: 'audio_output' }>
  index: number
  messageId?: MessageId | undefined
  attachmentRef?: ReturnType<typeof liveAttachmentRefs>[number] | undefined
  onMutateAttachmentRef?:
    | ((mutation: MessageAttachmentRefMutation) => void | Promise<void>)
    | undefined
}) {
  const bundle = useRepositoryQuery(
    JSON.stringify(['attachment-bundle', audio.attachmentId ?? null]),
    async () => {
      if (!audio.attachmentId) return undefined
      return getWorkspaceRepository().getAttachmentBundle(audio.attachmentId)
    },
    undefined,
    attachmentBundleDependencies(audio.attachmentId),
  )
  const blob = useMemo(() => selectOutputImageBlob(bundle), [bundle])
  const objectUrl = useMemo(() => objectUrlForOutputBlob(blob), [blob])

  const src = objectUrl ?? remoteAttachmentUrl(bundle) ?? audio.url
  return (
    <figure
      data-ui="message-output-media"
      data-media="audio"
      data-context={attachmentRef?.includeInContext === false ? 'excluded' : 'included'}
      data-has-context-toggle={messageId && attachmentRef ? 'true' : undefined}
    >
      {src ? (
        // biome-ignore lint/a11y/useMediaCaption: audio-output captions arrive as transcript text, not a timed VTT track.
        <audio controls src={src} preload={objectUrl ? 'metadata' : 'none'} />
      ) : null}
      {audio.transcript ? <figcaption>{audio.transcript}</figcaption> : null}
      {messageId && attachmentRef ? (
        <OutputMediaContextToggle
          attachmentRef={attachmentRef}
          noun="audio"
          onMutateAttachmentRef={onMutateAttachmentRef}
        />
      ) : null}
    </figure>
  )
}

function OutputVideo({
  video,
  index,
  messageId,
  attachmentRef,
  onMutateAttachmentRef,
}: {
  video: Extract<ContentItem, { type: 'output_video' }>
  index: number
  messageId?: MessageId | undefined
  attachmentRef?: ReturnType<typeof liveAttachmentRefs>[number] | undefined
  onMutateAttachmentRef?:
    | ((mutation: MessageAttachmentRefMutation) => void | Promise<void>)
    | undefined
}) {
  const bundle = useRepositoryQuery(
    JSON.stringify(['attachment-bundle', video.attachmentId ?? null]),
    async () => {
      if (!video.attachmentId) return undefined
      return getWorkspaceRepository().getAttachmentBundle(video.attachmentId)
    },
    undefined,
    attachmentBundleDependencies(video.attachmentId),
  )
  const blob = useMemo(() => selectOutputImageBlob(bundle), [bundle])
  const objectUrl = useMemo(() => objectUrlForOutputBlob(blob), [blob])

  const src = objectUrl ?? remoteAttachmentUrl(bundle) ?? video.url
  const title = video.prompt ?? bundle?.attachment.filename ?? `Generated video ${index + 1}`
  return (
    <figure
      data-ui="message-output-media"
      data-media="video"
      data-context={attachmentRef?.includeInContext === false ? 'excluded' : 'included'}
      data-has-context-toggle={messageId && attachmentRef ? 'true' : undefined}
    >
      {src ? (
        // biome-ignore lint/a11y/useMediaCaption: generated video jobs do not return timed caption tracks.
        <video controls src={src} title={title} preload={objectUrl ? 'auto' : 'none'} />
      ) : null}
      {messageId && attachmentRef ? (
        <OutputMediaContextToggle
          attachmentRef={attachmentRef}
          noun="video"
          onMutateAttachmentRef={onMutateAttachmentRef}
        />
      ) : null}
    </figure>
  )
}

function OutputMediaContextToggle({
  attachmentRef,
  noun,
  onMutateAttachmentRef,
}: {
  attachmentRef: ReturnType<typeof liveAttachmentRefs>[number]
  noun: 'image' | 'audio' | 'video'
  onMutateAttachmentRef?:
    | ((mutation: MessageAttachmentRefMutation) => void | Promise<void>)
    | undefined
}) {
  return (
    <Button
      type="button"
      data-ui="message-output-image-context-toggle"
      aria-pressed={attachmentRef.includeInContext}
      aria-label={
        attachmentRef.includeInContext
          ? `Hide generated ${noun} from context`
          : `Include generated ${noun} in context`
      }
      title={
        attachmentRef.includeInContext
          ? `Hide this generated ${noun} from future context`
          : `Include this generated ${noun} in future context`
      }
      onClick={() =>
        void onMutateAttachmentRef?.({
          kind: 'visibility',
          refId: attachmentRef.refId,
          includeInContext: !attachmentRef.includeInContext,
        })
      }
      disabled={onMutateAttachmentRef === undefined}
    >
      {attachmentRef.includeInContext ? <EyeIcon size={14} /> : <EyeOffIcon size={14} />}
    </Button>
  )
}

function selectOutputImageBlob(bundle: AttachmentBundle | undefined): AttachmentBlob | undefined {
  return (
    bundle?.blobs.find((blob) => blob.role === 'original') ??
    bundle?.blobs.find((blob) => blob.role === 'normalized') ??
    bundle?.blobs[0]
  )
}

function objectUrlForOutputBlob(blob: AttachmentBlob | undefined): string | undefined {
  if (
    !blob ||
    !(blob.blob instanceof Blob) ||
    typeof outputObjectUrlApi.createObjectURL !== 'function'
  ) {
    return undefined
  }
  const cached = outputObjectUrlCache.get(blob.id)
  if (cached && cached.contentHash === blob.contentHash && cached.sizeBytes === blob.sizeBytes) {
    return cached.url
  }
  if (cached) outputObjectUrlApi.revokeObjectURL?.(cached.url)
  const url = outputObjectUrlApi.createObjectURL(blob.blob)
  outputObjectUrlCache.set(blob.id, {
    url,
    contentHash: blob.contentHash,
    sizeBytes: blob.sizeBytes,
  })
  trimOutputObjectUrlCache()
  return url
}

function trimOutputObjectUrlCache(): void {
  while (outputObjectUrlCache.size > MAX_OUTPUT_OBJECT_URL_CACHE) {
    const oldestKey = outputObjectUrlCache.keys().next().value
    if (!oldestKey) return
    const oldest = outputObjectUrlCache.get(oldestKey)
    if (oldest) outputObjectUrlApi.revokeObjectURL?.(oldest.url)
    outputObjectUrlCache.delete(oldestKey)
  }
}

function remoteAttachmentUrl(bundle: AttachmentBundle | undefined): string | undefined {
  const attachment = bundle?.attachment
  if (!attachment) return undefined
  if (attachment.storage.kind === 'remote-url') return attachment.storage.url
  return undefined
}

function previewFirstLine(text: string, mediaCount: number): string {
  const firstNonEmpty =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? text.trim()
  if (firstNonEmpty.length === 0) {
    return mediaCount > 0 ? `Generated media ...` : '...'
  }
  const singleLine = firstNonEmpty.replace(/\s+/g, ' ')
  if (singleLine.length <= PEEK_PREVIEW_CHARS) {
    return `${singleLine} ...`
  }
  return `${singleLine.slice(0, PEEK_PREVIEW_CHARS - 3).trimEnd()}...`
}
