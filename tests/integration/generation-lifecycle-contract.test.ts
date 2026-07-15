import { render, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../src/api/errors'
import type { ChatStreamChunk } from '../../src/api/types'
import { createMessageTreeProjection } from '../../src/core/active-path'
import { layoutBranchTree } from '../../src/core/branch-tree-layout'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings, ConnectionProfile, ContentItem, Message } from '../../src/core/types'
import { recoverOrphans, sendText } from '../../src/hooks/useChat'
import { continueAssistantInPlace } from '../../src/hooks/useContinue'
import { __resetBroadcastForTests, type BroadcastEvent, onEvent } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { createChat } from '../../src/store/chats'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { putCachedEndpoints } from '../../src/store/models-cache'
import {
  __flushStreamLeaseWritesForTests,
  __resetStreamLeasesForTests,
} from '../../src/store/stream-leases'
import { useAnnouncementStore } from '../../src/store/zustand/announcementStore'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { useStreamStore } from '../../src/store/zustand/streamStore'
import { useUiStore } from '../../src/store/zustand/uiStore'
import { BranchTreeView } from '../../src/ui/chat/BranchTreeView'

const DB_NAME = 'natter'
const MODEL = 'openai/gpt-4o'

function profile(): ConnectionProfile {
  return {
    id: 'lifecycle-profile',
    name: 'Lifecycle profile',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'lifecycle-key',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: 'http://localhost:5173',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function settings(): ChatSettings {
  const base = cloneDefaultChatSettings()
  return {
    ...base,
    profileId: 'lifecycle-profile',
    model: MODEL,
    reasoning: {
      mode: 'off',
      exclude: false,
      summary: 'off',
      include: { encrypted: false, summary: false, text: false },
    },
  }
}

function chunkFence(lease: { streamId: string; fenceToken?: string; replacementEpoch?: number }) {
  if (typeof lease.fenceToken !== 'string' || lease.replacementEpoch === undefined) {
    throw new Error(`expected fenced lease ${lease.streamId}`)
  }
  return { fenceToken: lease.fenceToken, replacementEpoch: lease.replacementEpoch }
}

async function reset(): Promise<void> {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetStreamLeasesForTests()
  useChatStore.getState().reset()
  useAnnouncementStore.getState().reset()
  useStreamStore.getState().reset()
  useUiStore.getState().reset()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await reset()
  await openDb()
  await putCachedEndpoints('lifecycle-profile', MODEL, {
    id: MODEL,
    endpoints: [
      {
        provider_name: 'Lifecycle provider',
        provider_slug: 'lifecycle-provider',
        supported_parameters: ['temperature'],
        context_length: 200_000,
        pricing: {},
        data_policy: {
          training: false,
          training_openrouter: false,
          retains_prompts: false,
          can_publish: false,
        },
      },
    ],
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await reset()
})

function captureBroadcasts(): { events: BroadcastEvent[]; stop: () => void } {
  const events: BroadcastEvent[] = []
  return {
    events,
    stop: onEvent((event) => events.push(event)),
  }
}

function streamEvents(
  events: readonly BroadcastEvent[],
): Array<Extract<BroadcastEvent, { kind: 'stream-started' | 'stream-ended' }>> {
  return events.filter(
    (event): event is Extract<BroadcastEvent, { kind: 'stream-started' | 'stream-ended' }> =>
      event.kind === 'stream-started' || event.kind === 'stream-ended',
  )
}

function expectLifecycle(
  events: readonly BroadcastEvent[],
  expected: { chatId: string; messageId: string; outcome: 'done' | 'error' | 'abort' },
): string {
  const lifecycle = streamEvents(events)
  expect(lifecycle).toHaveLength(3)
  const [admitted, published, ended] = lifecycle
  expect(admitted).toMatchObject({
    kind: 'stream-started',
    replacementEpoch: 0,
    chatId: expected.chatId,
    messageId: expected.messageId,
  })
  expect(published).toMatchObject({
    kind: 'stream-started',
    replacementEpoch: 0,
    chatId: expected.chatId,
    messageId: expected.messageId,
  })
  expect(ended).toMatchObject({
    kind: 'stream-ended',
    replacementEpoch: 0,
    chatId: expected.chatId,
    messageId: expected.messageId,
    outcome: expected.outcome,
  })
  expect(published?.streamId).toBe(admitted?.streamId)
  expect(ended?.streamId).toBe(admitted?.streamId)
  return expectDefined(admitted?.streamId, 'stream id')
}

async function eventually(assertion: () => Promise<void> | void): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  throw lastError
}

function expectDefined<T>(value: T | undefined, label: string): T {
  expect(value).toBeDefined()
  if (value === undefined) throw new Error(`${label} missing`)
  return value
}

function completionChunk(text = ''): ChatStreamChunk {
  return {
    type: 'delta',
    chunk: {
      id: 'lifecycle-generation',
      choices: [{ delta: text ? { content: text } : {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  }
}

async function* finiteStream(...chunks: ChatStreamChunk[]): AsyncGenerator<ChatStreamChunk> {
  for (const chunk of chunks) yield chunk
}

function delayedMalformedResponsesStream(): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': upstream still working\n\n'))
      queueMicrotask(() => {
        controller.enqueue(
          encoder.encode(
            [
              'event: response.output_text.delta',
              'data: {"type":"response.output_text.delta","delta":{"text":"wrong-shape"},"output_index":0,"content_index":0}',
              '',
              'event: response.completed',
              'data: {"type":"response.completed","response":{"status":"completed"}}',
              '',
              '',
            ].join('\n'),
          ),
        )
        controller.close()
      })
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function throwingStream(error: unknown): AsyncIterable<ChatStreamChunk> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          throw error
        },
      }
    },
  }
}

function abortableStream(signal: AbortSignal): AsyncIterable<ChatStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'delta',
        chunk: { choices: [{ delta: { content: 'partial' } }] },
      }
      await new Promise<never>((_, reject) => {
        const rejectAbort = () => reject(new DOMException('aborted', 'AbortError'))
        if (signal.aborted) {
          rejectAbort()
          return
        }
        signal.addEventListener('abort', rejectAbort, { once: true })
      })
    },
  }
}

async function seedAssistant(chatId: string, suffix: string): Promise<Message> {
  const repo = getBrowserRepository()
  const user: Message = {
    id: `user-${suffix}`,
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: `turn-user-${suffix}`,
    turnIndex: 0,
    createdAt: 10,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'question' }],
    nodeVersion: 0,
    deleted: false,
  }
  const assistant: Message = {
    id: `assistant-${suffix}`,
    chatId,
    parentId: user.id,
    siblingIndex: 0,
    turnId: `turn-assistant-${suffix}`,
    turnIndex: 0,
    createdAt: 20,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'output_text', text: 'original' }],
    nodeVersion: 0,
    deleted: false,
    generation: {
      id: `generation-${suffix}`,
      model: MODEL,
      requestedModel: MODEL,
      apiUsed: 'chat',
      delivery: 'streaming',
      costSource: 'stream',
      startedAt: 11,
      finishedAt: 19,
    },
  }
  await repo.runMutation(
    [
      { kind: 'message', messageId: user.id },
      { kind: 'message', messageId: assistant.id },
      { kind: 'children', chatId, parentId: null },
      { kind: 'children', chatId, parentId: user.id },
    ],
    async (ctx) => {
      await ctx.putMessage(user)
      await ctx.putMessage(assistant)
    },
  )
  return assistant
}

async function expectSettled(streamId: string, _messageId: string): Promise<void> {
  const repo = getBrowserRepository()
  expect(useStreamStore.getState().getActive(streamId)).toBeUndefined()
  expect(useStreamStore.getState().getLiveSnapshotByStreamId(streamId)).toBeUndefined()
  await eventually(async () => {
    expect(await repo.listStreamLeases()).toHaveLength(0)
  })
}

