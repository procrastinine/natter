import {
  Component,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ConversationDeleteMode } from '../../app/conversation-actions'
import type {
  ConversationMutationSettlement,
  GenerationSubmission,
} from '../../app/presentation-interactions'
import type { ChatSettingsPatch } from '../../core/chat-metadata'
import {
  createAppliedMessageView,
  projectAppliedMessageReasoningPresentation,
} from '../../core/continuation-content'
import type { LongMessageDisplayMode } from '../../core/global-settings'
import { plaintextOf } from '../../core/message-content'
import { messageReasoningVisibility } from '../../core/reasoning'
import { detectStaleReasoning, staleReasoningBannerText } from '../../core/stale-reasoning'
import type {
  ChatId,
  MessageAttachmentRef,
  Message as MessageRow,
  ProviderOutputMemberRef,
  ReasoningMemberRef,
} from '../../core/types'
import { useMessageStreamProjection } from '../../hooks/useMessageStreamProjection'
import type {
  MessageAttachmentRefMutation,
  WorkspaceFence,
} from '../../store/presentation-contracts'
import { useToastStore } from '../../store/zustand/toastStore'
import { useUiStore } from '../../store/zustand/uiStore'
import { AttachmentRefChips } from '../attachments/AttachmentRefChips'
import { Button } from '../primitives/Button'
import { BranchControls, type BranchNavigationContext } from './BranchControls'
import { InlineEditor } from './InlineEditor'
import { PROGRESSIVE_STATIC_MARKDOWN_CHARS } from './MarkdownView'
import { type InsertSlot, MessageActions, MessageEditTreeActions } from './MessageActions'
import { MessageContent, messageTextSegmentsFromContent } from './MessageContent'
import { MessageHeader } from './MessageHeader'
import { MessageInfo } from './MessageInfo'
import {
  collapseProfileFor,
  type MessageCollapseMode,
  nextCollapseMode,
} from './MessageStreamOverflow'
import { ProfileGlyph } from './ProfileGlyph'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolEvidenceBlock } from './ToolEvidenceBlock'

interface MessageProps {
  chatId: ChatId
  message: MessageRow
  bodyVersion: number
  bodyExact?: boolean
  branchContext?: BranchNavigationContext
  generationSubmissionPending?: boolean
  structuralMutationPending?: boolean
  onCancelStructuralMutation?: () => void
  presentationOnly?: boolean
  presentationFence: WorkspaceFence
  // Whether this message sits immediately before a message of the same role
  // on the active path — surfaces the adjacency-warning badge (§10.6).
  roleMismatch?: boolean
  // Whether this message is the user message directly before a visible
  // assistant reply that the user just edited in this session — surfaces
  // the "stale reply?" hint under the NEXT assistant (§10.6 Edit action).
  staleReplyHint?: boolean
  // When true, this message is being trimmed out of the outgoing request
  // by the current context-truncation settings. The profile glyph picks
  // up a dashed ring to surface the exclusion visually.
  excludedFromContext?: boolean
  // Structural op handlers. Threaded from the list so `<Message>` can stay
  // presentational except for its own edit-swap state.
  onBeginEdit: (
    presentationFence: WorkspaceFence,
    message: MessageRow,
  ) => {
    readonly admitted: Promise<void>
    release(): void
  }
  onEditInPlace: (message: MessageRow, text: string) => ConversationMutationSettlement
  onToggleContextVisibility?: (message: MessageRow) => ConversationMutationSettlement
  onDismissGenerationNotice?: (message: MessageRow) => ConversationMutationSettlement
  onMutateAttachmentRef?: (
    message: MessageRow,
    mutation: MessageAttachmentRefMutation,
  ) => Promise<void>
  onToggleReasoningDetailHidden?: (
    message: MessageRow,
    member: ReasoningMemberRef,
  ) => ConversationMutationSettlement
  onToggleProviderOutputItemHidden?: (
    message: MessageRow,
    member: ProviderOutputMemberRef,
  ) => ConversationMutationSettlement
  onEditAndSend?: (
    message: MessageRow,
    text: string,
    opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
  ) => GenerationSubmission
  onRegenerate?: (
    message: MessageRow,
    options?: { settingsPatch?: ChatSettingsPatch },
  ) => GenerationSubmission
  onContinue?: (message: MessageRow) => GenerationSubmission
  onForkChat?: (message: MessageRow) => ConversationMutationSettlement
  onDeleteMessage: (
    message: MessageRow,
    mode: ConversationDeleteMode,
    roleMismatch?: boolean,
  ) => ConversationMutationSettlement
  onInsert?: (message: MessageRow, slot: InsertSlot) => void
  // Prefill UI plumbing — passes through to InlineEditor's Save & Send.
  // `showPrefillButton` is true only when the chat's model class is not
  // `unsupported`. `defaultPrefill` seeds the textarea on toggle-open.
  showPrefillButton?: boolean
  defaultPrefill?: string
  prefillSettingsPrompt?: ReactNode
  longMessageDisplayMode?: LongMessageDisplayMode
}

