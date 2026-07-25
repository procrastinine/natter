import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { ChatId, ConnectionKind, ConnectionProfile, ProfileId } from '../../core/types'
import {
  useConnectionManagerCatalog,
  useConnectionProfileCatalog,
} from '../../hooks/useConfigurationCatalog'
import { configurationApplication } from '../../store/configuration-application'
import {
  configurationController,
  currentActiveConfigurationSelection,
  previousActiveConfigurationSelection,
} from '../../store/configuration-controller'
import { createConnectionWithSeedPreset } from '../../store/connection-onboarding'
import {
  isValidConnectionHttpUrl as isValidHttpUrl,
  connectionKindRequiresKey as kindRequiresKey,
  loadConnectionProbeApplication,
} from '../../store/connection-probe-capability'
import type {
  ActiveConfigurationSeed,
  ConfigurationConnectionProbeInput,
  ConfigurationProfileCatalogRow,
  ConnectionProbeState as ProbeState,
} from '../../store/presentation-contracts'
import { ChevronIcon, CloseIcon, TrashIcon } from '../icons/Icon'
import { Button, IconButton } from '../primitives/Button'
import { Dialog } from '../primitives/Dialog'
import { ConnectionDeleteDialog } from './ConnectionDeleteDialog'

async function runConnectionTest(input: ConfigurationConnectionProbeInput): Promise<ProbeState> {
  try {
    const application = await loadConnectionProbeApplication()
    return await application.runConfigurationConnectionProbe(input)
  } catch (error) {
    return { kind: 'fail', message: keyErrorMessage(error) }
  }
}

