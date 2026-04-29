import type { Message as MessageRow } from '../../core/types'

interface MessageHeaderProps {
  message: MessageRow
}

const ROLE_LABEL: Record<MessageRow['role'], string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
  developer: 'Developer',
  tool: 'Tool',
}

const PHASE_LABEL: Record<'commentary' | 'final_answer', string> = {
  commentary: 'commentary',
  final_answer: 'final',
}

// Header row for each message. Carries the prominent role label, optional
// state pills (edited / imported), and — for assistant messages — quiet
// right-aligned chips with the model id, completion-token count, and the
// Responses-API `phase`. The full factual record (timestamps, costs,
// breakdowns) still lives in the info disclosure on the action row.
export function MessageHeader({ message }: MessageHeaderProps) {
  const isAssistant = message.role === 'assistant'
  const gen = message.generation
  const model = isAssistant ? gen?.model : undefined
  const completionTok = isAssistant ? gen?.usage?.completion_tokens : undefined
  // `phase` is only meaningful on Responses-API turns (apiUsed === 'responses').
  // Chat-completions and Gemini turns never carry it; hide the chip entirely
  // rather than display "unset" noise.
  const phase = isAssistant && gen?.apiUsed === 'responses' ? message.phase : undefined
  const roleLabel = ROLE_LABEL[message.role]
  return (
    <header data-ui="message-header">
      <span data-ui="message-role">{roleLabel}</span>
      <span data-ui="message-header-spacer" />
      {phase ? (
        <span
          data-ui="message-phase-chip"
          data-phase={phase}
          title="Responses-API phase — required for gpt-5.4-family models to avoid early stopping."
        >
          {PHASE_LABEL[phase]}
        </span>
      ) : null}
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
