export interface PresentationTextDialogRequest {
  readonly id: number
  readonly kind: 'text'
  readonly title: string
  readonly initialValue: string
  readonly inputLabel: string
  readonly confirmLabel: string
  readonly cancelLabel: string
}

export interface PresentationConfirmDialogRequest {
  readonly id: number
  readonly kind: 'confirm'
  readonly title: string
  readonly message: string
  readonly confirmLabel: string
  readonly cancelLabel: string
  readonly tone: 'neutral' | 'accent' | 'warning' | 'danger'
}

export type PresentationDialogRequest =
  | PresentationTextDialogRequest
  | PresentationConfirmDialogRequest

interface PresentationTextDialogOptions {
  readonly title: string
  readonly initialValue?: string
  readonly inputLabel?: string
  readonly confirmLabel?: string
  readonly cancelLabel?: string
}

interface PresentationConfirmDialogOptions {
  readonly title: string
  readonly message: string
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  readonly tone?: PresentationConfirmDialogRequest['tone']
}

interface ActivePresentationDialog {
  readonly request: PresentationDialogRequest
  readonly resolve: (value: string | boolean | null) => void
}

const listeners = new Set<() => void>()
let activeDialog: ActivePresentationDialog | null = null
let nextRequestId = 0

export function requestPresentationText(
  options: PresentationTextDialogOptions,
): Promise<string | null> {
  return openPresentationDialog<string | null>((id) => ({
    id,
    kind: 'text',
    title: options.title,
    initialValue: options.initialValue ?? '',
    inputLabel: options.inputLabel ?? options.title,
    confirmLabel: options.confirmLabel ?? 'OK',
    cancelLabel: options.cancelLabel ?? 'Cancel',
  }))
}

export function requestPresentationConfirmation(
  options: PresentationConfirmDialogOptions,
): Promise<boolean> {
  return openPresentationDialog<boolean>((id) => ({
    id,
    kind: 'confirm',
    title: options.title,
    message: options.message,
    confirmLabel: options.confirmLabel ?? 'Confirm',
    cancelLabel: options.cancelLabel ?? 'Cancel',
    tone: options.tone ?? 'neutral',
  }))
}

export function subscribePresentationDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0) return
    const active = activeDialog
    if (!active) return
    activeDialog = null
    active.resolve(active.request.kind === 'confirm' ? false : null)
  }
}

export function getPresentationDialogSnapshot(): PresentationDialogRequest | null {
  return activeDialog?.request ?? null
}

export function settlePresentationDialog(requestId: number, value: string | boolean | null): void {
  const active = activeDialog
  if (!active || active.request.id !== requestId) return
  activeDialog = null
  publishPresentationDialog()
  active.resolve(value)
}

export function cancelPresentationDialog(requestId: number): void {
  const request = activeDialog?.request
  if (!request || request.id !== requestId) return
  settlePresentationDialog(requestId, request.kind === 'confirm' ? false : null)
}

function openPresentationDialog<T extends string | boolean | null>(
  createRequest: (id: number) => PresentationDialogRequest,
): Promise<T> {
  if (listeners.size === 0) return Promise.reject(new Error('PresentationDialogHostUnavailable'))
  if (activeDialog) return Promise.reject(new Error('PresentationDialogAlreadyActive'))
  nextRequestId += 1
  return new Promise<T>((resolve) => {
    activeDialog = {
      request: createRequest(nextRequestId),
      resolve: (value) => resolve(value as T),
    }
    publishPresentationDialog()
  })
}

function publishPresentationDialog(): void {
  for (const listener of listeners) listener()
}
