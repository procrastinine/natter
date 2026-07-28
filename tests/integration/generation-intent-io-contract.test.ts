import Dexie, { type Transaction } from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import { navigate, newChatHref } from '../../src/app/router'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type {
  ChatSettings,
  ConnectionProfile,
  ContentItem,
  Message,
  MessageAttachmentRef,
  MessageId,
  MessageRole,
} from '../../src/core/types'
import { createRemoteAttachment } from '../../src/store/attachments'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { configurationController } from '../../src/store/configuration-controller'
import { importMessagesOp } from '../../src/store/conversation-command-client'
import { conversationController } from '../../src/store/conversation-controller'
import { createConversationRouteOwnerController } from '../../src/store/conversation-route-owner'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { generationAdmissionController } from '../../src/store/generation-admission-controller'
import type {
  CompletedGeneration,
  GenerationHandle,
  GenerationIntent,
  GenerationTransportInput,
  PreparedGeneration,
  PreparedNewChatGeneration,
} from '../../src/store/generation-engine'
import { createGenerationEngine } from '../../src/store/generation-engine'
import type { MessageBodyRow } from '../../src/store/message-storage'
import type { WorkspaceQuery, WorkspaceRepository } from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'
import { createChat } from '../helpers/chats'
import { putCachedEndpoints, putCachedPrivacyPolicy } from '../helpers/discovery-cache'
import {
  installGenerationProfile,
  prepareControlledGenerationSurface,
  requireStartedGeneration,
  startControlledGeneration,
  startGenerationForIntent,
} from '../helpers/generation-engine'
import { executeMessageCommand } from '../helpers/message-commands'
import { readTestMessages } from '../helpers/message-storage'

const DB_NAME = 'natter'
const MODEL = 'google/gemini-3.1-flash-lite-preview'
const PROVIDER_CAP = 120
const INTENT_KINDS = [
  'new-chat-send',
  'send',
  'reply',
  'regenerate',
  'edit-resend',
  'continue',
] as const satisfies readonly GenerationIntent['kind'][]

interface ExpectedPathEntry {
  id: MessageId
  role: MessageRole
  text: string
}

interface GenerationIoScenario {
  intent: GenerationIntent
  settings: ChatSettings
  coldBodyIds: MessageId[]
  siblingBodyIds: MessageId[]
  readableBodyIds: MessageId[]
  expectedPath(prepared: PreparedGeneration): ExpectedPathEntry[]
}

interface ProviderCapture {
  wireMessages: unknown
  readsAtOpen: MessageId[]
  bodyBatchesAtOpen: readonly BodyReadBatch[]
  queryEvidenceAtOpen: QueryEvidence
}

interface BodyReadBatch {
  transaction: number
  storeNames: readonly string[]
  ids: readonly MessageId[]
}

interface ClassifiedBodyReadBatch extends BodyReadBatch {
  source: 'message.presentations' | 'attempt-write'
}

interface QueryEvidence {
  queryKinds: string[]
  branchPageStructureRows: number[]
  branchPageStructureBodyIds: MessageId[]
}

interface QueryEvidenceMark {
  queryKinds: number
  branchPageStructureRows: number
  branchPageStructureBodyIds: number
}

const TRANSCRIPT_BODY_PAGE_ROWS = 24
const PROMPT_BODY_PAGE_ROWS = 16
const PROMPT_BODY_PAGE_TEXT_CHARS = 256_000

let queryEvidence: QueryEvidence

interface DeepBranchedFixture {
  chatId: string
  path: Message[]
  coldBodyIds: MessageId[]
  siblingBodyIds: MessageId[]
}

function profile(): ConnectionProfile {
  return {
    id: 'intent-io-profile',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'intent-io-key',
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

function boundedSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    ...cloneDefaultChatSettings(),
    profileId: profile().id,
    model: MODEL,
    maxCompletionTokens: 0,
    contextStrategy: {
      ...cloneDefaultChatSettings().contextStrategy,
      kind: 'sliding_window',
      keepFirstPairs: 0,
    },
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
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  sessionStorage.clear()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await reset()
  queryEvidence = emptyQueryEvidence()
  __setWorkspaceRepositoryForTests(
    repositoryWithQueryEvidence(() => getBrowserRepository(), queryEvidence),
  )
  await openBrowserWorkspace()
  await installGenerationProfile(profile(), { 'intent-io-key': 'sk-test' })
  await seedBoundedModel()
})

afterEach(async () => {
  await shutdownBrowserWorkspace()
  await reset()
})

