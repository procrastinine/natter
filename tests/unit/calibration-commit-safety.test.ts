import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import type { ChatCompletionUsageWire } from '../../src/api/types'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings, ConnectionProfile, Message } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __messageRequestContextChangedForTests,
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import {
  attachConversationWorkspace,
  disposeConversationWorkspace,
} from '../../src/store/conversation-workspace'
import { __resetDbForTests, getDb } from '../../src/store/db'
import type { GenerationTransportInput } from '../../src/store/generation-engine'
import { readGlobalPreferences } from '../../src/store/global-settings'
import {
  type MessageBodyRow,
  type MessageHeaderRow,
  splitMessageForStorage,
} from '../../src/store/message-storage'
import type {
  CommitEnvelope,
  WorkspaceCommand,
  WorkspaceCommandResult,
  WorkspaceRepository,
  WorkspaceWriteAuthority,
} from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'
import { getWorkspaceRuntimeControlSnapshot } from '../../src/store/workspace-runtime-control'
import { createChat } from '../helpers/chats'
import { putCachedEndpoints, putCachedPrivacyPolicy } from '../helpers/discovery-cache'
import { installGenerationProfile, startControlledGeneration } from '../helpers/generation-engine'

const DB_NAME = 'natter'
const MODEL = 'openai/gpt-4o'

type PostCommitCommand = Extract<WorkspaceCommand, { kind: 'generation.post-commit-metadata' }>
type PostCommitEnvelope = CommitEnvelope<WorkspaceCommandResult<PostCommitCommand>>
type ExecuteInterceptor = (
  permit: WorkspaceWriteAuthority,
  command: WorkspaceCommand,
  next: WorkspaceRepository['execute'],
) => Promise<unknown>

interface PostCommitPhysicalCapture {
  readonly beforeHeader: MessageHeaderRow
  readonly beforeBody: MessageBodyRow
  readonly afterHeader: MessageHeaderRow
  readonly afterBody: MessageBodyRow
  readonly commit: PostCommitEnvelope
}

let executeInterceptor: ExecuteInterceptor | undefined

