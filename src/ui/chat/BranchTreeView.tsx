import {
  lazy,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type {
  ConversationMutationSettlement,
  GenerationSubmission,
} from '../../app/presentation-interactions'
import { chatHref } from '../../app/router'
import {
  type BranchTreeLayout,
  type BranchTreeLayoutNode,
  layoutBranchTree,
} from '../../core/branch-tree-layout'
import type { MessageBodyAuthoringOperations } from '../../core/message-body-authoring'
import type {
  ChatId,
  Message,
  MessageAttachmentRef,
  MessageId,
  MessageRole,
  ProviderOutputMemberRef,
  ReasoningMemberRef,
} from '../../core/types'
import {
  useConversationInspectorDemand,
  useConversationTreePreviewDemand,
} from '../../hooks/useConversationFrame'
import { attemptStopCapability } from '../../store/attempt-controller'
import { branchTreeSearchTarget } from '../../store/branch-tree-search-session'
import { branchTreeSessionWorkspace } from '../../store/branch-tree-session-workspace'
import { conversationController as defaultConversationController } from '../../store/conversation-controller'
import { rebaseHydratedMessageHeader } from '../../store/message-storage'
import type {
  AttemptExecutionRecord,
  BranchTreeSearchSource,
  ConversationController,
  ConversationTreeSurface,
  MessageAttachmentRefMutation,
  MessageHeaderRow,
  RequestableAttemptStopCapability,
  TreePreviewTarget,
} from '../../store/presentation-contracts'
import {
  ChevronIcon,
  CloseIcon,
  EyeOffIcon,
  PersonIcon,
  RobotIcon,
  SearchIcon,
  StopIcon,
} from '../icons/Icon'
import { Button } from '../primitives/Button'
import { SvgAction } from '../primitives/SvgAction'
import { TreeDensityToggle } from './TreeDensityToggle'

const COMPACT_LAYOUT = {
  nodeWidth: 44,
  nodeHeight: 40,
  horizontalGap: 42,
  verticalGap: 64,
  padding: 64,
} as const

const EXPANDED_LAYOUT = {
  nodeWidth: 244,
  nodeHeight: 112,
  horizontalGap: 48,
  verticalGap: 66,
  padding: 64,
} as const

const VIEWPORT_OVERSCAN_X = 240
const VIEWPORT_OVERSCAN_ROWS = 1
const DEFAULT_INSPECTOR_RATIO = 0.38
const INSPECTOR_DESKTOP_MIN_PX = 300
const INSPECTOR_NARROW_MIN_PX = 160
const INSPECTOR_MAX_PX = 960
const INSPECTOR_MAX_RATIO = 0.75
const INSPECTOR_NARROW_BREAKPOINT_PX = 760
const TREE_DESKTOP_MIN_PX = 260
const TREE_NARROW_MIN_PX = 112
const INSPECTOR_SEPARATOR_PX = 7
const EMPTY_MESSAGE_ID_SET: ReadonlySet<MessageId> = Object.freeze(new Set<MessageId>())
const EMPTY_MESSAGE_IDS: readonly MessageId[] = Object.freeze([])
const EMPTY_TARGETED_ATTEMPTS: readonly TargetedAttempt[] = Object.freeze([])
const EMPTY_BRANCH_TREE_LAYOUT: BranchTreeLayout = Object.freeze({
  nodes: [],
  byId: new Map(),
  childrenByParent: new Map(),
  rowsByDepth: [],
  width: 0,
  height: 0,
  maxDepth: 0,
})
const EMPTY_CONNECTOR_INDEX: ConnectorIndex = Object.freeze({
  sharedByDepth: [],
  childrenByDepth: [],
})

const BranchTreeInspector = lazy(() =>
  import('./BranchTreeInspector').then((module) => ({ default: module.BranchTreeInspector })),
)
const BranchTreePreview = lazy(() =>
  import('./BranchTreePreview').then((module) => ({ default: module.BranchTreePreview })),
)

type BranchTreeComputation = 'render' | 'layout' | 'connector-index'
type BranchTreeComputationProbe = (operation: BranchTreeComputation) => void
let branchTreeComputationProbe: BranchTreeComputationProbe | undefined

export function observeBranchTreeComputations(
  observer: BranchTreeComputationProbe | undefined,
): void {
  branchTreeComputationProbe = observer
}

export type BranchTreeRepository = BranchTreeSearchSource

interface BranchTreeHeaderLookup {
  get(messageId: MessageId): MessageHeaderRow | undefined
  has(messageId: MessageId): boolean
}

type BranchTreeAction = (messageId: MessageId, observedTipId?: MessageId) => void | Promise<void>
type BranchTreeEditAction = (
  message: Message,
  text: string,
  authoring?: MessageBodyAuthoringOperations,
  attachmentRefs?: MessageAttachmentRef[],
) => ConversationMutationSettlement
type BranchTreeGenerationEditAction = (
  message: Message,
  text: string,
  options?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
) => GenerationSubmission
type BranchTreeMessageMutationAction = (message: Message) => ConversationMutationSettlement
type BranchTreeGenerationMessageAction = (message: Message) => GenerationSubmission
type BranchTreeProviderOutputAction = (
  message: Message,
  member: ProviderOutputMemberRef,
) => ConversationMutationSettlement
type BranchTreeReasoningAction = (
  message: Message,
  member: ReasoningMemberRef,
) => ConversationMutationSettlement
type BranchTreeReasoningEditAction = (
  message: Message,
  member: Extract<ReasoningMemberRef, { kind: 'visible' }>,
  text: string,
) => ConversationMutationSettlement
type BranchTreeMessageAttachmentAction = (
  message: Message,
  mutation: MessageAttachmentRefMutation,
) => void | Promise<void>

export interface BranchTreeViewProps {
  binding: ConversationTreeSurface
  attempts: readonly AttemptExecutionRecord[]
  viewportActive: boolean
  mutationsUnavailable?: boolean
  structuralMutationPending?: boolean
  expanded: boolean
  previewFontFamily?: string
  selectedNodeId?: MessageId | null
  conversationController?: ConversationController
  repository?: BranchTreeRepository
  onActivateNode: BranchTreeAction
  onSelectNode?: (messageId: MessageId | null) => void
  onInsertAtSharedTrunk?: (parentId: MessageId | null) => void | Promise<void>
  onInsertAtChildLeg?: (childId: MessageId) => void | Promise<void>
  onInsertAfterLeaf?: BranchTreeAction
  onEditMessage?: BranchTreeEditAction
  onEditAndSendMessage?: BranchTreeGenerationEditAction
  onDeleteNode?: BranchTreeMessageMutationAction
  onRegenerateMessage?: BranchTreeGenerationMessageAction
  onContinueMessage?: BranchTreeGenerationMessageAction
  onForkMessage?: BranchTreeMessageMutationAction
  onToggleMessageContextVisibility?: BranchTreeMessageMutationAction
  onMutateMessageAttachmentRef?: BranchTreeMessageAttachmentAction
  onToggleReasoningDetailHidden?: BranchTreeReasoningAction
  onEditReasoningDetail?: BranchTreeReasoningEditAction
  onToggleProviderOutputItemHidden?: BranchTreeProviderOutputAction
  onRequestStop?: (capability: RequestableAttemptStopCapability) => void
  generationSubmissionPending?: boolean
  onCancelGenerationSubmission?: () => void
  onCancelStructuralMutation?: () => void
  className?: string
}

type ActiveBranchTreeViewProps = BranchTreeViewProps

interface Viewport {
  left: number
  top: number
  width: number
  height: number
}

interface ActivePreview {
  messageId: MessageId
}

type InspectedMessageSnapshot =
  | {
      id: MessageId
      bodyVersion: number
      status: 'loading'
    }
  | {
      id: MessageId
      bodyVersion: number
      status: 'ready'
      message: Message
    }

interface PanGesture {
  pointerId: number
  startX: number
  startY: number
  startScrollLeft: number
  startScrollTop: number
  moved: boolean
}

type TargetedAttempt = AttemptExecutionRecord

function latestAttempt(
  attempts: readonly AttemptExecutionRecord[],
  messageId?: MessageId,
): AttemptExecutionRecord | undefined {
  let selected: AttemptExecutionRecord | undefined
  for (const attempt of attempts) {
    if (messageId !== undefined && attempt.messageId !== messageId) continue
    if (!selected || attempt.admissionSequence > selected.admissionSequence) selected = attempt
  }
  return selected
}

function latestTargetAttempt(
  attempts: readonly AttemptExecutionRecord[],
  messageId: MessageId | null,
): AttemptExecutionRecord | undefined {
  return messageId ? latestAttempt(attempts, messageId) : undefined
}

interface SharedConnector {
  key: string
  parentId: MessageId
  depth: number
  minX: number
  maxX: number
  path: string
  insertX: number
  insertY: number
}

interface ChildConnector {
  key: string
  parentId: MessageId
  childId: MessageId
  depth: number
  x: number
  path: string
  insertX: number
  insertY: number
}

interface IntervalNode {
  connector: SharedConnector
  maxX: number
  left: IntervalNode | null
  right: IntervalNode | null
}

interface ConnectorIndex {
  sharedByDepth: Array<IntervalNode | null | undefined>
  childrenByDepth: Array<ChildConnector[] | undefined>
}

const EMPTY_VIEWPORT: Viewport = { left: 0, top: 0, width: 1024, height: 768 }

function inspectorWidthBounds(workspaceWidth: number): {
  min: number
  max: number
  canvasMin: number
} {
  const narrow = workspaceWidth <= INSPECTOR_NARROW_BREAKPOINT_PX
  const min = narrow ? INSPECTOR_NARROW_MIN_PX : INSPECTOR_DESKTOP_MIN_PX
  const canvasMin = narrow ? TREE_NARROW_MIN_PX : TREE_DESKTOP_MIN_PX
  const max = Math.max(
    min,
    Math.min(
      INSPECTOR_MAX_PX,
      workspaceWidth * INSPECTOR_MAX_RATIO,
      workspaceWidth - canvasMin - INSPECTOR_SEPARATOR_PX,
    ),
  )
  return { min, max, canvasMin }
}

function pointerHitsScrollbarGutter(
  element: HTMLElement,
  clientX: number,
  clientY: number,
): boolean {
  const bounds = element.getBoundingClientRect()
  const verticalGutter = Math.max(0, element.offsetWidth - element.clientWidth)
  const horizontalGutter = Math.max(0, element.offsetHeight - element.clientHeight)
  return (
    (verticalGutter > 0 && clientX >= bounds.right - verticalGutter) ||
    (horizontalGutter > 0 && clientY >= bounds.bottom - horizontalGutter)
  )
}

function roleLabel(role: MessageRole): string {
  return role.charAt(0).toLocaleUpperCase() + role.slice(1)
}

function lowerBoundNodeX(row: readonly BranchTreeLayoutNode[], target: number): number {
  let low = 0
  let high = row.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((row[middle] as BranchTreeLayoutNode).x < target) low = middle + 1
    else high = middle
  }
  return low
}

