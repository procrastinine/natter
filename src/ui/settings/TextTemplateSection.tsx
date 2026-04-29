import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { LlamaServerProps } from '../../api/probe'
import {
  BUILTIN_TEXT_TEMPLATE_ORDER,
  EMPTY_TEXT_TEMPLATE,
  TEXT_TEMPLATES,
  createSavedTextTemplate,
  deleteSavedTextTemplate,
  editableTextTemplateConfig,
  readSavedTextTemplates,
  templateSourceForConfig,
  type SavedTextTemplate,
  updateSavedTextTemplate,
} from '../../core/text-templates'
import { textCompletionsNeedsReasoningOffFor } from '../../core/quirks'
import type { Chat, TextTemplateConfig, TextTemplateId } from '../../core/types'
import { updateChatSettings } from '../../store/chats'
import { InfoDisclosure } from './InfoDisclosure'

interface TextTemplateSectionProps {
  chat: Chat
  mode: 'llama-server' | 'openrouter'
  llamaProps?: LlamaServerProps | null
  heading?: string
  requestStopControl?: ReactNode
}

export function TextTemplateSection({
  chat,
  mode,
  llamaProps = null,
  heading = 'Text completions template',
  requestStopControl = null,
}: TextTemplateSectionProps) {
  const saved = useLiveQuery(() => readSavedTextTemplates(), [], [] as SavedTextTemplate[]) ?? []
  const allowServerDefault = mode === 'llama-server'
  const selectedRaw = chat.settings.textTemplate ?? 'chatml'
  const selected = !allowServerDefault && selectedRaw === 'default' ? 'chatml' : selectedRaw
  const selectedSaved = saved.find((row) => row.id === selected) ?? null
  const selectedBuiltin = TEXT_TEMPLATES[selected] ?? null
  const selectedIsPerChatCustom = selected === 'custom'
  const selectedConfig =
    selectedSaved?.config ??
    selectedBuiltin ??
    (selectedIsPerChatCustom ? (chat.settings.customTextTemplate ?? EMPTY_TEXT_TEMPLATE) : null)
  const canEdit = selectedSaved !== null || selectedIsPerChatCustom
  const helper = useMemo(
    () => describeTemplate(selected, mode, llamaProps, selectedSaved?.config),
    [selected, mode, llamaProps, selectedSaved?.config],
  )
  const needsReasoningOff =
    mode === 'openrouter' &&
    textCompletionsNeedsReasoningOffFor(chat.settings.model) &&
    chat.settings.reasoning.mode !== 'off'

  const setTemplate = (next: TextTemplateId) => {
    void updateChatSettings(chat.id, { textTemplate: next })
  }

  const createBlank = async () => {
    const row = await createSavedTextTemplate({
      name: 'New text template',
      config: { ...EMPTY_TEXT_TEMPLATE, includeSystemPrompt: true },
    })
    await updateChatSettings(chat.id, { textTemplate: row.id })
  }

  const saveAsNew = async () => {
    const base = selectedConfig ?? EMPTY_TEXT_TEMPLATE
    const row = await createSavedTextTemplate({
      name: `${labelFor(selected, selectedSaved?.name)} copy`,
      config: editableTextTemplateConfig(base),
    })
    await updateChatSettings(chat.id, { textTemplate: row.id })
  }

  const deleteCurrent = async () => {
    if (!selectedSaved) return
    await deleteSavedTextTemplate(selectedSaved.id)
    await updateChatSettings(chat.id, { textTemplate: 'chatml' })
  }

  const updateSelectedConfig = (config: TextTemplateConfig) => {
    if (selectedSaved) {
      void updateSavedTextTemplate(selectedSaved.id, { config })
      return
    }
    if (selectedIsPerChatCustom) {
      void updateChatSettings(chat.id, { customTextTemplate: config })
    }
  }

  return (
    <section data-ui="settings-section" data-ui-section="text-template">
      <h3>
        {heading}{' '}
        <InfoDisclosure title="Text completions sends one rendered prompt string. Pick any template manually; the app does not force a template from the model family. Saved templates are global and shared by OpenRouter and llama-server." />
      </h3>
      <div data-ui="field-group">
        <label htmlFor={`${mode}-text-template`}>Chat template</label>
        <select
          id={`${mode}-text-template`}
          data-ui="text-template-picker"
          value={selected}
          onChange={(e) => setTemplate(e.target.value)}
        >
          {allowServerDefault ? <option value="default">Default (server template)</option> : null}
          <optgroup label="Built in">
            {BUILTIN_TEXT_TEMPLATE_ORDER.map((id) => (
              <option key={id} value={id}>
                {labelFor(id)}
              </option>
            ))}
          </optgroup>
          {saved.length > 0 ? (
            <optgroup label="Saved">
              {saved.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {selectedIsPerChatCustom ? <option value="custom">Per-chat custom</option> : null}
        </select>
        <span data-ui="helper">{helper}</span>
      </div>
      {needsReasoningOff ? (
        <div data-ui="notice-banner" role="status" data-tone="warning">
          <span>
            This model family often emits reasoning-only text completions unless reasoning is
            disabled. The warning belongs to Text completions mode, not prefill.
          </span>
        </div>
      ) : null}
      <div data-ui="inline-actions">
        <button type="button" data-ui="secondary-button" onClick={createBlank}>
          New template
        </button>
        {selectedConfig ? (
          <button type="button" data-ui="secondary-button" onClick={saveAsNew}>
            Save as new
          </button>
        ) : null}
        {selectedSaved ? (
          <button type="button" data-ui="secondary-button" onClick={deleteCurrent}>
            Delete saved
          </button>
        ) : null}
      </div>
      {selectedSaved ? (
        <TemplateNameEditor templateId={selectedSaved.id} name={selectedSaved.name} />
      ) : null}
      {selectedConfig ? (
        <TemplateConfigEditor
          config={editableTextTemplateConfig(selectedConfig)}
          readOnly={!canEdit}
          onChange={updateSelectedConfig}
        />
      ) : null}
      {requestStopControl}
    </section>
  )
}

function labelFor(id: TextTemplateId, savedName?: string): string {
  if (savedName) return savedName
  if (id === 'custom') return 'Per-chat custom'
  const entry = TEXT_TEMPLATES[id]
  return entry ? entry.name : id
}

function describeTemplate(
  id: TextTemplateId,
  mode: TextTemplateSectionProps['mode'],
  llamaProps: LlamaServerProps | null,
  savedConfig?: TextTemplateConfig,
): string {
  if (id === 'default') {
    if (mode !== 'llama-server') return 'OpenRouter does not expose server-defined templates.'
    if (!llamaProps) return 'Uses POST /apply-template on the server (probing...).'
    if (llamaProps.chatTemplate === null) {
      return "Server doesn't advertise a chat template; /apply-template may fail."
    }
    return "Uses the server's GGUF chat_template via POST /apply-template."
  }
  if (id === 'custom') return 'Per-chat template. Use Save as new for a global copy.'
  const config = savedConfig ?? TEXT_TEMPLATES[id]
  if (!config) return 'Template not found; send falls back to a raw prompt.'
  if (id === 'raw') {
    return 'Raw continuation: renders visible message text directly, with no system prompt or role markers.'
  }
  return config.stop.length > 0
    ? `Stops on: ${config.stop.join(', ')}`
    : 'No built-in stop sequences.'
}

function TemplateNameEditor({ templateId, name }: { templateId: TextTemplateId; name: string }) {
  const [draft, setDraft] = useState(name)
  useEffect(() => {
    setDraft(name)
  }, [name])
  return (
    <div data-ui="field-group">
      <label htmlFor={`${templateId}-name`}>Template name</label>
      <input
        id={`${templateId}-name`}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== name) void updateSavedTextTemplate(templateId, { name: draft })
        }}
      />
    </div>
  )
}

