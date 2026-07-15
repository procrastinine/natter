// Continue supports two request strategies. Default continue keeps the existing
// assistant row and appends tokens to it, driven by a system-prompt instruction
// to the model. Continue-prefill instead sends the existing assistant row as the
// final assistant prefix on the wire, still appending the returned continuation
// into that same stored row.
//
// The existing assistant's generation metadata (model, usage, cost,
// reasoningDetails, responsesEchoItem) is NEVER touched: those fields
// are factual records of the original turn. Continuation provenance is
// stored separately in the message's cold attempt history.

import {
  type AssistantDispatchPlan,
  type AssistantStreamChunk,
  openAssistantRequestStream,
} from '../api/assistant-stream'
import { activePath, cursorKeyOf } from '../core/active-path'
import { buildContinuationAttempt } from '../core/continuation-attempt'
import { appendContinuationText } from '../core/continuation-content'
import { resolveContinueSystemPromptTemplate } from '../core/continue-prompts'
import { createCursorOverlay, createNonConflictingCursorPathGuard } from '../core/cursor-overlay'
import {
  CONTINUE_GENERATION_ATTEMPT_ERROR_POLICY,
  runGenerationAttempt,
} from '../core/generation-attempt-runner'
import { readGlobalPreferences } from '../core/global-settings'
import { prefillClassFor } from '../core/quirks'
import {
  type AssistantRequestPlan,
  NoEligibleProvidersError,
  prepareAssistantRequestPlan,
} from '../core/send-planning'
import {
  createStreamAccumulator,
  projectStreamAccumulatorLiveContent,
  streamAccumulatorText,
} from '../core/stream-accumulator'
// `globalPrefs` is still read for token-calibration mode; continue prompts
// moved to `chat.settings` in the prompt-preset refactor.
import { calibrationFieldsForEdit, readTokenCalibrationGlobal } from '../core/token-calibration'
import type {
  Chat,
  ChatId,
  ChatSettings,
  ConnectionProfile,
  ContentItem,
  Message,
  MessageId,
} from '../core/types'
import { raceWithAbortSignal } from '../lib/abort'
import { newId } from '../lib/ulid'
import {
  type ConnectionRuntimeKeyCandidate,
  primeConnectionRuntimeKeyCandidates,
} from '../store/connection-runtime'
import { splitMessageForStorage } from '../store/message-storage'
import {
  assertSendContextFresh,
  createSendContextGuard,
  linearizeSendContextGuard,
  loadChatHeaderSnapshot,
  loadSendContextForBranch,
} from '../store/send-context'
import { createStreamChunkWriter } from '../store/stream-chunk-writer'
import { announceStreamEnded } from '../store/stream-leases'
import { getWorkspaceRepository } from '../store/workspace-repository'
import { announceGenerationOutcome } from '../store/zustand/announcementStore'
import type {
  CommittedMessagePresentation,
  CommittedPathProducer,
  NavigationIntent,
} from '../store/zustand/chatStore'
import { useChatStore } from '../store/zustand/chatStore'
import { useStreamStore } from '../store/zustand/streamStore'
import { useUiStore } from '../store/zustand/uiStore'
import { markLifecycleTarget, startRequestLifecycle } from './requestLifecycle'

const retainedRequestPlansForTests = import.meta.env.DEV
  ? new Set<AssistantRequestPlan>()
  : undefined

export function __retainedContinueRequestPlanCountForTests(): number | undefined {
  return retainedRequestPlansForTests?.size
}

interface ContinueInPlaceInput {
  chatId: ChatId
  targetMessageId: MessageId
  navigationIntent?: NavigationIntent
  committedPathProducer?: CommittedPathProducer
  connection: ConnectionProfile
  apiKey: string
  apiKeyCandidates?: readonly ConnectionRuntimeKeyCandidate[]
  now?: () => number
  signal?: AbortSignal
  openStream?: (input: {
    connection: ConnectionProfile
    apiKey: string
    wireBody: Record<string, unknown>
    signal: AbortSignal
    route?: AssistantRequestPlan['route']
    geminiModelId?: string
  }) => AsyncIterable<AssistantStreamChunk>
}

function throwWithZeroEligibleUi(chatId: ChatId, err: unknown): never {
  if (err instanceof NoEligibleProvidersError) {
    useUiStore.getState().setZeroEligibleChatId(chatId)
  }
  throw err
}

