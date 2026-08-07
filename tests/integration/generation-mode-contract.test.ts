import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import { browserConversationNavigationPort, chatHref, navigate } from '../../src/app/router'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { fixedConversationSelectionTarget } from '../../src/core/messages'
import type {
  ChatSettings,
  ConnectionProfile,
  GenerationMeta,
  Message,
  MessageId,
  MessageRole,
} from '../../src/core/types'
import { attemptController } from '../../src/store/attempt-controller'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { getChat } from '../../src/store/chats'
import { importMessagesOp } from '../../src/store/conversation-command-client'
import {
  type ConversationPresentationResourcePort,
  conversationController,
} from '../../src/store/conversation-controller'
import { __resetDbForTests, getDb } from '../../src/store/db'
import {
  createGenerationEngine,
  type GenerationHandle,
  type GenerationIntent,
  type GenerationTransportInput,
} from '../../src/store/generation-engine'
import { type MessageBodyRow, splitMessageForStorage } from '../../src/store/message-storage'
import { getWorkspaceRepository } from '../../src/store/workspace-repository'
import { runWorkspaceRead } from '../../src/store/workspace-runtime'
import { CONVERSATION_SESSION_PREFIX } from '../../src/store/workspace-tab-session'
import { createChat, updateChatForTest } from '../helpers/chats'
import { putCachedEndpoints, putCachedPrivacyPolicy } from '../helpers/discovery-cache'
import { installGenerationProfile, startControlledGeneration } from '../helpers/generation-engine'
import { executeMessageCommand } from '../helpers/message-commands'
import { readTestMessages } from '../helpers/message-storage'
import { reasoningEnvelopeFromDetailsForTest } from '../helpers/reasoning-events'

const DB_NAME = 'natter'
const CHAT_MODEL = 'google/gemini-3.1-flash-lite-preview'
const PREFILL_MODEL = 'z-ai/glm-5.1'
const UNSUPPORTED_PREFILL_MODEL = 'anthropic/claude-sonnet-4.6'
const ORIGINAL_PROVIDER_CONTEXT = `partial

<tool_evidence>
<tool_call>
Tool: Message
Dialect: openai-responses
Type: message
Result: {"type": "message", "id": "original-output"}
</tool_call>
</tool_evidence>`

interface CapturedOpen {
  wireBody: Record<string, unknown>
  route: Pick<GenerationTransportInput['requestPlan'], 'kind' | 'transport' | 'reason'>
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
    profileId: profile().id,
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
  sessionStorage.clear()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await reset()
  await openBrowserWorkspace()
  await installGenerationProfile(profile(), { 'key-a': 'sk-test' })
  await Promise.all([
    seedModel(CHAT_MODEL),
    seedModel(PREFILL_MODEL),
    seedModel(UNSUPPORTED_PREFILL_MODEL),
  ])
})

