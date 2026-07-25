import {
  Activity,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { attachmentsDisabledByTextProtocol } from '../core/attachments/context'
import {
  PREFILL_UNAVAILABLE_PLAN,
  rebaseEffectiveEndpointRouting,
} from '../core/effective-endpoint-routing'
import {
  applyBaseFontSizeToDocument,
  applyChatMaxWidthToDocument,
  applyFontFamilyToDocument,
  applyThemeToDocument,
  DEFAULT_GLOBAL_PREFERENCES,
  fontFamilyStack,
} from '../core/global-settings'
import {
  connectionAvailabilityFromProfileCount,
  generationNotStarted,
  pendingGenerationCapability,
} from '../core/interaction-capability'
import type { PasteImportSlot } from '../core/messages'
import { EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS, mergeMessageContextRouteFacts } from '../core/reasoning'
import { DEFAULT_SIDEBAR_SORT_MODE } from '../core/sidebar-sort'
import type {
  Chat,
  ChatId,
  Message,
  MessageAttachmentRef,
  MessageId,
  MessageRole,
  ProviderOutputMemberRef,
  ReasoningMemberRef,
} from '../core/types'
import { useActiveBranchFrame } from '../hooks/useActiveBranchFrame'
import { catalogChatPresentation, useCatalogTab } from '../hooks/useCatalogApplication'
import { useConfigurationPreferences } from '../hooks/useConfigurationPreferences'
import { navigateConversationMessage } from '../hooks/useConversationCursor'
import { useConversationSnapshot } from '../hooks/useConversationFrame'
import { useModelCatalog } from '../hooks/useModelCatalog'
import { usePresentationInteraction } from '../hooks/usePresentationInteraction'
import { isPageHidingAbortError } from '../lib/page-lifecycle'
import { newId } from '../lib/ulid'
import { requestAttemptStop } from '../store/attempt-control-application'
import { attemptStopCapability, useAttemptTargetAdmissionFrame } from '../store/attempt-controller'
import { catalogApplication } from '../store/catalog-application'
import { discardEmptyDraftChat, touchLastViewed } from '../store/chat-metadata-application'
import {
  configurationController,
  currentActiveConfigurationSelection,
  readyActiveConfigurationSelection,
} from '../store/configuration-controller'
import { conversationController } from '../store/conversation-controller'
import { generationCapabilityController } from '../store/generation-capability-controller'
import { materializeTemporaryNewChat } from '../store/new-chat-seed'
import { writeSidebarCollapsed } from '../store/preferences-application'
import type {
  ConfigurationProjectionLoadStates,
  ConversationPresentationResourcePort,
  ConversationPresentationResourceState,
  ConversationSurface,
  MessageAttachmentRefMutation,
  RequestableAttemptStopCapability,
} from '../store/presentation-contracts'
import { installPersistenceRequestOnFirstInteraction } from '../store/quota'
import {
  getWorkspaceRuntimeState,
  subscribeWorkspaceRuntimeState,
} from '../store/workspace-runtime'
import { readWorkspaceMeta } from '../store/workspace-shell-application'
import { announceEditTreeMode, announceTreeBranchOpened } from '../store/zustand/announcementStore'
import { useToastStore } from '../store/zustand/toastStore'
import { useUiStore } from '../store/zustand/uiStore'
import { BannerTray } from '../ui/chat/BannerTray'
import type { BranchTreeView as BranchTreeViewComponent } from '../ui/chat/BranchTreeView'
import { ChatHeader } from '../ui/chat/ChatHeader'
import {
  Composer,
  type ComposerDroppedFiles,
  type ComposerProps,
  type ComposerSubmission,
  type ComposerSubmissionOutcome,
  moveComposerDraft,
} from '../ui/chat/Composer'
import { EditTreeToolbar } from '../ui/chat/EditTreeToolbar'
import { EmptyState } from '../ui/chat/EmptyState'
import { FocusModeToggle } from '../ui/chat/FocusModeToggle'
import type { MessageList as MessageListComponent } from '../ui/chat/MessageList'
import { PrefillSettingsPrompt } from '../ui/chat/PrefillSettingsPrompt'
import { ScrollRegion, type ScrollRegionHandle, type ScrollState } from '../ui/chat/ScrollRegion'
import { ToastTray } from '../ui/chat/ToastTray'
import { ZeroEligibleModal } from '../ui/chat/ZeroEligibleModal'
import { ConnectionHeader } from '../ui/header/ConnectionHeader'
import {
  ChevronIcon,
  CogIcon,
  DatabaseIcon,
  MenuIcon,
  NewChatIcon,
  SidebarIcon,
} from '../ui/icons/Icon'
import { Button, IconButton } from '../ui/primitives/Button'
import { LiveRegions } from '../ui/primitives/LiveRegions'
import { ChatModelPanel } from '../ui/settings/ChatModelPanel'
import { GlobalSettingsModal } from '../ui/settings/GlobalSettingsModal'
import { ChatList } from '../ui/sidebar/ChatList'
import {
  loadConversationActions,
  requireConversationActions,
} from './conversation-actions-capability'
import {
  type ConversationMutationIntent,
  type ConversationMutationSettlement,
  conversationMutationInteraction,
  conversationMutationTarget,
  generationSubmitInteraction,
} from './presentation-interactions'
import {
  beginRouteIntent,
  cancelRouteIntent,
  homeHref,
  isRouteIntentCurrent,
  makeAnchorClickHandler,
  navigateHome,
  navigateNew,
  navigateToChatForIntent,
  newChatHref,
  routeIntentOwner,
  storageHref,
  useRoute,
} from './router'

type MessageListModule = { default: typeof MessageListComponent }
type BranchTreeViewModule = { default: typeof BranchTreeViewComponent }

function createSurfaceModuleResource<Module>(loader: () => Promise<Module>) {
  let loaded: Module | null = null
  let pending: Promise<Module> | null = null
  let state: ConversationPresentationResourceState = Object.freeze({ kind: 'idle' })
  const listeners = new Set<() => void>()
  const publish = () => {
    for (const listener of [...listeners]) listener()
  }
  return Object.freeze({
    getSnapshot: () => loaded,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load: () => {
      if (loaded) return Promise.resolve(loaded)
      if (pending) return pending
      state = Object.freeze({ kind: 'loading' })
      pending = loader().then(
        (module) => {
          loaded = module
          state = Object.freeze({ kind: 'ready' })
          publish()
          return module
        },
        (error: unknown) => {
          pending = null
          state = Object.freeze({
            kind: 'failed',
            message: error instanceof Error ? error.message : 'Conversation surface failed to load',
          })
          publish()
          throw error
        },
      )
      return pending
    },
  })
}

const messageListModuleResource = createSurfaceModuleResource<MessageListModule>(() =>
  Promise.all([import('../ui/chat/MessageList'), loadConversationActions()]).then(([module]) => ({
    default: module.MessageList,
  })),
)
const branchTreeViewModuleResource = createSurfaceModuleResource<BranchTreeViewModule>(() =>
  Promise.all([import('../ui/chat/BranchTreeView'), loadConversationActions()]).then(
    ([module]) => ({
      default: module.BranchTreeView,
    }),
  ),
)
const loadMessageList = messageListModuleResource.load
const loadBranchTreeView = branchTreeViewModuleResource.load
const presentationResources: Readonly<
  Record<
    ConversationSurface,
    typeof messageListModuleResource | typeof branchTreeViewModuleResource
  >
> = Object.freeze({
  transcript: messageListModuleResource,
  tree: branchTreeViewModuleResource,
})
const conversationPresentationResourcePort: ConversationPresentationResourcePort = Object.freeze({
  get: (surface: ConversationSurface) => presentationResources[surface].getState(),
  request: (surface: ConversationSurface) => {
    void presentationResources[surface].load().catch(() => undefined)
  },
  subscribe: (listener: () => void) => {
    const unsubscribeTranscript = messageListModuleResource.subscribe(listener)
    const unsubscribeTree = branchTreeViewModuleResource.subscribe(listener)
    return () => {
      unsubscribeTranscript()
      unsubscribeTree()
    }
  },
})
conversationController.installPresentationResourcePort(conversationPresentationResourcePort)
const loadImportModal = () =>
  Promise.all([import('../ui/chat/ImportModal'), loadConversationActions()]).then(([module]) => ({
    default: module.ImportModal,
  }))
const loadStorageView = () =>
  import('../ui/storage/StorageView').then((module) => ({ default: module.StorageView }))

const ImportModal = lazy(loadImportModal)
const StorageView = lazy(loadStorageView)
const PENDING_TREE_GENERATION_START = generationNotStarted(
  pendingGenerationCapability('prompt-path'),
)

function preload(loader: () => Promise<unknown>): void {
  void loader().catch(() => undefined)
}

const preloadMessageList = () => preload(loadMessageList)
const preloadBranchTreeView = () => preload(loadBranchTreeView)
const preloadImportModal = () => preload(loadImportModal)
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

function TranscriptLoadFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <div data-ui="surface-loading" data-placement="inline" role="alert">
      <span>Conversation could not be loaded.</span>
      <Button type="button" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}

