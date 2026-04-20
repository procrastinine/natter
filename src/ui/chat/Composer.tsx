import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SendShortcut } from '../../core/global-settings'
import { InsertIcon, StopIcon } from '../icons/Icon'

export interface ComposerProps {
  // Disables the textarea entirely.
  disabled?: boolean
  // The textarea remains editable but Send is locked. Reason is rendered
  // beneath the composer and used as the Send-button tooltip.
  sendBlockedReason?: string
  onSubmit: (text: string) => void | Promise<void>
  seed?: string | null
  onSeedConsumed?: () => void
  sendShortcut?: SendShortcut
  // Live token usage surfaced next to the char count so the user sees
  // context pressure without opening the Context tab. Undefined = don't
  // render (e.g. no chat yet, no tokenizer).
  tokenBudget?: { used: number; budget: number }
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
  // "Import at end" button handler (§10.7). Opens the import modal
  // pre-scoped to "end of active path." Rendered only when provided.
  onImportAtEnd?: () => void
  // Reply-to-trailing-user handler. When the active path ends with a
  // user message and the composer text is empty, pressing Send triggers
  // this instead of creating a new user message — it just fires an
  // assistant completion under the existing trailing user.
  onReplyToTrailingUser?: () => void | Promise<void>
  // Whether the active path currently ends with a user message. When
  // true and the composer text is empty, the Send button switches to
  // "Reply" and calls `onReplyToTrailingUser` on click.
  trailingUserMessage?: boolean
  // When true, the textarea starts at the variant's default height
  // and auto-grows with content up to the variant's auto-grow cap. The
  // drag handle remains visible; dragging sets a MINIMUM floor that
  // content can still grow past (see `useLayoutEffect` below for the
  // `max(content, floor)` semantics).
  autoSize?: boolean
  // Which auto-size profile to use when `autoSize` is true. Different
  // surfaces have different natural sizes:
  //   - `'normal'` (default): compact — start at one line, cap at
  //     ~10 lines. Optimized to leave room for the message list.
  //   - `'focus'`: generous — start taller, cap roughly doubled. In
  //     focus mode the composer IS the bottom of the reading lane
  //     (scrolls with content, no sticky footer), so a bigger default
  //     and a bigger ceiling are useful for drafting.
  // Each variant has its own localStorage key for the floor so user
  // drags in one mode don't leak into the other.
  autoSizeVariant?: AutoSizeVariant
}

type AutoSizeVariant = 'normal' | 'focus'

interface AutoSizeProfile {
  defaultFloor: number
  autoGrowMax: number
  storageKey: string
}

const AUTO_SIZE_PROFILES: Record<AutoSizeVariant, AutoSizeProfile> = {
  normal: {
    defaultFloor: 0,
    autoGrowMax: 240,
    storageKey: 'natter:composer-floor',
  },
  focus: {
    defaultFloor: 200,
    autoGrowMax: 480,
    storageKey: 'natter:composer-floor-focus',
  },
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
  return clampFixedHeight(parsed)
}

function readSavedFloor(variant: AutoSizeVariant): number {
  const profile = AUTO_SIZE_PROFILES[variant]
  if (typeof window === 'undefined') return profile.defaultFloor
  const raw = window.localStorage.getItem(profile.storageKey)
  if (!raw) return profile.defaultFloor
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return profile.defaultFloor
  return clampFloorHeight(parsed)
}

function clampFixedHeight(value: number): number {
  return Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, value))
}

function clampFloorHeight(value: number): number {
  return Math.max(0, Math.min(COMPOSER_MAX_HEIGHT, value))
}

