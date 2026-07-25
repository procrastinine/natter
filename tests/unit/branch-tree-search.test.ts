import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSearchQuery } from '../../src/core/search-query'
import type { Message } from '../../src/core/types'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { splitMessageForStorage } from '../../src/store/message-storage'
import type { WorkspaceQuery, WorkspaceQueryResult } from '../../src/store/workspace-protocol'
import { getWorkspaceRepository } from '../../src/store/workspace-repository'
import { runWorkspaceRead } from '../../src/store/workspace-runtime'

function message(id: string, text: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    chatId: 'tree-search-chat',
    parentId: null,
    siblingIndex: 0,
    turnId: `turn-${id}`,
    turnIndex: 0,
    createdAt: 1,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}

async function putMessage(row: Message): Promise<void> {
  const stored = splitMessageForStorage(row)
  await getDb().messages.put(stored.header)
  await getDb().messageBodies.put(stored.body)
  await getDb().messagePreviews.put(stored.preview)
}

async function resetAll(): Promise<void> {
  __resetDbForTests()
  await Dexie.delete('natter')
}

beforeEach(async () => {
  await resetAll()
  await openBrowserWorkspace()
})

afterEach(async () => {
  await shutdownBrowserWorkspace()
  await resetAll()
})

describe('branch-tree text reads', () => {
  it('returns every live matching node in only the requested chat', async () => {
    await putMessage(message('first', 'Alpha NEEDLE'))
    await putMessage(
      message('second', '', {
        content: [
          { type: 'text', text: 'needle' },
          { type: 'output_text', text: 'across items' },
        ],
      }),
    )
    await putMessage(message('deleted', 'needle', { deleted: true }))
    await putMessage(message('other-chat', 'needle', { chatId: 'other' }))

    await expect(searchMessageIds('tree-search-chat', 'NeEdLe')).resolves.toEqual(
      expect.arrayContaining(['first', 'second']),
    )
    expect(await searchMessageIds('tree-search-chat', 'NeEdLe')).toHaveLength(2)
  })

  it('returns a bounded plaintext preview without hydrating the full message', async () => {
    await putMessage(message('long', `  ${'word '.repeat(500)}`))
    const preview = await messagePreview('long')
    expect(preview?.length).toBeLessThanOrEqual(240)
    expect(preview?.endsWith('…')).toBe(true)
    const richerPreview = await messagePreview('long', 960)
    expect(richerPreview?.length).toBe(960)
    expect(richerPreview?.endsWith('…')).toBe(true)
  })

  it('rejects an already-cancelled preview read', async () => {
    await putMessage(message('preview-cancelled', 'preview'))
    const controller = new AbortController()
    controller.abort()
    await expect(messagePreview('preview-cancelled', 240, controller.signal)).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    )
  })

  it('rejects an already-cancelled search before retaining results', async () => {
    await putMessage(message('match', 'needle'))
    const controller = new AbortController()
    controller.abort()
    await expect(
      searchMessageIds('tree-search-chat', 'needle', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

async function searchMessageIds(
  chatId: string,
  text: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const parsed = parseSearchQuery(text)
  if (!parsed.ok) throw new Error(parsed.error.message)
  const result = await query(
    {
      kind: 'message.search-corpus',
      request: { chatId, clauses: parsed.query.text, collectMatchingMessageIds: true },
    },
    signal,
  )
  return result.matchingMessageIds
}

async function messagePreview(
  messageId: string,
  maxChars = 240,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const header = await getDb().messages.get(messageId)
  if (!header) return undefined
  const rows = await query(
    {
      kind: 'message.preview-window',
      targets: [{ messageId, bodyVersion: header.bodyVersion }],
      maxChars,
    },
    signal,
  )
  return rows[0]?.text
}

function query<Q extends WorkspaceQuery>(
  request: Q,
  signal?: AbortSignal,
): Promise<WorkspaceQueryResult<Q>> {
  return runWorkspaceRead(
    'repository-query',
    async (permit) =>
      (
        await getWorkspaceRepository().query(
          permit,
          request,
          signal === undefined ? {} : { signal },
        )
      ).value,
    signal === undefined ? {} : { signal },
  )
}
