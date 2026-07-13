import { act, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScrollRegion, type ScrollRegionHandle } from '../../src/ui/chat/ScrollRegion'

describe('ScrollRegion programmatic intent ledger', () => {
  let frameId = 0
  let frames: Array<{ id: number; callback: FrameRequestCallback }>

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameId += 1
      frames.push({ id: frameId, callback })
      return frameId
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames = frames.filter((frame) => frame.id !== id)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function setup() {
    const ref = createRef<ScrollRegionHandle>()
    const renderView = () => (
      <ScrollRegion ref={ref} streamActive autoScrollOnStream>
        <div>content</div>
      </ScrollRegion>
    )
    const { container, rerender } = render(renderView())
    const region = container.querySelector<HTMLElement>('[data-ui="scroll-region"]')
    if (!region || !ref.current) throw new Error('ScrollRegion fixture did not mount')
    let scrollHeight = 100
    Object.defineProperty(region, 'clientHeight', { configurable: true, get: () => 100 })
    Object.defineProperty(region, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    })
    Object.defineProperty(region, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 0,
    })
    scrollHeight = 200
    rerender(renderView())
    act(() => {
      while (frames.length > 0) runNextFrame()
      scrollHeight = 100
      ref.current?.scrollToBottom({ smooth: false })
      while (frames.length > 0) runNextFrame()
    })
    return {
      region,
      ref,
      setHeight(value: number) {
        scrollHeight = value
      },
      rerender,
    }
  }

  function runNextFrame(): void {
    const frame = frames.shift()
    if (frame) frame.callback(performance.now())
  }

  it('accepts delayed instant events in target order', () => {
    const { region, ref, setHeight } = setup()
    act(() => {
      setHeight(700)
      ref.current?.scrollToBottom({ smooth: false })
      setHeight(1100)
      ref.current?.scrollToBottom({ smooth: false })
      region.scrollTop = 600
      fireEvent.scroll(region)
    })
    expect(region.dataset.scrollState).toBe('follow')

    act(() => {
      region.scrollTop = 1000
      fireEvent.scroll(region)
    })
    expect(region.dataset.scrollState).toBe('follow')
  })

  it('accepts one coalesced event at the newest target', () => {
    const { region, ref, setHeight } = setup()
    act(() => {
      setHeight(700)
      ref.current?.scrollToBottom({ smooth: false })
      setHeight(1100)
      ref.current?.scrollToBottom({ smooth: false })
      region.scrollTop = 1000
      fireEvent.scroll(region)
    })
    expect(region.dataset.scrollState).toBe('follow')
  })

  it('pins an unmatched native scroll even while intents are pending', async () => {
    const { region, ref, setHeight } = setup()
    act(() => {
      setHeight(1100)
      ref.current?.scrollToBottom({ smooth: false })
      region.scrollTop = 125
      fireEvent.scroll(region)
    })
    expect(ref.current?.getState()).toBe('pinned')
    await act(nextTask)
    expect(region.dataset.scrollState).toBe('pinned')
  })

  it('pins a native jump back to the pre-assignment position when the bottom event was coalesced', async () => {
    const { region, ref, setHeight } = setup()
    act(() => {
      setHeight(1100)
      ref.current?.scrollToBottom({ smooth: false })
      region.scrollTop = 0
      fireEvent.scroll(region)
    })
    expect(ref.current?.getState()).toBe('pinned')
    await act(nextTask)
    expect(region.dataset.scrollState).toBe('pinned')
  })

  it('pins native movement even when layout measures it before the scroll event', async () => {
    const { region, ref, rerender, setHeight } = setup()
    act(() => {
      setHeight(1100)
      ref.current?.scrollToBottom({ smooth: false })
      region.scrollTop = 125
      rerender(
        <ScrollRegion ref={ref} streamActive autoScrollOnStream>
          <div>layout observed the moved viewport</div>
        </ScrollRegion>,
      )
      fireEvent.scroll(region)
      while (frames.length > 0) runNextFrame()
    })
    expect(region.scrollTop).toBe(125)
    expect(ref.current?.getState()).toBe('pinned')
    await act(nextTask)
    expect(region.dataset.scrollState).toBe('pinned')
  })

  it('follows the first transient upward clamp while a replacement tail settles', () => {
    const { region, ref, rerender, setHeight } = setup()
    act(() => {
      setHeight(1100)
      ref.current?.scrollToBottom({ smooth: false })
      while (frames.length > 0) runNextFrame()
      setHeight(1200)
      rerender(
        <ScrollRegion ref={ref} streamActive autoScrollOnStream streamFollowKey="new-tail">
          <div>replacement tail</div>
        </ScrollRegion>,
      )
    })
    act(() => {
      region.scrollTop = 825
      fireEvent.scroll(region)
    })
    expect(ref.current?.getState()).toBe('follow')

    act(() => {
      while (frames.length > 0) runNextFrame()
    })
    expect(region.scrollTop).toBe(1100)
    expect(region.dataset.scrollState).toBe('follow')
  })

  it('does not recognize an old target after its rendering-batch cleanup', async () => {
    const { region, ref, setHeight } = setup()
    act(() => {
      setHeight(700)
      ref.current?.scrollToBottom({ smooth: false })
      runNextFrame()
      setHeight(1100)
      ref.current?.scrollToBottom({ smooth: false })
      region.scrollTop = 600
      fireEvent.scroll(region)
    })
    expect(ref.current?.getState()).toBe('pinned')
    await act(nextTask)
    expect(region.dataset.scrollState).toBe('pinned')
  })

  it('keeps a target recorded after an older cleanup was scheduled', () => {
    const { region, ref, setHeight } = setup()
    act(() => {
      setHeight(700)
      ref.current?.scrollToBottom({ smooth: false })
      setHeight(1100)
      ref.current?.scrollToBottom({ smooth: false })
      runNextFrame()
      region.scrollTop = 1000
      fireEvent.scroll(region)
    })
    expect(region.dataset.scrollState).toBe('follow')
  })

  it('coalesces resize and subtree mutation signals into one reconciliation frame', () => {
    let resizeCallback: ResizeObserverCallback | undefined
    let mutationCallback: MutationCallback | undefined
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback
        }
        observe() {}
        disconnect() {}
      },
    )
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(callback: MutationCallback) {
          mutationCallback = callback
        }
        observe() {}
        disconnect() {}
      },
    )
    const { region, setHeight } = setup()

    act(() => {
      setHeight(300)
      resizeCallback?.([], {} as ResizeObserver)
      mutationCallback?.([], {} as MutationObserver)
      resizeCallback?.([], {} as ResizeObserver)
    })
    expect(frames).toHaveLength(1)

    act(() => runNextFrame())
    expect(region.dataset.scrollState).toBe('follow')
  })

  it('does not treat a stationary Firefox content-growth scroll event as user intent', async () => {
    const { region, rerender, setHeight } = setup()
    act(() => {
      setHeight(300)
      rerender(
        <ScrollRegion streamActive autoScrollOnStream>
          <div>grown content</div>
        </ScrollRegion>,
      )
      fireEvent.scroll(region)
    })

    expect(region.scrollTop).toBe(0)
    await act(nextTask)
    expect(region.dataset.scrollState).toBe('follow')
  })
})

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
