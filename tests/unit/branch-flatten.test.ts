import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildBranchCacheRow,
  buildBranchMessages,
  exportActiveBranchAsTxt,
  exportLastUpdatedBranchAsTxt,
  flattenBranchMessages,
  messageRenderableText,
} from '../../src/core/branch-flatten'
import type { Chat, ChatBranchCache, Message } from '../../src/core/types'
import type { WorkspaceRepository } from '../../src/store/repository'

function message(overrides: Partial<Message>): Message {
  return {
    id: 'm',
    chatId: 'c',
    parentId: null,
    siblingIndex: 0,
    turnId: 't',
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

const chat = { title: '' } as Pick<Chat, 'title'>

function fullChat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: '01ABCDEFGHJKMNPQRSTVWXYZ',
    title: 'Export chat',
    titleStatus: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    settings: {} as Chat['settings'],
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('branch-flatten', () => {
  it('walks a root-to-leaf branch', () => {
    const root = message({ id: 'root', createdAt: 1, content: [{ type: 'text', text: 'root' }] })
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
    expect(buildBranchMessages([leaf, older, root], leaf.id).map((m) => m.id)).toEqual([
      'root',
      'leaf',
    ])
  })

  it('flattens a simple user plus assistant branch', () => {
    const user = message({ id: 'u', role: 'user', content: [{ type: 'text', text: 'Hi' }] })
    const assistant = message({
      id: 'a',
      role: 'assistant',
      parentId: user.id,
      createdAt: 2,
      content: [{ type: 'output_text', text: 'Hello' }],
    })
    expect(flattenBranchMessages([user, assistant], chat)).toBe(
      '# Untitled chat\n\nUSER:\nHi\n\nASSISTANT:\nHello\n',
    )
  })

  it('renders tools and attachments as placeholders', () => {
    const row = message({
      id: 'tool',
      role: 'assistant',
      attachmentRefs: [
        {
          refId: 'ref-1',
          attachmentId: 'att-1',
          includeInContext: true,
          presentation: { label: 'brief.pdf' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      toolCalls: [
        { id: 'call-1', type: 'function', function: { name: 'search', arguments: '{}' } },
      ],
      content: [{ type: 'output_image', attachmentId: 'img-1' }],
    })
    expect(messageRenderableText(row)).toBe(
      '[image: img-1]\n[attachment: brief.pdf]\n[tool call: search]',
    )
  })

  it('labels multi-item Responses phases', () => {
    const row = message({
      id: 'phase',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'final' }],
    })
    expect(flattenBranchMessages([row], chat)).toBe(
      '# Untitled chat\n\nASSISTANT (final):\nfinal\n',
    )
  })

  it('builds branch-cache rows from the same renderable text', () => {
    const user = message({ id: 'u', role: 'user', content: [{ type: 'text', text: 'Hi there' }] })
    const assistant = message({
      id: 'a',
      role: 'assistant',
      parentId: user.id,
      createdAt: 2,
      editedAt: 5,
      content: [{ type: 'output_text', text: 'Hello back' }],
    })
    const row = buildBranchCacheRow({
      chatId: 'c',
      branchLeafId: assistant.id,
      messages: [user, assistant],
      generatedAt: 10,
    })
    expect(row).toMatchObject({
      chatId: 'c',
      branchLeafId: 'a',
      generatedAt: 10,
      previewText: 'Hello back',
      messageCount: 2,
      wordCount: 4,
      messageTimestamps: [
        { id: 'u', createdAt: 1, editedAt: 1 },
        { id: 'a', createdAt: 2, editedAt: 5 },
      ],
    })
    expect(row.textContent).toBe('USER:\nHi there\n\nASSISTANT:\nHello back\n')
  })

  it('exports the active cursor branch with dated slug filenames', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-26T12:00:00.000Z'))
    const user = message({
      id: 'u',
      role: 'user',
      content: [{ type: 'text', text: 'active user' }],
    })
    const stale = message({
      id: 'old',
      parentId: user.id,
      siblingIndex: 0,
      createdAt: 2,
      content: [{ type: 'text', text: 'old branch' }],
    })
    const active = message({
      id: 'active',
      parentId: user.id,
      siblingIndex: 1,
      createdAt: 3,
      content: [{ type: 'text', text: 'current branch' }],
    })
    const repo = {
      getChat: vi.fn(async () => fullChat({ title: 'Branching Deep Dive' })),
      getActiveBranchSnapshot: vi.fn(async () => ({
        chatId: 'c',
        branch: [user, active],
        allHeaders: [user, stale, active],
        branchHeaders: [user, active],
        siblingGroups: [],
        treeKey: 'tree',
      })),
    } as unknown as WorkspaceRepository

    const out = await exportActiveBranchAsTxt(repo, 'c', { u: 'active' })

    expect(out.filename).toBe('branching-deep-dive-2026-04-26.txt')
    expect(out.content).toBe(
      '# Branching Deep Dive\n\nUSER:\nactive user\n\nUSER:\ncurrent branch\n',
    )
  })

  it('uses a chat-id fallback filename for untitled exports', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-26T12:00:00.000Z'))
    const repo = {
      getChat: vi.fn(async () =>
        fullChat({
          id: '01UNTITLEDXYZ',
          title: 'Untitled chat',
          titleStatus: 'untitled',
        }),
      ),
      getActiveBranchSnapshot: vi.fn(async () => ({
        chatId: 'c',
        branch: [],
        allHeaders: [],
        branchHeaders: [],
        siblingGroups: [],
        treeKey: '',
      })),
    } as unknown as WorkspaceRepository

    const out = await exportActiveBranchAsTxt(repo, 'c', {})

    expect(out.filename).toBe('chat-01UNTITL-2026-04-26.txt')
    expect(out.content).toBe('# Untitled chat\n')
  })

  it('exports last-updated text from a fresh cache without loading messages', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-26T12:00:00.000Z'))
    const listMessages = vi.fn(async () => {
      throw new Error('should not load messages')
    })
    const repo = {
      getChat: vi.fn(async () =>
        fullChat({
          title: 'Cached branch',
          lastUpdatedLeafId: 'a',
          lastBranchUpdatedAt: 5,
        }),
      ),
      getChatBranchCache: vi.fn(async () => ({
        chatId: 'c',
        branchLeafId: 'a',
        generatedAt: 10,
        textContent: 'USER:\nfrom cache\n',
        previewText: 'from cache',
        messageCount: 1,
        wordCount: 2,
        messageTimestamps: [],
      })),
      listMessages,
    } as unknown as WorkspaceRepository

    const out = await exportLastUpdatedBranchAsTxt(repo, 'c')

    expect(out.content).toBe('# Cached branch\n\nUSER:\nfrom cache\n')
    expect(listMessages).not.toHaveBeenCalled()
  })

  it('refreshes stale last-updated cache through the repository', async () => {
    const user = message({ id: 'u', content: [{ type: 'text', text: 'fresh user' }] })
    const assistant = message({
      id: 'a',
      role: 'assistant',
      parentId: user.id,
      createdAt: 2,
      content: [{ type: 'output_text', text: 'fresh assistant' }],
    })
    const putChatBranchCache = vi.fn(async (row: ChatBranchCache) => row)
    const repo = {
      getChat: vi.fn(async () =>
        fullChat({
          title: 'Freshened branch',
          lastUpdatedLeafId: 'a',
          lastBranchUpdatedAt: 20,
        }),
      ),
      getChatBranchCache: vi.fn(async () => ({
        chatId: 'c',
        branchLeafId: 'a',
        generatedAt: 10,
        textContent: 'stale',
        previewText: 'stale',
        messageCount: 1,
        wordCount: 1,
        messageTimestamps: [],
      })),
      getBranchByLeaf: vi.fn(async () => [user, assistant]),
      putChatBranchCache,
    } as unknown as WorkspaceRepository

    const out = await exportLastUpdatedBranchAsTxt(repo, 'c')

    expect(out.content).toBe(
      '# Freshened branch\n\nUSER:\nfresh user\n\nASSISTANT:\nfresh assistant\n',
    )
    expect(putChatBranchCache).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'c',
        branchLeafId: 'a',
        previewText: 'fresh assistant',
      }),
    )
  })
})