describe('generation intent outbound-path and body-I/O contract', () => {
  it.each(
    INTENT_KINDS,
  )('%s resolves one finite provider cutoff before bounded branch hydration', async (kind) => {
    const scenario = await buildScenario(kind)
    expect(scenario.settings.customMaxContext).toBeUndefined()
    const queryMark = markQueryEvidence(queryEvidence)
    const releaseSurface = await prepareControlledGenerationSurface(scenario.intent, {
      profile: profile(),
      ...(kind === 'new-chat-send' ? { newChatSettings: scenario.settings } : {}),
    })
    releaseSurface()
    const bodyReads = captureBodyReads()
    let providerCapture: ProviderCapture | undefined
    let prepared: PreparedGeneration | undefined
    let outcome: CompletedGeneration | undefined
    try {
      const result = await runToCompletion(scenario.intent, (input) => {
        providerCapture = {
          wireMessages: structuredClone(input.requestPlan.wire.messages),
          readsAtOpen: [...bodyReads.ids],
          bodyBatchesAtOpen: bodyReads.batches(),
          queryEvidenceAtOpen: readQueryEvidenceSince(queryEvidence, queryMark),
        }
        return completedStream('intent contract answer')
      })
      prepared = result.prepared
      outcome = result.completed
    } finally {
      bodyReads.stop()
    }

    expect(outcome.error).toBeUndefined()
    expect(outcome).toMatchObject({ outcome: 'done' })
    const capture = required(providerCapture, 'provider capture')
    const preparedAttempt = required(prepared, 'prepared attempt')
    if (kind === 'new-chat-send') {
      const newChat = requirePreparedNewChat(preparedAttempt)
      expect(newChat.kind).toBe('handoff')
      if (newChat.kind !== 'handoff') throw new Error('prepared new chat route superseded')
      expect(newChat.handoff.chatId).toBe(newChat.chatId)
      expect(newChat.handoff.id.length).toBeGreaterThan(0)
      expect(newChat.handoff.workspaceId).toBeTruthy()
      expect(newChat.handoff.replacementEpoch).toBeGreaterThanOrEqual(0)
    }
    const expectedPath = scenario.expectedPath(preparedAttempt)
    expect(capture.wireMessages).toEqual(
      expectedPath.map(({ role, text }) => ({ role, content: text })),
    )
    expect(capture.queryEvidenceAtOpen.queryKinds).not.toContain('branch.body-page')
    expect(capture.queryEvidenceAtOpen.branchPageStructureBodyIds).toEqual([])
    expect(
      capture.queryEvidenceAtOpen.branchPageStructureRows.every(
        (rows) => rows <= TRANSCRIPT_BODY_PAGE_ROWS,
      ),
    ).toBe(true)
    if (kind !== 'new-chat-send') {
      expect(capture.queryEvidenceAtOpen.queryKinds).toContain('branch.page-structure')
      expect(capture.queryEvidenceAtOpen.branchPageStructureRows.length).toBeGreaterThan(0)
    }

    for (const id of [...scenario.coldBodyIds, ...scenario.siblingBodyIds]) {
      expect(capture.readsAtOpen, `body ${id} must stay cold`).not.toContain(id)
    }
    const counts = countBodyReads(capture.readsAtOpen)
    expect([...counts.values()].every((count) => count === 1)).toBe(true)
    const readableBodyIds = new Set(scenario.readableBodyIds)
    expect([...counts.keys()].every((id) => readableBodyIds.has(id))).toBe(true)
    expect(counts.size).toBeLessThanOrEqual(
      kind === 'new-chat-send' ? 0 : TRANSCRIPT_BODY_PAGE_ROWS,
    )
    const batches = await classifyBodyReadBatches(capture.readsAtOpen, capture.bodyBatchesAtOpen)
    const promptReadIds = batches
      .filter((batch) => batch.source === 'message.presentations')
      .flatMap((batch) => batch.ids)
    if (preparedAttempt.userMessageId) {
      expect(capture.readsAtOpen, 'prepared user body must not be reread').not.toContain(
        preparedAttempt.userMessageId,
      )
    }
    expect(
      promptReadIds,
      'prepared assistant body must not be read for prompt planning',
    ).not.toContain(preparedAttempt.assistantMessageId)
    if (kind !== 'continue') {
      expect(capture.readsAtOpen, 'prepared assistant body must not be reread').not.toContain(
        preparedAttempt.assistantMessageId,
      )
    }
  })

  it('reconciles a mandatory terminal send by shrinking endpoint eligibility without rereading bodies', async () => {
    await seedReconciledModel()
    const fixture = await seedDeepBranchedFixture(
      boundedSettings({ strictProviderRouting: true }),
      [],
    )
    const submitted = `mandatory terminal question ${'x'.repeat(2_000)}`
    const intent = {
      kind: 'send' as const,
      chatId: fixture.chatId,
      expectedLeafId: required(fixture.path.at(-1), 'reconciled leaf').id,
      content: [{ type: 'text' as const, text: submitted }],
    }
    const releaseSurface = await prepareControlledGenerationSurface(intent, {
      profile: profile(),
    })
    releaseSurface()
    const bodyReads = captureBodyReads()
    let wire: Record<string, unknown> | undefined
    let completed: CompletedGeneration | undefined
    try {
      const result = await runToCompletion(intent, (input) => {
        wire = structuredClone(input.requestPlan.wire)
        return completedStream('reconciled answer')
      })
      completed = result.completed
    } finally {
      bodyReads.stop()
    }

    expect(completed).toMatchObject({ outcome: 'done' })
    const sentWire = required(wire, 'reconciled wire')
    const providerWire = sentWire.provider as { ignore?: string[] }
    expect(JSON.stringify(sentWire.messages)).toContain(submitted)
    expect(providerWire.ignore).toContain('tiny-cap')
    expect(providerWire.ignore).not.toContain('large-cap')
    const counts = countBodyReads(bodyReads.ids)
    expect([...counts.values()].every((count) => count === 1)).toBe(true)
    for (const id of fixture.siblingBodyIds) expect(bodyReads.ids).not.toContain(id)
  })

  it('rejects new-chat preparation before transport when no route-delivery result exists', async () => {
    const intent = {
      kind: 'new-chat-send' as const,
      content: [{ type: 'text' as const, text: 'x' }],
    }
    const releaseSurface = await prepareControlledGenerationSurface(intent, {
      profile: profile(),
      newChatSettings: boundedSettings(),
    })
    const openStream = vi.fn(() => completedStream('must not open'))
    const missingHandoff = vi
      .spyOn(generationAdmissionController, 'acceptPrepared')
      .mockReturnValueOnce(undefined)
    try {
      let handle: GenerationHandle
      try {
        handle = requireStartedGeneration(
          startGenerationForIntent(createGenerationEngine({ openStream }), intent),
        )
      } finally {
        releaseSurface()
      }

      await expect(handle.prepared).rejects.toThrow('GenerationNewChatRouteDeliveryMissing')
      await expect(handle.completed).resolves.toMatchObject({ outcome: 'error' })
      expect(openStream).not.toHaveBeenCalled()
    } finally {
      missingHandoff.mockRestore()
    }
  })

  it('continues a committed new-chat generation when its tab route is already superseded', async () => {
    const intent = {
      kind: 'new-chat-send' as const,
      content: [{ type: 'text' as const, text: 'keep generating' }],
    }
    const releaseSurface = await prepareControlledGenerationSurface(intent, {
      profile: profile(),
      newChatSettings: boundedSettings(),
    })
    const owner = createConversationRouteOwnerController()
    owner.cancel('superseded-before-commit')
    let handle: GenerationHandle
    try {
      handle = requireStartedGeneration(
        createGenerationEngine({ openStream: () => completedStream('background answer') }).start({
          intent,
          routeOwner: owner.owner,
        }),
      )
    } finally {
      releaseSurface()
    }

    await expect(handle.prepared).resolves.toMatchObject({
      kind: 'superseded',
      chatId: handle.chatId,
    })
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
  })

  it('captures caller-owned draft, prefill, attachment, and settings payloads before deferred reads', async () => {
    await seedBoundedModel(100_000)
    const chat = await createChat({ settings: boundedSettings({ customMaxContext: -1 }) })
    const attachment = await createRemoteAttachment({
      url: 'https://example.test/start-time.png',
      filename: 'start-time.png',
      mime: 'image/png',
      kind: 'image',
      origin: 'user-remote-url',
    })
    const content: ContentItem[] = [{ type: 'text', text: 'start-time draft' }]
    const prefillContent: ContentItem[] = [{ type: 'text', text: 'start-time prefill' }]
    const attachmentRefs: MessageAttachmentRef[] = [attachmentRef(attachment.id)]
    const sendIntent = {
      kind: 'send' as const,
      chatId: chat.id,
      expectedLeafId: null,
      content,
      prefillContent,
      attachmentRefs,
    }
    const releaseSendSurface = await prepareControlledGenerationSurface(sendIntent, {
      profile: profile(),
    })
    let sendWire: Record<string, unknown> | undefined
    const sendEngine = createGenerationEngine({
      openStream: (input) => {
        sendWire = structuredClone(input.requestPlan.wire)
        return completedStream('snapshot answer')
      },
    })
    let sendHandle: GenerationHandle
    try {
      sendHandle = requireStartedGeneration(startGenerationForIntent(sendEngine, sendIntent))
    } finally {
      releaseSendSurface()
    }

    ;(content[0] as { type: 'text'; text: string }).text = 'mutated draft'
    ;(prefillContent[0] as { type: 'text'; text: string }).text = 'mutated prefill'
    const mutableRef = required(attachmentRefs[0], 'mutable attachment ref')
    mutableRef.includeInContext = false
    mutableRef.presentation.label = 'mutated attachment'

    const preparedSend = await sendHandle.prepared
    const completedSend = await sendHandle.completed
    expect(completedSend.error).toBeUndefined()
    expect(completedSend).toMatchObject({ outcome: 'done' })
    const sendWireText = JSON.stringify(sendWire)
    expect(sendWireText).toContain('start-time draft')
    expect(sendWireText).toContain('start-time prefill')
    expect(sendWireText).toContain('image_url')
    expect(sendWireText).not.toContain('mutated draft')
    expect(sendWireText).not.toContain('mutated prefill')
    const storedUser = (await readTestMessages(chat.id)).find(
      (message) => message.id === preparedSend.userMessageId,
    )
    expect(storedUser?.attachmentRefs).toEqual([
      expect.objectContaining({
        attachmentId: attachment.id,
        includeInContext: true,
        presentation: {},
      }),
    ])

    const settingsPatch = { systemPrompt: 'start-time system' }
    let regenerateWire: Record<string, unknown> | undefined
    const regenerateEngine = createGenerationEngine({
      openStream: (input) => {
        regenerateWire = structuredClone(input.requestPlan.wire)
        return completedStream('snapshot regeneration')
      },
    })
    const regenerateIntent = {
      kind: 'regenerate' as const,
      chatId: chat.id,
      targetAssistantId: preparedSend.assistantMessageId,
      settingsPatch,
    }
    const releaseRegenerateSurface = await prepareControlledGenerationSurface(regenerateIntent, {
      profile: profile(),
    })
    let regenerateHandle: GenerationHandle
    try {
      regenerateHandle = requireStartedGeneration(
        regenerateEngine.start({ intent: regenerateIntent }),
      )
    } finally {
      releaseRegenerateSurface()
    }
    settingsPatch.systemPrompt = 'mutated system'

    await expect(regenerateHandle.completed).resolves.toMatchObject({ outcome: 'done' })
    const regenerateWireText = JSON.stringify(regenerateWire)
    expect(regenerateWireText).toContain('start-time system')
    expect(regenerateWireText).not.toContain('mutated system')
  })

  it('commits the exact nonzero-sibling regenerate placement shown at admission', async () => {
    const chat = await createChat({ settings: boundedSettings() })
    const path = await seedLinear(chat.id, [
      { role: 'user', text: 'regenerate exact placement parent' },
      { role: 'assistant', text: 'regenerate exact placement target' },
    ])
    const target = required(path.at(-1), 'regenerate placement target')
    await executeMessageCommand({
      kind: 'message.insert-sibling',
      input: {
        chatId: chat.id,
        targetId: target.id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'existing sibling' }],
      },
    })
    const intent = {
      kind: 'regenerate' as const,
      chatId: chat.id,
      targetAssistantId: target.id,
    }
    let releaseProvider: () => void = () => undefined
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    const presented = vi.spyOn(conversationController, 'presentGenerationIntent')
    let immediate: Message | undefined
    let committed: Message | undefined
    let preparedAssistantId: MessageId | undefined
    try {
      const handle = await startControlledGeneration(intent, {
        profile: profile(),
        openStream: () => gatedCompletedStream(providerGate, 'replacement answer'),
      })
      immediate = required(presented.mock.calls.at(-1)?.[1].messages.at(-1), 'immediate placement')
      const prepared = await handle.prepared
      preparedAssistantId = prepared.assistantMessageId
      committed = required(
        (await readTestMessages(chat.id)).find(
          (message) => message.id === prepared.assistantMessageId,
        ),
        'committed placement',
      )
      releaseProvider()
      await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
    } finally {
      presented.mockRestore()
      releaseProvider()
    }
    const exactImmediate = required(immediate, 'captured immediate placement')
    const exactCommitted = required(committed, 'captured committed placement')
    expect(exactImmediate.siblingIndex).toBe(2)
    expect(exactCommitted.id).toBe(preparedAssistantId)
    const {
      generation: immediateGeneration,
      nodeVersion: immediateNodeVersion,
      ...immediateMessage
    } = exactImmediate
    const {
      generation: committedGeneration,
      nodeVersion: committedNodeVersion,
      ...committedMessage
    } = exactCommitted
    expect(committedMessage).toEqual(immediateMessage)
    expect(immediateNodeVersion).toBe(0)
    expect(committedNodeVersion).toBeGreaterThanOrEqual(immediateNodeVersion)
    const { reasoningVisibility: _immediateVisibility, ...immediateProvenance } = required(
      immediateGeneration,
      'immediate generation',
    )
    expect(committedGeneration).toMatchObject({
      ...immediateProvenance,
      status: 'streaming',
    })
  })

  it.each([
    'send',
    'regenerate',
    'continue',
  ] as const)('%s remains eligible after re-reading an imported chain from durable storage', async (kind) => {
    const chat = await createChat({
      settings: boundedSettings({ continueSystemPrompt: '', continueUserPrompt: '' }),
    })
    const path = await seedLinear(chat.id, [
      { role: 'user', text: 'imported generation parent' },
      { role: 'assistant', text: 'imported assistant without generation metadata' },
    ])
    const durablePath = await readTestMessages(chat.id)
    const user = required(
      durablePath.find((message) => message.id === path.at(-2)?.id),
      'durable imported user',
    )
    const assistant = required(
      durablePath.find((message) => message.id === path.at(-1)?.id),
      'durable imported assistant',
    )
    expect(user.origin).toBe('imported')
    expect(assistant.origin).toBe('imported')
    expect(assistant.generation).toBeUndefined()

    const intent: GenerationIntent =
      kind === 'send'
        ? {
            kind,
            chatId: chat.id,
            expectedLeafId: assistant.id,
            content: [{ type: 'text', text: 'send after imported chain' }],
          }
        : { kind, chatId: chat.id, targetAssistantId: assistant.id }
    const result = await runToCompletion(intent, () =>
      completedStream(`${kind} after imported chain`),
    )

    expect(result.completed).toMatchObject({ outcome: 'done' })
    expect(result.completed.error).toBeUndefined()
  })

  it('retains one frozen first submit while destination selection settles', async () => {
    const chat = await createChat({ settings: boundedSettings() })
    const path = await seedLinear(chat.id, [
      { role: 'user', text: 'choose a branch' },
      { role: 'assistant', text: 'left branch' },
    ])
    const parent = required(path[0], 'branch parent')
    const left = required(path[1], 'left branch')
    const right = await executeMessageCommand({
      kind: 'message.insert-sibling',
      input: {
        chatId: chat.id,
        targetId: left.id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'right branch' }],
      },
    })
    const releaseSurface = await prepareControlledGenerationSurface(
      {
        kind: 'send',
        chatId: chat.id,
        expectedLeafId: left.id,
        content: [{ type: 'text', text: 'surface only' }],
      },
      { profile: profile() },
    )
    releaseSurface()

    conversationController.navigate({
      chatId: chat.id,
      kind: 'sibling-position',
      parentId: parent.id,
      position: 1,
    })
    const content: ContentItem[] = [{ type: 'text', text: 'captured first submit' }]
    let wire: Record<string, unknown> | undefined
    const openStream = vi.fn((input: GenerationTransportInput) => {
      wire = structuredClone(input.requestPlan.wire)
      return completedStream('selected answer')
    })
    const controller = new AbortController()
    const handlePromise = createGenerationEngine({ openStream }).startWhenCapabilitySettles(
      { intent: { kind: 'selected-send', chatId: chat.id, content } },
      { signal: controller.signal },
    )
    expect(openStream).not.toHaveBeenCalled()
    ;(content[0] as { type: 'text'; text: string }).text = 'mutated after gesture'

    const handle = await handlePromise
    const prepared = await handle.prepared
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
    expect(openStream).toHaveBeenCalledOnce()
    const storedUser = (await readTestMessages(chat.id)).find(
      (message) => message.id === prepared.userMessageId,
    )
    expect(storedUser?.parentId).toBe(right.messageId)
    expect(JSON.stringify(wire)).toContain('captured first submit')
    expect(JSON.stringify(wire)).not.toContain('mutated after gesture')
  })

  it('retains selected configuration through its exact acknowledgement and a route change', async () => {
    const first = await createChat({ settings: boundedSettings() })
    const path = await seedLinear(first.id, [
      { role: 'user', text: 'first route' },
      { role: 'assistant', text: 'first route leaf' },
    ])
    const leaf = required(path.at(-1), 'first route leaf')
    const releaseFirst = await prepareControlledGenerationSurface(
      {
        kind: 'send',
        chatId: first.id,
        expectedLeafId: leaf.id,
        content: [{ type: 'text', text: 'surface only' }],
      },
      { profile: profile() },
    )
    releaseFirst()
    const [configurationIntent] = configurationController.stageChatSettingsFields(first.id, [
      { path: ['textTemplate'], value: 'raw' },
    ])
    if (!configurationIntent) throw new Error('GenerationConfigurationIntentMissing')
    const openStream = vi.fn(() => completedStream('route-independent answer'))
    const controller = new AbortController()
    const handlePromise = createGenerationEngine({ openStream }).startWhenCapabilitySettles(
      {
        intent: {
          kind: 'selected-send',
          chatId: first.id,
          content: [{ type: 'text', text: 'finish the first route' }],
        },
      },
      { signal: controller.signal },
    )
    expect(openStream).not.toHaveBeenCalled()

    const second = await createChat({ settings: boundedSettings() })
    const releaseSecond = await prepareControlledGenerationSurface(
      {
        kind: 'send',
        chatId: second.id,
        expectedLeafId: null,
        content: [{ type: 'text', text: 'second surface only' }],
      },
      { profile: profile() },
    )
    releaseSecond()
    configurationController.acknowledgePendingConfiguration(first.id, {
      promptFields: [],
      chatSettingsFields: [
        {
          fieldKey: configurationIntent.fieldKey,
          revision: configurationIntent.revision,
        },
      ],
      acceptedChatConfigurationVersion: 1,
    })

    const handle = await handlePromise
    const prepared = await handle.prepared
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
    expect(openStream).toHaveBeenCalledOnce()
    expect(
      (await readTestMessages(first.id)).find((message) => message.id === prepared.userMessageId),
    ).toMatchObject({
      chatId: first.id,
      content: [{ type: 'text', text: 'finish the first route' }],
    })
  })

  it('releases a cancelled pending first submit before the next gesture', async () => {
    const chat = await createChat({ settings: boundedSettings() })
    const path = await seedLinear(chat.id, [
      { role: 'user', text: 'choose a cancellable branch' },
      { role: 'assistant', text: 'first branch' },
    ])
    const parent = required(path[0], 'cancellable branch parent')
    const first = required(path[1], 'first cancellable branch')
    await executeMessageCommand({
      kind: 'message.insert-sibling',
      input: {
        chatId: chat.id,
        targetId: first.id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'second branch' }],
      },
    })
    const releaseSurface = await prepareControlledGenerationSurface(
      {
        kind: 'send',
        chatId: chat.id,
        expectedLeafId: first.id,
        content: [{ type: 'text', text: 'surface only' }],
      },
      { profile: profile() },
    )
    releaseSurface()

    conversationController.navigate({
      chatId: chat.id,
      kind: 'sibling-position',
      parentId: parent.id,
      position: 1,
    })
    const openStream = vi.fn(() => completedStream('only the second gesture runs'))
    const engine = createGenerationEngine({ openStream })
    const cancelled = new AbortController()
    const firstGesture = engine.startWhenCapabilitySettles(
      {
        intent: {
          kind: 'selected-send',
          chatId: chat.id,
          content: [{ type: 'text', text: 'cancel this gesture' }],
        },
      },
      { signal: cancelled.signal },
    )
    cancelled.abort(new DOMException('Gesture cancelled.', 'AbortError'))

    await expect(firstGesture).rejects.toMatchObject({ name: 'AbortError' })
    expect(openStream).not.toHaveBeenCalled()

    const next = new AbortController()
    const handle = await engine.startWhenCapabilitySettles(
      {
        intent: {
          kind: 'selected-send',
          chatId: chat.id,
          content: [{ type: 'text', text: 'run the next gesture' }],
        },
      },
      { signal: next.signal },
    )
    await handle.prepared
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
    expect(openStream).toHaveBeenCalledOnce()
  })

  it('releases submit ownership after preparation without aborting the provider stream', async () => {
    const chat = await createChat({ settings: boundedSettings() })
    const path = await seedLinear(chat.id, [
      { role: 'user', text: 'prepare independently' },
      { role: 'assistant', text: 'prepared branch' },
    ])
    const leaf = required(path.at(-1), 'prepared branch leaf')
    const releaseSurface = await prepareControlledGenerationSurface(
      {
        kind: 'send',
        chatId: chat.id,
        expectedLeafId: leaf.id,
        content: [{ type: 'text', text: 'surface only' }],
      },
      { profile: profile() },
    )
    releaseSurface()

    let releaseProvider: () => void = () => undefined
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    const controller = new AbortController()
    const handle = await createGenerationEngine({
      openStream: () => gatedCompletedStream(providerGate, 'provider survives presentation'),
    }).startWhenCapabilitySettles(
      {
        intent: {
          kind: 'selected-send',
          chatId: chat.id,
          content: [{ type: 'text', text: 'durably prepare this send' }],
        },
      },
      { signal: controller.signal },
    )

    await handle.prepared
    controller.abort(new DOMException('Presentation owner released.', 'AbortError'))
    releaseProvider()

    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
  })

  it('retains one frozen first submit while new-chat configuration settles', async () => {
    configurationController.rememberSeed({
      profileId: profile().id,
      presetId: null,
      settings: boundedSettings(),
    })
    navigate(newChatHref())
    const content: ContentItem[] = [{ type: 'text', text: 'new chat first submit' }]
    let wire: Record<string, unknown> | undefined
    const openStream = vi.fn((input: GenerationTransportInput) => {
      wire = structuredClone(input.requestPlan.wire)
      return completedStream('new chat answer')
    })
    const routeOwner = createConversationRouteOwnerController()
    const controller = new AbortController()
    const handlePromise = createGenerationEngine({ openStream }).startWhenCapabilitySettles(
      { intent: { kind: 'new-chat-send', content }, routeOwner: routeOwner.owner },
      { signal: controller.signal },
    )
    expect(openStream).not.toHaveBeenCalled()
    ;(content[0] as { type: 'text'; text: string }).text = 'mutated new chat draft'

    const handle = await handlePromise
    const prepared = await handle.prepared
    if (prepared.kind === 'handoff') prepared.handoff.cancel()
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
    expect(openStream).toHaveBeenCalledOnce()
    expect(JSON.stringify(wire)).toContain('new chat first submit')
    expect(JSON.stringify(wire)).not.toContain('mutated new chat draft')
  })

  it('hydrates the exact unlimited branch before excluding an insufficient provider', async () => {
    const unlimitedSettings = boundedSettings({ customMaxContext: -1 })
    const fixture = await seedDeepBranchedFixture(unlimitedSettings, [])
    const submitted = 'unlimited submitted question'
    const intent = {
      kind: 'send' as const,
      chatId: fixture.chatId,
      expectedLeafId: required(fixture.path.at(-1), 'unlimited leaf').id,
      content: [{ type: 'text' as const, text: submitted }],
    }
    const queryMark = markQueryEvidence(queryEvidence)
    const releaseSurface = await prepareControlledGenerationSurface(intent, { profile: profile() })
    releaseSurface()
    const bodyReads = captureBodyReads()
    let prepared: PreparedGeneration | undefined
    let completed: CompletedGeneration | undefined
    let readsAtCompletion: MessageId[]
    let batchesAtCompletion: readonly BodyReadBatch[]
    let queryEvidenceAtCompletion: QueryEvidence | undefined
    try {
      const result = await runToCompletion(intent, () => completedStream('must not open'))
      prepared = result.prepared
      completed = result.completed
      readsAtCompletion = [...bodyReads.ids]
      batchesAtCompletion = bodyReads.batches()
      queryEvidenceAtCompletion = readQueryEvidenceSince(queryEvidence, queryMark)
    } finally {
      bodyReads.stop()
    }

    const preparedAttempt = required(prepared, 'unlimited prepared attempt')
    expect(completed).toMatchObject({
      outcome: 'error',
      error: { message: 'No eligible providers can serve this request.' },
    })
    const evidence = required(queryEvidenceAtCompletion, 'unlimited query evidence')
    expect(evidence.queryKinds).toContain('branch.page-structure')
    expect(evidence.queryKinds).not.toContain('branch.body-page')
    expect(evidence.branchPageStructureBodyIds).toEqual([])
    expect(evidence.branchPageStructureRows.length).toBeGreaterThan(0)
    expect(
      evidence.branchPageStructureRows.every((rows) => rows <= TRANSCRIPT_BODY_PAGE_ROWS),
    ).toBe(true)
    const pathIds = new Set(fixture.path.map((message) => message.id))
    const counts = countBodyReads(readsAtCompletion)
    expect([...counts.values()].every((count) => count === 1)).toBe(true)
    expect(readsAtCompletion).not.toContain(preparedAttempt.userMessageId)
    expect(readsAtCompletion).not.toContain(preparedAttempt.assistantMessageId)
    expect([...counts.keys()].every((id) => pathIds.has(id))).toBe(true)
    for (const id of fixture.siblingBodyIds) expect(readsAtCompletion).not.toContain(id)
    const batches = await classifyBodyReadBatches(readsAtCompletion, batchesAtCompletion)
    expect(
      batches.filter((batch) => batch.source === 'message.presentations').length,
    ).toBeGreaterThan(1)
  })
})

