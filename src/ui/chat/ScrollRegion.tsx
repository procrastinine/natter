import {
  createContext,
  forwardRef,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { hasScrollDebugSink, logScrollDebug } from '../../lib/debug-scroll'
import { scheduleReactPublication } from '../../lib/react-publication'
import type {
  ConversationViewportPreparation,
  ConversationViewportTransition,
} from '../../store/presentation-contracts'

export type ScrollState = 'follow' | 'pinned'

interface ScrollRegionProps {
  children: ReactNode
  // Hidden retained views keep their DOM and state, but they cannot consume
  // open/follow claims until this viewport becomes visible again.
  viewportActive?: boolean
  pinThresholdPx?: number
  // Notified whenever the follow/pinned state changes. Lets a sibling render
  // a "Jump to latest" affordance anchored to the main-pane viewport bottom
  // (rather than scrolling with the content inside the region).
  onStateChange?: (state: ScrollState) => void
  // While `streamActive` is true AND follow has not been cancelled by the
  // user, keep the exact streamed message's end in view as tokens arrive.
  // When false, streams never move the viewport — user stays wherever they
  // are. Chat open always lands at the branch leaf regardless of this setting.
  autoScrollOnStream?: boolean
  // Parent signals that a stream is currently in progress for the content
  // being rendered here. Stream-time follow only activates during this
  // window; outside it, content changes never move the scroll position
  // through the streaming path.
  streamActive?: boolean
  workspaceEpoch?: number
  // Identity that resets the open-latch. When this value changes (e.g. the
  // user switches chats via sidebar), the next content-load triggers
  // another one-shot open-scroll.
  resetKey?: string | number | null
  // Identity of the selected branch tail. Unlike stream identity, this changes
  // only when the tab selects a different path, so stream completion cannot
  // accidentally cancel exact-target ownership.
  selectionKey?: string | number | null
  viewportRevision?: number
  // Identity of the selected path's active stream. A stream can become active
  // before its row is mounted; this lets target-follow attach when it appears.
  streamFollowKey?: string | number | null
  streamFollowTargetMessageId?: string | null
  // A non-null key grants one stream-start follow claim. The caller must only
  // provide it for a path operation started by this tab. The claim persists
  // independently of stream lifetime until its exact target is rendered.
  revealClaimKey?: string | number | null
  revealClaimTargetMessageId?: string | null
  revealSurfaceAvailable?: boolean
  onRevealClaimConsumed?: () => void
}

export interface ScrollRegionHandle {
  scrollToBottom: (opts?: { smooth?: boolean }) => void
  getState: () => ScrollState
  prepareLayoutChange: (
    transition: ConversationViewportTransition,
  ) => ConversationViewportPreparation
}

export interface ScrollRegionCommands {
  captureLayoutAnchor(input?: {
    element?: HTMLElement
    edge?: 'top' | 'bottom'
    replaceExisting?: boolean
  }): boolean
  getUserScrollRevision(): number
  revealNearest(element: HTMLElement): boolean
  getLayoutAnchorMessageId(): string | null
  getLayoutAnchorSnapshot(): {
    readonly element: HTMLElement
    readonly messageId: string | null
    readonly edge: 'top' | 'bottom'
    readonly coordinate: number
  } | null
  reconcileLayoutAnchor(): boolean
  applyVirtualizerOffset(offset: number, adjustment?: number): void
  claimTextEditingViewport(): () => void
  preserveTextEditingViewport(change: () => void): void
  scrollTextEditingViewportBy(deltaY: number, deltaMode?: number): void
}

const ScrollRegionCommandsContext = createContext<ScrollRegionCommands | null>(null)
const ScrollRegionStateContext = createContext<ScrollState | undefined>(undefined)

export function useScrollRegionCommands(): ScrollRegionCommands | null {
  return useContext(ScrollRegionCommandsContext)
}

export function useScrollRegionState(): ScrollState | undefined {
  return useContext(ScrollRegionStateContext)
}

const DEFAULT_THRESHOLD_PX = 48
const PROGRAMMATIC_SCROLL_TOLERANCE_PX = 4
const BOTTOM_REACQUIRE_TOLERANCE_PX = PROGRAMMATIC_SCROLL_TOLERANCE_PX

interface SmoothScrollIntent {
  target: number
  last: number
  direction: -1 | 1
}

interface InstantScrollIntent {
  readonly top: number
  readonly scrollHeight: number
  readonly preserveThroughScrollEnd: boolean
}

interface ObservedScrollGeometry {
  readonly scrollHeight: number
  readonly clientHeight: number
}

interface MessageFollowTarget {
  messageId: string
  element: HTMLElement | null
}

interface TextContinuityIdentity {
  readonly markdownOrdinal: number
  readonly edge: 'start' | 'end'
  readonly characterOffset: number
}

type ViewportDisplacement =
  | {
      readonly kind: 'element'
      readonly element: HTMLElement
      readonly messageId: string | null
      readonly elementOrdinal: number | null
      readonly textIdentity: TextContinuityIdentity | null
      readonly edge: 'top' | 'bottom'
      readonly coordinate: number
      readonly documentCoordinate: number
    }
  | {
      readonly kind: 'bottom'
      readonly distance: number
    }

interface ViewportContinuityLeaseBase {
  readonly revision: number
  readonly workspaceEpoch: number
  readonly chatKey: string | number | null
  readonly selectionKey: string | number | null
  readonly viewportRevision: number
  readonly source: 'content' | 'prepend' | 'open' | 'reveal' | 'stream' | 'manual'
}

type ViewportContinuityLease =
  | (ViewportContinuityLeaseBase & {
      readonly mode: 'follow'
      readonly claim: SemanticFollowClaim
      readonly displacement: ViewportDisplacement | null
    })
  | (ViewportContinuityLeaseBase & {
      readonly mode: 'preserve'
      readonly displacement: ViewportDisplacement
    })

type SemanticFollowClaim =
  | {
      readonly source: 'open' | 'reveal' | 'stream' | 'manual'
      readonly kind: 'bottom'
    }
  | {
      readonly source: 'open' | 'reveal' | 'stream'
      readonly kind: 'message'
      readonly target: MessageFollowTarget
    }

interface RevealClaimLifecycle {
  readonly key: string | number
  status: 'active' | 'cancelled' | 'consumed'
}

interface RetainedViewportDisposition {
  readonly state: ScrollState
  readonly lease: ViewportContinuityLease | null
  readonly distanceFromBottom: number | null
  readonly workspaceEpoch: number
  readonly chatKey: string | number | null
  readonly selectionKey: string | number | null
}

const CONTINUITY_BLOCK_SELECTOR =
  'p, li, pre, blockquote, table, figcaption, [data-ui="reasoning-summary"], [data-ui="message-body"]'

function continuityElementOrdinal(message: HTMLElement, element: HTMLElement): number | null {
  if (message === element || !element.matches(CONTINUITY_BLOCK_SELECTOR)) return null
  return Array.from(message.querySelectorAll<HTMLElement>(CONTINUITY_BLOCK_SELECTOR)).indexOf(
    element,
  )
}

function rangeLineTop(range: Range): number | null {
  const node = range.startContainer
  if (!(node instanceof Text)) return range.getClientRects().item(0)?.top ?? null
  const probe = range.cloneRange()
  if (range.startOffset < node.length) {
    probe.setEnd(node, range.startOffset + 1)
  } else if (range.startOffset > 0) {
    probe.setStart(node, range.startOffset - 1)
  }
  return probe.getClientRects().item(0)?.top ?? null
}

function captureTextContinuity(
  container: HTMLDivElement,
  message: HTMLElement,
  element: HTMLElement,
): {
  readonly element: HTMLElement
  readonly identity: TextContinuityIdentity
  readonly coordinate: number
} | null {
  const markdown = element.closest<HTMLElement>('[data-ui="markdown"]')
  if (!markdown || !message.contains(markdown)) return null
  const markdowns = Array.from(message.querySelectorAll<HTMLElement>('[data-ui="markdown"]'))
  const markdownOrdinal = markdowns.indexOf(markdown)
  if (markdownOrdinal < 0) return null
  const containerRect = container.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  const markdownRect = markdown.getBoundingClientRect()
  const targetY = Math.min(
    Math.max(containerRect.top + containerRect.height * 0.46, elementRect.top + 1),
    elementRect.bottom - 1,
  )
  const left = Math.max(containerRect.left, markdownRect.left, elementRect.left) + 4
  const right = Math.min(containerRect.right, markdownRect.right, elementRect.right) - 4
  const xs = [containerRect.left + containerRect.width / 2, left + 12, right - 12].filter(
    (x) => Number.isFinite(x) && x >= left && x <= right,
  )
  for (const x of xs) {
    const caret = container.ownerDocument.caretRangeFromPoint(x, targetY)
    if (!caret || !markdown.contains(caret.startContainer)) continue
    const coordinate = rangeLineTop(caret)
    if (coordinate === null) continue
    const prefix = container.ownerDocument.createRange()
    prefix.selectNodeContents(markdown)
    prefix.setEnd(caret.startContainer, caret.startOffset)
    const prefixLength = prefix.toString().length
    const progressiveStatic = markdown.dataset.overflow === 'progressive-static'
    const caretElement =
      (caret.startContainer instanceof Element
        ? caret.startContainer
        : caret.startContainer.parentElement
      )?.closest<HTMLElement>(CONTINUITY_BLOCK_SELECTOR) ?? element
    return {
      element: message.contains(caretElement) ? caretElement : element,
      identity: {
        markdownOrdinal,
        edge: progressiveStatic ? 'end' : 'start',
        characterOffset: progressiveStatic
          ? Math.max(0, markdown.textContent.length - prefixLength)
          : prefixLength,
      },
      coordinate,
    }
  }
  return null
}

function resolveTextContinuity(
  message: HTMLElement,
  identity: TextContinuityIdentity,
): { readonly element: HTMLElement; readonly coordinate: number } | null {
  const markdown = Array.from(message.querySelectorAll<HTMLElement>('[data-ui="markdown"]')).at(
    identity.markdownOrdinal,
  )
  if (!markdown) return null
  const walker = message.ownerDocument.createTreeWalker(markdown, NodeFilter.SHOW_TEXT)
  let remaining =
    identity.edge === 'end'
      ? Math.max(0, markdown.textContent.length - identity.characterOffset)
      : identity.characterOffset
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (remaining > text.length) {
      remaining -= text.length
      continue
    }
    const range = message.ownerDocument.createRange()
    range.setStart(text, remaining)
    range.collapse(true)
    const coordinate = rangeLineTop(range)
    if (coordinate === null) return null
    const element = text.parentElement?.closest<HTMLElement>(CONTINUITY_BLOCK_SELECTOR) ?? markdown
    return { element, coordinate }
  }
  return null
}

