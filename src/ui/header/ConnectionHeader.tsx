import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { probeLlamaServer } from '../../api/probe'
import { runFirstRunSeed } from '../../core/defaults'
import type {
  ChatId,
  ConnectionKind,
  ConnectionProfile,
  KeyRecord,
  ProfileId,
} from '../../core/types'
import { updateChatSettings } from '../../store/chats'
import { createKey, getKey } from '../../store/keys'
import {
  bumpProfileLastUsedAt,
  createProfile,
  deleteProfile,
  listProfiles,
  updateProfile,
} from '../../store/profiles'
import { ChevronIcon, CloseIcon } from '../icons/Icon'

interface HeaderState {
  profile: ConnectionProfile | null
  profiles: ConnectionProfile[]
  keyRecord: KeyRecord | null
}

const ACTIVE_PROFILE_KEY = 'natter:active-profile-id'

// Workspace-active profile id — the connection the user last clicked in the
// header. New chats created via `/new` or the composer seed from this so
// "I switched to llama-server, next chat should be on llama-server" works
// even when the MRU preset is pinned to a different connection. Stored in
// localStorage (UI preference, per-origin/browser); daemon mode will replace
// this with its own preference store behind the same function signatures.
export function readActiveProfileId(): ProfileId | null {
  if (typeof window === 'undefined') return null
  return (window.localStorage.getItem(ACTIVE_PROFILE_KEY) ?? null) as ProfileId | null
}

export function writeActiveProfileId(id: ProfileId | null): void {
  if (typeof window === 'undefined') return
  if (id) window.localStorage.setItem(ACTIVE_PROFILE_KEY, id)
  else window.localStorage.removeItem(ACTIVE_PROFILE_KEY)
}

// When a chat is open, the header represents the chat's pinned connection
// (`chat.settings.profileId`) rather than the workspace-default MRU. A chat
// created on OpenRouter keeps using OpenRouter even after the user adds a
// llama-server profile; showing the workspace default would falsely imply
// this chat lives on llama-server. Switching via the dropdown rewires the
// chat's profileId and bumps the workspace default at the same time, which
// matches how users read "connection" — "the connection for this chat."
async function loadHeaderState(
  activeId: ProfileId | null,
  chatProfileId: ProfileId | null,
): Promise<HeaderState> {
  const live = (await listProfiles()).sort(
    (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
  )
  const chatProfile = chatProfileId ? live.find((p) => p.id === chatProfileId) : undefined
  const fallback = activeId ? live.find((p) => p.id === activeId) : undefined
  const profile = chatProfile ?? fallback ?? live[0] ?? null
  const keyRecord = profile ? ((await getKey(profile.apiKeyRef)) ?? null) : null
  return { profile, profiles: live, keyRecord }
}

const KIND_LABEL: Record<ConnectionKind, string> = {
  openrouter: 'OpenRouter',
  'openai-compatible': 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'llama-server': 'llama-server (local)',
  custom: 'Custom (OpenAI-compatible)',
}

const KIND_ORDER: readonly ConnectionKind[] = [
  'openrouter',
  'openai-compatible',
  'anthropic',
  'google',
  'llama-server',
  'custom',
]

// Only the four hosted providers lock to a canonical base URL. Local-
// server kinds (llama-server) and 'custom' both keep the URL visible
// because the user needs to point us at their machine.
const KIND_LOCKED_BASE_URL: Record<ConnectionKind, string | null> = {
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  'llama-server': null,
  custom: null,
}

const KIND_DEFAULT_BASE_URL: Record<ConnectionKind, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  'llama-server': 'http://127.0.0.1:8080/v1',
  custom: '',
}

function kindRequiresKey(kind: ConnectionKind): boolean {
  return kind !== 'custom' && kind !== 'llama-server'
}

const PLACEHOLDER_KEY = '••••••••••••••••'

export interface ConnectionHeaderProps {
  // When a chat is open, the header represents that chat's connection. The
  // chat's `settings.profileId` is the source of truth; swapping the
  // dropdown rewires the chat AND bumps the workspace default so the next
  // "New chat" lands on the same connection. Home / "New chat" surfaces
  // pass `null` and the header falls back to workspace-default MRU.
  activeChatId?: ChatId | null
  activeChatProfileId?: ProfileId | null
}

