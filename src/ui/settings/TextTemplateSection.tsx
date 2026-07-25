import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { LlamaServerProps } from '../../api/probe'
import {
  configurationWriteInteraction,
  configurationWriteTarget,
  definePresentationInteraction,
} from '../../app/presentation-interactions'
import { textCompletionsNeedsReasoningOffFor } from '../../core/quirks'
import {
  BUILTIN_TEXT_TEMPLATE_ORDER,
  EMPTY_TEXT_TEMPLATE,
  editableTextTemplateConfig,
  isStaticTextTemplateId,
  TEXT_TEMPLATES,
  templateSourceForConfig,
} from '../../core/text-templates'
import type { Chat, TextTemplateConfig, TextTemplateId } from '../../core/types'
import { usePresentationInteraction } from '../../hooks/usePresentationInteraction'
import { useSettledConfigurationEdit } from '../../hooks/useSettledConfigurationEdit'
import { useTextTemplateLibrary } from '../../hooks/useTextTemplateLibrary'
import { configurationApplication } from '../../store/configuration-application'
import { configurationController } from '../../store/configuration-controller'
import { Button } from '../primitives/Button'
import { InfoDisclosure } from './InfoDisclosure'

interface TextTemplateSectionProps {
  chat: Chat
  mode: 'llama-server' | 'openrouter'
  llamaProps?: LlamaServerProps | null
  heading?: string
  requestStopControl?: ReactNode
}

const textTemplateLibraryInteraction = definePresentationInteraction<'library'>({
  id: 'text-template-library.mutate',
  label: 'Text template update',
  concurrency: 'reject',
  lifetime: 'workspace-tab',
})

