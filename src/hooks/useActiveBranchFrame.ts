import { useCallback, useEffect, useMemo, useState } from 'react'
import { initialTranscriptWorkBudget } from '../core/transcript-work-budget'
import type { ChatId, MessageId } from '../core/types'
import {
  mostRecentlyAdmittedAttempt,
  useAttemptExecutionsForChat,
} from '../store/attempt-controller'
import {
  conversationController,
  currentConversationDestinationSpine,
} from '../store/conversation-controller'
import type {
  AttemptExecutionRecord,
  ConversationChatSnapshot,
  ConversationTranscriptSurface,
  ConversationTreeSurface,
  WorkspaceFence,
} from '../store/presentation-contracts'
import {
  type ConversationTranscriptDemand,
  useConversationTranscriptDemand,
} from './useConversationFrame'

export interface UseActiveBranchFrameOptions {
  activeChatId: ChatId | null
  frame: ConversationChatSnapshot | null
  workspaceFence: WorkspaceFence
  pinnedMessageId?: MessageId
  initialTranscriptWorkScale: number
}

export function useActiveBranchFrame({
  activeChatId,
  frame,
  workspaceFence,
  pinnedMessageId,
  initialTranscriptWorkScale,
}: UseActiveBranchFrameOptions) {
  const normalizedInitialRowTarget = Math.max(1, Math.floor(initialTranscriptWorkScale))
  const viewportHeight = useViewportHeight()
  const baseBudget = useMemo(
    () => initialTranscriptWorkBudget(normalizedInitialRowTarget, viewportHeight),
    [normalizedInitialRowTarget, viewportHeight],
  )
  const currentSpine = frame ? currentConversationDestinationSpine(frame.destination) : null
  const currentPath = currentSpine?.path ?? null
  const paintedFrame = frame?.presentation.painted ?? null
  const visibleBinding = paintedFrame?.binding ?? null
  const transcriptBinding = frame?.presentation.residents.transcript ?? null
  const treeBinding = frame?.presentation.residents.tree ?? null
  const activeStreams = useAttemptExecutionsForChat(activeChatId)
  const currentPathMessageIds = currentPath?.messageIds
  const activeBranchTailId = currentPath?.leaf?.id ?? null
  const attemptPartitions = useMemo(
    () =>
      partitionAttempts(
        activeStreams,
        workspaceFence,
        currentPathMessageIds,
        activeBranchTailId,
        transcriptBinding,
        treeBinding,
      ),
    [
      activeBranchTailId,
      activeStreams,
      currentPathMessageIds,
      transcriptBinding,
      treeBinding,
      workspaceFence,
    ],
  )
  const currentPathStreams = attemptPartitions.current
  const transcriptStreams = attemptPartitions.transcript
  const treeStreams = attemptPartitions.tree
  const newestSelectedPathStream = useMemo(
    () => mostRecentlyAdmittedAttempt(currentPathStreams),
    [currentPathStreams],
  )
  const newestTranscriptStream = useMemo(
    () => mostRecentlyAdmittedAttempt(transcriptStreams),
    [transcriptStreams],
  )
  const composerStream = useMemo(
    () => mostRecentlyAdmittedAttempt(attemptPartitions.composer),
    [attemptPartitions.composer],
  )
  const transcriptOwnsViewportWork =
    frame?.presentation.request.surface === 'transcript' ||
    (visibleBinding?.seal.chatId === activeChatId && visibleBinding.surface === 'transcript') ||
    transcriptStreams.length > 0
  const resolvedActiveBranchSnapshot = transcriptBinding?.window ?? null
  const transcriptSelectionRevision = frame?.selectionRevision ?? null
  const transcriptSelectionEpoch = frame?.transcriptSelectionEpoch ?? null
  const transcriptDemand = useMemo<ConversationTranscriptDemand | null>(() => {
    if (!transcriptOwnsViewportWork) return null
    if (
      !activeChatId ||
      transcriptSelectionRevision === null ||
      transcriptSelectionEpoch === null
    ) {
      return null
    }
    return Object.freeze({
      chatId: activeChatId,
      selectionRevision: transcriptSelectionRevision,
      selectionEpoch: transcriptSelectionEpoch,
      budget: baseBudget,
    })
  }, [
    activeChatId,
    baseBudget,
    transcriptSelectionEpoch,
    transcriptSelectionRevision,
    transcriptOwnsViewportWork,
  ])
  useConversationTranscriptDemand(transcriptDemand)
  const transcriptBoundaryOffset = resolvedActiveBranchSnapshot?.offset ?? null
  const transcriptLoadFailed =
    frame?.failure?.kind === 'transcript' && frame.failure.code === 'read-failed'
  const acknowledgeActiveRevealRequest = useCallback((request: { revision: string }) => {
    conversationController.consumePresentationReveal(request.revision, 'transcript')
  }, [])
  const loadOlderMessageWindow = useCallback(() => {
    if (
      !activeChatId ||
      transcriptSelectionRevision === null ||
      transcriptSelectionEpoch === null
    ) {
      return
    }
    if (transcriptLoadFailed) {
      conversationController.retryTranscriptDemand({
        chatId: activeChatId,
        selectionRevision: transcriptSelectionRevision,
        selectionEpoch: transcriptSelectionEpoch,
      })
      return
    }
    if (transcriptBoundaryOffset === null) return
    conversationController.expandTranscriptDemand({
      chatId: activeChatId,
      selectionRevision: transcriptSelectionRevision,
      selectionEpoch: transcriptSelectionEpoch,
      boundaryOffset: transcriptBoundaryOffset,
    })
  }, [
    activeChatId,
    transcriptBoundaryOffset,
    transcriptLoadFailed,
    transcriptSelectionEpoch,
    transcriptSelectionRevision,
  ])
  const urlPinnedTargetPending =
    pinnedMessageId !== undefined &&
    (frame === null || frame.selectionTargetId === pinnedMessageId) &&
    !currentPath?.has(pinnedMessageId)
  const selectedPathStreamActive = transcriptStreams.length > 0
  const transcriptPresentationOnly =
    transcriptBinding === null ||
    transcriptBinding.currency !== 'current' ||
    visibleBinding !== transcriptBinding
  const activeTranscriptExists =
    (currentPath?.length ?? 0) > 0 ||
    frame?.chat?.lastUpdatedLeafId != null ||
    (resolvedActiveBranchSnapshot?.branchLength ?? 0) > 0
  const transcriptReveal =
    visibleBinding?.surface === 'transcript' && visibleBinding.currency === 'current'
      ? visibleBinding.reveal
      : null
  const activeRevealRequest = transcriptReveal
    ? {
        chatId: transcriptReveal.chatId,
        revision: transcriptReveal.id,
        targetMessageId: transcriptReveal.targetMessageId,
      }
    : null

  return {
    visibleBinding,
    paintedChat: paintedFrame?.chat ?? null,
    transcriptBinding,
    treeBinding,
    activeSpine: currentSpine,
    activePath: currentPath,
    activeBranchTailId,
    resolvedActiveBranchSnapshot,
    transcriptStreams,
    treeStreams,
    selectedPathStreamActive,
    newestTranscriptStream,
    newestSelectedPathStream,
    composerStream,
    keyboardStopAttempt: newestSelectedPathStream,
    transcriptPresentationOnly,
    activeTranscriptExists,
    activeRevealRequest,
    acknowledgeActiveRevealRequest,
    urlPinnedTargetPending,
    transcriptLoadFailed,
    loadOlderMessageWindow,
  }
}

