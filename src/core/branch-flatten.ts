import {
  chatMatchesBranchCacheWriteGuard,
  readChatBranchCacheSource,
  type WorkspaceRepository,
} from '../store/repository'
import { indexById } from './active-path'
import type {
  Chat,
  ChatBranchCache,
  ChatId,
  ContentItem,
  CursorMap,
  Message,
  MessageId,
} from './types'
import { countMessagesWords } from './word-count'

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

interface ChatTextExport {
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
  const parts: string[] = []
  for (const item of message.content) {
    const rendered = renderContentItem(item)
    if (rendered.length > 0) parts.push(rendered)
  }
  for (const ref of message.attachmentRefs ?? []) {
    if (ref.attachmentId) parts.push(`[attachment: ${ref.presentation.label ?? ref.attachmentId}]`)
  }
  for (const call of message.toolCalls ?? []) {
    parts.push(`[tool call: ${call.function.name}]`)
  }
  return parts.join('\n')
}

export function flattenBranchMessages(
  messages: readonly Message[],
  chat?: Pick<Chat, 'title'>,
  options: FlattenBranchOptions = {},
): string {
  const blocks: string[] = []
  if (options.includeTitle !== false) {
    blocks.push(`# ${displayTitle(chat)}`)
  }
  for (const message of messages) {
    const phase = message.phase ? ` (${PHASE_LABEL[message.phase]})` : ''
    blocks.push(`${ROLE_LABEL[message.role]}${phase}:\n${messageRenderableText(message)}`)
  }
  return `${blocks.join('\n\n')}\n`
}

export function buildBranchCacheRow(input: {
  chatId: ChatId
  branchLeafId: MessageId | null
  messages: readonly Message[]
  generatedAt?: number
}): ChatBranchCache {
  const branch = buildBranchMessages(input.messages, input.branchLeafId)
  return {
    chatId: input.chatId,
    branchLeafId: input.branchLeafId,
    generatedAt: input.generatedAt ?? Date.now(),
    textContent: flattenBranchMessages(branch, undefined, { includeTitle: false }),
    previewText: newestPreviewText(branch),
    messageCount: branch.length,
    wordCount: countMessagesWords(branch),
    messageTimestamps: branch.map((message) => ({
      id: message.id,
      createdAt: message.createdAt,
      editedAt: message.editedAt ?? message.createdAt,
    })),
  }
}

export async function exportActiveBranchAsTxt(
  repo: WorkspaceRepository,
  chatId: ChatId,
  cursorSnapshot: CursorMap = {},
): Promise<ChatTextExport> {
  const [chat, snapshot] = await Promise.all([
    repo.getChat(chatId),
    repo.getActiveBranchSnapshot(chatId, cursorSnapshot),
  ])
  if (!chat) throw new Error(`ChatMissing:${chatId}`)
  return {
    filename: exportFilename(chat),
    content: flattenBranchMessages(snapshot.branch, chat),
  }
}

export async function exportLastUpdatedBranchAsTxt(
  repo: WorkspaceRepository,
  chatId: ChatId,
): Promise<ChatTextExport> {
  for (;;) {
    const { chat, expected } = await readChatBranchCacheSource(repo, chatId)
    if (!chat) throw new Error(`ChatMissing:${chatId}`)
    const cached = await repo.getChatBranchCache(chatId)
    if ((await repo.getWorkspaceMeta()).replacementEpoch !== expected.replacementEpoch) continue
    if (
      cached &&
      cached.branchLeafId === chat.lastUpdatedLeafId &&
      cached.generatedAt >= chat.lastBranchUpdatedAt
    ) {
      return {
        filename: exportFilename(chat),
        content: textBodyWithTitle(chat, cached.textContent),
      }
    }

    const branch = await repo.getBranchByLeaf(chatId, chat.lastUpdatedLeafId)
    if (chat.lastUpdatedLeafId === null) {
      if (cached) await repo.deleteChatBranchCache(chatId, expected)
      const current = await readChatBranchCacheSource(repo, chatId)
      if (!current.chat) throw new Error(`ChatMissing:${chatId}`)
      if (
        current.expected.replacementEpoch !== expected.replacementEpoch ||
        !chatMatchesBranchCacheWriteGuard(current.chat, expected)
      ) {
        continue
      }
    } else {
      const written = await repo.putChatBranchCache(
        buildBranchCacheRow({
          chatId,
          branchLeafId: chat.lastUpdatedLeafId,
          messages: branch,
          generatedAt: Math.max(Date.now(), chat.lastBranchUpdatedAt),
        }),
        expected,
      )
      if (!written) continue
    }
    return {
      filename: exportFilename(chat),
      content: flattenBranchMessages(branch, chat),
    }
  }
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
      return `[image: ${item.attachmentId ?? item.url ?? item.prompt ?? 'generated'}]`
    case 'audio_output':
      return (
        item.transcript ?? `[audio: ${item.attachmentId ?? item.url ?? item.format ?? 'generated'}]`
      )
    case 'output_video':
      return `[video: ${item.attachmentId ?? item.url ?? item.prompt ?? 'generated'}]`
  }
}

function newestPreviewText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messageRenderableText(messages[i] as Message)
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length > 0) return text.length > 500 ? text.slice(0, 500) : text
  }
  return ''
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