interface ConnectionSaveResult {
  profileId: ProfileId
  activate: boolean
  seed?: ActiveConfigurationSeed
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

const PLACEHOLDER_KEY = '••••••••••••••••'
const EMPTY_PROFILE_ADDRESS_IDS: readonly ProfileId[] = Object.freeze([])

function hostFor(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
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

function keyErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ConnectionHeaderProps {
  activeChatId?: ChatId | null
  activeChatProfileId?: ProfileId | null
  variant?: 'empty-action' | 'title-icon' | 'mobile-menu'
}

export function ConnectionHeader({
  activeChatId = null,
  activeChatProfileId,
  variant = 'empty-action',
}: ConnectionHeaderProps = {}) {
  const activeSeed = useSyncExternalStore(
    configurationController.subscribe,
    configurationController.getSnapshot,
    configurationController.getSnapshot,
  )
  const [setupOpen, setSetupOpen] = useState(false)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const currentSelection = currentActiveConfigurationSelection(activeSeed.frame)
  const previousSelection = previousActiveConfigurationSelection(activeSeed.frame)
  const selectionMatchesSurface = (selection: NonNullable<typeof currentSelection>): boolean =>
    activeChatId
      ? selection.target.kind === 'chat' &&
        selection.target.chatId === activeChatId &&
        selection.target.profileId === (activeChatProfileId ?? null)
      : selection.target.kind === 'new-chat'
  const currentSurfaceSelection =
    currentSelection && selectionMatchesSurface(currentSelection) ? currentSelection : null
  const previousSurfaceSelection = previousSelection
  const presentedSelection = currentSurfaceSelection ?? previousSurfaceSelection
  const selectionPresentationOnly = currentSurfaceSelection === null && presentedSelection !== null
  const activeId =
    currentSurfaceSelection?.target.profileId ??
    activeSeed.seed.settings?.profileId ??
    activeSeed.seed.profileId
  const selectedProfile = presentedSelection?.value.profile ?? null
  const addressedProfileId = selectedProfile?.id ?? activeId ?? null
  const addressedProfileIds = useMemo(
    (): readonly ProfileId[] =>
      addressedProfileId ? [addressedProfileId] : EMPTY_PROFILE_ADDRESS_IDS,
    [addressedProfileId],
  )
  const profileCatalogResult = useConnectionProfileCatalog(
    variant === 'mobile-menu' || open,
    addressedProfileIds,
  )
  const profileCatalog = profileCatalogResult.snapshot
  const maskRemoteFirstProfile =
    setupOpen &&
    activeId === null &&
    (activeChatProfileId === null || activeChatProfileId === undefined)
  const profileRows = useMemo(() => {
    const rows = profileCatalog?.page.rows ?? []
    const addressed = profileCatalog?.page.addressedRows.find(
      (candidate) => candidate.id === addressedProfileId,
    )?.row
    if (!addressed || rows.some((row) => row.id === addressed.id)) return rows
    return [addressed, ...rows]
  }, [addressedProfileId, profileCatalog?.page.addressedRows, profileCatalog?.page.rows])
  const requestKey = presentedSelection?.value.requestRevision?.key ?? null
  const state = maskRemoteFirstProfile
    ? { profile: null, profiles: [], hasKey: false, keyMaterialRevision: null }
    : {
        profile: selectedProfile,
        profiles: profileRows,
        hasKey: requestKey?.kind === 'material',
        keyMaterialRevision: requestKey?.kind === 'material' ? requestKey.materialRevision : null,
      }
  const [probeState, setProbeState] = useState<ProbeState>({ kind: 'idle' })
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteCountOverride, setDeleteCountOverride] = useState<{
    revision: number
    presetCount: number
    chatCount: number
  } | null>(null)
  const [deleteReassignTo, setDeleteReassignTo] = useState<ProfileId | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const detailId = `connection-title-detail-${useId().replace(/:/g, '')}`
  const titleEntryRef = useRef<HTMLDivElement | null>(null)
  const probeRunRef = useRef(0)
  const hasConnection = state.profile !== null
  const connectionsKnownMissing = activeSeed.frame.shell?.totalProfileCount === 0
  const selectedProfileId = currentSurfaceSelection?.value.profile?.id ?? null
  const deleteAddressedIds = useMemo(
    () =>
      deleteConfirmOpen
        ? [
            ...new Set(
              [selectedProfileId, deleteReassignTo].filter((id): id is ProfileId => id !== null),
            ),
          ]
        : EMPTY_PROFILE_ADDRESS_IDS,
    [deleteConfirmOpen, deleteReassignTo, selectedProfileId],
  )
  const deleteManagerCatalog = useConnectionManagerCatalog(
    deleteConfirmOpen && selectedProfileId !== null,
    deleteAddressedIds,
    1,
  )
  const deleteManagerSnapshot = deleteManagerCatalog.snapshot
  const deleteManagerPage = deleteManagerSnapshot?.page
  const deleteManagerRows = useMemo(
    () => [
      ...new Map(
        [
          ...(deleteManagerPage?.rows ?? []),
          ...(deleteManagerPage?.addressedRows.flatMap((address) =>
            address.row ? [address.row] : [],
          ) ?? []),
        ].map((row) => [row.id, row]),
      ).values(),
    ],
    [deleteManagerPage?.addressedRows, deleteManagerPage?.rows],
  )
  const deleteManagerRow = selectedProfileId
    ? (deleteManagerRows.find((row) => row.id === selectedProfileId) ?? null)
    : null
  const effectiveDeleteCountOverride =
    deleteCountOverride?.revision === deleteManagerSnapshot?.revision ? deleteCountOverride : null
  const deleteDependents = deleteManagerRow
    ? effectiveDeleteCountOverride
      ? {
          presetCount: effectiveDeleteCountOverride.presetCount,
          chatCount: effectiveDeleteCountOverride.chatCount,
        }
      : {
          presetCount: deleteManagerRow.presetCount,
          chatCount: deleteManagerRow.chatCount,
        }
    : null

  const resetProbeState = useCallback(() => {
    probeRunRef.current += 1
    setProbeState({ kind: 'idle' })
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedProfileId is the profile-change trigger for resetting transient editor state.
  useEffect(() => {
    setEditing(false)
    resetProbeState()
    setDeleteConfirmOpen(false)
    setDeleteCountOverride(null)
    setDeleteReassignTo(null)
    setDeleteError(null)
  }, [selectedProfileId, resetProbeState])

  useEffect(() => {
    if (
      deleteReassignTo !== null &&
      deleteManagerSnapshot?.status === 'ready' &&
      !deleteManagerRows.some(
        (row) => row.id === deleteReassignTo && row.id !== selectedProfileId && !row.archived,
      )
    ) {
      setDeleteReassignTo(null)
    }
  }, [deleteManagerRows, deleteManagerSnapshot?.status, deleteReassignTo, selectedProfileId])

  useEffect(() => {
    if (variant !== 'title-icon' || !open) return
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-control="dialog-overlay"]')
      ) {
        return
      }
      const root = titleEntryRef.current
      if (!root || root.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [variant, open])

  const activateProfile = useCallback(
    async (id: ProfileId, seed?: ActiveConfigurationSeed) => {
      const intent = configurationController.claimIntent()
      if (activeChatId) {
        await configurationApplication.switchChatProfile({
          chatId: activeChatId,
          profileId: id,
          isCurrent: () => configurationController.intentIsCurrent(intent),
        })
        return
      }
      if (!configurationController.intentIsCurrent(intent)) return
      if (seed) configurationController.rememberSeed(seed)
      else configurationController.rememberProfile(id)
      await configurationApplication.execute({
        kind: 'connection.touch',
        profileId: id,
        now: Date.now(),
      })
    },
    [activeChatId],
  )

  const switchProfile = useCallback(
    async (id: ProfileId) => {
      if (id !== selectedProfileId) {
        setEditing(false)
        resetProbeState()
        setDeleteConfirmOpen(false)
      }
      await activateProfile(id)
    },
    [activateProfile, resetProbeState, selectedProfileId],
  )

  const applySaveResult = useCallback(
    async (result: ConnectionSaveResult) => {
      if (result.activate) {
        await activateProfile(result.profileId, result.seed)
      }
      setEditing(false)
      setSetupOpen(false)
    },
    [activateProfile],
  )

  const deleteCurrentProfile = useCallback(async () => {
    const profile = state.profile
    if (!profile || !deleteDependents) return
    const hasDependents = deleteDependents.presetCount > 0 || deleteDependents.chatCount > 0
    if (hasDependents && deleteReassignTo === null) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const result = await configurationApplication.deleteConnection(
        profile.id,
        deleteReassignTo === null ? {} : { reassignTo: deleteReassignTo },
      )
      if (result.kind === 'connection-delete-blocked') {
        setDeleteCountOverride({
          revision: deleteManagerSnapshot?.revision ?? -1,
          presetCount: result.presetCount,
          chatCount: result.chatCount,
        })
        return
      }
      if (result.kind !== 'connection-deleted') {
        setDeleteError('The connection could not be deleted. Nothing was changed.')
        return
      }
      setEditing(false)
      setDeleteConfirmOpen(false)
      setDeleteReassignTo(null)
      setDeleteCountOverride(null)
    } catch {
      setDeleteError('The connection could not be deleted. Nothing was changed.')
    } finally {
      setDeleteBusy(false)
    }
  }, [deleteDependents, deleteManagerSnapshot?.revision, deleteReassignTo, state.profile])

  const runSavedProfileTest = useCallback(async () => {
    const profile = state.profile
    if (!profile) return
    const probeRun = ++probeRunRef.current
    setProbeState({ kind: 'running' })
    try {
      const nextState = await runConnectionTest({
        kind: profile.kind,
        name: profile.name,
        baseUrl: profile.baseUrl,
        ...(profile.apiKeyRef ? { fallbackKeyId: profile.apiKeyRef } : {}),
      })
      if (probeRunRef.current === probeRun) setProbeState(nextState)
    } catch (error) {
      if (probeRunRef.current === probeRun) {
        setProbeState({ kind: 'fail', message: keyErrorMessage(error) })
      }
    }
  }, [state.profile])

  if (!presentedSelection && !maskRemoteFirstProfile && !connectionsKnownMissing) {
    return variant === 'title-icon' ? null : (
      <div
        data-ui="connection-empty-action"
        data-variant={variant}
        data-state="resolving"
        aria-hidden="true"
      />
    )
  }

  if (connectionsKnownMissing || !hasConnection || !state.profile) {
    if (variant === 'title-icon') return null
    return (
      <div data-ui="connection-empty-action" data-variant={variant}>
        <Button
          data-ui="connection-add"
          tone="accent"
          appearance="solid"
          onClick={() => setSetupOpen(true)}
        >
          Add connection
        </Button>
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
  const detailOpen = variant === 'mobile-menu' || open
  const connectionSummary = (
    <>
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
    </>
  )
  const connectionRow =
    variant === 'mobile-menu' ? (
      <div data-ui="connection-row" data-static="true">
        <span data-ui="connection-inline-icon" aria-hidden="true">
          <ConnectionKindIcon kind={profile.kind} size={16} />
        </span>
        {connectionSummary}
      </div>
    ) : (
      <Button
        type="button"
        data-ui="connection-row"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((v) => !v)}
        disabled={selectionPresentationOnly}
      >
        <span data-ui="connection-chevron" aria-hidden="true">
          <ChevronIcon size={14} rotate={open ? 90 : 0} />
        </span>
        {connectionSummary}
      </Button>
    )
  const connectionDetail = detailOpen ? (
    <div data-ui="connection-detail" id={detailId}>
      <ProfileSwitcher
        profiles={profiles}
        activeId={profile.id}
        hasPrevious={Boolean(profileCatalog?.page.previousCursor)}
        hasMore={Boolean(profileCatalog?.page.nextCursor)}
        onLoadPrevious={profileCatalogResult.demandBefore}
        onLoadMore={profileCatalogResult.demandAfter}
        onSwitch={switchProfile}
        onCreateNew={() => setSetupOpen(true)}
      />
      {editing ? (
        <ConnectionEditor
          profile={profile}
          resetModelChatId={activeChatId}
          hasKey={hasKey}
          keyMaterialRevision={state.keyMaterialRevision}
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
  const connectionDialogs = (
    <>
      {setupOpen ? (
        <ConnectionSetupModal
          hasExistingConnections={(activeSeed.frame.shell?.totalProfileCount ?? 0) > 0}
          onClose={() => setSetupOpen(false)}
          onSaved={applySaveResult}
        />
      ) : null}
      {deleteConfirmOpen ? (
        <ConnectionDeleteDialog
          profileName={profile.name}
          busy={deleteBusy}
          dependents={deleteDependents}
          replacementProfiles={deleteManagerRows.filter(
            (candidate) => candidate.id !== profile.id && !candidate.archived,
          )}
          hasPreviousReplacementProfiles={Boolean(deleteManagerPage?.previousCursor)}
          hasMoreReplacementProfiles={Boolean(deleteManagerPage?.nextCursor)}
          reassignTo={deleteReassignTo}
          error={deleteError}
          onCancel={() => {
            setDeleteConfirmOpen(false)
            setDeleteReassignTo(null)
            setDeleteCountOverride(null)
          }}
          onConfirm={deleteCurrentProfile}
          onLoadPreviousReplacementProfiles={deleteManagerCatalog.demandBefore}
          onLoadMoreReplacementProfiles={deleteManagerCatalog.demandAfter}
          onReassignTo={setDeleteReassignTo}
        />
      ) : null}
    </>
  )

  if (variant === 'mobile-menu') {
    return (
      <section
        data-ui="connection-header"
        data-state="configured"
        data-open="true"
        data-variant="mobile-menu"
        aria-label={`Connection: ${profile.name}`}
        data-presentation={selectionPresentationOnly ? 'retained' : 'current'}
        inert={selectionPresentationOnly ? true : undefined}
      >
        {connectionRow}
        {connectionDetail}
        {connectionDialogs}
      </section>
    )
  }

  if (variant !== 'title-icon') return null
  return (
    <div
      data-ui="connection-title-entry"
      data-presentation={selectionPresentationOnly ? 'retained' : 'current'}
      ref={titleEntryRef}
    >
      <Button
        type="button"
        data-ui="connection-provider-button"
        data-kind={profile.kind}
        aria-label={`Connection: ${profile.name} (${status === 'ready' ? 'ready' : 'no key'})`}
        aria-expanded={open}
        aria-controls={detailId}
        title={`${KIND_LABEL[profile.kind]} · ${profile.name}`}
        onClick={() => setOpen((v) => !v)}
        disabled={selectionPresentationOnly}
      >
        <ConnectionKindIcon kind={profile.kind} size={18} />
      </Button>
      {open ? (
        <section
          data-ui="connection-header"
          data-state="configured"
          data-open="true"
          data-variant="popover"
          aria-label={`Connection: ${profile.name}`}
          data-presentation={selectionPresentationOnly ? 'retained' : 'current'}
          inert={selectionPresentationOnly ? true : undefined}
        >
          {connectionRow}
          {connectionDetail}
        </section>
      ) : null}
      {connectionDialogs}
    </div>
  )
}

function ConnectionKindIcon({ kind, size }: { kind: ConnectionKind; size: number }) {
  const geminiGradientId = `gemini-sparkle-gradient-${useId().replace(/:/g, '')}`

  if (kind === 'openrouter') {
    return (
      <svg
        viewBox="0 0 401.4 293.7"
        width={size}
        height={size}
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
        data-icon="openrouter"
      >
        <path d="M303.9475,17.19926c42.79734,0,77.48933,34.69327,77.48933,77.48933s-34.69199,77.48933-77.48933,77.48933l76.86166,76.86244c9.76367,9.76313,2.84903,26.45667-10.95697,26.45667h-220.88335c-71.32686,0-129.14889-57.82202-129.14889-129.14889S77.64197,17.19926,148.96884,17.19926h154.97866ZM148.96884,68.85881c-42.79607,0-77.48933,34.69327-77.48933,77.48933s34.69327,77.48933,77.48933,77.48933,77.48933-34.69327,77.48933-77.48933-34.69327-77.48933-77.48933-77.48933Z" />
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
        data-icon="llama-server"
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
  profiles: readonly ConfigurationProfileCatalogRow[]
  activeId: ProfileId
  hasPrevious: boolean
  hasMore: boolean
  onLoadPrevious: () => void
  onLoadMore: () => void
  onSwitch: (id: ProfileId) => void | Promise<void>
  onCreateNew: () => void
}

const LOAD_MORE_PROFILES_VALUE = '__natter_load_more_profiles__'
const LOAD_PREVIOUS_PROFILES_VALUE = '__natter_load_previous_profiles__'

function ProfileSwitcher({
  profiles,
  activeId,
  hasPrevious,
  hasMore,
  onLoadPrevious,
  onLoadMore,
  onSwitch,
  onCreateNew,
}: ProfileSwitcherProps) {
  return (
    <div data-ui="connection-switcher">
      <label htmlFor="connection-profile-select">Profile</label>
      <select
        id="connection-profile-select"
        data-ui="connection-profile-select"
        value={activeId}
        onChange={(event) => {
          if (event.target.value === LOAD_PREVIOUS_PROFILES_VALUE) {
            onLoadPrevious()
            return
          }
          if (event.target.value === LOAD_MORE_PROFILES_VALUE) {
            onLoadMore()
            return
          }
          void onSwitch(event.target.value)
        }}
      >
        {hasPrevious ? (
          <option value={LOAD_PREVIOUS_PROFILES_VALUE}>Earlier connections…</option>
        ) : null}
        {profiles.map((p) => (
          <option key={p.id} value={p.id} disabled={p.archived === true}>
            {p.name}
            {p.archived ? ' (archived)' : ''}
          </option>
        ))}
        {hasMore ? <option value={LOAD_MORE_PROFILES_VALUE}>Load more connections…</option> : null}
      </select>
      <Button
        type="button"
        data-ui="connection-new"
        onClick={onCreateNew}
        aria-label="Add new connection profile"
        title="Add a new connection profile"
      >
        +
      </Button>
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
          <Button type="button" data-ui="connection-edit" onClick={onEdit}>
            Edit
          </Button>
          <Button type="button" data-ui="connection-test" onClick={() => void onTest()}>
            {probeState.kind === 'running' ? 'Testing…' : 'Test'}
          </Button>
        </div>
        <div data-ui="connection-actions-trailing">
          <Button
            type="button"
            data-ui="connection-delete"
            data-role="connection-delete"
            onClick={() => void onDelete()}
            disabled={deleteBusy}
            aria-label="Delete connection"
            title="Delete connection"
          >
            <TrashIcon size={13} />
          </Button>
        </div>
      </div>
      <ConnectionProbeMessage state={probeState} />
    </div>
  )
}

interface ConnectionEditorProps {
  profile: ConnectionProfile
  resetModelChatId: ChatId | null
  hasKey: boolean
  keyMaterialRevision: number | null
  deleteBusy: boolean
  onDone: (result: ConnectionSaveResult) => void | Promise<void>
  onCancel: () => void
  onDelete: () => void | Promise<void>
}

function ConnectionEditor({
  profile,
  resetModelChatId,
  hasKey,
  keyMaterialRevision,
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
  const effectiveBaseUrl = baseUrlIsLocked ? lockedBaseUrl : baseUrl
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
      setProbeState(
        await runConnectionTest({
          kind,
          name: trimmedName || profile.name,
          baseUrl: trimmedBaseUrl,
          ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
          ...(!saveAsNew && hasKey && profile.apiKeyRef
            ? { fallbackKeyId: profile.apiKeyRef }
            : {}),
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
        const result = await createConnectionWithSeedPreset({
          name: trimmedName,
          kind,
          baseUrl: trimmedBaseUrl,
          ...(trimmedKey.length > 0 ? { plaintextKey: trimmedKey } : {}),
          initialPresetName: `${trimmedName} default`,
        })
        if (result.kind !== 'connection-saved') return
        const created = result.profile
        await onDone({
          profileId: created.id,
          activate: true,
          ...(result.initialPreset
            ? {
                seed: {
                  profileId: created.id,
                  presetId: result.initialPreset.id,
                  settings: result.initialPreset.settings,
                },
              }
            : {}),
        })
      } else {
        await configurationApplication.editConnection({
          profile,
          patch: {
            name: trimmedName,
            kind,
            baseUrl: trimmedBaseUrl,
          },
          ...(trimmedKey.length > 0 ? { plaintextKey: trimmedKey } : {}),
          ...(resetModel && resetModelChatId ? { resetModelChatId } : {}),
          ...(keyMaterialRevision === null
            ? {}
            : { expectedKeyMaterialRevision: keyMaterialRevision }),
        })
        await onDone({ profileId: profile.id, activate: false })
      }
    } catch (submitError) {
      setError(keyErrorMessage(submitError))
    } finally {
      setBusy(false)
    }
  }, [
    canSave,
    keyMaterialRevision,
    kind,
    onDone,
    profile,
    resetModelChatId,
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
          <Button
            type="button"
            data-ui="connection-test"
            onClick={() => void runProbe()}
            disabled={busy || !baseUrlValid}
          >
            {probeState.kind === 'running' ? 'Testing…' : 'Test'}
          </Button>
        </div>
        <div data-ui="connection-actions-trailing">
          <Button
            type="button"
            data-ui="connection-delete"
            data-role="connection-delete"
            onClick={() => void onDelete()}
            disabled={busy || deleteBusy}
            aria-label="Delete connection"
            title="Delete connection"
          >
            <TrashIcon size={13} />
          </Button>
          <Button type="button" data-ui="connection-edit-cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            data-ui="connection-edit-save"
            tone="accent"
            appearance="solid"
            busy={busy}
            busyLabel="Saving…"
            disabled={!canSave}
          >
            Save
          </Button>
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
  const effectiveBaseUrl = baseUrlIsLocked ? lockedBaseUrl : baseUrl
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
        ...(trimmedKey.length > 0 ? { apiKey: trimmedKey } : {}),
      }),
    )
  }, [kind, trimmedName, trimmedBaseUrl, trimmedKey])

  const submit = useCallback(async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      const now = Date.now()
      const result = await createConnectionWithSeedPreset({
        name: trimmedName,
        kind,
        baseUrl: trimmedBaseUrl,
        ...(trimmedKey.length > 0 ? { plaintextKey: trimmedKey } : {}),
        initialPresetName: `${trimmedName} default`,
        now,
      })
      if (result.kind !== 'connection-saved') return
      const profile = result.profile
      await onSaved({
        profileId: profile.id,
        activate: true,
        ...(result.initialPreset
          ? {
              seed: {
                profileId: profile.id,
                presetId: result.initialPreset.id,
                settings: result.initialPreset.settings,
              },
            }
          : {}),
      })
    } catch (submitError) {
      setError(keyErrorMessage(submitError))
    } finally {
      setBusy(false)
    }
  }, [canSave, kind, onSaved, trimmedBaseUrl, trimmedKey, trimmedName])

  return (
    <Dialog
      overlayUi="connection-setup-overlay"
      scrimUi="connection-setup-scrim"
      surfaceUi="connection-setup-modal"
      surfaceAs="form"
      ariaLabel="Add connection"
      scrimLabel="Close add-connection dialog"
      backdrop="blurred"
      onClose={onClose}
      surfaceProps={{
        'aria-busy': busy || undefined,
        onSubmit: (event) => {
          event.preventDefault()
          void submit()
        },
      }}
    >
      <header>
        <h2>Add connection</h2>
        <IconButton
          data-ui="icon-button"
          data-role="connection-setup-close"
          onClick={onClose}
          aria-label="Close"
        >
          <CloseIcon size={16} />
        </IconButton>
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
            <Button
              data-ui="connection-test"
              onClick={() => void runProbe()}
              disabled={busy || !baseUrlValid}
            >
              {probeState.kind === 'running' ? 'Testing…' : 'Test'}
            </Button>
          </div>
          <div data-ui="connection-actions-trailing">
            <Button data-ui="connection-edit-cancel" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              data-ui="connection-setup-submit"
              tone="accent"
              appearance="solid"
              busy={busy}
              busyLabel="Saving…"
              disabled={!canSave}
            >
              Save
            </Button>
          </div>
        </div>
        <ConnectionProbeMessage state={probeState} />
        {error ? (
          <span data-ui="helper" data-validation="invalid" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </Dialog>
  )
}
