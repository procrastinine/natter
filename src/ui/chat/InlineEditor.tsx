// In-place edit surface for a single message. Message edits own content only;
// reasoning and provider output have their own visibility actions.

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { GenerationSubmission } from '../../app/presentation-interactions'
import { generationCapabilityBlockedReason } from '../../core/interaction-capability'
import type { AttachmentRef, MessageAttachmentRef } from '../../core/types'
import { isPageHidingAbortError } from '../../lib/page-lifecycle'
import type { TotalPresentationInteractionPromise } from '../../store/presentation-contracts'
import { useAnnouncementStore } from '../../store/zustand/announcementStore'
import { AttachmentDraftTray } from '../attachments/AttachmentDraftTray'
import { AttachmentPicker } from '../attachments/AttachmentPicker'
import { useAttachmentDrafts } from '../attachments/useAttachmentDrafts'
import { DatabaseIcon, PaperclipIcon, PrefillIcon } from '../icons/Icon'
import { Button } from '../primitives/Button'
import { useScrollRegionCommands } from './ScrollRegion'

interface InlineEditorProps {
  initial: string
  onSave: (text: string) => TotalPresentationInteractionPromise<void>
  onCancel: () => void
  onSaveAndSend?: (
    text: string,
    opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
  ) => GenerationSubmission
  saveDisabled?: boolean
  ariaLabel?: string
  initialAttachmentRefs?: readonly AttachmentRef[] | undefined
  attachmentsEnabled?: boolean
  // Prefill toggle for Save & Send. Only applied to user messages
  // (assistants don't have a "send" path). Hidden when the model doesn't
  // support prefill. Empty / whitespace-only prefill text is treated as
  // "no prefill" (matches the composer's behavior).
  showPrefillButton?: boolean
  defaultPrefill?: string
  prefillSettingsPrompt?: ReactNode
}

const MIN_TEXTAREA_ROWS = 6
const MAX_TEXTAREA_PX = 600

interface InlineEditorSession {
  active: boolean
}

function autosize(el: HTMLTextAreaElement | null): void {
  if (!el) return
  el.style.height = 'auto'
  const next = Math.min(el.scrollHeight, MAX_TEXTAREA_PX)
  el.style.height = `${next}px`
}

