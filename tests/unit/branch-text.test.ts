import { describe, expect, it, vi } from 'vitest'
import { flattenBranchMessages } from '../../src/core/branch-flatten'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, Message } from '../../src/core/types'
import {
  consumeLastUpdatedBranchText,
  readBranchText,
  readLastUpdatedBranchText,
} from '../../src/store/branch-text'
import { splitMessageForStorage } from '../../src/store/message-storage'
import type {
  WorkspaceQuery,
  WorkspaceReadAuthority,
  WorkspaceRepository,
} from '../../src/store/workspace-protocol'

const authority = {
  signal: new AbortController().signal,
} as WorkspaceReadAuthority

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: 'chat',
    title: 'Bounded branch',
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

function branch(length: number, prefix = 'message'): Message[] {
  const messages: Message[] = []
  for (let index = 0; index < length; index += 1) {
    const parent = messages.at(-1)
    messages.push({
      id: `m-${index}`,
      chatId: 'chat',
      parentId: parent?.id ?? null,
      siblingIndex: 0,
      turnId: `turn-${index}`,
      turnIndex: index,
      createdAt: index + 1,
      role: index % 2 === 0 ? 'user' : 'assistant',
      origin: index % 2 === 0 ? 'user' : 'generated',
      content: [{ type: index % 2 === 0 ? 'text' : 'output_text', text: `${prefix}-${index}` }],
      nodeVersion: 0,
      deleted: false,
    })
  }
  return messages
}

function repositoryFor(
  messages: readonly Message[],
  options: { stalePageOnceAtOffset?: number } = {},
): { repo: WorkspaceRepository; pageWindows: Array<{ offset: number; limit: number }> } {
  const presentations = messages.map((message) => {
    const { header } = splitMessageForStorage(message)
    return { header, message, bodyVersion: header.bodyVersion }
  })
  const headers = presentations.map((presentation) => presentation.header)
  const presentationsById = new Map(
    presentations.map((presentation) => [presentation.message.id, presentation]),
  )
  const currentChat = chat({ lastUpdatedLeafId: messages.at(-1)?.id ?? null })
  const pageWindows: Array<{ offset: number; limit: number }> = []
  let staleReturned = false
  const query = vi.fn(async (_authority: unknown, request: WorkspaceQuery) => {
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
      case 'branch.open':
        value = {
          kind: 'ready',
          chat: currentChat,
          target: request.target,
          proof: {
            chatId: currentChat.id,
            structuralVersion: currentChat.structuralVersion,
            tipId: messages.at(-1)?.id ?? null,
            pathHeaders: headers,
          },
          presentations: [],
        }
        break
      case 'branch.page-structure': {
        pageWindows.push({ offset: request.window.offset, limit: request.window.nodes.length })
        if (!staleReturned && request.window.offset === options.stalePageOnceAtOffset) {
          staleReturned = true
          value = { kind: 'stale-path', chatId: currentChat.id, reason: 'body-version-mismatch' }
          break
        }
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
      }
      case 'message.presentations':
        value = request.messageIds.map((messageId) => presentationsById.get(messageId))
        break
    }
    return { workspaceId: 'workspace', replacementEpoch: 0, value }
  })
  return {
    repo: {
      query,
      execute: vi.fn(),
      replace: vi.fn(),
      subscribeChanges: vi.fn(() => () => undefined),
    } as unknown as WorkspaceRepository,
    pageWindows,
  }
}

describe('canonical branch text reader', () => {
  it('reads bodies in bounded physical pages while preserving exact export text', async () => {
    const messages = branch(61)
    const { repo, pageWindows } = repositoryFor(messages)

    const result = await readLastUpdatedBranchText(repo, authority, 'chat')

    expect(result?.textContent).toBe(
      flattenBranchMessages(messages, undefined, { includeTitle: false }),
    )
    expect(pageWindows).toEqual([
      { offset: 0, limit: 24 },
      { offset: 24, limit: 24 },
      { offset: 48, limit: 13 },
    ])
  })

  it('resets partial output and retries the canonical read after a stale page', async () => {
    const messages = branch(30, 'fresh')
    const { repo, pageWindows } = repositoryFor(messages, { stalePageOnceAtOffset: 24 })

    const result = await readLastUpdatedBranchText(repo, authority, 'chat')

    expect(result?.textContent).toBe(
      flattenBranchMessages(messages, undefined, { includeTitle: false }),
    )
    expect(pageWindows.map((page) => page.offset)).toEqual([0, 24, 0, 24])
    expect(result?.textContent.match(/fresh-0/g)).toHaveLength(1)
  })

  it('uses the same reader for an explicit per-tab branch target', async () => {
    const messages = branch(31)
    const { repo, pageWindows } = repositoryFor(messages)

    const result = await readBranchText(repo, authority, 'chat', messages.at(-1)?.id ?? null)

    expect(result?.branchLeafId).toBe('m-30')
    expect(pageWindows.every((page) => page.limit <= 24)).toBe(true)
  })

  it('lets search-like consumers retain bounded state instead of a whole branch string', async () => {
    const messages = branch(80)
    const { repo } = repositoryFor(messages)
    let retained = ''
    let resets = 0

    const result = await consumeLastUpdatedBranchText(repo, authority, 'chat', {
      reset: () => {
        resets += 1
        retained = ''
      },
      push: (segment) => {
        retained = (retained + segment).slice(-96)
      },
    })

    expect(result?.branchLeafId).toBe('m-79')
    expect(resets).toBe(1)
    expect(retained.length).toBeLessThanOrEqual(96)
    expect(retained).toContain('message-79')
  })
})
