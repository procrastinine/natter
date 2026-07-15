import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { hasScrollDebugSink, logScrollDebug } from '../../lib/debug-scroll'
import { scheduleReactPublication } from '../../lib/react-publication'

export type ScrollState = 'follow' | 'pinned'

interface ScrollRegionProps {
  children: ReactNode
  pinThresholdPx?: number
  // Notified whenever the follow/pinned state changes. Lets a sibling render
  // a "Jump to latest" affordance anchored to the main-pane viewport bottom
  // (rather than scrolling with the content inside the region).
  onStateChange?: (state: ScrollState) => void
  // While `streamActive` is true AND the sentinel is currently visible
  // (user hasn't scrolled up), follow new tokens into view as they arrive.
  // When false, streams never move the viewport — user stays wherever they
  // are. Chat open always lands at the branch leaf regardless of this setting.
  autoScrollOnStream?: boolean
  // Parent signals that a stream is currently in progress for the content
  // being rendered here. Stream-time follow only activates during this
  // window; outside it, content changes never move the scroll position
  // through the streaming path.
  streamActive?: boolean
  // Identity that resets the open-latch. When this value changes (e.g. the
  // user switches chats via sidebar), the next content-load triggers
  // another one-shot open-scroll.
  resetKey?: string | number | null
  // Identity of the currently rendered branch tail. A stream can become
  // active before the new streamed row is mounted; this lets bottom-follow
  // attach when that row actually appears.
  streamFollowKey?: string | number | null
}

export interface ScrollRegionHandle {
  scrollToBottom: (opts?: { smooth?: boolean }) => void
  getState: () => ScrollState
}

const DEFAULT_THRESHOLD_PX = 48
const USER_SCROLL_INTENT_MS = 750
const PROGRAMMATIC_SCROLL_TOLERANCE_PX = 4
const SETTLE_REQUIRED_STABLE_FRAMES = 2
const SETTLE_MAX_FRAME_CHECKS = 8

interface InstantScrollIntent {
  sequence: number
  top: number
}

interface SmoothScrollIntent {
  target: number
  last: number
  direction: -1 | 1
}

