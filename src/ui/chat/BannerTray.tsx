// Inline banner stack. See `plan/10-ui.md §10.13.1`. Callers push
// banners (`chat-not-found`, `mutation-conflict`, …) into the toast
// store; the tray renders them above the message list in the main
// pane so they read as blocking context.

import { useToastStore } from '../../store/zustand/toastStore'

export function BannerTray() {
  const banners = useToastStore((s) => s.banners)
  const dismiss = useToastStore((s) => s.dismissBanner)
  if (banners.length === 0) return null
  return (
    <div data-ui="banner-tray">
      {banners.map((b) => (
        <div
          key={b.id}
          data-ui="banner"
          data-kind={b.kind}
          data-tone={b.kind === 'mutation-conflict' ? 'warning' : 'info'}
          role="status"
        >
          <span data-ui="banner-text">{b.text}</span>
          <span data-ui="banner-spacer" />
          {b.primary ? (
            <button
              type="button"
              data-ui="banner-primary"
              onClick={() => {
                void b.primary?.action()
                dismiss(b.id)
              }}
            >
              {b.primary.label}
            </button>
          ) : null}
          {b.secondary ? (
            <button
              type="button"
              data-ui="banner-secondary"
              onClick={() => {
                void b.secondary?.action()
                dismiss(b.id)
              }}
            >
              {b.secondary.label}
            </button>
          ) : null}
          <button
            type="button"
            data-ui="banner-dismiss"
            aria-label="Dismiss banner"
            onClick={() => dismiss(b.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
