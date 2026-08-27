import { type KeyboardEvent, useRef, useState, useSyncExternalStore } from 'react'
import {
  cancelPresentationDialog,
  getPresentationDialogSnapshot,
  type PresentationConfirmDialogRequest,
  type PresentationTextDialogRequest,
  settlePresentationDialog,
  subscribePresentationDialog,
} from '../../app/presentation-dialog'
import { ConfirmDialog } from './ConfirmDialog'

export function PresentationDialogHost() {
  const request = useSyncExternalStore(
    subscribePresentationDialog,
    getPresentationDialogSnapshot,
    () => null,
  )
  if (!request) return null
  return request.kind === 'text' ? (
    <PresentationTextDialog key={request.id} request={request} />
  ) : (
    <PresentationConfirmDialog key={request.id} request={request} />
  )
}

function PresentationTextDialog({ request }: { request: PresentationTextDialogRequest }) {
  const [value, setValue] = useState(request.initialValue)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const commit = () => settlePresentationDialog(request.id, value)
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    commit()
  }
  return (
    <ConfirmDialog
      title={request.title}
      confirmLabel={request.confirmLabel}
      cancelLabel={request.cancelLabel}
      confirmTone="accent"
      initialFocusRef={inputRef}
      onCancel={() => cancelPresentationDialog(request.id)}
      onConfirm={commit}
      closeLabel={`Cancel ${request.title.toLowerCase()}`}
    >
      <label data-ui="presentation-dialog-field">
        <span>{request.inputLabel}</span>
        <input
          ref={inputRef}
          data-ui="presentation-dialog-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </label>
    </ConfirmDialog>
  )
}

function PresentationConfirmDialog({ request }: { request: PresentationConfirmDialogRequest }) {
  return (
    <ConfirmDialog
      title={request.title}
      confirmLabel={request.confirmLabel}
      cancelLabel={request.cancelLabel}
      confirmTone={request.tone}
      initialFocus="cancel"
      onCancel={() => cancelPresentationDialog(request.id)}
      onConfirm={() => settlePresentationDialog(request.id, true)}
      closeLabel={`Cancel ${request.title.toLowerCase()}`}
    >
      <div data-ui="confirm-dialog-copy">
        <p>{request.message}</p>
      </div>
    </ConfirmDialog>
  )
}
