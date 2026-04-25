import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { runAssistantRequestOnce } from '../../api/assistant-stream'
import { fetchModels } from '../../api/models'
import { probeLlamaServer } from '../../api/probe'
import { normalizeModelsResponse } from '../../api/providers'
import { cloneDefaultChatSettings } from '../../core/defaults'
import { normalizeReasoningSettings } from '../../core/reasoning'
import { prepareAssistantRequestPlan } from '../../core/send-planning'
import type {
  Chat,
  ChatId,
  ChatSettings,
  ConnectionKind,
  ConnectionProfile,
  Message,
  PresetId,
  ProfileId,
} from '../../core/types'
import { newId } from '../../lib/ulid'
import { updateChatSettings } from '../../store/chats'
import { createKey, getKey, resolveKey } from '../../store/keys'
import { createPreset } from '../../store/presets'
import {
  bumpProfileLastUsedAt,
  createProfile,
  deleteProfile,
  listProfiles,
  updateProfile,
} from '../../store/profiles'
import { ChevronIcon, CloseIcon, TrashIcon } from '../icons/Icon'

interface HeaderState {
  profile: ConnectionProfile | null
  profiles: ConnectionProfile[]
  hasKey: boolean
}

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; message: string }
  | { kind: 'fail'; message: string }

interface ConnectionSaveResult {
  profileId: ProfileId
  activate: boolean
  resetModel: boolean
}

const ACTIVE_PROFILE_KEY = 'natter:active-profile-id'
const ACTIVE_SEED_KEY = 'natter:active-seed'

interface ActiveSeedState {
  profileId: ProfileId | null
  presetId: PresetId | null
  settings: ChatSettings | null
}

function normalizeActiveSeedState(value: unknown): ActiveSeedState | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { profileId?: unknown; presetId?: unknown; settings?: unknown }
  const profileId =
    typeof candidate.profileId === 'string' ? (candidate.profileId as ProfileId) : null
  const presetId = typeof candidate.presetId === 'string' ? (candidate.presetId as PresetId) : null
  const rawSettings =
    candidate.settings && typeof candidate.settings === 'object'
      ? (candidate.settings as ChatSettings)
      : null
  // SessionStorage may contain settings authored by a pre-Phase-11 build that
  // didn't have `reasoning.include` yet. Heal them on the way in so the seed
  // can't carry a malformed shape into newly-created chats.
  const settings = rawSettings
    ? ({ ...rawSettings, reasoning: normalizeReasoningSettings(rawSettings.reasoning) } as ChatSettings)
    : null
  if (!profileId && !presetId && !settings) return null
  return { profileId, presetId, settings }
}

export function readActiveSeedState(): ActiveSeedState {
  if (typeof window === 'undefined') return { profileId: null, presetId: null, settings: null }
  const raw = window.sessionStorage.getItem(ACTIVE_SEED_KEY)
  if (raw) {
    try {
      const parsed = normalizeActiveSeedState(JSON.parse(raw))
      if (parsed) return parsed
    } catch {
      // Fall through to legacy migration path.
    }
  }
  const legacy = window.localStorage.getItem(ACTIVE_PROFILE_KEY)
  return { profileId: (legacy ?? null) as ProfileId | null, presetId: null, settings: null }
}

export function writeActiveSeedState(state: ActiveSeedState): void {
  if (typeof window === 'undefined') return
  if (state.profileId || state.presetId || state.settings) {
    window.sessionStorage.setItem(
      ACTIVE_SEED_KEY,
      JSON.stringify({
        profileId: state.profileId ?? null,
        presetId: state.presetId ?? null,
        settings: state.settings ?? null,
      }),
    )
  } else {
    window.sessionStorage.removeItem(ACTIVE_SEED_KEY)
  }
  window.localStorage.removeItem(ACTIVE_PROFILE_KEY)
}

export function readActiveProfileId(): ProfileId | null {
  const state = readActiveSeedState()
  return state.settings?.profileId || state.profileId
}

export function writeActiveProfileId(id: ProfileId | null): void {
  if (!id) {
    writeActiveSeedState({ profileId: null, presetId: null, settings: null })
    return
  }
  const current = readActiveSeedState()
  const nextSettings = current.settings
    ? structuredClone(current.settings)
    : cloneDefaultChatSettings()
  const currentProfileId = current.settings?.profileId || current.profileId
  nextSettings.profileId = id
  if (currentProfileId && currentProfileId !== id) nextSettings.model = ''
  writeActiveSeedState({ profileId: id, presetId: null, settings: nextSettings })
}

async function loadHeaderState(
  activeId: ProfileId | null,
  chatProfileId: ProfileId | null,
): Promise<HeaderState> {
  const live = (await listProfiles()).sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
  const chatProfile = chatProfileId ? live.find((p) => p.id === chatProfileId) : undefined
  const fallback = activeId ? live.find((p) => p.id === activeId) : undefined
  const profile = chatProfile ?? fallback ?? live[0] ?? null
  const hasKey = profile ? ((await getKey(profile.apiKeyRef)) ?? null) !== null : false
  return { profile, profiles: live, hasKey }
}

