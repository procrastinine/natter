import { Component, memo, useState, type ReactNode } from 'react'
import type { Message as MessageRow } from '../../core/types'
import { MessageActions } from './MessageActions'
import { MessageContent } from './MessageContent'
import { MessageHeader } from './MessageHeader'
import { MessageInfo } from './MessageInfo'
import { ProfileGlyph } from './ProfileGlyph'
import { ReasoningBlock } from './ReasoningBlock'

export interface MessageProps {
  message: MessageRow
  streaming?: boolean
}

// Memoized — the markdown render path (Streamdown + Shiki + KaTeX) is
// expensive, and parents (Shell) re-render on any global-prefs change.
// Without memo, every theme/sendShortcut/chatMaxWidth change cascades a
// markdown re-render of every visible message, which is the perf cost
// the user noticed when picking dropdowns in Settings.
export const Message = memo(
  function Message({ message, streaming }: MessageProps) {
    return (
      <MessageErrorBoundary messageId={message.id}>
        <MessageInner
          message={message}
          {...(streaming === undefined ? {} : { streaming })}
        />
      </MessageErrorBoundary>
    )
  },
  (prev, next) =>
    prev.message === next.message && prev.streaming === next.streaming,
)

function MessageInner({ message, streaming }: MessageProps) {
  const error = message.generation?.error
  const abortReason = message.generation?.abortReason
  // Test-only crash channel: a live-DB row with debugCrash=true forces this
  // component to throw synchronously so the error boundary exercise can run.
  // Production code never sets this field.
  const debug = (message as unknown as { debugCrash?: boolean }).debugCrash
  if (debug) {
    throw new Error('Message debug crash')
  }
  const reasoning = message.reasoningDetails ?? []
  const [showInfo, setShowInfo] = useState(false)
  return (
    <article
      data-ui="message"
      data-role={message.role}
      data-origin={message.origin}
      data-message-id={message.id}
      data-has-error={error ? 'true' : 'false'}
      data-has-reasoning={reasoning.length > 0 ? 'true' : 'false'}
    >
      <ProfileGlyph role={message.role} />
      <div data-ui="message-body-column">
        <MessageHeader message={message} />
        {reasoning.length > 0 ? <ReasoningBlock details={reasoning} /> : null}
        <MessageContent
          content={message.content}
          streaming={streaming ?? false}
        />
        {error ? (
          <div data-ui="message-error" data-role="error">
            <strong>Error{error.statusCode ? ` ${error.statusCode}` : ''}:</strong>{' '}
            {error.message}
          </div>
        ) : null}
        {abortReason && !error ? (
          <div data-ui="message-error" data-role="abort" data-reason={abortReason}>
            <span>Stream interrupted ({abortReason}).</span>
            {abortReason === 'network' || abortReason === 'tab-close' ? (
              <button type="button" data-ui="message-continue">
                Continue
              </button>
            ) : null}
          </div>
        ) : null}
        <MessageActions
          message={message}
          showInfo={showInfo}
          onToggleInfo={() => setShowInfo((v) => !v)}
        />
        {showInfo ? <MessageInfo message={message} /> : null}
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
