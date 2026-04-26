// Floating eye icon that lives at the bottom-left of the viewport and
// toggles the app's "reading mode." When active, sidebar / headers /
// composer / jump-to-latest all hide via the `data-focus-mode="on"`
// attribute on the app shell (see `shell.css`). The toggle itself is
// fixed-position so it stays in place whether the composer is visible
// or not.

import { useUiStore } from '../../store/zustand/uiStore'
import { EyeIcon, EyeOffIcon } from '../icons/Icon'

export function FocusModeToggle({ disabled = false }: { disabled?: boolean }) {
  const focusMode = useUiStore((s) => s.focusMode)
  const setFocusMode = useUiStore((s) => s.setFocusMode)
  const active = !disabled && focusMode
  return (
    <button
      type="button"
      data-ui="focus-mode-toggle"
      data-state={disabled ? 'disabled' : active ? 'active' : 'idle'}
      aria-label={
        disabled
          ? 'Reading mode unavailable on storage pages'
          : active
            ? 'Exit reading mode'
            : 'Enter reading mode'
      }
      aria-pressed={active}
      title={
        disabled
          ? 'Reading mode is unavailable on storage pages'
          : active
            ? 'Show chrome (exit reading mode)'
            : 'Hide chrome (reading mode)'
      }
      disabled={disabled}
      onClick={() => {
        if (!disabled) setFocusMode(!focusMode)
      }}
    >
      {active ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
    </button>
  )
}