function devOnlyOpenStreamOverride(
  openStream: ContinueInPlaceInput['openStream'],
): ContinueInPlaceInput['openStream'] {
  if (!openStream) return undefined
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV !== true) {
    throw new Error('openStream override is dev-only; production sends must use assistant-stream')
  }
  return openStream
}

export async function continueAssistantInPlace(input: ContinueInPlaceInput): Promise<void> {
  const now = input.now ?? Date.now
  const repo = getWorkspaceRepository()
  const chatStore = useChatStore.getState()
  const navigationIntent = input.navigationIntent ?? chatStore.beginNavigationIntent(input.chatId)
  const committedPathProducer =
    input.committedPathProducer ??
    chatStore.registerCommittedPathProducer(input.chatId, navigationIntent)
  if (!committedPathProducer) throw new Error('continue: navigation was superseded')
  let lifecycle: Awaited<ReturnType<typeof startRequestLifecycle>> | undefined
  let lifecycleOutcome: 'done' | 'error' | 'abort' = 'error'
  const attemptState = { canonicalAnnounced: false, canonicalFinalized: false, started: false }
  let target: Message | undefined
  try {
    const requestLifecycle = await startRequestLifecycle({
      chatId: input.chatId,
      streamId: newId(),
      messageId: input.targetMessageId,
      attemptKind: 'continuation',
      originNavigationRevision: navigationIntent.revision,
      ...(input.signal ? { userSignal: input.signal } : {}),
    })
    lifecycle = requestLifecycle
    let headerSnapshot: Awaited<ReturnType<typeof loadChatHeaderSnapshot>> | undefined =
      await loadChatHeaderSnapshot(input.chatId)
    let chat: Chat | undefined = headerSnapshot.chat
    const allHeaders = headerSnapshot.allHeaders
    headerSnapshot = undefined
    const byId = new Map(allHeaders.map((header) => [header.id, header]))
    const targetHeader = byId.get(input.targetMessageId)
    if (!targetHeader || targetHeader.chatId !== input.chatId || targetHeader.deleted) {
      throw new Error(`continue: target ${input.targetMessageId} unavailable`)
    }
    if (targetHeader.role !== 'assistant') {
      throw new Error('continue: target must be an assistant message')
    }
    const activeTargetSnapshot = await repo.getMessagePresentationSnapshot(input.targetMessageId)
    const activeTarget = activeTargetSnapshot?.message
    if (!activeTarget || activeTarget.chatId !== input.chatId || activeTarget.deleted) {
      throw new Error(`continue: target ${input.targetMessageId} unavailable`)
    }
    const { header: activeTargetHeader } = splitMessageForStorage(activeTarget, {
      bodyVersion: activeTargetSnapshot.bodyVersion,
      requestContextVersion: targetHeader.requestContextVersion,
    })
    target = activeTarget

    const baseCursor = useChatStore.getState().getCursor(input.chatId) ?? {}
    const activePathHeaders = activePath(allHeaders as unknown as Message[], baseCursor).map(
      (message) =>
        message.id === activeTarget.id
          ? activeTargetHeader
          : (message as unknown as (typeof allHeaders)[number]),
    )
    if (activePathHeaders.some((header) => header.id === activeTarget.id)) {
      useChatStore
        .getState()
        .selectCommittedPathForProducer(
          input.chatId,
          committedPathProducer,
          Object.fromEntries(
            activePathHeaders.map((header) => [cursorKeyOf(header.parentId), header.id] as const),
          ),
          {
            phase: 'open',
            pathHeaders: activePathHeaders,
            presentations: [
              {
                header: activeTargetHeader,
                message: activeTarget,
                bodyVersion: activeTargetHeader.bodyVersion,
              },
            ],
          },
        )
    }
    // Pin the cursor so the active-path walk ends at the target. Without
    // this, a fresh chat (no cursor) might resolve a different leaf.
    const cursor = createCursorOverlay(baseCursor)
    const targetPathSelections: [string, MessageId][] = []
    let cur: (typeof allHeaders)[number] | undefined = targetHeader
    while (cur) {
      const key = cursorKeyOf(cur.parentId)
      cursor[key] = cur.id
      targetPathSelections.push([key, cur.id])
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    const storedPath = activePath(allHeaders as unknown as Message[], cursor).map(
      (message) => message as unknown as (typeof allHeaders)[number],
    )
    // Truncate the path at the target so downstream descendants that
    // happen to share siblingIndex 0 are excluded.
    const targetIdx = storedPath.findIndex((message) => message.id === activeTarget.id)
    const storedUpstream = targetIdx >= 0 ? storedPath.slice(0, targetIdx + 1) : storedPath
    const upstream = storedUpstream.map((header) =>
      header.id === activeTarget.id ? activeTargetHeader : header,
    )
    const sendContextGuard = createSendContextGuard(chat, storedUpstream)

    // Build the wire body as if sending a request that ends with
    // the target assistant. Continue has two independent per-chat prompt slots
    // (stored on chat.settings, preset-pinnable): a system override (which
    // replaces the chat system prompt when non-empty) and a synthetic trailing
    // user prompt (which avoids the double-assistant shape when non-empty).
    // Either can be blank.
    const [{ tokenCalibrationMode }, globalCalibration] = await Promise.all([
      readGlobalPreferences(),
      readTokenCalibrationGlobal(),
    ])
    // Two continue strategies:
    //
    //   continuePrefill = true → real prefill turn. Don't override the system
    //     prompt; don't append a synthetic continue-user turn. Just walk the
    //     active path up through the target and mark the target as
    //     `origin: 'prefill'` so the wire transform applies the trailing-
    //     whitespace trim and treats the assistant content as the prefix the
    //     model continues from. Hidden continue prompts (continueSystemPrompt /
    //     continueUserPrompt) are unused.
    //
    //   continuePrefill = false → legacy continue-prompt mode (kept for
    //     compat / models where prefill is unsupported). System prompt is
    //     swapped for the continue-system template; the synthetic
    //     continue-user trailing turn (if non-empty) avoids the double-
    //     assistant shape.
    const usePrefillContinue =
      chat.settings.continuePrefill === true &&
      prefillClassFor(chat.settings.model) !== 'unsupported'
    let continueUserPrompt = chat.settings.continueUserPrompt
    let settingsForContinue: ChatSettings | undefined = usePrefillContinue
      ? chat.settings
      : {
          ...chat.settings,
          systemPrompt: resolveContinueSystemPromptTemplate(
            chat.settings.continueSystemPrompt,
            chat.settings.systemPrompt,
          ),
        }
    let continuePath: Message[]
    let pendingMessages: Message[]
    let preCutAttachmentIds: string[]
    const mapHydratedMessage = usePrefillContinue
      ? (message: Message): Message =>
          message.id === activeTarget.id ? { ...message, origin: 'prefill' } : message
      : undefined
    if (usePrefillContinue) {
      const sendContext = await loadSendContextForBranch({
        chat,
        branchHeaders: upstream,
        settings: settingsForContinue,
        ...(mapHydratedMessage ? { mapHydratedMessage } : {}),
      })
      continuePath = sendContext.pathMessages
      preCutAttachmentIds = sendContext.preCutAttachmentIds
    } else {
      pendingMessages =
        continueUserPrompt.trim().length > 0
          ? [
              {
                id: `continue-user:${activeTarget.id}`,
                chatId: input.chatId,
                parentId: activeTarget.id,
                siblingIndex: 0,
                turnId: `continue-user:${activeTarget.turnId}`,
                turnIndex: 0,
                createdAt: activeTarget.createdAt,
                role: 'user' as const,
                origin: 'user' as const,
                content: [{ type: 'text' as const, text: continueUserPrompt }],
                nodeVersion: 0,
                deleted: false,
              },
            ]
          : []
      const sendContext = await loadSendContextForBranch({
        chat,
        branchHeaders: upstream,
        settings: settingsForContinue,
        pendingMessages,
      })
      continuePath = sendContext.pathMessages
      preCutAttachmentIds = sendContext.preCutAttachmentIds
    }
    let requestPlan: AssistantRequestPlan | undefined = await prepareAssistantRequestPlan({
      chat,
      connection: input.connection,
      pathMessages: continuePath,
      preCutAttachmentIds,
      settings: settingsForContinue,
      draftText: '',
      debugSource: 'continue',
      signal: lifecycle.signal,
    })
      .then((prepared) => prepared.requestPlan)
      .catch((err) => throwWithZeroEligibleUi(input.chatId, err))
    const { route, geminiModelId, requestedModel, apiUsed, hasAttachmentContext } = requestPlan
    const dispatchPlan: AssistantDispatchPlan = {
      useTextProtocol: requestPlan.useTextProtocol,
      route,
      requestedModel,
      wire: requestPlan.wire,
      ...(geminiModelId ? { geminiModelId } : {}),
    }
    const chatModel = chat.settings.model
    const calibrationChat = { tokenCalibration: chat.tokenCalibration }
    retainedRequestPlansForTests?.add(requestPlan)
    requestPlan.outboundPath = []
    requestPlan.wire = {}
    retainedRequestPlansForTests?.delete(requestPlan)
    requestPlan = undefined
    settingsForContinue = undefined
    continueUserPrompt = ''
    continuePath = []
    pendingMessages = []
    preCutAttachmentIds = []
    chat = undefined

    const [apiKeyCandidates] = await Promise.all([
      primeConnectionRuntimeKeyCandidates(input.apiKeyCandidates, requestLifecycle.signal),
      raceWithAbortSignal(() => assertSendContextFresh(sendContextGuard), requestLifecycle.signal),
    ])
    if (requestLifecycle.signal.aborted) throw new DOMException('Request aborted.', 'AbortError')

    const streamId = lifecycle.streamId
    const strategy = usePrefillContinue ? 'prefill' : 'prompt'
    const startedAt = now()

    const baseTextLength = textLengthOf(activeTarget.content)
    const accumulator = createStreamAccumulator({
      initialContent: activeTarget.content,
      now: startedAt,
    })
    const openStream =
      devOnlyOpenStreamOverride(input.openStream) ??
      ((open) =>
        openAssistantRequestStream({
          connection: open.connection,
          apiKey: open.apiKey,
          ...(apiKeyCandidates ? { apiKeyCandidates } : {}),
          requestPlan: dispatchPlan,
          signal: open.signal,
        }))
    const livePathGuard = createNonConflictingCursorPathGuard(targetPathSelections)

    const prepareLiveSnapshot = (publishedAt: number) => {
      if (useUiStore.getState().activeChatId !== input.chatId) return undefined
      const preparedCursor = useChatStore.getState().getCursor(input.chatId)
      if (!livePathGuard.matches(preparedCursor)) return undefined
      const snapshot = {
        streamId,
        chatId: input.chatId,
        messageId: activeTarget.id,
        replacementEpoch: requestLifecycle.replacementEpoch,
        content: projectStreamAccumulatorLiveContent(accumulator),
        textLength: baseTextLength + accumulator.textLength,
        reasoningLength: 0,
        updatedAt: publishedAt,
      }
      return () => {
        if (useUiStore.getState().activeChatId !== input.chatId) return
        const currentCursor = useChatStore.getState().getCursor(input.chatId)
        if (!livePathGuard.matches(currentCursor)) return
        useStreamStore.getState().setLiveSnapshot(snapshot)
      }
    }

    const streamFence = await markLifecycleTarget({
      chatId: input.chatId,
      streamId,
      messageId: activeTarget.id,
      abort: requestLifecycle.abort,
      attemptKind: 'continuation',
      continuationStrategy: strategy,
      baseBodyVersion: activeTargetHeader.bodyVersion,
      requestedModel,
      apiUsed,
      replacementEpoch: requestLifecycle.replacementEpoch,
    })
    const journal = createStreamChunkWriter({
      port: repo,
      chatId: input.chatId,
      streamId,
      messageId: activeTarget.id,
      now: startedAt,
      fence: streamFence,
    })
    attemptState.started = true
    const result = await runGenerationAttempt({
      open: () => {
        const source = openStream({
          connection: input.connection,
          apiKey: input.apiKey,
          wireBody: dispatchPlan.wire,
          signal: requestLifecycle.signal,
          ...(route ? { route } : {}),
          ...(geminiModelId ? { geminiModelId } : {}),
        })
        dispatchPlan.wire = {}
        return source
      },
      beforeDispatch: () =>
        linearizeSendContextGuard(sendContextGuard, {
          streamFence: { streamId, fence: streamFence },
        }),
      ...(route?.transport ? { transportHint: route.transport } : {}),
      accumulator,
      journal,
      errorPolicy: CONTINUE_GENERATION_ATTEMPT_ERROR_POLICY,
      now,
      signal: requestLifecycle.signal,
      isAborted: () => requestLifecycle.signal.aborted,
      prepareLive: ({ now: publishedAt }) => prepareLiveSnapshot(publishedAt),
      finalize: async (attemptResult) => {
        const finishedAt = now()
        const continuationAttempt = buildContinuationAttempt({
          streamId,
          strategy,
          status: attemptResult.outcome,
          requestedModel,
          apiUsed,
          startedAt,
          finishedAt,
          accumulator,
          ...(attemptResult.abortReason ? { abortReason: attemptResult.abortReason } : {}),
          ...(attemptResult.error ? { error: attemptResult.error } : {}),
        })
        const continuationText = streamAccumulatorText(accumulator)
        const terminalMutation = await repo.runMutation(
          [{ kind: 'message', messageId: activeTarget.id }],
          async (ctx) => {
            const current = await ctx.getMessage(activeTarget.id)
            if (!current) throw new Error(`ContinueMessageMissing:${activeTarget.id}`)
            const nextContent = appendContinuationText(current.content, continuationText)
            const calibrationPatch =
              chatModel && !hasAttachmentContext
                ? calibrationFieldsForEdit(
                    nextContent,
                    current.originalCharCount,
                    current.originalModelId,
                    current.originalCalibrationKey,
                    chatModel,
                    calibrationChat,
                    globalCalibration,
                    tokenCalibrationMode,
                  )
                : null
            await ctx.putMessage({
              ...current,
              content: nextContent,
              continuationAttempts: [
                ...(current.continuationAttempts ?? []).filter(
                  (attempt) => attempt.streamId !== streamId,
                ),
                continuationAttempt,
              ],
              ...(calibrationPatch ?? {}),
            })
            const [header, message] = await Promise.all([
              ctx.getMessageHeader(activeTarget.id),
              ctx.getMessage(activeTarget.id),
            ])
            if (!header || !message) {
              throw new Error(`CommittedMessagePresentationMissing:${activeTarget.id}`)
            }
            return {
              header,
              message,
              bodyVersion: header.bodyVersion,
            } satisfies CommittedMessagePresentation
          },
          { streamFence: { streamId, fence: streamFence } },
        )
        const terminalPresentation = terminalMutation.value
        useChatStore
          .getState()
          .updateCommittedMessageForProducer(
            input.chatId,
            committedPathProducer,
            terminalPresentation,
            'terminal',
          )
        attemptState.canonicalFinalized = true
      },
      onCanonicalCommitted: (attemptResult) => {
        attemptState.canonicalAnnounced = true
        announceGenerationOutcome(streamId, attemptResult.outcome)
        announceStreamEnded({
          chatId: input.chatId,
          streamId,
          messageId: activeTarget.id,
          outcome: attemptResult.outcome,
          replacementEpoch: streamFence.replacementEpoch,
        })
      },
      cleanupJournal: () => repo.deleteStreamChunks(streamId, streamFence),
      cleanup: (attemptResult) => {
        if (attemptResult.journalCleanupPending) requestLifecycle.preserveLease()
        if (!attemptState.canonicalAnnounced) {
          announceGenerationOutcome(streamId, attemptResult.outcome)
          announceStreamEnded({
            chatId: input.chatId,
            streamId,
            messageId: activeTarget.id,
            outcome: attemptResult.outcome,
            replacementEpoch: streamFence.replacementEpoch,
          })
        }
      },
    })
    lifecycleOutcome = result.outcome
  } catch (error) {
    useChatStore.getState().sealCommittedPathProducer(input.chatId, committedPathProducer)
    if (attemptState.started && !attemptState.canonicalFinalized) lifecycle?.preserveLease()
    throw error
  } finally {
    if (
      lifecycle &&
      useStreamStore.getState().getActive(lifecycle.streamId)?.replacementEpoch ===
        lifecycle.replacementEpoch
    ) {
      announceStreamEnded({
        chatId: input.chatId,
        streamId: lifecycle.streamId,
        ...(target ? { messageId: target.id } : {}),
        outcome: lifecycleOutcome,
        replacementEpoch: lifecycle.replacementEpoch,
      })
    }
    if (lifecycle) await lifecycle.end(lifecycleOutcome)
  }
}

function textLengthOf(content: readonly ContentItem[]): number {
  let length = 0
  for (const item of content) {
    if (item.type === 'text' || item.type === 'output_text') length += item.text.length
  }
  return length
}