async function buildScenario(kind: GenerationIntent['kind']): Promise<GenerationIoScenario> {
  switch (kind) {
    case 'new-chat-send': {
      const chatSettings = boundedSettings()
      const decoy = await seedDeepBranchedFixture(chatSettings, [])
      const text = 'new chat submitted question'
      return {
        settings: chatSettings,
        intent: {
          kind,
          title: 'Intent I/O new chat',
          content: [{ type: 'text', text }],
        },
        coldBodyIds: decoy.path.map((message) => message.id),
        siblingBodyIds: decoy.siblingBodyIds,
        readableBodyIds: [],
        expectedPath: (prepared) => [
          {
            id: required(prepared.userMessageId, 'new-chat prepared user'),
            role: 'user',
            text,
          },
        ],
      }
    }
    case 'send': {
      const chatSettings = boundedSettings()
      const fixture = await seedDeepBranchedFixture(chatSettings, [])
      const text = 'send submitted question'
      return {
        settings: chatSettings,
        intent: {
          kind,
          chatId: fixture.chatId,
          expectedLeafId: required(fixture.path.at(-1), 'send leaf').id,
          content: [{ type: 'text', text }],
        },
        coldBodyIds: fixture.coldBodyIds,
        siblingBodyIds: fixture.siblingBodyIds,
        readableBodyIds: fixture.path.map((message) => message.id),
        expectedPath: (prepared) => [
          {
            id: required(prepared.userMessageId, 'send prepared user'),
            role: 'user',
            text,
          },
        ],
      }
    }
    case 'reply': {
      const chatSettings = boundedSettings()
      const parentText = 'reply parent question'
      const fixture = await seedDeepBranchedFixture(chatSettings, [
        { role: 'user', text: parentText },
      ])
      const parent = required(fixture.path.at(-1), 'reply parent')
      return {
        settings: chatSettings,
        intent: { kind, chatId: fixture.chatId, parentUserId: parent.id },
        coldBodyIds: fixture.coldBodyIds,
        siblingBodyIds: fixture.siblingBodyIds,
        readableBodyIds: fixture.path.map((message) => message.id),
        expectedPath: () => [{ id: parent.id, role: 'user', text: parentText }],
      }
    }
    case 'regenerate': {
      const chatSettings = boundedSettings()
      const parentText = 'regenerate parent question'
      const targetText = 'regenerate excluded old answer'
      const fixture = await seedDeepBranchedFixture(chatSettings, [
        { role: 'user', text: parentText },
        { role: 'assistant', text: targetText },
      ])
      const parent = required(fixture.path.at(-2), 'regenerate parent')
      const target = required(fixture.path.at(-1), 'regenerate target')
      return {
        settings: chatSettings,
        intent: { kind, chatId: fixture.chatId, targetAssistantId: target.id },
        coldBodyIds: fixture.coldBodyIds,
        siblingBodyIds: fixture.siblingBodyIds,
        readableBodyIds: fixture.path.map((message) => message.id),
        expectedPath: () => [{ id: parent.id, role: 'user', text: parentText }],
      }
    }
    case 'edit-resend': {
      const chatSettings = boundedSettings()
      const oldText = 'edit excluded old question'
      const oldAnswerText = 'edit excluded old answer'
      const editedText = 'edited replacement question'
      const fixture = await seedDeepBranchedFixture(chatSettings, [
        { role: 'user', text: oldText },
        { role: 'assistant', text: oldAnswerText },
      ])
      const target = required(fixture.path.at(-2), 'edit target')
      const oldDescendant = required(fixture.path.at(-1), 'edit old descendant')
      return {
        settings: chatSettings,
        intent: {
          kind,
          chatId: fixture.chatId,
          targetUserId: target.id,
          content: [{ type: 'text', text: editedText }],
        },
        coldBodyIds: [...fixture.coldBodyIds, oldDescendant.id],
        siblingBodyIds: fixture.siblingBodyIds,
        readableBodyIds: fixture.path.map((message) => message.id),
        expectedPath: (prepared) => [
          {
            id: required(prepared.userMessageId, 'edit prepared user'),
            role: 'user',
            text: editedText,
          },
        ],
      }
    }
    case 'continue': {
      const chatSettings = boundedSettings({ continueSystemPrompt: '', continueUserPrompt: '' })
      const parentText = 'continue parent question'
      const targetText = 'continue partial answer'
      const fixture = await seedDeepBranchedFixture(chatSettings, [
        { role: 'user', text: parentText },
        { role: 'assistant', text: targetText },
      ])
      const parent = required(fixture.path.at(-2), 'continue parent')
      const target = required(fixture.path.at(-1), 'continue target')
      return {
        settings: chatSettings,
        intent: { kind, chatId: fixture.chatId, targetAssistantId: target.id },
        coldBodyIds: fixture.coldBodyIds,
        siblingBodyIds: fixture.siblingBodyIds,
        readableBodyIds: fixture.path.map((message) => message.id),
        expectedPath: () => [
          { id: parent.id, role: 'user', text: parentText },
          { id: target.id, role: 'assistant', text: targetText },
        ],
      }
    }
  }
}

