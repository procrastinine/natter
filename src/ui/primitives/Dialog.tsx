import {
  createElement,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react'
import { createPortal } from 'react-dom'

type DialogSurfaceTag = 'div' | 'section' | 'form'
type DialogBackdrop = 'standard' | 'blurred' | 'light' | 'dim'

interface DialogSurfaceProps extends HTMLAttributes<HTMLElement> {
  'data-ui-modal'?: string
}

export interface DialogProps {
  children: ReactNode
  onClose: () => void
  overlayUi: string
  scrimUi: string
  surfaceUi: string
  surfaceAs?: DialogSurfaceTag
  ariaLabel?: string
  labelledBy?: string
  describedBy?: string
  scrimLabel?: string
  backdrop?: DialogBackdrop
  initialFocusRef?: RefObject<HTMLElement | null>
  closeOnEscape?: boolean
  closeOnScrim?: boolean
  restoreFocus?: boolean
  overlayProps?: HTMLAttributes<HTMLDivElement>
  surfaceProps?: DialogSurfaceProps
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true',
  )
}

export function Dialog({
  children,
  onClose,
  overlayUi,
  scrimUi,
  surfaceUi,
  surfaceAs = 'div',
  ariaLabel,
  labelledBy,
  describedBy,
  scrimLabel = 'Close dialog',
  backdrop = 'standard',
  initialFocusRef,
  closeOnEscape = true,
  closeOnScrim = true,
  restoreFocus = true,
  overlayProps,
  surfaceProps,
}: DialogProps) {
  const surfaceRef = useRef<HTMLElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const surface = surfaceRef.current
    const initial = initialFocusRef?.current ?? (surface ? focusableElements(surface)[0] : null)
    ;(initial ?? surface)?.focus()

    return () => {
      if (restoreFocus && returnFocusRef.current?.isConnected) returnFocusRef.current.focus()
    }
  }, [initialFocusRef, restoreFocus])

  useEffect(() => {
    if (!closeOnEscape) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [closeOnEscape, onClose])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    surfaceProps?.onKeyDown?.(event)
    if (event.defaultPrevented) return
    if (event.key !== 'Tab') return

    const surface = surfaceRef.current
    if (!surface) return
    const focusable = focusableElements(surface)
    if (focusable.length === 0) {
      event.preventDefault()
      surface.focus()
      return
    }
    const first = focusable[0]
    const last = focusable.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const { onKeyDown: _surfaceOnKeyDown, tabIndex = -1, ...restSurfaceProps } = surfaceProps ?? {}

  return createPortal(
    <div
      {...overlayProps}
      data-control="dialog-overlay"
      data-ui={overlayUi}
      data-dialog-backdrop={backdrop}
    >
      <button
        type="button"
        data-control="dialog-scrim"
        data-ui={scrimUi}
        aria-label={scrimLabel}
        tabIndex={-1}
        onClick={closeOnScrim ? onClose : undefined}
        disabled={!closeOnScrim}
      />
      {createElement(
        surfaceAs,
        {
          ...restSurfaceProps,
          ref: surfaceRef,
          'data-control': 'dialog-surface',
          'data-ui': surfaceUi,
          role: 'dialog',
          'aria-modal': true,
          'aria-label': ariaLabel,
          'aria-labelledby': labelledBy,
          'aria-describedby': describedBy,
          tabIndex,
          onKeyDown: handleKeyDown,
        },
        children,
      )}
    </div>,
    document.body,
  )
}
