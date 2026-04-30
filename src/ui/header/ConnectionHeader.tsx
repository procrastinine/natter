import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { runAssistantRequestOnce } from '../../api/assistant-stream'
import { fetchModels } from '../../api/models'
import { probeLlamaServer } from '../../api/probe'
import { normalizeModelsResponse } from '../../api/providers'
import { cloneDefaultChatSettings } from '../../core/defaults'
import { defaultApiForProfile, withProfileApiDefaults } from '../../core/provider-defaults'
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
  getProfile,
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
    typeof candidate.profileId === 'string' ? (candidate.profileId) : null
  const presetId = typeof candidate.presetId === 'string' ? (candidate.presetId) : null
  const rawSettings =
    candidate.settings && typeof candidate.settings === 'object'
      ? (candidate.settings as ChatSettings)
      : null
  const settings = rawSettings ? structuredClone(rawSettings) : null
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
      window.sessionStorage.removeItem(ACTIVE_SEED_KEY)
    }
  }
  return { profileId: null, presetId: null, settings: null }
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
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: kind === 'openrouter',
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
    const probeSettings = withProfileApiDefaults(settings, probeProfile)
    const { requestPlan } = await prepareAssistantRequestPlan({
      chat: probeChat(probeSettings),
      connection: probeProfile,
      pathMessages: [probeUserMessage()],
      settings: probeSettings,
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

interface ConnectionHeaderProps {
  activeChatId?: ChatId | null
  activeChatProfileId?: ProfileId | null
  variant?: 'empty-action' | 'title-icon'
}

export function ConnectionHeader({
  activeChatId = null,
  activeChatProfileId = null,
  variant = 'empty-action',
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
  const titleEntryRef = useRef<HTMLDivElement | null>(null)
  const probeRunRef = useRef(0)
  const hasConnection = state.profile !== null
  const selectedProfileId = state.profile?.id ?? null

  const resetProbeState = useCallback(() => {
    probeRunRef.current += 1
    setProbeState({ kind: 'idle' })
  }, [])

  useEffect(() => {
    setEditing(false)
    resetProbeState()
    setDeleteConfirmOpen(false)
  }, [selectedProfileId, resetProbeState])

  useEffect(() => {
    if (variant !== 'title-icon' || !open) return
    const onPointerDown = (event: PointerEvent) => {
      const root = titleEntryRef.current
      if (!root || root.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [variant, open])

  const activateProfile = useCallback(
    async (id: ProfileId, opts: { resetModel?: boolean } = {}) => {
      writeActiveProfileId(id)
      setActiveId(id)
      await bumpProfileLastUsedAt(id)
      if (!activeChatId) return
      const profile = state.profiles.find((candidate) => candidate.id === id) ?? (await getProfile(id))
      const patch: { profileId: ProfileId; model?: string; api?: ChatSettings['api'] } = {
        profileId: id,
      }
      if (opts.resetModel) patch.model = ''
      if (profile && opts.resetModel) patch.api = defaultApiForProfile(profile)
      await updateChatSettings(activeChatId, patch)
    },
    [activeChatId, state.profiles],
  )

  const switchProfile = useCallback(
    async (id: ProfileId) => {
      if (id !== selectedProfileId) {
        setEditing(false)
        resetProbeState()
        setDeleteConfirmOpen(false)
      }
      await activateProfile(id, { resetModel: true })
    },
    [activateProfile, resetProbeState, selectedProfileId],
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
    const probeRun = ++probeRunRef.current
    setProbeState({ kind: 'running' })
    try {
      let apiKey: string | null = null
      if (kindRequiresKey(profile.kind)) {
        apiKey = await resolveKey(profile.apiKeyRef)
      }
      const nextState = await runConnectionTest({
        kind: profile.kind,
        name: profile.name,
        baseUrl: profile.baseUrl,
        apiKey,
      })
      if (probeRunRef.current === probeRun) setProbeState(nextState)
    } catch (error) {
      if (probeRunRef.current === probeRun) {
        setProbeState({ kind: 'fail', message: keyErrorMessage(error) })
      }
    }
  }, [state.profile])

  if (!hasConnection || !state.profile) {
    if (variant === 'title-icon') return null
    return (
      <div data-ui="connection-empty-action">
        <button type="button" data-ui="connection-add" onClick={() => setSetupOpen(true)}>
          Add connection
        </button>
        {setupOpen ? (
          <ConnectionSetupModal
            hasExistingConnections={false}
            onClose={() => setSetupOpen(false)}
            onSaved={applySaveResult}
          />
        ) : null}
      </div>
    )
  }

  const { profile, profiles, hasKey } = state
  const status: 'ready' | 'no-key' = hasKey || !kindRequiresKey(profile.kind) ? 'ready' : 'no-key'
  if (variant !== 'title-icon') return null
  const detailId = 'connection-title-detail'
  const connectionRow = (
    <button
      type="button"
      data-ui="connection-row"
      aria-expanded={open}
      aria-controls={detailId}
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
  )
  const connectionDetail = open ? (
    <div data-ui="connection-detail" id={detailId}>
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
  ) : null

  return (
    <div data-ui="connection-title-entry" ref={titleEntryRef}>
      <button
        type="button"
        data-ui="connection-provider-button"
        data-kind={profile.kind}
        aria-label={`Connection: ${profile.name} (${status === 'ready' ? 'ready' : 'no key'})`}
        aria-expanded={open}
        aria-controls={detailId}
        title={`${KIND_LABEL[profile.kind]} · ${profile.name}`}
        onClick={() => setOpen((v) => !v)}
      >
        <ConnectionKindIcon kind={profile.kind} size={18} />
      </button>
      {open ? (
        <section
          data-ui="connection-header"
          data-state="configured"
          data-open="true"
          data-variant="popover"
          aria-label={`Connection: ${profile.name}`}
        >
          {connectionRow}
          {connectionDetail}
        </section>
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
    </div>
  )
}

function ConnectionKindIcon({ kind, size }: { kind: ConnectionKind; size: number }) {
  const geminiGradientId = `gemini-sparkle-gradient-${useId().replace(/:/g, '')}`

  if (kind === 'openrouter') {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
        data-icon=""
      >
        <path d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z" />
      </svg>
    )
  }
  if (kind === 'openai-compatible') {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
        data-icon=""
      >
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
      </svg>
    )
  }
  if (kind === 'anthropic') {
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
        data-icon=""
      >
        <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
      </svg>
    )
  }
  if (kind === 'google') {
    return (
      <svg
        viewBox="0 0 28 28"
        width={size}
        height={size}
        fill="none"
        aria-hidden="true"
        focusable="false"
        data-icon=""
      >
        <path
          d="M14 28c0-1.9367-.3733-3.7567-1.12-5.46-.7233-1.7033-1.715-3.185-2.975-4.445s-2.7417-2.2517-4.445-2.975C3.7567 14.3733 1.9367 14 0 14c1.9367 0 3.7567-.3617 5.46-1.085 1.7033-.7467 3.185-1.75 4.445-3.01s2.2517-2.7417 2.975-4.445C13.6267 3.7567 14 1.9367 14 0c0 1.9367.3617 3.7567 1.085 5.46.7467 1.7033 1.75 3.185 3.01 4.445s2.7417 2.2633 4.445 3.01C24.2433 13.6383 26.0633 14 28 14c-1.9367 0-3.7567.3733-5.46 1.12-1.7033.7233-3.185 1.715-4.445 2.975s-2.2633 2.7417-3.01 4.445C14.3617 24.2433 14 26.0633 14 28Z"
          fill={`url(#${geminiGradientId})`}
        />
        <defs>
          <radialGradient
            id={geminiGradientId}
            cx="0"
            cy="0"
            r="1"
            gradientUnits="userSpaceOnUse"
            gradientTransform="translate(2.77876 11.3795) rotate(18.6832) scale(29.8025 238.737)"
          >
            <stop offset="0.0671246" stopColor="#9168c0" />
            <stop offset="0.342551" stopColor="#5684d1" />
            <stop offset="0.672076" stopColor="#1ba1e3" />
          </radialGradient>
        </defs>
      </svg>
    )
  }
  if (kind === 'llama-server') {
    return (
      <svg
        viewBox="0 0 250 250"
        width={size}
        height={size}
        aria-hidden="true"
        focusable="false"
        data-icon=""
      >
        <rect width="250" height="250" rx="8.6857" ry="8.7008" fill="#1b1f20" />
        <g transform="translate(-995.51066,-129.70875)" fill="#ff8236">
          <path d="m1163.3 226.8-13.5 24c-17.8-13.7-44.2-15.7-62-1-28.7 23.7-26.7 78.5 18 78.8 12.5 0 23.1-5.9 34.5-9.8l6 23.9c-10.1 4.7-20.4 9.5-31.5 11-101.2 13.8-95.4-132.3-3.9-139.9 19.2-1.6 36.1 3.4 52.5 13Z" />
          <path d="m1093.4 203.8c-15.4 4.6-29.7 13.1-40.5 25-2-24.2 3.4-73.1 30.3-82.7 4-1.4 17.7-4.9 17.3 2.2-.4 7.1-9.9 19.3-12.2 25.9-4 11.6-.3 19.6 5.2 29.7Z" />
          <polygon points="1131.4 307.8 1116.4 307.8 1116.4 290.8 1099.4 290.8 1099.4 276.8 1114.9 276.8 1116.4 275.3 1116.4 258.8 1131.4 258.8 1131.4 276.8 1147.4 276.8 1147.4 290.8 1131.4 290.8" />
          <polygon points="1186.4 290.8 1186.4 307.8 1171.4 307.8 1171.4 290.8 1155.4 290.8 1155.4 276.8 1171.4 276.8 1171.4 258.8 1186.4 258.8 1186.4 275.3 1187.9 276.8 1203.4 276.8 1203.4 290.8" />
          <path d="m1142.3 156.9c2 3-9.3 15.9-11.1 19.2-5.2 9.8-1.7 15.4 2.2 24.7-11.3-1.7-21.8-.3-33 1 2.5-21.5 14.6-52.8 41.9-44.9Z" />
        </g>
      </svg>
    )
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon=""
    >
      <path d="M8 8h8a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-2a3 3 0 0 1 3-3Z" />
      <path d="M9 4v4" />
      <path d="M15 4v4" />
      <path d="M10 12h4" />
    </svg>
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
        onChange={(e) => void onSwitch(e.target.value)}
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
    </div>
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
        ? 'Saving in place. This profile stays no-key until a key is pasted.'
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
      ? 'Hosted providers can save without a key, but sends and tests stay blocked until a key is added.'
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
          settings: withProfileApiDefaults(settings, profile),
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
