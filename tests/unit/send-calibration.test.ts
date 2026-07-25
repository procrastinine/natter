import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import type { ChatCompletionUsageWire } from '../../src/api/types'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { tokenCalibrationKey } from '../../src/core/model-ids'
import type { ChatSettings, ConnectionProfile, ContentItem } from '../../src/core/types'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { clearChatTokenCalibration } from '../../src/store/chats'
import { __resetDbForTests, getDb } from '../../src/store/db'
import type { GenerationHandle, GenerationTransportInput } from '../../src/store/generation-engine'
import { readTokenCalibrationGlobal } from '../../src/store/token-calibration'
import type {
  WorkspaceCommand,
  WorkspaceRepository,
  WorkspaceWriteAuthority,
} from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'
import { createChat } from '../helpers/chats'
import { putCachedEndpoints, putCachedPrivacyPolicy } from '../helpers/discovery-cache'
import { installGenerationProfile, startControlledGeneration } from '../helpers/generation-engine'

const DB_NAME = 'natter'
const MODEL = 'openai/gpt-4o'

type ExecuteInterceptor = (
  permit: WorkspaceWriteAuthority,
  command: WorkspaceCommand,
  next: WorkspaceRepository['execute'],
) => Promise<unknown>

let executeInterceptor: ExecuteInterceptor | undefined

