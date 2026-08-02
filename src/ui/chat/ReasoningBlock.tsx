// Per-message reasoning panel. Three independent disclosures (Summary /
// Details / Encrypted) can each be present on a single turn — OpenAI
// Responses returns summary + encrypted, Gemini returns summary + signature,
// Claude returns text + signature, DeepSeek/Qwen return text only. The outer
// disclosure lets the reader collapse the whole block; the inner ones let
// them zoom in.
//
// Auto-expand / auto-collapse:
// - `streaming === true` + the message has no content yet → force-open (the
//   reasoning lane is receiving).
// - content has started AND the user hasn't clicked → collapse once. The
//   click pins the panel open (sticky chevron) for the rest of the turn.
// - after the stream finishes, the panel stays in whatever state the user
//   last chose.
//
// Per-row hide toggles address stable envelope member identities. Hidden
// members remain on disk but are omitted from the next-turn wire projection.

import { type KeyboardEvent, memo, useEffect, useRef, useState } from 'react'
import type { ConversationMutationSettlement } from '../../app/presentation-interactions'
import type { ReasoningPresentation } from '../../core/reasoning-envelope'
import type { ReasoningMemberRef } from '../../core/types'
import { PencilIcon } from '../icons/Icon'
import { Button } from '../primitives/Button'

type VisibleReasoningMemberRef = Extract<ReasoningMemberRef, { kind: 'visible' }>

interface ReasoningBlockProps {
  presentation: ReasoningPresentation
  streaming?: boolean
  deferContentUntilOpen?: boolean
  // True when the message body already has visible content. Drives the
  // auto-collapse rule: the panel stays open until content starts so the
  // user can watch tokens stream into reasoning, then folds away on first
  // content token unless pinned open.
  hasContent?: boolean
  // Caller-supplied toggle for per-row hide. When omitted, the eye icons
  // don't render (read-only view).
  onToggleHidden?: (member: ReasoningMemberRef) => ConversationMutationSettlement
  toggleHiddenDisabled?: boolean
  onEditVisible?: (
    member: VisibleReasoningMemberRef,
    text: string,
  ) => ConversationMutationSettlement
  editDisabled?: boolean
}

