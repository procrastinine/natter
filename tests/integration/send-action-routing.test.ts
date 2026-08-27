import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings, ConnectionProfile, Message, MessageRole } from '../../src/core/types'
import { attemptController } from '../../src/store/attempt-controller'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { getChat } from '../../src/store/chats'
import { configurationApplication } from '../../src/store/configuration-application'
import { configurationController } from '../../src/store/configuration-controller'
import { importMessagesOp } from '../../src/store/conversation-command-client'
import { __resetDbForTests } from '../../src/store/db'
import {
  createGenerationEngine,
  type GenerationTransportInput,
} from '../../src/store/generation-engine'
import { getCachedEndpoints } from '../../src/store/models-cache'
import { getCachedPrivacyPolicy } from '../../src/store/privacy-cache'
import type { WorkspaceRepository } from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import { runWorkspaceRead } from '../../src/store/workspace-runtime'
import { useUiStore } from '../../src/store/zustand/uiStore'
import { createChat } from '../helpers/chats'
import { putCachedEndpoints, putCachedPrivacyPolicy } from '../helpers/discovery-cache'
import {
  installGenerationProfile,
  prepareControlledGenerationSurface,
  runControlledGeneration,
  startControlledGeneration,
} from '../helpers/generation-engine'
import { readTestMessages } from '../helpers/message-storage'

const DB_NAME = 'natter'

function makeProfile(): ConnectionProfile {
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

function makeOpenAiProfile(): ConnectionProfile {
  return {
    ...makeProfile(),
    id: 'prof-openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
  }
}

function makeGoogleNativeProfile(): ConnectionProfile {
  return {
    ...makeProfile(),
    id: 'prof-google',
    name: 'Google',
    kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
  }
}

function makeAnthropicProfile(): ConnectionProfile {
  return {
    ...makeProfile(),
    id: 'prof-anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
  }
}

function chatSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  const base = cloneDefaultChatSettings()
  return {
    ...base,
    profileId: 'prof',
    model: 'openai/gpt-4o',
    reasoning: {
      mode: 'off',
      exclude: false,
      summary: 'off',
      include: { encrypted: false, summary: false, text: false },
    },
    ...overrides,
  }
}

async function reset() {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  useUiStore.getState().reset()
  await Dexie.delete(DB_NAME)
}

async function* stream<T>(...chunks: T[]): AsyncGenerator<T> {
  for (const c of chunks) yield c
}

interface ConfiguredGenerationInput {
  chatId: string
  connection: ConnectionProfile
  apiKey: string
  openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>
}

interface ConfiguredSendInput extends ConfiguredGenerationInput {
  content: Message['content']
  prefillContent?: Message['content']
}

async function executeSend(input: ConfiguredSendInput) {
  const chat = await getChat(input.chatId)
  if (!chat) throw new Error(`chat ${input.chatId} missing`)
  return runControlledGeneration(
    {
      kind: 'send',
      chatId: input.chatId,
      target: { kind: 'fixed', messageId: chat.lastUpdatedLeafId },
      content: input.content,
      ...(input.prefillContent ? { prefillContent: input.prefillContent } : {}),
    },
    {
      profile: input.connection,
      keyMaterial: input.connection.apiKeyRef ? { [input.connection.apiKeyRef]: input.apiKey } : {},
      openStream: input.openStream,
    },
  )
}

async function executeReply(input: ConfiguredGenerationInput & { parentMessageId: string }) {
  return runControlledGeneration(
    { kind: 'reply', chatId: input.chatId, parentUserId: input.parentMessageId },
    {
      profile: input.connection,
      keyMaterial: input.connection.apiKeyRef ? { [input.connection.apiKeyRef]: input.apiKey } : {},
      openStream: input.openStream,
    },
  )
}

async function executeRegenerate(input: ConfiguredGenerationInput & { targetAssistantId: string }) {
  return runControlledGeneration(
    {
      kind: 'regenerate',
      chatId: input.chatId,
      targetAssistantId: input.targetAssistantId,
    },
    {
      profile: input.connection,
      keyMaterial: input.connection.apiKeyRef ? { [input.connection.apiKeyRef]: input.apiKey } : {},
      openStream: input.openStream,
    },
  )
}

async function executeContinue(input: ConfiguredGenerationInput & { targetMessageId: string }) {
  return runControlledGeneration(
    { kind: 'continue', chatId: input.chatId, targetAssistantId: input.targetMessageId },
    {
      profile: input.connection,
      keyMaterial: input.connection.apiKeyRef ? { [input.connection.apiKeyRef]: input.apiKey } : {},
      openStream: input.openStream,
    },
  )
}

async function messagesFor(chatId: string): Promise<Message[]> {
  return readTestMessages(chatId)
}

async function messageFor(messageId: string): Promise<Message | undefined> {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'message.presentation', messageId })
      .then((envelope) => envelope.value?.message),
  )
}

function requireDefined<T>(value: T | undefined, label: string): T {
  expect(value).toBeDefined()
  if (value === undefined) throw new Error(`${label} missing`)
  return value
}

const LOREM_USER =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante.'
const LOREM_ASSISTANT =
  'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque.'
const LOREM_FOLLOWUP =
  'Quisque rutrum, aenean imperdiet etiam ultricies nisi vel augue curabitur ullamcorper.'
const SYSTEM_PROMPT =
  'System: answer with concise citations, preserve variables, and never drop the requested format.'
const APPEND_PROMPT = '\n\nAppend: verify assumptions and include the requested unit labels.'

interface SeedMessage {
  id: string
  role: MessageRole
  text: string
}