let messageRenderProbe: ((messageId: string) => void) | undefined

export function __setMessageRenderProbeForTests(
  probe: ((messageId: string) => void) | undefined,
): void {
  messageRenderProbe = probe
}

// Memoized — the markdown render path (Streamdown + Shiki + KaTeX) is
// expensive, and parents (Shell) re-render on any global-prefs change.
// Without memo, every theme/sendShortcut/chatMaxWidth change cascades a
// markdown re-render of every visible message, which is the perf cost
// the user noticed when picking dropdowns in Settings.
export const Message = memo(
  function Message(props: MessageProps) {
    return (
      <MessageErrorBoundary messageId={props.message.id}>
        <MessageInner {...props} />
      </MessageErrorBoundary>
    )
  },
  (prev, next) =>
    prev.message === next.message &&
    prev.bodyVersion === next.bodyVersion &&
    prev.bodyExact === next.bodyExact &&
    prev.branchContext === next.branchContext &&
    prev.generationSubmissionPending === next.generationSubmissionPending &&
    prev.structuralMutationPending === next.structuralMutationPending &&
    prev.onCancelStructuralMutation === next.onCancelStructuralMutation &&
    prev.presentationOnly === next.presentationOnly &&
    prev.presentationFence === next.presentationFence &&
    prev.roleMismatch === next.roleMismatch &&
    prev.staleReplyHint === next.staleReplyHint &&
    prev.excludedFromContext === next.excludedFromContext &&
    prev.onBeginEdit === next.onBeginEdit &&
    prev.onEditInPlace === next.onEditInPlace &&
    prev.onToggleContextVisibility === next.onToggleContextVisibility &&
    prev.onDismissGenerationNotice === next.onDismissGenerationNotice &&
    prev.onMutateAttachmentRef === next.onMutateAttachmentRef &&
    prev.onToggleReasoningDetailHidden === next.onToggleReasoningDetailHidden &&
    prev.onToggleProviderOutputItemHidden === next.onToggleProviderOutputItemHidden &&
    prev.onEditAndSend === next.onEditAndSend &&
    prev.onRegenerate === next.onRegenerate &&
    prev.onContinue === next.onContinue &&
    prev.onForkChat === next.onForkChat &&
    prev.onDeleteMessage === next.onDeleteMessage &&
    prev.onInsert === next.onInsert &&
    prev.showPrefillButton === next.showPrefillButton &&
    prev.defaultPrefill === next.defaultPrefill &&
    prev.prefillSettingsPrompt === next.prefillSettingsPrompt &&
    prev.longMessageDisplayMode === next.longMessageDisplayMode,
)

