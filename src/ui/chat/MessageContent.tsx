import { useMemo } from 'react'
import {
  attachmentMutationInteraction,
  attachmentMutationTarget,
} from '../../app/presentation-interactions'
import { liveAttachmentRefs } from '../../core/attachment-refs'
import {
  type CitationDisplayTarget,
  planCitationDisplay,
  safeCitationUrl,
} from '../../core/content-annotations'
import type { AttachmentRef, ContentItem, MessageId } from '../../core/types'
import { usePresentationInteraction } from '../../hooks/usePresentationInteraction'
import type {
  AttachmentMediaProjection,
  MessageAttachmentRefMutation,
} from '../../store/presentation-contracts'
import { useAttachmentMedia } from '../attachments/useAttachmentMedia'
import { useAttachmentObjectUrl } from '../attachments/useAttachmentObjectUrl'
import { EyeIcon, EyeOffIcon } from '../icons/Icon'
import { Button } from '../primitives/Button'
import { MarkdownView } from './MarkdownView'
import type { MessageCollapseMode } from './MessageStreamOverflow'

interface MessageContentProps {
  content: readonly ContentItem[]
  text: string
  textSegments?: readonly string[] | undefined
  streaming?: boolean
  renderRevision?: string | number | undefined
  collapseMode?: MessageCollapseMode
  messageId?: MessageId | undefined
  attachmentRefs?: readonly AttachmentRef[] | undefined
  onMutateAttachmentRef?: MessageAttachmentMutationAction | undefined
}

type MessageAttachmentMutationAction = (
  mutation: MessageAttachmentRefMutation,
) => void | Promise<void>

const COMPACT_PREVIEW_CHARS = 8_000
const PEEK_PREVIEW_CHARS = 160

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
  renderRevision,
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
  const files = useMemo(() => outputFilesFromContent(content), [content])
  const mediaRefs = useMemo(() => liveAttachmentRefs(attachmentRefs), [attachmentRefs])
  const mediaRefByAttachmentId = useMemo(
    () => new Map(mediaRefs.map((ref) => [ref.attachmentId, ref])),
    [mediaRefs],
  )
  const compactText = useMemo(
    () =>
      collapseMode === 'compact'
        ? markdownSegments
          ? previewSliceFromSegments(markdownSegments, COMPACT_PREVIEW_CHARS)
          : previewSlice(text, COMPACT_PREVIEW_CHARS)
        : '',
    [collapseMode, text, markdownSegments],
  )
  const hasRenderableCitations = useMemo(
    () =>
      content.some(
        (item) =>
          item.type === 'output_text' &&
          item.annotations?.some(
            (annotation) =>
              annotation.type === 'file_citation' ||
              (annotation.type === 'url_citation' && safeCitationUrl(annotation.url)),
          ),
      ),
    [content],
  )
  const fullCitationProjection = useMemo(
    () =>
      collapseMode === 'full' && hasRenderableCitations
        ? citationProjectionFromContent(content)
        : EMPTY_CITATION_PROJECTION,
    [collapseMode, content, hasRenderableCitations],
  )
  const compactCitationProjection = useMemo(() => {
    if (collapseMode !== 'compact' || !hasRenderableCitations) return undefined
    const truncated = compactText.endsWith('\n\n...')
    const rawLength = compactText.length - (truncated ? '\n\n...'.length : 0)
    const projection = citationProjectionFromContent(content, rawLength)
    return {
      ...projection,
      markdown: `${projection.markdown}${truncated ? '\n\n...' : ''}`,
    }
  }, [collapseMode, compactText, content, hasRenderableCitations])
  const peekText = useMemo(
    () =>
      collapseMode === 'peek'
        ? markdownSegments
          ? previewFirstLineFromSegments(
              markdownSegments,
              images.length + audios.length + videos.length + files.length,
            )
          : previewFirstLine(text, images.length + audios.length + videos.length + files.length)
        : '',
    [
      collapseMode,
      text,
      markdownSegments,
      images.length,
      audios.length,
      videos.length,
      files.length,
    ],
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
          <MarkdownView
            content={compactCitationProjection?.markdown ?? compactText}
            streaming={streaming}
            renderRevision={renderRevision}
            {...(compactCitationProjection
              ? { citationTargets: compactCitationProjection.targets }
              : {})}
          />
        ) : null}
        <OutputImages
          images={images}
          messageId={messageId}
          attachmentRefs={mediaRefByAttachmentId}
          onMutateAttachmentRef={onMutateAttachmentRef}
        />
        <OutputAudios
          audios={audios}
          messageId={messageId}
          attachmentRefs={mediaRefByAttachmentId}
          onMutateAttachmentRef={onMutateAttachmentRef}
        />
        <OutputVideos
          videos={videos}
          messageId={messageId}
          attachmentRefs={mediaRefByAttachmentId}
          onMutateAttachmentRef={onMutateAttachmentRef}
        />
        <OutputFiles
          files={files}
          messageId={messageId}
          attachmentRefs={mediaRefByAttachmentId}
          onMutateAttachmentRef={onMutateAttachmentRef}
        />
      </div>
    )
  }
  return (
    <div data-ui="message-body" data-role="content">
      {textLength > 0 ? (
        <MarkdownView
          content={
            fullCitationProjection.targets.length > 0 ? fullCitationProjection.markdown : text
          }
          contentSegments={
            fullCitationProjection.targets.length > 0
              ? fullCitationProjection.segments
              : markdownSegments
          }
          streaming={streaming}
          renderRevision={renderRevision}
          citationTargets={fullCitationProjection.targets}
        />
      ) : null}
      <OutputImages
        images={images}
        messageId={messageId}
        attachmentRefs={mediaRefByAttachmentId}
        onMutateAttachmentRef={onMutateAttachmentRef}
      />
      <OutputAudios
        audios={audios}
        messageId={messageId}
        attachmentRefs={mediaRefByAttachmentId}
        onMutateAttachmentRef={onMutateAttachmentRef}
      />
      <OutputVideos
        videos={videos}
        messageId={messageId}
        attachmentRefs={mediaRefByAttachmentId}
        onMutateAttachmentRef={onMutateAttachmentRef}
      />
      <OutputFiles
        files={files}
        messageId={messageId}
        attachmentRefs={mediaRefByAttachmentId}
        onMutateAttachmentRef={onMutateAttachmentRef}
      />
    </div>
  )
}

