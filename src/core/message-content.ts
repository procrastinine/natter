import type { ContentItem } from './types'

export function plaintextOf(content: readonly ContentItem[]): string {
  return content
    .map((item) => (item.type === 'text' || item.type === 'output_text' ? item.text : ''))
    .join('')
}

export function writeTextInto(prev: readonly ContentItem[], nextText: string): ContentItem[] {
  let replaced = false
  const out: ContentItem[] = []
  for (const item of prev) {
    if (item.type === 'text' || item.type === 'output_text') {
      if (!replaced) {
        out.push({ ...item, text: nextText })
        replaced = true
      }
      continue
    }
    out.push(item)
  }
  if (!replaced) out.push({ type: 'text', text: nextText })
  return out
}
