// llama-server-specific chat settings. Only rendered on llama-server
// profiles; the visibility gate is in ChatModelPanel.
//
// Exposes:
// - Protocol toggle (Chat / Text) — flips between /v1/chat/completions
//   and /v1/completions at dispatch time.
// - Template picker (only when protocol='text') — selects the client-
//   side renderer or delegates to the server via /apply-template.
// - Custom template editor (only when textTemplate='custom').

import { useEffect, useState } from 'react'
import { probeLlamaServer, type LlamaServerProps } from '../../api/probe'
import { TEXT_TEMPLATES, TEXT_TEMPLATE_ORDER } from '../../core/text-templates'
import type {
  Chat,
  ConnectionProfile,
  TextTemplateConfig,
  TextTemplateId,
} from '../../core/types'
import { updateChatSettings } from '../../store/chats'

const EMPTY_CUSTOM: TextTemplateConfig = {
  userPrefix: '',
  userSuffix: '',
  assistantPrefix: '',
  assistantSuffix: '',
  systemPrefix: '',
  systemSuffix: '',
  bos: '',
  stop: [],
}

export interface LlamaServerSectionProps {
  chat: Chat
  profile: ConnectionProfile
}

export function LlamaServerSection({ chat, profile }: LlamaServerSectionProps) {
  // One-shot probe per profile. Populates the "Default" template option
  // with a preview of the server's own chat_template when it resolves.
  const [props, setProps] = useState<LlamaServerProps | null>(null)
  useEffect(() => {
    let cancelled = false
    void probeLlamaServer({ baseUrl: profile.baseUrl }).then((result) => {
      if (cancelled) return
      if (result.kind === 'ok') setProps(result.props)
    })
    return () => {
      cancelled = true
    }
  }, [profile.baseUrl])

  const protocol = chat.settings.protocol ?? 'chat'
  const textTemplate = chat.settings.textTemplate ?? 'chatml'
  // Wire default is true. We only persist an explicit `false` when the
  // user opts out; persisting true would be noise.
  const reuseCache = chat.settings.cachePrompt !== false

  const setProtocol = (next: 'chat' | 'text') => {
    void updateChatSettings(chat.id, { protocol: next })
  }

  const setTemplate = (next: TextTemplateId) => {
    void updateChatSettings(chat.id, { textTemplate: next })
  }

  const setReuseCache = (next: boolean) => {
    // Write undefined when matching the server default to keep payloads
    // clean (and to avoid the preset drift that would otherwise flag
    // the chat as diverged from a preset that doesn't carry the field).
    const patch: Partial<import('../../core/types').ChatSettings> = next
      ? {}
      : { cachePrompt: false }
    if (next && chat.settings.cachePrompt !== undefined) {
      // Unset an explicit `false` by rewriting the sub-object without it.
      // updateChatSettings merges top-level, so deleting a key via patch
      // isn't supported; shallow-clone and omit instead.
      const { cachePrompt: _drop, ...rest } = chat.settings
      void updateChatSettings(chat.id, rest)
      return
    }
    void updateChatSettings(chat.id, patch)
  }

  return (
    <section data-ui="settings-section" data-ui-section="llama-server">
      <h3>llama-server</h3>
      <div data-ui="field-group">
        <span id="llama-protocol" data-ui="field-label">
          Wire protocol
        </span>
        <div data-ui="segmented">
          <button
            type="button"
            aria-pressed={protocol === 'chat'}
            data-ui="segmented-option"
            data-active={protocol === 'chat'}
            onClick={() => setProtocol('chat')}
          >
            Chat completion
          </button>
          <button
            type="button"
            aria-pressed={protocol === 'text'}
            data-ui="segmented-option"
            data-active={protocol === 'text'}
            onClick={() => setProtocol('text')}
          >
            Text completion
          </button>
        </div>
        <span data-ui="helper">
          {protocol === 'chat'
            ? "Posts to /v1/chat/completions. The server applies its own chat template to the messages."
            : 'Posts to /v1/completions with a client-rendered prompt. You pick the chat template below.'}
        </span>
      </div>
      <div data-ui="field-group">
        <label>
          <input
            type="checkbox"
            data-ui="llama-cache-prompt"
            checked={reuseCache}
            onChange={(e) => setReuseCache(e.target.checked)}
          />
          &nbsp;Reuse KV cache between requests
        </label>
        <span data-ui="helper">
          Sends <code>cache_prompt</code>. When on (llama-server default), the shared prompt prefix
          is not re-evaluated — faster reprocessing, slight nondeterminism possible on some
          backends. Turn off to force a fresh prompt evaluation each send.
        </span>
      </div>
      {protocol === 'text' ? (
        <>
          <div data-ui="field-group">
            <label htmlFor="llama-template">Chat template</label>
            <select
              id="llama-template"
              data-ui="llama-template-picker"
              value={textTemplate}
              onChange={(e) => setTemplate(e.target.value as TextTemplateId)}
            >
              {TEXT_TEMPLATE_ORDER.map((id) => (
                <option key={id} value={id}>
                  {labelFor(id)}
                </option>
              ))}
            </select>
            <span data-ui="helper">{describeTemplate(textTemplate, props)}</span>
          </div>
          {textTemplate === 'custom' ? (
            <CustomTemplateEditor chat={chat} />
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function labelFor(id: TextTemplateId): string {
  if (id === 'default') return 'Default (server template)'
  if (id === 'custom') return 'Custom…'
  const entry = TEXT_TEMPLATES[id]
  return entry ? entry.name : id
}

function describeTemplate(id: TextTemplateId, props: LlamaServerProps | null): string {
  if (id === 'default') {
    if (!props) return 'Uses POST /apply-template on the server (probing…).'
    if (props.chatTemplate === null) {
      return "Server doesn't advertise a chat template; /apply-template may fail."
    }
    return `Uses the server's Jinja template via POST /apply-template.`
  }
  if (id === 'raw') return 'No separators. Messages are concatenated verbatim.'
  if (id === 'custom') return 'Define your own prefix/suffix tokens below.'
  const entry = TEXT_TEMPLATES[id]
  if (!entry) return ''
  return entry.stop.length > 0 ? `Stops on: ${entry.stop.join(', ')}` : 'No built-in stop sequences.'
}

function CustomTemplateEditor({ chat }: { chat: Chat }) {
  const current = chat.settings.customTextTemplate ?? EMPTY_CUSTOM
  const patch = (next: Partial<TextTemplateConfig>) => {
    void updateChatSettings(chat.id, {
      customTextTemplate: { ...current, ...next },
    })
  }
  const [stopDraft, setStopDraft] = useState(current.stop.join('\n'))
  useEffect(() => {
    setStopDraft(current.stop.join('\n'))
  }, [current.stop])

  return (
    <div data-ui="custom-template-editor">
      <FieldRow label="BOS token" value={current.bos} onChange={(v) => patch({ bos: v })} />
      <FieldRow
        label="User prefix"
        value={current.userPrefix}
        onChange={(v) => patch({ userPrefix: v })}
      />
      <FieldRow
        label="User suffix"
        value={current.userSuffix}
        onChange={(v) => patch({ userSuffix: v })}
      />
      <FieldRow
        label="Assistant prefix"
        value={current.assistantPrefix}
        onChange={(v) => patch({ assistantPrefix: v })}
      />
      <FieldRow
        label="Assistant suffix"
        value={current.assistantSuffix}
        onChange={(v) => patch({ assistantSuffix: v })}
      />
      <FieldRow
        label="System prefix"
        value={current.systemPrefix}
        onChange={(v) => patch({ systemPrefix: v })}
      />
      <FieldRow
        label="System suffix"
        value={current.systemSuffix}
        onChange={(v) => patch({ systemSuffix: v })}
      />
      <div data-ui="field-group">
        <label>
          Stop sequences (one per line)
          <textarea
            rows={3}
            value={stopDraft}
            onChange={(e) => setStopDraft(e.target.value)}
            onBlur={() => {
              const stops = stopDraft
                .split('\n')
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
              patch({ stop: stops })
            }}
          />
        </label>
      </div>
    </div>
  )
}

function FieldRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (next: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])
  return (
    <div data-ui="field-group">
      <label>
        {label}
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== value) onChange(draft)
          }}
        />
      </label>
    </div>
  )
}
