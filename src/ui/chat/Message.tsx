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
import { groupByParent } from '../../core/active-path'
import type { EffectiveCapability } from '../../core/capabilities'
import { normalizeReasoningDetails } from '../../core/reasoning'
import { detectStaleReasoning, staleReasoningBannerText } from '../../core/stale-reasoning'
import type { ChatId, CursorMap, Message as MessageRow, ReasoningDetail } from '../../core/types'
import { dismissAbortReason, updateChatSettings } from '../../store/chats'
import { useStreamStore } from '../../store/zustand/streamStore'
import { useToastStore } from '../../store/zustand/toastStore'
import { useUiStore } from '../../store/zustand/uiStore'
import { BranchControls } from './BranchControls'
import { InlineEditor, plaintextOf } from './InlineEditor'
import { type InsertSlot, MessageActions, MessageEditTreeActions } from './MessageActions'
import { MessageContent, messageTextFromContent } from './MessageContent'
import { MessageHeader } from './MessageHeader'
import { MessageInfo } from './MessageInfo'
import {
  collapseProfileFor,
  type MessageCollapseMode,
  nextCollapseMode,
} from './MessageStreamOverflow'
import { ProfileGlyph } from './ProfileGlyph'
import { ReasoningBlock } from './ReasoningBlock'

export interface MessageProps {
  chatId: ChatId
  message: MessageRow
  messages: readonly MessageRow[]
  cursor: CursorMap
  streaming?: boolean
  hasConnection: boolean
  // Effective capability for the chat's current model. Threaded from the
  // list so the message can surface capability-dependent affordances like
  // the hidden-reasoning footer on o-series/chat-completions turns without
  // redoing the /endpoints fetch per message.
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
  onEditInPlace: (text: string, reasoning?: ReasoningDetail[]) => Promise<void>
  onEditAndSend?: (text: string) => Promise<void>
  onRegenerate?: () => Promise<void>
  onContinue?: () => Promise<void>
  onForkChat?: () => Promise<void>
  onInsert?: (slot: InsertSlot) => void
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
    prev.messages === next.messages &&
    prev.cursor === next.cursor &&
    prev.streaming === next.streaming &&
    prev.hasConnection === next.hasConnection &&
    prev.capability === next.capability &&
    prev.roleMismatch === next.roleMismatch &&
    prev.staleReplyHint === next.staleReplyHint &&
    prev.excludedFromContext === next.excludedFromContext &&
    prev.onEditInPlace === next.onEditInPlace &&
    prev.onEditAndSend === next.onEditAndSend &&
    prev.onRegenerate === next.onRegenerate &&
    prev.onContinue === next.onContinue &&
    prev.onForkChat === next.onForkChat &&
    prev.onInsert === next.onInsert,
)