const KIND_LABEL: Record<ConnectionKind, string> = {
  openrouter: 'OpenRouter',
  'openai-compatible': 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'llama-server': 'llama-server (local)',
  custom: 'Custom (OpenAI-compatible)',
}

const KIND_DEFAULT_NAME: Record<ConnectionKind, string> = {
  openrouter: 'OpenRouter',
  'openai-compatible': 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'llama-server': 'llama-server',
  custom: 'Custom',
}

const KIND_ORDER: readonly ConnectionKind[] = [
  'openrouter',
  'openai-compatible',
  'anthropic',
  'google',
  'llama-server',
  'custom',
]

const KIND_LOCKED_BASE_URL: Record<ConnectionKind, string | null> = {
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  'llama-server': null,
  custom: null,
}

const KIND_DEFAULT_BASE_URL: Record<ConnectionKind, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  'llama-server': 'http://127.0.0.1:8080/v1',
  custom: '',
}

function kindRequiresKey(kind: ConnectionKind): boolean {
  return kind !== 'custom' && kind !== 'llama-server'
}

const PLACEHOLDER_KEY = '••••••••••••••••'

const PROBE_MODEL_CANDIDATES: Record<ConnectionKind, readonly string[]> = {
  openrouter: ['anthropic/claude-haiku-4.5', 'openai/gpt-4o-mini'],
  'openai-compatible': ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'],
  anthropic: ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1-20250805'],
  google: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
  'llama-server': [],
  custom: [],
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

function nextBaseUrlForKind(
  currentKind: ConnectionKind,
  nextKind: ConnectionKind,
  currentBaseUrl: string,
): string {
  const nextLock = KIND_LOCKED_BASE_URL[nextKind]
  if (nextLock !== null) return nextLock
  return KIND_LOCKED_BASE_URL[currentKind] !== null
    ? KIND_DEFAULT_BASE_URL[nextKind]
    : currentBaseUrl
}

function buildProbeProfile(kind: ConnectionKind, name: string, baseUrl: string): ConnectionProfile {
  const now = Date.now()
  return {
    id: `probe:${kind}:${name}`,
    name,
    kind,
    baseUrl,
    apiKeyRef: 'probe-key',
    defaultHeaders: {},
    appTitle: 'llm-api-frontend',
    appUrl: '',
    usesResponsesApiByDefault: false,
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: now,
    updatedAt: now,
  }
}

function normalizeProbeModelId(kind: ConnectionKind, modelId: string): string {
  if (kind === 'google' && modelId.startsWith('models/')) {
    return modelId.slice('models/'.length)
  }
  if (kind === 'anthropic') {
    return modelId.replace(/-\d{8}$/u, '').replace(/(\d)\.(\d)(?=-|$)/g, '$1-$2')
  }
  return modelId
}

function pickProbeModel(kind: ConnectionKind, modelIds: string[]): string {
  const candidates = PROBE_MODEL_CANDIDATES[kind]
  for (const candidate of candidates) {
    const hit = modelIds.find((modelId) => normalizeProbeModelId(kind, modelId) === candidate)
    if (hit) return hit
  }
  return modelIds[0] ?? candidates[0] ?? ''
}

function probeUserMessage(): Message {
  return {
    id: 'probe-user',
    chatId: 'probe-chat',
    parentId: null,
    siblingIndex: 0,
    turnId: 'probe-turn',
    turnIndex: 0,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'Reply with the single word ok.' }],
    createdAt: 1,
    nodeVersion: 0,
    deleted: false,
  }
}

