import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type ScrollState = 'follow' | 'pinned'

export interface ScrollRegionProps {
  children: ReactNode
  pinThresholdPx?: number
  // Notified whenever the follow/pinned state changes. Lets a sibling render
  // a "Jump to latest" affordance anchored to the main-pane viewport bottom
  // (rather than scrolling with the content inside the region).
  onStateChange?: (state: ScrollState) => void
}

export interface ScrollRegionHandle {
  scrollToBottom: (opts?: { smooth?: boolean }) => void
  getState: () => ScrollState
}

const DEFAULT_THRESHOLD_PX = 48

// A scroll container that tracks two discrete states:
// - `follow`: user is at (or near) the bottom; new content auto-scrolls into view.
// - `pinned`: user scrolled up; new content does NOT yank them back.
// We do NOT listen to `scroll`; we use a sentinel at the bottom of the content
// tree plus IntersectionObserver so the work stays paint-budget cheap during
// streams. The sentinel's visibility drives the state transition.
export const ScrollRegion = forwardRef<ScrollRegionHandle, ScrollRegionProps>(
  function ScrollRegion({ children, pinThresholdPx, onStateChange }, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const sentinelRef = useRef<HTMLDivElement | null>(null)
    const [state, setState] = useState<ScrollState>('follow')
    const stateRef = useRef<ScrollState>('follow')
    stateRef.current = state
    useEffect(() => {
      onStateChange?.(state)
    }, [state, onStateChange])

    useEffect(() => {
      if (typeof IntersectionObserver === 'undefined') return
      const container = containerRef.current
      const sentinel = sentinelRef.current
      if (!container || !sentinel) return
      const threshold = pinThresholdPx ?? DEFAULT_THRESHOLD_PX
      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[0]
          if (!entry) return
          setState(entry.isIntersecting ? 'follow' : 'pinned')
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

    // During `follow`, auto-scroll the sentinel into view when new content
    // appears. We don't want to run this under `pinned` — that's the whole
    // point of pinning.
    useEffect(() => {
      if (state !== 'follow') return
      const container = containerRef.current
      if (!container) return
      const id = requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight
      })
      return () => cancelAnimationFrame(id)
    }, [state, children])

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

    // On tab-hide/tab-show we snap-to-bottom (no smooth animation) if state was
    // `follow` — keeps long streams legible when the user returns.
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
      <div
        ref={containerRef}
        data-ui="scroll-region"
        data-scroll-state={state}
      >
        {children}
        <div ref={sentinelRef} data-ui="scroll-sentinel" aria-hidden="true" />
      </div>
    )
  },
)
