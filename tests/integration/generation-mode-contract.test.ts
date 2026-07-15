import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cursorKeyOf } from '../../src/core/active-path'
import type { ApiRoute } from '../../src/core/api-choice'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings, ConnectionProfile, GenerationMeta, Message } from '../../src/core/types'
import { sendFromMessage, sendText } from '../../src/hooks/useChat'
import { continueAssistantInPlace } from '../../src/hooks/useContinue'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { createChat } from '../../src/store/chats'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { putCachedEndpoints } from '../../src/store/models-cache'
import { __resetPrivacyInFlightForTests } from '../../src/store/privacy-cache'
import { __resetStreamLeasesForTests } from '../../src/store/stream-leases'
import type { CommittedPathPresentationReceipt } from '../../src/store/zustand/chatStore'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { useStreamStore } from '../../src/store/zustand/streamStore'
import { useUiStore } from '../../src/store/zustand/uiStore'

const DB_NAME = 'natter'
const CHAT_MODEL = 'google/gemini-3.1-flash-lite-preview'
const PREFILL_MODEL = 'z-ai/glm-5.1'
const UNSUPPORTED_PREFILL_MODEL = 'anthropic/claude-sonnet-4.6'
const ORIGINAL_PROVIDER_CONTEXT = `partial

<tool_call>
Tool: Message
Dialect: openai-responses
Type: message
Result: {
  "type": "message",
  "id": "original-output"
}
</tool_call>`

interface CapturedOpen {
  wireBody: Record<string, unknown>
  route?: ApiRoute
}

function profile(): ConnectionProfile {
  return {
    id: 'prof',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-a',
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

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    ...cloneDefaultChatSettings(),
    profileId: 'prof',
    model: CHAT_MODEL,
    reasoning: {
      mode: 'off',
      exclude: false,
      summary: 'off',
      include: { encrypted: false, summary: false, text: false },
    },
    ...overrides,
  }
}

async function reset(): Promise<void> {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetPrivacyInFlightForTests()
  __resetStreamLeasesForTests()
  useChatStore.getState().reset()
  useStreamStore.getState().reset()
  useUiStore.getState().reset()
  await Dexie.delete(DB_NAME)
}