function probeChat(settings: ChatSettings): Chat {
  return {
    id: 'probe-chat',
    title: 'Connection probe',
    titleStatus: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    settings,
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

function keyErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function runConnectionTest(opts: {
  kind: ConnectionKind
  name: string
  baseUrl: string
  apiKey: string | null
}): Promise<ProbeState> {
  if (!isValidHttpUrl(opts.baseUrl)) {
    return { kind: 'fail', message: 'Enter a full URL starting with http:// or https://.' }
  }
  if (opts.kind === 'llama-server') {
    const result = await probeLlamaServer({ baseUrl: opts.baseUrl }, { timeoutMs: 3_000 })
    if (result.kind === 'ok') {
      const tpl = result.props.chatTemplate
      const ctx = result.props.defaultContextLength
      const model = result.props.modelPath
      const bits = [
        model ? model.split('/').pop() : null,
        ctx ? `ctx ${ctx}` : null,
        tpl ? 'template detected' : null,
      ]
      return {
        kind: 'ok',
        message: `Reached llama-server in ${result.elapsedMs}ms — ${bits.filter(Boolean).join(' · ') || 'OK'}`,
      }
    }
    return {
      kind: 'fail',
      message: `${result.message} (${result.rootUrl}/props)`,
    }
  }
  if (kindRequiresKey(opts.kind) && !opts.apiKey) {
    return { kind: 'fail', message: 'Set an API key before testing this profile.' }
  }
  const started = performance.now()
  try {
    const probeProfile = buildProbeProfile(opts.kind, opts.name, opts.baseUrl)
    let modelIds: string[] = []
    try {
      const payload = await fetchModels(
        {
          profile: probeProfile,
          apiKey: opts.apiKey ?? '',
        },
        {},
        { timeoutMs: 3_000 },
      )
      modelIds = normalizeModelsResponse(payload).map((row) =>
        normalizeProbeModelId(opts.kind, row.id),
      )
    } catch {
      // Some OpenAI-compatible layers (notably Anthropic) accept chat
      // completions but do not provide a bearer-authenticated /models list.
      // The actual test path is a tiny completion below, so model discovery
      // failures are advisory rather than fatal here.
    }
    const model = pickProbeModel(opts.kind, modelIds)
    if (!model) {
      return {
        kind: 'fail',
        message: 'Could not choose a model to test.',
      }
    }
    const settings = cloneDefaultChatSettings()
    settings.profileId = probeProfile.id
    settings.model = model
    const { requestPlan } = await prepareAssistantRequestPlan({
      chat: probeChat(settings),
      connection: probeProfile,
      pathMessages: [probeUserMessage()],
      settings,
      stream: false,
      debugSource: 'connection-probe',
    })
    await runAssistantRequestOnce({
      connection: probeProfile,
      apiKey: opts.apiKey ?? '',
      requestPlan,
    })
    const elapsedMs = Math.round(performance.now() - started)
    return {
      kind: 'ok',
      message: `Completed test chat in ${elapsedMs}ms — ${model}`,
    }
  } catch (error) {
    return { kind: 'fail', message: keyErrorMessage(error) }
  }
}

export interface ConnectionHeaderProps {
  activeChatId?: ChatId | null
  activeChatProfileId?: ProfileId | null
}

export function ConnectionHeader({
  activeChatId = null,
  activeChatProfileId = null,
}: ConnectionHeaderProps = {}) {
  const [activeId, setActiveId] = useState<ProfileId | null>(() => readActiveProfileId())
  const liveState = useLiveQuery(
    () => loadHeaderState(activeId, activeChatProfileId),
    [activeId, activeChatProfileId],
    undefined,
  )
  const stateCacheRef = useRef<HeaderState>({ profile: null, profiles: [], hasKey: false })
  useEffect(() => {
    if (liveState === undefined) return
    stateCacheRef.current = liveState
  }, [liveState])
  const state = liveState ?? stateCacheRef.current
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [probeState, setProbeState] = useState<ProbeState>({ kind: 'idle' })
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const hasConnection = state.profile !== null

  useEffect(() => {
    setEditing(false)
    setProbeState({ kind: 'idle' })
    setDeleteConfirmOpen(false)
  }, [])

  const activateProfile = useCallback(
    async (id: ProfileId, opts: { resetModel?: boolean } = {}) => {
      writeActiveProfileId(id)
      setActiveId(id)
      await bumpProfileLastUsedAt(id)
      if (!activeChatId) return
      const patch: { profileId: ProfileId; model?: string } = { profileId: id }
      if (opts.resetModel) patch.model = ''
      await updateChatSettings(activeChatId, patch)
    },
    [activeChatId],
  )

  const switchProfile = useCallback(
    async (id: ProfileId) => {
      await activateProfile(id, { resetModel: true })
    },
    [activateProfile],
  )

  const applySaveResult = useCallback(
    async (result: ConnectionSaveResult) => {
      setEditing(false)
      setSetupOpen(false)
      if (result.activate) {
        await activateProfile(result.profileId, { resetModel: result.resetModel })
        return
      }
      if (activeChatId && activeChatProfileId === result.profileId && result.resetModel) {
        await updateChatSettings(activeChatId, { model: '' })
      }
    },
    [activateProfile, activeChatId, activeChatProfileId],
  )

  const deleteCurrentProfile = useCallback(async () => {
    const profile = state.profile
    if (!profile) return
    setDeleteBusy(true)
    try {
      await deleteProfile(profile.id, { force: true })
      setEditing(false)
      setDeleteConfirmOpen(false)
      writeActiveProfileId(null)
      setActiveId(null)
    } finally {
      setDeleteBusy(false)
    }
  }, [state.profile])

  const runSavedProfileTest = useCallback(async () => {
    const profile = state.profile
    if (!profile) return
    setProbeState({ kind: 'running' })
    try {
      let apiKey: string | null = null
      if (kindRequiresKey(profile.kind)) {
        apiKey = await resolveKey(profile.apiKeyRef)
      }
      setProbeState(
        await runConnectionTest({
          kind: profile.kind,
          name: profile.name,
          baseUrl: profile.baseUrl,
          apiKey,
        }),
      )
    } catch (error) {
      setProbeState({ kind: 'fail', message: keyErrorMessage(error) })
    }
  }, [state.profile])

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
        {setupOpen ? (
          <ConnectionSetupModal
            hasExistingConnections={false}
            onClose={() => setSetupOpen(false)}
            onSaved={applySaveResult}
          />
        ) : null}
      </section>
    )
  }

  const { profile, profiles, hasKey } = state
  const status: 'ready' | 'no-key' = hasKey || !kindRequiresKey(profile.kind) ? 'ready' : 'no-key'

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
                : 'No key required'
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
              hasKey={hasKey}
              deleteBusy={deleteBusy}
              onDone={applySaveResult}
              onCancel={() => setEditing(false)}
              onDelete={() => setDeleteConfirmOpen(true)}
            />
          ) : (
            <ConnectionViewer
              profile={profile}
              hasKey={hasKey}
              deleteBusy={deleteBusy}
              probeState={probeState}
              onEdit={() => setEditing(true)}
              onTest={runSavedProfileTest}
              onDelete={() => setDeleteConfirmOpen(true)}
            />
          )}
        </div>
      ) : null}
      {setupOpen ? (
        <ConnectionSetupModal
          hasExistingConnections={profiles.length > 0}
          onClose={() => setSetupOpen(false)}
          onSaved={applySaveResult}
        />
      ) : null}
      {deleteConfirmOpen ? (
        <ConnectionDeleteDialog
          profileName={profile.name}
          busy={deleteBusy}
          onCancel={() => setDeleteConfirmOpen(false)}
          onConfirm={deleteCurrentProfile}
        />
      ) : null}
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
        + New profile
      </button>
    </div>
  )
}