export function ConnectionHeader({
  activeChatId = null,
  activeChatProfileId = null,
}: ConnectionHeaderProps = {}) {
  const [activeId, setActiveId] = useState<ProfileId | null>(() => readActiveProfileId())
  const state = useLiveQuery(
    () => loadHeaderState(activeId, activeChatProfileId),
    [activeId, activeChatProfileId],
    {
      profile: null,
      profiles: [],
      keyRecord: null,
    },
  )
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const hasConnection = state.profile !== null

  // Whenever the active profile changes we drop out of edit mode so the form
  // doesn't carry a stale draft against a different connection.
  useEffect(() => {
    setEditing(false)
  }, [state.profile?.id])

  const switchProfile = useCallback(
    async (id: ProfileId) => {
      writeActiveProfileId(id)
      setActiveId(id)
      await bumpProfileLastUsedAt(id)
      // If a chat is open, rewire its pinned connection too — otherwise
      // the header would flip but the chat's panels and send-path would
      // keep hitting the old profile, which is exactly the
      // "header says llama-server but the chat is still OpenRouter" bug.
      // Deselect the model at the same time: the old model is almost
      // certainly not served by the new connection (gemini isn't on
      // llama-server, gemma isn't on OpenRouter), so carrying it forward
      // produces the "Waiting for model capability…" dead-state. The
      // auto-select effect below will re-pick when the new profile has
      // exactly one model.
      if (activeChatId) {
        await updateChatSettings(activeChatId, { profileId: id, model: '' })
      }
    },
    [activeChatId],
  )

  if (!hasConnection || !state.profile) {
    return (
      <section
        data-ui="connection-header"
        data-state="unset"
        aria-label="Connection (none configured)"
      >
        <div data-ui="connection-row">
          <span data-ui="connection-status-dot" data-state="unset" aria-hidden="true" />
          <span data-ui="connection-empty">No connection configured</span>
          <button type="button" data-ui="connection-add" onClick={() => setSetupOpen(true)}>
            Add connection
          </button>
        </div>
        {setupOpen ? <ConnectionSetupModal onClose={() => setSetupOpen(false)} /> : null}
      </section>
    )
  }

  const { profile, profiles, keyRecord } = state
  const status: 'ready' | 'no-key' =
    keyRecord || !kindRequiresKey(profile.kind) ? 'ready' : 'no-key'

  return (
    <section
      data-ui="connection-header"
      data-state="configured"
      data-open={open}
      aria-label={`Connection: ${profile.name}`}
    >
      <button
        type="button"
        data-ui="connection-row"
        aria-expanded={open}
        aria-controls="connection-header-detail"
        onClick={() => setOpen((v) => !v)}
      >
        <span data-ui="connection-chevron" aria-hidden="true">
          <ChevronIcon size={14} rotate={open ? 90 : 0} />
        </span>
        <span data-ui="connection-name" title={profile.name}>
          {profile.name}
        </span>
        {KIND_LOCKED_BASE_URL[profile.kind] !== null ? null : (
          <span data-ui="connection-baseurl" title={profile.baseUrl}>
            {hostFor(profile.baseUrl)}
          </span>
        )}
        <span data-ui="connection-row-spacer" />
        <span
          data-ui="connection-status-dot"
          data-state={status}
          title={
            status === 'ready'
              ? kindRequiresKey(profile.kind)
                ? 'Key on file'
                : 'Custom endpoint — no key required'
              : 'No key — sends are blocked'
          }
          aria-hidden="true"
        />
        <span data-ui="connection-status-text">{status === 'ready' ? 'ready' : 'no key'}</span>
      </button>
      {open ? (
        <div data-ui="connection-detail" id="connection-header-detail">
          <ProfileSwitcher
            profiles={profiles}
            activeId={profile.id}
            onSwitch={switchProfile}
            onCreateNew={() => setSetupOpen(true)}
          />
          {editing ? (
            <ConnectionEditor
              profile={profile}
              hasKey={Boolean(keyRecord)}
              onDone={() => setEditing(false)}
              onCancel={() => setEditing(false)}
              onDeleted={() => {
                setEditing(false)
                writeActiveProfileId(null)
                setActiveId(null)
              }}
            />
          ) : (
            <ConnectionViewer
              profile={profile}
              hasKey={Boolean(keyRecord)}
              onEdit={() => setEditing(true)}
            />
          )}
        </div>
      ) : null}
      {setupOpen ? <ConnectionSetupModal onClose={() => setSetupOpen(false)} /> : null}
    </section>
  )
}

interface ProfileSwitcherProps {
  profiles: ConnectionProfile[]
  activeId: ProfileId
  onSwitch: (id: ProfileId) => void | Promise<void>
  onCreateNew: () => void
}

