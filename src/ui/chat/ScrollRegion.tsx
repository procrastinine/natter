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

export type ScrollState = 'follow' | 'pinned'

interface ScrollRegionProps {
  children: ReactNode
  pinThresholdPx?: number
  // Notified whenever the follow/pinned state changes. Lets a sibling render
  // a "Jump to latest" affordance anchored to the main-pane viewport bottom
  // (rather than scrolling with the content inside the region).
  onStateChange?: (state: ScrollState) => void
  // One-shot: on mount (or after `resetKey` changes) jump the viewport to
  // the bottom so the chat opens already positioned at the leaf. Uses
  // useLayoutEffect + behavior: 'auto' — the scroll lands BEFORE paint so
  // there is no visible animation. When false, opens at the top.
  autoScrollOnOpen?: boolean
  // While `streamActive` is true AND the sentinel is currently visible
  // (user hasn't scrolled up), follow new tokens into view as they arrive.
  // When false, streams never move the viewport — user stays wherever they
  // are. Completely independent of `autoScrollOnOpen`.
  autoScrollOnStream?: boolean
  // Parent signals that a stream is currently in progress for the content
  // being rendered here. Stream-time follow only activates during this
  // window; outside it, content changes never move the scroll position
  // (chat switches, in-place edits, deletes all stay put).
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

function scrollStateFromPosition(container: HTMLDivElement, threshold: number): ScrollState {
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
  return distanceFromBottom <= threshold ? 'follow' : 'pinned'
}

// A scroll container with two independent auto-scroll behaviors:
//
//   - autoScrollOnOpen: on mount (or resetKey change), instantly position
//     at the bottom BEFORE paint. The chat just appears at the leaf — no
//     animation, no flash of "at top then jumps."
//
//   - autoScrollOnStream + streamActive: while a stream is in flight and
//     the user is already at the bottom, keep new tokens in view as they
//     arrive. Scrolling up mid-stream flips to `pinned` and the stream
//     stops chasing. These two settings don't leak into each other: the
//     stream setting never fires on open, and the open setting doesn't
//     influence stream-time behavior.
//
// A bottom sentinel plus IntersectionObserver tracks content-growth changes,
// while a throttled scroll listener keeps Firefox and wheel-driven scrolls
// honest when the container position changes before the observer reports.
export const ScrollRegion = forwardRef<ScrollRegionHandle, ScrollRegionProps>(function ScrollRegion(
  {
    children,
    pinThresholdPx,
    onStateChange,
    autoScrollOnOpen = true,
    autoScrollOnStream = true,
    streamActive = false,
    resetKey = null,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  // Always start in `pinned`. The IntersectionObserver promotes to
  // `follow` after paint if the sentinel is visible. Settings never
  // bias the initial value — this is what keeps stream auto-scroll
  // from accidentally firing on open.
  const [state, setState] = useState<ScrollState>('pinned')
  const stateRef = useRef<ScrollState>(state)
  stateRef.current = state
  useEffect(() => {
    onStateChange?.(state)
  }, [state, onStateChange])

  // Open-time jump. Fires once on mount (or after `resetKey` changes)
  // the first time the container has overflowing content. Uses
  // useLayoutEffect + behavior: 'auto' so the scroll position is set
  // before the browser paints — the chat renders already at the leaf.
  const didOpenRef = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the explicit reset signal for this ref.
  useEffect(() => {
    didOpenRef.current = false
  }, [resetKey])
  // biome-ignore lint/correctness/useExhaustiveDependencies: children changes are the content-load signal for measuring overflow.
  useLayoutEffect(() => {
    if (didOpenRef.current) return
    const container = containerRef.current
    if (!container) return
    // No content yet (empty or still loading). Wait for another render
    // so autoScrollOnOpen can apply once content arrives.
    if (container.scrollHeight <= container.clientHeight) return
    didOpenRef.current = true
    if (!autoScrollOnOpen) return
    container.scrollTo({ top: container.scrollHeight, behavior: 'auto' })
  }, [children, autoScrollOnOpen])

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
        setState(scrollStateFromPosition(container, threshold))
      },
      {
        root: container,
        rootMargin: `0px 0px ${threshold}px 0px`,
        threshold: 0,
      },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [pinThresholdPx])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const threshold = pinThresholdPx ?? DEFAULT_THRESHOLD_PX
    let frame: number | null = null
    const updateFromScrollPosition = () => {
      frame = null
      setState(scrollStateFromPosition(container, threshold))
    }
    const onScroll = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(updateFromScrollPosition)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', onScroll)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [pinThresholdPx])

  // Stream-time follow. Fires ONLY while a stream is active AND the
  // user is at the bottom. Chat switches, content loads, and in-place
  // edits don't trigger this because `streamActive` is false in those
  // cases — the scroll position stays put.
  // biome-ignore lint/correctness/useExhaustiveDependencies: children changes are the stream-content signal for follow scrolling.
  useEffect(() => {
    if (!autoScrollOnStream) return
    if (!streamActive) return
    if (state !== 'follow') return
    const container = containerRef.current
    if (!container) return
    const id = requestAnimationFrame(() => {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'auto',
      })
    })
    return () => cancelAnimationFrame(id)
  }, [state, children, autoScrollOnStream, streamActive])

  const scrollToBottom = useCallback((opts?: { smooth?: boolean }) => {
    const container = containerRef.current
    if (!container) return
    const smooth = opts?.smooth ?? true
    container.scrollTo({
      top: container.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    })
  }, [])

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
      if (stateRef.current !== 'follow') return
      scrollToBottom({ smooth: false })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [scrollToBottom])

  return (
    <div ref={containerRef} data-ui="scroll-region" data-scroll-state={state}>
      {children}
      <div ref={sentinelRef} data-ui="scroll-sentinel" aria-hidden="true" />
    </div>
  )
})