async function seedLinearMessages(
  chatId: string,
  specs: readonly SeedMessage[],
): Promise<Message[]> {
  const imported = await importMessagesOp({
    chatId,
    slot: { kind: 'at-end' },
    activeLeafId: null,
    messages: specs.map((spec) => ({
      role: spec.role,
      content: [
        spec.role === 'assistant'
          ? { type: 'output_text' as const, text: spec.text }
          : { type: 'text' as const, text: spec.text },
      ],
    })),
  })
  return imported.presentations.map((presentation) => presentation.message)
}

function captureChatDelta(
  capture: (wire: Record<string, unknown>) => void,
  text = 'ok',
): (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk> {
  return (open) => {
    capture(open.requestPlan.wire)
    return stream({
      type: 'delta',
      chunk: {
        id: 'almost-live',
        choices: [{ delta: { content: text }, finish_reason: 'stop' }],
      },
    })
  }
}

async function warmOpenRouterPrivacy(modelId: string) {
  await putCachedEndpoints('prof', modelId, {
    id: modelId,
    endpoints: [
      {
        provider_name: 'Trusted Host',
        supported_parameters: ['temperature'],
        context_length: 200000,
        pricing: {},
      },
      {
        provider_name: 'Filtered Host',
        supported_parameters: ['temperature'],
        context_length: 200000,
        pricing: {},
      },
    ],
  })
  await putCachedPrivacyPolicy('prof', modelId, {
    policies: {
      'Trusted Host': {
        training: false,
        trainingOpenRouter: false,
        retainsPrompts: false,
        canPublish: false,
        termsOfServiceURL: '',
        privacyPolicyURL: '',
      },
      'Filtered Host': {
        training: false,
        trainingOpenRouter: false,
        retainsPrompts: true,
        requiresUserIDs: true,
        canPublish: false,
        termsOfServiceURL: '',
        privacyPolicyURL: '',
      },
    },
    fetchedAt: 0,
  })
}

beforeEach(async () => {
  await reset()
  await openBrowserWorkspace()
  await installGenerationProfile(makeProfile(), { 'key-a': 'sk-test' })
  await installGenerationProfile(makeOpenAiProfile(), { 'key-a': 'sk-test' })
  await installGenerationProfile(makeGoogleNativeProfile(), { 'key-a': 'sk-test' })
  await installGenerationProfile(makeAnthropicProfile(), { 'key-a': 'sk-test' })
})

afterEach(async () => {
  await shutdownBrowserWorkspace()
  await reset()
})

describe('almost-live request shape matrix', () => {
  it('does not let Send overtake the exact pending manual-provider command', async () => {
    const modelId = 'google/gemini-3.1-flash-lite-preview'
    await warmOpenRouterPrivacy(modelId)
    const chat = await createChat({ settings: chatSettings({ model: modelId }) })
    const intent = {
      kind: 'send' as const,
      chatId: chat.id,
      target: { kind: 'fixed' as const, messageId: null },
      content: [{ type: 'text' as const, text: LOREM_FOLLOWUP }],
    }
    const releaseSurface = await prepareControlledGenerationSurface(intent, {
      profile: makeProfile(),
    })
    await waitForConfigurationChat(chat.id)
    const enteredConfiguration = deferred<void>()
    const releaseConfiguration = deferred<void>()
    const controller = new AbortController()
    let configurationWrite: Promise<boolean> | undefined
    const target = getBrowserRepository()
    const execute = target.execute.bind(target)
    __setWorkspaceRepositoryForTests(
      repositoryProxy(target, async (permit, command, options) => {
        if (
          command.kind === 'configuration.execute' &&
          command.input.kind === 'chat.settings-fields-patch'
        ) {
          enteredConfiguration.resolve()
          await releaseConfiguration.promise
        }
        return execute(permit, command, options)
      }),
    )

    try {
      configurationWrite = configurationApplication.patchChatSettingsFields(chat.id, [
        { path: ['providerPrefs', 'ignore'], value: ['Trusted Host'] },
        { path: ['providerPrefs', 'ignoreOverridesFilter'], value: true },
        { path: ['providerPrefs', 'only'], value: undefined },
      ])
      await enteredConfiguration.promise
      expect(
        configurationController.projectChatConfiguration(chat).settings.providerPrefs,
      ).toMatchObject({
        ignore: ['Trusted Host'],
        ignoreOverridesFilter: true,
      })

      let wire: Record<string, unknown> | undefined
      let admitted = false
      const engine = createGenerationEngine({
        openStream: captureChatDelta((captured) => {
          wire = captured
        }),
      })
      const handlePromise = engine
        .startWhenCapabilitySettles({ intent }, { signal: controller.signal })
        .then((handle) => {
          admitted = true
          return handle
        })
      await Promise.resolve()
      await Promise.resolve()
      expect(admitted).toBe(false)
      expect(wire).toBeUndefined()

      releaseConfiguration.resolve()
      await expect(configurationWrite).resolves.toBe(true)
      const handle = await handlePromise
      await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
      const providerWire = requireDefined(wire?.provider, 'manual provider wire') as {
        ignore?: string[]
      }
      expect(providerWire).toMatchObject({
        ignore: ['Trusted Host'],
      })
      expect(providerWire.ignore).not.toContain('Filtered Host')
    } finally {
      releaseConfiguration.resolve()
      controller.abort()
      await configurationWrite?.catch(() => undefined)
      releaseSurface()
      __resetWorkspaceRepositoryForTests()
    }
  })

  it('normal send captures seeded history, system prompt, append prompt, and assistant prefill', async () => {
    const modelId = 'google/gemini-3.1-flash-lite-preview'
    await warmOpenRouterPrivacy(modelId)
    const chat = await createChat({
      settings: chatSettings({
        model: modelId,
        systemPrompt: SYSTEM_PROMPT,
        appendPrompt: APPEND_PROMPT,
      }),
    })
    await seedLinearMessages(chat.id, [
      { id: 'seed-u1', role: 'user', text: LOREM_USER },
      { id: 'seed-a1', role: 'assistant', text: LOREM_ASSISTANT },
    ])

    let wire: Record<string, unknown> | undefined
    const completed = await executeSend({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: LOREM_FOLLOWUP }],
      prefillContent: [{ type: 'text', text: 'Prefilled opening sentence   ' }],
      openStream: captureChatDelta((captured) => {
        wire = captured
      }),
    })

    expect(completed, completed.error?.message).toMatchObject({ outcome: 'done' })
    const messages = (wire as { messages?: Array<{ role: string; content: unknown }> }).messages
    expect(messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: LOREM_USER },
      { role: 'assistant', content: LOREM_ASSISTANT },
      { role: 'user', content: `${LOREM_FOLLOWUP}${APPEND_PROMPT}` },
      { role: 'assistant', content: 'Prefilled opening sentence' },
    ])
    expect(wire?.input).toBeUndefined()
    expect(wire?.provider).toMatchObject({ data_collection: 'deny' })
  })

  it('executeReply captures the same append/system shape without creating another user turn', async () => {
    const modelId = 'google/gemini-3.1-flash-lite-preview'
    await warmOpenRouterPrivacy(modelId)
    const chat = await createChat({
      settings: chatSettings({
        model: modelId,
        systemPrompt: SYSTEM_PROMPT,
        appendPrompt: APPEND_PROMPT,
      }),
    })
    const [user] = await seedLinearMessages(chat.id, [
      { id: 'edit-u1', role: 'user', text: LOREM_USER },
    ])

    let wire: Record<string, unknown> | undefined
    await executeReply({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      parentMessageId: requireDefined(user, 'seeded user').id,
      openStream: captureChatDelta((captured) => {
        wire = captured
      }),
    })

    const messages = (wire as { messages?: Array<{ role: string; content: unknown }> }).messages
    expect(messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${LOREM_USER}${APPEND_PROMPT}` },
    ])
  })

  it('legacy Continue captures continue prompts while append stays on the real user turn', async () => {
    const modelId = 'google/gemini-3.1-flash-lite-preview'
    await warmOpenRouterPrivacy(modelId)
    const chat = await createChat({
      settings: chatSettings({
        model: modelId,
        systemPrompt: SYSTEM_PROMPT,
        appendPrompt: APPEND_PROMPT,
        continueSystemPrompt: 'Continue the assistant text.\n\nOriginal system:\n[SYSTEM_PROMPT]',
        continueUserPrompt: 'Continue from the exact next token.',
      }),
    })
    const [, assistant] = await seedLinearMessages(chat.id, [
      { id: 'cont-u1', role: 'user', text: LOREM_USER },
      { id: 'cont-a1', role: 'assistant', text: LOREM_ASSISTANT },
    ])

    let wire: Record<string, unknown> | undefined
    await executeContinue({
      chatId: chat.id,
      targetMessageId: requireDefined(assistant, 'seeded assistant').id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: (open) => {
        wire = open.requestPlan.wire
        return stream({
          type: 'delta',
          chunk: {
            id: 'almost-live-continue',
            choices: [{ delta: { content: ' continuation' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    const messages = (wire as { messages?: Array<{ role: string; content: unknown }> }).messages
    expect(messages).toEqual([
      {
        role: 'system',
        content: `Continue the assistant text.\n\nOriginal system:\n${SYSTEM_PROMPT}`,
      },
      { role: 'user', content: `${LOREM_USER}${APPEND_PROMPT}` },
      { role: 'assistant', content: LOREM_ASSISTANT },
      { role: 'user', content: 'Continue from the exact next token.' },
    ])
  })

  it('Continue prefill captures append plus visible reasoning context and omits continue prompts', async () => {
    const modelId = 'z-ai/glm-5.1'
    await warmOpenRouterPrivacy(modelId)
    const chat = await createChat({
      settings: chatSettings({
        model: modelId,
        systemPrompt: SYSTEM_PROMPT,
        appendPrompt: APPEND_PROMPT,
        continueSystemPrompt: 'THIS CONTINUE SYSTEM PROMPT MUST NOT BE SENT',
        continueUserPrompt: 'THIS CONTINUE USER PROMPT MUST NOT BE SENT',
        continuePrefill: true,
        reasoning: {
          mode: 'off',
          exclude: true,
          summary: 'off',
          include: { encrypted: false, summary: false, text: false },
        },
      }),
    })
    const [user] = await seedLinearMessages(chat.id, [
      { id: 'prefill-u1', role: 'user', text: LOREM_USER },
    ])
    await executeReply({
      chatId: chat.id,
      parentMessageId: requireDefined(user, 'seeded user').id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: () =>
        stream({
          type: 'delta',
          chunk: {
            id: 'prefill-seed-generation',
            choices: [
              {
                delta: {
                  content: LOREM_ASSISTANT,
                  reasoning_details: [
                    { type: 'reasoning.text', text: 'Visible lorem reasoning.' },
                    { type: 'reasoning.text', text: 'Hidden lorem reasoning.', hidden: true },
                    { type: 'reasoning.encrypted', data: 'opaque-carrier' },
                  ],
                },
                finish_reason: 'stop',
              },
            ],
          },
        }),
    })
    const assistant = (await readTestMessages(chat.id)).find(
      (message) => message.parentId === user?.id && message.role === 'assistant',
    )
    expect(assistant?.reasoningEnvelope?.visible).toHaveLength(2)

    let wire: Record<string, unknown> | undefined
    await executeContinue({
      chatId: chat.id,
      targetMessageId: requireDefined(assistant, 'seeded assistant').id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: (open) => {
        wire = open.requestPlan.wire
        return stream({
          type: 'delta',
          chunk: {
            id: 'almost-live-continue-prefill',
            choices: [{ delta: { content: ' continuation' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    const messages = (wire as { messages?: Array<{ role: string; content: unknown }> }).messages
    expect(messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${LOREM_USER}${APPEND_PROMPT}` },
      {
        role: 'assistant',
        content: `<think>\nVisible lorem reasoning.\n</think>\n\n${LOREM_ASSISTANT}`,
      },
    ])
    expect(JSON.stringify(wire)).not.toContain('THIS CONTINUE')
    expect(JSON.stringify(wire)).not.toContain('Hidden lorem reasoning.')
    expect(JSON.stringify(wire)).not.toContain('opaque-carrier')
  })

  it('executeContinue keeps large continuations out of the IndexedDB hot path', async () => {
    await warmOpenRouterPrivacy('openai/gpt-4o')
    const chat = await createChat({
      settings: chatSettings({
        continueSystemPrompt: 'Continue exactly from the last assistant message.',
        continueUserPrompt: '',
      }),
    })
    const [, assistant] = await seedLinearMessages(chat.id, [
      { id: 'large-cont-u1', role: 'user', text: LOREM_USER },
      { id: 'large-cont-a1', role: 'assistant', text: LOREM_ASSISTANT },
    ])
    const target = requireDefined(assistant, 'seeded assistant')
    const chunks = Array.from({ length: 48 }, (_, index) =>
      `chunk-${index}:`.padEnd(128, String(index % 10)),
    )
    const expectedContinuation = chunks.join('')

    await executeContinue({
      chatId: chat.id,
      targetMessageId: target.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: () =>
        (async function* () {
          for (let i = 0; i < chunks.length; i += 1) {
            yield {
              type: 'delta' as const,
              chunk: {
                id: `large-cont-${i}`,
                choices: [{ delta: { content: chunks[i] ?? '' } }],
              },
            }
          }
          yield {
            type: 'delta' as const,
            chunk: {
              id: 'large-cont-done',
              choices: [{ delta: {}, finish_reason: 'stop' }],
            },
          }
        })(),
    })

    const updated = requireDefined(await messageFor(target.id), 'continued assistant')
    expect(updated.nodeVersion).toBe(1)
    expect(updated.content).toEqual([
      { type: 'output_text', text: `${LOREM_ASSISTANT}${expectedContinuation}` },
    ])
    expect(attemptController.getTargetSnapshot(chat.id, target.id).liveProjection).toBeUndefined()
  })

  it('Responses and Gemini native sends expose valid transport-specific request shapes', async () => {
    const openAiChat = await createChat({
      settings: chatSettings({
        profileId: 'prof-openai',
        model: 'gpt-5.4',
        api: 'responses',
        systemPrompt: SYSTEM_PROMPT,
        appendPrompt: APPEND_PROMPT,
      }),
    })
    await seedLinearMessages(openAiChat.id, [
      { id: 'resp-u1', role: 'user', text: LOREM_USER },
      { id: 'resp-a1', role: 'assistant', text: LOREM_ASSISTANT },
    ])

    let responsesWire: Record<string, unknown> | undefined
    await executeSend({
      chatId: openAiChat.id,
      connection: makeOpenAiProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: LOREM_FOLLOWUP }],
      openStream: captureChatDelta((captured) => {
        responsesWire = captured
      }),
    })

    expect(responsesWire?.instructions).toBe(SYSTEM_PROMPT)
    expect(responsesWire?.messages).toBeUndefined()
    expect(responsesWire?.provider).toBeUndefined()
    const responseInput = responsesWire?.input as Array<{
      type: string
      role?: string
      content?: Array<{ type: string; text?: string }>
    }>
    expect(responseInput.map((item) => item.role)).toEqual(['user', 'assistant', 'user'])
    expect(responseInput[2]?.content?.[0]?.text).toBe(`${LOREM_FOLLOWUP}${APPEND_PROMPT}`)

    const geminiChat = await createChat({
      settings: chatSettings({
        profileId: 'prof-google',
        model: 'google/gemini-3.1-flash-lite-preview',
        api: 'gemini-native',
        systemPrompt: SYSTEM_PROMPT,
        appendPrompt: APPEND_PROMPT,
      }),
    })
    await seedLinearMessages(geminiChat.id, [
      { id: 'gem-u1', role: 'user', text: LOREM_USER },
      { id: 'gem-a1', role: 'assistant', text: LOREM_ASSISTANT },
    ])

    let geminiWire: Record<string, unknown> | undefined
    await executeSend({
      chatId: geminiChat.id,
      connection: makeGoogleNativeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: LOREM_FOLLOWUP }],
      openStream: captureChatDelta((captured) => {
        geminiWire = captured
      }),
    })

    expect(geminiWire?.systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: SYSTEM_PROMPT }],
    })
    expect(geminiWire?.messages).toBeUndefined()
    expect(geminiWire?.input).toBeUndefined()
    const contents = geminiWire?.contents as Array<{
      role: string
      parts: Array<{ text?: string }>
    }>
    expect(contents.map((item) => item.role)).toEqual(['user', 'model', 'user'])
    expect(requireAt(requireAt(contents, 2).parts, 0).text).toBe(
      `${LOREM_FOLLOWUP}${APPEND_PROMPT}`,
    )
  })

  it('direct provider mode matrix exposes the expected request shape for every chat-owned API mode', async () => {
    async function capture(input: {
      profile: ConnectionProfile
      settings: Partial<ChatSettings>
    }): Promise<{
      route: string | undefined
      transport: string | undefined
      geminiModelId: string | undefined
      wire: Record<string, unknown>
    }> {
      const chat = await createChat({
        settings: chatSettings({
          profileId: input.profile.id,
          systemPrompt: SYSTEM_PROMPT,
          appendPrompt: APPEND_PROMPT,
          ...input.settings,
        }),
      })
      await seedLinearMessages(chat.id, [
        { id: `${chat.id}-u1`, role: 'user', text: LOREM_USER },
        { id: `${chat.id}-a1`, role: 'assistant', text: LOREM_ASSISTANT },
      ])

      let wire: Record<string, unknown> | undefined
      let route: string | undefined
      let transport: string | undefined
      let geminiModelId: string | undefined
      await executeSend({
        chatId: chat.id,
        connection: input.profile,
        apiKey: 'sk-test',
        content: [{ type: 'text', text: LOREM_FOLLOWUP }],
        openStream: (open) => {
          wire = open.requestPlan.wire
          route = open.requestPlan.kind
          transport = open.requestPlan.transport
          geminiModelId = open.requestPlan.geminiModelId
          return stream({
            type: 'delta',
            chunk: {
              id: `${chat.id}-shape`,
              choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
            },
          })
        },
      })
      expect(wire).toBeDefined()
      return { route, transport, geminiModelId, wire: wire as Record<string, unknown> }
    }

    const openAiResponses = await capture({
      profile: makeOpenAiProfile(),
      settings: { model: 'gpt-5.4-nano', api: 'responses' },
    })
    expect(openAiResponses.route).toBe('responses')
    expect(openAiResponses.transport).toBe('openai-responses')
    expect(openAiResponses.wire.provider).toBeUndefined()
    expect(openAiResponses.wire.messages).toBeUndefined()
    expect(openAiResponses.wire.instructions).toBe(SYSTEM_PROMPT)
    expect(openAiResponses.wire.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
      ]),
    )

    const openAiChat = await capture({
      profile: makeOpenAiProfile(),
      settings: { model: 'gpt-4o', api: 'chat' },
    })
    expect(openAiChat.route).toBe('chat-completions')
    expect(openAiChat.transport).toBe('openai-chat')
    expect(openAiChat.wire.provider).toBeUndefined()
    expect(openAiChat.wire.input).toBeUndefined()
    expect(openAiChat.wire.messages).toEqual(
      expect.arrayContaining([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: LOREM_USER },
        { role: 'assistant', content: LOREM_ASSISTANT },
        { role: 'user', content: `${LOREM_FOLLOWUP}${APPEND_PROMPT}` },
      ]),
    )

    const googleNative = await capture({
      profile: makeGoogleNativeProfile(),
      settings: {
        model: 'google/gemini-3.1-flash-lite-preview',
        api: 'gemini-native',
      },
    })
    expect(googleNative.route).toBe('gemini-generate')
    expect(googleNative.transport).toBe('gemini-native')
    expect(googleNative.geminiModelId).toBe('gemini-3.1-flash-lite-preview')
    expect(googleNative.wire.provider).toBeUndefined()
    expect(googleNative.wire.messages).toBeUndefined()
    expect(googleNative.wire.input).toBeUndefined()
    expect(googleNative.wire.systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: SYSTEM_PROMPT }],
    })
    expect(googleNative.wire.contents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'model' }),
      ]),
    )

    const googleCompat = await capture({
      profile: makeGoogleNativeProfile(),
      settings: {
        model: 'google/gemini-3.1-flash-lite-preview',
        api: 'chat',
      },
    })
    expect(googleCompat.route).toBe('chat-completions')
    expect(googleCompat.transport).toBe('openai-chat')
    expect(googleCompat.wire.provider).toBeUndefined()
    expect(googleCompat.wire.contents).toBeUndefined()
    expect(googleCompat.wire.messages).toEqual(
      expect.arrayContaining([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: LOREM_USER },
        { role: 'assistant', content: LOREM_ASSISTANT },
        { role: 'user', content: `${LOREM_FOLLOWUP}${APPEND_PROMPT}` },
      ]),
    )

    const anthropicMessages = await capture({
      profile: makeAnthropicProfile(),
      settings: { model: 'claude-haiku-4.5', api: 'anthropic-messages' },
    })
    expect(anthropicMessages.route).toBe('anthropic-messages')
    expect(anthropicMessages.transport).toBe('anthropic')
    expect(anthropicMessages.wire.provider).toBeUndefined()
    expect(anthropicMessages.wire.input).toBeUndefined()
    expect(anthropicMessages.wire.system).toBe(SYSTEM_PROMPT)
    expect(anthropicMessages.wire.model).toBe('claude-haiku-4-5')
    const anthropicNativeMessages = anthropicMessages.wire.messages as Array<{
      role: string
      content: Array<{ type: string; text?: string }>
    }>
    expect(anthropicNativeMessages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
    expect(requireAt(requireAt(anthropicNativeMessages, 0).content, 0).text).toBe(LOREM_USER)
    expect(requireAt(requireAt(anthropicNativeMessages, 1).content, 0).text).toBe(LOREM_ASSISTANT)
    expect(requireAt(requireAt(anthropicNativeMessages, 2).content, 0).text).toBe(
      `${LOREM_FOLLOWUP}${APPEND_PROMPT}`,
    )

    const anthropicCompat = await capture({
      profile: makeAnthropicProfile(),
      settings: { model: 'claude-haiku-4.5', api: 'chat' },
    })
    expect(anthropicCompat.route).toBe('chat-completions')
    expect(anthropicCompat.transport).toBe('openai-chat')
    expect(anthropicCompat.wire.provider).toBeUndefined()
    expect(anthropicCompat.wire.input).toBeUndefined()
    expect(anthropicCompat.wire.model).toBe('claude-haiku-4-5')
    expect(anthropicCompat.wire.messages).toEqual(
      expect.arrayContaining([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: LOREM_USER },
        { role: 'assistant', content: LOREM_ASSISTANT },
        { role: 'user', content: `${LOREM_FOLLOWUP}${APPEND_PROMPT}` },
      ]),
    )
  })

  it('text-completions send captures a rendered prompt with the same rewritten context', async () => {
    const modelId = 'meta-llama/llama-3.3-70b-instruct'
    await putCachedEndpoints('prof', modelId, {
      id: modelId,
      endpoints: [
        {
          provider_name: 'Trusted Host',
          provider_slug: 'trusted-host',
          supported_parameters: ['provider', 'max_tokens', 'reasoning'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy('prof', modelId, {
      policies: {
        'Trusted Host': {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
      },
      fetchedAt: 0,
    })
    const chat = await createChat({
      settings: chatSettings({
        model: modelId,
        api: 'text',
        textTemplate: 'chatml',
        systemPrompt: SYSTEM_PROMPT,
        appendPrompt: APPEND_PROMPT,
        maxCompletionTokens: 64,
      }),
    })
    await seedLinearMessages(chat.id, [
      { id: 'text-u1', role: 'user', text: LOREM_USER },
      { id: 'text-a1', role: 'assistant', text: LOREM_ASSISTANT },
    ])

    let wire: Record<string, unknown> | undefined
    await executeSend({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: LOREM_FOLLOWUP }],
      openStream: captureChatDelta((captured) => {
        wire = captured
      }),
    })

    expect(wire?.messages).toBeUndefined()
    expect(wire?.input).toBeUndefined()
    expect(wire?.prompt).toContain(`<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>`)
    expect(wire?.prompt).toContain(`<|im_start|>user\n${LOREM_USER}<|im_end|>`)
    expect(wire?.prompt).toContain(`<|im_start|>assistant\n${LOREM_ASSISTANT}<|im_end|>`)
    expect(wire?.prompt).toContain(`<|im_start|>user\n${LOREM_FOLLOWUP}${APPEND_PROMPT}<|im_end|>`)
    expect(wire?.max_tokens).toBe(64)
  })
})

function requireAt<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`missing item at index ${index}`)
  return item
}

