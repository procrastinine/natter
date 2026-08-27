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
import type { ChatSettingsPatch } from '../core/chat-metadata'
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
import { connectionAvailabilityFromProfileCount } from '../core/interaction-capability'
import type { MessageBodyAuthoringOperations } from '../core/message-body-authoring'
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
  ConversationVisibleSurfaceBinding,
  GenerationPreparationObserver,
  MessageAttachmentRefMutation,
  RequestableAttemptStopCapability,
  WorkspaceFence,
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
import type {
  MessageList as MessageListComponent,
  MessageListPoint as MessageListPointComponent,
} from '../ui/chat/MessageList'
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
  type ConversationMutationRunner,
  type ConversationMutationSettlement,
  conversationMutationInteraction,
  conversationMutationTarget,
  type GenerationSubmitIntent,
  generationSubmitDiagnosticTarget,
  generationSubmitInteraction,
  generationSubmitTarget,
  reportConversationMutationFailure,
  reportConversationMutationPhase,
  reportGenerationSubmissionFailure,
  reportGenerationSubmissionPhase,
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
  routeToHref,
  settleRouteForegroundDemandForPresentation,
  startRouteForegroundMetadata,
  storageHref,
  useRoute,
} from './router'

type MessageListModule = {
  default: typeof MessageListComponent
  point: typeof MessageListPointComponent
}
type BranchTreeViewModule = { default: typeof BranchTreeViewComponent }
type ActiveComposerProps = ComposerProps & {
  generationCapability: NonNullable<ComposerProps['generationCapability']>
}

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
    point: module.MessageListPoint,
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
  workspaceId: WorkspaceFence['workspaceId']
  chatId: ChatId
  pinnedMessageId: MessageId | undefined
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
  const MessageListPoint = messageListModule?.point
  const BranchTreeView = branchTreeViewModule?.default
  const activeChatId = route.kind === 'chat' ? route.chatId : null
  const activePinnedMessageId = route.kind === 'chat' ? route.pinnedMessageId : undefined
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
  const { run: runGenerationSubmit, isPending: isGenerationSubmitPending } =
    usePresentationInteraction(generationSubmitInteraction)
  const generationSubmissionClaimsRef = useRef(
    new Map<string, { readonly id: number; cancel(): void }>(),
  )
  const { run: runConversationMutationInteraction, isPending: isConversationMutationPending } =
    usePresentationInteraction(conversationMutationInteraction)
  const conversationMutationClaimsRef = useRef(
    new Map<string, { readonly id: number; cancel(): void }>(),
  )
  const runConversationMutation = useCallback<ConversationMutationRunner>(
    (
      intent: ConversationMutationIntent,
      action,
      commit?: () => void,
    ): ConversationMutationSettlement => {
      const target = conversationMutationTarget(intent)
      let claimReported = false
      const reportClaimed = (claimId: number) => {
        if (claimReported) return
        claimReported = true
        reportConversationMutationPhase({ claimId, target, phase: 'claimed' })
      }
      const runAction = ({ id, signal }: { readonly id: number; readonly signal: AbortSignal }) => {
        reportClaimed(id)
        reportConversationMutationPhase({ claimId: id, target, phase: 'admitted' })
        return action(signal, (phase) =>
          reportConversationMutationPhase({ claimId: id, target, phase }),
        )
      }
      const claim = commit
        ? runConversationMutationInteraction({
            target,
            action: runAction,
            commit: () => {
              commit()
              return undefined
            },
          })
        : runConversationMutationInteraction({ target, action: runAction })
      reportClaimed(claim.id)
      if (!claim.signal.aborted) {
        conversationMutationClaimsRef.current.set(
          target,
          Object.freeze({ id: claim.id, cancel: () => claim.cancel() }),
        )
      }
      void claim.settled.then((outcome) => {
        if (conversationMutationClaimsRef.current.get(target)?.id === claim.id) {
          conversationMutationClaimsRef.current.delete(target)
        }
        reportConversationMutationPhase({
          claimId: claim.id,
          target,
          phase: 'settled',
          outcome: outcome.kind,
        })
        if (outcome.kind === 'failed') {
          reportConversationMutationFailure({
            claimId: claim.id,
            target,
            failure: outcome.failure,
          })
        }
      })
      return claim.settled
    },
    [runConversationMutationInteraction],
  )
  const cancelStructuralMutation = useCallback((chatId: ChatId) => {
    const target = conversationMutationTarget({ kind: 'delete', chatId })
    conversationMutationClaimsRef.current.get(target)?.cancel()
  }, [])
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
    transcriptPoint,
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
    transcriptRendererAvailable: messageListModule !== null,
  })
  const catalogTab = useCatalogTab()
  const resolvedPaintedChatRow = paintedChat
    ? catalogChatPresentation(
        catalogTab,
        configurationController.projectChatConfiguration(paintedChat),
      )
    : undefined
  const chatModelPanelCanonicalRow = useFencedChatPresentation(
    activeConversation?.chat ?? paintedChat,
    activeChatId,
    conversationWorkspaceFence,
  )
  const resolvedChatModelPanelRow = chatModelPanelCanonicalRow
    ? configurationController.projectChatConfiguration(chatModelPanelCanonicalRow)
    : undefined
  useEffect(() => {
    if (paintedChat) catalogApplication.tab.observeChatRows([paintedChat])
  }, [paintedChat])
  const visibleBindingAddressesActiveConversation =
    visibleBinding !== null &&
    visibleBinding.seal.workspaceId === conversationWorkspaceFence.workspaceId &&
    visibleBinding.seal.chatId === activeChatId
  const visiblePresentationOnly = !visibleBindingAddressesActiveConversation
  const transcriptMutationsUnavailable = conversationBindingMutationsUnavailable(
    transcriptBinding,
    conversationWorkspaceFence,
  )
  const treeMutationsUnavailable = conversationBindingMutationsUnavailable(
    treeBinding,
    conversationWorkspaceFence,
  )
  useEffect(() => {
    if (!treeInsertTarget) return
    const currentWorkspaceId = conversationSnapshot.workspaceId
    if (
      activeChatId !== treeInsertTarget.chatId ||
      activePinnedMessageId !== treeInsertTarget.pinnedMessageId ||
      (currentWorkspaceId !== null && currentWorkspaceId !== treeInsertTarget.workspaceId)
    ) {
      setTreeInsertTarget(null)
    }
  }, [activeChatId, activePinnedMessageId, conversationSnapshot.workspaceId, treeInsertTarget])
  const activeTreeInsertTarget =
    treeInsertTarget?.chatId === activeChatId &&
    treeInsertTarget.pinnedMessageId === activePinnedMessageId &&
    (conversationSnapshot.workspaceId === null ||
      treeInsertTarget.workspaceId === conversationSnapshot.workspaceId)
      ? treeInsertTarget
      : null
  useEffect(() => {
    if (urlPinnedTargetPending) {
      setImportAtEndOpen(false)
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
      ? {
          kind: 'send',
          chatId: activeChatId,
          target: { kind: 'fixed', messageId: activeBranchTailId },
        }
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

  useLayoutEffect(() => {
    if (!activeChatId) return
    const task = startRouteForegroundMetadata(routeToHref(route), activeChatId, async (signal) => {
      try {
        await touchLastViewed(activeChatId, Date.now(), { signal })
      } catch (error) {
        if (signal.aborted || isPageHidingAbortError(error)) return
        console.error('Failed to update chat viewed timestamp', error)
      }
    })
    void task
  }, [activeChatId, route])

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
    if (workspaceRuntimeState !== 'RUNNING') return
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
  }, [workspaceRuntimeState])

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
    (
      intent: GenerationSubmitIntent,
      action: (control: {
        readonly signal: AbortSignal
        readonly observer: GenerationPreparationObserver
      }) => Promise<{ readonly generationSettled: Promise<unknown> }>,
    ): ComposerSubmission => {
      const target = generationSubmitTarget(intent)
      const diagnosticTarget = generationSubmitDiagnosticTarget(intent)
      let resolveAdmission!: () => void
      const admitted = new Promise<void>((resolve) => {
        resolveAdmission = resolve
      })
      let admissionReported = false
      let claimReported = false
      let settleGeneration!: () => void
      let generationSettled = false
      const generationSettlement = new Promise<void>((resolve) => {
        settleGeneration = () => {
          if (generationSettled) return
          generationSettled = true
          resolve()
        }
      })
      const diagnosticStartedAt = performance.now()
      let diagnosticPreviousAt = diagnosticStartedAt
      const reportPhase = (
        claimId: number,
        phase: Parameters<typeof reportGenerationSubmissionPhase>[0]['phase'],
        detail: Pick<
          Parameters<typeof reportGenerationSubmissionPhase>[0],
          'owner' | 'outcome'
        > = {},
      ) => {
        const now = performance.now()
        reportGenerationSubmissionPhase({
          claimId,
          target: diagnosticTarget,
          phase,
          ...detail,
          elapsedMs: now - diagnosticStartedAt,
          phaseElapsedMs: now - diagnosticPreviousAt,
        })
        diagnosticPreviousAt = now
      }
      const reportClaimed = (claimId: number) => {
        if (claimReported) return
        claimReported = true
        reportPhase(claimId, 'claimed')
      }
      const claim = runGenerationSubmit({
        target,
        action: async ({ id, signal }) => {
          reportClaimed(id)
          const lifecycle = await action({
            signal,
            observer: Object.freeze({
              pending: (owner) => reportPhase(id, 'waiting', { owner }),
              phase: (phase) => reportPhase(id, phase),
            } satisfies GenerationPreparationObserver),
          })
          void lifecycle.generationSettled.then(settleGeneration, settleGeneration)
          if (!admissionReported) {
            admissionReported = true
            reportPhase(id, 'admitted')
          }
          resolveAdmission()
        },
      })
      reportClaimed(claim.id)
      const cancelClaim = () => {
        if (generationSubmissionClaimsRef.current.get(target)?.id !== claim.id) return
        reportPhase(claim.id, 'cancelling')
        claim.cancel()
      }
      generationSubmissionClaimsRef.current.set(
        target,
        Object.freeze({ id: claim.id, cancel: cancelClaim }),
      )
      const completion = (async (): Promise<ComposerSubmissionOutcome> => {
        const outcome = await claim.settled
        if (outcome.kind !== 'succeeded') settleGeneration()
        if (generationSubmissionClaimsRef.current.get(target)?.id === claim.id) {
          generationSubmissionClaimsRef.current.delete(target)
        }
        reportPhase(claim.id, 'settled', { outcome: outcome.kind })
        switch (outcome.kind) {
          case 'succeeded':
            return Object.freeze({ kind: 'prepared' })
          case 'failed': {
            return Object.freeze({
              kind: 'not-prepared',
              reason: outcome.kind,
              failure: reportGenerationSubmissionFailure({
                claimId: claim.id,
                target: diagnosticTarget,
                failure: outcome.failure,
              }),
            })
          }
          case 'superseded':
          case 'rejected-pending':
          case 'cancelled':
            return Object.freeze({ kind: 'not-prepared', reason: outcome.kind })
        }
      })()
      const admission = Promise.race([
        admitted.then(() => Object.freeze({ kind: 'admitted' as const })),
        claim.settled.then((outcome) =>
          outcome.kind === 'succeeded'
            ? Object.freeze({ kind: 'admitted' as const })
            : Object.freeze({ kind: 'not-admitted' as const, reason: outcome.kind }),
        ),
      ])
      return Object.freeze({
        kind: 'started',
        admission,
        completion,
        generationSettled: generationSettlement,
        cancel: cancelClaim,
      })
    },
    [runGenerationSubmit],
  )
  const cancelGenerationSubmission = useCallback((chatId: ChatId | null) => {
    generationSubmissionClaimsRef.current
      .get(generationSubmitTarget({ chatId, action: 'composer' }))
      ?.cancel()
  }, [])
  const activeGenerationSubmissionPending =
    activeChatId !== null &&
    isGenerationSubmitPending(generationSubmitTarget({ chatId: activeChatId, action: 'composer' }))
  const newChatGenerationSubmissionPending = isGenerationSubmitPending(
    generationSubmitTarget({ chatId: null, action: 'composer' }),
  )
  const activeStructuralMutationPending =
    activeChatId !== null &&
    isConversationMutationPending(
      conversationMutationTarget({ kind: 'delete', chatId: activeChatId }),
    )

  const handleSubmit = useCallback(
    (
      text: string,
      opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
    ): ComposerSubmission => {
      if (!activeChatId) throw new Error('SendActiveChatMissing')
      const target = conversationController.captureGenerationTarget(activeChatId)
      const prefillText = opts?.prefillText ?? ''
      return ownGenerationSubmission(
        { chatId: activeChatId, action: 'composer' },
        async ({ signal, observer }) => {
          const conversationActions = await loadConversationActions()
          const handle = await conversationActions.sendMessageWhenCapabilitySettles(
            activeChatId,
            target,
            [{ type: 'text', text }],
            signal,
            {
              ...(opts?.attachmentRefs ? { attachmentRefs: opts.attachmentRefs } : {}),
              ...(prefillText.length > 0
                ? { prefillContent: [{ type: 'text', text: prefillText }] }
                : {}),
            },
            observer,
          )
          preloadMessageList()
          await handle.prepared
          return { generationSettled: handle.completed }
        },
      )
    },
    [activeChatId, ownGenerationSubmission],
  )

  const handleNewChatSubmit = useCallback(
    (
      text: string,
      opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
    ): ComposerSubmission => {
      const prefillText = opts?.prefillText ?? ''
      return ownGenerationSubmission(
        { chatId: null, action: 'composer' },
        async ({ signal, observer }) => {
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
              observer,
            )
            const prepared = await handle.prepared
            if (prepared.kind === 'handoff') {
              navigateToChatForIntent(routeIntent, prepared.chatId, prepared.handoff)
            }
            return { generationSettled: handle.completed }
          } finally {
            cancelRouteIntent(routeIntent)
          }
        },
      )
    },
    [ownGenerationSubmission],
  )

  const handleReplyToTrailingUser = useCallback((): ComposerSubmission => {
    if (!trailingUserMessage) throw new Error('ReplyTargetMissing')
    const chatId = trailingUserMessage.chatId
    return ownGenerationSubmission(
      {
        chatId,
        action: 'reply',
        messageId: trailingUserMessage.id,
      },
      async ({ signal, observer }) => {
        const conversationActions = await loadConversationActions()
        const handle = await conversationActions.replyToMessageWhenCapabilitySettles(
          chatId,
          trailingUserMessage.id,
          signal,
          observer,
        )
        await handle.prepared
        return { generationSettled: handle.completed }
      },
    )
  }, [ownGenerationSubmission, trailingUserMessage])

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
    chatModelOpen && !!activeChatId && !!resolvedChatModelPanelRow && !activeStorageRoute
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
      const workspaceId = treeBinding?.seal.workspaceId
      if (!activeChatId || !workspaceId || !treeHeaderById || !treeProjection) return
      const childStreaming = (treeProjection.liveByParent.get(parentId) ?? []).some((header) => {
        return treeStreamTargetIds.has(header.id)
      })
      if (childStreaming) {
        pushToast({ level: 'info', text: 'Wait for the connected generation to finish.' })
        return
      }
      const parent = parentId ? treeHeaderById.get(parentId) : undefined
      setTreeInsertTarget({
        workspaceId,
        chatId: activeChatId,
        pinnedMessageId: activePinnedMessageId,
        slot: { kind: 'after-all', parentId },
        defaultRole: parent ? oppositeRole(parent.role) : 'user',
      })
    },
    [
      activeChatId,
      activePinnedMessageId,
      pushToast,
      treeBinding,
      treeHeaderById,
      treeProjection,
      treeStreamTargetIds,
    ],
  )
  const insertAtTreeChildLeg = useCallback(
    (childId: MessageId) => {
      const workspaceId = treeBinding?.seal.workspaceId
      if (!activeChatId || !workspaceId || !treeHeaderById) return
      const child = treeHeaderById.get(childId)
      if (!child || child.deleted) return
      if (treeStreamTargetIds.has(childId)) {
        pushToast({ level: 'info', text: 'Wait for this generation to finish.' })
        return
      }
      setTreeInsertTarget({
        workspaceId,
        chatId: activeChatId,
        pinnedMessageId: activePinnedMessageId,
        slot: { kind: 'before', messageId: childId },
        defaultRole: oppositeRole(child.role),
      })
    },
    [
      activeChatId,
      activePinnedMessageId,
      pushToast,
      treeBinding,
      treeHeaderById,
      treeStreamTargetIds,
    ],
  )
  const insertAfterTreeLeaf = useCallback(
    (messageId: MessageId) => {
      const workspaceId = treeBinding?.seal.workspaceId
      if (!activeChatId || !workspaceId || !treeHeaderById || !treeProjection) return
      const leaf = treeHeaderById.get(messageId)
      if (!leaf || leaf.deleted) return
      const hasLiveChild = (treeProjection.liveByParent.get(messageId)?.length ?? 0) > 0
      if (hasLiveChild) return
      if (treeStreamTargetIds.has(messageId)) {
        pushToast({ level: 'info', text: 'Wait for this generation to finish.' })
        return
      }
      setTreeInsertTarget({
        workspaceId,
        chatId: activeChatId,
        pinnedMessageId: activePinnedMessageId,
        slot: { kind: 'after', messageId },
        defaultRole: oppositeRole(leaf.role),
      })
    },
    [
      activeChatId,
      activePinnedMessageId,
      pushToast,
      treeBinding,
      treeHeaderById,
      treeProjection,
      treeStreamTargetIds,
    ],
  )
  const editTreeMessage = useCallback(
    (
      message: Message,
      text: string,
      authoring?: MessageBodyAuthoringOperations,
      attachmentRefs?: MessageAttachmentRef[],
    ) =>
      runConversationMutation(
        { kind: 'edit', chatId: message.chatId, messageId: message.id },
        (signal) =>
          requireConversationActions().editMessage(
            message.chatId,
            message,
            text,
            signal,
            authoring,
            attachmentRefs,
          ),
      ),
    [runConversationMutation],
  )
  const editAndSendMessage = useCallback(
    (
      message: Message,
      text: string,
      options?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
    ): ComposerSubmission => {
      const attachmentRefs = options?.attachmentRefs ?? message.attachmentRefs
      return ownGenerationSubmission(
        {
          chatId: message.chatId,
          action: 'edit-resend',
          messageId: message.id,
        },
        async ({ signal, observer }) => {
          const conversationActions = await loadConversationActions()
          const handle = await conversationActions.editAndResendWhenCapabilitySettles(
            message.chatId,
            message,
            text,
            signal,
            {
              ...(options?.prefillText ? { prefillText: options.prefillText } : {}),
              ...(attachmentRefs ? { attachmentRefs } : {}),
            },
            observer,
          )
          preloadMessageList()
          await handle.prepared
          return { generationSettled: handle.completed }
        },
      )
    },
    [ownGenerationSubmission],
  )
  const deleteTreeNode = useCallback(
    (message: Message) =>
      runConversationMutation({ kind: 'delete', chatId: message.chatId }, (signal, reportPhase) =>
        requireConversationActions().deleteMessage(
          message.chatId,
          message.id,
          'single',
          false,
          signal,
          reportPhase,
        ),
      ),
    [runConversationMutation],
  )
  const regenerateMessage = useCallback(
    (message: Message, options?: { settingsPatch?: ChatSettingsPatch }): ComposerSubmission => {
      return ownGenerationSubmission(
        {
          chatId: message.chatId,
          action: 'regenerate',
          messageId: message.id,
        },
        async ({ signal, observer }) => {
          const conversationActions = await loadConversationActions()
          const handle = await conversationActions.regenerateWhenCapabilitySettles(
            message.chatId,
            message,
            signal,
            options,
            observer,
          )
          preloadMessageList()
          await handle.prepared
          return { generationSettled: handle.completed }
        },
      )
    },
    [ownGenerationSubmission],
  )
  const continueMessage = useCallback(
    (message: Message): ComposerSubmission => {
      return ownGenerationSubmission(
        {
          chatId: message.chatId,
          action: 'continue',
          messageId: message.id,
        },
        async ({ signal, observer }) => {
          const conversationActions = await loadConversationActions()
          const handle = await conversationActions.continueMessageWhenCapabilitySettles(
            message.chatId,
            message,
            signal,
            observer,
          )
          preloadMessageList()
          await handle.prepared
          return { generationSettled: handle.completed }
        },
      )
    },
    [ownGenerationSubmission],
  )
  const forkTreeMessage = useCallback(
    (message: Message) =>
      runConversationMutation(
        { kind: 'fork', chatId: message.chatId, messageId: message.id },
        (signal, reportPhase) =>
          requireConversationActions().forkMessage(message.chatId, message, signal, reportPhase),
      ),
    [runConversationMutation],
  )
  const toggleTreeMessageContextVisibility = useCallback(
    (message: Message) =>
      runConversationMutation(
        { kind: 'context', chatId: message.chatId, messageId: message.id },
        (signal) => requireConversationActions().toggleContext(message.chatId, message, signal),
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
        (signal) =>
          requireConversationActions().toggleReasoning(message.chatId, message, member, signal),
      ),
    [runConversationMutation],
  )
  const editTreeReasoningDetail = useCallback(
    (message: Message, member: Extract<ReasoningMemberRef, { kind: 'visible' }>, text: string) =>
      runConversationMutation(
        {
          kind: 'reasoning',
          chatId: message.chatId,
          messageId: message.id,
          member,
        },
        (signal) =>
          requireConversationActions().editReasoning(message.chatId, message, member, text, signal),
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
        (signal) =>
          requireConversationActions().toggleProviderOutput(
            message.chatId,
            message,
            member,
            signal,
          ),
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
  const activeComposerProps: ActiveComposerProps | null = activeChatId
    ? {
        onSubmit: handleSubmit,
        ...(composerStopCapability ? { stopCapability: composerStopCapability } : {}),
        onRequestStop: requestStop,
        autoSize: true,
        ...(transcriptFocusMode ? { autoSizeVariant: 'focus' as const } : {}),
        autoSizeMeasurementKey: `${prefs.fontFamily}:${prefs.baseFontSize}`,
        generationCapability: activeSendCapability,
        replyGenerationCapability: trailingReplyCapability,
        submissionPending: activeGenerationSubmissionPending,
        onCancelSubmission: () => cancelGenerationSubmission(activeChatId),
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
  const displayedComposerProps = rebaseRetainedComposerLifecycle(
    composerPresentation.value,
    activeComposerProps,
  )
  const editorRetentionPresentation = activePresentation?.editorRetention ?? null
  const retainedEditorDestinationDeferred =
    editorRetentionPresentation?.destinationDeferred === true
  const retainedEditorReturnTargetId = retainedEditorDestinationDeferred
    ? editorRetentionPresentation.returnTargetMessageId
    : null
  const displayedTranscriptComposer = displayedComposerProps ? (
    <Composer
      key={displayedComposerProps.draftKey}
      {...displayedComposerProps}
      generationCapability={displayedComposerProps.generationCapability}
      presentationOnly={
        retainedEditorDestinationDeferred ||
        (composerPresentation.retained && !visibleBindingAddressesActiveConversation)
      }
    />
  ) : null
  const activeSurfaceReady = activeChatId ? activePresentation?.visibleReady === true : true
  const routePresentationTargetKind = activePresentation?.target.kind ?? null
  const routePresentationRevealPending =
    activePresentation?.target.kind === 'ready' && activePresentation.target.binding.reveal !== null
  const routePresentationDestinationDeferred =
    activePresentation?.editorRetention?.destinationDeferred === true
  useLayoutEffect(() => {
    settleRouteForegroundDemandForPresentation(
      routeToHref(route),
      {
        hasActiveChat: activeChatId !== null,
        targetKind: routePresentationTargetKind,
        revealPending: routePresentationRevealPending,
        destinationDeferred: routePresentationDestinationDeferred,
      },
      activeChatId,
    )
  }, [
    activeChatId,
    route,
    routePresentationDestinationDeferred,
    routePresentationRevealPending,
    routePresentationTargetKind,
  ])

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
            onClick={(event) => {
              if (isNarrowScreen) {
                setMobileSidebarOpen(false)
                return
              }
              const nextCollapsed = !sidebarCollapsed
              const shell = event.currentTarget.closest<HTMLElement>('[data-ui="app-shell"]')
              shell?.setAttribute('data-sidebar', nextCollapsed ? 'collapsed' : 'expanded')
              shell
                ?.querySelector<HTMLElement>('[data-ui="sidebar"]')
                ?.setAttribute('data-collapsed', String(nextCollapsed))
              updateSidebarCollapsed(nextCollapsed)
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
                      if (surface === 'transcript') setTreeInsertTarget(null)
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
                {retainedEditorDestinationDeferred ? (
                  <div data-ui="retained-editor-navigation" role="status" aria-live="polite">
                    <span data-ui="retained-editor-navigation-text">
                      {editorRetentionPresentation.editorCount === 1
                        ? 'An open edit is keeping this branch visible.'
                        : `${editorRetentionPresentation.editorCount} open edits are keeping this branch visible.`}{' '}
                      Save or cancel {editorRetentionPresentation.editorCount === 1 ? 'it' : 'them'}
                      {' to show the selected branch.'}
                    </span>
                    {retainedEditorReturnTargetId ? (
                      <Button
                        type="button"
                        data-ui="retained-editor-navigation-return"
                        onClick={() =>
                          navigateConversationMessage(activeChatId, retainedEditorReturnTargetId)
                        }
                      >
                        Return to edited branch
                      </Button>
                    ) : null}
                  </div>
                ) : null}
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
                        mutationsUnavailable={treeMutationsUnavailable}
                        structuralMutationPending={activeStructuralMutationPending}
                        expanded={treeExpanded}
                        previewFontFamily={fontFamilyStack(prefs.fontFamily)}
                        onActivateNode={activateTreeNode}
                        onInsertAtSharedTrunk={insertAtSharedTreeTrunk}
                        onInsertAtChildLeg={insertAtTreeChildLeg}
                        onInsertAfterLeaf={insertAfterTreeLeaf}
                        onEditMessage={editTreeMessage}
                        onEditAndSendMessage={editAndSendMessage}
                        onDeleteNode={deleteTreeNode}
                        onRegenerateMessage={regenerateMessage}
                        onContinueMessage={continueMessage}
                        onForkMessage={forkTreeMessage}
                        onToggleMessageContextVisibility={toggleTreeMessageContextVisibility}
                        onMutateMessageAttachmentRef={mutateTreeMessageAttachmentRef}
                        onToggleReasoningDetailHidden={toggleTreeReasoningDetailHidden}
                        onEditReasoningDetail={editTreeReasoningDetail}
                        onToggleProviderOutputItemHidden={toggleTreeProviderOutputItemHidden}
                        onRequestStop={requestStop}
                        generationSubmissionPending={activeGenerationSubmissionPending}
                        onCancelGenerationSubmission={() =>
                          cancelGenerationSubmission(activeChatId)
                        }
                        onCancelStructuralMutation={() => cancelStructuralMutation(activeChatId)}
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
                      selectionKey={
                        transcriptBinding?.seal.leafId ?? transcriptPoint?.window.leafId ?? null
                      }
                      viewportRevision={transcriptBinding?.viewportRevision ?? 0}
                      streamFollowKey={selectedPathFollowKey}
                      streamFollowTargetMessageId={selectedPathFollowTargetMessageId}
                      revealClaimKey={selectedPathRevealClaimKey}
                      revealClaimTargetMessageId={activeRevealRequest?.targetMessageId ?? null}
                      revealSurfaceAvailable={Boolean(
                        (transcriptBinding && resolvedPaintedChatRow && MessageList) ||
                          (transcriptPoint && resolvedActiveChatRow && MessageListPoint),
                      )}
                      onRevealClaimConsumed={acknowledgeSelectedPathRevealClaim}
                      onStateChange={setScrollState}
                    >
                      {activeTranscriptExists ? (
                        transcriptBinding && resolvedPaintedChatRow ? (
                          MessageList ? (
                            <MessageList
                              key={transcriptBinding.seal.chatId}
                              binding={transcriptBinding}
                              mutationsUnavailable={transcriptMutationsUnavailable}
                              structuralMutationPending={activeStructuralMutationPending}
                              runConversationMutation={runConversationMutation}
                              chatSettings={resolvedPaintedChatRow.settings}
                              onEditAndSendMessage={editAndSendMessage}
                              onRegenerateMessage={regenerateMessage}
                              onContinueMessage={continueMessage}
                              generationSubmissionPending={activeGenerationSubmissionPending}
                              onCancelStructuralMutation={() =>
                                cancelStructuralMutation(activeChatId)
                              }
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
                        ) : transcriptPoint && resolvedActiveChatRow && MessageListPoint ? (
                          <MessageListPoint
                            key={activeChatId}
                            kind="point"
                            chatId={activeChatId}
                            workspaceFence={conversationWorkspaceFence}
                            window={transcriptPoint.window}
                            runConversationMutation={runConversationMutation}
                            chatSettings={resolvedActiveChatRow.settings}
                            onEditAndSendMessage={editAndSendMessage}
                            onRegenerateMessage={regenerateMessage}
                            onContinueMessage={continueMessage}
                            generationSubmissionPending={activeGenerationSubmissionPending}
                            structuralMutationPending={activeStructuralMutationPending}
                            onCancelStructuralMutation={() =>
                              cancelStructuralMutation(activeChatId)
                            }
                            {...(activeCapability ? { capability: activeCapability } : {})}
                            prefillPlan={activePrefillPlan}
                            longMessageDisplayMode={prefs.longMessageDisplayMode}
                          />
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
                  submissionPending={newChatGenerationSubmissionPending}
                  onCancelSubmission={() => cancelGenerationSubmission(null)}
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
          chatSnapshot={resolvedChatModelPanelRow}
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
      {activeTreeInsertTarget ? (
        <Suspense fallback={<SurfaceLoading label="Loading import…" overlay />}>
          <ImportModal
            chatId={activeTreeInsertTarget.chatId}
            slot={activeTreeInsertTarget.slot}
            defaultRole={activeTreeInsertTarget.defaultRole}
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

function rebaseRetainedComposerLifecycle(
  presented: ActiveComposerProps | null,
  current: ActiveComposerProps | null,
): ActiveComposerProps | null {
  if (presented === null) return null
  const {
    submissionPending: _submissionPending,
    onCancelSubmission: _onCancelSubmission,
    stopCapability: _stopCapability,
    onRequestStop: _onRequestStop,
    ...stablePresentation
  } = presented
  return {
    ...stablePresentation,
    submissionPending: current?.submissionPending === true,
    ...(current?.onCancelSubmission ? { onCancelSubmission: current.onCancelSubmission } : {}),
    ...(current?.stopCapability ? { stopCapability: current.stopCapability } : {}),
    ...(current?.onRequestStop ? { onRequestStop: current.onRequestStop } : {}),
  }
}

function useFencedChatPresentation(
  chat: Chat | null,
  activeChatId: ChatId | null,
  workspace: WorkspaceFence,
): Chat | null {
  const retained = useRef<{
    readonly workspaceId: WorkspaceFence['workspaceId']
    readonly replacementEpoch: WorkspaceFence['replacementEpoch']
    readonly chat: Chat
  } | null>(null)
  const current = activeChatId !== null && chat?.id === activeChatId ? chat : null
  useLayoutEffect(() => {
    if (!current) return
    retained.current = Object.freeze({
      workspaceId: workspace.workspaceId,
      replacementEpoch: workspace.replacementEpoch,
      chat: current,
    })
  }, [current, workspace.replacementEpoch, workspace.workspaceId])
  if (current) return current
  const previous = retained.current
  return activeChatId !== null &&
    previous?.chat.id === activeChatId &&
    previous.workspaceId === workspace.workspaceId &&
    previous.replacementEpoch === workspace.replacementEpoch
    ? previous.chat
    : null
}

function conversationBindingMutationsUnavailable(
  binding: ConversationVisibleSurfaceBinding | null,
  workspace: WorkspaceFence,
): boolean {
  return binding === null || binding.seal.workspaceId !== workspace.workspaceId
}