function partitionAttempts(
  attempts: ReturnType<typeof useAttemptExecutionsForChat>,
  workspaceFence: WorkspaceFence,
  currentPathMessageIds: ReadonlySet<MessageId> | undefined,
  currentTailId: MessageId | null,
  transcriptBinding: ConversationTranscriptSurface | null,
  treeBinding: ConversationTreeSurface | null,
) {
  const current: AttemptExecutionRecord[] = []
  const composer: AttemptExecutionRecord[] = []
  const transcript: AttemptExecutionRecord[] = []
  const tree: AttemptExecutionRecord[] = []
  for (const attempt of attempts) {
    const messageId = attempt.messageId
    if (
      attempt.workspaceId === workspaceFence.workspaceId &&
      attempt.replacementEpoch === workspaceFence.replacementEpoch &&
      currentPathMessageIds?.has(messageId) === true
    ) {
      current.push(attempt)
      if (messageId === currentTailId) composer.push(attempt)
    }
    if (attemptMatchesBinding(attempt, messageId, transcriptBinding)) transcript.push(attempt)
    if (attemptMatchesBinding(attempt, messageId, treeBinding)) tree.push(attempt)
  }
  return Object.freeze({
    current: Object.freeze(current),
    composer: Object.freeze(composer),
    transcript: Object.freeze(transcript),
    tree: Object.freeze(tree),
  })
}

function attemptMatchesBinding(
  attempt: ReturnType<typeof useAttemptExecutionsForChat>[number],
  messageId: MessageId,
  binding: ConversationTranscriptSurface | ConversationTreeSurface | null,
): boolean {
  if (
    !binding ||
    attempt.workspaceId !== binding.seal.workspaceId ||
    attempt.replacementEpoch !== binding.seal.replacementEpoch ||
    attempt.chatId !== binding.seal.chatId
  ) {
    return false
  }
  return binding.surface === 'transcript'
    ? binding.spine.path.has(messageId)
    : binding.topology.byId.has(messageId)
}

function useViewportHeight(): number {
  const [height, setHeight] = useState(readViewportHeight)
  useEffect(() => {
    if (typeof window === 'undefined') return
    let frame: number | null = null
    const update = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = null
        setHeight(readViewportHeight())
      })
    }
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
    }
  }, [])
  return height
}

function readViewportHeight(): number {
  return typeof window === 'undefined'
    ? 800
    : Math.max(1, Math.floor(window.visualViewport?.height ?? window.innerHeight))
}