afterEach(async () => {
  vi.restoreAllMocks()
  await shutdownBrowserWorkspace()
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
    const [priorUser, priorAssistant] = await seedLinear(chat.id, [
      { role: 'user', text: priorUserText },
      { role: 'assistant', text: priorAssistantText },
    ])
    const sendCaptures: CapturedOpen[] = []
    const sent = await run(
      {
        kind: 'send',
        chatId: chat.id,
        target: {
          kind: 'fixed',
          messageId: required(priorAssistant, 'prior assistant').id,
        },
        content: [{ type: 'text', text: 'new question' }],
      },
      captureOpen(sendCaptures, 'answer'),
    )
    expect(JSON.stringify(sendCaptures[0]?.wireBody)).toContain('system-start:')
    expect(JSON.stringify(sendCaptures[0]?.wireBody)).toContain(':system-end')
    const priorUserContent = required(priorUser, 'prior user').content[0]
    expect(JSON.stringify(sendCaptures[0]?.wireBody)).toContain(
      priorUserContent &&
        (priorUserContent.type === 'text' || priorUserContent.type === 'output_text')
        ? priorUserContent.text
        : '',
    )
    expect(JSON.stringify(sendCaptures[0]?.wireBody)).toContain(priorAssistantText)

    const continueCaptures: CapturedOpen[] = []
    await run(
      {
        kind: 'continue',
        chatId: chat.id,
        targetAssistantId: sent.assistantMessageId,
      },
      captureOpen(continueCaptures, ' tail'),
    )
    const continuedWire = JSON.stringify(continueCaptures[0]?.wireBody)
    expect(continuedWire).toContain('system-start:')
    expect(continuedWire).toContain(':system-end')
    expect(continuedWire).toContain(priorUserText)
    expect(continuedWire).toContain(priorAssistantText)
  })

  it('resolves the default provider cutoff before hydrating a deep send path', async () => {
    const boundedSettings = settings({
      maxCompletionTokens: 0,
      contextStrategy: {
        ...cloneDefaultChatSettings().contextStrategy,
        kind: 'sliding_window',
        keepFirstPairs: 0,
      },
    })
    expect(boundedSettings.customMaxContext).toBeUndefined()
    const chat = await createChat({ settings: boundedSettings })
    const history = await seedLinear(
      chat.id,
      Array.from({ length: 24 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        text: `history-${index}:${String(index).padStart(2, '0')}:${'x'.repeat(180)}`,
      })),
    )
    await putCachedEndpoints(profile().id, CHAT_MODEL, {
      id: CHAT_MODEL,
      endpoints: [
        {
          provider_name: 'Test Clean',
          provider_slug: 'test-clean',
          supported_parameters: ['temperature'],
          context_length: 100,
          max_prompt_tokens: 100,
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
    const reads = captureBodyReads()
    let readsAtProviderOpen: MessageId[] = []
    let wireAtProviderOpen: Record<string, unknown> = {}

    const completed = await run(
      {
        kind: 'send',
        chatId: chat.id,
        target: {
          kind: 'fixed',
          messageId: required(history.at(-1), 'history leaf').id,
        },
        content: [{ type: 'text', text: 'fresh submitted question' }],
      },
      (open) => {
        readsAtProviderOpen = [...reads.ids]
        wireAtProviderOpen = structuredClone(open.requestPlan.wire)
        return completedStream('bounded answer')
      },
    )
    reads.stop()

    expect(completed, JSON.stringify(completed)).toMatchObject({ outcome: 'done' })
    const wireText = JSON.stringify(wireAtProviderOpen)
    expect(wireText).toContain('fresh submitted question')
    expect(wireText).not.toContain('history-0:00')
    expect(readsAtProviderOpen).not.toContain(required(history[0], 'cold prefix user').id)
    expect(readsAtProviderOpen).not.toContain(required(history[1], 'cold prefix assistant').id)
    expect(new Set(readsAtProviderOpen).size).toBeLessThanOrEqual(16)
  })

  it('send creates one user and one generated assistant and selects its exact tip in this tab', async () => {
    const chat = await createChat({ settings: settings() })
    const calls: CapturedOpen[] = []
    const result = await run(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'new question' }],
      },
      captureOpen(calls, 'new answer'),
      () => 100,
    )

    expect(calls).toEqual([
      {
        route: expectedRoute(),
        wireBody: expectedWire(CHAT_MODEL, [{ role: 'user', content: 'new question' }]),
      },
    ])
    const rows = await messages(chat.id)
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
      turnIndex: 1,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'new answer' }],
      generation: { status: 'done' },
    })
    expect(assistant?.turnId).toBe(user?.turnId)
    expect(storedSelection(chat.id)).toEqual({ kind: 'tip', messageId: result.assistantMessageId })
    expect((await branchHeaders(chat.id, result.assistantMessageId)).map((row) => row.id)).toEqual([
      result.userMessageId,
      result.assistantMessageId,
    ])
  })

  it('commits the terminal send body before removing its attempt after newer tab navigation', async () => {
    const chat = await createChat({ settings: settings() })
    const gate = providerGate('answer after navigation')
    const handle = await start(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'question before navigation' }],
      },
      gate.openStream,
    )
    const prepared = await handle.prepared
    await gate.opened
    const terminalAtRemoval = terminalMessageAtAttemptRemoval(handle, prepared.assistantMessageId)
    conversationController.navigate({
      chatId: chat.id,
      kind: 'message',
      messageId: required(prepared.userMessageId, 'prepared user'),
    })
    const newerTipId = await waitForConversationTip(chat.id, prepared.assistantMessageId)

    gate.release()
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
    expect(await terminalAtRemoval).toMatchObject({
      id: prepared.assistantMessageId,
      content: [{ type: 'output_text', text: 'answer after navigation' }],
      generation: { status: 'done' },
    })
    expect(conversationTip(chat.id)).toBe(newerTipId)
  })

  it('keeps repeated linear sends on their complete explicit path', async () => {
    const chat = await createChat({ settings: settings() })
    const first = await run(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'first question' }],
      },
      captureOpen([], 'first answer'),
    )
    const second = await run(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: first.assistantMessageId },
        content: [{ type: 'text', text: 'second question' }],
      },
      captureOpen([], 'second answer'),
    )

    expect((await branchHeaders(chat.id, second.assistantMessageId)).map((row) => row.id)).toEqual([
      first.userMessageId,
      first.assistantMessageId,
      second.userMessageId,
      second.assistantMessageId,
    ])
    expect(storedSelection(chat.id)).toEqual({ kind: 'tip', messageId: second.assistantMessageId })
  })

  it('prepares and streams two existing branches concurrently without cross-branch invalidation', async () => {
    const { chatId, root, left, right } = await seedTwoBranches()
    await openConversationAt(chatId, left.id)
    const releaseTopology = await demandTreeTopology(chatId)
    const gate = sharedProviderGate(2)
    try {
      const leftHandle = await start(
        {
          kind: 'send',
          chatId,
          target: { kind: 'fixed', messageId: left.id },
          content: [{ type: 'text', text: 'left followup' }],
        },
        gate.openStream,
      )
      const rightHandle = await start(
        {
          kind: 'send',
          chatId,
          target: { kind: 'fixed', messageId: right.id },
          content: [{ type: 'text', text: 'right followup' }],
        },
        gate.openStream,
      )
      const [leftPrepared, rightPrepared] = await Promise.all([
        leftHandle.prepared,
        rightHandle.prepared,
      ])
      await gate.allOpened

      expect(await streamLeases(chatId)).toHaveLength(2)
      expect(
        gate.wires
          .map((wire) =>
            (wire.messages as Array<{ content: string }>).map((entry) => entry.content),
          )
          .sort((a, b) => a.at(-1)?.localeCompare(b.at(-1) ?? '') ?? 0),
      ).toEqual([
        ['root question', 'left answer', 'left followup'],
        ['root question', 'right answer', 'right followup'],
      ])

      gate.release()
      await expect(Promise.all([leftHandle.completed, rightHandle.completed])).resolves.toEqual([
        expect.objectContaining({ outcome: 'done' }),
        expect.objectContaining({ outcome: 'done' }),
      ])
      expect((await message(required(leftPrepared.userMessageId, 'left user')))?.parentId).toBe(
        left.id,
      )
      expect((await message(leftPrepared.assistantMessageId))?.parentId).toBe(
        leftPrepared.userMessageId,
      )
      expect((await message(required(rightPrepared.userMessageId, 'right user')))?.parentId).toBe(
        right.id,
      )
      expect((await message(rightPrepared.assistantMessageId))?.parentId).toBe(
        rightPrepared.userMessageId,
      )
      expect(await message(root.id)).toBeDefined()
      expect(await streamLeases(chatId)).toEqual([])
    } finally {
      releaseTopology()
    }
  })

  it('serializes simultaneous same-parent composer appends into distinct branches', async () => {
    const chat = await createChat({ settings: settings() })
    const gate = sharedProviderGate(2)
    const first = await start(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'concurrent A' }],
      },
      gate.openStream,
    )
    const second = await start(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'concurrent B' }],
      },
      gate.openStream,
    )
    const prepared = await Promise.all([first.prepared, second.prepared])
    await gate.allOpened

    expect(prepared.map((result) => result.userMessageId)).toHaveLength(2)
    expect(await streamLeases(chat.id)).toHaveLength(2)
    gate.release()
    const completed = await Promise.all([first.completed, second.completed])
    expect(completed.every((result) => result.outcome === 'done')).toBe(true)
    expect(gate.wires).toHaveLength(2)
    const rows = await messages(chat.id)
    const users = rows
      .filter((message) => message.role === 'user')
      .sort((left, right) => left.siblingIndex - right.siblingIndex)
    expect(users.map((message) => [message.parentId, message.siblingIndex])).toEqual([
      [null, 0],
      [null, 1],
    ])
    expect(rows).toHaveLength(4)
    expect(await streamLeases(chat.id)).toEqual([])
  })

  it('regenerate captures its complete frozen path and selects the new sibling tip', async () => {
    const chat = await createChat({ settings: settings() })
    const [user, targetBranch, followup, original] = await seedLinear(chat.id, [
      { role: 'user', text: 'same question' },
      { role: 'assistant', text: 'target answer' },
      { role: 'user', text: 'follow-up question' },
      { role: 'assistant', text: 'old answer' },
    ])
    const otherBranch = await executeMessageCommand({
      kind: 'message.insert-sibling',
      input: {
        chatId: chat.id,
        targetId: required(targetBranch, 'target branch').id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'other answer' }],
      },
    })
    conversationController.navigate({
      chatId: chat.id,
      kind: 'message',
      messageId: otherBranch.messageId,
    })
    const calls: CapturedOpen[] = []

    const result = await run(
      {
        kind: 'regenerate',
        chatId: chat.id,
        targetAssistantId: required(original, 'original assistant').id,
      },
      captureOpen(calls, 'regenerated answer'),
    )

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
    expect(await message(required(user, 'root user').id)).toBeDefined()
    expect(await message(required(original, 'original').id)).toMatchObject({
      content: [{ type: 'output_text', text: 'old answer' }],
    })
    expect(await message(result.assistantMessageId)).toMatchObject({
      parentId: required(followup, 'followup').id,
      siblingIndex: 1,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'regenerated answer' }],
    })
    expect(storedSelection(chat.id)).toEqual({ kind: 'tip', messageId: result.assistantMessageId })
  })

  it('persists regenerated settings while removing the superseded resolution link', async () => {
    const chat = await createChat({ settings: settings() })
    const [, target] = await seedLinear(chat.id, [
      { role: 'user', text: 'same question' },
      { role: 'assistant', text: 'old answer' },
    ])
    await updateChatForTest(chat.id, {
      modelResolution: {
        intentId: 'superseded-resolution',
        target: {
          profileId: profile().id,
          requestRevision: 0,
          key: { kind: 'missing' },
        },
        sourceModelId: CHAT_MODEL,
        expectedConfigurationVersion: 0,
      },
    })

    const result = await run(
      {
        kind: 'regenerate',
        chatId: chat.id,
        targetAssistantId: required(target, 'target assistant').id,
        settingsPatch: { systemPrompt: 'persisted by regenerate' },
      },
      captureOpen([], 'regenerated answer'),
    )

    expect(result.error?.message).toBeUndefined()
    expect(result).toMatchObject({ outcome: 'done' })
    const stored = await getChat(chat.id)
    expect(stored).toMatchObject({
      settings: { systemPrompt: 'persisted by regenerate' },
    })
    expect(stored?.modelResolution).toBeUndefined()
    const links = await getDb()
      .configurationLinks.where('ownerKey')
      .equals(`chat:${chat.id}`)
      .toArray()
    expect(links.some((link) => link.targetKind === 'model-resolution')).toBe(false)
    expect(links.filter((link) => link.targetKind === 'profile')).toMatchObject([
      { targetId: profile().id },
    ])
    expect(await getDb().configurationProfileUsageRows.get(profile().id)).toMatchObject({
      chatCount: 1,
      activeChatCount: 1,
    })
  })

  it('Continue appends in place while preserving original provenance and tree identity', async () => {
    const chat = await createChat({
      settings: settings({
        systemPrompt: 'Original system',
        continueSystemPrompt: 'Continue exactly. Original: [SYSTEM_PROMPT]',
        continueUserPrompt: 'Continue from the next token.',
      }),
    })
    const [user, target] = await seedLinear(chat.id, [
      { role: 'user', text: 'question' },
      { role: 'assistant', text: 'partial' },
    ])
    const generation = originalGeneration()
    const reasoningEnvelope = reasoningEnvelopeFromDetailsForTest(
      [{ type: 'reasoning.text', text: 'original reasoning' }],
      'openrouter-chat',
    )
    const original = await patchMessageFixture(required(target, 'target').id, {
      generation,
      reasoningEnvelope,
      phase: 'final_answer',
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'message',
          item: { type: 'message', id: 'original-output' },
        },
      ],
    })
    const tipBefore = await openConversationAt(chat.id, original.id)
    const messageCountBefore = (await messages(chat.id)).length
    const chatCostBefore = (await getChat(chat.id))?.totalCostUsd
    const calls: CapturedOpen[] = []

    await run(
      { kind: 'continue', chatId: chat.id, targetAssistantId: original.id },
      captureOpen(calls, ' continued'),
    )

    expect(calls).toEqual([
      {
        route: {
          kind: 'responses',
          transport: 'openai-responses',
          reason: 'prior server-tool output requires Responses for round-trip',
        },
        wireBody: {
          model: CHAT_MODEL,
          instructions: 'Continue exactly. Original: Original system',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'question' }],
            },
            {
              type: 'message',
              role: 'assistant',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: ORIGINAL_PROVIDER_CONTEXT }],
            },
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Continue from the next token.' }],
            },
          ],
          provider: { data_collection: 'deny' },
          store: false,
          stream: true,
        },
      },
    ])
    expect(await messages(chat.id)).toHaveLength(messageCountBefore)
    const continued = required(await message(original.id), 'continued target')
    expect(continued).toMatchObject({
      id: original.id,
      parentId: original.parentId,
      siblingIndex: original.siblingIndex,
      turnId: original.turnId,
      turnIndex: original.turnIndex,
      createdAt: original.createdAt,
      role: original.role,
      origin: original.origin,
      content: [{ type: 'output_text', text: 'partial continued' }],
      reasoningEnvelope: original.reasoningEnvelope,
      phase: original.phase,
      providerOutputItems: original.providerOutputItems,
    })
    expect(continued.generation).toEqual(generation)
    expect(continued.continuationAttempts).toEqual([expect.objectContaining({ status: 'done' })])
    expect(conversationTip(chat.id)).toBe(tipBefore)
    expect((await getChat(chat.id))?.totalCostUsd).toBe(chatCostBefore)
    expect(required(user, 'user').id).toBe(original.parentId)
  })

  it('commits the terminal Continue body before removing its attempt after newer navigation', async () => {
    const { chatId, root: user, left: target, right: newerSibling } = await seedTwoBranches()
    conversationController.navigate({
      chatId,
      kind: 'message',
      messageId: target.id,
    })
    const gate = providerGate(' continued')
    const handle = await start(
      { kind: 'continue', chatId, targetAssistantId: target.id },
      gate.openStream,
    )
    await handle.prepared
    await gate.opened
    const terminalAtRemoval = terminalMessageAtAttemptRemoval(handle, target.id)
    conversationController.navigate({
      chatId,
      kind: 'message',
      messageId: newerSibling.id,
    })
    const newerTipId = await waitForConversationTip(chatId, newerSibling.id)

    gate.release()
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
    expect(await terminalAtRemoval).toMatchObject({
      id: target.id,
      content: [{ type: 'output_text', text: 'left answer continued' }],
      continuationAttempts: [expect.objectContaining({ status: 'done' })],
    })
    expect(conversationTip(chatId)).toBe(newerTipId)
    expect(await message(user.id)).toBeDefined()
  })

  it('keeps a 100k base plus 100k fragmented Continue geometrically segmented until final', async () => {
    const chat = await createChat({
      settings: settings({ continueSystemPrompt: '', continueUserPrompt: '' }),
    })
    const base = 'b'.repeat(100_000)
    const continuation = 'c'.repeat(100_000)
    const [, target] = await seedLinear(chat.id, [
      { role: 'user', text: 'question' },
      { role: 'assistant', text: base },
    ])
    const targetId = required(target, 'target').id
    const snapshots: Array<{
      baseContent: readonly Message['content'][number][] | undefined
      content: readonly Message['content'][number][]
    }> = []
    const stop = attemptController.subscribeTarget(chat.id, targetId, () => {
      const live = attemptController.getTargetSnapshot(chat.id, targetId).liveProjection
      if (live) {
        snapshots.push({
          baseContent: live.baseContent ? structuredClone([...live.baseContent]) : undefined,
          content: structuredClone([...live.content]),
        })
      }
    })

    await run({ kind: 'continue', chatId: chat.id, targetAssistantId: targetId }, () =>
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
    )
    stop()

    expect(snapshots.length).toBeGreaterThan(1)
    expect(snapshots.length).toBeLessThanOrEqual(64)
    const continuationBlockBudget = Math.floor(Math.log2(Math.ceil(100_000 / 20_000))) + 2
    for (const snapshot of snapshots) {
      expect(snapshot.baseContent).toEqual([{ type: 'output_text', text: base }])
      const textItems = snapshot.content.filter(
        (item) => item.type === 'text' || item.type === 'output_text',
      )
      expect(textItems.length).toBeLessThanOrEqual(continuationBlockBudget)
    }
    expect(await message(targetId)).toMatchObject({
      content: [{ type: 'output_text', text: base + continuation }],
    })
  })

  it('does not start a second same-target Continue or open another provider stream', async () => {
    const chat = await createChat({
      settings: settings({ continueSystemPrompt: '', continueUserPrompt: '' }),
    })
    const [, target] = await seedLinear(chat.id, [
      { role: 'user', text: 'question' },
      { role: 'assistant', text: 'base' },
    ])
    const targetId = required(target, 'target').id
    const gate = providerGate('-one')
    const first = await start(
      { kind: 'continue', chatId: chat.id, targetAssistantId: targetId },
      gate.openStream,
    )
    const secondOpen = vi.fn(() => completedStream('-two'))
    const second = createGenerationEngine({ openStream: secondOpen }).start({
      intent: {
        kind: 'continue',
        chatId: chat.id,
        targetAssistantId: targetId,
      },
    })

    try {
      expect(second).toEqual({
        kind: 'not-started',
        capability: { state: 'pending', owner: 'attempt-target' },
      })
      expect(secondOpen).not.toHaveBeenCalled()
    } finally {
      gate.release()
    }
    await first.prepared
    await gate.opened
    await expect(first.completed).resolves.toMatchObject({ outcome: 'done' })
    expect(await message(targetId)).toMatchObject({
      content: [{ type: 'output_text', text: 'base-one' }],
      continuationAttempts: [expect.objectContaining({ status: 'done' })],
    })
  })

  it('lets current durable Continue proceed when the optional attempt frame is stale', async () => {
    const chat = await createChat({
      settings: settings({ continueSystemPrompt: '', continueUserPrompt: '' }),
    })
    const [, target] = await seedLinear(chat.id, [
      { role: 'user', text: 'question' },
      { role: 'assistant', text: 'base' },
    ])
    const targetId = required(target, 'target').id
    attemptController.replaceWorkspace({
      workspaceId: 'stale-attempt-controller-workspace',
      replacementEpoch: Number.MAX_SAFE_INTEGER,
    })
    const openStream = vi.fn(() => completedStream('-continued'))

    const result = await run(
      { kind: 'continue', chatId: chat.id, targetAssistantId: targetId },
      openStream,
    )

    expect(result).toMatchObject({ outcome: 'done' })
    expect(openStream).toHaveBeenCalledTimes(1)
    expect(await message(targetId)).toMatchObject({
      content: [{ type: 'output_text', text: 'base-continued' }],
      continuationAttempts: [expect.objectContaining({ status: 'done' })],
    })
  })

  it('rejects a public manual body edit while Continue owns the target', async () => {
    const { chatId, target, handle, gate } = await activeContinue('edited')
    await expect(
      executeMessageCommand({
        kind: 'message.edit-body',
        input: {
          chatId,
          messageId: target.id,
          content: [{ type: 'output_text', text: 'manually edited' }],
        },
      }),
    ).rejects.toThrow(`StreamTargetBusy:${target.id}`)
    gate.release()
    await handle.completed
    expect(await message(target.id)).toMatchObject({
      content: [{ type: 'output_text', text: 'base-tail' }],
    })
  })

  it('rejects public delete-splice while Continue owns the target', async () => {
    const { chatId, target, handle, gate } = await activeContinue('deleted')
    await expect(
      executeMessageCommand({
        kind: 'message.delete',
        mode: 'single',
        input: {
          chatId,
          messageId: target.id,
          activeLeafId: target.id,
        },
      }),
    ).rejects.toThrow(`StreamTargetBusy:${target.id}`)
    gate.release()
    await handle.completed
    expect(await message(target.id)).toMatchObject({
      content: [{ type: 'output_text', text: 'base-tail' }],
      deleted: false,
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
    const [user, target] = await seedLinear(chat.id, [
      { role: 'user', text: 'prefill question' },
      { role: 'assistant', text: 'prefix' },
    ])
    const calls: CapturedOpen[] = []

    await run(
      { kind: 'continue', chatId: chat.id, targetAssistantId: required(target, 'target').id },
      captureOpen(calls, ' tail'),
    )

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
    expect(await messages(chat.id)).toHaveLength(2)
    expect(await message(required(target, 'target').id)).toMatchObject({
      parentId: required(user, 'user').id,
      content: [{ type: 'output_text', text: 'prefix tail' }],
    })
    expect(JSON.stringify(calls[0]?.wireBody)).not.toContain('MUST NOT APPEAR')
  })

  it('unsupported prefill falls back to Continue prompts without creating a row', async () => {
    const chat = await createChat({
      settings: settings({
        model: UNSUPPORTED_PREFILL_MODEL,
        systemPrompt: 'Claude original system',
        continuePrefill: true,
        continueSystemPrompt: 'Legacy fallback: [SYSTEM_PROMPT]',
        continueUserPrompt: 'Legacy fallback user',
      }),
    })
    const [, target] = await seedLinear(chat.id, [
      { role: 'user', text: 'fallback question' },
      { role: 'assistant', text: 'fallback partial' },
    ])
    const calls: CapturedOpen[] = []

    await run(
      { kind: 'continue', chatId: chat.id, targetAssistantId: required(target, 'target').id },
      captureOpen(calls, ' completed'),
    )

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
    expect(await messages(chat.id)).toHaveLength(2)
    expect(await message(required(target, 'target').id)).toMatchObject({
      content: [{ type: 'output_text', text: 'fallback partial completed' }],
    })
  })

  it('Continue pins a non-current branch for planning but leaves this tab selection untouched', async () => {
    const { chatId, left, right } = await seedTwoBranches({
      continueSystemPrompt: '',
      continueUserPrompt: 'Continue the selected branch.',
    })
    const rightBefore = await message(right.id)
    const rightTipId = await openConversationAt(chatId, right.id)
    const releaseTopology = await demandTreeTopology(chatId)
    const calls: CapturedOpen[] = []
    try {
      await run(
        { kind: 'continue', chatId, targetAssistantId: left.id },
        captureOpen(calls, ' extended'),
      )

      expect(calls).toEqual([
        {
          route: expectedRoute(),
          wireBody: expectedWire(CHAT_MODEL, [
            { role: 'user', content: 'root question' },
            { role: 'assistant', content: 'left answer' },
            { role: 'user', content: 'Continue the selected branch.' },
          ]),
        },
      ])
      expect(conversationTip(chatId)).toBe(rightTipId)
      expect(await message(left.id)).toMatchObject({
        content: [{ type: 'output_text', text: 'left answer extended' }],
      })
      expect(await message(right.id)).toEqual(rightBefore)
      expect(await messages(chatId)).toHaveLength(3)
    } finally {
      releaseTopology()
    }
  })
})

