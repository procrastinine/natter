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
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { ContentItem, ReasoningDetail } from '../../core/types'

export interface InlineEditorProps {
  initial: string
  onSave: (text: string, reasoning?: ReasoningDetail[]) => void | Promise<void>
  onCancel: () => void
  onSaveAndSend?: (text: string) => void | Promise<void>
  saveAndSendDisabled?: boolean
  saveAndSendDisabledReason?: string
  ariaLabel?: string
  // Optional starting reasoning-details list. When provided, the
  // "Reasoning" disclosure is rendered; on save, the edited list is
  // passed back via onSave's second argument. Keep reference stable
  // across renders to avoid resetting the disclosure state.
  initialReasoning?: ReasoningDetail[]
}

const MIN_TEXTAREA_ROWS = 6
const MAX_TEXTAREA_PX = 600

// Extract the single plaintext run from a message's content array. Phase 8.1
// only edits text lanes; multi-modal content stays untouched when we commit.
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
  | { kind: 'text'; text: string; index: number; original: ReasoningDetail }
  | { kind: 'summary'; summary: string; index: number; original: ReasoningDetail }
  | { kind: 'encrypted'; index: number; original: ReasoningDetail; bytes: number }

function toEditable(list: ReasoningDetail[]): EditableReasoning[] {
  return list.map((detail, i) => {
    if (detail.type === 'reasoning.text') {
      return {
        kind: 'text',
        text: detail.text ?? '',
        index: detail.index ?? i,
        original: detail,
      }
    }
    if (detail.type === 'reasoning.summary') {
      return {
        kind: 'summary',
        summary: detail.summary,
        index: detail.index ?? i,
        original: detail,
      }
    }
    return {
      kind: 'encrypted',
      index: detail.index ?? i,
      original: detail,
      bytes: new Blob([detail.data ?? '']).size,
    }
  })
}

function fromEditable(list: EditableReasoning[]): ReasoningDetail[] {
  return list.map((row) => {
    if (row.kind === 'text') {
      return {
        ...row.original,
        type: 'reasoning.text',
        text: row.text,
      } as ReasoningDetail
    }
    if (row.kind === 'summary') {
      return {
        ...row.original,
        type: 'reasoning.summary',
        summary: row.summary,
      } as ReasoningDetail
    }
    return row.original
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
}: InlineEditorProps) {
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const [reasoning, setReasoning] = useState<EditableReasoning[]>(() =>
    toEditable(initialReasoning ?? []),
  )
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const actionsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    // preventScroll: true so the browser doesn't align the textarea's top
    // with the viewport top (which on long assistant messages pushes the
    // Save/Cancel row below the fold). We scroll the action row into view
    // ourselves with block: 'nearest' so the user always sees where they
    // commit or cancel.
    el.focus({ preventScroll: true })
    const end = el.value.length
    el.setSelectionRange(end, end)
    actionsRef.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [])
  useLayoutEffect(() => {
    autosize(textareaRef.current)
  }, [text])

  const run = useCallback(
    async (action: (text: string, reasoning?: ReasoningDetail[]) => void | Promise<void>) => {
      // Empty messages are allowed — both Save (in place) and Save & Send
      // commit whatever the user typed, including an empty string.
      // Messages may legitimately be empty (placeholder turn, deliberate
      // blank). The only place empty is blocked is the composer prompt
      // input, where "send empty" has no well-defined meaning.
      const trimmed = text.trim()
      if (busy) return
      setBusy(true)
      try {
        const nextReasoning = initialReasoning ? fromEditable(reasoning) : undefined
        await action(trimmed, nextReasoning)
      } finally {
        setBusy(false)
      }
    },
    [text, busy, initialReasoning, reasoning],
  )
  // No-op Save when nothing has changed — closes the editor without
  // touching IDB, without bumping `editedAt`, and (critically) without
  // flagging the "this reply may be stale" hint on downstream
  // assistant messages. Save & Send deliberately bypasses this check;
  // the user may want to re-send even when the text is unchanged.
  const isUnchanged = useCallback(() => {
    if (text !== initial) return false
    if (!initialReasoning) return true
    const nextReasoning = fromEditable(reasoning)
    return JSON.stringify(initialReasoning) === JSON.stringify(nextReasoning)
  }, [text, initial, initialReasoning, reasoning])
  const commitSave = useCallback(() => {
    if (isUnchanged()) {
      onCancel()
      return
    }
    return run(onSave)
  }, [isUnchanged, onCancel, run, onSave])
  const commitSaveAndSend = useCallback(() => {
    if (!onSaveAndSend || saveAndSendDisabled) return
    return run((text) => onSaveAndSend(text))
  }, [run, onSaveAndSend, saveAndSendDisabled])

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

  const reasoningEditableCount = reasoning.filter((r) => r.kind !== 'encrypted').length
  const showReasoningSection = (initialReasoning?.length ?? 0) > 0

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
      {showReasoningSection ? (
        <details
          data-ui="inline-editor-reasoning"
          open={reasoningOpen}
          onToggle={(e) => setReasoningOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>
            Reasoning ({reasoning.length}
            {reasoningEditableCount < reasoning.length
              ? `, ${reasoning.length - reasoningEditableCount} read-only`
              : ''}
            )
          </summary>
          <div data-ui="inline-editor-reasoning-list">
            {reasoning.map((row, i) => {
              if (row.kind === 'encrypted') {
                return (
                  <div key={i} data-ui="inline-editor-reasoning-row" data-kind="encrypted">
                    <span data-ui="inline-editor-reasoning-label">
                      Encrypted reasoning #{row.index}
                    </span>
                    <span data-ui="inline-editor-reasoning-readonly">
                      {row.bytes} bytes (read-only)
                    </span>
                  </div>
                )
              }
              return (
                <div key={i} data-ui="inline-editor-reasoning-row" data-kind={row.kind}>
                  <span data-ui="inline-editor-reasoning-label">
                    {row.kind === 'text' ? 'Reasoning' : 'Summary'} #{row.index}
                  </span>
                  <textarea
                    data-ui="inline-editor-reasoning-input"
                    value={row.kind === 'text' ? row.text : row.summary}
                    onChange={(e) => {
                      const next = e.target.value
                      setReasoning((prev) =>
                        prev.map((p, idx) =>
                          idx === i
                            ? row.kind === 'text'
                              ? { ...row, text: next }
                              : { ...row, summary: next }
                            : p,
                        ),
                      )
                    }}
                    rows={4}
                    disabled={busy}
                    aria-label={`Edit reasoning entry ${row.index}`}
                  />
                </div>
              )
            })}
          </div>
        </details>
      ) : null}
      <div data-ui="inline-editor-actions" ref={actionsRef}>
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
        <button
          type="button"
          data-ui="inline-editor-button"
          data-role="save"
          onClick={() => void commitSave()}
          disabled={busy}
          title="Save in place (⌘⏎)"
        >
          Save
        </button>
        {onSaveAndSend ? (
          <button
            type="button"
            data-ui="inline-editor-button"
            data-role="save-send"
            onClick={() => void commitSaveAndSend()}
            disabled={busy || saveAndSendDisabled}
            title={
              saveAndSendDisabled
                ? (saveAndSendDisabledReason ?? 'Send disabled')
                : 'Save as a new variant and send (⇧⌘⏎)'
            }
          >
            Save &amp; Send
          </button>
        ) : null}
      </div>
    </div>
  )
}
