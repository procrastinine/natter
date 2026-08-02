import Dexie from 'dexie'
import { ownBrowserWorkspaceSuite } from '../helpers/browser-workspace-suite'
import { createChat } from '../helpers/chats'
import { putCachedEndpoints, putCachedPrivacyPolicy } from '../helpers/discovery-cache'
import { putTestMessages } from '../helpers/message-storage'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readCachedPrivacyPayload } from '../../src/api/privacy-scrape'
import { normalizeEndpointsResponse } from '../../src/api/providers'
import type { AssistantPlanningResources } from '../../src/core/assistant-planning-resources'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { contextRouteFactsFromMessages } from '../../src/core/reasoning'
import { isStaticTextTemplateId, resolveStaticTextTemplate } from '../../src/core/text-templates'
import type { Chat, ConnectionProfile, Message, MessageAttachmentRef } from '../../src/core/types'
import {
  deleteReferencedAttachmentBytes,
  getAttachment,
  getAttachmentBundle,
  ingestAttachmentBytes,
} from '../../src/store/attachments'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'

import { __resetDbForTests, getDb } from '../../src/store/db'
import { exportWorkspaceBackup, restoreWorkspaceBackup } from '../../src/store/import-export'
import { getCachedEndpoints } from '../../src/store/models-cache'
import { getCachedPrivacyPolicy } from '../../src/store/privacy-cache'
import {
  prepareAssistantRequestPlan as prepareAssistantRequestPlanWithResources,
  resolveAssistantRequestFacts,
  resolveRequestPrivacyPlan as resolveRequestPrivacyPlanWithResources,
} from '../../src/store/request-planning'
import {
  __resetWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import { runWorkspaceRead } from '../../src/store/workspace-runtime'
import { reasoningEnvelopeFromDetailsForTest } from '../helpers/reasoning-events'

const DB_NAME = 'natter'
const workspaceSuite = ownBrowserWorkspaceSuite()

const cloneDefaultPrivacyPrefs = () => cloneDefaultChatSettings().privacy

let emptyWorkspaceBackup: Awaited<ReturnType<typeof exportWorkspaceBackup>>

function makeProfile(): ConnectionProfile {
  return {
    id: 'prof-1',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-1',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

function makeOpenAiProfile(): ConnectionProfile {
  return {
    ...makeProfile(),
    id: 'prof-openai',
    name: 'OpenAI direct',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
  }
}

function makeGoogleProfile(): ConnectionProfile {
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

function makeLlamaServerProfile(): ConnectionProfile {
  return {
    ...makeProfile(),
    id: 'prof-llama',
    name: 'llama-server',
    kind: 'llama-server',
    baseUrl: 'http://llama.test/v1',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
  }
}

function makeChat(overrides: Partial<Chat['settings']> = {}): Chat {
  const settings = cloneDefaultChatSettings()
  settings.profileId = 'prof-1'
  settings.model = 'openai/gpt-4o'
  settings.privacy = cloneDefaultPrivacyPrefs()
  Object.assign(settings, overrides)
  return {
    id: 'chat-1',
    title: 'test',
    titleStatus: 'manual',
    createdAt: 0,
    updatedAt: 0,
    lastViewedAt: 0,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 0,
    settings,
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 0,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

function openRouterTools(
  openrouter: Partial<Chat['settings']['tools']['openrouter']>,
): Pick<Chat['settings'], 'tools'> {
  const tools = cloneDefaultChatSettings().tools
  return { tools: { ...tools, openrouter: { ...tools.openrouter, ...openrouter } } }
}

function anthropicTools(
  anthropic: Partial<Chat['settings']['tools']['anthropic']>,
): Pick<Chat['settings'], 'tools'> {
  const tools = cloneDefaultChatSettings().tools
  return { tools: { ...tools, anthropic: { ...tools.anthropic, ...anthropic } } }
}

function makeMessage(text: string): Message {
  return {
    id: 'u1',
    chatId: 'chat-1',
    parentId: null,
    siblingIndex: 0,
    turnId: 't1',
    turnIndex: 0,
    createdAt: 0,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text }],
    nodeVersion: 0,
    deleted: false,
  }
}

function makeAssistantWithProviderOutput(
  providerOutputItems: NonNullable<Message['providerOutputItems']>,
): Message {
  return {
    ...makeMessage('tool evidence answer'),
    id: 'a1',
    parentId: 'u1',
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'output_text', text: 'tool evidence answer' }],
    providerOutputItems,
  }
}

function attachmentRef(attachmentId: string): MessageAttachmentRef {
  return {
    refId: `ref-${attachmentId}`,
    attachmentId,
    includeInContext: true,
    presentation: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

beforeAll(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
  await workspaceSuite.open()
  emptyWorkspaceBackup = await exportWorkspaceBackup()
})

beforeEach(async () => {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  await restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 1 })
  await getDb().profiles.bulkPut([
    makeProfile(),
    makeOpenAiProfile(),
    makeGoogleProfile(),
    makeAnthropicProfile(),
  ])
})

type PrepareInput = Omit<
  Parameters<typeof prepareAssistantRequestPlanWithResources>[0],
  'resources'
>
type PrivacyInput = Omit<
  Parameters<typeof resolveRequestPrivacyPlanWithResources>[0],
  'resources' | 'routing' | 'facts'
>

function prepareAssistantRequestPlan(input: PrepareInput) {
  return prepareAssistantRequestPlanWithResources({
    ...input,
    resources: planningResources(input.connection),
  })
}

async function resolveRequestPrivacyPlan(input: PrivacyInput) {
  const resources = planningResources(input.profile)
  const settings = input.settings ?? input.chat.settings
  const facts = await resolveAssistantRequestFacts({
    chat: input.chat,
    connection: input.profile,
    settings,
    contextFacts: contextRouteFactsFromMessages(input.activePathMessages),
    resources,
  })
  return resolveRequestPrivacyPlanWithResources({
    ...input,
    settings,
    facts,
    routing: facts.preflightRouting.route,
    resources,
  })
}

function planningResources(profile: ConnectionProfile): AssistantPlanningResources {
  return {
    globalCalibration: () => ({ version: 1, updatedAt: 0, byModel: {} }),
    calibrationMode: () => 'adaptive',
    proxy: () => ({ url: '', secret: '' }),
    readModels: async () => undefined,
    resolveEndpoints: async (modelId) => {
      const row = await getCachedEndpoints(profile.id, modelId)
      return row ? normalizeEndpointsResponse(row.payload) : null
    },
    resolvePrivacy: async (modelId) => {
      const row = await getCachedPrivacyPolicy(profile.id, modelId)
      return {
        policies: row ? (readCachedPrivacyPayload(row.payload)?.policies ?? {}) : {},
        offlineFallback: false,
      }
    },
    getAttachment,
    getAttachmentBundle,
    resolveTextTemplate: async (id, customFallback) => {
      if (!isStaticTextTemplateId(id)) return null
      return resolveStaticTextTemplate(id, customFallback)
    },
  }
}

describe('resolveRequestPrivacyPlan', () => {
  it('resolves endpoint context capability for free OpenRouter models without privacy routing', async () => {
    const profile = makeProfile()
    const chat = makeChat({ model: 'openai/free-test:free' })
    await putCachedEndpoints(profile.id, chat.settings.model, {
      id: chat.settings.model,
      endpoints: [
        {
          provider_name: 'Free Host',
          provider_slug: 'free-host',
          supported_parameters: ['temperature'],
          context_length: 8192,
          max_prompt_tokens: 7168,
          pricing: {},
        },
      ],
    })

    const facts = await resolveAssistantRequestFacts({
      chat,
      connection: profile,
      resources: planningResources(profile),
    })

    expect(facts.preflightPrivacy.applicable).toBe(false)
    expect(facts.capability).toMatchObject({ contextLength: 8192, maxPromptTokens: 7168 })

    const { requestPlan, privacyPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('hello')],
      facts,
    })
    expect(privacyPlan.privacy.applicable).toBe(false)
    expect(requestPlan.effectiveRouting.selectedEndpoints).toHaveLength(1)
    expect(requestPlan.effectiveRouting.endpointAvailability).toBe('available')
    expect(requestPlan.wire.provider).toBeUndefined()
  })

  it('rejects an empty endpoint catalog without classifying it as provider filtering', async () => {
    const profile = makeProfile()
    const chat = makeChat({ model: 'openai/catalog-empty:free' })
    await putCachedEndpoints(profile.id, chat.settings.model, {
      id: chat.settings.model,
      endpoints: [],
    })

    await expect(
      resolveAssistantRequestFacts({
        chat,
        connection: profile,
        resources: planningResources(profile),
      }),
    ).rejects.toThrow('No provider endpoints are currently available for this model.')
  })

  it('reuses one attempt-scoped discovery result across context facts and wire planning', async () => {
    const profile = makeProfile()
    const chat = makeChat()
    await putCachedEndpoints(profile.id, chat.settings.model, {
      id: chat.settings.model,
      endpoints: [
        {
          provider_name: 'Clean Host',
          provider_slug: 'clean-host',
          supported_parameters: ['temperature'],
          context_length: 8192,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy(profile.id, chat.settings.model, {
      policies: {
        'Clean Host': {
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
    const base = planningResources(profile)
    let endpointReads = 0
    let privacyReads = 0
    const resources: AssistantPlanningResources = {
      ...base,
      resolveEndpoints: async (...args) => {
        endpointReads += 1
        return base.resolveEndpoints(...args)
      },
      resolvePrivacy: async (...args) => {
        privacyReads += 1
        return base.resolvePrivacy(...args)
      },
    }
    const facts = await resolveAssistantRequestFacts({
      chat,
      connection: profile,
      resources,
    })

    await prepareAssistantRequestPlanWithResources({
      chat,
      connection: profile,
      pathMessages: [makeMessage('submitted exactly once')],
      facts,
      resources,
    })

    expect(endpointReads).toBe(1)
    expect(privacyReads).toBe(1)
  })

  it('derives the context cutoff from the providers the picker actually permits', async () => {
    const profile = makeProfile()
    const chat = makeChat({
      providerPrefs: {
        sort: 'price',
        only: ['small-host'],
      },
    })
    await putCachedEndpoints(profile.id, chat.settings.model, {
      id: chat.settings.model,
      endpoints: [
        {
          provider_name: 'Small Host',
          provider_slug: 'small-host',
          supported_parameters: ['temperature'],
          context_length: 4096,
          pricing: {},
        },
        {
          provider_name: 'Large Host',
          provider_slug: 'large-host',
          supported_parameters: ['temperature'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy(profile.id, chat.settings.model, {
      policies: Object.fromEntries(
        ['Small Host', 'Large Host'].map((name) => [
          name,
          {
            training: false,
            trainingOpenRouter: false,
            retainsPrompts: false,
            canPublish: false,
            termsOfServiceURL: '',
            privacyPolicyURL: '',
          },
        ]),
      ),
      fetchedAt: Date.now(),
    })

    const facts = await resolveAssistantRequestFacts({
      chat,
      connection: profile,
      resources: planningResources(profile),
    })

    expect(facts.capability?.contextLength).toBe(4096)
  })

  it('counts the submitted draft text for a normal send', async () => {
    const chat = makeChat()
    const profile = makeProfile()
    await putCachedEndpoints('prof-1', 'openai/gpt-4o', {
      id: 'openai/gpt-4o',
      endpoints: [
        {
          provider_name: 'Tiny Host',
          supported_parameters: ['temperature'],
          context_length: 200,
          pricing: {},
        },
        {
          provider_name: 'Big Host',
          supported_parameters: ['temperature'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy('prof-1', 'openai/gpt-4o', {
      policies: {
        'Tiny Host': {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
        'Big Host': {
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

    const result = await resolveRequestPrivacyPlan({
      chat,
      profile,
      activePathMessages: [],
      draftText: 'x'.repeat(5000),
    })

    expect(result.neededTokens).toBeGreaterThan(200)
    expect(result.privacy.wire?.ignore).toContain('Tiny Host')
    expect(result.privacy.wire?.ignore).not.toContain('Big Host')
  })

  it('uses the override system prompt for continue-style sends instead of the chat prompt', async () => {
    const chat = makeChat({ systemPrompt: 'x'.repeat(5000) })
    const profile = makeProfile()
    await putCachedEndpoints('prof-1', 'openai/gpt-4o', {
      id: 'openai/gpt-4o',
      endpoints: [
        {
          provider_name: 'Tight Host',
          supported_parameters: ['temperature'],
          context_length: 400,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy('prof-1', 'openai/gpt-4o', {
      policies: {
        'Tight Host': {
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

    const result = await resolveRequestPrivacyPlan({
      chat,
      profile,
      activePathMessages: [makeMessage('hello')],
      draftText: '',
      settings: {
        ...chat.settings,
        systemPrompt: 'Continue from the last assistant message.',
      },
    })

    expect(result.neededTokens).toBeLessThan(400)
    expect(result.privacy.wire?.ignore ?? []).not.toContain('Tight Host')
  })

  it('continue-style sizing counts both the prepended system prompt and the synthetic continue user prompt', async () => {
    const chat = makeChat({ systemPrompt: 'x'.repeat(4000) })
    const profile = makeProfile()
    await putCachedEndpoints('prof-1', 'openai/gpt-4o', {
      id: 'openai/gpt-4o',
      endpoints: [
        {
          provider_name: 'Tight Host',
          supported_parameters: ['temperature'],
          context_length: 700,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy('prof-1', 'openai/gpt-4o', {
      policies: {
        'Tight Host': {
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

    const result = await resolveRequestPrivacyPlan({
      chat,
      profile,
      activePathMessages: [
        makeMessage('hello'),
        {
          ...makeMessage('partial'),
          id: 'a1',
          parentId: 'u1',
          role: 'assistant',
          origin: 'generated',
          content: [{ type: 'output_text', text: 'partial' }],
        },
        {
          ...makeMessage('Now please generate only the continuation of the last message.'),
          id: 'u2',
          parentId: 'a1',
        },
      ],
      draftText: '',
      settings: {
        ...chat.settings,
        systemPrompt:
          'Continue exactly from the last assistant message.\n\nThe original system prompt (for reference):\n' +
          chat.settings.systemPrompt,
      },
    })

    expect(result.neededTokens).toBeGreaterThan(700)
    expect(result.privacy.wire?.ignore).toContain('Tight Host')
  })

  it('does not carry OpenRouter provider/privacy wire onto non-OpenRouter connections', async () => {
    const profile = makeOpenAiProfile()
    const chat = makeChat({
      profileId: profile.id,
      model: 'gpt-4o',
      api: 'chat',
      allowFallbacks: false,
      ...openRouterTools({ enabledServerToolIds: ['datetime'] }),
      providerPrefs: {
        sort: 'price',
        only: ['OpenAI'],
      },
    })
    await putCachedEndpoints(profile.id, 'gpt-4o', {
      id: 'gpt-4o',
      endpoints: [
        {
          provider_name: 'Training Host',
          supported_parameters: ['temperature'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy(profile.id, 'gpt-4o', {
      policies: {
        'Training Host': {
          training: true,
          trainingOpenRouter: true,
          retainsPrompts: true,
          canPublish: true,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
      },
      fetchedAt: 0,
    })

    const { requestPlan, privacyPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('hello')],
      draftText: '',
    })

    expect(privacyPlan.privacy.applicable).toBe(false)
    expect(requestPlan.wire.provider).toBeUndefined()
    expect(requestPlan.wire.tools).toBeUndefined()
    expect(requestPlan.kind).toBe('chat-completions')
  })

  it('seals GPT summary visibility from the effective OpenRouter or direct Chat route', async () => {
    const baseReasoning = {
      ...cloneDefaultChatSettings().reasoning,
      mode: 'default' as const,
      summary: 'auto' as const,
    }
    const openRouter = makeProfile()
    const openRouterChat = makeChat({
      model: 'openai/gpt-5.4',
      api: 'chat',
      reasoning: baseReasoning,
    })
    const direct = makeOpenAiProfile()
    const directChat = makeChat({
      profileId: direct.id,
      model: 'gpt-5.4',
      api: 'chat',
      reasoning: baseReasoning,
    })
    await putCachedEndpoints(openRouter.id, openRouterChat.settings.model, {
      id: openRouterChat.settings.model,
      endpoints: [
        {
          provider_name: 'OpenAI',
          provider_slug: 'openai',
          supported_parameters: ['reasoning'],
          context_length: 200_000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy(openRouter.id, openRouterChat.settings.model, {
      policies: {
        OpenAI: {
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

    const [openRouterPlan, directPlan] = await Promise.all([
      prepareAssistantRequestPlan({
        chat: openRouterChat,
        connection: openRouter,
        pathMessages: [makeMessage('hello')],
        draftText: '',
        capabilities: {
          supportedParameters: ['reasoning'],
          streaming: 'supported',
        },
      }),
      prepareAssistantRequestPlan({
        chat: directChat,
        connection: direct,
        pathMessages: [makeMessage('hello')],
        draftText: '',
        capabilities: {
          supportedParameters: ['reasoning'],
          streaming: 'supported',
        },
      }),
    ])

    expect(openRouterPlan.requestPlan.wire.reasoning).toEqual({ summary: 'auto' })
    expect(openRouterPlan.requestPlan.reasoning.inboundVisibility).toEqual({
      disclosure: 'visible',
      visibleKind: 'summary',
    })
    expect(directPlan.requestPlan.wire.reasoning).toBeUndefined()
    expect(directPlan.requestPlan.reasoning.inboundVisibility).toEqual({
      disclosure: 'absent',
      unexpectedVisibleKind: 'summary',
      reason: 'api-mode',
    })
  })

  it('seals direct Responses summary visibility from emitted or capability-gated wire', async () => {
    const profile = makeOpenAiProfile()
    const chat = makeChat({
      profileId: profile.id,
      model: 'gpt-5.4',
      api: 'responses',
      reasoning: {
        ...cloneDefaultChatSettings().reasoning,
        mode: 'default',
        summary: 'auto',
      },
    })

    const emitted = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('hello')],
      draftText: '',
      capabilities: { supportedParameters: ['reasoning'], streaming: 'supported' },
    })
    expect(emitted.requestPlan.wire.reasoning).toEqual({ summary: 'auto' })
    expect(emitted.requestPlan.reasoning.inboundVisibility).toEqual({
      disclosure: 'visible',
      visibleKind: 'summary',
    })

    const gated = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('hello')],
      draftText: '',
      capabilities: { supportedParameters: [], streaming: 'supported' },
    })
    expect(gated.requestPlan.wire.reasoning).toBeUndefined()
    expect(gated.requestPlan.reasoning.inboundVisibility).toEqual({
      disclosure: 'absent',
      unexpectedVisibleKind: 'summary',
      reason: 'provider-default',
    })
  })

  it('does not carry OpenRouter hosted tools onto direct OpenAI Responses requests', async () => {
    const profile = makeOpenAiProfile()
    const chat = makeChat({
      profileId: profile.id,
      model: 'gpt-5.4',
      api: 'responses',
      allowFallbacks: false,
      ...openRouterTools({
        enabledServerToolIds: ['datetime', 'web-fetch', 'shell'],
        toolChoice: 'auto',
      }),
      providerPrefs: {
        sort: 'price',
        only: ['OpenAI'],
      },
    })
    await putCachedEndpoints(profile.id, 'gpt-5.4', {
      id: 'gpt-5.4',
      endpoints: [
        {
          provider_name: 'Training Host',
          supported_parameters: ['tools', 'provider', 'tool_choice'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })

    const { requestPlan, privacyPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('hello')],
      draftText: '',
    })

    expect(privacyPlan.privacy.applicable).toBe(false)
    expect(requestPlan.kind).toBe('responses')
    expect(requestPlan.wire.input).toBeDefined()
    expect(requestPlan.wire.provider).toBeUndefined()
    expect(requestPlan.wire.tools).toBeUndefined()
    expect(requestPlan.wire.tool_choice).toBeUndefined()
    expect(requestPlan.wire.parallel_tool_calls).toBeUndefined()
  })

  it('plans GPT-5.5 Pro as a buffered native Responses request', async () => {
    const profile = makeOpenAiProfile()
    const chat = makeChat({
      profileId: profile.id,
      model: 'gpt-5.5-pro',
      api: 'responses',
    })
    const { requestPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('solve this carefully')],
      draftText: '',
    })

    expect(requestPlan.kind).toBe('responses')
    expect(requestPlan.wire.stream).toBeUndefined()
  })

  it('carries OpenAI hosted tools only on direct OpenAI Responses plans', async () => {
    const profile = makeOpenAiProfile()
    const tools = cloneDefaultChatSettings().tools
    const chat = makeChat({
      profileId: profile.id,
      model: 'gpt-5.4-nano',
      api: 'chat',
      tools: {
        ...tools,
        openai: {
          ...tools.openai,
          enabledServerToolIds: ['web-search', 'image-generation'],
          toolChoice: 'auto',
          config: {
            'web-search': {
              searchContextSize: 'medium',
              includeSources: true,
            },
            'image-generation': {
              size: '1024x1024',
              quality: 'low',
              format: 'png',
            },
          },
        },
        openrouter: { ...tools.openrouter, enabledServerToolIds: ['datetime'] },
      },
    })

    const { requestPlan, privacyPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('search then draw')],
      draftText: '',
      capabilities: {
        supportedParameters: ['tools', 'tool_choice', 'parallel_tool_calls', 'reasoning'],
        streaming: 'supported',
        architecture: { inputModalities: ['text'], outputModalities: ['text'] },
      },
    })

    expect(privacyPlan.privacy.applicable).toBe(false)
    expect(requestPlan.kind).toBe('responses')
    expect(requestPlan.reason).toBe('OpenAI hosted tools require Responses API')
    expect(requestPlan.wire.provider).toBeUndefined()
    expect(requestPlan.wire.tools).toEqual([
      { type: 'web_search', search_context_size: 'medium' },
      {
        type: 'image_generation',
        quality: 'low',
        size: '1024x1024',
        output_format: 'png',
      },
    ])
    expect(requestPlan.wire.include).toEqual(
      expect.arrayContaining(['web_search_call.action.sources']),
    )
    expect(requestPlan.wire.tool_choice).toBe('auto')
  })

  it('carries Google hosted tools only on Gemini native plans', async () => {
    const profile = makeGoogleProfile()
    const tools = cloneDefaultChatSettings().tools
    const chat = makeChat({
      profileId: profile.id,
      model: 'google/gemini-3.1-flash-lite-preview',
      api: 'gemini-native',
      tools: {
        ...tools,
        google: {
          ...tools.google,
          enabledServerToolIds: ['google-search', 'url-context'],
        },
        openrouter: { ...tools.openrouter, enabledServerToolIds: ['datetime'] },
      },
    })

    const { requestPlan, privacyPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('search and read this URL')],
      draftText: '',
      capabilities: {
        supportedParameters: ['tools'],
        streaming: 'supported',
        architecture: { inputModalities: ['text'], outputModalities: ['text'] },
      },
    })

    expect(privacyPlan.privacy.applicable).toBe(false)
    expect(requestPlan.kind).toBe('gemini-generate')
    expect(requestPlan.reason).toBe('Gemini native required for Google hosted tools')
    expect(requestPlan.wire.provider).toBeUndefined()
    expect(requestPlan.wire.tools).toEqual([{ googleSearch: {} }, { urlContext: {} }])
  })

  it('carries Anthropic hosted tools only on Messages plans', async () => {
    const profile = makeAnthropicProfile()
    const chat = makeChat({
      profileId: profile.id,
      model: 'claude-haiku-4.5',
      api: 'anthropic-messages',
      ...anthropicTools({
        enabledServerToolIds: ['web-search', 'web-fetch'],
        toolChoice: 'required',
      }),
    })

    const { requestPlan, privacyPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('search the web')],
      draftText: '',
      capabilities: {
        supportedParameters: ['tools', 'tool_choice'],
        streaming: 'supported',
        architecture: { inputModalities: ['text'], outputModalities: ['text'] },
      },
    })

    expect(privacyPlan.privacy.applicable).toBe(false)
    expect(requestPlan.kind).toBe('anthropic-messages')
    expect(requestPlan.anthropicModelId).toBe('claude-haiku-4-5')
    expect(requestPlan.wire.model).toBe('claude-haiku-4-5')
    expect(requestPlan.wire.tools).toEqual([
      { type: 'web_search_20250305', name: 'web_search' },
      { type: 'web_fetch_20250910', name: 'web_fetch' },
    ])
    expect(requestPlan.wire.tool_choice).toEqual({ type: 'any' })
  })

  it('carries OpenRouter hosted tools on chat/responses plans only for OpenRouter connections', async () => {
    const profile = makeProfile()
    const chat = makeChat({
      ...openRouterTools({
        enabledServerToolIds: ['datetime', 'web-fetch', 'shell'],
        toolChoice: 'auto',
      }),
    })
    await putCachedEndpoints(profile.id, chat.settings.model, {
      id: chat.settings.model,
      endpoints: [
        {
          provider_name: 'OpenAI',
          provider_slug: 'openai',
          supported_parameters: ['tools', 'tool_choice'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy(profile.id, chat.settings.model, {
      policies: {
        OpenAI: {
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

    const { requestPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('what time is it?')],
      draftText: '',
    })

    expect(requestPlan.wire.tools).toEqual([
      { type: 'openrouter:datetime' },
      { type: 'openrouter:web_fetch' },
    ])
    expect(requestPlan.wire.tool_choice).toBe('auto')

    const responsesChat = {
      ...chat,
      settings: { ...chat.settings, api: 'responses' as const },
    }
    const { requestPlan: responsesPlan } = await prepareAssistantRequestPlan({
      chat: responsesChat,
      connection: profile,
      pathMessages: [makeMessage('inspect the environment')],
      draftText: '',
    })
    expect(responsesPlan.kind).toBe('responses')
    expect(responsesPlan.wire.tools).toEqual([
      { type: 'openrouter:datetime' },
      { type: 'openrouter:web_fetch' },
      { type: 'openrouter:shell' },
    ])
  })

  it('uses one tool-call visibility source for OpenRouter, OpenAI, Gemini, and Anthropic planning', async () => {
    const providerOutputItems: NonNullable<Message['providerOutputItems']> = [
      {
        dialect: 'openai-responses',
        type: 'code_interpreter_call',
        item: {
          id: 'ci_1',
          type: 'code_interpreter_call',
          code: 'print(55)',
          outputs: [{ type: 'logs', logs: '55' }],
        },
      },
      {
        dialect: 'google-gemini',
        type: 'google:code_execution',
        item: { executableCode: { language: 'PYTHON', code: 'print(55)' } },
      },
      {
        dialect: 'anthropic-claude',
        type: 'server_tool_use',
        item: {
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
          input: { query: 'natter' },
        },
      },
    ]
    const path = [
      makeMessage('Use the tool evidence.'),
      makeAssistantWithProviderOutput(providerOutputItems),
    ]

    const openRouterProfile = makeProfile()
    await putCachedEndpoints(openRouterProfile.id, 'anthropic/claude-haiku-4.5', {
      id: 'anthropic/claude-haiku-4.5',
      endpoints: [
        {
          provider_name: 'Anthropic',
          provider_slug: 'anthropic',
          supported_parameters: ['provider', 'tools'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy(openRouterProfile.id, 'anthropic/claude-haiku-4.5', {
      policies: {
        anthropic: {
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

    const cases = [
      {
        name: 'openrouter',
        profile: openRouterProfile,
        settings: { model: 'anthropic/claude-haiku-4.5' },
        nativeNeedle: '<tool_call>',
      },
      {
        name: 'openai',
        profile: makeOpenAiProfile(),
        settings: { profileId: 'prof-openai', model: 'gpt-5.4-nano', api: 'responses' },
        nativeNeedle: '"code_interpreter_call"',
      },
      {
        name: 'google',
        profile: makeGoogleProfile(),
        settings: {
          profileId: 'prof-google',
          model: 'google/gemini-3.1-flash-lite-preview',
          api: 'gemini-native',
        },
        nativeNeedle: '"executableCode"',
      },
      {
        name: 'anthropic',
        profile: makeAnthropicProfile(),
        settings: {
          profileId: 'prof-anthropic',
          model: 'anthropic/claude-haiku-4.5',
          api: 'anthropic-messages',
        },
        nativeNeedle: '"server_tool_use"',
      },
    ] as const

    for (const entry of cases) {
      const includedChat = makeChat(entry.settings)
      const included = await prepareAssistantRequestPlan({
        chat: includedChat,
        connection: entry.profile,
        pathMessages: path,
        draftText: '',
      })
      expect(included.requestPlan.outboundReasoningOpts.includeToolCalls, entry.name).toBe(true)
      const includedWire = JSON.stringify(included.requestPlan.wire)
      expect(includedWire, entry.name).toContain(entry.nativeNeedle)
      expect(includedWire, entry.name).toContain('<tool_call>')

      const disabledChat = makeChat({
        ...entry.settings,
        toolCallContext: { include: false },
      })
      const disabled = await prepareAssistantRequestPlan({
        chat: disabledChat,
        connection: entry.profile,
        pathMessages: path,
        draftText: '',
      })
      expect(disabled.requestPlan.outboundReasoningOpts.includeToolCalls, entry.name).toBe(false)
      const disabledWire = JSON.stringify(disabled.requestPlan.wire)
      expect(disabledWire, entry.name).not.toContain('<tool_call>')
      expect(disabledWire, entry.name).not.toContain('code_interpreter_call')
      expect(disabledWire, entry.name).not.toContain('executableCode')
      expect(disabledWire, entry.name).not.toContain('server_tool_use')
      expect(included.privacyPlan.neededTokens ?? 0, entry.name).toBeGreaterThan(
        disabled.privacyPlan.neededTokens ?? 0,
      )
    }
  })

  it('passes the max completion cap through max_tokens when OpenRouter endpoints advertise only that name', async () => {
    const profile = makeProfile()
    const chat = makeChat({
      model: 'anthropic/claude-haiku-4.5',
      maxCompletionTokens: 32,
    })
    await putCachedEndpoints(profile.id, chat.settings.model, {
      id: chat.settings.model,
      endpoints: [
        {
          provider_name: 'OpenAI',
          provider_slug: 'openai',
          supported_parameters: ['provider', 'max_tokens'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy(profile.id, chat.settings.model, {
      policies: {
        OpenAI: {
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

    const { requestPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('answer briefly')],
      draftText: '',
    })

    expect(requestPlan.kind).toBe('chat-completions')
    expect(requestPlan.wire.max_tokens).toBe(32)
    expect(requestPlan.wire.max_completion_tokens).toBeUndefined()
  })

  it('routes OpenRouter video generation from the top-level endpoint architecture', async () => {
    const model = 'google/veo-3.1-lite'
    const profile = makeProfile()
    const chat = makeChat({ model })
    await putCachedEndpoints(profile.id, model, {
      id: model,
      architecture: {
        input_modalities: ['text', 'image'],
        output_modalities: ['video'],
      },
      endpoints: [
        {
          provider_name: 'Google',
          provider_slug: 'google',
          supported_parameters: ['max_tokens', 'temperature', 'top_p', 'seed'],
          context_length: 0,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy(profile.id, model, {
      policies: {
        Google: {
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

    const { requestPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('make a five second clip of a lighthouse')],
      draftText: '',
    })

    expect(requestPlan.transport).toBe('openrouter-video')
    expect(requestPlan.kind).toBe('video-generation')
    expect(requestPlan.wire.model).toBe(model)
    expect(requestPlan.wire.prompt).toBe('make a five second clip of a lighthouse')
    expect(requestPlan.wire.messages).toBeUndefined()
    expect(requestPlan.wire.provider).toMatchObject({ data_collection: 'deny' })
  })

  it('builds OpenRouter text-completions plans with the same provider routing inputs', async () => {
    const model = 'meta-llama/llama-3.3-70b-instruct'
    const profile = makeProfile()
    const chat = makeChat({
      model,
      api: 'text',
      textTemplate: 'chatml',
      maxCompletionTokens: 32,
      allowFallbacks: false,
      ...openRouterTools({ enabledServerToolIds: ['datetime'] }),
      providerPrefs: { only: ['Nebius'] },
      reasoning: {
        ...cloneDefaultChatSettings().reasoning,
        mode: 'off',
      },
    })
    await putCachedEndpoints(profile.id, model, {
      id: model,
      endpoints: [
        {
          provider_name: 'Nebius',
          provider_slug: 'nebius',
          supported_parameters: ['provider', 'reasoning', 'max_tokens'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy(profile.id, model, {
      policies: {
        Nebius: {
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

    const { requestPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('hello')],
      draftText: '',
    })

    expect(requestPlan.transport).toBe('openai-text')
    expect(requestPlan.kind).toBe('text-completions')
    expect(requestPlan.wire.prompt).toContain('<|im_start|>user\nhello<|im_end|>')
    expect(requestPlan.wire.max_tokens).toBe(32)
    expect(requestPlan.wire.reasoning).toEqual({ enabled: false })
    expect(requestPlan.wire.provider).toMatchObject({
      only: ['nebius'],
      allow_fallbacks: false,
    })
    expect(requestPlan.wire.tools).toBeUndefined()
  })

  it('keeps llama-server default-template reasoning evidence opaque through planning', async () => {
    const profile = makeLlamaServerProfile()
    const chat = makeChat({
      profileId: profile.id,
      model: 'local-model',
      api: 'text',
      protocol: 'text',
      textTemplate: 'default',
      reasoning: {
        ...cloneDefaultChatSettings().reasoning,
        include: { encrypted: false, summary: false, text: true },
      },
    })
    const assistant: Message = {
      ...makeMessage('answer'),
      id: 'a1',
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'answer' }],
      reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
        [{ type: 'reasoning.text', format: 'unknown', text: 'thought' }],
        'inline',
      ),
    }
    let appliedMessages: unknown
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('Expected string template body')
      const parsed: unknown = JSON.parse(init.body)
      if (!parsed || typeof parsed !== 'object' || !('messages' in parsed)) {
        throw new Error('Expected template messages')
      }
      appliedMessages = parsed.messages
      return new Response(JSON.stringify({ prompt: 'opaque server prompt' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { requestPlan } = await prepareAssistantRequestPlan({
        chat,
        connection: profile,
        pathMessages: [assistant],
        draftText: '',
      })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const request = fetchMock.mock.calls[0]?.[0]
      const requestUrl = request instanceof Request ? request.url : request?.toString()
      expect(requestUrl).toBe('http://llama.test/apply-template')
      expect(appliedMessages).toEqual([
        {
          role: 'assistant',
          content: '<think>\nthought\n</think>\n\nanswer',
        },
      ])
      expect(requestPlan.wire.prompt).toBe('opaque server prompt')
      expect(requestPlan.reasoningCarryForwardEvidence).toEqual({
        certainty: 'opaque',
        possible: 'visible-only',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('drops attachment context for text-completions plans', async () => {
    const model = 'meta-llama/llama-3.3-70b-instruct'
    const profile = makeProfile()
    const chat = makeChat({
      model,
      api: 'text',
      textTemplate: 'chatml',
      reasoning: {
        ...cloneDefaultChatSettings().reasoning,
        mode: 'off',
      },
    })
    await putCachedEndpoints(profile.id, model, {
      id: model,
      endpoints: [
        {
          provider_name: 'Nebius',
          provider_slug: 'nebius',
          supported_parameters: ['provider', 'reasoning', 'max_tokens'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy(profile.id, model, {
      policies: {
        Nebius: {
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
    await ingestAttachmentBytes({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      filename: 'cat.png',
      declaredMime: 'image/png',
      id: 'att-cat',
    })

    const message = {
      ...makeMessage('look'),
      attachmentRefs: [attachmentRef('att-cat')],
    }
    const { requestPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [message],
      draftText: '',
    })

    expect(requestPlan.transport).toBe('openai-text')
    expect(requestPlan.hasAttachmentContext).toBe(false)
    expect(String(requestPlan.wire.prompt)).not.toContain('cat.png')
  })

  it('skips a referenced attachment whose bytes were explicitly deleted', async () => {
    const profile = makeProfile()
    const chat = makeChat({ model: 'openai/gpt-4o:free' })
    await putCachedEndpoints(profile.id, chat.settings.model, {
      id: chat.settings.model,
      endpoints: [
        {
          provider_name: 'OpenAI',
          provider_slug: 'openai',
          supported_parameters: ['temperature'],
          context_length: 200_000,
          pricing: {},
        },
      ],
    })
    await ingestAttachmentBytes({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      filename: 'deleted-cat.png',
      declaredMime: 'image/png',
      id: 'att-deleted-cat',
    })
    const message = {
      ...makeMessage('look'),
      attachmentRefs: [attachmentRef('att-deleted-cat')],
    }
    await createChat({ id: chat.id, title: chat.title, settings: chat.settings, now: 1 })
    await putTestMessages([message])
    await deleteReferencedAttachmentBytes('att-deleted-cat', 'deleted', 10)
    const loaded = await runWorkspaceRead('repository-query', (permit) =>
      getWorkspaceRepository()
        .query(permit, { kind: 'message.presentation', messageId: message.id })
        .then((envelope) => envelope.value?.message),
    )
    if (!loaded) throw new Error('expected referenced message to remain loadable')
    const cachedEndpoints = await getCachedEndpoints(profile.id, chat.settings.model)
    expect(normalizeEndpointsResponse(cachedEndpoints?.payload)?.endpoints).toHaveLength(1)

    const { requestPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [loaded],
      draftText: '',
      capabilities: {
        supportedParameters: [],
        streaming: 'supported',
        architecture: { inputModalities: ['text', 'image'], outputModalities: ['text'] },
      },
    })

    expect(requestPlan.hasAttachmentContext).toBe(true)
    expect(JSON.stringify(requestPlan.wire)).not.toContain('deleted-cat.png')
    expect(JSON.stringify(requestPlan.wire)).not.toContain('AQID')
  })

  it('glues appendPrompt onto the last user message at wire time and leaves the stored row alone', async () => {
    const profile = makeOpenAiProfile()
    const chat = makeChat({
      profileId: profile.id,
      model: 'gpt-4o',
      api: 'chat',
      appendPrompt: '\n\nMake sure you do not introduce variables without defining them.',
    })
    const stored = makeMessage('What is 2+2?')
    const { requestPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [stored],
      draftText: '',
    })

    const wireMessages = requestPlan.wire.messages as Array<{ role: string; content: unknown }>
    const lastUser = [...wireMessages].reverse().find((m) => m.role === 'user')
    const lastUserText = typeof lastUser?.content === 'string' ? lastUser.content : ''
    expect(lastUserText).toBe(
      'What is 2+2?\n\nMake sure you do not introduce variables without defining them.',
    )
    // Stored row is untouched — only the wire clone carries the append.
    expect(stored.content).toEqual([{ type: 'text', text: 'What is 2+2?' }])

    // Outbound path message is a NEW object, not the stored row.
    const outboundLastUser = [...requestPlan.outboundPath].reverse().find((m) => m.role === 'user')
    expect(outboundLastUser).not.toBe(stored)
  })

  it('applies appendPrompt before cutoff while retaining the mandatory terminal user', async () => {
    const profile = makeOpenAiProfile()
    const chat = makeChat({
      profileId: profile.id,
      model: 'gpt-4o',
      api: 'chat',
      customMaxContext: 12,
      maxCompletionTokens: 0,
      contextStrategy: {
        ...cloneDefaultChatSettings().contextStrategy,
        keepFirstPairs: 0,
      },
      appendPrompt: `\n\n${'x'.repeat(200)}`,
    })

    const { requestPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('short')],
      draftText: '',
    })

    const wireMessages = requestPlan.wire.messages as Array<{ role: string; content: unknown }>
    expect(requestPlan.outboundPath).toHaveLength(1)
    expect(JSON.stringify(wireMessages)).toContain('short')
    expect(JSON.stringify(wireMessages)).toContain('x'.repeat(200))
  })

  it('non-prefill continue rides appendPrompt on the previous user turn, not the synthetic continueUser wrapper', async () => {
    const profile = makeOpenAiProfile()
    const chat = makeChat({
      profileId: profile.id,
      model: 'gpt-4o',
      api: 'chat',
      appendPrompt: '\n\nDouble-check your work.',
    })
    const realUser = makeMessage('Solve x^2 = 9.')
    const assistantPartial: Message = {
      ...makeMessage('We start by'),
      id: 'a1',
      parentId: 'u1',
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'We start by' }],
    }
    const continueUser: Message = {
      ...makeMessage('continue from where you left off.'),
      id: 'continue-user:a1',
      parentId: 'a1',
    }

    const { requestPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [realUser, assistantPartial, continueUser],
      draftText: '',
    })

    const wireMessages = requestPlan.wire.messages as Array<{ role: string; content: unknown }>
    const userTexts = wireMessages
      .filter((m) => m.role === 'user')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
    // Real user gets the append; the synthetic continueUser wrapper stays clean.
    expect(userTexts).toEqual([
      'Solve x^2 = 9.\n\nDouble-check your work.',
      'continue from where you left off.',
    ])
  })

  it('continue-prefill injects visible plaintext reasoning as think context even when reasoning echo is off', async () => {
    const profile = makeAnthropicProfile()
    const chat = makeChat({
      profileId: profile.id,
      model: 'claude-haiku-4.5',
      api: 'chat',
      reasoning: {
        ...cloneDefaultChatSettings().reasoning,
        mode: 'off',
        exclude: true,
        include: { encrypted: false, summary: false, text: false },
      },
    })
    const user = makeMessage('Explain the proof.')
    const reasoningEnvelope = reasoningEnvelopeFromDetailsForTest(
      [
        { type: 'reasoning.encrypted', data: 'opaque' },
        { type: 'reasoning.text', text: 'visible chain' },
        { type: 'reasoning.summary', summary: 'visible summary' },
      ],
      'inline',
    )
    const prefillAssistant: Message = {
      ...makeMessage('Partial answer'),
      id: 'a1',
      parentId: user.id,
      role: 'assistant',
      origin: 'prefill',
      content: [{ type: 'output_text', text: 'Partial answer' }],
      reasoningEnvelope,
    }

    const { requestPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [user, prefillAssistant],
      draftText: '',
    })

    const wireMessages = requestPlan.wire.messages as Array<{
      role: string
      content: unknown
      reasoning_details?: unknown
    }>
    const assistantWire = wireMessages.find((m) => m.role === 'assistant')
    expect(assistantWire?.content).toBe(
      '<think>\nvisible chain\n\nSummary: visible summary\n</think>\n\nPartial answer',
    )
    expect(assistantWire).not.toHaveProperty('reasoning_details')
    expect(prefillAssistant.reasoningEnvelope).toBe(reasoningEnvelope)
    expect(reasoningEnvelope.visible).toHaveLength(2)
    expect(reasoningEnvelope.carriers).toHaveLength(1)
  })

  it('continue-prefill honors hidden reasoning and leaves an open think block when only reasoning exists', async () => {
    const profile = makeAnthropicProfile()
    const chat = makeChat({
      profileId: profile.id,
      model: 'claude-haiku-4.5',
      api: 'chat',
      reasoning: {
        ...cloneDefaultChatSettings().reasoning,
        mode: 'off',
        exclude: true,
        include: { encrypted: false, summary: false, text: false },
      },
    })
    const user = makeMessage('Continue when ready.')
    const prefillAssistant: Message = {
      ...makeMessage(''),
      id: 'a1',
      parentId: user.id,
      role: 'assistant',
      origin: 'prefill',
      content: [],
      reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
        [
          { type: 'reasoning.text', text: 'do not send me', hidden: true },
          { type: 'reasoning.text', text: 'still thinking' },
        ],
        'inline',
      ),
    }

    const { requestPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [user, prefillAssistant],
      draftText: '',
    })

    const wireMessages = requestPlan.wire.messages as Array<{ role: string; content: unknown }>
    const assistantWire = wireMessages.find((m) => m.role === 'assistant')
    expect(assistantWire?.content).toBe('<think>\nstill thinking')
    expect(String(assistantWire?.content)).not.toContain('</think>')
    expect(String(assistantWire?.content)).not.toContain('do not send me')
  })

  it('continue-prefill preserves overlap-looking rows and excludes tool signatures', async () => {
    const profile = makeAnthropicProfile()
    const chat = makeChat({ profileId: profile.id, model: 'claude-haiku-4.5', api: 'chat' })
    const user = makeMessage('Continue the partial answer.')
    const reasoningDetails = [
      { type: 'reasoning.text', id: 'block-a', index: 0, text: 'ends A' },
      { type: 'reasoning.text', id: 'tool_call-1', index: 0, text: 'tool carrier' },
      { type: 'reasoning.text', id: 'block-b', index: 0, text: 'A starts' },
    ] as const
    const reasoningEnvelope = reasoningEnvelopeFromDetailsForTest(reasoningDetails, 'inline')
    const prefillAssistant: Message = {
      ...makeMessage('Partial answer'),
      id: 'a1',
      parentId: user.id,
      role: 'assistant',
      origin: 'prefill',
      content: [{ type: 'output_text', text: 'Partial answer' }],
      reasoningEnvelope,
    }

    const { requestPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [user, prefillAssistant],
      draftText: '',
    })

    const wireMessages = requestPlan.wire.messages as Array<{ role: string; content: unknown }>
    const assistantWire = wireMessages.find((message) => message.role === 'assistant')
    expect(assistantWire?.content).toBe('<think>\nends A\n\nA starts\n</think>\n\nPartial answer')
    expect(prefillAssistant.reasoningEnvelope).toBe(reasoningEnvelope)
  })

  it('omits appendPrompt entirely when the slot is blank', async () => {
    const profile = makeOpenAiProfile()
    const chat = makeChat({
      profileId: profile.id,
      model: 'gpt-4o',
      api: 'chat',
      appendPrompt: '',
    })
    const { requestPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages: [makeMessage('hi')],
      draftText: '',
    })
    const wireMessages = requestPlan.wire.messages as Array<{ role: string; content: unknown }>
    const lastUser = [...wireMessages].reverse().find((m) => m.role === 'user')
    expect(lastUser?.content).toBe('hi')
  })
})