function profile(): ConnectionProfile {
  return {
    id: 'calibration-safety-profile',
    name: 'Calibration safety profile',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'calibration-safety-key',
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

function settings(): ChatSettings {
  return {
    ...cloneDefaultChatSettings(),
    profileId: profile().id,
    model: MODEL,
    reasoning: {
      mode: 'off',
      exclude: false,
      summary: 'off',
      include: { encrypted: false, summary: false, text: false },
    },
  }
}

async function resetAll(): Promise<void> {
  executeInterceptor = undefined
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openBrowserWorkspace()
  const target = getBrowserRepository()
  const next = target.execute.bind(target)
  __setWorkspaceRepositoryForTests(
    repositoryProxy(target, (async (permit, command) => {
      const interceptor = executeInterceptor
      return interceptor ? interceptor(permit, command, next) : next(permit, command)
    }) as WorkspaceRepository['execute']),
  )
  await installGenerationProfile(profile(), { 'calibration-safety-key': 'sk-test' })
  await putCachedEndpoints(profile().id, MODEL, {
    id: MODEL,
    endpoints: [
      {
        provider_name: 'Calibration provider',
        provider_slug: 'calibration-provider',
        supported_parameters: ['provider'],
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
  await resetAll()
})

describe('calibration metadata commits', () => {
  it('partitions semantic and advisory storage revisions', () => {
    const message: Message = {
      id: 'partition-message',
      chatId: 'partition-chat',
      parentId: null,
      siblingIndex: 0,
      turnId: 'partition-turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'answer' }],
      nodeVersion: 0,
      deleted: false,
    }
    const { header, body } = splitMessageForStorage(message)
    const semanticHeaders = [
      { ...header, parentId: 'new-parent' },
      { ...header, role: 'tool' as const },
      { ...header, origin: 'imported' as const },
      { ...header, deleted: true },
      { ...header, hiddenFromContext: true },
      { ...header, pinCache: true },
      {
        ...header,
        attachmentRefs: [
          {
            refId: 'partition-ref',
            attachmentId: 'partition-attachment',
            includeInContext: true,
            presentation: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      { ...header, approval: { state: 'approved' as const, approvedAt: 2 } },
    ]
    for (const nextHeader of semanticHeaders) {
      expect(__messageRequestContextChangedForTests(header, body, nextHeader, body)).toBe(true)
    }

    const advisoryHeader = {
      ...header,
      siblingIndex: 4,
      turnId: 'other-turn',
      turnIndex: 3,
      createdAt: 9,
      editedAt: 10,
      nodeVersion: 11,
      requestContextVersion: 12,
      bodyVersion: 13,
      bodyWordCount: 14,
      textPreview: 'derived',
      originalCharCount: 15,
      originalTokenEstimate: 16,
      originalModelId: 'model',
      originalCalibrationKey: 'family:model',
      charCountDelta: 17,
      cachedTokenEstimate: 18,
      cachedMediaTokens: 19,
    }
    expect(__messageRequestContextChangedForTests(header, body, advisoryHeader, body)).toBe(false)
    expect(
      __messageRequestContextChangedForTests(header, body, header, {
        ...body,
        content: [{ type: 'output_text', text: 'changed' }],
        phase: 'final_answer',
      }),
    ).toBe(true)
    expect(
      __messageRequestContextChangedForTests(header, body, header, {
        ...body,
        bodyVersion: body.bodyVersion + 1,
        updatedAt: body.updatedAt + 1,
        continuationAttempts: [
          {
            streamId: 'partition-continuation',
            strategy: 'prompt',
            status: 'done',
            startedAt: 1,
            finishedAt: 2,
            application: { kind: 'unapplied', reason: 'base-version-changed' },
            reasoningCarryForward: 'unknown',
            reasoningVisibility: { disclosure: 'unknown' },
          },
        ],
      }),
    ).toBe(false)
  })

  it('commits accepted generation calibration as a header-only public command', async () => {
    const chat = await createChat({ settings: settings() })
    let capture: PostCommitPhysicalCapture | undefined
    let replay: PostCommitEnvelope | undefined
    let postCommitCalls = 0
    executeInterceptor = async (permit, command, next) => {
      if (command.kind !== 'generation.post-commit-metadata') {
        return next(permit, command)
      }
      postCommitCalls += 1
      const lease = await getDb().streamLeases.get(command.input.streamId)
      if (!lease) throw new Error(`PostCommitLeaseMissing:${command.input.streamId}`)
      const beforeHeader = await getDb().messages.get(lease.messageId)
      const beforeBody = await getDb().messageBodies.get(lease.messageId)
      if (!beforeHeader || !beforeBody) {
        throw new Error(`PostCommitMessageMissing:${lease.messageId}`)
      }
      const commit = await next(permit, command)
      replay = await next(permit, command)
      const afterHeader = await getDb().messages.get(lease.messageId)
      const afterBody = await getDb().messageBodies.get(lease.messageId)
      if (!afterHeader || !afterBody) {
        throw new Error(`PostCommitMessageMissingAfterCommit:${lease.messageId}`)
      }
      capture = {
        beforeHeader: structuredClone(beforeHeader),
        beforeBody: structuredClone(beforeBody),
        afterHeader: structuredClone(afterHeader),
        afterBody: structuredClone(afterBody),
        commit,
      }
      return commit
    }

    const handle = await startControlledGeneration(
      {
        kind: 'send',
        chatId: chat.id,
        expectedLeafId: null,
        content: [{ type: 'text', text: 'a'.repeat(400) }],
      },
      {
        profile: profile(),
        keyMaterial: { 'calibration-safety-key': 'sk-test' },
        openStream: streamText('b'.repeat(200), {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        }),
      },
    )
    await handle.prepared
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })

    expect(postCommitCalls).toBe(1)
    expect((await readGlobalPreferences()).recentModels).toEqual([MODEL])
    expect(replay).toMatchObject({
      effectScope: 'none',
      value: { outcome: 'already-applied' },
    })
    const physical = required(capture, 'post-commit capture')
    expect(physical.commit.effectScope).toBe('workspace')
    expect(physical.commit.value).toMatchObject({
      outcome: 'applied',
      chatId: chat.id,
      messageId: physical.beforeHeader.id,
      calibration: {
        attempted: true,
        promptAccepted: true,
        completionAccepted: true,
      },
    })
    expect(physical.beforeHeader.generation?.tokenCalibration).toBeUndefined()
    expect(physical.afterHeader).toMatchObject({
      id: physical.beforeHeader.id,
      nodeVersion: physical.beforeHeader.nodeVersion + 1,
      bodyVersion: physical.beforeHeader.bodyVersion,
      requestContextVersion: physical.beforeHeader.requestContextVersion,
      originalCharCount: 200,
      originalModelId: MODEL,
      generation: {
        tokenCalibration: {
          promptSample: true,
          completionSample: true,
          sampleCount: 2,
        },
      },
    })
    expect(physical.afterBody).toEqual(physical.beforeBody)
    if (
      physical.commit.value.outcome !== 'applied' ||
      !physical.commit.value.header ||
      !physical.commit.value.chatVersions
    ) {
      throw new Error('Expected applied calibration header')
    }
    expect(physical.commit.value.header).toEqual(physical.afterHeader)
    expect(physical.commit.receipt.messageRevisions).toEqual([
      {
        before: physical.beforeHeader,
        header: physical.afterHeader,
        structuralVersion: physical.commit.value.chatVersions.structuralVersion,
        changed: { structure: false, body: false },
      },
    ])
    expect(physical.commit.delta.facts).toContainEqual({
      kind: 'message-revision',
      chatId: chat.id,
      structuralVersion: physical.commit.value.chatVersions.structuralVersion,
      header: physical.afterHeader,
      changed: { structure: false, body: false },
    })
    expect(physical.commit.delta.invalidations).not.toContainEqual(
      expect.objectContaining({ kind: 'message-body', chatId: chat.id }),
    )
    expect(physical.commit.delta.invalidations).not.toContainEqual(
      expect.objectContaining({ kind: 'sidebar', chatIds: [chat.id] }),
    )
    expect(physical.commit.delta.facts).not.toContainEqual({
      kind: 'sidebar-row-changed',
      chatId: chat.id,
    })
  })

  it('does not publish model recency when dispatch fails after attempt preparation', async () => {
    const chat = await createChat({ settings: settings() })
    const beforeProfileLastUsedAt = (await getDb().profiles.get(profile().id))?.lastUsedAt
    const beforeKeyLastUsedAt = (await getDb().keys.get('calibration-safety-key'))?.lastUsedAt
    executeInterceptor = async (permit, command, next) => {
      if (command.kind === 'attempt.dispatch') throw new Error('dispatch failed before admission')
      return next(permit, command)
    }
    disposeConversationWorkspace()
    const runtime = getWorkspaceRuntimeControlSnapshot()
    if (!runtime.workspaceId) throw new Error('Expected open workspace')
    attachConversationWorkspace({
      workspaceId: runtime.workspaceId,
      replacementEpoch: runtime.replacementEpoch,
    })

    const handle = await startControlledGeneration(
      {
        kind: 'send',
        chatId: chat.id,
        expectedLeafId: null,
        content: [{ type: 'text', text: 'prepared but not dispatched' }],
      },
      {
        profile: profile(),
        keyMaterial: { 'calibration-safety-key': 'sk-test' },
        openStream: () => {
          throw new Error('transport must remain unopened')
        },
      },
    )
    await expect(handle.prepared).resolves.toMatchObject({ chatId: chat.id })
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'error' })

    expect((await readGlobalPreferences()).recentModels).toEqual([])
    expect((await getDb().profiles.get(profile().id))?.lastUsedAt).toBe(beforeProfileLastUsedAt)
    expect((await getDb().keys.get('calibration-safety-key'))?.lastUsedAt).toBe(beforeKeyLastUsedAt)
    const assistant = (await getDb().messages.where('chatId').equals(chat.id).toArray()).find(
      (message) => message.role === 'assistant',
    )
    expect(assistant?.generation?.status).toBe('error')
  })
})

function streamText(text: string, usage: ChatCompletionUsageWire) {
  return async function* (_input: GenerationTransportInput): AsyncIterable<AssistantStreamChunk> {
    yield {
      type: 'delta',
      chunk: {
        id: 'calibration-safety-generation',
        model: MODEL,
        choices: [{ delta: { content: text } }],
      },
    }
    yield {
      type: 'delta',
      chunk: {
        id: 'calibration-safety-generation',
        model: MODEL,
        choices: [{ finish_reason: 'stop' }],
        usage,
      },
    }
  }
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

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}`)
  return value
}
