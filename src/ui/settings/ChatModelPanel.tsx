// Right-side settings pane for the current chat. See `plan/10-ui.md §10.9`.
//
// Tabs:
// 1. "Model & Provider"  — inline model picker + (OpenRouter only) provider
//                          picker shell
// 2. "Generation"        — ParamForm (sampling, reasoning, verbosity, stop,
//                          response format, logit-bias, system prompt)
// 3. "Caching"           — CachingPanel
//
// Above the tabs, the preset breadcrumb surfaces the "model + provider +
// generation settings as a profile" concept: shows the current preset name
// and a "Save to preset…" affordance. Picking a model + editing params
// diverges the chat from its seed preset; the breadcrumb lets the user
// write those edits back to the preset (update or save-as-new).
//
// Model switch: we call `adaptSettingsForCapability` after the new /endpoints
// row arrives so settings the new model still supports are preserved; the
// dropped ones are surfaced via a short issues banner on the Generation
// tab (see ParamForm's own issues banner).

import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Chat, ChatId, ChatPreset, ConnectionKind, ConnectionProfile } from '../../core/types'
import type { EffectiveCapability } from '../../core/capabilities'
import { useEndpoints } from '../../hooks/useEndpoints'
import { getChat, setChatPreset, updateChatSettings } from '../../store/chats'
import {
  createPreset,
  deletePreset,
  getPreset,
  listPresets,
  updatePreset,
} from '../../store/presets'
import { getProfile } from '../../store/profiles'
import { useToastStore } from '../../store/zustand/toastStore'
import { CloseIcon } from '../icons/Icon'
import { CachingPanel } from './CachingPanel'
import { ContextPanel } from './ContextPanel'
import { LlamaServerSection } from './LlamaServerSection'
import { ModelPicker } from './ModelPicker'
import { ParamForm } from './ParamForm'
import { PrivacySection } from './PrivacySection'
import { ProviderPicker } from './ProviderPicker'

export interface ChatModelPanelProps {
  // Null while the user is on /new before the chat row has materialized.
  // The panel renders a placeholder in that case; the rest of the wiring
  // already handles undefined chat / profile / preset.
  chatId: ChatId | null
  chatSnapshot?: Chat | null
  onClose: () => void
}

type Tab = 'model' | 'context' | 'generation'