function ProfileSwitcher({ profiles, activeId, onSwitch, onCreateNew }: ProfileSwitcherProps) {
  return (
    <div data-ui="connection-switcher">
      <label htmlFor="connection-profile-select">Profile</label>
      <select
        id="connection-profile-select"
        data-ui="connection-profile-select"
        value={activeId}
        onChange={(e) => void onSwitch(e.target.value as ProfileId)}
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-ui="connection-new"
        onClick={onCreateNew}
        title="Add a new connection profile"
      >
        + New
      </button>
    </div>
  )
}

interface ConnectionViewerProps {
  profile: ConnectionProfile
  hasKey: boolean
  onEdit: () => void
}

function ConnectionViewer({ profile, hasKey, onEdit }: ConnectionViewerProps) {
  const requiresKey = kindRequiresKey(profile.kind)
  const baseUrlIsLocked = KIND_LOCKED_BASE_URL[profile.kind] !== null
  return (
    <dl data-ui="connection-fields">
      <div>
        <dt>Provider</dt>
        <dd>{KIND_LABEL[profile.kind]}</dd>
      </div>
      {baseUrlIsLocked ? null : (
        <div>
          <dt>Base URL</dt>
          <dd>
            <code>{profile.baseUrl}</code>
          </dd>
        </div>
      )}
      <div>
        <dt>API key</dt>
        <dd data-ui="connection-key-row">
          {hasKey ? (
            <code>{PLACEHOLDER_KEY}</code>
          ) : requiresKey ? (
            <span data-ui="connection-key-missing">not set</span>
          ) : (
            <span data-ui="connection-key-optional">none — custom endpoint</span>
          )}
          <button type="button" data-ui="connection-edit" onClick={onEdit}>
            Edit
          </button>
        </dd>
      </div>
    </dl>
  )
}

interface ConnectionEditorProps {
  profile: ConnectionProfile
  hasKey: boolean
  onDone: () => void
  onCancel: () => void
  onDeleted: () => void
}

