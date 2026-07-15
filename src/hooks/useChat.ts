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
import type { ApiError } from '../api/errors'
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
import {
  flushPostCommitTasksForTests,
  resetPostCommitTasksForTests,
  schedulePostCommitTask,
} from '../core/post-commit-task'
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
  addAcceptedSamplesToGlobal,
  addSampleToChat,
  calibrationFieldsForCreate,
  deriveCompletionSample,
  derivePromptCalibrationBasis,
  derivePromptSampleFromBasis,
  type PromptCalibrationBasis,
  readTokenCalibrationGlobal,
  tokenCalibrationClearGeneration,
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
import { getChat } from '../store/chats'
import {
  type ConnectionRuntimeKeyCandidate,
  primeConnectionRuntimeKeyCandidates,
} from '../store/connection-runtime'
import { recoverStaleContinuationAttempts } from '../store/continuation-recovery'
import {
  commitPreparedGeneratedOutputAttachments,
  contentNeedsGeneratedOutputMaterialization,
  type GeneratedOutputDownloader,
  prepareGeneratedOutputAttachments,
  withGeneratedOutputLocalizationClaim,
} from '../store/generated-images'
import { type MessageHeaderRow, rebaseHydratedMessageHeader } from '../store/message-storage'
import { ENDPOINTS_TTL_MS, getCachedEndpoints, isFresh } from '../store/models-cache'
import { getCachedPrivacyPolicy } from '../store/privacy-cache'
import { flushPendingPromptSettingSaves } from '../store/prompt-presets'
import {
  ExpectedLeafChangedError,
  type MessageCalibrationPatch,
  type MessageHeaderPatch,
  type MutationContext,
  type StreamLeaseRow,
  type StreamWriteFence,
  streamLeaseOwnsTargetWrites,
} from '../store/repository'
import {
  assertSendContextGuardInMutation,
  createSendContextGuard,
  loadActiveBranchHeaderSnapshot,
  loadChatHeaderSnapshot,
  loadSendContextForBranch,
  type SendContextGuard,
} from '../store/send-context'
import { createStreamChunkWriter } from '../store/stream-chunk-writer'
import {
  announceStreamEnded,
  getStreamClientId,
  indexStreamLeasesForRecovery,
  isFreshStreamLease,
  isRecoveryClaimedStreamLease,
  newestStreamLeaseByAdmission,
  STREAM_LEASE_TTL_MS,
  streamLeaseRecoveryKind,
  streamOwnershipLocksSupported,
  streamWriteFenceForLease,
  withStreamRecoveryLocks,
} from '../store/stream-leases'
import { getWorkspaceRepository } from '../store/workspace-repository'
import { announceGenerationOutcome } from '../store/zustand/announcementStore'
import type {
  CommittedMessagePresentation,
  CommittedPathProducer,
  NavigationIntent,
} from '../store/zustand/chatStore'
import { claimCommittedPresentationWorkspace, useChatStore } from '../store/zustand/chatStore'
import { useStreamStore } from '../store/zustand/streamStore'
import { useUiStore } from '../store/zustand/uiStore'
import { startRequestLifecycle } from './requestLifecycle'

const ORPHAN_RECOVERY_RETRY_MS = 2_000

export async function __flushPostCommitCalibrationForTests(): Promise<void> {
  await flushPostCommitTasksForTests()
}

