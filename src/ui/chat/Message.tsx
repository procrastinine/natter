import type { Message as MessageRow } from '../../core/types'
import { MessageContent } from './MessageContent'

export interface MessageProps {
  message: MessageRow
}

export function Message({ message }: MessageProps) {
  const error = message.generation?.error
  const abortReason = message.generation?.abortReason
  return (
    <article
      data-ui="message"
      data-role={message.role}
      data-origin={message.origin}
      data-message-id={message.id}
    >
      <header data-ui="message-header">
        <span data-role="role-label">{message.role}</span>
      </header>
      <MessageContent content={message.content} />
      {error ? (
        <div data-ui="message-error" data-role="error">
          <strong>Error{error.statusCode ? ` ${error.statusCode}` : ''}:</strong>{' '}
          {error.message}
        </div>
      ) : null}
      {abortReason && !error ? (
        <div data-ui="message-error" data-role="abort">
          Stream interrupted ({abortReason}).
        </div>
      ) : null}
    </article>
  )
}
