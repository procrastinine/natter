// Minimal chat-export-as-txt for the Phase-8-polish chat-title-bar
// download button. Walks the active branch of `chatId` (current cursor over
// `lastUpdatedLeafId`'s chain), serialises each message as
//   <ROLE>:
//   <text>
//
// blocks, and triggers a browser download via a Blob URL. Full
// flatten-export (with attachments, tool calls, and per-branch options)
// lands in plan/12-features §12.13.

import { activePath } from './active-path'
import type { ChatId, CursorMap, Message } from './types'
import { loadChatMessages, getChat } from '../store/chats'

function flattenMessageText(msg: Message): string {
  return msg.content
    .map((part) => {
      if (part.type === 'text' || part.type === 'output_text') return part.text
      return ''
    })
    .filter((s) => s.length > 0)
    .join('\n')
}

const ROLE_LABEL: Record<Message['role'], string> = {
  user: 'USER',
  assistant: 'ASSISTANT',
  system: 'SYSTEM',
  developer: 'DEVELOPER',
  tool: 'TOOL',
}

export async function exportChatAsTxt(
  chatId: ChatId,
  cursor: CursorMap = {},
): Promise<{ filename: string; content: string }> {
  const [chat, messages] = await Promise.all([
    getChat(chatId),
    loadChatMessages(chatId),
  ])
  const path = activePath(messages, cursor)
  const title = chat?.title?.trim().length ? chat.title : 'Untitled chat'
  const header = `# ${title}\n\n`
  const body = path
    .map((m) => {
      const text = flattenMessageText(m)
      return `${ROLE_LABEL[m.role] ?? m.role.toUpperCase()}:\n${text}\n`
    })
    .join('\n')
  const safeBase = title
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
  const filename = `${safeBase || 'chat'}.txt`
  return { filename, content: header + body }
}

export function triggerBrowserDownload(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