export function __resetPostCommitCalibrationForTests(): void {
  resetPostCommitTasksForTests()
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
  committedPathProducer?: CommittedPathProducer | null
  expectedLeafId?: MessageId | null
  connection: ConnectionProfile
  apiKey: string
  apiKeyCandidates?: readonly ConnectionRuntimeKeyCandidate[]
  content: ContentItem[]
  attachmentRefs?: AttachmentRef[]
  capabilities?: CapabilityDescriptor
  transform?: AssistantRequestTransform
  // Optional transport dependency for exercising orchestration in isolation.
  // Browser callers omit it and use the normal assistant transport.
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

function replaceActiveChatMessageRoute(chatId: ChatId, messageId: MessageId): void {
  if (typeof window === 'undefined') return
  const route = parseRoute(window.location.hash)
  if (route.kind !== 'chat' || route.chatId !== chatId) return
  replaceRoute(chatHref(chatId, messageId))
}

async function committedMessagePresentation(
  ctx: MutationContext,
  messageId: MessageId,
): Promise<CommittedMessagePresentation> {
  const [header, message] = await Promise.all([
    ctx.getMessageHeader(messageId),
    ctx.getMessage(messageId),
  ])
  if (!header || !message) throw new Error(`CommittedMessagePresentationMissing:${messageId}`)
  return { header, message, bodyVersion: header.bodyVersion }
}

function knownCommittedMessagePresentation(
  header: MessageHeaderRow,
  message: Message,
): CommittedMessagePresentation {
  return { header, message, bodyVersion: header.bodyVersion }
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
  const chatStore = useChatStore.getState()
  const navigationIntent =
    input.navigationIntent === undefined
      ? chatStore.beginNavigationIntent(input.chatId)
      : input.navigationIntent
  const committedPathProducer = navigationIntent
    ? input.committedPathProducer === undefined
      ? chatStore.registerCommittedPathProducer(input.chatId, navigationIntent)
      : input.committedPathProducer
    : null
  const cursorAtSubmit = chatStore.getCursor(input.chatId) ?? {}
  let lifecycle: Awaited<ReturnType<typeof startRequestLifecycle>> | undefined
  let lifecycleOutcome: SendTextResult['outcome'] = 'error'
  try {
    const expectedLeafId =
      input.expectedLeafId !== undefined
        ? input.expectedLeafId
        : ((await loadActiveBranchHeaderSnapshot(input.chatId, cursorAtSubmit)).branchHeaders.at(-1)
            ?.id ?? null)
    const userMessageId = newId()
    const assistantMessageId = newId()
    lifecycle = await startRequestLifecycle({
      chatId: input.chatId,
      streamId: newId(),
      messageId: assistantMessageId,
      attemptKind: 'generation',
      ...(navigationIntent ? { originNavigationRevision: navigationIntent.revision } : {}),
      ...(input.signal ? { userSignal: input.signal } : {}),
    })
    await flushPendingPromptSettingSaves(input.chatId)
    let chat: Chat | null | undefined = await getChat(input.chatId)
    if (!chat) throw new Error(`sendText: chat not found: ${input.chatId}`)

    const createdAt = now()
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

    const committedBranchHeaders = userMsg.branchHeaders
    if (committedBranchHeaders.at(-1)?.id !== userMsg.messageId) {
      throw new ExpectedLeafChangedError(input.chatId, userMsg.messageId, 'missing')
    }
    const committedPathSelections = committedBranchHeaders.map(
      (header) => [cursorKeyOf(header.parentId), header.id] as const,
    )
    if (committedPathProducer) {
      useChatStore
        .getState()
        .selectCommittedPathForProducer(
          input.chatId,
          committedPathProducer,
          Object.fromEntries(committedPathSelections),
          {
            phase: 'open',
            pathHeaders: committedBranchHeaders,
            presentations: [knownCommittedMessagePresentation(userMsg.header, userMsg.message)],
          },
        )
    }

    let planningChat: Chat | null | undefined = await getChat(input.chatId)
    if (!planningChat) throw new Error(`sendText: chat not found: ${input.chatId}`)
    const branchHeaders = committedBranchHeaders
    const sendContextGuard = createSendContextGuard(planningChat, branchHeaders)
    const targetPathSelections = branchHeaders.map(
      (header) => [cursorKeyOf(header.parentId), header.id] as const,
    )
    const hasPrefill = (input.prefillContent?.length ?? 0) > 0
    const prefillMessageId = hasPrefill ? assistantMessageId : null
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

    const requested = openAssistantStreamUnder({
      ...input,
      signal: lifecycle.signal,
      lifecyclePreserveLease: lifecycle.preserveLease,
      lifecycleAbort: lifecycle.abort,
      lifecyclePublishTarget: lifecycle.publishTarget,
      lifecycleRefreshLease: lifecycle.refreshLease,
      streamId: lifecycle.streamId,
      streamFence: lifecycle.streamFence,
      assistantMessageId,
      parentMessageId: userMsg.messageId,
      userMessageId: userMsg.messageId,
      requireEmptyParent: true,
      sendContextGuard,
      committedPathProducer,
      targetPathSelections,
      targetPathHeaders: branchHeaders,
      targetPresentations: committedPathProducer
        ? [
            knownCommittedMessagePresentation(
              branchHeaders.at(-1) as MessageHeaderRow,
              userMsg.message,
            ),
          ]
        : [],
      ...(hasPrefill ? { initialAssistantContent: input.prefillContent ?? [] } : {}),
      requestPlan,
    })
    requestPlan = undefined as never
    plannedPath = []
    sendContext = undefined
    planningChat = undefined
    const result = await requested
    lifecycleOutcome = result.outcome
    return result
  } catch (error) {
    if (committedPathProducer) {
      useChatStore.getState().sealCommittedPathProducer(input.chatId, committedPathProducer)
    }
    throw error
  } finally {
    if (lifecycle) {
      if (lifecycle.signal.aborted) lifecycleOutcome = 'abort'
      const ended = await lifecycle.end(lifecycleOutcome)
      if (ended.recoveryPending) {
        await recoverStreamOrphan(
          {
            chatId: input.chatId,
            streamId: lifecycle.streamId,
            ...(lifecycle.messageId ? { messageId: lifecycle.messageId } : {}),
            attemptKind: 'generation',
            replacementEpoch: lifecycle.replacementEpoch,
            outcome: lifecycleOutcome,
          },
          Date.now(),
        ).catch(() => {})
      }
    }
  }
}

// Edit-then-send / resend-from-existing-user entrypoint. The caller has
// already created the user sibling (e.g. via `insertSibling` with
// role:'user', origin:'user'); all that's left is to attach an assistant
// placeholder under it and stream the reply. No user message is created.
export async function sendFromMessage(input: SendFromMessageInput): Promise<SendTextResult> {
  const chatStore = useChatStore.getState()
  const navigationIntent =
    input.navigationIntent === undefined
      ? chatStore.beginNavigationIntent(input.chatId)
      : input.navigationIntent
  const committedPathProducer = navigationIntent
    ? input.committedPathProducer === undefined
      ? chatStore.registerCommittedPathProducer(input.chatId, navigationIntent)
      : input.committedPathProducer
    : null
  let lifecycle: Awaited<ReturnType<typeof startRequestLifecycle>> | undefined
  let lifecycleOutcome: SendTextResult['outcome'] = 'error'
  try {
    const assistantMessageId = newId()
    lifecycle = await startRequestLifecycle({
      chatId: input.chatId,
      streamId: newId(),
      messageId: assistantMessageId,
      attemptKind: 'generation',
      ...(navigationIntent ? { originNavigationRevision: navigationIntent.revision } : {}),
      ...(input.signal ? { userSignal: input.signal } : {}),
    })
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
    const prefillMessageId = hasPrefill ? assistantMessageId : null
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
    const committedParentHeader = rawOutboundHeaders.at(-1)
    const committedParentMessage = plannedPath.find(
      (message) => message.id === input.parentMessageId,
    )
    const targetPresentations =
      committedParentHeader && committedParentMessage
        ? [knownCommittedMessagePresentation(committedParentHeader, committedParentMessage)]
        : []
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

    const requested = openAssistantStreamUnder({
      ...input,
      signal: lifecycle.signal,
      lifecyclePreserveLease: lifecycle.preserveLease,
      lifecycleAbort: lifecycle.abort,
      lifecyclePublishTarget: lifecycle.publishTarget,
      lifecycleRefreshLease: lifecycle.refreshLease,
      streamId: lifecycle.streamId,
      streamFence: lifecycle.streamFence,
      assistantMessageId,
      parentMessageId: input.parentMessageId,
      userMessageId: input.parentMessageId,
      sendContextGuard,
      committedPathProducer,
      targetPathSelections: rawOutboundHeaders.map(
        (header) => [cursorKeyOf(header.parentId), header.id] as const,
      ),
      targetPathHeaders: rawOutboundHeaders,
      targetPresentations,
      ...(hasPrefill ? { initialAssistantContent: input.prefillContent ?? [] } : {}),
      requestPlan,
    })
    requestPlan = undefined as never
    plannedPath = []
    sendContext = undefined
    chat = undefined
    const result = await requested
    lifecycleOutcome = result.outcome
    return result
  } catch (error) {
    if (committedPathProducer) {
      useChatStore.getState().sealCommittedPathProducer(input.chatId, committedPathProducer)
    }
    throw error
  } finally {
    if (lifecycle) {
      if (lifecycle.signal.aborted) lifecycleOutcome = 'abort'
      const ended = await lifecycle.end(lifecycleOutcome)
      if (ended.recoveryPending) {
        await recoverStreamOrphan(
          {
            chatId: input.chatId,
            streamId: lifecycle.streamId,
            ...(lifecycle.messageId ? { messageId: lifecycle.messageId } : {}),
            attemptKind: 'generation',
            replacementEpoch: lifecycle.replacementEpoch,
            outcome: lifecycleOutcome,
          },
          Date.now(),
        ).catch(() => {})
      }
    }
  }
}

async function openAssistantStreamUnder(
  input: SendFromMessageInput & {
    userMessageId: MessageId
    requestPlan: AssistantRequestPlan
    sendContextGuard: SendContextGuard
    committedPathProducer: CommittedPathProducer | null
    targetPathSelections: ReadonlyArray<readonly [string, MessageId]>
    targetPathHeaders: readonly MessageHeaderRow[]
    targetPresentations: readonly CommittedMessagePresentation[]
    streamId: string
    streamFence: StreamWriteFence
    assistantMessageId: MessageId
    initialAssistantContent?: ContentItem[]
    signal: AbortSignal
    lifecyclePreserveLease: (reason?: 'content' | 'cleanup') => void
    lifecycleAbort: () => void
    lifecyclePublishTarget: () => void
    lifecycleRefreshLease: () => Promise<void>
    requireEmptyParent?: boolean
  },
): Promise<SendTextResult> {
  const now = input.now ?? Date.now
  const repo = getWorkspaceRepository()
  const apiKeyCandidates = await primeConnectionRuntimeKeyCandidates(
    input.apiKeyCandidates,
    input.signal,
  )
  await input.lifecycleRefreshLease()
  if (input.signal.aborted) throw new DOMException('Request aborted.', 'AbortError')
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

  const assistantId = input.assistantMessageId
  const targetPathSelections = [
    ...input.targetPathSelections,
    [cursorKeyOf(input.parentMessageId), assistantId] as const,
  ]
  const placeholderMutation = await repo.runMutation(
    [
      { kind: 'chat-meta', chatId: input.chatId },
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
      return committedMessagePresentation(ctx, assistantId)
    },
    { streamFence: { streamId: input.streamId, fence: input.streamFence } },
  )
  const assistantPlaceholder = placeholderMutation.value

  const selectedPathHeaders = [...input.targetPathHeaders, assistantPlaceholder.header]
  const selected = input.committedPathProducer
    ? useChatStore
        .getState()
        .selectCommittedPathForProducer(
          input.chatId,
          input.committedPathProducer,
          Object.fromEntries(targetPathSelections),
          {
            phase: 'open',
            pathHeaders: selectedPathHeaders,
            presentations: [...input.targetPresentations, assistantPlaceholder],
          },
        )
    : false
  if (selected) {
    replaceActiveChatMessageRoute(input.chatId, assistantId)
  }
  input.lifecyclePublishTarget()

  const streamId = input.streamId
  const debugScope = `send:${streamId}`
  const streamFence = input.streamFence

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
    input.openStream ??
    ((open) =>
      openAssistantRequestStream({
        connection: open.connection,
        apiKey: open.apiKey,
        ...(apiKeyCandidates ? { apiKeyCandidates } : {}),
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
  let canonicalAnnounced = false
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
    ...(route?.transport !== undefined ? { transportHint: route.transport } : {}),
    accumulator,
    journal,
    errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
    now,
    isAborted: () => input.signal.aborted,
    registerLiveProjectionRequester: (requester) => {
      useStreamStore
        .getState()
        .setLiveSnapshotRequester(streamId, streamFence.replacementEpoch, requester)
    },
    onLiveProjectionFailure: input.lifecycleAbort,
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
      const committedPathProducer = input.committedPathProducer
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
        onCommittedPresentation: (presentation: CommittedMessagePresentation) => {
          const store = useChatStore.getState()
          const publishedForProducer = committedPathProducer
            ? store.updateCommittedMessageForProducer(
                input.chatId,
                committedPathProducer,
                presentation,
                'terminal',
              )
            : false
          if (!publishedForProducer) {
            store.publishCommittedMessageMutation(input.chatId, selectedPathHeaders, presentation)
          }
        },
        onPostCommitPresentation: (presentation: CommittedMessagePresentation) => {
          useChatStore
            .getState()
            .publishCommittedMessageMutation(input.chatId, selectedPathHeaders, presentation)
        },
      })
      canonicalFinalized = true
    },
    onCanonicalCommitted: (result) => {
      canonicalAnnounced = true
      announceGenerationOutcome(streamId, result.outcome)
    },
    cleanupJournal: () => repo.deleteStreamChunks(streamId, streamFence),
    cleanup: (result) => {
      if (result.journalCleanupPending) input.lifecyclePreserveLease('cleanup')
      if (!canonicalAnnounced) {
        announceGenerationOutcome(streamId, result.outcome)
      }
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
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return undefined
  if (useUiStore.getState().activeChatId !== ctx.chatId) return undefined
  const preparedCursor = useChatStore.getState().getCursor(ctx.chatId)
  if (!ctx.pathGuard.matches(preparedCursor)) return undefined
  const projection = projectStreamAccumulatorLive(ctx.accumulator, {
    requestedModel: ctx.requestedModel,
    apiUsed: ctx.apiUsed,
    now: ctx.now,
  })
  return () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false
    if (useUiStore.getState().activeChatId !== ctx.chatId) return false
    const cursor = useChatStore.getState().getCursor(ctx.chatId)
    if (!ctx.pathGuard.matches(cursor)) return false
    useStreamStore.getState().setLiveSnapshot({
      streamId: ctx.streamId,
      chatId: ctx.chatId,
      messageId: ctx.messageId,
      replacementEpoch: ctx.replacementEpoch,
      ...projection,
    })
    return true
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
  onCommittedPresentation?: (presentation: CommittedMessagePresentation) => void
  onPostCommitPresentation?: (presentation: CommittedMessagePresentation) => void
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

const GENERATED_OUTPUT_POST_COMMIT_TIMEOUT_MS = 20_000

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

async function localizeCommittedGeneratedOutput(input: {
  repo: ReturnType<typeof getWorkspaceRepository>
  presentation: CommittedMessagePresentation
  connection: ConnectionProfile
  apiKey: string
  requestSignal: AbortSignal
  taskSignal: AbortSignal
  now: number
  expectedReplacementEpoch: number
  isCurrent: () => boolean
  onCommittedPresentation?: (presentation: CommittedMessagePresentation) => void
}): Promise<void> {
  await withGeneratedOutputLocalizationClaim(
    input.repo,
    input.presentation.message.id,
    async (current) => {
      if (current.bodyVersion !== input.presentation.bodyVersion || !input.isCurrent()) return
      const controller = new AbortController()
      let cancel!: () => void
      const cancelled = new Promise<undefined>((resolve) => {
        cancel = () => {
          controller.abort()
          resolve(undefined)
        }
      })
      input.requestSignal.addEventListener('abort', cancel, { once: true })
      input.taskSignal.addEventListener('abort', cancel, { once: true })
      if (input.requestSignal.aborted || input.taskSignal.aborted) cancel()
      const preparing = prepareGeneratedOutputAttachments({
        messageId: input.presentation.message.id,
        content: current.message.content,
        now: input.now,
        downloader: generatedOutputDownloader({
          connection: input.connection,
          apiKey: input.apiKey,
          signal: controller.signal,
        }),
        preserveRemoteUrlOnDownloadFailure: true,
      })
      const prepared = await Promise.race([preparing, cancelled]).finally(() => {
        input.requestSignal.removeEventListener('abort', cancel)
        input.taskSignal.removeEventListener('abort', cancel)
      })
      if (!prepared || controller.signal.aborted || !input.isCurrent()) return
      const presentation = await commitPreparedGeneratedOutputAttachments({
        repo: input.repo,
        presentation: input.presentation,
        prepared,
        expectedReplacementEpoch: input.expectedReplacementEpoch,
        isCurrent: input.isCurrent,
      })
      if (presentation && input.isCurrent()) input.onCommittedPresentation?.(presentation)
    },
    { signal: input.taskSignal },
  )
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

async function finalize(ctx: FinalizeContext): Promise<CommittedMessagePresentation> {
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
  const finalContent = finalProjection.content
  const reasoning = finalProjection.reasoningDetails ?? []

  const completionCalibrationBlocked =
    calibrationInputs !== undefined &&
    (streamAccumulatorHasCompletionCalibrationBlockers(accumulator) ||
      finalContent.some(isNonTextContentItem))

  const persistedAssistantMutation = await repo.runMutation(
    [{ kind: 'message', messageId }],
    async (inner) => {
      const current = await inner.getMessageHeader(messageId)
      if (!current) throw new Error(`FinalizeMessageMissing:${messageId}`)
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
      const headerPatch: MessageHeaderPatch = { generation }
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
      const chat = await inner.getChat(chatId)
      if (!chat) throw new Error(`FinalizeChatMissing:${chatId}`)
      return {
        presentation: await committedMessagePresentation(inner, messageId),
        tokenCalibrationGeneration: chatTokenCalibrationGeneration(chat),
      }
    },
    { streamFence: { streamId: ctx.streamId, fence: streamFence } },
  )
  const persistedAssistant = persistedAssistantMutation.value.presentation
  ctx.onCommittedPresentation?.(persistedAssistant)

  if (contentNeedsGeneratedOutputMaterialization(finalContent)) {
    schedulePostCommitTask(
      (isCurrent, taskSignal) =>
        localizeCommittedGeneratedOutput({
          repo,
          presentation: persistedAssistant,
          connection: ctx.connection,
          apiKey: ctx.apiKey,
          requestSignal: ctx.signal,
          taskSignal,
          now,
          expectedReplacementEpoch: streamFence.replacementEpoch,
          isCurrent,
          ...(ctx.onPostCommitPresentation
            ? { onCommittedPresentation: ctx.onPostCommitPresentation }
            : {}),
        }),
      { timeoutMs: GENERATED_OUTPUT_POST_COMMIT_TIMEOUT_MS },
    )
  }

  if (outcome === 'done' && calibrationInputs && !completionCalibrationBlocked) {
    schedulePostCommitTask((isCurrent) =>
      calibrateCommittedAssistant({
        repo,
        chatId,
        presentation: persistedAssistant,
        ...(accumulator.usage ? { usage: accumulator.usage } : {}),
        calibrationInputs,
        now,
        expectedChatCalibrationGeneration:
          persistedAssistantMutation.value.tokenCalibrationGeneration,
        expectedReplacementEpoch: streamFence.replacementEpoch,
        ...(ctx.onPostCommitPresentation
          ? { onCommittedPresentation: ctx.onPostCommitPresentation }
          : {}),
        isCurrent,
      }),
    )
  }
  return persistedAssistant
}

function isNonTextContentItem(item: ContentItem): boolean {
  return item.type !== 'text' && item.type !== 'output_text'
}

function presentationVersionMatches(
  header: MessageHeaderRow | undefined,
  presentation: CommittedMessagePresentation,
): boolean {
  return (
    header?.id === presentation.header.id &&
    header.nodeVersion === presentation.header.nodeVersion &&
    header.bodyVersion === presentation.bodyVersion
  )
}

function chatTokenCalibrationGeneration(chat: Pick<Chat, 'tokenCalibrationGeneration'>): number {
  return typeof chat.tokenCalibrationGeneration === 'number' &&
    Number.isSafeInteger(chat.tokenCalibrationGeneration) &&
    chat.tokenCalibrationGeneration >= 0
    ? chat.tokenCalibrationGeneration
    : 0
}

function presentationWithMetadataHeader(
  presentation: CommittedMessagePresentation,
  header: MessageHeaderRow,
): CommittedMessagePresentation {
  return {
    header,
    bodyVersion: header.bodyVersion,
    message: rebaseHydratedMessageHeader(presentation.message, header),
  }
}

async function calibrateCommittedAssistant(args: {
  repo: ReturnType<typeof getWorkspaceRepository>
  chatId: ChatId
  presentation: CommittedMessagePresentation
  usage?: ChatUsage
  calibrationInputs: NonNullable<FinalizeContext['calibrationInputs']>
  now: number
  expectedChatCalibrationGeneration: number
  expectedReplacementEpoch: number
  onCommittedPresentation?: (presentation: CommittedMessagePresentation) => void
  isCurrent: () => boolean
}): Promise<void> {
  const { repo, chatId, calibrationInputs, now } = args
  const [chatForRatio, globalCal, prefs] = await Promise.all([
    repo.getChat(chatId),
    readTokenCalibrationGlobal(),
    readGlobalPreferences(),
  ])
  if (!args.isCurrent()) return
  const assistantCalibrationFields = calibrationFieldsForCreate(
    args.presentation.message.content,
    calibrationInputs.modelId,
    chatForRatio,
    globalCal,
    prefs.tokenCalibrationMode,
  )
  const assistantMessage = args.presentation.message
  if (assistantMessage.generation?.tokenCalibration) return

  const calibrationKey = tokenCalibrationKey(calibrationInputs.modelId)
  const promptSample =
    args.usage && calibrationInputs.promptCalibrationAllowed && calibrationInputs.promptBasis
      ? derivePromptSampleFromBasis(calibrationInputs.promptBasis, args.usage)
      : null
  const completionSample =
    args.usage &&
    calibrationInputs.completionCalibrationAllowed &&
    !assistantMessage.content.some(isNonTextContentItem) &&
    !messageHasToolArtifacts(assistantMessage)
      ? deriveCompletionSample({
          assistantMessage,
          usage: args.usage,
          family: calibrationInputs.family,
        })
      : null
  if (!args.isCurrent()) return
  const expectedGlobalClearGeneration = tokenCalibrationClearGeneration(globalCal)
  const mutation = await repo.runMutation(
    [
      { kind: 'chat-meta', chatId },
      { kind: 'message', messageId: assistantMessage.id },
    ],
    async (inner) => {
      const chat = await inner.getChat(chatId)
      const assistantHeader = await inner.getMessageHeader(assistantMessage.id)
      if (
        !chat ||
        chatTokenCalibrationGeneration(chat) !== args.expectedChatCalibrationGeneration ||
        assistantHeader?.chatId !== chatId ||
        !assistantHeader.generation ||
        assistantHeader.generation.tokenCalibration ||
        !presentationVersionMatches(assistantHeader, args.presentation)
      ) {
        return undefined
      }

      let promptAccepted = false
      let completionAccepted = false
      const localAcceptedSamples: Array<{ chars: number; tokens: number }> = []
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
      const headerPatch: MessageCalibrationPatch = { ...assistantCalibrationFields }
      if (localAcceptedSamples.length > 0) {
        inner.patchChatMeta(
          chatId,
          { tokenCalibration: staged.tokenCalibration },
          { touchVisibleState: false, broadcast: false },
        )
        headerPatch.generation = {
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
        }
      }
      const header = await inner.patchMessageCalibration(assistantMessage.id, headerPatch)
      return header ? { header, acceptedSamples: localAcceptedSamples } : undefined
    },
    { workspaceFence: { replacementEpoch: args.expectedReplacementEpoch } },
  )
  if (!args.isCurrent() || !mutation.value) return
  args.onCommittedPresentation?.(
    presentationWithMetadataHeader(args.presentation, mutation.value.header),
  )
  if (mutation.value.acceptedSamples.length === 0 || !args.isCurrent()) return
  await addAcceptedSamplesToGlobal(calibrationInputs.modelId, mutation.value.acceptedSamples, now, {
    expectedClearGeneration: expectedGlobalClearGeneration,
    expectedReplacementEpoch: args.expectedReplacementEpoch,
  })
}

// Orphan sweep for interrupted streams. The active-chat shell runs it on open
// and when lease expiry or ownership-release evidence arrives. Any message
// whose `generation.startedAt` is set without a `finishedAt` is marked
// `abortReason: 'tab-close'` so the UI can render the "Stream interrupted"
// banner.
export interface OrphanRecoveryPoint {
  chatId: ChatId
  streamId: string
  messageId?: MessageId
  attemptKind?: 'generation' | 'continuation'
  replacementEpoch?: number
  outcome?: 'done' | 'error' | 'abort'
}

export async function recoverStreamOrphan(
  point: OrphanRecoveryPoint,
  now = Date.now(),
): Promise<'recovered' | 'retry' | 'deferred' | 'resolved'> {
  const repo = getWorkspaceRepository()
  const replacementEpoch = (await repo.getWorkspaceMeta()).replacementEpoch
  if (point.replacementEpoch !== undefined && point.replacementEpoch !== replacementEpoch) {
    return 'resolved'
  }
  const recovered = await recoverOrphans(now, point.chatId, point)
  if (recovered > 0) return 'recovered'
  const lease = await repo.getStreamLease(point.streamId)
  if (lease) {
    if (isLocallyRecoveryPendingStream(point.streamId)) return 'retry'
    if (isFreshStreamLease(lease, now) && !isRecoveryClaimedStreamLease(lease)) return 'deferred'
    return 'retry'
  }
  if (isLocallyRecoveryPendingStream(point.streamId)) return 'retry'
  if ((await repo.listStreamChunks(point.streamId)).length > 0) {
    await repo.deleteStreamJournal(point.streamId, {
      replacementEpoch,
      expectedLeaseMissing: true,
    })
  }
  return 'resolved'
}

export async function recoverOrphans(
  now = Date.now(),
  chatId?: ChatId,
  point?: OrphanRecoveryPoint,
): Promise<number> {
  const repo = getWorkspaceRepository()
  const recoveryReplacementEpoch = (await repo.getWorkspaceMeta()).replacementEpoch
  if (
    point?.replacementEpoch !== undefined &&
    point.replacementEpoch !== recoveryReplacementEpoch
  ) {
    return 0
  }
  const presentationWorkspace = claimCommittedPresentationWorkspace()
  const pointLease = point ? await repo.getStreamLease(point.streamId) : undefined
  const effectiveMessageId = point?.messageId ?? pointLease?.messageId
  const effectiveAttemptKind =
    point?.attemptKind ?? (pointLease ? streamLeaseRecoveryKind(pointLease) : undefined)
  const effectiveReplacementEpoch = point?.replacementEpoch ?? pointLease?.replacementEpoch
  const scopedPoint: OrphanRecoveryPoint | undefined = point
    ? {
        ...point,
        ...(effectiveMessageId ? { messageId: effectiveMessageId } : {}),
        ...(effectiveAttemptKind ? { attemptKind: effectiveAttemptKind } : {}),
        ...(effectiveReplacementEpoch !== undefined
          ? { replacementEpoch: effectiveReplacementEpoch }
          : {}),
      }
    : undefined
  const scopedChatId = chatId ?? scopedPoint?.chatId
  const scopedChat = scopedChatId !== undefined ? await repo.getChat(scopedChatId) : undefined
  const scopedPointHeader = scopedPoint?.messageId
    ? await repo.getMessageHeader(scopedPoint.messageId)
    : undefined
  const scopedTargetUnavailable = Boolean(
    scopedPoint &&
      (!scopedChat || (scopedPoint.messageId && scopedPointHeader?.chatId !== scopedPoint.chatId)),
  )
  if (scopedPoint && scopedTargetUnavailable) {
    return (await cleanupUnavailableRecoveryGroup({
      repo,
      point: scopedPoint,
      now,
      replacementEpoch: recoveryReplacementEpoch,
    }))
      ? 1
      : 0
  }
  const pointTerminalPresentation =
    scopedPoint && !pointLease
      ? await pointCanonicalTerminalPresentation(repo, scopedPoint)
      : undefined
  if (scopedPoint && !pointLease && pointTerminalPresentation) {
    await repo.deleteStreamJournal(scopedPoint.streamId, {
      replacementEpoch: scopedPoint.replacementEpoch ?? recoveryReplacementEpoch,
      expectedLeaseMissing: true,
    })
    useChatStore
      .getState()
      .publishCommittedMessageMutation(
        scopedPoint.chatId,
        [],
        pointTerminalPresentation,
        presentationWorkspace,
      )
    announceStreamEnded({
      chatId: scopedPoint.chatId,
      streamId: scopedPoint.streamId,
      ...(scopedPoint.messageId ? { messageId: scopedPoint.messageId } : {}),
      outcome: scopedPoint.outcome ?? 'abort',
      replacementEpoch: scopedPoint.replacementEpoch ?? recoveryReplacementEpoch,
    })
    return 1
  }
  const pointActive = scopedPoint
    ? useStreamStore.getState().getActive(scopedPoint.streamId)
    : undefined
  if (
    scopedPoint &&
    !pointLease &&
    pointActive &&
    (pointActive.phase === 'recovery-pending' || pointActive.phase === 'cleanup-pending') &&
    (pointActive.phase === 'cleanup-pending' ||
      !scopedPoint.messageId ||
      !scopedChat ||
      !scopedPointHeader)
  ) {
    await repo.deleteStreamJournal(scopedPoint.streamId, {
      replacementEpoch: scopedPoint.replacementEpoch ?? recoveryReplacementEpoch,
      expectedLeaseMissing: true,
    })
    announceStreamEnded({
      chatId: scopedPoint.chatId,
      streamId: scopedPoint.streamId,
      outcome: scopedPoint.outcome ?? pointActive.recoveryOutcome ?? 'abort',
      replacementEpoch: scopedPoint.replacementEpoch ?? recoveryReplacementEpoch,
    })
    return 1
  }
  const chats =
    scopedChatId !== undefined ? (scopedChat ? [scopedChat] : []) : await repo.listChats()
  const allLeases = scopedPoint
    ? effectiveMessageId
      ? await repo.listStreamLeasesForMessage(effectiveMessageId)
      : pointLease
        ? [pointLease]
        : []
    : await repo.listStreamLeases(chatId)
  const initialLeaseIndex = indexStreamLeasesForRecovery(allLeases)
  const ownershipLocksSupported = streamOwnershipLocksSupported()
  const leases = allLeases.filter((lease) => isFreshStreamLease(lease, now))
  const leasedMessageIds = new Set(
    ownershipLocksSupported
      ? []
      : leases
          .filter((lease) => lease.messageId !== undefined)
          .filter((lease) => !isRecoveryClaimedStreamLease(lease))
          .filter((lease) => !isLocallyRecoveryPendingStream(lease.streamId))
          .map((lease) => lease.messageId as MessageId),
  )
  let recovered = 0
  const recoveredPresentations = new Map<ChatId, CommittedMessagePresentation[]>()
  const retainRecoveredPresentation = (
    recoveredChatId: ChatId,
    presentation: CommittedMessagePresentation,
  ) => {
    const presentations = recoveredPresentations.get(recoveredChatId)
    if (presentations) presentations.push(presentation)
    else recoveredPresentations.set(recoveredChatId, [presentation])
  }
  const finalizedGenerationTargetIds = new Set<MessageId>()
  if (!scopedTargetUnavailable) {
    for (const [messageId, messageLeases] of initialLeaseIndex.byMessageId) {
      if (!messageLeases.some((lease) => streamLeaseRecoveryKind(lease) === 'generation')) continue
      const header = await repo.getMessageHeader(messageId)
      if (header?.generation?.finishedAt !== undefined) {
        finalizedGenerationTargetIds.add(messageId)
      }
    }
  }
  for (const messageId of finalizedGenerationTargetIds) {
    const initialLeases = initialLeaseIndex.byMessageId.get(messageId) ?? []
    if (
      await cleanupFinalizedGenerationRecoveryGroup({
        repo,
        messageId,
        initialLeases,
        now,
        isTargetActive: isLocallyOwnedTargetActive,
        isRecoveryPending: isLocallyRecoveryPendingStream,
        recoveryOutcome: locallyPendingRecoveryOutcome,
        onRecoveredPresentation: retainRecoveredPresentation,
      })
    ) {
      recovered += 1
    }
  }
  for (const lease of allLeases) {
    if (lease.messageId && finalizedGenerationTargetIds.has(lease.messageId)) continue
    if (
      (!scopedTargetUnavailable && streamLeaseRecoveryKind(lease) !== 'generation') ||
      (isFreshStreamLease(lease, now) &&
        !ownershipLocksSupported &&
        !isRecoveryClaimedStreamLease(lease) &&
        !isLocallyRecoveryPendingStream(lease.streamId)) ||
      (lease.messageId && isLocallyOwnedTargetActive(lease.chatId, lease.messageId))
    ) {
      continue
    }
    const guarded = await withStreamRecoveryLocks([lease.streamId], async (ownershipVerified) => {
      if (lease.messageId && isLocallyOwnedTargetActive(lease.chatId, lease.messageId)) {
        return false
      }
      const currentLease = await repo.getStreamLease(lease.streamId)
      if (
        !currentLease ||
        (isFreshStreamLease(currentLease, now) &&
          !ownershipVerified &&
          !isRecoveryClaimedStreamLease(currentLease) &&
          !isLocallyRecoveryPendingStream(currentLease.streamId))
      ) {
        return false
      }
      let finalizedPresentation: CommittedMessagePresentation | undefined
      if (!scopedTargetUnavailable) {
        const header = currentLease.messageId
          ? await repo.getMessageHeader(currentLease.messageId)
          : undefined
        if (header?.generation && header.generation.finishedAt === undefined) return false
        if (header?.generation?.finishedAt !== undefined) {
          const message = await repo.getMessage(header.id)
          if (message?.chatId === header.chatId && !message.deleted) {
            finalizedPresentation = {
              header,
              message,
              bodyVersion: header.bodyVersion,
            }
          }
        }
      }
      const claimedLease = await repo.claimStreamLeaseForRecovery(currentLease, now)
      if (!claimedLease) return false
      const fence = streamWriteFenceForLease(claimedLease)
      await repo.deleteStreamJournal(claimedLease.streamId, {
        replacementEpoch: fence.replacementEpoch,
        streamFence: fence,
      })
      announceStreamEnded({
        chatId: claimedLease.chatId,
        streamId: claimedLease.streamId,
        ...(claimedLease.messageId ? { messageId: claimedLease.messageId } : {}),
        outcome: locallyPendingRecoveryOutcome(claimedLease.streamId) ?? 'abort',
        replacementEpoch: streamWriteFenceForLease(claimedLease).replacementEpoch,
      })
      if (finalizedPresentation) {
        retainRecoveredPresentation(claimedLease.chatId, finalizedPresentation)
      }
      return true
    })
    if (guarded.acquired && guarded.value) recovered += 1
  }
  recovered += await recoverStaleContinuationAttempts({
    repo,
    leases: allLeases,
    now,
    isTargetActive: isLocallyOwnedTargetActive,
    isRecoveryPending: isLocallyRecoveryPendingStream,
    recoveryOutcome: locallyPendingRecoveryOutcome,
    onRecoveredPresentation: retainRecoveredPresentation,
  })
  for (const chat of chats) {
    const pointHeader = scopedPointHeader
    const headers = scopedPoint
      ? pointHeader
        ? [pointHeader]
        : []
      : await repo.listMessageHeaders(chat.id)
    const unfinishedHeaders = headers.filter((header) => {
      const generation = header.generation
      return Boolean(
        generation && generation.finishedAt === undefined && generation.abortReason === undefined,
      )
    })
    if (unfinishedHeaders.length === 0) continue
    const currentMessageLessGenerationLeases = await repo.listMessageLessGenerationStreamLeases(
      chat.id,
    )
    if (currentMessageLessGenerationLeases.length > 0) continue
    for (const header of unfinishedHeaders) {
      const gen = header.generation as NonNullable<typeof header.generation>
      const observedTarget = useStreamStore.getState().getTargetActive(chat.id, header.id)
      const targetRecoveryPending = observedTarget?.phase === 'recovery-pending'
      if (
        now - gen.startedAt < STREAM_LEASE_TTL_MS &&
        !ownershipLocksSupported &&
        !targetRecoveryPending
      ) {
        continue
      }
      if (isLocallyOwnedTargetActive(chat.id, header.id)) continue
      if (leasedMessageIds.has(header.id)) continue
      const initialChunks = await repo.listStreamChunksForMessage(header.id)
      const initialMessageLeases = initialLeaseIndex.byMessageId.get(header.id) ?? []
      const guardedStreamIds = new Set([
        ...initialChunks.map((chunk) => chunk.streamId),
        ...initialMessageLeases.map((lease) => lease.streamId),
        ...(observedTarget ? [observedTarget.streamId] : []),
      ])
      const guarded = await withStreamRecoveryLocks(
        [...guardedStreamIds],
        async (ownershipVerified) => {
          if (isLocallyOwnedTargetActive(chat.id, header.id)) return false
          const currentTargetHeader = await repo.getMessageHeader(header.id)
          if (
            !currentTargetHeader?.generation ||
            currentTargetHeader.generation.finishedAt !== undefined ||
            currentTargetHeader.generation.abortReason !== undefined
          ) {
            return false
          }
          const currentMessageLeases = await repo.listStreamLeasesForMessage(header.id)
          if (
            currentMessageLeases.some(
              (lease) =>
                !guardedStreamIds.has(lease.streamId) ||
                (isFreshStreamLease(lease, now) &&
                  !ownershipVerified &&
                  !isRecoveryClaimedStreamLease(lease) &&
                  !isLocallyRecoveryPendingStream(lease.streamId)),
            )
          ) {
            return false
          }
          const currentChunks = await repo.listStreamChunksForMessage(header.id)
          if (currentChunks.some((chunk) => !guardedStreamIds.has(chunk.streamId))) return false
          const claimedLeases: StreamLeaseRow[] = []
          for (const currentLease of [...currentMessageLeases].sort((left, right) =>
            left.streamId.localeCompare(right.streamId),
          )) {
            const claimed = await repo.claimStreamLeaseForRecovery(currentLease, now)
            if (!claimed) return false
            claimedLeases.push(claimed)
          }
          const primaryClaim = newestStreamLeaseByAdmission(
            claimedLeases.filter((claimed) => streamLeaseRecoveryKind(claimed) === 'generation'),
          )
          const claimedLeaseByStreamId = new Map(
            claimedLeases.map((claimed) => [claimed.streamId, claimed]),
          )
          const removedSecondaryLeaseIds = new Set<string>()
          for (const claimed of claimedLeases) {
            if (claimed.streamId === primaryClaim?.streamId) continue
            await repo.deleteOwnedStreamLease(claimed.streamId, streamWriteFenceForLease(claimed))
            removedSecondaryLeaseIds.add(claimed.streamId)
          }
          const cleanupGroupJournals = async (anchor?: StreamLeaseRow) => {
            const cleanupStreamIds = [...guardedStreamIds].sort()
            if (anchor && guardedStreamIds.has(anchor.streamId)) {
              const anchorIndex = cleanupStreamIds.indexOf(anchor.streamId)
              cleanupStreamIds.splice(anchorIndex, 1)
              cleanupStreamIds.push(anchor.streamId)
            }
            for (const streamId of cleanupStreamIds) {
              const claimed = claimedLeaseByStreamId.get(streamId)
              const claimedFence = claimed ? streamWriteFenceForLease(claimed) : undefined
              const retainedFence =
                claimed && !removedSecondaryLeaseIds.has(streamId) ? claimedFence : undefined
              await repo.deleteStreamJournal(streamId, {
                replacementEpoch: claimedFence?.replacementEpoch ?? recoveryReplacementEpoch,
                ...(retainedFence
                  ? { streamFence: retainedFence }
                  : { expectedLeaseMissing: true }),
              })
              announceStreamEnded({
                chatId: chat.id,
                streamId,
                messageId: header.id,
                outcome: locallyPendingRecoveryOutcome(streamId) ?? 'abort',
                replacementEpoch: claimedFence?.replacementEpoch ?? recoveryReplacementEpoch,
              })
            }
          }
          if (!primaryClaim) await cleanupGroupJournals()
          const chunks = primaryClaim
            ? currentChunks.filter((chunk) => chunk.streamId === primaryClaim.streamId)
            : []
          const recoveredMutation = await repo.runMutation(
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
                return committedMessagePresentation(ctx, header.id)
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
              return committedMessagePresentation(ctx, header.id)
            },
            primaryClaim
              ? {
                  streamFence: {
                    streamId: primaryClaim.streamId,
                    fence: streamWriteFenceForLease(primaryClaim),
                  },
                }
              : { workspaceFence: { replacementEpoch: recoveryReplacementEpoch } },
          )
          if (recoveredMutation.value) {
            retainRecoveredPresentation(chat.id, recoveredMutation.value)
          }
          if (primaryClaim) await cleanupGroupJournals(primaryClaim)
          return recoveredMutation.value !== undefined
        },
      )
      if (guarded.acquired && guarded.value) recovered += 1
    }
  }
  const chatStore = useChatStore.getState()
  for (const [recoveredChatId, presentations] of recoveredPresentations) {
    chatStore.publishCommittedMessageBatch(recoveredChatId, presentations, presentationWorkspace)
  }
  return recovered
}

async function cleanupUnavailableRecoveryGroup(args: {
  repo: ReturnType<typeof getWorkspaceRepository>
  point: OrphanRecoveryPoint
  now: number
  replacementEpoch: number
}): Promise<boolean> {
  const { messageId } = args.point
  const [unfilteredInitialLeases, unfilteredInitialChunks] = await Promise.all([
    messageId
      ? args.repo.listStreamLeasesForMessage(messageId)
      : args.repo.listStreamLeases(args.point.chatId),
    messageId
      ? args.repo.listStreamChunksForMessage(messageId)
      : args.repo.listStreamChunksForChat(args.point.chatId),
  ])
  const initialLeases = unfilteredInitialLeases.filter(
    (lease) => lease.chatId === args.point.chatId,
  )
  const initialChunks = unfilteredInitialChunks.filter(
    (chunk) => chunk.chatId === args.point.chatId,
  )
  const guardedStreamIds = new Set([
    args.point.streamId,
    ...initialLeases.map((lease) => lease.streamId),
    ...initialChunks.map((chunk) => chunk.streamId),
  ])
  const guarded = await withStreamRecoveryLocks(
    [...guardedStreamIds],
    async (ownershipVerified) => {
      const [currentChat, currentHeader] = await Promise.all([
        args.repo.getChat(args.point.chatId),
        messageId ? args.repo.getMessageHeader(messageId) : Promise.resolve(undefined),
      ])
      if (currentChat && (!messageId || currentHeader?.chatId === args.point.chatId)) return false
      const [unfilteredCurrentLeases, unfilteredCurrentChunks] = await Promise.all([
        messageId
          ? args.repo.listStreamLeasesForMessage(messageId)
          : args.repo.listStreamLeases(args.point.chatId),
        messageId
          ? args.repo.listStreamChunksForMessage(messageId)
          : args.repo.listStreamChunksForChat(args.point.chatId),
      ])
      const currentLeases = unfilteredCurrentLeases.filter(
        (lease) => lease.chatId === args.point.chatId,
      )
      const currentChunks = unfilteredCurrentChunks.filter(
        (chunk) => chunk.chatId === args.point.chatId,
      )
      if (
        currentLeases.some(
          (lease) =>
            !guardedStreamIds.has(lease.streamId) ||
            (isFreshStreamLease(lease, args.now) &&
              !ownershipVerified &&
              !isRecoveryClaimedStreamLease(lease) &&
              !isLocallyRecoveryPendingStream(lease.streamId)),
        ) ||
        currentChunks.some((chunk) => !guardedStreamIds.has(chunk.streamId))
      ) {
        return false
      }
      const claimedLeases: StreamLeaseRow[] = []
      for (const lease of [...currentLeases].sort((left, right) =>
        left.streamId.localeCompare(right.streamId),
      )) {
        const claimed = await args.repo.claimStreamLeaseForRecovery(lease, args.now)
        if (!claimed) return false
        claimedLeases.push(claimed)
      }
      const claimedByStreamId = new Map(claimedLeases.map((lease) => [lease.streamId, lease]))
      const cleanupStreamIds = [...guardedStreamIds].sort()
      const pointIndex = cleanupStreamIds.indexOf(args.point.streamId)
      cleanupStreamIds.splice(pointIndex, 1)
      cleanupStreamIds.push(args.point.streamId)
      for (const streamId of cleanupStreamIds) {
        const claimed = claimedByStreamId.get(streamId)
        const fence = claimed ? streamWriteFenceForLease(claimed) : undefined
        const targetMessageId = claimed?.messageId ?? messageId
        await args.repo.deleteStreamJournal(streamId, {
          replacementEpoch: fence?.replacementEpoch ?? args.replacementEpoch,
          ...(fence ? { streamFence: fence } : { expectedLeaseMissing: true }),
        })
        announceStreamEnded({
          chatId: claimed?.chatId ?? args.point.chatId,
          streamId,
          ...(targetMessageId ? { messageId: targetMessageId } : {}),
          outcome:
            locallyPendingRecoveryOutcome(streamId) ??
            (streamId === args.point.streamId ? args.point.outcome : undefined) ??
            'abort',
          replacementEpoch: fence?.replacementEpoch ?? args.replacementEpoch,
        })
      }
      return true
    },
  )
  return guarded.acquired && guarded.value
}

async function cleanupFinalizedGenerationRecoveryGroup(args: {
  repo: ReturnType<typeof getWorkspaceRepository>
  messageId: MessageId
  initialLeases: readonly StreamLeaseRow[]
  now: number
  isTargetActive: (chatId: ChatId, messageId: MessageId) => boolean
  isRecoveryPending: (streamId: string) => boolean
  recoveryOutcome: (streamId: string) => 'done' | 'error' | 'abort' | undefined
  onRecoveredPresentation: (chatId: ChatId, presentation: CommittedMessagePresentation) => void
}): Promise<boolean> {
  const initialLease = args.initialLeases[0]
  if (!initialLease) return false
  const initialChunks = await args.repo.listStreamChunksForMessage(args.messageId)
  const guardedStreamIds = new Set([
    ...args.initialLeases.map((lease) => lease.streamId),
    ...initialChunks.map((chunk) => chunk.streamId),
  ])
  const guarded = await withStreamRecoveryLocks(
    [...guardedStreamIds],
    async (ownershipVerified) => {
      const currentHeader = await args.repo.getMessageHeader(args.messageId)
      if (currentHeader?.generation?.finishedAt === undefined) return false
      const currentLeases = await args.repo.listStreamLeasesForMessage(args.messageId)
      if (
        currentLeases.some(
          (lease) =>
            !guardedStreamIds.has(lease.streamId) ||
            (isFreshStreamLease(lease, args.now) &&
              !ownershipVerified &&
              !isRecoveryClaimedStreamLease(lease) &&
              !args.isRecoveryPending(lease.streamId)),
        ) ||
        currentLeases.some(
          (lease) =>
            streamLeaseOwnsTargetWrites(lease) && args.isTargetActive(lease.chatId, args.messageId),
        ) ||
        currentLeases.some(
          (lease) =>
            streamLeaseRecoveryKind(lease) === 'continuation' && streamLeaseOwnsTargetWrites(lease),
        )
      ) {
        return false
      }
      const currentChunks = await args.repo.listStreamChunksForMessage(args.messageId)
      if (currentChunks.some((chunk) => !guardedStreamIds.has(chunk.streamId))) return false

      const claimedLeases: StreamLeaseRow[] = []
      for (const currentLease of [...currentLeases].sort((left, right) =>
        left.streamId.localeCompare(right.streamId),
      )) {
        const claimed = await args.repo.claimStreamLeaseForRecovery(currentLease, args.now)
        if (!claimed) return false
        claimedLeases.push(claimed)
      }
      const anchor = newestStreamLeaseByAdmission(
        claimedLeases.filter(
          (lease) =>
            streamLeaseRecoveryKind(lease) === 'generation' && streamLeaseOwnsTargetWrites(lease),
        ),
      )
      if (!anchor) return false
      const anchorFence = streamWriteFenceForLease(anchor)

      const claimedByStreamId = new Map(claimedLeases.map((lease) => [lease.streamId, lease]))
      const removedLeaseIds = new Set<string>()
      for (const claimed of claimedLeases) {
        if (claimed.streamId === anchor.streamId) continue
        await args.repo.deleteOwnedStreamLease(claimed.streamId, streamWriteFenceForLease(claimed))
        removedLeaseIds.add(claimed.streamId)
      }
      const cleanupStreamIds = [...guardedStreamIds].sort()
      const anchorIndex = cleanupStreamIds.indexOf(anchor.streamId)
      cleanupStreamIds.splice(anchorIndex, 1)
      cleanupStreamIds.push(anchor.streamId)
      for (const streamId of cleanupStreamIds) {
        const claimed = claimedByStreamId.get(streamId)
        const claimedFence = claimed ? streamWriteFenceForLease(claimed) : undefined
        const retainedFence = claimed && !removedLeaseIds.has(streamId) ? claimedFence : undefined
        await args.repo.deleteStreamJournal(streamId, {
          replacementEpoch: claimedFence?.replacementEpoch ?? anchorFence.replacementEpoch,
          ...(retainedFence ? { streamFence: retainedFence } : { expectedLeaseMissing: true }),
        })
        announceStreamEnded({
          chatId: claimed?.chatId ?? currentHeader.chatId,
          streamId,
          messageId: claimed?.messageId ?? args.messageId,
          outcome: args.recoveryOutcome(streamId) ?? 'abort',
          replacementEpoch: claimedFence?.replacementEpoch ?? anchorFence.replacementEpoch,
        })
      }
      const message = await args.repo.getMessage(args.messageId)
      if (message && !message.deleted && message.chatId === currentHeader.chatId) {
        args.onRecoveredPresentation(currentHeader.chatId, {
          header: currentHeader,
          message,
          bodyVersion: currentHeader.bodyVersion,
        })
      }
      return true
    },
  )
  return guarded.acquired && guarded.value
}

async function pointCanonicalTerminalPresentation(
  repo: ReturnType<typeof getWorkspaceRepository>,
  point: OrphanRecoveryPoint,
): Promise<CommittedMessagePresentation | undefined> {
  if (!point.messageId) return undefined
  const [header, message] = await Promise.all([
    repo.getMessageHeader(point.messageId),
    repo.getMessage(point.messageId),
  ])
  if (
    !header ||
    !message ||
    header.chatId !== point.chatId ||
    message.chatId !== point.chatId ||
    header.deleted ||
    message.deleted
  ) {
    return undefined
  }
  if (point.attemptKind === 'continuation') {
    if (!message.continuationAttempts?.some((attempt) => attempt.streamId === point.streamId)) {
      return undefined
    }
  } else if (header.generation?.finishedAt === undefined) {
    return undefined
  }
  return { header, message, bodyVersion: header.bodyVersion }
}

export async function nextOrphanRecoveryAt(
  chatId: ChatId,
  now = Date.now(),
): Promise<number | null> {
  const repo = getWorkspaceRepository()
  const leases = await repo.listStreamLeases(chatId)
  let next = Number.POSITIVE_INFINITY
  for (const lease of leases) {
    const active = useStreamStore.getState().getActive(lease.streamId)
    if (
      active?.ownerClientId === getStreamClientId() &&
      active.phase !== 'recovery-pending' &&
      active.phase !== 'cleanup-pending'
    ) {
      continue
    }
    const expiresAt = lease.heartbeatAt + STREAM_LEASE_TTL_MS + 1
    next = Math.min(
      next,
      active?.phase === 'recovery-pending' ||
        active?.phase === 'cleanup-pending' ||
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
  const active = useStreamStore.getState().getTargetActive(chatId, messageId)
  return (
    active?.ownerClientId === getStreamClientId() &&
    active.phase !== 'recovery-pending' &&
    active.phase !== 'cleanup-pending'
  )
}

function isLocallyRecoveryPendingStream(streamId: string): boolean {
  const active = useStreamStore.getState().getActive(streamId)
  return (
    active?.ownerClientId === getStreamClientId() &&
    (active.phase === 'recovery-pending' || active.phase === 'cleanup-pending')
  )
}

function locallyPendingRecoveryOutcome(streamId: string): 'done' | 'error' | 'abort' | undefined {
  const active = useStreamStore.getState().getActive(streamId)
  return active?.phase === 'recovery-pending' || active?.phase === 'cleanup-pending'
    ? active.recoveryOutcome
    : undefined
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