function MessageInner({
  chatId,
  message,
  messages,
  cursor,
  streaming,
  hasConnection,
  capability,
  roleMismatch,
  staleReplyHint,
  excludedFromContext,
  onEditInPlace,
  onEditAndSend,
  onRegenerate,
  onContinue,
  onForkChat,
  onInsert,
}: MessageProps) {
  const error = message.generation?.error
  const abortReason = message.generation?.abortReason
  const debug = (message as unknown as { debugCrash?: boolean }).debugCrash
  if (debug) {
    throw new Error('Message debug crash')
  }
  const reasoning = useMemo(
    () => normalizeReasoningDetails(message.reasoningDetails ?? []),
    [message.reasoningDetails],
  )
  const [showInfo, setShowInfo] = useState(false)
  const [editing, setEditing] = useState(false)
  const text = useMemo(() => messageTextFromContent(message.content), [message.content])
  // Streaming state is tracked per-message (messageId) in the ephemeral
  // stream store. Prop `streaming` is the authoritative fallback when a
  // caller passes it in; otherwise we check the store. Either way, the
  // resolved value drives auto-expand/collapse for the reasoning block.
  const storeStreaming = useStreamStore((s) =>
    message.role === 'assistant' ? s.isTargetActive(chatId, message.id) : false,
  )
  const isStreaming = streaming === true || storeStreaming
  const hasContent = text.length > 0
  // Hidden-reasoning footer: only applies to assistant turns on a route that
  // hides reasoning. `apiUsed === 'responses'` means reasoning IS returned
  // (or could be, via summary+encrypted). The footer is explicitly for chat-
  // completions where the model reasons silently.
  const gen = message.generation
  const apiUsed = gen?.apiUsed
  const showHiddenReasoningFooter =
    message.role === 'assistant' &&
    !editing &&
    reasoning.length === 0 &&
    capability?.quirks.hiddenReasoningOnChatApi === true &&
    apiUsed === 'chat'
  const canSwitchToResponses = Boolean(onRegenerate && hasConnection)
  const handleSwitchToResponses = useCallback(async () => {
    await updateChatSettings(chatId, { api: 'responses' })
    if (onRegenerate) await onRegenerate()
  }, [chatId, onRegenerate])

  // Stale-reasoning detection. When a fresh assistant error matches the
  // "preserved reasoning got rejected" pattern, push a banner with actions
  // to retry without carry-forward and to copy the error. The banner is the
  // canonical surface (see plan/13 §Phase 11.1); the inline error row still
  // shows the raw message so the user has context either way.
  const pushBanner = useToastStore((s) => s.pushBanner)
  const clearBannersByKind = useToastStore((s) => s.clearBannersByKind)
  const dismissBanner = useToastStore((s) => s.dismissBanner)
  const staleProvider = useMemo(() => {
    if (!error) return null
    const hadReasoning =
      (message.reasoningDetails?.length ?? 0) > 0 ||
      messages.some((m) => m.id !== message.id && (m.reasoningDetails?.length ?? 0) > 0)
    return detectStaleReasoning(
      {
        message: error.message,
        ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
      },
      { hadReasoningDetails: hadReasoning },
    )
  }, [error, message.reasoningDetails, message.id, messages])
  const handleRetryWithoutReasoning = useCallback(async () => {
    await updateChatSettings(chatId, {
      reasoning: {
        mode: 'default',
        exclude: false,
        summary: 'auto',
        include: { encrypted: false, summary: false, text: false },
      },
    })
    if (onRegenerate) await onRegenerate()
  }, [chatId, onRegenerate])
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
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(payload)
    }
  }, [error, message.id])
  useEffect(() => {
    if (!staleProvider) return
    // One banner per error id. We key on the message id so subsequent
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
  ])
  const collapseProfile = useMemo(() => collapseProfileFor(text.length), [text.length])
  const manualCollapseRef = useRef(false)
  const [collapseMode, setCollapseMode] = useState<MessageCollapseMode>(collapseProfile.defaultMode)

  useEffect(() => {
    setCollapseMode((prev) => {
      if (manualCollapseRef.current) {
        return collapseProfile.modes.includes(prev) ? prev : collapseProfile.defaultMode
      }
      return collapseProfile.defaultMode
    })
  }, [collapseProfile.defaultMode, collapseProfile.modes])

  const handleSave = useCallback(
    async (text: string, reasoning?: ReasoningDetail[]) => {
      await onEditInPlace(text, reasoning)
      setEditing(false)
    },
    [onEditInPlace],
  )
  // Per-block hide toggle. `reasoning` is the normalized view, so indices
  // here map 1:1 to the stored list for clean data (post-Phase-11 fix);
  // legacy duplicates get cleaned up as a side effect of the first toggle.
  const handleToggleReasoningHidden = useCallback(
    (detailIndex: number) => {
      if (detailIndex < 0 || detailIndex >= reasoning.length) return
      const next = reasoning.map((d, i) =>
        i === detailIndex ? { ...d, hidden: !d.hidden } : d,
      )
      void onEditInPlace(text, next)
    },
    [reasoning, text, onEditInPlace],
  )
  const handleSaveAndSend = useCallback(
    async (text: string) => {
      if (!onEditAndSend) return
      await onEditAndSend(text)
      setEditing(false)
    },
    [onEditAndSend],
  )
  const byParent = groupByParent(messages)
  const siblings = (byParent.get(message.parentId) ?? []).filter((m) => !m.deleted)
  const editTreeMode = useUiStore((s) => s.editTreeMode)
  const collapseEnabled = !editing && collapseProfile.modes.length > 1
  const cycleCollapse = useCallback(() => {
    if (!collapseEnabled) return
    manualCollapseRef.current = true
    setCollapseMode((prev) => nextCollapseMode(prev, collapseProfile.modes))
  }, [collapseEnabled, collapseProfile.modes])

  return (
    <article
      data-ui="message"
      data-role={message.role}
      data-origin={message.origin}
      data-message-id={message.id}
      data-editing={editing ? 'true' : 'false'}
      data-has-error={error ? 'true' : 'false'}
      data-has-reasoning={reasoning.length > 0 ? 'true' : 'false'}
      data-collapse-mode={collapseMode}
    >
      <button
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
      </button>
      <div data-ui="message-body-column">
        <MessageHeader message={message} />
        {collapseMode === 'full' && reasoning.length > 0 ? (
          <ReasoningBlock
            details={reasoning}
            streaming={isStreaming}
            hasContent={hasContent}
            {...(message.role === 'assistant' && !editing
              ? { onToggleHidden: handleToggleReasoningHidden }
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
              <button
                type="button"
                data-ui="message-hidden-reasoning-action"
                onClick={() => void handleSwitchToResponses()}
                title="Switch this chat to the Responses API and regenerate"
              >
                Switch to Responses API
              </button>
            ) : null}
          </div>
        ) : null}
        {editing ? (
          <InlineEditor
            initial={plaintextOf(message.content)}
            onSave={handleSave}
            onCancel={() => setEditing(false)}
            {...(message.role === 'user' && onEditAndSend
              ? {
                  onSaveAndSend: handleSaveAndSend,
                  saveAndSendDisabled: !hasConnection,
                  saveAndSendDisabledReason: 'Add a connection to send messages.',
                }
              : {})}
            {...(message.role === 'assistant'
              ? { initialReasoning: message.reasoningDetails ?? [] }
              : {})}
            ariaLabel={`Edit ${message.role} message`}
          />
        ) : (
          <MessageContent text={text} streaming={streaming ?? false} collapseMode={collapseMode} />
        )}
        {error ? (
          <div data-ui="message-error" data-role="error">
            <strong>Error{error.statusCode ? ` ${error.statusCode}` : ''}:</strong> {error.message}
            <button
              type="button"
              data-ui="message-error-dismiss"
              onClick={() => void dismissAbortReason(message.id)}
              aria-label="Dismiss error"
              title="Dismiss"
            >
              ×
            </button>
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
              <button
                type="button"
                data-ui="message-continue"
                onClick={() => void onContinue()}
                disabled={!hasConnection}
                title={!hasConnection ? 'Add a connection to continue.' : 'Continue this response'}
              >
                Continue
              </button>
            ) : null}
            <button
              type="button"
              data-ui="message-error-dismiss"
              onClick={() => void dismissAbortReason(message.id)}
              aria-label="Dismiss banner"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        ) : null}
        {null}
        <div data-ui="message-action-row">
          {siblings.length > 1 ? (
            <BranchControls chatId={chatId} message={message} messages={messages} />
          ) : (
            <span data-ui="message-action-row-spacer" />
          )}
          <MessageActions
            chatId={chatId}
            cursor={cursor}
            message={message}
            showInfo={showInfo}
            onToggleInfo={() => setShowInfo((v) => !v)}
            isEditing={editing}
            onBeginEdit={() => setEditing(true)}
            hasConnection={hasConnection}
            {...(roleMismatch ? { roleMismatch: true } : {})}
            {...(onRegenerate ? { onRegenerate } : {})}
            {...(onContinue ? { onContinue } : {})}
            {...(onForkChat ? { onForkChat } : {})}
          />
        </div>
        {editTreeMode ? (
          <MessageEditTreeActions
            chatId={chatId}
            cursor={cursor}
            message={message}
            {...(onInsert ? { onInsert } : {})}
            {...(roleMismatch ? { roleMismatch: true } : {})}
          />
        ) : null}
        {showInfo ? (
          <MessageInfo message={message} {...(staleReplyHint ? { staleReplyHint: true } : {})} />
        ) : null}
      </div>
    </article>
  )
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
