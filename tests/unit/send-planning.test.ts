import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings, cloneDefaultPrivacyPrefs } from '../../src/core/defaults'
import {
  prepareAssistantRequestPlan,
  resolveRequestPrivacyPlan,
} from '../../src/core/send-planning'
import type { Chat, ConnectionProfile, Message, MessageAttachmentRef } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { ingestAttachmentBytes } from '../../src/store/attachments'
import { putCachedEndpoints } from '../../src/store/models-cache'
import {
  __resetPrivacyInFlightForTests,
  putCachedPrivacyPolicy,
} from '../../src/store/privacy-cache'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetPrivacyInFlightForTests()
  await Dexie.delete(DB_NAME)
}

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
    usesResponsesApiByDefault: false,
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
    usesResponsesApiByDefault: true,
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
    settings,
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 0,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
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

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

describe('resolveRequestPrivacyPlan', () => {
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
      enabledServerToolIds: ['datetime'],
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
    expect(requestPlan.route?.kind).toBe('chat-completions')
  })

  it('carries OpenRouter hosted tools on chat/responses plans only for OpenRouter connections', async () => {
    const profile = makeProfile()
    const chat = makeChat({
      enabledServerToolIds: ['datetime', 'web-fetch'],
      toolChoice: 'auto',
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

    expect(requestPlan.route?.transport).toBe('openrouter-video')
    expect(requestPlan.route?.kind).toBe('video-generation')
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
      enabledServerToolIds: ['datetime'],
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

    expect(requestPlan.useTextProtocol).toBe(true)
    expect(requestPlan.route?.kind).toBe('text-completions')
    expect(requestPlan.wire.prompt).toContain('<|im_start|>user\nhello<|im_end|>')
    expect(requestPlan.wire.max_tokens).toBe(32)
    expect(requestPlan.wire.reasoning).toEqual({ enabled: false })
    expect(requestPlan.wire.provider).toMatchObject({
      only: ['Nebius'],
      allow_fallbacks: false,
    })
    expect(requestPlan.wire.tools).toBeUndefined()
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

    expect(requestPlan.useTextProtocol).toBe(true)
    expect(requestPlan.hasAttachmentContext).toBe(false)
    expect(String(requestPlan.wire.prompt)).not.toContain('cat.png')
  })
})
