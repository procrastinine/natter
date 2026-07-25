import { normalizeInlineReasoningPayload } from './reasoning-inline'
import type {
  ChatSettings,
  ContentItem,
  Message,
  MessageId,
  ReasoningEnvelopeV2,
  ReasoningVisiblePartV2,
  SealedReasoningCarryForward,
} from './types'

const CONTINUE_USER_ID_PREFIX = 'continue-user:'

export interface OutboundContextRewritePlan {
  readonly appendPrompt: string
  readonly appendPromptTargetId: MessageId | null
  readonly prefillReasoningTargetId: MessageId | null
}

interface OutboundContextRewriteCandidate {
  readonly id: MessageId
  readonly role: Message['role']
  readonly origin: Message['origin']
  readonly deleted: boolean
  readonly hiddenFromContext?: boolean | undefined
}

export interface OutboundContextMessageRewrite {
  readonly message: Message
  readonly reasoningCarryForward?: SealedReasoningCarryForward
}

export function applyOutboundContextRewrites(
  path: readonly Message[],
  settings: ChatSettings,
  prefillReasoningTargetId?: MessageId,
): Message[] {
  return projectOutboundContextRewrites(path, settings, prefillReasoningTargetId).messages
}

export interface OutboundContextProjection {
  messages: Message[]
  reasoningCarryForwardByMessageId: ReadonlyMap<MessageId, SealedReasoningCarryForward>
}

export function projectOutboundContextRewrites(
  path: readonly Message[],
  settings: ChatSettings,
  prefillReasoningTargetId?: MessageId,
): OutboundContextProjection {
  const plan = planOutboundContextRewrites(path, settings, prefillReasoningTargetId)
  const reasoningCarryForwardByMessageId = new Map<MessageId, SealedReasoningCarryForward>()
  const messages = path.map((message) => {
    const rewritten = applyOutboundContextRewrite(message, plan)
    if (rewritten.reasoningCarryForward) {
      reasoningCarryForwardByMessageId.set(message.id, rewritten.reasoningCarryForward)
    }
    return rewritten.message
  })
  return {
    messages,
    reasoningCarryForwardByMessageId,
  }
}

export function planOutboundContextRewrites(
  path: readonly OutboundContextRewriteCandidate[],
  settings: Pick<ChatSettings, 'appendPrompt'>,
  exactPrefillReasoningTargetId?: MessageId,
): OutboundContextRewritePlan {
  let appendPromptTargetId: MessageId | null = null
  let prefillReasoningTargetId: MessageId | null = null
  let terminalSeen = false
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const message = path[i]
    if (!message || message.deleted || message.hiddenFromContext) continue
    if (!terminalSeen) {
      terminalSeen = true
      if (
        message.role === 'assistant' &&
        (message.id === exactPrefillReasoningTargetId || message.origin === 'prefill')
      ) {
        prefillReasoningTargetId = message.id
      }
    }
    if (message.role === 'user' && !message.id.startsWith(CONTINUE_USER_ID_PREFIX)) {
      appendPromptTargetId = message.id
    }
    if (appendPromptTargetId !== null) break
  }
  return Object.freeze({
    appendPrompt: settings.appendPrompt,
    appendPromptTargetId: settings.appendPrompt.length > 0 ? appendPromptTargetId : null,
    prefillReasoningTargetId,
  })
}

export function applyOutboundContextRewrite(
  message: Message,
  plan: OutboundContextRewritePlan,
): OutboundContextMessageRewrite {
  let next = message
  if (message.id === plan.appendPromptTargetId) {
    next = {
      ...next,
      content: appendTextToContent(next.content, plan.appendPrompt),
    }
  }
  if (message.id !== plan.prefillReasoningTargetId) return { message: next }
  const rewritten = withPrefillReasoningContext(next)
  return rewritten.message === next
    ? { message: next }
    : { message: rewritten.message, reasoningCarryForward: 'visible-only' }
}

function withPrefillReasoningContext(message: Message): { message: Message } {
  const plain: ReasoningVisiblePartV2[] = []
  const root = partitionPrefillReasoningEnvelope(message.reasoningEnvelope)
  plain.push(...root.plain)
  let continuationAttempts = message.continuationAttempts
  if (continuationAttempts) {
    continuationAttempts = continuationAttempts.map((attempt) => {
      if (attempt.application.kind !== 'applied') return attempt
      const partition = partitionPrefillReasoningEnvelope(attempt.reasoningEnvelope)
      plain.push(...partition.plain)
      if (partition.envelope === attempt.reasoningEnvelope) return attempt
      const next = { ...attempt }
      if (partition.envelope) next.reasoningEnvelope = partition.envelope
      else delete next.reasoningEnvelope
      return next
    })
  }
  const thinkBlock = prefillThinkBlock(message.content, plain)
  if (!thinkBlock) return { message }
  const next: Message = {
    ...message,
    content: prependTextToContent(message.content, thinkBlock),
    ...(continuationAttempts ? { continuationAttempts } : {}),
  }
  if (root.envelope) next.reasoningEnvelope = root.envelope
  else delete next.reasoningEnvelope
  return { message: next }
}

function partitionPrefillReasoningEnvelope(envelope: ReasoningEnvelopeV2 | undefined): {
  plain: ReasoningVisiblePartV2[]
  envelope: ReasoningEnvelopeV2 | undefined
} {
  if (!envelope || envelope.visible.length === 0) return { plain: [], envelope }
  const retainedVisibleIds = new Set(
    envelope.carriers.flatMap((carrier) =>
      'bindsVisiblePartId' in carrier ? [carrier.bindsVisiblePartId] : [],
    ),
  )
  const plain = envelope.visible.filter(
    (part) => part.hidden !== true && !retainedVisibleIds.has(part.id),
  )
  if (plain.length === 0) return { plain, envelope }
  const retainedVisible = envelope.visible.filter((part) => retainedVisibleIds.has(part.id))
  return {
    plain,
    envelope:
      envelope.carriers.length > 0 || retainedVisible.length > 0
        ? { schemaVersion: 2, visible: retainedVisible, carriers: envelope.carriers }
        : undefined,
  }
}

function prefillThinkBlock(
  content: readonly ContentItem[],
  details: readonly ReasoningVisiblePartV2[],
): string | null {
  const parts = reasoningPlainParts(details)
  if (parts.length === 0) return null
  const body = parts.join('\n\n')
  return hasAssistantResponseContent(content) ? `<think>\n${body}\n</think>` : `<think>\n${body}`
}

function reasoningPlainParts(details: readonly ReasoningVisiblePartV2[]): string[] {
  return details
    .map((part) => {
      if (part.kind === 'summary') {
        const summary = normalizeInlineReasoningPayload(part.text)
        return summary.length > 0 ? `Summary: ${summary}` : ''
      }
      return normalizeInlineReasoningPayload(part.text)
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
