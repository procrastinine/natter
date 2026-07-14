import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile, Message } from '../../src/core/types'
import {
  editAndResend,
  type MessageOpsContext,
  regenerateFromMessage,
} from '../../src/hooks/useMessageOps'
import { useChatStore } from '../../src/store/zustand/chatStore'

const mocks = vi.hoisted(() => ({
  bumpPresetLastUsedAt: vi.fn(),
  bumpProfileLastUsedAt: vi.fn(),
  getChat: vi.fn(),
  getBranchHeaderSnapshotByLeaf: vi.fn(),
  getMessageHeader: vi.fn(),
  getProfile: vi.fn(),
  insertSibling: vi.fn(),
  resolveConnectionRuntimeKeys: vi.fn(),
}))

vi.mock('../../src/core/messages', () => ({
  deletePair: vi.fn(),
  deleteSingleMessage: vi.fn(),
  deleteTurn: vi.fn(),
  deleteVariant: vi.fn(),
  editMessageContent: vi.fn(),
  insertSibling: mocks.insertSibling,
}))

vi.mock('../../src/store/chats', () => ({ getChat: mocks.getChat }))
vi.mock('../../src/store/connection-runtime', () => ({
  resolveConnectionRuntimeKeys: mocks.resolveConnectionRuntimeKeys,
}))
vi.mock('../../src/store/presets', () => ({
  bumpPresetLastUsedAt: mocks.bumpPresetLastUsedAt,
}))
vi.mock('../../src/store/profiles', () => ({
  bumpProfileLastUsedAt: mocks.bumpProfileLastUsedAt,
  getProfile: mocks.getProfile,
}))
vi.mock('../../src/store/workspace-repository', () => ({
  getWorkspaceRepository: () => ({
    getBranchHeaderSnapshotByLeaf: mocks.getBranchHeaderSnapshotByLeaf,
    getMessageHeader: mocks.getMessageHeader,
  }),
}))
vi.mock('../../src/hooks/useContinue', () => ({ continueAssistantInPlace: vi.fn() }))

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const chat = {
  id: 'chat-1',
  settings: { profileId: 'profile-1', model: 'model-1' },
}

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Profile',
  kind: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKeyRef: 'key-1',
  defaultHeaders: {},
  appTitle: 'Natter',
  appUrl: 'http://localhost',
  supportsEndpointsApi: true,
  supportsGenerationApi: true,
  supportsPrivacyScrape: true,
  createdAt: 1,
  updatedAt: 1,
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'assistant-1',
    chatId: 'chat-1',
    parentId: 'stale-parent',
    siblingIndex: 0,
    turnId: 'turn-1',
    turnIndex: 0,
    createdAt: 1,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'output_text', text: 'answer' }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  useChatStore.getState().reset()
  mocks.getProfile.mockResolvedValue(profile)
  mocks.getBranchHeaderSnapshotByLeaf.mockImplementation(
    async (_chatId: string, leafId: string) => ({
      chat,
      chatId: 'chat-1',
      branchHeaders: [{ id: leafId, parentId: null }],
    }),
  )
  mocks.resolveConnectionRuntimeKeys.mockResolvedValue([])
  mocks.bumpProfileLastUsedAt.mockResolvedValue(undefined)
  mocks.bumpPresetLastUsedAt.mockResolvedValue(undefined)
})