async function seedDeepBranchedFixture(
  chatSettings: ChatSettings,
  tail: readonly { role: MessageRole; text: string }[],
): Promise<DeepBranchedFixture> {
  const chat = await createChat({ settings: chatSettings })
  const coldRows = Array.from({ length: 20 }, (_, pair) => [
    {
      role: 'user' as const,
      text: `cold-user-${pair}:${'u'.repeat(360)}`,
    },
    {
      role: 'assistant' as const,
      text: `cold-assistant-${pair}:${'a'.repeat(360)}`,
    },
  ]).flat()
  const path = await seedLinear(chat.id, [...coldRows, ...tail])
  const branchAnchor = required(path[5], 'branch anchor')
  const sibling = await executeMessageCommand({
    kind: 'message.insert-sibling',
    input: {
      chatId: chat.id,
      targetId: branchAnchor.id,
      role: 'assistant',
      content: [{ type: 'output_text', text: 'off-path sibling body must stay cold' }],
    },
  })
  const siblingChild = await executeMessageCommand({
    kind: 'message.append-child',
    input: {
      chatId: chat.id,
      parentMessageId: sibling.messageId,
      role: 'user',
      content: [{ type: 'text', text: 'off-path descendant body must stay cold' }],
    },
  })
  return {
    chatId: chat.id,
    path,
    coldBodyIds: path.slice(0, 8).map((message) => message.id),
    siblingBodyIds: [sibling.messageId, siblingChild.messageId],
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
    messages: rows.map(({ role, text }) => ({
      role,
      content: [
        role === 'assistant'
          ? { type: 'output_text' as const, text }
          : { type: 'text' as const, text },
      ],
    })),
  })
  return imported.presentations.map((presentation) => presentation.message)
}

