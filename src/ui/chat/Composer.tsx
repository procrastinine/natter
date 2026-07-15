import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { SendShortcut } from '../../core/global-settings'
import { estimateTokens } from '../../core/tokens'
import type { MessageAttachmentRef } from '../../core/types'
import { isPageHidingAbortError } from '../../lib/page-lifecycle'
import { AttachmentDraftTray } from '../attachments/AttachmentDraftTray'
import { AttachmentPicker } from '../attachments/AttachmentPicker'
import { useAttachmentDrafts } from '../attachments/useAttachmentDrafts'
import { DatabaseIcon, InsertIcon, PaperclipIcon, PrefillIcon, StopIcon } from '../icons/Icon'
import { Button } from '../primitives/Button'
import {
  publishComposerContextDraft,
  readComposerDraftText,
  writeComposerDraftText,
} from './composer-draft-state'

export { moveComposerDraft } from './composer-draft-state'

interface ComposerProps {
  // Disables the textarea entirely.
  disabled?: boolean
  // The textarea remains editable but Send is locked. Reason is rendered
  // beneath the composer and used as the Send-button tooltip.
  sendBlockedReason?: string
  onSubmit: (
    text: string,
    opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
  ) => void | Promise<void>
  draftKey?: string | null
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
  // "Import at end" button handler (§10.7). Opens the import modal
  // pre-scoped to "end of active path." Rendered only when provided.
  onImportAtEnd?: () => void
  onImportAtEndIntent?: () => void
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
  attachmentScopeKey?: string | null
  attachmentsDisabled?: boolean
  attachmentsDisabledReason?: string
  droppedFiles?: ComposerDroppedFiles | null
  onDroppedFilesConsumed?: (id: string) => void
  // When true, the textarea starts at the variant's default height and
  // auto-grows with content up to the variant's cap until the user resizes it.
  // A manual resize becomes an explicit viewport height; excess content
  // scrolls inside the textarea.
  autoSize?: boolean
  // Which auto-size profile to use when `autoSize` is true. Different
  // surfaces have different natural sizes:
  //   - `'normal'` (default): compact — start at one line, cap at
  //     ~10 lines. Optimized to leave room for the message list.
  //   - `'focus'`: generous — start taller, cap roughly doubled. In
  //     focus mode the composer IS the bottom of the reading lane
  //     (scrolls with content, no sticky footer), so a bigger default
  //     and a bigger ceiling are useful for drafting.
  // Each variant has its own localStorage key for the height so user
  // drags in one mode don't leak into the other.
  autoSizeVariant?: AutoSizeVariant
  autoSizeMeasurementKey?: string
}

type AutoSizeVariant = 'normal' | 'focus'

export interface ComposerDroppedFiles {
  id: string
  files: File[]
}

interface AutoSizeProfile {
  autoMinHeight: number
  autoGrowMax: number
  storageKey: string
}

const AUTO_SIZE_PROFILES: Record<AutoSizeVariant, AutoSizeProfile> = {
  normal: {
    autoMinHeight: 0,
    autoGrowMax: 240,
    storageKey: 'natter:composer-floor',
  },
  focus: {
    autoMinHeight: 200,
    autoGrowMax: 480,
    storageKey: 'natter:composer-height-focus',
  },
}

const COMPOSER_HEIGHT_STORAGE_KEY = 'natter:composer-height'
const COMPOSER_MIN_HEIGHT = 80
const COMPOSER_MAX_HEIGHT = 600
const COMPOSER_DEFAULT_HEIGHT = 120
const EMPTY_ATTACHMENT_REFS: readonly MessageAttachmentRef[] = Object.freeze([])

function readSavedHeight(): number {
  if (typeof window === 'undefined') return COMPOSER_DEFAULT_HEIGHT
  const raw = window.localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY)
  if (!raw) return COMPOSER_DEFAULT_HEIGHT
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return COMPOSER_DEFAULT_HEIGHT
  return clampFixedHeight(parsed)
}

