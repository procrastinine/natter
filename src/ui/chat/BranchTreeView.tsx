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
} from 'react'
import { chatHref } from '../../app/router'
import { type MessageTreeProjection, resolveActiveLeafIdProjected } from '../../core/active-path'
import {
  type BranchTreeLayout,
  type BranchTreeLayoutNode,
  layoutBranchTree,
} from '../../core/branch-tree-layout'
import type { ChatId, CursorMap, Message, MessageId, MessageRole } from '../../core/types'
import type { StructuralMessageHeader } from '../../hooks/useBranchUrlSync'
import type { MessageAttachmentRefMutation } from '../../store/attachments'
import { onEvent } from '../../store/broadcast'
import {
  type MessageHeaderRow,
  previewTextFromContent,
  rebaseHydratedMessageHeader,
} from '../../store/message-storage'
import { primaryKeys } from '../../store/reactive-dependencies'
import { useRepositoryPresentationQuery } from '../../store/reactive-query'
import type { MessagePresentationSnapshot, WorkspaceRepository } from '../../store/repository'
import { getWorkspaceRepository } from '../../store/workspace-repository'
import {
  type ActiveStream,
  isStreamRelevantToSelectedPath,
  useActiveStreamsForChat,
  useStreamStore,
} from '../../store/zustand/streamStore'
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

const PREVIEW_CACHE_LIMIT = 256
const PREVIEW_TEXT_MAX_CHARS = 960
const PREVIEW_CACHE_CHAR_LIMIT = PREVIEW_CACHE_LIMIT * PREVIEW_TEXT_MAX_CHARS
const EXPANDED_PREVIEW_CONCURRENCY = 6
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

const BranchTreeInspector = lazy(() =>
  import('./BranchTreeInspector').then((module) => ({ default: module.BranchTreeInspector })),
)
const BranchTreePreview = lazy(() =>
  import('./BranchTreePreview').then((module) => ({ default: module.BranchTreePreview })),
)

type BranchTreeComputation =
  | 'render'
  | 'layout'
  | 'connector-index'
  | 'preview-complete'
  | 'preview-publish'
type BranchTreeComputationProbe = (operation: BranchTreeComputation) => void
let branchTreeComputationProbe: BranchTreeComputationProbe | undefined

function setBranchTreeComputationProbeForTests(
  probe: BranchTreeComputationProbe | undefined,
): void {
  if (import.meta.env.MODE === 'test') branchTreeComputationProbe = probe
}

export type BranchTreeRepository = Pick<
  WorkspaceRepository,
  'getMessagePresentationSnapshot' | 'getMessageTextPreview' | 'searchChatMessageText'
>

interface BranchTreeHeaderLookup {
  get(messageId: MessageId): MessageHeaderRow | undefined
}

interface SearchRevisionState {
  versions: ReadonlyMap<MessageId, number>
  value: number
  active: boolean
  headersSource: readonly MessageHeaderRow[] | null
  latestHeaderSource: BranchTreeHeaderLookup | undefined
  frozenIds: ReadonlySet<MessageId>
}

interface CompactPreviewRequest {
  controller: AbortController
  header: MessageHeaderRow
  key: string
}

interface QueuedCompactPreview {
  header: MessageHeaderRow
  key: string
}

type BranchTreeAction = (messageId: MessageId) => void | Promise<void>
type BranchTreeEditAction = (message: Message, text: string) => void | Promise<void>
type BranchTreeMessageAction = (message: Message) => void | Promise<void>
type BranchTreeRequestAction = (
  message: Message,
) => MessageId | undefined | Promise<MessageId | undefined>
type BranchTreeEditRequestAction = (
  message: Message,
  text: string,
) => MessageId | undefined | Promise<MessageId | undefined>
type BranchTreeMessageIndexedAction = (message: Message, index: number) => void | Promise<void>
type BranchTreeMessageAttachmentAction = (
  message: Message,
  mutation: MessageAttachmentRefMutation,
) => void | Promise<void>

export interface BranchTreeViewProps {
  chatId: ChatId
  headers: readonly MessageHeaderRow[]
  latestHeaderById?: BranchTreeHeaderLookup
  presentationHeaderById?: BranchTreeHeaderLookup
  changedHeaderKeys?: readonly string[] | null
  changedHeaders?: readonly (MessageHeaderRow | undefined)[] | null
  projection: MessageTreeProjection<StructuralMessageHeader>
  cursor: CursorMap
  expanded: boolean
  previewFontFamily?: string
  selectedNodeId?: MessageId | null
  repository?: BranchTreeRepository
  presentationSnapshots?: ReadonlyMap<MessageId, MessagePresentationSnapshot>
  onActivateNode: BranchTreeAction
  onSelectNode?: (messageId: MessageId | null) => void
  onInsertAtSharedTrunk?: (parentId: MessageId | null) => void | Promise<void>
  onInsertAtChildLeg?: (childId: MessageId) => void | Promise<void>
  onInsertAfterLeaf?: BranchTreeAction
  onEditMessage?: BranchTreeEditAction
  onEditAndSendMessage?: BranchTreeEditRequestAction
  onDeleteNode?: BranchTreeAction
  onRegenerateMessage?: BranchTreeRequestAction
  onContinueMessage?: BranchTreeRequestAction
  onForkMessage?: BranchTreeMessageAction
  onToggleMessageContextVisibility?: BranchTreeMessageAction
  onMutateMessageAttachmentRef?: BranchTreeMessageAttachmentAction
  onToggleReasoningDetailHidden?: BranchTreeMessageIndexedAction
  onToggleProviderOutputItemHidden?: BranchTreeMessageIndexedAction
  onAbort?: (streamId: string) => void
  followActiveStreamOnMount?: boolean
  navigationRevision?: string
  hasConnection?: boolean
  className?: string
}

interface Viewport {
  left: number
  top: number
  width: number
  height: number
}

interface PreviewCacheEntry {
  text: string
}

interface ActivePreview {
  key: string
  messageId: MessageId
  text?: string
  failed?: boolean
}

