import type { Message as MessageRow } from '../../core/types'

export interface MessageInfoProps {
  message: MessageRow
  // Set to true when the previous message on the active path was a user
  // message that got edited after this assistant was generated — the
  // factual-record (tokens, cost, text) is still the original but the
  // reply may look stale relative to the edited question. See §10.6
  // "stale reply?" hint. Surfaced as a row in the info panel so the
  // reading lane stays calm.
  staleReplyHint?: boolean
}

// Detail panel revealed via the ⓘ button on each message. Contains the
// metadata we used to dump as always-visible chips (model, timestamps,
// token breakdown, cost). Quiet two-column layout, no badges.
export function MessageInfo({ message, staleReplyHint }: MessageInfoProps) {
  const gen = message.generation
  const usage = gen?.usage
  const start = gen?.startedAt
  const end = gen?.finishedAt
  const elapsedSec =
    typeof start === 'number' && typeof end === 'number' && end >= start
      ? (end - start) / 1000
      : undefined
  const completionTokens = usage?.completion_tokens
  const tokenPerSec =
    elapsedSec && elapsedSec > 0 && completionTokens
      ? completionTokens / elapsedSec
      : undefined
  const rows: Array<[string, React.ReactNode]> = []
  rows.push(['Created', new Date(message.createdAt).toLocaleString()])
  if (message.editedAt) {
    rows.push([
      'Edited',
      `${new Date(message.editedAt).toLocaleString()} (original token count and cost unchanged)`,
    ])
  }
  if (message.origin === 'imported') {
    rows.push(['Origin', 'Imported from another source'])
  }
  if (gen?.model) {
    rows.push([
      'Model',
      gen.requestedModel && gen.requestedModel !== gen.model ? (
        <span title={`Requested ${gen.requestedModel} → served ${gen.model}`}>
          {gen.model}
        </span>
      ) : (
        gen.model
      ),
    ])
  }
  if (usage?.prompt_tokens !== undefined) {
    rows.push(['Prompt tokens', usage.prompt_tokens.toLocaleString()])
  }
  if (usage?.completion_tokens !== undefined) {
    rows.push(['Completion tokens', usage.completion_tokens.toLocaleString()])
  }
  const reasoningTok = usage?.completion_tokens_details?.reasoning_tokens
  if (reasoningTok) {
    rows.push(['Reasoning tokens', reasoningTok.toLocaleString()])
  }
  const cachedTok = usage?.prompt_tokens_details?.cached_tokens
  if (cachedTok) {
    rows.push(['Cache read', cachedTok.toLocaleString()])
  }
  const cacheWrite = usage?.cache_creation_input_tokens
  if (cacheWrite) {
    rows.push(['Cache write', cacheWrite.toLocaleString()])
  }
  if (gen?.cost !== undefined) {
    const prefix = gen.costSource === 'estimated' ? '≈ ' : ''
    rows.push(['Cost', `${prefix}$${gen.cost.toFixed(6)}`])
  }
  if (elapsedSec !== undefined) {
    rows.push(['Latency', `${elapsedSec.toFixed(2)} s`])
  }
  if (tokenPerSec !== undefined) {
    rows.push(['Throughput', `${tokenPerSec.toFixed(1)} tok/s`])
  }
  if (gen?.apiUsed) {
    rows.push(['API', gen.apiUsed])
  }
  if (gen?.delivery) {
    rows.push(['Delivery', gen.delivery])
  }
  if (staleReplyHint) {
    rows.push([
      'Note',
      'Previous user message was edited after this reply — text may be stale.',
    ])
  }
  return (
    <dl data-ui="message-info">
      {rows.map(([label, value]) => (
        <div key={label} data-ui="message-info-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
