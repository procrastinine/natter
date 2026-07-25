import { indexById } from './active-path'
import { type AppliedMessageView, createAppliedMessageView } from './continuation-content'
import type { Chat, ContentItem, Message, MessageId } from './types'

const ROLE_LABEL: Record<Message['role'], string> = {
  user: 'USER',
  assistant: 'ASSISTANT',
  system: 'SYSTEM',
  developer: 'DEVELOPER',
  tool: 'TOOL',
}

const PHASE_LABEL: Record<NonNullable<Message['phase']>, string> = {
  commentary: 'commentary',
  final_answer: 'final',
}

export interface ChatTextExport {
  filename: string
  content: string
}

interface FlattenBranchOptions {
  includeTitle?: boolean
}

export function buildBranchMessages(
  messages: readonly Message[],
  leafId: MessageId | null,
): Message[] {
  if (leafId === null) return []
  const byId = indexById(messages)
  const branch: Message[] = []
  let currentId: MessageId | null = leafId
  while (currentId !== null) {
    const message = byId.get(currentId)
    if (!message || message.deleted) break
    branch.push(message)
    currentId = message.parentId
  }
  branch.reverse()
  return branch
}

export function messageRenderableText(message: Message): string {
  return [...messageRenderableTextSegments(message)].join('\n')
}

export function* messageRenderableTextSegments(
  message: Pick<Message, 'content' | 'attachmentRefs' | 'toolCalls' | 'continuationAttempts'>,
  view: AppliedMessageView = createAppliedMessageView(message),
): Generator<string> {
  for (const item of message.content) {
    const rendered = renderContentItem(item)
    if (rendered.length > 0) yield rendered
  }
  for (const ref of message.attachmentRefs ?? []) {
    if (ref.attachmentId) yield `[attachment: ${ref.presentation.label ?? ref.attachmentId}]`
  }
  for (const call of view.toolCalls) {
    yield `[tool call: ${call.function.name}]`
  }
}

export function messageRenderableTextSemanticsEqual(
  left: Pick<Message, 'content' | 'attachmentRefs' | 'toolCalls' | 'continuationAttempts'>,
  right: Pick<Message, 'content' | 'attachmentRefs' | 'toolCalls' | 'continuationAttempts'>,
  leftView: AppliedMessageView = createAppliedMessageView(left),
  rightView: AppliedMessageView = createAppliedMessageView(right),
): boolean {
  const leftSegments = messageRenderableTextSegments(left, leftView)
  const rightSegments = messageRenderableTextSegments(right, rightView)
  for (;;) {
    const leftSegment = leftSegments.next()
    const rightSegment = rightSegments.next()
    if (leftSegment.done || rightSegment.done) return leftSegment.done === rightSegment.done
    if (leftSegment.value !== rightSegment.value) return false
  }
}

export function flattenBranchMessages(
  messages: readonly Message[],
  chat?: Pick<Chat, 'title'>,
  options: FlattenBranchOptions = {},
): string {
  return [...branchTextSegments(messages, chat, options)].join('')
}

function* branchTextSegments(
  messages: Iterable<Message>,
  chat?: Pick<Chat, 'title'>,
  options: FlattenBranchOptions = {},
): Generator<string> {
  let hasBlock = false
  if (options.includeTitle !== false) {
    yield `# ${displayTitle(chat)}`
    hasBlock = true
  }
  for (const message of messages) {
    if (hasBlock) yield '\n\n'
    yield* branchMessageTextSegments(message)
    hasBlock = true
  }
  yield '\n'
}

export function* branchMessageTextSegments(message: Message): Generator<string> {
  const view = createAppliedMessageView(message)
  const phase = view.phase ? ` (${PHASE_LABEL[view.phase]})` : ''
  yield `${ROLE_LABEL[message.role]}${phase}:\n`
  let hasRenderableText = false
  for (const segment of messageRenderableTextSegments(message, view)) {
    if (hasRenderableText) yield '\n'
    yield segment
    hasRenderableText = true
  }
}

export function branchTextExport(
  chat: Pick<Chat, 'id' | 'title' | 'titleStatus'>,
  messages: readonly Message[],
): ChatTextExport {
  return { filename: exportFilename(chat), content: flattenBranchMessages(messages, chat) }
}

export function branchTextBodyExport(
  chat: Pick<Chat, 'id' | 'title' | 'titleStatus'>,
  body: string,
): ChatTextExport {
  return { filename: exportFilename(chat), content: textBodyWithTitle(chat, body) }
}

function renderContentItem(item: ContentItem): string {
  switch (item.type) {
    case 'text':
    case 'output_text':
      return item.text
    case 'image_url':
      return `[image: ${item.attachmentId ?? item.url ?? 'inline'}]`
    case 'input_audio':
      return `[audio: ${item.attachmentId ?? item.format}]`
    case 'file':
      return `[file: ${item.filename}]`
    case 'video_url':
      return `[video: ${item.attachmentId ?? item.url ?? 'inline'}]`
    case 'output_image':
      return `[image: ${item.attachmentId ?? item.url}]`
    case 'audio_output':
      return (
        item.transcript ?? `[audio: ${item.attachmentId ?? item.url ?? item.format ?? 'generated'}]`
      )
    case 'output_video':
      return `[video: ${item.attachmentId ?? item.url}]`
  }
}

function displayTitle(chat?: Pick<Chat, 'title'>): string {
  const title = chat?.title.trim()
  return title ? title : 'Untitled chat'
}

function textBodyWithTitle(chat: Pick<Chat, 'title'>, body: string): string {
  const normalizedBody = body.endsWith('\n') ? body : `${body}\n`
  return `# ${displayTitle(chat)}\n\n${normalizedBody}`
}

function exportFilename(
  chat: Pick<Chat, 'id' | 'title' | 'titleStatus'>,
  now = Date.now(),
): string {
  const date = new Date(now).toISOString().slice(0, 10)
  const base = filenameBase(chat)
  return `${base}-${date}.txt`
}

function filenameBase(chat: Pick<Chat, 'id' | 'title' | 'titleStatus'>): string {
  const title = chat.title.trim()
  if (title.length > 0 && chat.titleStatus !== 'untitled') {
    const slug = title
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
    if (slug.length > 0) return slug
  }
  return `chat-${chat.id.slice(0, 8)}`
}
