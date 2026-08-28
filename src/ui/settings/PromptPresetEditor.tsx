// Four parallel prompt editors: system / append / continue-system /
// continue-user.
//
// Each component owns its own chat-settings slot. They share a thin state
// hook (`usePromptSlot`) for the draft/save/preset-action plumbing — the
// editors themselves stay flat so readers can see exactly which fields each
// slot touches. Typing saves just the text and clears the pin ("save to this
// chat only" is the default); the preset picker offers load / overwrite /
// save-as-new / rename / delete.
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  requestPresentationConfirmation,
  requestPresentationText,
} from '../../app/presentation-dialog'
import { claimPresentationForegroundDemand } from '../../app/router'
import { estimateTokensByTokenizer } from '../../core/tokens'
import type { Chat, ChatSettings, PromptPresetKind } from '../../core/types'
import { usePromptPresetCatalog } from '../../hooks/useConfigurationCatalog'
import { useSettledConfigurationEdit } from '../../hooks/useSettledConfigurationEdit'
import { configurationApplication } from '../../store/configuration-application'
import {
  configurationController,
  currentActiveConfigurationSelection,
} from '../../store/configuration-controller'
import type {
  ConfigurationPromptPresetCatalogRow,
  WorkspacePresentationForegroundDemand,
} from '../../store/presentation-contracts'
import { useToastStore } from '../../store/zustand/toastStore'
import { Button, IconButton } from '../primitives/Button'
import { InfoDisclosure } from './InfoDisclosure'

const SAVE_DEBOUNCE_MS = 300
const EMPTY_PROMPT_PRESET_ROWS: readonly ConfigurationPromptPresetCatalogRow[] = Object.freeze([])
const EMPTY_PROMPT_PRESET_IDS: readonly string[] = Object.freeze([])

interface Slot<K extends PromptPresetKind> {
  kind: K
  textKey: keyof ChatSettings
  pinKey: keyof ChatSettings
}

interface SlotState {
  draft: string
  setDraft: (v: string) => void
  pinnedPreset: ConfigurationPromptPresetCatalogRow | null
  presets: readonly ConfigurationPromptPresetCatalogRow[]
  presetsLoading: boolean
  presetsHavePrevious: boolean
  presetsHaveMore: boolean
  loadPreviousPresets: () => void
  loadMorePresets: () => void
  tokens: number
  pickerOpen: boolean
  setPickerOpen: (v: boolean) => void
  beginDraftEdit: () => void
  finishDraftEdit: () => void
  flushDraft: () => Promise<void>
  loadPreset: (id: string) => Promise<void>
  saveToExisting: (id: string, presetName: string) => Promise<void>
  saveAsNew: (promptTitle: string) => Promise<void>
  renamePreset: (id: string, currentName: string) => Promise<void>
  deletePresetWithConfirm: (id: string, name: string) => Promise<void>
}

interface UsePromptSlotOpts {
  showTokens: boolean
}