async function seedModel(model: string): Promise<void> {
  await putCachedEndpoints('prof', model, {
    id: model,
    endpoints: [
      {
        provider_name: 'Test Clean',
        provider_slug: 'test-clean',
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
}

function message(
  chatId: string,
  id: string,
  role: Message['role'],
  text: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id,
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: `${id}:turn`,
    turnIndex: 0,
    createdAt: 1,
    role,
    origin: role === 'assistant' ? 'generated' : 'user',
    content: [{ type: role === 'assistant' ? 'output_text' : 'text', text }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}

async function putMessages(rows: readonly Message[]): Promise<void> {
  const repo = getBrowserRepository()
  for (const row of rows) {
    await repo.runMutation(
      [
        { kind: 'message', messageId: row.id },
        { kind: 'children', chatId: row.chatId, parentId: row.parentId },
      ],
      async (ctx) => {
        await ctx.putMessage(row)
      },
    )
  }
}

function captureOpen(calls: CapturedOpen[], text: string) {
  return (open: { wireBody: Record<string, unknown>; route?: ApiRoute | null }) => {
    calls.push({
      wireBody: structuredClone(open.wireBody),
      ...(open.route ? { route: structuredClone(open.route) } : {}),
    })
    return (async function* () {
      yield {
        type: 'delta' as const,
        chunk: {
          id: 'attempt-generation',
          model: 'attempt-model',
          choices: [{ delta: { content: text }, finish_reason: 'stop' as const }],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 3,
            total_tokens: 10,
            cost: 0.25,
          },
        },
      }
    })()
  }
}

function expectedRoute(): CapturedOpen['route'] {
  return {
    kind: 'chat-completions',
    transport: 'openai-chat',
    reason: 'default (chat completions)',
  }
}

function expectedWire(
  model: string,
  messages: Array<{ role: string; content: string }>,
): Record<string, unknown> {
  return {
    model,
    messages,
    provider: { data_collection: 'deny' },
    reasoning: { enabled: false },
    stream: true,
  }
}

function originalGeneration(): GenerationMeta {
  return {
    id: 'original-generation',
    model: 'original-model',
    requestedModel: 'original-requested-model',
    provider: 'original-provider',
    apiUsed: 'chat',
    delivery: 'streaming',
    usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16, cost: 1.25 },
    cost: 1.25,
    costSource: 'stream',
    startedAt: 10,
    firstTextAt: 11,
    reasoningStartedAt: 12,
    reasoningFinishedAt: 13,
    finishedAt: 14,
    finishReason: 'length',
    error: { category: 'network', code: 'NETWORK', message: 'original interruption' },
    abortReason: 'network',
    serverTools: [
      {
        type: 'web_search_call',
        source: 'responses-output',
        id: 'original-tool',
        status: 'completed',
      },
    ],
  }
}

beforeEach(async () => {
  await reset()
  await openDb()
  await Promise.all([
    seedModel(CHAT_MODEL),
    seedModel(PREFILL_MODEL),
    seedModel(UNSUPPORTED_PREFILL_MODEL),
  ])
})

afterEach(async () => {
  await reset()
})

describe('generation mode contract', () => {
  it('streams a 100k system prompt and 200k prior path through send and continue intact', async () => {
    const systemPrompt = `system-start:${'s'.repeat(100_000)}:system-end`
    const priorUserText = `prior-user-start:${'u'.repeat(100_000)}:prior-user-end`
    const priorAssistantText = `prior-assistant-start:${'a'.repeat(100_000)}:prior-assistant-end`
    const chat = await createChat({
      settings: settings({
        systemPrompt,
        continueSystemPrompt: '[SYSTEM_PROMPT]',
        continueUserPrompt: '',
      }),
    })
    const priorUser = message(chat.id, 'retention-user', 'user', priorUserText)
    const priorAssistant = message(
      chat.id,
      'retention-assistant',
      'assistant',
      priorAssistantText,
      {
        parentId: priorUser.id,
        createdAt: 2,
      },
    )
    await putMessages([priorUser, priorAssistant])

    const sent = await sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'new question' }],
      openStream: (open) => {
        const wire = JSON.stringify(open.wireBody)
        expect(wire).toContain('system-start:')
        expect(wire).toContain(':system-end')
        expect(wire).toContain('prior-user-start:')
        expect(wire).toContain(':prior-user-end')
        expect(wire).toContain('prior-assistant-start:')
        expect(wire).toContain(':prior-assistant-end')
        return captureOpen([], 'answer')(open)
      },
    })

    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: sent.assistantMessageId,
      connection: profile(),
      apiKey: 'sk-test',
      openStream: (open) => {
        const wire = JSON.stringify(open.wireBody)
        expect(wire).toContain('system-start:')
        expect(wire).toContain(':system-end')
        expect(wire).toContain('prior-user-start:')
        expect(wire).toContain(':prior-user-end')
        expect(wire).toContain('prior-assistant-start:')
        expect(wire).toContain(':prior-assistant-end')
        return captureOpen([], ' tail')(open)
      },
    })
  })

  it('send creates one user and one generated assistant with an explicit local path', async () => {
    const chat = await createChat({ settings: settings() })
    const calls: CapturedOpen[] = []

    const result = await sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'new question' }],
      openStream: captureOpen(calls, 'new answer'),
      now: () => 100,
    })

    expect(calls).toEqual([
      {
        route: expectedRoute(),
        wireBody: expectedWire(CHAT_MODEL, [{ role: 'user', content: 'new question' }]),
      },
    ])
    const rows = await getBrowserRepository().listMessages(chat.id)
    expect(rows).toHaveLength(2)
    const user = rows.find((row) => row.id === result.userMessageId)
    const assistant = rows.find((row) => row.id === result.assistantMessageId)
    expect(user).toMatchObject({
      parentId: null,
      siblingIndex: 0,
      turnIndex: 0,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'new question' }],
    })
    expect(assistant).toMatchObject({
      parentId: result.userMessageId,
      siblingIndex: 0,
      turnIndex: 0,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'new answer' }],
    })
    expect(assistant?.turnId).not.toBe(user?.turnId)
    expect(result.outcome).toBe('done')
    const cursor = useChatStore.getState().getCursor(chat.id)
    expect(cursor).toEqual({
      [cursorKeyOf(null)]: result.userMessageId,
      [cursorKeyOf(result.userMessageId)]: result.assistantMessageId,
    })
    const active = await getBrowserRepository().getActiveBranchSnapshot(chat.id, cursor ?? {})
    expect(active.branch.map((row) => row.id)).toEqual([
      result.userMessageId,
      result.assistantMessageId,
    ])
  })

  it('keeps repeated linear sends on their complete explicit local path', async () => {
    const chat = await createChat({ settings: settings() })
    const first = await sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'first question' }],
      openStream: captureOpen([], 'first answer'),
      now: () => 100,
    })
    const second = await sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'second question' }],
      openStream: captureOpen([], 'second answer'),
      now: () => 200,
    })

    const cursor = useChatStore.getState().getCursor(chat.id)
    expect(cursor).toEqual({
      [cursorKeyOf(null)]: first.userMessageId,
      [cursorKeyOf(first.userMessageId)]: first.assistantMessageId,
      [cursorKeyOf(first.assistantMessageId)]: second.userMessageId,
      [cursorKeyOf(second.userMessageId)]: second.assistantMessageId,
    })
    const active = await getBrowserRepository().getActiveBranchSnapshot(chat.id, cursor ?? {})
    expect(active.branch.map((row) => row.id)).toEqual([
      first.userMessageId,
      first.assistantMessageId,
      second.userMessageId,
      second.assistantMessageId,
    ])
  })

  it('prepares and streams two existing branches concurrently without cross-branch invalidation', async () => {
    const chat = await createChat({ settings: settings() })
    const root = message(chat.id, 'parallel-root', 'user', 'root question')
    const left = message(chat.id, 'parallel-left', 'assistant', 'left answer', {
      parentId: root.id,
      siblingIndex: 0,
      createdAt: 2,
    })
    const right = message(chat.id, 'parallel-right', 'assistant', 'right answer', {
      parentId: root.id,
      siblingIndex: 1,
      createdAt: 3,
    })
    await putMessages([root, left, right])

    const repo = getBrowserRepository()

    let releaseStreams!: () => void
    const streamGate = new Promise<void>((resolve) => {
      releaseStreams = resolve
    })
    let markBothOpened!: () => void
    const bothOpened = new Promise<void>((resolve) => {
      markBothOpened = resolve
    })
    const opens: Record<string, unknown>[] = []
    const openStream = (open: { wireBody: Record<string, unknown> }) => {
      opens.push(structuredClone(open.wireBody))
      if (opens.length === 2) markBothOpened()
      return (async function* () {
        await streamGate
        yield {
          type: 'delta' as const,
          chunk: {
            id: 'parallel-generation',
            model: 'attempt-model',
            choices: [{ delta: { content: 'parallel answer' }, finish_reason: 'stop' as const }],
          },
        }
      })()
    }

    const leftSend = sendText({
      chatId: chat.id,
      expectedLeafId: left.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'left followup' }],
      openStream,
    })
    const rightSend = sendText({
      chatId: chat.id,
      expectedLeafId: right.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'right followup' }],
      openStream,
    })

    await bothOpened
    const targetedLeases = await repo.listStreamLeases(chat.id)
    expect(targetedLeases).toHaveLength(2)
    expect(new Set(targetedLeases.map((lease) => lease.messageId)).size).toBe(2)
    expect(
      opens
        .map((wire) => (wire.messages as Array<{ content: string }>).map((entry) => entry.content))
        .sort((a, b) => a.at(-1)?.localeCompare(b.at(-1) ?? '') ?? 0),
    ).toEqual([
      ['root question', 'left answer', 'left followup'],
      ['root question', 'right answer', 'right followup'],
    ])

    releaseStreams()
    const [leftResult, rightResult] = await Promise.all([leftSend, rightSend])
    expect(leftResult.outcome).toBe('done')
    expect(rightResult.outcome).toBe('done')
    const rows = await repo.listMessages(chat.id)
    expect(rows.find((row) => row.id === leftResult.userMessageId)?.parentId).toBe(left.id)
    expect(rows.find((row) => row.id === leftResult.assistantMessageId)?.parentId).toBe(
      leftResult.userMessageId,
    )
    expect(rows.find((row) => row.id === rightResult.userMessageId)?.parentId).toBe(right.id)
    expect(rows.find((row) => row.id === rightResult.assistantMessageId)?.parentId).toBe(
      rightResult.userMessageId,
    )
    expect(await repo.listStreamLeases(chat.id)).toEqual([])
    expect(useStreamStore.getState().listByChat(chat.id)).toEqual([])
  })

  it('allows exactly one simultaneous same-leaf composer append', async () => {
    const chat = await createChat({ settings: settings() })
    let releaseStream!: () => void
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    let markOpened!: () => void
    const opened = new Promise<void>((resolve) => {
      markOpened = resolve
    })
    const opens: string[] = []
    const openStream = (open: { wireBody: Record<string, unknown> }) => {
      opens.push(JSON.stringify(open.wireBody))
      markOpened()
      return (async function* () {
        await streamGate
        yield {
          type: 'delta' as const,
          chunk: {
            id: 'exclusive-generation',
            model: 'attempt-model',
            choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' as const }],
          },
        }
      })()
    }
    const tagged = (promise: ReturnType<typeof sendText>) =>
      promise.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      )
    const first = tagged(
      sendText({
        chatId: chat.id,
        expectedLeafId: null,
        connection: profile(),
        apiKey: 'sk-test',
        content: [{ type: 'text', text: 'concurrent A' }],
        openStream,
      }),
    )
    const second = tagged(
      sendText({
        chatId: chat.id,
        expectedLeafId: null,
        connection: profile(),
        apiKey: 'sk-test',
        content: [{ type: 'text', text: 'concurrent B' }],
        openStream,
      }),
    )

    await opened
    const loser = await Promise.race([first, second])
    expect(loser.status).toBe('rejected')
    if (loser.status !== 'rejected') throw new Error('expected one expected-leaf rejection')
    expect(loser.reason).toMatchObject({
      name: 'ExpectedLeafChangedError',
      reason: 'root-not-empty',
    })
    const rowsWhileStreaming = await getBrowserRepository().listMessages(chat.id)
    const winningUser = rowsWhileStreaming.find((row) => row.role === 'user')
    expect(loser.reason).toMatchObject({ blockingChildId: winningUser?.id })
    expect(await getBrowserRepository().listStreamLeases(chat.id)).toHaveLength(1)
    releaseStream()
    const settled = await Promise.all([first, second])

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(opens).toHaveLength(1)
    const rows = await getBrowserRepository().listMessages(chat.id)
    expect(rows).toHaveLength(2)
    const user = rows.find((row) => row.role === 'user')
    const assistant = rows.find((row) => row.role === 'assistant')
    expect(user?.parentId).toBeNull()
    expect(assistant?.parentId).toBe(user?.id)
    expect(rows.filter((row) => row.parentId === null)).toHaveLength(1)
    expect(await getBrowserRepository().listStreamLeases(chat.id)).toEqual([])
    expect(useStreamStore.getState().listByChat(chat.id)).toEqual([])
  })

  it('sendFromMessage publishes the complete regenerate path in one tab-local cursor write', async () => {
    const chat = await createChat({ settings: settings() })
    const user = message(chat.id, 'regen-user', 'user', 'same question')
    const otherBranch = message(chat.id, 'regen-other-branch', 'assistant', 'other answer', {
      parentId: user.id,
      createdAt: 2,
    })
    const targetBranch = message(chat.id, 'regen-target-branch', 'assistant', 'target answer', {
      parentId: user.id,
      siblingIndex: 1,
      createdAt: 3,
    })
    const followup = message(chat.id, 'regen-followup', 'user', 'follow-up question', {
      parentId: targetBranch.id,
      createdAt: 4,
    })
    const original = message(chat.id, 'regen-original', 'assistant', 'old answer', {
      parentId: followup.id,
      createdAt: 5,
    })
    await putMessages([user, otherBranch, targetBranch, followup, original])
    useChatStore.getState().navigateToCursor(chat.id, {
      [cursorKeyOf(null)]: user.id,
      [cursorKeyOf(user.id)]: otherBranch.id,
    })
    const cursorPublications: Array<Record<string, string>> = []
    let previousCursor = useChatStore.getState().getCursor(chat.id)
    const unsubscribe = useChatStore.subscribe((state) => {
      const cursor = state.getCursor(chat.id)
      if (cursor !== previousCursor) {
        previousCursor = cursor
        cursorPublications.push({ ...(cursor ?? {}) })
      }
    })
    const calls: CapturedOpen[] = []
    let openReceipt: CommittedPathPresentationReceipt | undefined
    let cursorAtProviderOpen: Readonly<Record<string, string>> | undefined
    const capturedStream = captureOpen(calls, 'regenerated answer')

    const result = await sendFromMessage({
      chatId: chat.id,
      parentMessageId: followup.id,
      connection: profile(),
      apiKey: 'sk-test',
      openStream: (input) => {
        openReceipt = useChatStore.getState().getCommittedPathPresentation(chat.id)
        cursorAtProviderOpen = useChatStore.getState().getCursor(chat.id)
        return capturedStream(input)
      },
      now: () => 100,
    }).finally(unsubscribe)

    expect(calls).toEqual([
      {
        route: expectedRoute(),
        wireBody: expectedWire(CHAT_MODEL, [
          { role: 'user', content: 'same question' },
          { role: 'assistant', content: 'target answer' },
          { role: 'user', content: 'follow-up question' },
        ]),
      },
    ])
    const rows = await getBrowserRepository().listMessages(chat.id)
    expect(rows).toHaveLength(6)
    expect(await getBrowserRepository().getMessage(original.id)).toEqual(
      expect.objectContaining({ content: [{ type: 'output_text', text: 'old answer' }] }),
    )
    const regenerated = await getBrowserRepository().getMessage(result.assistantMessageId)
    expect(regenerated).toMatchObject({
      parentId: followup.id,
      siblingIndex: 1,
      turnIndex: 0,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'regenerated answer' }],
    })
    expect(regenerated?.turnId).not.toBe(original.turnId)
    const expectedCursor = {
      [cursorKeyOf(null)]: user.id,
      [cursorKeyOf(user.id)]: targetBranch.id,
      [cursorKeyOf(targetBranch.id)]: followup.id,
      [cursorKeyOf(followup.id)]: result.assistantMessageId,
    }
    expect(openReceipt?.phase).toBe('open')
    expect(openReceipt?.pathHeaders.map((header) => header.id)).toEqual([
      user.id,
      targetBranch.id,
      followup.id,
      result.assistantMessageId,
    ])
    expect(openReceipt?.pathHeaders.at(-1)?.id).toBe(result.assistantMessageId)
    expect(cursorAtProviderOpen).toEqual(expectedCursor)
    expect(useChatStore.getState().getCursor(chat.id)).toEqual(expectedCursor)
    expect(cursorPublications).toEqual([expectedCursor])
    const terminalReceipt = useChatStore.getState().getCommittedPathPresentation(chat.id)
    expect(terminalReceipt?.phase).toBe('terminal')
    expect(terminalReceipt?.pathHeaders.at(-1)?.id).toBe(result.assistantMessageId)
    const terminalPresentation = terminalReceipt?.presentations.find(
      (presentation) => presentation.message.id === result.assistantMessageId,
    )
    expect(terminalPresentation).toMatchObject({
      message: { content: [{ type: 'output_text', text: 'regenerated answer' }] },
    })
    expect(terminalPresentation?.bodyVersion).toBe(terminalPresentation?.header.bodyVersion)
  })

  it('legacy Continue appends in place while preserving original provenance and tree identity', async () => {
    const chat = await createChat({
      settings: settings({
        systemPrompt: 'Original system',
        continueSystemPrompt: 'Continue exactly. Original: [SYSTEM_PROMPT]',
        continueUserPrompt: 'Continue from the next token.',
      }),
    })
    const user = message(chat.id, 'legacy-user', 'user', 'question')
    const generation = originalGeneration()
    const target = message(chat.id, 'legacy-target', 'assistant', 'partial', {
      parentId: user.id,
      createdAt: 2,
      generation,
      reasoningDetails: [{ type: 'reasoning.text', text: 'original reasoning' }],
      phase: 'final_answer',
      responsesEchoItem: { type: 'message', id: 'original-echo' },
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'message',
          item: { type: 'message', id: 'original-output' },
        },
      ],
    })
    await putMessages([user, target])
    const cursorBefore = {
      [cursorKeyOf(null)]: user.id,
      [cursorKeyOf(user.id)]: target.id,
    }
    useChatStore.getState().navigateToCursor(chat.id, cursorBefore)
    const cursorReference = useChatStore.getState().getCursor(chat.id)
    const calls: CapturedOpen[] = []
    const messageCountBefore = (await getBrowserRepository().listMessages(chat.id)).length
    const chatCostBefore = (await getBrowserRepository().getChat(chat.id))?.totalCostUsd

    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: target.id,
      connection: profile(),
      apiKey: 'sk-test',
      openStream: captureOpen(calls, ' continued'),
      now: () => 100,
    })

    expect(calls).toEqual([
      {
        route: expectedRoute(),
        wireBody: expectedWire(CHAT_MODEL, [
          { role: 'system', content: 'Continue exactly. Original: Original system' },
          { role: 'user', content: 'question' },
          { role: 'assistant', content: ORIGINAL_PROVIDER_CONTEXT },
          { role: 'user', content: 'Continue from the next token.' },
        ]),
      },
    ])
    const rows = await getBrowserRepository().listMessages(chat.id)
    expect(rows).toHaveLength(messageCountBefore)
    const continued = rows.find((row) => row.id === target.id)
    expect(continued).toMatchObject({
      id: target.id,
      parentId: target.parentId,
      siblingIndex: target.siblingIndex,
      turnId: target.turnId,
      turnIndex: target.turnIndex,
      createdAt: target.createdAt,
      role: target.role,
      origin: target.origin,
      content: [{ type: 'output_text', text: 'partial continued' }],
      reasoningDetails: target.reasoningDetails,
      phase: target.phase,
      responsesEchoItem: target.responsesEchoItem,
      providerOutputItems: target.providerOutputItems,
    })
    expect(continued?.generation).toEqual(generation)
    expect(useChatStore.getState().getCursor(chat.id)).toEqual(cursorBefore)
    expect(useChatStore.getState().getCursor(chat.id)).toBe(cursorReference)
    const receipt = useChatStore.getState().getCommittedPathPresentation(chat.id)
    expect(receipt?.phase).toBe('terminal')
    expect(receipt?.pathHeaders.at(-1)?.id).toBe(target.id)
    expect(receipt?.pathHeaders.map((header) => header.id)).toEqual([user.id, target.id])
    expect(receipt?.presentations).toHaveLength(1)
    expect(receipt?.presentations[0]).toMatchObject({
      message: { id: target.id, content: [{ type: 'output_text', text: 'partial continued' }] },
    })
    expect(receipt?.presentations[0]?.bodyVersion).toBe(
      receipt?.presentations[0]?.header.bodyVersion,
    )
    expect((await getBrowserRepository().getChat(chat.id))?.totalCostUsd).toBe(chatCostBefore)
  })

  it('keeps a 100k base plus 100k fragmented Continue geometrically segmented until final', async () => {
    const chat = await createChat({
      settings: settings({ continueSystemPrompt: '', continueUserPrompt: '' }),
    })
    const base = 'b'.repeat(100_000)
    const continuation = 'c'.repeat(100_000)
    const user = message(chat.id, 'large-continue-user', 'user', 'question')
    const target = message(chat.id, 'large-continue-target', 'assistant', base, {
      parentId: user.id,
      createdAt: 2,
    })
    await putMessages([user, target])
    useUiStore.getState().setActiveChatId(chat.id)
    const setLiveSnapshot = vi.spyOn(useStreamStore.getState(), 'setLiveSnapshot')
    let clock = 100

    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: target.id,
      connection: profile(),
      apiKey: 'sk-test',
      now: () => ++clock,
      openStream: () =>
        (async function* () {
          for (let offset = 0; offset < continuation.length; offset += 128) {
            yield {
              type: 'delta' as const,
              chunk: {
                choices: [
                  {
                    delta: { content: continuation.slice(offset, offset + 128) },
                    ...(offset + 128 >= continuation.length
                      ? { finish_reason: 'stop' as const }
                      : {}),
                  },
                ],
              },
            }
          }
        })(),
    })

    const snapshots = setLiveSnapshot.mock.calls.map(([snapshot]) => snapshot)
    expect(snapshots.length).toBeGreaterThan(10)
    const continuationBlockBudget =
      Math.floor(Math.log2(Math.ceil(continuation.length / 20_000))) + 2
    for (const snapshot of snapshots) {
      const textItems = snapshot.content.filter(
        (item) => item.type === 'text' || item.type === 'output_text',
      )
      expect(textItems[0]?.text).toBe(base)
      expect(textItems.length).toBeLessThanOrEqual(continuationBlockBudget)
      expect(snapshot.textLength).toBeGreaterThanOrEqual(base.length)
      expect(snapshot.textLength).toBeLessThanOrEqual(base.length + continuation.length)
    }
    expect(
      snapshots.some((snapshot) =>
        snapshot.content.some(
          (item, index) =>
            index > 0 &&
            (item.type === 'text' || item.type === 'output_text') &&
            item.text.length > 20_000,
        ),
      ),
    ).toBe(true)
    expect(await getBrowserRepository().getMessage(target.id)).toMatchObject({
      content: [{ type: 'output_text', text: base + continuation }],
    })
  })

  it('rejects a second same-target Continue before opening another provider stream', async () => {
    const chat = await createChat({
      settings: settings({ continueSystemPrompt: '', continueUserPrompt: '' }),
    })
    const user = message(chat.id, 'concurrent-continue-user', 'user', 'question')
    const target = message(chat.id, 'concurrent-continue-target', 'assistant', 'base', {
      parentId: user.id,
      createdAt: 2,
    })
    await putMessages([user, target])

    let opened!: () => void
    const firstOpened = new Promise<void>((resolve) => {
      opened = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const open = (tail: string) => () =>
      (async function* () {
        opened()
        await gate
        yield {
          type: 'delta' as const,
          chunk: {
            choices: [{ delta: { content: tail }, finish_reason: 'stop' as const }],
          },
        }
      })()

    const first = continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: target.id,
      connection: profile(),
      apiKey: 'sk-test',
      openStream: open('-one'),
    })
    await firstOpened
    const second = continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: target.id,
      connection: profile(),
      apiKey: 'sk-test',
      openStream: vi.fn(() =>
        (async function* () {
          yield {
            type: 'delta' as const,
            chunk: { choices: [{ delta: { content: '-two' }, finish_reason: 'stop' as const }] },
          }
        })(),
      ),
    })

    await expect(second).rejects.toThrow(`StreamTargetBusy:${target.id}`)
    release()
    await first

    expect(await getBrowserRepository().getMessage(target.id)).toMatchObject({
      content: [{ type: 'output_text', text: 'base-one' }],
      continuationAttempts: [{ status: 'done' }],
    })
  })

  it('rejects a manual body edit while Continue owns the target', async () => {
    const chat = await createChat({
      settings: settings({ continueSystemPrompt: '', continueUserPrompt: '' }),
    })
    const user = message(chat.id, 'edited-continue-user', 'user', 'question')
    const target = message(chat.id, 'edited-continue-target', 'assistant', 'base', {
      parentId: user.id,
      createdAt: 2,
    })
    await putMessages([user, target])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let opened!: () => void
    const didOpen = new Promise<void>((resolve) => {
      opened = resolve
    })
    const continuing = continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: target.id,
      connection: profile(),
      apiKey: 'sk-test',
      openStream: () =>
        (async function* () {
          opened()
          await gate
          yield {
            type: 'delta' as const,
            chunk: {
              choices: [{ delta: { content: '-tail' }, finish_reason: 'stop' as const }],
            },
          }
        })(),
    })

    await didOpen
    await expect(
      getBrowserRepository().runMutation(
        [{ kind: 'message', messageId: target.id }],
        async (ctx) => {
          const current = await ctx.getMessage(target.id)
          if (!current) throw new Error('missing Continue target')
          await ctx.putMessage({
            ...current,
            content: [{ type: 'output_text', text: 'manually edited' }],
          })
        },
      ),
    ).rejects.toThrow(`StreamTargetBusy:${target.id}`)
    release()
    await continuing

    expect(await getBrowserRepository().getMessage(target.id)).toMatchObject({
      content: [{ type: 'output_text', text: 'base-tail' }],
      continuationAttempts: [{ status: 'done' }],
    })
  })

  it('rejects hard deletion while Continue owns the target', async () => {
    const chat = await createChat({
      settings: settings({ continueSystemPrompt: '', continueUserPrompt: '' }),
    })
    const user = message(chat.id, 'deleted-continue-user', 'user', 'question')
    const target = message(chat.id, 'deleted-continue-target', 'assistant', 'base', {
      parentId: user.id,
      createdAt: 2,
    })
    await putMessages([user, target])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let opened!: () => void
    const didOpen = new Promise<void>((resolve) => {
      opened = resolve
    })
    const continuing = continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: target.id,
      connection: profile(),
      apiKey: 'sk-test',
      openStream: () =>
        (async function* () {
          opened()
          await gate
          yield {
            type: 'delta' as const,
            chunk: {
              choices: [{ delta: { content: '-tail' }, finish_reason: 'stop' as const }],
            },
          }
        })(),
    })

    await didOpen
    await expect(
      getBrowserRepository().runMutation(
        [
          { kind: 'message', messageId: target.id },
          { kind: 'children', chatId: chat.id, parentId: user.id },
        ],
        async (ctx) => ctx.deleteMessage(target.id),
      ),
    ).rejects.toThrow(`StreamTargetBusy:${target.id}`)
    release()
    await continuing

    expect(await getBrowserRepository().getMessage(target.id)).toMatchObject({
      content: [{ type: 'output_text', text: 'base-tail' }],
      continuationAttempts: [{ status: 'done' }],
    })
  })

  it('prefill Continue uses the target as the assistant prefix and ignores continue prompts', async () => {
    const chat = await createChat({
      settings: settings({
        model: PREFILL_MODEL,
        systemPrompt: 'Prefill system',
        continuePrefill: true,
        continueSystemPrompt: 'MUST NOT APPEAR SYSTEM',
        continueUserPrompt: 'MUST NOT APPEAR USER',
      }),
    })
    const user = message(chat.id, 'prefill-user', 'user', 'prefill question')
    const target = message(chat.id, 'prefill-target', 'assistant', 'prefix', {
      parentId: user.id,
      createdAt: 2,
    })
    await putMessages([user, target])
    const cursorBefore = {
      [cursorKeyOf(null)]: user.id,
      [cursorKeyOf(user.id)]: target.id,
    }
    useChatStore.getState().navigateToCursor(chat.id, cursorBefore)
    const calls: CapturedOpen[] = []

    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: target.id,
      connection: profile(),
      apiKey: 'sk-test',
      openStream: captureOpen(calls, ' tail'),
      now: () => 100,
    })

    expect(calls).toEqual([
      {
        route: expectedRoute(),
        wireBody: expectedWire(PREFILL_MODEL, [
          { role: 'system', content: 'Prefill system' },
          { role: 'user', content: 'prefill question' },
          { role: 'assistant', content: 'prefix' },
        ]),
      },
    ])
    const rows = await getBrowserRepository().listMessages(chat.id)
    expect(rows).toHaveLength(2)
    expect(await getBrowserRepository().getMessage(target.id)).toMatchObject({
      id: target.id,
      parentId: user.id,
      siblingIndex: 0,
      turnId: target.turnId,
      origin: 'generated',
      content: [{ type: 'output_text', text: 'prefix tail' }],
    })
    expect(useChatStore.getState().getCursor(chat.id)).toEqual(cursorBefore)
    expect(JSON.stringify(calls[0]?.wireBody)).not.toContain('MUST NOT APPEAR')
  })

  it('unsupported prefill falls back to legacy Continue prompts without creating a row', async () => {
    const chat = await createChat({
      settings: settings({
        model: UNSUPPORTED_PREFILL_MODEL,
        systemPrompt: 'Claude original system',
        continuePrefill: true,
        continueSystemPrompt: 'Legacy fallback: [SYSTEM_PROMPT]',
        continueUserPrompt: 'Legacy fallback user',
      }),
    })
    const user = message(chat.id, 'fallback-user', 'user', 'fallback question')
    const target = message(chat.id, 'fallback-target', 'assistant', 'fallback partial', {
      parentId: user.id,
      createdAt: 2,
    })
    await putMessages([user, target])
    const calls: CapturedOpen[] = []

    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: target.id,
      connection: profile(),
      apiKey: 'sk-test',
      openStream: captureOpen(calls, ' completed'),
      now: () => 100,
    })

    expect(calls).toEqual([
      {
        route: expectedRoute(),
        wireBody: expectedWire(UNSUPPORTED_PREFILL_MODEL, [
          { role: 'system', content: 'Legacy fallback: Claude original system' },
          { role: 'user', content: 'fallback question' },
          { role: 'assistant', content: 'fallback partial' },
          { role: 'user', content: 'Legacy fallback user' },
        ]),
      },
    ])
    const rows = await getBrowserRepository().listMessages(chat.id)
    expect(rows).toHaveLength(2)
    expect(await getBrowserRepository().getMessage(target.id)).toMatchObject({
      id: target.id,
      parentId: user.id,
      content: [{ type: 'output_text', text: 'fallback partial completed' }],
    })
  })

  it('Continue pins a non-current branch for planning but leaves the stored cursor untouched', async () => {
    const chat = await createChat({
      settings: settings({
        continueSystemPrompt: '',
        continueUserPrompt: 'Continue the selected branch.',
      }),
    })
    const user = message(chat.id, 'branch-user', 'user', 'branch question')
    const left = message(chat.id, 'branch-left', 'assistant', 'left partial', {
      parentId: user.id,
      siblingIndex: 0,
      createdAt: 2,
    })
    const right = message(chat.id, 'branch-right', 'assistant', 'right current', {
      parentId: user.id,
      siblingIndex: 1,
      createdAt: 3,
    })
    await putMessages([user, left, right])
    const rightBefore = await getBrowserRepository().getMessage(right.id)
    const cursorBefore = {
      [cursorKeyOf(null)]: user.id,
      [cursorKeyOf(user.id)]: right.id,
    }
    useChatStore.getState().navigateToCursor(chat.id, cursorBefore)
    const calls: CapturedOpen[] = []

    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: left.id,
      connection: profile(),
      apiKey: 'sk-test',
      openStream: captureOpen(calls, ' extended'),
      now: () => 100,
    })

    expect(calls).toEqual([
      {
        route: expectedRoute(),
        wireBody: expectedWire(CHAT_MODEL, [
          { role: 'user', content: 'branch question' },
          { role: 'assistant', content: 'left partial' },
          { role: 'user', content: 'Continue the selected branch.' },
        ]),
      },
    ])
    expect(useChatStore.getState().getCursor(chat.id)).toEqual(cursorBefore)
    expect(await getBrowserRepository().getMessage(left.id)).toMatchObject({
      id: left.id,
      parentId: user.id,
      siblingIndex: 0,
      turnId: left.turnId,
      origin: 'generated',
      content: [{ type: 'output_text', text: 'left partial extended' }],
    })
    expect(await getBrowserRepository().getMessage(right.id)).toEqual(rightBefore)
    expect(await getBrowserRepository().listMessages(chat.id)).toHaveLength(3)
  })
})