function MessageInner({
  chatId,
  message,
  bodyVersion,
  bodyExact = true,
  branchContext,
  generationSubmissionPending = false,
  structuralMutationPending = false,
  onCancelStructuralMutation,
  presentationOnly = false,
  presentationFence,
  roleMismatch,
  staleReplyHint,
  excludedFromContext,
  onBeginEdit,
  onEditInPlace,
  onToggleContextVisibility,
  onDismissGenerationNotice,
  onMutateAttachmentRef,
  onToggleReasoningDetailHidden,
  onToggleProviderOutputItemHidden,
  onEditAndSend,
  onRegenerate,
  onContinue,
  onForkChat,
  onDeleteMessage,
  onInsert,
  showPrefillButton,
  defaultPrefill,
  prefillSettingsPrompt,
  longMessageDisplayMode = 'full',
}: MessageProps) {
  messageRenderProbe?.(message.id)
  const bodyMutationUnavailable = presentationOnly || !bodyExact
  const [showInfo, setShowInfo] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editSessionReady, setEditSessionReady] = useState(false)
  const editSessionRef = useRef<{
    readonly identity: string
    readonly fenceIdentity: string
    readonly admitted: Promise<void>
    release(): void
  } | null>(null)
  const editIdentity = `${presentationFence.workspaceId}:${chatId}:${message.id}`
  const editFenceIdentity = `${presentationFence.workspaceId}:${presentationFence.replacementEpoch}`
  const appliedView = useMemo(() => createAppliedMessageView(message), [message])
  const projectionEnabled = message.role === 'assistant'
  const streamProjection = useMessageStreamProjection(message, presentationFence, projectionEnabled)
  const activeAttempt = streamProjection.execution
  const availability = activeAttempt?.availability
  const liveSnapshot = streamProjection.liveProjection
  const streamTargetBusy = availability !== undefined && availability.presentation !== 'none'
  const activeStreamingPresentation =
    availability !== undefined && availability.presentation !== 'none'
  const liveRendering =
    activeStreamingPresentation ||
    liveSnapshot !== undefined ||
    streamProjection.presentation !== undefined

  const endEditing = useCallback(() => {
    editSessionRef.current?.release()
    editSessionRef.current = null
    setEditSessionReady(false)
    setEditing(false)
  }, [])
  const ownEditSession = useCallback(
    (retainEditor: boolean) => {
      editSessionRef.current?.release()
      const session = onBeginEdit(presentationFence, message)
      const owned = {
        ...session,
        identity: editIdentity,
        fenceIdentity: editFenceIdentity,
      }
      editSessionRef.current = owned
      setEditSessionReady(false)
      if (!retainEditor) setEditing(false)
      void session.admitted.then(
        () => {
          if (editSessionRef.current === owned) {
            setEditing(true)
            setEditSessionReady(true)
          }
        },
        () => {
          if (editSessionRef.current === owned) endEditing()
        },
      )
    },
    [editFenceIdentity, editIdentity, endEditing, message, onBeginEdit, presentationFence],
  )
  const beginEditing = useCallback(() => {
    ownEditSession(false)
  }, [ownEditSession])
  useEffect(() => {
    if (!editing) return
    const session = editSessionRef.current
    if (session?.fenceIdentity === editFenceIdentity) return
    session?.release()
    editSessionRef.current = null
    setEditSessionReady(false)
    if (presentationOnly || !bodyExact) return
    ownEditSession(true)
  }, [bodyExact, editFenceIdentity, editing, ownEditSession, presentationOnly])
  useEffect(() => {
    const session = editSessionRef.current
    if (session && session.identity !== editIdentity) endEditing()
  }, [editIdentity, endEditing])
  useEffect(() => endEditing, [endEditing])
  const editMutationUnavailable =
    !editSessionReady ||
    editSessionRef.current?.identity !== editIdentity ||
    editSessionRef.current.fenceIdentity !== editFenceIdentity
  const remoteStreaming = availability?.presentation === 'remote-streaming'
  const renderedContent = useMemo(
    () =>
      liveSnapshot?.baseContent
        ? [...liveSnapshot.baseContent, ...liveSnapshot.content]
        : (liveSnapshot?.content ?? message.content),
    [liveSnapshot, message.content],
  )
  const liveReasoning = liveSnapshot?.reasoning
  const renderedGeneration = mergeLiveGeneration(message.generation, liveSnapshot?.generation)
  const infoMessage = useMemo(() => {
    if (!showInfo || !liveSnapshot) return message
    return {
      ...message,
      content: [...renderedContent],
      ...(renderedGeneration ? { generation: renderedGeneration } : {}),
    }
  }, [showInfo, liveSnapshot, message, renderedContent, renderedGeneration])
  const infoAppliedView = useMemo(
    () => (infoMessage === message ? appliedView : createAppliedMessageView(infoMessage)),
    [appliedView, infoMessage, message],
  )
  const reasoningPresentation = useMemo(
    () =>
      liveReasoning
        ? projectAppliedMessageReasoningPresentation(appliedView, {
            attemptKind: liveSnapshot.attemptKind,
            streamId: liveSnapshot.streamId,
            projection: liveReasoning,
          })
        : projectAppliedMessageReasoningPresentation(appliedView),
    [appliedView, liveReasoning, liveSnapshot?.attemptKind, liveSnapshot?.streamId],
  )
  const hasDisplayReasoning = reasoningPresentation.hasReasoning
  const textSegments = useMemo(
    () => messageTextSegmentsFromContent(renderedContent),
    [renderedContent],
  )
  const textLength = useMemo(
    () => textSegments.reduce((sum, segment) => sum + segment.length, 0),
    [textSegments],
  )
  const text = useMemo(
    () =>
      liveRendering || textLength > PROGRESSIVE_STATIC_MARKDOWN_CHARS ? '' : textSegments.join(''),
    [liveRendering, textLength, textSegments],
  )
  const hasContent =
    textLength > 0 ||
    renderedContent.some(
      (item) =>
        item.type === 'output_image' ||
        item.type === 'audio_output' ||
        item.type === 'output_video' ||
        item.type === 'file',
    )
  const latestAttempt = appliedView.latestAttempt
  const terminalAttempt =
    latestAttempt.kind === 'generation' ? renderedGeneration : latestAttempt.metadata
  const gen = terminalAttempt
  const error = gen?.error
  const abortReason = gen?.abortReason
  const reasoningVisibility = messageReasoningVisibility(appliedView)
  const showHiddenReasoningFooter =
    message.role === 'assistant' &&
    !editing &&
    !hasDisplayReasoning &&
    reasoningVisibility.disclosure === 'absent' &&
    reasoningVisibility.reason === 'api-mode'
  const canSwitchToResponses = Boolean(!bodyMutationUnavailable && onRegenerate)
  const handleSwitchToResponses = useCallback((): GenerationSubmission => {
    if (!onRegenerate) throw new Error('MessageRegenerateHandlerMissing')
    return onRegenerate(message, { settingsPatch: { api: 'responses' } })
  }, [message, onRegenerate])

  // Stale-reasoning detection. When a fresh assistant error matches the
  // "preserved reasoning got rejected" pattern, push a banner with actions
  // to retry without carry-forward and to copy the error. The inline error row
  // still shows the raw message so the user has context either way.
  const pushBanner = useToastStore((s) => s.pushBanner)
  const clearBannersByKind = useToastStore((s) => s.clearBannersByKind)
  const dismissBanner = useToastStore((s) => s.dismissBanner)
  const staleProvider = useMemo(() => {
    if (!error) return null
    return detectStaleReasoning(
      {
        message: error.message,
        ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
      },
      gen.reasoningCarryForward,
    )
  }, [error, gen])
  const handleRetryWithoutReasoning = useCallback((): GenerationSubmission => {
    if (!onRegenerate) throw new Error('MessageRegenerateHandlerMissing')
    return onRegenerate(message, {
      settingsPatch: {
        reasoning: {
          mode: 'default',
          exclude: false,
          summary: 'auto',
          include: { encrypted: false, summary: false, text: false },
        },
      },
    })
  }, [message, onRegenerate])
  const handleCopyError = useCallback(() => {
    if (!error) return
    const payload = JSON.stringify(
      {
        messageId: message.id,
        code: error.code,
        message: error.message,
        statusCode: error.statusCode,
      },
      null,
      2,
    )
    const browserNavigator: Partial<Navigator> | undefined =
      typeof navigator === 'undefined' ? undefined : navigator
    if (browserNavigator?.clipboard) {
      void browserNavigator.clipboard.writeText(payload)
    }
  }, [error, message.id])
  useEffect(() => {
    if (bodyMutationUnavailable) return
    if (!staleProvider) return
    // One banner per error id. The key is the message id so subsequent
    // swipes back to the same failed leaf don't stack a second banner.
    clearBannersByKind('stale-reasoning')
    const bannerId = pushBanner({
      kind: 'stale-reasoning',
      text: staleReasoningBannerText(staleProvider),
      primary: {
        label: 'Retry without preserved reasoning',
        action: async () => {
          const start = handleRetryWithoutReasoning()
          if (start.kind === 'not-started') return false
          return (await start.completion).kind === 'prepared'
        },
      },
      secondary: {
        label: 'Copy error',
        action: () => {
          handleCopyError()
        },
      },
    })
    return () => {
      dismissBanner(bannerId)
    }
  }, [
    staleProvider,
    pushBanner,
    clearBannersByKind,
    dismissBanner,
    handleRetryWithoutReasoning,
    handleCopyError,
    bodyMutationUnavailable,
  ])
  const collapseProfile = useMemo(
    () => collapseProfileFor(textLength, { streaming: liveRendering, longMessageDisplayMode }),
    [liveRendering, longMessageDisplayMode, textLength],
  )
  const manualCollapseRef = useRef(false)
  const previousStreamingRef = useRef(liveRendering)
  const [collapseMode, setCollapseMode] = useState<MessageCollapseMode>(collapseProfile.defaultMode)

  useEffect(() => {
    const justFinalized = previousStreamingRef.current && !liveRendering
    previousStreamingRef.current = liveRendering
    setCollapseMode((prev) => {
      if (manualCollapseRef.current) {
        return collapseProfile.modes.includes(prev) ? prev : collapseProfile.defaultMode
      }
      if (justFinalized && collapseProfile.modes.includes(prev)) return prev
      return collapseProfile.defaultMode
    })
  }, [collapseProfile.defaultMode, collapseProfile.modes, liveRendering])

  const handleSave = useCallback(
    (text: string) => onEditInPlace(message, text),
    [message, onEditInPlace],
  )
  // The display normalizer is deliberately one-row-in/one-row-out. Apply the
  // eye toggle to that same raw row and leave every other carrier untouched.
  const handleToggleReasoningHidden = useCallback(
    (member: ReasoningMemberRef) => onToggleReasoningDetailHidden!(message, member),
    [message, onToggleReasoningDetailHidden],
  )
  const handleToggleToolHidden = useCallback(
    (member: ProviderOutputMemberRef) => onToggleProviderOutputItemHidden!(message, member),
    [message, onToggleProviderOutputItemHidden],
  )
  const handleSaveAndSend = useCallback(
    (text: string, opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] }) => {
      if (!onEditAndSend) throw new Error('MessageEditAndSendHandlerMissing')
      return onEditAndSend(message, text, opts)
    },
    [message, onEditAndSend],
  )
  const editTreeMode = useUiStore((s) => s.editTreeMode)
  const collapseEnabled = !editing && collapseProfile.modes.length > 1
  const cycleCollapse = useCallback(() => {
    if (!collapseEnabled) return
    manualCollapseRef.current = true
    setCollapseMode((prev) => nextCollapseMode(prev, collapseProfile.modes))
  }, [collapseEnabled, collapseProfile.modes])
  const handleRegenerate = useCallback(() => {
    if (!onRegenerate) throw new Error('MessageRegenerateHandlerMissing')
    return onRegenerate(message)
  }, [message, onRegenerate])
  const handleContinue = useCallback(() => {
    if (!onContinue) throw new Error('MessageContinueHandlerMissing')
    return onContinue(message)
  }, [message, onContinue])
  const handleForkChat = useCallback(() => {
    return onForkChat!(message)
  }, [message, onForkChat])
  const handleDeleteMessage = useCallback(
    (mode: ConversationDeleteMode) => onDeleteMessage(message, mode, roleMismatch),
    [message, onDeleteMessage, roleMismatch],
  )
  const handleInsert = useCallback(
    (slot: InsertSlot) => {
      if (presentationOnly || !onInsert) return
      onInsert(message, slot)
    },
    [message, onInsert, presentationOnly],
  )

  return (
    <article
      data-ui="message"
      data-role={message.role}
      data-origin={message.origin}
      data-message-id={message.id}
      data-editing={editing ? 'true' : 'false'}
      data-has-error={error ? 'true' : 'false'}
      data-has-reasoning={hasDisplayReasoning ? 'true' : 'false'}
      data-collapse-mode={collapseMode}
      data-body-exact={bodyExact ? 'true' : 'false'}
      aria-busy={streamTargetBusy || undefined}
    >
      <Button
        type="button"
        data-ui="profile-glyph-button"
        data-collapse-mode={collapseMode}
        data-collapse-enabled={collapseEnabled ? 'true' : 'false'}
        data-collapse-oversized={collapseProfile.oversized ? 'true' : undefined}
        onClick={cycleCollapse}
        disabled={!collapseEnabled}
        aria-label={collapseButtonLabel(message.role, collapseMode, collapseProfile.modes.length)}
        title={collapseButtonTitle(
          collapseMode,
          collapseProfile.modes.length,
          collapseProfile.oversized,
        )}
      >
        <ProfileGlyph
          role={message.role}
          decorative
          {...(excludedFromContext ? { excluded: true } : {})}
        />
      </Button>
      <div data-ui="message-body-column">
        <MessageHeader message={message} appliedView={appliedView} />
        {collapseMode === 'full' && hasDisplayReasoning && !editing ? (
          <ReasoningBlock
            presentation={reasoningPresentation}
            streaming={liveRendering}
            hasContent={hasContent}
            deferContentUntilOpen={!liveRendering}
            toggleHiddenDisabled={bodyMutationUnavailable}
            {...(message.role === 'assistant' && onToggleReasoningDetailHidden
              ? { onToggleHidden: handleToggleReasoningHidden }
              : {})}
          />
        ) : null}
        {collapseMode === 'full' && !editing ? (
          <ToolEvidenceBlock
            message={infoMessage}
            appliedView={appliedView}
            toggleHiddenDisabled={bodyMutationUnavailable}
            {...(onToggleProviderOutputItemHidden
              ? { onToggleHidden: handleToggleToolHidden }
              : {})}
          />
        ) : null}
        {collapseMode === 'full' && showHiddenReasoningFooter ? (
          <div data-ui="message-hidden-reasoning" role="status">
            <span>
              <strong>{gen?.model ?? 'This model'}</strong> reasoned internally; content wasn't
              returned in this API mode.
            </span>
            {canSwitchToResponses ? (
              <Button
                type="button"
                data-ui="message-hidden-reasoning-action"
                onClick={() => {
                  handleSwitchToResponses()
                }}
                title="Switch this chat to the Responses API and regenerate"
              >
                Switch to Responses API
              </Button>
            ) : null}
          </div>
        ) : null}
        {editing ? (
          <InlineEditor
            initial={plaintextOf(message.content)}
            onSave={handleSave}
            onCancel={endEditing}
            saveDisabled={editMutationUnavailable}
            attachmentsEnabled={message.role === 'user' && onEditAndSend !== undefined}
            {...(message.role === 'user' && onEditAndSend
              ? {
                  initialAttachmentRefs: message.attachmentRefs,
                  onSaveAndSend: handleSaveAndSend,
                  ...(showPrefillButton
                    ? {
                        showPrefillButton: true,
                        defaultPrefill: defaultPrefill ?? '',
                        prefillSettingsPrompt,
                      }
                    : {}),
                }
              : {})}
            ariaLabel={`Edit ${message.role} message`}
          />
        ) : (
          <MessageContent
            content={renderedContent}
            text={text}
            textSegments={textSegments}
            streaming={liveRendering}
            renderRevision={bodyVersion}
            collapseMode={collapseMode}
            messageId={message.id}
            attachmentRefs={message.attachmentRefs}
            {...(!bodyMutationUnavailable && onMutateAttachmentRef
              ? {
                  onMutateAttachmentRef: (mutation: MessageAttachmentRefMutation) =>
                    onMutateAttachmentRef(message, mutation),
                }
              : {})}
          />
        )}
        {!editing ? (
          <AttachmentRefChips
            refs={message.attachmentRefs}
            messageId={message.id}
            {...(!bodyMutationUnavailable && onMutateAttachmentRef
              ? {
                  onMutateMessageRef: (mutation: MessageAttachmentRefMutation) =>
                    onMutateAttachmentRef(message, mutation),
                }
              : {})}
          />
        ) : null}
        {error ? (
          <div data-ui="message-error" data-role="error">
            <strong>Error{error.statusCode ? ` ${error.statusCode}` : ''}:</strong> {error.message}
            <Button
              type="button"
              data-ui="message-error-dismiss"
              onClick={() => void onDismissGenerationNotice?.(message)}
              disabled={bodyMutationUnavailable || onDismissGenerationNotice === undefined}
              aria-label="Dismiss error"
              title={
                bodyMutationUnavailable ? 'Refreshing this message before dismissal.' : 'Dismiss'
              }
            >
              ×
            </Button>
          </div>
        ) : null}
        {abortReason && !error ? (
          <div data-ui="message-error" data-role="abort" data-reason={abortReason} role="status">
            <span>
              {abortReason === 'user'
                ? 'Cancelled — partial response kept above. Continue to resume.'
                : `Stream interrupted (${abortReason}).`}
            </span>
            {onContinue ? (
              <Button
                type="button"
                data-ui="message-continue"
                onClick={handleContinue}
                title={
                  streamTargetBusy
                    ? 'Replace the active stream with a continuation'
                    : 'Continue this response'
                }
              >
                Continue
              </Button>
            ) : null}
            <Button
              type="button"
              data-ui="message-error-dismiss"
              onClick={() => void onDismissGenerationNotice?.(message)}
              disabled={bodyMutationUnavailable || onDismissGenerationNotice === undefined}
              aria-label="Dismiss banner"
              title={
                bodyMutationUnavailable ? 'Refreshing this message before dismissal.' : 'Dismiss'
              }
            >
              ×
            </Button>
          </div>
        ) : null}
        {remoteStreaming ? (
          <div data-ui="message-stream-remote" role="status">
            This response is currently streaming in another tab.
          </div>
        ) : null}
        {null}
        <div data-ui="message-action-row">
          {branchContext ? (
            <BranchControls chatId={chatId} message={message} context={branchContext} />
          ) : (
            <span data-ui="message-action-row-spacer" />
          )}
          <MessageActions
            message={message}
            appliedView={appliedView}
            showInfo={showInfo}
            onToggleInfo={() => setShowInfo((v) => !v)}
            isEditing={editing}
            onBeginEdit={beginEditing}
            generationBusy={generationSubmissionPending}
            streamTargetBusy={streamTargetBusy}
            mutationDisabled={bodyMutationUnavailable}
            structuralDisabled={presentationOnly || structuralMutationPending}
            structuralMutationPending={structuralMutationPending}
            {...(onCancelStructuralMutation ? { onCancelStructuralMutation } : {})}
            {...(onToggleContextVisibility
              ? { onToggleContextVisibility: () => onToggleContextVisibility(message) }
              : {})}
            {...(roleMismatch ? { roleMismatch: true } : {})}
            {...(onRegenerate ? { onRegenerate: handleRegenerate } : {})}
            {...(onContinue ? { onContinue: handleContinue } : {})}
            {...(onForkChat ? { onForkChat: handleForkChat } : {})}
            onDelete={handleDeleteMessage}
          />
        </div>
        {editTreeMode ? (
          <MessageEditTreeActions
            streamTargetBusy={streamTargetBusy || presentationOnly}
            structuralMutationPending={structuralMutationPending}
            {...(onCancelStructuralMutation ? { onCancelStructuralMutation } : {})}
            onDelete={handleDeleteMessage}
            {...(onInsert ? { onInsert: handleInsert } : {})}
          />
        ) : null}
        {showInfo ? (
          <MessageInfo
            message={infoMessage}
            appliedView={infoAppliedView}
            reasoningPresentation={reasoningPresentation}
            {...(staleReplyHint ? { staleReplyHint: true } : {})}
          />
        ) : null}
      </div>
    </article>
  )
}

