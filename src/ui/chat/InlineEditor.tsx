// In-place edit surface for a single message body.

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
import {
  type MessageBodyAuthoringOperations,
  type ProviderOutputAuthoringEntry,
  type ProviderOutputAuthoringProjection,
  planProviderOutputAuthoringOperations,
  planReasoningAuthoringOperations,
  type ReasoningAuthoringEntry,
  type ReasoningAuthoringProjection,
  reasoningAuthoringEntryKey,
} from '../../core/message-body-authoring'
import type {
  AttachmentRef,
  MessageAttachmentRef,
  MessageAttemptOwner,
  ProviderOutputDialect,
} from '../../core/types'
import { isPageHidingAbortError } from '../../lib/page-lifecycle'
import { sameValue } from '../../lib/same-value'
import { newId } from '../../lib/ulid'
import type { TotalPresentationInteractionPromise } from '../../store/presentation-contracts'
import { useAnnouncementStore } from '../../store/zustand/announcementStore'
import { AttachmentDraftTray } from '../attachments/AttachmentDraftTray'
import { AttachmentPicker } from '../attachments/AttachmentPicker'
import { useAttachmentDrafts } from '../attachments/useAttachmentDrafts'
import {
  DatabaseIcon,
  EyeIcon,
  EyeOffIcon,
  PaperclipIcon,
  PrefillIcon,
  TrashIcon,
} from '../icons/Icon'
import { Button } from '../primitives/Button'
import { useScrollRegionCommands } from './ScrollRegion'

interface InlineEditorProps {
  initial: string
  onSave: (
    text: string,
    authoring?: MessageBodyAuthoringOperations,
    attachmentRefs?: MessageAttachmentRef[],
  ) => TotalPresentationInteractionPromise<void>
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
  initialReasoning?: ReasoningAuthoringProjection
  initialProviderOutput?: ProviderOutputAuthoringProjection
}

const MIN_TEXTAREA_ROWS = 6
const MAX_TEXTAREA_PX = 600

interface InlineEditorSession {
  active: boolean
}

