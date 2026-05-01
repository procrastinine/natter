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
import { logScrollDebug } from '../../lib/debug-scroll'

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
}

export interface ScrollRegionHandle {
  scrollToBottom: (opts?: { smooth?: boolean }) => void
  getState: () => ScrollState
}

const DEFAULT_THRESHOLD_PX = 48
const USER_SCROLL_INTENT_MS = 750
const SETTLE_REQUIRED_STABLE_FRAMES = 2
const SETTLE_MAX_FRAME_CHECKS = 8

type PositionSource = 'layout' | 'observer' | 'resize' | 'scroll'
type ScrollDebugEvent =
  | 'state'
  | 'scroll.to-bottom'
  | 'follow.settle.start'
  | 'follow.settle.tick'
  | 'follow.schedule'
  | 'follow.scheduled-scroll'
  | 'follow.resize-scroll'
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
  stateRef.current = state
  const followIntentRef = useRef(true)
  const didOpenRef = useRef(false)
  const resetKeyRef = useRef(resetKey)
  const followFrameRef = useRef<number | null>(null)
  const settleCheckFrameRef = useRef<number | null>(null)
  const settleFollowPendingRef = useRef(false)
  const settleLastHeightRef = useRef<number | null>(null)
  const settleStableFramesRef = useRef(0)
  const settleFrameChecksRef = useRef(0)
  const userScrollIntentUntilRef = useRef(0)
  const thresholdRef = useRef(pinThresholdPx ?? DEFAULT_THRESHOLD_PX)
  const autoScrollOnStreamRef = useRef(autoScrollOnStream)
  const streamActiveRef = useRef(streamActive)
  const previousStreamActiveRef = useRef(streamActive)
  thresholdRef.current = pinThresholdPx ?? DEFAULT_THRESHOLD_PX
  autoScrollOnStreamRef.current = autoScrollOnStream
  streamActiveRef.current = streamActive

  const debugScroll = useCallback(
    (event: ScrollDebugEvent, details: Record<string, unknown> = {}) => {
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

  const setScrollStateNow = useCallback(
    (next: ScrollState, reason = 'unknown') => {
      const previous = stateRef.current
      stateRef.current = next
      if (previous !== next) debugScroll('state', { from: previous, to: next, reason })
      setState((prev) => (prev === next ? prev : next))
    },
    [debugScroll],
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
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({
          top,
          behavior: smooth ? 'smooth' : 'auto',
        })
      }
      if (!smooth) container.scrollTop = top
      followIntentRef.current = true
      setScrollStateNow('follow', opts?.reason ?? 'scroll.to-bottom')
    },
    [debugScroll, setScrollStateNow],
  )

  const shouldFollowContentGrowth = useCallback(() => {
    if (!followIntentRef.current) return false
    if (streamActiveRef.current) return autoScrollOnStreamRef.current
    return settleFollowPendingRef.current || stateRef.current === 'follow'
  }, [])

  const settleActive = useCallback(() => settleFollowPendingRef.current, [])

  const clearFollowSettle = useCallback(() => {
    settleFollowPendingRef.current = false
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
      const next = scrollStateFromPosition(container, thresholdRef.current)
      debugScroll('position', { source, next })
      if (next === 'follow') {
        followIntentRef.current = true
        setScrollStateNow('follow', source)
        return
      }
      const userScrollIntentActive = nowMs() <= userScrollIntentUntilRef.current
      if (shouldFollowContentGrowth() && !userScrollIntentActive) {
        scheduleFollowScroll()
        return
      }
      followIntentRef.current = false
      setScrollStateNow('pinned', source)
    },
    [debugScroll, scheduleFollowScroll, setScrollStateNow, shouldFollowContentGrowth],
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
  // the ScrollRegion parent does not necessarily rerender per token. Observing
  // content height is the durable signal that the bottom moved.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const content = contentRef.current
    if (!content) return
    const observer = new ResizeObserver(() => {
      debugScroll('resize')
      if (completeOpenScrollIfReady()) return
      if (shouldFollowContentGrowth()) {
        if (settleActive()) {
          debugScroll('follow.resize-scroll')
          scrollToBottomNow({ smooth: false, reason: 'resize-follow' })
        } else {
          scheduleFollowScroll()
        }
        return
      }
      updateFromScrollPosition('resize')
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [
    completeOpenScrollIfReady,
    debugScroll,
    scheduleFollowScroll,
    shouldFollowContentGrowth,
    scrollToBottomNow,
    settleActive,
    updateFromScrollPosition,
  ])

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const content = contentRef.current
    if (!content) return
    const observer = new MutationObserver(() => {
      debugScroll('mutation')
      if (completeOpenScrollIfReady()) return
      if (shouldFollowContentGrowth()) {
        if (settleActive()) {
          debugScroll('follow.resize-scroll', { source: 'mutation' })
          scrollToBottomNow({ smooth: false, reason: 'mutation-follow' })
        } else {
          scheduleFollowScroll()
        }
        return
      }
      updateFromScrollPosition('resize')
    })
    observer.observe(content, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    return () => observer.disconnect()
  }, [
    completeOpenScrollIfReady,
    debugScroll,
    scheduleFollowScroll,
    shouldFollowContentGrowth,
    scrollToBottomNow,
    settleActive,
    updateFromScrollPosition,
  ])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const markUserScrollIntent = (event: 'wheel' | 'touchmove') => {
      userScrollIntentUntilRef.current = nowMs() + USER_SCROLL_INTENT_MS
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
    const onWheel = () => markUserScrollIntent('wheel')
    const onTouchMove = () => markUserScrollIntent('touchmove')
    container.addEventListener('wheel', onWheel, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: true })
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('wheel', onWheel)
      container.removeEventListener('touchmove', onTouchMove)
      container.removeEventListener('scroll', onScroll)
    }
  }, [clearFollowSettle, debugScroll, updateFromScrollPosition])

  useLayoutEffect(() => {
    if (!autoScrollOnStream || !streamActive || !followIntentRef.current) return
    debugScroll('stream-start')
    scrollToBottomNow({ smooth: false, reason: 'stream-start' })
  }, [autoScrollOnStream, debugScroll, streamActive, scrollToBottomNow])

  useLayoutEffect(() => {
    const wasActive = previousStreamActiveRef.current
    previousStreamActiveRef.current = streamActive
    if (streamActive || !wasActive) return
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
      clearFollowSettle()
    }
  }, [clearFollowSettle])

  return (
    <div ref={containerRef} data-ui="scroll-region" data-scroll-state={state}>
      <div ref={contentRef} data-ui="scroll-content">
        {children}
        <div ref={sentinelRef} data-ui="scroll-sentinel" aria-hidden="true" />
      </div>
    </div>
  )
})
