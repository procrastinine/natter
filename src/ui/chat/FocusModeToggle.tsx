// Floating eye icon that lives at the bottom-left of the viewport and
// toggles the app's "reading mode." When active, sidebar / headers /
// composer / jump-to-latest all hide via the `data-focus-mode="on"`
// attribute on the app shell (see `shell.css`). The toggle itself is
// fixed-position so it stays in place whether the composer is visible
// or not.

import { useUiStore } from '../../store/zustand/uiStore'
import { EyeIcon, EyeOffIcon } from '../icons/Icon'

export function FocusModeToggle() {
  const focusMode = useUiStore((s) => s.focusMode)
  const setFocusMode = useUiStore((s) => s.setFocusMode)
  return (
    <button
      type="button"
      data-ui="focus-mode-toggle"
      data-state={focusMode ? 'active' : 'idle'}
      aria-label={focusMode ? 'Exit reading mode' : 'Enter reading mode'}
      aria-pressed={focusMode}
      title={
        focusMode
          ? 'Show chrome (exit reading mode)'
          : 'Hide chrome (reading mode)'
      }
      onClick={() => setFocusMode(!focusMode)}
    >
      {focusMode ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
    </button>
  )
}
