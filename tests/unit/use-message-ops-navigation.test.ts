import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/core/types'
import {
  continueFromMessage,
  editAndResend,
  mutateMessageAttachmentReference,
  regenerateFromMessage,
  replyToMessage,
  sendMessage,
  sendNewChat,
} from '../../src/store/conversation-command-client'
import { createConversationRouteOwnerController } from '../../src/store/conversation-route-owner'
import type {
  GenerationHandle,
  GenerationStartResult,
  PreparedGeneration,
} from '../../src/store/generation-engine'

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  mutateAttachment: vi.fn(),
}))

function requireStarted(result: GenerationStartResult): GenerationHandle<PreparedGeneration> {
  if (result.kind === 'started') return result.handle
  const capability = result.capability
  const detail = capability.state === 'unavailable' ? capability.reason : capability.owner
  throw new Error(`GenerationTestNotStarted:${capability.state}:${detail}`)
}

vi.mock('../../src/store/generation-engine', () => ({
  generationEngine: { start: mocks.start },
}))

vi.mock('../../src/store/attachments', () => ({
  mutateMessageAttachmentRef: mocks.mutateAttachment,
}))

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'assistant-1',
    chatId: 'chat-1',
    parentId: 'user-1',
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
  mocks.start.mockReturnValue({
    kind: 'started',
    handle: {
      streamId: 'stream-1',
      chatId: 'chat-1',
      prepared: Promise.resolve({
        streamId: 'stream-1',
        chatId: 'chat-1',
        assistantMessageId: 'assistant-new',
      }),
      completed: Promise.resolve({
        streamId: 'stream-1',
        chatId: 'chat-1',
        assistantMessageId: 'assistant-new',
        outcome: 'done',
      }),
      abort: vi.fn(),
    },
  })
})

describe('conversation command generation intents', () => {
  it('propagates the exact assistant target into regenerate', async () => {
    requireStarted(
      regenerateFromMessage({ chatId: 'chat-1' }, message(), {
        settingsPatch: { model: 'model-2' },
      }),
    )

    expect(mocks.start).toHaveBeenCalledWith({
      intent: {
        kind: 'regenerate',
        chatId: 'chat-1',
        targetAssistantId: 'assistant-1',
        settingsPatch: { model: 'model-2' },
      },
    })
  })

  it('propagates the exact user target and payload into edit-and-resend', async () => {
    const original = message({
      id: 'user-1',
      parentId: null,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'before' }],
    })
    requireStarted(
      editAndResend({ chatId: 'chat-1' }, original, 'after', {
        prefillContent: [{ type: 'text', text: 'prefill' }],
        attachmentRefs: [
          {
            refId: 'ref-1',
            attachmentId: 'attachment-1',
            includeInContext: true,
            presentation: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    )

    expect(mocks.start).toHaveBeenCalledWith({
      intent: {
        kind: 'edit-resend',
        chatId: 'chat-1',
        targetUserId: 'user-1',
        content: [{ type: 'text', text: 'after' }],
        prefillContent: [{ type: 'text', text: 'prefill' }],
        attachmentRefs: [
          {
            refId: 'ref-1',
            attachmentId: 'attachment-1',
            includeInContext: true,
            presentation: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    })
  })

  it('keeps Continue in place by targeting the existing assistant identity', async () => {
    requireStarted(continueFromMessage({ chatId: 'chat-1' }, message()))

    expect(mocks.start).toHaveBeenCalledWith({
      intent: {
        kind: 'continue',
        chatId: 'chat-1',
        targetAssistantId: 'assistant-1',
      },
    })
  })

  it('routes ordinary send, reply, and new-chat send through the same engine', async () => {
    const routeOwner = createConversationRouteOwnerController().owner
    requireStarted(sendMessage('chat-1', 'expected-leaf', [{ type: 'text', text: 'send' }]))
    requireStarted(replyToMessage('chat-1', 'user-1'))
    requireStarted(sendNewChat([{ type: 'text', text: 'new chat' }], routeOwner))

    expect(mocks.start.mock.calls).toEqual([
      [
        {
          intent: {
            kind: 'send',
            chatId: 'chat-1',
            expectedLeafId: 'expected-leaf',
            content: [{ type: 'text', text: 'send' }],
          },
        },
      ],
      [{ intent: { kind: 'reply', chatId: 'chat-1', parentUserId: 'user-1' } }],
      [
        {
          intent: {
            kind: 'new-chat-send',
            content: [{ type: 'text', text: 'new chat' }],
          },
          routeOwner,
        },
      ],
    ])
  })

  it('fails loudly when the total start contract refuses the intent', () => {
    mocks.start.mockReturnValueOnce({
      kind: 'not-started',
      capability: { state: 'pending', owner: 'configuration' },
    })

    expect(() =>
      requireStarted(sendMessage('chat-1', 'expected-leaf', [{ type: 'text', text: 'send' }])),
    ).toThrow('GenerationTestNotStarted:pending:configuration')
  })
})

describe('conversation command non-generation delegation', () => {
  it('delegates attachment visibility mutation without retaining branch state', async () => {
    const mutation = {
      kind: 'visibility' as const,
      refId: 'ref-1',
      expectedAttachmentId: 'attachment-1',
      includeInContext: false,
    }
    mocks.mutateAttachment.mockResolvedValue(undefined)

    await mutateMessageAttachmentReference('chat-1', 'assistant-1', mutation)

    expect(mocks.mutateAttachment).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'assistant-1',
      mutation,
    })
  })
})
