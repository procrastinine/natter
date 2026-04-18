import type { Message as MessageRow } from '../../core/types'

export interface MessageHeaderProps {
  message: MessageRow
}

const ROLE_LABEL: Record<MessageRow['role'], string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  developer: 'Developer',
  tool: 'Tool',
}

// Header row for each message. Carries the prominent role label, optional
// state pills (edited / imported), and — for assistant messages — quiet
// right-aligned chips with the model id and completion-token count. The
// full factual record (timestamps, costs, breakdowns) still lives in the
// info disclosure on the action row.
export function MessageHeader({ message }: MessageHeaderProps) {
  const isAssistant = message.role === 'assistant'
  const gen = message.generation
  const model = isAssistant ? gen?.model : undefined
  const completionTok = isAssistant ? gen?.usage?.completion_tokens : undefined
  return (
    <header data-ui="message-header" aria-label={ROLE_LABEL[message.role]}>
      <span data-ui="message-role">{ROLE_LABEL[message.role]}</span>
      {message.editedAt ? (
        <span
          data-ui="message-edited"
          title="Edited in place — original token count and cost unchanged."
        >
          edited
        </span>
      ) : null}
      {message.origin === 'imported' ? (
        <span data-ui="message-imported" title="Imported from another source">
          imported
        </span>
      ) : null}
      <span data-ui="message-header-spacer" />
      {model ? (
        <span
          data-ui="message-model-chip"
          title={
            gen?.requestedModel && gen.requestedModel !== gen.model
              ? `Requested ${gen.requestedModel} → served ${gen.model}`
              : undefined
          }
        >
          {model}
        </span>
      ) : null}
      {completionTok !== undefined ? (
        <span data-ui="message-tokens-chip">{completionTok.toLocaleString()} tok</span>
      ) : null}
    </header>
  )
}
