// In-place edit surface for a single message. Plaintext for content; a
// "Reasoning" advanced disclosure exposes each text-/summary-type
// reasoning detail for inline editing (encrypted entries stay read-only
// because their opaque carrier is provider-native and not safe to hand-
// edit).
//
// The action row at the bottom mirrors the composer Send slot: edge-to-
// edge full-width buttons with no internal padding. Save is the primary
// action, Save & Send is the accent action for user messages.

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type {
  AttachmentRef,
  ContentItem,
  MessageAttachmentRef,
  ReasoningDetail,
} from '../../core/types'
import { AttachmentDraftTray } from '../attachments/AttachmentDraftTray'
import { AttachmentPicker } from '../attachments/AttachmentPicker'
import { useAttachmentDrafts } from '../attachments/useAttachmentDrafts'
import { DatabaseIcon, PaperclipIcon, PrefillIcon } from '../icons/Icon'

interface InlineEditorProps {
  initial: string
  onSave: (
    text: string,
    reasoning?: ReasoningDetail[],
    attachmentRefs?: MessageAttachmentRef[],
  ) => void | Promise<void>
  onCancel: () => void
  onSaveAndSend?: (
    text: string,
    opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
  ) => void | Promise<void>
  saveAndSendDisabled?: boolean
  saveAndSendDisabledReason?: string
  ariaLabel?: string
  // Optional starting reasoning-details list. When provided, the
  // "Reasoning" disclosure is rendered; on save, the edited list is
  // passed back via onSave's second argument. Keep reference stable
  // across renders to avoid resetting the disclosure state.
  initialReasoning?: ReasoningDetail[]
  initialAttachmentRefs?: readonly AttachmentRef[] | undefined
  // Prefill toggle for Save & Send. Only applied to user messages
  // (assistants don't have a "send" path). Hidden when the model doesn't
  // support prefill. Empty / whitespace-only prefill text is treated as
  // "no prefill" (matches the composer's behavior).
  showPrefillButton?: boolean
  defaultPrefill?: string
  prefillSettingsPrompt?: ReactNode
}

const MIN_TEXTAREA_ROWS = 6
const MAX_TEXTAREA_PX = 600

// Extract the single plaintext run from a message's content array. Phase 8.1
// only edits text lanes; multi-modal content stays untouched on commit.
export function plaintextOf(content: readonly ContentItem[]): string {
  return content
    .map((item) => (item.type === 'text' || item.type === 'output_text' ? item.text : ''))
    .join('')
}

export function writeTextInto(prev: readonly ContentItem[], nextText: string): ContentItem[] {
  let replaced = false
  const out: ContentItem[] = []
  for (const item of prev) {
    if (!replaced && (item.type === 'text' || item.type === 'output_text')) {
      out.push({ ...item, text: nextText })
      replaced = true
      continue
    }
    out.push(item)
  }
  if (!replaced) {
    out.push({ type: 'text', text: nextText })
  }
  return out
}

function autosize(el: HTMLTextAreaElement | null): void {
  if (!el) return
  el.style.height = 'auto'
  const next = Math.min(el.scrollHeight, MAX_TEXTAREA_PX)
  el.style.height = `${next}px`
}

type EditableReasoning =
  | {
      kind: 'text'
      text: string
      index: number
      hidden: boolean
      original: ReasoningDetail | null
    }
  | {
      kind: 'summary'
      summary: string
      index: number
      hidden: boolean
      original: ReasoningDetail | null
    }
  | {
      kind: 'encrypted'
      index: number
      hidden: boolean
      original: ReasoningDetail
      bytes: number
    }

