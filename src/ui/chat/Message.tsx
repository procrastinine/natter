import { Component, memo, useCallback, useState, type ReactNode } from 'react'
import { groupByParent } from '../../core/active-path'
import type {
  ChatId,
  CursorMap,
  Message as MessageRow,
  ReasoningDetail,
} from '../../core/types'
import { BranchControls } from './BranchControls'
import { InlineEditor, plaintextOf } from './InlineEditor'
import {
  MessageActions,
  MessageEditTreeActions,
  type InsertSlot,
} from './MessageActions'
import { MessageContent } from './MessageContent'
import { MessageHeader } from './MessageHeader'
import { MessageInfo } from './MessageInfo'
import { ProfileGlyph } from './ProfileGlyph'
import { ReasoningBlock } from './ReasoningBlock'
import { useUiStore } from '../../store/zustand/uiStore'

export interface MessageProps {
  chatId: ChatId
  message: MessageRow
  messages: readonly MessageRow[]
  cursor: CursorMap
  streaming?: boolean
  hasConnection: boolean
  // Whether this message sits immediately before a message of the same role
  // on the active path — surfaces the adjacency-warning badge (§10.6).
  roleMismatch?: boolean
  // Whether this message is the user message directly before a visible
  // assistant reply that the user just edited in this session — surfaces
  // the "stale reply?" hint under the NEXT assistant (§10.6 Edit action).
  staleReplyHint?: boolean
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
    prev.roleMismatch === next.roleMismatch &&
    prev.staleReplyHint === next.staleReplyHint &&
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
  roleMismatch,
  staleReplyHint,
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
  const reasoning = message.reasoningDetails ?? []
  const [showInfo, setShowInfo] = useState(false)
  const [editing, setEditing] = useState(false)

  const handleSave = useCallback(
    async (text: string, reasoning?: ReasoningDetail[]) => {
      await onEditInPlace(text, reasoning)
      setEditing(false)
    },
    [onEditInPlace],
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
  const siblings = (byParent.get(message.parentId) ?? []).filter(
    (m) => !m.deleted,
  )
  const editTreeMode = useUiStore((s) => s.editTreeMode)

  return (
    <article
      data-ui="message"
      data-role={message.role}
      data-origin={message.origin}
      data-message-id={message.id}
      data-editing={editing ? 'true' : 'false'}
      data-has-error={error ? 'true' : 'false'}
      data-has-reasoning={reasoning.length > 0 ? 'true' : 'false'}
    >
      <ProfileGlyph role={message.role} />
      <div data-ui="message-body-column">
        <MessageHeader message={message} />
        {reasoning.length > 0 ? <ReasoningBlock details={reasoning} /> : null}
        {editing ? (
          <InlineEditor
            initial={plaintextOf(message.content)}
            onSave={handleSave}
            onCancel={() => setEditing(false)}
            {...(message.role === 'user' && onEditAndSend
              ? {
                  onSaveAndSend: handleSaveAndSend,
                  saveAndSendDisabled: !hasConnection,
                  saveAndSendDisabledReason:
                    'Add a connection to send messages.',
                }
              : {})}
            {...(message.reasoningDetails &&
            message.reasoningDetails.length > 0
              ? { initialReasoning: message.reasoningDetails }
              : {})}
            ariaLabel={`Edit ${message.role} message`}
          />
        ) : (
          <MessageContent
            content={message.content}
            streaming={streaming ?? false}
          />
        )}
        {error ? (
          <div data-ui="message-error" data-role="error">
            <strong>Error{error.statusCode ? ` ${error.statusCode}` : ''}:</strong>{' '}
            {error.message}
          </div>
        ) : null}
        {abortReason && !error ? (
          <div
            data-ui="message-error"
            data-role="abort"
            data-reason={abortReason}
            role="status"
          >
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
                title={
                  !hasConnection
                    ? 'Add a connection to continue.'
                    : 'Continue this response'
                }
              >
                Continue
              </button>
            ) : null}
          </div>
        ) : null}
{null}
        <div data-ui="message-action-row">
          {siblings.length > 1 ? (
            <BranchControls
              chatId={chatId}
              message={message}
              messages={messages}
            />
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
          <MessageInfo
            message={message}
            {...(staleReplyHint ? { staleReplyHint: true } : {})}
          />
        ) : null}
      </div>
    </article>
  )
}

interface MessageErrorBoundaryProps {
  messageId: string
  children: ReactNode
}

interface MessageErrorBoundaryState {
  error: Error | null
}

class MessageErrorBoundary extends Component<
  MessageErrorBoundaryProps,
  MessageErrorBoundaryState
> {
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
