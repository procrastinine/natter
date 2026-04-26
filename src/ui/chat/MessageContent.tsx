import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import type { AttachmentBlob, AttachmentRef, ContentItem, MessageId } from '../../core/types'
import { liveAttachmentRefs } from '../../store/attachment-refs'
import { getBrowserRepository } from '../../store/browser-repo'
import { setAttachmentRefVisibility } from '../../store/attachments'
import type { AttachmentBundle } from '../../store/repository'
import { EyeIcon, EyeOffIcon } from '../icons/Icon'
import { MarkdownView } from './MarkdownView'
import { MessageStreamOverflow, type MessageCollapseMode } from './MessageStreamOverflow'

export interface MessageContentProps {
  content: ContentItem[]
  text: string
  streaming?: boolean
  collapseMode?: MessageCollapseMode
  messageId?: MessageId | undefined
  attachmentRefs?: readonly AttachmentRef[] | undefined
}

const COMPACT_PREVIEW_CHARS = 8_000
const PEEK_PREVIEW_CHARS = 160

export function messageTextFromContent(content: ContentItem[]): string {
  return content
    .map((item) => {
      if (item.type === 'text' || item.type === 'output_text') return item.text
      return ''
    })
    .join('')
}

export function MessageContent({
  content,
  text,
  streaming = false,
  collapseMode = 'full',
  messageId,
  attachmentRefs,
}: MessageContentProps) {
  const images = useMemo(() => outputImagesFromContent(content), [content])
  const imageRefs = useMemo(() => liveAttachmentRefs(attachmentRefs), [attachmentRefs])
  const body = (
    <div data-ui="message-body" data-role="content">
      {text.length > 0 ? <MarkdownView content={text} streaming={streaming} /> : null}
      <OutputImages images={images} messageId={messageId} attachmentRefs={imageRefs} />
    </div>
  )
  const compactText = useMemo(() => previewSlice(text, COMPACT_PREVIEW_CHARS), [text])
  const compact = (
    <div data-ui="message-body" data-role="content" data-overflow="compact">
      {compactText.length > 0 ? <MarkdownView content={compactText} streaming={streaming} /> : null}
      <OutputImages images={images} messageId={messageId} attachmentRefs={imageRefs} />
    </div>
  )
  const peekText = useMemo(() => previewFirstLine(text, images.length), [text, images.length])
  const peek = (
    <div data-ui="message-body" data-role="text" data-overflow="peek">
      <p data-ui="message-body-peek">{peekText}</p>
    </div>
  )
  return (
    <MessageStreamOverflow
      collapseMode={collapseMode}
      fullChildren={body}
      compactChildren={compact}
      peekChildren={peek}
    />
  )
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

function OutputImages({
  images,
  messageId,
  attachmentRefs,
}: {
  images: Array<Extract<ContentItem, { type: 'output_image' }>>
  messageId?: MessageId | undefined
  attachmentRefs: ReturnType<typeof liveAttachmentRefs>
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
}: {
  image: Extract<ContentItem, { type: 'output_image' }>
  index: number
  messageId?: MessageId | undefined
  attachmentRef?: ReturnType<typeof liveAttachmentRefs>[number] | undefined
}) {
  const bundle = useLiveQuery(
    async () => {
      if (!image.attachmentId) return undefined
      return getBrowserRepository().getAttachmentBundle(image.attachmentId)
    },
    [image.attachmentId],
    undefined,
  )
  const blob = useMemo(() => selectOutputImageBlob(bundle), [bundle])
  const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!blob || !(blob.blob instanceof Blob) || typeof URL.createObjectURL !== 'function') {
      setObjectUrl(undefined)
      return
    }
    const url = URL.createObjectURL(blob.blob)
    setObjectUrl(url)
    return () => URL.revokeObjectURL?.(url)
  }, [blob])

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
        <button
          type="button"
          data-ui="message-output-image-context-toggle"
          aria-pressed={attachmentRef.includeInContext}
          aria-label={
            attachmentRef.includeInContext
              ? 'Hide generated image from context'
              : 'Include generated image in context'
          }
          title={
            attachmentRef.includeInContext
              ? 'Hide this generated image from future context'
              : 'Include this generated image in future context'
          }
          onClick={() =>
            void setAttachmentRefVisibility({
              messageId,
              refId: attachmentRef.refId,
              includeInContext: !attachmentRef.includeInContext,
            })
          }
        >
          {attachmentRef.includeInContext ? <EyeIcon size={14} /> : <EyeOffIcon size={14} />}
        </button>
      ) : null}
    </figure>
  )
}

function selectOutputImageBlob(bundle: AttachmentBundle | undefined): AttachmentBlob | undefined {
  return (
    bundle?.blobs.find((blob) => blob.role === 'original') ??
    bundle?.blobs.find((blob) => blob.role === 'normalized') ??
    bundle?.blobs[0]
  )
}

function remoteAttachmentUrl(bundle: AttachmentBundle | undefined): string | undefined {
  const attachment = bundle?.attachment
  if (!attachment) return undefined
  if (attachment.storage.kind === 'remote-url') return attachment.storage.url
  return attachment.sourceUrl
}

function previewFirstLine(text: string, imageCount: number): string {
  const firstNonEmpty =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? text.trim()
  if (firstNonEmpty.length === 0) {
    return imageCount > 0 ? `Generated image${imageCount === 1 ? '' : 's'} ...` : '...'
  }
  const singleLine = firstNonEmpty.replace(/\s+/g, ' ')
  if (singleLine.length <= PEEK_PREVIEW_CHARS) {
    return `${singleLine} ...`
  }
  return `${singleLine.slice(0, PEEK_PREVIEW_CHARS - 3).trimEnd()}...`
}