function ConnectionEditor({ profile, hasKey, onDone, onCancel, onDeleted }: ConnectionEditorProps) {
  const [name, setName] = useState(profile.name)
  const [kind, setKind] = useState<ConnectionKind>(profile.kind)
  const [baseUrl, setBaseUrl] = useState(profile.baseUrl)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The Save-as-new flow lets the user pick a new name without dropping the
  // existing profile.
  const [saveAsName, setSaveAsName] = useState('')
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const trimmedKey = keyDraft.trim()
  const lockedBaseUrl = KIND_LOCKED_BASE_URL[kind]
  const baseUrlIsLocked = lockedBaseUrl !== null
  const effectiveBaseUrl = baseUrlIsLocked ? (lockedBaseUrl ?? '') : baseUrl
  const trimmedBaseUrl = effectiveBaseUrl.trim()
  const trimmedName = name.trim()
  const baseUrlValid = useMemo(() => isValidHttpUrl(trimmedBaseUrl), [trimmedBaseUrl])
  const requiresKey = kindRequiresKey(kind)
  const kindChanged = kind !== profile.kind
  // Per the user's rule: "Leave empty to keep existing key" only applies if
  // the provider is unchanged and the kind requires a key. If the user
  // switched provider, the existing key may not even be valid for the new
  // provider, so they must paste a fresh one (or save Custom without one).
  const allowEmptyKey = !kindChanged && hasKey && requiresKey
  const dirty =
    name !== profile.name ||
    kindChanged ||
    effectiveBaseUrl !== profile.baseUrl ||
    trimmedKey.length > 0
  const keyMissing = requiresKey && trimmedKey.length === 0 && !allowEmptyKey
  const canSave = baseUrlValid && trimmedName.length > 0 && dirty && !keyMissing && !busy

  const submit = useCallback(async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      await updateProfile(profile.id, {
        name: trimmedName,
        kind,
        baseUrl: trimmedBaseUrl,
      })
      if (trimmedKey.length > 0) {
        // createKey is an upsert keyed on id; reusing apiKeyRef rotates the
        // ciphertext under the same logical key so every profile + chat that
        // references this id picks up the new secret automatically.
        await createKey({
          id: profile.apiKeyRef,
          name: profile.name,
          plaintextKey: trimmedKey,
        })
      }
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [
    canSave,
    profile.id,
    profile.apiKeyRef,
    profile.name,
    trimmedName,
    kind,
    trimmedBaseUrl,
    trimmedKey,
    onDone,
  ])

  const submitSaveAs = useCallback(async () => {
    const trimmedSaveAsName = saveAsName.trim()
    if (!trimmedSaveAsName || !baseUrlValid || keyMissing) return
    setBusy(true)
    setError(null)
    try {
      // Always create a fresh key for save-as-new (we don't share the key id
      // with the original profile, since the user typically uses save-as to
      // diverge into a separate workspace).
      const created = await createKey({
        name: trimmedSaveAsName,
        plaintextKey: trimmedKey,
      })
      const newProfile = await createProfile({
        name: trimmedSaveAsName,
        kind,
        baseUrl: trimmedBaseUrl,
        apiKeyRef: created.id,
      })
      writeActiveProfileId(newProfile.id)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [baseUrlValid, keyMissing, saveAsName, trimmedKey, kind, trimmedBaseUrl, onDone])

  const submitDelete = useCallback(async () => {
    if (!window.confirm(`Delete connection "${profile.name}"? This cannot be undone.`)) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await deleteProfile(profile.id, { force: true })
      onDeleted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [profile.id, profile.name, onDeleted])

  // Track probe state so the user gets feedback on a live test against
  // whatever baseUrl is currently in the form (not the saved one — the
  // user typically clicks Test BEFORE saving to verify the URL works).
  const [probeState, setProbeState] = useState<
    { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'ok'; message: string }
    | { kind: 'fail'; message: string }
  >({ kind: 'idle' })
  const runProbe = useCallback(async () => {
    if (!baseUrlValid) return
    setProbeState({ kind: 'running' })
    const result = await probeLlamaServer({ baseUrl: trimmedBaseUrl }, { timeoutMs: 3_000 })
    if (result.kind === 'ok') {
      const tpl = result.props.chatTemplate
      const ctx = result.props.defaultContextLength
      const model = result.props.modelPath
      const bits = [model ? model.split('/').pop() : null, ctx ? `ctx ${ctx}` : null, tpl ? 'template detected' : null]
      setProbeState({
        kind: 'ok',
        message: `Reached llama-server in ${result.elapsedMs}ms — ${bits.filter(Boolean).join(' · ') || 'OK'}`,
      })
    } else {
      setProbeState({ kind: 'fail', message: `${result.message} (${result.rootUrl}/props)` })
    }
  }, [baseUrlValid, trimmedBaseUrl])

  return (
    <form
      data-ui="connection-editor"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div data-ui="field-group">
        <label htmlFor="connection-edit-name">Name</label>
        <input
          id="connection-edit-name"
          data-ui="connection-edit-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
        />
      </div>
      <div data-ui="field-group">
        <label htmlFor="connection-edit-kind">Provider</label>
        <select
          id="connection-edit-kind"
          data-ui="connection-edit-kind"
          value={kind}
          onChange={(e) => {
            const next = e.target.value as ConnectionKind
            const prevLock = KIND_LOCKED_BASE_URL[kind]
            setKind(next)
            const nextLock = KIND_LOCKED_BASE_URL[next]
            if (nextLock !== null) {
              // Snap base URL to the canonical endpoint for the new
              // provider so the locked field stays consistent.
              setBaseUrl(nextLock)
            } else if (prevLock !== null) {
              // Previous kind was locked; swap to the default for the
              // new kind instead of carrying an irrelevant URL like
              // https://openrouter.ai/api/v1 over to a llama-server
              // profile.
              setBaseUrl(KIND_DEFAULT_BASE_URL[next])
            }
          }}
        >
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      {baseUrlIsLocked ? null : (
        <div data-ui="field-group">
          <label htmlFor="connection-edit-base-url">Base URL</label>
          <input
            id="connection-edit-base-url"
            data-ui="connection-edit-base-url"
            type="text"
            inputMode="url"
            value={effectiveBaseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            aria-invalid={trimmedBaseUrl.length > 0 && !baseUrlValid}
          />
          {trimmedBaseUrl.length > 0 && !baseUrlValid ? (
            <span data-ui="helper" data-validation="invalid">
              Enter a full URL starting with http:// or https://.
            </span>
          ) : null}
        </div>
      )}
      <div data-ui="field-group">
        <label htmlFor="connection-edit-key">
          API key{!requiresKey ? <em> (optional)</em> : null}
        </label>
        <input
          id="connection-edit-key"
          data-ui="connection-edit-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={
            allowEmptyKey
              ? 'Leave empty to keep existing key'
              : requiresKey
                ? 'Paste API key'
                : 'Optional — leave empty for no key'
          }
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
        />
        <span data-ui="helper">
          {requiresKey
            ? 'The key is stored locally and never displayed back, even to you.'
            : 'Custom endpoints can save without a key (e.g. local servers).'}
        </span>
      </div>
      {kind === 'llama-server' ? (
        <div data-ui="field-group">
          <button
            type="button"
            data-ui="connection-edit-probe"
            onClick={() => void runProbe()}
            disabled={!baseUrlValid || probeState.kind === 'running'}
          >
            {probeState.kind === 'running' ? 'Testing…' : 'Test connection'}
          </button>
          {probeState.kind === 'ok' ? (
            <span data-ui="helper" data-validation="ok">
              {probeState.message}
            </span>
          ) : probeState.kind === 'fail' ? (
            <span data-ui="helper" data-validation="invalid" role="status">
              {probeState.message}
            </span>
          ) : (
            <span data-ui="helper">
              GETs <code>/props</code> on the server root to confirm reachability and read the GGUF's
              chat template.
            </span>
          )}
        </div>
      ) : null}
      {error ? (
        <p data-ui="helper" data-validation="invalid" role="alert">
          {error}
        </p>
      ) : null}
      {saveAsOpen ? (
        <div data-ui="field-group">
          <label htmlFor="connection-save-as-name">New profile name</label>
          <input
            id="connection-save-as-name"
            data-ui="connection-save-as-name"
            type="text"
            placeholder="e.g. OpenRouter (work key)"
            value={saveAsName}
            onChange={(e) => setSaveAsName(e.target.value)}
            maxLength={80}
          />
        </div>
      ) : null}
      <div data-ui="connection-actions">
        <button
          type="button"
          data-ui="connection-edit-delete"
          onClick={() => void submitDelete()}
          disabled={busy}
        >
          Delete
        </button>
        <span data-ui="connection-actions-spacer" />
        {saveAsOpen ? (
          <>
            <button
              type="button"
              data-ui="connection-edit-cancel"
              onClick={() => setSaveAsOpen(false)}
              disabled={busy}
            >
              Cancel save-as
            </button>
            <button
              type="button"
              data-ui="connection-edit-save"
              onClick={() => void submitSaveAs()}
              disabled={busy || !saveAsName.trim() || !baseUrlValid || keyMissing}
            >
              {busy ? 'Saving…' : 'Save as new'}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              data-ui="connection-save-as"
              onClick={() => {
                setSaveAsName(`${profile.name} (copy)`)
                setSaveAsOpen(true)
              }}
              disabled={busy}
            >
              Save as new…
            </button>
            <button
              type="button"
              data-ui="connection-edit-cancel"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button type="submit" data-ui="connection-edit-save" disabled={!canSave}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>
    </form>
  )
}

function hostFor(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function isValidHttpUrl(value: string): boolean {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

interface ConnectionSetupModalProps {
  onClose: () => void
}

function ConnectionSetupModal({ onClose }: ConnectionSetupModalProps) {
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = apiKey.trim()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const submit = useCallback(async () => {
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await runFirstRunSeed({
        apiKey: trimmed,
        model: 'google/gemini-3.1-flash-lite-preview',
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [trimmed, busy, onClose])
  return (
    <div
      data-ui="connection-setup-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Add connection"
    >
      <div
        data-ui="connection-setup-scrim"
        onClick={onClose}
        role="button"
        tabIndex={-1}
        aria-label="Close add-connection dialog"
      />
      <form
        data-ui="connection-setup-modal"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <header>
          <h2>Add connection</h2>
          <button
            type="button"
            data-ui="icon-button"
            data-role="connection-setup-close"
            onClick={onClose}
            aria-label="Close"
          >
            <CloseIcon size={16} />
          </button>
        </header>
        <div data-ui="settings-section">
          <h3>OpenRouter</h3>
          <p data-ui="helper">
            Paste an OpenRouter API key. The first connection is created automatically; you can add
            more from the connection header dropdown once it's set up.
          </p>
          <div data-ui="field-group">
            <label htmlFor="connection-setup-key">API key</label>
            <input
              id="connection-setup-key"
              data-ui="connection-setup-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
        </div>
        <footer>
          {error ? (
            <span data-ui="helper" data-validation="invalid" role="alert">
              {error}
            </span>
          ) : null}
          <button type="submit" data-ui="connection-setup-submit" disabled={busy || !trimmed}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </form>
    </div>
  )
}