function semanticFollowClaimForTarget(
  source: Exclude<SemanticFollowClaim['source'], 'manual'>,
  messageId: string | null | undefined,
  selectedTailKey: string | number | null,
): SemanticFollowClaim {
  return messageId && !Object.is(messageId, selectedTailKey)
    ? { source, kind: 'message', target: { messageId, element: null } }
    : { source, kind: 'bottom' }
}

const LAYOUT_ANCHOR_TOLERANCE_PX = 0.5

function matchesInstantScrollIntent(intent: InstantScrollIntent | null, top: number): boolean {
  return intent !== null && Math.abs(intent.top - top) <= PROGRAMMATIC_SCROLL_TOLERANCE_PX
}

function advanceSmoothScrollIntent(
  intent: SmoothScrollIntent,
  top: number,
): { programmatic: boolean; next: SmoothScrollIntent | null } {
  const withinTarget =
    intent.direction > 0
      ? top >= intent.last - PROGRAMMATIC_SCROLL_TOLERANCE_PX &&
        top <= intent.target + PROGRAMMATIC_SCROLL_TOLERANCE_PX
      : top <= intent.last + PROGRAMMATIC_SCROLL_TOLERANCE_PX &&
        top >= intent.target - PROGRAMMATIC_SCROLL_TOLERANCE_PX
  if (!withinTarget) return { programmatic: false, next: null }
  if (Math.abs(top - intent.target) <= PROGRAMMATIC_SCROLL_TOLERANCE_PX) {
    return { programmatic: true, next: null }
  }
  return { programmatic: true, next: { ...intent, last: top } }
}

type PositionSource = 'layout' | 'observer' | 'resize' | 'scroll'
type ScrollDebugEvent =
  | 'state'
  | 'scroll.to-bottom'
  | 'follow.schedule'
  | 'follow.scheduled-scroll'
  | 'position'
  | 'open.wait'
  | 'open.bottom'
  | 'reset-key'
  | 'observer'
  | 'resize'
  | 'mutation'
  | 'wheel'
  | 'touchmove'
  | 'native-scroll'
  | 'native-scroll-adopted'
  | 'stream-start'
  | 'user-follow-cancel'

function scrollStateFromPosition(
  container: HTMLDivElement,
  threshold: number,
  current: ScrollState,
): ScrollState {
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
  if (current === 'pinned') {
    return distanceFromBottom <= BOTTOM_REACQUIRE_TOLERANCE_PX ? 'follow' : 'pinned'
  }
  return distanceFromBottom <= threshold ? 'follow' : 'pinned'
}

function bottomScrollTop(container: HTMLDivElement): number {
  return Math.max(0, container.scrollHeight - container.clientHeight)
}

function messageFollowScrollTop(
  container: HTMLDivElement,
  element: HTMLElement,
  threshold: number,
): number {
  const containerRect = container.getBoundingClientRect()
  const elementRect = element.getBoundingClientRect()
  const targetTop = container.scrollTop + elementRect.bottom - containerRect.bottom
  const bottomTop = bottomScrollTop(container)
  return Math.max(
    0,
    Math.min(bottomTop, bottomTop - targetTop <= threshold ? bottomTop : targetTop),
  )
}

function visibleContentAnchor(
  container: HTMLDivElement,
  content: HTMLDivElement,
): HTMLElement | undefined {
  const containerRect = container.getBoundingClientRect()
  const x = containerRect.left + containerRect.width / 2
  const yCandidates = [
    containerRect.top + 1,
    containerRect.top + containerRect.height / 2,
    containerRect.bottom - 1,
  ]
  const hitTestDocument = container.ownerDocument as unknown as {
    elementFromPoint?: (x: number, y: number) => Element | null
  }
  for (const y of yCandidates) {
    const hit = hitTestDocument.elementFromPoint?.call(container.ownerDocument, x, y)
    const message = hit?.closest<HTMLElement>('[data-ui="message"][data-message-id]')
    if (!message || !content.contains(message)) continue
    const element = hit instanceof HTMLElement ? hit : hit?.parentElement
    const textBlock = element?.closest<HTMLElement>(
      'p, li, pre, blockquote, table, figcaption, [data-ui="reasoning-summary"], [data-ui="message-body"]',
    )
    return textBlock && message.contains(textBlock) ? textBlock : message
  }
  for (const message of content.querySelectorAll<HTMLElement>(
    '[data-ui="message"][data-message-id]',
  )) {
    const rect = message.getBoundingClientRect()
    if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) return message
  }
  return undefined
}