type InspectedMessageSnapshot =
  | {
      id: MessageId
      bodyVersion: number
      status: 'loading' | 'missing' | 'failed'
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

interface PendingRequestLeafFollow {
  token: number
  initialStreamIds: ReadonlySet<string>
}

interface EntryStreamFollow {
  chatId: ChatId
  openedAt: number
  streamIds: ReadonlySet<string>
  messageIds: ReadonlySet<MessageId>
  acceptHydratedStream: boolean
  state: 'pending' | 'done' | 'cancelled'
}

function pendingRequestMatchesToken(
  pending: PendingRequestLeafFollow | null,
  token: number,
): boolean {
  return pending?.token === token
}

function cancelEntryStreamFollow(follow: EntryStreamFollow | null): void {
  if (follow?.state === 'pending') follow.state = 'cancelled'
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

function sameRevisionMap(
  left: ReadonlyMap<MessageId, number>,
  right: ReadonlyMap<MessageId, number>,
): boolean {
  if (left.size !== right.size) return false
  for (const [id, version] of left) {
    if (right.get(id) !== version) return false
  }
  return true
}

function roleLabel(role: MessageRole): string {
  return role.charAt(0).toLocaleUpperCase() + role.slice(1)
}

function headerHasPendingGeneration(header: MessageHeaderRow): boolean {
  return header.generation?.status === 'streaming' && header.generation.finishedAt === undefined
}

function sameHeaderStructure(left: MessageHeaderRow, right: MessageHeaderRow): boolean {
  return (
    left.id === right.id &&
    left.chatId === right.chatId &&
    left.parentId === right.parentId &&
    left.siblingIndex === right.siblingIndex &&
    left.deleted === right.deleted
  )
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isRepositoryLifecycleError(error: unknown): boolean {
  const candidate = error as { name?: unknown; inner?: { name?: unknown } } | null
  return (
    candidate?.name === 'AbortError' ||
    candidate?.name === 'DatabaseClosedError' ||
    candidate?.inner?.name === 'AbortError' ||
    candidate?.inner?.name === 'DatabaseClosedError'
  )
}

function storePreview(cache: Map<string, PreviewCacheEntry>, key: string, text: string): string {
  const retainedText =
    text.length > PREVIEW_TEXT_MAX_CHARS ? `${text.slice(0, PREVIEW_TEXT_MAX_CHARS - 1)}…` : text
  cache.delete(key)
  cache.set(key, { text: retainedText })
  let retainedChars = 0
  for (const entry of cache.values()) retainedChars += entry.text.length
  while (cache.size > PREVIEW_CACHE_LIMIT || retainedChars > PREVIEW_CACHE_CHAR_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    retainedChars -= cache.get(oldest)?.text.length ?? 0
    cache.delete(oldest)
  }
  return retainedText
}

function runAction(action: (() => void | Promise<void>) | undefined): void {
  if (!action) return
  void Promise.resolve(action())
}

function exactPresentationForHeader(
  presentations: ReadonlyMap<MessageId, MessagePresentationSnapshot> | undefined,
  header: Pick<MessageHeaderRow, 'bodyVersion' | 'chatId' | 'id'> | undefined,
): MessagePresentationSnapshot | undefined {
  if (!header) return undefined
  const presentation = presentations?.get(header.id)
  return presentation?.bodyVersion === header.bodyVersion &&
    presentation.message.id === header.id &&
    presentation.message.chatId === header.chatId &&
    !presentation.message.deleted
    ? presentation
    : undefined
}

const BranchTreeViewComponent = memo(function BranchTreeView({
  chatId,
  headers,
  latestHeaderById,
  presentationHeaderById,
  changedHeaderKeys,
  changedHeaders,
  projection,
  cursor,
  expanded,
  previewFontFamily = treePreviewFontFamily(),
  selectedNodeId,
  repository = getWorkspaceRepository(),
  presentationSnapshots,
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
  onToggleProviderOutputItemHidden,
  onAbort,
  followActiveStreamOnMount = false,
  navigationRevision = '0',
  hasConnection = false,
  className,
}: BranchTreeViewProps) {
  if (import.meta.env.MODE === 'test') branchTreeComputationProbe?.('render')
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const centerNodeRef = useRef<(messageId: MessageId) => void>(() => undefined)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const previewCacheRef = useRef<Map<string, PreviewCacheEntry>>(new Map())
  const pendingPreviewsRef = useRef<Map<string, Promise<string>>>(new Map())
  const expandedPreviewQueueRef = useRef<Map<string, MessageHeaderRow>>(new Map())
  const expandedPreviewInFlightKeysRef = useRef<Set<string>>(new Set())
  const compactPreviewInFlightRef = useRef<CompactPreviewRequest | null>(null)
  const compactPreviewQueuedRef = useRef<QueuedCompactPreview | null>(null)
  const pumpCompactPreviewQueueRef = useRef<() => void>(() => undefined)
  const previewRevisionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activePreviewKeyRef = useRef<string | null>(null)
  const previewScopeEpochRef = useRef(0)
  const workspaceRevisionRef = useRef(0)
  const viewportFrameRef = useRef<number | null>(null)
  const inspectorResizeFrameRef = useRef<number | null>(null)
  const pendingInspectorClientXRef = useRef<number | null>(null)
  const resizingInspectorRef = useRef(false)
  const initialCenterKeyRef = useRef('')
  const lastExternalSelectionRef = useRef<MessageId | null>(null)
  const previewScopeRef = useRef({ chatId, repository })
  const presentationSnapshotsRef = useRef(presentationSnapshots)
  presentationSnapshotsRef.current = presentationSnapshots
  const selectionScopeChatIdRef = useRef(chatId)
  const panGestureRef = useRef<PanGesture | null>(null)
  const suppressCanvasClickRef = useRef(false)
  const searchRevisionRef = useRef<SearchRevisionState>({
    versions: new Map(),
    value: 0,
    active: false,
    headersSource: null,
    latestHeaderSource: undefined,
    frozenIds: new Set(),
  })
  const currentMatchIdRef = useRef<MessageId | null>(null)
  const inspectedMessageIdRef = useRef<MessageId | null>(null)
  const retainedInspectedMessageRef = useRef<{
    workspaceRevision: number
    repository: BranchTreeRepository
    chatId: ChatId
    id: MessageId
    bodyVersion: number
    message: Message
  } | null>(null)
  const requestLeafFollowTokenRef = useRef(0)
  const pendingRequestLeafFollowRef = useRef<PendingRequestLeafFollow | null>(null)
  const entryStreamFollowRef = useRef<EntryStreamFollow | null>(null)
  const lastSearchQueryRef = useRef('')
  const [viewport, setViewport] = useState<Viewport>(EMPTY_VIEWPORT)
  const [workspaceWidth, setWorkspaceWidth] = useState(EMPTY_VIEWPORT.width)
  const [inspectorRatio, setInspectorRatio] = useState(DEFAULT_INSPECTOR_RATIO)
  const [resizingInspector, setResizingInspector] = useState(false)
  const [panningCanvas, setPanningCanvas] = useState(false)
  const [workspaceRevision, setWorkspaceRevision] = useState(0)
  const [, setPreviewRevision] = useState(0)
  const [activePreview, setActivePreview] = useState<ActivePreview | null>(null)
  const [localSelectedNodeId, setLocalSelectedNodeId] = useState<MessageId | null>(null)
  const [hoveredConnectorKey, setHoveredConnectorKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const chatStreams = useActiveStreamsForChat(chatId)
  const activeStreamTargetIds = useMemo(() => {
    const ids = new Set<MessageId>()
    for (const stream of chatStreams) if (stream.messageId) ids.add(stream.messageId)
    return ids
  }, [chatStreams])
  const retainedHeaderById = useMemo(
    () => new Map(headers.map((header) => [header.id, header])),
    [headers],
  )
  const persistedStreamTargetsRef = useRef<{
    headersSource: readonly MessageHeaderRow[] | null
    latestHeaderSource: BranchTreeHeaderLookup | undefined
    ids: ReadonlySet<MessageId>
  }>({ headersSource: null, latestHeaderSource: undefined, ids: new Set() })
  const persistedStreamTargetIds = useMemo(() => {
    const previous = persistedStreamTargetsRef.current
    if (
      previous.headersSource !== headers ||
      (changedHeaderKeys === null && previous.latestHeaderSource !== latestHeaderById)
    ) {
      const ids = new Set<MessageId>()
      for (const retained of headers) {
        const exact = latestHeaderById?.get(retained.id) ?? retained
        if (headerHasPendingGeneration(exact)) ids.add(retained.id)
      }
      persistedStreamTargetsRef.current = {
        headersSource: headers,
        latestHeaderSource: latestHeaderById,
        ids,
      }
      return ids
    }
    if (
      !changedHeaderKeys ||
      !changedHeaders ||
      changedHeaderKeys.length !== changedHeaders.length
    ) {
      persistedStreamTargetsRef.current = {
        headersSource: headers,
        latestHeaderSource: latestHeaderById,
        ids: previous.ids,
      }
      return previous.ids
    }
    let next: Set<MessageId> | null = null
    for (let index = 0; index < changedHeaderKeys.length; index += 1) {
      const id = changedHeaderKeys[index] as MessageId
      if (!retainedHeaderById.has(id)) continue
      const changed = latestHeaderById?.get(id) ?? changedHeaders[index]
      const pending = changed ? headerHasPendingGeneration(changed) : false
      if (pending === previous.ids.has(id)) continue
      next ??= new Set(previous.ids)
      if (pending) next.add(id)
      else next.delete(id)
    }
    persistedStreamTargetsRef.current = {
      headersSource: headers,
      latestHeaderSource: latestHeaderById,
      ids: next ?? previous.ids,
    }
    return persistedStreamTargetsRef.current.ids
  }, [changedHeaderKeys, changedHeaders, headers, latestHeaderById, retainedHeaderById])
  const busyMessageIds = useMemo(() => {
    if (persistedStreamTargetIds.size === 0) return activeStreamTargetIds
    const ids = new Set(activeStreamTargetIds)
    for (const id of persistedStreamTargetIds) ids.add(id)
    return ids
  }, [activeStreamTargetIds, persistedStreamTargetIds])
  const deferredQuery = useDeferredValue(query)
  const normalizedQuery = deferredQuery.trim()
  const [matches, setMatches] = useState<MessageId[]>([])
  const [matchIndex, setMatchIndex] = useState(-1)
  const currentMatchId = matchIndex < 0 ? null : (matches[matchIndex] ?? null)
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  currentMatchIdRef.current = currentMatchId

  const resetPreviewScope = useCallback(() => {
    previewScopeEpochRef.current += 1
    previewCacheRef.current = new Map()
    pendingPreviewsRef.current = new Map()
    expandedPreviewQueueRef.current.clear()
    expandedPreviewInFlightKeysRef.current = new Set()
    compactPreviewQueuedRef.current = null
    compactPreviewInFlightRef.current?.controller.abort()
    activePreviewKeyRef.current = null
    if (previewRevisionTimerRef.current !== null) {
      clearTimeout(previewRevisionTimerRef.current)
      previewRevisionTimerRef.current = null
    }
    setActivePreview(null)
  }, [])

  useEffect(
    () =>
      onEvent((event) => {
        if (event.kind !== 'workspace-replaced') return
        resetPreviewScope()
        workspaceRevisionRef.current += 1
        setWorkspaceRevision(workspaceRevisionRef.current)
      }),
    [resetPreviewScope],
  )

  const searchRevision = useMemo(() => {
    const previous = searchRevisionRef.current
    if (normalizedQuery.length === 0) {
      previous.active = false
      return previous.value
    }

    const exactHeader = (messageId: MessageId) =>
      latestHeaderById?.get(messageId) ?? retainedHeaderById.get(messageId)
    const requiresFullRebuild =
      !previous.active ||
      previous.headersSource !== headers ||
      (changedHeaderKeys === null && previous.latestHeaderSource !== latestHeaderById)
    let versions = previous.versions
    let changed = false

    if (requiresFullRebuild) {
      const next = new Map<MessageId, number>()
      for (const retained of headers) {
        const exact = exactHeader(retained.id) ?? retained
        next.set(
          retained.id,
          busyMessageIds.has(retained.id)
            ? (previous.versions.get(retained.id) ?? exact.bodyVersion)
            : exact.bodyVersion,
        )
      }
      changed = !sameRevisionMap(previous.versions, next)
      versions = next
    } else {
      const update: { next: Map<MessageId, number> | null } = { next: null }
      const setVersion = (messageId: MessageId, bodyVersion: number) => {
        if ((update.next ?? versions).get(messageId) === bodyVersion) return
        update.next ??= new Map(versions)
        update.next.set(messageId, bodyVersion)
        changed = true
      }
      if (
        changedHeaderKeys &&
        changedHeaders &&
        changedHeaderKeys.length === changedHeaders.length
      ) {
        for (let index = 0; index < changedHeaderKeys.length; index += 1) {
          const messageId = changedHeaderKeys[index] as MessageId
          if (busyMessageIds.has(messageId) || !retainedHeaderById.has(messageId)) continue
          const exact = exactHeader(messageId) ?? changedHeaders[index]
          if (exact) setVersion(messageId, exact.bodyVersion)
        }
      }
      for (const messageId of previous.frozenIds) {
        if (busyMessageIds.has(messageId) || !retainedHeaderById.has(messageId)) continue
        const exact = exactHeader(messageId)
        if (exact) setVersion(messageId, exact.bodyVersion)
      }
      versions = update.next ?? versions
    }

    const value = previous.value + (changed ? 1 : 0)
    searchRevisionRef.current = {
      versions,
      value,
      active: true,
      headersSource: headers,
      latestHeaderSource: latestHeaderById,
      frozenIds: new Set(busyMessageIds),
    }
    return value
  }, [
    busyMessageIds,
    changedHeaderKeys,
    changedHeaders,
    headers,
    latestHeaderById,
    normalizedQuery,
    retainedHeaderById,
  ])

  const layoutOptions = expanded ? EXPANDED_LAYOUT : COMPACT_LAYOUT
  const layout = useMemo(() => {
    if (import.meta.env.MODE === 'test') branchTreeComputationProbe?.('layout')
    return layoutBranchTree(projection.nodes, layoutOptions)
  }, [layoutOptions, projection])
  const headerById = useMemo(
    () => ({
      get(messageId: MessageId): MessageHeaderRow | undefined {
        const presentationHeader = presentationHeaderById?.get(messageId)
        if (presentationHeader) return presentationHeader
        const retained = retainedHeaderById.get(messageId)
        const latest = latestHeaderById?.get(messageId)
        if (!retained) return latest
        if (!latest) return retained
        if (!sameHeaderStructure(retained, latest) && latest.nodeVersion >= retained.nodeVersion) {
          return latest
        }
        const retainedStrictlyDominates =
          (retained.nodeVersion > latest.nodeVersion &&
            retained.bodyVersion >= latest.bodyVersion) ||
          (retained.bodyVersion > latest.bodyVersion && retained.nodeVersion >= latest.nodeVersion)
        return retainedStrictlyDominates ? retained : latest
      },
    }),
    [latestHeaderById, presentationHeaderById, retainedHeaderById],
  )
  const headerByIdRef = useRef(headerById)
  headerByIdRef.current = headerById
  const connectorIndex = useMemo(() => {
    if (import.meta.env.MODE === 'test') branchTreeComputationProbe?.('connector-index')
    return connectorIndexFor(layout)
  }, [layout])
  const activeLeafId = useMemo(
    () => resolveActiveLeafIdProjected(projection, cursor),
    [cursor, projection],
  )
  const activePathIds = useMemo(() => {
    const path = new Set<MessageId>()
    let currentId = activeLeafId
    while (currentId !== null) {
      if (path.has(currentId)) break
      path.add(currentId)
      currentId = layout.byId.get(currentId)?.parentId ?? null
    }
    return path
  }, [activeLeafId, layout])
  const knownHeaderMessageIds = useMemo(() => new Set(projection.byId.keys()), [projection])
  const selectedPathStreams = useMemo(
    () =>
      chatStreams.filter((stream) =>
        isStreamRelevantToSelectedPath(
          stream,
          activePathIds,
          knownHeaderMessageIds,
          navigationRevision,
        ),
      ),
    [activePathIds, chatStreams, knownHeaderMessageIds, navigationRevision],
  )
  const selectedPersistedStreamTargetIds = useMemo(() => {
    const ids = new Set<MessageId>()
    for (const id of persistedStreamTargetIds) if (activePathIds.has(id)) ids.add(id)
    return ids
  }, [activePathIds, persistedStreamTargetIds])
  if (entryStreamFollowRef.current?.chatId !== chatId) {
    entryStreamFollowRef.current = {
      chatId,
      openedAt: Date.now(),
      streamIds: new Set(selectedPathStreams.map((stream) => stream.streamId)),
      messageIds: new Set(selectedPersistedStreamTargetIds),
      acceptHydratedStream:
        followActiveStreamOnMount ||
        selectedPathStreams.length > 0 ||
        selectedPersistedStreamTargetIds.size > 0,
      state: selectedNodeId === undefined ? 'pending' : 'cancelled',
    }
  }
  const entryStreamFollow = entryStreamFollowRef.current
  if (
    entryStreamFollow.state === 'pending' &&
    (followActiveStreamOnMount ||
      selectedPathStreams.length > 0 ||
      selectedPersistedStreamTargetIds.size > 0)
  ) {
    entryStreamFollow.acceptHydratedStream = true
  }
  const generationBusy = selectedPathStreams.length > 0 || selectedPersistedStreamTargetIds.size > 0
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
  const toolbarStream = useMemo(() => {
    let inspected: ActiveStream | undefined
    let activeLeaf: ActiveStream | undefined
    let selectedPath: ActiveStream | undefined
    for (const stream of chatStreams) {
      const isNewer = (current: ActiveStream | undefined) =>
        !current ||
        stream.startedAt > current.startedAt ||
        (stream.startedAt === current.startedAt && stream.streamId > current.streamId)
      if (stream.messageId === inspectedMessageId && isNewer(inspected)) inspected = stream
      if (stream.messageId === activeLeafId && isNewer(activeLeaf)) activeLeaf = stream
    }
    for (const stream of selectedPathStreams) {
      if (
        !selectedPath ||
        stream.startedAt > selectedPath.startedAt ||
        (stream.startedAt === selectedPath.startedAt && stream.streamId > selectedPath.streamId)
      ) {
        selectedPath = stream
      }
    }
    return inspected ?? activeLeaf ?? selectedPath
  }, [activeLeafId, chatStreams, inspectedMessageId, selectedPathStreams])
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
  }, [readViewport, scheduleViewportRead])

  const centerNode = useCallback(
    (messageId: MessageId) => {
      const element = scrollRef.current
      const node = layout.byId.get(messageId)
      if (!element || !node) return
      const width = element.clientWidth || EMPTY_VIEWPORT.width
      const height = element.clientHeight || EMPTY_VIEWPORT.height
      element.scrollLeft = Math.max(0, graphOffsetX + node.x + node.width / 2 - width / 2)
      element.scrollTop = Math.max(0, node.y + node.height / 2 - height / 2)
      readViewport()
    },
    [graphOffsetX, layout, readViewport],
  )
  centerNodeRef.current = centerNode

  useLayoutEffect(() => {
    const focusNodeId = inspectedMessageId ?? currentMatchId ?? activeLeafId
    const centerKey = `${chatId}:${expanded ? 'expanded' : 'compact'}`
    if (initialCenterKeyRef.current === centerKey || !focusNodeId) return
    if (!layout.byId.has(focusNodeId)) return
    initialCenterKeyRef.current = centerKey
    centerNode(focusNodeId)
  }, [activeLeafId, centerNode, chatId, currentMatchId, expanded, inspectedMessageId, layout])

  useEffect(() => {
    if (selectedNodeId === null) {
      cancelEntryStreamFollow(entryStreamFollowRef.current)
      lastExternalSelectionRef.current = null
      return
    }
    if (selectedNodeId === undefined || lastExternalSelectionRef.current === selectedNodeId) return
    cancelEntryStreamFollow(entryStreamFollowRef.current)
    lastExternalSelectionRef.current = selectedNodeId
    centerNode(selectedNodeId)
  }, [centerNode, selectedNodeId])

  useEffect(() => {
    if (selectionScopeChatIdRef.current === chatId) return
    selectionScopeChatIdRef.current = chatId
    requestLeafFollowTokenRef.current += 1
    pendingRequestLeafFollowRef.current = null
    setLocalSelectedNodeId(null)
  }, [chatId])

  useLayoutEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) return
    workspace.style.setProperty('--branch-tree-inspector-width', `${inspectorWidth}px`)
    workspace.style.setProperty('--branch-tree-inspector-min-width', `${inspectorBounds.min}px`)
    workspace.style.setProperty('--branch-tree-canvas-min-width', `${inspectorBounds.canvasMin}px`)
  }, [inspectorBounds.canvasMin, inspectorBounds.min, inspectorWidth])

  const directInspectedPresentation = exactPresentationForHeader(
    presentationSnapshots,
    liveSelectedHeader,
  )

  // The local one-body retention below bridges versioned reads without keeping
  // an idle hydrated-body query cache or remounting the inspector.
  const queriedInspectedMessage = useRepositoryPresentationQuery<InspectedMessageSnapshot | null>(
    JSON.stringify([
      'branch-tree-inspector',
      workspaceRevision,
      chatId,
      inspectedMessageId,
      selectedBodyVersion,
    ]),
    async (signal) => {
      if (!inspectedMessageId) return null
      if (directInspectedPresentation) {
        return {
          id: inspectedMessageId,
          bodyVersion: directInspectedPresentation.bodyVersion,
          status: 'ready',
          message: directInspectedPresentation.message,
        }
      }
      try {
        const snapshot = await repository.getMessagePresentationSnapshot(inspectedMessageId, {
          signal,
        })
        if (!snapshot || snapshot.message.chatId !== chatId || snapshot.message.deleted) {
          return {
            id: inspectedMessageId,
            bodyVersion: selectedBodyVersion as number,
            status: 'missing',
          }
        }
        return {
          id: inspectedMessageId,
          bodyVersion: snapshot.bodyVersion,
          status: 'ready',
          message: snapshot.message,
        }
      } catch (error) {
        if (signal.aborted || isRepositoryLifecycleError(error)) throw error
        return {
          id: inspectedMessageId,
          bodyVersion: selectedBodyVersion as number,
          status: 'failed',
        }
      }
    },
    inspectedMessageId
      ? {
          id: inspectedMessageId,
          bodyVersion: selectedBodyVersion as number,
          status: 'loading',
        }
      : null,
    inspectedMessageId ? primaryKeys('messageBodies', inspectedMessageId) : [],
  )
  const inspectedMessage = directInspectedPresentation
    ? {
        id: directInspectedPresentation.message.id,
        bodyVersion: directInspectedPresentation.bodyVersion,
        status: 'ready' as const,
        message: directInspectedPresentation.message,
      }
    : queriedInspectedMessage

  useEffect(() => {
    if (
      previewScopeRef.current.chatId === chatId &&
      previewScopeRef.current.repository === repository
    ) {
      return
    }
    previewScopeRef.current = { chatId, repository }
    resetPreviewScope()
  }, [chatId, repository, resetPreviewScope])

  const previewKeyFor = useCallback(
    (header: MessageHeaderRow) =>
      `${workspaceRevision}\u0000${previewScopeEpochRef.current}\u0000${chatId}\u0000${header.id}\u0000${header.bodyVersion}`,
    [chatId, workspaceRevision],
  )

  const cachedPreviewFor = useCallback(
    (header: MessageHeaderRow): string | undefined => {
      const key = previewKeyFor(header)
      const cached = previewCacheRef.current.get(key)
      return cached?.text
    },
    [previewKeyFor],
  )

  const loadPreview = useCallback(
    (header: MessageHeaderRow): Promise<string> => {
      const key = previewKeyFor(header)
      const cache = previewCacheRef.current
      const cached = cache.get(key)
      if (cached) {
        cache.delete(key)
        cache.set(key, cached)
        return Promise.resolve(cached.text)
      }
      const pending = pendingPreviewsRef.current.get(key)
      if (pending) return pending
      const pendingPreviews = pendingPreviewsRef.current
      const directPresentation = exactPresentationForHeader(
        presentationSnapshotsRef.current,
        header,
      )
      const request = Promise.resolve(
        directPresentation
          ? previewTextFromContent(directPresentation.message.content, PREVIEW_TEXT_MAX_CHARS)
          : repository.getMessageTextPreview(header.id, { maxChars: PREVIEW_TEXT_MAX_CHARS }),
      )
        .then((text) => text ?? '')
        .then((text) => storePreview(cache, key, text))
        .finally(() => pendingPreviews.delete(key))
      pendingPreviews.set(key, request)
      return request
    },
    [previewKeyFor, repository],
  )

  const pumpCompactPreviewQueue = useCallback(() => {
    if (compactPreviewInFlightRef.current) return
    const queued = compactPreviewQueuedRef.current
    if (!queued || activePreviewKeyRef.current !== queued.key) {
      compactPreviewQueuedRef.current = null
      return
    }
    compactPreviewQueuedRef.current = null
    const controller = new AbortController()
    const request: CompactPreviewRequest = {
      controller,
      header: queued.header,
      key: queued.key,
    }
    compactPreviewInFlightRef.current = request
    const cache = previewCacheRef.current
    const directPresentation = exactPresentationForHeader(
      presentationSnapshotsRef.current,
      request.header,
    )
    const read = directPresentation
      ? Promise.resolve(
          previewTextFromContent(directPresentation.message.content, PREVIEW_TEXT_MAX_CHARS),
        )
      : repository
          .getMessageTextPreview(request.header.id, {
            maxChars: PREVIEW_TEXT_MAX_CHARS,
            signal: controller.signal,
          })
          .then((text) => text ?? '')
    void read
      .then((text) => {
        if (controller.signal.aborted || previewCacheRef.current !== cache) return
        const currentHeader = headerByIdRef.current.get(request.header.id)
        if (!currentHeader || previewKeyFor(currentHeader) !== request.key) return
        const retained = storePreview(cache, request.key, text)
        if (activePreviewKeyRef.current === request.key) {
          setActivePreview({
            key: request.key,
            messageId: request.header.id,
            text: retained,
          })
        }
      })
      .catch(() => {
        if (
          !controller.signal.aborted &&
          previewCacheRef.current === cache &&
          activePreviewKeyRef.current === request.key
        ) {
          const currentHeader = headerByIdRef.current.get(request.header.id)
          if (currentHeader && previewKeyFor(currentHeader) === request.key) {
            setActivePreview({
              key: request.key,
              messageId: request.header.id,
              failed: true,
            })
          }
        }
      })
      .finally(() => {
        if (compactPreviewInFlightRef.current === request) {
          compactPreviewInFlightRef.current = null
        }
        pumpCompactPreviewQueueRef.current()
      })
  }, [previewKeyFor, repository])
  pumpCompactPreviewQueueRef.current = pumpCompactPreviewQueue

  const queueCompactPreview = useCallback(
    (header: MessageHeaderRow, key: string) => {
      const inFlight = compactPreviewInFlightRef.current
      if (inFlight?.key === key && !inFlight.controller.signal.aborted) return
      compactPreviewQueuedRef.current = { header, key }
      if (inFlight) inFlight.controller.abort()
      pumpCompactPreviewQueue()
    },
    [pumpCompactPreviewQueue],
  )

  const cancelCompactPreview = useCallback((key?: string) => {
    if (!key || compactPreviewQueuedRef.current?.key === key) {
      compactPreviewQueuedRef.current = null
    }
    const inFlight = compactPreviewInFlightRef.current
    if (inFlight && (!key || inFlight.key === key)) inFlight.controller.abort()
  }, [])

  const schedulePreviewRevision = useCallback(() => {
    if (previewRevisionTimerRef.current !== null) return
    previewRevisionTimerRef.current = setTimeout(() => {
      previewRevisionTimerRef.current = null
      if (import.meta.env.MODE === 'test') branchTreeComputationProbe?.('preview-publish')
      setPreviewRevision((revision) => revision + 1)
    }, 0)
  }, [])

  const pumpExpandedPreviewQueue = useCallback(() => {
    const queue = expandedPreviewQueueRef.current
    const inFlight = expandedPreviewInFlightKeysRef.current
    while (inFlight.size < EXPANDED_PREVIEW_CONCURRENCY) {
      const next = queue.entries().next().value
      if (!next) return
      const [key, header] = next
      queue.delete(key)
      inFlight.add(key)
      const cache = previewCacheRef.current
      void loadPreview(header)
        .catch(() => {
          if (previewCacheRef.current === cache) {
            storePreview(cache, key, 'Preview unavailable')
          }
        })
        .finally(() => {
          if (import.meta.env.MODE === 'test') branchTreeComputationProbe?.('preview-complete')
          inFlight.delete(key)
          if (expandedPreviewInFlightKeysRef.current !== inFlight) return
          schedulePreviewRevision()
          pumpExpandedPreviewQueue()
        })
    }
  }, [loadPreview, schedulePreviewRevision])

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

  useEffect(() => {
    const queue = expandedPreviewQueueRef.current
    queue.clear()
    if (!expanded) return
    const inFlight = expandedPreviewInFlightKeysRef.current
    for (const node of visibleNodes) {
      const header = headerById.get(node.id)
      if (!header || busyMessageIds.has(node.id) || cachedPreviewFor(header) !== undefined) continue
      const key = previewKeyFor(header)
      if (!inFlight.has(key)) queue.set(key, header)
    }
    pumpExpandedPreviewQueue()
  }, [
    cachedPreviewFor,
    busyMessageIds,
    expanded,
    headerById,
    previewKeyFor,
    pumpExpandedPreviewQueue,
    visibleNodes,
  ])

  useEffect(
    () => () => {
      expandedPreviewQueueRef.current.clear()
      compactPreviewQueuedRef.current = null
      compactPreviewInFlightRef.current?.controller.abort()
      if (previewRevisionTimerRef.current !== null) clearTimeout(previewRevisionTimerRef.current)
      previewRevisionTimerRef.current = null
    },
    [],
  )

  const openPreview = useCallback(
    (header: MessageHeaderRow) => {
      if (expanded) return
      if (busyMessageIds.has(header.id)) {
        cancelCompactPreview()
        const key = `streaming\u0000${chatId}\u0000${header.id}`
        activePreviewKeyRef.current = key
        setActivePreview({ key, messageId: header.id, text: 'Streaming response…' })
        return
      }
      const key = previewKeyFor(header)
      const previousKey = activePreviewKeyRef.current
      if (previousKey !== key) cancelCompactPreview(previousKey ?? undefined)
      activePreviewKeyRef.current = key
      const cached = cachedPreviewFor(header)
      setActivePreview({
        key,
        messageId: header.id,
        ...(cached === undefined ? {} : { text: cached }),
      })
      if (cached !== undefined) return
      queueCompactPreview(header, key)
    },
    [
      busyMessageIds,
      cachedPreviewFor,
      cancelCompactPreview,
      chatId,
      expanded,
      previewKeyFor,
      queueCompactPreview,
    ],
  )

  useEffect(() => {
    if (expanded) {
      if (!activePreview) return
      cancelCompactPreview()
      activePreviewKeyRef.current = null
      setActivePreview(null)
      return
    }
    if (!activePreview) return
    const currentHeader = headerById.get(activePreview.messageId)
    if (!currentHeader) {
      cancelCompactPreview(activePreview.key)
      activePreviewKeyRef.current = null
      setActivePreview(null)
      return
    }
    const currentKey = busyMessageIds.has(currentHeader.id)
      ? `streaming\u0000${chatId}\u0000${currentHeader.id}`
      : previewKeyFor(currentHeader)
    if (currentKey !== activePreview.key) openPreview(currentHeader)
  }, [
    activePreview,
    busyMessageIds,
    cancelCompactPreview,
    chatId,
    expanded,
    headerById,
    openPreview,
    previewKeyFor,
  ])

  const closePreview = useCallback(
    (messageId: MessageId) => {
      if (activePreview?.messageId !== messageId) return
      cancelCompactPreview(activePreview.key)
      activePreviewKeyRef.current = null
      setActivePreview(null)
    },
    [activePreview, cancelCompactPreview],
  )

  const cancelAutomaticFollow = useCallback(() => {
    cancelEntryStreamFollow(entryStreamFollowRef.current)
    requestLeafFollowTokenRef.current += 1
    pendingRequestLeafFollowRef.current = null
  }, [])

  const selectMessage = useCallback(
    (messageId: MessageId) => {
      cancelCompactPreview()
      activePreviewKeyRef.current = null
      setActivePreview(null)
      setLocalSelectedNodeId(messageId)
      lastExternalSelectionRef.current = messageId
      onSelectNode?.(messageId)
    },
    [cancelCompactPreview, onSelectNode],
  )

  const inspectMessage = useCallback(
    (messageId: MessageId) => {
      cancelAutomaticFollow()
      selectMessage(messageId)
    },
    [cancelAutomaticFollow, selectMessage],
  )

  const inspectAndCenterMessage = useCallback(
    (messageId: MessageId) => {
      selectMessage(messageId)
      centerNodeRef.current(messageId)
    },
    [selectMessage],
  )

  const runRequestAndFollowLeaf = useCallback(
    async (action: () => MessageId | undefined | Promise<MessageId | undefined>): Promise<void> => {
      cancelAutomaticFollow()
      const token = requestLeafFollowTokenRef.current + 1
      requestLeafFollowTokenRef.current = token
      pendingRequestLeafFollowRef.current = {
        token,
        initialStreamIds: new Set(useStreamStore.getState().listStreamIds()),
      }
      try {
        const targetId = await action()
        if (pendingRequestMatchesToken(pendingRequestLeafFollowRef.current, token) && targetId) {
          pendingRequestLeafFollowRef.current = null
          inspectAndCenterMessage(targetId)
        }
      } finally {
        if (pendingRequestMatchesToken(pendingRequestLeafFollowRef.current, token)) {
          pendingRequestLeafFollowRef.current = null
        }
      }
    },
    [cancelAutomaticFollow, inspectAndCenterMessage],
  )

  useEffect(() => {
    const pending = pendingRequestLeafFollowRef.current
    if (!pending || !activeLeafId) return
    for (const stream of chatStreams) {
      if (stream.messageId !== activeLeafId || pending.initialStreamIds.has(stream.streamId)) {
        continue
      }
      pendingRequestLeafFollowRef.current = null
      inspectAndCenterMessage(activeLeafId)
      return
    }
  }, [activeLeafId, chatStreams, inspectAndCenterMessage])

  useEffect(() => {
    const follow = entryStreamFollowRef.current
    if (!follow || follow.chatId !== chatId || follow.state !== 'pending' || !activeLeafId) return
    const streams = selectedPathStreams
      .filter(
        (candidate) =>
          (follow.streamIds.has(candidate.streamId) ||
            (follow.acceptHydratedStream && candidate.startedAt <= follow.openedAt)) &&
          candidate.messageId !== undefined &&
          activePathIds.has(candidate.messageId) &&
          layout.byId.has(candidate.messageId),
      )
      .sort((left, right) => right.startedAt - left.startedAt)
    const stream = streams.find((candidate) => candidate.messageId === activeLeafId) ?? streams[0]
    const messageId =
      stream?.messageId ??
      ((follow.messageIds.has(activeLeafId) ||
        (follow.acceptHydratedStream &&
          selectedPersistedStreamTargetIds.has(activeLeafId) &&
          (headerById.get(activeLeafId)?.generation?.startedAt ?? Number.POSITIVE_INFINITY) <=
            follow.openedAt)) &&
      layout.byId.has(activeLeafId)
        ? activeLeafId
        : undefined)
    if (!messageId) return
    follow.state = 'done'
    inspectAndCenterMessage(messageId)
  }, [
    activeLeafId,
    activePathIds,
    chatId,
    headerById,
    inspectAndCenterMessage,
    layout,
    selectedPathStreams,
    selectedPersistedStreamTargetIds,
  ])

  useEffect(() => {
    if (normalizedQuery.length === 0) {
      lastSearchQueryRef.current = ''
      setMatches([])
      setMatchIndex(-1)
      setSearching(false)
      setSearchFailed(false)
      return
    }
    const queryChanged = lastSearchQueryRef.current !== normalizedQuery
    lastSearchQueryRef.current = normalizedQuery
    const previousCurrentId = currentMatchIdRef.current
    const previousInspectedId = inspectedMessageIdRef.current
    const requestRevision = searchRevision
    const requestWorkspaceRevision = workspaceRevision
    const controller = new AbortController()
    setSearching(true)
    setSearchFailed(false)
    if (queryChanged) {
      setMatches([])
      setMatchIndex(-1)
    }
    void repository
      .searchChatMessageText(chatId, normalizedQuery, { signal: controller.signal })
      .then((ids) => {
        if (
          controller.signal.aborted ||
          requestRevision !== searchRevisionRef.current.value ||
          requestWorkspaceRevision !== workspaceRevisionRef.current
        ) {
          return
        }
        const hitIds = new Set(ids)
        const ordered = layout.nodes.filter((node) => hitIds.has(node.id)).map((node) => node.id)
        const retainedIndex = queryChanged ? -1 : ordered.indexOf(previousCurrentId ?? '')
        const nextIndex = ordered.length === 0 ? -1 : Math.max(0, retainedIndex)
        const nextMessageId = nextIndex < 0 ? undefined : ordered[nextIndex]
        setMatches(ordered)
        setMatchIndex(nextIndex)
        setSearching(false)
        if (queryChanged && nextMessageId) {
          inspectAndCenterMessage(nextMessageId)
        } else if (
          nextMessageId &&
          previousCurrentId &&
          previousInspectedId === previousCurrentId &&
          nextMessageId !== previousCurrentId
        ) {
          inspectAndCenterMessage(nextMessageId)
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return
        if (queryChanged) {
          setMatches([])
          setMatchIndex(-1)
        }
        setSearching(false)
        setSearchFailed(true)
      })
    return () => controller.abort()
  }, [
    chatId,
    inspectAndCenterMessage,
    layout,
    normalizedQuery,
    repository,
    searchRevision,
    workspaceRevision,
  ])

  useEffect(() => {
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
  }, [])

  const goToMatch = useCallback(
    (direction: -1 | 1) => {
      if (matches.length === 0) return
      cancelAutomaticFollow()
      const current = matchIndex < 0 ? 0 : matchIndex
      const next = (current + direction + matches.length) % matches.length
      setMatchIndex(next)
      const messageId = matches[next]
      if (messageId) inspectAndCenterMessage(messageId)
    },
    [cancelAutomaticFollow, inspectAndCenterMessage, matchIndex, matches],
  )

  const clearSelection = useCallback(() => {
    cancelAutomaticFollow()
    setLocalSelectedNodeId(null)
    onSelectNode?.(null)
  }, [cancelAutomaticFollow, onSelectNode])

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
      cancelAutomaticFollow()
      runAction(() => onActivateNode(messageId))
    },
    [cancelAutomaticFollow, onActivateNode],
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
  const readyInspectedMessage =
    inspectedMessage?.status === 'ready' &&
    inspectedMessage.bodyVersion === selectedBodyVersion &&
    inspectedMessage.message.id === liveSelectedHeader?.id
      ? inspectedMessage
      : undefined
  if (readyInspectedMessage) {
    retainedInspectedMessageRef.current = {
      workspaceRevision,
      repository,
      chatId,
      id: readyInspectedMessage.id,
      bodyVersion: readyInspectedMessage.bodyVersion,
      message: readyInspectedMessage.message,
    }
  }
  const retainedInspectedMessage = retainedInspectedMessageRef.current
  const retainedInspectorMatchesSelection =
    retainedInspectedMessage?.workspaceRevision === workspaceRevision &&
    retainedInspectedMessage.repository === repository &&
    retainedInspectedMessage.chatId === chatId &&
    retainedInspectedMessage.id === inspectedMessageId &&
    retainedInspectedMessage.bodyVersion === selectedBodyVersion
  const inspectorBody = readyInspectedMessage
    ? readyInspectedMessage.message
    : retainedInspectorMatchesSelection
      ? retainedInspectedMessage.message
      : undefined
  const inspectorBodyVersion = readyInspectedMessage
    ? readyInspectedMessage.bodyVersion
    : retainedInspectorMatchesSelection
      ? retainedInspectedMessage.bodyVersion
      : undefined
  const inspectorMessage = useMemo<Message | undefined>(() => {
    if (!inspectorBody || liveSelectedHeader?.id !== inspectorBody.id) return undefined
    return rebaseHydratedMessageHeader(inspectorBody, liveSelectedHeader)
  }, [inspectorBody, liveSelectedHeader])
  const handleInspectorActivate = useCallback(() => {
    if (inspectedMessageId) activateNode(inspectedMessageId)
  }, [activateNode, inspectedMessageId])
  const handleInspectorEditAndSend = useCallback(
    (message: Message, text: string) =>
      runRequestAndFollowLeaf(() => onEditAndSendMessage?.(message, text)),
    [onEditAndSendMessage, runRequestAndFollowLeaf],
  )
  const handleInspectorDelete = useCallback(() => {
    if (inspectedMessageId) runAction(() => onDeleteNode?.(inspectedMessageId))
  }, [inspectedMessageId, onDeleteNode])
  const handleInspectorRegenerate = useCallback(() => {
    if (inspectorMessage) {
      return runRequestAndFollowLeaf(() => onRegenerateMessage?.(inspectorMessage))
    }
  }, [inspectorMessage, onRegenerateMessage, runRequestAndFollowLeaf])
  const handleInspectorContinue = useCallback(() => {
    if (inspectorMessage) {
      return runRequestAndFollowLeaf(() => onContinueMessage?.(inspectorMessage))
    }
  }, [inspectorMessage, onContinueMessage, runRequestAndFollowLeaf])
  const handleInspectorFork = useCallback(() => {
    if (inspectorMessage) runAction(() => onForkMessage?.(inspectorMessage))
  }, [inspectorMessage, onForkMessage])
  const handleInspectorContextVisibility = useCallback(() => {
    if (inspectorMessage) {
      runAction(() => onToggleMessageContextVisibility?.(inspectorMessage))
    }
  }, [inspectorMessage, onToggleMessageContextVisibility])
  const handleInspectorAttachmentMutation = useCallback(
    (mutation: MessageAttachmentRefMutation) => {
      if (inspectorMessage) {
        runAction(() => onMutateMessageAttachmentRef?.(inspectorMessage, mutation))
      }
    },
    [inspectorMessage, onMutateMessageAttachmentRef],
  )
  const handleInspectorReasoningVisibility = useCallback(
    (index: number) => {
      if (inspectorMessage) {
        runAction(() => onToggleReasoningDetailHidden?.(inspectorMessage, index))
      }
    },
    [inspectorMessage, onToggleReasoningDetailHidden],
  )
  const handleInspectorProviderItemVisibility = useCallback(
    (index: number) => {
      if (inspectorMessage) {
        runAction(() => onToggleProviderOutputItemHidden?.(inspectorMessage, index))
      }
    },
    [inspectorMessage, onToggleProviderOutputItemHidden],
  )

  return (
    <section
      className={className}
      data-ui="branch-tree-view"
      data-expanded={expanded}
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
              cancelAutomaticFollow()
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
                  cancelAutomaticFollow()
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
                cancelAutomaticFollow()
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
            disabled={matches.length === 0}
            onClick={() => goToMatch(-1)}
          >
            <ChevronIcon size={15} rotate={180} />
          </Button>
          <Button
            type="button"
            aria-label="Next matching message"
            data-ui="branch-tree-search-nav"
            disabled={matches.length === 0}
            onClick={() => goToMatch(1)}
          >
            <ChevronIcon size={15} />
          </Button>
        </search>
        {toolbarStream && onAbort ? (
          <Button
            type="button"
            data-ui="branch-tree-stop"
            aria-label="Stop generating"
            title="Stop generating"
            onClick={() => onAbort(toolbarStream.streamId)}
          >
            <StopIcon size={14} />
            <span>Stop</span>
          </Button>
        ) : null}
      </div>

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
                        return (
                          <SvgAction
                            key={`${connector.key}:hit-group`}
                            label="Insert after this parent before all of its children"
                            disabled={streamBusy}
                            data-connector-hit="shared-trunk"
                            data-parent-id={connector.parentId}
                            data-stream-busy={streamBusy || undefined}
                            onPointerEnter={() => {
                              if (!streamBusy) setHoveredConnectorKey(connector.key)
                            }}
                            onPointerLeave={() => setHoveredConnectorKey(null)}
                            onFocus={() => {
                              if (!streamBusy) setHoveredConnectorKey(connector.key)
                            }}
                            onBlur={() => setHoveredConnectorKey(null)}
                            onActivate={() => {
                              runAction(() => onInsertAtSharedTrunk(connector.parentId))
                            }}
                          >
                            {streamBusy ? (
                              <title>
                                Wait for the connected generation to finish before inserting
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
                        return (
                          <SvgAction
                            key={`${connector.key}:hit-group`}
                            label="Insert before this child only"
                            disabled={streamBusy}
                            data-connector-hit="child-leg"
                            data-parent-id={connector.parentId}
                            data-child-id={connector.childId}
                            data-stream-busy={streamBusy || undefined}
                            onPointerEnter={() => {
                              if (!streamBusy) setHoveredConnectorKey(connector.key)
                            }}
                            onPointerLeave={() => setHoveredConnectorKey(null)}
                            onFocus={() => {
                              if (!streamBusy) setHoveredConnectorKey(connector.key)
                            }}
                            onBlur={() => setHoveredConnectorKey(null)}
                            onActivate={() => {
                              runAction(() => onInsertAtChildLeg(connector.childId))
                            }}
                          >
                            {streamBusy ? (
                              <title>Wait for this generation to finish before inserting</title>
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
                        const markerKey = `leaf:${node.id}`
                        const x = node.x + node.width / 2
                        const startY = node.y + node.height
                        const markerY = startY + 28
                        const path = `M ${x} ${startY} V ${markerY}`
                        return (
                          <SvgAction
                            key={markerKey}
                            label="Add message after this leaf"
                            disabled={streamBusy}
                            data-connector-hit="leaf-append"
                            data-parent-id={node.id}
                            data-stream-busy={streamBusy || undefined}
                            onPointerEnter={() => {
                              if (!streamBusy) setHoveredConnectorKey(markerKey)
                            }}
                            onPointerLeave={() => setHoveredConnectorKey(null)}
                            onFocus={() => {
                              if (!streamBusy) setHoveredConnectorKey(markerKey)
                            }}
                            onBlur={() => setHoveredConnectorKey(null)}
                            onActivate={() => {
                              runAction(() => onInsertAfterLeaf(node.id))
                            }}
                          >
                            {streamBusy ? (
                              <title>
                                Wait for this generation to finish before adding a child
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
                    const cachedPreview = streaming ? undefined : cachedPreviewFor(header)
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
                          href={chatHref(chatId, node.id)}
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
                            activateNode(node.id)
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
                                cacheKey={
                                  streaming || cachedPreview === undefined
                                    ? undefined
                                    : previewKeyFor(header)
                                }
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
                        text={activePreview.text}
                        failed={activePreview.failed}
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
                    bodyVersion={inspectorBodyVersion as number}
                    bodyReady={readyInspectedMessage !== undefined}
                    searchQuery={normalizedQuery}
                    searchMatched={matchSet.has(inspectedMessageId)}
                    hasConnection={hasConnection}
                    streamOnActivePath={activePathIds.has(inspectedMessageId)}
                    onClose={clearSelection}
                    onActivate={handleInspectorActivate}
                    {...(onEditMessage ? { onEdit: onEditMessage } : {})}
                    {...(onEditAndSendMessage ? { onEditAndSend: handleInspectorEditAndSend } : {})}
                    {...(onDeleteNode ? { onDelete: handleInspectorDelete } : {})}
                    {...(onRegenerateMessage ? { onRegenerate: handleInspectorRegenerate } : {})}
                    {...(onContinueMessage ? { onContinue: handleInspectorContinue } : {})}
                    {...(onForkMessage ? { onForkChat: handleInspectorFork } : {})}
                    {...(onToggleMessageContextVisibility
                      ? { onToggleContextVisibility: handleInspectorContextVisibility }
                      : {})}
                    {...(onMutateMessageAttachmentRef
                      ? { onMutateAttachmentRef: handleInspectorAttachmentMutation }
                      : {})}
                    {...(onToggleReasoningDetailHidden
                      ? { onToggleReasoningDetailHidden: handleInspectorReasoningVisibility }
                      : {})}
                    {...(onToggleProviderOutputItemHidden
                      ? {
                          onToggleProviderOutputItemHidden: handleInspectorProviderItemVisibility,
                        }
                      : {})}
                  />
                </Suspense>
              ) : (
                <div role="status" data-ui="branch-tree-inspector-status" data-state="error">
                  {inspectedMessage.status === 'missing'
                    ? 'This message is no longer available.'
                    : inspectedMessage.status === 'failed'
                      ? 'Could not load this message.'
                      : 'Loading message…'}
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </section>
  )
})

export const BranchTreeView = BranchTreeViewComponent as typeof BranchTreeViewComponent & {
  __setComputationProbeForTests: (probe: BranchTreeComputationProbe | undefined) => void
}
if (import.meta.env.MODE === 'test') {
  BranchTreeView.__setComputationProbeForTests = setBranchTreeComputationProbeForTests
}

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