function lowerBoundChildX(row: readonly ChildConnector[], target: number): number {
  let low = 0
  let high = row.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((row[middle] as ChildConnector).x < target) low = middle + 1
    else high = middle
  }
  return low
}

function buildIntervalTree(connectors: readonly SharedConnector[]): IntervalNode | null {
  if (connectors.length === 0) return null
  const ordered = [...connectors].sort(
    (left, right) =>
      left.minX - right.minX || left.maxX - right.maxX || left.key.localeCompare(right.key),
  )
  const build = (start: number, end: number): IntervalNode | null => {
    if (start >= end) return null
    const middle = (start + end) >>> 1
    const connector = ordered[middle] as SharedConnector
    const left = build(start, middle)
    const right = build(middle + 1, end)
    return {
      connector,
      maxX: Math.max(connector.maxX, left?.maxX ?? -Infinity, right?.maxX ?? -Infinity),
      left,
      right,
    }
  }
  return build(0, ordered.length)
}

function queryIntervalTree(
  root: IntervalNode | null,
  minX: number,
  maxX: number,
  output: SharedConnector[],
): void {
  if (!root || root.maxX < minX) return
  if (root.left?.maxX !== undefined && root.left.maxX >= minX) {
    queryIntervalTree(root.left, minX, maxX, output)
  }
  if (root.connector.minX <= maxX && root.connector.maxX >= minX) {
    output.push(root.connector)
  }
  if (root.connector.minX <= maxX) queryIntervalTree(root.right, minX, maxX, output)
}

function connectorIndexFor(layout: BranchTreeLayout): ConnectorIndex {
  const sharedRows: Array<SharedConnector[] | undefined> = []
  const childrenByDepth: Array<ChildConnector[] | undefined> = []
  for (const parent of layout.nodes) {
    const children = layout.childrenByParent.get(parent.id) ?? []
    if (children.length === 0) continue
    const parentCenterX = parent.x + parent.width / 2
    const parentBottomY = parent.y + parent.height
    const childTopY = (children[0] as BranchTreeLayoutNode).y
    const middleY = (parentBottomY + childTopY) / 2
    const firstChildX = (children[0] as BranchTreeLayoutNode).x + parent.width / 2
    const lastChildX = (children.at(-1) as BranchTreeLayoutNode).x + parent.width / 2
    const minX = Math.min(parentCenterX, firstChildX, lastChildX)
    const maxX = Math.max(parentCenterX, firstChildX, lastChildX)
    const sharedPath =
      children.length === 1
        ? `M ${parentCenterX} ${parentBottomY} V ${childTopY}`
        : `M ${parentCenterX} ${parentBottomY} V ${middleY} M ${firstChildX} ${middleY} H ${lastChildX}`
    const shared: SharedConnector = {
      key: `shared:${parent.id}`,
      parentId: parent.id,
      depth: parent.depth,
      minX,
      maxX,
      path: sharedPath,
      insertX: parentCenterX,
      insertY: children.length === 1 ? middleY : (parentBottomY + middleY) / 2,
    }
    const sharedRow = sharedRows[parent.depth]
    if (sharedRow) sharedRow.push(shared)
    else sharedRows[parent.depth] = [shared]
    if (children.length === 1) continue

    for (const child of children) {
      const childCenterX = child.x + child.width / 2
      const connector: ChildConnector = {
        key: `child:${child.id}`,
        parentId: parent.id,
        childId: child.id,
        depth: parent.depth,
        x: childCenterX,
        path: `M ${childCenterX} ${middleY} V ${child.y}`,
        insertX: childCenterX,
        insertY: (middleY + child.y) / 2,
      }
      const childRow = childrenByDepth[parent.depth]
      if (childRow) childRow.push(connector)
      else childrenByDepth[parent.depth] = [connector]
    }
  }
  for (const row of childrenByDepth) row?.sort((left, right) => left.x - right.x)
  return {
    sharedByDepth: sharedRows.map((row) => buildIntervalTree(row ?? [])),
    childrenByDepth,
  }
}