export const ReasoningBlock = memo(function ReasoningBlock({
  presentation,
  streaming = false,
  deferContentUntilOpen = false,
  hasContent = false,
  onToggleHidden,
  toggleHiddenDisabled = false,
  onEditVisible,
  editDisabled = false,
}: ReasoningBlockProps) {
  const parts = presentation
  const total = presentation.rowCount
  const format = presentation.kind

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

  const totalEncryptedBytes = presentation.preservedCarrierBytes
  const carrierNotice = reasoningCarrierNotice(presentation)

  if (!presentation.hasReasoning) return null

  return (
    <details
      data-ui="reasoning"
      data-reasoning-format={format}
      data-reasoning-count={total}
      data-pinned={pinnedOpen ? 'true' : undefined}
      open={open}
      onToggle={(e) => {
        setOpen(e.currentTarget.open)
        if (e.nativeEvent.isTrusted) setPinnedOpen(true)
      }}
    >
      <summary data-ui="reasoning-summary">
        <span data-ui="reasoning-title">Reasoning</span>
        {total > 0 ? <span data-ui="reasoning-count">· {total}</span> : null}
        {carrierNotice ? (
          <span
            data-ui="reasoning-lock"
            data-kind={carrierNotice.kind}
            title={`${carrierNotice.label} — ${formatBytes(totalEncryptedBytes)}`}
            role="img"
            aria-label={`${carrierNotice.label}, ${formatBytes(totalEncryptedBytes)}`}
          >
            <LockIcon />
          </span>
        ) : null}
        <span data-ui="reasoning-badge" data-kind={format}>
          {format}
        </span>
      </summary>
      {!deferContentUntilOpen || open ? (
        <div data-ui="reasoning-details">
          {parts.summary.length > 0 ? (
            <NestedSection kind="summary" label="Summary" defaultOpen>
              {parts.summary.map((entry) => (
                <ReasoningRow
                  key={keyFor(entry.owner, entry.part, 'summary')}
                  kind="summary"
                  hidden={entry.part.hidden === true}
                  toggleHiddenDisabled={toggleHiddenDisabled}
                  editDisabled={editDisabled}
                  {...(entry.text !== undefined ? { initialText: entry.text } : {})}
                  {...(onEditVisible && !entry.valueSections
                    ? {
                        onEdit: (text: string) =>
                          onEditVisible(
                            {
                              owner: entry.owner,
                              kind: 'visible',
                              id: entry.part.id,
                            },
                            text,
                          ),
                      }
                    : {})}
                  {...(onToggleHidden
                    ? {
                        onToggleHidden: () =>
                          onToggleHidden({
                            owner: entry.owner,
                            kind: 'visible',
                            id: entry.part.id,
                          }),
                      }
                    : {})}
                >
                  {reasoningText(entry, entry.text, 'Empty summary.')}
                </ReasoningRow>
              ))}
            </NestedSection>
          ) : null}
          {parts.text.length > 0 ? (
            <NestedSection kind="text" label="Details" defaultOpen={parts.summary.length === 0}>
              {parts.text.map((entry) => (
                <ReasoningRow
                  key={keyFor(entry.owner, entry.part, 'text')}
                  kind="text"
                  hidden={entry.part.hidden === true}
                  toggleHiddenDisabled={toggleHiddenDisabled}
                  editDisabled={editDisabled}
                  {...(entry.text !== undefined ? { initialText: entry.text } : {})}
                  {...(onEditVisible && !entry.valueSections
                    ? {
                        onEdit: (text: string) =>
                          onEditVisible(
                            {
                              owner: entry.owner,
                              kind: 'visible',
                              id: entry.part.id,
                            },
                            text,
                          ),
                      }
                    : {})}
                  {...(onToggleHidden
                    ? {
                        onToggleHidden: () =>
                          onToggleHidden({
                            owner: entry.owner,
                            kind: 'visible',
                            id: entry.part.id,
                          }),
                      }
                    : {})}
                >
                  {reasoningText(entry, entry.text, 'Empty reasoning block.')}
                </ReasoningRow>
              ))}
            </NestedSection>
          ) : null}
          {parts.opaque.length > 0 ? (
            <NestedSection kind="encrypted" label="Encrypted" defaultOpen>
              {parts.opaque.map((entry) => (
                <ReasoningRow
                  key={keyFor(entry.owner, entry.carrier, 'encrypted')}
                  kind="encrypted"
                  hidden={entry.carrier.hidden === true}
                  toggleHiddenDisabled={toggleHiddenDisabled}
                  {...(onToggleHidden
                    ? {
                        onToggleHidden: () =>
                          onToggleHidden({
                            owner: entry.owner,
                            kind: 'carrier',
                            id: entry.carrier.id,
                          }),
                      }
                    : {})}
                >
                  <LockIcon />
                  <em>
                    Encrypted reasoning preserved — {formatBytes(entry.valueLength)} ·{' '}
                    {entry.carrier.format}
                  </em>
                </ReasoningRow>
              ))}
            </NestedSection>
          ) : null}
        </div>
      ) : null}
    </details>
  )
})