export function InlineEditor({
  initial,
  onSave,
  onCancel,
  onSaveAndSend,
  saveDisabled,
  ariaLabel,
  initialAttachmentRefs,
  attachmentsEnabled = true,
  showPrefillButton,
  defaultPrefill,
  prefillSettingsPrompt,
}: InlineEditorProps) {
  const [text, setText] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [saveAndSendError, setSaveAndSendError] = useState<string | null>(null)
  const attachments = useAttachmentDrafts(attachmentsEnabled ? initialAttachmentRefs : undefined)
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
  } = attachments
  const [pickerOpen, setPickerOpen] = useState(false)
  const [prefillOpen, setPrefillOpen] = useState(false)
  const [prefillText, setPrefillText] = useState(defaultPrefill ?? '')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const actionsRef = useRef<HTMLDivElement | null>(null)
  const scrollRegionCommands = useScrollRegionCommands()
  const prefillTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const sessionRef = useRef<InlineEditorSession>({ active: false })
  const pendingGenerationRef = useRef<Extract<GenerationSubmission, { kind: 'started' }> | null>(
    null,
  )
  const onCancelRef = useRef(onCancel)
  const uploadingAttachments = uploads.some((upload) => upload.state === 'uploading')

  useLayoutEffect(() => {
    onCancelRef.current = onCancel
  }, [onCancel])
  useLayoutEffect(() => {
    const session = sessionRef.current
    session.active = true
    return () => {
      session.active = false
    }
  }, [])
  const sessionIsCurrent = useCallback(
    (session: InlineEditorSession) => sessionRef.current === session && session.active,
    [],
  )
  const dismissIfCurrent = useCallback(
    (session: InlineEditorSession) => {
      if (!sessionIsCurrent(session)) return
      onCancelRef.current()
    },
    [sessionIsCurrent],
  )

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    // preventScroll: true so the browser doesn't align the textarea's top
    // with the viewport top (which on long assistant messages pushes the
    // Save/Cancel row below the fold). The action row is scrolled into view
    // explicitly with block: 'nearest' so the user always sees where to
    // commit or cancel.
    el.focus({ preventScroll: true })
    const end = el.value.length
    el.setSelectionRange(end, end)
    const actions = actionsRef.current
    if (actions) scrollRegionCommands?.revealNearest(actions)
  }, [scrollRegionCommands])
  // biome-ignore lint/correctness/useExhaustiveDependencies: text changes alter textarea scrollHeight.
  useLayoutEffect(() => {
    autosize(textareaRef.current)
  }, [text])

  const togglePrefill = useCallback(() => {
    if (prefillOpen) {
      setPrefillOpen(false)
      return
    }
    setPrefillText((prev) => (prev.length === 0 ? (defaultPrefill ?? '') : prev))
    setPrefillOpen(true)
    requestAnimationFrame(() => prefillTextareaRef.current?.focus())
  }, [prefillOpen, defaultPrefill])
  // No-op Save when nothing has changed — closes the editor without
  // touching IDB, without bumping `editedAt`, and (critically) without
  // flagging the "this reply may be stale" hint on downstream
  // assistant messages. Save & Send deliberately bypasses this check;
  // the user may want to re-send even when the text is unchanged.
  const isUnchanged = useCallback(() => text === initial, [text, initial])
  const commitSave = useCallback(() => {
    if (saveDisabled || busy || uploadingAttachments) return
    if (isUnchanged()) {
      onCancel()
      return
    }
    setBusy(true)
    const session = sessionRef.current
    const settlement = onSave(text)
    void settlement.then((outcome) => {
      if (!sessionIsCurrent(session)) return
      setBusy(false)
      if (outcome.kind !== 'succeeded') return
      useAnnouncementStore.getState().announce({ text: 'Message saved.' })
      dismissIfCurrent(session)
    })
    return settlement
  }, [
    busy,
    dismissIfCurrent,
    isUnchanged,
    onCancel,
    onSave,
    saveDisabled,
    sessionIsCurrent,
    text,
    uploadingAttachments,
  ])
  const commitSaveAndSend = useCallback(() => {
    if (!onSaveAndSend || uploadingAttachments) return
    const prefillOut = prefillOpen && prefillText.trim().length > 0 ? prefillText : ''
    setSaveAndSendError(null)
    const start = onSaveAndSend(text, {
      ...(prefillOut.length > 0 ? { prefillText: prefillOut } : {}),
      ...(attachmentRefs.length > 0 ? { attachmentRefs } : {}),
    })
    if (start.kind === 'not-started') {
      setSaveAndSendError(
        generationCapabilityBlockedReason(start.capability, 'edit-resend') ??
          'This branch is still preparing. Save & Send did not start.',
      )
      return
    }
    pendingGenerationRef.current?.cancel()
    setBusy(true)
    pendingGenerationRef.current = start
    const session = sessionRef.current
    void (async () => {
      try {
        const outcome = await start.completion
        if (!sessionIsCurrent(session) || pendingGenerationRef.current !== start) return
        if (outcome.kind === 'prepared') {
          dismissIfCurrent(session)
          return
        }
        setSaveAndSendError(
          outcome.failure
            ? `${outcome.failure.message} (${outcome.failure.diagnosticId})`
            : `Save & Send did not prepare (${outcome.reason}).`,
        )
      } catch (error) {
        if (
          !isPageHidingAbortError(error) &&
          sessionIsCurrent(session) &&
          pendingGenerationRef.current === start
        ) {
          setSaveAndSendError(
            error instanceof Error ? error.message : 'Generation preparation failed.',
          )
        }
      } finally {
        if (pendingGenerationRef.current === start) {
          pendingGenerationRef.current = null
          if (sessionIsCurrent(session)) setBusy(false)
        }
      }
    })()
  }, [
    attachmentRefs,
    dismissIfCurrent,
    onSaveAndSend,
    prefillOpen,
    prefillText,
    sessionIsCurrent,
    text,
    uploadingAttachments,
  ])

  const handleKey = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (e.shiftKey && onSaveAndSend) {
          void commitSaveAndSend()
        } else {
          void commitSave()
        }
      }
    },
    [commitSave, commitSaveAndSend, onCancel, onSaveAndSend],
  )

  return (
    <div data-ui="inline-editor" aria-busy={busy || undefined}>
      <textarea
        ref={textareaRef}
        data-ui="inline-editor-input"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setSaveAndSendError(null)
        }}
        onKeyDown={handleKey}
        aria-label={ariaLabel ?? 'Edit message'}
        rows={MIN_TEXTAREA_ROWS}
        disabled={busy}
      />
      {prefillOpen ? (
        <>
          {prefillSettingsPrompt}
          <textarea
            ref={prefillTextareaRef}
            data-ui="inline-editor-prefill"
            value={prefillText}
            onChange={(e) => {
              setPrefillText(e.target.value)
              setSaveAndSendError(null)
            }}
            placeholder="Assistant prefill — the model continues from this text…"
            rows={3}
            disabled={busy}
            aria-label="Assistant prefill text"
          />
        </>
      ) : null}
      {attachmentsEnabled && (attachmentRefs.length > 0 || uploads.length > 0) ? (
        <AttachmentDraftTray
          refs={attachmentRefs}
          attachments={attachmentRows}
          uploads={uploads}
          disabled={busy}
          onToggle={toggleAttachment}
          onRemove={removeAttachment}
          onReplace={replaceAttachment}
          onDismissUpload={dismissUpload}
        />
      ) : null}
      <div data-ui="inline-editor-actions" ref={actionsRef}>
        {attachmentsEnabled ? (
          <>
            <input
              data-ui="attachment-hidden-input"
              type="file"
              multiple
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? [])
                event.currentTarget.value = ''
                if (files.length === 0) return
                void ingestFiles(files)
              }}
            />
            <Button
              data-ui="inline-editor-button"
              data-role="attach"
              geometry="flush"
              onClick={() =>
                (
                  actionsRef.current?.querySelector(
                    '[data-ui="attachment-hidden-input"]',
                  ) as HTMLInputElement | null
                )?.click()
              }
              disabled={busy || uploadingAttachments}
              aria-label="Upload attachment"
              title="Upload attachment"
            >
              <PaperclipIcon size={14} />
            </Button>
            <Button
              data-ui="inline-editor-button"
              data-role="attach-existing"
              geometry="flush"
              onClick={() => setPickerOpen(true)}
              disabled={busy}
              aria-label="Use existing stored attachment"
              title="Use existing stored attachment"
            >
              <DatabaseIcon size={14} />
            </Button>
          </>
        ) : null}
        <Button
          data-ui="inline-editor-button"
          data-role="cancel"
          geometry="flush"
          onClick={() => {
            if (busy && pendingGenerationRef.current) {
              pendingGenerationRef.current.cancel()
              return
            }
            onCancel()
          }}
          disabled={busy && pendingGenerationRef.current === null}
          title={
            busy && pendingGenerationRef.current
              ? 'Cancel request preparation and keep this edit'
              : 'Cancel (Esc)'
          }
        >
          {busy && pendingGenerationRef.current ? 'Cancel preparing' : 'Cancel'}
        </Button>
        {onSaveAndSend && showPrefillButton ? (
          <Button
            data-ui="inline-editor-button"
            data-role="prefill"
            geometry="flush"
            data-active={prefillOpen ? 'true' : undefined}
            onClick={() => void togglePrefill()}
            disabled={busy}
            aria-pressed={prefillOpen}
            title={
              prefillOpen
                ? 'Close prefill'
                : 'Add an assistant prefill, the model continues from the prefilled text on Save & Send'
            }
          >
            <PrefillIcon size={14} />
            <span>Prefill</span>
          </Button>
        ) : null}
        <Button
          data-ui="inline-editor-button"
          data-role="save"
          appearance="surface"
          geometry="flush"
          onClick={() => void commitSave()}
          disabled={busy || uploadingAttachments || saveDisabled}
          title={
            uploadingAttachments
              ? 'Uploading attachments'
              : saveDisabled
                ? 'Preparing this edit'
                : 'Save in place (⌘⏎)'
          }
        >
          Save
        </Button>
        {onSaveAndSend ? (
          <Button
            data-ui="inline-editor-button"
            data-role="save-send"
            tone="accent"
            appearance="solid"
            geometry="flush"
            onClick={() => void commitSaveAndSend()}
            disabled={uploadingAttachments}
            title={
              uploadingAttachments
                ? 'Uploading attachments'
                : 'Save as a new variant and send (⇧⌘⏎)'
            }
          >
            Save &amp; Send
          </Button>
        ) : null}
      </div>
      {saveAndSendError ? (
        <div data-ui="inline-editor-generation-error" role="alert">
          {saveAndSendError}
        </div>
      ) : null}
      {attachmentsEnabled && pickerOpen ? (
        <AttachmentPicker
          sessionSurface="picker-inline-editor"
          title="Use stored attachment"
          onClose={() => setPickerOpen(false)}
          onPick={(attachment) => {
            addAttachment(attachment)
          }}
        />
      ) : null}
    </div>
  )
}
