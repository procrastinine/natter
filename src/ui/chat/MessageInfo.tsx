import { normalizeReasoningDetails } from '../../core/reasoning'
import type { GenerationMeta, Message as MessageRow, ReasoningDetail } from '../../core/types'

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
  const normalizedReasoning = normalizeReasoningDetails(message.reasoningDetails ?? [])
  const start = gen?.startedAt
  const end = gen?.finishedAt
  const elapsedSec =
    typeof start === 'number' && typeof end === 'number' && end >= start
      ? (end - start) / 1000
      : undefined
  const completionTokens = usage?.completion_tokens
  const tokenPerSec =
    elapsedSec && elapsedSec > 0 && completionTokens ? completionTokens / elapsedSec : undefined
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
        <span key="model-served" title={`Requested ${gen.requestedModel} → served ${gen.model}`}>
          {gen.model}
        </span>
      ) : (
        gen.model
      ),
    ])
  }
  // Resolved provider. Only present on OpenRouter — native providers
  // don't surface it. Rendering here (instead of as a header chip)
  // keeps the reading lane quiet; users who care click ⓘ.
  if (gen?.provider) {
    rows.push(['Provider', gen.provider])
  }
  if (gen?.requestedModels && gen.requestedModels.length > 1) {
    // Fallback chain was consulted — e.g. requested [gpt-5.4, gpt-5.4-mini].
    // Show the full chain so the user can see where the cascade landed.
    rows.push(['Fallback chain', gen.requestedModels.join(' → ')])
  }
  if (usage?.prompt_tokens !== undefined) {
    rows.push(['Prompt tokens', usage.prompt_tokens.toLocaleString()])
  }
  if (usage?.completion_tokens !== undefined) {
    rows.push(['Completion tokens', usage.completion_tokens.toLocaleString()])
  }
  const reasoningTok = usage?.completion_tokens_details?.reasoning_tokens
  const hasReasoningBreakout =
    (typeof reasoningTok === 'number' && reasoningTok > 0) ||
    normalizedReasoning.length > 0
  const answerTokens =
    hasReasoningBreakout && usage?.completion_tokens !== undefined && reasoningTok !== undefined
      ? Math.max(0, usage.completion_tokens - reasoningTok)
      : undefined
  if (answerTokens !== undefined) {
    rows.push(['Answer tokens', answerTokens.toLocaleString()])
  }
  if (reasoningTok) {
    rows.push(['Reasoning tokens', reasoningTok.toLocaleString()])
  } else {
    const reasoningChars = summarizeReasoningChars(normalizedReasoning)
    if (reasoningChars.total > 0) {
      rows.push(['Reasoning chars', formatReasoningChars(reasoningChars)])
    }
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
  const reasoningTiming = reasoningTimingRow(gen)
  if (reasoningTiming) {
    rows.push(reasoningTiming)
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
    rows.push(['Note', 'Previous user message was edited after this reply — text may be stale.'])
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

function summarizeReasoningChars(details: ReasoningDetail[]): {
  text: number
  summary: number
  encrypted: number
  total: number
} {
  let text = 0
  let summary = 0
  let encrypted = 0
  for (const detail of normalizeReasoningDetails(details)) {
    if (detail.type === 'reasoning.text') text += detail.text?.length ?? 0
    else if (detail.type === 'reasoning.summary') summary += detail.summary?.length ?? 0
    else if (detail.type === 'reasoning.encrypted') encrypted += detail.data?.length ?? 0
  }
  return { text, summary, encrypted, total: text + summary + encrypted }
}

function formatReasoningChars(counts: {
  text: number
  summary: number
  encrypted: number
  total: number
}): string {
  const parts: string[] = []
  if (counts.text > 0) parts.push(`text ${counts.text.toLocaleString()}`)
  if (counts.summary > 0) parts.push(`summary ${counts.summary.toLocaleString()}`)
  if (counts.encrypted > 0) parts.push(`encrypted ${counts.encrypted.toLocaleString()}`)
  if (parts.length === 0) return counts.total.toLocaleString()
  return `${counts.total.toLocaleString()} total (${parts.join(', ')})`
}

function reasoningTimingRow(gen: GenerationMeta | undefined): [string, string] | null {
  if (!gen || gen.reasoningStartedAt === undefined) return null
  const end =
    gen.firstTextAt !== undefined && gen.firstTextAt >= gen.reasoningStartedAt
      ? gen.firstTextAt
      : gen.reasoningFinishedAt ?? gen.finishedAt
  if (end === undefined || end <= gen.reasoningStartedAt) return null
  const seconds = ((end - gen.reasoningStartedAt) / 1000).toFixed(2)
  const value =
    gen.firstTextAt !== undefined && gen.firstTextAt >= gen.reasoningStartedAt
      ? `${seconds} s before answer`
      : `${seconds} s`
  return ['Reasoning time', value]
}