function TemplateConfigEditor({
  config,
  readOnly,
  onChange,
}: {
  config: TextTemplateConfig
  readOnly: boolean
  onChange: (next: TextTemplateConfig) => void
}) {
  const patch = (next: Partial<TextTemplateConfig>) => onChange({ ...config, ...next })
  return (
    <div data-ui="text-template-editor">
      <TemplateSourceField
        value={templateSourceForConfig(config)}
        readOnly={readOnly}
        onChange={(template) => patch({ template })}
      />
      <label data-ui="reasoning-checkbox" data-disabled={readOnly ? 'true' : undefined}>
        <input
          type="checkbox"
          checked={config.includeSystemPrompt !== false}
          disabled={readOnly}
          onChange={(e) => patch({ includeSystemPrompt: e.target.checked })}
        />
        <span>Include chat system prompt</span>
      </label>
      <StopField value={config.stop} readOnly={readOnly} onChange={(stop) => patch({ stop })} />
    </div>
  )
}

function TemplateSourceField({
  value,
  readOnly,
  onChange,
}: {
  value: string
  readOnly: boolean
  onChange: (next: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])
  const id = 'text-template-source'
  return (
    <div data-ui="field-group">
      <label htmlFor={id}>Template source</label>
      <textarea
        id={id}
        data-ui="text-template-source"
        rows={14}
        value={draft}
        readOnly={readOnly}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!readOnly && draft !== value) onChange(draft)
        }}
      />
    </div>
  )
}

function StopField({
  value,
  readOnly,
  onChange,
}: {
  value: readonly string[]
  readOnly: boolean
  onChange: (next: string[]) => void
}) {
  const text = value.join('\n')
  const [draft, setDraft] = useState(text)
  useEffect(() => {
    setDraft(text)
  }, [text])
  const id = 'text-template-stop-sequences'
  return (
    <div data-ui="field-group">
      <label htmlFor={id}>Template stop sequences</label>
      <textarea
        id={id}
        rows={4}
        value={draft}
        readOnly={readOnly}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (readOnly || draft === text) return
          onChange(
            draft
              .split('\n')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          )
        }}
      />
      <span data-ui="helper">Saved with this template and merged into the request stop list.</span>
    </div>
  )
}
