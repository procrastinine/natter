// Per-message reasoning panel. Three independent disclosures (Summary /
// Details / Encrypted) can each be present on a single turn — OpenAI
// Responses returns summary + encrypted, Gemini returns summary + signature,
// Claude returns text + signature, DeepSeek/Qwen return text only. The outer
// disclosure lets the reader collapse the whole block; the inner ones let
// them zoom in. See `plan/10-ui.md §10.8`.
//
// Auto-expand / auto-collapse:
// - `streaming === true` + the message has no content yet → force-open (the
//   reasoning lane is receiving).
// - content has started AND the user hasn't clicked → collapse once. The
//   click pins the panel open (sticky chevron) for the rest of the turn.
// - after the stream finishes, the panel stays in whatever state the user
//   last chose.
//
// Per-row hide toggle: each displayed entry carries its index in `details`
// so the reader can mark an individual block `hidden: true` from the view.
// Hidden blocks remain on disk but are filtered out of the next-turn echo
// via `filterReasoningForInclude`.

import { useEffect, useRef, useState } from 'react'
import { normalizeReasoningDetails } from '../../core/reasoning'
import type { ReasoningDetail } from '../../core/types'

export interface ReasoningBlockProps {
  details: ReasoningDetail[]
  streaming?: boolean
  // True when the message body already has visible content. Drives the
  // auto-collapse rule: the panel stays open until content starts so the
  // user can watch tokens stream into reasoning, then folds away on first
  // content token unless pinned open.
  hasContent?: boolean
  // Caller-supplied toggle for per-row hide. When omitted, the eye icons
  // don't render (read-only view).
  onToggleHidden?: (detailIndex: number) => void
}

type PartitionEntry<T extends ReasoningDetail> = T & { __detailIndex: number }

interface Partitioned {
  text: PartitionEntry<Extract<ReasoningDetail, { type: 'reasoning.text' }>>[]
  summary: PartitionEntry<Extract<ReasoningDetail, { type: 'reasoning.summary' }>>[]
  encrypted: PartitionEntry<Extract<ReasoningDetail, { type: 'reasoning.encrypted' }>>[]
}

function partitionReasoning(details: ReasoningDetail[]): Partitioned {
  const text: Partitioned['text'] = []
  const summary: Partitioned['summary'] = []
  const encrypted: Partitioned['encrypted'] = []
  // Normalize for display coherence: collapses overlap-duplicated text
  // chunks (legacy rows, or Claude's mirrored `reasoning` + `reasoning_details`)
  // and relabels Gemini 3 summaries that still arrive as `.text`. The
  // normalized output's indices are what `onToggleHidden` forwards — the
  // parent (Message.tsx) normalizes with the same pass, so a click maps
  // 1:1 to its `reasoning[i]`. Tool-call leakages (id `tool_…`) are
  // dropped inside `normalizeReasoningDetails`.
  const normalized = normalizeReasoningDetails(details)
  for (let i = 0; i < normalized.length; i += 1) {
    const entry = normalized[i]
    if (!entry) continue
    if (entry.type === 'reasoning.text') {
      text.push({ ...entry, __detailIndex: i })
    } else if (entry.type === 'reasoning.summary') {
      summary.push({ ...entry, __detailIndex: i })
    } else if (entry.type === 'reasoning.encrypted') {
      encrypted.push({ ...entry, __detailIndex: i })
    }
  }
  return { text, summary, encrypted }
}