async function seedModel(model: string): Promise<void> {
  await putCachedEndpoints(profile().id, model, {
    id: model,
    endpoints: [
      {
        provider_name: 'Test Clean',
        provider_slug: 'test-clean',
        supported_parameters: ['temperature'],
        context_length: 1_000_000,
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
  await putCachedPrivacyPolicy(profile().id, model, {
    policies: {
      'Test Clean': {
        training: false,
        trainingOpenRouter: false,
        retainsPrompts: false,
        canPublish: false,
        termsOfServiceURL: '',
        privacyPolicyURL: '',
      },
    },
    fetchedAt: Date.now(),
  })
}

async function start(
  intent: GenerationIntent,
  openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>,
  now?: () => number,
): Promise<GenerationHandle> {
  return startControlledGeneration(intent, {
    profile: profile(),
    keyMaterial: { 'key-a': 'sk-test' },
    openStream,
    ...(now ? { now } : {}),
  })
}

async function run(
  intent: GenerationIntent,
  openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>,
  now?: () => number,
) {
  const handle = await start(intent, openStream, now)
  void handle.prepared.catch(() => {})
  return handle.completed
}

function captureOpen(calls: CapturedOpen[], text: string) {
  return (open: GenerationTransportInput) => {
    calls.push({
      wireBody: structuredClone(open.requestPlan.wire),
      route: {
        kind: open.requestPlan.kind,
        transport: open.requestPlan.transport,
        reason: open.requestPlan.reason,
      },
    })
    return open.requestPlan.transport === 'openai-responses'
      ? completedResponsesStream(text)
      : completedStream(text)
  }
}

async function* completedStream(text: string): AsyncGenerator<AssistantStreamChunk> {
  yield {
    type: 'delta',
    chunk: {
      id: 'attempt-generation',
      model: 'attempt-model',
      choices: [{ delta: { content: text }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
        cost: 0.25,
      },
    },
  }
}

async function* completedResponsesStream(text: string): AsyncGenerator<AssistantStreamChunk> {
  yield {
    type: 'event',
    event: {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      delta: text,
    },
  }
  yield {
    type: 'event',
    event: {
      type: 'response.completed',
      response: {
        id: 'attempt-response',
        model: 'attempt-model',
        status: 'completed',
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      },
    },
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
  path: Array<{ role: string; content: string }>,
): Record<string, unknown> {
  return {
    model,
    messages: path,
    provider: { data_collection: 'deny' },
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
    reasoningCarryForward: 'none',
    reasoningVisibility: { disclosure: 'unknown' },
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

async function seedLinear(
  chatId: string,
  rows: readonly { role: MessageRole; text: string }[],
): Promise<Message[]> {
  const imported = await importMessagesOp({
    chatId,
    slot: { kind: 'at-end' },
    activeLeafId: null,
    messages: rows.map((row) => ({
      role: row.role,
      content: [
        row.role === 'assistant'
          ? { type: 'output_text' as const, text: row.text }
          : { type: 'text' as const, text: row.text },
      ],
    })),
  })
  return imported.presentations.map((presentation) => presentation.message)
}

async function seedTwoBranches(overrides: Partial<ChatSettings> = {}): Promise<{
  chatId: string
  root: Message
  left: Message
  right: Message
}> {
  const chat = await createChat({ settings: settings(overrides) })
  const [root, left] = await seedLinear(chat.id, [
    { role: 'user', text: 'root question' },
    { role: 'assistant', text: 'left answer' },
  ])
  const right = await executeMessageCommand({
    kind: 'message.insert-sibling',
    input: {
      chatId: chat.id,
      targetId: required(left, 'left').id,
      role: 'assistant',
      content: [{ type: 'output_text', text: 'right answer' }],
    },
  })
  return {
    chatId: chat.id,
    root: required(root, 'root'),
    left: required(left, 'left'),
    right: right.message,
  }
}

async function patchMessageFixture(
  messageId: MessageId,
  patch: Partial<Message>,
): Promise<Message> {
  const current = required(await message(messageId), 'fixture message')
  const presentation = required(await presentationFor(messageId), 'fixture presentation')
  const next = { ...current, ...structuredClone(patch) }
  const split = splitMessageForStorage(next, {
    bodyVersion: presentation.bodyVersion + 1,
    requestContextVersion: presentation.header.requestContextVersion + 1,
  })
  await getDb().transaction(
    'rw',
    getDb().messages,
    getDb().messageBodies,
    getDb().messagePreviews,
    async () => {
      await getDb().messages.put(split.header)
      await getDb().messageBodies.put(split.body)
      await getDb().messagePreviews.put(split.preview)
    },
  )
  return next
}

function providerGate(text: string): {
  openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>
  opened: Promise<void>
  release(): void
} {
  let markOpened!: () => void
  const opened = new Promise<void>((resolve) => {
    markOpened = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    opened,
    release,
    openStream: () =>
      (async function* () {
        markOpened()
        await gate
        yield* completedStream(text)
      })(),
  }
}

function sharedProviderGate(expectedOpens: number): {
  openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>
  allOpened: Promise<void>
  wires: Record<string, unknown>[]
  release(): void
} {
  let markAllOpened!: () => void
  const allOpened = new Promise<void>((resolve) => {
    markAllOpened = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const wires: Record<string, unknown>[] = []
  return {
    allOpened,
    release,
    wires,
    openStream: (input) => {
      wires.push(structuredClone(input.requestPlan.wire))
      if (wires.length === expectedOpens) markAllOpened()
      return (async function* () {
        await gate
        yield* completedStream('parallel answer')
      })()
    },
  }
}

async function activeContinue(suffix: string): Promise<{
  chatId: string
  target: Message
  handle: GenerationHandle
  gate: ReturnType<typeof providerGate>
}> {
  const chat = await createChat({
    settings: settings({ continueSystemPrompt: '', continueUserPrompt: '' }),
  })
  const [, target] = await seedLinear(chat.id, [
    { role: 'user', text: 'question' },
    { role: 'assistant', text: 'base' },
  ])
  const gate = providerGate('-tail')
  const handle = await start(
    {
      kind: 'continue',
      chatId: chat.id,
      targetAssistantId: required(target, suffix).id,
    },
    gate.openStream,
  )
  await handle.prepared
  await gate.opened
  return { chatId: chat.id, target: required(target, suffix), handle, gate }
}

function terminalMessageAtAttemptRemoval(
  handle: GenerationHandle,
  messageId: MessageId,
): Promise<Message | undefined> {
  let sawAttempt = attemptController.get(handle.streamId) !== undefined
  return new Promise((resolve) => {
    const stop = attemptController.subscribeChat(handle.chatId, () => {
      if (attemptController.get(handle.streamId)) {
        sawAttempt = true
        return
      }
      if (!sawAttempt) return
      stop()
      void message(messageId).then(resolve)
    })
  })
}

function storedSelection(chatId: string): unknown {
  const raw = sessionStorage.getItem(`${CONVERSATION_SESSION_PREFIX}${encodeURIComponent(chatId)}`)
  return raw ? (JSON.parse(raw) as { selection?: unknown }).selection : { kind: 'default' }
}

function conversationTip(chatId: string): MessageId | null | undefined {
  const snapshot = conversationController.getSnapshot()
  if (snapshot.activeChatId !== chatId || snapshot.active?.destination.kind !== 'ready') {
    return undefined
  }
  return snapshot.active.destination.spine.resolvedLeafId
}

async function openConversationAt(chatId: string, tipId: MessageId): Promise<MessageId> {
  conversationController.setNavigationPort(browserConversationNavigationPort)
  navigate(chatHref(chatId, tipId))
  await waitForConversationTip(chatId, tipId)
  return tipId
}

function waitForConversationTip(
  chatId: string,
  tipId: MessageId | null,
): Promise<MessageId | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    let unsubscribe: () => void = () => undefined
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      unsubscribe()
      if (error === undefined) resolve(tipId)
      else reject(error)
    }
    const inspect = () => {
      const snapshot = conversationController.getSnapshot()
      if (snapshot.activeChatId !== chatId || !snapshot.active) return
      const destination = snapshot.active.destination
      if (destination.kind === 'ready' && destination.spine.resolvedLeafId === tipId) {
        finish()
      } else if (destination.kind === 'failed') {
        finish(new Error(`ConversationDestinationFailed:${destination.failure.message}`))
      } else if (destination.kind === 'missing') {
        finish(new Error(`ConversationDestinationMissing:${chatId}`))
      }
    }
    unsubscribe = conversationController.subscribe(inspect)
    inspect()
  })
}

function demandTreeTopology(chatId: string): Promise<() => void> {
  const previousSurface = conversationController.getSnapshot().active?.presentation.request.surface
  const resourcePort: ConversationPresentationResourcePort = {
    get: () => Object.freeze({ kind: 'ready' }),
    request: () => undefined,
    subscribe: () => () => undefined,
  }
  const uninstallResourcePort = conversationController.installPresentationResourcePort(resourcePort)
  conversationController.requestPresentation({ chatId, surface: 'tree' })
  return new Promise((resolve, reject) => {
    let settled = false
    let unsubscribe: () => void = () => undefined
    const release = () => {
      if (previousSurface)
        conversationController.requestPresentation({ chatId, surface: previousSurface })
      uninstallResourcePort()
    }
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      unsubscribe()
      if (error === undefined) {
        resolve(release)
      } else {
        release()
        reject(error)
      }
    }
    const inspect = () => {
      const snapshot = conversationController.getSnapshot()
      if (snapshot.activeChatId !== chatId || !snapshot.active) return
      const target = snapshot.active.presentation.target
      if (
        target.kind === 'ready' &&
        target.binding.surface === 'tree' &&
        target.binding.seal.chatId === chatId
      ) {
        finish()
      } else if (target.kind === 'failed' && target.surface === 'tree') {
        finish(new Error(`ConversationTopologyFailed:${target.message}`))
      } else if (snapshot.active.destination.kind === 'failed') {
        finish(
          new Error(`ConversationTopologyFailed:${snapshot.active.destination.failure.message}`),
        )
      } else if (snapshot.active.destination.kind === 'missing') {
        finish(new Error(`ConversationTopologyMissing:${chatId}`))
      }
    }
    unsubscribe = conversationController.subscribe(inspect)
    inspect()
  })
}

async function messages(chatId: string): Promise<Message[]> {
  return readTestMessages(chatId)
}

async function message(messageId: MessageId): Promise<Message | undefined> {
  return (await presentationFor(messageId))?.message
}

async function presentationFor(messageId: MessageId) {
  return runWorkspaceRead('repository-query', async (permit) => {
    return (
      await getWorkspaceRepository().query(
        permit,
        { kind: 'message.presentation', messageId },
        { signal: permit.signal },
      )
    ).value
  })
}

async function branchHeaders(chatId: string, leafId: MessageId) {
  return runWorkspaceRead('repository-query', async (permit) => {
    const opened = (
      await getWorkspaceRepository().query(
        permit,
        {
          kind: 'branch.open',
          chatId,
          target: fixedConversationSelectionTarget({ kind: 'tip', messageId: leafId }, leafId),
          bodyDemand: 'none',
        },
        { signal: permit.signal },
      )
    ).value
    if (opened.kind !== 'ready') throw new Error(`BranchUnavailable:${opened.kind}`)
    return opened.proof.pathHeaders
  })
}

async function streamLeases(chatId: string) {
  return runWorkspaceRead('repository-query', async (permit) => {
    return (
      await getWorkspaceRepository().query(
        permit,
        { kind: 'stream.leases', chatId },
        { signal: permit.signal },
      )
    ).value
  })
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} missing`)
  return value
}

function captureBodyReads(): {
  readonly ids: MessageId[]
  readonly stop: () => void
} {
  const ids: MessageId[] = []
  const reading = (row: MessageBodyRow | undefined): MessageBodyRow | undefined => {
    if (row) ids.push(row.id)
    return row
  }
  getDb().messageBodies.hook('reading', reading)
  return {
    ids,
    stop: () => getDb().messageBodies.hook('reading').unsubscribe(reading),
  }
}