function readSavedManualHeight(variant: AutoSizeVariant): number | null {
  const profile = AUTO_SIZE_PROFILES[variant]
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(profile.storageKey)
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(COMPOSER_MAX_HEIGHT, parsed)
}

function clampFixedHeight(value: number): number {
  return Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, value))
}

function clampComposerHeight(value: number, minHeight: number): number {
  return Math.min(COMPOSER_MAX_HEIGHT, Math.max(minHeight, value))
}

function cssPixels(value: string, fallback = 0): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

interface TextareaLineMetrics {
  lineHeight: number
  oneLineHeight: number
}

function textareaLineMetrics(el: HTMLTextAreaElement): TextareaLineMetrics {
  const style = getComputedStyle(el)
  const fontSize = cssPixels(style.fontSize, 16)
  const lineHeight = cssPixels(style.lineHeight, fontSize * 1.2)
  return {
    lineHeight,
    oneLineHeight: Math.ceil(
      lineHeight +
        cssPixels(style.paddingTop) +
        cssPixels(style.paddingBottom) +
        cssPixels(style.borderTopWidth) +
        cssPixels(style.borderBottomWidth),
    ),
  }
}

function oneLineTextareaHeight(el: HTMLTextAreaElement): number {
  return textareaLineMetrics(el).oneLineHeight
}

function setComposerTextareaHeight(
  el: HTMLTextAreaElement,
  height: number,
  measuredContentHeight = el.scrollHeight,
): void {
  const effectiveHeight = Math.ceil(height)
  el.style.height = `${effectiveHeight}px`
  el.style.overflowY = measuredContentHeight > effectiveHeight + 1 ? 'auto' : 'hidden'
}

