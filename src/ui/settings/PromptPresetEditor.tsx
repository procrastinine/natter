// Four parallel prompt editors: system / append / continue-system /
// continue-user.
//
// Each component owns its own chat-settings slot. They share a thin state
// hook (`usePromptSlot`) for the draft/save/preset-action plumbing — the
// editors themselves stay flat so readers can see exactly which fields each
// slot touches. Typing saves just the text and clears the pin ("save to this
// chat only" is the default); the preset picker offers load / overwrite /
// save-as-new / rename / delete.
//
// Pin semantics, storage layout: see `plan/02-data-model.md §2.6b` and
// `src/store/prompt-presets.ts`. UI spec: `plan/10-ui.md §10.9`.

import { useLiveQuery } from 'dexie-react-hooks'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { estimateTokensByTokenizer } from '../../core/tokens'
import type { Chat, ChatSettings, PromptPreset, PromptPresetKind } from '../../core/types'
import { updateChatSettings } from '../../store/chats'
import {
  bumpPromptPresetLastUsedAt,
  createPromptPreset,
  deletePromptPreset,
  listPromptPresets,
  updatePromptPreset,
} from '../../store/prompt-presets'
import { useToastStore } from '../../store/zustand/toastStore'
import { InfoDisclosure } from './InfoDisclosure'

const SAVE_DEBOUNCE_MS = 300

interface Slot<K extends PromptPresetKind> {
  kind: K
  textKey: keyof ChatSettings
  pinKey: keyof ChatSettings
}

interface SlotState {
  draft: string
  setDraft: (v: string) => void
  pinnedPreset: PromptPreset | null
  presets: readonly PromptPreset[]
  tokens: number
  toastVisible: boolean
  pickerOpen: boolean
  setPickerOpen: (v: boolean) => void
  loadPreset: (id: string) => Promise<void>
  saveToExisting: (id: string, presetName: string) => Promise<void>
  saveAsNew: (promptTitle: string) => Promise<void>
  renamePreset: (id: string, currentName: string) => Promise<void>
  deletePresetWithConfirm: (id: string, name: string) => Promise<void>
}

interface UsePromptSlotOpts {
  showTokens: boolean
  // When set, a one-off toast fires the first time the user commits a local
  // edit in this browser session. Keyed in sessionStorage by this string.
  firstEditToastKey?: string
}