describe('message generation navigation intents', () => {
  it('propagates the exact assistant target into the regenerate send', async () => {
    mocks.getChat.mockResolvedValue(chat)
    mocks.getMessageHeader.mockResolvedValue({
      ...message(),
      content: undefined,
      parentId: 'fresh-parent',
      textPreview: 'answer',
    })
    const sendFrom = vi.fn(async (input: Parameters<MessageOpsContext['sendFrom']>[0]) => ({
      streamId: 'regenerate-stream',
      userMessageId: input.parentMessageId,
      assistantMessageId: 'generated-assistant',
      outcome: 'done' as const,
    }))

    await regenerateFromMessage({ chatId: 'chat-1', sendFrom }, message())

    expect(sendFrom).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        parentMessageId: 'fresh-parent',
        regenerateTargetMessageId: 'assistant-1',
      }),
    )
  })

  it('keeps a newer regenerate selected when an older operation resumes later', async () => {
    const olderChatRead = deferred<typeof chat>()
    mocks.getChat.mockImplementationOnce(() => olderChatRead.promise).mockResolvedValueOnce(chat)
    mocks.getMessageHeader.mockResolvedValue({
      ...message(),
      content: undefined,
      parentId: 'fresh-parent',
      textPreview: 'answer',
    })

    const sendFrom = vi.fn(async (input: Parameters<MessageOpsContext['sendFrom']>[0]) => {
      const assistantMessageId = `generated-${input.navigationIntent.revision}`
      useChatStore.getState().selectPathForIntent(input.chatId, input.navigationIntent, {
        [input.parentMessageId]: assistantMessageId,
      })
      return {
        streamId: `stream-${input.navigationIntent.revision}`,
        userMessageId: input.parentMessageId,
        assistantMessageId,
        outcome: 'done' as const,
      }
    })
    const ctx: MessageOpsContext = { chatId: 'chat-1', sendFrom }

    const older = regenerateFromMessage(ctx, message())
    const olderRevision = useChatStore.getState().getNavigationRevision('chat-1')
    expect(BigInt(olderRevision)).toBeGreaterThan(0n)

    const newer = regenerateFromMessage(ctx, message())
    const newerRevision = useChatStore.getState().getNavigationRevision('chat-1')
    expect(BigInt(newerRevision)).toBeGreaterThan(BigInt(olderRevision))
    await newer
    expect(useChatStore.getState().getCursor('chat-1')).toEqual({
      'fresh-parent': `generated-${newerRevision}`,
    })

    olderChatRead.resolve(chat)
    await older

    expect(useChatStore.getState().getCursor('chat-1')).toEqual({
      'fresh-parent': `generated-${newerRevision}`,
    })
    expect(sendFrom.mock.calls.map(([input]) => input.navigationIntent.revision)).toEqual([
      newerRevision,
      olderRevision,
    ])
    expect(sendFrom.mock.calls.map(([input]) => input.parentMessageId)).toEqual([
      'fresh-parent',
      'fresh-parent',
    ])
  })

  it('does not let a superseded edit-and-resend select its late sibling', async () => {
    const olderChatRead = deferred<typeof chat>()
    mocks.getChat.mockImplementationOnce(() => olderChatRead.promise).mockResolvedValueOnce(chat)
    mocks.insertSibling
      .mockResolvedValueOnce({
        messageId: 'new-user-2',
        effects: { cursorUpdates: { __root__: 'new-user-2' } },
        versions: {},
      })
      .mockResolvedValueOnce({
        messageId: 'new-user-1',
        effects: { cursorUpdates: { __root__: 'new-user-1' } },
        versions: {},
      })

    const sendFrom = vi.fn(async (input: Parameters<MessageOpsContext['sendFrom']>[0]) => ({
      streamId: `stream-${input.navigationIntent.revision}`,
      userMessageId: input.parentMessageId,
      assistantMessageId: `assistant-${input.navigationIntent.revision}`,
      outcome: 'done' as const,
    }))
    const ctx: MessageOpsContext = { chatId: 'chat-1', sendFrom }
    const originalUser = message({
      id: 'user-1',
      parentId: null,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'prompt' }],
    })

    const older = editAndResend(ctx, originalUser, 'older')
    const olderRevision = useChatStore.getState().getNavigationRevision('chat-1')
    expect(BigInt(olderRevision)).toBeGreaterThan(0n)

    const newer = editAndResend(ctx, originalUser, 'newer')
    const newerRevision = useChatStore.getState().getNavigationRevision('chat-1')
    expect(BigInt(newerRevision)).toBeGreaterThan(BigInt(olderRevision))
    await newer
    expect(useChatStore.getState().getCursor('chat-1')).toEqual({ __root__: 'new-user-2' })

    olderChatRead.resolve(chat)
    await older

    expect(useChatStore.getState().getCursor('chat-1')).toEqual({ __root__: 'new-user-2' })
    expect(sendFrom.mock.calls.map(([input]) => input.navigationIntent.revision)).toEqual([
      newerRevision,
      olderRevision,
    ])
    expect(sendFrom.mock.calls.map(([input]) => input.parentMessageId)).toEqual([
      'new-user-2',
      'new-user-1',
    ])
  })

  it('selects the complete off-path inserted branch before assistant planning starts', async () => {
    mocks.getChat.mockResolvedValue(chat)
    mocks.insertSibling.mockResolvedValue({
      messageId: 'new-user',
      effects: { cursorUpdates: { 'target-parent': 'new-user' } },
      versions: {},
    })
    mocks.getBranchHeaderSnapshotByLeaf.mockResolvedValue({
      chat,
      chatId: 'chat-1',
      branchHeaders: [
        { id: 'target-root', parentId: null },
        { id: 'target-parent', parentId: 'target-root' },
        { id: 'new-user', parentId: 'target-parent' },
      ],
    })
    useChatStore.getState().navigateToCursor('chat-1', {
      __root__: 'other-root',
      'other-root': 'other-leaf',
    })
    const sendFrom = vi.fn(async () => {
      expect(useChatStore.getState().getCursor('chat-1')).toMatchObject({
        __root__: 'target-root',
        'target-root': 'target-parent',
        'target-parent': 'new-user',
      })
      throw new Error('planning failed')
    })

    await expect(
      editAndResend(
        { chatId: 'chat-1', sendFrom },
        message({
          id: 'original-user',
          parentId: 'target-parent',
          role: 'user',
          origin: 'user',
        }),
        'edited prompt',
      ),
    ).rejects.toThrow('planning failed')

    expect(useChatStore.getState().getCursor('chat-1')).toMatchObject({
      __root__: 'target-root',
      'target-root': 'target-parent',
      'target-parent': 'new-user',
    })
    expect(useChatStore.getState().getPendingBranchNavigation('chat-1')).toMatchObject({
      targetMessageId: 'new-user',
      pathMessageIds: ['target-root', 'target-parent', 'new-user'],
    })
  })
})
