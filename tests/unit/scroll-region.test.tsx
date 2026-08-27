import { act, fireEvent, render } from '@testing-library/react'
import { type ComponentProps, createRef, type ReactNode, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ScrollRegion,
  type ScrollRegionCommands,
  type ScrollRegionHandle,
  useScrollRegionCommands,
} from '../../src/ui/chat/ScrollRegion'

type RegionProps = Omit<ComponentProps<typeof ScrollRegion>, 'children'>
type ViewportTransition = Parameters<ScrollRegionHandle['prepareLayoutChange']>[0]

interface ResizeObserverFixture {
  callback: ResizeObserverCallback
  active: boolean
}

interface IntersectionObserverFixture {
  callback: IntersectionObserverCallback
  active: boolean
}

interface RegionFixture {
  region: HTMLElement
  ref: React.RefObject<ScrollRegionHandle | null>
  commands(): ScrollRegionCommands
  setClientHeight(value: number): void
  setHeight(value: number): void
  rerender(props?: Partial<RegionProps>, children?: ReactNode): void
}

function CommandProbe({
  onCommands,
}: {
  onCommands: (commands: ScrollRegionCommands | null) => void
}) {
  const commands = useScrollRegionCommands()
  useEffect(() => {
    onCommands(commands)
  }, [commands, onCommands])
  return (
    <article data-ui="message" data-message-id="command-target">
      content
    </article>
  )
}