function usePromptSlot(
  chat: Chat,
  slot: Slot<PromptPresetKind>,
  opts: UsePromptSlotOpts,
): SlotState {
  const storedText = (chat.settings[slot.textKey] as string | undefined) ?? ''
  const pinnedId = chat.settings[slot.pinKey] as string | undefined

  const [draft, setDraft] = useState(storedText)
  const lastPersistedRef = useRef(storedText)
  const lastChatIdRef = useRef(chat.id)
  const [estimateText, setEstimateText] = useState(storedText)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [toastVisible, setToastVisible] = useState(false)

  const presets = useLiveQuery(
    () => listPromptPresets(slot.kind),
    [slot.kind],
    [] as PromptPreset[],
  )
  const pushToast = useToastStore((s) => s.push)

  // Resync draft from storage on chat-switch OR when an external write
  // (preset propagation, other tab) changed the stored value.
  useEffect(() => {
    if (lastChatIdRef.current !== chat.id) {
      lastChatIdRef.current = chat.id
      lastPersistedRef.current = storedText
      setDraft(storedText)
      setEstimateText(storedText)
      return
    }
    if (storedText !== lastPersistedRef.current) {
      lastPersistedRef.current = storedText
      setDraft(storedText)
      setEstimateText(storedText)
    }
  }, [chat.id, storedText])

  useEffect(() => {
    if (!opts.showTokens) return
    const id = window.setTimeout(() => setEstimateText(draft), 120)
    return () => window.clearTimeout(id)
  }, [draft, opts.showTokens])

  // Debounced local save clears the pin: editing the text is the default
  // "save to this chat only" action per the user spec.
  useEffect(() => {
    if (draft === lastPersistedRef.current) return
    const id = window.setTimeout(async () => {
      lastPersistedRef.current = draft
      const saved = await updateChatSettings(chat.id, {
        [slot.textKey]: draft,
        [slot.pinKey]: undefined,
      } as Parameters<typeof updateChatSettings>[1])
      if (saved && opts.firstEditToastKey && typeof window !== 'undefined') {
        if (!window.sessionStorage.getItem(opts.firstEditToastKey)) {
          window.sessionStorage.setItem(opts.firstEditToastKey, '1')
          setToastVisible(true)
          window.setTimeout(() => setToastVisible(false), 4000)
        }
      }
    }, SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [draft, chat.id, slot.textKey, slot.pinKey, opts.firstEditToastKey])

  const pinnedPreset = useMemo(
    () => (pinnedId ? (presets.find((p) => p.id === pinnedId) ?? null) : null),
    [pinnedId, presets],
  )

  const tokens = useMemo(
    () => (opts.showTokens ? estimateTokensByTokenizer(estimateText, null) : 0),
    [estimateText, opts.showTokens],
  )

  const flushDraftBeforeAction = useCallback(async () => {
    if (draft === lastPersistedRef.current) return
    lastPersistedRef.current = draft
    await updateChatSettings(chat.id, {
      [slot.textKey]: draft,
      [slot.pinKey]: undefined,
    } as Parameters<typeof updateChatSettings>[1])
  }, [chat.id, draft, slot.pinKey, slot.textKey])

  const loadPreset = useCallback(
    async (targetId: string) => {
      const target = presets.find((p) => p.id === targetId)
      if (!target) return
      lastPersistedRef.current = target.text
      setDraft(target.text)
      setEstimateText(target.text)
      await updateChatSettings(chat.id, {
        [slot.textKey]: target.text,
        [slot.pinKey]: target.id,
      } as Parameters<typeof updateChatSettings>[1])
      await bumpPromptPresetLastUsedAt(target.id)
      setPickerOpen(false)
    },
    [chat.id, presets, slot.pinKey, slot.textKey],
  )

  const saveToExisting = useCallback(
    async (targetId: string, presetName: string) => {
      await flushDraftBeforeAction()
      await updatePromptPreset(targetId, { text: draft })
      await updateChatSettings(chat.id, {
        [slot.pinKey]: targetId,
      } as Parameters<typeof updateChatSettings>[1])
      pushToast({
        level: 'info',
        text: `Saved to "${presetName}".`,
        durationMs: 2500,
      })
      setPickerOpen(false)
    },
    [chat.id, draft, flushDraftBeforeAction, pushToast, slot.pinKey],
  )

  const saveAsNew = useCallback(
    async (promptTitle: string) => {
      await flushDraftBeforeAction()
      const name = window.prompt(`Name for new ${promptTitle.toLowerCase()} preset:`)
      if (!name?.trim()) return
      const created = await createPromptPreset({
        kind: slot.kind,
        name: name.trim(),
        text: draft,
        lastUsedAt: Date.now(),
      })
      await updateChatSettings(chat.id, {
        [slot.pinKey]: created.id,
      } as Parameters<typeof updateChatSettings>[1])
      pushToast({
        level: 'info',
        text: `Created preset "${created.name}".`,
        durationMs: 2500,
      })
      setPickerOpen(false)
    },
    [chat.id, draft, flushDraftBeforeAction, pushToast, slot.kind, slot.pinKey],
  )

  const renamePreset = useCallback(
    async (targetId: string, currentName: string) => {
      const name = window.prompt('Rename preset:', currentName)
      if (!name?.trim() || name === currentName) return
      await updatePromptPreset(targetId, { name: name.trim() })
    },
    [],
  )

  const deletePresetWithConfirm = useCallback(
    async (targetId: string, name: string) => {
      if (
        !window.confirm(
          `Delete preset "${name}"? Chats pinned to it keep their current text.`,
        )
      ) {
        return
      }
      await deletePromptPreset(targetId)
    },
    [],
  )

  return {
    draft,
    setDraft,
    pinnedPreset,
    presets,
    tokens,
    toastVisible,
    pickerOpen,
    setPickerOpen,
    loadPreset,
    saveToExisting,
    saveAsNew,
    renamePreset,
    deletePresetWithConfirm,
  }
}

// ---------------------------------------------------------------------------
// System prompt — the per-chat instructions the model sees first.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_TOAST_KEY = 'natter:system-prompt-toast-shown'

export function SystemPromptEditor({
  chat,
  defaultCollapsed = false,
}: {
  chat: Chat
  defaultCollapsed?: boolean
}) {
  const slot: Slot<'system'> = {
    kind: 'system',
    textKey: 'systemPrompt',
    pinKey: 'systemPromptPresetId',
  }
  const s = usePromptSlot(chat, slot, {
    showTokens: true,
    firstEditToastKey: SYSTEM_PROMPT_TOAST_KEY,
  })
  const [expanded, setExpanded] = useState(!defaultCollapsed)
  return (
    <section
      data-ui="settings-section"
      data-ui-section="prompt-slot-system"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div data-ui="prompt-slot-header">
        <div data-ui="prompt-slot-title-group">
          <button
            type="button"
            data-ui="prompt-slot-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronIcon expanded={expanded} />
            <h3>System prompt</h3>
          </button>
          <InfoDisclosure title="System prompt">
            Sent ahead of every turn as the chat's system message. Empty = no system message.
          </InfoDisclosure>
        </div>
        {expanded ? (
          <PromptPresetPicker
            open={s.pickerOpen}
            setOpen={s.setPickerOpen}
            pinnedPreset={s.pinnedPreset}
            presets={s.presets}
            onLoad={(id) => void s.loadPreset(id)}
            onSaveToExisting={(id, name) => void s.saveToExisting(id, name)}
            onSaveAsNew={() => void s.saveAsNew('system prompt')}
            onRename={(id, name) => void s.renamePreset(id, name)}
            onDelete={(id, name) => void s.deletePresetWithConfirm(id, name)}
          />
        ) : null}
      </div>
      {expanded ? (
        <>
          {s.toastVisible ? (
            <div data-ui="settings-toast" role="status">
              System prompt updated, it takes effect on the next send. Earlier responses used
              the previous prompt.
            </div>
          ) : null}
          <div data-ui="field-group">
            <label htmlFor="system-prompt-textarea" data-ui="visually-hidden">
              System prompt
            </label>
            <textarea
              id="system-prompt-textarea"
              data-ui="system-prompt-textarea"
              value={s.draft}
              onChange={(e) => s.setDraft(e.target.value)}
              rows={8}
              spellCheck
            />
            <span data-ui="system-prompt-token-estimate" aria-live="polite">
              ~{s.tokens.toLocaleString()} tokens
            </span>
          </div>
        </>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Append prompt — silently glued onto the LAST user message at send time
// and stripped from history. During non-prefill continue the planner skips
// the synthetic continueUser wrapper so the append rides on the previous
// real user turn instead. Whitespace is preserved verbatim.
// ---------------------------------------------------------------------------

export function AppendPromptEditor({
  chat,
  defaultCollapsed = false,
}: {
  chat: Chat
  defaultCollapsed?: boolean
}) {
  const slot: Slot<'append'> = {
    kind: 'append',
    textKey: 'appendPrompt',
    pinKey: 'appendPromptPresetId',
  }
  const s = usePromptSlot(chat, slot, { showTokens: true })
  const [expanded, setExpanded] = useState(!defaultCollapsed)
  return (
    <section
      data-ui="settings-section"
      data-ui-section="prompt-slot-append"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div data-ui="prompt-slot-header">
        <div data-ui="prompt-slot-title-group">
          <button
            type="button"
            data-ui="prompt-slot-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronIcon expanded={expanded} />
            <h3>Append prompt</h3>
          </button>
          <InfoDisclosure title="Append prompt">
            Glued onto the last user message at send time and stripped from history. Leading
            whitespace is preserved.
          </InfoDisclosure>
        </div>
        {expanded ? (
          <PromptPresetPicker
            open={s.pickerOpen}
            setOpen={s.setPickerOpen}
            pinnedPreset={s.pinnedPreset}
            presets={s.presets}
            onLoad={(id) => void s.loadPreset(id)}
            onSaveToExisting={(id, name) => void s.saveToExisting(id, name)}
            onSaveAsNew={() => void s.saveAsNew('append prompt')}
            onRename={(id, name) => void s.renamePreset(id, name)}
            onDelete={(id, name) => void s.deletePresetWithConfirm(id, name)}
          />
        ) : null}
      </div>
      {expanded ? (
        <div data-ui="field-group">
          <label htmlFor="append-prompt-textarea" data-ui="visually-hidden">
            Append prompt
          </label>
          <textarea
            id="append-prompt-textarea"
            data-ui="append-prompt-textarea"
            value={s.draft}
            onChange={(e) => s.setDraft(e.target.value)}
            rows={4}
            spellCheck
          />
          <span data-ui="append-prompt-token-estimate" aria-live="polite">
            ~{s.tokens.toLocaleString()} tokens
          </span>
        </div>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Default prefill — text seeded into the prefill box when the user opens
// prefill on this chat. Lives in ParamForm's "Prefill" section because the
// continue-prefill toggle and recommendation widget render alongside it; the
// `children` slot is where ParamForm injects those.
// ---------------------------------------------------------------------------

export function PrefillPromptEditor({
  chat,
  defaultCollapsed = false,
  children,
}: {
  chat: Chat
  defaultCollapsed?: boolean
  children?: ReactNode
}) {
  const slot: Slot<'prefill'> = {
    kind: 'prefill',
    textKey: 'defaultPrefill',
    pinKey: 'defaultPrefillPresetId',
  }
  const s = usePromptSlot(chat, slot, { showTokens: false })
  const [expanded, setExpanded] = useState(!defaultCollapsed)
  return (
    <section
      data-ui="settings-section"
      data-ui-section="prefill"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div data-ui="prompt-slot-header">
        <div data-ui="prompt-slot-title-group">
          <button
            type="button"
            data-ui="prompt-slot-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronIcon expanded={expanded} />
            <h3>Prefill</h3>
          </button>
          <InfoDisclosure title="Prefill">
            Seeds the prefill box when prefill opens on this chat. The Continue-prefill toggle
            below sends the existing assistant message as a real prefill turn during Continue,
            instead of the continue-prompt template.
          </InfoDisclosure>
        </div>
        {expanded ? (
          <PromptPresetPicker
            open={s.pickerOpen}
            setOpen={s.setPickerOpen}
            pinnedPreset={s.pinnedPreset}
            presets={s.presets}
            onLoad={(id) => void s.loadPreset(id)}
            onSaveToExisting={(id, name) => void s.saveToExisting(id, name)}
            onSaveAsNew={() => void s.saveAsNew('default prefill')}
            onRename={(id, name) => void s.renamePreset(id, name)}
            onDelete={(id, name) => void s.deletePresetWithConfirm(id, name)}
          />
        ) : null}
      </div>
      {expanded ? (
        <>
          <div data-ui="field-group">
            <label htmlFor="default-prefill-textarea" data-ui="visually-hidden">
              Default prefill text
            </label>
            <textarea
              id="default-prefill-textarea"
              data-ui="default-prefill-textarea"
              value={s.draft}
              onChange={(e) => s.setDraft(e.target.value)}
              placeholder='Default text seeded into the prefill box. Example: "Chapter 1: The"'
              rows={3}
              spellCheck
            />
          </div>
          {children}
        </>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Continue system prompt — injected in place of the chat system prompt
// during Continue-in-place. `[SYSTEM_PROMPT]` expands to the chat's own
// system prompt verbatim.
// ---------------------------------------------------------------------------

export function ContinueSystemPromptEditor({
  chat,
  defaultCollapsed = false,
}: {
  chat: Chat
  defaultCollapsed?: boolean
}) {
  const slot: Slot<'continue-system'> = {
    kind: 'continue-system',
    textKey: 'continueSystemPrompt',
    pinKey: 'continueSystemPromptPresetId',
  }
  const s = usePromptSlot(chat, slot, { showTokens: false })
  const [expanded, setExpanded] = useState(!defaultCollapsed)
  return (
    <section
      data-ui="settings-section"
      data-ui-section="prompt-slot-continue-system"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div data-ui="prompt-slot-header">
        <div data-ui="prompt-slot-title-group">
          <button
            type="button"
            data-ui="prompt-slot-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronIcon expanded={expanded} />
            <h3>Continue system prompt</h3>
          </button>
          <InfoDisclosure title="Continue system prompt">
            Used by Continue-in-place. [SYSTEM_PROMPT] expands to this chat's system prompt;
            blank sends none.
          </InfoDisclosure>
        </div>
        {expanded ? (
          <PromptPresetPicker
            open={s.pickerOpen}
            setOpen={s.setPickerOpen}
            pinnedPreset={s.pinnedPreset}
            presets={s.presets}
            onLoad={(id) => void s.loadPreset(id)}
            onSaveToExisting={(id, name) => void s.saveToExisting(id, name)}
            onSaveAsNew={() => void s.saveAsNew('continue system prompt')}
            onRename={(id, name) => void s.renamePreset(id, name)}
            onDelete={(id, name) => void s.deletePresetWithConfirm(id, name)}
          />
        ) : null}
      </div>
      {expanded ? (
        <div data-ui="field-group">
          <label htmlFor="continue-system-prompt-textarea" data-ui="visually-hidden">
            Continue system prompt
          </label>
          <textarea
            id="continue-system-prompt-textarea"
            data-ui="continue-system-prompt-textarea"
            value={s.draft}
            onChange={(e) => s.setDraft(e.target.value)}
            rows={4}
            spellCheck
          />
        </div>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Continue user prompt — appended as a synthetic trailing user turn during
// Continue-in-place. Non-empty avoids the double-assistant shape.
// ---------------------------------------------------------------------------

export function ContinueUserPromptEditor({
  chat,
  defaultCollapsed = false,
}: {
  chat: Chat
  defaultCollapsed?: boolean
}) {
  const slot: Slot<'continue-user'> = {
    kind: 'continue-user',
    textKey: 'continueUserPrompt',
    pinKey: 'continueUserPromptPresetId',
  }
  const s = usePromptSlot(chat, slot, { showTokens: false })
  const [expanded, setExpanded] = useState(!defaultCollapsed)
  return (
    <section
      data-ui="settings-section"
      data-ui-section="prompt-slot-continue-user"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div data-ui="prompt-slot-header">
        <div data-ui="prompt-slot-title-group">
          <button
            type="button"
            data-ui="prompt-slot-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronIcon expanded={expanded} />
            <h3>Continue user prompt</h3>
          </button>
          <InfoDisclosure title="Continue user prompt">
            Synthetic trailing user message appended during Continue-in-place. Blank falls back
            to the legacy double-assistant shape.
          </InfoDisclosure>
        </div>
        {expanded ? (
          <PromptPresetPicker
            open={s.pickerOpen}
            setOpen={s.setPickerOpen}
            pinnedPreset={s.pinnedPreset}
            presets={s.presets}
            onLoad={(id) => void s.loadPreset(id)}
            onSaveToExisting={(id, name) => void s.saveToExisting(id, name)}
            onSaveAsNew={() => void s.saveAsNew('continue user prompt')}
            onRename={(id, name) => void s.renamePreset(id, name)}
            onDelete={(id, name) => void s.deletePresetWithConfirm(id, name)}
          />
        ) : null}
      </div>
      {expanded ? (
        <div data-ui="field-group">
          <label htmlFor="continue-user-prompt-textarea" data-ui="visually-hidden">
            Continue user prompt
          </label>
          <textarea
            id="continue-user-prompt-textarea"
            data-ui="continue-user-prompt-textarea"
            value={s.draft}
            onChange={(e) => s.setDraft(e.target.value)}
            rows={3}
            spellCheck
          />
        </div>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Picker UI — a compact dropdown reused by all three editors.
// ---------------------------------------------------------------------------

interface PickerProps {
  open: boolean
  setOpen: (v: boolean) => void
  pinnedPreset: PromptPreset | null
  presets: readonly PromptPreset[]
  onLoad: (id: string) => void
  onSaveToExisting: (id: string, name: string) => void
  onSaveAsNew: () => void
  onRename: (id: string, currentName: string) => void
  onDelete: (id: string, name: string) => void
}

function PromptPresetPicker({
  open,
  setOpen,
  pinnedPreset,
  presets,
  onLoad,
  onSaveToExisting,
  onSaveAsNew,
  onRename,
  onDelete,
}: PickerProps) {
  return (
    <div data-ui="prompt-preset-picker">
      <button
        type="button"
        data-ui="prompt-preset-picker-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>
          Preset: <strong>{pinnedPreset ? pinnedPreset.name : 'none'}</strong>
        </span>
        <span data-ui="prompt-preset-picker-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div data-ui="prompt-preset-picker-menu" role="menu">
          {presets.length === 0 ? (
            <p data-ui="helper">No presets of this kind yet.</p>
          ) : (
            <ul>
              {presets.map((p) => {
                const isCurrent = pinnedPreset?.id === p.id
                return (
                  <li key={p.id} data-current={isCurrent ? 'true' : undefined}>
                    <button
                      type="button"
                      data-ui="preset-menu-load"
                      onClick={() => onLoad(p.id)}
                      title={isCurrent ? 'Already loaded' : 'Load preset'}
                    >
                      {isCurrent ? '●' : '○'} {p.name}
                    </button>
                    <div data-ui="preset-menu-actions">
                      <button
                        type="button"
                        data-ui="field-inline-action"
                        onClick={() => onSaveToExisting(p.id, p.name)}
                        title={`Overwrite "${p.name}" with the current text`}
                      >
                        save
                      </button>
                      <button
                        type="button"
                        data-ui="field-inline-action"
                        onClick={() => onRename(p.id, p.name)}
                        title="Rename"
                      >
                        rename
                      </button>
                      <button
                        type="button"
                        data-ui="icon-button"
                        data-compact
                        data-tone="danger"
                        onClick={() => onDelete(p.id, p.name)}
                        title="Delete preset"
                        aria-label="Delete preset"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          <div data-ui="preset-menu-footer">
            <button type="button" data-ui="field-inline-action" onClick={() => onSaveAsNew()}>
              + Save as new…
            </button>
            <button
              type="button"
              data-ui="icon-button"
              data-compact
              onClick={() => setOpen(false)}
              aria-label="Close"
              title="Close"
            >
              <CloseGlyph />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      data-ui="prompt-slot-chevron"
      data-expanded={expanded ? 'true' : 'false'}
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
      width="10"
      height="10"
    >
      <path
        d="M4 2.5L8 6l-4 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="13" height="13">
      <path
        d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.5a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.5M6.8 7v4M9.2 7v4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="13" height="13">
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