function autosize(el: HTMLTextAreaElement | null): void {
  if (!el) return
  el.style.height = 'auto'
  el.style.overflowY = 'hidden'
  const measuredHeight = el.scrollHeight
  const next = Math.min(measuredHeight, MAX_TEXTAREA_PX)
  el.style.height = `${next}px`
  el.style.overflowY = measuredHeight > next ? 'auto' : 'hidden'
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
  initialReasoning,
  initialProviderOutput,
}: InlineEditorProps) {
  const initialTextRef = useRef(initial)
  const initialReasoningRef = useRef(initialReasoning)
  const reasoningBaseline = initialReasoningRef.current
  const initialProviderOutputRef = useRef(initialProviderOutput)
  const providerOutputBaseline = initialProviderOutputRef.current
  const [text, setText] = useState(initialTextRef.current)
  const [busy, setBusy] = useState(false)
  const [saveAndSendError, setSaveAndSendError] = useState<string | null>(null)
  const attachments = useAttachmentDrafts(attachmentsEnabled ? initialAttachmentRefs : undefined)
  const {
    initialAttachmentRefs: startingAttachmentRefs,
    attachmentRefs,
    currentAttachmentRefs,
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
  const [reasoningOpen, setReasoningOpen] = useState(false)
  const [reasoning, setReasoning] = useState<ReasoningAuthoringEntry[]>(() =>
    reasoningBaseline ? [...reasoningBaseline.entries] : [],
  )
  const [providerOutputOpen, setProviderOutputOpen] = useState(false)
  const [providerOutput, setProviderOutput] = useState<ProviderOutputAuthoringEntry[] | null>(() =>
    providerOutputBaseline?.entries.length === 0 ? [] : null,
  )
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
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const style = getComputedStyle(el)
    let measuredWidth =
      el.clientWidth -
      (Number.parseFloat(style.paddingLeft) || 0) -
      (Number.parseFloat(style.paddingRight) || 0)
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || Math.abs(entry.contentRect.width - measuredWidth) < 0.5) return
      measuredWidth = entry.contentRect.width
      autosize(el)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

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
  const isUnchanged = useCallback(() => {
    const currentRefs = currentAttachmentRefs()
    return (
      text === initialTextRef.current &&
      sameValue(startingAttachmentRefs, currentRefs) &&
      (!reasoningBaseline ||
        planReasoningAuthoringOperations(reasoningBaseline.entries, reasoning).length === 0) &&
      (!providerOutputBaseline ||
        providerOutput === null ||
        planProviderOutputAuthoringOperations(providerOutputBaseline.entries, providerOutput)
          .length === 0)
    )
  }, [
    currentAttachmentRefs,
    providerOutput,
    providerOutputBaseline,
    reasoning,
    reasoningBaseline,
    startingAttachmentRefs,
    text,
  ])
  const commitSave = useCallback(() => {
    if (saveDisabled || busy || uploadingAttachments) return
    if (isUnchanged()) {
      onCancel()
      return
    }
    setBusy(true)
    const session = sessionRef.current
    const reasoningOperations = reasoningBaseline
      ? planReasoningAuthoringOperations(reasoningBaseline.entries, reasoning)
      : []
    const providerOutputOperations =
      providerOutputBaseline && providerOutput !== null
        ? planProviderOutputAuthoringOperations(providerOutputBaseline.entries, providerOutput)
        : []
    const authoring: MessageBodyAuthoringOperations = {
      ...(reasoningOperations.length > 0 ? { reasoning: reasoningOperations } : {}),
      ...(providerOutputOperations.length > 0 ? { providerOutput: providerOutputOperations } : {}),
    }
    const currentRefs = currentAttachmentRefs()
    const attachmentRefsChanged = !sameValue(startingAttachmentRefs, currentRefs)
    const authoredBodyChanged =
      reasoningOperations.length > 0 || providerOutputOperations.length > 0
    const settlement =
      authoredBodyChanged || attachmentRefsChanged
        ? onSave(
            text,
            authoredBodyChanged ? authoring : undefined,
            attachmentRefsChanged ? currentRefs : undefined,
          )
        : onSave(text)
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
    currentAttachmentRefs,
    dismissIfCurrent,
    isUnchanged,
    onCancel,
    onSave,
    providerOutput,
    providerOutputBaseline,
    reasoningBaseline,
    reasoning,
    saveDisabled,
    sessionIsCurrent,
    text,
    startingAttachmentRefs,
    uploadingAttachments,
  ])
  const commitSaveAndSend = useCallback(() => {
    if (!onSaveAndSend || uploadingAttachments) return
    const currentRefs = currentAttachmentRefs()
    const prefillOut = prefillOpen && prefillText.trim().length > 0 ? prefillText : ''
    setSaveAndSendError(null)
    const start = onSaveAndSend(text, {
      ...(prefillOut.length > 0 ? { prefillText: prefillOut } : {}),
      ...(currentRefs.length > 0 ? { attachmentRefs: currentRefs } : {}),
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
    currentAttachmentRefs,
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
      {reasoningBaseline ? (
        <details
          data-ui="inline-editor-reasoning"
          open={reasoningOpen || reasoning.length === 0}
          onToggle={(event) => setReasoningOpen(event.currentTarget.open)}
        >
          <summary>Reasoning ({reasoning.length})</summary>
          <div data-ui="inline-editor-reasoning-list">
            {reasoning.map((entry, index) => (
              <ReasoningEditorRow
                key={reasoningAuthoringEntryKey(entry)}
                entry={entry}
                ownerLabel={reasoningOwnerLabel(entry.owner, reasoningBaseline.owners)}
                showOwner={reasoningBaseline.owners.length > 1}
                busy={busy}
                onChange={(next) =>
                  setReasoning((current) =>
                    current.map((candidate, candidateIndex) =>
                      candidateIndex === index ? next : candidate,
                    ),
                  )
                }
                onDelete={() =>
                  setReasoning((current) =>
                    current.filter((_, candidateIndex) => candidateIndex !== index),
                  )
                }
                onCommit={handleKey}
              />
            ))}
          </div>
          <AddReasoningEntry
            owners={reasoningBaseline.owners}
            busy={busy}
            onAdd={(kind, owner) => {
              const id = newId()
              setReasoning((current) => [
                ...current,
                {
                  kind: 'visible',
                  owner,
                  part: {
                    id,
                    groupId: id,
                    kind,
                    text: '',
                    format: 'unknown',
                    source: { dialect: 'unknown', bridge: 'unknown' },
                  },
                },
              ])
              setReasoningOpen(true)
            }}
          />
        </details>
      ) : null}
      {providerOutputBaseline ? (
        <details
          data-ui="inline-editor-tool-calls"
          open={providerOutputOpen || providerOutputBaseline.entries.length === 0}
          onToggle={(event) => {
            const open = event.currentTarget.open
            setProviderOutputOpen(open)
            if (open) setProviderOutput((current) => current ?? [...providerOutputBaseline.entries])
          }}
        >
          <summary>
            Tool calls ({providerOutput?.length ?? providerOutputBaseline.entries.length})
          </summary>
          {providerOutput !== null ? (
            <>
              <div data-ui="inline-editor-tool-call-list">
                {providerOutput.map((entry, index) => (
                  <ProviderOutputEditorRow
                    key={entry.editorId}
                    entry={entry}
                    ownerLabel={reasoningOwnerLabel(entry.owner, providerOutputBaseline.owners)}
                    showOwner={providerOutputBaseline.owners.length > 1}
                    busy={busy}
                    onChange={(next) =>
                      setProviderOutput(
                        (current) =>
                          current?.map((candidate, candidateIndex) =>
                            candidateIndex === index ? next : candidate,
                          ) ?? null,
                      )
                    }
                    onDelete={() =>
                      setProviderOutput(
                        (current) =>
                          current?.filter((_, candidateIndex) => candidateIndex !== index) ?? null,
                      )
                    }
                    onCommit={handleKey}
                  />
                ))}
              </div>
              <AddProviderOutputEntry
                entries={providerOutput}
                owners={providerOutputBaseline.owners}
                busy={busy}
                onAdd={(owner, outputIndex) => {
                  const editorId = `new:${newId()}`
                  setProviderOutput((current) => [
                    ...(current ?? []),
                    {
                      editorId,
                      owner,
                      item: {
                        dialect: 'unknown',
                        type: 'manual_tool_call',
                        outputIndex,
                        item: {},
                      },
                    },
                  ])
                }}
              />
              <p data-ui="inline-editor-tool-call-note">
                Provider authentication and encrypted fields are preserved when raw data is edited.
              </p>
            </>
          ) : null}
        </details>
      ) : null}
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

function ReasoningEditorRow({
  entry,
  ownerLabel,
  showOwner,
  busy,
  onChange,
  onDelete,
  onCommit,
}: {
  entry: ReasoningAuthoringEntry
  ownerLabel: string
  showOwner: boolean
  busy: boolean
  onChange: (entry: ReasoningAuthoringEntry) => void
  onDelete: () => void
  onCommit: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  const hidden =
    entry.kind === 'visible' ? entry.part.hidden === true : entry.carrier.hidden === true
  const setHidden = (nextHidden: boolean) => {
    if (entry.kind === 'visible') {
      const { hidden: _hidden, ...part } = entry.part
      onChange({
        ...entry,
        part: nextHidden ? { ...part, hidden: true } : part,
      })
      return
    }
    const { hidden: _hidden, ...carrier } = entry.carrier
    onChange({
      ...entry,
      carrier: nextHidden ? { ...carrier, hidden: true } : carrier,
    })
  }
  const label =
    entry.kind === 'visible'
      ? entry.part.kind === 'summary'
        ? 'Summary'
        : 'Plaintext'
      : carrierLabel(entry.carrier.kind)

  return (
    <div
      data-ui="inline-editor-reasoning-row"
      data-kind={entry.kind === 'visible' ? entry.part.kind : 'encrypted'}
      data-hidden={hidden ? 'true' : undefined}
    >
      <div data-ui="inline-editor-reasoning-row-header">
        <div data-ui="inline-editor-reasoning-row-identity">
          {entry.kind === 'visible' ? (
            <select
              data-ui="inline-editor-reasoning-row-kind"
              value={entry.part.kind}
              onChange={(event) =>
                onChange({
                  ...entry,
                  part: { ...entry.part, kind: event.currentTarget.value as 'text' | 'summary' },
                })
              }
              disabled={busy}
              aria-label="Reasoning block type"
            >
              <option value="text">Plaintext</option>
              <option value="summary">Summary</option>
            </select>
          ) : (
            <span data-ui="inline-editor-reasoning-label">{label}</span>
          )}
          {showOwner ? <span data-ui="inline-editor-reasoning-owner">{ownerLabel}</span> : null}
        </div>
        <div data-ui="inline-editor-reasoning-row-actions">
          <Button
            type="button"
            appearance="ghost"
            size="xs"
            onClick={() => setHidden(!hidden)}
            disabled={busy}
            aria-label={hidden ? 'Unhide reasoning block' : 'Hide reasoning block'}
            title={
              hidden
                ? 'Hidden — preserved on disk and skipped on replay. Click to unhide.'
                : 'Hide this block without deleting it.'
            }
          >
            {hidden ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
          </Button>
          <Button
            type="button"
            appearance="ghost"
            size="xs"
            tone="danger"
            onClick={onDelete}
            disabled={busy}
            aria-label={`Delete ${label.toLowerCase()} reasoning block`}
            title="Delete this reasoning block"
          >
            <TrashIcon size={13} />
          </Button>
        </div>
      </div>
      {entry.kind === 'visible' ? (
        <textarea
          data-ui="inline-editor-reasoning-input"
          value={entry.part.text}
          onChange={(event) =>
            onChange({ ...entry, part: { ...entry.part, text: event.currentTarget.value } })
          }
          onKeyDown={onCommit}
          rows={4}
          disabled={busy || hidden}
          aria-label={`Edit ${label.toLowerCase()} reasoning`}
        />
      ) : (
        <span data-ui="inline-editor-reasoning-readonly">
          {entry.payloadLength.toLocaleString()} characters · {entry.carrier.format} · payload
          read-only
        </span>
      )}
    </div>
  )
}

function ProviderOutputEditorRow({
  entry,
  ownerLabel,
  showOwner,
  busy,
  onChange,
  onDelete,
  onCommit,
}: {
  entry: ProviderOutputAuthoringEntry
  ownerLabel: string
  showOwner: boolean
  busy: boolean
  onChange: (entry: ProviderOutputAuthoringEntry) => void
  onDelete: () => void
  onCommit: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}) {
  const [typeText, setTypeText] = useState(entry.item.type)
  const [outputIndexText, setOutputIndexText] = useState(
    entry.item.outputIndex === undefined ? '' : String(entry.item.outputIndex),
  )
  const [rawText, setRawText] = useState(() => formatProviderOutputForEdit(entry.item.item))
  const hidden = entry.item.hidden === true
  const updateItem = (item: ProviderOutputAuthoringEntry['item']) => onChange({ ...entry, item })
  return (
    <div
      data-ui="inline-editor-tool-call-row"
      data-hidden={hidden ? 'true' : undefined}
      data-edited={entry.item.edited ? 'true' : undefined}
    >
      <div data-ui="inline-editor-reasoning-row-header">
        <div data-ui="inline-editor-reasoning-row-identity">
          <span data-ui="inline-editor-reasoning-label">
            {entry.item.type || 'Tool call'} · {entry.item.dialect}
          </span>
          {showOwner ? <span data-ui="inline-editor-reasoning-owner">{ownerLabel}</span> : null}
        </div>
        <div data-ui="inline-editor-reasoning-row-actions">
          <Button
            type="button"
            appearance="ghost"
            size="xs"
            onClick={() => {
              const { hidden: _hidden, ...shown } = entry.item
              updateItem(hidden ? shown : { ...shown, hidden: true })
            }}
            disabled={busy}
            aria-label={hidden ? 'Unhide tool call' : 'Hide tool call'}
            title={hidden ? 'Unhide this provider output.' : 'Hide this provider output.'}
          >
            {hidden ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
          </Button>
          <Button
            type="button"
            appearance="ghost"
            size="xs"
            tone="danger"
            onClick={onDelete}
            disabled={busy}
            aria-label="Delete tool call"
            title="Delete this provider output"
          >
            <TrashIcon size={13} />
          </Button>
        </div>
      </div>
      <div data-ui="inline-editor-tool-call-meta">
        <label>
          <span>Dialect</span>
          <select
            value={entry.item.dialect}
            onChange={(event) =>
              updateItem({
                ...entry.item,
                dialect: event.currentTarget.value as ProviderOutputDialect,
              })
            }
            disabled={busy || hidden}
            aria-label="Tool call dialect"
          >
            <option value="unknown">unknown</option>
            <option value="openai-responses">openai-responses</option>
            <option value="openrouter-responses">openrouter-responses</option>
            <option value="google-gemini">google-gemini</option>
            <option value="anthropic-claude">anthropic-claude</option>
          </select>
        </label>
        <label>
          <span>Type</span>
          <input
            value={typeText}
            onChange={(event) => {
              const next = event.currentTarget.value
              setTypeText(next)
              updateItem({ ...entry.item, type: next.trim() || 'manual_tool_call' })
            }}
            disabled={busy || hidden}
            aria-label="Tool call type"
          />
        </label>
        <label>
          <span>Index</span>
          <input
            value={outputIndexText}
            onChange={(event) => {
              const next = event.currentTarget.value
              setOutputIndexText(next)
              const outputIndex = parseProviderOutputIndex(next)
              const { outputIndex: _outputIndex, ...withoutIndex } = entry.item
              updateItem(
                outputIndex === undefined ? withoutIndex : { ...withoutIndex, outputIndex },
              )
            }}
            disabled={busy || hidden}
            inputMode="numeric"
            aria-label="Tool call output index"
          />
        </label>
      </div>
      <textarea
        data-ui="inline-editor-tool-call-input"
        value={rawText}
        onChange={(event) => {
          const next = event.currentTarget.value
          setRawText(next)
          updateItem({ ...entry.item, item: parseProviderOutputFromEdit(next) })
        }}
        onKeyDown={onCommit}
        rows={5}
        disabled={busy || hidden}
        aria-label="Edit tool call JSON or text"
      />
    </div>
  )
}

function AddProviderOutputEntry({
  entries,
  owners,
  busy,
  onAdd,
}: {
  entries: readonly ProviderOutputAuthoringEntry[]
  owners: readonly MessageAttemptOwner[]
  busy: boolean
  onAdd: (owner: MessageAttemptOwner, outputIndex: number) => void
}) {
  const [ownerIndex, setOwnerIndex] = useState(0)
  const owner = owners[ownerIndex] ?? owners[0]
  if (!owner) throw new Error('ProviderOutputAuthoringOwnerMissing')
  return (
    <div data-ui="inline-editor-tool-call-add">
      {owners.length > 1 ? (
        <select
          value={ownerIndex}
          onChange={(event) => setOwnerIndex(Number(event.currentTarget.value))}
          disabled={busy}
          aria-label="New tool call owner"
        >
          {owners.map((candidate, index) => (
            <option key={reasoningOwnerKey(candidate)} value={index}>
              {reasoningOwnerLabel(candidate, owners)}
            </option>
          ))}
        </select>
      ) : null}
      <Button
        type="button"
        data-ui="inline-editor-tool-call-add-button"
        appearance="surface"
        size="sm"
        onClick={() => onAdd(owner, nextProviderOutputIndex(entries, owner))}
        disabled={busy}
      >
        Add tool call
      </Button>
    </div>
  )
}

function nextProviderOutputIndex(
  entries: readonly ProviderOutputAuthoringEntry[],
  owner: MessageAttemptOwner,
): number {
  let largest = -1
  for (const entry of entries) {
    if (
      reasoningOwnerKey(entry.owner) === reasoningOwnerKey(owner) &&
      entry.item.outputIndex !== undefined
    ) {
      largest = Math.max(largest, entry.item.outputIndex)
    }
  }
  return largest + 1
}

function formatProviderOutputForEdit(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function parseProviderOutputFromEdit(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  try {
    return JSON.parse(trimmed)
  } catch {
    return raw
  }
}

function parseProviderOutputIndex(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function AddReasoningEntry({
  owners,
  busy,
  onAdd,
}: {
  owners: readonly MessageAttemptOwner[]
  busy: boolean
  onAdd: (kind: 'text' | 'summary', owner: MessageAttemptOwner) => void
}) {
  const [kind, setKind] = useState<'text' | 'summary'>('text')
  const [ownerIndex, setOwnerIndex] = useState(0)
  const owner = owners[ownerIndex] ?? owners[0]
  if (!owner) throw new Error('ReasoningAuthoringOwnerMissing')
  return (
    <div data-ui="inline-editor-reasoning-add">
      <select
        data-ui="inline-editor-reasoning-kind"
        value={kind}
        onChange={(event) => setKind(event.currentTarget.value as 'text' | 'summary')}
        disabled={busy}
        aria-label="New reasoning block type"
      >
        <option value="text">Plaintext</option>
        <option value="summary">Summary</option>
      </select>
      {owners.length > 1 ? (
        <select
          data-ui="inline-editor-reasoning-owner"
          value={ownerIndex}
          onChange={(event) => setOwnerIndex(Number(event.currentTarget.value))}
          disabled={busy}
          aria-label="New reasoning block owner"
        >
          {owners.map((candidate, index) => (
            <option key={reasoningOwnerKey(candidate)} value={index}>
              {reasoningOwnerLabel(candidate, owners)}
            </option>
          ))}
        </select>
      ) : null}
      <Button
        type="button"
        data-ui="inline-editor-reasoning-add-button"
        appearance="surface"
        size="sm"
        onClick={() => onAdd(kind, owner)}
        disabled={busy}
      >
        Add reasoning block
      </Button>
    </div>
  )
}

function reasoningOwnerKey(owner: MessageAttemptOwner): string {
  return owner.kind === 'generation' ? 'generation' : `continuation:${owner.streamId}`
}

function reasoningOwnerLabel(
  owner: MessageAttemptOwner,
  owners: readonly MessageAttemptOwner[],
): string {
  if (owner.kind === 'generation') return 'Original response'
  const continuationIndex = owners.findIndex(
    (candidate) => candidate.kind === 'continuation' && candidate.streamId === owner.streamId,
  )
  return `Continuation ${Math.max(1, continuationIndex)}`
}

function carrierLabel(kind: string): string {
  if (kind === 'responses-encrypted') return 'Encrypted'
  if (kind === 'anthropic-signature' || kind === 'gemini-thought-signature') {
    return 'Authentication'
  }
  if (kind === 'anthropic-redacted') return 'Redacted'
  return 'Opaque'
}