const ActiveBranchTreeView = memo(function ActiveBranchTreeView({
  viewportActive,
  mutationsUnavailable = false,
  structuralMutationPending = false,
  binding,
  attempts,
  expanded,
  previewFontFamily = treePreviewFontFamily(),
  selectedNodeId,
  conversationController: injectedController,
  repository,
  onActivateNode,
  onSelectNode,
  onInsertAtSharedTrunk,
  onInsertAtChildLeg,
  onInsertAfterLeaf,
  onEditMessage,
  onEditAndSendMessage,
  onDeleteNode,
  onRegenerateMessage,
  onContinueMessage,
  onForkMessage,
  onToggleMessageContextVisibility,
  onMutateMessageAttachmentRef,
  onToggleReasoningDetailHidden,
  onEditReasoningDetail,
  onToggleProviderOutputItemHidden,
  onRequestStop,
  generationSubmissionPending = false,
  onCancelGenerationSubmission,
  onCancelStructuralMutation,
  className,
}: ActiveBranchTreeViewProps) {
  branchTreeComputationProbe?.('render')
  const bodyActive = viewportActive && !mutationsUnavailable
  const controller = injectedController ?? defaultConversationController
  const chatId = binding.seal.chatId
  const exactHeaderById = binding.headers
  const headerChangeRevision = binding.headerChangeRevision
  const changedHeaderKeys = binding.changedHeaderKeys
  const projection = binding.topology
  const acceptedPath = binding.spine.path
  const workspaceRevision = `${binding.seal.workspaceId}:${binding.seal.replacementEpoch}`
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const centerNodeRef = useRef<(messageId: MessageId) => boolean>(() => false)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const committedHeaderDeliveryRef = useRef<{
    chatId: ChatId
    source: BranchTreeHeaderLookup
    revision: number
  } | null>(null)
  const deliveredChangedHeaderKeys = (() => {
    const previous = committedHeaderDeliveryRef.current
    if (!previous) return null
    if (
      previous.chatId === chatId &&
      previous.source === exactHeaderById &&
      previous.revision === headerChangeRevision
    ) {
      return EMPTY_MESSAGE_IDS
    }
    return previous.chatId === chatId && previous.revision + 1 === headerChangeRevision
      ? changedHeaderKeys
      : null
  })()
  useLayoutEffect(() => {
    committedHeaderDeliveryRef.current = {
      chatId,
      source: exactHeaderById,
      revision: headerChangeRevision,
    }
  }, [chatId, exactHeaderById, headerChangeRevision])
  const viewportFrameRef = useRef<number | null>(null)
  const inspectorResizeFrameRef = useRef<number | null>(null)
  const pendingInspectorClientXRef = useRef<number | null>(null)
  const resizingInspectorRef = useRef(false)
  const initialCenterKeyRef = useRef('')
  const lastExternalSelectionRef = useRef<MessageId | null>(null)
  const selectionScopeChatIdRef = useRef(chatId)
  const panGestureRef = useRef<PanGesture | null>(null)
  const suppressCanvasClickRef = useRef(false)
  const inspectedMessageIdRef = useRef<MessageId | null>(null)
  const handledSearchRevealRef = useRef(0)
  const searchWasActiveRef = useRef(false)
  const [viewport, setViewport] = useState<Viewport>(EMPTY_VIEWPORT)
  const [workspaceWidth, setWorkspaceWidth] = useState(EMPTY_VIEWPORT.width)
  const [inspectorRatio, setInspectorRatio] = useState(DEFAULT_INSPECTOR_RATIO)
  const [resizingInspector, setResizingInspector] = useState(false)
  const [panningCanvas, setPanningCanvas] = useState(false)
  const [activePreview, setActivePreview] = useState<ActivePreview | null>(null)
  const [localSelectedNodeId, setLocalSelectedNodeId] = useState<MessageId | null>(null)
  const [hoveredConnectorKey, setHoveredConnectorKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const targetedAttempts = useMemo(
    () => (bodyActive ? attempts : EMPTY_TARGETED_ATTEMPTS),
    [attempts, bodyActive],
  )
  const activeAttemptTargetIds = useMemo(() => {
    const ids = new Set<MessageId>()
    for (const attempt of targetedAttempts) ids.add(attempt.messageId)
    return ids
  }, [targetedAttempts])
  const busyMessageIds = activeAttemptTargetIds
  const busyMessageIdsRef = useRef<ReadonlySet<MessageId>>(busyMessageIds)
  busyMessageIdsRef.current = busyMessageIds
  const deferredQuery = useDeferredValue(query)
  const normalizedQuery = deferredQuery.trim()
  const searchSession = branchTreeSessionWorkspace.searchFor(repository)
  const searchSnapshot = useSyncExternalStore(
    searchSession.subscribe,
    searchSession.getSnapshot,
    searchSession.getSnapshot,
  )
  const visibleSearchSnapshot =
    bodyActive &&
    searchWasActiveRef.current &&
    searchSnapshot?.workspaceId === binding.seal.workspaceId &&
    searchSnapshot.replacementEpoch === binding.seal.replacementEpoch &&
    searchSnapshot.chatId === chatId &&
    searchSnapshot.query === normalizedQuery
      ? searchSnapshot
      : null
  const matches = visibleSearchSnapshot?.matches ?? EMPTY_MESSAGE_IDS
  const matchIndex = visibleSearchSnapshot?.currentIndex ?? -1
  const currentMatchId = visibleSearchSnapshot?.currentMatchId ?? null
  const searching = visibleSearchSnapshot?.status === 'searching'
  const searchFailed = visibleSearchSnapshot?.status === 'error'
  const searchInteractive = visibleSearchSnapshot?.interactive ?? normalizedQuery.length === 0

  useEffect(() => {
    void workspaceRevision
    setActivePreview(null)
  }, [workspaceRevision])

  const layoutOptions = expanded ? EXPANDED_LAYOUT : COMPACT_LAYOUT
  const viewportDemandKey = `${chatId}:${expanded ? 'expanded' : 'compact'}`
  const layout = useMemo(() => {
    if (!bodyActive) return EMPTY_BRANCH_TREE_LAYOUT
    branchTreeComputationProbe?.('layout')
    return layoutBranchTree(projection, layoutOptions)
  }, [bodyActive, layoutOptions, projection])
  const headerById = exactHeaderById
  const headerByIdRef = useRef(headerById)
  headerByIdRef.current = headerById
  const connectorIndex = useMemo(() => {
    if (!bodyActive) return EMPTY_CONNECTOR_INDEX
    branchTreeComputationProbe?.('connector-index')
    return connectorIndexFor(layout)
  }, [bodyActive, layout])
  const acceptedLeaf = acceptedPath.leaf
  const activeLeafId = acceptedLeaf ? acceptedLeaf.id : null
  const activePathIds = bodyActive ? acceptedPath.messageIds : EMPTY_MESSAGE_ID_SET
  const selectedPathAttempts = useMemo(
    () =>
      activePathIds.size > 0
        ? targetedAttempts.filter((attempt) => activePathIds.has(attempt.messageId))
        : [],
    [activePathIds, targetedAttempts],
  )
  const generationBusy = selectedPathAttempts.length > 0
  const activeChildByParent = useMemo(() => {
    const active = new Map<MessageId, MessageId>()
    for (const id of activePathIds) {
      const parentId = layout.byId.get(id)?.parentId
      if (parentId) active.set(parentId, id)
    }
    return active
  }, [activePathIds, layout])
  const streamBusyParentIds = useMemo(() => {
    const parents = new Set<MessageId>()
    for (const messageId of busyMessageIds) {
      const parentId = layout.byId.get(messageId)?.parentId
      if (parentId) parents.add(parentId)
    }
    return parents
  }, [busyMessageIds, layout])
  const effectiveSelectedNodeId =
    selectedNodeId === undefined ? localSelectedNodeId : selectedNodeId
  const selectedHeader = effectiveSelectedNodeId
    ? headerById.get(effectiveSelectedNodeId)
    : undefined
  const liveSelectedHeader = selectedHeader?.deleted ? undefined : selectedHeader
  const inspectedMessageId = liveSelectedHeader?.id ?? null
  const selectedBodyVersion = liveSelectedHeader?.bodyVersion ?? null
  inspectedMessageIdRef.current = inspectedMessageId
  useConversationInspectorDemand(bodyActive ? chatId : null, inspectedMessageId, controller)
  const toolbarAttempt = useMemo(() => {
    const inspected = latestTargetAttempt(targetedAttempts, inspectedMessageId)
    const activeLeaf = latestTargetAttempt(targetedAttempts, activeLeafId)
    const selectedPath = latestAttempt(selectedPathAttempts)
    return inspected ?? activeLeaf ?? selectedPath
  }, [activeLeafId, inspectedMessageId, selectedPathAttempts, targetedAttempts])
  const toolbarStopCapability = useMemo(
    () => attemptStopCapability(toolbarAttempt),
    [toolbarAttempt],
  )
  const planeWidth = Math.max(layout.width, viewport.width)
  const planeHeight = Math.max(layout.height, viewport.height)
  const graphOffsetX = Math.max(0, (planeWidth - layout.width) / 2)
  const inspectorBounds = inspectorWidthBounds(workspaceWidth)
  const inspectorWidth = Math.min(
    inspectorBounds.max,
    Math.max(inspectorBounds.min, inspectorRatio * workspaceWidth),
  )

  const readViewport = useCallback(() => {
    viewportFrameRef.current = null
    const element = scrollRef.current
    if (!element) return
    const nextWorkspaceWidth = workspaceRef.current?.clientWidth || EMPTY_VIEWPORT.width
    setWorkspaceWidth((previous) =>
      previous === nextWorkspaceWidth ? previous : nextWorkspaceWidth,
    )
    const next: Viewport = {
      left: element.scrollLeft,
      top: element.scrollTop,
      width: element.clientWidth || EMPTY_VIEWPORT.width,
      height: element.clientHeight || EMPTY_VIEWPORT.height,
    }
    setViewport((previous) =>
      previous.left === next.left &&
      previous.top === next.top &&
      previous.width === next.width &&
      previous.height === next.height
        ? previous
        : next,
    )
  }, [])

  const scheduleViewportRead = useCallback(() => {
    if (viewportFrameRef.current !== null) return
    if (typeof requestAnimationFrame === 'function') {
      viewportFrameRef.current = requestAnimationFrame(readViewport)
    } else {
      readViewport()
    }
  }, [readViewport])

  useLayoutEffect(() => {
    if (!bodyActive) return
    readViewport()
    const element = scrollRef.current
    if (!element) return
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleViewportRead)
    observer?.observe(element)
    window.addEventListener('resize', scheduleViewportRead)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', scheduleViewportRead)
      if (viewportFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(viewportFrameRef.current)
        viewportFrameRef.current = null
      }
    }
  }, [bodyActive, readViewport, scheduleViewportRead])

  const centerNode = useCallback(
    (messageId: MessageId): boolean => {
      const element = scrollRef.current
      const node = layout.byId.get(messageId)
      if (!element || !node) return false
      const width = element.clientWidth || EMPTY_VIEWPORT.width
      const height = element.clientHeight || EMPTY_VIEWPORT.height
      element.scrollLeft = Math.max(0, graphOffsetX + node.x + node.width / 2 - width / 2)
      element.scrollTop = Math.max(0, node.y + node.height / 2 - height / 2)
      readViewport()
      return true
    },
    [graphOffsetX, layout, readViewport],
  )
  centerNodeRef.current = centerNode

  useLayoutEffect(() => {
    if (!bodyActive) return
    const focusNodeId = inspectedMessageId ?? currentMatchId ?? activeLeafId
    if (initialCenterKeyRef.current === viewportDemandKey || !focusNodeId) return
    if (!layout.byId.has(focusNodeId)) return
    if (!centerNode(focusNodeId)) return
    initialCenterKeyRef.current = viewportDemandKey
  }, [
    activeLeafId,
    bodyActive,
    centerNode,
    currentMatchId,
    inspectedMessageId,
    layout,
    viewportDemandKey,
  ])

  useEffect(() => {
    if (!bodyActive) return
    if (selectedNodeId === null) {
      lastExternalSelectionRef.current = null
      return
    }
    if (selectedNodeId === undefined || lastExternalSelectionRef.current === selectedNodeId) return
    lastExternalSelectionRef.current = selectedNodeId
    centerNode(selectedNodeId)
  }, [bodyActive, centerNode, selectedNodeId])

  useEffect(() => {
    if (selectionScopeChatIdRef.current === chatId) return
    selectionScopeChatIdRef.current = chatId
    setLocalSelectedNodeId(null)
  }, [chatId])

  useLayoutEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return
    workspace.style.setProperty('--branch-tree-inspector-width', `${inspectorWidth}px`)
    workspace.style.setProperty('--branch-tree-inspector-min-width', `${inspectorBounds.min}px`)
    workspace.style.setProperty('--branch-tree-canvas-min-width', `${inspectorBounds.canvasMin}px`)
  }, [inspectorBounds.canvasMin, inspectorBounds.min, inspectorWidth])

  const exactInspectedPresentation = binding.inspector.exact
  const retainedInspectedPresentation = binding.inspector.retained
  const exactInspectorBodyReady =
    exactInspectedPresentation?.message.id === inspectedMessageId &&
    exactInspectedPresentation.bodyVersion === selectedBodyVersion
  const selectedInspectedPresentation = exactInspectorBodyReady
    ? exactInspectedPresentation
    : retainedInspectedPresentation?.message.id === inspectedMessageId &&
        retainedInspectedPresentation.bodyVersion === selectedBodyVersion
      ? retainedInspectedPresentation
      : null
  const inspectedMessage: InspectedMessageSnapshot | null =
    inspectedMessageId === null || selectedBodyVersion === null
      ? null
      : selectedInspectedPresentation
        ? {
            id: inspectedMessageId,
            bodyVersion: selectedInspectedPresentation.bodyVersion,
            status: 'ready',
            message: selectedInspectedPresentation.message,
          }
        : {
            id: inspectedMessageId,
            bodyVersion: selectedBodyVersion,
            status: 'loading',
          }

  const rowStride = layoutOptions.nodeHeight + layoutOptions.verticalGap
  const firstVisibleDepth = Math.max(
    0,
    Math.floor((viewport.top - layoutOptions.padding - layoutOptions.nodeHeight) / rowStride) -
      VIEWPORT_OVERSCAN_ROWS,
  )
  const lastVisibleDepth = Math.min(
    layout.maxDepth,
    Math.ceil((viewport.top + viewport.height - layoutOptions.padding) / rowStride) +
      VIEWPORT_OVERSCAN_ROWS,
  )
  const visibleMinX = viewport.left - graphOffsetX - VIEWPORT_OVERSCAN_X - layoutOptions.nodeWidth
  const visibleMaxX = viewport.left - graphOffsetX + viewport.width + VIEWPORT_OVERSCAN_X

  const visibleNodes = useMemo(() => {
    const visible: BranchTreeLayoutNode[] = []
    for (let depth = firstVisibleDepth; depth <= lastVisibleDepth; depth += 1) {
      const row = layout.rowsByDepth[depth] ?? []
      let index = lowerBoundNodeX(row, visibleMinX)
      while (index < row.length) {
        const node = row[index] as BranchTreeLayoutNode
        if (node.x > visibleMaxX) break
        visible.push(node)
        index += 1
      }
    }
    return visible
  }, [firstVisibleDepth, lastVisibleDepth, layout, visibleMaxX, visibleMinX])

  const visibleConnectors = useMemo(() => {
    const shared: SharedConnector[] = []
    const children: ChildConnector[] = []
    const firstDepth = Math.max(0, firstVisibleDepth - 1)
    const lastDepth = Math.min(layout.maxDepth - 1, lastVisibleDepth)
    for (let depth = firstDepth; depth <= lastDepth; depth += 1) {
      queryIntervalTree(
        connectorIndex.sharedByDepth[depth] ?? null,
        visibleMinX,
        visibleMaxX,
        shared,
      )
      const row = connectorIndex.childrenByDepth[depth] ?? []
      let index = lowerBoundChildX(row, visibleMinX)
      while (index < row.length) {
        const connector = row[index] as ChildConnector
        if (connector.x > visibleMaxX) break
        children.push(connector)
        index += 1
      }
    }
    return { shared, children }
  }, [
    connectorIndex,
    firstVisibleDepth,
    lastVisibleDepth,
    layout.maxDepth,
    visibleMaxX,
    visibleMinX,
  ])

  const previewTargets = useMemo<TreePreviewTarget[]>(() => {
    if (!bodyActive) return []
    const targetIds = expanded
      ? visibleNodes.map((node) => node.id)
      : activePreview
        ? [activePreview.messageId]
        : []
    const targets: TreePreviewTarget[] = []
    for (const messageId of targetIds) {
      const header = headerById.get(messageId)
      if (!header || busyMessageIds.has(messageId)) continue
      targets.push({ messageId, bodyVersion: header.bodyVersion })
    }
    return targets
  }, [activePreview, bodyActive, busyMessageIds, expanded, headerById, visibleNodes])

  useConversationTreePreviewDemand(bodyActive ? chatId : null, previewTargets, controller)

  const previewTextFor = useCallback(
    (header: MessageHeaderRow): string | undefined => {
      const preview = binding.previews.get(header.id)
      return preview?.bodyVersion === header.bodyVersion ? preview.text : undefined
    },
    [binding.previews],
  )

  const openPreview = useCallback(
    (header: MessageHeaderRow) => {
      if (expanded) return
      setActivePreview((current) =>
        current?.messageId === header.id ? current : { messageId: header.id },
      )
    },
    [expanded],
  )

  useEffect(() => {
    if (!activePreview || (bodyActive && !expanded && headerById.has(activePreview.messageId))) {
      return
    }
    setActivePreview(null)
  }, [activePreview, bodyActive, expanded, headerById])

  const closePreview = useCallback((messageId: MessageId) => {
    setActivePreview((current) => (current?.messageId === messageId ? null : current))
  }, [])

  const automaticRevealId =
    binding.currency === 'current' && binding.reveal?.chatId === chatId ? binding.reveal.id : null
  const cancelAutomaticReveal = useCallback(() => {
    if (automaticRevealId) controller.consumePresentationReveal(automaticRevealId, 'tree')
  }, [automaticRevealId, controller])

  const selectMessage = useCallback(
    (messageId: MessageId) => {
      setActivePreview(null)
      setLocalSelectedNodeId(messageId)
      lastExternalSelectionRef.current = messageId
      onSelectNode?.(messageId)
    },
    [onSelectNode],
  )

  const inspectMessage = useCallback(
    (messageId: MessageId) => {
      cancelAutomaticReveal()
      selectMessage(messageId)
    },
    [cancelAutomaticReveal, selectMessage],
  )

  const inspectAndCenterMessage = useCallback(
    (messageId: MessageId): boolean => {
      selectMessage(messageId)
      return centerNodeRef.current(messageId)
    },
    [selectMessage],
  )

  const revealEffect = bodyActive ? binding.reveal : null
  useLayoutEffect(() => {
    if (
      !revealEffect ||
      revealEffect.chatId !== chatId ||
      !layout.byId.has(revealEffect.targetMessageId)
    ) {
      return
    }
    if (!inspectAndCenterMessage(revealEffect.targetMessageId)) return
    controller.consumePresentationReveal(revealEffect.id, 'tree')
  }, [chatId, controller, inspectAndCenterMessage, layout, revealEffect])

  const searchSyncRef = useRef<{
    session: typeof searchSession
    workspaceId: string
    replacementEpoch: number
    chatId: ChatId
    query: string
    topology: typeof projection
    headerSource: BranchTreeHeaderLookup
    busyIds: ReadonlySet<MessageId>
  } | null>(null)
  useLayoutEffect(() => {
    searchSession.setActive(bodyActive)
    if (!bodyActive) {
      searchWasActiveRef.current = false
      return
    }
    const workspaceId = binding.seal.workspaceId
    const previous = searchSyncRef.current
    const fullSync =
      !searchWasActiveRef.current ||
      previous === null ||
      previous.session !== searchSession ||
      previous.workspaceId !== workspaceId ||
      previous.replacementEpoch !== binding.seal.replacementEpoch ||
      previous.chatId !== chatId ||
      previous.query !== normalizedQuery ||
      previous.topology !== projection
    searchWasActiveRef.current = true
    const targetsFor = (messageIds: readonly MessageId[]) =>
      messageIds.flatMap((messageId) => {
        const header = exactHeaderById.get(messageId)
        if (!header) return []
        const target = branchTreeSearchTarget(header)
        return [{ ...target, pending: target.pending || busyMessageIds.has(messageId) }]
      })
    if (fullSync) {
      searchSession.request({
        workspaceId,
        replacementEpoch: binding.seal.replacementEpoch,
        chatId,
        query: normalizedQuery,
        targets: targetsFor(layout.nodes.map((node) => node.id)),
      })
    } else if (normalizedQuery.length > 0) {
      const headerSourceChanged = previous.headerSource !== exactHeaderById
      if (deliveredChangedHeaderKeys == null && headerSourceChanged) {
        searchSession.replaceTopology(targetsFor(layout.nodes.map((node) => node.id)))
      } else {
        const changedIds = new Set<MessageId>(deliveredChangedHeaderKeys ?? [])
        for (const messageId of previous.busyIds) {
          if (!busyMessageIds.has(messageId)) changedIds.add(messageId)
        }
        for (const messageId of busyMessageIds) {
          if (!previous.busyIds.has(messageId)) changedIds.add(messageId)
        }
        if (changedIds.size > 0) searchSession.observeTargets(targetsFor([...changedIds]))
      }
    }
    searchSession.setInspectedMessageId(inspectedMessageId)
    searchSyncRef.current = {
      session: searchSession,
      workspaceId,
      replacementEpoch: binding.seal.replacementEpoch,
      chatId,
      query: normalizedQuery,
      topology: projection,
      headerSource: exactHeaderById,
      busyIds: busyMessageIds,
    }
  }, [
    bodyActive,
    busyMessageIds,
    deliveredChangedHeaderKeys,
    chatId,
    binding.seal.replacementEpoch,
    binding.seal.workspaceId,
    exactHeaderById,
    inspectedMessageId,
    layout,
    normalizedQuery,
    projection,
    searchSession,
  ])

  useEffect(() => {
    if (!bodyActive) return
    const revealRevision = visibleSearchSnapshot?.revealRevision ?? 0
    if (revealRevision === 0 || revealRevision === handledSearchRevealRef.current) return
    handledSearchRevealRef.current = revealRevision
    if (visibleSearchSnapshot?.currentMatchId) {
      inspectAndCenterMessage(visibleSearchSnapshot.currentMatchId)
    }
  }, [bodyActive, inspectAndCenterMessage, visibleSearchSnapshot])

  useEffect(() => {
    if (!bodyActive) return
    const focusSearch = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.key.toLocaleLowerCase() !== 'f'
      ) {
        return
      }
      event.preventDefault()
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [bodyActive])

  const goToMatch = useCallback(
    (direction: -1 | 1) => {
      cancelAutomaticReveal()
      const messageId = searchSession.move(direction)
      if (!messageId) return
      handledSearchRevealRef.current = searchSession.getSnapshot()?.revealRevision ?? 0
      inspectAndCenterMessage(messageId)
    },
    [cancelAutomaticReveal, inspectAndCenterMessage, searchSession],
  )

  const clearSelection = useCallback(() => {
    cancelAutomaticReveal()
    setLocalSelectedNodeId(null)
    onSelectNode?.(null)
  }, [cancelAutomaticReveal, onSelectNode])

  const settleBranchTreeAction = useCallback(
    async (label: string, action: () => void | Promise<void>): Promise<void> => {
      try {
        await action()
        setActionError(null)
      } catch (error) {
        setActionError(
          `${label} failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        )
      }
    },
    [],
  )

  useEffect(() => {
    if (!inspectedMessageId) return
    const closeInspector = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape') return
      event.preventDefault()
      clearSelection()
    }
    window.addEventListener('keydown', closeInspector)
    return () => window.removeEventListener('keydown', closeInspector)
  }, [clearSelection, inspectedMessageId])

  const activateNode = useCallback(
    (messageId: MessageId) => {
      cancelAutomaticReveal()
      return settleBranchTreeAction('Open branch', () =>
        onActivateNode(messageId, layout.byId.get(messageId)?.newestLeafId),
      )
    },
    [cancelAutomaticReveal, layout, onActivateNode, settleBranchTreeAction],
  )

  const setInspectorWidthFromClientX = useCallback((clientX: number) => {
    const workspace = workspaceRef.current
    if (!workspace) return
    const bounds = workspace.getBoundingClientRect()
    if (bounds.width <= 0) return
    const inspectorBounds = inspectorWidthBounds(bounds.width)
    const width = Math.min(
      inspectorBounds.max,
      Math.max(inspectorBounds.min, bounds.right - clientX),
    )
    setInspectorRatio(width / bounds.width)
  }, [])

  const flushPendingInspectorResize = useCallback(() => {
    inspectorResizeFrameRef.current = null
    const clientX = pendingInspectorClientXRef.current
    pendingInspectorClientXRef.current = null
    if (clientX !== null) setInspectorWidthFromClientX(clientX)
  }, [setInspectorWidthFromClientX])

  const scheduleInspectorResize = useCallback(
    (clientX: number) => {
      pendingInspectorClientXRef.current = clientX
      if (inspectorResizeFrameRef.current !== null) return
      if (typeof requestAnimationFrame === 'function') {
        inspectorResizeFrameRef.current = requestAnimationFrame(flushPendingInspectorResize)
      } else {
        flushPendingInspectorResize()
      }
    },
    [flushPendingInspectorResize],
  )

  const handleSeparatorPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      resizingInspectorRef.current = true
      setResizingInspector(true)
      setInspectorWidthFromClientX(event.clientX)
    },
    [setInspectorWidthFromClientX],
  )

  const handleSeparatorPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!resizingInspectorRef.current || !event.currentTarget.hasPointerCapture(event.pointerId))
        return
      scheduleInspectorResize(event.clientX)
    },
    [scheduleInspectorResize],
  )

  const handleSeparatorPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!resizingInspectorRef.current) return
      resizingInspectorRef.current = false
      pendingInspectorClientXRef.current = null
      if (inspectorResizeFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(inspectorResizeFrameRef.current)
      }
      inspectorResizeFrameRef.current = null
      setInspectorWidthFromClientX(event.clientX)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      setResizingInspector(false)
    },
    [setInspectorWidthFromClientX],
  )

  useEffect(
    () => () => {
      if (inspectorResizeFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(inspectorResizeFrameRef.current)
      }
    },
    [],
  )

  const handleSeparatorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const workspace = workspaceRef.current
      if (!workspace || workspace.clientWidth <= 0) return
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? 1 : -1
      const inspectorBounds = inspectorWidthBounds(workspace.clientWidth)
      const currentWidth = Math.min(
        inspectorBounds.max,
        Math.max(inspectorBounds.min, inspectorRatio * workspace.clientWidth),
      )
      const nextWidth = Math.min(
        inspectorBounds.max,
        Math.max(inspectorBounds.min, currentWidth + direction * 40),
      )
      setInspectorRatio(nextWidth / workspace.clientWidth)
    },
    [inspectorRatio],
  )

  const handleCanvasClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (suppressCanvasClickRef.current) {
        suppressCanvasClickRef.current = false
        return
      }
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('[data-ui="branch-tree-node"], [data-connector-hit]')
      ) {
        return
      }
      clearSelection()
    },
    [clearSelection],
  )

  const handleCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    suppressCanvasClickRef.current = false
    if (event.button !== 0) return
    const target = event.target
    if (
      target instanceof Element &&
      target.closest('[data-ui="branch-tree-node"], [data-connector-hit]')
    ) {
      return
    }
    if (pointerHitsScrollbarGutter(event.currentTarget, event.clientX, event.clientY)) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    panGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: event.currentTarget.scrollLeft,
      startScrollTop: event.currentTarget.scrollTop,
      moved: false,
    }
    setPanningCanvas(true)
  }, [])

  const handleCanvasPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = panGestureRef.current
      if (!gesture || gesture.pointerId !== event.pointerId) return
      const deltaX = event.clientX - gesture.startX
      const deltaY = event.clientY - gesture.startY
      if (!gesture.moved && Math.hypot(deltaX, deltaY) >= 3) gesture.moved = true
      event.currentTarget.scrollLeft = gesture.startScrollLeft - deltaX
      event.currentTarget.scrollTop = gesture.startScrollTop - deltaY
      scheduleViewportRead()
    },
    [scheduleViewportRead],
  )

  const handleCanvasPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = panGestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (gesture.moved) {
      suppressCanvasClickRef.current = true
    }
    panGestureRef.current = null
    setPanningCanvas(false)
  }, [])

  const matchSet = useMemo(() => new Set(matches), [matches])
  const previewNode = activePreview ? layout.byId.get(activePreview.messageId) : undefined
  const activePreviewHeader = activePreview ? headerById.get(activePreview.messageId) : undefined
  const activePreviewText = activePreviewHeader
    ? busyMessageIds.has(activePreviewHeader.id)
      ? 'Streaming response…'
      : previewTextFor(activePreviewHeader)
    : undefined
  const readyInspectedMessage =
    inspectedMessage?.status === 'ready' &&
    inspectedMessage.bodyVersion === selectedBodyVersion &&
    inspectedMessage.message.id === liveSelectedHeader?.id
      ? inspectedMessage
      : undefined
  const inspectorBody = readyInspectedMessage?.message
  const inspectorBodyVersion = readyInspectedMessage?.bodyVersion
  const inspectorMessage = useMemo<Message | undefined>(() => {
    if (!inspectorBody || liveSelectedHeader?.id !== inspectorBody.id) return undefined
    return rebaseHydratedMessageHeader(inspectorBody, liveSelectedHeader)
  }, [inspectorBody, liveSelectedHeader])
  const handleInspectorActivate = useCallback(() => {
    if (inspectedMessageId) void activateNode(inspectedMessageId)
  }, [activateNode, inspectedMessageId])
  const inspectorMessageActions = useMemo(() => {
    if (!inspectorMessage) return {}
    return {
      ...(onDeleteNode ? { onDelete: () => onDeleteNode(inspectorMessage) } : {}),
      ...(onForkMessage ? { onForkChat: () => onForkMessage(inspectorMessage) } : {}),
      ...(onToggleMessageContextVisibility
        ? {
            onToggleContextVisibility: () => onToggleMessageContextVisibility(inspectorMessage),
          }
        : {}),
      ...(onMutateMessageAttachmentRef
        ? {
            onMutateAttachmentRef: (mutation: MessageAttachmentRefMutation) =>
              onMutateMessageAttachmentRef(inspectorMessage, mutation),
          }
        : {}),
      ...(onToggleReasoningDetailHidden
        ? {
            onToggleReasoningDetailHidden: (member: ReasoningMemberRef) =>
              onToggleReasoningDetailHidden(inspectorMessage, member),
          }
        : {}),
      ...(onEditReasoningDetail
        ? {
            onEditReasoningDetail: (
              member: Extract<ReasoningMemberRef, { kind: 'visible' }>,
              text: string,
            ) => onEditReasoningDetail(inspectorMessage, member, text),
          }
        : {}),
      ...(onToggleProviderOutputItemHidden
        ? {
            onToggleProviderOutputItemHidden: (member: ProviderOutputMemberRef) =>
              onToggleProviderOutputItemHidden(inspectorMessage, member),
          }
        : {}),
    }
  }, [
    inspectorMessage,
    onDeleteNode,
    onForkMessage,
    onMutateMessageAttachmentRef,
    onToggleMessageContextVisibility,
    onEditReasoningDetail,
    onToggleProviderOutputItemHidden,
    onToggleReasoningDetailHidden,
  ])

  return (
    <section
      className={className}
      data-ui="branch-tree-view"
      data-expanded={expanded}
      data-presentation-only={!bodyActive || undefined}
      inert={!bodyActive || undefined}
      aria-busy={!bodyActive || undefined}
      aria-label="Chat tree"
    >
      <div data-ui="branch-tree-toolbar">
        <search data-ui="branch-tree-search">
          <span aria-hidden="true" data-ui="branch-tree-search-icon">
            <SearchIcon size={14} />
          </span>
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            placeholder="Search this chat tree"
            aria-label="Search messages in this chat"
            aria-controls="branch-tree-canvas"
            aria-busy={searching}
            data-ui="branch-tree-search-input"
            onChange={(event) => {
              cancelAutomaticReveal()
              setQuery(event.currentTarget.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                goToMatch(event.shiftKey ? -1 : 1)
              } else if (event.key === 'Escape') {
                if (query.length > 0) {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelAutomaticReveal()
                  setQuery('')
                }
              }
            }}
          />
          {query.length > 0 ? (
            <Button
              type="button"
              aria-label="Clear tree search"
              data-ui="branch-tree-search-clear"
              onClick={() => {
                cancelAutomaticReveal()
                setQuery('')
                searchInputRef.current?.focus()
              }}
            >
              <CloseIcon size={13} />
            </Button>
          ) : null}
          <output
            aria-live="polite"
            data-ui="branch-tree-search-status"
            data-state={searchFailed ? 'error' : searching ? 'searching' : 'idle'}
          >
            {searchFailed
              ? 'Error'
              : searching
                ? 'Searching…'
                : query.length > 0
                  ? matches.length > 0
                    ? `${matchIndex + 1} / ${matches.length}`
                    : '0 / 0'
                  : ''}
          </output>
          <Button
            type="button"
            aria-label="Previous matching message"
            data-ui="branch-tree-search-nav"
            disabled={!searchInteractive || matches.length === 0}
            onClick={() => goToMatch(-1)}
          >
            <ChevronIcon size={15} rotate={180} />
          </Button>
          <Button
            type="button"
            aria-label="Next matching message"
            data-ui="branch-tree-search-nav"
            disabled={!searchInteractive || matches.length === 0}
            onClick={() => goToMatch(1)}
          >
            <ChevronIcon size={15} />
          </Button>
        </search>
        {toolbarStopCapability ? (
          <Button
            type="button"
            data-ui="branch-tree-stop"
            aria-label={
              toolbarStopCapability.kind === 'requestable' ? 'Stop generating' : 'Stop requested'
            }
            title={
              toolbarStopCapability.kind === 'requestable' ? 'Stop generating' : 'Stop requested'
            }
            disabled={toolbarStopCapability.kind !== 'requestable' || !onRequestStop}
            onClick={() => {
              if (toolbarStopCapability.kind === 'requestable') {
                onRequestStop?.(toolbarStopCapability)
              }
            }}
          >
            <StopIcon size={14} />
            <span>
              {toolbarStopCapability.kind === 'requestable'
                ? 'Stop'
                : toolbarStopCapability.kind === 'requesting'
                  ? 'Stop requested…'
                  : 'Stopping…'}
            </span>
          </Button>
        ) : null}
      </div>

      {actionError ? (
        <div role="alert" data-ui="branch-tree-action-error">
          {actionError}
        </div>
      ) : null}

      <div
        ref={workspaceRef}
        data-ui="branch-tree-workspace"
        data-inspector-open={inspectedMessageId ? true : undefined}
        data-resizing={resizingInspector || undefined}
      >
        <div data-ui="branch-tree-canvas-pane">
          {/* biome-ignore lint/a11y/useSemanticElements: a scrollable graph canvas is a labeled group, not form controls. */}
          <div
            id="branch-tree-canvas"
            ref={scrollRef}
            tabIndex={-1}
            role="group"
            aria-label="Conversation tree canvas"
            data-ui="branch-tree-scroll"
            data-panning={panningCanvas || undefined}
            onScroll={scheduleViewportRead}
            onClick={handleCanvasClick}
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={handleCanvasPointerEnd}
            onPointerCancel={handleCanvasPointerEnd}
            onLostPointerCapture={handleCanvasPointerEnd}
            onKeyDown={(event) => {
              if (event.key === 'Escape') clearSelection()
            }}
          >
            {layout.nodes.length === 0 ? (
              <div role="status" data-ui="branch-tree-empty">
                {generationBusy ? 'Preparing response…' : 'This chat has no messages yet.'}
              </div>
            ) : (
              <svg
                aria-label="Message relationships"
                data-ui="branch-tree-plane"
                width={planeWidth}
                height={planeHeight}
              >
                <g transform={`translate(${graphOffsetX} 0)`}>
                  {visibleConnectors.shared.map((connector) => {
                    const active = activeChildByParent.has(connector.parentId)
                    const highlighted = hoveredConnectorKey === connector.key
                    return (
                      <path
                        key={connector.key}
                        d={connector.path}
                        data-ui="branch-tree-connector"
                        data-connector-kind="shared-trunk"
                        data-active={active || undefined}
                        data-highlighted={highlighted || undefined}
                        vectorEffect="non-scaling-stroke"
                      />
                    )
                  })}
                  {visibleConnectors.children.map((connector) => {
                    const active = activeChildByParent.get(connector.parentId) === connector.childId
                    const highlighted = hoveredConnectorKey === connector.key
                    return (
                      <path
                        key={connector.key}
                        d={connector.path}
                        data-ui="branch-tree-connector"
                        data-connector-kind="child-leg"
                        data-active={active || undefined}
                        data-highlighted={highlighted || undefined}
                        vectorEffect="non-scaling-stroke"
                      />
                    )
                  })}

                  {onInsertAtSharedTrunk
                    ? visibleConnectors.shared.map((connector) => {
                        const streamBusy = streamBusyParentIds.has(connector.parentId)
                        const structuralBusy = streamBusy || structuralMutationPending
                        return (
                          <SvgAction
                            key={`${connector.key}:hit-group`}
                            label="Insert after this parent before all of its children"
                            disabled={structuralBusy}
                            data-connector-hit="shared-trunk"
                            data-parent-id={connector.parentId}
                            data-stream-busy={streamBusy || undefined}
                            onPointerEnter={() => {
                              if (!structuralBusy) setHoveredConnectorKey(connector.key)
                            }}
                            onPointerLeave={() => setHoveredConnectorKey(null)}
                            onFocus={() => {
                              if (!structuralBusy) setHoveredConnectorKey(connector.key)
                            }}
                            onBlur={() => setHoveredConnectorKey(null)}
                            onActivate={() => {
                              void settleBranchTreeAction('Insert message', () =>
                                onInsertAtSharedTrunk(connector.parentId),
                              )
                            }}
                          >
                            {structuralBusy ? (
                              <title>
                                {structuralMutationPending
                                  ? 'Wait for the current structural update before inserting'
                                  : 'Wait for the connected generation to finish before inserting'}
                              </title>
                            ) : null}
                            <path d={connector.path} data-ui="branch-tree-connector-hit-path" />
                            <BranchTreeAddMarker
                              ui="branch-tree-connector-add"
                              x={connector.insertX}
                              y={connector.insertY}
                              highlighted={hoveredConnectorKey === connector.key}
                            />
                          </SvgAction>
                        )
                      })
                    : null}
                  {onInsertAtChildLeg
                    ? visibleConnectors.children.map((connector) => {
                        const streamBusy = busyMessageIds.has(connector.childId)
                        const structuralBusy = streamBusy || structuralMutationPending
                        return (
                          <SvgAction
                            key={`${connector.key}:hit-group`}
                            label="Insert before this child only"
                            disabled={structuralBusy}
                            data-connector-hit="child-leg"
                            data-parent-id={connector.parentId}
                            data-child-id={connector.childId}
                            data-stream-busy={streamBusy || undefined}
                            onPointerEnter={() => {
                              if (!structuralBusy) setHoveredConnectorKey(connector.key)
                            }}
                            onPointerLeave={() => setHoveredConnectorKey(null)}
                            onFocus={() => {
                              if (!structuralBusy) setHoveredConnectorKey(connector.key)
                            }}
                            onBlur={() => setHoveredConnectorKey(null)}
                            onActivate={() => {
                              void settleBranchTreeAction('Insert message', () =>
                                onInsertAtChildLeg(connector.childId),
                              )
                            }}
                          >
                            {structuralBusy ? (
                              <title>
                                {structuralMutationPending
                                  ? 'Wait for the current structural update before inserting'
                                  : 'Wait for this generation to finish before inserting'}
                              </title>
                            ) : null}
                            <path d={connector.path} data-ui="branch-tree-connector-hit-path" />
                            <BranchTreeAddMarker
                              ui="branch-tree-connector-add"
                              x={connector.insertX}
                              y={connector.insertY}
                              highlighted={hoveredConnectorKey === connector.key}
                            />
                          </SvgAction>
                        )
                      })
                    : null}
                  {onInsertAfterLeaf
                    ? visibleNodes.map((node) => {
                        if ((layout.childrenByParent.get(node.id)?.length ?? 0) > 0) return null
                        const streamBusy = busyMessageIds.has(node.id)
                        const structuralBusy = streamBusy || structuralMutationPending
                        const markerKey = `leaf:${node.id}`
                        const x = node.x + node.width / 2
                        const startY = node.y + node.height
                        const markerY = startY + 28
                        const path = `M ${x} ${startY} V ${markerY}`
                        return (
                          <SvgAction
                            key={markerKey}
                            label="Add message after this leaf"
                            disabled={structuralBusy}
                            data-connector-hit="leaf-append"
                            data-parent-id={node.id}
                            data-stream-busy={streamBusy || undefined}
                            onPointerEnter={() => {
                              if (!structuralBusy) setHoveredConnectorKey(markerKey)
                            }}
                            onPointerLeave={() => setHoveredConnectorKey(null)}
                            onFocus={() => {
                              if (!structuralBusy) setHoveredConnectorKey(markerKey)
                            }}
                            onBlur={() => setHoveredConnectorKey(null)}
                            onActivate={() => {
                              void settleBranchTreeAction('Insert message', () =>
                                onInsertAfterLeaf(node.id),
                              )
                            }}
                          >
                            {structuralBusy ? (
                              <title>
                                {structuralMutationPending
                                  ? 'Wait for the current structural update before adding a child'
                                  : 'Wait for this generation to finish before adding a child'}
                              </title>
                            ) : null}
                            <path
                              d={path}
                              data-ui="branch-tree-connector"
                              data-connector-kind="leaf-append"
                              data-active={activePathIds.has(node.id) || undefined}
                              data-highlighted={hoveredConnectorKey === markerKey || undefined}
                            />
                            <path d={path} data-ui="branch-tree-connector-hit-path" />
                            <BranchTreeAddMarker
                              ui="branch-tree-leaf-add"
                              x={x}
                              y={markerY}
                              highlighted={hoveredConnectorKey === markerKey}
                            />
                          </SvgAction>
                        )
                      })
                    : null}

                  {visibleNodes.map((node) => {
                    const header = headerById.get(node.id)
                    if (!header) return null
                    const streaming = busyMessageIds.has(node.id)
                    const cachedPreview = streaming ? undefined : previewTextFor(header)
                    const previewText = streaming
                      ? 'Streaming response…'
                      : cachedPreview === undefined
                        ? 'Loading preview…'
                        : cachedPreview.length > 0
                          ? cachedPreview
                          : 'No text content'
                    const onActivePath = activePathIds.has(node.id)
                    const currentLeaf = node.id === activeLeafId
                    const selected = node.id === effectiveSelectedNodeId
                    const searchMatch = matchSet.has(node.id)
                    const currentMatch = node.id === currentMatchId
                    return (
                      <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
                        <a
                          href={chatHref(chatId, node.newestLeafId)}
                          rel="noopener"
                          data-ui="branch-tree-node"
                          data-message-id={node.id}
                          data-role={header.role}
                          data-hidden-from-context={header.hiddenFromContext || undefined}
                          data-streaming={streaming || undefined}
                          data-active-path={onActivePath || undefined}
                          data-current-leaf={currentLeaf || undefined}
                          data-selected={selected || undefined}
                          data-search-match={searchMatch || undefined}
                          data-current-match={currentMatch || undefined}
                          aria-label={`${roleLabel(header.role)} message${header.hiddenFromContext ? ', hidden from context' : ''}${streaming ? ', streaming' : ''}${selected ? ', inspected' : ''}${currentLeaf ? ', current leaf' : ''}${cachedPreview ? `: ${cachedPreview.slice(0, 160)}` : ''}`}
                          aria-current={currentLeaf ? 'true' : undefined}
                          onClick={(event) => {
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
                            inspectMessage(node.id)
                          }}
                          onDoubleClick={(event) => {
                            event.preventDefault()
                            void activateNode(node.id)
                          }}
                          onPointerEnter={() => openPreview(header)}
                          onPointerLeave={(event) => {
                            if (document.activeElement !== event.currentTarget)
                              closePreview(node.id)
                          }}
                          onFocus={() => openPreview(header)}
                          onBlur={() => closePreview(node.id)}
                        >
                          <TreeNodeShape
                            role={header.role}
                            width={node.width}
                            height={node.height}
                            expanded={expanded}
                          />
                          {expanded ? (
                            <Suspense fallback={null}>
                              <BranchTreePreview
                                kind="expanded"
                                role={header.role}
                                text={previewText}
                                width={node.width}
                                fontFamily={previewFontFamily}
                              />
                            </Suspense>
                          ) : null}
                          {header.hiddenFromContext ? (
                            <TreeNodeVisibilityMarker
                              width={node.width}
                              height={node.height}
                              expanded={expanded}
                            />
                          ) : null}
                        </a>
                      </g>
                    )
                  })}

                  {!expanded && activePreview && previewNode ? (
                    <Suspense fallback={null}>
                      <BranchTreePreview
                        kind="hover"
                        role={previewNode.source.role}
                        text={activePreviewText}
                        node={previewNode}
                        viewport={viewport}
                        graphOffsetX={graphOffsetX}
                        fontFamily={previewFontFamily}
                      />
                    </Suspense>
                  ) : null}
                </g>
              </svg>
            )}
          </div>
          <TreeDensityToggle placement="canvas" />
        </div>

        {inspectedMessageId ? (
          <>
            {/* biome-ignore lint/a11y/useSemanticElements: the interactive full-height drag target must not inherit hr geometry. */}
            <div
              role="separator"
              tabIndex={0}
              aria-label="Resize message details"
              aria-orientation="vertical"
              aria-valuemin={Math.round((inspectorBounds.min / workspaceWidth) * 100)}
              aria-valuemax={Math.round((inspectorBounds.max / workspaceWidth) * 100)}
              aria-valuenow={Math.round((inspectorWidth / workspaceWidth) * 100)}
              data-ui="branch-tree-separator"
              onPointerDown={handleSeparatorPointerDown}
              onPointerMove={handleSeparatorPointerMove}
              onPointerUp={handleSeparatorPointerEnd}
              onPointerCancel={handleSeparatorPointerEnd}
              onLostPointerCapture={handleSeparatorPointerEnd}
              onKeyDown={handleSeparatorKeyDown}
            />
            <div data-ui="branch-tree-inspector-slot">
              {!inspectedMessage || inspectedMessage.id !== inspectedMessageId ? (
                <div role="status" data-ui="branch-tree-inspector-status">
                  Loading message…
                </div>
              ) : inspectorMessage ? (
                <Suspense
                  fallback={
                    <div role="status" data-ui="branch-tree-inspector-status">
                      Loading message renderer…
                    </div>
                  }
                >
                  <BranchTreeInspector
                    key={inspectorMessage.id}
                    message={inspectorMessage}
                    presentationFence={binding.seal}
                    bodyVersion={inspectorBodyVersion as number}
                    bodyReady={exactInspectorBodyReady}
                    searchQuery={normalizedQuery}
                    searchMatched={matchSet.has(inspectedMessageId)}
                    generationSubmissionPending={generationSubmissionPending}
                    structuralMutationPending={structuralMutationPending}
                    {...(onCancelGenerationSubmission ? { onCancelGenerationSubmission } : {})}
                    {...(onCancelStructuralMutation ? { onCancelStructuralMutation } : {})}
                    streamOnActivePath={activePathIds.has(inspectedMessageId)}
                    onClose={clearSelection}
                    onActivate={handleInspectorActivate}
                    {...(onEditMessage ? { onEdit: onEditMessage } : {})}
                    {...(onEditAndSendMessage ? { onEditAndSend: onEditAndSendMessage } : {})}
                    {...(onRegenerateMessage
                      ? { onRegenerate: () => onRegenerateMessage(inspectorMessage) }
                      : {})}
                    {...(onContinueMessage
                      ? { onContinue: () => onContinueMessage(inspectorMessage) }
                      : {})}
                    {...inspectorMessageActions}
                  />
                </Suspense>
              ) : (
                <div role="status" data-ui="branch-tree-inspector-status">
                  Loading message…
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </section>
  )
})

export const BranchTreeView = ActiveBranchTreeView

function BranchTreeAddMarker({
  ui,
  x,
  y,
  highlighted,
}: {
  ui: 'branch-tree-connector-add' | 'branch-tree-leaf-add'
  x: number
  y: number
  highlighted: boolean
}) {
  return (
    <g data-ui={ui} data-highlighted={highlighted || undefined} transform={`translate(${x} ${y})`}>
      <circle r={8} />
      <path d="M -3.25 0 H 3.25 M 0 -3.25 V 3.25" />
    </g>
  )
}

function treePreviewFontFamily(): string {
  if (typeof document === 'undefined') return 'system-ui, sans-serif'
  const configured = document.documentElement.style.getPropertyValue('--font-sans').trim()
  return (configured || 'system-ui, sans-serif').replace(/^ui-sans-serif\s*,\s*/u, '')
}

function TreeNodeVisibilityMarker({
  width,
  height,
  expanded,
}: {
  width: number
  height: number
  expanded: boolean
}) {
  const radius = expanded ? 10 : 8
  const x = width - radius - (expanded ? 8 : 1)
  const y = height - radius - (expanded ? 8 : 1)
  const scale = expanded ? 0.58 : 0.46
  const iconSize = 24 * scale
  return (
    <g data-ui="branch-tree-node-visibility">
      <circle cx={x} cy={y} r={radius} />
      <g transform={`translate(${x - iconSize / 2} ${y - iconSize / 2}) scale(${scale})`}>
        <EyeOffIcon size={24} />
      </g>
    </g>
  )
}

function TreeNodeShape({
  role,
  width,
  height,
  expanded,
}: {
  role: MessageRole
  width: number
  height: number
  expanded: boolean
}) {
  const compactInsetX = 4
  const compactInsetY = role === 'user' ? 6 : 4
  const compactWidth = width - compactInsetX * 2
  const compactHeight = height - compactInsetY * 2
  const compactRadius = Math.max(4, Math.min(compactWidth, compactHeight) / 2)
  const hexagon = `${width / 2},4 ${width - 4},${height * 0.3} ${width - 4},${
    height * 0.7
  } ${width / 2},${height - 4} 4,${height * 0.7} 4,${height * 0.3}`

  return (
    <>
      {expanded ? (
        <rect
          data-ui="branch-tree-node-surface"
          data-shape="card"
          x={1}
          y={1}
          width={width - 2}
          height={height - 2}
          rx={7}
        />
      ) : role === 'assistant' ? (
        <circle
          data-ui="branch-tree-node-surface"
          data-shape="circle"
          cx={width / 2}
          cy={height / 2}
          r={compactRadius}
        />
      ) : role === 'tool' ? (
        <polygon data-ui="branch-tree-node-surface" data-shape="hexagon" points={hexagon} />
      ) : (
        <rect
          data-ui="branch-tree-node-surface"
          data-shape={role === 'user' ? 'rounded-square' : 'square'}
          x={compactInsetX}
          y={compactInsetY}
          width={compactWidth}
          height={compactHeight}
          rx={role === 'user' ? 6 : 3}
        />
      )}
      {!expanded && (role === 'user' || role === 'assistant') ? (
        <g
          data-ui="branch-tree-node-icon"
          data-role={role}
          transform={`translate(${width / 2 - 10} ${height / 2 - 10})`}
        >
          {role === 'user' ? <PersonIcon size={20} /> : <RobotIcon size={20} />}
        </g>
      ) : null}
      <TreeNodeOutline
        role={role}
        width={width}
        height={height}
        expanded={expanded}
        kind="search"
      />
      <TreeNodeOutline
        role={role}
        width={width}
        height={height}
        expanded={expanded}
        kind="selection"
      />
      <circle data-ui="branch-tree-node-leaf-dot" cx={width - 2} cy={2} r={5} />
    </>
  )
}

function TreeNodeOutline({
  role,
  width,
  height,
  expanded,
  kind,
}: {
  role: MessageRole
  width: number
  height: number
  expanded: boolean
  kind: 'search' | 'selection'
}) {
  const expansion = kind === 'search' ? 2.5 : 5
  const dataUi =
    kind === 'search' ? 'branch-tree-node-search-ring' : 'branch-tree-node-selection-ring'
  if (expanded) {
    return (
      <rect
        data-ui={dataUi}
        data-shape="card"
        x={1 - expansion}
        y={1 - expansion}
        width={width - 2 + expansion * 2}
        height={height - 2 + expansion * 2}
        rx={7 + expansion}
      />
    )
  }

  const insetX = 4
  const insetY = role === 'user' ? 6 : 4
  const compactWidth = width - insetX * 2
  const compactHeight = height - insetY * 2
  if (role === 'assistant') {
    return (
      <circle
        data-ui={dataUi}
        data-shape="circle"
        cx={width / 2}
        cy={height / 2}
        r={Math.max(4, Math.min(compactWidth, compactHeight) / 2) + expansion}
      />
    )
  }
  if (role === 'tool') {
    const inset = 4 - expansion
    const points = `${width / 2},${inset} ${width - inset},${height * 0.3} ${
      width - inset
    },${height * 0.7} ${width / 2},${height - inset} ${inset},${
      height * 0.7
    } ${inset},${height * 0.3}`
    return <polygon data-ui={dataUi} data-shape="hexagon" points={points} />
  }
  return (
    <rect
      data-ui={dataUi}
      data-shape={role === 'user' ? 'rounded-square' : 'square'}
      x={insetX - expansion}
      y={insetY - expansion}
      width={compactWidth + expansion * 2}
      height={compactHeight + expansion * 2}
      rx={(role === 'user' ? 6 : 3) + expansion}
    />
  )
}