function repositoryProxy(
  target: WorkspaceRepository,
  execute: WorkspaceRepository['execute'],
): WorkspaceRepository {
  return {
    query: target.query.bind(target),
    execute,
    replace: target.replace.bind(target),
    subscribeChanges: target.subscribeChanges.bind(target),
  }
}

function waitForConfigurationChat(chatId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let unsubscribe: () => void = () => undefined
    const inspect = () => {
      const target = configurationController.getSnapshot().frame.target
      if (target.kind !== 'chat' || target.chatId !== chatId) return
      unsubscribe()
      resolve()
    }
    unsubscribe = configurationController.subscribe(inspect)
    inspect()
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('send action routing', () => {
  it('executeReply reuses the same privacy/provider selection workflow as normal sends', async () => {
    await warmOpenRouterPrivacy('openai/gpt-4o')
    const chat = await createChat({ settings: chatSettings() })
    let initialWire: Record<string, unknown> | undefined
    await executeSend({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: (open) => {
        initialWire = open.requestPlan.wire
        return stream({
          type: 'delta',
          chunk: {
            id: 'seed',
            choices: [{ delta: { content: 'seed' }, finish_reason: 'stop' }],
          },
        })
      },
    })
    expect((initialWire as { provider?: { ignore?: string[] } }).provider?.ignore).toContain(
      'Filtered Host',
    )
    const rows = await messagesFor(chat.id)
    const user = requireDefined(
      rows.find((m) => m.role === 'user'),
      'user message',
    )
    const assistant = requireDefined(
      rows.find((m) => m.role === 'assistant'),
      'assistant message',
    )
    expect(assistant.parentId).toBe(user.id)

    let seenWire: Record<string, unknown> | undefined
    await executeRegenerate({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      targetAssistantId: assistant.id,
      openStream: (open) => {
        seenWire = open.requestPlan.wire
        return stream({
          type: 'delta',
          chunk: {
            id: 'regen',
            choices: [{ delta: { content: 'regen' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    expect(seenWire).toBeDefined()
    expect((seenWire as { provider?: { ignore?: string[] } }).provider?.ignore).toContain(
      'Filtered Host',
    )
    expect((seenWire as { provider?: { ignore?: string[] } }).provider?.ignore).not.toContain(
      'Trusted Host',
    )
  })

  it('executeSend applies zero-eligible provider selection before creating the user row', async () => {
    const modelId = 'openai/gpt-4o'
    const cachedAt = Date.now()
    await putCachedEndpoints(
      'prof',
      modelId,
      {
        id: modelId,
        endpoints: [
          {
            provider_name: 'Only Trainer',
            supported_parameters: ['temperature'],
            context_length: 200000,
            pricing: {},
          },
        ],
      },
      cachedAt,
    )
    await putCachedPrivacyPolicy(
      'prof',
      modelId,
      {
        policies: {
          'Only Trainer': {
            training: true,
            trainingOpenRouter: false,
            retainsPrompts: false,
            canPublish: false,
            termsOfServiceURL: '',
            privacyPolicyURL: '',
          },
        },
        fetchedAt: cachedAt,
      },
      cachedAt,
    )
    const chat = await createChat({ settings: chatSettings({ model: modelId }) })
    const cachedEndpoints = await getCachedEndpoints('prof', modelId)
    const cachedPrivacy = await getCachedPrivacyPolicy('prof', modelId)
    expect(cachedEndpoints).toMatchObject({
      profileId: 'prof',
      modelId,
      fetchedAt: cachedAt,
      payload: { id: modelId, endpoints: [{ provider_name: 'Only Trainer' }] },
    })
    expect(cachedPrivacy).toMatchObject({
      profileId: 'prof',
      modelId,
      fetchedAt: cachedAt,
      payload: { policies: { 'Only Trainer': { training: true } } },
    })
    expect(cachedEndpoints?.profileRevision).toBe(cachedPrivacy?.profileRevision)

    const handle = await startControlledGeneration(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'hello' }],
      },
      {
        profile: makeProfile(),
        keyMaterial: { 'key-a': 'sk-test' },
        openStream: () =>
          stream({
            type: 'delta',
            chunk: {
              id: 'should-not-open',
              choices: [{ delta: { content: 'nope' }, finish_reason: 'stop' }],
            },
          }),
      },
    )
    await expect(handle.prepared).rejects.toThrow('No eligible providers can serve this request.')
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'error' })

    expect(useUiStore.getState().zeroEligibleChatId).toBe(chat.id)
    expect(await messagesFor(chat.id)).toEqual([])
  })

  it('executeContinue does not add the original system prompt when the template has no placeholder in double-assistant mode', async () => {
    await warmOpenRouterPrivacy('openai/gpt-4o')
    const chat = await createChat({
      settings: chatSettings({
        systemPrompt: 'ORIGINAL SYSTEM PROMPT SHOULD NOT APPEAR',
        continueSystemPrompt: 'Continue exactly from the last assistant message.',
        continueUserPrompt: '',
      }),
    })
    await executeSend({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: () =>
        stream({
          type: 'delta',
          chunk: {
            id: 'seed',
            choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }],
          },
        }),
    })
    const rows = await messagesFor(chat.id)
    const assistant = requireDefined(
      rows.find((m) => m.role === 'assistant'),
      'assistant message',
    )

    let seenWire: Record<string, unknown> | undefined
    await executeContinue({
      chatId: chat.id,
      targetMessageId: assistant.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: (open) => {
        seenWire = open.requestPlan.wire
        return stream({
          type: 'delta',
          chunk: {
            id: 'continue',
            choices: [{ delta: { content: ' more' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    expect(seenWire).toBeDefined()
    expect((seenWire as { provider?: { ignore?: string[] } }).provider?.ignore).toContain(
      'Filtered Host',
    )
    const chatMessages = (
      seenWire as {
        messages?: Array<{ role: string; content: string }>
      }
    ).messages
    const responseInput = (
      seenWire as {
        input?: Array<{
          type: string
          role?: string
          content?: Array<{ type: string; text?: string }>
        }>
        instructions?: string
      }
    ).input
    if (chatMessages) {
      expect(chatMessages).toEqual([
        {
          role: 'system',
          content: 'Continue exactly from the last assistant message.',
        },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'partial' },
      ])
    } else {
      expect((seenWire as { instructions?: string }).instructions).toBe(
        'Continue exactly from the last assistant message.',
      )
      expect(responseInput).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'partial' }],
        },
      ])
    }
    expect(JSON.stringify(seenWire)).not.toContain('ORIGINAL SYSTEM PROMPT SHOULD NOT APPEAR')
    const updated = await messageFor(assistant.id)
    expect(updated?.content).toEqual([{ type: 'output_text', text: 'partial more' }])
    expect(updated?.originalCharCount).toBe('partial'.length)
    expect(updated?.charCountDelta).toBe(' more'.length)
    expect(updated?.cachedTokenEstimate).toBeGreaterThan(0)
  })

  it('executeContinue expands [SYSTEM_PROMPT] verbatim inside the system template', async () => {
    await warmOpenRouterPrivacy('openai/gpt-4o')
    const chat = await createChat({
      settings: chatSettings({
        systemPrompt: 'ORIGINAL SYSTEM PROMPT SHOULD APPEAR IN A CODE BLOCK',
        continueSystemPrompt:
          'Continue exactly from the last assistant message.\n\nThe original system prompt (for reference):\n```\n[SYSTEM_PROMPT]\n```',
        continueUserPrompt: '',
      }),
    })
    await executeSend({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: () =>
        stream({
          type: 'delta',
          chunk: {
            id: 'seed',
            choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }],
          },
        }),
    })
    const rows = await messagesFor(chat.id)
    const assistant = requireDefined(
      rows.find((m) => m.role === 'assistant'),
      'assistant message',
    )

    let seenWire: Record<string, unknown> | undefined
    await executeContinue({
      chatId: chat.id,
      targetMessageId: assistant.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: (open) => {
        seenWire = open.requestPlan.wire
        return stream({
          type: 'delta',
          chunk: {
            id: 'continue',
            choices: [{ delta: { content: ' more' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    const expectedTemplate =
      'Continue exactly from the last assistant message.\n\nThe original system prompt (for reference):\n```\nORIGINAL SYSTEM PROMPT SHOULD APPEAR IN A CODE BLOCK\n```'
    const chatMessages = (
      seenWire as {
        messages?: Array<{ role: string; content: string }>
      }
    ).messages
    if (chatMessages) {
      expect(chatMessages[0]).toEqual({ role: 'system', content: expectedTemplate })
    } else {
      expect((seenWire as { instructions?: string }).instructions).toBe(expectedTemplate)
    }
  })

  it('executeContinue supports a synthetic user prompt with no system prompt when the template is blank', async () => {
    await warmOpenRouterPrivacy('openai/gpt-4o')
    const chat = await createChat({
      settings: chatSettings({
        systemPrompt: 'ORIGINAL SYSTEM PROMPT SHOULD APPEAR',
        continueSystemPrompt: '',
        continueUserPrompt: 'Now only continue the last assistant message.',
      }),
    })
    await executeSend({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: () =>
        stream({
          type: 'delta',
          chunk: {
            id: 'seed',
            choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }],
          },
        }),
    })
    const rows = await messagesFor(chat.id)
    const assistant = requireDefined(
      rows.find((m) => m.role === 'assistant'),
      'assistant message',
    )

    let seenWire: Record<string, unknown> | undefined
    await executeContinue({
      chatId: chat.id,
      targetMessageId: assistant.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: (open) => {
        seenWire = open.requestPlan.wire
        return stream({
          type: 'delta',
          chunk: {
            id: 'continue',
            choices: [{ delta: { content: ' more' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    expect(seenWire).toBeDefined()
    expect((seenWire as { provider?: { ignore?: string[] } }).provider?.ignore).toContain(
      'Filtered Host',
    )
    const chatMessages = (
      seenWire as {
        messages?: Array<{ role: string; content: string }>
      }
    ).messages
    const responseInput = (
      seenWire as {
        input?: Array<{
          type: string
          role?: string
          content?: Array<{ type: string; text?: string }>
        }>
        instructions?: string
      }
    ).input
    if (chatMessages) {
      expect(chatMessages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'Now only continue the last assistant message.' },
      ])
    } else {
      expect((seenWire as { instructions?: string }).instructions ?? '').toBe('')
      expect(responseInput).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'partial' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Now only continue the last assistant message.' }],
        },
      ])
    }
    expect(JSON.stringify(seenWire)).not.toContain(
      'Continue exactly from the last assistant message.',
    )
    expect(JSON.stringify(seenWire)).not.toContain('ORIGINAL SYSTEM PROMPT SHOULD APPEAR')
    const updated = await messageFor(assistant.id)
    expect(updated?.content).toEqual([{ type: 'output_text', text: 'partial more' }])
  })

  it('executeContinue prefill mode skips continue prompts without auto-configuring settings', async () => {
    const modelId = 'z-ai/glm-5.1'
    await putCachedEndpoints('prof', modelId, {
      id: modelId,
      endpoints: [
        {
          provider_name: 'DeepInfra',
          provider_slug: 'deepinfra',
          supported_parameters: ['temperature', 'reasoning'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy('prof', modelId, {
      policies: {
        DeepInfra: {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
        deepinfra: {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
      },
      fetchedAt: 0,
    })
    const chat = await createChat({
      settings: chatSettings({
        model: modelId,
        systemPrompt: 'ORIGINAL SYSTEM PROMPT',
        continueSystemPrompt: 'CONTINUE SYSTEM PROMPT SHOULD NOT APPEAR',
        continueUserPrompt: 'CONTINUE USER PROMPT SHOULD NOT APPEAR',
        continuePrefill: true,
        reasoning: {
          mode: 'default',
          exclude: false,
          summary: 'off',
          include: { encrypted: false, summary: false, text: false },
        },
      }),
    })

    await executeSend({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: () =>
        stream({
          type: 'delta',
          chunk: {
            id: 'seed',
            choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }],
          },
        }),
    })
    const rows = await messagesFor(chat.id)
    const assistant = requireDefined(
      rows.find((m) => m.role === 'assistant'),
      'assistant message',
    )

    let seenWire: Record<string, unknown> | undefined
    await executeContinue({
      chatId: chat.id,
      targetMessageId: assistant.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: (open) => {
        seenWire = open.requestPlan.wire
        return stream({
          type: 'delta',
          chunk: {
            id: 'continue-prefill',
            choices: [{ delta: { content: ' more' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    expect(seenWire).toBeDefined()
    expect((seenWire as { messages?: Array<{ role: string; content: string }> }).messages).toEqual([
      { role: 'system', content: 'ORIGINAL SYSTEM PROMPT' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'partial' },
    ])
    expect(JSON.stringify(seenWire)).not.toContain('CONTINUE SYSTEM PROMPT SHOULD NOT APPEAR')
    expect(JSON.stringify(seenWire)).not.toContain('CONTINUE USER PROMPT SHOULD NOT APPEAR')
    expect((seenWire as { reasoning?: unknown }).reasoning).toBeUndefined()
    expect((seenWire as { provider?: { only?: string[] } }).provider?.only).toBeUndefined()
    const storedChat = await getChat(chat.id)
    expect(storedChat?.settings.reasoning.mode).toBe('default')
    expect(storedChat?.settings.providerPrefs?.only).toBeUndefined()
    const finalRows = await messagesFor(chat.id)
    expect(finalRows.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect((await messageFor(assistant.id))?.content).toEqual([
      { type: 'output_text', text: 'partial more' },
    ])
  })
})