// Open, reveal, stream, publication, and manual intents all replace one
// revisioned continuity lease. User input cancels semantic follow but rebases
// an already-prepared structural transition; the ResizeObserver reconciles
// delayed geometry through that same authority.
export const ScrollRegion = forwardRef<ScrollRegionHandle, ScrollRegionProps>(function ScrollRegion(
  {
    children,
    viewportActive = true,
    pinThresholdPx,
    onStateChange,
    autoScrollOnStream = true,
    streamActive = false,
    workspaceEpoch = 0,
    resetKey = null,
    selectionKey = null,
    viewportRevision = 0,
    streamFollowKey = null,
    streamFollowTargetMessageId = null,
    revealClaimKey = null,
    revealClaimTargetMessageId = null,
    revealSurfaceAvailable = true,
    onRevealClaimConsumed,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const continuityLeaseRef = useRef<ViewportContinuityLease | null>({
    mode: 'follow',
    revision: 0,
    workspaceEpoch,
    chatKey: resetKey,
    selectionKey,
    viewportRevision,
    source: 'open',
    claim: { source: 'open', kind: 'bottom' },
    displacement: null,
  })
  const continuityRevisionRef = useRef(0)
  const lastPreparedTransitionRevisionRef = useRef(0)
  const pendingPreparedTransitionRef = useRef<ConversationViewportTransition | null>(null)
  const committedViewportRevisionRef = useRef(viewportRevision)
  // Start in `follow`: an empty or non-overflowing transcript is already
  // at its leaf. Overflow measurement below flips to `pinned` when needed.
  const [state, setState] = useState<ScrollState>('follow')
  const stateRef = useRef<ScrollState>(state)
  const pendingStateRef = useRef<ScrollState | null>(null)
  const statePublicationScheduledRef = useRef(false)
  const mountedRef = useRef(true)
  const didOpenRef = useRef(false)
  const finiteAcquisitionRef = useRef<{ leaseRevision: number } | null>(null)
  const resetKeyRef = useRef(resetKey)
  const workspaceEpochRef = useRef(workspaceEpoch)
  const selectionKeyRef = useRef(selectionKey)
  const documentVisibleRef = useRef(
    typeof document === 'undefined' || document.visibilityState !== 'hidden',
  )
  const lastNativeScrollTopRef = useRef<number | null>(null)
  const lastObservedScrollGeometryRef = useRef<ObservedScrollGeometry | null>(null)
  const userScrollIntentRef = useRef(false)
  const userScrollRevisionRef = useRef(0)
  const textEditingViewportClaimsRef = useRef(0)
  const textEditingViewportTopRef = useRef<number | null>(null)
  const instantScrollIntentRef = useRef<InstantScrollIntent | null>(null)
  const layoutCorrectionPendingRef = useRef(false)
  const smoothScrollIntentRef = useRef<SmoothScrollIntent | null>(null)
  const thresholdRef = useRef(pinThresholdPx ?? DEFAULT_THRESHOLD_PX)
  const autoScrollOnStreamRef = useRef(autoScrollOnStream)
  const previousAutoScrollOnStreamRef = useRef(autoScrollOnStream)
  const streamActiveRef = useRef(streamActive)
  const streamFollowKeyRef = useRef(streamFollowKey)
  const streamFollowTargetMessageIdRef = useRef(streamFollowTargetMessageId)
  const previousStreamActiveRef = useRef(false)
  const revealClaimLifecycleRef = useRef<RevealClaimLifecycle | null>(null)
  const retainedViewportLifecycleRef = useRef<'active' | 'inactive'>(
    viewportActive ? 'active' : 'inactive',
  )
  const retainedViewportReactivationPendingRef = useRef(false)
  const retainedViewportDispositionRef = useRef<RetainedViewportDisposition | null>(null)
  const captureRetainedViewportDispositionRef = useRef<() => void>(() => undefined)
  thresholdRef.current = pinThresholdPx ?? DEFAULT_THRESHOLD_PX
  autoScrollOnStreamRef.current = autoScrollOnStream
  streamActiveRef.current = streamActive

  const debugScroll = useCallback(
    (event: ScrollDebugEvent, details: Record<string, unknown> = {}) => {
      if (!hasScrollDebugSink()) return
      const container = containerRef.current
      const lease = continuityLeaseRef.current
      const claim = lease?.mode === 'follow' ? lease.claim : null
      const payload = {
        resetKey,
        state: stateRef.current,
        semanticClaim: claim ? `${claim.source}:${claim.kind}` : null,
        didOpen: didOpenRef.current,
        streamActive: streamActiveRef.current,
        autoScrollOnStream: autoScrollOnStreamRef.current,
        instantScrollIntent: instantScrollIntentRef.current,
        layoutCorrectionPending: layoutCorrectionPendingRef.current,
        followTargetMessageId: claim?.kind === 'message' ? claim.target.messageId : null,
        smoothScrollIntent: smoothScrollIntentRef.current,
        metrics: container
          ? {
              scrollTop: container.scrollTop,
              clientHeight: container.clientHeight,
              scrollHeight: container.scrollHeight,
              distanceFromBottom:
                container.scrollHeight - container.scrollTop - container.clientHeight,
            }
          : null,
        ...details,
      }
      logScrollDebug(event, payload)
    },
    [resetKey],
  )

  useEffect(() => {
    onStateChange?.(state)
  }, [state, onStateChange])

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      pendingStateRef.current = null
    }
  }, [])

  const setScrollStateNow = useCallback(
    (next: ScrollState, reason = 'unknown', publishSynchronously = false) => {
      const previous = stateRef.current
      stateRef.current = next
      if (hasScrollDebugSink() && previous !== next) {
        debugScroll('state', { from: previous, to: next, reason })
      }
      if (publishSynchronously) {
        pendingStateRef.current = null
        setState((current) => (current === next ? current : next))
        return
      }
      pendingStateRef.current = next
      if (statePublicationScheduledRef.current) return
      statePublicationScheduledRef.current = true
      scheduleReactPublication(() => {
        statePublicationScheduledRef.current = false
        const pending = pendingStateRef.current
        pendingStateRef.current = null
        if (!mountedRef.current || pending === null) return
        setState((current) => (current === pending ? current : pending))
      })
    },
    [debugScroll],
  )

  const clearInstantScrollIntents = useCallback(() => {
    instantScrollIntentRef.current = null
  }, [])

  const clearProgrammaticScrollIntents = useCallback(() => {
    clearInstantScrollIntents()
    smoothScrollIntentRef.current = null
  }, [clearInstantScrollIntents])

  const recordInstantScrollIntent = useCallback((top: number, reason: string) => {
    const container = containerRef.current
    instantScrollIntentRef.current = {
      top,
      scrollHeight: container?.scrollHeight ?? 0,
      preserveThroughScrollEnd: reason === 'layout-anchor' || reason === 'virtualizer-layout',
    }
  }, [])

  const releaseSemanticClaim = useCallback(() => {
    const lease = continuityLeaseRef.current
    if (lease?.mode !== 'follow') return
    continuityLeaseRef.current = lease.displacement
      ? { ...lease, mode: 'preserve', displacement: lease.displacement }
      : null
  }, [])

  const cancelContinuityLease = useCallback(() => {
    continuityLeaseRef.current = null
    finiteAcquisitionRef.current = null
    pendingPreparedTransitionRef.current = null
    layoutCorrectionPendingRef.current = false
  }, [])

  const cancelViewportOwnership = useCallback(() => {
    cancelContinuityLease()
  }, [cancelContinuityLease])

  const acquireFollowLease = useCallback((claim: SemanticFollowClaim) => {
    finiteAcquisitionRef.current = null
    continuityLeaseRef.current = {
      mode: 'follow',
      revision: ++continuityRevisionRef.current,
      workspaceEpoch: workspaceEpochRef.current,
      chatKey: resetKeyRef.current,
      selectionKey: selectionKeyRef.current,
      viewportRevision: committedViewportRevisionRef.current,
      source: claim.source,
      claim,
      displacement: null,
    }
  }, [])

  const installContinuityLease = useCallback(
    (
      source: ViewportContinuityLease['source'],
      displacement: ViewportDisplacement,
      prepared?: ConversationViewportTransition,
    ) => {
      finiteAcquisitionRef.current = null
      continuityLeaseRef.current = {
        mode: 'preserve',
        revision: ++continuityRevisionRef.current,
        workspaceEpoch: workspaceEpochRef.current,
        chatKey: resetKeyRef.current,
        selectionKey: selectionKeyRef.current,
        viewportRevision: prepared?.revision ?? committedViewportRevisionRef.current,
        source,
        displacement,
      }
    },
    [],
  )

  const writeScrollTopNow = useCallback(
    (top: number, reason: string): number => {
      const container = containerRef.current
      if (!container) return 0
      smoothScrollIntentRef.current = null
      const boundedTop = Math.max(0, Math.min(bottomScrollTop(container), top))
      const before = container.scrollTop
      const pendingNativeLayoutClamp =
        reason === 'layout-anchor' &&
        continuityLeaseRef.current?.mode === 'preserve' &&
        !userScrollIntentRef.current &&
        lastNativeScrollTopRef.current !== null &&
        Math.abs(lastNativeScrollTopRef.current - before) > 0.5
      container.scrollTop = boundedTop
      const actual = container.scrollTop
      if (textEditingViewportClaimsRef.current > 0) {
        textEditingViewportTopRef.current = actual
      }
      lastNativeScrollTopRef.current = actual
      lastObservedScrollGeometryRef.current = {
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
      }
      if (
        (Math.abs(actual - before) > 0.5 || pendingNativeLayoutClamp) &&
        reason !== 'text-edit-restore'
      ) {
        recordInstantScrollIntent(actual, reason)
      }
      if (hasScrollDebugSink()) {
        debugScroll('position', { source: reason, targetTop: boundedTop })
      }
      return actual
    },
    [debugScroll, recordInstantScrollIntent],
  )

  const capturePinnedLayoutAnchor = useCallback(
    (
      input?: {
        element?: HTMLElement
        edge?: 'top' | 'bottom'
        replaceExisting?: boolean
      },
      prepared?: ConversationViewportTransition,
    ): boolean => {
      const container = containerRef.current
      const content = contentRef.current
      if (!container || !content || continuityLeaseRef.current?.mode === 'follow') {
        return false
      }
      let element = input?.element
      let edge = input?.edge ?? 'top'
      if (!element || !content.contains(element)) {
        element = visibleContentAnchor(container, content)
        edge = 'top'
      }
      if (!element || !content.contains(element)) return false
      const existing = continuityLeaseRef.current?.displacement
      if (
        input?.replaceExisting === false &&
        existing?.kind === 'element' &&
        !element.contains(existing.element) &&
        !existing.element.contains(element)
      ) {
        return false
      }
      if (input?.replaceExisting === false && existing?.kind === 'bottom') return false
      const message = element.closest<HTMLElement>('[data-ui="message"][data-message-id]')
      const textContinuity = message ? captureTextContinuity(container, message, element) : null
      const anchorElement = textContinuity?.element ?? element
      const rect = anchorElement.getBoundingClientRect()
      const coordinate = textContinuity?.coordinate ?? (edge === 'bottom' ? rect.bottom : rect.top)
      installContinuityLease(
        prepared?.kind ?? 'manual',
        {
          kind: 'element',
          element: anchorElement,
          messageId: message?.getAttribute('data-message-id') ?? null,
          elementOrdinal: message ? continuityElementOrdinal(message, anchorElement) : null,
          textIdentity: textContinuity?.identity ?? null,
          edge,
          coordinate,
          documentCoordinate: coordinate + container.scrollTop,
        },
        prepared,
      )
      return true
    },
    [installContinuityLease],
  )

  const rebasePreparedTransitionToUser = useCallback(
    (transition: ConversationViewportTransition): void => {
      finiteAcquisitionRef.current = null
      releaseSemanticClaim()
      if (capturePinnedLayoutAnchor(undefined, transition)) return
      const container = containerRef.current
      if (!container) return
      installContinuityLease(
        transition.kind,
        {
          kind: 'bottom',
          distance: container.scrollHeight - container.scrollTop - container.clientHeight,
        },
        transition,
      )
    },
    [capturePinnedLayoutAnchor, installContinuityLease, releaseSemanticClaim],
  )

  const adoptUnclaimedNativeViewportMovement = useCallback((): boolean => {
    const container = containerRef.current
    const previousTop = lastNativeScrollTopRef.current
    const previousGeometry = lastObservedScrollGeometryRef.current
    if (!container || previousTop === null || previousGeometry === null) return false
    if (Math.abs(container.scrollTop - previousTop) <= 0.5) return false
    if (
      Math.abs(container.scrollHeight - previousGeometry.scrollHeight) > 0.5 ||
      Math.abs(container.clientHeight - previousGeometry.clientHeight) > 0.5
    ) {
      return false
    }
    if (scrollStateFromPosition(container, thresholdRef.current, stateRef.current) !== 'pinned') {
      return false
    }
    if (matchesInstantScrollIntent(instantScrollIntentRef.current, container.scrollTop))
      return false
    if (smoothScrollIntentRef.current) {
      const smooth = advanceSmoothScrollIntent(smoothScrollIntentRef.current, container.scrollTop)
      smoothScrollIntentRef.current = smooth.next
      if (smooth.programmatic) return false
    }
    didOpenRef.current = true
    clearProgrammaticScrollIntents()
    cancelViewportOwnership()
    lastNativeScrollTopRef.current = container.scrollTop
    lastObservedScrollGeometryRef.current = {
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    }
    setScrollStateNow('pinned', 'native-displacement', true)
    capturePinnedLayoutAnchor()
    if (hasScrollDebugSink()) {
      debugScroll('native-scroll-adopted', { previousTop })
    }
    return true
  }, [
    cancelViewportOwnership,
    capturePinnedLayoutAnchor,
    clearProgrammaticScrollIntents,
    debugScroll,
    setScrollStateNow,
  ])

  const correctContinuityLease = useCallback((): boolean => {
    const container = containerRef.current
    const lease = continuityLeaseRef.current
    if (!container || !lease) return false
    if (adoptUnclaimedNativeViewportMovement()) return false
    if (
      !Object.is(lease.selectionKey, selectionKeyRef.current) ||
      lease.workspaceEpoch !== workspaceEpochRef.current ||
      !Object.is(lease.chatKey, resetKeyRef.current)
    ) {
      continuityLeaseRef.current = null
      return false
    }
    if (lease.viewportRevision > committedViewportRevisionRef.current) return false
    const anchor = lease.displacement
    if (!anchor) return false
    if (anchor.kind === 'bottom') {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight
      const delta = distance - anchor.distance
      if (Math.abs(delta) <= LAYOUT_ANCHOR_TOLERANCE_PX) return false
      writeScrollTopNow(container.scrollTop + delta, 'layout-anchor')
      return true
    }
    let element = anchor.element
    let current: number
    if (anchor.textIdentity) {
      if (!anchor.messageId) {
        continuityLeaseRef.current = null
        return false
      }
      const message = contentRef.current?.querySelector<HTMLElement>(
        `[data-ui="message"][data-message-id="${CSS.escape(anchor.messageId)}"]`,
      )
      if (!message) return false
      const resolved = resolveTextContinuity(message, anchor.textIdentity)
      if (!resolved) return false
      element = resolved.element
      current = resolved.coordinate
    } else if (!element.isConnected || !contentRef.current?.contains(element)) {
      if (!anchor.messageId) {
        continuityLeaseRef.current = null
        return false
      }
      const message = contentRef.current?.querySelector<HTMLElement>(
        `[data-ui="message"][data-message-id="${CSS.escape(anchor.messageId)}"]`,
      )
      if (!message) return false
      element =
        anchor.elementOrdinal === null
          ? message
          : (Array.from(message.querySelectorAll<HTMLElement>(CONTINUITY_BLOCK_SELECTOR)).at(
              anchor.elementOrdinal,
            ) ?? element)
      if (!element.isConnected || !contentRef.current?.contains(element)) return false
      const rect = element.getBoundingClientRect()
      current = anchor.edge === 'bottom' ? rect.bottom : rect.top
    } else {
      const rect = element.getBoundingClientRect()
      current = anchor.edge === 'bottom' ? rect.bottom : rect.top
    }
    const documentCoordinate = current + container.scrollTop
    const delta = current - anchor.coordinate
    if (Math.abs(delta) <= LAYOUT_ANCHOR_TOLERANCE_PX) {
      if (Math.abs(documentCoordinate - anchor.documentCoordinate) > LAYOUT_ANCHOR_TOLERANCE_PX) {
        continuityLeaseRef.current = {
          ...lease,
          displacement: { ...anchor, element, documentCoordinate },
        }
      }
      return false
    }
    writeScrollTopNow(container.scrollTop + delta, 'layout-anchor')
    if (continuityLeaseRef.current === lease) {
      continuityLeaseRef.current = {
        ...lease,
        displacement: { ...anchor, element, documentCoordinate },
      }
    }
    return true
  }, [adoptUnclaimedNativeViewportMovement, writeScrollTopNow])

  const resolveFollowTargetElement = useCallback(
    (target: MessageFollowTarget): HTMLElement | null => {
      if (
        target.element?.isConnected &&
        target.element.getAttribute('data-message-id') === target.messageId
      ) {
        return target.element
      }
      const content = contentRef.current
      if (!content) return null
      for (const element of content.querySelectorAll<HTMLElement>(
        '[data-ui="message"][data-message-id]',
      )) {
        if (element.getAttribute('data-message-id') !== target.messageId) continue
        target.element = element
        return element
      }
      target.element = null
      return null
    },
    [],
  )

  const scrollToFollowTargetNow = useCallback(
    (reason: string): boolean => {
      const container = containerRef.current
      const lease = continuityLeaseRef.current
      const claim = lease?.mode === 'follow' ? lease.claim : null
      if (!container || claim?.kind !== 'message') return false
      const target = claim.target
      const element = resolveFollowTargetElement(target)
      if (!element) return false
      writeScrollTopNow(messageFollowScrollTop(container, element, thresholdRef.current), reason)
      return true
    },
    [resolveFollowTargetElement, writeScrollTopNow],
  )

  const captureFollowDisplacement = useCallback(
    (prepared?: ConversationViewportTransition) => {
      const container = containerRef.current
      const lease = continuityLeaseRef.current
      if (!container || lease?.mode !== 'follow') return
      const claim = lease.claim
      if ((claim.source === 'open' && !didOpenRef.current) || claim.source === 'reveal') {
        finiteAcquisitionRef.current = null
        continuityLeaseRef.current = {
          ...lease,
          viewportRevision: prepared?.revision ?? lease.viewportRevision,
          displacement: null,
        }
        return
      }
      if (claim.kind === 'bottom') {
        continuityLeaseRef.current = {
          ...lease,
          viewportRevision: prepared?.revision ?? lease.viewportRevision,
          displacement: {
            kind: 'bottom',
            distance: container.scrollHeight - container.scrollTop - container.clientHeight,
          },
        }
        return
      }
      const element = resolveFollowTargetElement(claim.target)
      if (!element) {
        continuityLeaseRef.current = {
          ...lease,
          viewportRevision: prepared?.revision ?? lease.viewportRevision,
          displacement: {
            kind: 'bottom',
            distance: container.scrollHeight - container.scrollTop - container.clientHeight,
          },
        }
        return
      }
      continuityLeaseRef.current = {
        ...lease,
        viewportRevision: prepared?.revision ?? lease.viewportRevision,
        displacement: {
          kind: 'element',
          element,
          messageId: claim.target.messageId,
          elementOrdinal: null,
          textIdentity: null,
          edge: 'bottom',
          coordinate: element.getBoundingClientRect().bottom,
          documentCoordinate: element.getBoundingClientRect().bottom + container.scrollTop,
        },
      }
    },
    [resolveFollowTargetElement],
  )

  const prepareLayoutChange = useCallback(
    (transition: ConversationViewportTransition): ConversationViewportPreparation => {
      if (!viewportActive) return { kind: 'unavailable' }
      if (transition.revision <= lastPreparedTransitionRevisionRef.current) {
        return { kind: 'prepared' }
      }
      if (
        transition.workspaceEpoch !== workspaceEpochRef.current ||
        !Object.is(transition.chatId, resetKeyRef.current)
      ) {
        return { kind: 'unavailable' }
      }
      if (!Object.is(transition.fromSelectionKey, selectionKeyRef.current)) {
        return { kind: 'unavailable' }
      }
      const container = containerRef.current
      if (!container) return { kind: 'unavailable' }
      const lease = continuityLeaseRef.current
      if (transition.kind === 'reveal') {
        acquireFollowLease(
          semanticFollowClaimForTarget(
            'reveal',
            transition.revealTargetMessageId,
            transition.toSelectionKey,
          ),
        )
        const acquired = continuityLeaseRef.current
        if (acquired?.mode !== 'follow') return { kind: 'unavailable' }
        continuityLeaseRef.current = {
          ...acquired,
          viewportRevision: transition.revision,
          source: 'reveal',
        }
      } else if (lease?.mode === 'follow') {
        captureFollowDisplacement(transition)
      } else if (
        lease?.mode === 'preserve' &&
        lease.workspaceEpoch === transition.workspaceEpoch &&
        Object.is(lease.chatKey, transition.chatId) &&
        Object.is(lease.selectionKey, transition.fromSelectionKey)
      ) {
        continuityLeaseRef.current = {
          ...lease,
          revision: ++continuityRevisionRef.current,
          viewportRevision: transition.revision,
          source: transition.kind,
        }
      } else if (stateRef.current === 'follow') {
        installContinuityLease(
          transition.kind,
          {
            kind: 'bottom',
            distance: container.scrollHeight - container.scrollTop - container.clientHeight,
          },
          transition,
        )
      } else if (!capturePinnedLayoutAnchor(undefined, transition)) {
        return { kind: 'unavailable' }
      }
      lastPreparedTransitionRevisionRef.current = transition.revision
      pendingPreparedTransitionRef.current = transition
      layoutCorrectionPendingRef.current = true
      return { kind: 'prepared' }
    },
    [
      acquireFollowLease,
      captureFollowDisplacement,
      capturePinnedLayoutAnchor,
      installContinuityLease,
      viewportActive,
    ],
  )

  const scrollToBottomNow = useCallback(
    (opts?: { smooth?: boolean; reason?: string }) => {
      const container = containerRef.current
      if (!container) return
      const smooth = opts?.smooth ?? false
      const top = bottomScrollTop(container)
      if (hasScrollDebugSink()) {
        debugScroll('scroll.to-bottom', {
          reason: opts?.reason ?? 'unknown',
          smooth,
          targetTop: top,
        })
      }
      if (smooth && Math.abs(container.scrollTop - top) > PROGRAMMATIC_SCROLL_TOLERANCE_PX) {
        clearInstantScrollIntents()
        smoothScrollIntentRef.current = {
          target: top,
          last: container.scrollTop,
          direction: top > container.scrollTop ? 1 : -1,
        }
        container.scrollTo({
          top,
          behavior: 'smooth',
        })
      } else if (!smooth) {
        writeScrollTopNow(top, opts?.reason ?? 'scroll.to-bottom')
      } else {
        smoothScrollIntentRef.current = null
      }
      setScrollStateNow('follow', opts?.reason ?? 'scroll.to-bottom')
    },
    [clearInstantScrollIntents, debugScroll, setScrollStateNow, writeScrollTopNow],
  )

  const scrollToFollowPositionNow = useCallback(
    (reason: string) => {
      if (!scrollToFollowTargetNow(reason)) {
        scrollToBottomNow({ smooth: false, reason })
      }
      captureFollowDisplacement()
    },
    [captureFollowDisplacement, scrollToBottomNow, scrollToFollowTargetNow],
  )

  const followClaimIsAcquired = useCallback(
    (claim: SemanticFollowClaim): boolean => {
      const container = containerRef.current
      if (!container) return false
      const targetTop =
        claim.kind === 'bottom'
          ? bottomScrollTop(container)
          : (() => {
              const element = resolveFollowTargetElement(claim.target)
              return element
                ? messageFollowScrollTop(container, element, thresholdRef.current)
                : null
            })()
      return (
        targetTop !== null &&
        Math.abs(container.scrollTop - targetTop) <= LAYOUT_ANCHOR_TOLERANCE_PX
      )
    },
    [resolveFollowTargetElement],
  )

  const preserveAcquiredFollowClaim = useCallback(
    (claim: SemanticFollowClaim) => {
      const container = containerRef.current
      if (!container) return false
      if (claim.source === 'open') didOpenRef.current = true
      if (
        claim.kind === 'bottom' ||
        Math.abs(container.scrollTop - bottomScrollTop(container)) <= LAYOUT_ANCHOR_TOLERANCE_PX
      ) {
        installContinuityLease(claim.source, { kind: 'bottom', distance: 0 })
        return true
      }
      const element = resolveFollowTargetElement(claim.target)
      if (!element) return false
      installContinuityLease(claim.source, {
        kind: 'element',
        element,
        messageId: claim.target.messageId,
        elementOrdinal: null,
        textIdentity: null,
        edge: 'bottom',
        coordinate: element.getBoundingClientRect().bottom,
        documentCoordinate: element.getBoundingClientRect().bottom + container.scrollTop,
      })
      return true
    },
    [installContinuityLease, resolveFollowTargetElement],
  )

  const settleAcquiredFiniteFollowClaim = useCallback((): boolean => {
    const lease = continuityLeaseRef.current
    if (lease?.mode !== 'follow' || lease.claim.source === 'stream') return false
    if (!followClaimIsAcquired(lease.claim)) return false
    finiteAcquisitionRef.current = null
    return preserveAcquiredFollowClaim(lease.claim)
  }, [followClaimIsAcquired, preserveAcquiredFollowClaim])

  const reconcileFiniteFollowClaim = useCallback(
    (reason: string): 'none' | 'pending' | 'settled' => {
      const lease = continuityLeaseRef.current
      if (lease?.mode !== 'follow' || lease.claim.source === 'stream') return 'none'
      if (
        lease.claim.source === 'reveal' &&
        revealClaimLifecycleRef.current?.status !== 'consumed'
      ) {
        return 'none'
      }
      if (
        finiteAcquisitionRef.current?.leaseRevision === lease.revision &&
        followClaimIsAcquired(lease.claim)
      ) {
        finiteAcquisitionRef.current = null
        return preserveAcquiredFollowClaim(lease.claim) ? 'settled' : 'pending'
      }
      finiteAcquisitionRef.current = null
      scrollToFollowPositionNow(reason)
      const current = continuityLeaseRef.current
      if (
        current?.mode === 'follow' &&
        current.revision === lease.revision &&
        followClaimIsAcquired(current.claim)
      ) {
        finiteAcquisitionRef.current = { leaseRevision: current.revision }
      }
      setScrollStateNow('follow', `${reason}.acquire`)
      return 'pending'
    },
    [
      followClaimIsAcquired,
      preserveAcquiredFollowClaim,
      scrollToFollowPositionNow,
      setScrollStateNow,
    ],
  )

  const semanticClaimFollowsGrowth = useCallback(() => {
    const lease = continuityLeaseRef.current
    if (lease?.mode !== 'follow') return false
    const claim = lease.claim
    if (claim.source === 'stream') {
      return streamActiveRef.current && autoScrollOnStreamRef.current
    }
    return true
  }, [])

  const updateFromScrollPosition = useCallback(
    (source: PositionSource) => {
      const container = containerRef.current
      if (!container) return
      if (textEditingViewportClaimsRef.current > 0) {
        const intendedTop = textEditingViewportTopRef.current
        const instantIntent = instantScrollIntentRef.current
        const instantMatched = matchesInstantScrollIntent(instantIntent, container.scrollTop)
        let acceptsNativeMovement = userScrollIntentRef.current || instantMatched
        if (instantMatched) {
          instantScrollIntentRef.current = instantIntent?.preserveThroughScrollEnd
            ? {
                ...instantIntent,
                top: container.scrollTop,
                scrollHeight: container.scrollHeight,
              }
            : null
        } else if (smoothScrollIntentRef.current) {
          const smooth = advanceSmoothScrollIntent(
            smoothScrollIntentRef.current,
            container.scrollTop,
          )
          smoothScrollIntentRef.current = smooth.next
          acceptsNativeMovement = acceptsNativeMovement || smooth.programmatic
        }
        if (
          source === 'scroll' &&
          !acceptsNativeMovement &&
          intendedTop !== null &&
          Math.abs(container.scrollTop - intendedTop) > 0.5
        ) {
          writeScrollTopNow(intendedTop, 'text-edit-restore')
        }
        textEditingViewportTopRef.current = container.scrollTop
        lastNativeScrollTopRef.current = container.scrollTop
        lastObservedScrollGeometryRef.current = {
          scrollHeight: container.scrollHeight,
          clientHeight: container.clientHeight,
        }
        setScrollStateNow('pinned', 'text-edit', source === 'scroll')
        return
      }
      const previousNativeScrollTop = lastNativeScrollTopRef.current
      const previousGeometry = lastObservedScrollGeometryRef.current
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight
      const nativeViewportMoved =
        source === 'scroll' &&
        previousNativeScrollTop !== null &&
        previousGeometry !== null &&
        Math.abs(container.scrollTop - previousNativeScrollTop) > 0.5 &&
        Math.abs(previousGeometry.scrollHeight - container.scrollHeight) <= 0.5 &&
        Math.abs(previousGeometry.clientHeight - container.clientHeight) <= 0.5
      const stationaryNativeScroll =
        source === 'scroll' &&
        previousNativeScrollTop !== null &&
        Math.abs(previousNativeScrollTop - container.scrollTop) <= 0.5
      const displacement = continuityLeaseRef.current?.displacement
      const continuityGeometryChanged =
        source === 'scroll' &&
        displacement?.kind === 'element' &&
        displacement.element.isConnected &&
        Math.abs(
          (displacement.edge === 'bottom'
            ? displacement.element.getBoundingClientRect().bottom
            : displacement.element.getBoundingClientRect().top) +
            container.scrollTop -
            displacement.documentCoordinate,
        ) > LAYOUT_ANCHOR_TOLERANCE_PX
      const scrollGeometryChanged =
        source === 'scroll' &&
        previousGeometry !== null &&
        (Math.abs(previousGeometry.scrollHeight - container.scrollHeight) > 0.5 ||
          Math.abs(previousGeometry.clientHeight - container.clientHeight) > 0.5)
      const passivePinnedLayoutClamp =
        source !== 'scroll' &&
        stateRef.current === 'pinned' &&
        continuityLeaseRef.current?.mode === 'preserve' &&
        !userScrollIntentRef.current &&
        previousNativeScrollTop !== null &&
        Math.abs(container.scrollTop - previousNativeScrollTop) > 0.5
      if (passivePinnedLayoutClamp) {
        recordInstantScrollIntent(container.scrollTop, 'layout-anchor')
      }
      if (source === 'scroll') lastNativeScrollTopRef.current = container.scrollTop
      lastObservedScrollGeometryRef.current = {
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
      }
      let programmaticScroll = false
      if (source === 'scroll') {
        const instantIntent = instantScrollIntentRef.current
        const instantMatched = matchesInstantScrollIntent(instantIntent, container.scrollTop)
        const instantGeometryChanged =
          instantIntent?.preserveThroughScrollEnd &&
          instantIntent.scrollHeight !== container.scrollHeight
        if (
          instantMatched ||
          instantGeometryChanged ||
          (continuityGeometryChanged && !userScrollIntentRef.current) ||
          (scrollGeometryChanged &&
            !userScrollIntentRef.current &&
            continuityLeaseRef.current !== null)
        ) {
          programmaticScroll = true
          instantScrollIntentRef.current = instantIntent?.preserveThroughScrollEnd
            ? {
                ...instantIntent,
                top: container.scrollTop,
                scrollHeight: container.scrollHeight,
              }
            : null
        } else if (smoothScrollIntentRef.current) {
          instantScrollIntentRef.current = null
          const smooth = advanceSmoothScrollIntent(
            smoothScrollIntentRef.current,
            container.scrollTop,
          )
          smoothScrollIntentRef.current = smooth.next
          programmaticScroll = smooth.programmatic
        } else {
          instantScrollIntentRef.current = null
        }
      }
      const viewportMovedUp =
        source === 'scroll' &&
        !programmaticScroll &&
        previousNativeScrollTop !== null &&
        container.scrollTop < previousNativeScrollTop - 0.5
      const userMovedAwayFromBottom =
        viewportMovedUp &&
        (userScrollIntentRef.current ||
          (nativeViewportMoved && distanceFromBottom > BOTTOM_REACQUIRE_TOLERANCE_PX))
      const preservesPinnedLease =
        source !== 'scroll' &&
        stateRef.current === 'pinned' &&
        continuityLeaseRef.current?.mode === 'preserve'
      const next =
        userMovedAwayFromBottom || preservesPinnedLease
          ? 'pinned'
          : scrollStateFromPosition(container, thresholdRef.current, stateRef.current)
      if (hasScrollDebugSink()) {
        debugScroll('position', {
          source,
          next,
          stationaryNativeScroll,
          nativeViewportMoved,
          continuityGeometryChanged,
          scrollGeometryChanged,
          programmaticScroll,
          userScrollIntent: userScrollIntentRef.current,
        })
      }
      const preparedTransition =
        source === 'scroll' && !programmaticScroll ? pendingPreparedTransitionRef.current : null
      if (preparedTransition) rebasePreparedTransitionToUser(preparedTransition)
      if (
        programmaticScroll ||
        (layoutCorrectionPendingRef.current && continuityLeaseRef.current?.mode === 'follow') ||
        (stationaryNativeScroll && continuityLeaseRef.current?.mode === 'follow')
      ) {
        return
      }
      if (next === 'follow') {
        if (source === 'scroll' && userScrollIntentRef.current) {
          cancelViewportOwnership()
          clearProgrammaticScrollIntents()
          if (streamActiveRef.current && autoScrollOnStreamRef.current) {
            acquireFollowLease(
              semanticFollowClaimForTarget(
                'stream',
                streamFollowTargetMessageIdRef.current,
                selectionKeyRef.current,
              ),
            )
          }
        }
        setScrollStateNow('follow', source, source === 'scroll' && userScrollIntentRef.current)
        return
      }
      if (source === 'scroll') {
        if (!preparedTransition) cancelViewportOwnership()
        clearProgrammaticScrollIntents()
        setScrollStateNow('pinned', source, userMovedAwayFromBottom)
        if (!preparedTransition) capturePinnedLayoutAnchor()
        return
      }
      if (
        continuityLeaseRef.current?.mode === 'follow' ||
        (continuityLeaseRef.current !== null &&
          stateRef.current === 'follow' &&
          !userScrollIntentRef.current)
      ) {
        setScrollStateNow('follow', source)
        return
      }
      setScrollStateNow('pinned', source)
    },
    [
      acquireFollowLease,
      cancelViewportOwnership,
      capturePinnedLayoutAnchor,
      clearProgrammaticScrollIntents,
      debugScroll,
      recordInstantScrollIntent,
      rebasePreparedTransitionToUser,
      setScrollStateNow,
      writeScrollTopNow,
    ],
  )

  const completeOpenScrollIfReady = useCallback(() => {
    const container = containerRef.current
    if (!container || didOpenRef.current) return false
    // No overflow yet (empty, still loading, or short transcript). Keep the
    // latch open so the first real overflow can still land at the leaf.
    if (container.scrollHeight <= container.clientHeight) {
      finiteAcquisitionRef.current = null
      if (!continuityLeaseRef.current) {
        acquireFollowLease({ source: 'open', kind: 'bottom' })
      }
      if (hasScrollDebugSink()) debugScroll('open.wait')
      setScrollStateNow('follow', 'open.wait')
      return false
    }
    const lease = continuityLeaseRef.current
    const claim = lease?.mode === 'follow' ? lease.claim : null
    if (!claim || claim.source === 'open') {
      if (!claim) acquireFollowLease({ source: 'open', kind: 'bottom' })
      const result = reconcileFiniteFollowClaim('open')
      if (result !== 'settled') return false
      if (hasScrollDebugSink()) debugScroll('open.bottom')
    } else {
      finiteAcquisitionRef.current = null
      didOpenRef.current = true
      scrollToFollowPositionNow('open-claimed')
    }
    return true
  }, [
    acquireFollowLease,
    debugScroll,
    reconcileFiniteFollowClaim,
    scrollToFollowPositionNow,
    setScrollStateNow,
  ])

  const scheduleFollowReconciliation = useCallback(
    (source?: 'resize' | 'mutation') => {
      if (source) layoutCorrectionPendingRef.current = true
      if (!viewportActive || !documentVisibleRef.current) return
      if (textEditingViewportClaimsRef.current > 0) {
        layoutCorrectionPendingRef.current = false
        setScrollStateNow('pinned', 'text-edit-layout')
        return
      }
      const pendingTransition = pendingPreparedTransitionRef.current
      if (
        pendingTransition !== null &&
        pendingTransition.revision !== committedViewportRevisionRef.current
      ) {
        return
      }
      if (adoptUnclaimedNativeViewportMovement()) {
        layoutCorrectionPendingRef.current = false
        return
      }
      if (hasScrollDebugSink()) debugScroll('follow.schedule')
      if (source && hasScrollDebugSink()) debugScroll(source)
      if (completeOpenScrollIfReady()) {
        layoutCorrectionPendingRef.current = false
        return
      }
      const finiteClaim = continuityLeaseRef.current
      if (
        didOpenRef.current &&
        finiteClaim?.mode === 'follow' &&
        finiteClaim.claim.source === 'reveal'
      ) {
        reconcileFiniteFollowClaim('reveal')
        layoutCorrectionPendingRef.current = false
        return
      }
      if (semanticClaimFollowsGrowth()) {
        if (hasScrollDebugSink()) debugScroll('follow.scheduled-scroll')
        scrollToFollowPositionNow('scheduled-follow')
      } else if (source) {
        correctContinuityLease()
        updateFromScrollPosition('resize')
      }
      layoutCorrectionPendingRef.current = false
    },
    [
      adoptUnclaimedNativeViewportMovement,
      completeOpenScrollIfReady,
      correctContinuityLease,
      debugScroll,
      reconcileFiniteFollowClaim,
      scrollToFollowPositionNow,
      semanticClaimFollowsGrowth,
      setScrollStateNow,
      updateFromScrollPosition,
      viewportActive,
    ],
  )

  const commands = useMemo<ScrollRegionCommands>(
    () => ({
      captureLayoutAnchor: capturePinnedLayoutAnchor,
      getUserScrollRevision() {
        return userScrollRevisionRef.current
      },
      revealNearest(element) {
        const container = containerRef.current
        if (!container?.contains(element)) return false
        clearProgrammaticScrollIntents()
        cancelViewportOwnership()
        const containerRect = container.getBoundingClientRect()
        const elementRect = element.getBoundingClientRect()
        if (elementRect.top < containerRect.top) {
          writeScrollTopNow(
            container.scrollTop + elementRect.top - containerRect.top,
            'reveal-nearest',
          )
        } else if (elementRect.bottom > containerRect.bottom) {
          writeScrollTopNow(
            container.scrollTop + elementRect.bottom - containerRect.bottom,
            'reveal-nearest',
          )
        }
        const next = scrollStateFromPosition(container, thresholdRef.current, stateRef.current)
        setScrollStateNow(next, 'reveal-nearest')
        if (next === 'pinned') {
          capturePinnedLayoutAnchor()
        } else {
          installContinuityLease('manual', {
            kind: 'bottom',
            distance: container.scrollHeight - container.scrollTop - container.clientHeight,
          })
        }
        return true
      },
      getLayoutAnchorMessageId() {
        const displacement = continuityLeaseRef.current?.displacement
        return displacement?.kind === 'element' ? displacement.messageId : null
      },
      getLayoutAnchorSnapshot() {
        const displacement = continuityLeaseRef.current?.displacement
        return displacement?.kind === 'element'
          ? {
              element: displacement.element,
              messageId: displacement.messageId,
              edge: displacement.edge,
              coordinate: displacement.coordinate,
            }
          : null
      },
      reconcileLayoutAnchor() {
        return correctContinuityLease()
      },
      applyVirtualizerOffset(offset, adjustment = 0) {
        writeScrollTopNow(offset + adjustment, 'virtualizer-layout')
        correctContinuityLease()
      },
      claimTextEditingViewport() {
        const container = containerRef.current
        if (textEditingViewportClaimsRef.current === 0) {
          textEditingViewportTopRef.current = container?.scrollTop ?? null
        }
        textEditingViewportClaimsRef.current += 1
        clearProgrammaticScrollIntents()
        cancelViewportOwnership()
        setScrollStateNow('pinned', 'text-edit', true)
        let released = false
        return () => {
          if (released) return
          released = true
          textEditingViewportClaimsRef.current = Math.max(
            0,
            textEditingViewportClaimsRef.current - 1,
          )
          if (textEditingViewportClaimsRef.current === 0) {
            textEditingViewportTopRef.current = null
            updateFromScrollPosition('layout')
          }
        }
      },
      preserveTextEditingViewport(change) {
        const container = containerRef.current
        if (!container || textEditingViewportClaimsRef.current === 0) {
          change()
          return
        }
        const top = textEditingViewportTopRef.current ?? container.scrollTop
        clearProgrammaticScrollIntents()
        container.scrollTo({ top, behavior: 'auto' })
        change()
        writeScrollTopNow(top, 'text-edit-layout')
      },
      scrollTextEditingViewportBy(deltaY, deltaMode = 0) {
        const container = containerRef.current
        if (!container || textEditingViewportClaimsRef.current === 0) return
        const scale = deltaMode === 1 ? 16 : deltaMode === 2 ? container.clientHeight : 1
        writeScrollTopNow(container.scrollTop + deltaY * scale, 'text-edit-wheel')
        setScrollStateNow('pinned', 'text-edit-wheel', true)
      },
    }),
    [
      cancelViewportOwnership,
      capturePinnedLayoutAnchor,
      clearProgrammaticScrollIntents,
      correctContinuityLease,
      installContinuityLease,
      setScrollStateNow,
      updateFromScrollPosition,
      writeScrollTopNow,
    ],
  )

  captureRetainedViewportDispositionRef.current = () => {
    const container = containerRef.current
    if (stateRef.current === 'pinned' && continuityLeaseRef.current === null) {
      capturePinnedLayoutAnchor()
    }
    retainedViewportDispositionRef.current = {
      state: stateRef.current,
      lease: continuityLeaseRef.current,
      distanceFromBottom: container
        ? container.scrollHeight - container.scrollTop - container.clientHeight
        : null,
      workspaceEpoch: workspaceEpochRef.current,
      chatKey: resetKeyRef.current,
      selectionKey: selectionKeyRef.current,
    }
  }

  useLayoutEffect(() => {
    if (!viewportActive) return
    const reactivating = retainedViewportLifecycleRef.current === 'inactive'
    retainedViewportLifecycleRef.current = 'active'
    retainedViewportReactivationPendingRef.current = reactivating
    return () => {
      captureRetainedViewportDispositionRef.current()
      retainedViewportLifecycleRef.current = 'inactive'
    }
  }, [viewportActive])

  useLayoutEffect(() => {
    if (!viewportActive || !retainedViewportReactivationPendingRef.current) return
    retainedViewportReactivationPendingRef.current = false
    const disposition = retainedViewportDispositionRef.current
    retainedViewportDispositionRef.current = null
    if (
      !disposition ||
      disposition.workspaceEpoch !== workspaceEpoch ||
      !Object.is(disposition.chatKey, resetKey) ||
      !Object.is(disposition.selectionKey, selectionKey)
    ) {
      return
    }

    clearProgrammaticScrollIntents()
    userScrollIntentRef.current = false
    lastNativeScrollTopRef.current = null
    lastObservedScrollGeometryRef.current = null
    continuityLeaseRef.current = disposition.lease

    if (disposition.lease?.mode === 'follow') {
      setScrollStateNow('follow', 'viewport-reactivate', true)
      scrollToFollowPositionNow('viewport-reactivate')
      layoutCorrectionPendingRef.current = true
      return
    }

    if (!disposition.lease && disposition.distanceFromBottom !== null) {
      installContinuityLease('manual', {
        kind: 'bottom',
        distance: disposition.distanceFromBottom,
      })
    }
    correctContinuityLease()
    setScrollStateNow(disposition.state, 'viewport-reactivate', true)
    updateFromScrollPosition('layout')
  }, [
    viewportActive,
    workspaceEpoch,
    resetKey,
    selectionKey,
    clearProgrammaticScrollIntents,
    correctContinuityLease,
    installContinuityLease,
    scrollToFollowPositionNow,
    setScrollStateNow,
    updateFromScrollPosition,
  ])

  useLayoutEffect(() => {
    if (!viewportActive) return
    committedViewportRevisionRef.current = viewportRevision
    const pendingTransition = pendingPreparedTransitionRef.current
    if (pendingTransition === null || pendingTransition.revision !== viewportRevision) return
    const lease = continuityLeaseRef.current
    if (
      lease &&
      Object.is(lease.selectionKey, pendingTransition.fromSelectionKey) &&
      Object.is(selectionKey, pendingTransition.toSelectionKey)
    ) {
      continuityLeaseRef.current = {
        ...lease,
        selectionKey: pendingTransition.toSelectionKey,
        viewportRevision,
      }
      selectionKeyRef.current = pendingTransition.toSelectionKey
    }
    if (pendingTransition.kind === 'reveal') {
      scrollToFollowPositionNow('prepared-reveal')
      setScrollStateNow('follow', 'prepared-reveal')
    } else {
      correctContinuityLease()
    }
    updateFromScrollPosition('layout')
    pendingPreparedTransitionRef.current = null
    layoutCorrectionPendingRef.current = false
  }, [
    correctContinuityLease,
    selectionKey,
    scrollToFollowPositionNow,
    setScrollStateNow,
    updateFromScrollPosition,
    viewportActive,
    viewportRevision,
  ])

  // Open-time jump. The reset happens in the same layout pass as the
  // measurement, so a reused scroll container can't carry the previous chat's
  // "already opened" latch into the new chat.
  useLayoutEffect(() => {
    if (!viewportActive) return
    const chatChanged = !Object.is(resetKeyRef.current, resetKey)
    const epochChanged = workspaceEpochRef.current !== workspaceEpoch
    if (chatChanged) {
      if (hasScrollDebugSink()) {
        debugScroll('reset-key', { from: resetKeyRef.current, to: resetKey })
      }
      resetKeyRef.current = resetKey
      workspaceEpochRef.current = workspaceEpoch
      didOpenRef.current = false
      finiteAcquisitionRef.current = null
      clearProgrammaticScrollIntents()
      cancelViewportOwnership()
      acquireFollowLease({ source: 'open', kind: 'bottom' })
    } else if (epochChanged) {
      workspaceEpochRef.current = workspaceEpoch
      const lease = continuityLeaseRef.current
      if (lease) continuityLeaseRef.current = { ...lease, workspaceEpoch }
      pendingPreparedTransitionRef.current = null
      layoutCorrectionPendingRef.current = false
    }
    if (completeOpenScrollIfReady()) return
    if (!Object.is(selectionKeyRef.current, selectionKey)) return
    updateFromScrollPosition('layout')
  })

  // IntersectionObserver keeps the ordinary branch-bottom state accurate.
  // Exact-target ownership may intentionally remain above that sentinel.
  useEffect(() => {
    if (!viewportActive) return
    if (typeof IntersectionObserver === 'undefined') return
    const container = containerRef.current
    const sentinel = sentinelRef.current
    if (!container || !sentinel) return
    const threshold = pinThresholdPx ?? DEFAULT_THRESHOLD_PX
    const observer = new IntersectionObserver(
      () => {
        if (hasScrollDebugSink()) debugScroll('observer')
        if (completeOpenScrollIfReady()) return
        updateFromScrollPosition('observer')
      },
      {
        root: container,
        rootMargin: `0px 0px ${threshold}px 0px`,
        threshold: 0,
      },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [
    viewportActive,
    pinThresholdPx,
    completeOpenScrollIfReady,
    debugScroll,
    updateFromScrollPosition,
  ])

  // Live stream snapshots rerender individual Message rows through Zustand;
  // the ScrollRegion parent does not necessarily rerender per token. DOM
  // commits reconcile before paint, while ResizeObserver owns geometry changes
  // that occur without a DOM mutation.
  useLayoutEffect(() => {
    if (!viewportActive) return
    const container = containerRef.current
    const content = contentRef.current
    if (!container || !content) return
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => scheduleFollowReconciliation('resize'))
    const mutationObserver =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver(() => scheduleFollowReconciliation('mutation'))
    resizeObserver?.observe(content)
    resizeObserver?.observe(container)
    mutationObserver?.observe(content, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    scheduleFollowReconciliation('resize')

    return () => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
    }
  }, [viewportActive, scheduleFollowReconciliation])

  useEffect(() => {
    const onVisibilityChange = () => {
      documentVisibleRef.current = document.visibilityState !== 'hidden'
      if (documentVisibleRef.current) scheduleFollowReconciliation('resize')
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [scheduleFollowReconciliation])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const markUserScrollIntent = (event: 'wheel' | 'touchmove' | 'scrollbar' | 'keyboard') => {
      userScrollIntentRef.current = true
      userScrollRevisionRef.current += 1
      didOpenRef.current = true
      finiteAcquisitionRef.current = null
      clearProgrammaticScrollIntents()
      const lease = continuityLeaseRef.current
      if (lease?.mode === 'follow') {
        const lifecycle = revealClaimLifecycleRef.current
        if (lease.claim.source === 'reveal' && lifecycle?.status === 'active') {
          lifecycle.status = 'cancelled'
        }
      }
      const owned = continuityLeaseRef.current !== null
      const preparedTransition = pendingPreparedTransitionRef.current
      if (preparedTransition) {
        rebasePreparedTransitionToUser(preparedTransition)
      } else {
        cancelViewportOwnership()
        capturePinnedLayoutAnchor()
      }
      if (owned && hasScrollDebugSink()) {
        debugScroll('user-follow-cancel', { event })
      }
      if (hasScrollDebugSink() && (event === 'wheel' || event === 'touchmove')) {
        debugScroll(event)
      }
    }
    const onScroll = () => {
      if (hasScrollDebugSink()) debugScroll('native-scroll')
      const lease = continuityLeaseRef.current
      if (
        lease?.mode === 'follow' &&
        ((!didOpenRef.current && lease.claim.source === 'open') ||
          (lease.claim.source === 'reveal' &&
            revealClaimLifecycleRef.current?.status === 'consumed'))
      ) {
        scheduleFollowReconciliation()
      }
      updateFromScrollPosition('scroll')
      settleAcquiredFiniteFollowClaim()
    }
    const onScrollEnd = () => {
      userScrollIntentRef.current = false
      if (!instantScrollIntentRef.current?.preserveThroughScrollEnd) {
        instantScrollIntentRef.current = null
      }
      smoothScrollIntentRef.current = null
      settleAcquiredFiniteFollowClaim()
      updateFromScrollPosition('layout')
    }
    const onWheel = () => markUserScrollIntent('wheel')
    const onTouchMove = () => markUserScrollIntent('touchmove')
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === container) markUserScrollIntent('scrollbar')
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (
        !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) ||
        target?.closest(
          'button, a, input, textarea, select, [contenteditable="true"], [role="button"]',
        )
      ) {
        return
      }
      markUserScrollIntent('keyboard')
    }
    container.addEventListener('wheel', onWheel, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: true })
    container.addEventListener('pointerdown', onPointerDown, { passive: true })
    container.addEventListener('keydown', onKeyDown)
    container.addEventListener('scroll', onScroll, { capture: true, passive: true })
    container.addEventListener('scrollend', onScrollEnd, { passive: true })
    return () => {
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('keydown', onKeyDown)
      container.removeEventListener('scroll', onScroll, { capture: true })
      container.removeEventListener('scrollend', onScrollEnd)
    }
  }, [
    cancelViewportOwnership,
    capturePinnedLayoutAnchor,
    clearProgrammaticScrollIntents,
    debugScroll,
    rebasePreparedTransitionToUser,
    scheduleFollowReconciliation,
    settleAcquiredFiniteFollowClaim,
    updateFromScrollPosition,
  ])

  useLayoutEffect(() => {
    const previous = previousAutoScrollOnStreamRef.current
    previousAutoScrollOnStreamRef.current = autoScrollOnStream
    if (!previous || autoScrollOnStream) return
    const container = containerRef.current
    clearProgrammaticScrollIntents()
    const lease = continuityLeaseRef.current
    if (lease?.mode === 'follow' && lease.claim.source === 'stream') {
      captureFollowDisplacement()
      releaseSemanticClaim()
    }
    if (!container) return
    const next = scrollStateFromPosition(container, thresholdRef.current, stateRef.current)
    setScrollStateNow(next, 'auto-scroll-mode')
    if (next === 'pinned') capturePinnedLayoutAnchor()
  }, [
    autoScrollOnStream,
    captureFollowDisplacement,
    capturePinnedLayoutAnchor,
    clearProgrammaticScrollIntents,
    releaseSemanticClaim,
    setScrollStateNow,
  ])

  useLayoutEffect(() => {
    if (!viewportActive) return
    const container = containerRef.current
    const streamWasActive = previousStreamActiveRef.current
    const streamStarted = !streamWasActive && streamActive
    const streamEnded = streamWasActive && !streamActive
    previousStreamActiveRef.current = streamActive

    const selectionChanged = !Object.is(selectionKeyRef.current, selectionKey)
    const selectionIdentityChanged = selectionChanged
    const followKeyChanged = !Object.is(streamFollowKeyRef.current, streamFollowKey)
    const targetChanged = !Object.is(
      streamFollowTargetMessageIdRef.current,
      streamFollowTargetMessageId,
    )
    streamFollowKeyRef.current = streamFollowKey
    streamFollowTargetMessageIdRef.current = streamFollowTargetMessageId

    const previousLease = continuityLeaseRef.current
    if (
      streamEnded &&
      previousLease?.mode === 'follow' &&
      previousLease.claim.source === 'stream'
    ) {
      correctContinuityLease()
      captureFollowDisplacement()
      releaseSemanticClaim()
      layoutCorrectionPendingRef.current = false
      if (container) setScrollStateNow('follow', 'stream-terminal')
    }
    const terminalStreamLease =
      streamEnded && continuityLeaseRef.current?.mode === 'preserve'
        ? continuityLeaseRef.current
        : null
    const carriedClaim =
      continuityLeaseRef.current?.mode === 'follow'
        ? continuityLeaseRef.current.claim
        : !streamEnded && previousLease?.mode === 'follow'
          ? previousLease.claim
          : null
    const carriedDisplacement =
      continuityLeaseRef.current?.mode === 'preserve'
        ? continuityLeaseRef.current.displacement
        : previousLease?.mode === 'preserve'
          ? previousLease.displacement
          : null
    if (selectionIdentityChanged) {
      if (terminalStreamLease) {
        continuityLeaseRef.current = {
          ...terminalStreamLease,
          revision: ++continuityRevisionRef.current,
          selectionKey,
        }
      } else {
        cancelContinuityLease()
      }
    }
    selectionKeyRef.current = selectionKey

    const lifecycle = revealClaimLifecycleRef.current
    const revealArrived =
      revealClaimKey !== null && (!lifecycle || !Object.is(lifecycle.key, revealClaimKey))
    if (revealArrived) {
      revealClaimLifecycleRef.current = { key: revealClaimKey, status: 'active' }
      didOpenRef.current = true
      clearProgrammaticScrollIntents()
      cancelViewportOwnership()
      acquireFollowLease(
        semanticFollowClaimForTarget(
          'reveal',
          revealClaimTargetMessageId ?? streamFollowTargetMessageId,
          selectionKeyRef.current,
        ),
      )
      setScrollStateNow('follow', 'reveal-acquire')
      scrollToFollowPositionNow('reveal-acquire')
      layoutCorrectionPendingRef.current = true
      scheduleFollowReconciliation()
    }

    if (selectionIdentityChanged && terminalStreamLease) {
      correctContinuityLease()
    } else if (selectionIdentityChanged) {
      clearProgrammaticScrollIntents()
      const currentLease = continuityLeaseRef.current
      const claim = currentLease?.mode === 'follow' ? currentLease.claim : carriedClaim
      if (claim) {
        if (claim.source === 'stream') {
          acquireFollowLease(
            semanticFollowClaimForTarget(
              'stream',
              streamFollowTargetMessageId,
              selectionKeyRef.current,
            ),
          )
        } else if (claim.source === 'reveal') {
          acquireFollowLease(
            semanticFollowClaimForTarget(
              'reveal',
              revealClaimTargetMessageId ?? streamFollowTargetMessageId,
              selectionKeyRef.current,
            ),
          )
        } else {
          acquireFollowLease({ source: 'open', kind: 'bottom' })
        }
        setScrollStateNow('follow', 'selection-claim')
        scrollToFollowPositionNow('selection-claim')
        layoutCorrectionPendingRef.current = true
        scheduleFollowReconciliation()
      } else if (stateRef.current === 'follow') {
        scrollToBottomNow({ smooth: false, reason: 'selection' })
        if (container) {
          installContinuityLease('manual', {
            kind: 'bottom',
            distance: container.scrollHeight - container.scrollTop - container.clientHeight,
          })
        }
      } else if (
        carriedDisplacement?.kind === 'element' &&
        carriedDisplacement.element.isConnected &&
        contentRef.current?.contains(carriedDisplacement.element)
      ) {
        installContinuityLease('manual', carriedDisplacement)
        correctContinuityLease()
      }
    }

    const activeLifecycle = revealClaimLifecycleRef.current
    const revealStillPending =
      revealClaimKey !== null &&
      activeLifecycle?.status === 'active' &&
      Object.is(activeLifecycle.key, revealClaimKey)
    if (
      streamActive &&
      autoScrollOnStream &&
      (streamStarted || followKeyChanged || targetChanged) &&
      !revealStillPending &&
      (stateRef.current === 'follow' ||
        (continuityLeaseRef.current?.mode === 'follow' &&
          continuityLeaseRef.current.claim.source === 'stream'))
    ) {
      if (hasScrollDebugSink()) debugScroll('stream-start')
      acquireFollowLease(
        semanticFollowClaimForTarget(
          'stream',
          streamFollowTargetMessageId,
          selectionKeyRef.current,
        ),
      )
      setScrollStateNow('follow', 'stream')
      scrollToFollowPositionNow('stream')
      layoutCorrectionPendingRef.current = true
      scheduleFollowReconciliation()
    }

    const readyLifecycle = revealClaimLifecycleRef.current
    if (
      revealClaimKey !== null &&
      readyLifecycle !== null &&
      readyLifecycle.status !== 'consumed' &&
      Object.is(readyLifecycle.key, revealClaimKey) &&
      revealSurfaceAvailable
    ) {
      const revealClaim = semanticFollowClaimForTarget(
        'reveal',
        revealClaimTargetMessageId ?? streamFollowTargetMessageId,
        selectionKeyRef.current,
      )
      const acquired =
        revealClaim.kind === 'bottom'
          ? container !== null
          : resolveFollowTargetElement(revealClaim.target) !== null
      if (!acquired) return
      const accepted = readyLifecycle.status === 'active'
      readyLifecycle.status = 'consumed'
      if (accepted) {
        acquireFollowLease(revealClaim)
        setScrollStateNow('follow', 'reveal-ready')
        if (streamActive && autoScrollOnStream) {
          acquireFollowLease(
            semanticFollowClaimForTarget(
              'stream',
              streamFollowTargetMessageId ?? revealClaimTargetMessageId,
              selectionKeyRef.current,
            ),
          )
        }
        layoutCorrectionPendingRef.current = true
        scheduleFollowReconciliation()
      }
      onRevealClaimConsumed?.()
    }
  }, [
    viewportActive,
    acquireFollowLease,
    autoScrollOnStream,
    cancelContinuityLease,
    cancelViewportOwnership,
    captureFollowDisplacement,
    clearProgrammaticScrollIntents,
    correctContinuityLease,
    debugScroll,
    installContinuityLease,
    onRevealClaimConsumed,
    revealClaimKey,
    revealClaimTargetMessageId,
    revealSurfaceAvailable,
    releaseSemanticClaim,
    resolveFollowTargetElement,
    scheduleFollowReconciliation,
    scrollToBottomNow,
    scrollToFollowPositionNow,
    selectionKey,
    setScrollStateNow,
    streamActive,
    streamFollowKey,
    streamFollowTargetMessageId,
  ])

  const scrollToBottom = useCallback(
    (opts?: { smooth?: boolean }) => {
      cancelViewportOwnership()
      if (streamActiveRef.current && autoScrollOnStreamRef.current) {
        acquireFollowLease(
          semanticFollowClaimForTarget(
            'stream',
            streamFollowTargetMessageIdRef.current,
            selectionKeyRef.current,
          ),
        )
      } else {
        acquireFollowLease({ source: 'manual', kind: 'bottom' })
      }
      scrollToBottomNow({ smooth: opts?.smooth ?? true })
      settleAcquiredFiniteFollowClaim()
    },
    [
      acquireFollowLease,
      cancelViewportOwnership,
      scrollToBottomNow,
      settleAcquiredFiniteFollowClaim,
    ],
  )

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom,
      getState: () => stateRef.current,
      prepareLayoutChange,
    }),
    [prepareLayoutChange, scrollToBottom],
  )

  useEffect(() => {
    return () => {
      clearProgrammaticScrollIntents()
    }
  }, [clearProgrammaticScrollIntents])

  return (
    <div ref={containerRef} data-ui="scroll-region" data-scroll-state={state}>
      <div ref={contentRef} data-ui="scroll-content">
        <ScrollRegionStateContext.Provider value={state}>
          <ScrollRegionCommandsContext.Provider value={commands}>
            {children}
          </ScrollRegionCommandsContext.Provider>
        </ScrollRegionStateContext.Provider>
        <div ref={sentinelRef} data-ui="scroll-sentinel" aria-hidden="true" />
      </div>
    </div>
  )
})