async function seedBoundedModel(providerCap = PROVIDER_CAP): Promise<void> {
  await putCachedEndpoints(profile().id, MODEL, {
    id: MODEL,
    endpoints: [
      {
        provider_name: 'Test Clean',
        provider_slug: 'test-clean',
        supported_parameters: ['temperature'],
        context_length: providerCap,
        max_prompt_tokens: providerCap,
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

async function seedReconciledModel(): Promise<void> {
  await putCachedEndpoints(profile().id, MODEL, {
    id: MODEL,
    endpoints: [
      {
        provider_name: 'Tiny Cap',
        provider_slug: 'tiny-cap',
        supported_parameters: ['temperature'],
        context_length: 1,
        max_prompt_tokens: 1,
        pricing: {},
      },
      {
        provider_name: 'Large Cap',
        provider_slug: 'large-cap',
        supported_parameters: ['temperature'],
        context_length: 120_000,
        max_prompt_tokens: 120_000,
        pricing: {},
      },
    ],
  })
  await putCachedPrivacyPolicy(profile().id, MODEL, {
    policies: Object.fromEntries(
      ['Tiny Cap', 'Large Cap'].map((providerName) => [
        providerName,
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
}

async function runToCompletion(
  intent: GenerationIntent,
  openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>,
) {
  const handle = await startControlledGeneration(intent, {
    profile: profile(),
    ...(intent.kind === 'new-chat-send' ? { newChatSettings: boundedSettings() } : {}),
    keyMaterial: { 'intent-io-key': 'sk-test' },
    openStream,
  })
  const prepared = await handle.prepared
  const completed = await handle.completed
  return { prepared, completed }
}

async function* completedStream(text: string): AsyncGenerator<AssistantStreamChunk> {
  yield {
    type: 'delta',
    chunk: {
      id: 'intent-io-generation',
      model: MODEL,
      choices: [{ delta: { content: text }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
        cost: 0.01,
      },
    },
  }
}

async function* gatedCompletedStream(
  gate: Promise<void>,
  text: string,
): AsyncGenerator<AssistantStreamChunk> {
  await gate
  yield* completedStream(text)
}

function captureBodyReads(): {
  ids: MessageId[]
  batches(): readonly BodyReadBatch[]
  stop(): void
} {
  const ids: MessageId[] = []
  const transactionIds = new WeakMap<Transaction, number>()
  const batches = new Map<number, { storeNames: readonly string[]; ids: MessageId[] }>()
  let nextTransactionId = 1
  const reading = (row: MessageBodyRow | undefined): MessageBodyRow | undefined => {
    if (row) {
      ids.push(row.id)
      const transaction = Dexie.currentTransaction
      const transactionId = transactionIds.get(transaction) ?? nextTransactionId++
      transactionIds.set(transaction, transactionId)
      const storeNames = [...transaction.storeNames]
      const batch = batches.get(transactionId) ?? { storeNames, ids: [] }
      batch.ids.push(row.id)
      batches.set(transactionId, batch)
    }
    return row
  }
  getDb().messageBodies.hook('reading', reading)
  return {
    ids,
    batches: () =>
      Object.freeze(
        [...batches].map(([transaction, batch]) =>
          Object.freeze({
            transaction,
            storeNames: Object.freeze([...batch.storeNames]),
            ids: Object.freeze([...batch.ids]),
          }),
        ),
      ),
    stop: () => getDb().messageBodies.hook('reading').unsubscribe(reading),
  }
}

function countBodyReads(ids: readonly MessageId[]): Map<MessageId, number> {
  const counts = new Map<MessageId, number>()
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
  return counts
}

function emptyQueryEvidence(): QueryEvidence {
  return {
    queryKinds: [],
    branchPageStructureRows: [],
    branchPageStructureBodyIds: [],
  }
}

function markQueryEvidence(evidence: QueryEvidence): QueryEvidenceMark {
  return {
    queryKinds: evidence.queryKinds.length,
    branchPageStructureRows: evidence.branchPageStructureRows.length,
    branchPageStructureBodyIds: evidence.branchPageStructureBodyIds.length,
  }
}

function readQueryEvidenceSince(evidence: QueryEvidence, mark: QueryEvidenceMark): QueryEvidence {
  return {
    queryKinds: evidence.queryKinds.slice(mark.queryKinds),
    branchPageStructureRows: evidence.branchPageStructureRows.slice(mark.branchPageStructureRows),
    branchPageStructureBodyIds: evidence.branchPageStructureBodyIds.slice(
      mark.branchPageStructureBodyIds,
    ),
  }
}

function repositoryWithQueryEvidence(
  currentRepository: () => WorkspaceRepository,
  evidence: QueryEvidence,
): WorkspaceRepository {
  return new Proxy({} as WorkspaceRepository, {
    get(_current, property) {
      const target = currentRepository()
      if (property !== 'query') {
        const member = Reflect.get(target, property) as unknown
        return typeof member === 'function'
          ? (...args: unknown[]): unknown => Reflect.apply(member, target, args) as unknown
          : member
      }
      return async (
        permit: Parameters<WorkspaceRepository['query']>[0],
        query: WorkspaceQuery,
        options?: Parameters<WorkspaceRepository['query']>[2],
      ) => {
        evidence.queryKinds.push(query.kind)
        if (query.kind !== 'branch.page-structure') {
          return target.query(permit, query, options)
        }
        evidence.branchPageStructureRows.push(query.window.nodes.length)
        const reading = (row: MessageBodyRow | undefined): MessageBodyRow | undefined => {
          if (!row) return row
          const stores = new Set(Dexie.currentTransaction.storeNames)
          if (stores.has('workspaceFence') && stores.has('chats')) {
            evidence.branchPageStructureBodyIds.push(row.id)
          }
          return row
        }
        getDb().messageBodies.hook('reading', reading)
        try {
          return await target.query(permit, query, options)
        } finally {
          getDb().messageBodies.hook('reading').unsubscribe(reading)
        }
      }
    },
  })
}

async function classifyBodyReadBatches(
  ids: readonly MessageId[],
  batches: readonly BodyReadBatch[],
): Promise<readonly ClassifiedBodyReadBatch[]> {
  expect(countBodyReads(batches.flatMap((batch) => batch.ids))).toEqual(countBodyReads(ids))
  expect(
    batches.filter((batch) => {
      const stores = new Set(batch.storeNames)
      return (
        stores.has('workspaceFence') &&
        stores.has('chats') &&
        stores.has('messages') &&
        stores.has('messageBodies')
      )
    }),
    'branch.page-structure must never read messageBodies and branch.body-page must not return',
  ).toEqual([])
  const classified = batches.map((batch): ClassifiedBodyReadBatch => {
    const stores = new Set(batch.storeNames)
    const source =
      stores.size === 2 && stores.has('messages') && stores.has('messageBodies')
        ? 'message.presentations'
        : stores.has('messages') && stores.has('messageBodies')
          ? 'attempt-write'
          : undefined
    if (!source) {
      throw new Error(`UnexpectedMessageBodyReadTransaction:${batch.storeNames.join(',')}`)
    }
    return { ...batch, source }
  })
  for (const batch of classified) {
    if (batch.source !== 'message.presentations') continue
    expect(batch.ids.length).toBeLessThanOrEqual(PROMPT_BODY_PAGE_ROWS)
    const headers = await getDb().messages.bulkGet([...batch.ids])
    expect(headers.every((header) => header !== undefined)).toBe(true)
    expect(
      headers.reduce((sum, header) => sum + (header?.bodyTextCharCount ?? 0), 0),
    ).toBeLessThanOrEqual(PROMPT_BODY_PAGE_TEXT_CHARS)
  }
  return classified
}

function requirePreparedNewChat(value: PreparedGeneration): PreparedNewChatGeneration {
  if (!('kind' in value) || (value.kind !== 'handoff' && value.kind !== 'superseded')) {
    throw new Error('prepared new chat route delivery missing')
  }
  return value as PreparedNewChatGeneration
}

function attachmentRef(attachmentId: string): MessageAttachmentRef {
  return {
    refId: `intent-snapshot-ref:${attachmentId}`,
    attachmentId,
    includeInContext: true,
    presentation: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} missing`)
  return value
}