function toEditable(list: ReasoningDetail[]): EditableReasoning[] {
  return list.map((detail, i) => {
    const hidden = detail.hidden === true
    if (detail.type === 'reasoning.text') {
      return {
        kind: 'text',
        text: detail.text ?? '',
        index: detail.index ?? i,
        hidden,
        original: detail,
      }
    }
    if (detail.type === 'reasoning.summary') {
      return {
        kind: 'summary',
        summary: detail.summary,
        index: detail.index ?? i,
        hidden,
        original: detail,
      }
    }
    return {
      kind: 'encrypted',
      index: detail.index ?? i,
      hidden,
      original: detail,
      bytes: new Blob([detail.data ?? '']).size,
    }
  })
}

function fromEditable(list: EditableReasoning[]): ReasoningDetail[] {
  return list.map((row) => {
    if (row.kind === 'text') {
      // `original` is null for rows the user added via "Add reasoning entry".
      // Synthesize a minimal reasoning.text detail with the current index so
      // downstream merge/filter logic treats it like any other entry.
      const base = row.original ?? { type: 'reasoning.text', index: row.index }
      return {
        ...base,
        type: 'reasoning.text',
        text: row.text,
        hidden: row.hidden || undefined,
      } as ReasoningDetail
    }
    if (row.kind === 'summary') {
      const base = row.original ?? { type: 'reasoning.summary', index: row.index, summary: '' }
      return {
        ...base,
        type: 'reasoning.summary',
        summary: row.summary,
        hidden: row.hidden || undefined,
      } as ReasoningDetail
    }
    return {
      ...row.original,
      hidden: row.hidden || undefined,
    } as ReasoningDetail
  })
}