function ConfigurationLoadFailure({ loads }: { loads: ConfigurationProjectionLoadStates }) {
  const failed = (['shell', 'globalTokenCalibration', 'textTemplates'] as const).filter(
    (kind) => loads[kind].status === 'error',
  )
  if (failed.length === 0) return null
  const retry = () => {
    for (const kind of failed) configurationController.retryProjection(kind)
  }
  return (
    <div data-ui="banner-tray">
      <div data-ui="banner" data-kind="configuration-load" data-tone="warning" role="alert">
        <span data-ui="banner-text">
          Workspace configuration could not be loaded. Defaults are being used where possible.
        </span>
        <span data-ui="banner-spacer" />
        <Button type="button" data-ui="banner-primary" onClick={retry}>
          Retry
        </Button>
      </div>
    </div>
  )
}

const MOBILE_SHELL_QUERY = '(max-width: 700px)'

interface TreeInsertTarget {
  chatId: ChatId
  slot: PasteImportSlot
  defaultRole: MessageRole
}

function oppositeRole(role: MessageRole): MessageRole {
  if (role === 'user') return 'assistant'
  if (role === 'assistant') return 'user'
  return role
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

export function Shell() {
  const workspaceRuntimeState = useSyncExternalStore(
    subscribeWorkspaceRuntimeState,
    getWorkspaceRuntimeState,
    getWorkspaceRuntimeState,
  )
  const route = useRoute()
  const messageListModule = useSyncExternalStore(
    messageListModuleResource.subscribe,
    messageListModuleResource.getSnapshot,
    messageListModuleResource.getSnapshot,
  )
  const branchTreeViewModule = useSyncExternalStore(
    branchTreeViewModuleResource.subscribe,
    branchTreeViewModuleResource.getSnapshot,
    branchTreeViewModuleResource.getSnapshot,
  )
  const MessageList = messageListModule?.default
  const BranchTreeView = branchTreeViewModule?.default
  const activeChatId = route.kind === 'chat' ? route.chatId : null
  const onNewChatSurface = route.kind === 'new'
  if (activeChatId || onNewChatSurface) preloadMessageList()
  const activeStorageRoute = route.kind === 'storage' ? route.storage : null
  const activeStorageRouteKey = activeStorageRoute ? storageHref(activeStorageRoute) : null
  const focusModeAvailable = !activeStorageRoute
  const activeSurfaceKey = activeChatId
    ? `chat:${activeChatId}`
    : activeStorageRouteKey
      ? `storage:${activeStorageRouteKey}`
      : onNewChatSurface
        ? 'new'
        : 'empty'
  const isNarrowScreen = useMediaQuery(MOBILE_SHELL_QUERY)
  const configurationSession = useSyncExternalStore(
    configurationController.subscribe,
    configurationController.getSnapshot,
    configurationController.getSnapshot,
  )
  const profileCount = configurationSession.frame.shell?.totalProfileCount
  const connectionAvailability = connectionAvailabilityFromProfileCount(profileCount)
  const connectionKnown = connectionAvailability !== 'unknown'
  const [chatModelOpen, setChatModelOpen] = useState(false)
  const [globalSettingsOpen, setGlobalSettingsOpen] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [composerSeed, setComposerSeed] = useState<string | null>(null)
  const [composerDroppedFiles, setComposerDroppedFiles] = useState<ComposerDroppedFiles | null>(
    null,
  )
  const [scrollState, setScrollState] = useState<ScrollState>('follow')
  const [importAtEndOpen, setImportAtEndOpen] = useState(false)
  const [treeInsertTarget, setTreeInsertTarget] = useState<TreeInsertTarget | null>(null)
  const { run: runGenerationSubmit } = usePresentationInteraction(generationSubmitInteraction)
  const { run: runConversationMutationInteraction } = usePresentationInteraction(
    conversationMutationInteraction,
    { observePending: false },
  )
  const runConversationMutation = useCallback(
    (
      intent: ConversationMutationIntent,
      action: () => Promise<void>,
    ): ConversationMutationSettlement =>
      runConversationMutationInteraction({
        target: conversationMutationTarget(intent),
        action,
      }).settled,
    [runConversationMutationInteraction],
  )
  const editTreeMode = useUiStore((s) => s.editTreeMode)
  const setEditTreeMode = useUiStore((s) => s.setEditTreeMode)
  const treeExpanded = useUiStore((s) => s.treeExpanded)
  const conversationSnapshot = useConversationSnapshot()
  const pushBanner = useToastStore((s) => s.pushBanner)
  const pushToast = useToastStore((s) => s.push)
  const clearBannersByKind = useToastStore((s) => s.clearBannersByKind)
  const activeConversation =
    activeChatId !== null && conversationSnapshot.active?.chatId === activeChatId
      ? conversationSnapshot.active
      : null
  const conversationWorkspaceFence = useMemo(
    () => ({
      workspaceId: conversationSnapshot.workspaceId ?? '',
      replacementEpoch: conversationSnapshot.workspaceEpoch,
    }),
    [conversationSnapshot.workspaceEpoch, conversationSnapshot.workspaceId],
  )
  const activePresentation = activeConversation?.presentation ?? null
  const visibleConversationSurface = activePresentation?.painted?.binding.surface ?? null
  const displayedConversationSurface =
    visibleConversationSurface ?? activePresentation?.request.surface ?? 'transcript'
  const treeViewActive = displayedConversationSurface === 'tree'
  const treeViewRequested = activePresentation?.request.surface === 'tree'
  if (treeViewRequested) preloadBranchTreeView()
  const focusMode = useUiStore((s) => s.focusMode)
  const transcriptFocusMode = !isNarrowScreen && focusMode && focusModeAvailable
  const effectiveFocusMode = !treeViewActive && transcriptFocusMode
  useEffect(() => {
    if (treeViewActive && editTreeMode) setEditTreeMode(false)
  }, [editTreeMode, setEditTreeMode, treeViewActive])
  const lastProjectionFailureRef = useRef<string | null>(null)
  useEffect(() => {
    const failure = activeConversation?.failure
    if (!failure) return
    const failureKey = `${activeConversation.chatId}:${failure.kind}:${failure.code}:${failure.key}:${failure.observationRevision}`
    if (lastProjectionFailureRef.current === failureKey) return
    lastProjectionFailureRef.current = failureKey
    pushToast({ level: 'danger', text: `Chat view failed to refresh: ${failure.message}` })
  }, [activeConversation, pushToast])
  const lastPresentationFailureRef = useRef<string | null>(null)
  useEffect(() => {
    const target = activePresentation?.target
    if (!activePresentation || target?.kind !== 'failed') return
    const key = `${activeConversation?.chatId ?? ''}:${activePresentation.request.revision}:${target.surface}:${target.blocker}:${target.message}`
    if (lastPresentationFailureRef.current === key) return
    lastPresentationFailureRef.current = key
    pushToast({
      level: 'danger',
      text: `Conversation ${target.surface} failed to load: ${target.message}`,
    })
  }, [activeConversation?.chatId, activePresentation, pushToast])
  const resolvedActiveChatRow = activeConversation?.chat
    ? configurationController.projectChatConfiguration(activeConversation.chat)
    : undefined
  const configurationPreferences = useConfigurationPreferences()
  const loadedPrefs = configurationPreferences?.global
  const prefs = loadedPrefs ?? DEFAULT_GLOBAL_PREFERENCES
  const transcriptMounted = activePresentation?.mounted.transcript ?? !treeViewActive
  const treeMounted = activePresentation?.mounted.tree ?? treeViewRequested
  const {
    visibleBinding,
    paintedChat,
    transcriptBinding,
    treeBinding,
    activePath,
    activeBranchTailId,
    treeStreams,
    selectedPathStreamActive,
    newestTranscriptStream,
    newestSelectedPathStream,
    composerStream,
    keyboardStopAttempt,
    transcriptPresentationOnly,
    activeTranscriptExists,
    activeRevealRequest,
    acknowledgeActiveRevealRequest,
    urlPinnedTargetPending,
    transcriptLoadFailed,
    loadOlderMessageWindow,
  } = useActiveBranchFrame({
    activeChatId,
    frame: activeConversation,
    workspaceFence: conversationWorkspaceFence,
    ...(route.kind === 'chat' && route.pinnedMessageId !== undefined
      ? { pinnedMessageId: route.pinnedMessageId }
      : {}),
    initialTranscriptWorkScale: prefs.messageInitialRenderWork,
  })
  const catalogTab = useCatalogTab()
  const resolvedPaintedChatRow = paintedChat
    ? catalogChatPresentation(
        catalogTab,
        configurationController.projectChatConfiguration(paintedChat),
      )
    : undefined
  useEffect(() => {
    if (paintedChat) catalogApplication.tab.observeChatRows([paintedChat])
  }, [paintedChat])
  const visiblePresentationOnly =
    visibleBinding === null ||
    visibleBinding.currency !== 'current' ||
    visibleBinding.seal.chatId !== activeChatId
  useEffect(() => {
    if (!treeViewActive) return
    setTreeInsertTarget(null)
  }, [treeViewActive])
  useEffect(() => {
    if (urlPinnedTargetPending) {
      setImportAtEndOpen(false)
      setTreeInsertTarget(null)
      return
    }
    if (!treeViewActive && transcriptPresentationOnly) setImportAtEndOpen(false)
  }, [transcriptPresentationOnly, treeViewActive, urlPinnedTargetPending])
  // One catalog projection supplies the same live-plus-bundled rows to every
  // model, capability and privacy consumer on this surface.
  const configurationTarget =
    configurationSession.frame.target.kind === 'new-chat' ||
    configurationSession.frame.target.kind === 'chat'
      ? configurationSession.frame.target
      : null
  const attemptTargetAdmission = useAttemptTargetAdmissionFrame(activeChatId)
  const generationCapabilityFrame =
    generationCapabilityController.captureFrame(attemptTargetAdmission)
  const connectionGenerationCapability = generationCapabilityFrame.capability(
    configurationTarget?.kind === 'new-chat' ? { kind: 'new-chat-send' } : null,
  )
  const activeSendCapability = generationCapabilityFrame.capability(
    activeChatId
      ? { kind: 'send', chatId: activeChatId, expectedLeafId: activeBranchTailId }
      : null,
  )
  const targetProfileId = configurationTarget?.profileId ?? null
  const selectedCatalogProfile =
    currentActiveConfigurationSelection(configurationSession.frame)?.value.profile ?? null
  const activeProfileForModelList =
    selectedCatalogProfile?.id === targetProfileId ? selectedCatalogProfile : undefined
  const activeModelCatalog = useModelCatalog(configurationTarget, activeProfileForModelList, {
    modelsDemanded: chatModelOpen,
  })
  const activeEndpoints = activeModelCatalog.routing
  const activeCapabilityPresentation = activeEndpoints.capabilityPresentation
  const activeCapability = activeCapabilityPresentation.capability
  const activePrefillPlan = useMemo(() => {
    if (activeCapabilityPresentation.retained) {
      return activeCapabilityPresentation.effectiveRouting?.prefillPlan ?? PREFILL_UNAVAILABLE_PLAN
    }
    const profile = activeProfileForModelList
    const settings = resolvedActiveChatRow?.settings
    if (!profile || !settings) return PREFILL_UNAVAILABLE_PLAN
    const contextFacts = activePath
      ? mergeMessageContextRouteFacts(
          activePath
            .materializeNodes()
            .filter((header) => !header.deleted && header.hiddenFromContext !== true)
            .map((header) => header.contextRouteFacts),
        )
      : EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS
    const routing = activeEndpoints.effectiveRouting
    if (!routing) return PREFILL_UNAVAILABLE_PLAN
    return rebaseEffectiveEndpointRouting(routing, contextFacts).prefillPlan
  }, [
    activeEndpoints.effectiveRouting,
    activePath,
    activeCapabilityPresentation.effectiveRouting,
    activeCapabilityPresentation.retained,
    activeProfileForModelList,
    resolvedActiveChatRow?.settings,
  ])
  const sidebarSortMode = configurationPreferences?.sidebarSortMode ?? DEFAULT_SIDEBAR_SORT_MODE
  const trailingLeaf = activePath?.leaf ?? null
  const trailingUserMessage = trailingLeaf?.role === 'user' ? trailingLeaf : null
  const trailingReplyCapability = generationCapabilityFrame.capability(
    activeChatId && trailingUserMessage
      ? { kind: 'reply', chatId: activeChatId, parentUserId: trailingUserMessage.id }
      : null,
  )
  const sidebarCollapsed = configurationSession.ui.sidebarCollapsed
  const updateSidebarCollapsed = useCallback((collapsed: boolean) => {
    configurationController.setSidebarCollapsed(collapsed)
    void writeSidebarCollapsed(collapsed).catch((error: unknown) => {
      console.error('Failed to save sidebar preference', error)
    })
  }, [])
  const scrollRef = useRef<ScrollRegionHandle>(null)
  useLayoutEffect(() => {
    void treeViewActive
    if (!activeChatId) return
    return conversationController.installViewportPort({
      chatId: activeChatId,
      prepare: (transition) =>
        scrollRef.current?.prepareLayoutChange(transition) ?? { kind: 'unavailable' },
    })
  }, [activeChatId, treeViewActive])
  const activeComposerDraftKey = activeChatId
    ? `chat:${activeChatId}`
    : onNewChatSurface
      ? 'new'
      : null
  const requestStop = useCallback(
    (capability: RequestableAttemptStopCapability) => {
      const request = requestAttemptStop(capability)
      void request.completed.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown error'
        pushToast({ level: 'danger', text: `Stop failed: ${message}` })
      })
    },
    [pushToast],
  )
  const composerStopCapability = useMemo(
    () => attemptStopCapability(composerStream),
    [composerStream],
  )
  const keyboardStopCapability = useMemo(
    () => attemptStopCapability(keyboardStopAttempt),
    [keyboardStopAttempt],
  )
  const requestKeyboardStop = useCallback(() => {
    if (keyboardStopCapability?.kind === 'requestable') requestStop(keyboardStopCapability)
  }, [keyboardStopCapability, requestStop])
  const selectedPathFollowKey = newestTranscriptStream
    ? `${newestTranscriptStream.streamId}:${newestTranscriptStream.messageId}`
    : null
  const selectedPathFollowTargetMessageId =
    newestTranscriptStream?.messageId ?? transcriptBinding?.seal.leafId ?? null
  const selectedPathRevealClaimKey = activeRevealRequest?.revision ?? null
  const acknowledgeSelectedPathRevealClaim = useCallback(() => {
    if (activeRevealRequest) acknowledgeActiveRevealRequest(activeRevealRequest)
  }, [acknowledgeActiveRevealRequest, activeRevealRequest])

  useEffect(() => {
    if (activeStorageRoute && chatModelOpen) setChatModelOpen(false)
  }, [activeStorageRoute, chatModelOpen])

  useEffect(() => {
    if (!isNarrowScreen) setMobileSidebarOpen(false)
  }, [isNarrowScreen])

  const previousActiveSurfaceKeyRef = useRef(activeSurfaceKey)
  useEffect(() => {
    if (previousActiveSurfaceKeyRef.current === activeSurfaceKey) return
    previousActiveSurfaceKeyRef.current = activeSurfaceKey
    setMobileSidebarOpen(false)
  }, [activeSurfaceKey])

  const previousActiveChatIdRef = useRef<ChatId | null>(activeChatId)
  useEffect(() => {
    const previous = previousActiveChatIdRef.current
    previousActiveChatIdRef.current = activeChatId
    if (!previous || previous === activeChatId) return
    const controller = new AbortController()
    void discardEmptyDraftChat(previous, { signal: controller.signal }).catch((error: unknown) => {
      if (controller.signal.aborted || isPageHidingAbortError(error)) return
      console.error('Failed to discard empty draft chat', error)
    })
    return () => controller.abort()
  }, [activeChatId])

  useEffect(() => {
    if (!activeChatId) return
    const controller = new AbortController()
    void touchLastViewed(activeChatId, Date.now(), { signal: controller.signal }).catch(
      (error: unknown) => {
        if (controller.signal.aborted || isPageHidingAbortError(error)) return
        console.error('Failed to update chat viewed timestamp', error)
      },
    )
    return () => controller.abort()
  }, [activeChatId])

  const openingNewChatSettingsRef = useRef<{
    readonly intent: ReturnType<typeof beginRouteIntent>
    readonly task: Promise<void>
  } | null>(null)
  const openSettingsForNewChat = useCallback((): Promise<void> => {
    const pending = openingNewChatSettingsRef.current
    if (pending && isRouteIntentCurrent(pending.intent)) return pending.task
    const routeIntent = beginRouteIntent()
    const task = (async () => {
      try {
        const materialized = await materializeTemporaryNewChat(routeIntentOwner(routeIntent))
        if (!materialized) return
        if (navigateToChatForIntent(routeIntent, materialized.chatId, materialized.routeHandoff)) {
          moveComposerDraft('new', `chat:${materialized.chatId}`)
          setChatModelOpen(true)
        }
      } finally {
        cancelRouteIntent(routeIntent)
        if (openingNewChatSettingsRef.current?.intent === routeIntent) {
          openingNewChatSettingsRef.current = null
        }
      }
    })()
    openingNewChatSettingsRef.current = Object.freeze({ intent: routeIntent, task })
    return task
  }, [])

  const openNewChat = useCallback(() => {
    if (route.kind !== 'new') navigateNew()
    if (chatModelOpen) {
      void openSettingsForNewChat()
      return
    }
    if (route.kind === 'new') navigateNew()
  }, [chatModelOpen, openSettingsForNewChat, route.kind])

  const handleNewChatClick = useMemo(
    () => makeAnchorClickHandler(newChatHref(), () => openNewChat()),
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
    const controller = new AbortController()
    void readWorkspaceMeta({ signal: controller.signal })
      .then((meta) => {
        if (!active || meta.backendKind !== 'browser-idb') return
        cleanup = installPersistenceRequestOnFirstInteraction()
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isPageHidingAbortError(error)) return
        console.error('Failed to inspect workspace backend for persistence request', error)
      })
    return () => {
      active = false
      controller.abort()
      cleanup()
    }
  }, [])

  // Persist the panel's open/closed state across route transitions —
  // in particular, navigating to /new or between chats shouldn't auto-
  // collapse the settings pane the user explicitly opened.

  // Chat-not-found banner: if the route refers to a chat id that doesn't
  // resolve (deleted, never existed, or pasted from another workspace),
  // surface the banner per §10.13.1 Route table. Reactive storage invalidation guarantees
  // re-evaluation when the chats table changes.
  const routedChatExists =
    !activeChatId || !activeConversation || activeConversation.destination.kind !== 'missing'
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

  const showPrefillButton = activePrefillPlan.availability !== 'unsupported'
  const activeDefaultPrefill = resolvedActiveChatRow?.settings.defaultPrefill ?? ''
  const attachmentsDisabledForActiveChat = resolvedActiveChatRow
    ? attachmentsDisabledByTextProtocol(resolvedActiveChatRow.settings)
    : false
  const handleDroppedFilesConsumed = useCallback((id: string) => {
    setComposerDroppedFiles((current) => (current?.id === id ? null : current))
  }, [])

  const ownGenerationSubmission = useCallback(
    (action: (signal: AbortSignal) => Promise<void>): ComposerSubmission => {
      const claim = runGenerationSubmit({
        target: 'composer',
        action: ({ signal }) => action(signal),
      })
      const completion = (async (): Promise<ComposerSubmissionOutcome> => {
        const outcome = await claim.settled
        switch (outcome.kind) {
          case 'succeeded':
            return Object.freeze({ kind: 'prepared' })
          case 'failed':
          case 'superseded':
          case 'rejected-pending':
          case 'cancelled':
            return Object.freeze({ kind: 'not-prepared', reason: outcome.kind })
        }
      })()
      return Object.freeze({ kind: 'started', completion })
    },
    [runGenerationSubmit],
  )

  const handleSubmit = useCallback(
    (
      text: string,
      opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
    ): ComposerSubmission => {
      if (!activeChatId) throw new Error('SendActiveChatMissing')
      const prefillText = opts?.prefillText ?? ''
      return ownGenerationSubmission(async (signal) => {
        const admission = generationCapabilityController.claimSelectedSend(activeChatId)
        let admissionTransferred = false
        try {
          const conversationActions = await loadConversationActions()
          const handlePromise = conversationActions.sendSelectedMessageWhenCapabilitySettles(
            activeChatId,
            [{ type: 'text', text }],
            signal,
            {
              admission,
              ...(opts?.attachmentRefs ? { attachmentRefs: opts.attachmentRefs } : {}),
              ...(prefillText.length > 0
                ? { prefillContent: [{ type: 'text', text: prefillText }] }
                : {}),
            },
          )
          admissionTransferred = true
          const handle = await handlePromise
          preloadMessageList()
          await handle.prepared
        } finally {
          if (!admissionTransferred) {
            generationCapabilityController.cancelSelectedSend(admission)
          }
        }
      })
    },
    [activeChatId, ownGenerationSubmission],
  )

  const handleNewChatSubmit = useCallback(
    (
      text: string,
      opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
    ): ComposerSubmission => {
      const prefillText = opts?.prefillText ?? ''
      return ownGenerationSubmission(async (signal) => {
        const routeIntent = beginRouteIntent()
        try {
          const conversationActions = await loadConversationActions()
          const handle = await conversationActions.sendNewChatWhenCapabilitySettles(
            [{ type: 'text', text }],
            routeIntentOwner(routeIntent),
            signal,
            {
              ...(opts?.attachmentRefs ? { attachmentRefs: opts.attachmentRefs } : {}),
              ...(prefillText.length > 0
                ? { prefillContent: [{ type: 'text', text: prefillText }] }
                : {}),
            },
          )
          const prepared = await handle.prepared
          if (prepared.kind === 'handoff') {
            navigateToChatForIntent(routeIntent, prepared.chatId, prepared.handoff)
          }
        } finally {
          cancelRouteIntent(routeIntent)
        }
      })
    },
    [ownGenerationSubmission],
  )

  const handleReplyToTrailingUser = useCallback((): ComposerSubmission => {
    if (!activeChatId || !trailingUserMessage) {
      return Object.freeze({
        kind: 'not-started',
        capability: pendingGenerationCapability('prompt-path'),
      })
    }
    return ownGenerationSubmission(async (signal) => {
      const conversationActions = await loadConversationActions()
      const handle = await conversationActions.replyToMessageWhenCapabilitySettles(
        activeChatId,
        trailingUserMessage.id,
        signal,
      )
      await handle.prepared
    })
  }, [activeChatId, ownGenerationSubmission, trailingUserMessage])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const activeTag = (document.activeElement?.tagName ?? '').toLowerCase()
      const isTyping = activeTag === 'input' || activeTag === 'textarea'
      if (e.key.toLowerCase() === 'o' && (e.metaKey || e.ctrlKey) && e.shiftKey && !isTyping) {
        e.preventDefault()
        openNewChat()
      }
      if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setGlobalSettingsOpen((v) => !v)
      }
      if (
        e.key === '.' &&
        (e.metaKey || e.ctrlKey) &&
        keyboardStopCapability?.kind === 'requestable'
      ) {
        e.preventDefault()
        requestKeyboardStop()
      }
      // Edit-tree mode toggle (§10.14). Works globally; scoped by chat only
      // because the mode visually affects rows — the store field itself is
      // app-wide.
      if (e.key === 'E' && e.shiftKey && (e.metaKey || e.ctrlKey) && !isTyping && !treeViewActive) {
        e.preventDefault()
        const nextEditTreeMode = !useUiStore.getState().editTreeMode
        setEditTreeMode(nextEditTreeMode)
        announceEditTreeMode(nextEditTreeMode)
      }
      // Import-at-end modal shortcut (§10.14). Only meaningful on an active
      // chat; the keystroke is swallowed either way so DevTools bindings
      // (`Ctrl+Shift+I`) don't stomp on it.
      if (
        e.key === 'V' &&
        e.shiftKey &&
        (e.metaKey || e.ctrlKey) &&
        activeChatId &&
        !isTyping &&
        (treeViewActive || !transcriptPresentationOnly)
      ) {
        e.preventDefault()
        setImportAtEndOpen(true)
      }
      if (e.key === 'Escape') {
        if (useUiStore.getState().editTreeMode) {
          e.preventDefault()
          setEditTreeMode(false)
          announceEditTreeMode(false)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    requestKeyboardStop,
    keyboardStopCapability,
    activeChatId,
    setEditTreeMode,
    openNewChat,
    transcriptPresentationOnly,
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
  const treeHeaderById = treeBinding?.headers ?? null
  const treeProjection = treeBinding?.topology ?? null
  const treeStreamTargetIds = useMemo(() => {
    const ids = new Set<MessageId>()
    for (const attempt of treeStreams) {
      if (attempt.messageId) ids.add(attempt.messageId)
    }
    return ids
  }, [treeStreams])
  const activateTreeNode = useCallback(
    (messageId: MessageId, observedTipId?: MessageId) => {
      if (!activeChatId || !treeHeaderById) return
      const header = treeHeaderById.get(messageId)
      if (!header || header.deleted) return
      navigateConversationMessage(activeChatId, messageId, observedTipId)
      announceTreeBranchOpened(header.role)
    },
    [activeChatId, treeHeaderById],
  )
  const insertAtSharedTreeTrunk = useCallback(
    (parentId: MessageId | null) => {
      if (!activeChatId || !treeHeaderById || !treeProjection) return
      const childStreaming = (treeProjection.liveByParent.get(parentId) ?? []).some((header) => {
        return treeStreamTargetIds.has(header.id)
      })
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
    [activeChatId, pushToast, treeHeaderById, treeProjection, treeStreamTargetIds],
  )
  const insertAtTreeChildLeg = useCallback(
    (childId: MessageId) => {
      if (!activeChatId || !treeHeaderById) return
      const child = treeHeaderById.get(childId)
      if (!child || child.deleted) return
      if (treeStreamTargetIds.has(childId)) {
        pushToast({ level: 'info', text: 'Wait for this generation to finish.' })
        return
      }
      setTreeInsertTarget({
        chatId: activeChatId,
        slot: { kind: 'before', messageId: childId },
        defaultRole: oppositeRole(child.role),
      })
    },
    [activeChatId, pushToast, treeHeaderById, treeStreamTargetIds],
  )
  const insertAfterTreeLeaf = useCallback(
    (messageId: MessageId) => {
      if (!activeChatId || !treeHeaderById || !treeProjection) return
      const leaf = treeHeaderById.get(messageId)
      if (!leaf || leaf.deleted) return
      const hasLiveChild = (treeProjection.liveByParent.get(messageId)?.length ?? 0) > 0
      if (hasLiveChild) return
      if (treeStreamTargetIds.has(messageId)) {
        pushToast({ level: 'info', text: 'Wait for this generation to finish.' })
        return
      }
      setTreeInsertTarget({
        chatId: activeChatId,
        slot: { kind: 'after', messageId },
        defaultRole: oppositeRole(leaf.role),
      })
    },
    [activeChatId, pushToast, treeHeaderById, treeProjection, treeStreamTargetIds],
  )
  const editTreeMessage = useCallback(
    (message: Message, text: string) =>
      runConversationMutation({ kind: 'edit', chatId: message.chatId, messageId: message.id }, () =>
        requireConversationActions().editMessage(message.chatId, message, text),
      ),
    [runConversationMutation],
  )
  const editAndSendTreeMessage = useCallback(
    (message: Message, text: string) => {
      if (!activeChatId || message.chatId !== activeChatId || message.role !== 'user') {
        return PENDING_TREE_GENERATION_START
      }
      return requireConversationActions().editAndResend(
        activeChatId,
        message,
        text,
        message.attachmentRefs ? { attachmentRefs: message.attachmentRefs } : {},
      )
    },
    [activeChatId],
  )
  const deleteTreeNode = useCallback(
    (message: Message) =>
      runConversationMutation({ kind: 'delete', chatId: message.chatId }, () =>
        requireConversationActions().deleteMessage(message.chatId, message.id, 'single'),
      ),
    [runConversationMutation],
  )
  const regenerateTreeMessage = useCallback(
    (message: Message) => {
      if (!activeChatId || message.chatId !== activeChatId || message.role !== 'assistant') {
        return PENDING_TREE_GENERATION_START
      }
      return requireConversationActions().regenerate(activeChatId, message)
    },
    [activeChatId],
  )
  const continueTreeMessage = useCallback(
    (message: Message) => {
      if (!activeChatId || message.chatId !== activeChatId || message.role !== 'assistant') {
        return PENDING_TREE_GENERATION_START
      }
      return requireConversationActions().continueMessage(activeChatId, message)
    },
    [activeChatId],
  )
  const forkTreeMessage = useCallback(
    (message: Message) =>
      runConversationMutation({ kind: 'fork', chatId: message.chatId, messageId: message.id }, () =>
        requireConversationActions().forkMessage(message.chatId, message),
      ),
    [runConversationMutation],
  )
  const toggleTreeMessageContextVisibility = useCallback(
    (message: Message) =>
      runConversationMutation(
        { kind: 'context', chatId: message.chatId, messageId: message.id },
        () => requireConversationActions().toggleContext(message.chatId, message),
      ),
    [runConversationMutation],
  )
  const mutateTreeMessageAttachmentRef = useCallback(
    (message: Message, mutation: MessageAttachmentRefMutation) =>
      requireConversationActions().mutateAttachment(message, mutation),
    [],
  )
  const toggleTreeReasoningDetailHidden = useCallback(
    (message: Message, member: ReasoningMemberRef) =>
      runConversationMutation(
        {
          kind: 'reasoning',
          chatId: message.chatId,
          messageId: message.id,
          member,
        },
        () => requireConversationActions().toggleReasoning(message.chatId, message, member),
      ),
    [runConversationMutation],
  )
  const toggleTreeProviderOutputItemHidden = useCallback(
    (message: Message, member: ProviderOutputMemberRef) =>
      runConversationMutation(
        {
          kind: 'provider-output',
          chatId: message.chatId,
          messageId: message.id,
          member,
        },
        () => requireConversationActions().toggleProviderOutput(message.chatId, message, member),
      ),
    [runConversationMutation],
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
  const unmaterializedChatTitleBar = activeChatId ? null : (
    <div data-ui="chat-title-bar" {...(onNewChatSurface ? {} : { 'data-mobile-home': true })}>
      <IconButton
        type="button"
        data-ui="icon-button"
        data-role="mobile-sidebar-toggle"
        aria-label="Open chats sidebar"
        aria-expanded={mobileSidebarOpen}
        title="Chats"
        onClick={() => setMobileSidebarOpen(true)}
      >
        <SidebarIcon size={20} />
      </IconButton>
      {onNewChatSurface ? <ConnectionHeader variant="title-icon" /> : null}
      <span data-ui="chat-title" data-title-status={onNewChatSurface ? 'untitled' : 'manual'}>
        <span data-ui="chat-title-label">{onNewChatSurface ? 'New chat' : 'natter'}</span>
      </span>
      <span data-ui="header-spacer" />
      <IconButton
        type="button"
        data-ui="icon-button"
        data-role="settings-cog"
        aria-label="Open chat settings"
        title="Chat settings"
        onClick={() => void openSettingsForNewChat()}
      >
        <CogIcon size={20} />
      </IconButton>
      <MobileNewChatControls connectionControl={newChatMobileConnectionControl} />
    </div>
  )
  const activeComposerProps:
    | (ComposerProps & {
        generationCapability: NonNullable<ComposerProps['generationCapability']>
      })
    | null = activeChatId
    ? {
        onSubmit: handleSubmit,
        ...(composerStopCapability ? { stopCapability: composerStopCapability } : {}),
        onRequestStop: requestStop,
        autoSize: true,
        ...(transcriptFocusMode ? { autoSizeVariant: 'focus' as const } : {}),
        autoSizeMeasurementKey: `${prefs.fontFamily}:${prefs.baseFontSize}`,
        generationCapability: activeSendCapability,
        replyGenerationCapability: trailingReplyCapability,
        seed: composerSeed,
        onSeedConsumed: () => setComposerSeed(null),
        draftKey: activeComposerDraftKey,
        attachmentScopeKey: activeChatId,
        attachmentsDisabled: attachmentsDisabledForActiveChat,
        attachmentsDisabledReason: 'Attachments are unavailable with Text completions.',
        droppedFiles: composerDroppedFiles,
        onDroppedFilesConsumed: handleDroppedFilesConsumed,
        sendShortcut: prefs.sendShortcut,
        onImportAtEndIntent: preloadImportModal,
        onImportAtEnd: () => setImportAtEndOpen(true),
        ...(showPrefillButton
          ? {
              showPrefillButton: true,
              defaultPrefill: activeDefaultPrefill,
              prefillScopeKey: activeChatId,
              prefillSettingsPrompt: resolvedActiveChatRow ? (
                <PrefillSettingsPrompt chatId={resolvedActiveChatRow.id} plan={activePrefillPlan} />
              ) : null,
            }
          : {}),
        trailingUserMessage: Boolean(trailingUserMessage),
        ...(trailingUserMessage ? { onReplyToTrailingUser: handleReplyToTrailingUser } : {}),
        ...(!transcriptFocusMode && scrollState === 'pinned'
          ? {
              floatingAccessory: (
                <Button
                  type="button"
                  data-ui="jump-to-latest"
                  onClick={() => scrollRef.current?.scrollToBottom({ smooth: true })}
                >
                  ↓ Jump to latest
                </Button>
              ),
            }
          : {}),
      }
    : null
  const readyConfigurationSelection = readyActiveConfigurationSelection(configurationSession.frame)
  const activeComposerPresentationReady =
    activeChatId !== null &&
    activePresentation?.visibleReady === true &&
    readyConfigurationSelection?.target.kind === 'chat' &&
    readyConfigurationSelection.target.chatId === activeChatId
  const composerPresentation = useSampleAndHoldPresentation(
    activeComposerProps,
    activeComposerPresentationReady,
  )
  const displayedTranscriptComposer = composerPresentation.value ? (
    <Composer
      key={composerPresentation.value.draftKey}
      {...composerPresentation.value}
      generationCapability={composerPresentation.value.generationCapability}
      presentationOnly={composerPresentation.retained}
    />
  ) : null
  const activeSurfaceReady = activeChatId ? activePresentation?.visibleReady === true : true

  return (
    <div
      data-ui="app-shell"
      data-workspace-runtime-state={workspaceRuntimeState}
      data-chat-model-panel={showChatModelPanel ? 'open' : 'closed'}
      data-sidebar={effectiveSidebarCollapsed ? 'collapsed' : 'expanded'}
      data-mobile-sidebar={mobileSidebarOpen ? 'open' : 'closed'}
      data-focus-mode={effectiveFocusMode ? 'on' : 'off'}
    >
      <LiveRegions />
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
          <IconButton
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
              updateSidebarCollapsed(!sidebarCollapsed)
            }}
          >
            <ChevronIcon size={16} rotate={effectiveSidebarCollapsed ? 0 : 180} />
          </IconButton>
          <a
            data-ui="icon-button"
            data-role="new-chat"
            href={newChatHref()}
            rel="noopener"
            aria-label="New chat"
            aria-keyshortcuts="Meta+Shift+O Control+Shift+O"
            title="New chat (⌘⇧O / Ctrl+Shift+O)"
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
          <Button
            type="button"
            data-ui="open-global-settings"
            aria-label="Open settings"
            title="Settings (⌘,)"
            onClick={() => setGlobalSettingsOpen(true)}
          >
            <CogIcon size={18} />
            <span>Settings</span>
          </Button>
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
        data-active-surface-ready={activeSurfaceReady}
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
        <ConfigurationLoadFailure loads={configurationSession.loads} />
        {activeStorageRoute ? (
          <Suspense fallback={<SurfaceLoading label="Loading storage…" />}>
            <StorageView
              route={activeStorageRoute}
              onOpenSidebar={() => setMobileSidebarOpen(true)}
            />
          </Suspense>
        ) : (
          <>
            {connectionAvailability === 'missing' && !isNarrowScreen ? (
              <ConnectionHeader
                activeChatId={activeChatId}
                activeChatProfileId={resolvedActiveChatRow?.settings.profileId ?? null}
              />
            ) : null}
            {activeChatId ? (
              <>
                <div
                  data-ui="chat-title-bar"
                  data-chat-id={resolvedPaintedChatRow?.id}
                  data-presentation-only={transcriptPresentationOnly || undefined}
                >
                  <IconButton
                    type="button"
                    data-ui="icon-button"
                    data-role="mobile-sidebar-toggle"
                    aria-label="Open chats sidebar"
                    aria-expanded={mobileSidebarOpen}
                    title="Chats"
                    onClick={() => setMobileSidebarOpen(true)}
                  >
                    <SidebarIcon size={20} />
                  </IconButton>
                  <ConnectionHeader
                    variant="title-icon"
                    activeChatId={paintedChat?.id ?? activeChatId}
                    activeChatProfileId={resolvedPaintedChatRow?.settings.profileId ?? null}
                  />
                  <ChatHeader
                    chat={resolvedPaintedChatRow}
                    paintedBranchLeafId={visibleBinding?.seal.leafId ?? undefined}
                    presentationOnly={visiblePresentationOnly}
                    privacyRouting={activeModelCatalog.routing}
                    settingsOpen={chatModelOpen}
                    onToggleSettings={() => setChatModelOpen((v) => !v)}
                    editTreeActive={editTreeMode}
                    onToggleEditTree={() => {
                      const nextEditTreeMode = !editTreeMode
                      setEditTreeMode(nextEditTreeMode)
                      announceEditTreeMode(nextEditTreeMode)
                    }}
                    treeViewActive={treeViewActive}
                    onTreeViewIntent={preloadBranchTreeView}
                    onToggleTreeView={() => {
                      const retryingFailedTree =
                        treeViewRequested && activePresentation.target.kind === 'failed'
                      const surface =
                        treeViewActive || (treeViewRequested && !retryingFailedTree)
                          ? 'transcript'
                          : 'tree'
                      if (surface === 'tree') setEditTreeMode(false)
                      conversationController.requestPresentation({
                        chatId: activeChatId,
                        surface,
                        ...(surface === 'tree' && newestSelectedPathStream?.messageId
                          ? { revealTargetMessageId: newestSelectedPathStream.messageId }
                          : {}),
                      })
                    }}
                    mobileConnectionControl={activeMobileConnectionControl}
                  />
                </div>
                {!treeViewActive ? <EditTreeToolbar /> : null}
                <BannerTray />
                {treeMounted ? (
                  <Activity
                    name={`conversation-tree:${activeChatId}`}
                    mode={treeViewActive ? 'visible' : 'hidden'}
                  >
                    {BranchTreeView && treeBinding ? (
                      <BranchTreeView
                        binding={treeBinding}
                        attempts={treeStreams}
                        viewportActive={treeViewActive}
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
                        onMutateMessageAttachmentRef={mutateTreeMessageAttachmentRef}
                        onToggleReasoningDetailHidden={toggleTreeReasoningDetailHidden}
                        onToggleProviderOutputItemHidden={toggleTreeProviderOutputItemHidden}
                        onRequestStop={requestStop}
                        generationCapabilityFrame={generationCapabilityFrame}
                      />
                    ) : (
                      <SurfaceLoading label="Loading conversation tree…" />
                    )}
                  </Activity>
                ) : null}
                {transcriptMounted ? (
                  <Activity
                    name={`conversation-transcript:${activeChatId}`}
                    mode={treeViewActive ? 'hidden' : 'visible'}
                  >
                    <ScrollRegion
                      key={transcriptBinding?.seal.chatId ?? activeChatId}
                      ref={scrollRef}
                      viewportActive={!treeViewActive}
                      autoScrollOnStream={prefs.autoScrollOnStream}
                      streamActive={selectedPathStreamActive}
                      workspaceEpoch={
                        transcriptBinding?.seal.replacementEpoch ??
                        conversationSnapshot.workspaceEpoch
                      }
                      resetKey={transcriptBinding?.seal.chatId ?? activeChatId}
                      selectionKey={transcriptBinding?.seal.leafId ?? null}
                      viewportRevision={transcriptBinding?.viewportRevision ?? 0}
                      streamFollowKey={selectedPathFollowKey}
                      streamFollowTargetMessageId={selectedPathFollowTargetMessageId}
                      revealClaimKey={selectedPathRevealClaimKey}
                      revealClaimTargetMessageId={activeRevealRequest?.targetMessageId ?? null}
                      onRevealClaimConsumed={acknowledgeSelectedPathRevealClaim}
                      onStateChange={setScrollState}
                    >
                      {activeTranscriptExists ? (
                        transcriptBinding && resolvedPaintedChatRow ? (
                          MessageList ? (
                            <MessageList
                              key={transcriptBinding.seal.chatId}
                              binding={transcriptBinding}
                              chatSettings={resolvedPaintedChatRow.settings}
                              generationCapabilityFrame={generationCapabilityFrame}
                              contextPreviewFrozen={selectedPathStreamActive}
                              {...(activeCapability ? { capability: activeCapability } : {})}
                              prefillPlan={activePrefillPlan}
                              longMessageDisplayMode={prefs.longMessageDisplayMode}
                              messageInitialRenderWork={prefs.messageInitialRenderWork}
                              messageRenderWindowLoadMode={
                                loadedPrefs ? prefs.messageRenderWindowLoadMode : 'manual'
                              }
                              transcriptLoadFailed={transcriptLoadFailed}
                              onLoadOlderMessages={loadOlderMessageWindow}
                            />
                          ) : (
                            <SurfaceLoading label="Loading conversation…" />
                          )
                        ) : transcriptLoadFailed ? (
                          <TranscriptLoadFailure onRetry={loadOlderMessageWindow} />
                        ) : (
                          <SurfaceLoading label="Loading conversation…" />
                        )
                      ) : null}
                      {transcriptFocusMode ? displayedTranscriptComposer : null}
                    </ScrollRegion>
                    {transcriptFocusMode ? null : displayedTranscriptComposer}
                  </Activity>
                ) : null}
              </>
            ) : onNewChatSurface ? (
              <>
                {/* The new-chat surface stays IDB-cold until send/import/settings
                 * needs a row. */}
                {unmaterializedChatTitleBar}
                <EmptyState onPick={(text) => setComposerSeed(text)} />
                <Composer
                  onSubmit={handleNewChatSubmit}
                  autoSize
                  autoSizeMeasurementKey={`${prefs.fontFamily}:${prefs.baseFontSize}`}
                  generationCapability={connectionGenerationCapability}
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
                {unmaterializedChatTitleBar}
                <EmptyState onPick={(text) => setComposerSeed(text)} />
              </>
            )}
          </>
        )}
      </main>
      {mobilePanelOpen ? (
        <Button
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
          modelCatalog={activeModelCatalog}
          onClose={() => setChatModelOpen(false)}
        />
      ) : null}
      {globalSettingsOpen ? (
        <GlobalSettingsModal open onClose={() => setGlobalSettingsOpen(false)} />
      ) : null}
      <ZeroEligibleModalHost activeChat={resolvedActiveChatRow} />
      {importAtEndOpen && activeChatId ? (
        <Suspense fallback={<SurfaceLoading label="Loading import…" overlay />}>
          <ImportModal
            chatId={activeChatId}
            slot={{ kind: 'at-end' }}
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
            materializeChat={async () => {
              const routeIntent = beginRouteIntent()
              try {
                // Fire only when the user clicks Import; if import never writes
                // messages, the temporary row is discarded on navigation.
                const materialized = await materializeTemporaryNewChat(
                  routeIntentOwner(routeIntent),
                )
                if (!materialized) return null
                navigateToChatForIntent(routeIntent, materialized.chatId, materialized.routeHandoff)
                return { chatId: materialized.chatId }
              } finally {
                cancelRouteIntent(routeIntent)
              }
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
            defaultRole={treeInsertTarget.defaultRole}
            onClose={() => setTreeInsertTarget(null)}
            onDone={() => {
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
      <IconButton
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
      </IconButton>
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
function ZeroEligibleModalHost({ activeChat }: { activeChat: Chat | undefined }) {
  const chatId = useUiStore((s) => s.zeroEligibleChatId)
  if (!chatId) return null
  return (
    <ZeroEligibleModal
      chatId={chatId}
      {...(activeChat?.id === chatId && activeChat.settings.model
        ? { modelLabel: activeChat.settings.model }
        : {})}
    />
  )
}

function useSampleAndHoldPresentation<T>(
  value: T | null,
  ready: boolean,
): { readonly value: T | null; readonly retained: boolean } {
  const lastCommittedValue = useRef(value)
  useLayoutEffect(() => {
    if (ready && value !== null) lastCommittedValue.current = value
  }, [ready, value])
  const presented = ready ? value : lastCommittedValue.current
  return {
    value: presented,
    retained: !ready && presented !== null,
  }
}