describe('generation lifecycle contract', () => {
  it('never creates the placeholder or dispatches when the pre-commit lease refresh fails', async () => {
    const chat = await createChat({ settings: settings() })
    const repo = getBrowserRepository()
    vi.spyOn(repo, 'renewStreamLease').mockRejectedValueOnce(new Error('retarget failed'))
    const openStream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield completionChunk()
      },
    }))

    await expect(
      sendText({
        chatId: chat.id,
        connection: profile(),
        apiKey: 'sk-test',
        content: [{ type: 'text', text: 'retarget failure' }],
        openStream,
      }),
    ).rejects.toMatchObject({ kind: 'storage' })
    await __flushStreamLeaseWritesForTests()

    expect(openStream).not.toHaveBeenCalled()
    const messages = await repo.listMessages(chat.id)
    const assistant = messages.find((message) => message.role === 'assistant')
    expect(assistant).toBeUndefined()
    expect(messages.some((message) => message.generation?.status === 'streaming')).toBe(false)
    expect(await repo.listStreamLeases(chat.id)).toEqual([])
    expect(await repo.listStreamChunksForChat(chat.id)).toEqual([])
  })

  it('send admits and republishes one exact target before provider open and settles lease/chunks', async () => {
    const chat = await createChat({ settings: settings() })
    useUiStore.getState().setActiveChatId(chat.id)
    const capture = captureBroadcasts()
    let targetMessageId: string | undefined
    let streamId: string | undefined
    let sawLease = false
    let sawDurableChunk = false
    let sawLiveSnapshot = false
    const largeText = 's'.repeat(132 * 1024)
    const openStream = vi.fn((open: { signal: AbortSignal }) => {
      const starts = streamEvents(capture.events)
      expect(starts).toHaveLength(2)
      expect(starts[0]).toMatchObject({ kind: 'stream-started', attemptKind: 'generation' })
      targetMessageId = expectDefined(
        starts[0]?.kind === 'stream-started' ? starts[0].messageId : undefined,
        'send target',
      )
      expect(starts[1]).toMatchObject({ messageId: targetMessageId })
      streamId = expectDefined(starts[0]?.streamId, 'send stream')
      expect(useStreamStore.getState().getActive(streamId)?.messageId).toBe(targetMessageId)
      return {
        async *[Symbol.asyncIterator]() {
          await eventually(async () => {
            const leases = await getBrowserRepository().listStreamLeases(chat.id)
            expect(leases).toHaveLength(1)
            expect(leases[0]).toMatchObject({ streamId, messageId: targetMessageId })
          })
          sawLease = true
          yield {
            type: 'delta' as const,
            chunk: { choices: [{ delta: { content: largeText } }] },
          }
          await eventually(async () => {
            expect(
              useStreamStore.getState().getLiveSnapshot(chat.id, targetMessageId as string),
            ).toBeDefined()
            expect(
              await getDb()
                .streamChunks.where('streamId')
                .equals(streamId as string)
                .count(),
            ).toBe(1)
          })
          sawLiveSnapshot = true
          sawDurableChunk = true
          expect(useAnnouncementStore.getState().polite.map((event) => event.text)).toEqual([
            'Assistant is responding.',
          ])
          expect(useAnnouncementStore.getState().assertive).toEqual([])
          yield {
            type: 'delta' as const,
            chunk: { choices: [{ delta: { content: ' after the durable flush' } }] },
          }
          expect(useAnnouncementStore.getState().polite.map((event) => event.text)).toEqual([
            'Assistant is responding.',
          ])
          expect(useAnnouncementStore.getState().assertive).toEqual([])
          yield completionChunk()
          void open.signal
        },
      }
    })

    try {
      const result = await sendText({
        chatId: chat.id,
        connection: profile(),
        apiKey: 'sk-test',
        content: [{ type: 'text', text: 'hello' }],
        openStream,
      })

      expect(openStream).toHaveBeenCalledTimes(1)
      expect(result.outcome).toBe('done')
      expect(result.assistantMessageId).toBe(targetMessageId)
      const endedStreamId = expectLifecycle(capture.events, {
        chatId: chat.id,
        messageId: result.assistantMessageId,
        outcome: 'done',
      })
      expect(endedStreamId).toBe(streamId)
      expect(sawLease).toBe(true)
      expect(sawDurableChunk).toBe(true)
      expect(sawLiveSnapshot).toBe(true)
      expect(useAnnouncementStore.getState().polite.map((event) => event.text)).toEqual([
        'Assistant is responding.',
      ])
      expect(useAnnouncementStore.getState().assertive).toEqual([])
      await expectSettled(endedStreamId, result.assistantMessageId)
      expect(await getDb().streamChunks.where('streamId').equals(endedStreamId).count()).toBe(0)
    } finally {
      capture.stop()
    }
  })

  it.each([
    { name: 'empty SSE', chunks: [] as ChatStreamChunk[], expectedText: '' },
    {
      name: 'content followed by ordinary EOF',
      chunks: [
        { type: 'delta', chunk: { choices: [{ delta: { content: 'partial response' } }] } },
      ] as ChatStreamChunk[],
      expectedText: 'partial response',
    },
  ])('persists $name as a retryable error without losing output', async ({
    chunks,
    expectedText,
  }) => {
    const chat = await createChat({ settings: settings() })

    const result = await sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'terminal evidence' }],
      openStream: () => finiteStream(...chunks),
    })

    expect(result).toMatchObject({
      outcome: 'error',
      error: {
        kind: 'protocol',
        code: 'STREAM_TRUNCATED',
        midStream: true,
        retryable: true,
      },
    })
    const assistant = expectDefined(
      await getBrowserRepository().getMessage(result.assistantMessageId),
      'truncated assistant',
    )
    expect(assistant.content).toEqual([{ type: 'output_text', text: expectedText }])
    expect(assistant.generation).toMatchObject({
      status: 'error',
      integrity: 'clean',
      error: {
        category: 'protocol',
        code: 'STREAM_TRUNCATED',
        retryable: true,
        midStream: true,
      },
    })
    await expectSettled(result.streamId, result.assistantMessageId)
  })

  it('finalizes a silent-stream watchdog timeout and leaves the branch readable', async () => {
    const chat = await createChat({ settings: settings() })
    const timeout = new ApiError({
      kind: 'timeout',
      code: 'TIMEOUT',
      message: 'Request timed out',
      midStream: true,
      retryable: true,
    })

    const result = await sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'silent stream' }],
      openStream: () => throwingStream(timeout),
    })

    expect(result).toMatchObject({ outcome: 'error', error: timeout })
    const repo = getBrowserRepository()
    const assistant = expectDefined(
      await repo.getMessage(result.assistantMessageId),
      'timed-out assistant',
    )
    expect(assistant.content).toEqual([{ type: 'output_text', text: '' }])
    expect(assistant.generation).toMatchObject({
      status: 'error',
      error: {
        category: 'network',
        code: 'TIMEOUT',
        retryable: true,
        midStream: true,
      },
    })
    await expectSettled(result.streamId, result.assistantMessageId)

    const headers = await repo.listMessageHeaders(chat.id)
    const projection = createMessageTreeProjection(headers)
    expect(layoutBranchTree(projection.nodes).byId.has(result.assistantMessageId)).toBe(true)
    await expect(
      repo.getMessagePresentationSnapshot(result.assistantMessageId),
    ).resolves.toMatchObject({ message: { id: result.assistantMessageId } })
  })

  it('accepts a chat [DONE] sentinel as clean terminal evidence', async () => {
    const chat = await createChat({ settings: { ...settings(), api: 'chat' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'data: {"choices":[{"delta":{"content":"sentinel complete"}}]}\n\ndata: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    )

    const result = await sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'sentinel' }],
    })

    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({ outcome: 'done' })
    expect(result.finishReason).toBeUndefined()
    const assistant = expectDefined(
      await getBrowserRepository().getMessage(result.assistantMessageId),
      'sentinel assistant',
    )
    expect(assistant.content).toEqual([{ type: 'output_text', text: 'sentinel complete' }])
    expect(assistant.generation).toMatchObject({ status: 'done', integrity: 'clean' })
    expect(assistant.generation?.error).toBeUndefined()
  })

  it('finalizes a delayed malformed Responses content frame before branch-tree reads', async () => {
    const chat = await createChat({ settings: { ...settings(), api: 'responses' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => delayedMalformedResponsesStream()),
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'malformed frame lifecycle' }],
    })

    expect(result).toMatchObject({ outcome: 'done', finishReason: 'stop' })
    const repo = getBrowserRepository()
    const assistant = expectDefined(
      await repo.getMessage(result.assistantMessageId),
      'malformed-frame assistant',
    )
    expect(assistant.content).toEqual([{ type: 'output_text', text: '' }])
    expect(assistant.generation).toMatchObject({
      apiUsed: 'responses',
      status: 'done',
      integrity: 'degraded',
      integritySummary: {
        count: 1,
        entries: [
          {
            category: 'malformed-event-shape',
            adapter: 'responses',
            eventType: 'response.output_text.delta',
            count: 1,
          },
        ],
      },
    })
    expect(assistant.generation?.error).toBeUndefined()
    await expectSettled(result.streamId, result.assistantMessageId)

    const headers = await repo.listMessageHeaders(chat.id)
    const projection = createMessageTreeProjection(headers)
    const layout = layoutBranchTree(projection.nodes)
    expect(layout.byId.has(result.assistantMessageId)).toBe(true)
    await expect(repo.getMessageTextPreview(result.assistantMessageId)).resolves.toBe('')
    const presentation = expectDefined(
      await repo.getMessagePresentationSnapshot(result.assistantMessageId),
      'malformed-frame presentation',
    )
    expect(presentation.message).toEqual(assistant)
    expect(typeof presentation.bodyVersion).toBe('number')

    const tree = render(
      createElement(BranchTreeView, {
        chatId: chat.id,
        headers,
        projection,
        cursor: {},
        expanded: false,
        selectedNodeId: result.assistantMessageId,
        repository: repo,
        onActivateNode: () => undefined,
        onSelectNode: () => undefined,
      }),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        result.assistantMessageId,
      ),
    )
    tree.unmount()
  })

  it('Continue has the same event ordering, durable chunks, cleanup, and attempt history', async () => {
    const chat = await createChat({ settings: settings() })
    useUiStore.getState().setActiveChatId(chat.id)
    const target = await seedAssistant(chat.id, 'continue-success')
    const capture = captureBroadcasts()
    let streamId: string | undefined
    let sawLease = false
    let sawLiveSnapshot = false
    let sawDurableChunk = false
    const largeText = 'c'.repeat(132 * 1024)
    const openStream = vi.fn(() => {
      const starts = streamEvents(capture.events)
      expect(starts).toHaveLength(2)
      expect(starts[0]).toMatchObject({
        kind: 'stream-started',
        messageId: target.id,
        attemptKind: 'continuation',
      })
      expect(starts[1]).toMatchObject({ kind: 'stream-started', messageId: target.id })
      streamId = expectDefined(starts[0]?.streamId, 'Continue stream')
      expect(useStreamStore.getState().getActive(streamId)).toMatchObject({
        messageId: target.id,
        attemptKind: 'continuation',
        originNavigationRevision: useChatStore.getState().getNavigationRevision(chat.id),
      })
      return {
        async *[Symbol.asyncIterator]() {
          await eventually(async () => {
            expect(await getBrowserRepository().listStreamLeases(chat.id)).toHaveLength(1)
          })
          sawLease = true
          yield {
            type: 'delta' as const,
            chunk: { choices: [{ delta: { content: largeText } }] },
          }
          await eventually(async () => {
            expect(useStreamStore.getState().getLiveSnapshot(chat.id, target.id)).toBeDefined()
            expect(
              await getDb()
                .streamChunks.where('streamId')
                .equals(streamId as string)
                .count(),
            ).toBe(1)
          })
          sawLiveSnapshot = true
          sawDurableChunk = true
          yield completionChunk()
        },
      }
    })

    try {
      await continueAssistantInPlace({
        chatId: chat.id,
        targetMessageId: target.id,
        connection: profile(),
        apiKey: 'sk-test',
        openStream,
      })

      expect(openStream).toHaveBeenCalledTimes(1)
      const endedStreamId = expectLifecycle(capture.events, {
        chatId: chat.id,
        messageId: target.id,
        outcome: 'done',
      })
      expect(endedStreamId).toBe(streamId)
      expect(sawLease).toBe(true)
      expect(sawLiveSnapshot).toBe(true)
      expect(sawDurableChunk).toBe(true)
      expect(useAnnouncementStore.getState().polite.map((event) => event.text)).toEqual([
        'Assistant is responding.',
      ])
      expect(useAnnouncementStore.getState().assertive).toEqual([])
      await expectSettled(endedStreamId, target.id)
      expect(await getDb().streamChunks.where('streamId').equals(endedStreamId).count()).toBe(0)
      const stored = expectDefined(
        await getBrowserRepository().getMessage(target.id),
        'continued target',
      )
      expect(stored.content).toEqual([{ type: 'output_text', text: `original${largeText}` }])
      expect(stored.generation).toEqual(target.generation)
      expect(stored.continuationAttempts).toHaveLength(1)
      expect(stored.continuationAttempts?.[0]).toMatchObject({
        streamId: endedStreamId,
        strategy: 'prompt',
        status: 'done',
        requestedModel: MODEL,
        apiUsed: 'responses',
      })
    } finally {
      capture.stop()
    }
  })

  it('Continue preserves structured content order and original failure provenance', async () => {
    const chat = await createChat({ settings: settings() })
    const target = await seedAssistant(chat.id, 'continue-structured-content')
    const repo = getBrowserRepository()
    const originalContent: ContentItem[] = [
      {
        type: 'output_text',
        text: 'cited opening',
        annotations: [{ type: 'url_citation', url: 'https://example.invalid/source' }],
      },
      { type: 'output_image', url: 'https://example.invalid/image.png', prompt: 'chart' },
      { type: 'output_text', text: 'middle' },
      { type: 'audio_output', url: 'https://example.invalid/audio.wav', format: 'wav' },
      {
        type: 'output_text',
        text: 'cited ending',
        annotations: [{ type: 'file_citation', filename: 'evidence.txt' }],
      },
    ]
    const originalGeneration = {
      ...expectDefined(target.generation, 'structured Continue generation'),
      status: 'interrupted' as const,
      abortReason: 'network' as const,
      error: {
        category: 'network' as const,
        code: 'NETWORK',
        message: 'original connection ended',
      },
    }
    await repo.runMutation([{ kind: 'message', messageId: target.id }], async (ctx) => {
      const current = expectDefined(await ctx.getMessage(target.id), 'structured Continue target')
      await ctx.putMessage({
        ...current,
        content: originalContent,
        generation: originalGeneration,
      })
    })

    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: target.id,
      connection: profile(),
      apiKey: 'sk-test',
      openStream: () => finiteStream(completionChunk(' continued')),
    })

    const continued = expectDefined(await repo.getMessage(target.id), 'continued structured target')
    expect(continued.content).toEqual([
      ...originalContent,
      { type: 'output_text', text: ' continued' },
    ])
    expect(continued.generation).toEqual(originalGeneration)
    expect(continued.continuationAttempts).toHaveLength(1)
    expect(continued.continuationAttempts?.[0]).toMatchObject({ status: 'done' })
  })

  it('Continue stores returned tool calls on its attempt without changing original provenance', async () => {
    const chat = await createChat({ settings: settings() })
    const target = await seedAssistant(chat.id, 'continue-tool-call')
    const repo = getBrowserRepository()
    const originalToolCalls = [
      {
        id: 'original-call',
        type: 'function' as const,
        function: { name: 'original_tool', arguments: '{"original":true}' },
      },
    ]
    await repo.runMutation([{ kind: 'message', messageId: target.id }], async (ctx) => {
      const current = expectDefined(await ctx.getMessage(target.id), 'Continue tool-call target')
      await ctx.putMessage({ ...current, toolCalls: originalToolCalls })
    })

    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: target.id,
      connection: profile(),
      apiKey: 'sk-test',
      openStream: () =>
        finiteStream(
          {
            type: 'delta',
            chunk: {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'continued-call',
                        type: 'function',
                        function: { name: 'continued_tool', arguments: '{"continued":' },
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            type: 'delta',
            chunk: {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, function: { arguments: 'true}' } }],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          },
        ),
    })

    const continued = expectDefined(await repo.getMessage(target.id), 'continued tool-call target')
    expect(continued.toolCalls).toEqual(originalToolCalls)
    expect(continued.continuationAttempts?.[0]?.toolCalls).toEqual([
      {
        id: 'continued-call',
        type: 'function',
        function: { name: 'continued_tool', arguments: '{"continued":true}' },
      },
    ])
  })

  it('send and Continue both settle one abort event without overwriting original provenance', async () => {
    const sendChat = await createChat({ settings: settings() })
    const sendCapture = captureBroadcasts()
    const sendOpen = vi.fn((open: { signal: AbortSignal }) => abortableStream(open.signal))
    const sendPromise = sendText({
      chatId: sendChat.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'abort send' }],
      openStream: sendOpen,
    })
    await eventually(() => expect(sendOpen).toHaveBeenCalledTimes(1))
    let sendActive: { streamId: string; messageId?: string; replacementEpoch: number } | undefined
    await eventually(() => {
      sendActive = useStreamStore
        .getState()
        .listActive()
        .find((stream) => stream.chatId === sendChat.id && stream.messageId !== undefined)
      expect(sendActive).toBeDefined()
    })
    const sendStreamId = expectDefined(sendActive?.streamId, 'active send stream')
    expect(
      useStreamStore
        .getState()
        .abortStream(sendStreamId, expectDefined(sendActive?.replacementEpoch, 'stream epoch')),
    ).toBe(true)
    const sendResult = await sendPromise
    const sendMessageId = expectDefined(sendActive?.messageId, 'active send target')
    expect(sendResult.outcome).toBe('abort')
    expect(sendOpen).toHaveBeenCalledTimes(1)
    expectLifecycle(sendCapture.events, {
      chatId: sendChat.id,
      messageId: sendMessageId,
      outcome: 'abort',
    })
    await expectSettled(sendStreamId, sendMessageId)
    expect((await getBrowserRepository().getMessage(sendMessageId))?.generation?.abortReason).toBe(
      'user',
    )
    expect(await getDb().streamChunks.where('streamId').equals(sendStreamId).count()).toBe(0)
    expect(
      useAnnouncementStore
        .getState()
        .polite.filter((event) => event.text === 'Generation stopped. Partial response kept.'),
    ).toHaveLength(1)
    expect(useAnnouncementStore.getState().assertive).toEqual([])
    sendCapture.stop()

    const continueChat = await createChat({ settings: settings() })
    const continueTarget = await seedAssistant(continueChat.id, 'continue-abort')
    const continueCapture = captureBroadcasts()
    const continueOpen = vi.fn((open: { signal: AbortSignal }) => abortableStream(open.signal))
    const continuePromise = continueAssistantInPlace({
      chatId: continueChat.id,
      targetMessageId: continueTarget.id,
      connection: profile(),
      apiKey: 'sk-test',
      openStream: continueOpen,
    })
    await eventually(() => expect(continueOpen).toHaveBeenCalledTimes(1))
    let continueStreamId: string | undefined
    await eventually(() => {
      continueStreamId = useStreamStore
        .getState()
        .listActive()
        .find(
          (stream) => stream.chatId === continueChat.id && stream.messageId === continueTarget.id,
        )?.streamId
      expect(continueStreamId).toBeDefined()
    })
    const continueActive = useStreamStore.getState().getActive(continueStreamId as string)
    expect(
      useStreamStore
        .getState()
        .abortStream(
          continueStreamId as string,
          expectDefined(continueActive?.replacementEpoch, 'continue stream epoch'),
        ),
    ).toBe(true)
    await continuePromise
    expect(continueOpen).toHaveBeenCalledTimes(1)
    expectLifecycle(continueCapture.events, {
      chatId: continueChat.id,
      messageId: continueTarget.id,
      outcome: 'abort',
    })
    await expectSettled(continueStreamId as string, continueTarget.id)
    const continued = expectDefined(
      await getBrowserRepository().getMessage(continueTarget.id),
      'aborted Continue target',
    )
    expect(continued.content).toEqual([{ type: 'output_text', text: 'originalpartial' }])
    expect(continued.generation).toEqual(continueTarget.generation)
    expect(continued.continuationAttempts?.[0]).toMatchObject({
      streamId: continueStreamId,
      status: 'abort',
      abortReason: 'user',
    })
    expect(
      await getDb()
        .streamChunks.where('streamId')
        .equals(continueStreamId as string)
        .count(),
    ).toBe(0)
    expect(
      useAnnouncementStore
        .getState()
        .polite.filter((event) => event.text === 'Generation stopped. Partial response kept.'),
    ).toHaveLength(2)
    expect(useAnnouncementStore.getState().assertive).toEqual([])
    continueCapture.stop()
  })

  it('normalizes unknown stream failures while preserving Continue rethrow semantics', async () => {
    const apiError = new ApiError({
      kind: 'bad_request',
      code: 400,
      message: 'injected API error',
      midStream: true,
      retryable: false,
    })

    let expectedErrorAnnouncements = 0
    for (const [label, error] of [
      ['api', apiError],
      ['unknown', new Error('injected unknown send error')],
    ] as const) {
      const chat = await createChat({ settings: settings() })
      const capture = captureBroadcasts()
      const openStream = vi.fn(() => throwingStream(error))
      const result = await sendText({
        chatId: chat.id,
        connection: profile(),
        apiKey: 'sk-test',
        content: [{ type: 'text', text: `send ${label}` }],
        openStream,
      })
      expect(openStream).toHaveBeenCalledTimes(1)
      expect(result.outcome).toBe('error')
      if (label === 'api') expect(result.error).toBe(apiError)
      else {
        expect(result.error).toMatchObject({
          kind: 'protocol',
          code: 'PROTOCOL',
          message: error.message,
        })
      }
      const streamId = expectLifecycle(capture.events, {
        chatId: chat.id,
        messageId: result.assistantMessageId,
        outcome: 'error',
      })
      await expectSettled(streamId, result.assistantMessageId)
      expectedErrorAnnouncements += 1
      expect(
        useAnnouncementStore
          .getState()
          .assertive.filter(
            (event) => event.text === 'Response failed. Partial response kept if available.',
          ),
      ).toHaveLength(expectedErrorAnnouncements)
      expect(await getDb().streamChunks.where('streamId').equals(streamId).count()).toBe(0)
      capture.stop()
    }

    const apiChat = await createChat({ settings: settings() })
    const apiTarget = await seedAssistant(apiChat.id, 'continue-api-error')
    const apiCapture = captureBroadcasts()
    const apiOpen = vi.fn(() => throwingStream(apiError))
    await expect(
      continueAssistantInPlace({
        chatId: apiChat.id,
        targetMessageId: apiTarget.id,
        connection: profile(),
        apiKey: 'sk-test',
        openStream: apiOpen,
      }),
    ).resolves.toBeUndefined()
    expect(apiOpen).toHaveBeenCalledTimes(1)
    const apiStreamId = expectLifecycle(apiCapture.events, {
      chatId: apiChat.id,
      messageId: apiTarget.id,
      outcome: 'error',
    })
    await expectSettled(apiStreamId, apiTarget.id)
    expectedErrorAnnouncements += 1
    expect(
      useAnnouncementStore
        .getState()
        .assertive.filter(
          (event) => event.text === 'Response failed. Partial response kept if available.',
        ),
    ).toHaveLength(expectedErrorAnnouncements)
    apiCapture.stop()

    const unknownChat = await createChat({ settings: settings() })
    const unknownTarget = await seedAssistant(unknownChat.id, 'continue-unknown-error')
    const unknownCapture = captureBroadcasts()
    const unknownError = new Error('injected unknown Continue error')
    const unknownOpen = vi.fn(() => throwingStream(unknownError))
    await expect(
      continueAssistantInPlace({
        chatId: unknownChat.id,
        targetMessageId: unknownTarget.id,
        connection: profile(),
        apiKey: 'sk-test',
        openStream: unknownOpen,
      }),
    ).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'protocol',
      code: 'PROTOCOL',
      message: unknownError.message,
    })
    expect(unknownOpen).toHaveBeenCalledTimes(1)
    const unknownStreamId = expectLifecycle(unknownCapture.events, {
      chatId: unknownChat.id,
      messageId: unknownTarget.id,
      outcome: 'error',
    })
    await expectSettled(unknownStreamId, unknownTarget.id)
    expectedErrorAnnouncements += 1
    expect(
      useAnnouncementStore
        .getState()
        .assertive.filter(
          (event) => event.text === 'Response failed. Partial response kept if available.',
        ),
    ).toHaveLength(expectedErrorAnnouncements)
    unknownCapture.stop()
  })

  it('send retains durable chunks when the canonical final write fails', async () => {
    const chat = await createChat({ settings: settings() })
    const repo = getBrowserRepository()
    const capture = captureBroadcasts()
    const originalRunMutation = repo.runMutation.bind(repo)
    let targetMessageId: string | undefined
    let streamId: string | undefined
    let failFinalWrite = false
    let injectedFailures = 0
    vi.spyOn(repo, 'runMutation').mockImplementation(async (scopes, fn, options) => {
      if (
        failFinalWrite &&
        injectedFailures === 0 &&
        scopes.some((scope) => scope.kind === 'message' && scope.messageId === targetMessageId)
      ) {
        injectedFailures += 1
        throw new Error('injected final write failure')
      }
      return originalRunMutation(scopes, fn, options)
    })
    const openStream = vi.fn(() => {
      const starts = streamEvents(capture.events)
      targetMessageId = expectDefined(
        starts[0]?.kind === 'stream-started' ? starts[0].messageId : undefined,
        'failed send target',
      )
      streamId = expectDefined(starts[0]?.streamId, 'failed send stream')
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'delta' as const,
            chunk: { choices: [{ delta: { content: 'x'.repeat(132 * 1024) } }] },
          }
          await eventually(async () => {
            expect(
              await getDb()
                .streamChunks.where('streamId')
                .equals(streamId as string)
                .count(),
            ).toBe(1)
          })
          failFinalWrite = true
          yield completionChunk()
        },
      }
    })

    try {
      await expect(
        sendText({
          chatId: chat.id,
          connection: profile(),
          apiKey: 'sk-test',
          content: [{ type: 'text', text: 'fail final write' }],
          openStream,
        }),
      ).rejects.toThrow('injected final write failure')
      expect(openStream).toHaveBeenCalledTimes(1)
      expect(injectedFailures).toBe(1)
      const target = expectDefined(targetMessageId, 'failed target')
      const endedStreamId = expectLifecycle(capture.events, {
        chatId: chat.id,
        messageId: target,
        outcome: 'error',
      })
      expect(endedStreamId).toBe(streamId)
      expect(useStreamStore.getState().getActive(endedStreamId)).toBeUndefined()
      expect(useStreamStore.getState().getLiveSnapshot(chat.id, target)).toBeUndefined()
      expect(await repo.listStreamLeases()).toHaveLength(1)
      expect(
        await getDb().streamChunks.where('streamId').equals(endedStreamId).count(),
      ).toBeGreaterThan(0)
      expect((await repo.getMessage(target))?.generation?.finishedAt).toBeUndefined()

      expect(await recoverOrphans(Date.now() + 60_000, chat.id)).toBe(1)
      expect(await repo.listStreamLeases()).toHaveLength(0)
      expect(await getDb().streamChunks.where('streamId').equals(endedStreamId).count()).toBe(0)
      expect((await repo.getMessage(target))?.generation?.finishedAt).toBeDefined()
    } finally {
      capture.stop()
    }
  })

  it.each([
    { name: 'empty SSE', chunks: [] as ChatStreamChunk[], expectedText: '', hasTextChunk: false },
    {
      name: 'content followed by ordinary EOF',
      chunks: [
        { type: 'delta', chunk: { choices: [{ delta: { content: 'durable partial' } }] } },
      ] as ChatStreamChunk[],
      expectedText: 'durable partial',
      hasTextChunk: true,
    },
  ])('recovers $name and its truncated-stream failure after a canonical write failure', async ({
    chunks: sourceChunks,
    expectedText,
    hasTextChunk,
  }) => {
    const chat = await createChat({ settings: settings() })
    const repo = getBrowserRepository()
    const originalRunMutation = repo.runMutation.bind(repo)
    let injectedFailure = false
    vi.spyOn(repo, 'runMutation').mockImplementation(async (scopes, fn, options) => {
      const lease = options?.streamFence
        ? (await repo.listStreamLeases(chat.id)).find(
            (row) => row.streamId === options.streamFence?.streamId,
          )
        : undefined
      const targetExists = lease?.messageId ? await repo.getMessage(lease.messageId) : undefined
      const isTargetMutation = lease?.messageId
        ? scopes.some((scope) => scope.kind === 'message' && scope.messageId === lease.messageId)
        : false
      if (!injectedFailure && options?.streamFence && targetExists && isTargetMutation) {
        injectedFailure = true
        throw new Error('injected truncated-stream final write failure')
      }
      return originalRunMutation(scopes, fn, options)
    })

    await expect(
      sendText({
        chatId: chat.id,
        connection: profile(),
        apiKey: 'sk-test',
        content: [{ type: 'text', text: 'recover truncated stream' }],
        openStream: () => finiteStream(...sourceChunks),
      }),
    ).rejects.toThrow('injected truncated-stream final write failure')

    expect(injectedFailure).toBe(true)
    const assistantBeforeRecovery = expectDefined(
      (await repo.listMessages(chat.id)).find((message) => message.role === 'assistant'),
      'truncated assistant before recovery',
    )
    expect(assistantBeforeRecovery.content).toEqual([{ type: 'output_text', text: '' }])
    const [lease] = await repo.listStreamLeases(chat.id)
    expect(lease).toBeDefined()
    const chunks = await repo.listStreamChunks(lease?.streamId ?? '')
    expect(chunks.some((chunk) => (chunk.event as { lane?: unknown }).lane === 'text')).toBe(
      hasTextChunk,
    )
    expect(
      chunks.some(
        (chunk) =>
          (chunk.event as { lane?: unknown; error?: { code?: unknown } }).lane === 'error' &&
          (chunk.event as { error?: { code?: unknown } }).error?.code === 'STREAM_TRUNCATED',
      ),
    ).toBe(true)

    expect(await recoverOrphans(Date.now() + 60_000, chat.id)).toBe(1)
    const recovered = expectDefined(
      await repo.getMessage(assistantBeforeRecovery.id),
      'recovered truncated assistant',
    )
    expect(recovered.content).toEqual([{ type: 'output_text', text: expectedText }])
    expect(recovered.generation).toMatchObject({
      status: 'error',
      integrity: 'clean',
      error: {
        category: 'protocol',
        code: 'STREAM_TRUNCATED',
        retryable: true,
        midStream: true,
      },
    })
    expect(await repo.listStreamLeases(chat.id)).toEqual([])
    expect(await repo.listStreamChunks(lease?.streamId ?? '')).toEqual([])
  })

  it('recovers partial output and a typed thrown network failure after finalization fails', async () => {
    const chat = await createChat({ settings: settings() })
    const repo = getBrowserRepository()
    const originalRunMutation = repo.runMutation.bind(repo)
    let injectedFailure = false
    vi.spyOn(repo, 'runMutation').mockImplementation(async (scopes, fn, options) => {
      const lease = options?.streamFence
        ? (await repo.listStreamLeases(chat.id)).find(
            (row) => row.streamId === options.streamFence?.streamId,
          )
        : undefined
      const targetExists = lease?.messageId ? await repo.getMessage(lease.messageId) : undefined
      const isTargetMutation = lease?.messageId
        ? scopes.some((scope) => scope.kind === 'message' && scope.messageId === lease.messageId)
        : false
      if (!injectedFailure && options?.streamFence && targetExists && isTargetMutation) {
        injectedFailure = true
        throw new Error('injected network-failure final write failure')
      }
      return originalRunMutation(scopes, fn, options)
    })
    const networkError = new ApiError({
      kind: 'network',
      code: 'NETWORK',
      message: 'stream reader disconnected',
      midStream: true,
      retryable: true,
    })
    const openStream = () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<ChatStreamChunk> {
        yield {
          type: 'delta',
          chunk: { choices: [{ delta: { content: 'durable network partial' } }] },
        }
        throw networkError
      },
    })

    await expect(
      sendText({
        chatId: chat.id,
        connection: profile(),
        apiKey: 'sk-test',
        content: [{ type: 'text', text: 'recover thrown network failure' }],
        openStream,
      }),
    ).rejects.toThrow('injected network-failure final write failure')

    expect(injectedFailure).toBe(true)
    const assistantBeforeRecovery = expectDefined(
      (await repo.listMessages(chat.id)).find((message) => message.role === 'assistant'),
      'network-failed assistant before recovery',
    )
    const [lease] = await repo.listStreamLeases(chat.id)
    expect(lease).toBeDefined()
    const chunks = await repo.listStreamChunks(lease?.streamId ?? '')
    expect(
      chunks.some(
        (chunk) =>
          (chunk.event as { lane?: unknown; error?: { kind?: unknown } }).lane === 'error' &&
          (chunk.event as { error?: { kind?: unknown } }).error?.kind === 'network',
      ),
    ).toBe(true)

    expect(await recoverOrphans(Date.now() + 60_000, chat.id)).toBe(1)
    const recovered = expectDefined(
      await repo.getMessage(assistantBeforeRecovery.id),
      'recovered network-failed assistant',
    )
    expect(recovered.content).toEqual([{ type: 'output_text', text: 'durable network partial' }])
    expect(recovered.generation).toMatchObject({
      status: 'error',
      integrity: 'clean',
      error: {
        category: 'network',
        code: 'NETWORK',
        retryable: true,
        midStream: true,
      },
    })
    expect(await repo.listStreamLeases(chat.id)).toEqual([])
    expect(await repo.listStreamChunks(lease?.streamId ?? '')).toEqual([])
  })

  it('prevents a recovered stream from being overwritten by a stale send finalizer', async () => {
    const chat = await createChat({ settings: settings() })
    const repo = getBrowserRepository()
    const durableTail = 'race-safe send'.repeat(12_000)
    const originalRunMutation = repo.runMutation.bind(repo)
    let claimedStreamId: string | undefined
    let claimAt = 0
    vi.spyOn(repo, 'runMutation').mockImplementation(async (scopes, fn, options) => {
      if (!claimedStreamId && options?.streamFence) {
        const expected = (await repo.listStreamLeases(chat.id)).find(
          (lease) => lease.streamId === options.streamFence?.streamId,
        )
        if (!expected) throw new Error('expected live send lease before finalization')
        const targetExists = expected.messageId
          ? await repo.getMessage(expected.messageId)
          : undefined
        const isTargetMutation = expected.messageId
          ? scopes.some(
              (scope) => scope.kind === 'message' && scope.messageId === expected.messageId,
            )
          : false
        if (targetExists && isTargetMutation) {
          claimAt = Date.now()
          let claimed = await repo.claimStreamLeaseForRecovery(expected, claimAt)
          if (!claimed) {
            const refreshed = (await repo.listStreamLeases(chat.id)).find(
              (lease) => lease.streamId === expected.streamId,
            )
            if (refreshed) claimed = await repo.claimStreamLeaseForRecovery(refreshed, claimAt)
          }
          if (!claimed) throw new Error('expected send recovery claim')
          claimedStreamId = claimed.streamId
        }
      }
      return originalRunMutation(scopes, fn, options)
    })

    await expect(
      sendText({
        chatId: chat.id,
        connection: profile(),
        apiKey: 'sk-test',
        content: [{ type: 'text', text: 'stale send race' }],
        openStream: () => finiteStream(completionChunk(durableTail)),
      }),
    ).rejects.toThrow(/StreamFenceLost:/u)

    const streamId = expectDefined(claimedStreamId, 'claimed send stream')
    const beforeRecovery = (await repo.listMessages(chat.id)).find(
      (message) => message.role === 'assistant',
    )
    expect(beforeRecovery?.content).toEqual([{ type: 'output_text', text: '' }])
    expect(await repo.listStreamChunks(streamId)).not.toHaveLength(0)

    expect(await recoverOrphans(claimAt + 60_000, chat.id)).toBe(1)
    const recovered = expectDefined(
      (await repo.listMessages(chat.id)).find((message) => message.role === 'assistant'),
      'recovered assistant',
    )
    expect(recovered.content).toEqual([{ type: 'output_text', text: durableTail }])
    expect(await repo.listStreamLeases(chat.id)).toEqual([])
    expect(await repo.listStreamChunks(streamId)).toEqual([])
  })

  it('recovers an interrupted Continue separately from the original generation provenance', async () => {
    const chat = await createChat({ settings: settings() })
    const target = await seedAssistant(chat.id, 'continue-interrupted-recovery')
    const repo = getBrowserRepository()
    const originalContent: ContentItem[] = [
      {
        type: 'output_text',
        text: 'cited original',
        annotations: [{ type: 'url_citation', url: 'https://example.invalid/original' }],
      },
      { type: 'output_image', url: 'https://example.invalid/original.png' },
      {
        type: 'output_text',
        text: 'annotated ending',
        annotations: [{ type: 'file_citation', filename: 'original.txt' }],
      },
    ]
    await repo.runMutation([{ kind: 'message', messageId: target.id }], async (ctx) => {
      const current = expectDefined(await ctx.getMessage(target.id), 'stale Continue target')
      await ctx.putMessage({ ...current, content: originalContent })
    })
    const baseline = expectDefined(await repo.getMessage(target.id), 'stale Continue baseline')
    const streamId = 'stale-continue-stream'
    const staleLease = await repo.upsertStreamLease({
      streamId,
      chatId: chat.id,
      messageId: target.id,
      ownerClientId: 'closed-tab',
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'continuation',
      continuationStrategy: 'prefill',
      baseNodeVersion: baseline.nodeVersion,
      requestedModel: MODEL,
      apiUsed: 'responses',
    })
    const staleFence = chunkFence(staleLease)
    await repo.appendStreamChunks([
      {
        id: `${streamId}:0`,
        streamId,
        chatId: chat.id,
        messageId: target.id,
        seq: 0,
        createdAt: 300,
        event: { lane: 'text', text: '-recovered' },
        ...staleFence,
      },
      {
        id: `${streamId}:1`,
        streamId,
        chatId: chat.id,
        messageId: target.id,
        seq: 1,
        createdAt: 310,
        event: {
          lane: 'reasoning',
          textDelta: 'continuation reasoning',
          outputIndex: 0,
        },
        ...staleFence,
      },
      {
        id: `${streamId}:2`,
        streamId,
        chatId: chat.id,
        messageId: target.id,
        seq: 2,
        createdAt: 320,
        event: {
          lane: 'tool-call',
          index: 0,
          id: 'recovered-continuation-call',
          type: 'function',
          name: 'recover_tool',
          argumentsDelta: '{"recovered":',
        },
        ...staleFence,
      },
      {
        id: `${streamId}:3`,
        streamId,
        chatId: chat.id,
        messageId: target.id,
        seq: 3,
        createdAt: 330,
        event: { lane: 'tool-call', index: 0, argumentsDelta: 'true}' },
        ...staleFence,
      },
    ])

    const concurrentRecoveries = await Promise.all([
      recoverOrphans(100_000, chat.id),
      recoverOrphans(100_000, chat.id),
    ])
    expect(concurrentRecoveries.sort()).toEqual([0, 1])
    expect(await recoverOrphans(100_001, chat.id)).toBe(0)
    const recovered = expectDefined(await repo.getMessage(target.id), 'interrupted Continue target')
    expect(recovered.content).toEqual([
      ...originalContent,
      { type: 'output_text', text: '-recovered' },
    ])
    expect(recovered.generation).toEqual(target.generation)
    expect(recovered.continuationAttempts).toHaveLength(1)
    expect(recovered.continuationAttempts?.[0]).toMatchObject({
      streamId,
      strategy: 'prefill',
      status: 'interrupted',
      requestedModel: MODEL,
      apiUsed: 'responses',
      abortReason: 'tab-close',
      reasoningDetails: [
        {
          type: 'reasoning.text',
          id: 'text#0',
          index: 0,
          text: 'continuation reasoning',
        },
      ],
      toolCalls: [
        {
          id: 'recovered-continuation-call',
          type: 'function',
          function: { name: 'recover_tool', arguments: '{"recovered":true}' },
        },
      ],
    })
    expect(await repo.listStreamLeases()).toHaveLength(0)
    expect(await repo.listStreamChunks(streamId)).toHaveLength(0)
  })

  it('keeps the Continue lease as a recovery anchor when chunk cleanup fails', async () => {
    const chat = await createChat({ settings: settings() })
    const target = await seedAssistant(chat.id, 'continue-cleanup-retry')
    const repo = getBrowserRepository()
    const streamId = 'continue-cleanup-retry-stream'
    const staleLease = await repo.upsertStreamLease({
      streamId,
      chatId: chat.id,
      messageId: target.id,
      ownerClientId: 'closed-tab',
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'continuation',
      continuationStrategy: 'prompt',
      baseNodeVersion: target.nodeVersion,
      requestedModel: MODEL,
      apiUsed: 'responses',
    })
    await repo.appendStreamChunks([
      {
        id: `${streamId}:0`,
        streamId,
        chatId: chat.id,
        messageId: target.id,
        seq: 0,
        createdAt: 300,
        event: { lane: 'text', text: '-recovered' },
        ...chunkFence(staleLease),
      },
    ])
    vi.spyOn(repo, 'deleteStreamChunks').mockRejectedValueOnce(
      new Error('injected chunk cleanup failure'),
    )

    await expect(recoverOrphans(100_000, chat.id)).rejects.toThrow('injected chunk cleanup failure')
    expect(await repo.listStreamLeases(chat.id)).toHaveLength(1)
    expect(await repo.listStreamChunks(streamId)).toHaveLength(1)
    expect((await repo.getMessage(target.id))?.continuationAttempts).toHaveLength(1)

    expect(await recoverOrphans(100_001, chat.id)).toBe(1)
    expect(await repo.listStreamLeases(chat.id)).toEqual([])
    expect(await repo.listStreamChunks(streamId)).toEqual([])
    expect((await repo.getMessage(target.id))?.continuationAttempts).toHaveLength(1)
  })

  it('recovers Continue output after a structure-only target revision', async () => {
    const chat = await createChat({ settings: settings() })
    const target = await seedAssistant(chat.id, 'continue-recovery-structure-only')
    const repo = getBrowserRepository()
    const baseline = expectDefined(await repo.getMessageHeader(target.id), 'Continue target header')
    await repo.runMutation(
      [
        { kind: 'message', messageId: target.id },
        { kind: 'children', chatId: chat.id, parentId: target.parentId },
      ],
      async (ctx) => {
        await ctx.patchMessageStructure(target.id, {
          siblingIndex: baseline.siblingIndex + 1,
        })
      },
    )
    const structurallyChanged = expectDefined(
      await repo.getMessageHeader(target.id),
      'structurally changed Continue target',
    )
    expect(structurallyChanged.nodeVersion).toBeGreaterThan(baseline.nodeVersion)
    expect(structurallyChanged.bodyVersion).toBe(baseline.bodyVersion)

    const streamId = 'continue-after-structure-only'
    const staleLease = await repo.upsertStreamLease({
      streamId,
      chatId: chat.id,
      messageId: target.id,
      ownerClientId: 'closed-tab',
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'continuation',
      continuationStrategy: 'prompt',
      baseBodyVersion: baseline.bodyVersion,
      requestedModel: MODEL,
      apiUsed: 'responses',
    })
    await repo.appendStreamChunks([
      {
        id: `${streamId}:0`,
        streamId,
        chatId: chat.id,
        messageId: target.id,
        seq: 0,
        createdAt: 300,
        event: { lane: 'text', text: '-recovered-after-move' },
        ...chunkFence(staleLease),
      },
    ])

    expect(await recoverOrphans(100_000, chat.id)).toBe(1)
    const recovered = expectDefined(await repo.getMessage(target.id), 'recovered Continue target')
    expect(recovered.content).toEqual([
      { type: 'output_text', text: 'original-recovered-after-move' },
    ])
    expect(recovered.continuationAttempts?.[0]?.unappliedText).toBeUndefined()
  })

  it('does not overwrite a newer edit while recovering a stale Continue tail', async () => {
    const chat = await createChat({ settings: settings() })
    const target = await seedAssistant(chat.id, 'continue-recovery-edit-race')
    const repo = getBrowserRepository()
    const streamId = 'stale-continue-after-edit'
    const baseline = expectDefined(await repo.getMessageHeader(target.id), 'Continue target header')
    await repo.runMutation([{ kind: 'message', messageId: target.id }], async (ctx) => {
      const current = expectDefined(await ctx.getMessage(target.id), 'edited Continue target')
      await ctx.putMessage({
        ...current,
        content: [{ type: 'output_text', text: 'newer user edit' }],
        editedAt: 400,
      })
    })
    const staleLease = await repo.upsertStreamLease({
      streamId,
      chatId: chat.id,
      messageId: target.id,
      ownerClientId: 'closed-tab',
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'continuation',
      continuationStrategy: 'prompt',
      baseBodyVersion: baseline.bodyVersion,
      requestedModel: MODEL,
      apiUsed: 'responses',
    })
    const staleFence = chunkFence(staleLease)
    await repo.appendStreamChunks([
      {
        id: `${streamId}:0`,
        streamId,
        chatId: chat.id,
        messageId: target.id,
        seq: 0,
        createdAt: 300,
        event: { lane: 'text', text: '-stale-tail' },
        ...staleFence,
      },
    ])

    expect(await recoverOrphans(100_000, chat.id)).toBe(1)
    const recovered = expectDefined(await repo.getMessage(target.id), 'race-safe Continue target')
    expect(recovered.content).toEqual([{ type: 'output_text', text: 'newer user edit' }])
    expect(recovered.continuationAttempts?.[0]).toMatchObject({
      streamId,
      status: 'interrupted',
      unappliedText: '-stale-tail',
    })
    expect(await repo.listStreamLeases()).toHaveLength(0)
    expect(await repo.listStreamChunks(streamId)).toHaveLength(0)
  })

  it('Continue recovers its in-place text and attempt record after a canonical write failure', async () => {
    const chat = await createChat({ settings: settings() })
    const target = await seedAssistant(chat.id, 'continue-final-write-failure')
    const repo = getBrowserRepository()
    const originalContent: ContentItem[] = [
      {
        type: 'output_text',
        text: 'original cited',
        annotations: [{ type: 'url_citation', url: 'https://example.invalid/recovery' }],
      },
      { type: 'output_image', url: 'https://example.invalid/recovery.png' },
      {
        type: 'output_text',
        text: 'original ending',
        annotations: [{ type: 'file_citation', filename: 'recovery.txt' }],
      },
    ]
    const originalGeneration = {
      ...expectDefined(target.generation, 'failed Continue generation'),
      status: 'interrupted' as const,
      abortReason: 'network' as const,
      error: {
        category: 'network' as const,
        code: 'NETWORK',
        message: 'original stream failed',
      },
    }
    await repo.runMutation([{ kind: 'message', messageId: target.id }], async (ctx) => {
      const current = expectDefined(await ctx.getMessage(target.id), 'failed Continue target')
      await ctx.putMessage({
        ...current,
        content: originalContent,
        generation: originalGeneration,
      })
    })
    const baseline = expectDefined(await repo.getMessage(target.id), 'failed Continue baseline')
    const capture = captureBroadcasts()
    const originalRunMutation = repo.runMutation.bind(repo)
    const largeText = 'r'.repeat(132 * 1024)
    let failFinalWrite = false
    let injectedFailures = 0
    let streamId: string | undefined
    vi.spyOn(repo, 'runMutation').mockImplementation(async (scopes, fn, options) => {
      if (
        failFinalWrite &&
        injectedFailures === 0 &&
        scopes.some((scope) => scope.kind === 'message' && scope.messageId === target.id)
      ) {
        injectedFailures += 1
        throw new Error('injected Continue final write failure')
      }
      return originalRunMutation(scopes, fn, options)
    })
    const openStream = vi.fn(() => {
      const starts = streamEvents(capture.events)
      streamId = expectDefined(starts[0]?.streamId, 'failed Continue stream')
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'delta' as const,
            chunk: { choices: [{ delta: { content: largeText } }] },
          }
          await eventually(async () => {
            expect(
              await getDb()
                .streamChunks.where('streamId')
                .equals(streamId as string)
                .count(),
            ).toBe(1)
          })
          failFinalWrite = true
          yield completionChunk()
        },
      }
    })

    try {
      await expect(
        continueAssistantInPlace({
          chatId: chat.id,
          targetMessageId: target.id,
          connection: profile(),
          apiKey: 'sk-test',
          openStream,
        }),
      ).rejects.toThrow('injected Continue final write failure')
      expect(injectedFailures).toBe(1)
      const failedStreamId = expectDefined(streamId, 'failed Continue stream')
      expectLifecycle(capture.events, {
        chatId: chat.id,
        messageId: target.id,
        outcome: 'error',
      })
      expect((await repo.getMessage(target.id))?.content).toEqual(baseline.content)
      expect((await repo.getMessage(target.id))?.generation).toEqual(originalGeneration)
      expect(await repo.listStreamLeases()).toHaveLength(1)
      expect(
        await getDb().streamChunks.where('streamId').equals(failedStreamId).count(),
      ).toBeGreaterThan(0)

      expect(await recoverOrphans(Date.now() + 60_000, chat.id)).toBe(1)
      const recovered = expectDefined(await repo.getMessage(target.id), 'recovered Continue target')
      expect(recovered.content).toEqual([
        ...originalContent,
        { type: 'output_text', text: largeText },
      ])
      expect(recovered.generation).toEqual(originalGeneration)
      expect(recovered.continuationAttempts).toHaveLength(1)
      expect(recovered.continuationAttempts?.[0]).toMatchObject({
        streamId: failedStreamId,
        strategy: 'prompt',
        status: 'done',
        requestedModel: MODEL,
        apiUsed: 'responses',
      })
      expect(await repo.listStreamLeases()).toHaveLength(0)
      expect(await getDb().streamChunks.where('streamId').equals(failedStreamId).count()).toBe(0)
    } finally {
      capture.stop()
    }
  })

  it('prevents a recovered Continue from being appended again by a stale finalizer', async () => {
    const chat = await createChat({ settings: settings() })
    const target = await seedAssistant(chat.id, 'continue-stale-finalizer')
    const repo = getBrowserRepository()
    const durableTail = '-tail'.repeat(40_000)
    const originalRunMutation = repo.runMutation.bind(repo)
    let claimedStreamId: string | undefined
    let claimAt = 0
    let fencedTargetMutationCount = 0
    vi.spyOn(repo, 'runMutation').mockImplementation(async (scopes, fn, options) => {
      if (!claimedStreamId && options?.streamFence) {
        const expected = (await repo.listStreamLeases(chat.id)).find(
          (lease) => lease.streamId === options.streamFence?.streamId,
        )
        if (!expected) throw new Error('expected live Continue lease before finalization')
        const isTargetMutation = expected.messageId
          ? scopes.some(
              (scope) => scope.kind === 'message' && scope.messageId === expected.messageId,
            )
          : false
        if (isTargetMutation) {
          fencedTargetMutationCount += 1
          // The first fenced target transaction is Continue's read-only
          // pre-dispatch certificate. Claim at the subsequent final write so
          // the durable journal already contains the provider result.
          if (fencedTargetMutationCount === 1) {
            return originalRunMutation(scopes, fn, options)
          }
          claimAt = Date.now()
          let claimed = await repo.claimStreamLeaseForRecovery(expected, claimAt)
          if (!claimed) {
            const refreshed = (await repo.listStreamLeases(chat.id)).find(
              (lease) => lease.streamId === expected.streamId,
            )
            if (refreshed) claimed = await repo.claimStreamLeaseForRecovery(refreshed, claimAt)
          }
          if (!claimed) throw new Error('expected Continue recovery claim')
          claimedStreamId = claimed.streamId
        }
      }
      return originalRunMutation(scopes, fn, options)
    })

    await expect(
      continueAssistantInPlace({
        chatId: chat.id,
        targetMessageId: target.id,
        connection: profile(),
        apiKey: 'sk-test',
        openStream: () => finiteStream(completionChunk(durableTail)),
      }),
    ).rejects.toThrow(/StreamFenceLost:/u)

    const streamId = expectDefined(claimedStreamId, 'claimed Continue stream')
    expect((await repo.getMessage(target.id))?.content).toEqual(target.content)
    expect(await repo.listStreamChunks(streamId)).not.toHaveLength(0)

    expect(await recoverOrphans(claimAt + 60_000, chat.id)).toBe(1)
    const recovered = expectDefined(await repo.getMessage(target.id), 'recovered Continue target')
    expect(recovered.content).toEqual([{ type: 'output_text', text: `original${durableTail}` }])
    expect(recovered.continuationAttempts).toHaveLength(1)
    expect(recovered.continuationAttempts?.[0]?.streamId).toBe(streamId)
    expect(await repo.listStreamLeases(chat.id)).toEqual([])
    expect(await repo.listStreamChunks(streamId)).toEqual([])
  })
})