function mergeLiveGeneration(
  persisted: MessageRow['generation'],
  live: MessageRow['generation'],
): MessageRow['generation'] {
  if (!live) return persisted
  if (!persisted) return live
  return {
    ...persisted,
    ...live,
    startedAt: persisted.startedAt,
  }
}

function collapseButtonLabel(
  role: MessageRow['role'],
  mode: MessageCollapseMode,
  modeCount: number,
): string {
  const name = `${role} message`
  if (modeCount <= 1) return `${name} avatar`
  if (mode === 'full') {
    return modeCount > 2
      ? `Collapse ${name} to a compact preview`
      : `Collapse ${name} to a one-line preview`
  }
  if (mode === 'compact') {
    return `Collapse ${name} to a one-line preview`
  }
  return `Expand ${name}`
}

function collapseButtonTitle(
  mode: MessageCollapseMode,
  modeCount: number,
  oversized: boolean,
): string {
  if (modeCount <= 1) return oversized ? 'Oversized message preview' : 'Message avatar'
  if (mode === 'full') {
    return modeCount > 2 ? 'Collapse to a substantial preview' : 'Collapse to a one-line preview'
  }
  if (mode === 'compact') {
    return 'Collapse further to a one-line preview'
  }
  return 'Expand back to the full message'
}

interface MessageErrorBoundaryProps {
  messageId: string
  children: ReactNode
}

interface MessageErrorBoundaryState {
  error: Error | null
}

class MessageErrorBoundary extends Component<MessageErrorBoundaryProps, MessageErrorBoundaryState> {
  override state: MessageErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): MessageErrorBoundaryState {
    return { error }
  }

  override render() {
    if (this.state.error) {
      return (
        <article
          data-ui="message"
          data-role="error"
          data-message-id={this.props.messageId}
          data-state="crashed"
        >
          <div data-ui="message-crash">
            This message failed to render. The rest of the chat is still interactive.
          </div>
        </article>
      )
    }
    return this.props.children
  }
}
