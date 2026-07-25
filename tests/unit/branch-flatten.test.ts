import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildBranchMessages,
  flattenBranchMessages,
  messageRenderableText,
} from '../../src/core/branch-flatten'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, Message } from '../../src/core/types'
import {
  exportActiveBranchAsTxt,
  exportLastUpdatedBranchAsTxt,
} from '../../src/store/branch-flatten'
import { splitMessageForStorage } from '../../src/store/message-storage'
import type {
  WorkspaceQuery,
  WorkspaceReadAuthority,
  WorkspaceRepository,
} from '../../src/store/workspace-protocol'

const authority = { signal: new AbortController().signal } as WorkspaceReadAuthority
const CHAT_ID = '01ABCDEFGHJKMNPQRSTVWXYZ'

function message(overrides: Partial<Message>): Message {
  return {
    id: 'm',
    chatId: CHAT_ID,
    parentId: null,
    siblingIndex: 0,
    turnId: 'turn',
    turnIndex: 0,
    createdAt: 1,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'hello' }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}

function chat(
  overrides: Partial<Pick<Chat, 'lastUpdatedLeafId' | 'title' | 'titleStatus'>> = {},
): Chat {
  return {
    id: CHAT_ID,
    title: 'Export chat',
    titleStatus: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 1,
    structuralVersion: 1,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
    ...overrides,
  }
}

function repository(currentChat: Chat, messages: readonly Message[]): WorkspaceRepository {
  const presentations = messages.map((row) => {
    const { header } = splitMessageForStorage(row)
    return { header, message: row, bodyVersion: header.bodyVersion }
  })
  const headers = presentations.map((row) => row.header)
  const presentationsById = new Map(presentations.map((row) => [row.message.id, row] as const))
  return {
    query: vi.fn(async (_authority: unknown, request: WorkspaceQuery) => {
      if (
        request.kind !== 'chat.get' &&
        request.kind !== 'branch.open' &&
        request.kind !== 'branch.page-structure' &&
        request.kind !== 'message.presentations'
      ) {
        throw new Error(`UnexpectedQuery:${request.kind}`)
      }
      let value: unknown
      switch (request.kind) {
        case 'chat.get':
          value = currentChat
          break
        case 'branch.open': {
          const branchLeafId =
            request.target.kind === 'fixed-empty'
              ? null
              : request.target.kind === 'fixed-tip'
                ? request.target.messageId
                : currentChat.lastUpdatedLeafId
          value = {
            kind: 'ready',
            chat: currentChat,
            target: request.target,
            proof: {
              chatId: currentChat.id,
              structuralVersion: currentChat.structuralVersion,
              tipId: branchLeafId,
              pathHeaders: branchLeafId === null ? [] : headers,
            },
            presentations: [],
          }
          break
        }
        case 'branch.page-structure':
          value = {
            kind: 'ready',
            snapshot: {
              chatId: currentChat.id,
              pageHeaders: headers.slice(
                request.window.offset,
                request.window.offset + request.window.nodes.length,
              ),
              pageOffset: request.window.offset,
              pageLimit: request.window.limit,
              branchLength: headers.length,
            },
          }
          break
        case 'message.presentations':
          value = request.messageIds.map((messageId) => presentationsById.get(messageId))
          break
      }
      return { workspaceId: 'workspace', replacementEpoch: 0, value }
    }),
    execute: vi.fn(),
    replace: vi.fn(),
    subscribeChanges: vi.fn(() => () => undefined),
  } as unknown as WorkspaceRepository
}

afterEach(() => {
  vi.useRealTimers()
})

describe('branch-flatten', () => {
  it('walks a root-to-leaf branch', () => {
    const root = message({ id: 'root', content: [{ type: 'text', text: 'root' }] })
    const older = message({
      id: 'older',
      parentId: root.id,
      siblingIndex: 0,
      createdAt: 2,
      content: [{ type: 'text', text: 'older' }],
    })
    const leaf = message({
      id: 'leaf',
      parentId: root.id,
      siblingIndex: 1,
      createdAt: 3,
      content: [{ type: 'text', text: 'leaf' }],
    })

    expect(buildBranchMessages([leaf, older, root], leaf.id).map((row) => row.id)).toEqual([
      'root',
      'leaf',
    ])
  })

  it('flattens phases, tools, and attachments without branch metadata', () => {
    const user = message({ id: 'user', content: [{ type: 'text', text: 'Hi' }] })
    const assistant = message({
      id: 'assistant',
      parentId: user.id,
      createdAt: 2,
      role: 'assistant',
      origin: 'generated',
      phase: 'final_answer',
      attachmentRefs: [
        {
          refId: 'ref',
          attachmentId: 'attachment',
          includeInContext: true,
          presentation: { label: 'brief.pdf' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      toolCalls: [{ id: 'call', type: 'function', function: { name: 'search', arguments: '{}' } }],
      content: [{ type: 'output_image', attachmentId: 'image' }],
    })

    expect(messageRenderableText(assistant)).toBe(
      '[image: image]\n[attachment: brief.pdf]\n[tool call: search]',
    )
    expect(flattenBranchMessages([user, assistant], { title: '' })).toBe(
      '# Untitled chat\n\nUSER:\nHi\n\nASSISTANT (final):\n[image: image]\n[attachment: brief.pdf]\n[tool call: search]\n',
    )
  })

  it('exports last-updated text through the canonical segmented reader', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-26T12:00:00.000Z'))
    const user = message({ id: 'user', content: [{ type: 'text', text: 'hello' }] })
    const assistant = message({
      id: 'assistant',
      parentId: user.id,
      createdAt: 2,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'world' }],
    })
    const currentChat = chat({
      title: 'Branching deep dive',
      lastUpdatedLeafId: assistant.id,
    })

    const result = await exportLastUpdatedBranchAsTxt(
      repository(currentChat, [user, assistant]),
      currentChat.id,
      authority,
    )

    expect(result).toEqual({
      filename: 'branching-deep-dive-2026-04-26.txt',
      content: '# Branching deep dive\n\nUSER:\nhello\n\nASSISTANT:\nworld\n',
    })
  })

  it('uses the same reader for an explicit per-tab leaf and empty chats', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-26T12:00:00.000Z'))
    const leaf = message({ id: 'leaf', content: [{ type: 'text', text: 'selected branch' }] })
    const currentChat = chat({ titleStatus: 'untitled', title: '', lastUpdatedLeafId: leaf.id })

    const active = await exportActiveBranchAsTxt(
      repository(currentChat, [leaf]),
      currentChat.id,
      leaf.id,
      authority,
    )
    const empty = await exportActiveBranchAsTxt(
      repository(currentChat, []),
      currentChat.id,
      null,
      authority,
    )

    expect(active.filename).toBe('chat-01ABCDEF-2026-04-26.txt')
    expect(active.content).toBe('# Untitled chat\n\nUSER:\nselected branch\n')
    expect(empty.content).toBe('# Untitled chat\n')
  })
})