interface CitationMarkdownProjection {
  readonly markdown: string
  readonly segments: readonly string[]
  readonly targets: readonly CitationDisplayTarget[]
}

const EMPTY_CITATION_PROJECTION: CitationMarkdownProjection = Object.freeze({
  markdown: '',
  segments: Object.freeze([]),
  targets: Object.freeze([]),
})

function citationProjectionFromContent(
  content: readonly ContentItem[],
  maxRawChars = Number.POSITIVE_INFINITY,
): CitationMarkdownProjection {
  const segments: string[] = []
  const targets: CitationDisplayTarget[] = []
  let remaining = maxRawChars
  for (const [index, item] of content.entries()) {
    if (item.type !== 'text' && item.type !== 'output_text') continue
    if (remaining <= 0) break
    const text = item.text.slice(0, remaining)
    const annotations =
      item.type === 'output_text'
        ? item.annotations?.filter((annotation) => annotation.endIndex <= text.length)
        : undefined
    const plan = planCitationDisplay(text, annotations, `m${index}`, targets.length)
    segments.push(plan.markdown)
    targets.push(...plan.targets)
    remaining -= text.length
  }
  return { markdown: segments.join(''), segments, targets }
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
      item.type === 'output_image' && Boolean(item.attachmentId),
  )
}

function outputAudiosFromContent(content: readonly ContentItem[]) {
  return content.filter(
    (item): item is Extract<ContentItem, { type: 'audio_output' }> =>
      item.type === 'audio_output' && Boolean(item.attachmentId),
  )
}

function outputVideosFromContent(content: readonly ContentItem[]) {
  return content.filter(
    (item): item is Extract<ContentItem, { type: 'output_video' }> =>
      item.type === 'output_video' && Boolean(item.attachmentId),
  )
}