export function InlineEditor({
  initial,
  onSave,
  onCancel,
  onSaveAndSend,
  saveAndSendDisabled,
  saveAndSendDisabledReason,
  ariaLabel,
  initialReasoning,
  initialAttachmentRefs,
  showPrefillButton,
  defaultPrefill,
  prefillSettingsPrompt,
}: InlineEditorProps) {
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const [reasoning, setReasoning] = useState<EditableReasoning[]>(() =>
    toEditable(initialReasoning ?? []),
  )
  const attachments = useAttachmentDrafts(initialAttachmentRefs)
  const {
    initialAttachmentRefs: startingAttachmentRefs,
    attachmentRefs,
    attachmentRows,
    uploads,
    addAttachment,
    replaceAttachment,
    toggleAttachment,
    removeAttachment,
    ingestFiles,
    dismissUpload,
  } = attachments
  const [pickerOpen, setPickerOpen] = useState(false)
  const [prefillOpen, setPrefillOpen] = useState(false)
  const [prefillText, setPrefillText] = useState(defaultPrefill ?? '')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const actionsRef = useRef<HTMLDivElement | null>(null)
  const prefillTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const uploadingAttachments = uploads.some((upload) => upload.state === 'uploading')

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    // preventScroll: true so the browser doesn't align the textarea's top
    // with the viewport top (which on long assistant messages pushes the
    // Save/Cancel row below the fold). The action row is scrolled into view
    // explicitly with block: 'nearest' so the user always sees where to
    // commit or cancel.
    el.focus({ preventScroll: true })
    const end = el.value.length
    el.setSelectionRange(end, end)
    if (typeof actionsRef.current?.scrollIntoView === 'function') {
      actionsRef.current.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: text changes alter textarea scrollHeight.
  useLayoutEffect(() => {
    autosize(textareaRef.current)
  }, [text])

  const run = useCallback(
    async (
      action: (
        text: string,
        reasoning?: ReasoningDetail[],
        attachmentRefs?: MessageAttachmentRef[],
      ) => void | Promise<void>,
    ) => {
      // Empty messages are allowed — both Save (in place) and Save & Send
      // commit whatever the user typed, including an empty string.
      // Messages may legitimately be empty (placeholder turn, deliberate
      // blank). The only place empty is blocked is the composer prompt
      // input, where "send empty" has no well-defined meaning.
      const trimmed = text.trim()
      if (busy || uploadingAttachments) return
      setBusy(true)
      try {
        const nextReasoning = initialReasoning ? fromEditable(reasoning) : undefined
        await action(trimmed, nextReasoning, attachmentRefs)
      } finally {
        setBusy(false)
      }
    },
    [text, busy, uploadingAttachments, initialReasoning, reasoning, attachmentRefs],
  )
  const togglePrefill = useCallback(async () => {
    if (prefillOpen) {
      setPrefillOpen(false)
      return
    }
    setPrefillText((prev) => (prev.length === 0 ? (defaultPrefill ?? '') : prev))
    setPrefillOpen(true)
    requestAnimationFrame(() => prefillTextareaRef.current?.focus())
  }, [prefillOpen, defaultPrefill])
  // No-op Save when nothing has changed — closes the editor without
  // touching IDB, without bumping `editedAt`, and (critically) without
  // flagging the "this reply may be stale" hint on downstream
  // assistant messages. Save & Send deliberately bypasses this check;
  // the user may want to re-send even when the text is unchanged.
  const isUnchanged = useCallback(() => {
    if (text !== initial) return false
    if (JSON.stringify(startingAttachmentRefs) !== JSON.stringify(attachmentRefs)) return false
    if (!initialReasoning) return true
    const nextReasoning = fromEditable(reasoning)
    return JSON.stringify(initialReasoning) === JSON.stringify(nextReasoning)
  }, [text, initial, initialReasoning, reasoning, startingAttachmentRefs, attachmentRefs])
  const commitSave = useCallback(() => {
    if (isUnchanged()) {
      onCancel()
      return
    }
    return run(onSave)
  }, [isUnchanged, onCancel, run, onSave])
  const commitSaveAndSend = useCallback(() => {
    if (!onSaveAndSend || saveAndSendDisabled) return
    const prefillOut = prefillOpen && prefillText.trim().length > 0 ? prefillText : ''
    return run((next, _reasoning, attachmentRefs) =>
      onSaveAndSend(next, {
        ...(prefillOut.length > 0 ? { prefillText: prefillOut } : {}),
        ...(attachmentRefs && attachmentRefs.length > 0 ? { attachmentRefs } : {}),
      }),
    )
  }, [run, onSaveAndSend, saveAndSendDisabled, prefillOpen, prefillText])

  const handleKey = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (e.shiftKey && onSaveAndSend && !saveAndSendDisabled) {
          void commitSaveAndSend()
        } else {
          void commitSave()
        }
      }
    },
    [commitSave, commitSaveAndSend, onCancel, onSaveAndSend, saveAndSendDisabled],
  )

  const showReasoningSection = initialReasoning !== undefined
  const nextReasoningIndex = () => {
    const indices = reasoning.map((r) => r.index)
    return indices.length === 0 ? 0 : Math.max(...indices) + 1
  }
  const addReasoningRow = (kind: 'text' | 'summary') => {
    const idx = nextReasoningIndex()
    setReasoning((prev) =>
      kind === 'text'
        ? [...prev, { kind: 'text', text: '', index: idx, hidden: false, original: null }]
        : [...prev, { kind: 'summary', summary: '', index: idx, hidden: false, original: null }],
    )
    setReasoningOpen(true)
  }
  const deleteRow = (rowIndex: number) => {
    setReasoning((prev) => prev.filter((_, i) => i !== rowIndex))
  }
  const toggleHidden = (rowIndex: number) => {
    setReasoning((prev) => prev.map((r, i) => (i === rowIndex ? { ...r, hidden: !r.hidden } : r)))
  }

  return (
    <div data-ui="inline-editor">
      <textarea
        ref={textareaRef}
        data-ui="inline-editor-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKey}
        aria-label={ariaLabel ?? 'Edit message'}
        rows={MIN_TEXTAREA_ROWS}
        disabled={busy}
      />
      {prefillOpen ? (
        <>
          {prefillSettingsPrompt}
          <textarea
            ref={prefillTextareaRef}
            data-ui="inline-editor-prefill"
            value={prefillText}
            onChange={(e) => setPrefillText(e.target.value)}
            placeholder="Assistant prefill — the model continues from this text…"
            rows={3}
            disabled={busy}
            aria-label="Assistant prefill text"
          />
        </>
      ) : null}
      {showReasoningSection ? (
        <details
          data-ui="inline-editor-reasoning"
          open={reasoningOpen || reasoning.length === 0}
          onToggle={(e) => setReasoningOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>Reasoning ({reasoning.length})</summary>
          <div data-ui="inline-editor-reasoning-list">
            {reasoning.map((row, i) => (
              <ReasoningEditorRow
                key={`${row.kind}-${row.index}`}
                row={row}
                busy={busy}
                onChangeText={(next) =>
                  setReasoning((prev) =>
                    prev.map((p, idx) =>
                      idx === i && p.kind === 'text' ? { ...p, text: next } : p,
                    ),
                  )
                }
                onChangeSummary={(next) =>
                  setReasoning((prev) =>
                    prev.map((p, idx) =>
                      idx === i && p.kind === 'summary' ? { ...p, summary: next } : p,
                    ),
                  )
                }
                onToggleHidden={() => toggleHidden(i)}
                onDelete={() => deleteRow(i)}
              />
            ))}
          </div>
          <AddReasoningEntry busy={busy} onAdd={addReasoningRow} />
        </details>
      ) : null}
      {attachmentRefs.length > 0 || uploads.length > 0 ? (
        <AttachmentDraftTray
          refs={attachmentRefs}
          attachments={attachmentRows}
          uploads={uploads}
          disabled={busy}
          onToggle={toggleAttachment}
          onRemove={removeAttachment}
          onReplace={replaceAttachment}
          onDismissUpload={dismissUpload}
        />
      ) : null}
      <div data-ui="inline-editor-actions" ref={actionsRef}>
        <input
          data-ui="attachment-hidden-input"
          type="file"
          multiple
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            event.currentTarget.value = ''
            if (files.length === 0) return
            void ingestFiles(files)
          }}
        />
        <button
          type="button"
          data-ui="inline-editor-button"
          data-role="attach"
          onClick={() =>
            (
              actionsRef.current?.querySelector(
                '[data-ui="attachment-hidden-input"]',
              ) as HTMLInputElement | null
            )?.click()
          }
          disabled={busy || uploadingAttachments}
          aria-label="Upload attachment"
          title="Upload attachment"
        >
          <PaperclipIcon size={14} />
        </button>
        <button
          type="button"
          data-ui="inline-editor-button"
          data-role="attach-existing"
          onClick={() => setPickerOpen(true)}
          disabled={busy}
          aria-label="Use existing stored attachment"
          title="Use existing stored attachment"
        >
          <DatabaseIcon size={14} />
        </button>
        <button
          type="button"
          data-ui="inline-editor-button"
          data-role="cancel"
          onClick={onCancel}
          disabled={busy}
          title="Cancel (Esc)"
        >
          Cancel
        </button>
        {onSaveAndSend && showPrefillButton ? (
          <button
            type="button"
            data-ui="inline-editor-button"
            data-role="prefill"
            data-active={prefillOpen ? 'true' : undefined}
            onClick={() => void togglePrefill()}
            disabled={busy}
            aria-pressed={prefillOpen}
            title={
              prefillOpen
                ? 'Close prefill'
                : 'Add an assistant prefill, the model continues from the prefilled text on Save & Send'
            }
          >
            <PrefillIcon size={14} />
            <span>Prefill</span>
          </button>
        ) : null}
        <button
          type="button"
          data-ui="inline-editor-button"
          data-role="save"
          onClick={() => void commitSave()}
          disabled={busy || uploadingAttachments}
          title={uploadingAttachments ? 'Uploading attachments' : 'Save in place (⌘⏎)'}
        >
          Save
        </button>
        {onSaveAndSend ? (
          <button
            type="button"
            data-ui="inline-editor-button"
            data-role="save-send"
            onClick={() => void commitSaveAndSend()}
            disabled={busy || uploadingAttachments || saveAndSendDisabled}
            title={
              uploadingAttachments
                ? 'Uploading attachments'
                : saveAndSendDisabled
                  ? (saveAndSendDisabledReason ?? 'Send disabled')
                  : 'Save as a new variant and send (⇧⌘⏎)'
            }
          >
            Save &amp; Send
          </button>
        ) : null}
      </div>
      {pickerOpen ? (
        <AttachmentPicker
          title="Use stored attachment"
          onClose={() => setPickerOpen(false)}
          onPick={(attachment) => {
            addAttachment(attachment)
            setPickerOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

function ReasoningEditorRow({
  row,
  busy,
  onChangeText,
  onChangeSummary,
  onToggleHidden,
  onDelete,
}: {
  row: EditableReasoning
  busy: boolean
  onChangeText: (next: string) => void
  onChangeSummary: (next: string) => void
  onToggleHidden: () => void
  onDelete: () => void
}) {
  const label =
    row.kind === 'encrypted'
      ? `Encrypted #${row.index}`
      : row.kind === 'summary'
        ? `Summary #${row.index}`
        : `Reasoning text #${row.index}`
  return (
    <div
      data-ui="inline-editor-reasoning-row"
      data-kind={row.kind}
      data-hidden={row.hidden ? 'true' : undefined}
    >
      <div data-ui="inline-editor-reasoning-row-header">
        <span data-ui="inline-editor-reasoning-label">{label}</span>
        <div data-ui="inline-editor-reasoning-row-actions">
          <button
            type="button"
            data-ui="icon-button"
            data-compact
            data-pressed={row.hidden ? 'true' : undefined}
            onClick={onToggleHidden}
            disabled={busy}
            aria-label={row.hidden ? 'Unhide reasoning entry' : 'Hide reasoning entry'}
            title={
              row.hidden
                ? 'Hidden — preserved on disk, not sent on next turn. Click to unhide.'
                : 'Hide this reasoning entry (kept on disk, skipped on echo).'
            }
          >
            {row.hidden ? <EyeOffIcon /> : <EyeIcon />}
          </button>
          <button
            type="button"
            data-ui="icon-button"
            data-compact
            data-tone="danger"
            onClick={onDelete}
            disabled={busy}
            aria-label="Delete reasoning entry"
            title="Delete this reasoning entry"
          >
            <TrashSmallIcon />
          </button>
        </div>
      </div>
      {row.kind === 'encrypted' ? (
        <span data-ui="inline-editor-reasoning-readonly">{row.bytes} bytes (read-only)</span>
      ) : (
        <textarea
          data-ui="inline-editor-reasoning-input"
          value={row.kind === 'text' ? row.text : row.summary}
          onChange={(e) =>
            row.kind === 'text' ? onChangeText(e.target.value) : onChangeSummary(e.target.value)
          }
          rows={4}
          disabled={busy || row.hidden}
          aria-label={`Edit ${label}`}
        />
      )}
    </div>
  )
}

function AddReasoningEntry({
  busy,
  onAdd,
}: {
  busy: boolean
  onAdd: (kind: 'text' | 'summary') => void
}) {
  const [kind, setKind] = useState<'text' | 'summary'>('text')
  return (
    <div data-ui="inline-editor-reasoning-add">
      <select
        data-ui="inline-editor-reasoning-kind"
        value={kind}
        onChange={(e) => setKind(e.target.value as 'text' | 'summary')}
        disabled={busy}
        aria-label="New reasoning kind"
      >
        <option value="text">Reasoning text</option>
        <option value="summary">Summary</option>
      </select>
      <button
        type="button"
        data-ui="inline-editor-reasoning-add-button"
        onClick={() => onAdd(kind)}
        disabled={busy}
      >
        + Add reasoning entry
      </button>
    </div>
  )
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="13" height="13">
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
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="13" height="13">
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

function TrashSmallIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="13" height="13">
      <path
        d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.5a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.5M6.8 7v4M9.2 7v4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