export function TextTemplateSection({
  chat,
  mode,
  llamaProps = null,
  heading = 'Text completions template',
  requestStopControl = null,
}: TextTemplateSectionProps) {
  const allowServerDefault = mode === 'llama-server'
  const selectedRaw = chat.settings.textTemplate ?? 'chatml'
  const selected = !allowServerDefault && selectedRaw === 'default' ? 'chatml' : selectedRaw
  const selectedSavedId = isStaticTextTemplateId(selected) ? null : selected
  const { catalog: saved, selected: selectedSavedValue } = useTextTemplateLibrary(selectedSavedId)
  const selectedSavedCatalogRow = saved.find((row) => row.id === selectedSavedId) ?? null
  const selectedSaved = selectedSavedValue ?? null
  const selectedBuiltin = TEXT_TEMPLATES[selected] ?? null
  const selectedIsPerChatCustom = selected === 'custom'
  const selectedConfig =
    selectedSaved?.config ??
    selectedBuiltin ??
    (selectedIsPerChatCustom ? (chat.settings.customTextTemplate ?? EMPTY_TEXT_TEMPLATE) : null)
  const canEdit = selectedSaved !== null || selectedIsPerChatCustom
  const editableConfig = useMemo(
    () => (selectedConfig ? editableTextTemplateConfig(selectedConfig) : null),
    [selectedConfig],
  )
  const helper = useMemo(
    () => describeTemplate(selected, mode, llamaProps, selectedSaved?.config),
    [selected, mode, llamaProps, selectedSaved?.config],
  )
  const needsReasoningOff =
    mode === 'openrouter' &&
    textCompletionsNeedsReasoningOffFor(chat.settings.model) &&
    chat.settings.reasoning.mode !== 'off'
  const libraryInteraction = usePresentationInteraction(textTemplateLibraryInteraction)
  const { run: runConfigurationWrite } = usePresentationInteraction(configurationWriteInteraction, {
    observePending: false,
  })

  const setTemplate = (next: TextTemplateId) => {
    runConfigurationWrite({
      target: configurationWriteTarget(chat.id, 'textTemplate'),
      action: () => configurationApplication.patchChatSettings(chat.id, { textTemplate: next }),
    })
  }

  const createBlank = () => {
    libraryInteraction.run({
      target: 'library',
      action: () =>
        configurationApplication.createAndSelectTextTemplate({
          chatId: chat.id,
          name: 'New text template',
          config: { ...EMPTY_TEXT_TEMPLATE, includeSystemPrompt: true },
        }),
    })
  }

  const saveAsNew = () => {
    const base = selectedConfig ?? EMPTY_TEXT_TEMPLATE
    libraryInteraction.run({
      target: 'library',
      action: () =>
        configurationApplication.createAndSelectTextTemplate({
          chatId: chat.id,
          name: `${labelFor(selected, selectedSaved?.name)} copy`,
          config: editableTextTemplateConfig(base),
        }),
    })
  }

  const deleteCurrent = () => {
    if (!selectedSaved) return
    libraryInteraction.run({
      target: 'library',
      action: () => configurationApplication.deleteTextTemplate(selectedSaved.id),
    })
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
          {selectedSavedId && !selectedSavedCatalogRow ? (
            <option value={selectedSavedId}>
              {selectedSaved?.name ?? 'Loading saved template…'}
            </option>
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
        <Button
          type="button"
          data-ui="secondary-button"
          disabled={libraryInteraction.isPending('library')}
          onClick={createBlank}
        >
          New template
        </Button>
        {selectedConfig ? (
          <Button
            type="button"
            data-ui="secondary-button"
            disabled={libraryInteraction.isPending('library')}
            onClick={saveAsNew}
          >
            Save as new
          </Button>
        ) : null}
        {selectedSaved ? (
          <Button
            type="button"
            data-ui="secondary-button"
            disabled={libraryInteraction.isPending('library')}
            onClick={deleteCurrent}
          >
            Delete saved
          </Button>
        ) : null}
      </div>
      {selectedSaved ? (
        <TemplateNameEditor templateId={selectedSaved.id} name={selectedSaved.name} />
      ) : null}
      {editableConfig ? (
        <TemplateConfigEditor
          key={selectedSaved?.id ?? selected}
          chatId={chat.id}
          {...(selectedSaved ? { templateId: selectedSaved.id } : {})}
          config={editableConfig}
          readOnly={!canEdit}
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
  const edit = useSettledConfigurationEdit({
    ownerKey: `text-template:${templateId}`,
    fieldKey: `text-template.${templateId}.name`,
    storedValue: name,
    commit: (next) => configurationApplication.updateTextTemplate(templateId, { name: next }),
  })
  return (
    <div data-ui="field-group">
      <label htmlFor={`${templateId}-name`}>Template name</label>
      <input
        id={`${templateId}-name`}
        type="text"
        value={edit.value}
        onChange={(e) => edit.setValue(e.target.value)}
        onBlur={edit.onBlur}
      />
    </div>
  )
}

function TemplateConfigEditor({
  chatId,
  templateId,
  config,
  readOnly,
}: {
  chatId: Chat['id']
  templateId?: TextTemplateId
  config: TextTemplateConfig
  readOnly: boolean
}) {
  const edit = useSettledConfigurationEdit({
    ...(templateId
      ? { ownerKey: `text-template:${templateId}` }
      : readOnly
        ? {}
        : { ownerChatId: chatId }),
    fieldKey: templateId ? `text-template.${templateId}.config` : 'customTextTemplate',
    storedValue: config,
    equal: sameTextTemplateConfig,
    stage(next) {
      if (templateId) {
        configurationController.stageTextTemplateConfig(templateId, next)
      } else if (!readOnly) {
        configurationController.stageChatSettingsFields(chatId, [
          { path: ['customTextTemplate'], value: next },
        ])
      }
    },
    async commit(next) {
      if (templateId) {
        await configurationApplication.updateTextTemplate(templateId, { config: next })
      } else if (!readOnly) {
        await configurationApplication.patchChatSettingsFields(chatId, [
          { path: ['customTextTemplate'], value: next },
        ])
      }
    },
  })
  const patch = (next: Partial<TextTemplateConfig>) => {
    edit.setValue({ ...edit.value, ...next })
  }
  return (
    <div data-ui="text-template-editor">
      <TemplateSourceField
        value={templateSourceForConfig(edit.value)}
        readOnly={readOnly}
        onChange={(template) => patch({ template })}
        onBlur={edit.onBlur}
      />
      <label data-ui="reasoning-checkbox" data-disabled={readOnly ? 'true' : undefined}>
        <input
          type="checkbox"
          checked={edit.value.includeSystemPrompt !== false}
          disabled={readOnly}
          onChange={(e) => {
            patch({ includeSystemPrompt: e.target.checked })
            edit.onBlur()
          }}
        />
        <span>Include chat system prompt</span>
      </label>
      <StopField
        value={config.stop}
        readOnly={readOnly}
        onChange={(stop) => patch({ stop })}
        onBlur={edit.onBlur}
      />
    </div>
  )
}

function TemplateSourceField({
  value,
  readOnly,
  onChange,
  onBlur,
}: {
  value: string
  readOnly: boolean
  onChange: (next: string) => void
  onBlur: () => void
}) {
  const id = 'text-template-source'
  return (
    <div data-ui="field-group">
      <label htmlFor={id}>Template source</label>
      <textarea
        id={id}
        data-ui="text-template-source"
        rows={14}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
    </div>
  )
}

function StopField({
  value,
  readOnly,
  onChange,
  onBlur,
}: {
  value: readonly string[]
  readOnly: boolean
  onChange: (next: string[]) => void
  onBlur: () => void
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
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          onChange(sanitizeTemplateStops(next))
        }}
        onBlur={() => {
          if (!readOnly && draft !== text) onChange(sanitizeTemplateStops(draft))
          onBlur()
        }}
      />
      <span data-ui="helper">Saved with this template and merged into the request stop list.</span>
    </div>
  )
}

function sanitizeTemplateStops(text: string): string[] {
  return text
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

function sameTextTemplateConfig(left: TextTemplateConfig, right: TextTemplateConfig): boolean {
  return (
    left.template === right.template &&
    left.includeSystemPrompt === right.includeSystemPrompt &&
    left.userPrefix === right.userPrefix &&
    left.userSuffix === right.userSuffix &&
    left.assistantPrefix === right.assistantPrefix &&
    left.assistantSuffix === right.assistantSuffix &&
    left.systemPrefix === right.systemPrefix &&
    left.systemSuffix === right.systemSuffix &&
    left.bos === right.bos &&
    left.stop.length === right.stop.length &&
    left.stop.every((value, index) => value === right.stop[index])
  )
}
