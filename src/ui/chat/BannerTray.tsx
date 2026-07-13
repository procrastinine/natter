// Callers push inline banners (`chat-not-found`, `mutation-conflict`, …) into
// the toast store; the tray renders them above the message list as blocking
// context.

import { useToastStore } from '../../store/zustand/toastStore'
import { Button } from '../primitives/Button'

export function BannerTray() {
  const banners = useToastStore((s) => s.banners)
  const dismiss = useToastStore((s) => s.dismissBanner)
  const runAction = useToastStore((s) => s.runBannerAction)
  if (banners.length === 0) return null
  return (
    <div data-ui="banner-tray">
      {banners.map((b) => {
        const pending = b.actionState?.pending === true
        return (
          <div
            key={b.id}
            data-ui="banner"
            data-kind={b.kind}
            data-tone={b.kind === 'mutation-conflict' ? 'warning' : 'info'}
            data-state={pending ? 'pending' : b.actionState?.error ? 'error' : 'idle'}
            aria-busy={pending}
          >
            <span data-ui="banner-text">{b.text}</span>
            {b.actionState?.error ? (
              <span data-ui="banner-action-error">{b.actionState.error}</span>
            ) : null}
            <span data-ui="banner-spacer" />
            {b.primary ? (
              <Button
                type="button"
                data-ui="banner-primary"
                aria-disabled={pending}
                data-pending={pending && b.actionState?.key === 'primary' ? true : undefined}
                onClick={(event) => {
                  if (pending) {
                    event.preventDefault()
                    return
                  }
                  void runAction(b.id, 'primary')
                }}
              >
                {pending && b.actionState?.key === 'primary' ? 'Working…' : b.primary.label}
              </Button>
            ) : null}
            {b.secondary ? (
              <Button
                type="button"
                data-ui="banner-secondary"
                aria-disabled={pending}
                data-pending={pending && b.actionState?.key === 'secondary' ? true : undefined}
                onClick={(event) => {
                  if (pending) {
                    event.preventDefault()
                    return
                  }
                  void runAction(b.id, 'secondary')
                }}
              >
                {pending && b.actionState?.key === 'secondary' ? 'Working…' : b.secondary.label}
              </Button>
            ) : null}
            <Button
              type="button"
              data-ui="banner-dismiss"
              aria-label="Dismiss banner"
              aria-disabled={pending}
              onClick={(event) => {
                if (pending) {
                  event.preventDefault()
                  return
                }
                dismiss(b.id)
              }}
            >
              ×
            </Button>
          </div>
        )
      })}
    </div>
  )
}