function usePromptSlot(
  chat: Chat,
  slot: Slot<PromptPresetKind>,
  opts: UsePromptSlotOpts,
): SlotState {
  const { kind } = slot
  const storedText = (chat.settings[slot.textKey] as string | undefined) ?? ''
  const pinnedId = chat.settings[slot.pinKey] as string | undefined

  const [estimateText, setEstimateText] = useState(storedText)
  const [pickerOpen, setPickerOpen] = useState(false)

  const configuration = useSyncExternalStore(
    configurationController.subscribe,
    configurationController.getSnapshot,
    configurationController.getSnapshot,
  )
  const addressedPresetIds = useMemo(
    () => (pinnedId ? [pinnedId] : EMPTY_PROMPT_PRESET_IDS),
    [pinnedId],
  )
  const presetCatalogResult = usePromptPresetCatalog(kind, pickerOpen, addressedPresetIds)
  const presetCatalog = presetCatalogResult.snapshot
  const presets = presetCatalog?.page.rows ?? EMPTY_PROMPT_PRESET_ROWS
  const presetsLoading = pickerOpen && presetCatalog?.interactive !== true
  const activeSelection = currentActiveConfigurationSelection(configuration.frame)
  const pinnedSummaries =
    activeSelection?.target.kind === 'chat' && activeSelection.target.chatId === chat.id
      ? activeSelection.value.promptPresets
      : EMPTY_PROMPT_PRESET_ROWS
  const pushToast = useToastStore((s) => s.push)

  const edit = useSettledConfigurationEdit({
    ownerChatId: chat.id,
    fieldKey: `prompt.${kind}`,
    storedValue: storedText,
    settleMs: SAVE_DEBOUNCE_MS,
    stage: (text) => configurationController.stagePromptField(chat.id, kind, text),
    async commit(text) {
      await configurationApplication.commitPromptText(chat.id, kind, text)
    },
  })
  const draft = edit.value

  useEffect(() => {
    if (!opts.showTokens) return
    const id = window.setTimeout(() => setEstimateText(draft), 120)
    return () => window.clearTimeout(id)
  }, [draft, opts.showTokens])

  const flushDraft = edit.flush
  const foregroundDemandRef = useRef<WorkspacePresentationForegroundDemand | null>(null)

  const beginDraftEdit = useCallback(() => {
    foregroundDemandRef.current ??= claimPresentationForegroundDemand()
  }, [])

  const releaseDraftEdit = useCallback(() => {
    const foregroundDemand = foregroundDemandRef.current
    foregroundDemandRef.current = null
    foregroundDemand?.release()
  }, [])

  useEffect(() => releaseDraftEdit, [releaseDraftEdit])

  const finishDraftEdit = useCallback(() => {
    const foregroundDemand = foregroundDemandRef.current
    foregroundDemandRef.current = null
    void flushDraft()
      .finally(() => foregroundDemand?.release())
      .catch(() => undefined)
  }, [flushDraft])

  const pinnedPreset = useMemo(
    () =>
      pinnedId
        ? (pinnedSummaries.find((preset) => preset.id === pinnedId) ??
          presetCatalog?.page.addressedRows.find((preset) => preset.id === pinnedId)?.row ??
          presets.find((preset) => preset.id === pinnedId) ??
          null)
        : null,
    [pinnedId, pinnedSummaries, presetCatalog?.page.addressedRows, presets],
  )

  const tokens = useMemo(
    () => (opts.showTokens ? estimateTokensByTokenizer(estimateText, null) : 0),
    [estimateText, opts.showTokens],
  )

  const flushDraftBeforeAction = useCallback(async () => {
    try {
      await flushDraft()
      return true
    } catch {
      return false
    }
  }, [flushDraft])

  const loadPreset = useCallback(
    async (targetId: string) => {
      if (!presets.some((preset) => preset.id === targetId)) return
      if (!(await flushDraftBeforeAction())) return
      try {
        const result = await configurationApplication.loadPromptPreset(chat.id, targetId)
        if (result.kind !== 'prompt-preset-saved' || !result.preset) return
        edit.acceptValue(result.preset.text)
        setEstimateText(result.preset.text)
        setPickerOpen(false)
      } catch {
        return
      }
    },
    [chat.id, edit, flushDraftBeforeAction, presets],
  )

  const saveToExisting = useCallback(
    async (targetId: string, presetName: string) => {
      if (!(await flushDraftBeforeAction())) return
      try {
        await configurationApplication.overwriteAndPinPromptPreset(chat.id, targetId, edit.value)
        pushToast({
          level: 'info',
          text: `Saved to "${presetName}".`,
          durationMs: 2500,
        })
        setPickerOpen(false)
      } catch {
        return
      }
    },
    [chat.id, edit.value, flushDraftBeforeAction, pushToast],
  )

  const saveAsNew = useCallback(
    async (promptTitle: string) => {
      if (!(await flushDraftBeforeAction())) return
      const name = await requestPresentationText({
        title: `New ${promptTitle.toLowerCase()} preset`,
        inputLabel: 'Preset name',
        confirmLabel: 'Save',
      })
      if (!name?.trim()) return
      try {
        const result = await configurationApplication.createAndPinPromptPreset({
          chatId: chat.id,
          kind,
          name: name.trim(),
          text: edit.value,
        })
        if (result.kind !== 'prompt-preset-saved') return
        const created = result.preset
        if (!created) return
        pushToast({
          level: 'info',
          text: `Created preset "${created.name}".`,
          durationMs: 2500,
        })
        setPickerOpen(false)
      } catch {
        return
      }
    },
    [chat.id, edit.value, flushDraftBeforeAction, kind, pushToast],
  )

  const renamePreset = useCallback(async (targetId: string, currentName: string) => {
    const name = await requestPresentationText({
      title: 'Rename preset',
      inputLabel: 'Preset name',
      initialValue: currentName,
      confirmLabel: 'Rename',
    })
    if (!name?.trim() || name === currentName) return
    try {
      await configurationApplication.renamePromptPreset(targetId, name.trim())
    } catch {
      return
    }
  }, [])

  const deletePresetWithConfirm = useCallback(async (targetId: string, name: string) => {
    if (
      !(await requestPresentationConfirmation({
        title: 'Delete preset?',
        message: `Delete preset "${name}"? Chats pinned to it keep their current text.`,
        confirmLabel: 'Delete',
        tone: 'danger',
      }))
    ) {
      return
    }
    try {
      await configurationApplication.deletePromptPreset(targetId)
    } catch {
      return
    }
  }, [])

  return {
    draft,
    setDraft: edit.setValue,
    pinnedPreset,
    presets,
    presetsLoading,
    presetsHavePrevious: Boolean(presetCatalog?.page.previousCursor),
    presetsHaveMore: Boolean(presetCatalog?.page.nextCursor),
    loadPreviousPresets: presetCatalogResult.demandBefore,
    loadMorePresets: presetCatalogResult.demandAfter,
    tokens,
    pickerOpen,
    setPickerOpen,
    beginDraftEdit,
    finishDraftEdit,
    flushDraft,
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
  const s = usePromptSlot(chat, slot, { showTokens: true })
  const [expanded, setExpanded] = useState(!defaultCollapsed)
  return (
    <section
      data-ui="settings-section"
      data-ui-section="prompt-slot-system"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div data-ui="prompt-slot-header">
        <div data-ui="prompt-slot-title-group">
          <Button
            type="button"
            data-ui="prompt-slot-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronIcon expanded={expanded} />
            <h3>System prompt</h3>
          </Button>
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
            loading={s.presetsLoading}
            hasPrevious={s.presetsHavePrevious}
            hasMore={s.presetsHaveMore}
            onLoadPrevious={s.loadPreviousPresets}
            onLoadMore={s.loadMorePresets}
            onLoad={(id) => void s.loadPreset(id)}
            onSaveToExisting={(id, name) => void s.saveToExisting(id, name)}
            onSaveAsNew={() => void s.saveAsNew('system prompt')}
            onRename={(id, name) => void s.renamePreset(id, name)}
            onDelete={(id, name) => void s.deletePresetWithConfirm(id, name)}
          />
        ) : null}
      </div>
      {expanded ? (
        <div data-ui="field-group">
          <label htmlFor="system-prompt-textarea" data-ui="visually-hidden">
            System prompt
          </label>
          <textarea
            id="system-prompt-textarea"
            data-ui="system-prompt-textarea"
            value={s.draft}
            onChange={(e) => s.setDraft(e.target.value)}
            onFocus={s.beginDraftEdit}
            onBlur={s.finishDraftEdit}
            rows={8}
            spellCheck
          />
          <span data-ui="system-prompt-token-estimate" aria-live="polite">
            ~{s.tokens.toLocaleString()} tokens
          </span>
        </div>
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
          <Button
            type="button"
            data-ui="prompt-slot-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronIcon expanded={expanded} />
            <h3>Append prompt</h3>
          </Button>
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
            loading={s.presetsLoading}
            hasPrevious={s.presetsHavePrevious}
            hasMore={s.presetsHaveMore}
            onLoadPrevious={s.loadPreviousPresets}
            onLoadMore={s.loadMorePresets}
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
            onFocus={s.beginDraftEdit}
            onBlur={s.finishDraftEdit}
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
          <Button
            type="button"
            data-ui="prompt-slot-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronIcon expanded={expanded} />
            <h3>Prefill</h3>
          </Button>
          <InfoDisclosure title="Prefill">
            Seeds the prefill box when prefill opens on this chat. The Continue-prefill toggle below
            sends the existing assistant message as a real prefill turn during Continue, instead of
            the continue-prompt template.
          </InfoDisclosure>
        </div>
        {expanded ? (
          <PromptPresetPicker
            open={s.pickerOpen}
            setOpen={s.setPickerOpen}
            pinnedPreset={s.pinnedPreset}
            presets={s.presets}
            loading={s.presetsLoading}
            hasPrevious={s.presetsHavePrevious}
            hasMore={s.presetsHaveMore}
            onLoadPrevious={s.loadPreviousPresets}
            onLoadMore={s.loadMorePresets}
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
              onFocus={s.beginDraftEdit}
              onBlur={s.finishDraftEdit}
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
          <Button
            type="button"
            data-ui="prompt-slot-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronIcon expanded={expanded} />
            <h3>Continue system prompt</h3>
          </Button>
          <InfoDisclosure title="Continue system prompt">
            Used by Continue-in-place. [SYSTEM_PROMPT] expands to this chat's system prompt; blank
            sends none.
          </InfoDisclosure>
        </div>
        {expanded ? (
          <PromptPresetPicker
            open={s.pickerOpen}
            setOpen={s.setPickerOpen}
            pinnedPreset={s.pinnedPreset}
            presets={s.presets}
            loading={s.presetsLoading}
            hasPrevious={s.presetsHavePrevious}
            hasMore={s.presetsHaveMore}
            onLoadPrevious={s.loadPreviousPresets}
            onLoadMore={s.loadMorePresets}
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
            onFocus={s.beginDraftEdit}
            onBlur={s.finishDraftEdit}
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
          <Button
            type="button"
            data-ui="prompt-slot-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronIcon expanded={expanded} />
            <h3>Continue user prompt</h3>
          </Button>
          <InfoDisclosure title="Continue user prompt">
            Synthetic trailing user message appended during Continue-in-place. Blank falls back to
            the legacy double-assistant shape.
          </InfoDisclosure>
        </div>
        {expanded ? (
          <PromptPresetPicker
            open={s.pickerOpen}
            setOpen={s.setPickerOpen}
            pinnedPreset={s.pinnedPreset}
            presets={s.presets}
            loading={s.presetsLoading}
            hasPrevious={s.presetsHavePrevious}
            hasMore={s.presetsHaveMore}
            onLoadPrevious={s.loadPreviousPresets}
            onLoadMore={s.loadMorePresets}
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
            onFocus={s.beginDraftEdit}
            onBlur={s.finishDraftEdit}
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
  pinnedPreset: ConfigurationPromptPresetCatalogRow | null
  presets: readonly ConfigurationPromptPresetCatalogRow[]
  loading: boolean
  hasPrevious: boolean
  hasMore: boolean
  onLoadPrevious: () => void
  onLoadMore: () => void
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
  loading,
  hasPrevious,
  hasMore,
  onLoadPrevious,
  onLoadMore,
  onLoad,
  onSaveToExisting,
  onSaveAsNew,
  onRename,
  onDelete,
}: PickerProps) {
  return (
    <div data-ui="prompt-preset-picker">
      <Button
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
      </Button>
      {open ? (
        <div data-ui="prompt-preset-picker-menu" role="menu">
          {presets.length === 0 ? (
            <p data-ui="helper">{loading ? 'Loading presets…' : 'No presets of this kind yet.'}</p>
          ) : (
            <ul>
              {hasPrevious ? (
                <li data-ui="configuration-catalog-boundary">
                  <Button type="button" data-ui="field-inline-action" onClick={onLoadPrevious}>
                    Earlier presets…
                  </Button>
                </li>
              ) : null}
              {presets.map((p) => {
                const isCurrent = pinnedPreset?.id === p.id
                return (
                  <li key={p.id} data-current={isCurrent ? 'true' : undefined}>
                    <Button
                      type="button"
                      data-ui="preset-menu-load"
                      onClick={() => onLoad(p.id)}
                      title={isCurrent ? 'Already loaded' : 'Load preset'}
                    >
                      {isCurrent ? '●' : '○'} {p.name}
                    </Button>
                    <div data-ui="preset-menu-actions">
                      <Button
                        type="button"
                        data-ui="field-inline-action"
                        onClick={() => onSaveToExisting(p.id, p.name)}
                        title={`Overwrite "${p.name}" with the current text`}
                      >
                        save
                      </Button>
                      <Button
                        type="button"
                        data-ui="field-inline-action"
                        onClick={() => onRename(p.id, p.name)}
                        title="Rename"
                      >
                        rename
                      </Button>
                      <IconButton
                        type="button"
                        data-ui="icon-button"
                        data-compact
                        data-tone="danger"
                        onClick={() => onDelete(p.id, p.name)}
                        title="Delete preset"
                        aria-label="Delete preset"
                      >
                        <TrashIcon />
                      </IconButton>
                    </div>
                  </li>
                )
              })}
              {hasMore ? (
                <li data-ui="configuration-catalog-boundary">
                  <Button type="button" data-ui="field-inline-action" onClick={onLoadMore}>
                    More presets…
                  </Button>
                </li>
              ) : null}
            </ul>
          )}
          <div data-ui="preset-menu-footer">
            <Button type="button" data-ui="field-inline-action" onClick={() => onSaveAsNew()}>
              + Save as new…
            </Button>
            <IconButton
              type="button"
              data-ui="icon-button"
              data-compact
              onClick={() => setOpen(false)}
              aria-label="Close"
              title="Close"
            >
              <CloseGlyph />
            </IconButton>
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
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
