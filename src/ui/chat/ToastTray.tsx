// Bottom-right toast tray. Feeds off `useToastStore`. Each toast
// auto-dismisses after `durationMs` (default 5s per §10.6.1), with an
// optional "Undo" button for structural-op toasts.

import { useEffect } from 'react'
import { useToastStore } from '../../store/zustand/toastStore'

export function ToastTray() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismissToast)

  useEffect(() => {
    if (toasts.length === 0) return
    const timers = toasts.map((t) => {
      const remaining = Math.max(0, t.createdAt + t.durationMs - Date.now())
      return window.setTimeout(() => dismiss(t.id), remaining)
    })
    return () => {
      for (const id of timers) window.clearTimeout(id)
    }
  }, [toasts, dismiss])

  if (toasts.length === 0) return null
  return (
    <div data-ui="toast-tray" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div
          key={t.id}
          data-ui="toast"
          data-tone={t.level}
          role={t.level === 'danger' ? 'alert' : 'status'}
        >
          <span data-ui="toast-text">{t.text}</span>
          {t.undo ? (
            <button
              type="button"
              data-ui="toast-undo"
              onClick={() => {
                void t.undo?.()
                dismiss(t.id)
              }}
            >
              Undo
            </button>
          ) : null}
          <button
            type="button"
            data-ui="toast-dismiss"
            aria-label="Dismiss notification"
            onClick={() => dismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