function ConnectionDeleteDialog({
  profileName,
  busy,
  onCancel,
  onConfirm,
}: {
  profileName: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void | Promise<void>
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div data-ui="confirm-delete-overlay">
      <button
        type="button"
        data-ui="confirm-delete-scrim"
        aria-label="Cancel connection delete"
        tabIndex={-1}
        onClick={onCancel}
      />
      <div
        data-ui="confirm-delete"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-connection-title"
      >
        <div data-ui="confirm-delete-header">
          <h2 id="delete-connection-title">Delete connection?</h2>
          <button
            type="button"
            data-ui="icon-button"
            data-size="sm"
            data-role="confirm-delete-close"
            aria-label="Cancel delete"
            onClick={onCancel}
            disabled={busy}
          >
            <CloseIcon size={14} />
          </button>
        </div>
        <blockquote data-ui="confirm-delete-preview">
          Delete <strong>{profileName}</strong>? This cannot be undone.
        </blockquote>
        <div data-ui="confirm-delete-actions">
          <button
            type="button"
            data-ui="confirm-delete-button"
            data-role="cancel"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            data-ui="confirm-delete-button"
            data-role="confirm"
            data-tone="danger"
            onClick={() => void onConfirm()}
            disabled={busy}
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface ConnectionViewerProps {
  profile: ConnectionProfile
  hasKey: boolean
  deleteBusy: boolean
  probeState: ProbeState
  onEdit: () => void
  onTest: () => void | Promise<void>
  onDelete: () => void | Promise<void>
}

function ConnectionViewer({
  profile,
  hasKey,
  deleteBusy,
  probeState,
  onEdit,
  onTest,
  onDelete,
}: ConnectionViewerProps) {
  const requiresKey = kindRequiresKey(profile.kind)
  const baseUrlIsLocked = KIND_LOCKED_BASE_URL[profile.kind] !== null

  return (
    <div data-ui="connection-viewer">
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
          <dd>
            {hasKey ? (
              <code>{PLACEHOLDER_KEY}</code>
            ) : requiresKey ? (
              <span data-ui="connection-key-missing">not set</span>
            ) : (
              <span data-ui="connection-key-optional">none — custom endpoint</span>
            )}
          </dd>
        </div>
      </dl>
      <div data-ui="connection-actions">
        <div data-ui="connection-actions-leading">
          <button type="button" data-ui="connection-edit" onClick={onEdit}>
            Edit
          </button>
          <button type="button" data-ui="connection-test" onClick={() => void onTest()}>
            {probeState.kind === 'running' ? 'Testing…' : 'Test'}
          </button>
        </div>
        <div data-ui="connection-actions-trailing">
          <button
            type="button"
            data-ui="connection-delete"
            data-role="connection-delete"
            onClick={() => void onDelete()}
            disabled={deleteBusy}
            aria-label="Delete connection"
            title="Delete connection"
          >
            <TrashIcon size={13} />
          </button>
        </div>
      </div>
      <ConnectionProbeMessage state={probeState} />
      <ConnectionRoutingControls profile={profile} />
    </div>
  )
}

// Per-kind API-routing controls that live directly on the connection.
// Visible outside edit mode because they're transport preferences, not
// identity fields — flipping them shouldn't force a Save cycle. Changes are
// applied via updateProfile() immediately. See `plan/10-ui.md §10.17.5` and
// `plan/phase11-implementation.md §6`.
function ConnectionRoutingControls({ profile }: { profile: ConnectionProfile }) {
  // OpenRouter doesn't have a user-facing routing choice: chat completions is
  // the default, and Responses is auto-upgraded by the quirks registry when
  // needed. Show a static note rather than a no-op toggle.
  if (profile.kind === 'openrouter') {
    return (
      <details data-ui="connection-routing" data-kind="openrouter">
        <summary>API routing</summary>
        <p data-ui="helper">
          OpenRouter uses chat completions by default. Responses is auto-upgraded for models that
          need it (gpt-5.4 family, encrypted-reasoning preservation, server-tool outputs).
        </p>
      </details>
    )
  }
  if (profile.kind === 'google') {
    return <GoogleRoutingControls profile={profile} />
  }
  if (profile.kind === 'openai-compatible') {
    return <OpenAIRoutingControls profile={profile} />
  }
  // anthropic / llama-server / custom: no routing choice at the connection
  // level. Hide entirely rather than rendering an empty disclosure.
  return null
}

function GoogleRoutingControls({ profile }: { profile: ConnectionProfile }) {
  const mode = profile.geminiMode ?? 'native'
  const allowImported = profile.geminiDefaults?.allowImportedWithoutSignature ?? false
  return (
    <details data-ui="connection-routing" data-kind="google" open>
      <summary>API routing</summary>
      <div data-ui="connection-routing-body">
        <fieldset data-ui="connection-routing-radio-group">
          <legend>Gemini mode</legend>
          <label data-ui="connection-routing-radio">
            <input
              type="radio"
              name={`gemini-mode-${profile.id}`}
              value="native"
              checked={mode === 'native'}
              onChange={() => void updateProfile(profile.id, { geminiMode: 'native' })}
            />
            <span>
              Native <em>(recommended)</em>
            </span>
          </label>
          <label data-ui="connection-routing-radio">
            <input
              type="radio"
              name={`gemini-mode-${profile.id}`}
              value="openai-compat"
              checked={mode === 'openai-compat'}
              onChange={() => void updateProfile(profile.id, { geminiMode: 'openai-compat' })}
            />
            <span>OpenAI-compat</span>
          </label>
          <span data-ui="helper">
            Native preserves <code>thoughtSignature</code> on every turn — required for multi-turn
            reasoning round-trip on Gemini 3. OpenAI-compat only preserves signatures on
            function-call turns.
          </span>
        </fieldset>
        <details data-ui="connection-routing-advanced">
          <summary>Advanced</summary>
          <label data-ui="reasoning-checkbox">
            <input
              type="checkbox"
              checked={allowImported}
              onChange={(e) =>
                void updateProfile(profile.id, {
                  geminiDefaults: {
                    allowImportedWithoutSignature: e.target.checked,
                  },
                })
              }
            />
            <span>
              Allow imported chats without <code>thoughtSignature</code>
            </span>
          </label>
          <span data-ui="helper">
            Substitutes <code>"skip_thought_signature_validator"</code> for missing signatures on
            echoed turns so Gemini 3 doesn't 400 on chats imported from other frontends.
          </span>
        </details>
      </div>
    </details>
  )
}

function OpenAIRoutingControls({ profile }: { profile: ConnectionProfile }) {
  const usesResponses = profile.usesResponsesApiByDefault ?? false
  const store = profile.responsesDefaults?.store ?? false
  const includeEncrypted = profile.responsesDefaults?.includeEncrypted ?? true
  return (
    <details data-ui="connection-routing" data-kind="openai-compatible" open>
      <summary>API routing</summary>
      <div data-ui="connection-routing-body">
        <fieldset data-ui="connection-routing-radio-group">
          <legend>Default API</legend>
          <label data-ui="connection-routing-radio">
            <input
              type="radio"
              name={`openai-default-api-${profile.id}`}
              value="responses"
              checked={usesResponses}
              onChange={() => void updateProfile(profile.id, { usesResponsesApiByDefault: true })}
            />
            <span>
              Responses <em>(recommended)</em>
            </span>
          </label>
          <label data-ui="connection-routing-radio">
            <input
              type="radio"
              name={`openai-default-api-${profile.id}`}
              value="chat"
              checked={!usesResponses}
              onChange={() => void updateProfile(profile.id, { usesResponsesApiByDefault: false })}
            />
            <span>Chat completions</span>
          </label>
          <span data-ui="helper">
            Responses preserves encrypted reasoning across turns. Chat completions is cheaper on
            request setup but drops encrypted_content.
          </span>
        </fieldset>
        <details data-ui="connection-routing-advanced">
          <summary>Advanced</summary>
          <label data-ui="reasoning-checkbox">
            <input
              type="checkbox"
              checked={store}
              onChange={(e) =>
                void updateProfile(profile.id, {
                  responsesDefaults: {
                    store: e.target.checked,
                    includeEncrypted,
                  },
                })
              }
            />
            <span>
              Pass <code>store: true</code> upstream
            </span>
          </label>
          <span data-ui="helper">
            OpenAI retains the response for 30 days. Required for <code>previous_response_id</code>;
            disabled by default for privacy.
          </span>
          <label data-ui="reasoning-checkbox">
            <input
              type="checkbox"
              checked={includeEncrypted}
              onChange={(e) =>
                void updateProfile(profile.id, {
                  responsesDefaults: {
                    store,
                    includeEncrypted: e.target.checked,
                  },
                })
              }
            />
            <span>Include encrypted reasoning in requests</span>
          </label>
          <span data-ui="helper">
            Sends <code>include: ["reasoning.encrypted_content"]</code> on all Responses calls.
            Leave on unless you want to strip reasoning at the wire level.
          </span>
        </details>
      </div>
    </details>
  )
}

interface ConnectionEditorProps {
  profile: ConnectionProfile
  hasKey: boolean
  deleteBusy: boolean
  onDone: (result: ConnectionSaveResult) => void | Promise<void>
  onCancel: () => void
  onDelete: () => void | Promise<void>
}

function ConnectionEditor({
  profile,
  hasKey,
  deleteBusy,
  onDone,
  onCancel,
  onDelete,
}: ConnectionEditorProps) {
  const [name, setName] = useState(profile.name)
  const [kind, setKind] = useState<ConnectionKind>(profile.kind)
  const [baseUrl, setBaseUrl] = useState(profile.baseUrl)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [probeState, setProbeState] = useState<ProbeState>({ kind: 'idle' })

  const trimmedKey = keyDraft.trim()
  const trimmedName = name.trim()
  const originalName = profile.name.trim()
  const saveAsNew = trimmedName !== originalName
  const lockedBaseUrl = KIND_LOCKED_BASE_URL[kind]
  const baseUrlIsLocked = lockedBaseUrl !== null
  const effectiveBaseUrl = baseUrlIsLocked ? (lockedBaseUrl ?? '') : baseUrl
  const trimmedBaseUrl = effectiveBaseUrl.trim()
  const baseUrlValid = useMemo(() => isValidHttpUrl(trimmedBaseUrl), [trimmedBaseUrl])
  const requiresKey = kindRequiresKey(kind)
  const dirty =
    trimmedName !== originalName ||
    kind !== profile.kind ||
    trimmedBaseUrl !== profile.baseUrl ||
    trimmedKey.length > 0
  const canSave = baseUrlValid && trimmedName.length > 0 && dirty && !busy

  useEffect(() => {
    setProbeState({ kind: 'idle' })
  }, [])

  const runProbe = useCallback(async () => {
    setProbeState({ kind: 'running' })
    try {
      let apiKey: string | null = null
      if (trimmedKey.length > 0) {
        apiKey = trimmedKey
      } else if (!saveAsNew && hasKey && kindRequiresKey(kind)) {
        apiKey = await resolveKey(profile.apiKeyRef)
      }
      setProbeState(
        await runConnectionTest({
          kind,
          name: trimmedName || profile.name,
          baseUrl: trimmedBaseUrl,
          apiKey,
        }),
      )
    } catch (probeError) {
      setProbeState({ kind: 'fail', message: keyErrorMessage(probeError) })
    }
  }, [
    trimmedKey,
    saveAsNew,
    hasKey,
    kind,
    profile.apiKeyRef,
    profile.name,
    trimmedName,
    trimmedBaseUrl,
  ])

  const keyPlaceholder = saveAsNew
    ? requiresKey
      ? 'Optional — leave empty to save without a key'
      : 'Optional — leave empty for no key'
    : hasKey
      ? 'Leave empty to keep existing key'
      : requiresKey
        ? 'Optional — this profile currently has no key'
        : 'Optional — leave empty for no key'

  const keyHelper = saveAsNew
    ? requiresKey
      ? 'New name creates a new profile. Leave the key empty to save it with no key.'
      : 'New name creates a new profile. Custom and local endpoints can save without a key.'
    : hasKey
      ? 'Saving in place. Leave the key empty to keep the existing key.'
      : requiresKey
        ? 'Saving in place. This profile stays no-key until you paste one.'
        : 'Custom and local endpoints can save without a key.'

  const submit = useCallback(async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      const resetModel = kind !== profile.kind || trimmedBaseUrl !== profile.baseUrl
      if (saveAsNew) {
        const apiKeyRef =
          trimmedKey.length > 0
            ? (
                await createKey({
                  name: trimmedName,
                  plaintextKey: trimmedKey,
                })
              ).id
            : newId()
        const created = await createProfile({
          name: trimmedName,
          kind,
          baseUrl: trimmedBaseUrl,
          apiKeyRef,
        })
        await onDone({ profileId: created.id, activate: true, resetModel })
      } else {
        await updateProfile(profile.id, {
          name: trimmedName,
          kind,
          baseUrl: trimmedBaseUrl,
        })
        if (trimmedKey.length > 0) {
          await createKey({
            id: profile.apiKeyRef,
            name: trimmedName,
            plaintextKey: trimmedKey,
          })
        }
        await onDone({ profileId: profile.id, activate: false, resetModel })
      }
    } catch (submitError) {
      setError(keyErrorMessage(submitError))
    } finally {
      setBusy(false)
    }
  }, [
    canSave,
    kind,
    onDone,
    profile.apiKeyRef,
    profile.baseUrl,
    profile.id,
    profile.kind,
    saveAsNew,
    trimmedBaseUrl,
    trimmedKey,
    trimmedName,
  ])

  return (
    <form
      data-ui="connection-editor"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <ConnectionFormFields
        prefix="connection-edit"
        name={name}
        kind={kind}
        baseUrl={effectiveBaseUrl}
        baseUrlValid={baseUrlValid}
        trimmedBaseUrl={trimmedBaseUrl}
        keyDraft={keyDraft}
        keyPlaceholder={keyPlaceholder}
        keyHelper={keyHelper}
        requiresKey={requiresKey}
        onNameChange={setName}
        onKindChange={(next) => {
          setKind(next)
          const nextLock = KIND_LOCKED_BASE_URL[next]
          if (nextLock !== null) {
            setBaseUrl(nextLock)
            return
          }
          setBaseUrl(nextBaseUrlForKind(kind, next, baseUrl))
        }}
        onBaseUrlChange={setBaseUrl}
        onKeyChange={setKeyDraft}
      />
      <div data-ui="connection-actions">
        <div data-ui="connection-actions-leading">
          <button
            type="button"
            data-ui="connection-test"
            onClick={() => void runProbe()}
            disabled={busy || !baseUrlValid}
          >
            {probeState.kind === 'running' ? 'Testing…' : 'Test'}
          </button>
        </div>
        <div data-ui="connection-actions-trailing">
          <button
            type="button"
            data-ui="connection-delete"
            data-role="connection-delete"
            onClick={() => void onDelete()}
            disabled={busy || deleteBusy}
            aria-label="Delete connection"
            title="Delete connection"
          >
            <TrashIcon size={13} />
          </button>
          <button type="button" data-ui="connection-edit-cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" data-ui="connection-edit-save" disabled={!canSave}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <ConnectionProbeMessage state={probeState} />
      {error ? (
        <p data-ui="helper" data-validation="invalid" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}

function ConnectionProbeMessage({ state }: { state: ProbeState }) {
  if (state.kind === 'idle' || state.kind === 'running') return null
  return (
    <p
      data-ui="helper"
      data-validation={state.kind === 'ok' ? 'ok' : 'invalid'}
      role={state.kind === 'fail' ? 'status' : undefined}
    >
      {state.message}
    </p>
  )
}

interface ConnectionFormFieldsProps {
  prefix: 'connection-edit' | 'connection-setup'
  name: string
  kind: ConnectionKind
  baseUrl: string
  baseUrlValid: boolean
  trimmedBaseUrl: string
  keyDraft: string
  keyPlaceholder: string
  keyHelper: string
  requiresKey: boolean
  onNameChange: (value: string) => void
  onKindChange: (value: ConnectionKind) => void
  onBaseUrlChange: (value: string) => void
  onKeyChange: (value: string) => void
}

function ConnectionFormFields({
  prefix,
  name,
  kind,
  baseUrl,
  baseUrlValid,
  trimmedBaseUrl,
  keyDraft,
  keyPlaceholder,
  keyHelper,
  requiresKey,
  onNameChange,
  onKindChange,
  onBaseUrlChange,
  onKeyChange,
}: ConnectionFormFieldsProps) {
  const baseUrlIsLocked = KIND_LOCKED_BASE_URL[kind] !== null

  return (
    <>
      <div data-ui="field-group">
        <label htmlFor={`${prefix}-name`}>Name</label>
        <input
          id={`${prefix}-name`}
          data-ui={`${prefix}-name`}
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          maxLength={80}
        />
      </div>
      <div data-ui="field-group">
        <label htmlFor={`${prefix}-kind`}>Provider</label>
        <select
          id={`${prefix}-kind`}
          data-ui={`${prefix}-kind`}
          value={kind}
          onChange={(e) => onKindChange(e.target.value as ConnectionKind)}
        >
          {KIND_ORDER.map((value) => (
            <option key={value} value={value}>
              {KIND_LABEL[value]}
            </option>
          ))}
        </select>
      </div>
      {baseUrlIsLocked ? null : (
        <div data-ui="field-group">
          <label htmlFor={`${prefix}-base-url`}>Base URL</label>
          <input
            id={`${prefix}-base-url`}
            data-ui={`${prefix}-base-url`}
            type="text"
            inputMode="url"
            value={baseUrl}
            onChange={(e) => onBaseUrlChange(e.target.value)}
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
        <label htmlFor={`${prefix}-key`}>API key{!requiresKey ? <em> (optional)</em> : null}</label>
        <input
          id={`${prefix}-key`}
          data-ui={`${prefix}-key`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={keyPlaceholder}
          value={keyDraft}
          onChange={(e) => onKeyChange(e.target.value)}
        />
        <span data-ui="helper">{keyHelper}</span>
      </div>
    </>
  )
}

interface ConnectionSetupModalProps {
  hasExistingConnections: boolean
  onClose: () => void
  onSaved: (result: ConnectionSaveResult) => void | Promise<void>
}

function ConnectionSetupModal({
  hasExistingConnections,
  onClose,
  onSaved,
}: ConnectionSetupModalProps) {
  const [name, setName] = useState(KIND_DEFAULT_NAME.openrouter)
  const [kind, setKind] = useState<ConnectionKind>('openrouter')
  const [baseUrl, setBaseUrl] = useState(KIND_DEFAULT_BASE_URL.openrouter)
  const [keyDraft, setKeyDraft] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [probeState, setProbeState] = useState<ProbeState>({ kind: 'idle' })

  const trimmedName = name.trim()
  const trimmedKey = keyDraft.trim()
  const lockedBaseUrl = KIND_LOCKED_BASE_URL[kind]
  const baseUrlIsLocked = lockedBaseUrl !== null
  const effectiveBaseUrl = baseUrlIsLocked ? (lockedBaseUrl ?? '') : baseUrl
  const trimmedBaseUrl = effectiveBaseUrl.trim()
  const baseUrlValid = useMemo(() => isValidHttpUrl(trimmedBaseUrl), [trimmedBaseUrl])
  const requiresKey = kindRequiresKey(kind)
  const mustProvideKey = requiresKey && !hasExistingConnections
  const canSave =
    baseUrlValid && trimmedName.length > 0 && (!mustProvideKey || trimmedKey.length > 0) && !busy
  const keyPlaceholder = mustProvideKey
    ? 'Paste API key'
    : requiresKey
      ? 'Optional — leave empty to save without a key'
      : 'Optional — leave empty for no key'
  const keyHelper = mustProvideKey
    ? 'The first hosted connection must include a key so the app can talk to it.'
    : requiresKey
      ? 'Hosted providers can save without a key, but sends and tests stay blocked until you add one.'
      : 'Custom and local endpoints can save without a key.'

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

  useEffect(() => {
    setProbeState({ kind: 'idle' })
  }, [])

  const onKindChange = useCallback(
    (next: ConnectionKind) => {
      const previousDefault = KIND_DEFAULT_NAME[kind]
      setKind(next)
      const nextLock = KIND_LOCKED_BASE_URL[next]
      setBaseUrl(nextLock ?? nextBaseUrlForKind(kind, next, baseUrl))
      if (!nameTouched || name.trim() === previousDefault) {
        setName(KIND_DEFAULT_NAME[next])
      }
    },
    [baseUrl, kind, name, nameTouched],
  )

  const runProbe = useCallback(async () => {
    setProbeState({ kind: 'running' })
    setProbeState(
      await runConnectionTest({
        kind,
        name: trimmedName || KIND_DEFAULT_NAME[kind],
        baseUrl: trimmedBaseUrl,
        apiKey: trimmedKey.length > 0 ? trimmedKey : null,
      }),
    )
  }, [kind, trimmedName, trimmedBaseUrl, trimmedKey])

  const submit = useCallback(async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      const now = Date.now()
      const apiKeyRef =
        trimmedKey.length > 0
          ? (
              await createKey({
                name: trimmedName,
                plaintextKey: trimmedKey,
                now,
              })
            ).id
          : newId()
      const profile = await createProfile({
        name: trimmedName,
        kind,
        baseUrl: trimmedBaseUrl,
        apiKeyRef,
        now,
      })
      if (!hasExistingConnections) {
        const settings = cloneDefaultChatSettings()
        settings.profileId = profile.id
        await createPreset({
          name: `${profile.name} default`,
          connectionProfileId: profile.id,
          settings,
          lastUsedAt: now,
          now,
        })
      }
      await onSaved({ profileId: profile.id, activate: true, resetModel: true })
    } catch (submitError) {
      setError(keyErrorMessage(submitError))
    } finally {
      setBusy(false)
    }
  }, [canSave, hasExistingConnections, kind, onSaved, trimmedBaseUrl, trimmedKey, trimmedName])

  return (
    <div
      data-ui="connection-setup-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Add connection"
    >
      <button
        type="button"
        data-ui="connection-setup-scrim"
        onClick={onClose}
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
          <ConnectionFormFields
            prefix="connection-setup"
            name={name}
            kind={kind}
            baseUrl={effectiveBaseUrl}
            baseUrlValid={baseUrlValid}
            trimmedBaseUrl={trimmedBaseUrl}
            keyDraft={keyDraft}
            keyPlaceholder={keyPlaceholder}
            keyHelper={keyHelper}
            requiresKey={requiresKey}
            onNameChange={(value) => {
              setName(value)
              setNameTouched(true)
            }}
            onKindChange={onKindChange}
            onBaseUrlChange={setBaseUrl}
            onKeyChange={setKeyDraft}
          />
          <div data-ui="connection-actions">
            <div data-ui="connection-actions-leading">
              <button
                type="button"
                data-ui="connection-test"
                onClick={() => void runProbe()}
                disabled={busy || !baseUrlValid}
              >
                {probeState.kind === 'running' ? 'Testing…' : 'Test'}
              </button>
            </div>
            <div data-ui="connection-actions-trailing">
              <button
                type="button"
                data-ui="connection-edit-cancel"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button type="submit" data-ui="connection-setup-submit" disabled={!canSave}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
          <ConnectionProbeMessage state={probeState} />
          {error ? (
            <span data-ui="helper" data-validation="invalid" role="alert">
              {error}
            </span>
          ) : null}
        </div>
      </form>
    </div>
  )
}
