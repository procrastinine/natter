import {
  Activity,
  lazy,
  type MouseEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { attachmentsDisabledByTextProtocol } from '../core/attachments/context'
import { seedCursorAtMessage } from '../core/branch-resolve'
import { cloneDefaultChatSettings } from '../core/defaults'
import {
  applyBaseFontSizeToDocument,
  applyChatMaxWidthToDocument,
  applyFontFamilyToDocument,
  applyThemeToDocument,
  bumpRecentModel,
  DEFAULT_GLOBAL_PREFERENCES,
  fontFamilyStack,
  readGlobalPreferences,
} from '../core/global-settings'
import {
  applyStructuralEffectsToCursor,
  deleteSingleMessage,
  type PasteImportSlot,
} from '../core/messages'
import {
  forceEquivalentModelIdForConnection,
  modelLooksForeignForProfile,
  pickEquivalentModelId,
} from '../core/model-selection'
import { withProfileApiDefaults } from '../core/provider-defaults'
import { prefillClassFor } from '../core/quirks'
import { DEFAULT_SIDEBAR_SORT_MODE } from '../core/sidebar-sort'
import type {
  Chat,
  ChatId,
  ConnectionProfile,
  CursorMap,
  Message,
  MessageAttachmentRef,
  MessageId,
  MessageRole,
} from '../core/types'
import { useBranchUrlSync } from '../hooks/useBranchUrlSync'
import { nextOrphanRecoveryAt, recoverOrphans, useChat } from '../hooks/useChat'
import { useEndpoints } from '../hooks/useEndpoints'
import { useModels } from '../hooks/useModels'
import { LruMap } from '../lib/lru-map'
import { isPageHidingAbortError } from '../lib/page-lifecycle'
import { newId } from '../lib/ulid'
import { onEvent } from '../store/broadcast'
import {
  createChat,
  discardEmptyDraftChat,
  discardEmptyDraftChats,
  getChat,
  listChatSidebarRows,
  loadActiveBranchWindowSnapshot,
  markChatPermanent,
  toggleMessageHidden,
  touchLastViewed,
  updateChatSettings,
} from '../store/chats'
import { resolveConnectionRuntimeKeys } from '../store/connection-runtime'
import { bumpPresetLastUsedAt, getPreset, pickPreferredPreset } from '../store/presets'
import { bumpProfileLastUsedAt, countProfiles, getProfile } from '../store/profiles'
import { installPersistenceRequestOnFirstInteraction } from '../store/quota'
import {
  allTable,
  chatMessageDependencies,
  chatRowDependencies,
  GLOBAL_PREFERENCES_DEPENDENCIES,
  primaryKeys,
} from '../store/reactive-dependencies'
import { useRepositoryQuery, useRepositoryQueryState } from '../store/reactive-query'
import type { ActiveBranchWindowSnapshot } from '../store/repository'
import { readSidebarSortMode, SIDEBAR_SORT_SETTING_KEY } from '../store/sidebar-preferences'
import {
  installStreamLeaseListener,
  onRemoteStreamLeasesExpired,
  onRemoteStreamOwnershipReleased,
  requestAbortForChat,
} from '../store/stream-leases'
import { getWorkspaceRepository } from '../store/workspace-repository'
import { useChatStore } from '../store/zustand/chatStore'
import { useStreamStore } from '../store/zustand/streamStore'
import { useToastStore } from '../store/zustand/toastStore'
import { useUiStore } from '../store/zustand/uiStore'
import { BannerTray } from '../ui/chat/BannerTray'
import { ChatHeader } from '../ui/chat/ChatHeader'
import { Composer, type ComposerDroppedFiles, moveComposerDraft } from '../ui/chat/Composer'
import { EditTreeToolbar } from '../ui/chat/EditTreeToolbar'
import { EmptyState } from '../ui/chat/EmptyState'
import { FocusModeToggle } from '../ui/chat/FocusModeToggle'
import { PrefillSettingsPrompt } from '../ui/chat/PrefillSettingsPrompt'
import { ScrollRegion, type ScrollRegionHandle, type ScrollState } from '../ui/chat/ScrollRegion'
import { ToastTray } from '../ui/chat/ToastTray'
import { ZeroEligibleModal } from '../ui/chat/ZeroEligibleModal'
import {
  ConnectionHeader,
  readActiveSeedState,
  writeActiveSeedState,
} from '../ui/header/ConnectionHeader'
import {
  ChevronIcon,
  CogIcon,
  DatabaseIcon,
  MenuIcon,
  NewChatIcon,
  SidebarIcon,
} from '../ui/icons/Icon'
import { ChatModelPanel } from '../ui/settings/ChatModelPanel'
import { ChatList } from '../ui/sidebar/ChatList'
import {
  homeHref,
  makeAnchorClickHandler,
  navigateHome,
  navigateNew,
  navigateToChat,
  newChatHref,
  storageHref,
  useRoute,
} from './router'

const loadMessageList = () =>
  import('../ui/chat/MessageList').then((module) => ({ default: module.MessageList }))
const loadBranchTreeView = () =>
  import('../ui/chat/BranchTreeView').then((module) => ({ default: module.BranchTreeView }))
const loadImportModal = () =>
  import('../ui/chat/ImportModal').then((module) => ({ default: module.ImportModal }))
const loadGlobalSettingsModal = () =>
  import('../ui/settings/GlobalSettingsModal').then((module) => ({
    default: module.GlobalSettingsModal,
  }))
const loadStorageView = () =>
  import('../ui/storage/StorageView').then((module) => ({ default: module.StorageView }))

const MessageList = lazy(loadMessageList)
const BranchTreeView = lazy(loadBranchTreeView)
const ImportModal = lazy(loadImportModal)
const GlobalSettingsModal = lazy(loadGlobalSettingsModal)
const StorageView = lazy(loadStorageView)

function preload(loader: () => Promise<unknown>): void {
  void loader().catch(() => undefined)
}

const preloadMessageList = () => preload(loadMessageList)
const preloadBranchTreeView = () => preload(loadBranchTreeView)
const preloadImportModal = () => preload(loadImportModal)
const preloadGlobalSettingsModal = () => preload(loadGlobalSettingsModal)
const preloadStorageView = () => preload(loadStorageView)

function SurfaceLoading({ label, overlay = false }: { label: string; overlay?: boolean }) {
  return (
    <div
      data-ui="surface-loading"
      data-placement={overlay ? 'overlay' : 'inline'}
      role="status"
      aria-live="polite"
    >
      {label}
    </div>
  )
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'natter:sidebar-collapsed'
const MOBILE_SHELL_QUERY = '(max-width: 700px)'
// Stable empty reference so useSyncExternalStore selectors don't allocate a
// fresh `{}` each render (React 19 flags that as infinite re-render).
const EMPTY_CURSOR: CursorMap = Object.freeze({})
// Matches ModelPicker's MODELS_QUERY — the cache row is keyed on the query
// signature, so reusing the same one here means the picker and the
// auto-selector share a single /models fetch instead of triggering two.
const MODEL_AUTOSELECT_QUERY = {
  outputModalities: ['text', 'image', 'audio', 'file', 'video'],
} as const
const DIRECT_MODEL_AUTOSELECT_QUERY = {} as const
const TRANSCRIPT_RECYCLE_REMOUNT_DELAY_MS = 50
const RECYCLE_TRANSCRIPT_EVENT = 'natter:recycle-transcript'
const ORPHAN_RECOVERY_FAILURE_RETRY_MS = 2_000
const CHAT_SNAPSHOT_CACHE_MAX_ENTRIES = 16

interface ActiveBranchWindowSnapshotResult {
  key: string
  cursorKey: string
  snapshot: ActiveBranchWindowSnapshot
}

interface LastBranchSnapshot {
  cursorKey: string
  snapshot: ActiveBranchWindowSnapshot
}

interface ActiveBranchSnapshotOverride extends ActiveBranchWindowSnapshotResult {
  queryResultAtSet: ActiveBranchWindowSnapshotResult | null
}

interface ActiveProfileState {
  chatId: ChatId
  profileId: string
}

interface TreeInsertTarget {
  chatId: ChatId
  slot: PasteImportSlot
  defaultRole: MessageRole
  activateNodeId?: MessageId
}

function oppositeRole(role: MessageRole): MessageRole {
  if (role === 'user') return 'assistant'
  if (role === 'assistant') return 'user'
  return role
}

function cursorCacheKey(chatId: ChatId, cursor: CursorMap): string {
  const entries = Object.entries(cursor).sort(([left], [right]) => left.localeCompare(right))
  return JSON.stringify([chatId, entries])
}

function hasFileTransfer(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    setMatches(media.matches)
    const onChange = () => setMatches(media.matches)
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }
    media.addListener(onChange)
    return () => media.removeListener(onChange)
  }, [query])

  return matches
}

// Seed settings for a new chat from this tab's remembered default first,
// then fall back to the workspace-global MRU preset. The remembered seed
// tracks the most recently viewed chat in this tab (including preset-backed
// chats with no local edits), plus explicit new-chat/profile-switch actions.
// `profileId` is still overridden with the preferred profile so an explicit
// connection choice can win even when a different preset had to be used
// for the rest of the seed settings.
// If the chosen profileId differs from the preset's, clear the model —
// the preset's model is almost certainly not served on the new connection,
// and the Shell-level auto-selector will fill it in if the new connection
// has exactly one model.
function seedSettingsForNewChat(
  presetSettings: Chat['settings'] | undefined,
  preferredProfile: ConnectionProfile | null,
): Chat['settings'] {
  const base = presetSettings ? { ...presetSettings } : cloneDefaultChatSettings()
  const targetId = preferredProfile?.id ?? base.profileId
  let next = base
  if (targetId && targetId !== base.profileId) {
    next = { ...base, profileId: targetId, model: '' }
  }
  return preferredProfile ? withProfileApiDefaults(next, preferredProfile) : next
}

