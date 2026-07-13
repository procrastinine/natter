import { type ReactNode, useId, useRef } from 'react'
import { CloseIcon } from '../icons/Icon'
import { Button, IconButton } from './Button'
import { Dialog } from './Dialog'

interface ConfirmDialogProps {
  title: string
  children: ReactNode
  confirmLabel: string
  busyLabel?: string
  cancelLabel?: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void | Promise<void>
  closeLabel?: string
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busyLabel,
  cancelLabel = 'Cancel',
  busy = false,
  onCancel,
  onConfirm,
  closeLabel = 'Cancel delete',
}: ConfirmDialogProps) {
  const titleId = useId()
  const confirmRef = useRef<HTMLButtonElement | null>(null)

  return (
    <Dialog
      overlayUi="confirm-delete-overlay"
      scrimUi="confirm-delete-scrim"
      surfaceUi="confirm-delete"
      labelledBy={titleId}
      scrimLabel={closeLabel}
      initialFocusRef={confirmRef}
      onClose={onCancel}
    >
      <div data-ui="confirm-delete-header">
        <h2 id={titleId}>{title}</h2>
        <IconButton
          data-ui="icon-button"
          data-size="sm"
          data-role="confirm-delete-close"
          aria-label={closeLabel}
          onClick={onCancel}
          disabled={busy}
        >
          <CloseIcon size={14} />
        </IconButton>
      </div>
      {children}
      <div data-ui="confirm-delete-actions">
        <Button
          data-ui="confirm-delete-button"
          data-role="cancel"
          appearance="plain"
          geometry="flush"
          onClick={onCancel}
          disabled={busy}
        >
          {cancelLabel}
        </Button>
        <Button
          ref={confirmRef}
          data-ui="confirm-delete-button"
          data-role="confirm"
          tone="danger"
          appearance="solid"
          geometry="flush"
          busy={busy}
          busyLabel={busyLabel}
          onClick={() => void onConfirm()}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}
