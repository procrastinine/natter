import type { ReasoningDetail } from '../../core/types'

export interface ReasoningBlockProps {
  details: ReasoningDetail[]
}

// Filter + partition: OpenRouter occasionally leaks tool-call signatures into
// `reasoning_details[]` (CLAUDE.md cross-provider landmine). Drop those before
// we try to read anything. Then partition by reasoning shape so a message that
// returns BOTH `reasoning.text` and `reasoning.summary` (common on Claude) can
// render each section cleanly.
function partitionReasoning(details: ReasoningDetail[]): {
  text: Array<Extract<ReasoningDetail, { type: 'reasoning.text' }>>
  summary: Array<Extract<ReasoningDetail, { type: 'reasoning.summary' }>>
  encrypted: Array<Extract<ReasoningDetail, { type: 'reasoning.encrypted' }>>
} {
  const text: Array<Extract<ReasoningDetail, { type: 'reasoning.text' }>> = []
  const summary: Array<Extract<ReasoningDetail, { type: 'reasoning.summary' }>> = []
  const encrypted: Array<Extract<ReasoningDetail, { type: 'reasoning.encrypted' }>> = []
  for (const entry of details) {
    if (entry.id && entry.id.startsWith('tool_')) continue
    if (entry.type === 'reasoning.text') text.push(entry)
    else if (entry.type === 'reasoning.summary') summary.push(entry)
    else if (entry.type === 'reasoning.encrypted') encrypted.push(entry)
  }
  return { text, summary, encrypted }
}

export function ReasoningBlock({ details }: ReasoningBlockProps) {
  if (details.length === 0) return null
  const parts = partitionReasoning(details)
  const total = parts.text.length + parts.summary.length + parts.encrypted.length
  if (total === 0) return null
  const hasEncrypted = parts.encrypted.length > 0
  const format = hasEncrypted
    ? 'encrypted'
    : parts.summary.length > 0 && parts.text.length === 0
      ? 'summary'
      : 'plaintext'
  return (
    <details data-ui="reasoning" data-reasoning-format={format} data-reasoning-count={total}>
      <summary data-ui="reasoning-summary">
        <span>Reasoning ({total})</span>
        <span data-ui="reasoning-badge" data-kind={format}>
          {format}
        </span>
      </summary>
      <div data-ui="reasoning-details">
        {parts.summary.length > 0 ? (
          <section data-ui="reasoning-section" data-reasoning-kind="summary">
            {parts.summary.map((entry, idx) => (
              <p key={keyFor(entry, 'summary', idx)}>
                {textOrFallback(entry.summary, 'Empty summary.')}
              </p>
            ))}
          </section>
        ) : null}
        {parts.text.length > 0 ? (
          <section data-ui="reasoning-section" data-reasoning-kind="text">
            {parts.text.map((entry, idx) => (
              <p key={keyFor(entry, 'text', idx)}>
                {textOrFallback(entry.text, 'Empty reasoning block.')}
              </p>
            ))}
          </section>
        ) : null}
        {parts.encrypted.length > 0 ? (
          <section data-ui="reasoning-section" data-reasoning-kind="encrypted">
            {parts.encrypted.map((entry, idx) => (
              <p key={keyFor(entry, 'encrypted', idx)} data-state="encrypted">
                <em>Encrypted reasoning preserved — {(entry.data ?? '').length} chars.</em>
              </p>
            ))}
          </section>
        ) : null}
      </div>
    </details>
  )
}

function keyFor(entry: ReasoningDetail, kind: string, index: number): string {
  return entry.id ?? `reasoning-${kind}-${index}`
}

// `text?: string` in our type means undefined is possible, but wire payloads
// may also send literal null when a provider hasn't produced text yet. Treat
// both the same way.
function textOrFallback(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback
  const trimmed = raw.trim()
  return trimmed.length === 0 ? fallback : raw
}