function ReasoningRow({
  kind,
  hidden,
  initialText,
  onEdit,
  editDisabled = false,
  onToggleHidden,
  toggleHiddenDisabled = false,
  children,
}: {
  kind: 'summary' | 'text' | 'encrypted'
  hidden: boolean
  initialText?: string
  onEdit?: (text: string) => ConversationMutationSettlement
  editDisabled?: boolean
  onToggleHidden?: () => ConversationMutationSettlement
  toggleHiddenDisabled?: boolean
  children: React.ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const editLabel = kind === 'summary' ? 'Edit reasoning summary' : 'Edit reasoning details'
  useEffect(() => {
    if (editing) editorRef.current?.focus()
  }, [editing])
  const beginEdit = () => {
    if (initialText === undefined || editDisabled) return
    setDraft(initialText)
    setEditing(true)
  }
  const cancelEdit = () => {
    if (busy) return
    setEditing(false)
  }
  const saveEdit = () => {
    if (!onEdit || initialText === undefined || editDisabled || busy) return
    if (draft === initialText) {
      setEditing(false)
      return
    }
    setBusy(true)
    void onEdit(draft).then((outcome) => {
      setBusy(false)
      if (outcome.kind === 'succeeded') setEditing(false)
    })
  }
  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelEdit()
      return
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      saveEdit()
    }
  }

  return (
    <div
      data-ui="reasoning-row"
      data-reasoning-kind={kind}
      data-hidden={hidden ? 'true' : undefined}
    >
      {editing ? (
        <div data-ui="reasoning-row-editor">
          <textarea
            ref={editorRef}
            data-ui="reasoning-row-editor-input"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={handleEditorKeyDown}
            disabled={busy || editDisabled}
            aria-label={editLabel}
          />
          <div data-ui="reasoning-row-editor-actions">
            <Button type="button" appearance="ghost" size="xs" onClick={cancelEdit} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              tone="accent"
              appearance="solid"
              size="xs"
              onClick={saveEdit}
              disabled={busy || editDisabled}
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p
            data-ui="reasoning-row-body"
            {...(kind === 'encrypted' ? { 'data-state': 'encrypted' } : {})}
          >
            {children}
          </p>
          {onEdit || onToggleHidden ? (
            <div data-ui="reasoning-row-actions">
              {onEdit && initialText !== undefined ? (
                <Button
                  type="button"
                  data-ui="reasoning-row-edit"
                  onClick={beginEdit}
                  disabled={editDisabled}
                  aria-label={editLabel}
                  title={
                    editDisabled
                      ? 'Wait for this generation to finish before editing reasoning.'
                      : editLabel
                  }
                >
                  <PencilIcon size={12} />
                </Button>
              ) : null}
              {onToggleHidden ? (
                <Button
                  type="button"
                  data-ui="reasoning-row-hide"
                  data-pressed={hidden ? 'true' : undefined}
                  onClick={() => {
                    void onToggleHidden()
                  }}
                  disabled={toggleHiddenDisabled}
                  aria-label={hidden ? 'Unhide this reasoning block' : 'Hide this reasoning block'}
                  title={
                    toggleHiddenDisabled
                      ? 'Wait for this generation to finish before changing reasoning visibility.'
                      : hidden
                        ? 'Hidden — preserved on disk, skipped on next-turn echo. Click to unhide.'
                        : 'Hide this reasoning block (kept on disk, skipped on echo).'
                  }
                >
                  {hidden ? <EyeOffIcon /> : <EyeIcon />}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
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

function keyFor(owner: ReasoningMemberRef['owner'], entry: { id: string }, kind: string): string {
  const ownerKey = owner.kind === 'generation' ? 'generation' : `continuation:${owner.streamId}`
  return `${ownerKey}:${kind}:${entry.id}`
}

function reasoningCarrierNotice(
  presentation: ReasoningPresentation,
): Readonly<{ kind: 'authentication' | 'encrypted' | 'mixed'; label: string }> | undefined {
  const hasAuthentication = presentation.authenticationCarrierBytes > 0
  const hasEncrypted = presentation.opaqueCarrierBytes > 0
  if (hasAuthentication && hasEncrypted) {
    return { kind: 'mixed', label: 'Encrypted reasoning and authentication preserved' }
  }
  if (hasAuthentication) {
    return { kind: 'authentication', label: 'Reasoning authentication preserved' }
  }
  if (hasEncrypted) return { kind: 'encrypted', label: 'Encrypted reasoning preserved' }
  return undefined
}

function textOrFallback(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback
  const trimmed = raw.trim()
  return trimmed.length === 0 ? fallback : raw
}

function reasoningText(
  entry: {
    valueSections?: readonly string[]
    pendingValue?: string
    valueLength: number
  },
  raw: string | null | undefined,
  fallback: string,
): React.ReactNode {
  if (!entry.valueSections) return textOrFallback(raw, fallback)
  if (entry.valueLength === 0) return fallback
  return (
    <>
      {entry.valueSections}
      {entry.pendingValue}
    </>
  )
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