function outputFilesFromContent(content: readonly ContentItem[]) {
  return content.filter(
    (item): item is Extract<ContentItem, { type: 'file' }> =>
      item.type === 'file' && Boolean(item.attachmentId),
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
  attachmentRefs: ReadonlyMap<string, ReturnType<typeof liveAttachmentRefs>[number]>
  onMutateAttachmentRef?: MessageAttachmentMutationAction | undefined
}) {
  if (images.length === 0) return null
  return (
    <div data-ui="message-output-images">
      {images.map((image, index) => {
        const ref = image.attachmentId ? attachmentRefs.get(image.attachmentId) : undefined
        return (
          <OutputImage
            key={image.attachmentId}
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
  attachmentRefs: ReadonlyMap<string, ReturnType<typeof liveAttachmentRefs>[number]>
  onMutateAttachmentRef?: MessageAttachmentMutationAction | undefined
}) {
  if (audios.length === 0) return null
  return (
    <div data-ui="message-output-media-list" data-media="audio">
      {audios.map((audio, index) => {
        const ref = audio.attachmentId ? attachmentRefs.get(audio.attachmentId) : undefined
        return (
          <OutputAudio
            key={audio.attachmentId}
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
  attachmentRefs: ReadonlyMap<string, ReturnType<typeof liveAttachmentRefs>[number]>
  onMutateAttachmentRef?: MessageAttachmentMutationAction | undefined
}) {
  if (videos.length === 0) return null
  return (
    <div data-ui="message-output-media-list" data-media="video">
      {videos.map((video, index) => {
        const ref = video.attachmentId ? attachmentRefs.get(video.attachmentId) : undefined
        return (
          <OutputVideo
            key={video.attachmentId}
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

function OutputFiles({
  files,
  messageId,
  attachmentRefs,
  onMutateAttachmentRef,
}: {
  files: Array<Extract<ContentItem, { type: 'file' }>>
  messageId?: MessageId | undefined
  attachmentRefs: ReadonlyMap<string, ReturnType<typeof liveAttachmentRefs>[number]>
  onMutateAttachmentRef?: MessageAttachmentMutationAction | undefined
}) {
  if (files.length === 0) return null
  return (
    <div data-ui="message-output-media-list" data-media="file">
      {files.map((file, index) => (
        <OutputFile
          key={file.attachmentId ?? `${file.filename}:${index}`}
          file={file}
          messageId={messageId}
          attachmentRef={file.attachmentId ? attachmentRefs.get(file.attachmentId) : undefined}
          onMutateAttachmentRef={onMutateAttachmentRef}
        />
      ))}
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
  onMutateAttachmentRef?: MessageAttachmentMutationAction | undefined
}) {
  const mediaSnapshot = useAttachmentMedia(image.attachmentId, 'message-output')
  const media = mediaSnapshot.media
  const objectUrl = useAttachmentObjectUrl(media?.blob, mediaSnapshot.workspaceFence)

  const src = image.attachmentId ? attachmentMediaUrl(media, objectUrl) : undefined
  const alt = image.prompt ?? media?.attachment.filename ?? `Generated image ${index + 1}`
  return (
    <figure
      data-ui="message-output-image"
      data-context={attachmentRef?.includeInContext === false ? 'excluded' : 'included'}
      data-has-context-toggle={messageId && attachmentRef ? 'true' : undefined}
    >
      {src ? <img src={src} alt={alt} /> : <span data-ui="message-output-image-missing" />}
      {messageId && attachmentRef ? (
        <OutputMediaContextToggle
          messageId={messageId}
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
  onMutateAttachmentRef?: MessageAttachmentMutationAction | undefined
}) {
  const mediaSnapshot = useAttachmentMedia(audio.attachmentId, 'message-output')
  const media = mediaSnapshot.media
  const objectUrl = useAttachmentObjectUrl(media?.blob, mediaSnapshot.workspaceFence)

  const src = audio.attachmentId ? attachmentMediaUrl(media, objectUrl) : undefined
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
          messageId={messageId}
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
  onMutateAttachmentRef?: MessageAttachmentMutationAction | undefined
}) {
  const mediaSnapshot = useAttachmentMedia(video.attachmentId, 'message-output')
  const media = mediaSnapshot.media
  const objectUrl = useAttachmentObjectUrl(media?.blob, mediaSnapshot.workspaceFence)

  const src = video.attachmentId ? attachmentMediaUrl(media, objectUrl) : undefined
  const title = video.prompt ?? media?.attachment.filename ?? `Generated video ${index + 1}`
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
          messageId={messageId}
          attachmentRef={attachmentRef}
          noun="video"
          onMutateAttachmentRef={onMutateAttachmentRef}
        />
      ) : null}
    </figure>
  )
}

function OutputFile({
  file,
  messageId,
  attachmentRef,
  onMutateAttachmentRef,
}: {
  file: Extract<ContentItem, { type: 'file' }>
  messageId?: MessageId | undefined
  attachmentRef?: ReturnType<typeof liveAttachmentRefs>[number] | undefined
  onMutateAttachmentRef?: MessageAttachmentMutationAction | undefined
}) {
  const mediaSnapshot = useAttachmentMedia(file.attachmentId, 'message-output')
  const media = mediaSnapshot.media
  const objectUrl = useAttachmentObjectUrl(media?.blob, mediaSnapshot.workspaceFence)
  const href = file.attachmentId ? attachmentMediaUrl(media, objectUrl) : undefined
  const filename = media?.attachment.filename ?? file.filename
  return (
    <figure
      data-ui="message-output-media"
      data-media="file"
      data-context={attachmentRef?.includeInContext === false ? 'excluded' : 'included'}
      data-has-context-toggle={messageId && attachmentRef ? 'true' : undefined}
    >
      {href ? (
        <a href={href} download={objectUrl ? filename : undefined}>
          {filename}
        </a>
      ) : (
        filename
      )}
      {messageId && attachmentRef ? (
        <OutputMediaContextToggle
          messageId={messageId}
          attachmentRef={attachmentRef}
          noun="file"
          onMutateAttachmentRef={onMutateAttachmentRef}
        />
      ) : null}
    </figure>
  )
}

function OutputMediaContextToggle({
  messageId,
  attachmentRef,
  noun,
  onMutateAttachmentRef,
}: {
  messageId: MessageId
  attachmentRef: ReturnType<typeof liveAttachmentRefs>[number]
  noun: 'image' | 'audio' | 'video' | 'file'
  onMutateAttachmentRef?: MessageAttachmentMutationAction | undefined
}) {
  const mutationInteraction = usePresentationInteraction(attachmentMutationInteraction)
  const mutationTarget = attachmentMutationTarget({ messageId, refId: attachmentRef.refId })
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
      onClick={() => {
        if (!onMutateAttachmentRef) return
        mutationInteraction.run({
          target: mutationTarget,
          action: () =>
            onMutateAttachmentRef({
              kind: 'visibility',
              refId: attachmentRef.refId,
              includeInContext: !attachmentRef.includeInContext,
            }),
        })
      }}
      disabled={
        onMutateAttachmentRef === undefined || mutationInteraction.isPending(mutationTarget)
      }
    >
      {attachmentRef.includeInContext ? <EyeIcon size={14} /> : <EyeOffIcon size={14} />}
    </Button>
  )
}

function remoteAttachmentUrl(media: AttachmentMediaProjection | undefined): string | undefined {
  const attachment = media?.attachment
  if (!attachment) return undefined
  if (attachment.storage.kind === 'remote-url') return attachment.storage.url
  return undefined
}

function attachmentMediaUrl(
  media: AttachmentMediaProjection | undefined,
  objectUrl: string | undefined,
): string | undefined {
  const localBlobUsable =
    typeof Blob !== 'undefined' &&
    media?.blob?.blob instanceof Blob &&
    typeof URL.createObjectURL === 'function'
  return localBlobUsable ? objectUrl : remoteAttachmentUrl(media)
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