describe('ScrollRegion continuity lease', () => {
  let resizeObservers: ResizeObserverFixture[]
  let intersectionObservers: IntersectionObserverFixture[]

  beforeEach(() => {
    resizeObservers = []
    intersectionObservers = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly fixture: ResizeObserverFixture

        constructor(callback: ResizeObserverCallback) {
          this.fixture = { callback, active: false }
          resizeObservers.push(this.fixture)
        }

        observe() {
          this.fixture.active = true
        }

        disconnect() {
          this.fixture.active = false
        }
      },
    )
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private readonly fixture: IntersectionObserverFixture

        constructor(callback: IntersectionObserverCallback) {
          this.fixture = { callback, active: false }
          intersectionObservers.push(this.fixture)
        }

        observe() {
          this.fixture.active = true
        }

        disconnect() {
          this.fixture.active = false
        }
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function deliverResize(): void {
    for (const observer of resizeObservers) {
      if (observer.active) observer.callback([], {} as ResizeObserver)
    }
  }

  function deliverIntersection(): void {
    for (const observer of intersectionObservers) {
      if (observer.active) observer.callback([], {} as IntersectionObserver)
    }
  }

  function setup(
    initialProps: Partial<RegionProps> = {},
    initialChildren: ReactNode = <div>content</div>,
  ): RegionFixture {
    const ref = createRef<ScrollRegionHandle>()
    const observedCommands: ScrollRegionCommands[] = []
    const recordCommands = (commands: ScrollRegionCommands | null) => {
      if (commands) observedCommands.push(commands)
    }
    let props: RegionProps = {
      resetKey: 'chat-a',
      selectionKey: 'tail-a',
      viewportRevision: 0,
      ...initialProps,
    }
    let children = initialChildren
    const view = () => (
      <ScrollRegion ref={ref} {...props}>
        <CommandProbe onCommands={recordCommands} />
        {children}
      </ScrollRegion>
    )
    const rendered = render(view())
    const region = rendered.container.querySelector<HTMLElement>('[data-ui="scroll-region"]')
    if (!region || !ref.current) throw new Error('ScrollRegion fixture did not mount')
    let clientHeight = 100
    let scrollHeight = 100
    Object.defineProperty(region, 'clientHeight', { configurable: true, get: () => clientHeight })
    Object.defineProperty(region, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(region, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    })
    region.getBoundingClientRect = () => rect({ top: 0, bottom: clientHeight })

    return {
      region,
      ref,
      commands() {
        const commands = observedCommands.at(-1)
        if (!commands) throw new Error('ScrollRegion commands did not mount')
        return commands
      },
      setClientHeight(value: number) {
        clientHeight = value
      },
      setHeight(value: number) {
        scrollHeight = value
      },
      rerender(nextProps = {}, nextChildren = children) {
        props = { ...props, ...nextProps }
        children = nextChildren
        rendered.rerender(view())
      },
    }
  }

  function acquireOpen(fixture: RegionFixture, height = 1_100): void {
    act(() => {
      fixture.setHeight(height)
      fixture.rerender()
    })
    expect(fixture.region.scrollTop).toBe(height - 100)
    act(() => deliverResize())
    expect(fixture.ref.current?.getState()).toBe('follow')
  }

  async function pinByWheel(fixture: RegionFixture, top = 200): Promise<void> {
    act(() => {
      fireEvent.wheel(fixture.region)
      fixture.region.scrollTop = top
      fireEvent.scroll(fixture.region)
    })
    expect(fixture.ref.current?.getState()).toBe('pinned')
    await act(nextTask)
    expect(fixture.region.dataset.scrollState).toBe('pinned')
  }

  it('acquires the finite open destination and preserves it across delayed layout', () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fixture.setHeight(1_400)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(1_300)
    expect(fixture.region.dataset.scrollState).toBe('follow')
  })

  it('does not mistake a geometry-coupled native clamp for user navigation', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    await act(() => fireEvent.scroll(fixture.region))

    act(() => {
      fixture.setHeight(900)
      fixture.region.scrollTop = 620
      fireEvent.scroll(fixture.region)
    })

    expect(fixture.ref.current?.getState()).toBe('follow')
    act(() => deliverResize())
    expect(fixture.region.scrollTop).toBe(800)
    expect(fixture.ref.current?.getState()).toBe('follow')
  })

  it('does not let a stationary native scroll notification erase bottom ownership', () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fireEvent.scroll(fixture.region)
      fireEvent.scroll(fixture.region)
      fixture.setHeight(1_400)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(1_300)
    expect(fixture.ref.current?.getState()).toBe('follow')
  })

  it('does not let an unclaimed follow-range native scroll erase bottom ownership', () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fixture.region.scrollTop = 997
      fireEvent.scroll(fixture.region)
      fixture.setHeight(1_400)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(1_300)
    expect(fixture.ref.current?.getState()).toBe('follow')
  })

  it('does not let an intermediate layout snapshot revoke follow ownership', () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fixture.setHeight(1_400)
      fixture.rerender()
    })

    expect(fixture.region.scrollTop).toBe(1_000)
    expect(fixture.ref.current?.getState()).toBe('follow')
    act(() => deliverResize())
    expect(fixture.region.scrollTop).toBe(1_300)
    expect(fixture.ref.current?.getState()).toBe('follow')
  })

  it('rebinds a same-chat workspace epoch without reopening or moving a pinned viewport', async () => {
    const fixture = setup({ workspaceEpoch: 0 })
    acquireOpen(fixture)
    const target = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
    if (!target) throw new Error('Continuity target did not mount')
    let documentBottom = 280
    target.getBoundingClientRect = () =>
      rect({
        top: documentBottom - 120 - fixture.region.scrollTop,
        bottom: documentBottom - fixture.region.scrollTop,
      })
    await pinByWheel(fixture)

    act(() => {
      fixture.rerender({ workspaceEpoch: 1 })
    })

    expect(fixture.region.scrollTop).toBe(200)
    expect(fixture.ref.current?.getState()).toBe('pinned')
    expect(
      fixture.ref.current?.prepareLayoutChange({
        workspaceEpoch: 1,
        chatId: 'chat-a',
        revision: 1,
        fromSelectionKey: 'tail-a',
        toSelectionKey: 'tail-a',
        kind: 'content',
      }),
    ).toEqual({ kind: 'prepared' })

    act(() => {
      documentBottom += 300
      fixture.setHeight(1_400)
      fixture.rerender({ viewportRevision: 1 })
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(500)
    expect(fixture.ref.current?.getState()).toBe('pinned')
  })

  it('acquires a reveal before its suffix arrives, then settles the ready destination', () => {
    const consumed = vi.fn()
    const fixture = setup({ onRevealClaimConsumed: consumed })
    acquireOpen(fixture)

    act(() => {
      fixture.rerender({
        revealClaimKey: 'save-send',
        revealClaimTargetMessageId: 'new-tail',
      })
    })
    expect(fixture.region.scrollTop).toBe(1_000)
    expect(consumed).not.toHaveBeenCalled()

    act(() => {
      fixture.setHeight(1_500)
      fixture.rerender(
        {
          selectionKey: 'new-tail',
        },
        <article data-ui="message" data-message-id="new-tail">
          replacement suffix
        </article>,
      )
      deliverResize()
    })
    expect(fixture.region.scrollTop).toBe(1_400)
    expect(consumed).toHaveBeenCalledTimes(1)

    act(() => {
      fixture.setHeight(1_800)
      deliverResize()
    })
    expect(fixture.region.scrollTop).toBe(1_700)
  })

  it('settles a retained reveal when its lazy surface becomes available', () => {
    const consumed = vi.fn()
    const fixture = setup({ onRevealClaimConsumed: consumed, revealSurfaceAvailable: false })
    acquireOpen(fixture)

    act(() => {
      fixture.rerender(
        {
          revealClaimKey: 'lazy-destination',
          revealClaimTargetMessageId: 'lazy-tail',
        },
        <article data-ui="message" data-message-id="lazy-tail">
          lazy destination
        </article>,
      )
    })
    expect(consumed).not.toHaveBeenCalled()

    act(() => {
      fixture.rerender({ revealSurfaceAvailable: true })
    })
    expect(consumed).toHaveBeenCalledTimes(1)
  })

  it('does not reacquire a pending reveal after explicit reading begins', async () => {
    const consumed = vi.fn()
    const fixture = setup({ onRevealClaimConsumed: consumed, revealSurfaceAvailable: false })
    acquireOpen(fixture)

    act(() => {
      fixture.rerender({
        revealClaimKey: 'lazy-destination',
        revealClaimTargetMessageId: 'lazy-tail',
      })
    })
    expect(consumed).not.toHaveBeenCalled()
    await pinByWheel(fixture, 700)

    act(() => {
      fixture.rerender(
        { revealSurfaceAvailable: true },
        <article data-ui="message" data-message-id="lazy-tail">
          lazy destination
        </article>,
      )
    })

    expect(consumed).toHaveBeenCalledTimes(1)
    expect(fixture.ref.current?.getState()).toBe('pinned')
  })

  it('owns an old-to-new reveal transition before the replacement suffix publishes', () => {
    const fixture = setup()
    acquireOpen(fixture)

    expect(
      fixture.ref.current?.prepareLayoutChange({
        workspaceEpoch: 0,
        chatId: 'chat-a',
        revision: 1,
        fromSelectionKey: 'tail-a',
        toSelectionKey: 'new-tail',
        kind: 'reveal',
        revealTargetMessageId: 'new-tail',
      }),
    ).toEqual({ kind: 'prepared' })

    act(() => {
      fixture.setHeight(1_500)
      fixture.rerender(
        {
          selectionKey: 'new-tail',
          viewportRevision: 1,
        },
        <article data-ui="message" data-message-id="new-tail">
          replacement suffix
        </article>,
      )
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(1_400)
    expect(fixture.ref.current?.getState()).toBe('follow')
  })

  it('continues following the selected stream through delayed content growth', () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fixture.setHeight(1_200)
      fixture.rerender({
        streamActive: true,
        autoScrollOnStream: true,
        streamFollowKey: 'stream-a',
        streamFollowTargetMessageId: 'tail-a',
      })
      deliverResize()
    })
    expect(fixture.region.scrollTop).toBe(1_100)

    act(() => {
      fixture.setHeight(1_500)
      deliverResize()
    })
    expect(fixture.region.scrollTop).toBe(1_400)
    expect(fixture.ref.current?.getState()).toBe('follow')
  })

  it('restores an unchanged stream claim when a retained viewport becomes active again', () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fixture.rerender({
        streamActive: true,
        autoScrollOnStream: true,
        streamFollowKey: 'stream-a',
        streamFollowTargetMessageId: 'tail-a',
      })
    })
    act(() => {
      fixture.rerender({ viewportActive: false })
    })
    act(() => {
      fixture.setHeight(1_500)
      fixture.region.scrollTop = 0
    })
    act(() => {
      fixture.rerender({ viewportActive: true })
    })

    expect(fixture.region.scrollTop).toBe(1_400)
    expect(fixture.ref.current?.getState()).toBe('follow')
    expect(fixture.region.dataset.scrollState).toBe('follow')
  })

  it('lands at the completed tail when a followed stream ends in a retained hidden viewport', () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fixture.rerender({
        streamActive: true,
        autoScrollOnStream: true,
        streamFollowKey: 'stream-a',
        streamFollowTargetMessageId: 'tail-a',
      })
    })
    act(() => {
      fixture.rerender({ viewportActive: false })
    })
    act(() => {
      fixture.setHeight(1_500)
      fixture.region.scrollTop = 0
      fixture.rerender({
        streamActive: false,
        streamFollowKey: null,
      })
    })
    act(() => {
      fixture.rerender({ viewportActive: true })
    })

    expect(fixture.region.scrollTop).toBe(1_400)
    expect(fixture.ref.current?.getState()).toBe('follow')
  })

  it('restores a pinned text position when a retained viewport becomes active again', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    const target = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
    if (!target) throw new Error('Retained viewport target did not mount')
    let documentBottom = 280
    target.getBoundingClientRect = () =>
      rect({
        top: documentBottom - 120 - fixture.region.scrollTop,
        bottom: documentBottom - fixture.region.scrollTop,
      })
    await pinByWheel(fixture)
    const targetBottom = target.getBoundingClientRect().bottom

    act(() => {
      fixture.rerender({ viewportActive: false })
    })
    act(() => {
      documentBottom += 300
      fixture.setHeight(1_400)
      fixture.region.scrollTop = 0
    })
    act(() => {
      fixture.rerender({ viewportActive: true })
    })

    expect(fixture.region.scrollTop).toBe(500)
    expect(target.getBoundingClientRect().bottom).toBe(targetBottom)
    expect(fixture.ref.current?.getState()).toBe('pinned')
    expect(fixture.region.dataset.scrollState).toBe('pinned')
  })

  it('hands simultaneous stream completion and leaf publication to one preserve lease', () => {
    const fixture = setup()
    acquireOpen(fixture, 2_000)
    const target = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
    if (!target) throw new Error('Stream terminal target did not mount')
    let documentBottom = 1_300
    target.getBoundingClientRect = () =>
      rect({
        top: documentBottom - 120 - fixture.region.scrollTop,
        bottom: documentBottom - fixture.region.scrollTop,
      })
    act(() => {
      fixture.rerender({
        streamActive: true,
        autoScrollOnStream: true,
        streamFollowKey: 'stream-a',
        streamFollowTargetMessageId: 'command-target',
      })
      deliverResize()
    })
    expect(fixture.region.scrollTop).toBe(1_200)

    act(() => {
      fixture.rerender({
        selectionKey: 'command-target',
        streamActive: false,
        streamFollowKey: null,
      })
      documentBottom += 240
      fixture.setHeight(2_240)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(1_440)
    expect(target.getBoundingClientRect().bottom).toBe(100)

    act(() => {
      documentBottom += 160
      fixture.setHeight(2_400)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(1_600)
    expect(target.getBoundingClientRect().bottom).toBe(100)
    expect(fixture.ref.current?.getState()).toBe('follow')
  })

  it('keeps bottom continuity when the viewport height changes', () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fixture.setClientHeight(60)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(1_040)
    expect(fixture.ref.current?.getState()).toBe('follow')
  })

  it('settles a smooth manual jump only after it acquires the bottom', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    await pinByWheel(fixture)
    const scrollTo = vi.fn()
    Object.defineProperty(fixture.region, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })

    act(() => fixture.ref.current?.scrollToBottom({ smooth: true }))
    expect(scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'smooth' })
    expect(fixture.ref.current?.getState()).toBe('follow')

    act(() => {
      fixture.region.scrollTop = 600
      fireEvent.scroll(fixture.region)
      fixture.region.scrollTop = 1_000
      fireEvent.scroll(fixture.region)
      fixture.region.dispatchEvent(new Event('scrollend'))
      fixture.setHeight(1_400)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(1_300)
    expect(fixture.ref.current?.getState()).toBe('follow')
  })

  it('canonicalizes an exact-bottom viewport when the native gesture settles', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    await pinByWheel(fixture)

    act(() => {
      fixture.region.scrollTop = 1_000
      fixture.region.dispatchEvent(new Event('scrollend'))
    })

    expect(fixture.ref.current?.getState()).toBe('follow')
    await act(nextTask)
    expect(fixture.region.dataset.scrollState).toBe('follow')
  })

  it.each([
    ['wheel', (region: HTMLElement) => fireEvent.wheel(region)],
    ['touch', (region: HTMLElement) => fireEvent.touchMove(region)],
    ['scrollbar', (region: HTMLElement) => fireEvent.pointerDown(region)],
    ['keyboard', (region: HTMLElement) => fireEvent.keyDown(region, { key: 'PageUp' })],
  ])('lets explicit %s input cancel stream ownership synchronously', async (_name, cancel) => {
    const fixture = setup({
      streamActive: true,
      autoScrollOnStream: true,
      streamFollowKey: 'stream-a',
    })
    acquireOpen(fixture)

    act(() => {
      cancel(fixture.region)
      fixture.region.scrollTop = 300
      fireEvent.scroll(fixture.region)
    })
    expect(fixture.ref.current?.getState()).toBe('pinned')
    await act(nextTask)

    act(() => {
      fixture.setHeight(1_500)
      deliverResize()
    })
    expect(fixture.region.scrollTop).toBe(300)
    expect(fixture.region.dataset.scrollState).toBe('pinned')
  })

  it('cancels upward wheel ownership before publishing an unmeasured position', async () => {
    const fixture = setup({
      streamActive: true,
      autoScrollOnStream: true,
      streamFollowKey: 'stream-a',
    })
    acquireOpen(fixture)

    act(() => {
      fireEvent.wheel(fixture.region, { deltaY: -320 })
    })

    expect(fixture.ref.current?.getState()).toBe('follow')
    act(() => {
      fixture.setHeight(1_400)
      deliverResize()
    })
    expect(fixture.region.scrollTop).toBe(1_000)
    await act(nextTask)
    expect(fixture.ref.current?.getState()).toBe('pinned')
  })

  it('holds a pinned near-bottom state until exact bottom is reacquired', async () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fireEvent.wheel(fixture.region, { deltaY: -80 })
      fixture.region.scrollTop = 975
      fireEvent.scroll(fixture.region)
      fixture.region.scrollTop = 990
      fireEvent.scroll(fixture.region)
    })

    await act(nextTask)
    expect(fixture.ref.current?.getState()).toBe('pinned')
    expect(fixture.region.dataset.scrollState).toBe('pinned')

    act(() => {
      fixture.region.scrollTop = 997
      fireEvent.scroll(fixture.region)
    })

    expect(fixture.ref.current?.getState()).toBe('follow')
    await act(nextTask)
    expect(fixture.region.dataset.scrollState).toBe('follow')

    act(() => {
      fixture.setHeight(1_400)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(997)
    await act(nextTask)
    expect(fixture.ref.current?.getState()).toBe('pinned')
  })

  it('retains a one-pixel upward reading position before delayed layout grows', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    const target = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
    if (!target) throw new Error('Near-bottom anchor target did not mount')
    let documentBottom = 1_070
    target.getBoundingClientRect = () =>
      rect({
        top: documentBottom - 120 - fixture.region.scrollTop,
        bottom: documentBottom - fixture.region.scrollTop,
      })

    act(() => {
      fireEvent.wheel(fixture.region, { deltaY: -1 })
      fixture.region.scrollTop = 999
      fireEvent.scroll(fixture.region)
    })
    const anchorBottom = target.getBoundingClientRect().bottom
    expect(fixture.commands().getLayoutAnchorMessageId()).toBe('command-target')
    expect(fixture.ref.current?.getState()).toBe('pinned')
    act(() => {
      fixture.region.dispatchEvent(new Event('scrollend'))
    })

    act(() => {
      documentBottom += 137
      fixture.setHeight(1_237)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(1_136)
    expect(target.getBoundingClientRect().bottom).toBe(anchorBottom)
    expect(fixture.ref.current?.getState()).toBe('pinned')
    await act(nextTask)
    expect(fixture.region.dataset.scrollState).toBe('pinned')
  })

  it('reacquires stream ownership at exact bottom and follows later growth', async () => {
    const fixture = setup({
      streamActive: true,
      autoScrollOnStream: true,
      streamFollowKey: 'stream-a',
    })
    acquireOpen(fixture)

    await pinByWheel(fixture, 900)
    act(() => {
      fixture.region.scrollTop = 1_000
      fireEvent.scroll(fixture.region)
    })
    expect(fixture.ref.current?.getState()).toBe('follow')

    act(() => {
      fixture.setHeight(1_400)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(1_300)
    expect(fixture.ref.current?.getState()).toBe('follow')
    await act(nextTask)
    expect(fixture.region.dataset.scrollState).toBe('follow')
  })

  it('does not let an observer relabel a pinned continuity lease as follow', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    await pinByWheel(fixture, 900)

    act(() => deliverResize())

    expect(fixture.ref.current?.getState()).toBe('pinned')
    await act(nextTask)
    expect(fixture.region.dataset.scrollState).toBe('pinned')
  })

  it.each(['intersection', 'resize'] as const)(
    'keeps pinned ownership when the %s observer records a terminal clamp before its native scroll',
    async (firstObserver) => {
      const fixture = setup({
        streamActive: true,
        autoScrollOnStream: true,
        streamFollowKey: 'stream-a',
      })
      const target = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
      if (!target) throw new Error('Terminal collapse anchor target did not mount')
      target.getBoundingClientRect = () =>
        rect({
          top: 2_420 - fixture.region.scrollTop,
          bottom: 2_540 - fixture.region.scrollTop,
        })
      acquireOpen(fixture, 3_000)
      await pinByWheel(fixture, 2_500)
      act(() => {
        fixture.region.dispatchEvent(new Event('scrollend'))
      })

      act(() => {
        fixture.setHeight(1_181)
        fixture.region.scrollTop = 1_081
        fixture.rerender({ streamActive: false })
        if (firstObserver === 'intersection') deliverIntersection()
        else deliverResize()
        fireEvent.scroll(fixture.region)
        if (firstObserver === 'intersection') deliverResize()
        else deliverIntersection()
      })

      expect(fixture.region.scrollTop).toBe(1_081)
      expect(fixture.ref.current?.getState()).toBe('pinned')
      await act(nextTask)
      expect(fixture.region.dataset.scrollState).toBe('pinned')
    },
  )

  it('clears a stale pinned control when layout places the viewport at bottom', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    await pinByWheel(fixture, 900)

    act(() => {
      fixture.setHeight(1_000)
      deliverResize()
    })

    expect(fixture.ref.current?.getState()).toBe('follow')
    await act(nextTask)
    expect(fixture.region.dataset.scrollState).toBe('follow')
  })

  it('does not let delayed open acquisition reclaim a stream cancelled by the user', async () => {
    const fixture = setup({
      streamActive: true,
      autoScrollOnStream: true,
      streamFollowKey: 'stream-a',
    })

    act(() => {
      fireEvent.wheel(fixture.region, { deltaY: -320 })
      fixture.setHeight(1_500)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(0)
    await act(nextTask)
    expect(fixture.ref.current?.getState()).toBe('pinned')
    expect(fixture.region.dataset.scrollState).toBe('pinned')
  })

  it('pins an unmatched native scroll even while programmatic intents are pending', async () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fixture.region.scrollTop = 125
      fireEvent.scroll(fixture.region)
    })
    expect(fixture.ref.current?.getState()).toBe('pinned')
    await act(nextTask)
    expect(fixture.region.dataset.scrollState).toBe('pinned')
  })

  it('pins a native jump to the pre-assignment position after a coalesced bottom event', async () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fixture.region.scrollTop = 0
      fireEvent.scroll(fixture.region)
    })
    expect(fixture.ref.current?.getState()).toBe('pinned')
    await act(nextTask)
    expect(fixture.region.dataset.scrollState).toBe('pinned')
  })

  it('pins native movement even when layout observes it before the scroll event', async () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fixture.region.scrollTop = 125
      fixture.rerender({}, <div>layout observed the moved viewport</div>)
      fireEvent.scroll(fixture.region)
    })
    expect(fixture.region.scrollTop).toBe(125)
    expect(fixture.ref.current?.getState()).toBe('pinned')
    await act(nextTask)
    expect(fixture.region.dataset.scrollState).toBe('pinned')
  })

  it('adopts native movement before a pending resize correction can restore follow', async () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fixture.region.scrollTop = 125
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(125)
    expect(fixture.ref.current?.getState()).toBe('pinned')
    await act(nextTask)
    expect(fixture.region.dataset.scrollState).toBe('pinned')
  })

  it('does not treat a stationary Firefox content-growth scroll event as user intent', async () => {
    const fixture = setup({ streamActive: true, autoScrollOnStream: true })

    act(() => deliverResize())
    act(() => {
      fixture.setHeight(300)
      fixture.rerender({}, <div>grown content</div>)
      fireEvent.scroll(fixture.region)
    })

    expect(fixture.region.scrollTop).toBe(200)
    await act(nextTask)
    expect(fixture.ref.current?.getState()).toBe('follow')
  })

  it('pins a native jump that collides with an obsolete instant-scroll target', async () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fixture.setHeight(700)
      fixture.ref.current?.scrollToBottom({ smooth: false })
      fixture.setHeight(1_100)
      fixture.ref.current?.scrollToBottom({ smooth: false })
      fixture.region.scrollTop = 600
      fireEvent.scroll(fixture.region)
    })
    expect(fixture.ref.current?.getState()).toBe('pinned')
    await act(nextTask)
    expect(fixture.region.dataset.scrollState).toBe('pinned')
  })

  it('accepts a coalesced instant event at the newest recorded target', () => {
    const fixture = setup()
    acquireOpen(fixture)

    act(() => {
      fixture.setHeight(700)
      fixture.ref.current?.scrollToBottom({ smooth: false })
      fixture.setHeight(1_100)
      fixture.ref.current?.scrollToBottom({ smooth: false })
      fixture.region.scrollTop = 1_000
      fireEvent.scroll(fixture.region)
    })

    expect(fixture.ref.current?.getState()).toBe('follow')
  })

  it('keeps the command port stable across reactive follow-state changes', async () => {
    const observed: ScrollRegionCommands[] = []
    const record = (commands: ScrollRegionCommands | null) => {
      if (commands) observed.push(commands)
    }
    const fixture = setup({}, <CommandProbe onCommands={record} />)
    acquireOpen(fixture)
    expect(observed).toHaveLength(1)

    await pinByWheel(fixture)

    expect(observed).toHaveLength(1)
  })

  it('advances the scroll-ownership revision only for user input', () => {
    const fixture = setup()
    acquireOpen(fixture)
    const commands = fixture.commands()
    const initialRevision = commands.getUserScrollRevision()

    act(() => {
      fixture.setHeight(700)
      fixture.ref.current?.scrollToBottom({ smooth: false })
      deliverResize()
    })

    expect(commands.getUserScrollRevision()).toBe(initialRevision)

    fireEvent.wheel(fixture.region, { deltaY: -100 })

    expect(commands.getUserScrollRevision()).toBe(initialRevision + 1)
  })

  it('uses a prepared viewport revision to preserve a pinned message edge pre-paint', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    const target = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
    if (!target) throw new Error('Prepared transition target did not mount')
    let documentBottom = 280
    target.getBoundingClientRect = () =>
      rect({
        top: documentBottom - 120 - fixture.region.scrollTop,
        bottom: documentBottom - fixture.region.scrollTop,
      })
    await pinByWheel(fixture)

    const transition: ViewportTransition = {
      workspaceEpoch: 0,
      chatId: 'chat-a',
      revision: 1,
      fromSelectionKey: 'tail-a',
      toSelectionKey: 'tail-a',
      kind: 'prepend',
    }
    act(() => {
      fixture.ref.current?.prepareLayoutChange(transition)
      documentBottom += 300
      fixture.setHeight(1_400)
      fixture.rerender({ viewportRevision: 1 })
    })

    expect(fixture.region.scrollTop).toBe(500)
    expect(target.getBoundingClientRect().bottom).toBe(80)
    expect(fixture.ref.current?.getState()).toBe('pinned')
  })

  it('defers a prepared lease until its parent viewport revision publishes', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    const target = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
    if (!target) throw new Error('Deferred prepared target did not mount')
    let documentBottom = 280
    target.getBoundingClientRect = () =>
      rect({
        top: documentBottom - 120 - fixture.region.scrollTop,
        bottom: documentBottom - fixture.region.scrollTop,
      })
    await pinByWheel(fixture)

    const transition: ViewportTransition = {
      workspaceEpoch: 0,
      chatId: 'chat-a',
      revision: 1,
      fromSelectionKey: 'tail-a',
      toSelectionKey: 'tail-a',
      kind: 'prepend',
    }
    act(() => {
      expect(fixture.ref.current?.prepareLayoutChange(transition)).toEqual({ kind: 'prepared' })
      documentBottom += 300
      fixture.setHeight(1_400)
      expect(fixture.commands().reconcileLayoutAnchor()).toBe(false)
    })

    act(() => fixture.rerender({ viewportRevision: 1 }))

    expect(fixture.region.scrollTop).toBe(500)
    expect(target.getBoundingClientRect().bottom).toBe(80)
    expect(fixture.ref.current?.getState()).toBe('pinned')
  })

  it('rebases a prepared prepend to native wheel position before publication', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    const target = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
    if (!target) throw new Error('Prepared wheel target did not mount')
    let documentBottom = 1_050
    target.getBoundingClientRect = () =>
      rect({
        top: documentBottom - 120 - fixture.region.scrollTop,
        bottom: documentBottom - fixture.region.scrollTop,
      })
    const transition: ViewportTransition = {
      workspaceEpoch: 0,
      chatId: 'chat-a',
      revision: 1,
      fromSelectionKey: 'tail-a',
      toSelectionKey: 'tail-a',
      kind: 'prepend',
    }

    act(() => {
      expect(fixture.ref.current?.prepareLayoutChange(transition)).toEqual({ kind: 'prepared' })
      fireEvent.wheel(fixture.region, { deltaY: -180 })
      fixture.region.scrollTop = 820
      fireEvent.scroll(fixture.region)
    })
    await act(nextTask)
    expect(fixture.ref.current?.getState()).toBe('pinned')

    act(() => {
      documentBottom += 300
      fixture.setHeight(1_400)
      fixture.rerender({ viewportRevision: 1 })
    })

    expect(fixture.region.scrollTop).toBe(1_120)
    expect(target.getBoundingClientRect().bottom).toBe(230)
    expect(fixture.ref.current?.getState()).toBe('pinned')
  })

  it('ignores a prepared transition for a different selection authority', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    await pinByWheel(fixture)

    act(() => {
      fixture.ref.current?.prepareLayoutChange({
        workspaceEpoch: 0,
        chatId: 'chat-a',
        revision: 1,
        fromSelectionKey: 'other-tail',
        toSelectionKey: 'other-tail',
        kind: 'content',
      })
      fixture.setHeight(1_400)
      fixture.rerender({ viewportRevision: 1 })
    })

    expect(fixture.region.scrollTop).toBe(200)
    expect(fixture.ref.current?.getState()).toBe('pinned')
  })

  it('preserves an explicit layout anchor through delayed ResizeObserver geometry', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    const target = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
    if (!target) throw new Error('Layout anchor target did not mount')
    let documentBottom = 720
    target.getBoundingClientRect = () =>
      rect({
        top: documentBottom - 120 - fixture.region.scrollTop,
        bottom: documentBottom - fixture.region.scrollTop,
      })
    await pinByWheel(fixture)
    expect(fixture.commands().captureLayoutAnchor({ element: target, edge: 'bottom' })).toBe(true)

    act(() => {
      documentBottom += 300
      fixture.setHeight(1_400)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(500)
    expect(target.getBoundingClientRect().bottom).toBe(520)
    expect(fixture.ref.current?.getState()).toBe('pinned')
  })

  it('reconciles descendant content commits before delayed geometry delivery', async () => {
    const fixture = setup(
      {},
      <div data-ui="message-list" data-virtualized="false">
        <span data-ui="live-text">live output</span>
      </div>,
    )
    acquireOpen(fixture)
    const liveText = fixture.region.querySelector<HTMLElement>('[data-ui="live-text"]')
    if (!liveText) throw new Error('Live text did not mount')

    fixture.setHeight(1_190)
    liveText.textContent = 'expanded live output'
    await act(nextTask)

    expect(fixture.region.scrollTop).toBe(1_090)
    expect(fixture.region.dataset.scrollState).toBe('follow')
  })

  it('reconciles an estimate-based virtualizer offset against the exact text lease synchronously', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    const target = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
    if (!target) throw new Error('Virtualizer anchor target did not mount')
    let documentBottom = 720
    target.getBoundingClientRect = () =>
      rect({
        top: documentBottom - 120 - fixture.region.scrollTop,
        bottom: documentBottom - fixture.region.scrollTop,
      })
    await pinByWheel(fixture)
    expect(fixture.commands().captureLayoutAnchor({ element: target, edge: 'bottom' })).toBe(true)

    act(() => {
      documentBottom += 205_000
      fixture.setHeight(220_000)
      fixture.commands().applyVirtualizerOffset(2_400)
    })

    expect(fixture.region.scrollTop).toBe(205_200)
    expect(target.getBoundingClientRect().bottom).toBe(520)
    expect(fixture.ref.current?.getState()).toBe('pinned')
  })

  it('keeps layout ownership when measured geometry coalesces an unmatched native scroll', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    const target = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
    if (!target) throw new Error('Layout anchor target did not mount')
    let documentBottom = 720
    target.getBoundingClientRect = () =>
      rect({
        top: documentBottom - 120 - fixture.region.scrollTop,
        bottom: documentBottom - fixture.region.scrollTop,
      })
    await pinByWheel(fixture)
    expect(fixture.commands().captureLayoutAnchor({ element: target, edge: 'bottom' })).toBe(true)

    act(() => {
      documentBottom += 300
      fixture.setHeight(1_400)
      deliverResize()
      fixture.setHeight(1_450)
      fixture.region.scrollTop = 450
      fireEvent.scroll(fixture.region)
      documentBottom += 100
      fixture.setHeight(1_500)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(600)
    expect(target.getBoundingClientRect().bottom).toBe(520)
    expect(fixture.ref.current?.getState()).toBe('pinned')
  })

  it('does not let unrelated progressive content replace an owned text anchor', async () => {
    const fixture = setup(
      {},
      <article data-ui="message" data-message-id="unrelated-progressive-message">
        unrelated
      </article>,
    )
    acquireOpen(fixture)
    await pinByWheel(fixture)
    const target = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
    const unrelated = fixture.region.querySelector<HTMLElement>(
      '[data-message-id="unrelated-progressive-message"]',
    )
    if (!target || !unrelated) throw new Error('Progressive anchor fixtures did not mount')
    expect(fixture.commands().captureLayoutAnchor({ element: target })).toBe(true)

    expect(
      fixture.commands().captureLayoutAnchor({
        element: unrelated,
        edge: 'bottom',
        replaceExisting: false,
      }),
    ).toBe(false)
    expect(fixture.commands().getLayoutAnchorMessageId()).toBe('command-target')
  })

  it('re-resolves a replaced streaming text block without falling back to its message shell', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    const message = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
    if (!message) throw new Error('Streaming block message did not mount')
    let documentTop = 240
    const initialBlock = document.createElement('p')
    initialBlock.textContent = 'stable streamed prefix'
    initialBlock.getBoundingClientRect = () =>
      rect({
        top: documentTop - fixture.region.scrollTop,
        bottom: documentTop + 20 - fixture.region.scrollTop,
      })
    message.append(initialBlock)
    await pinByWheel(fixture)
    expect(fixture.commands().captureLayoutAnchor({ element: initialBlock })).toBe(true)

    const replacementBlock = document.createElement('p')
    replacementBlock.textContent = 'stable streamed prefix plus a new suffix'
    replacementBlock.getBoundingClientRect = () =>
      rect({
        top: documentTop - fixture.region.scrollTop,
        bottom: documentTop + 20 - fixture.region.scrollTop,
      })
    act(() => {
      initialBlock.replaceWith(replacementBlock)
      documentTop += 300
      fixture.setHeight(1_400)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(500)
    expect(replacementBlock.getBoundingClientRect().top).toBe(40)
    expect(fixture.ref.current?.getState()).toBe('pinned')
  })

  it('reveals the nearest message and preserves its viewport coordinate', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    await pinByWheel(fixture)
    const target = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
    if (!target) throw new Error('Reveal target did not mount')
    let documentBottom = 620
    target.getBoundingClientRect = () =>
      rect({
        top: documentBottom - 120 - fixture.region.scrollTop,
        bottom: documentBottom - fixture.region.scrollTop,
      })

    act(() => {
      expect(fixture.commands().revealNearest(target)).toBe(true)
    })
    expect(fixture.region.scrollTop).toBe(520)
    expect(target.getBoundingClientRect().bottom).toBe(100)

    act(() => {
      documentBottom += 200
      fixture.setHeight(1_300)
      deliverResize()
    })
    expect(fixture.region.scrollTop).toBe(720)
    expect(target.getBoundingClientRect().bottom).toBe(100)
  })

  it('gives an active text editor exclusive ownership against automatic layout scrolling', () => {
    const fixture = setup()
    acquireOpen(fixture)
    const scrollTo = vi.fn()
    Object.defineProperty(fixture.region, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })
    const release = fixture.commands().claimTextEditingViewport()
    const before = fixture.region.scrollTop

    act(() => {
      fixture.commands().preserveTextEditingViewport(() => {
        fixture.setHeight(1_500)
        fixture.region.scrollTop = 1_400
      })
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(before)
    expect(scrollTo).toHaveBeenCalledWith({ top: before, behavior: 'auto' })
    expect(fixture.ref.current?.getState()).toBe('pinned')

    act(() => {
      fixture.region.scrollTop = 640
      fireEvent.scroll(fixture.region)
    })
    expect(fixture.region.scrollTop).toBe(before)

    act(() => {
      fireEvent.wheel(fixture.region, { deltaY: -400 })
      fixture.region.scrollTop = 240
      fireEvent.scroll(fixture.region)
    })
    expect(fixture.region.scrollTop).toBe(240)
    expect(fixture.ref.current?.getState()).toBe('pinned')

    act(() => fixture.commands().scrollTextEditingViewportBy(160))
    expect(fixture.region.scrollTop).toBe(400)

    act(release)
  })

  it('uses ResizeObserver as the sole delayed-layout observer', async () => {
    const fixture = setup()
    acquireOpen(fixture)
    const target = fixture.region.querySelector<HTMLElement>('[data-message-id="command-target"]')
    if (!target) throw new Error('Delayed layout target did not mount')
    let documentBottom = 280
    target.getBoundingClientRect = () =>
      rect({
        top: documentBottom - 120 - fixture.region.scrollTop,
        bottom: documentBottom - fixture.region.scrollTop,
      })
    await pinByWheel(fixture)

    act(() => {
      documentBottom += 300
      fixture.setHeight(1_400)
      deliverResize()
    })

    expect(fixture.region.scrollTop).toBe(500)
    expect(target.getBoundingClientRect().bottom).toBe(80)
    expect(fixture.ref.current?.getState()).toBe('pinned')
  })
})

function rect({ top, bottom }: { top: number; bottom: number }): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 0,
    bottom,
    left: 0,
    width: 0,
    height: bottom - top,
    toJSON: () => ({}),
  }
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(undefined)
  })
}