export function Composer({
  disabled,
  sendBlockedReason,
  onSubmit,
  draftKey = null,
  seed,
  onSeedConsumed,
  sendShortcut = 'enter',
  floatingAccessory,
  streaming = false,
  onAbort,
  onImportAtEnd,
  onImportAtEndIntent,
  onReplyToTrailingUser,
  trailingUserMessage,
  autoSize = false,
  autoSizeVariant = 'normal',
  autoSizeMeasurementKey,
  showPrefillButton,
  defaultPrefill,
  prefillScopeKey,
  prefillSettingsPrompt,
  attachmentScopeKey,
  attachmentsDisabled = false,
  attachmentsDisabledReason = 'Attachments are unavailable for this request mode.',
  droppedFiles,
  onDroppedFilesConsumed,
}: ComposerProps) {
  const [text, setText] = useState(() => readComposerDraftText(draftKey))
  const [pickerOpen, setPickerOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [prefillOpen, setPrefillOpen] = useState(false)
  const [prefillText, setPrefillText] = useState(defaultPrefill ?? '')
  const deferredText = useDeferredValue(text)
  const deferredPrefillText = useDeferredValue(prefillOpen ? prefillText : '')
  const deferredDraftText = deferredText.trim()
  const deferredDraftPrefillText = deferredPrefillText.trim()
  const draftCharacterCount =
    Array.from(deferredDraftText).length + Array.from(deferredDraftPrefillText).length
  const draftTokenEstimate =
    estimateTokens(deferredDraftText, 'unknown') +
    estimateTokens(deferredDraftPrefillText, 'unknown')
  const draftTokenLabel =
    draftCharacterCount === 0
      ? '0 draft tokens'
      : draftCharacterCount === 1
        ? '1 draft token'
        : `≈ ${draftTokenEstimate.toLocaleString()} draft tokens`
  // Track whether the prefill textarea has ever been opened to avoid
  // accidental re-seeding on every open. Reset along with `defaultPrefill`
  // changes so an updated default does seed the next opening.
  const lastSeededDefaultRef = useRef<string | undefined>(defaultPrefill)
  const lastPrefillScopeRef = useRef<string | null | undefined>(prefillScopeKey)
  const lastAttachmentScopeRef = useRef<string | null | undefined>(attachmentScopeKey)
  const prefillTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const profile = AUTO_SIZE_PROFILES[autoSizeVariant]
  // A null auto-size height means content-driven sizing. The first manual
  // resize stores an exact viewport height; fixed mode always has a value.
  const [height, setHeight] = useState<number | null>(() =>
    autoSize ? readSavedManualHeight(autoSizeVariant) : readSavedHeight(),
  )
  const [renderedHeight, setRenderedHeight] = useState(() =>
    autoSize ? profile.autoMinHeight : (height ?? COMPOSER_DEFAULT_HEIGHT),
  )
  const [resizeMinHeight, setResizeMinHeight] = useState(() => (autoSize ? 1 : COMPOSER_MIN_HEIGHT))
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const dragStateRef = useRef<{
    minHeight: number
    startY: number
    startHeight: number
  } | null>(null)
  const latestTextRef = useRef(text)
  const draftKeyRef = useRef<string | null>(draftKey)
  useEffect(() => {
    latestTextRef.current = text
  }, [text])
  const setComposerText = useCallback((value: string | ((current: string) => string)) => {
    const next = typeof value === 'function' ? value(latestTextRef.current) : value
    latestTextRef.current = next
    setText(next)
    writeComposerDraftText(draftKeyRef.current, next)
  }, [])
  useEffect(() => {
    if (draftKeyRef.current === draftKey) return
    writeComposerDraftText(draftKeyRef.current, latestTextRef.current)
    draftKeyRef.current = draftKey
    const next = readComposerDraftText(draftKey)
    latestTextRef.current = next
    setText(next)
  }, [draftKey])
  useEffect(() => {
    if (seed && seed.length > 0) {
      setComposerText(seed)
      onSeedConsumed?.()
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        const pos = el.value.length
        el.setSelectionRange(pos, pos)
      })
    }
  }, [seed, onSeedConsumed, setComposerText])
  useEffect(() => {
    if (lastPrefillScopeRef.current === prefillScopeKey) return
    lastPrefillScopeRef.current = prefillScopeKey
    lastSeededDefaultRef.current = defaultPrefill
    setPrefillOpen(false)
    setPrefillText(defaultPrefill ?? '')
  }, [prefillScopeKey, defaultPrefill])
  useEffect(() => {
    if (showPrefillButton) return
    setPrefillOpen(false)
    setPrefillText(defaultPrefill ?? '')
  }, [showPrefillButton, defaultPrefill])
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
  const togglePrefill = useCallback(() => {
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
    if (autoSize && height === null) {
      window.localStorage.removeItem(key)
      return
    }
    window.localStorage.setItem(key, String(Math.round(height ?? COMPOSER_DEFAULT_HEIGHT)))
  }, [autoSize, profile.storageKey, height])
  // Drive the textarea height imperatively (via the DOM ref). The visual
  // size is dynamic — either drag-updated+persisted or content-driven —
  // so it can't live in a stylesheet, and the project's style-discipline
  // contract forbids inline JSX style attributes. useLayoutEffect so the
  // height lands before paint (prevents a one-frame tall flash during
  // keystrokes in auto-size mode).
  //
  // Auto-size semantics: null auto-grows from the profile minimum to its cap;
  // a manual value is an exact viewport height and overflows internally.
  // Constrain the `height: auto` measurement so its forced layout cannot
  // transiently resize the sibling transcript and clamp its bottom scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: text changes alter textarea scrollHeight.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const { lineHeight, oneLineHeight } = textareaLineMetrics(el)
    const minHeight = autoSize ? oneLineHeight : COMPOSER_MIN_HEIGHT
    setResizeMinHeight((current) => (current === minHeight ? current : minHeight))
    if (autoSize) {
      if (height !== null) {
        const manualHeight = Math.ceil(clampComposerHeight(height, oneLineHeight))
        el.style.minHeight = `${manualHeight}px`
        el.style.maxHeight = `${manualHeight}px`
        setComposerTextareaHeight(el, manualHeight)
        setRenderedHeight((current) => (current === manualHeight ? current : manualHeight))
        if (manualHeight === oneLineHeight && el.scrollHeight <= manualHeight + 1) {
          setHeight(null)
        } else if (manualHeight !== height) {
          setHeight(manualHeight)
        }
        return
      }
      const autoMinHeight = Math.max(oneLineHeight, profile.autoMinHeight)
      el.style.minHeight = `${autoMinHeight}px`
      el.style.maxHeight = `${Math.max(autoMinHeight, profile.autoGrowMax)}px`
      el.style.height = 'auto'
      el.style.overflowY = 'hidden'
      const measuredContentHeight = el.scrollHeight
      // Browser rounding can move a single line by a few scrollHeight pixels.
      const normalizedContentHeight =
        measuredContentHeight - oneLineHeight < lineHeight / 2
          ? oneLineHeight
          : measuredContentHeight
      const contentHeight = Math.min(normalizedContentHeight, profile.autoGrowMax)
      const effectiveHeight = Math.max(autoMinHeight, contentHeight)
      setComposerTextareaHeight(el, effectiveHeight, normalizedContentHeight)
      setRenderedHeight((current) =>
        current === effectiveHeight ? current : Math.ceil(effectiveHeight),
      )
      return
    }
    el.style.minHeight = ''
    el.style.maxHeight = ''
    const fixedHeight = height ?? COMPOSER_DEFAULT_HEIGHT
    setComposerTextareaHeight(el, fixedHeight)
    setRenderedHeight((current) => (current === fixedHeight ? current : Math.ceil(fixedHeight)))
  }, [autoSize, autoSizeMeasurementKey, profile.autoGrowMax, profile.autoMinHeight, height, text])
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
    if (lastAttachmentScopeRef.current === attachmentScopeKey) return
    lastAttachmentScopeRef.current = attachmentScopeKey
    clearAttachments()
  }, [attachmentScopeKey, clearAttachments])
  const draftScopeStable = draftKeyRef.current === draftKey
  const prefillScopeStable = lastPrefillScopeRef.current === prefillScopeKey
  const attachmentScopeStable = lastAttachmentScopeRef.current === attachmentScopeKey
  useEffect(() => {
    if (!draftScopeStable) return
    publishComposerContextDraft(draftKey, {
      text: deferredText.trim(),
      prefillText: prefillScopeStable ? deferredPrefillText : '',
      attachmentRefs:
        attachmentScopeStable && !attachmentsDisabled ? attachmentRefs : EMPTY_ATTACHMENT_REFS,
    })
  }, [
    attachmentRefs,
    attachmentScopeStable,
    attachmentsDisabled,
    deferredPrefillText,
    deferredText,
    draftKey,
    draftScopeStable,
    prefillScopeStable,
  ])
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
          if (isPageHidingAbortError(err)) return
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
    setComposerText('')
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
      if (isPageHidingAbortError(err)) return
      setComposerText((current) => (current.length === 0 ? out : current))
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
    setComposerText,
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
      const textarea = textareaRef.current
      dragStateRef.current = {
        minHeight: autoSize && textarea ? oneLineTextareaHeight(textarea) : COMPOSER_MIN_HEIGHT,
        startY: e.clientY,
        startHeight: textarea?.getBoundingClientRect().height ?? renderedHeight,
      }
    },
    [autoSize, renderedHeight],
  )
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current
    if (!drag) return
    const delta = drag.startY - e.clientY
    const next = drag.startHeight + delta
    setHeight(clampComposerHeight(next, drag.minHeight))
  }, [])
  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStateRef.current) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    dragStateRef.current = null
  }, [])
  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLHRElement>) => {
      if (autoSize && e.key === 'Enter') {
        e.preventDefault()
        setHeight(null)
        return
      }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      const step = e.shiftKey ? 40 : 10
      const delta = e.key === 'ArrowUp' ? step : -step
      const textarea = textareaRef.current
      const minHeight = autoSize && textarea ? oneLineTextareaHeight(textarea) : COMPOSER_MIN_HEIGHT
      const start = textarea?.getBoundingClientRect().height ?? renderedHeight
      setHeight(clampComposerHeight(start + delta, minHeight))
    },
    [autoSize, renderedHeight],
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
        data-resize-mode={autoSize && height === null ? 'auto' : 'manual'}
        aria-orientation="horizontal"
        aria-label={
          autoSize ? 'Resize composer; press Enter for automatic height' : 'Resize composer'
        }
        aria-keyshortcuts={autoSize ? 'Enter' : undefined}
        aria-valuemin={resizeMinHeight}
        aria-valuemax={COMPOSER_MAX_HEIGHT}
        aria-valuenow={Math.round(renderedHeight)}
        aria-valuetext={`${autoSize && height === null ? 'Automatic' : 'Manual'}, ${Math.round(renderedHeight)} pixels`}
        tabIndex={0}
        title={autoSize ? 'Drag to resize; double-click for automatic height' : 'Drag to resize'}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={() => {
          if (autoSize) setHeight(null)
        }}
        onKeyDown={handleResizeKeyDown}
      />
      {floatingAccessory ?? null}
      <div data-ui="composer-body">
        <div data-ui="composer-input-shell">
          <textarea
            ref={textareaRef}
            data-ui="composer-input"
            value={text}
            onChange={(e) => setComposerText(e.target.value)}
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
        </div>
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
          <span
            data-ui="token-counter"
            title="Pending text only; drafts longer than one character are approximate. Context settings combines this draft and included attachments with the active conversation."
          >
            {draftTokenLabel}
          </span>
          {showPrefillButton ? (
            <Button
              data-ui="composer-prefill-toggle"
              appearance="strip"
              geometry="flush"
              data-active={prefillOpen ? 'true' : undefined}
              onClick={() => void togglePrefill()}
              aria-label={prefillOpen ? 'Close prefill' : 'Open assistant prefill'}
              aria-pressed={prefillOpen}
              disabled={disabled}
              title={
                prefillOpen
                  ? 'Close prefill (assistant text editor)'
                  : 'Add an assistant prefill, the model continues from the prefilled text'
              }
            >
              <PrefillIcon size={14} />
              <span>Prefill</span>
            </Button>
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
          <Button
            data-ui="composer-attach"
            appearance="strip"
            geometry="flush"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Upload attachments"
            title={attachmentsDisabled ? attachmentsDisabledReason : 'Upload attachments'}
            disabled={attachmentControlsDisabled}
          >
            <PaperclipIcon size={14} />
          </Button>
          <Button
            data-ui="composer-attach-existing"
            appearance="strip"
            geometry="flush"
            onClick={() => setPickerOpen(true)}
            aria-label="Use existing stored attachment"
            title={
              attachmentsDisabled ? attachmentsDisabledReason : 'Use existing stored attachment'
            }
            disabled={attachmentControlsDisabled}
          >
            <DatabaseIcon size={14} />
          </Button>
          {onImportAtEnd ? (
            <Button
              data-ui="composer-import-at-end"
              appearance="strip"
              geometry="flush"
              onPointerEnter={onImportAtEndIntent}
              onPointerDown={onImportAtEndIntent}
              onFocus={onImportAtEndIntent}
              onClick={onImportAtEnd}
              aria-label="Import messages at the end of the chat"
              title="Import at end (⇧⌘V)"
              disabled={disabled}
            >
              <InsertIcon size={14} />
              <span>Import</span>
            </Button>
          ) : null}
          {streaming && onAbort ? (
            <Button
              data-ui="abort"
              tone="danger"
              appearance="solid"
              geometry="flush"
              onClick={onAbort}
              title="Stop generating (⌘.)"
              aria-label="Stop generating"
            >
              <StopIcon size={14} />
              <span>Stop</span>
            </Button>
          ) : (
            <Button
              type="submit"
              data-ui="send"
              tone="accent"
              appearance="solid"
              geometry="flush"
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
            </Button>
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
