import { useMemo } from 'react'
import type { ContentItem } from '../../core/types'
import { MarkdownView } from './MarkdownView'
import {
  MessageStreamOverflow,
  type MessageCollapseMode,
} from './MessageStreamOverflow'

export interface MessageContentProps {
  text: string
  streaming?: boolean
  collapseMode?: MessageCollapseMode
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
  text,
  streaming = false,
  collapseMode = 'full',
}: MessageContentProps) {
  // Non-text parts (images, attachments, tool calls) get dedicated renderers in
  // later phases. Phase 8 only wires text lanes through the markdown pipeline.
  const body = (
    <div data-ui="message-body" data-role="text">
      <MarkdownView content={text} streaming={streaming} />
    </div>
  )
  const compactText = useMemo(() => previewSlice(text, COMPACT_PREVIEW_CHARS), [text])
  const compact = (
    <div data-ui="message-body" data-role="text" data-overflow="compact">
      <MarkdownView content={compactText} streaming={streaming} />
    </div>
  )
  const peekText = useMemo(() => previewFirstLine(text), [text])
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

function previewFirstLine(text: string): string {
  const firstNonEmpty =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? text.trim()
  if (firstNonEmpty.length === 0) return '...'
  const singleLine = firstNonEmpty.replace(/\s+/g, ' ')
  if (singleLine.length <= PEEK_PREVIEW_CHARS) {
    return `${singleLine} ...`
  }
  return `${singleLine.slice(0, PEEK_PREVIEW_CHARS - 3).trimEnd()}...`
}
