import { normalizeReasoningDetails } from './reasoning'
import type { ChatSettings, ContentItem, Message, ReasoningDetail } from './types'

const CONTINUE_USER_ID_PREFIX = 'continue-user:'

export function applyOutboundContextRewrites(
  path: readonly Message[],
  settings: ChatSettings,
): Message[] {
  let next = applyAppendPromptToPath(path, settings.appendPrompt)
  next = applyPrefillReasoningToPath(next)
  return next
}

function applyAppendPromptToPath(path: readonly Message[], appendPrompt: string): Message[] {
  if (appendPrompt.length === 0) return [...path]
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const message = path[i]
    if (!message) continue
    if (message.role !== 'user') continue
    if (message.id.startsWith(CONTINUE_USER_ID_PREFIX)) continue
    const cloned: Message = {
      ...message,
      content: appendTextToContent(message.content, appendPrompt),
    }
    return [...path.slice(0, i), cloned, ...path.slice(i + 1)]
  }
  return [...path]
}

function applyPrefillReasoningToPath(path: readonly Message[]): Message[] {
  const tailIndex = lastVisibleIndex(path)
  if (tailIndex < 0) return [...path]
  const tail = path[tailIndex]
  if (tail?.role !== 'assistant' || tail.origin !== 'prefill') return [...path]
  const rewritten = withPrefillReasoningContext(tail)
  if (rewritten === tail) return [...path]
  return [...path.slice(0, tailIndex), rewritten, ...path.slice(tailIndex + 1)]
}

function lastVisibleIndex(path: readonly Message[]): number {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const message = path[i]
    if (!message || message.deleted || message.hiddenFromContext) continue
    return i
  }
  return -1
}

function withPrefillReasoningContext(message: Message): Message {
  if (!message.reasoningDetails || message.reasoningDetails.length === 0) return message
  const { plain, opaque } = splitPrefillReasoningDetails(message.reasoningDetails)
  const thinkBlock = prefillThinkBlock(message.content, plain)
  if (!thinkBlock) return message
  const next: Message = {
    ...message,
    content: prependTextToContent(message.content, thinkBlock),
  }
  if (opaque.length > 0) next.reasoningDetails = opaque
  else delete next.reasoningDetails
  delete next.responsesEchoItem
  return next
}

function splitPrefillReasoningDetails(details: readonly ReasoningDetail[]): {
  plain: ReasoningDetail[]
  opaque: ReasoningDetail[]
} {
  const plain: ReasoningDetail[] = []
  const opaque: ReasoningDetail[] = []
  for (const detail of normalizeReasoningDetails([...details])) {
    if (detail.id?.startsWith('tool_')) continue
    if (detail.hidden === true) continue
    if (isOpaqueReasoning(detail)) {
      opaque.push(detail)
    } else if (detail.type === 'reasoning.text' || detail.type === 'reasoning.summary') {
      plain.push(detail)
    }
  }
  return { plain, opaque }
}

function isOpaqueReasoning(detail: ReasoningDetail): boolean {
  if (detail.type === 'reasoning.encrypted') return true
  return (
    detail.type === 'reasoning.text' &&
    typeof detail.signature === 'string' &&
    detail.signature.length > 0
  )
}

function prefillThinkBlock(
  content: readonly ContentItem[],
  details: readonly ReasoningDetail[],
): string | null {
  const parts = reasoningPlainParts(details)
  if (parts.length === 0) return null
  const body = parts.join('\n\n')
  return hasAssistantResponseContent(content) ? `<think>\n${body}\n</think>` : `<think>\n${body}`
}

function reasoningPlainParts(details: readonly ReasoningDetail[]): string[] {
  return details
    .map((detail) => {
      if (detail.type === 'reasoning.summary') {
        const summary = normalizeThinkPayload(detail.summary)
        return summary.length > 0 ? `Summary: ${summary}` : ''
      }
      if (detail.type === 'reasoning.text') return normalizeThinkPayload(detail.text ?? '')
      return ''
    })
    .filter((text) => text.length > 0)
}

function hasAssistantResponseContent(content: readonly ContentItem[]): boolean {
  return content.some((item) => {
    if (item.type === 'text' || item.type === 'output_text') return item.text.trim().length > 0
    return true
  })
}

function appendTextToContent(content: readonly ContentItem[], appendText: string): ContentItem[] {
  const next: ContentItem[] = [...content]
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const item = next[i]
    if (item && item.type === 'text') {
      next[i] = { ...item, text: item.text + appendText }
      return next
    }
  }
  next.push({ type: 'text', text: appendText })
  return next
}

function prependTextToContent(content: readonly ContentItem[], prefix: string): ContentItem[] {
  const next: ContentItem[] = [...content]
  for (let i = 0; i < next.length; i += 1) {
    const item = next[i]
    if (!item) continue
    if (item.type === 'text' || item.type === 'output_text') {
      const separator = item.text.length > 0 ? '\n\n' : ''
      next[i] = { ...item, text: `${prefix}${separator}${item.text}` }
      return next
    }
  }
  return [{ type: 'text', text: prefix }, ...next]
}

function normalizeThinkPayload(value: string): string {
  let text = value.trim()
  let changed = true
  while (changed) {
    const before = text
    text = text
      .replace(/^<think>\s*/iu, '')
      .replace(/\s*<\/think>$/iu, '')
      .replace(/^<thought>\s*/iu, '')
      .replace(/\s*<\/thought>$/iu, '')
      .trim()
    changed = text !== before
  }
  return text
    .replace(/<think>/giu, '<think >')
    .replace(/<\/think>/giu, '</think >')
    .replace(/<thought>/giu, '<thought >')
    .replace(/<\/thought>/giu, '</thought >')
    .trim()
}
