// Lifecycle (text-only Phase 7):
//   1. Run a cached zero-eligible privacy preflight, then persist the user
//      message (via messages.sendUserMessage) before full request planning so
//      slow discovery/preflight still has a visible sent turn. Persist the
//      assistant placeholder (via continueAssistant-style append under the
//      user) before the fetch opens.
//   2. Compose the wire body from the active path via `send-planning`.
//   3. Open the stream through the single assistant dispatcher. Feed chunks
//      through `splitAssistantStream` into an
//      in-memory accumulator (text / reasoning / tool-calls / usage / meta).
//   4. Append stream-lane deltas to the durable `streamChunks` recovery log
//      while the visible owner tab renders from the in-memory accumulator.
//      The canonical `messageBodies` row is not rewritten on the hot path.
//   5. On stream end, write the final commit (content, reasoningDetails,
//      generation.usage/cost/finishReason/finishedAt). On error, attach
//      ApiError metadata. On user abort, attach abortReason='user'.
//
// The send function is written as a plain async function that lives outside
// React so integration tests can drive it without mounting a component. The
// `useChat` hook is a thin React wrapper that binds `streamStore` / `uiStore`
// callbacks; components call `sendText({chat, connection, ...})`.

import { useCallback, useRef } from 'react'
import {
  type AssistantDispatchPlan,
  type AssistantStreamChunk,
  openAssistantRequestStream,
} from '../api/assistant-stream'
import { type ApiError, normalizeError } from '../api/errors'
import { readCachedPrivacyPayload } from '../api/privacy-scrape'
import { normalizeEndpointsResponse } from '../api/providers'
import { chatHref, parseRoute, replaceRoute } from '../app/router'
import { activePath, cursorKeyOf } from '../core/active-path'
import { toPersistedAttemptFailure } from '../core/attempt-outcome'
import {
  createCursorOverlay,
  createExactCursorPathGuard,
  type ExactCursorPathGuard,
} from '../core/cursor-overlay'
import {
  runGenerationAttempt,
  SEND_GENERATION_ATTEMPT_ERROR_POLICY,
} from '../core/generation-attempt-runner'
import { readGlobalPreferences } from '../core/global-settings'
import { nextSiblingIndexFromChildren, sendUserMessage } from '../core/messages'
import { tokenCalibrationKey } from '../core/model-ids'
import { isFreeModel } from '../core/model-predicates'
import { buildWireProviderPrivacy, filterEndpointsByPrivacy } from '../core/privacy-filter'
import { hasEnabledHostedTools, isOpenAiDirectProfile } from '../core/provider-hosted-tools'
import {
  type AssistantRequestPlan,
  type AssistantRequestTransform,
  NoEligibleProvidersError,
  prepareAssistantRequestPlan,
} from '../core/send-planning'
import {
  createStreamAccumulator,
  projectStreamAccumulatorFinal,
  projectStreamAccumulatorLive,
  projectStreamGeneration,
  replayStreamAccumulator,
  type StreamAccumulator,
  streamAccumulatorHasCompletionCalibrationBlockers,
} from '../core/stream-accumulator'
import {
  addAcceptedSampleToGlobal,
  addSampleToChat,
  calibrationFieldsForCreate,
  deriveCompletionSample,
  derivePromptCalibrationBasis,
  derivePromptSampleFromBasis,
  type PromptCalibrationBasis,
  readTokenCalibrationGlobal,
} from '../core/token-calibration'
import type { TokenizerFamily } from '../core/tokens'
import { TreeChangedError } from '../core/tree-ops'
import type {
  AbortReason,
  AttachmentRef,
  CapabilityDescriptor,
  Chat,
  ChatId,
  ChatSettings,
  ChatUsage,
  ConnectionProfile,
  ContentItem,
  FinishReason,
  GenerationMeta,
  Message,
  MessageId,
  ProviderOutputItem,
} from '../core/types'
import { logStreamDebug, streamDebugEnabled } from '../lib/debug-streams'
import { newId } from '../lib/ulid'
import { attachmentScopes } from '../store/attachments'
import { getChat } from '../store/chats'
import type { ConnectionRuntimeKeyCandidate } from '../store/connection-runtime'
import { recoverStaleContinuationAttempts } from '../store/continuation-recovery'
import {
  type GeneratedOutputDownloader,
  mergeGeneratedImageAttachmentRefs,
  persistPreparedGeneratedOutputAttachments,
  prepareGeneratedOutputAttachments,
} from '../store/generated-images'
import { ENDPOINTS_TTL_MS, getCachedEndpoints, isFresh } from '../store/models-cache'
import { getCachedPrivacyPolicy } from '../store/privacy-cache'
import { flushPendingPromptSettingSaves } from '../store/prompt-presets'
import {
  ExpectedLeafChangedError,
  type MessageHeaderPatch,
  type StreamLeaseRow,
  type StreamWriteFence,
} from '../store/repository'
import {
  appendSendContextGuardMessage,
  assertSendContextFresh,
  assertSendContextGuardInMutation,
  createSendContextGuard,
  loadActiveBranchHeaderSnapshot,
  loadBranchHeaderSnapshotByLeaf,
  loadChatHeaderSnapshot,
  loadSendContextForBranch,
  type SendContextGuard,
} from '../store/send-context'
import { createStreamChunkWriter } from '../store/stream-chunk-writer'
import {
  announceStreamEnded,
  getStreamClientId,
  isFreshStreamLease,
  isRecoveryClaimedStreamLease,
  STREAM_LEASE_TTL_MS,
  streamOwnershipLocksSupported,
  streamWriteFenceForLease,
  withStreamRecoveryLocks,
} from '../store/stream-leases'
import { getWorkspaceRepository } from '../store/workspace-repository'
import { announceGenerationOutcome } from '../store/zustand/announcementStore'
import type { NavigationIntent } from '../store/zustand/chatStore'
import { useChatStore } from '../store/zustand/chatStore'
import { clearLiveSnapshotIfPresent, useStreamStore } from '../store/zustand/streamStore'
import { useUiStore } from '../store/zustand/uiStore'
import { markLifecycleTarget, startRequestLifecycle } from './requestLifecycle'

const retainedRequestPlansForTests = import.meta.env.DEV
  ? new Set<AssistantRequestPlan>()
  : undefined
const ORPHAN_RECOVERY_RETRY_MS = 2_000

export function __retainedSendRequestPlanCountForTests(): number | undefined {
  return retainedRequestPlansForTests?.size
}

function pendingPrefillMessage(input: {
  chatId: ChatId
  parentId: MessageId | null
  siblingIndex: number
  content: ContentItem[]
  createdAt: number
  messageId: MessageId
  turnId: string
}): Message {
  return {
    id: input.messageId,
    chatId: input.chatId,
    parentId: input.parentId,
    siblingIndex: input.siblingIndex,
    turnId: input.turnId,
    turnIndex: 1,
    createdAt: input.createdAt,
    role: 'assistant',
    origin: 'prefill',
    content: input.content,
    nodeVersion: 0,
    deleted: false,
  }
}

function throwWithZeroEligibleUi(chatId: ChatId, err: unknown): never {
  if (err instanceof NoEligibleProvidersError) {
    useUiStore.getState().setZeroEligibleChatId(chatId)
  }
  throw err
}