function profile(): ConnectionProfile {
  return {
    id: 'calibration-profile',
    name: 'Calibration profile',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'calibration-key',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: '',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function settings(tools = false): ChatSettings {
  const base = cloneDefaultChatSettings()
  return {
    ...base,
    profileId: profile().id,
    model: MODEL,
    reasoning: {
      mode: 'off',
      exclude: false,
      summary: 'off',
      include: { encrypted: false, summary: false, text: false },
    },
    ...(tools
      ? {
          tools: {
            ...base.tools,
            openrouter: {
              ...base.tools.openrouter,
              enabledServerToolIds: ['web-search'],
            },
          },
        }
      : {}),
  }
}

async function reset(): Promise<void> {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await reset()
  await openBrowserWorkspace()
  const target = getBrowserRepository()
  const next = target.execute.bind(target)
  __setWorkspaceRepositoryForTests(
    repositoryProxy(target, (async (permit, command) => {
      const interceptor = executeInterceptor
      return interceptor ? interceptor(permit, command, next) : next(permit, command)
    }) as WorkspaceRepository['execute']),
  )
  await installGenerationProfile(profile(), { 'calibration-key': 'sk-test' })
  await putCachedEndpoints(profile().id, MODEL, {
    id: MODEL,
    endpoints: [
      {
        provider_name: 'Calibration provider',
        provider_slug: 'calibration-provider',
        supported_parameters: ['tools', 'provider', 'tool_choice'],
        context_length: 8_192,
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
  await putCachedPrivacyPolicy(profile().id, MODEL, {
    policies: {
      'Calibration provider': {
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
})

afterEach(async () => {
  executeInterceptor = undefined
  __resetWorkspaceRepositoryForTests()
  await shutdownBrowserWorkspace()
  await reset()
})

describe('generation token calibration gates', () => {
  it('calibrates prompt and completion for completed text-only requests', async () => {
    const chat = await createChat({ settings: settings() })

    await runSend(
      chat.id,
      [{ type: 'text', text: 'a'.repeat(400) }],
      streamText('b'.repeat(200), {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      }),
    )

    const stored = await getDb().chats.get(chat.id)
    const calibrationKey = tokenCalibrationKey(MODEL)
    expect(stored?.tokenCalibration?.[calibrationKey]?.sampleCount).toBe(2)
    expect((await readTokenCalibrationGlobal()).byModel[calibrationKey]?.sampleCount).toBe(2)
    const assistant = await assistantHeader(chat.id)
    expect(assistant?.generation?.tokenCalibration).toMatchObject({
      calibrationKey,
      promptSample: true,
      completionSample: true,
      sampleCount: 2,
    })
  })

  it('does not repopulate a chat when an explicit clear overtakes metadata commit', async () => {
    const chat = await createChat({ settings: settings() })
    let release!: () => void
    let reached!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const metadataReached = new Promise<void>((resolve) => {
      reached = resolve
    })
    executeInterceptor = async (permit, command, next) => {
      if (command.kind === 'generation.post-commit-metadata') {
        reached()
        await gate
      }
      return next(permit, command)
    }

    const handle = await startSend(
      chat.id,
      [{ type: 'text', text: 'a'.repeat(400) }],
      streamText('b'.repeat(200), {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      }),
    )
    await handle.prepared
    await metadataReached
    expect(await clearChatTokenCalibration(chat.id)).toBe(false)
    release()
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })

    const stored = await getDb().chats.get(chat.id)
    expect(stored?.tokenCalibrationGeneration).toBe(1)
    expect(stored?.tokenCalibration).toEqual({})
    const assistant = await assistantHeader(chat.id)
    expect(assistant?.generation?.tokenCalibration).toBeUndefined()
    expect(assistant).not.toHaveProperty('originalCharCount')
    expect((await readTokenCalibrationGlobal()).byModel[tokenCalibrationKey(MODEL)]).toBeUndefined()
  })

  it('calibrates only completion when tool schemas are present but no tool call happens', async () => {
    const chat = await createChat({ settings: settings(true) })

    await runSend(
      chat.id,
      [{ type: 'text', text: 'a'.repeat(400) }],
      streamText('b'.repeat(200), {
        prompt_tokens: 140,
        completion_tokens: 50,
        total_tokens: 190,
      }),
    )

    const calibrationKey = tokenCalibrationKey(MODEL)
    expect(
      (await getDb().chats.get(chat.id))?.tokenCalibration?.[calibrationKey]?.sampleCount,
    ).toBe(1)
    expect((await assistantHeader(chat.id))?.generation?.tokenCalibration).toMatchObject({
      calibrationKey,
      promptSample: false,
      completionSample: true,
      sampleCount: 1,
    })
  })

  it('calibrates only completion for multimodal context with text-only output', async () => {
    const chat = await createChat({ settings: settings() })

    await runSend(
      chat.id,
      [
        { type: 'text', text: 'a'.repeat(400) },
        { type: 'image_url', url: 'https://example.com/image.png' },
      ],
      streamText('b'.repeat(200), {
        prompt_tokens: 180,
        completion_tokens: 50,
        total_tokens: 230,
      }),
    )

    expect(
      (await getDb().chats.get(chat.id))?.tokenCalibration?.[tokenCalibrationKey(MODEL)]
        ?.sampleCount,
    ).toBe(1)
  })

  it('does not calibrate a request that finishes with a tool call', async () => {
    const chat = await createChat({ settings: settings(true) })

    await runSend(
      chat.id,
      [{ type: 'text', text: 'a'.repeat(400) }],
      streamText(
        '',
        { prompt_tokens: 140, completion_tokens: 50, total_tokens: 190 },
        'tool_calls',
      ),
    )

    expect((await getDb().chats.get(chat.id))?.tokenCalibration).toBeUndefined()
    expect((await readTokenCalibrationGlobal()).byModel[tokenCalibrationKey(MODEL)]).toBeUndefined()
  })

  it('does not calibrate a request that reports server tool usage', async () => {
    const chat = await createChat({ settings: settings(true) })

    await runSend(
      chat.id,
      [{ type: 'text', text: 'a'.repeat(400) }],
      streamText('b'.repeat(200), {
        prompt_tokens: 140,
        completion_tokens: 50,
        total_tokens: 190,
        server_tool_use: { web_search: 1 },
      }),
    )

    expect((await getDb().chats.get(chat.id))?.tokenCalibration).toBeUndefined()
    expect((await assistantHeader(chat.id))?.generation?.tokenCalibration).toBeUndefined()
  })
})

async function startSend(
  chatId: string,
  content: ContentItem[],
  openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>,
): Promise<GenerationHandle> {
  return startControlledGeneration(
    { kind: 'send', chatId, expectedLeafId: null, content },
    {
      profile: profile(),
      keyMaterial: { 'calibration-key': 'sk-test' },
      openStream,
    },
  )
}

async function runSend(
  chatId: string,
  content: ContentItem[],
  openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>,
) {
  const handle = await startSend(chatId, content, openStream)
  await handle.prepared
  return handle.completed
}

function streamText(text: string, usage: ChatCompletionUsageWire, finishReason = 'stop') {
  return async function* (): AsyncIterable<AssistantStreamChunk> {
    if (text.length > 0) {
      yield {
        type: 'delta',
        chunk: {
          id: 'calibration-generation',
          model: MODEL,
          choices: [{ delta: { content: text } }],
        },
      }
    }
    yield {
      type: 'delta',
      chunk: {
        id: 'calibration-generation',
        model: MODEL,
        choices: [{ finish_reason: finishReason }],
        usage,
      },
    }
  }
}

async function assistantHeader(chatId: string) {
  return (await getDb().messages.where('chatId').equals(chatId).toArray()).find(
    (message) => message.role === 'assistant',
  )
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