export function ChatModelPanel({ chatId, chatSnapshot = null, onClose }: ChatModelPanelProps) {
  const liveChat = useLiveQuery(
    async () => (chatId ? await getChat(chatId) : undefined),
    [chatId],
    undefined,
  )
  const chatCacheRef = useRef(new Map<ChatId, Chat>())
  useEffect(() => {
    if (!liveChat) return
    chatCacheRef.current.set(liveChat.id, liveChat)
  }, [liveChat])
  const chat =
    liveChat ?? chatSnapshot ?? (chatId ? chatCacheRef.current.get(chatId) : undefined)

  const liveProfile = useLiveQuery(
    () => (chat ? getProfile(chat.settings.profileId) : Promise.resolve(undefined)),
    [chat?.settings.profileId],
    undefined,
  )
  const profileCacheRef = useRef(new Map<string, ConnectionProfile>())
  useEffect(() => {
    if (!liveProfile) return
    profileCacheRef.current.set(liveProfile.id, liveProfile)
  }, [liveProfile])
  const profile =
    liveProfile ??
    (chat?.settings.profileId ? profileCacheRef.current.get(chat.settings.profileId) : undefined)

  const livePreset = useLiveQuery(
    () => (chat?.presetId ? getPreset(chat.presetId) : Promise.resolve(undefined)),
    [chat?.presetId],
    undefined,
  )
  const presetCacheRef = useRef(new Map<string, ChatPreset>())
  useEffect(() => {
    if (!livePreset) return
    presetCacheRef.current.set(livePreset.id, livePreset)
  }, [livePreset])
  const preset =
    livePreset ?? (chat?.presetId ? presetCacheRef.current.get(chat.presetId) : undefined)
  const { capability, descriptor, modelAvailable } = useEndpoints(
    chat?.settings.profileId ?? null,
    chat?.settings.model || null,
    { strict: chat?.settings.strictProviderRouting === true },
  )
  const endpointTokenizer = descriptor?.architecture?.tokenizer ?? null
  const [tab, setTab] = useState<Tab>('model')

  // Opening the pane resets to Model & Provider — that's the "cog click =
  // see which model this chat is using" muscle memory (mirrors the
  // default-tab-on-open rule from §10.9).
  useEffect(() => {
    setTab('model')
  }, [chatId])

  const handleModelPick = useCallback(
    async (modelId: string) => {
      if (!chat) return
      if (chat.settings.model === modelId) return
      await updateChatSettings(chat.id, { model: modelId })
    },
    [chat],
  )

  const handleModelPickForPreset = useCallback(
    async (modelId: string) => {
      if (!chat) return
      if (!chat.presetId) return
      const p = await getPreset(chat.presetId)
      if (!p) return
      await updatePreset(p.id, {
        settings: { ...p.settings, model: modelId, profileId: p.connectionProfileId },
      })
      await updateChatSettings(chat.id, { model: modelId })
    },
    [chat],
  )

  if (!chat) {
    return (
      <aside data-ui="chat-model-panel" role="complementary" aria-label="Chat model settings">
        <PanelHeader onClose={onClose} title="Model settings" />
        <div data-ui="settings-panel" />
      </aside>
    )
  }

  const isOpenRouter = profile?.kind === 'openrouter'

  // Two distinct "no usable model" states, one banner either way:
  // 1. The chat has a model but the current connection doesn't serve it
  //    (e.g., gemma on an OpenRouter connection). Shows what's wrong.
  // 2. The chat has no model at all (fresh chat, or we just cleared it on
  //    a connection switch). Shows a generic prompt.
  // When `modelAvailable === null` we're still loading /models and suppress
  // the banner to avoid flicker.
  const noModel =
    !chat.settings.model || (profile?.kind === 'llama-server' && modelAvailable === false)
  const unavailableModel =
    modelAvailable === false && profile?.kind !== 'llama-server' ? chat.settings.model : null

  return (
    <aside data-ui="chat-model-panel" role="complementary" aria-label="Chat model settings">
      <PanelHeader onClose={onClose} title="Chat settings" />
      <PresetBreadcrumb chat={chat} preset={preset ?? undefined} />
      {unavailableModel ? (
        <div data-ui="notice-banner" role="status" data-tone="warning">
          <span>
            <strong>{unavailableModel}</strong> isn't served on{' '}
            <em>{profile?.name ?? 'this connection'}</em>. Pick a different model below.
          </span>
        </div>
      ) : noModel ? (
        <div data-ui="notice-banner" role="status" data-tone="info">
          <span>
            Pick a model for <em>{profile?.name ?? 'this connection'}</em>.
          </span>
        </div>
      ) : null}
      <div role="tablist" data-ui="settings-tabs" data-ui-panel-tabs>
        {(
          [
            ['model', 'Model'],
            ['context', 'Context'],
            ['generation', 'Generation'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            data-ui="settings-tab"
            data-tab={value}
            aria-selected={tab === value}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" data-ui="settings-panel" data-active-tab={tab}>
        {tab === 'model' ? (
          <>
            <ModelPicker
              chat={chat}
              profileKind={profile?.kind ?? 'custom'}
              onPick={handleModelPick}
              onPickForPreset={handleModelPickForPreset}
            />
            {isOpenRouter ? <ProviderPicker chat={chat} /> : null}
            {isOpenRouter ? <PrivacySection chat={chat} /> : null}
            {profile?.kind === 'llama-server' ? (
              <LlamaServerSection chat={chat} profile={profile} />
            ) : null}
          </>
        ) : null}
        {tab === 'context' ? (
          <ContextTab
            chat={chat}
            capability={capability}
            endpointTokenizer={endpointTokenizer}
            isOpenRouter={isOpenRouter}
            connectionKind={profile?.kind ?? 'custom'}
          />
        ) : null}
        {tab === 'generation' ? (
          <ParamForm
            chat={chat}
            capability={capability}
            endpointTokenizer={endpointTokenizer}
          />
        ) : null}
      </div>
    </aside>
  )
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <header data-ui="settings-pane-header">
      <span data-ui="settings-pane-title">{title}</span>
      <button
        type="button"
        data-ui="icon-button"
        data-role="settings-pane-close"
        onClick={onClose}
        aria-label="Close settings pane"
      >
        <CloseIcon size={16} />
      </button>
    </header>
  )
}

// Preset control: shows the current preset + picker menu for load / save /
// rename / delete / new. Chat settings diverge freely; the preset is the
// shared snapshot the user can write back to or swap from.
function PresetBreadcrumb({ chat, preset }: { chat: Chat; preset: ChatPreset | undefined }) {
  const pushToast = useToastStore((s) => s.push)
  const presets = useLiveQuery(() => listPresets(), [], [])
  const [pickerOpen, setPickerOpen] = useState(false)

  const diverged = useMemo(() => {
    if (!preset) return true
    return !settingsMatch(chat.settings, preset.settings)
  }, [chat.settings, preset])

  const closePicker = () => setPickerOpen(false)

  const loadPreset = useCallback(
    async (targetId: string) => {
      const target = await getPreset(targetId)
      if (!target) return
      await updateChatSettings(chat.id, {
        ...target.settings,
        profileId: target.connectionProfileId,
      })
      await updateChatSettings(chat.id, { ...target.settings, profileId: target.connectionProfileId })
      // presetId isn't inside settings; set via chats store directly
      await setChatPreset(chat.id, target.id)
      closePicker()
    },
    [chat.id],
  )

  const saveToExisting = useCallback(
    async (targetId: string) => {
      const target = await getPreset(targetId)
      if (!target) return
      await updatePreset(target.id, {
        settings: { ...chat.settings, profileId: target.connectionProfileId },
      })
      pushToast({
        level: 'info',
        text: `Saved settings to "${target.name}".`,
        durationMs: 2500,
      })
      closePicker()
    },
    [chat.settings, pushToast],
  )

  const saveAsNew = useCallback(async () => {
    const name = window.prompt('Name for new preset:')
    if (!name || !name.trim()) return
    const p = await createPreset({
      name: name.trim(),
      connectionProfileId: chat.settings.profileId,
      settings: { ...chat.settings },
    })
    await setChatPreset(chat.id, p.id)
    pushToast({ level: 'info', text: `Created preset "${p.name}".`, durationMs: 2500 })
    closePicker()
  }, [chat.id, chat.settings, pushToast])

  const renamePreset = useCallback(
    async (targetId: string, currentName: string) => {
      const name = window.prompt('Rename preset:', currentName)
      if (!name || !name.trim() || name === currentName) return
      await updatePreset(targetId, { name: name.trim() })
    },
    [],
  )

  const deletePresetWithConfirm = useCallback(
    async (targetId: string, name: string) => {
      if (!window.confirm(`Delete preset "${name}"? Chats stay; their preset link will clear.`)) {
        return
      }
      await deletePreset(targetId)
    },
    [],
  )

  return (
    <div data-ui="preset-breadcrumb">
      <button
        type="button"
        data-ui="preset-breadcrumb-button"
        aria-expanded={pickerOpen}
        onClick={() => setPickerOpen((v) => !v)}
      >
        <span>
          Preset: <strong>{preset ? preset.name : 'none'}</strong>
          {diverged ? <span data-ui="preset-diverged"> · edited</span> : null}
        </span>
        <span data-ui="preset-breadcrumb-chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {pickerOpen ? (
        <div data-ui="preset-breadcrumb-menu" role="menu">
          {presets.length === 0 ? (
            <p data-ui="helper">No presets yet.</p>
          ) : (
            <ul>
              {presets.map((p) => {
                const isCurrent = preset?.id === p.id
                return (
                  <li key={p.id} data-current={isCurrent ? 'true' : undefined}>
                    <button
                      type="button"
                      data-ui="preset-menu-load"
                      onClick={() => void loadPreset(p.id)}
                      title={isCurrent ? 'Already loaded' : 'Load preset'}
                    >
                      {isCurrent ? '●' : '○'} {p.name}
                    </button>
                    <div data-ui="preset-menu-actions">
                      <button
                        type="button"
                        data-ui="field-inline-action"
                        onClick={() => void saveToExisting(p.id)}
                        title={
                          isCurrent
                            ? 'Save current settings to this preset'
                            : `Overwrite "${p.name}" with current settings`
                        }
                      >
                        save
                      </button>
                      <button
                        type="button"
                        data-ui="field-inline-action"
                        onClick={() => void renamePreset(p.id, p.name)}
                        title="Rename"
                      >
                        rename
                      </button>
                      <button
                        type="button"
                        data-ui="icon-button"
                        data-compact
                        data-tone="danger"
                        onClick={() => void deletePresetWithConfirm(p.id, p.name)}
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
            <button
              type="button"
              data-ui="field-inline-action"
              onClick={() => void saveAsNew()}
            >
              + Save as new…
            </button>
            <button
              type="button"
              data-ui="icon-button"
              data-compact
              onClick={closePicker}
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

function settingsMatch(a: Chat['settings'], b: Chat['settings']): boolean {
  // Shallow comparison on the high-signal fields that live on the panel.
  // We intentionally don't JSON-stringify the full object; the breadcrumb
  // only needs a "roughly matches" signal for the "edited" dot.
  if (a.model !== b.model) return false
  if (a.systemPrompt !== b.systemPrompt) return false
  if (JSON.stringify(a.sampling) !== JSON.stringify(b.sampling)) return false
  if (JSON.stringify(a.reasoning) !== JSON.stringify(b.reasoning)) return false
  if (a.verbosity !== b.verbosity) return false
  if (a.maxCompletionTokens !== b.maxCompletionTokens) return false
  if (JSON.stringify(a.anthropicCache) !== JSON.stringify(b.anthropicCache)) return false
  if (JSON.stringify(a.providerPrefs ?? {}) !== JSON.stringify(b.providerPrefs ?? {})) return false
  return true
}

// The Context tab bundles three related controls: the running token gauge,
// the max-context / truncation knobs, and caching (which lives here because
// caching is a context-management concern — deciding which prefix to cache
// and for how long). Caching is hidden entirely when the model uses implicit
// caching or doesn't support caching at all; it only appears when there's
// something for the user to configure.
function ContextTab({
  chat,
  capability,
  endpointTokenizer,
  isOpenRouter,
  connectionKind,
}: {
  chat: Chat
  capability: EffectiveCapability | null
  endpointTokenizer: string | null
  isOpenRouter: boolean
  connectionKind: ConnectionKind
}) {
  return (
    <>
      <ContextPanel
        chat={chat}
        capability={capability}
        endpointTokenizer={endpointTokenizer}
        showMiddleOut={isOpenRouter}
      />
      <CachingPanel chat={chat} capability={capability} connectionKind={connectionKind} />
    </>
  )
}
