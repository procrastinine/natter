// Inline confirmation for the default delete-message button. Pops open
// a small modal on click so the delete isn't a one-click footgun next
// to Copy / Edit / Info. The default action is pair-delete (checkbox
// checked); unchecking downgrades to a single-message delete.
//
// For messages flagged with a role-adjacency warning the checkbox is
// disabled (pair-delete would remove a healthy neighbor). The caller
// is responsible for wiring that case — the dialog just reflects the
// `pairDisabled` prop.

import { useCallback, useState } from 'react'
import { ConfirmDialog } from '../primitives/ConfirmDialog'

interface ConfirmDeleteDialogProps {
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
    <ConfirmDialog
      title="Delete message?"
      confirmLabel="Delete"
      busy={busy}
      onCancel={onCancel}
      onConfirm={commit}
    >
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
            Disabled — this message has an adjacency warning, so pair-delete would remove a healthy
            neighbor.
          </span>
        ) : null}
      </label>
    </ConfirmDialog>
  )
}
