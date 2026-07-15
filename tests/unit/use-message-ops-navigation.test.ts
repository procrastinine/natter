import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile, Message } from '../../src/core/types'
import {
  editAndResend,
  type MessageOpsContext,
  mutateMessageAttachmentReference,
  regenerateFromMessage,
} from '../../src/hooks/useMessageOps'
import { splitMessageForStorage } from '../../src/store/message-storage'
import { useChatStore } from '../../src/store/zustand/chatStore'

const mocks = vi.hoisted(() => ({
  bumpPresetLastUsedAt: vi.fn(),
  bumpProfileLastUsedAt: vi.fn(),
  getChat: vi.fn(),
  getBranchHeaderSnapshotByLeaf: vi.fn(),
  getMessageHeader: vi.fn(),
  getProfile: vi.fn(),
  insertSibling: vi.fn(),
  mutateMessageAttachmentRef: vi.fn(),
  resolveConnectionRuntimeKeys: vi.fn(),
}))

vi.mock('../../src/store/attachments', () => ({
  mutateMessageAttachmentRef: mocks.mutateMessageAttachmentRef,
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

function navigationCounter(revision: string): bigint {
  const separator = revision.lastIndexOf(':')
  if (separator < 0) throw new Error(`InvalidNavigationRevision:${revision}`)
  return BigInt(revision.slice(separator + 1))
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

function insertedSiblingResult(
  messageId: string,
  path: Array<{ id: string; parentId: string | null; role: Message['role'] }> = [
    { id: messageId, parentId: null, role: 'user' },
  ],
) {
  const pathMessages = path.map((item, index) =>
    message({
      id: item.id,
      parentId: item.parentId,
      role: item.role,
      origin: item.role === 'assistant' ? 'generated' : 'user',
      content: [
        item.role === 'assistant'
          ? { type: 'output_text' as const, text: item.id }
          : { type: 'text' as const, text: item.id },
      ],
      createdAt: index + 1,
    }),
  )
  const inserted = pathMessages.at(-1)
  if (!inserted || inserted.id !== messageId) throw new Error('invalid inserted sibling fixture')
  const header = splitMessageForStorage(inserted).header
  return {
    messageId,
    message: inserted,
    header,
    branchHeaders: pathMessages.map((row) => splitMessageForStorage(row).header),
    effects: { cursorUpdates: { [inserted.parentId ?? '__root__']: messageId } },
    versions: { metaVersion: 0, summaryVersion: 0 },
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
    expect(navigationCounter(olderRevision)).toBeGreaterThan(0n)

    const newer = regenerateFromMessage(ctx, message())
    const newerRevision = useChatStore.getState().getNavigationRevision('chat-1')
    expect(navigationCounter(newerRevision)).toBeGreaterThan(navigationCounter(olderRevision))
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
      .mockResolvedValueOnce(insertedSiblingResult('new-user-2'))
      .mockResolvedValueOnce(insertedSiblingResult('new-user-1'))

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
    expect(navigationCounter(olderRevision)).toBeGreaterThan(0n)

    const newer = editAndResend(ctx, originalUser, 'newer')
    const newerRevision = useChatStore.getState().getNavigationRevision('chat-1')
    expect(navigationCounter(newerRevision)).toBeGreaterThan(navigationCounter(olderRevision))
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
    mocks.insertSibling.mockResolvedValue(
      insertedSiblingResult('new-user', [
        { id: 'target-root', parentId: null, role: 'user' },
        { id: 'target-parent', parentId: 'target-root', role: 'assistant' },
        { id: 'new-user', parentId: 'target-parent', role: 'user' },
      ]),
    )
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
      pathMessageIds: ['target-root', 'target-parent', 'new-user'],
    })
    expect(mocks.getBranchHeaderSnapshotByLeaf).not.toHaveBeenCalled()
  })
})

describe('same-tab exact message presentations', () => {
  it('publishes an attachment mutation against the captured path after route authority moves', async () => {
    const before = message({ id: 'assistant-1', parentId: null })
    const beforeHeader = splitMessageForStorage(before).header
    const intent = useChatStore.getState().beginNavigationIntent('chat-1')
    useChatStore
      .getState()
      .selectPathForIntent('chat-1', intent, { __root__: before.id }, [before.id])
    useChatStore.getState().beginNavigationIntent('chat-2')

    const after: Message = {
      ...before,
      attachmentRefs: [
        {
          refId: 'ref-1',
          attachmentId: 'attachment-1',
          includeInContext: false,
          presentation: {},
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      nodeVersion: before.nodeVersion + 1,
    }
    const afterHeader = splitMessageForStorage(after, {
      bodyVersion: beforeHeader.bodyVersion + 1,
    }).header
    mocks.mutateMessageAttachmentRef.mockResolvedValue({
      header: afterHeader,
      message: after,
      bodyVersion: afterHeader.bodyVersion,
    })

    await mutateMessageAttachmentReference(
      'chat-1',
      before.id,
      { kind: 'visibility', refId: 'ref-1', includeInContext: false },
      { pathHeaders: [beforeHeader] },
    )

    const receipt = useChatStore.getState().getCommittedPathPresentation('chat-1')
    expect(receipt).toMatchObject({
      phase: 'terminal',
      pathHeaders: [expect.objectContaining({ id: before.id })],
      presentations: [
        expect.objectContaining({
          bodyVersion: afterHeader.bodyVersion,
        }),
      ],
    })
    expect(receipt?.presentations[0]?.message.attachmentRefs).toEqual(after.attachmentRefs)
    expect(useChatStore.getState().getCursor('chat-2')).toEqual({})
  })
})
