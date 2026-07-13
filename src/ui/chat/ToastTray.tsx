// Bottom-right toast tray. Feeds off `useToastStore`. Each toast
// auto-dismisses after `durationMs` (default 5s per §10.6.1), with an
// optional "Undo" button for structural-op toasts.

import { useEffect } from 'react'
import { useToastStore } from '../../store/zustand/toastStore'
import { Button } from '../primitives/Button'

export function ToastTray() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismissToast)
  const runAction = useToastStore((s) => s.runToastAction)

  useEffect(() => {
    if (toasts.length === 0) return
    const timers = toasts.flatMap((t) => {
      if (t.actionState) return []
      const remaining = Math.max(0, t.createdAt + t.durationMs - Date.now())
      return [window.setTimeout(() => dismiss(t.id), remaining)]
    })
    return () => {
      for (const id of timers) window.clearTimeout(id)
    }
  }, [toasts, dismiss])

  if (toasts.length === 0) return null
  return (
    <section data-ui="toast-tray" aria-label="Notifications">
      {toasts.map((t) => {
        const pending = t.actionState?.pending === true
        return (
          <div
            key={t.id}
            data-ui="toast"
            data-tone={t.level}
            data-state={pending ? 'pending' : t.actionState?.error ? 'error' : 'idle'}
            aria-busy={pending}
          >
            <span data-ui="toast-text">{t.text}</span>
            {t.actionState?.error ? (
              <span data-ui="toast-action-error">{t.actionState.error}</span>
            ) : null}
            {t.undo ? (
              <Button
                type="button"
                data-ui="toast-undo"
                data-pending={pending || undefined}
                aria-disabled={pending}
                onClick={(event) => {
                  if (pending) {
                    event.preventDefault()
                    return
                  }
                  void runAction(t.id)
                }}
              >
                {pending ? 'Undoing…' : 'Undo'}
              </Button>
            ) : null}
            <Button
              type="button"
              data-ui="toast-dismiss"
              aria-label="Dismiss notification"
              aria-disabled={pending}
              onClick={(event) => {
                if (pending) {
                  event.preventDefault()
                  return
                }
                dismiss(t.id)
              }}
            >
              ×
            </Button>
          </div>
        )
      })}
    </section>
  )
}