function consumeInstantScrollIntent(intents: InstantScrollIntent[], top: number): boolean {
  for (let index = intents.length - 1; index >= 0; index -= 1) {
    const intent = intents[index]
    if (intent && Math.abs(intent.top - top) <= PROGRAMMATIC_SCROLL_TOLERANCE_PX) {
      intents.splice(0, index + 1)
      return true
    }
  }
  return false
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
  | 'follow.settle.start'
  | 'follow.settle.tick'
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
  | 'stream-start'
  | 'stream-tail'
  | 'stream-settle-start'
  | 'user-follow-cancel'
  | 'visibility'

function scrollStateFromPosition(container: HTMLDivElement, threshold: number): ScrollState {
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
  return distanceFromBottom <= threshold ? 'follow' : 'pinned'
}

function bottomScrollTop(container: HTMLDivElement): number {
  return Math.max(0, container.scrollHeight - container.clientHeight)
}

function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

// A scroll container with two independent auto-scroll behaviors:
//
//   - Opening a chat always positions at the bottom before paint. The chat
//     appears at the branch leaf with no animated jump.
//
//   - autoScrollOnStream + streamActive: while a stream is in flight and
//     the user is already at the bottom, keep new tokens in view as they
//     arrive. Scrolling up mid-stream flips to `pinned` and the stream
//     stops chasing. The stream setting never blocks the open-time leaf jump.
//
// ResizeObserver tracks content-growth changes from child-only stream renders,
// while a bottom sentinel and direct scroll listener keep wheel-driven scrolls
// honest when the container position changes before observers report.
export const ScrollRegion = forwardRef<ScrollRegionHandle, ScrollRegionProps>(function ScrollRegion(
  {
    children,
    pinThresholdPx,
    onStateChange,
    autoScrollOnStream = true,
    streamActive = false,
    resetKey = null,
    streamFollowKey = null,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // Start in `follow`: an empty or non-overflowing transcript is already
  // at its leaf. Overflow measurement below flips to `pinned` when needed.
  const [state, setState] = useState<ScrollState>('follow')
  const stateRef = useRef<ScrollState>(state)
  const pendingStateRef = useRef<ScrollState | null>(null)
  const statePublicationScheduledRef = useRef(false)
  const mountedRef = useRef(true)
  stateRef.current = state
  const followIntentRef = useRef(true)
  const didOpenRef = useRef(false)
  const resetKeyRef = useRef(resetKey)
  const followFrameRef = useRef<number | null>(null)
  const observerFrameRef = useRef<number | null>(null)
  const observerSignalsRef = useRef({ resize: false, mutation: false })
  const settleCheckFrameRef = useRef<number | null>(null)
  const settleFollowPendingRef = useRef(false)
  const settleLastHeightRef = useRef<number | null>(null)
  const settleStableFramesRef = useRef(0)
  const settleFrameChecksRef = useRef(0)
  const userScrollIntentUntilRef = useRef(0)
  const lastNativeScrollTopRef = useRef<number | null>(null)
  const instantScrollIntentsRef = useRef<InstantScrollIntent[]>([])
  const instantScrollSequenceRef = useRef(0)
  const instantScrollRevisionRef = useRef(0)
  const instantScrollCleanupFrameRef = useRef<number | null>(null)
  const streamTailLayoutScrollAllowanceRef = useRef(false)
  const smoothScrollIntentRef = useRef<SmoothScrollIntent | null>(null)
  const thresholdRef = useRef(pinThresholdPx ?? DEFAULT_THRESHOLD_PX)
  const autoScrollOnStreamRef = useRef(autoScrollOnStream)
  const streamActiveRef = useRef(streamActive)
  const previousStreamActiveRef = useRef(streamActive)
  const streamFollowKeyRef = useRef(streamFollowKey)
  thresholdRef.current = pinThresholdPx ?? DEFAULT_THRESHOLD_PX
  autoScrollOnStreamRef.current = autoScrollOnStream
  streamActiveRef.current = streamActive

  const debugScroll = useCallback(
    (event: ScrollDebugEvent, details: Record<string, unknown> = {}) => {
      if (!hasScrollDebugSink()) return
      const container = containerRef.current
      const timestamp = nowMs()
      logScrollDebug(event, {
        resetKey,
        state: stateRef.current,
        followIntent: followIntentRef.current,
        didOpen: didOpenRef.current,
        streamActive: streamActiveRef.current,
        autoScrollOnStream: autoScrollOnStreamRef.current,
        userScrollIntentMsRemaining: Math.max(0, userScrollIntentUntilRef.current - timestamp),
        instantScrollIntents: instantScrollIntentsRef.current.length,
        streamTailLayoutScrollAllowance: streamTailLayoutScrollAllowanceRef.current,
        smoothScrollIntent: smoothScrollIntentRef.current,
        settlePending: settleFollowPendingRef.current,
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
      })
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
    (next: ScrollState, reason = 'unknown') => {
      const previous = stateRef.current
      stateRef.current = next
      if (previous !== next) debugScroll('state', { from: previous, to: next, reason })
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
    instantScrollIntentsRef.current = []
    instantScrollRevisionRef.current += 1
    if (instantScrollCleanupFrameRef.current !== null) {
      cancelAnimationFrame(instantScrollCleanupFrameRef.current)
      instantScrollCleanupFrameRef.current = null
    }
  }, [])

  const clearProgrammaticScrollIntents = useCallback(() => {
    clearInstantScrollIntents()
    streamTailLayoutScrollAllowanceRef.current = false
    smoothScrollIntentRef.current = null
  }, [clearInstantScrollIntents])

  const scheduleInstantScrollIntentCleanup: () => void = useCallback(() => {
    if (instantScrollCleanupFrameRef.current !== null) return
    const scheduledRevision = instantScrollRevisionRef.current
    instantScrollCleanupFrameRef.current = requestAnimationFrame(() => {
      instantScrollCleanupFrameRef.current = null
      if (
        scheduledRevision !== instantScrollRevisionRef.current &&
        instantScrollIntentsRef.current.length > 0
      ) {
        scheduleInstantScrollIntentCleanup()
        return
      }
      instantScrollIntentsRef.current = []
    })
  }, [])

  const recordInstantScrollIntent = useCallback(
    (top: number) => {
      const sequence = instantScrollSequenceRef.current + 1
      instantScrollSequenceRef.current = sequence
      instantScrollIntentsRef.current.push({ sequence, top })
      instantScrollRevisionRef.current += 1
      scheduleInstantScrollIntentCleanup()
    },
    [scheduleInstantScrollIntentCleanup],
  )

  const scrollToBottomNow = useCallback(
    (opts?: { smooth?: boolean; reason?: string }) => {
      const container = containerRef.current
      if (!container) return
      const smooth = opts?.smooth ?? false
      const top = bottomScrollTop(container)
      debugScroll('scroll.to-bottom', {
        reason: opts?.reason ?? 'unknown',
        smooth,
        targetTop: top,
      })
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
        smoothScrollIntentRef.current = null
        const before = container.scrollTop
        container.scrollTop = top
        const actual = container.scrollTop
        lastNativeScrollTopRef.current = actual
        if (Math.abs(actual - before) > 0.5) recordInstantScrollIntent(actual)
      } else {
        smoothScrollIntentRef.current = null
      }
      followIntentRef.current = true
      setScrollStateNow('follow', opts?.reason ?? 'scroll.to-bottom')
    },
    [clearInstantScrollIntents, debugScroll, recordInstantScrollIntent, setScrollStateNow],
  )

  const shouldFollowContentGrowth = useCallback(() => {
    if (!followIntentRef.current) return false
    if (streamActiveRef.current) return autoScrollOnStreamRef.current
    return settleFollowPendingRef.current || stateRef.current === 'follow'
  }, [])

  const clearFollowSettle = useCallback(() => {
    settleFollowPendingRef.current = false
    streamTailLayoutScrollAllowanceRef.current = false
    settleLastHeightRef.current = null
    settleStableFramesRef.current = 0
    settleFrameChecksRef.current = 0
    if (settleCheckFrameRef.current !== null) {
      cancelAnimationFrame(settleCheckFrameRef.current)
      settleCheckFrameRef.current = null
    }
  }, [])

  const scheduleFollowScroll = useCallback(() => {
    if (followFrameRef.current !== null) return
    debugScroll('follow.schedule')
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null
      if (!shouldFollowContentGrowth()) return
      debugScroll('follow.scheduled-scroll')
      scrollToBottomNow({ smooth: false, reason: 'scheduled-follow' })
    })
  }, [debugScroll, scrollToBottomNow, shouldFollowContentGrowth])

  const scheduleSettleCheck = useCallback(
    (reason = 'stream') => {
      if (settleCheckFrameRef.current !== null) return
      const check = () => {
        settleCheckFrameRef.current = null
        if (!settleFollowPendingRef.current) return
        const container = containerRef.current
        if (!container) {
          clearFollowSettle()
          return
        }
        const height = container.scrollHeight
        const stable = settleLastHeightRef.current === height
        settleLastHeightRef.current = height
        settleStableFramesRef.current = stable ? settleStableFramesRef.current + 1 : 0
        settleFrameChecksRef.current += 1
        debugScroll('follow.settle.tick', {
          reason,
          height,
          stableFrames: settleStableFramesRef.current,
          frameChecks: settleFrameChecksRef.current,
        })
        if (
          settleStableFramesRef.current >= SETTLE_REQUIRED_STABLE_FRAMES ||
          settleFrameChecksRef.current >= SETTLE_MAX_FRAME_CHECKS
        ) {
          clearFollowSettle()
          return
        }
        scheduleFollowScroll()
        settleCheckFrameRef.current = requestAnimationFrame(check)
      }
      settleCheckFrameRef.current = requestAnimationFrame(check)
    },
    [clearFollowSettle, debugScroll, scheduleFollowScroll],
  )

  const startFollowSettle = useCallback(
    (reason = 'stream') => {
      clearFollowSettle()
      settleFollowPendingRef.current = true
      debugScroll('follow.settle.start', { reason })
      scheduleFollowScroll()
      scheduleSettleCheck(reason)
    },
    [clearFollowSettle, debugScroll, scheduleFollowScroll, scheduleSettleCheck],
  )

  const updateFromScrollPosition = useCallback(
    (source: PositionSource) => {
      const container = containerRef.current
      if (!container) return
      const previousNativeScrollTop = lastNativeScrollTopRef.current
      const next = scrollStateFromPosition(container, thresholdRef.current)
      const stationaryNativeScroll =
        source === 'scroll' &&
        previousNativeScrollTop !== null &&
        Math.abs(previousNativeScrollTop - container.scrollTop) <= 0.5
      if (source === 'scroll') lastNativeScrollTopRef.current = container.scrollTop
      debugScroll('position', { source, next, stationaryNativeScroll })
      let programmaticScroll = false
      if (source === 'scroll') {
        const instantMatched = consumeInstantScrollIntent(
          instantScrollIntentsRef.current,
          container.scrollTop,
        )
        if (instantMatched) {
          instantScrollRevisionRef.current += 1
          programmaticScroll = true
        } else if (smoothScrollIntentRef.current) {
          const smooth = advanceSmoothScrollIntent(
            smoothScrollIntentRef.current,
            container.scrollTop,
          )
          smoothScrollIntentRef.current = smooth.next
          programmaticScroll = smooth.programmatic
        }
      }
      if (next === 'follow') {
        followIntentRef.current = true
        setScrollStateNow('follow', source)
        return
      }
      const timestamp = nowMs()
      const userScrollIntentActive = timestamp <= userScrollIntentUntilRef.current
      const streamTailLayoutScroll =
        source === 'scroll' &&
        !programmaticScroll &&
        streamTailLayoutScrollAllowanceRef.current &&
        streamActiveRef.current &&
        settleFollowPendingRef.current &&
        previousNativeScrollTop !== null &&
        container.scrollTop < previousNativeScrollTop - PROGRAMMATIC_SCROLL_TOLERANCE_PX &&
        !userScrollIntentActive
      if (streamTailLayoutScroll) streamTailLayoutScrollAllowanceRef.current = false
      if (
        programmaticScroll ||
        streamTailLayoutScroll ||
        (stationaryNativeScroll && !userScrollIntentActive)
      ) {
        if (shouldFollowContentGrowth() && !userScrollIntentActive) scheduleFollowScroll()
        return
      }
      if (source === 'scroll') {
        followIntentRef.current = false
        clearProgrammaticScrollIntents()
        clearFollowSettle()
        debugScroll('user-follow-cancel', { event: 'native-scroll' })
        setScrollStateNow('pinned', source)
        return
      }
      if (shouldFollowContentGrowth() && !userScrollIntentActive) {
        scheduleFollowScroll()
        return
      }
      followIntentRef.current = false
      setScrollStateNow('pinned', source)
    },
    [
      clearFollowSettle,
      clearProgrammaticScrollIntents,
      debugScroll,
      scheduleFollowScroll,
      setScrollStateNow,
      shouldFollowContentGrowth,
    ],
  )

  const completeOpenScrollIfReady = useCallback(() => {
    const container = containerRef.current
    if (!container || didOpenRef.current) return false
    // No overflow yet (empty, still loading, or short transcript). Keep the
    // latch open so the first real overflow can still land at the leaf.
    if (container.scrollHeight <= container.clientHeight) {
      followIntentRef.current = true
      debugScroll('open.wait')
      setScrollStateNow('follow', 'open.wait')
      return false
    }
    didOpenRef.current = true
    debugScroll('open.bottom')
    scrollToBottomNow({ smooth: false, reason: 'open' })
    startFollowSettle('open')
    return true
  }, [debugScroll, scrollToBottomNow, setScrollStateNow, startFollowSettle])

  // Open-time jump. The reset happens in the same layout pass as the
  // measurement, so a reused scroll container can't carry the previous chat's
  // "already opened" latch into the new chat.
  useLayoutEffect(() => {
    if (!Object.is(resetKeyRef.current, resetKey)) {
      debugScroll('reset-key', { from: resetKeyRef.current, to: resetKey })
      resetKeyRef.current = resetKey
      didOpenRef.current = false
      followIntentRef.current = true
      clearProgrammaticScrollIntents()
      clearFollowSettle()
    }
    if (completeOpenScrollIfReady()) return
    updateFromScrollPosition('layout')
  })

  // IntersectionObserver tracks whether the sentinel is visible.
  // Settings don't filter the signal — `state` always reflects actual
  // scroll position, so the sibling "Jump to latest" chip stays
  // accurate regardless of auto-scroll prefs.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const container = containerRef.current
    const sentinel = sentinelRef.current
    if (!container || !sentinel) return
    const threshold = pinThresholdPx ?? DEFAULT_THRESHOLD_PX
    const observer = new IntersectionObserver(
      () => {
        debugScroll('observer')
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
  }, [pinThresholdPx, completeOpenScrollIfReady, debugScroll, updateFromScrollPosition])

  // Live stream snapshots rerender individual Message rows through Zustand;
  // the ScrollRegion parent does not necessarily rerender per token. Resize
  // and mutation signals cover different browser/layout paths, but both feed
  // one reconciliation per animation frame.
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const scheduleReconciliation = (source: 'resize' | 'mutation') => {
      observerSignalsRef.current[source] = true
      if (observerFrameRef.current !== null) return
      observerFrameRef.current = requestAnimationFrame(() => {
        observerFrameRef.current = null
        const signals = observerSignalsRef.current
        observerSignalsRef.current = { resize: false, mutation: false }
        if (signals.resize) debugScroll('resize')
        if (signals.mutation) debugScroll('mutation')
        if (completeOpenScrollIfReady()) return
        if (shouldFollowContentGrowth()) {
          scheduleFollowScroll()
          return
        }
        updateFromScrollPosition('resize')
      })
    }

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => scheduleReconciliation('resize'))
    resizeObserver?.observe(content)
    const mutationObserver =
      typeof MutationObserver === 'undefined'
        ? undefined
        : new MutationObserver(() => scheduleReconciliation('mutation'))
    mutationObserver?.observe(content, {
      childList: true,
      characterData: true,
      subtree: true,
    })

    return () => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      observerSignalsRef.current = { resize: false, mutation: false }
      if (observerFrameRef.current !== null) {
        cancelAnimationFrame(observerFrameRef.current)
        observerFrameRef.current = null
      }
    }
  }, [
    completeOpenScrollIfReady,
    debugScroll,
    scheduleFollowScroll,
    shouldFollowContentGrowth,
    updateFromScrollPosition,
  ])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const markUserScrollIntent = (event: 'wheel' | 'touchmove') => {
      userScrollIntentUntilRef.current = nowMs() + USER_SCROLL_INTENT_MS
      clearProgrammaticScrollIntents()
      if (followIntentRef.current) {
        followIntentRef.current = false
        clearFollowSettle()
        debugScroll('user-follow-cancel', { event })
      }
      debugScroll(event)
    }
    const onScroll = () => {
      debugScroll('native-scroll')
      updateFromScrollPosition('scroll')
    }
    const onScrollEnd = () => {
      smoothScrollIntentRef.current = null
    }
    const onWheel = () => markUserScrollIntent('wheel')
    const onTouchMove = () => markUserScrollIntent('touchmove')
    container.addEventListener('wheel', onWheel, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: true })
    container.addEventListener('scroll', onScroll, { passive: true })
    container.addEventListener('scrollend', onScrollEnd, { passive: true })
    return () => {
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('scroll', onScroll)
      container.removeEventListener('scrollend', onScrollEnd)
    }
  }, [clearFollowSettle, clearProgrammaticScrollIntents, debugScroll, updateFromScrollPosition])

  useLayoutEffect(() => {
    if (!autoScrollOnStream || !streamActive || !followIntentRef.current) return
    debugScroll('stream-start')
    scrollToBottomNow({ smooth: false, reason: 'stream-start' })
  }, [autoScrollOnStream, debugScroll, streamActive, scrollToBottomNow])

  useLayoutEffect(() => {
    if (Object.is(streamFollowKeyRef.current, streamFollowKey)) return
    debugScroll('stream-tail', { from: streamFollowKeyRef.current, to: streamFollowKey })
    streamFollowKeyRef.current = streamFollowKey
    if (!autoScrollOnStream || !streamActive || !followIntentRef.current) return
    scrollToBottomNow({ smooth: false, reason: 'stream-tail' })
    startFollowSettle('stream-tail')
    streamTailLayoutScrollAllowanceRef.current = true
  }, [
    autoScrollOnStream,
    debugScroll,
    scrollToBottomNow,
    startFollowSettle,
    streamActive,
    streamFollowKey,
  ])

  useLayoutEffect(() => {
    const wasActive = previousStreamActiveRef.current
    previousStreamActiveRef.current = streamActive
    if (streamActive || !wasActive) return
    streamTailLayoutScrollAllowanceRef.current = false
    if (!autoScrollOnStream) return
    if (!followIntentRef.current) return
    debugScroll('stream-settle-start')
    startFollowSettle('stream')
  }, [autoScrollOnStream, debugScroll, streamActive, startFollowSettle])

  const scrollToBottom = useCallback(
    (opts?: { smooth?: boolean }) => {
      scrollToBottomNow({ smooth: opts?.smooth ?? true })
    },
    [scrollToBottomNow],
  )

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom,
      getState: () => stateRef.current,
    }),
    [scrollToBottom],
  )

  // On tab-hide/tab-show, snap to bottom (no animation) if the
  // sentinel was visible before, keeps long streams legible when the
  // user returns.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      if (!followIntentRef.current) return
      debugScroll('visibility')
      scrollToBottom({ smooth: false })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [debugScroll, scrollToBottom])

  useEffect(() => {
    return () => {
      if (followFrameRef.current !== null) cancelAnimationFrame(followFrameRef.current)
      clearProgrammaticScrollIntents()
      clearFollowSettle()
    }
  }, [clearFollowSettle, clearProgrammaticScrollIntents])

  return (
    <div ref={containerRef} data-ui="scroll-region" data-scroll-state={state}>
      <div ref={contentRef} data-ui="scroll-content">
        {children}
        <div ref={sentinelRef} data-ui="scroll-sentinel" aria-hidden="true" />
      </div>
    </div>
  )
})