// Compact short-form for the composer's tok indicator so the
// "used/budget" pair stays readable in a ~60px slot. Breakpoints match
// the model-picker context column (`983k`, `1.0M`, `1.2M`, `200k`) so
// the user sees the same shape in both places.
function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(Math.round(n))
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
  onImportAtEnd,
  onReplyToTrailingUser,
  trailingUserMessage,
  autoSize = false,
  autoSizeVariant = 'normal',
  tokenBudget,
}: ComposerProps) {
  const [text, setText] = useState('')
  // In auto-size mode this is a minimum FLOOR (per-variant default).
  // In fixed mode it's the absolute textarea height. Drag updates it
  // in both modes; persistence uses separate localStorage keys
  // per variant so a value written in one doesn't leak into the other.
  const [height, setHeight] = useState<number>(() =>
    autoSize ? readSavedFloor(autoSizeVariant) : readSavedHeight(),
  )
  const profile = AUTO_SIZE_PROFILES[autoSizeVariant]
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
    const key = autoSize ? profile.storageKey : COMPOSER_HEIGHT_STORAGE_KEY
    window.localStorage.setItem(key, String(Math.round(height)))
  }, [autoSize, profile.storageKey, height])
  // Drive the textarea height imperatively (via the DOM ref). The visual
  // size is dynamic — either drag-updated+persisted or content-driven —
  // so it can't live in a stylesheet, and the project's style-discipline
  // contract forbids inline JSX style attributes. useLayoutEffect so the
  // height lands before paint (prevents a one-frame tall flash during
  // keystrokes in auto-size mode).
  //
  // Auto-size semantics: `height` acts as a MINIMUM floor set by the
  // drag handle. The textarea auto-grows from one line up to
  // COMPOSER_AUTO_SIZE_MAX as content arrives; whichever is taller of
  // (content-auto-grown, floor) wins. So:
  //   - empty + no drag (floor=0) → 1 line
  //   - empty + dragged to 200px → 200px (floor wins)
  //   - typed 15 lines + dragged to 200 → 240 (cap, content wins)
  //   - dragged back to 0 → collapses to whatever content needs
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    if (autoSize) {
      el.style.height = 'auto'
      const contentHeight = Math.min(el.scrollHeight, profile.autoGrowMax)
      const effective = Math.max(contentHeight, height)
      el.style.height = `${effective}px`
      return
    }
    el.style.height = `${height}px`
  }, [autoSize, profile.autoGrowMax, height, text])
  const sendBlocked = Boolean(sendBlockedReason) || Boolean(disabled) || streaming
  const trimmed = text.trim()
  const emptyWithTrailingUser =
    trimmed.length === 0 && Boolean(trailingUserMessage) && Boolean(onReplyToTrailingUser)
  const send = useCallback(async () => {
    if (sendBlocked) return
    if (text.trim().length === 0) {
      if (emptyWithTrailingUser && onReplyToTrailingUser) {
        await onReplyToTrailingUser()
      }
      return
    }
    const out = text.trim()
    setText('')
    await onSubmit(out)
  }, [text, sendBlocked, emptyWithTrailingUser, onReplyToTrailingUser, onSubmit])
  const sendButtonLabel = emptyWithTrailingUser
    ? 'Reply ⏎'
    : sendShortcut === 'cmd-enter'
      ? 'Send ⌘⏎'
      : 'Send ⏎'

  // Drag the TOP edge of the composer to resize. Capture pointer to keep
  // the drag stable even if the cursor leaves the handle, and clamp against
  // composer min/max so the textarea stays usable.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      dragStateRef.current = { startY: e.clientY, startHeight: height }
    },
    [height],
  )
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current
      if (!drag) return
      const delta = drag.startY - e.clientY
      const next = drag.startHeight + delta
      setHeight(autoSize ? clampFloorHeight(next) : clampFixedHeight(next))
    },
    [autoSize],
  )
  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    dragStateRef.current = null
  }, [])

  return (
    <form
      data-ui="composer"
      data-autosize={autoSize ? 'true' : 'false'}
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
        title={
          autoSize
            ? 'Drag to set a minimum height (content still auto-grows above it)'
            : 'Drag to resize'
        }
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
          rows={autoSize ? 1 : undefined}
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
          {tokenBudget ? (
            <span
              data-ui="token-counter"
              data-warn={
                tokenBudget.used > tokenBudget.budget
                  ? 'danger'
                  : tokenBudget.budget > 0 && tokenBudget.used / tokenBudget.budget > 0.75
                    ? 'warn'
                    : undefined
              }
              aria-live="polite"
              title={`${tokenBudget.used.toLocaleString()} / ${tokenBudget.budget.toLocaleString()} tokens`}
            >
              {formatTokenCount(tokenBudget.used)}/{formatTokenCount(tokenBudget.budget)} tok
            </span>
          ) : null}
          {onImportAtEnd ? (
            <button
              type="button"
              data-ui="composer-import-at-end"
              onClick={onImportAtEnd}
              aria-label="Import messages at the end of the chat"
              title="Import at end (⇧⌘V)"
            >
              <InsertIcon size={14} />
              <span>Import</span>
            </button>
          ) : null}
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
              data-mode={emptyWithTrailingUser ? 'reply' : 'send'}
              disabled={sendBlocked || (text.trim() === '' && !emptyWithTrailingUser)}
              title={
                sendBlockedReason ??
                (emptyWithTrailingUser
                  ? 'Generate an assistant reply for the trailing user message'
                  : undefined)
              }
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