export function Shell() {
  const route = useRoute()
  const activeChatId = route.kind === 'chat' ? route.chatId : null
  const activeStorageRoute = route.kind === 'storage' ? route.storage : null
  const activeStorageRouteKey = activeStorageRoute ? storageHref(activeStorageRoute) : null
  const focusModeAvailable = !activeStorageRoute
  const onNewChatSurface = route.kind === 'new'
  const activeSurfaceKey = activeChatId
    ? `chat:${activeChatId}`
    : activeStorageRouteKey
      ? `storage:${activeStorageRouteKey}`
      : onNewChatSurface
        ? 'new'
        : 'empty'
  const isNarrowScreen = useMediaQuery(MOBILE_SHELL_QUERY)
  const activeTreeHeaders = useBranchUrlSync(activeChatId)
  const { send, sendFrom } = useChat()
  const streamingOnActiveChat = useStreamStore((s) =>
    activeChatId ? s.hasStreamForChat(activeChatId) : false,
  )
  const profileCount = useRepositoryQuery(
    'profile-count:include-archived',
    () => countProfiles({ includeArchived: true }),
    undefined,
    allTable('profiles'),
  )
  const connectionKnown = profileCount !== undefined
  const hasConnection = connectionKnown && profileCount > 0
  const [chatModelOpen, setChatModelOpen] = useState(false)
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [composerSeed, setComposerSeed] = useState<string | null>(null)
  const [composerDroppedFiles, setComposerDroppedFiles] = useState<ComposerDroppedFiles | null>(
    null,
  )
  const [scrollState, setScrollState] = useState<ScrollState>('follow')
  const [transcriptRenderEpoch, setTranscriptRenderEpoch] = useState(0)
  const [transcriptMounted, setTranscriptMounted] = useState(true)
  const [transcriptPlaceholderHeight, setTranscriptPlaceholderHeight] = useState(0)
  const [importAtEndOpen, setImportAtEndOpen] = useState(false)
  const [treeInsertTarget, setTreeInsertTarget] = useState<TreeInsertTarget | null>(null)
  const [retainedAlternateViewsChatId, setRetainedAlternateViewsChatId] = useState<ChatId | null>(
    null,
  )
  const transcriptRemountTimerRef = useRef<number | null>(null)
  const editTreeMode = useUiStore((s) => s.editTreeMode)
  const setEditTreeMode = useUiStore((s) => s.setEditTreeMode)
  const treeViewChatId = useUiStore((s) => s.treeViewChatId)
  const setTreeViewChatId = useUiStore((s) => s.setTreeViewChatId)
  const treeExpanded = useUiStore((s) => s.treeExpanded)
  const treeViewActive = activeChatId !== null && treeViewChatId === activeChatId
  const setEphemeralActiveChatId = useUiStore((s) => s.setActiveChatId)
  const focusMode = useUiStore((s) => s.focusMode)
  const transcriptFocusMode = !isNarrowScreen && focusMode && focusModeAvailable
  const effectiveFocusMode = !treeViewActive && transcriptFocusMode
  const pushBanner = useToastStore((s) => s.pushBanner)
  const pushToast = useToastStore((s) => s.push)
  const clearBannersByKind = useToastStore((s) => s.clearBannersByKind)
  const activeCursor = useChatStore((s) =>
    activeChatId ? (s.cursors[activeChatId] ?? EMPTY_CURSOR) : EMPTY_CURSOR,
  )
  useEffect(() => {
    if (treeViewActive && editTreeMode) setEditTreeMode(false)
  }, [editTreeMode, setEditTreeMode, treeViewActive])
  useLayoutEffect(() => {
    setEphemeralActiveChatId(activeChatId)
    return () => {
      if (useUiStore.getState().activeChatId === activeChatId) {
        setEphemeralActiveChatId(null)
      }
    }
  }, [activeChatId, setEphemeralActiveChatId])
  // Keep a single active chat-row subscription. Expensive body loading is
  // handled by the message-window query below, not by draft/token observers.
  const activeChatRow = useRepositoryQuery(
    JSON.stringify(['chat', activeChatId]),
    async () => (activeChatId ? await getChat(activeChatId) : undefined),
    undefined,
    chatRowDependencies(activeChatId),
  )
  const chatSnapshotCacheRef = useRef(new LruMap<ChatId, Chat>(CHAT_SNAPSHOT_CACHE_MAX_ENTRIES))
  useEffect(() => {
    if (!activeChatRow) return
    chatSnapshotCacheRef.current.set(activeChatRow.id, activeChatRow)
  }, [activeChatRow])
  useEffect(
    () =>
      onEvent((event) => {
        if (event.kind === 'chat-deleted') chatSnapshotCacheRef.current.delete(event.chatId)
        else if (event.kind === 'workspace-replaced') chatSnapshotCacheRef.current.clear()
      }),
    [],
  )
  const resolvedActiveChatRow =
    activeChatRow ?? (activeChatId ? chatSnapshotCacheRef.current.get(activeChatId) : undefined)
  const globalPreferencesQuery = useRepositoryQueryState(
    'global-preferences',
    readGlobalPreferences,
    DEFAULT_GLOBAL_PREFERENCES,
    GLOBAL_PREFERENCES_DEPENDENCIES,
  )
  if (globalPreferencesQuery.status === 'error') throw globalPreferencesQuery.error
  const loadedPrefs =
    globalPreferencesQuery.status === 'ready' ? globalPreferencesQuery.value : undefined
  const prefs = globalPreferencesQuery.value
  const [messageBodyWindowLimit, setMessageBodyWindowLimit] = useState(
    DEFAULT_GLOBAL_PREFERENCES.messageRenderWindowSize,
  )
  const effectiveMessageBodyWindowLimit = Math.max(1, messageBodyWindowLimit)
  const activeChatHasTranscript = resolvedActiveChatRow?.lastUpdatedLeafId != null
  const activeCursorCacheKey =
    activeChatId && activeChatHasTranscript ? cursorCacheKey(activeChatId, activeCursor) : null
  const alternateViewsRetained = retainedAlternateViewsChatId === activeChatId
  const activeBranchWindowQueryKey =
    activeCursorCacheKey && (!treeViewActive || streamingOnActiveChat || alternateViewsRetained)
      ? JSON.stringify([activeCursorCacheKey, effectiveMessageBodyWindowLimit])
      : null
  const activeBranchWindowResult = useRepositoryQuery(
    JSON.stringify(['active-branch-window', activeChatId, activeBranchWindowQueryKey]),
    async (): Promise<ActiveBranchWindowSnapshotResult | null> => {
      const cursorKey = activeCursorCacheKey
      if (!activeChatId || !activeBranchWindowQueryKey || !cursorKey) return null
      const snapshot = await loadActiveBranchWindowSnapshot(activeChatId, activeCursor, {
        offset: -1,
        limit: effectiveMessageBodyWindowLimit,
      })
      return { key: activeBranchWindowQueryKey, cursorKey, snapshot }
    },
    null as ActiveBranchWindowSnapshotResult | null,
    chatMessageDependencies(activeChatId),
  )
  const activeBranchWindowResultRef = useRef(activeBranchWindowResult)
  activeBranchWindowResultRef.current = activeBranchWindowResult
  const [activeBranchSnapshotOverride, setActiveBranchSnapshotOverride] =
    useState<ActiveBranchSnapshotOverride | null>(null)
  useEffect(() => {
    setActiveBranchSnapshotOverride((current) =>
      current && current.queryResultAtSet !== activeBranchWindowResult ? null : current,
    )
  }, [activeBranchWindowResult])
  const branchSnapshotCacheRef = useRef(new Map<string, ActiveBranchWindowSnapshot>())
  const lastBranchSnapshotByChatRef = useRef(new Map<ChatId, LastBranchSnapshot>())
  const recycleTranscriptRenderTree = useCallback(() => {
    if (transcriptRemountTimerRef.current !== null) {
      window.clearTimeout(transcriptRemountTimerRef.current)
      transcriptRemountTimerRef.current = null
    }
    const list = document.querySelector<HTMLElement>('[data-ui="message-list"]')
    setTranscriptPlaceholderHeight(list?.offsetHeight ?? 0)
    branchSnapshotCacheRef.current.clear()
    lastBranchSnapshotByChatRef.current.clear()
    setTranscriptMounted(false)
    transcriptRemountTimerRef.current = window.setTimeout(() => {
      transcriptRemountTimerRef.current = null
      setTranscriptRenderEpoch((epoch) => epoch + 1)
      setTranscriptMounted(true)
      setTranscriptPlaceholderHeight(0)
    }, TRANSCRIPT_RECYCLE_REMOUNT_DELAY_MS)
  }, [])
  useEffect(() => {
    window.addEventListener(RECYCLE_TRANSCRIPT_EVENT, recycleTranscriptRenderTree)
    return () => window.removeEventListener(RECYCLE_TRANSCRIPT_EVENT, recycleTranscriptRenderTree)
  }, [recycleTranscriptRenderTree])
  useEffect(() => {
    if (!activeChatId) {
      branchSnapshotCacheRef.current.clear()
      lastBranchSnapshotByChatRef.current.clear()
      setActiveBranchSnapshotOverride(null)
      return
    }
    branchSnapshotCacheRef.current.clear()
    lastBranchSnapshotByChatRef.current.clear()
    setActiveBranchSnapshotOverride(null)
  }, [activeChatId])
  useEffect(() => {
    if (!treeViewActive) return
    setTreeInsertTarget(null)
  }, [treeViewActive])
  useEffect(() => {
    if (!activeBranchWindowResult) return
    if (activeBranchWindowResult.snapshot.chatId !== activeChatId) return
    branchSnapshotCacheRef.current.clear()
    branchSnapshotCacheRef.current.set(
      activeBranchWindowResult.key,
      activeBranchWindowResult.snapshot,
    )
    lastBranchSnapshotByChatRef.current.clear()
    lastBranchSnapshotByChatRef.current.set(activeBranchWindowResult.snapshot.chatId, {
      cursorKey: activeBranchWindowResult.cursorKey,
      snapshot: activeBranchWindowResult.snapshot,
    })
  }, [activeBranchWindowResult, activeChatId])
  useEffect(() => {
    void activeChatId
    setTranscriptMounted(true)
    setTranscriptPlaceholderHeight(0)
  }, [activeChatId])
  useEffect(() => {
    return () => {
      if (transcriptRemountTimerRef.current !== null) {
        window.clearTimeout(transcriptRemountTimerRef.current)
        transcriptRemountTimerRef.current = null
      }
    }
  }, [])
  const exactActiveBranchSnapshot =
    activeBranchSnapshotOverride?.key === activeBranchWindowQueryKey
      ? activeBranchSnapshotOverride.snapshot
      : activeBranchWindowResult?.key === activeBranchWindowQueryKey
        ? activeBranchWindowResult.snapshot
        : activeBranchWindowQueryKey
          ? (branchSnapshotCacheRef.current.get(activeBranchWindowQueryKey) ?? null)
          : null
  const lastActiveBranchSnapshot = activeChatId
    ? lastBranchSnapshotByChatRef.current.get(activeChatId)
    : undefined
  const retainedActiveBranchSnapshot =
    !treeViewActive || lastActiveBranchSnapshot?.cursorKey === activeCursorCacheKey
      ? (lastActiveBranchSnapshot?.snapshot ?? null)
      : null
  const resolvedActiveBranchSnapshot = exactActiveBranchSnapshot ?? retainedActiveBranchSnapshot
  const activeBranchLength = resolvedActiveBranchSnapshot?.branchLength ?? 0
  const activeBranchTailId = resolvedActiveBranchSnapshot?.branchHeaders.at(-1)?.id ?? null
  const messageBodyWindowResetKey = activeCursorCacheKey ?? '__none__'
  useEffect(() => {
    void messageBodyWindowResetKey
    setMessageBodyWindowLimit(Math.max(1, prefs.messageRenderWindowSize))
  }, [messageBodyWindowResetKey, prefs.messageRenderWindowSize])
  const loadOlderMessageWindow = useCallback(() => {
    const increment = Math.max(1, prefs.messageRenderWindowSize)
    const nextLimit = effectiveMessageBodyWindowLimit + increment
    setMessageBodyWindowLimit(
      activeBranchLength > 0 ? Math.min(activeBranchLength, nextLimit) : nextLimit,
    )
  }, [activeBranchLength, effectiveMessageBodyWindowLimit, prefs.messageRenderWindowSize])
  const activeEndpoints = useEndpoints(
    resolvedActiveChatRow?.settings.profileId ?? null,
    resolvedActiveChatRow?.settings.model || null,
    { strict: resolvedActiveChatRow?.settings.strictProviderRouting === true },
  )
  const activeCapability = activeEndpoints.capability
  // Keep the chat's model coherent with its connection. If a profile switch
  // cleared a model, first try to select the equivalent model from the new
  // connection's /models list. Fresh no-model chats still get the old
  // single-model convenience fallback.
  //
  // `useModels` powers both the fetch and read halves so this code sees the
  // same merged direct-provider list as ModelPicker. That matters for direct
  // Anthropic/Google, whose live /models rows can be sparse or unavailable
  // while bundled capability rows are still valid picker choices.
  const activeProfileId = resolvedActiveChatRow?.settings.profileId ?? null
  const activeProfileForModelList = useRepositoryQuery(
    JSON.stringify(['profile', activeProfileId]),
    () => (activeProfileId ? getProfile(activeProfileId) : Promise.resolve(undefined)),
    undefined,
    primaryKeys('profiles', activeProfileId),
  )
  const autoSelectModelsQuery =
    activeProfileForModelList?.kind === 'openrouter'
      ? MODEL_AUTOSELECT_QUERY
      : DIRECT_MODEL_AUTOSELECT_QUERY
  const autoSelectModels = useModels(activeProfileId, {
    query: autoSelectModelsQuery,
    enabled: !!resolvedActiveChatRow && !!activeProfileForModelList,
  })
  const previousActiveProfileStateRef = useRef<ActiveProfileState | null>(null)
  const pendingProfileSwitchRef = useRef<ActiveProfileState | null>(null)
  useEffect(() => {
    if (!resolvedActiveChatRow) return
    const activeProfileState: ActiveProfileState = {
      chatId: resolvedActiveChatRow.id,
      profileId: resolvedActiveChatRow.settings.profileId,
    }
    const previousProfileState = previousActiveProfileStateRef.current
    if (
      previousProfileState &&
      previousProfileState.chatId === activeProfileState.chatId &&
      previousProfileState.profileId !== activeProfileState.profileId
    ) {
      pendingProfileSwitchRef.current = activeProfileState
    }
    previousActiveProfileStateRef.current = activeProfileState
    if (!activeProfileForModelList) return
    if (activeProfileId !== resolvedActiveChatRow.settings.profileId) return
    if (activeProfileForModelList.id !== activeProfileId) return
    const pendingProfileSwitch = pendingProfileSwitchRef.current
    const shouldReconcileExistingModel =
      pendingProfileSwitch?.chatId === activeProfileState.chatId &&
      pendingProfileSwitch.profileId === activeProfileState.profileId
    const rows = autoSelectModels.models
    if (resolvedActiveChatRow.settings.model) {
      if (!shouldReconcileExistingModel) return
      if (rows.length === 0) return
      const equivalentModelId = pickEquivalentModelId(resolvedActiveChatRow.settings.model, rows)
      const normalizedEquivalentModelId = equivalentModelId
        ? (forceEquivalentModelIdForConnection(equivalentModelId, activeProfileForModelList.kind) ??
          equivalentModelId)
        : null
      const nextModel = normalizedEquivalentModelId
        ? normalizedEquivalentModelId === resolvedActiveChatRow.settings.model
          ? null
          : normalizedEquivalentModelId
        : modelLooksForeignForProfile(
              activeProfileForModelList.kind,
              resolvedActiveChatRow.settings.model,
            )
          ? ''
          : null
      if (nextModel === null) {
        pendingProfileSwitchRef.current = null
        return
      }
      pendingProfileSwitchRef.current = null
      void (async () => {
        const latest = await getChat(resolvedActiveChatRow.id)
        if (!latest) return
        if (latest.settings.profileId !== resolvedActiveChatRow.settings.profileId) return
        if (latest.settings.model !== resolvedActiveChatRow.settings.model) return
        await updateChatSettings(resolvedActiveChatRow.id, { model: nextModel })
      })()
      return
    }
    pendingProfileSwitchRef.current = null
    if (resolvedActiveChatRow.presetId) return
    if (rows.length !== 1) return
    const only = rows[0]
    if (!only) return
    void (async () => {
      // Re-read through the store layer (not getDb directly) so this lookup
      // migrates cleanly to the daemon WorkspaceRepository — whichever backend
      // is wired up, getChat() returns the same Chat shape.
      const latest = await getChat(resolvedActiveChatRow.id)
      if (!latest || latest.settings.model) return
      if (latest.settings.profileId !== resolvedActiveChatRow.settings.profileId) return
      await updateChatSettings(resolvedActiveChatRow.id, { model: only.id })
    })()
  }, [resolvedActiveChatRow, activeProfileId, activeProfileForModelList, autoSelectModels.models])
  const activePathHeaders = resolvedActiveBranchSnapshot?.branchHeaders ?? []
  const sidebarSortMode = useRepositoryQuery(
    'sidebar-sort-mode',
    readSidebarSortMode,
    DEFAULT_SIDEBAR_SORT_MODE,
    primaryKeys('settings', SIDEBAR_SORT_SETTING_KEY),
  )
  const trailingLeaf = useMemo(() => activePathHeaders.at(-1) ?? null, [activePathHeaders])
  const trailingUserMessage = trailingLeaf?.role === 'user' ? trailingLeaf : null
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === '1'
  })
  const scrollRef = useRef<ScrollRegionHandle>(null)
  const transcriptPlaceholderRef = useRef<HTMLDivElement | null>(null)
  const activeComposerDraftKey = activeChatId
    ? `chat:${activeChatId}`
    : onNewChatSurface
      ? 'new'
      : null
  const abortActiveChat = useCallback(() => {
    if (!activeChatId) return
    const aborted = requestAbortForChat(activeChatId)
    if (aborted === 0) {
      pushToast({ level: 'warning', text: 'No active stream was found for this chat.' })
    }
  }, [activeChatId, pushToast])

  useEffect(() => {
    if (activeStorageRoute && chatModelOpen) setChatModelOpen(false)
  }, [activeStorageRoute, chatModelOpen])

  useEffect(() => {
    if (!isNarrowScreen) setMobileSidebarOpen(false)
  }, [isNarrowScreen])

  const previousActiveSurfaceKeyRef = useRef(activeSurfaceKey)
  useLayoutEffect(() => {
    const placeholder = transcriptPlaceholderRef.current
    if (!placeholder) return
    placeholder.style.minHeight = `${transcriptPlaceholderHeight}px`
  }, [transcriptPlaceholderHeight])

  useEffect(() => {
    if (previousActiveSurfaceKeyRef.current === activeSurfaceKey) return
    previousActiveSurfaceKeyRef.current = activeSurfaceKey
    setMobileSidebarOpen(false)
  }, [activeSurfaceKey])

  useEffect(() => {
    installStreamLeaseListener()
  }, [])

  const previousActiveChatIdRef = useRef<ChatId | null>(activeChatId)
  useEffect(() => {
    const previous = previousActiveChatIdRef.current
    previousActiveChatIdRef.current = activeChatId
    if (!previous || previous === activeChatId) return
    void discardEmptyDraftChat(previous).catch((error: unknown) => {
      if (isPageHidingAbortError(error)) return
      console.error('Failed to discard empty draft chat', error)
    })
  }, [activeChatId])

  useEffect(() => {
    if (onNewChatSurface) return
    void discardEmptyDraftChats({ exceptChatId: activeChatId }).catch((error: unknown) => {
      if (isPageHidingAbortError(error)) return
      console.error('Failed to discard stale empty draft chats', error)
    })
  }, [activeChatId, onNewChatSurface])

  useEffect(() => {
    if (!activeChatId) return
    let stopped = false
    let timer: number | null = null
    let running: Promise<void> | null = null
    let rerun = false

    const schedule = (deadline: number) => {
      if (stopped) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(run, Math.max(1, deadline - Date.now()))
    }
    const perform = async () => {
      try {
        await recoverOrphans(Date.now(), activeChatId)
        const next = await nextOrphanRecoveryAt(activeChatId)
        if (next !== null) schedule(next)
      } catch {
        schedule(Date.now() + ORPHAN_RECOVERY_FAILURE_RETRY_MS)
      }
    }
    const run = () => {
      if (stopped) return
      if (running) {
        rerun = true
        return
      }
      if (timer !== null) window.clearTimeout(timer)
      timer = null
      running = perform().finally(() => {
        running = null
        if (!rerun) return
        rerun = false
        run()
      })
    }
    const stopExpirySubscription = onRemoteStreamLeasesExpired((leases) => {
      if (leases.some((lease) => lease.chatId === activeChatId)) run()
    })
    const stopOwnershipReleaseSubscription = onRemoteStreamOwnershipReleased(activeChatId, run)
    run()
    return () => {
      stopped = true
      stopExpirySubscription()
      stopOwnershipReleaseSubscription()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [activeChatId])

  useEffect(() => {
    if (!activeChatId) return
    void touchLastViewed(activeChatId).catch((error: unknown) => {
      if (isPageHidingAbortError(error)) return
      console.error('Failed to update chat viewed timestamp', error)
    })
  }, [activeChatId])

  const lastSeedSignatureRef = useRef<string>('')

  useEffect(() => {
    if (!resolvedActiveChatRow) return
    const nextSeed = {
      profileId: resolvedActiveChatRow.settings.profileId || null,
      presetId: resolvedActiveChatRow.presetId ?? null,
      settings: resolvedActiveChatRow.settings,
    }
    const signature = JSON.stringify({
      presetId: nextSeed.presetId,
      settings: nextSeed.settings,
    })
    if (signature === lastSeedSignatureRef.current) return
    lastSeedSignatureRef.current = signature
    writeActiveSeedState(nextSeed)
  }, [resolvedActiveChatRow])

  const resolveNewChatSeed = useCallback(async () => {
    const remembered = readActiveSeedState()
    const rememberedProfileId = remembered.settings?.profileId || remembered.profileId
    const rememberedProfile = rememberedProfileId
      ? await getProfile(rememberedProfileId)
      : undefined
    if (remembered.settings && rememberedProfile) {
      const preset = remembered.presetId ? await getPreset(remembered.presetId) : undefined
      return {
        preset,
        settings: withProfileApiDefaults(structuredClone(remembered.settings), rememberedProfile),
      }
    }
    const preset = await pickPreferredPreset({
      presetId: remembered.presetId,
      profileId: rememberedProfile ? rememberedProfile.id : null,
    })
    const settings = seedSettingsForNewChat(preset?.settings, rememberedProfile ?? null)
    return {
      preset,
      settings,
    }
  }, [])

  const openingNewChatSettingsRef = useRef<Promise<void> | null>(null)
  const openSettingsForNewChat = useCallback(async () => {
    if (openingNewChatSettingsRef.current) return openingNewChatSettingsRef.current
    const task = (async () => {
      const { preset, settings } = await resolveNewChatSeed()
      writeActiveSeedState({
        profileId: settings.profileId || null,
        presetId: preset?.id ?? null,
        settings,
      })
      const chat = await createChat({
        settings,
        temporary: true,
        ...(preset ? { presetId: preset.id } : {}),
      })
      moveComposerDraft('new', `chat:${chat.id}`)
      navigateToChat(chat.id)
      setChatModelOpen(true)
    })()
    openingNewChatSettingsRef.current = task
    try {
      await task
    } finally {
      if (openingNewChatSettingsRef.current === task) openingNewChatSettingsRef.current = null
    }
  }, [resolveNewChatSeed])

  const openNewChat = useCallback(() => {
    if (chatModelOpen) {
      void openSettingsForNewChat()
      return
    }
    navigateNew()
  }, [chatModelOpen, openSettingsForNewChat])

  const handleNewChatClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return
      }
      event.preventDefault()
      openNewChat()
    },
    [openNewChat],
  )

  useEffect(() => {
    applyThemeToDocument(prefs.theme)
  }, [prefs.theme])

  useEffect(() => {
    applyChatMaxWidthToDocument(prefs.chatMaxWidth)
  }, [prefs.chatMaxWidth])

  useInsertionEffect(() => {
    applyFontFamilyToDocument(prefs.fontFamily)
  }, [prefs.fontFamily])

  useInsertionEffect(() => {
    applyBaseFontSizeToDocument(prefs.baseFontSize)
  }, [prefs.baseFontSize])

  useEffect(() => {
    let active = true
    let cleanup = () => {}
    void getWorkspaceRepository()
      .getWorkspaceMeta()
      .then((meta) => {
        if (!active || meta.backendKind !== 'browser-idb') return
        cleanup = installPersistenceRequestOnFirstInteraction()
      })
      .catch((error: unknown) => {
        if (isPageHidingAbortError(error)) return
        console.error('Failed to inspect workspace backend for persistence request', error)
      })
    return () => {
      active = false
      cleanup()
    }
  }, [])

  // Persist the panel's open/closed state across route transitions —
  // in particular, navigating to /new or between chats shouldn't auto-
  // collapse the settings pane the user explicitly opened.

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  // Chat-not-found banner: if the route refers to a chat id that doesn't
  // resolve (deleted, never existed, or pasted from another workspace),
  // surface the banner per §10.13.1 Route table. Reactive storage invalidation guarantees
  // re-evaluation when the chats table changes.
  const routedChatExists = useRepositoryQuery(
    JSON.stringify(['chat-exists', activeChatId]),
    () => (activeChatId ? getChat(activeChatId).then((c) => !!c) : Promise.resolve(true)),
    true,
    chatRowDependencies(activeChatId),
  )
  useEffect(() => {
    clearBannersByKind('chat-not-found')
    if (!activeChatId) return
    if (routedChatExists) return
    pushBanner({
      kind: 'chat-not-found',
      text: 'Chat not found in this workspace.',
      primary: { label: 'Return to home', action: () => navigateHome() },
      secondary: {
        label: 'Dismiss',
        action: () => clearBannersByKind('chat-not-found'),
      },
    })
  }, [activeChatId, routedChatExists, pushBanner, clearBannersByKind])

  const failSend = useCallback(
    (message: string, err?: unknown): never => {
      console.error(message, err)
      pushToast({ level: 'danger', text: message.replace(/^send: /, 'Send failed: ') })
      throw err instanceof Error ? err : new Error(message)
    },
    [pushToast],
  )

  const activePrefillClass = resolvedActiveChatRow?.settings.model
    ? prefillClassFor(resolvedActiveChatRow.settings.model)
    : null
  const showPrefillButton = activePrefillClass !== null && activePrefillClass !== 'unsupported'
  const activeDefaultPrefill = resolvedActiveChatRow?.settings.defaultPrefill ?? ''
  const attachmentsDisabledForActiveChat = resolvedActiveChatRow
    ? attachmentsDisabledByTextProtocol(resolvedActiveChatRow.settings)
    : false
  const handleDroppedFilesConsumed = useCallback((id: string) => {
    setComposerDroppedFiles((current) => (current?.id === id ? null : current))
  }, [])

  const handleSubmit = useCallback(
    async (
      text: string,
      opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
    ) => {
      preloadMessageList()
      if (!activeChatId) return failSend('send: no active chat')
      const chat = await getChat(activeChatId)
      if (!chat) return failSend('send: chat row missing', { chatId: activeChatId })
      if (!chat.settings.profileId) {
        return failSend(
          'send: chat.settings.profileId is empty — create the chat from a seeded preset',
        )
      }
      if (!chat.settings.model) {
        return failSend('send: chat.settings.model is empty — no model selected')
      }
      const profile = await getProfile(chat.settings.profileId)
      if (!profile) {
        return failSend('send: connection profile missing', { profileId: chat.settings.profileId })
      }
      let apiKeyCandidates: Awaited<ReturnType<typeof resolveConnectionRuntimeKeys>>
      try {
        apiKeyCandidates = await resolveConnectionRuntimeKeys(profile, { chatId: activeChatId })
      } catch (err) {
        return failSend('send: resolveKey failed', err)
      }
      try {
        const prefillText = opts?.prefillText ?? ''
        const result = await send({
          chatId: activeChatId,
          connection: profile,
          apiKey: '',
          apiKeyCandidates,
          content: [{ type: 'text', text }],
          ...(opts?.attachmentRefs ? { attachmentRefs: opts.attachmentRefs } : {}),
          ...(prefillText.length > 0
            ? { prefillContent: [{ type: 'text', text: prefillText }] }
            : {}),
        })
        if (result.outcome !== 'done') {
          console.info('send: stream ended with outcome', result.outcome, result.error?.kind)
        }
        if (chat.temporary) await markChatPermanent(activeChatId)
      } catch (err) {
        if (isPageHidingAbortError(err)) return
        return failSend('send: pipeline threw', err)
      }
      await bumpProfileLastUsedAt(profile.id)
      if (chat.presetId) await bumpPresetLastUsedAt(chat.presetId)
      await bumpRecentModel(chat.settings.model)
    },
    [activeChatId, failSend, send],
  )

  const handleNewChatSubmit = useCallback(
    async (
      text: string,
      opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
    ) => {
      preloadMessageList()
      const { preset, settings } = await resolveNewChatSeed()
      if (!settings.profileId) {
        return failSend('send: chat.settings.profileId is empty — no profile selected')
      }
      if (!settings.model) {
        return failSend('send: chat.settings.model is empty — no model selected')
      }
      const profile = await getProfile(settings.profileId)
      if (!profile) {
        return failSend('send: connection profile missing', { profileId: settings.profileId })
      }
      try {
        await resolveConnectionRuntimeKeys(profile)
      } catch (err) {
        return failSend('send: resolveKey failed', err)
      }
      writeActiveSeedState({
        profileId: settings.profileId || null,
        presetId: preset?.id ?? null,
        settings,
      })
      const chat = await createChat({
        settings,
        temporary: true,
        ...(preset ? { presetId: preset.id } : {}),
      })
      navigateToChat(chat.id)
      try {
        const apiKeyCandidates = await resolveConnectionRuntimeKeys(profile, { chatId: chat.id })
        const prefillText = opts?.prefillText ?? ''
        const result = await send({
          chatId: chat.id,
          connection: profile,
          apiKey: '',
          apiKeyCandidates,
          content: [{ type: 'text', text }],
          ...(opts?.attachmentRefs ? { attachmentRefs: opts.attachmentRefs } : {}),
          ...(prefillText.length > 0
            ? { prefillContent: [{ type: 'text', text: prefillText }] }
            : {}),
        })
        if (result.outcome !== 'done') {
          console.info('send: stream ended with outcome', result.outcome, result.error?.kind)
        }
        await markChatPermanent(chat.id)
      } catch (err) {
        if (isPageHidingAbortError(err)) return
        return failSend('send: pipeline threw', err)
      }
      await bumpProfileLastUsedAt(profile.id)
      if (chat.presetId) await bumpPresetLastUsedAt(chat.presetId)
      await bumpRecentModel(chat.settings.model)
    },
    [failSend, resolveNewChatSeed, send],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const activeTag = (document.activeElement?.tagName ?? '').toLowerCase()
      const isTyping = activeTag === 'input' || activeTag === 'textarea'
      if (e.key === 'n' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !isTyping) {
        e.preventDefault()
        openNewChat()
      }
      if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setGlobalSettingsOpen((v) => !v)
      }
      if (e.key === '.' && (e.metaKey || e.ctrlKey) && streamingOnActiveChat) {
        e.preventDefault()
        abortActiveChat()
      }
      // Edit-tree mode toggle (§10.14). Works globally; scoped by chat only
      // because the mode visually affects rows — the store field itself is
      // app-wide.
      if (e.key === 'E' && e.shiftKey && (e.metaKey || e.ctrlKey) && !isTyping && !treeViewActive) {
        e.preventDefault()
        setEditTreeMode(!useUiStore.getState().editTreeMode)
      }
      // Import-at-end modal shortcut (§10.14). Only meaningful on an active
      // chat; the keystroke is swallowed either way so DevTools bindings
      // (`Ctrl+Shift+I`) don't stomp on it.
      if (e.key === 'V' && e.shiftKey && (e.metaKey || e.ctrlKey) && activeChatId && !isTyping) {
        e.preventDefault()
        setImportAtEndOpen(true)
      }
      if (e.key === 'Escape') {
        if (useUiStore.getState().editTreeMode) {
          e.preventDefault()
          setEditTreeMode(false)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    streamingOnActiveChat,
    abortActiveChat,
    activeChatId,
    setEditTreeMode,
    openNewChat,
    treeViewActive,
  ])

  // Keep the panel slot reserved whenever an active chat has the panel open,
  // including focus mode. Chat settings are per-chat, so routes without an
  // active chat hide the pane instead of showing the null-chat placeholder.
  const showChatModelPanel =
    chatModelOpen && !!activeChatId && !!resolvedActiveChatRow && !activeStorageRoute
  const effectiveSidebarCollapsed = isNarrowScreen ? false : sidebarCollapsed
  const mobilePanelOpen = isNarrowScreen && (mobileSidebarOpen || showChatModelPanel)
  const closeMobilePanels = useCallback(() => {
    setMobileSidebarOpen(false)
    setChatModelOpen(false)
  }, [])
  const treeHeaderById = useMemo(
    () => new Map(activeTreeHeaders.map((header) => [header.id, header])),
    [activeTreeHeaders],
  )
  const refreshTranscriptForTreeHandoff = useCallback(async () => {
    if (!activeChatId) return
    const cursor = useChatStore.getState().getCursor(activeChatId) ?? {}
    const cursorKey = cursorCacheKey(activeChatId, cursor)
    const key = JSON.stringify([cursorKey, effectiveMessageBodyWindowLimit])
    const snapshot = await loadActiveBranchWindowSnapshot(activeChatId, cursor, {
      offset: -1,
      limit: effectiveMessageBodyWindowLimit,
    })
    if (useUiStore.getState().activeChatId !== activeChatId) return
    const latestCursor = useChatStore.getState().getCursor(activeChatId) ?? {}
    if (cursorCacheKey(activeChatId, latestCursor) !== cursorKey) return
    setActiveBranchSnapshotOverride({
      key,
      cursorKey,
      snapshot,
      queryResultAtSet: activeBranchWindowResultRef.current,
    })
  }, [activeChatId, effectiveMessageBodyWindowLimit])
  const activateTreeNode = useCallback(
    (messageId: MessageId) => {
      if (!activeChatId) return
      const header = treeHeaderById.get(messageId)
      if (!header || header.deleted) return
      const current = useChatStore.getState().getCursor(activeChatId) ?? {}
      const next = { ...current }
      seedCursorAtMessage(activeTreeHeaders as unknown as Message[], messageId, next, {
        preserveDescendantPins: false,
      })
      useChatStore.getState().setCursor(activeChatId, next)
    },
    [activeChatId, activeTreeHeaders, treeHeaderById],
  )
  const insertAtSharedTreeTrunk = useCallback(
    (parentId: MessageId | null) => {
      if (!activeChatId) return
      const childStreaming = activeTreeHeaders.some(
        (header) =>
          !header.deleted &&
          header.parentId === parentId &&
          useStreamStore.getState().isTargetActive(activeChatId, header.id),
      )
      if (childStreaming) {
        pushToast({ level: 'info', text: 'Wait for the connected generation to finish.' })
        return
      }
      const parent = parentId ? treeHeaderById.get(parentId) : undefined
      setTreeInsertTarget({
        chatId: activeChatId,
        slot: { kind: 'after-all', parentId },
        defaultRole: parent ? oppositeRole(parent.role) : 'user',
      })
    },
    [activeChatId, activeTreeHeaders, pushToast, treeHeaderById],
  )
  const insertAtTreeChildLeg = useCallback(
    (childId: MessageId) => {
      if (!activeChatId) return
      const child = treeHeaderById.get(childId)
      if (!child || child.deleted) return
      if (useStreamStore.getState().isTargetActive(activeChatId, childId)) {
        pushToast({ level: 'info', text: 'Wait for this generation to finish.' })
        return
      }
      setTreeInsertTarget({
        chatId: activeChatId,
        slot: { kind: 'before', messageId: childId },
        defaultRole: oppositeRole(child.role),
      })
    },
    [activeChatId, pushToast, treeHeaderById],
  )
  const insertAfterTreeLeaf = useCallback(
    (messageId: MessageId) => {
      if (!activeChatId) return
      const leaf = treeHeaderById.get(messageId)
      if (!leaf || leaf.deleted) return
      const hasLiveChild = activeTreeHeaders.some(
        (header) => !header.deleted && header.parentId === messageId,
      )
      if (hasLiveChild) return
      if (useStreamStore.getState().isTargetActive(activeChatId, messageId)) {
        pushToast({ level: 'info', text: 'Wait for this generation to finish.' })
        return
      }
      setTreeInsertTarget({
        chatId: activeChatId,
        slot: { kind: 'after', messageId },
        defaultRole: oppositeRole(leaf.role),
        activateNodeId: messageId,
      })
    },
    [activeChatId, activeTreeHeaders, pushToast, treeHeaderById],
  )
  const editTreeMessage = useCallback(
    async (message: Message, text: string) => {
      if (!activeChatId || message.chatId !== activeChatId) return
      if (useStreamStore.getState().isTargetActive(activeChatId, message.id)) {
        throw new Error('Wait for this generation to finish before editing it.')
      }
      const { editInPlace } = await import('../hooks/useMessageOps')
      await editInPlace(activeChatId, message, text)
    },
    [activeChatId],
  )
  const editAndSendTreeMessage = useCallback(
    async (message: Message, text: string) => {
      if (!activeChatId || message.chatId !== activeChatId || message.role !== 'user') return
      activateTreeNode(message.id)
      try {
        const { editAndResend } = await import('../hooks/useMessageOps')
        const result = await editAndResend(
          { chatId: activeChatId, sendFrom },
          message,
          text,
          message.attachmentRefs ? { attachmentRefs: message.attachmentRefs } : {},
        )
        return result.assistantMessageId
      } catch (error) {
        pushToast({
          level: 'danger',
          text: `Send failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        })
        throw error
      }
    },
    [activateTreeNode, activeChatId, pushToast, sendFrom],
  )
  const deleteTreeNode = useCallback(
    async (messageId: MessageId) => {
      if (!activeChatId) return
      if (useStreamStore.getState().isTargetActive(activeChatId, messageId)) {
        pushToast({ level: 'info', text: 'Wait for this generation to finish before deleting it.' })
        return
      }
      const priorCursor = {
        ...(useChatStore.getState().getCursor(activeChatId) ?? {}),
      }
      try {
        const result = await deleteSingleMessage({
          chatId: activeChatId,
          messageId,
          cursor: priorCursor,
          ...(useUiStore.getState().cascadeDelete ? { cascade: true } : {}),
        })
        const latestCursor = useChatStore.getState().getCursor(activeChatId) ?? priorCursor
        useChatStore
          .getState()
          .setCursor(activeChatId, applyStructuralEffectsToCursor(latestCursor, result.effects))
        pushToast({
          level: 'info',
          text: 'Deleted message.',
          undo: async () => {
            const { applyStructuralSnapshot } = await import('../core/undo')
            await applyStructuralSnapshot(result.preImage)
            useChatStore.getState().setCursor(activeChatId, priorCursor)
          },
        })
      } catch (error) {
        pushToast({
          level: 'danger',
          text: `Delete failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        })
      }
    },
    [activeChatId, pushToast],
  )
  const regenerateTreeMessage = useCallback(
    async (message: Message) => {
      if (!activeChatId || message.chatId !== activeChatId || message.role !== 'assistant') return
      activateTreeNode(message.id)
      try {
        const { regenerateFromMessage } = await import('../hooks/useMessageOps')
        const result = await regenerateFromMessage({ chatId: activeChatId, sendFrom }, message)
        return result.assistantMessageId
      } catch (error) {
        pushToast({
          level: 'danger',
          text: `Regenerate failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        })
      }
    },
    [activateTreeNode, activeChatId, pushToast, sendFrom],
  )
  const continueTreeMessage = useCallback(
    async (message: Message) => {
      if (!activeChatId || message.chatId !== activeChatId || message.role !== 'assistant') return
      if (useStreamStore.getState().isTargetActive(activeChatId, message.id)) {
        pushToast({
          level: 'info',
          text: 'Wait for this generation to finish before continuing it.',
        })
        return
      }
      activateTreeNode(message.id)
      try {
        const { continueFromMessage } = await import('../hooks/useMessageOps')
        await continueFromMessage({ chatId: activeChatId, sendFrom }, message)
        return message.id
      } catch (error) {
        pushToast({
          level: 'danger',
          text: `Continue failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        })
      }
    },
    [activateTreeNode, activeChatId, pushToast, sendFrom],
  )
  const forkTreeMessage = useCallback(
    async (message: Message) => {
      if (!activeChatId || message.chatId !== activeChatId) return
      try {
        const { computeBranchTitle, forkChatFromMessage } = await import('../core/chat-fork')
        const sourceChat = await getChat(activeChatId)
        if (!sourceChat) throw new Error('Chat not found.')
        const existing = await listChatSidebarRows()
        const defaultTitle = computeBranchTitle(
          sourceChat.title,
          existing.map((chat) => chat.title),
        )
        const chosen = window.prompt('Name the new chat:', defaultTitle)
        if (chosen === null) return
        const title = chosen.trim() || defaultTitle
        const result = await forkChatFromMessage({
          chatId: activeChatId,
          messageId: message.id,
          title,
          cursor: activeCursor,
        })
        pushToast({
          level: 'success',
          text: `Forked to "${title}" (${result.messageCount} messages).`,
        })
        navigateToChat(result.chatId)
      } catch (error) {
        pushToast({
          level: 'danger',
          text: `Fork failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        })
      }
    },
    [activeChatId, activeCursor, pushToast],
  )
  const toggleTreeMessageContextVisibility = useCallback(
    async (message: Message) => {
      if (!activeChatId || message.chatId !== activeChatId) return
      try {
        await toggleMessageHidden(message.id)
      } catch (error) {
        pushToast({
          level: 'danger',
          text: `Context visibility update failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        })
      }
    },
    [activeChatId, pushToast],
  )
  const toggleTreeReasoningDetailHidden = useCallback(
    async (message: Message, detailIndex: number) => {
      if (!activeChatId || message.chatId !== activeChatId) return
      try {
        const { toggleReasoningDetailHidden } = await import('../hooks/useMessageOps')
        await toggleReasoningDetailHidden(activeChatId, message.id, detailIndex)
      } catch (error) {
        pushToast({
          level: 'danger',
          text: `Reasoning visibility update failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        })
      }
    },
    [activeChatId, pushToast],
  )
  const toggleTreeProviderOutputItemHidden = useCallback(
    async (message: Message, itemIndex: number) => {
      if (!activeChatId || message.chatId !== activeChatId) return
      try {
        const { toggleProviderOutputItemHidden } = await import('../hooks/useMessageOps')
        await toggleProviderOutputItemHidden(activeChatId, message.id, itemIndex)
      } catch (error) {
        pushToast({
          level: 'danger',
          text: `Tool visibility update failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        })
      }
    },
    [activeChatId, pushToast],
  )
  const activeMobileConnectionControl =
    connectionKnown && activeChatId ? (
      <ConnectionHeader
        variant="mobile-menu"
        activeChatId={activeChatId}
        activeChatProfileId={resolvedActiveChatRow?.settings.profileId ?? null}
      />
    ) : null
  const newChatMobileConnectionControl = connectionKnown ? (
    <ConnectionHeader variant="mobile-menu" />
  ) : null

  return (
    <div
      data-ui="app-shell"
      data-chat-model-panel={showChatModelPanel ? 'open' : 'closed'}
      data-sidebar={effectiveSidebarCollapsed ? 'collapsed' : 'expanded'}
      data-mobile-sidebar={mobileSidebarOpen ? 'open' : 'closed'}
      data-focus-mode={effectiveFocusMode ? 'on' : 'off'}
    >
      <aside
        data-ui="sidebar"
        data-collapsed={effectiveSidebarCollapsed}
        data-sort-key={sidebarSortMode}
        aria-label="Chats"
        aria-hidden={isNarrowScreen && !mobileSidebarOpen ? true : undefined}
      >
        <div data-ui="sidebar-header">
          <a data-ui="brand" href={homeHref()} onClick={makeAnchorClickHandler(homeHref())}>
            natter
          </a>
          <button
            type="button"
            data-ui="icon-button"
            data-role="sidebar-toggle"
            aria-label={
              isNarrowScreen
                ? 'Close sidebar'
                : sidebarCollapsed
                  ? 'Expand sidebar'
                  : 'Collapse sidebar'
            }
            title={
              isNarrowScreen
                ? 'Close sidebar'
                : sidebarCollapsed
                  ? 'Expand sidebar'
                  : 'Collapse sidebar'
            }
            onClick={() => {
              if (isNarrowScreen) {
                setMobileSidebarOpen(false)
                return
              }
              setSidebarCollapsed((v) => !v)
            }}
          >
            <ChevronIcon size={16} rotate={effectiveSidebarCollapsed ? 0 : 180} />
          </button>
          <a
            data-ui="icon-button"
            data-role="new-chat"
            href={newChatHref()}
            rel="noopener"
            aria-label="New chat"
            title="New chat"
            onClick={handleNewChatClick}
          >
            <NewChatIcon size={18} />
          </a>
        </div>
        <ChatList
          activeChatId={activeChatId}
          collapsed={effectiveSidebarCollapsed}
          onChatIntent={preloadMessageList}
        />
        <div data-ui="sidebar-footer">
          <button
            type="button"
            data-ui="open-global-settings"
            aria-label="Open settings"
            title="Settings (⌘,)"
            onPointerEnter={preloadGlobalSettingsModal}
            onPointerDown={preloadGlobalSettingsModal}
            onFocus={preloadGlobalSettingsModal}
            onClick={() => setGlobalSettingsOpen(true)}
          >
            <CogIcon size={18} />
            <span>Settings</span>
          </button>
          <a
            href={storageHref()}
            data-ui="open-storage"
            aria-label="Open storage"
            title="Storage"
            onPointerEnter={preloadStorageView}
            onPointerDown={preloadStorageView}
            onFocus={preloadStorageView}
            onClick={makeAnchorClickHandler(storageHref())}
          >
            <DatabaseIcon size={18} />
          </a>
        </div>
      </aside>
      <main
        data-ui="main-pane"
        onDragOver={(event) => {
          if (treeViewActive || activeStorageRoute || (!activeChatId && !onNewChatSurface)) return
          if (!hasFileTransfer(event.dataTransfer)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={(event) => {
          if (treeViewActive || activeStorageRoute || (!activeChatId && !onNewChatSurface)) return
          if (!hasFileTransfer(event.dataTransfer)) return
          const files = Array.from(event.dataTransfer.files)
          if (files.length === 0) return
          event.preventDefault()
          setComposerDroppedFiles({ id: newId(), files })
        }}
      >
        {activeStorageRoute ? (
          <Suspense fallback={<SurfaceLoading label="Loading storage…" />}>
            <StorageView
              route={activeStorageRoute}
              onOpenSidebar={() => setMobileSidebarOpen(true)}
            />
          </Suspense>
        ) : (
          <>
            {connectionKnown && !hasConnection && !isNarrowScreen ? (
              <ConnectionHeader
                activeChatId={activeChatId}
                activeChatProfileId={resolvedActiveChatRow?.settings.profileId ?? null}
              />
            ) : null}
            {activeChatId ? (
              <>
                <div data-ui="chat-title-bar">
                  <button
                    type="button"
                    data-ui="icon-button"
                    data-role="mobile-sidebar-toggle"
                    aria-label="Open chats sidebar"
                    aria-expanded={mobileSidebarOpen}
                    title="Chats"
                    onClick={() => setMobileSidebarOpen(true)}
                  >
                    <SidebarIcon size={20} />
                  </button>
                  <ConnectionHeader
                    variant="title-icon"
                    activeChatId={activeChatId}
                    activeChatProfileId={resolvedActiveChatRow?.settings.profileId ?? null}
                  />
                  <ChatHeader
                    chatId={activeChatId}
                    settingsOpen={chatModelOpen}
                    onToggleSettings={() => setChatModelOpen((v) => !v)}
                    editTreeActive={editTreeMode}
                    onToggleEditTree={() => setEditTreeMode(!editTreeMode)}
                    treeViewActive={treeViewActive}
                    onTreeViewIntent={preloadBranchTreeView}
                    onToggleTreeView={() => {
                      setRetainedAlternateViewsChatId(activeChatId)
                      if (!treeViewActive) {
                        setEditTreeMode(false)
                        setTreeViewChatId(activeChatId)
                        return
                      }
                      void refreshTranscriptForTreeHandoff()
                        .catch(() => undefined)
                        .finally(() => {
                          if (useUiStore.getState().treeViewChatId === activeChatId) {
                            setTreeViewChatId(null)
                          }
                        })
                    }}
                    mobileConnectionControl={activeMobileConnectionControl}
                  />
                </div>
                {!treeViewActive ? <EditTreeToolbar /> : null}
                <BannerTray />
                {treeViewActive || alternateViewsRetained ? (
                  <Activity
                    name={`conversation-tree:${activeChatId}`}
                    mode={treeViewActive ? 'visible' : 'hidden'}
                  >
                    <Suspense fallback={<SurfaceLoading label="Loading conversation tree…" />}>
                      <BranchTreeView
                        chatId={activeChatId}
                        headers={activeTreeHeaders}
                        cursor={activeCursor}
                        expanded={treeExpanded}
                        previewFontFamily={fontFamilyStack(prefs.fontFamily)}
                        onActivateNode={activateTreeNode}
                        onInsertAtSharedTrunk={insertAtSharedTreeTrunk}
                        onInsertAtChildLeg={insertAtTreeChildLeg}
                        onInsertAfterLeaf={insertAfterTreeLeaf}
                        onEditMessage={editTreeMessage}
                        onEditAndSendMessage={editAndSendTreeMessage}
                        onDeleteNode={deleteTreeNode}
                        onRegenerateMessage={regenerateTreeMessage}
                        onContinueMessage={continueTreeMessage}
                        onForkMessage={forkTreeMessage}
                        onToggleMessageContextVisibility={toggleTreeMessageContextVisibility}
                        onToggleReasoningDetailHidden={toggleTreeReasoningDetailHidden}
                        onToggleProviderOutputItemHidden={toggleTreeProviderOutputItemHidden}
                        onAbort={abortActiveChat}
                        followActiveStreamOnMount={streamingOnActiveChat}
                        hasConnection={hasConnection}
                      />
                    </Suspense>
                  </Activity>
                ) : null}
                {!treeViewActive || alternateViewsRetained ? (
                  <Activity
                    name={`conversation-transcript:${activeChatId}`}
                    mode={treeViewActive ? 'hidden' : 'visible'}
                  >
                    <ScrollRegion
                      key={activeChatId}
                      ref={scrollRef}
                      autoScrollOnStream={prefs.autoScrollOnStream}
                      streamActive={streamingOnActiveChat}
                      resetKey={activeChatId}
                      streamFollowKey={activeBranchTailId}
                      onStateChange={setScrollState}
                    >
                      {transcriptMounted && activeChatHasTranscript ? (
                        resolvedActiveBranchSnapshot ? (
                          <Suspense fallback={<SurfaceLoading label="Loading conversation…" />}>
                            <MessageList
                              key={`${activeChatId}:${transcriptRenderEpoch}`}
                              chatId={activeChatId}
                              chatSettings={resolvedActiveChatRow.settings}
                              hasConnection={hasConnection}
                              branchSnapshot={resolvedActiveBranchSnapshot}
                              {...(activeCapability ? { capability: activeCapability } : {})}
                              prefillRecommendationEndpoints={activeEndpoints.endpoints}
                              longMessageDisplayMode={prefs.longMessageDisplayMode}
                              messageRenderWindowSize={prefs.messageRenderWindowSize}
                              messageRenderWindowLoadMode={
                                loadedPrefs ? prefs.messageRenderWindowLoadMode : 'manual'
                              }
                              onLoadOlderMessages={loadOlderMessageWindow}
                            />
                          </Suspense>
                        ) : (
                          <SurfaceLoading label="Loading conversation…" />
                        )
                      ) : (
                        <div ref={transcriptPlaceholderRef} data-ui="message-list-recycling" />
                      )}
                      {transcriptFocusMode ? (
                        <Composer
                          onSubmit={handleSubmit}
                          streaming={streamingOnActiveChat}
                          onAbort={abortActiveChat}
                          autoSize
                          autoSizeVariant="focus"
                          autoSizeMeasurementKey={`${prefs.fontFamily}:${prefs.baseFontSize}`}
                          {...(hasConnection
                            ? {}
                            : { sendBlockedReason: 'Add a connection to send messages.' })}
                          seed={composerSeed}
                          onSeedConsumed={() => setComposerSeed(null)}
                          draftKey={activeComposerDraftKey}
                          attachmentScopeKey={activeChatId}
                          attachmentsDisabled={attachmentsDisabledForActiveChat}
                          attachmentsDisabledReason="Attachments are unavailable with Text completions."
                          droppedFiles={composerDroppedFiles}
                          onDroppedFilesConsumed={handleDroppedFilesConsumed}
                          sendShortcut={prefs.sendShortcut}
                          onImportAtEndIntent={preloadImportModal}
                          onImportAtEnd={() => setImportAtEndOpen(true)}
                          {...(showPrefillButton
                            ? {
                                showPrefillButton: true,
                                defaultPrefill: activeDefaultPrefill,
                                prefillScopeKey: activeChatId,
                                prefillSettingsPrompt: resolvedActiveChatRow ? (
                                  <PrefillSettingsPrompt
                                    chatId={resolvedActiveChatRow.id}
                                    settings={resolvedActiveChatRow.settings}
                                    endpoints={activeEndpoints.endpoints}
                                  />
                                ) : null,
                              }
                            : {})}
                          trailingUserMessage={Boolean(trailingUserMessage)}
                          {...(trailingUserMessage && hasConnection
                            ? {
                                onReplyToTrailingUser: async () => {
                                  const chat = await getChat(activeChatId)
                                  if (!chat) return
                                  const profile = await getProfile(chat.settings.profileId)
                                  if (!profile) return
                                  try {
                                    const apiKeyCandidates = await resolveConnectionRuntimeKeys(
                                      profile,
                                      { chatId: activeChatId },
                                    )
                                    await sendFrom({
                                      chatId: activeChatId,
                                      connection: profile,
                                      apiKey: '',
                                      apiKeyCandidates,
                                      parentMessageId: trailingUserMessage.id,
                                    })
                                    await bumpProfileLastUsedAt(profile.id)
                                    if (chat.presetId) {
                                      await bumpPresetLastUsedAt(chat.presetId)
                                    }
                                  } catch (err) {
                                    if (isPageHidingAbortError(err)) return
                                    console.error('reply-to-trailing failed', err)
                                  }
                                },
                              }
                            : {})}
                        />
                      ) : null}
                    </ScrollRegion>
                    {transcriptFocusMode ? null : (
                      <Composer
                        onSubmit={handleSubmit}
                        streaming={streamingOnActiveChat}
                        onAbort={abortActiveChat}
                        autoSize
                        autoSizeMeasurementKey={`${prefs.fontFamily}:${prefs.baseFontSize}`}
                        {...(hasConnection
                          ? {}
                          : { sendBlockedReason: 'Add a connection to send messages.' })}
                        seed={composerSeed}
                        onSeedConsumed={() => setComposerSeed(null)}
                        draftKey={activeComposerDraftKey}
                        attachmentScopeKey={activeChatId}
                        attachmentsDisabled={attachmentsDisabledForActiveChat}
                        attachmentsDisabledReason="Attachments are unavailable with Text completions."
                        droppedFiles={composerDroppedFiles}
                        onDroppedFilesConsumed={handleDroppedFilesConsumed}
                        sendShortcut={prefs.sendShortcut}
                        onImportAtEndIntent={preloadImportModal}
                        onImportAtEnd={() => setImportAtEndOpen(true)}
                        {...(showPrefillButton
                          ? {
                              showPrefillButton: true,
                              defaultPrefill: activeDefaultPrefill,
                              prefillScopeKey: activeChatId,
                              prefillSettingsPrompt: resolvedActiveChatRow ? (
                                <PrefillSettingsPrompt
                                  chatId={resolvedActiveChatRow.id}
                                  settings={resolvedActiveChatRow.settings}
                                  endpoints={activeEndpoints.endpoints}
                                />
                              ) : null,
                            }
                          : {})}
                        trailingUserMessage={Boolean(trailingUserMessage)}
                        {...(trailingUserMessage && hasConnection
                          ? {
                              onReplyToTrailingUser: async () => {
                                const chat = await getChat(activeChatId)
                                if (!chat) return
                                const profile = await getProfile(chat.settings.profileId)
                                if (!profile) return
                                try {
                                  const apiKeyCandidates = await resolveConnectionRuntimeKeys(
                                    profile,
                                    {
                                      chatId: activeChatId,
                                    },
                                  )
                                  await sendFrom({
                                    chatId: activeChatId,
                                    connection: profile,
                                    apiKey: '',
                                    apiKeyCandidates,
                                    parentMessageId: trailingUserMessage.id,
                                  })
                                  await bumpProfileLastUsedAt(profile.id)
                                  if (chat.presetId) {
                                    await bumpPresetLastUsedAt(chat.presetId)
                                  }
                                } catch (err) {
                                  if (isPageHidingAbortError(err)) return
                                  console.error('reply-to-trailing failed', err)
                                }
                              },
                            }
                          : {})}
                        floatingAccessory={
                          scrollState === 'pinned' ? (
                            <button
                              type="button"
                              data-ui="jump-to-latest"
                              onClick={() => scrollRef.current?.scrollToBottom({ smooth: true })}
                            >
                              ↓ Jump to latest
                            </button>
                          ) : null
                        }
                      />
                    )}
                  </Activity>
                ) : null}
              </>
            ) : onNewChatSurface ? (
              <>
                {/* The new-chat surface stays IDB-cold until send/import/settings
                 * needs a row. */}
                <div data-ui="chat-title-bar">
                  <button
                    type="button"
                    data-ui="icon-button"
                    data-role="mobile-sidebar-toggle"
                    aria-label="Open chats sidebar"
                    aria-expanded={mobileSidebarOpen}
                    title="Chats"
                    onClick={() => setMobileSidebarOpen(true)}
                  >
                    <SidebarIcon size={20} />
                  </button>
                  <ConnectionHeader variant="title-icon" />
                  <span data-ui="chat-title" data-title-status="untitled">
                    <span data-ui="chat-title-label">New chat</span>
                  </span>
                  <span data-ui="header-spacer" />
                  <button
                    type="button"
                    data-ui="icon-button"
                    data-role="settings-cog"
                    aria-label="Open chat settings"
                    title="Chat settings"
                    onClick={() => void openSettingsForNewChat()}
                  >
                    <CogIcon size={20} />
                  </button>
                  <MobileNewChatControls connectionControl={newChatMobileConnectionControl} />
                </div>
                <EmptyState onPick={(text) => setComposerSeed(text)} />
                <Composer
                  onSubmit={handleNewChatSubmit}
                  autoSize
                  autoSizeMeasurementKey={`${prefs.fontFamily}:${prefs.baseFontSize}`}
                  {...(hasConnection
                    ? {}
                    : { sendBlockedReason: 'Add a connection to send messages.' })}
                  seed={composerSeed}
                  onSeedConsumed={() => setComposerSeed(null)}
                  draftKey={activeComposerDraftKey}
                  attachmentScopeKey="new"
                  droppedFiles={composerDroppedFiles}
                  onDroppedFilesConsumed={handleDroppedFilesConsumed}
                  sendShortcut={prefs.sendShortcut}
                  onImportAtEndIntent={preloadImportModal}
                  onImportAtEnd={() => setImportAtEndOpen(true)}
                />
              </>
            ) : (
              <>
                <div data-ui="chat-title-bar" data-mobile-home="true">
                  <button
                    type="button"
                    data-ui="icon-button"
                    data-role="mobile-sidebar-toggle"
                    aria-label="Open chats sidebar"
                    aria-expanded={mobileSidebarOpen}
                    title="Chats"
                    onClick={() => setMobileSidebarOpen(true)}
                  >
                    <SidebarIcon size={20} />
                  </button>
                  <span data-ui="chat-title" data-title-status="manual">
                    <span data-ui="chat-title-label">natter</span>
                  </span>
                  <span data-ui="header-spacer" />
                  <button
                    type="button"
                    data-ui="icon-button"
                    data-role="settings-cog"
                    aria-label="Open chat settings"
                    title="Chat settings"
                    onClick={() => void openSettingsForNewChat()}
                  >
                    <CogIcon size={20} />
                  </button>
                  <MobileNewChatControls connectionControl={newChatMobileConnectionControl} />
                </div>
                <EmptyState onPick={(text) => setComposerSeed(text)} />
              </>
            )}
          </>
        )}
      </main>
      {mobilePanelOpen ? (
        <button
          type="button"
          data-ui="mobile-panel-scrim"
          aria-label="Close mobile side panel"
          onClick={closeMobilePanels}
        />
      ) : null}
      {showChatModelPanel ? (
        <ChatModelPanel
          chatSnapshot={resolvedActiveChatRow}
          profileSnapshot={activeProfileForModelList ?? null}
          onClose={() => setChatModelOpen(false)}
        />
      ) : null}
      {globalSettingsOpen ? (
        <Suspense fallback={<SurfaceLoading label="Loading settings…" overlay />}>
          <GlobalSettingsModal open onClose={() => setGlobalSettingsOpen(false)} />
        </Suspense>
      ) : null}
      <ZeroEligibleModalHost />
      {importAtEndOpen && activeChatId ? (
        <Suspense fallback={<SurfaceLoading label="Loading import…" overlay />}>
          <ImportModal
            chatId={activeChatId}
            slot={{ kind: 'at-end' }}
            cursor={activeCursor}
            onClose={() => setImportAtEndOpen(false)}
            onDone={() => setImportAtEndOpen(false)}
          />
        </Suspense>
      ) : null}
      {importAtEndOpen && !activeChatId && onNewChatSurface ? (
        <Suspense fallback={<SurfaceLoading label="Loading import…" overlay />}>
          <ImportModal
            chatId={null}
            slot={{ kind: 'at-end' }}
            cursor={EMPTY_CURSOR}
            materializeChat={async () => {
              // Fire only when the user clicks Import; if import never writes
              // messages, the temporary row is discarded on navigation.
              const { preset, settings } = await resolveNewChatSeed()
              writeActiveSeedState({
                profileId: settings.profileId || null,
                presetId: preset?.id ?? null,
                settings,
              })
              const chat = await createChat({
                settings,
                temporary: true,
                ...(preset ? { presetId: preset.id } : {}),
              })
              navigateToChat(chat.id)
              return chat.id
            }}
            onClose={() => setImportAtEndOpen(false)}
            onDone={() => setImportAtEndOpen(false)}
          />
        </Suspense>
      ) : null}
      {treeViewActive && treeInsertTarget?.chatId === activeChatId ? (
        <Suspense fallback={<SurfaceLoading label="Loading import…" overlay />}>
          <ImportModal
            chatId={activeChatId}
            slot={treeInsertTarget.slot}
            cursor={activeCursor}
            defaultRole={treeInsertTarget.defaultRole}
            onClose={() => setTreeInsertTarget(null)}
            onDone={() => {
              if (treeInsertTarget.activateNodeId) {
                activateTreeNode(treeInsertTarget.activateNodeId)
              }
              setTreeInsertTarget(null)
            }}
          />
        </Suspense>
      ) : null}
      <ToastTray />
      {!treeViewActive && focusModeAvailable && !isNarrowScreen ? <FocusModeToggle /> : null}
    </div>
  )
}

function MobileNewChatControls({ connectionControl }: { connectionControl: ReactNode }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current
      if (!root || root.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div data-ui="chat-controls-menu-root" ref={rootRef}>
      <button
        type="button"
        data-ui="icon-button"
        data-role="chat-controls-menu"
        aria-label="Open chat controls"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Chat controls"
        onClick={() => setOpen((value) => !value)}
      >
        <MenuIcon size={20} />
      </button>
      {open ? (
        <div data-ui="chat-controls-menu" role="dialog" aria-label="Chat controls">
          {connectionControl ? (
            <section data-ui="chat-controls-menu-section" data-section="connection">
              <div data-ui="chat-controls-menu-connection">{connectionControl}</div>
            </section>
          ) : (
            <div data-ui="mobile-menu-empty">No connection loaded.</div>
          )}
        </div>
      ) : null}
    </div>
  )
}

// Tiny wrapper that only renders the modal when `zeroEligibleChatId` is
// set. Having this as its own component lets Shell subscribe via
// Zustand without forcing the modal to mount all the time.
function ZeroEligibleModalHost() {
  const chatId = useUiStore((s) => s.zeroEligibleChatId)
  if (!chatId) return null
  return <ZeroEligibleModal chatId={chatId} />
}
