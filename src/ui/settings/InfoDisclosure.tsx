import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

export function InfoDisclosure({
  title,
  children,
  align = 'start',
}: {
  title: string
  children?: ReactNode
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Dynamic viewport-clamp shift — we measure the panel's bounding rect
  // after render and push it inward if it's overflowing either edge. The
  // shift writes to the `--info-panel-shift` CSS variable so the stylesheet
  // owns the `transform`; the style-discipline test forbids inline JSX
  // style attributes.
  useLayoutEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return

    const clampIntoViewport = () => {
      panel.style.setProperty('--info-panel-shift', '0px')
      const rect = panel.getBoundingClientRect()
      const margin = 12
      let shift = 0
      if (rect.right > window.innerWidth - margin) {
        shift -= rect.right - (window.innerWidth - margin)
      }
      if (rect.left + shift < margin) {
        shift += margin - (rect.left + shift)
      }
      panel.style.setProperty('--info-panel-shift', `${Math.round(shift)}px`)
    }

    clampIntoViewport()
    window.addEventListener('resize', clampIntoViewport)
    window.addEventListener('scroll', clampIntoViewport, true)
    return () => {
      window.removeEventListener('resize', clampIntoViewport)
      window.removeEventListener('scroll', clampIntoViewport, true)
    }
  }, [open])

  return (
    <span data-ui="info-disclosure" data-align={align} ref={rootRef}>
      <button
        type="button"
        data-ui="info-hint"
        aria-label={title}
        title={title}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="13" height="13">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.25" />
          <circle cx="8" cy="4.5" r="0.9" fill="currentColor" />
          <path d="M8 6.8v5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
      </button>
      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          data-ui="info-disclosure-panel"
          data-align={align}
          role="note"
        >
          {children ?? title}
        </div>
      ) : null}
    </span>
  )
}
