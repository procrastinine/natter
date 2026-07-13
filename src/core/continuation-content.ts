import type { ContentItem, Message } from './types'

export function appendContinuationText(
  content: readonly ContentItem[],
  continuationText: string,
): ContentItem[] {
  const next = structuredClone(content) as ContentItem[]
  if (continuationText.length === 0) return next

  const finalItem = next.at(-1)
  if (
    finalItem?.type === 'output_text' &&
    (finalItem.annotations === undefined || finalItem.annotations.length === 0)
  ) {
    finalItem.text += continuationText
    return next
  }

  next.push({ type: 'output_text', text: continuationText })
  return next
}

export function hasAppliedSuccessfulContinuation(
  message: Pick<Message, 'continuationAttempts'>,
): boolean {
  return Boolean(
    message.continuationAttempts?.some(
      (attempt) => attempt.status === 'done' && attempt.unappliedText === undefined,
    ),
  )
}
