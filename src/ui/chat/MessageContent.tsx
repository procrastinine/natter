import { useMemo } from 'react'
import type { ContentItem } from '../../core/types'
import { MarkdownView } from './MarkdownView'
import { DEFAULT_OVERFLOW_THRESHOLD, MessageStreamOverflow } from './MessageStreamOverflow'

export interface MessageContentProps {
  content: ContentItem[]
  streaming?: boolean
  overflowThreshold?: number
}

export function MessageContent({
  content,
  streaming = false,
  overflowThreshold = DEFAULT_OVERFLOW_THRESHOLD,
}: MessageContentProps) {
  const text = useMemo(
    () =>
      content
        .map((item) => {
          if (item.type === 'text' || item.type === 'output_text') return item.text
          return ''
        })
        .join(''),
    [content],
  )
  // Non-text parts (images, attachments, tool calls) get dedicated renderers in
  // later phases. Phase 8 only wires text lanes through the markdown pipeline.
  const body = (
    <div data-ui="message-body" data-role="text">
      <MarkdownView content={text} streaming={streaming} />
    </div>
  )
  const truncated = (
    <div data-ui="message-body" data-role="text">
      <MarkdownView content={text.slice(0, 4000)} streaming={streaming} />
    </div>
  )
  return (
    <MessageStreamOverflow
      totalChars={text.length}
      truncatedChildren={truncated}
      fullChildren={body}
      threshold={overflowThreshold}
    />
  )
}