export function ReasoningBlock({
  details,
  streaming = false,
  hasContent = false,
  onToggleHidden,
}: ReasoningBlockProps) {
  const parts = partitionReasoning(details)
  const total = parts.text.length + parts.summary.length + parts.encrypted.length
  const format = reasoningFormatTag(parts)
  const canToggle = typeof onToggleHidden === 'function'

  // Auto-expand on first chunk while streaming; auto-collapse once content
  // starts unless the user has pinned the panel. `pinnedOpen` sticks on
  // ANY user toggle, once the chevron is poked the auto-collapse stops.
  const [pinnedOpen, setPinnedOpen] = useState(false)
  const [open, setOpen] = useState(() => streaming && !hasContent)
  const lastHadContentRef = useRef(hasContent)
  useEffect(() => {
    if (pinnedOpen) return
    if (streaming && !hasContent) {
      setOpen(true)
      return
    }
    // Transition: content just arrived — collapse once.
    if (hasContent && !lastHadContentRef.current) {
      setOpen(false)
    }
    lastHadContentRef.current = hasContent
  }, [streaming, hasContent, pinnedOpen])

  const totalEncryptedBytes = parts.encrypted.reduce((acc, e) => acc + (e.data ?? '').length, 0)

  if (details.length === 0 || total === 0) return null

  return (
    <details
      data-ui="reasoning"
      data-reasoning-format={format}
      data-reasoning-count={total}
      data-pinned={pinnedOpen ? 'true' : undefined}
      open={open}
      onToggle={(e) => {
        const isOpen = (e.currentTarget as HTMLDetailsElement).open
        setOpen(isOpen)
        setPinnedOpen(true)
      }}
    >
      <summary data-ui="reasoning-summary">
        <span data-ui="reasoning-title">Reasoning</span>
        <span data-ui="reasoning-count">
          · {total}
        </span>
        {totalEncryptedBytes > 0 ? (
          <span
            data-ui="reasoning-lock"
            title={`Encrypted reasoning preserved — ${formatBytes(totalEncryptedBytes)}`}
            role="img"
            aria-label={`Encrypted reasoning preserved, ${formatBytes(totalEncryptedBytes)}`}
          >
            <LockIcon />
          </span>
        ) : null}
        <span data-ui="reasoning-badge" data-kind={format}>
          {format}
        </span>
      </summary>
      <div data-ui="reasoning-details">
        {parts.summary.length > 0 ? (
          <NestedSection kind="summary" label="Summary" defaultOpen>
            {parts.summary.map((entry, idx) => (
              <ReasoningRow
                key={keyFor(entry, 'summary', idx)}
                kind="summary"
                hidden={entry.hidden === true}
                {...(canToggle
                  ? { onToggleHidden: () => onToggleHidden?.(entry.__detailIndex) }
                  : {})}
              >
                {textOrFallback(entry.summary, 'Empty summary.')}
              </ReasoningRow>
            ))}
          </NestedSection>
        ) : null}
        {parts.text.length > 0 ? (
          <NestedSection kind="text" label="Details" defaultOpen={parts.summary.length === 0}>
            {parts.text.map((entry, idx) => (
              <ReasoningRow
                key={keyFor(entry, 'text', idx)}
                kind="text"
                hidden={entry.hidden === true}
                {...(canToggle
                  ? { onToggleHidden: () => onToggleHidden?.(entry.__detailIndex) }
                  : {})}
              >
                {textOrFallback(entry.text, 'Empty reasoning block.')}
              </ReasoningRow>
            ))}
          </NestedSection>
        ) : null}
        {parts.encrypted.length > 0 ? (
          <NestedSection kind="encrypted" label="Encrypted" defaultOpen>
            {parts.encrypted.map((entry, idx) => (
              <ReasoningRow
                key={keyFor(entry, 'encrypted', idx)}
                kind="encrypted"
                hidden={entry.hidden === true}
                {...(canToggle
                  ? { onToggleHidden: () => onToggleHidden?.(entry.__detailIndex) }
                  : {})}
              >
                <LockIcon />
                <em>
                  Encrypted reasoning preserved — {formatBytes((entry.data ?? '').length)}
                  {entry.format ? ` · ${entry.format}` : ''}
                </em>
              </ReasoningRow>
            ))}
          </NestedSection>
        ) : null}
      </div>
    </details>
  )
}

function ReasoningRow({
  kind,
  hidden,
  onToggleHidden,
  children,
}: {
  kind: 'summary' | 'text' | 'encrypted'
  hidden: boolean
  onToggleHidden?: () => void
  children: React.ReactNode
}) {
  return (
    <div
      data-ui="reasoning-row"
      data-reasoning-kind={kind}
      data-hidden={hidden ? 'true' : undefined}
    >
      <p data-ui="reasoning-row-body" {...(kind === 'encrypted' ? { 'data-state': 'encrypted' } : {})}>
        {children}
      </p>
      {onToggleHidden ? (
        <button
          type="button"
          data-ui="reasoning-row-hide"
          data-pressed={hidden ? 'true' : undefined}
          onClick={onToggleHidden}
          aria-label={hidden ? 'Unhide this reasoning block' : 'Hide this reasoning block'}
          title={
            hidden
              ? 'Hidden — preserved on disk, skipped on next-turn echo. Click to unhide.'
              : 'Hide this reasoning block (kept on disk, skipped on echo).'
          }
        >
          {hidden ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      ) : null}
    </div>
  )
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="12" height="12">
      <path
        d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="12" height="12">
      <path
        d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <path d="M2 2l12 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function NestedSection({
  kind,
  label,
  defaultOpen,
  children,
}: {
  kind: 'summary' | 'text' | 'encrypted'
  label: string
  defaultOpen: boolean
  children: React.ReactNode
}) {
  return (
    <details data-ui="reasoning-section" data-reasoning-kind={kind} open={defaultOpen}>
      <summary data-ui="reasoning-section-summary">{label}</summary>
      <div data-ui="reasoning-section-body">{children}</div>
    </details>
  )
}

function reasoningFormatTag(parts: Partitioned): 'encrypted' | 'summary' | 'plaintext' {
  if (parts.encrypted.length > 0) return 'encrypted'
  if (parts.summary.length > 0 && parts.text.length === 0) return 'summary'
  return 'plaintext'
}

function keyFor(entry: ReasoningDetail, kind: string, index: number): string {
  return entry.id ?? `reasoning-${kind}-${index}`
}

function textOrFallback(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback
  const trimmed = raw.trim()
  return trimmed.length === 0 ? fallback : raw
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} chars`
  const kb = n / 1024
  return kb >= 10 ? `${kb.toFixed(0)} KB` : `${kb.toFixed(1)} KB`
}

function LockIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      width="11"
      height="11"
      data-ui="reasoning-lock-icon"
    >
      <rect
        x="3"
        y="7"
        width="10"
        height="7"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}