async function throwIfCachedPrivacyPreflightZeroEligible(input: {
  chat: Chat
  connection: ConnectionProfile
}): Promise<void> {
  const { chat, connection } = input
  if (
    connection.kind !== 'openrouter' ||
    !chat.settings.model ||
    isFreeModel(chat.settings.model)
  ) {
    return
  }
  const endpointsRow = await getCachedEndpoints(connection.id, chat.settings.model)
  if (!endpointsRow || !isFresh(endpointsRow.fetchedAt, ENDPOINTS_TTL_MS)) return
  const descriptor = normalizeEndpointsResponse(endpointsRow.payload)
  const endpoints = descriptor?.endpoints ?? []
  if (endpoints.length === 0) return

  const privacyRow = await getCachedPrivacyPolicy(connection.id, chat.settings.model)
  const cachedPayload = privacyRow ? readCachedPrivacyPayload(privacyRow.payload) : null
  const policies = cachedPayload?.policies ?? {}
  const hasCachedPolicies = Object.keys(policies).length > 0
  if (!hasCachedPolicies && endpoints.some((endpoint) => !endpoint.data_policy)) return

  const filter = filterEndpointsByPrivacy({
    model: chat.settings.model,
    endpoints,
    policies,
    privacy: chat.settings.privacy,
  })
  const prefs = chat.settings.providerPrefs
  const wire = buildWireProviderPrivacy(filter, chat.settings.privacy, {
    userTouchedPicker: prefs?.ignoreOverridesFilter === true,
    ...(prefs?.ignore ? { existingIgnore: prefs.ignore } : {}),
    ...(prefs?.only ? { existingOnly: prefs.only } : {}),
    ...(prefs?.order ? { existingOrder: prefs.order } : {}),
  })
  if (wire.zeroEligible) throwWithZeroEligibleUi(chat.id, new NoEligibleProvidersError())
}

type ChatAccumulator = StreamAccumulator

interface SendTextInput {
  chatId: ChatId
  // `undefined` means this invocation is an active-view action and may claim
  // this tab's branch authority. `null` is an explicit detached/background
  // send: persist and stream normally, but never steer this tab's cursor/URL.
  navigationIntent?: NavigationIntent | null
  expectedLeafId?: MessageId | null
  connection: ConnectionProfile
  apiKey: string
  apiKeyCandidates?: readonly ConnectionRuntimeKeyCandidate[]
  content: ContentItem[]
  attachmentRefs?: AttachmentRef[]
  capabilities?: CapabilityDescriptor
  transform?: AssistantRequestTransform
  // Injection seam for integration tests that want to mock the stream
  // generator instead of `fetch`. The default opens a real chat-completions
  // call; tests pass a replacement iterable.
  openStream?: (input: OpenStreamInput) => AsyncIterable<OpenStreamChunk>
  signal?: AbortSignal
  now?: () => number
  // Optional assistant-prefill content. The request planner sees it as a
  // trailing assistant input, while storage creates one generated assistant
  // row initialized with this content and appends streamed continuation
  // tokens into that same row.
  prefillContent?: ContentItem[]
}

// "Open an assistant stream under an existing user (or other) message."
// Used by edit-then-send (the user sibling already exists; only a
// fresh assistant reply is needed) and regenerate-after-branch flows. No user
// message is created here. `prefillContent` (inherited from SendTextInput)
// is honored by adding a trailing assistant input to the request plan and
// initializing the generated assistant row with that text.
interface SendFromMessageInput extends Omit<SendTextInput, 'content'> {
  // Any existing message on the active path; the assistant placeholder
  // will be created as its child. Typically a user-role message.
  parentMessageId: MessageId
  regenerateTargetMessageId?: MessageId
}

function assertRegenerateTargetAvailable(
  target: Pick<Message, 'chatId' | 'parentId' | 'deleted'> | undefined,
  input: Pick<SendFromMessageInput, 'chatId' | 'parentMessageId' | 'regenerateTargetMessageId'>,
): void {
  const targetId = input.regenerateTargetMessageId
  if (targetId === undefined) return
  if (
    !target ||
    target.chatId !== input.chatId ||
    target.deleted ||
    target.parentId !== input.parentMessageId
  ) {
    throw new TreeChangedError(input.chatId, `regenerate target ${targetId} unavailable`)
  }
}

interface OpenStreamInput {
  connection: ConnectionProfile
  apiKey: string
  wireBody: Record<string, unknown>
  signal: AbortSignal
  route?: AssistantRequestPlan['route']
  geminiModelId?: string
}

type OpenStreamChunk = AssistantStreamChunk

function devOnlyOpenStreamOverride(
  openStream: SendTextInput['openStream'],
): SendTextInput['openStream'] {
  if (!openStream) return undefined
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV !== true) {
    throw new Error('openStream override is dev-only; production sends must use assistant-stream')
  }
  return openStream
}

function replaceActiveChatMessageRoute(chatId: ChatId, messageId: MessageId): void {
  if (typeof window === 'undefined') return
  const route = parseRoute(window.location.hash)
  if (route.kind !== 'chat' || route.chatId !== chatId) return
  replaceRoute(chatHref(chatId, messageId))
}

export interface SendTextResult {
  streamId: string
  userMessageId: MessageId
  assistantMessageId: MessageId
  outcome: 'done' | 'error' | 'abort'
  finishReason?: FinishReason
  error?: ApiError
}

// Public entry used by the hook + integration tests. Opens a stream, persists
// results, and resolves with the outcome. Never throws for normal upstream
// errors (they land in `result.error`); only programming errors (missing chat
// id, invalid invariants) throw.
export async function sendText(input: SendTextInput): Promise<SendTextResult> {
  const now = input.now ?? Date.now
  const navigationIntent =
    input.navigationIntent === undefined
      ? useChatStore.getState().beginNavigationIntent(input.chatId)
      : input.navigationIntent
  const cursorAtSubmit = useChatStore.getState().getCursor(input.chatId) ?? {}
  const expectedLeafId =
    input.expectedLeafId !== undefined
      ? input.expectedLeafId
      : ((await loadActiveBranchHeaderSnapshot(input.chatId, cursorAtSubmit)).branchHeaders.at(-1)
          ?.id ?? null)
  const lifecycle = await startRequestLifecycle({
    chatId: input.chatId,
    streamId: newId(),
    attemptKind: 'generation',
    ...(input.signal ? { userSignal: input.signal } : {}),
  })
  try {
    await flushPendingPromptSettingSaves(input.chatId)
    let chat: Chat | null | undefined = await getChat(input.chatId)
    if (!chat) throw new Error(`sendText: chat not found: ${input.chatId}`)

    const createdAt = now()
    const userMessageId = newId()
    const userTurnId = newId()
    const skipTurnCalibration = settingsMayRequestTools(input.connection, chat.settings)
    await throwIfCachedPrivacyPreflightZeroEligible({ chat, connection: input.connection })
    const userMsg = await sendUserMessage({
      chatId: input.chatId,
      expectedLeafId,
      content: input.content,
      ...(input.attachmentRefs ? { attachmentRefs: input.attachmentRefs } : {}),
      now: createdAt,
      messageId: userMessageId,
      turnId: userTurnId,
      ...(skipTurnCalibration ? { skipCalibration: true } : {}),
    })
    chat = null

    let branchSnapshot: Awaited<ReturnType<typeof loadBranchHeaderSnapshotByLeaf>> | undefined =
      await loadBranchHeaderSnapshotByLeaf(input.chatId, userMsg.messageId)
    let planningChat: Chat | undefined = branchSnapshot.chat
    const branchHeaders = branchSnapshot.branchHeaders
    if (branchHeaders.at(-1)?.id !== userMsg.messageId) {
      throw new ExpectedLeafChangedError(input.chatId, userMsg.messageId, 'missing')
    }
    const sendContextGuard = createSendContextGuard(planningChat, branchHeaders)
    const targetPathSelections = branchHeaders.map(
      (header) => [cursorKeyOf(header.parentId), header.id] as const,
    )
    if (navigationIntent) {
      useChatStore.getState().selectPathForIntent(
        input.chatId,
        navigationIntent,
        Object.fromEntries(targetPathSelections),
        branchHeaders.map((header) => header.id),
      )
    }
    branchSnapshot = undefined
    const hasPrefill = (input.prefillContent?.length ?? 0) > 0
    const prefillMessageId = hasPrefill ? newId() : null
    const pendingPrefill = hasPrefill
      ? pendingPrefillMessage({
          chatId: input.chatId,
          parentId: userMsg.messageId,
          siblingIndex: 0,
          content: input.prefillContent ?? [],
          createdAt,
          messageId: prefillMessageId as MessageId,
          turnId: userTurnId,
        })
      : null
    let sendContext: Awaited<ReturnType<typeof loadSendContextForBranch>> | undefined =
      await loadSendContextForBranch({
        chat: planningChat,
        branchHeaders,
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        pendingMessages: pendingPrefill ? [pendingPrefill] : [],
      })
    let plannedPath = sendContext.pathMessages
    let requestPlan: AssistantRequestPlan
    try {
      requestPlan = (
        await prepareAssistantRequestPlan({
          chat: planningChat,
          connection: input.connection,
          pathMessages: plannedPath,
          preCutAttachmentIds: sendContext.preCutAttachmentIds,
          draftText: '',
          debugSource: 'send',
          ...(input.capabilities ? { capabilities: input.capabilities } : {}),
          ...(input.transform ? { transform: input.transform } : {}),
          signal: lifecycle.signal,
        })
      ).requestPlan
    } catch (err) {
      throwWithZeroEligibleUi(input.chatId, err)
    }
    if (lifecycle.signal.aborted) throw new DOMException('Request aborted.', 'AbortError')

    retainedRequestPlansForTests?.add(requestPlan)
    const requested = openAssistantStreamUnder({
      ...input,
      signal: lifecycle.signal,
      lifecycleAbort: lifecycle.abort,
      lifecyclePreserveLease: lifecycle.preserveLease,
      lifecycleReplacementEpoch: lifecycle.replacementEpoch,
      streamId: lifecycle.streamId,
      parentMessageId: userMsg.messageId,
      userMessageId: userMsg.messageId,
      requireEmptyParent: true,
      sendContextGuard,
      navigationIntent,
      targetPathSelections,
      ...(hasPrefill ? { initialAssistantContent: input.prefillContent ?? [] } : {}),
      requestPlan,
    })
    retainedRequestPlansForTests?.delete(requestPlan)
    requestPlan = undefined as never
    plannedPath = []
    sendContext = undefined
    planningChat = undefined
    return await requested
  } finally {
    await lifecycle.end(lifecycle.signal.aborted ? 'abort' : 'error')
  }
}

