import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SendShortcut } from '../../core/global-settings'
import type { MessageAttachmentRef } from '../../core/types'
import { AttachmentDraftTray } from '../attachments/AttachmentDraftTray'
import { AttachmentPicker } from '../attachments/AttachmentPicker'
import { useAttachmentDrafts } from '../attachments/useAttachmentDrafts'
import { DatabaseIcon, InsertIcon, PaperclipIcon, PrefillIcon, StopIcon } from '../icons/Icon'

export interface ComposerProps {
  // Disables the textarea entirely.
  disabled?: boolean
  // The textarea remains editable but Send is locked. Reason is rendered
  // beneath the composer and used as the Send-button tooltip.
  sendBlockedReason?: string
  onSubmit: (
    text: string,
    opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
  ) => void | Promise<void>
  onDraftChange?: (text: string) => void
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
  // Prefill button + textarea support. When `showPrefillButton` is true
  // a "Prefill" button appears next to "Import"; toggling it reveals a
  // second textarea below the main one. The text gets sent as
  // `prefillContent` on submit. `defaultPrefill` seeds the prefill
  // textarea each time the user opens it with an empty draft.
  showPrefillButton?: boolean
  defaultPrefill?: string
  prefillScopeKey?: string | null
  prefillSettingsPrompt?: ReactNode
  // Fires whenever the prefill textarea changes (or is cleared). Mirrors
  // `onDraftChange` for the main textarea so the token-budget estimate can
  // include the prefill in its sum. Empty string when the prefill panel is
  // closed (so the consumer can drop it from the count).
  onPrefillDraftChange?: (text: string) => void
  attachmentScopeKey?: string | null
  onAttachmentDraftChange?: (refs: MessageAttachmentRef[]) => void
  attachmentsDisabled?: boolean
  attachmentsDisabledReason?: string
  droppedFiles?: ComposerDroppedFiles | null
  onDroppedFilesConsumed?: (id: string) => void
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

export interface ComposerDroppedFiles {
  id: string
  files: File[]
}

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
  onDraftChange,
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
  showPrefillButton,
  defaultPrefill,
  prefillScopeKey,
  prefillSettingsPrompt,
  onPrefillDraftChange,
  attachmentScopeKey,
  onAttachmentDraftChange,
  attachmentsDisabled = false,
  attachmentsDisabledReason = 'Attachments are unavailable for this request mode.',
  droppedFiles,
  onDroppedFilesConsumed,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [prefillOpen, setPrefillOpen] = useState(false)
  const [prefillText, setPrefillText] = useState(defaultPrefill ?? '')
  // Track whether the prefill textarea has ever been opened so we don't
  // accidentally re-seed on every open. Reset along with `defaultPrefill`
  // changes so an updated default does seed the next opening.
  const lastSeededDefaultRef = useRef<string | undefined>(defaultPrefill)
  const lastPrefillScopeRef = useRef<string | null | undefined>(prefillScopeKey)
  const lastAttachmentScopeRef = useRef<string | null | undefined>(attachmentScopeKey)
  const prefillTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
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
    onDraftChange?.(text)
  }, [text, onDraftChange])
  // Mirror prefill changes to the parent so the token-budget gauge reflects
  // the combined input. Reports an empty string when the prefill panel is
  // closed — even when the prefill draft has content, hidden = excluded.
  useEffect(() => {
    onPrefillDraftChange?.(prefillOpen ? prefillText : '')
  }, [prefillOpen, prefillText, onPrefillDraftChange])
  useEffect(() => {
    if (lastPrefillScopeRef.current === prefillScopeKey) return
    lastPrefillScopeRef.current = prefillScopeKey
    lastSeededDefaultRef.current = defaultPrefill
    setPrefillOpen(false)
    setPrefillText(defaultPrefill ?? '')
    onPrefillDraftChange?.('')
  }, [prefillScopeKey, defaultPrefill, onPrefillDraftChange])
  useEffect(() => {
    if (showPrefillButton) return
    setPrefillOpen(false)
    setPrefillText(defaultPrefill ?? '')
    onPrefillDraftChange?.('')
  }, [showPrefillButton, defaultPrefill, onPrefillDraftChange])
  // Re-seed the prefill textarea from `defaultPrefill` whenever the value
  // changes (e.g. chat switch, settings edit) AND the user hasn't typed
  // anything custom yet. Skip when the prefill area is open and the user
  // has already entered text — clobbering their draft would be hostile.
  useEffect(() => {
    if (lastSeededDefaultRef.current === defaultPrefill) return
    const previousDefault = lastSeededDefaultRef.current ?? ''
    lastSeededDefaultRef.current = defaultPrefill
    setPrefillText((prev) =>
      !prefillOpen || prev.length === 0 || prev === previousDefault ? (defaultPrefill ?? '') : prev,
    )
  }, [defaultPrefill, prefillOpen])
  // When the user closes prefill, reset the text to the chat's default so
  // the next open isn't haunted by stale text. (Send already clears it.)
  const togglePrefill = useCallback(async () => {
    const next = !prefillOpen
    if (next) {
      // Seed from the chat's default if the user's prefill draft is empty.
      setPrefillText((prev) => (prev.length === 0 ? (defaultPrefill ?? '') : prev))
      setPrefillOpen(true)
      requestAnimationFrame(() => prefillTextareaRef.current?.focus())
    } else {
      setPrefillOpen(false)
    }
  }, [prefillOpen, defaultPrefill])
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: text changes alter textarea scrollHeight.
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
  const trimmed = text.trim()
  const attachments = useAttachmentDrafts()
  const {
    attachmentRefs,
    attachmentRows,
    uploads,
    addAttachment,
    replaceAttachment,
    toggleAttachment,
    removeAttachment,
    ingestFiles,
    dismissUpload,
    clear: clearAttachments,
    restore: restoreAttachments,
  } = attachments
  useEffect(() => {
    if (!droppedFiles) return
    if (disabled || attachmentsDisabled) {
      onDroppedFilesConsumed?.(droppedFiles.id)
      return
    }
    void ingestFiles(droppedFiles.files).finally(() => {
      onDroppedFilesConsumed?.(droppedFiles.id)
    })
  }, [droppedFiles, disabled, attachmentsDisabled, ingestFiles, onDroppedFilesConsumed])
  useEffect(() => {
    if (attachmentsDisabled) setPickerOpen(false)
  }, [attachmentsDisabled])
  useEffect(() => {
    onAttachmentDraftChange?.(attachmentRefs)
  }, [attachmentRefs, onAttachmentDraftChange])
  useEffect(() => {
    if (lastAttachmentScopeRef.current === attachmentScopeKey) return
    lastAttachmentScopeRef.current = attachmentScopeKey
    clearAttachments()
    onAttachmentDraftChange?.([])
  }, [attachmentScopeKey, clearAttachments, onAttachmentDraftChange])
  const uploadingAttachments = uploads.some((upload) => upload.state === 'uploading')
  const sendBlocked =
    Boolean(sendBlockedReason) ||
    Boolean(disabled) ||
    streaming ||
    submitting ||
    uploadingAttachments
  const attachmentControlsDisabled = Boolean(disabled) || attachmentsDisabled
  const hasAttachments = !attachmentsDisabled && attachmentRefs.length > 0
  const emptyWithTrailingUser =
    trimmed.length === 0 &&
    !hasAttachments &&
    Boolean(trailingUserMessage) &&
    Boolean(onReplyToTrailingUser)
  const send = useCallback(async () => {
    if (sendBlocked) return
    if (text.trim().length === 0 && !hasAttachments) {
      if (emptyWithTrailingUser && onReplyToTrailingUser) {
        setSubmitting(true)
        try {
          await onReplyToTrailingUser()
        } catch (err) {
          console.error('composer reply failed', err)
        } finally {
          setSubmitting(false)
        }
      }
      return
    }
    const out = text.trim()
    const refsOut = attachmentsDisabled ? [] : attachmentRefs
    const rowsOut = new Map(attachmentRows)
    // Capture and clear the prefill text in the same render so a fast
    // double-tap doesn't send the same prefill twice. Empty / whitespace-
    // only prefill is treated as no prefill (the wire transform would trim
    // trailing whitespace anyway, so an empty prefill turn would be a
    // no-op-then-confuse-the-model).
    const prefillOut = prefillOpen && prefillText.trim().length > 0 ? prefillText : ''
    setText('')
    if (!attachmentsDisabled) clearAttachments()
    if (prefillOut.length > 0) {
      setPrefillText(defaultPrefill ?? '')
    }
    setSubmitting(true)
    try {
      await onSubmit(out, {
        ...(prefillOut.length > 0 ? { prefillText: prefillOut } : {}),
        ...(refsOut.length > 0 ? { attachmentRefs: refsOut } : {}),
      })
    } catch (err) {
      setText((current) => (current.length === 0 ? out : current))
      if (refsOut.length > 0) restoreAttachments(refsOut, rowsOut)
      if (prefillOut.length > 0) setPrefillText(prefillOut)
      console.error('composer submit failed', err)
    } finally {
      setSubmitting(false)
    }
  }, [
    text,
    sendBlocked,
    emptyWithTrailingUser,
    onReplyToTrailingUser,
    onSubmit,
    prefillOpen,
    prefillText,
    defaultPrefill,
    attachmentRefs,
    attachmentRows,
    hasAttachments,
    attachmentsDisabled,
    clearAttachments,
    restoreAttachments,
  ])
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
  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLHRElement>) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      const step = e.shiftKey ? 40 : 10
      const delta = e.key === 'ArrowUp' ? step : -step
      setHeight((current) =>
        autoSize ? clampFloorHeight(current + delta) : clampFixedHeight(current + delta),
      )
    },
    [autoSize],
  )

  return (
    <form
      data-ui="composer"
      data-autosize={autoSize ? 'true' : 'false'}
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <hr
        data-ui="composer-resize-handle"
        aria-orientation="horizontal"
        aria-label="Resize composer"
        aria-valuemin={autoSize ? 0 : COMPOSER_MIN_HEIGHT}
        aria-valuemax={COMPOSER_MAX_HEIGHT}
        aria-valuenow={Math.round(height)}
        tabIndex={0}
        title={
          autoSize
            ? 'Drag to set a minimum height (content still auto-grows above it)'
            : 'Drag to resize'
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleResizeKeyDown}
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
        {prefillOpen ? (
          <>
            {prefillSettingsPrompt}
            <textarea
              ref={prefillTextareaRef}
              data-ui="composer-prefill"
              value={prefillText}
              onChange={(e) => setPrefillText(e.target.value)}
              placeholder="Assistant prefill — the model continues from this text…"
              disabled={disabled}
              rows={3}
              aria-label="Assistant prefill text"
            />
          </>
        ) : null}
        {attachmentRefs.length > 0 || uploads.length > 0 ? (
          <AttachmentDraftTray
            refs={attachmentRefs}
            attachments={attachmentRows}
            uploads={uploads}
            disabled={disabled}
            onToggle={toggleAttachment}
            onRemove={removeAttachment}
            onReplace={replaceAttachment}
            onDismissUpload={dismissUpload}
          />
        ) : null}
        <div data-ui="composer-actions">
          <span data-ui="token-counter" aria-live="polite">
            {text.trim().length + (prefillOpen ? prefillText.length : 0)} chars
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
          {showPrefillButton ? (
            <button
              type="button"
              data-ui="composer-prefill-toggle"
              data-active={prefillOpen ? 'true' : undefined}
              onClick={() => void togglePrefill()}
              aria-label={prefillOpen ? 'Close prefill' : 'Open assistant prefill'}
              aria-pressed={prefillOpen}
              title={
                prefillOpen
                  ? 'Close prefill (assistant text editor)'
                  : 'Add an assistant prefill — the model continues from your text'
              }
            >
              <PrefillIcon size={14} />
              <span>Prefill</span>
            </button>
          ) : null}
          <input
            ref={fileInputRef}
            data-ui="attachment-hidden-input"
            type="file"
            multiple
            disabled={attachmentControlsDisabled}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? [])
              event.currentTarget.value = ''
              if (files.length === 0) return
              if (attachmentsDisabled) return
              void ingestFiles(files)
            }}
          />
          <button
            type="button"
            data-ui="composer-attach"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Upload attachments"
            title={attachmentsDisabled ? attachmentsDisabledReason : 'Upload attachments'}
            disabled={attachmentControlsDisabled}
          >
            <PaperclipIcon size={14} />
          </button>
          <button
            type="button"
            data-ui="composer-attach-existing"
            onClick={() => setPickerOpen(true)}
            aria-label="Use existing stored attachment"
            title={
              attachmentsDisabled ? attachmentsDisabledReason : 'Use existing stored attachment'
            }
            disabled={attachmentControlsDisabled}
          >
            <DatabaseIcon size={14} />
          </button>
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
              disabled={
                sendBlocked || (text.trim() === '' && !hasAttachments && !emptyWithTrailingUser)
              }
              title={
                sendBlockedReason ??
                (uploadingAttachments ? 'Uploading attachments' : undefined) ??
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
      {pickerOpen ? (
        <AttachmentPicker
          title="Use stored attachment"
          onClose={() => setPickerOpen(false)}
          onPick={(attachment) => {
            addAttachment(attachment)
            setPickerOpen(false)
          }}
        />
      ) : null}
    </form>
  )
}
