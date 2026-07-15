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
import type { EffectiveCapability } from '../../core/capabilities'
import { hasAppliedSuccessfulContinuation } from '../../core/continuation-content'
import type { LongMessageDisplayMode } from '../../core/global-settings'
import { quirksFor } from '../../core/quirks'
import { normalizeReasoningDetails } from '../../core/reasoning'
import { detectStaleReasoning, staleReasoningBannerText } from '../../core/stale-reasoning'
import type { StreamAccumulatorLiveReasoningRow } from '../../core/stream-accumulator'
import type {
  ChatId,
  MessageAttachmentRef,
  Message as MessageRow,
  ReasoningDetail,
} from '../../core/types'
import { useRetainedMessageStreamProjection } from '../../hooks/useMessageStreamProjection'
import type { MessageAttachmentRefMutation } from '../../store/attachments'
import { updateChatSettings } from '../../store/chats'
import {
  contentNeedsGeneratedOutputMaterialization,
  generatedOutputAttachmentIds,
  normalizeGeneratedImageOutputAttachmentRefs,
  scheduleGeneratedOutputMigration,
} from '../../store/generated-images'
import { getStreamClientId } from '../../store/stream-leases'
import { useToastStore } from '../../store/zustand/toastStore'
import { useUiStore } from '../../store/zustand/uiStore'
import { AttachmentRefChips } from '../attachments/AttachmentRefChips'
import { Button } from '../primitives/Button'
import { BranchControls, type BranchNavigationContext } from './BranchControls'
import { InlineEditor, plaintextOf } from './InlineEditor'
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
  branchContext?: BranchNavigationContext
  hasAnyReasoningDetails: boolean
  streaming?: boolean
  hasConnection: boolean
  generationBusy?: boolean
  presentationOnly?: boolean
  allowPresentationStreamProjection?: boolean
  // Effective capability for the chat's current model. Message-level quirks
  // should still prefer the stored message generation model when available.
  capability?: EffectiveCapability
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
  onEditInPlace: (message: MessageRow, text: string) => Promise<void>
  onToggleContextVisibility?: (message: MessageRow) => Promise<void>
  onDismissGenerationNotice?: (message: MessageRow) => Promise<void>
  onMutateAttachmentRef?: (
    message: MessageRow,
    mutation: MessageAttachmentRefMutation,
  ) => Promise<void>
  onToggleReasoningDetailHidden?: (message: MessageRow, detailIndex: number) => Promise<void>
  onToggleProviderOutputItemHidden?: (message: MessageRow, itemIndex: number) => Promise<void>
  onEditAndSend?: (
    message: MessageRow,
    text: string,
    opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
  ) => Promise<void>
  onRegenerate?: (message: MessageRow) => Promise<void>
  onContinue?: (message: MessageRow) => Promise<void>
  onForkChat?: (message: MessageRow) => Promise<void>
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
    prev.branchContext === next.branchContext &&
    prev.hasAnyReasoningDetails === next.hasAnyReasoningDetails &&
    prev.streaming === next.streaming &&
    prev.hasConnection === next.hasConnection &&
    prev.generationBusy === next.generationBusy &&
    prev.presentationOnly === next.presentationOnly &&
    prev.allowPresentationStreamProjection === next.allowPresentationStreamProjection &&
    prev.capability === next.capability &&
    prev.roleMismatch === next.roleMismatch &&
    prev.staleReplyHint === next.staleReplyHint &&
    prev.excludedFromContext === next.excludedFromContext &&
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
  branchContext,
  hasAnyReasoningDetails,
  streaming,
  hasConnection,
  generationBusy = false,
  presentationOnly = false,
  allowPresentationStreamProjection = false,
  capability,
  roleMismatch,
  staleReplyHint,
  excludedFromContext,
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
  onInsert,
  showPrefillButton,
  defaultPrefill,
  prefillSettingsPrompt,
  longMessageDisplayMode = 'full',
}: MessageProps) {
  messageRenderProbe?.(message.id)
  const debug = (message as unknown as { debugCrash?: boolean }).debugCrash
  if (debug) {
    throw new Error('Message debug crash')
  }
  const [showInfo, setShowInfo] = useState(false)
  const [editing, setEditing] = useState(false)
  // Streaming state is tracked per-message (messageId) in the ephemeral
  // stream store. Prop `streaming` is the authoritative fallback when a
  // caller passes it in; otherwise the store is checked. Either way, the
  // resolved value drives streaming render mode plus reasoning/collapse
  // affordances.
  const [activeStream, liveSnapshot] = useRetainedMessageStreamProjection(
    message,
    bodyVersion,
    message.role === 'assistant' && (!presentationOnly || allowPresentationStreamProjection),
  )
  const storeStreaming = activeStream !== undefined
  const isStreaming = !presentationOnly && (streaming === true || storeStreaming)
  const remoteStreaming =
    activeStream !== undefined && activeStream.ownerClientId !== getStreamClientId()
  const renderedContent = liveSnapshot?.content ?? message.content
  const liveReasoningRows = liveSnapshot?.reasoningRows
  const renderedGeneration = mergeLiveGeneration(message.generation, liveSnapshot?.generation)
  const infoReasoningDetails = useMemo(
    () =>
      showInfo && liveReasoningRows
        ? materializeLiveReasoningRows(liveReasoningRows)
        : message.reasoningDetails,
    [liveReasoningRows, message.reasoningDetails, showInfo],
  )
  const infoMessage = useMemo(() => {
    if (!showInfo || !liveSnapshot) return message
    return {
      ...message,
      content: renderedContent,
      ...(infoReasoningDetails ? { reasoningDetails: infoReasoningDetails } : {}),
      ...(renderedGeneration ? { generation: renderedGeneration } : {}),
    }
  }, [showInfo, liveSnapshot, message, renderedContent, infoReasoningDetails, renderedGeneration])
  const reasoning = useMemo(
    () =>
      liveReasoningRows
        ? liveReasoningRows.map((row) => row.detail)
        : normalizeReasoningDetails(message.reasoningDetails ?? []),
    [liveReasoningRows, message.reasoningDetails],
  )
  const hasDisplayReasoning = reasoning.some((detail) => !detail.id?.startsWith('tool_'))
  const textSegments = useMemo(
    () => messageTextSegmentsFromContent(renderedContent),
    [renderedContent],
  )
  const textLength = useMemo(
    () => textSegments.reduce((sum, segment) => sum + segment.length, 0),
    [textSegments],
  )
  const text = useMemo(
    () => (isStreaming ? '' : textSegments.join('')),
    [isStreaming, textSegments],
  )
  const hasContent =
    textLength > 0 ||
    renderedContent.some(
      (item) =>
        item.type === 'output_image' ||
        item.type === 'audio_output' ||
        item.type === 'output_video',
    )
  useEffect(() => {
    if (presentationOnly) return
    if (isStreaming) return
    if (contentNeedsGeneratedOutputMaterialization(renderedContent)) {
      scheduleGeneratedOutputMigration(message.id)
      return
    }
    if (generatedOutputAttachmentIds(renderedContent).size > 0) {
      void normalizeGeneratedImageOutputAttachmentRefs(message.id).catch(() => {})
    }
  }, [isStreaming, presentationOnly, renderedContent, message.id])
  const gen = renderedGeneration
  const suppressOriginalFailure = hasAppliedSuccessfulContinuation(message)
  const error = suppressOriginalFailure ? undefined : gen?.error
  const abortReason = suppressOriginalFailure ? undefined : gen?.abortReason
  const messageModelQuirks = useMemo(
    () => quirksFor(gen?.model ?? gen?.requestedModel ?? ''),
    [gen?.model, gen?.requestedModel],
  )
  // Hidden-reasoning footer: only applies to assistant turns on a route that
  // hides reasoning. `apiUsed === 'responses'` means reasoning IS returned
  // (or could be, via summary+encrypted). The footer is explicitly for chat-
  // completions where the model reasons silently.
  const apiUsed = gen?.apiUsed
  const showHiddenReasoningFooter =
    message.role === 'assistant' &&
    !editing &&
    !hasDisplayReasoning &&
    (messageModelQuirks.hiddenReasoningOnChatApi === true ||
      capability?.quirks.hiddenReasoningOnChatApi === true) &&
    apiUsed === 'chat'
  const canSwitchToResponses = Boolean(
    !presentationOnly && onRegenerate && hasConnection && !generationBusy,
  )
  const handleSwitchToResponses = useCallback(async () => {
    await updateChatSettings(chatId, { api: 'responses' })
    if (onRegenerate) await onRegenerate(message)
  }, [chatId, message, onRegenerate])

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
      { hadReasoningDetails: hasAnyReasoningDetails },
    )
  }, [error, hasAnyReasoningDetails])
  const handleRetryWithoutReasoning = useCallback(async () => {
    await updateChatSettings(chatId, {
      reasoning: {
        mode: 'default',
        exclude: false,
        summary: 'auto',
        include: { encrypted: false, summary: false, text: false },
      },
    })
    if (onRegenerate) await onRegenerate(message)
  }, [chatId, message, onRegenerate])
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
    if (presentationOnly) return
    if (!staleProvider) return
    // One banner per error id. The key is the message id so subsequent
    // swipes back to the same failed leaf don't stack a second banner.
    clearBannersByKind('stale-reasoning')
    const bannerId = pushBanner({
      kind: 'stale-reasoning',
      text: staleReasoningBannerText(staleProvider),
      primary: {
        label: 'Retry without preserved reasoning',
        action: handleRetryWithoutReasoning,
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
    presentationOnly,
  ])
  const collapseProfile = useMemo(
    () => collapseProfileFor(textLength, { streaming: isStreaming, longMessageDisplayMode }),
    [isStreaming, longMessageDisplayMode, textLength],
  )
  const manualCollapseRef = useRef(false)
  const [collapseMode, setCollapseMode] = useState<MessageCollapseMode>(collapseProfile.defaultMode)

  useEffect(() => {
    if (!presentationOnly) return
    setEditing(false)
    setShowInfo(false)
  }, [presentationOnly])

  useEffect(() => {
    setCollapseMode((prev) => {
      if (manualCollapseRef.current) {
        return collapseProfile.modes.includes(prev) ? prev : collapseProfile.defaultMode
      }
      return collapseProfile.defaultMode
    })
  }, [collapseProfile.defaultMode, collapseProfile.modes])

  const handleSave = useCallback(
    async (text: string) => {
      await onEditInPlace(message, text)
      setEditing(false)
    },
    [message, onEditInPlace],
  )
  // The display normalizer is deliberately one-row-in/one-row-out. Apply the
  // eye toggle to that same raw row and leave every other carrier untouched.
  const handleToggleReasoningHidden = useCallback(
    (detailIndex: number) => {
      if (liveReasoningRows || !onToggleReasoningDetailHidden) return
      void onToggleReasoningDetailHidden(message, detailIndex)
    },
    [liveReasoningRows, message, onToggleReasoningDetailHidden],
  )
  const handleToggleToolHidden = useCallback(
    (itemIndex: number) => {
      if (!onToggleProviderOutputItemHidden) return
      void onToggleProviderOutputItemHidden(message, itemIndex)
    },
    [message, onToggleProviderOutputItemHidden],
  )
  const handleSaveAndSend = useCallback(
    async (
      text: string,
      opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
    ) => {
      if (!onEditAndSend) return
      await onEditAndSend(message, text, opts)
      setEditing(false)
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
    if (!onRegenerate) return
    void onRegenerate(message)
  }, [message, onRegenerate])
  const handleContinue = useCallback(() => {
    if (!onContinue) return
    void onContinue(message)
  }, [message, onContinue])
  const handleForkChat = useCallback(() => {
    if (!onForkChat) return
    void onForkChat(message)
  }, [message, onForkChat])
  const handleInsert = useCallback(
    (slot: InsertSlot) => {
      if (!onInsert) return
      onInsert(message, slot)
    },
    [message, onInsert],
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
      aria-busy={isStreaming || undefined}
    >
      <Button
        type="button"
        data-ui="profile-glyph-button"
        data-collapse-mode={collapseMode}
        data-collapse-enabled={collapseEnabled ? 'true' : 'false'}
        data-collapse-oversized={collapseProfile.oversized ? 'true' : undefined}
        onClick={cycleCollapse}
        disabled={presentationOnly || !collapseEnabled}
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
        <MessageHeader message={message} />
        {collapseMode === 'full' && hasDisplayReasoning && !editing ? (
          <ReasoningBlock
            details={reasoning}
            detailsNormalized
            {...(liveReasoningRows ? { liveRows: liveReasoningRows } : {})}
            streaming={isStreaming}
            hasContent={hasContent}
            toggleHiddenDisabled={isStreaming}
            {...(message.role === 'assistant' && onToggleReasoningDetailHidden
              ? { onToggleHidden: handleToggleReasoningHidden }
              : {})}
          />
        ) : null}
        {collapseMode === 'full' && !editing ? (
          <ToolEvidenceBlock
            message={infoMessage}
            toggleHiddenDisabled={isStreaming}
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
                onClick={() => void handleSwitchToResponses()}
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
            onCancel={() => setEditing(false)}
            saveContentOnly
            attachmentsEnabled={message.role === 'user' && onEditAndSend !== undefined}
            {...(message.role === 'user' && onEditAndSend
              ? {
                  initialAttachmentRefs: message.attachmentRefs,
                  onSaveAndSend: handleSaveAndSend,
                  saveAndSendDisabled: !hasConnection || generationBusy,
                  ...(showPrefillButton
                    ? {
                        showPrefillButton: true,
                        defaultPrefill: defaultPrefill ?? '',
                        prefillSettingsPrompt,
                      }
                    : {}),
                  ...(!hasConnection
                    ? { saveAndSendDisabledReason: 'Add a connection to send messages.' }
                    : generationBusy
                      ? { saveAndSendDisabledReason: 'A request is already running for this chat.' }
                      : {}),
                }
              : {})}
            ariaLabel={`Edit ${message.role} message`}
          />
        ) : (
          <MessageContent
            key={`${message.id}:${bodyVersion}`}
            content={renderedContent}
            text={text}
            textSegments={isStreaming ? textSegments : undefined}
            streaming={isStreaming}
            collapseMode={collapseMode}
            messageId={message.id}
            attachmentRefs={message.attachmentRefs}
            {...(onMutateAttachmentRef
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
            {...(onMutateAttachmentRef
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
              aria-label="Dismiss error"
              title="Dismiss"
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
                disabled={!hasConnection}
                title={!hasConnection ? 'Add a connection to continue.' : 'Continue this response'}
              >
                Continue
              </Button>
            ) : null}
            <Button
              type="button"
              data-ui="message-error-dismiss"
              onClick={() => void onDismissGenerationNotice?.(message)}
              aria-label="Dismiss banner"
              title="Dismiss"
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
            <BranchControls
              key={presentationOnly ? 'branch-presentation' : 'branch-interactive'}
              chatId={chatId}
              message={message}
              context={branchContext}
            />
          ) : (
            <span data-ui="message-action-row-spacer" />
          )}
          <MessageActions
            key={presentationOnly ? 'actions-presentation' : 'actions-interactive'}
            chatId={chatId}
            message={message}
            showInfo={showInfo}
            onToggleInfo={() => setShowInfo((v) => !v)}
            isEditing={editing}
            onBeginEdit={() => setEditing(true)}
            hasConnection={hasConnection}
            generationBusy={generationBusy}
            streamTargetBusy={isStreaming}
            {...(onToggleContextVisibility
              ? { onToggleContextVisibility: () => onToggleContextVisibility(message) }
              : {})}
            {...(roleMismatch ? { roleMismatch: true } : {})}
            {...(onRegenerate ? { onRegenerate: handleRegenerate } : {})}
            {...(onContinue ? { onContinue: handleContinue } : {})}
            {...(onForkChat ? { onForkChat: handleForkChat } : {})}
          />
        </div>
        {editTreeMode ? (
          <MessageEditTreeActions
            chatId={chatId}
            message={message}
            streamTargetBusy={isStreaming}
            {...(onInsert ? { onInsert: handleInsert } : {})}
            {...(roleMismatch ? { roleMismatch: true } : {})}
          />
        ) : null}
        {showInfo ? (
          <MessageInfo
            message={infoMessage}
            {...(staleReplyHint ? { staleReplyHint: true } : {})}
          />
        ) : null}
      </div>
    </article>
  )
}

function materializeLiveReasoningRows(
  rows: readonly StreamAccumulatorLiveReasoningRow[],
): ReasoningDetail[] {
  return rows.map(({ detail, valueSections }) => {
    if (!valueSections) return detail
    const value = valueSections.join('')
    if (detail.type === 'reasoning.text') return { ...detail, text: value }
    if (detail.type === 'reasoning.summary') return { ...detail, summary: value }
    return { ...detail, data: value }
  })
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
