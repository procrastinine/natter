import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SendShortcut } from '../../core/global-settings'
import { StopIcon } from '../icons/Icon'

export interface ComposerProps {
  // Disables the textarea entirely (e.g. while a stream owns the chat).
  disabled?: boolean
  // The textarea remains editable but Send is locked. Reason is rendered
  // beneath the composer and used as the Send-button tooltip.
  sendBlockedReason?: string
  onSubmit: (text: string) => void | Promise<void>
  seed?: string | null
  onSeedConsumed?: () => void
  sendShortcut?: SendShortcut
  // Optional floating accessory rendered inside the composer's positioning
  // context (e.g. the "Jump to latest" pill). Floats above the body
  // regardless of how tall the composer is dragged.
  floatingAccessory?: ReactNode
  // Streaming state + abort handler. When `streaming` is true, the Send
  // button slot is replaced with a Stop button (square glyph) that calls
  // `onAbort`. The user asked for Stop to occupy the Send slot — moving
  // it here (from the chat title bar) makes the affordance reachable
  // alongside where the user's hand is anyway.
  streaming?: boolean
  onAbort?: () => void
}

const COMPOSER_HEIGHT_STORAGE_KEY = 'natter:composer-height'
const COMPOSER_MIN_HEIGHT = 80
const COMPOSER_MAX_HEIGHT = 600
const COMPOSER_DEFAULT_HEIGHT = 120

function readSavedHeight(): number {
  if (typeof window === 'undefined') return COMPOSER_DEFAULT_HEIGHT
  const raw = window.localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY)
  if (!raw) return COMPOSER_DEFAULT_HEIGHT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return COMPOSER_DEFAULT_HEIGHT
  return clampHeight(parsed)
}

function clampHeight(value: number): number {
  return Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, value))
}

export function Composer({
  disabled,
  sendBlockedReason,
  onSubmit,
  seed,
  onSeedConsumed,
  sendShortcut = 'enter',
  floatingAccessory,
  streaming = false,
  onAbort,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [height, setHeight] = useState<number>(() => readSavedHeight())
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null)
  useEffect(() => {
    if (seed && seed.length > 0) {
      setText(seed)
      onSeedConsumed?.()
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        const pos = el.value.length
        el.setSelectionRange(pos, pos)
      })
    }
  }, [seed, onSeedConsumed])
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(
      COMPOSER_HEIGHT_STORAGE_KEY,
      String(Math.round(height)),
    )
  }, [height])
  // Drive the textarea height imperatively (via the DOM ref). The visual
  // size is dynamic — drag-updated and persisted — so it can't live in a
  // stylesheet, and the project's style-discipline contract forbids inline
  // JSX style attributes.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = `${height}px`
  }, [height])
  const sendBlocked = Boolean(sendBlockedReason) || disabled
  const send = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || sendBlocked) return
    setText('')
    await onSubmit(trimmed)
  }, [text, sendBlocked, onSubmit])
  const sendButtonLabel = sendShortcut === 'cmd-enter' ? 'Send ⌘⏎' : 'Send ⏎'

  // Drag the TOP edge of the composer to resize. Capture pointer to keep
  // the drag stable even if the cursor leaves the handle, and clamp against
  // composer min/max so the textarea stays usable.
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStateRef.current = { startY: e.clientY, startHeight: height }
  }, [height])
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current
    if (!drag) return
    const delta = drag.startY - e.clientY
    setHeight(clampHeight(drag.startHeight + delta))
  }, [])
  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    dragStateRef.current = null
  }, [])

  return (
    <form
      data-ui="composer"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <div
        data-ui="composer-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize composer"
        title="Drag to resize"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
      {floatingAccessory ?? null}
      <div data-ui="composer-body">
        <textarea
          ref={textareaRef}
          data-ui="composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask anything…"
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            const isCmd = e.metaKey || e.ctrlKey
            if (sendShortcut === 'cmd-enter') {
              if (isCmd) {
                e.preventDefault()
                void send()
              }
              return
            }
            if (isCmd) {
              e.preventDefault()
              void send()
              return
            }
            if (!e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div data-ui="composer-actions">
          <span data-ui="token-counter" aria-live="polite">
            {text.trim().length} chars
          </span>
          {streaming && onAbort ? (
            <button
              type="button"
              data-ui="abort"
              onClick={onAbort}
              title="Stop generating (⌘.)"
              aria-label="Stop generating"
            >
              <StopIcon size={14} />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="submit"
              data-ui="send"
              disabled={sendBlocked || text.trim() === ''}
              title={sendBlockedReason ?? undefined}
            >
              {sendButtonLabel}
            </button>
          )}
        </div>
      </div>
      {sendBlockedReason ? (
        <p data-ui="composer-disabled-reason" role="status">
          {sendBlockedReason}
        </p>
      ) : null}
    </form>
  )
}