// Edit-then-send / resend-from-existing-user entrypoint. The caller has
// already created the user sibling (e.g. via `insertSibling` with
// role:'user', origin:'user'); all that's left is to attach an assistant
// placeholder under it and stream the reply. No user message is created.
export async function sendFromMessage(input: SendFromMessageInput): Promise<SendTextResult> {
  const navigationIntent =
    input.navigationIntent === undefined
      ? useChatStore.getState().beginNavigationIntent(input.chatId)
      : input.navigationIntent
  const lifecycle = await startRequestLifecycle({
    chatId: input.chatId,
    streamId: newId(),
    attemptKind: 'generation',
    ...(input.signal ? { userSignal: input.signal } : {}),
  })
  try {
    let headerSnapshot: Awaited<ReturnType<typeof loadChatHeaderSnapshot>> | undefined =
      await loadChatHeaderSnapshot(input.chatId)
    let chat: Chat | undefined = headerSnapshot.chat
    const allHeaders = headerSnapshot.allHeaders
    headerSnapshot = undefined
    const byId = new Map(allHeaders.map((header) => [header.id, header]))
    const parent = byId.get(input.parentMessageId)
    if (!parent || parent.chatId !== input.chatId || parent.deleted) {
      throw new Error(`sendFrom: parent ${input.parentMessageId} unavailable`)
    }
    assertRegenerateTargetAvailable(
      input.regenerateTargetMessageId !== undefined
        ? byId.get(input.regenerateTargetMessageId)
        : undefined,
      input,
    )
    const baseCursor = useChatStore.getState().getCursor(input.chatId) ?? {}
    const cursor = createCursorOverlay(baseCursor)
    let cur: (typeof allHeaders)[number] | undefined = parent
    while (cur) {
      cursor[cursorKeyOf(cur.parentId)] = cur.id
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    const branchHeaders = activePath(allHeaders as unknown as Message[], cursor).map(
      (message) => message as unknown as (typeof allHeaders)[number],
    )
    const parentIdx = branchHeaders.findIndex((m) => m.id === parent.id)
    const rawOutboundHeaders =
      parentIdx >= 0 ? branchHeaders.slice(0, parentIdx + 1) : branchHeaders
    const sendContextGuard = createSendContextGuard(chat, rawOutboundHeaders)
    const hasPrefill = (input.prefillContent?.length ?? 0) > 0
    const prefillMessageId = hasPrefill ? newId() : null
    const createdAt = (input.now ?? Date.now)()
    const pendingPrefill =
      hasPrefill && prefillMessageId
        ? pendingPrefillMessage({
            chatId: input.chatId,
            parentId: input.parentMessageId,
            siblingIndex: 0,
            content: input.prefillContent ?? [],
            createdAt,
            messageId: prefillMessageId,
            turnId: parent.turnId,
          })
        : null
    let sendContext: Awaited<ReturnType<typeof loadSendContextForBranch>> | undefined =
      await loadSendContextForBranch({
        chat,
        branchHeaders: rawOutboundHeaders,
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        pendingMessages: pendingPrefill ? [pendingPrefill] : [],
      })
    let plannedPath = sendContext.pathMessages
    let requestPlan: AssistantRequestPlan
    try {
      requestPlan = (
        await prepareAssistantRequestPlan({
          chat,
          connection: input.connection,
          pathMessages: plannedPath,
          preCutAttachmentIds: sendContext.preCutAttachmentIds,
          draftText: '',
          debugSource: 'send-from-message',
          ...(input.capabilities ? { capabilities: input.capabilities } : {}),
          ...(input.transform ? { transform: input.transform } : {}),
          signal: lifecycle.signal,
        })
      ).requestPlan
    } catch (err) {
      throwWithZeroEligibleUi(input.chatId, err)
    }
    if (lifecycle.signal.aborted) throw new DOMException('Request aborted.', 'AbortError')

    retainedRequestPlansForTests?.add(requestPlan)
    const requested = openAssistantStreamUnder({
      ...input,
      signal: lifecycle.signal,
      lifecycleAbort: lifecycle.abort,
      lifecyclePreserveLease: lifecycle.preserveLease,
      lifecycleReplacementEpoch: lifecycle.replacementEpoch,
      streamId: lifecycle.streamId,
      parentMessageId: input.parentMessageId,
      userMessageId: input.parentMessageId,
      sendContextGuard,
      navigationIntent,
      targetPathSelections: rawOutboundHeaders.map(
        (header) => [cursorKeyOf(header.parentId), header.id] as const,
      ),
      ...(hasPrefill ? { initialAssistantContent: input.prefillContent ?? [] } : {}),
      requestPlan,
    })
    retainedRequestPlansForTests?.delete(requestPlan)
    requestPlan = undefined as never
    plannedPath = []
    sendContext = undefined
    chat = undefined
    return await requested
  } finally {
    await lifecycle.end(lifecycle.signal.aborted ? 'abort' : 'error')
  }
}

async function openAssistantStreamUnder(
  input: SendFromMessageInput & {
    userMessageId: MessageId
    requestPlan: AssistantRequestPlan
    sendContextGuard: SendContextGuard
    navigationIntent: NavigationIntent | null
    targetPathSelections: ReadonlyArray<readonly [string, MessageId]>
    streamId?: string
    initialAssistantContent?: ContentItem[]
    signal: AbortSignal
    lifecycleAbort: () => void
    lifecyclePreserveLease: () => void
    lifecycleReplacementEpoch: number
    requireEmptyParent?: boolean
  },
): Promise<SendTextResult> {
  const now = input.now ?? Date.now
  const repo = getWorkspaceRepository()
  const {
    requestModel,
    useTextProtocol,
    route,
    resolvedApiUsed,
    requestedModel,
    geminiModelId,
    outboundTokenizer,
    dispatchPlan,
    delivery,
    outboundRetention,
  } = consumeAssistantRequestPlan(input)
  const initialAssistantContent = input.initialAssistantContent ?? []
  const initialStoredContent = assistantContentWithStreamPrefix(initialAssistantContent, '')

  const assistantId = newId()
  const targetPathSelections = [
    ...input.targetPathSelections,
    [cursorKeyOf(input.parentMessageId), assistantId] as const,
  ]
  await repo.runMutation(
    [
      { kind: 'chat-meta', chatId: input.chatId },
      ...input.sendContextGuard.messageRevisions.map((revision) => ({
        kind: 'message' as const,
        messageId: revision.id,
      })),
      ...(input.regenerateTargetMessageId !== undefined
        ? [{ kind: 'message' as const, messageId: input.regenerateTargetMessageId }]
        : []),
      { kind: 'message', messageId: assistantId },
      { kind: 'children', chatId: input.chatId, parentId: input.parentMessageId },
    ],
    async (ctx) => {
      await assertSendContextGuardInMutation(ctx, input.sendContextGuard)
      const currentParent = await ctx.getMessageHeader(input.parentMessageId)
      if (!currentParent || currentParent.chatId !== input.chatId || currentParent.deleted) {
        throw new Error(`sendText: parent ${input.parentMessageId} unavailable`)
      }
      const regenerateTarget =
        input.regenerateTargetMessageId !== undefined
          ? await ctx.getMessageHeader(input.regenerateTargetMessageId)
          : undefined
      assertRegenerateTargetAvailable(regenerateTarget, input)
      const siblings = await ctx.listChildHeaders(input.chatId, input.parentMessageId)
      const blockingChild = input.requireEmptyParent
        ? siblings.find((header) => !header.deleted)
        : undefined
      if (blockingChild) {
        throw new ExpectedLeafChangedError(
          input.chatId,
          input.parentMessageId,
          'has-live-child',
          blockingChild.id,
        )
      }
      await ctx.putMessage({
        id: assistantId,
        chatId: input.chatId,
        parentId: input.parentMessageId,
        siblingIndex: nextSiblingIndexFromChildren(siblings),
        turnId: newId(),
        turnIndex: 0,
        createdAt: now(),
        role: 'assistant',
        origin: 'generated',
        content: structuredClone(initialStoredContent),
        nodeVersion: 0,
        deleted: false,
        generation: {
          id: '',
          model: requestModel,
          requestedModel,
          apiUsed: resolvedApiUsed,
          delivery,
          status: 'streaming',
          integrity: 'clean',
          costSource: 'stream',
          startedAt: now(),
        },
      })
    },
  )
  const dispatchGuard = appendSendContextGuardMessage(input.sendContextGuard, {
    id: assistantId,
    chatId: input.chatId,
    parentId: input.parentMessageId,
    nodeVersion: 0,
    deleted: false,
  })

  const selected = input.navigationIntent
    ? useChatStore.getState().selectPathForIntent(
        input.chatId,
        input.navigationIntent,
        Object.fromEntries(targetPathSelections),
        targetPathSelections.map(([, messageId]) => messageId),
      )
    : false
  if (selected) {
    replaceActiveChatMessageRoute(input.chatId, assistantId)
  }

  const streamId = input.streamId ?? newId()
  const debugScope = `send:${streamId}`
  let streamFence: Awaited<ReturnType<typeof markLifecycleTarget>>
  try {
    streamFence = await markLifecycleTarget({
      chatId: input.chatId,
      streamId,
      messageId: assistantId,
      abort: input.lifecycleAbort,
      attemptKind: 'generation',
      replacementEpoch: input.lifecycleReplacementEpoch,
    })
  } catch (error) {
    const storageError = normalizeError(error, { midStream: false, cause: 'storage' })
    await repo.runMutation([{ kind: 'message', messageId: assistantId }], async (ctx) => {
      const current = await ctx.getMessageHeader(assistantId)
      if (!current?.generation || current.generation.finishedAt !== undefined) return
      await ctx.patchMessageBody(
        assistantId,
        {},
        {
          headerPatch: {
            generation: {
              ...current.generation,
              status: 'error',
              finishedAt: now(),
              error: toPersistedAttemptFailure(storageError, 'storage'),
            },
          },
        },
      )
    })
    throw storageError
  }

  const accumulator = createStreamAccumulator({
    initialContent: initialAssistantContent,
    now: now(),
  })

  if (streamDebugEnabled(input.connection)) {
    logStreamDebug(debugScope, 'send.open', {
      streamId,
      requestedModel,
      connection: {
        id: input.connection.id,
        name: input.connection.name,
        kind: input.connection.kind,
        baseUrl: input.connection.baseUrl,
      },
      chatSettingsModel: requestModel,
      useTextProtocol,
      route,
      wireBody: dispatchPlan.wire,
    })
  }

  const openStream =
    devOnlyOpenStreamOverride(input.openStream) ??
    ((open) =>
      openAssistantRequestStream({
        connection: open.connection,
        apiKey: open.apiKey,
        ...(input.apiKeyCandidates ? { apiKeyCandidates: input.apiKeyCandidates } : {}),
        onKeyCandidateSelected: (_candidate, _candidateIndex, apiKey) => {
          selectedApiKey = apiKey
        },
        requestPlan: dispatchPlan,
        signal: open.signal,
      }))

  const journal = createStreamChunkWriter({
    port: repo,
    chatId: input.chatId,
    streamId,
    messageId: assistantId,
    now: now(),
    fence: streamFence,
  })
  let selectedApiKey = input.apiKey
  let canonicalFinalized = false
  const livePathGuard = createExactCursorPathGuard(targetPathSelections)
  const attempt = await runGenerationAttempt({
    open: () => {
      const source = openStream({
        connection: input.connection,
        apiKey: selectedApiKey,
        wireBody: dispatchPlan.wire,
        signal: input.signal,
        ...(route ? { route } : {}),
        ...(geminiModelId ? { geminiModelId } : {}),
      })
      dispatchPlan.wire = {}
      return source
    },
    beforeDispatch: () => assertSendContextFresh(dispatchGuard),
    ...(route?.transport !== undefined ? { transportHint: route.transport } : {}),
    accumulator,
    journal,
    errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
    now,
    isAborted: () => input.signal.aborted,
    prepareLive: ({ accumulator: current, now: publishedAt }) =>
      prepareLiveSnapshot({
        chatId: input.chatId,
        streamId,
        messageId: assistantId,
        pathGuard: livePathGuard,
        replacementEpoch: streamFence.replacementEpoch,
        accumulator: current,
        requestedModel,
        apiUsed: resolvedApiUsed,
        now: publishedAt,
      }),
    finalize: async (result) => {
      const completionCalibrationBlocked =
        streamAccumulatorHasCompletionCalibrationBlockers(accumulator)
      const promptCalibrationBlocked =
        outboundRetention.promptCalibrationBlocked || completionCalibrationBlocked
      const promptCalibrationAllowed = !promptCalibrationBlocked
      const completionCalibrationAllowed = !completionCalibrationBlocked
      const calibrationInputs =
        promptCalibrationAllowed || completionCalibrationAllowed
          ? {
              promptBasis: outboundRetention.promptBasis,
              modelId: requestModel,
              family: outboundTokenizer,
              promptCalibrationAllowed,
              completionCalibrationAllowed,
            }
          : undefined
      await finalize({
        repo,
        chatId: input.chatId,
        streamId,
        messageId: assistantId,
        streamFence,
        connection: input.connection,
        apiKey: selectedApiKey,
        signal: input.signal,
        accumulator,
        requestedModel,
        apiUsed: resolvedApiUsed,
        outcome: result.outcome,
        ...(result.abortReason ? { abortReason: result.abortReason } : {}),
        ...(result.error ? { error: result.error } : {}),
        now: now(),
        ...(calibrationInputs ? { calibrationInputs } : {}),
        ...(streamDebugEnabled(input.connection) ? { debugScope } : {}),
      })
      canonicalFinalized = true
    },
    cleanupJournal: () => repo.deleteStreamChunks(streamId, streamFence),
    cleanup: (result) => {
      if (result.journalCleanupPending) input.lifecyclePreserveLease()
      announceGenerationOutcome(streamId, result.outcome)
      announceStreamEnded({
        chatId: input.chatId,
        streamId,
        messageId: assistantId,
        outcome: result.outcome,
        replacementEpoch: streamFence.replacementEpoch,
      })
    },
  }).catch((err) => {
    if (!canonicalFinalized) input.lifecyclePreserveLease()
    throw err
  })

  const result: SendTextResult = {
    streamId,
    userMessageId: input.userMessageId,
    assistantMessageId: assistantId,
    outcome: attempt.outcome,
  }
  if (attempt.finishReason) result.finishReason = attempt.finishReason as FinishReason
  if (attempt.error) result.error = attempt.error
  return result
}

const HOSTED_SERVER_TOOL_ITEM_TYPES = new Set<string>([
  'web_search_call',
  'file_search_call',
  'image_generation_call',
  'code_interpreter_call',
  'shell_call',
  'shell_call_output',
  'computer_call',
  'mcp_tool_call',
  'mcp_call',
  'google:google_search',
  'google:url_context',
  'google:code_execution',
  'google:google_maps',
  'openrouter:datetime',
  'openrouter:web_fetch',
  'openrouter:web_search',
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'advisor_tool_result',
])

function requestHasTools(wire: unknown): boolean {
  if (!wire || typeof wire !== 'object') return false
  const tools = (wire as { tools?: unknown }).tools
  return Array.isArray(tools) && tools.length > 0
}

function consumeOutboundPath(requestPlan: AssistantRequestPlan): {
  promptBasis: PromptCalibrationBasis | null
  promptCalibrationBlocked: boolean
} {
  const outboundPath = requestPlan.outboundPath
  const hasNonTextOutbound = outboundPath.some((message) =>
    message.content.some(isNonTextContentItem),
  )
  const promptBasis = derivePromptCalibrationBasis({
    sentPath: outboundPath,
    systemPrompt: requestPlan.settings.systemPrompt,
    family: requestPlan.outboundTokenizer,
    mediaTokens: requestPlan.hasAttachmentContext ? 1 : 0,
    reasoningEchoOpts: requestPlan.outboundReasoningOpts,
  })
  const promptCalibrationBlocked =
    requestPlan.hasAttachmentContext ||
    hasNonTextOutbound ||
    requestHasTools(requestPlan.wire) ||
    pathHasToolArtifacts(outboundPath)
  requestPlan.outboundPath = []
  return { promptBasis, promptCalibrationBlocked }
}

function consumeAssistantRequestPlan(input: { requestPlan: AssistantRequestPlan }): {
  requestModel: string
  useTextProtocol: boolean
  route: AssistantRequestPlan['route']
  resolvedApiUsed: AssistantRequestPlan['apiUsed']
  requestedModel: string
  geminiModelId: string | undefined
  outboundTokenizer: TokenizerFamily
  dispatchPlan: AssistantDispatchPlan
  delivery: 'buffered' | 'streaming'
  outboundRetention: ReturnType<typeof consumeOutboundPath>
} {
  const requestPlan = input.requestPlan
  input.requestPlan = undefined as never
  const dispatchPlan: AssistantDispatchPlan = {
    useTextProtocol: requestPlan.useTextProtocol,
    route: requestPlan.route,
    requestedModel: requestPlan.requestedModel,
    wire: requestPlan.wire,
    ...(requestPlan.geminiModelId ? { geminiModelId: requestPlan.geminiModelId } : {}),
  }
  const delivery =
    requestPlan.route?.transport === 'openai-responses' && dispatchPlan.wire.stream !== true
      ? 'buffered'
      : 'streaming'
  const outboundRetention = consumeOutboundPath(requestPlan)
  requestPlan.wire = {}
  return {
    requestModel: requestPlan.settings.model,
    useTextProtocol: requestPlan.useTextProtocol,
    route: requestPlan.route,
    resolvedApiUsed: requestPlan.apiUsed,
    requestedModel: requestPlan.requestedModel,
    geminiModelId: requestPlan.geminiModelId,
    outboundTokenizer: requestPlan.outboundTokenizer,
    dispatchPlan,
    delivery,
    outboundRetention,
  }
}

function settingsMayRequestTools(connection: ConnectionProfile, settings: ChatSettings): boolean {
  if (settings.enabledToolIds.length > 0) return true
  if (connection.kind === 'openrouter') return hasEnabledHostedTools(settings, 'openrouter')
  if (isOpenAiDirectProfile(connection)) return hasEnabledHostedTools(settings, 'openai')
  if (connection.kind === 'google' && settings.api !== 'chat') {
    return hasEnabledHostedTools(settings, 'google')
  }
  if (connection.kind === 'anthropic' && settings.api !== 'chat') {
    return hasEnabledHostedTools(settings, 'anthropic')
  }
  return false
}

function providerOutputItemHasToolArtifact(item: ProviderOutputItem): boolean {
  return HOSTED_SERVER_TOOL_ITEM_TYPES.has(item.type) || item.type.endsWith('_tool_result')
}

function messageHasToolArtifacts(message: Message): boolean {
  if (message.role === 'tool') return true
  if ((message.toolCalls?.length ?? 0) > 0) return true
  if ((message.generation?.serverTools?.length ?? 0) > 0) return true
  if (message.providerOutputItems?.some(providerOutputItemHasToolArtifact)) return true
  if (message.reasoningDetails?.some((detail) => detail.id?.startsWith('tool_'))) return true
  return false
}

function pathHasToolArtifacts(path: readonly Message[]): boolean {
  return path.some(messageHasToolArtifacts)
}

function prepareLiveSnapshot(ctx: {
  chatId: ChatId
  streamId: string
  messageId: MessageId
  pathGuard: ExactCursorPathGuard
  replacementEpoch: number
  accumulator: ChatAccumulator
  requestedModel: string
  apiUsed: GenerationMeta['apiUsed']
  now: number
}): (() => void) | undefined {
  if (useUiStore.getState().activeChatId !== ctx.chatId) {
    clearLiveSnapshotIfPresent(ctx.messageId, ctx.streamId, ctx.replacementEpoch)
    return undefined
  }
  const preparedCursor = useChatStore.getState().getCursor(ctx.chatId)
  if (!ctx.pathGuard.matches(preparedCursor)) {
    clearLiveSnapshotIfPresent(ctx.messageId, ctx.streamId, ctx.replacementEpoch)
    return undefined
  }
  const projection = projectStreamAccumulatorLive(ctx.accumulator, {
    requestedModel: ctx.requestedModel,
    apiUsed: ctx.apiUsed,
    now: ctx.now,
  })
  return () => {
    if (useUiStore.getState().activeChatId !== ctx.chatId) {
      clearLiveSnapshotIfPresent(ctx.messageId, ctx.streamId, ctx.replacementEpoch)
      return
    }
    const cursor = useChatStore.getState().getCursor(ctx.chatId)
    if (!ctx.pathGuard.matches(cursor)) {
      clearLiveSnapshotIfPresent(ctx.messageId, ctx.streamId, ctx.replacementEpoch)
      return
    }
    useStreamStore.getState().setLiveSnapshot({
      streamId: ctx.streamId,
      chatId: ctx.chatId,
      messageId: ctx.messageId,
      replacementEpoch: ctx.replacementEpoch,
      ...projection,
    })
  }
}

function assistantContentWithStreamPrefix(
  initialContent: readonly ContentItem[],
  streamedText: string,
  generatedContent: readonly ContentItem[] = [],
): ContentItem[] {
  const prefix = initialContent
    .filter(
      (item): item is Extract<ContentItem, { type: 'text' | 'output_text' }> =>
        item.type === 'text' || item.type === 'output_text',
    )
    .map((item) => item.text)
    .join('')
  const nonText = initialContent.filter(
    (item) => item.type !== 'text' && item.type !== 'output_text',
  )
  const text = prefix.length > 0 ? `${prefix}${streamedText}` : streamedText
  return [
    { type: 'output_text', text },
    ...structuredClone(nonText),
    ...structuredClone(generatedContent),
  ]
}

interface FlushContext {
  repo: ReturnType<typeof getWorkspaceRepository>
  chatId: ChatId
  streamId: string
  messageId: MessageId
  accumulator: ChatAccumulator
  requestedModel: string
  apiUsed: GenerationMeta['apiUsed']
}

interface FinalizeContext extends FlushContext {
  streamFence: StreamWriteFence
  connection: ConnectionProfile
  apiKey: string
  signal: AbortSignal
  outcome: 'done' | 'error' | 'abort'
  abortReason?: AbortReason
  error?: ApiError
  now: number
  debugScope?: string
  // Token-calibration inputs — present when the send can produce a
  // calibration sample on success. When omitted, calibration is skipped
  // (e.g., text-protocol / llama-server, where usage is not returned).
  calibrationInputs?: {
    promptBasis: PromptCalibrationBasis | null
    modelId: string
    family: TokenizerFamily
    promptCalibrationAllowed: boolean
    completionCalibrationAllowed: boolean
  }
}

function generatedOutputDownloader(input: {
  connection: ConnectionProfile
  apiKey: string
  signal: AbortSignal
}): GeneratedOutputDownloader {
  return async ({ url }) => {
    const headers: Record<string, string> = {}
    if (shouldAuthorizeGeneratedOutputUrl(url, input.connection)) {
      headers.Authorization = `Bearer ${input.apiKey}`
    }
    const response = await fetch(url, { headers, signal: input.signal })
    if (!response.ok) return null
    return response.blob()
  }
}

function shouldAuthorizeGeneratedOutputUrl(url: string, connection: ConnectionProfile): boolean {
  if (connection.kind !== 'openrouter') return false
  let target: URL
  let base: URL
  try {
    target = new URL(url)
    base = new URL(connection.baseUrl)
  } catch {
    return false
  }
  if (target.origin !== base.origin) return false
  const basePath = base.pathname.replace(/\/+$/u, '')
  return target.pathname.startsWith(`${basePath}/videos/`)
}

async function finalize(ctx: FinalizeContext): Promise<void> {
  const {
    repo,
    chatId,
    messageId,
    accumulator,
    requestedModel,
    apiUsed,
    outcome,
    abortReason,
    error,
    now,
    calibrationInputs,
    debugScope,
    streamFence,
  } = ctx

  const finalProjection = projectStreamAccumulatorFinal(accumulator)
  const rawFinalContent = finalProjection.content
  const generatedImageAttachments = contentNeedsGeneratedOutputMaterialization(rawFinalContent)
    ? await prepareGeneratedOutputAttachments({
        messageId,
        content: rawFinalContent,
        now,
        downloader: generatedOutputDownloader(ctx),
      })
    : {
        content: rawFinalContent,
        replacements: [],
        newRefs: [],
        changed: false,
        attachmentBundles: [],
      }
  const finalContent = generatedImageAttachments.content
  const reasoning = finalProjection.reasoningDetails ?? []

  // Pre-compute calibration fields for the assistant row. On a successful
  // `done`, `originalCharCount` / `originalTokenEstimate` /
  // `originalModelId` / `cachedTokenEstimate` are populated so the next
  // gauge tick can read the cache directly instead of re-multiplying
  // chars × ratio.
  // This block only runs when the assistant side is text-only. Multimodal
  // or tool output can still preserve generation usage, but it must not
  // seed text calibration caches.
  let assistantCalibrationFields: ReturnType<typeof calibrationFieldsForCreate> | null = null
  const completionCalibrationBlocked =
    calibrationInputs !== undefined &&
    (streamAccumulatorHasCompletionCalibrationBlockers(accumulator) ||
      finalContent.some(isNonTextContentItem))
  if (outcome === 'done' && calibrationInputs && !completionCalibrationBlocked) {
    try {
      const [chatForRatio, globalCal, prefs] = await Promise.all([
        repo.getChat(chatId),
        readTokenCalibrationGlobal(),
        readGlobalPreferences(),
      ])
      assistantCalibrationFields = calibrationFieldsForCreate(
        finalContent,
        calibrationInputs.modelId,
        chatForRatio,
        globalCal,
        prefs.tokenCalibrationMode,
      )
    } catch {
      assistantCalibrationFields = null
    }
  }

  const persistedAssistant = { value: null as Message | null }
  await repo.runMutation(
    [{ kind: 'message', messageId }, ...attachmentScopes(generatedImageAttachments.newRefs)],
    async (inner) => {
      const current = await inner.getMessageHeader(messageId)
      if (!current) return
      await persistPreparedGeneratedOutputAttachments(inner, generatedImageAttachments)
      const generation = projectStreamGeneration(current.generation, accumulator, requestedModel, {
        apiUsed,
        finishedAt: now,
      })
      generation.status =
        outcome === 'abort' ? (abortReason === 'tab-close' ? 'interrupted' : 'abort') : outcome
      generation.integrity = accumulator.integritySummary.count > 0 ? 'degraded' : 'clean'
      if (accumulator.integritySummary.count > 0) {
        generation.integritySummary = structuredClone(accumulator.integritySummary)
      } else {
        delete generation.integritySummary
      }
      if (outcome === 'abort') {
        generation.abortReason = abortReason ?? 'user'
      }
      const finalError = error ?? accumulator.midStreamError
      if (finalError) {
        generation.error = toPersistedAttemptFailure(finalError, 'provider')
      }
      const headerPatch: MessageHeaderPatch = {
        generation,
        ...(assistantCalibrationFields ?? {}),
      }
      if (generatedImageAttachments.newRefs.length > 0) {
        const merged = mergeGeneratedImageAttachmentRefs(
          current.attachmentRefs,
          generatedImageAttachments.newRefs,
          messageId,
          now,
        )
        headerPatch.attachmentRefs = merged.refs
        headerPatch.cachedMediaTokens = undefined
      }
      await inner.patchMessageBody(
        messageId,
        {
          content: finalContent,
          reasoningDetails: reasoning.length > 0 ? reasoning : undefined,
          toolCalls: finalProjection.toolCalls,
          phase: finalProjection.phase,
          providerOutputItems: finalProjection.providerOutputItems,
        },
        {
          headerPatch,
          replaceBody: true,
        },
      )
      if (debugScope) {
        logStreamDebug(debugScope, 'message.finalize', {
          messageId,
          outcome,
          reasoningDetails: reasoning,
          content: finalContent,
          generation,
        })
      }
      persistedAssistant.value = {
        ...current,
        ...headerPatch,
        content: finalContent,
        ...(reasoning.length > 0 ? { reasoningDetails: reasoning } : {}),
        ...(finalProjection.toolCalls
          ? { toolCalls: structuredClone(finalProjection.toolCalls) }
          : {}),
        ...(finalProjection.phase !== undefined ? { phase: finalProjection.phase } : {}),
        ...(finalProjection.providerOutputItems
          ? { providerOutputItems: structuredClone(finalProjection.providerOutputItems) }
          : {}),
      } as Message
    },
    { streamFence: { streamId: ctx.streamId, fence: streamFence } },
  )

  // Token calibration happens AFTER the assistant message is persisted
  // so the final content + reasoningDetails + usage are available. Skips
  // on anything other than a clean `done`, because error/abort streams
  // don't have reliable usage from the server.
  if (
    outcome === 'done' &&
    calibrationInputs &&
    !completionCalibrationBlocked &&
    persistedAssistant.value !== null &&
    accumulator.usage
  ) {
    try {
      await ingestCalibrationSample({
        repo,
        chatId,
        assistantMessage: persistedAssistant.value,
        usage: accumulator.usage,
        calibrationInputs,
        now,
        streamId: ctx.streamId,
        streamFence,
      })
    } catch {
      // Non-fatal: calibration failure must not surface to the user.
    }
  }
}

function isNonTextContentItem(item: ContentItem): boolean {
  return item.type !== 'text' && item.type !== 'output_text'
}

function contentNeedsGeneratedOutputMaterialization(content: readonly ContentItem[]): boolean {
  return content.some(
    (item) =>
      (item.type === 'output_image' ||
        item.type === 'audio_output' ||
        item.type === 'output_video') &&
      !item.attachmentId &&
      typeof item.url === 'string' &&
      item.url.length > 0,
  )
}

async function ingestCalibrationSample(args: {
  repo: ReturnType<typeof getWorkspaceRepository>
  chatId: ChatId
  assistantMessage: Message
  usage: ChatUsage
  calibrationInputs: NonNullable<FinalizeContext['calibrationInputs']>
  now: number
  streamId: string
  streamFence: StreamWriteFence
}): Promise<void> {
  const { repo, chatId, assistantMessage, usage, calibrationInputs, now, streamId, streamFence } =
    args
  if (assistantMessage.generation?.tokenCalibration) return

  const calibrationKey = tokenCalibrationKey(calibrationInputs.modelId)
  const promptSample =
    calibrationInputs.promptCalibrationAllowed && calibrationInputs.promptBasis
      ? derivePromptSampleFromBasis(calibrationInputs.promptBasis, usage)
      : null
  const completionSample =
    calibrationInputs.completionCalibrationAllowed &&
    !assistantMessage.content.some(isNonTextContentItem) &&
    !messageHasToolArtifacts(assistantMessage)
      ? deriveCompletionSample({
          assistantMessage,
          usage,
          family: calibrationInputs.family,
        })
      : null

  if (promptSample === null && completionSample === null) return

  // Step 1: apply per-chat samples in memory. `patchChatMeta` with
  // `touchVisibleState: false` writes into the hidden meta patch so
  // `metaVersion` doesn't bump and a sidebar broadcast doesn't fire just
  // for a calibration delta.
  const acceptedSamples: Array<{ chars: number; tokens: number }> = []
  await repo.runMutation(
    [
      { kind: 'chat-meta', chatId },
      { kind: 'message', messageId: assistantMessage.id },
    ],
    async (inner) => {
      const assistantHeader = await inner.getMessageHeader(assistantMessage.id)
      if (!assistantHeader?.generation || assistantHeader.generation.tokenCalibration) return

      let promptAccepted = false
      let completionAccepted = false
      const localAcceptedSamples: Array<{ chars: number; tokens: number }> = []
      const chat = await inner.getChat(chatId)
      if (!chat) return
      const staged = {
        tokenCalibration: { ...(chat.tokenCalibration ?? {}) },
      }
      if (promptSample !== null) {
        const outcome = addSampleToChat(
          staged,
          calibrationInputs.modelId,
          promptSample.chars,
          promptSample.tokens,
          now,
        )
        if (outcome.accepted) {
          localAcceptedSamples.push(promptSample)
          promptAccepted = true
        }
      }
      if (completionSample !== null) {
        const outcome = addSampleToChat(
          staged,
          calibrationInputs.modelId,
          completionSample.chars,
          completionSample.tokens,
          now,
        )
        if (outcome.accepted) {
          localAcceptedSamples.push(completionSample)
          completionAccepted = true
        }
      }
      if (localAcceptedSamples.length > 0) {
        inner.patchChatMeta(
          chatId,
          { tokenCalibration: staged.tokenCalibration },
          { touchVisibleState: false, broadcast: false },
        )
        await inner.patchMessageBody(
          assistantMessage.id,
          {},
          {
            headerPatch: {
              generation: {
                ...assistantHeader.generation,
                tokenCalibration: {
                  sampleId: assistantMessage.id,
                  modelId: calibrationInputs.modelId,
                  calibrationKey,
                  promptSample: promptAccepted,
                  completionSample: completionAccepted,
                  sampleCount: localAcceptedSamples.length,
                  appliedAt: now,
                },
              },
            },
            touchChatSummary: false,
            broadcast: false,
          },
        )
        acceptedSamples.push(...localAcceptedSamples)
      }
    },
    { streamFence: { streamId, fence: streamFence } },
  )

  // Step 2: roll up to global AFTER the chat mutation closes — separate
  // transaction on the settings table.
  for (const s of acceptedSamples) {
    await addAcceptedSampleToGlobal(calibrationInputs.modelId, s.chars, s.tokens, now)
  }
}

// Orphan sweep for interrupted streams. The active-chat shell runs it on open
// and when lease expiry or ownership-release evidence arrives. Any message
// whose `generation.startedAt` is set without a `finishedAt` is marked
// `abortReason: 'tab-close'` so the UI can render the "Stream interrupted"
// banner.
export async function recoverOrphans(now = Date.now(), chatId?: ChatId): Promise<number> {
  const repo = getWorkspaceRepository()
  const recoveryReplacementEpoch = (await repo.getWorkspaceMeta()).replacementEpoch
  const scopedChat = chatId !== undefined ? await repo.getChat(chatId) : undefined
  const chats = chatId !== undefined ? (scopedChat ? [scopedChat] : []) : await repo.listChats()
  const allLeases = await repo.listStreamLeases(chatId)
  const ownershipLocksSupported = streamOwnershipLocksSupported()
  const leases = allLeases.filter((lease) => isFreshStreamLease(lease, now))
  const leasedMessageIds = new Set(
    ownershipLocksSupported
      ? []
      : leases
          .filter((lease) => lease.messageId !== undefined)
          .filter((lease) => !isRecoveryClaimedStreamLease(lease))
          .map((lease) => lease.messageId as MessageId),
  )
  let recovered = 0
  for (const lease of allLeases) {
    if (
      lease.attemptKind !== 'generation' ||
      (isFreshStreamLease(lease, now) &&
        !ownershipLocksSupported &&
        !isRecoveryClaimedStreamLease(lease)) ||
      (lease.messageId && isLocallyOwnedTargetActive(lease.chatId, lease.messageId))
    ) {
      continue
    }
    const guarded = await withStreamRecoveryLocks([lease.streamId], async (ownershipVerified) => {
      if (lease.messageId && isLocallyOwnedTargetActive(lease.chatId, lease.messageId)) {
        return false
      }
      const currentLease = (await repo.listStreamLeases(lease.chatId)).find(
        (candidate) => candidate.streamId === lease.streamId,
      )
      if (
        !currentLease ||
        (isFreshStreamLease(currentLease, now) &&
          !ownershipVerified &&
          !isRecoveryClaimedStreamLease(currentLease))
      ) {
        return false
      }
      const header = currentLease.messageId
        ? await repo.getMessageHeader(currentLease.messageId)
        : undefined
      if (header?.generation && header.generation.finishedAt === undefined) return false
      const claimedLease = await repo.claimStreamLeaseForRecovery(currentLease, now)
      if (!claimedLease) return false
      await repo.deleteStreamChunks(claimedLease.streamId)
      await repo.deleteStreamLease(claimedLease.streamId)
      announceStreamEnded({
        chatId: claimedLease.chatId,
        streamId: claimedLease.streamId,
        ...(claimedLease.messageId ? { messageId: claimedLease.messageId } : {}),
        outcome: 'abort',
        replacementEpoch: streamWriteFenceForLease(claimedLease).replacementEpoch,
      })
      return true
    })
    if (guarded.acquired && guarded.value) recovered += 1
  }
  recovered += await recoverStaleContinuationAttempts({
    repo,
    leases: allLeases,
    now,
    isTargetActive: isLocallyOwnedTargetActive,
  })
  for (const chat of chats) {
    const headers = await repo.listMessageHeaders(chat.id)
    const initialMessageLessGenerationLeases = allLeases.filter(
      (lease) =>
        lease.chatId === chat.id &&
        lease.attemptKind === 'generation' &&
        lease.messageId === undefined,
    )
    for (const header of headers) {
      const gen = header.generation
      if (!gen || gen.finishedAt !== undefined || gen.abortReason !== undefined) continue
      if (now - gen.startedAt < STREAM_LEASE_TTL_MS && !ownershipLocksSupported) continue
      if (isLocallyOwnedTargetActive(chat.id, header.id)) continue
      if (leasedMessageIds.has(header.id)) continue
      const initialChunks = await repo.listStreamChunksForMessage(header.id)
      const initialMessageLeases = allLeases.filter((lease) => lease.messageId === header.id)
      const observedTarget = useStreamStore.getState().getTargetActive(chat.id, header.id)
      const guardedStreamIds = new Set([
        ...initialChunks.map((chunk) => chunk.streamId),
        ...initialMessageLeases.map((lease) => lease.streamId),
        ...initialMessageLessGenerationLeases.map((lease) => lease.streamId),
        ...(observedTarget ? [observedTarget.streamId] : []),
      ])
      const guarded = await withStreamRecoveryLocks(
        [...guardedStreamIds],
        async (ownershipVerified) => {
          if (isLocallyOwnedTargetActive(chat.id, header.id)) return false
          const currentChatLeases = await repo.listStreamLeases(chat.id)
          const currentMessageLeases = currentChatLeases.filter(
            (lease) => lease.messageId === header.id,
          )
          const currentMessageLessGenerationLeases = currentChatLeases.filter(
            (lease) => lease.attemptKind === 'generation' && lease.messageId === undefined,
          )
          if (
            currentMessageLessGenerationLeases.some(
              (lease) =>
                !guardedStreamIds.has(lease.streamId) ||
                (isFreshStreamLease(lease, now) &&
                  !ownershipVerified &&
                  !isRecoveryClaimedStreamLease(lease)),
            )
          ) {
            return false
          }
          if (
            currentMessageLeases.some(
              (lease) =>
                !guardedStreamIds.has(lease.streamId) ||
                (isFreshStreamLease(lease, now) &&
                  !ownershipVerified &&
                  !isRecoveryClaimedStreamLease(lease)),
            )
          ) {
            return false
          }
          const claimedLeases: StreamLeaseRow[] = []
          for (const currentLease of currentMessageLeases) {
            const claimed = await repo.claimStreamLeaseForRecovery(currentLease, now)
            if (!claimed) return false
            claimedLeases.push(claimed)
          }
          const primaryClaim = claimedLeases[0]
          for (const claimed of claimedLeases.slice(1)) {
            await repo.deleteStreamLease(claimed.streamId)
          }
          const chunks = await repo.listStreamChunksForMessage(header.id)
          if (chunks.some((chunk) => !guardedStreamIds.has(chunk.streamId))) return false
          let wroteCanonical = false
          await repo.runMutation(
            [{ kind: 'message', messageId: header.id }],
            async (ctx) => {
              const current = await ctx.getMessage(header.id)
              if (!current?.generation || current.generation.finishedAt !== undefined) return
              if (chunks.length === 0) {
                await ctx.putMessage({
                  ...current,
                  generation: {
                    ...current.generation,
                    finishedAt: now,
                    abortReason: 'tab-close',
                    status: 'interrupted',
                    integrity: current.generation.integrity ?? 'clean',
                  },
                })
                wroteCanonical = true
                return
              }
              const replayed = replayStreamAccumulator({
                initialContent: current.content,
                now,
                entries: chunks,
              })
              const generation = projectStreamGeneration(
                current.generation,
                replayed.accumulator,
                current.generation.requestedModel || current.generation.model,
                { apiUsed: current.generation.apiUsed, finishedAt: now },
              )
              generation.integrity =
                replayed.accumulator.integritySummary.count > 0 ? 'degraded' : 'clean'
              if (replayed.accumulator.integritySummary.count > 0) {
                generation.integritySummary = structuredClone(replayed.accumulator.integritySummary)
              } else {
                delete generation.integritySummary
              }
              generation.status = replayed.accumulator.midStreamError
                ? 'error'
                : replayed.finishedCleanly
                  ? 'done'
                  : 'interrupted'
              if (!replayed.finishedCleanly && !replayed.accumulator.midStreamError) {
                generation.abortReason = 'tab-close'
              }
              if (replayed.accumulator.midStreamError) {
                generation.error = toPersistedAttemptFailure(
                  replayed.accumulator.midStreamError,
                  'provider',
                )
              }
              await ctx.patchMessageBody(
                header.id,
                {
                  content: replayed.final.content,
                  reasoningDetails: replayed.final.reasoningDetails,
                  toolCalls: replayed.final.toolCalls,
                  phase: replayed.final.phase,
                  providerOutputItems: replayed.final.providerOutputItems,
                },
                {
                  headerPatch: { generation },
                  replaceBody: true,
                },
              )
              wroteCanonical = true
            },
            primaryClaim
              ? {
                  streamFence: {
                    streamId: primaryClaim.streamId,
                    fence: streamWriteFenceForLease(primaryClaim),
                  },
                }
              : undefined,
          )
          for (const streamId of guardedStreamIds) {
            await repo.deleteStreamChunks(streamId)
            await repo.deleteStreamLease(streamId)
            announceStreamEnded({
              chatId: chat.id,
              streamId,
              messageId: header.id,
              outcome: 'abort',
              replacementEpoch: primaryClaim?.replacementEpoch ?? recoveryReplacementEpoch,
            })
          }
          return wroteCanonical
        },
      )
      if (guarded.acquired && guarded.value) recovered += 1
    }
  }
  return recovered
}

export async function nextOrphanRecoveryAt(
  chatId: ChatId,
  now = Date.now(),
): Promise<number | null> {
  const repo = getWorkspaceRepository()
  const leases = await repo.listStreamLeases(chatId)
  let next = Number.POSITIVE_INFINITY
  for (const lease of leases) {
    if (lease.attemptKind !== 'generation' && lease.attemptKind !== 'continuation') continue
    if (
      useStreamStore.getState().getActive(lease.streamId)?.ownerClientId === getStreamClientId()
    ) {
      continue
    }
    const expiresAt = lease.heartbeatAt + STREAM_LEASE_TTL_MS + 1
    next = Math.min(
      next,
      isRecoveryClaimedStreamLease(lease)
        ? now + ORPHAN_RECOVERY_RETRY_MS
        : expiresAt > now
          ? expiresAt
          : now + ORPHAN_RECOVERY_RETRY_MS,
    )
  }
  if (!streamOwnershipLocksSupported()) {
    const headers = await repo.listMessageHeaders(chatId)
    for (const header of headers) {
      const generation = header.generation
      if (
        !generation ||
        generation.finishedAt !== undefined ||
        generation.abortReason !== undefined ||
        isLocallyOwnedTargetActive(chatId, header.id)
      ) {
        continue
      }
      const eligibleAt = generation.startedAt + STREAM_LEASE_TTL_MS + 1
      next = Math.min(next, eligibleAt > now ? eligibleAt : now + ORPHAN_RECOVERY_RETRY_MS)
    }
  }
  return Number.isFinite(next) ? next : null
}

function isLocallyOwnedTargetActive(chatId: ChatId, messageId: MessageId): boolean {
  return (
    useStreamStore.getState().getTargetActive(chatId, messageId)?.ownerClientId ===
    getStreamClientId()
  )
}

interface UseChatApi {
  send: (input: Omit<SendTextInput, 'signal'>) => Promise<SendTextResult>
  sendFrom: (input: Omit<SendFromMessageInput, 'signal'>) => Promise<SendTextResult>
  abort: () => void
  isStreaming: () => boolean
}

export function useChat(): UseChatApi {
  const controllerRef = useRef<AbortController | null>(null)
  const streamIdRef = useRef<string | null>(null)

  const send = useCallback(async (input: Omit<SendTextInput, 'signal'>) => {
    const ctl = new AbortController()
    controllerRef.current = ctl
    try {
      const result = await sendText({ ...input, signal: ctl.signal })
      streamIdRef.current = result.streamId
      return result
    } finally {
      if (controllerRef.current === ctl) controllerRef.current = null
    }
  }, [])

  const sendFrom = useCallback(async (input: Omit<SendFromMessageInput, 'signal'>) => {
    const ctl = new AbortController()
    controllerRef.current = ctl
    try {
      const result = await sendFromMessage({ ...input, signal: ctl.signal })
      streamIdRef.current = result.streamId
      return result
    } finally {
      if (controllerRef.current === ctl) controllerRef.current = null
    }
  }, [])

  const abort = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort()
      return
    }
    const streamId = streamIdRef.current
    if (!streamId) return
    const state = useStreamStore.getState()
    const stream = state.getActive(streamId)
    if (stream) state.abortStream(streamId, stream.replacementEpoch)
  }, [])

  const isStreaming = useCallback(() => controllerRef.current !== null, [])

  return { send, sendFrom, abort, isStreaming }
}
