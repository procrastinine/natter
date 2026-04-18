import type { ContentItem } from '../../core/types'

export interface MessageContentProps {
  content: ContentItem[]
}

// Phase 7 renders text-only content lanes. Non-text items are not Phase 7's
// problem yet; they'll get dedicated components in Phase 8+.
export function MessageContent({ content }: MessageContentProps) {
  const text = content
    .map((item) => {
      if (item.type === 'text' || item.type === 'output_text') return item.text
      return ''
    })
    .join('')
  return (
    <div data-ui="message-body" data-role="text">
      {text}
    </div>
  )
}
