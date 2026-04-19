// Inline confirmation for the default delete-message button. Pops open
// a small modal on click so the delete isn't a one-click footgun next
// to Copy / Edit / Info. The default action is pair-delete (checkbox
// checked); unchecking downgrades to a single-message delete.
//
// For messages flagged with a role-adjacency warning the checkbox is
// disabled (pair-delete would remove a healthy neighbor). The caller
// is responsible for wiring that case — the dialog just reflects the
// `pairDisabled` prop.

import { useCallback, useEffect, useRef, useState } from 'react'
import { CloseIcon } from '../icons/Icon'

export interface ConfirmDeleteDialogProps {
  previewText: string
  // When true, the pair checkbox is disabled (role-adjacency mismatch
  // — pair-delete would sweep a valid neighbor). Default false.
  pairDisabled?: boolean
  // Initial state of the pair checkbox. Default true.
  pairDefault?: boolean
  onConfirm: (deletePair: boolean) => void | Promise<void>
  onCancel: () => void
}

export function ConfirmDeleteDialog({
  previewText,
  pairDisabled,
  pairDefault = true,
  onConfirm,
  onCancel,
}: ConfirmDeleteDialogProps) {
  const [deletePair, setDeletePair] = useState<boolean>(pairDisabled ? false : pairDefault)
  const [busy, setBusy] = useState(false)
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    confirmBtnRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const commit = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm(deletePair)
    } finally {
      setBusy(false)
    }
  }, [busy, deletePair, onConfirm])

  return (
    <div
      data-ui="confirm-delete-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        data-ui="confirm-delete"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
      >
        <div data-ui="confirm-delete-header">
          <h2 id="confirm-delete-title">Delete message?</h2>
          <button
            type="button"
            data-ui="icon-button"
            data-size="sm"
            data-role="confirm-delete-close"
            aria-label="Cancel delete"
            onClick={onCancel}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <blockquote data-ui="confirm-delete-preview">{previewText}</blockquote>
        <label data-ui="confirm-delete-pair">
          <input
            type="checkbox"
            checked={deletePair}
            disabled={pairDisabled}
            onChange={(e) => setDeletePair(e.target.checked)}
          />
          <span>Also delete the paired user/assistant message</span>
          {pairDisabled ? (
            <span data-ui="confirm-delete-hint">
              Disabled — this message has an adjacency warning, so pair-delete would remove a
              healthy neighbor.
            </span>
          ) : null}
        </label>
        <div data-ui="confirm-delete-actions">
          <button
            type="button"
            data-ui="confirm-delete-button"
            data-role="cancel"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            data-ui="confirm-delete-button"
            data-role="confirm"
            data-tone="danger"
            onClick={() => void commit()}
            disabled={busy}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
