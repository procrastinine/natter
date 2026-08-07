import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installUiJourneyInvariantRecorderInPage,
  type UiJourneyIntent,
  type UiJourneyInvariantReport,
} from '../e2e/ui-journey-invariant-recorder'

interface TestRecorderApi {
  arm(label?: string): Promise<UiJourneyInvariantReport>
  markIntent(intent: UiJourneyIntent): void
  snapshot(label?: string, completeIntents?: boolean): Promise<UiJourneyInvariantReport>
  report(): UiJourneyInvariantReport
  stop(label?: string): Promise<UiJourneyInvariantReport>
  __disposeNow(): void
}

interface TestWindow extends Window {
  __uiJourneyInvariantRecorder?: TestRecorderApi
}

let frameId = 0
let frames = new Map<number, FrameRequestCallback>()
let rectTops = new WeakMap<Element, number>()
let topElement: Element | null = null
let visibilityState: DocumentVisibilityState = 'visible'
let resizeObservers: Array<{
  callback: ResizeObserverCallback
  observer: ResizeObserver
}> = []

beforeEach(() => {
  frames = new Map()
  rectTops = new WeakMap()
  frameId = 0
  topElement = null
  visibilityState = 'visible'
  resizeObservers = []
  document.body.innerHTML = ''
  history.replaceState(null, '', '/')
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frameId += 1
    frames.set(frameId, callback)
    return frameId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      readonly callback: ResizeObserverCallback

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        resizeObservers.push({ callback, observer: this })
      }

      observe() {}
      unobserve() {}
      disconnect() {
        resizeObservers = resizeObservers.filter((entry) => entry.observer !== this)
      }
    },
  )
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const top = rectTops.get(this) ?? 10
    return domRect({ x: 10, y: top, top, bottom: top + 20, width: 120, height: 20 })
  })
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => topElement,
  })
})

afterEach(() => {
  ;(window as TestWindow).__uiJourneyInvariantRecorder?.__disposeNow()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('UI journey invariant recorder', () => {
  it('has no observation or history-patch work before it is armed', async () => {
    installUiJourneyInvariantRecorderInPage({
      shell: { selector: '[data-ui="shell"]' },
    })
    document.body.innerHTML = '<div data-ui="shell"></div>'
    history.pushState(null, '', '/before-arm')
    await flushMutationFrame()

    expect(frames.size).toBe(0)
    expect(installedRecorder().report()).toMatchObject({ armed: false, samples: [] })
  })

  it('acknowledges explicit hidden-document checkpoints without waiting for a paint', async () => {
    document.body.innerHTML = '<div data-ui="shell"></div>'
    visibilityState = 'hidden'
    installUiJourneyInvariantRecorderInPage({
      shell: { selector: '[data-ui="shell"]' },
    })
    const recorder = installedRecorder()

    const armed = await recorder.arm('hidden-arm')
    expect(armed.samples.at(-1)).toMatchObject({
      label: 'hidden-arm',
      reasons: ['checkpoint'],
    })
    expect(frames.size).toBe(0)

    const checkpoint = await recorder.snapshot('hidden-checkpoint')
    expect(checkpoint.samples.at(-1)).toMatchObject({
      label: 'hidden-checkpoint',
      reasons: ['checkpoint'],
    })
    expect(frames.size).toBe(0)

    const stopped = await recorder.stop('hidden-stop')
    expect(stopped).toMatchObject({ armed: false, stopped: true })
    expect(stopped.samples.at(-1)).toMatchObject({
      label: 'hidden-stop',
      reasons: ['checkpoint'],
    })
    expect(frames.size).toBe(0)
  })

  it('coalesces dirty work, preserves node identity, bounds evidence, and records no bodies', async () => {
    document.body.innerHTML = `
      <div data-ui="shell">
        <main data-ui="content">
          <button data-ui="critical">branch 5/5</button>
          <div data-ui="scroll"><div data-ui="messages">
            <article data-message-id="m1">private body sentinel</article>
          </div></div>
        </main>
      </div>
    `
    const critical = requiredElement('[data-ui="critical"]')
    topElement = critical
    installUiJourneyInvariantRecorderInPage({
      sampleLimit: 3,
      transitionLimit: 2,
      violationLimit: 8,
      shell: {
        selector: '[data-ui="shell"]',
        contentSelector: '[data-ui="content"]',
        loadingSelectors: ['[data-ui="loading"]'],
      },
      semanticNodes: [{ id: 'critical', selector: '[data-ui="critical"]' }],
      countSurfaces: [
        {
          id: 'messages',
          rootSelector: '[data-ui="messages"]',
          itemSelector: '[data-message-id]',
          monotonic: 'nondecreasing',
        },
      ],
      transcript: {
        rootSelector: '[data-ui="messages"]',
        itemSelector: '[data-message-id]',
        idAttribute: 'data-message-id',
      },
    })
    const recorder = installedRecorder()

    const armed = recorder.arm('ready')
    flushFrame()
    const initial = await armed
    const criticalId = initial.samples[0]?.controls.critical?.id
    expect(criticalId).toBeTypeOf('number')

    const messages = requiredElement('[data-ui="messages"]')
    critical.setAttribute('data-state', 'one')
    critical.setAttribute('data-state', 'two')
    messages.insertAdjacentHTML(
      'beforeend',
      '<article data-message-id="m2">another secret</article>',
    )
    await flushMutationFrame()
    expect(recorder.report().samples).toHaveLength(2)
    expect(recorder.report().samples[1]?.controls.critical?.id).toBe(criticalId)

    const replacement = critical.cloneNode(true) as HTMLElement
    critical.replaceWith(replacement)
    topElement = replacement
    requiredElement('[data-message-id="m1"]').remove()
    requiredElement('[data-ui="content"]').insertAdjacentHTML(
      'beforeend',
      '<div data-ui="loading">loading private material</div>',
    )
    await flushMutationFrame()

    for (let index = 0; index < 3; index += 1) {
      messages.insertAdjacentHTML(
        'beforeend',
        `<article data-message-id="extra-${index}"></article>`,
      )
      await flushMutationFrame()
    }
    const report = recorder.report()
    expect(report.samples).toHaveLength(3)
    expect(report.transitions).toHaveLength(2)
    expect(report.droppedSamples).toBeGreaterThan(0)
    expect(report.droppedTransitions).toBeGreaterThan(0)
    expect(report.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        'count-regression',
        'semantic-node-remount',
        'shell-loading-exposed',
        'transcript-prefix-loss',
      ]),
    )
    expect(JSON.stringify(report)).not.toContain('private body sentinel')
    expect(JSON.stringify(report)).not.toContain('another secret')
    expect(JSON.stringify(report)).not.toContain('loading private material')
  })

  it('owns route and gesture phases without timer-based grace periods', async () => {
    document.body.innerHTML = `
      <div data-ui="shell"><main data-ui="content"><button data-ui="go">Go</button></main></div>
      <div data-ui="cover"></div>
    `
    const cover = requiredElement('[data-ui="cover"]')
    topElement = cover
    installUiJourneyInvariantRecorderInPage({
      shell: { selector: '[data-ui="shell"]', contentSelector: '[data-ui="content"]' },
    })
    const recorder = installedRecorder()
    const armed = recorder.arm()
    flushFrame()
    await armed

    recorder.markIntent({ kind: 'gesture', id: 'open-chat', targetSelector: '[data-ui="go"]' })
    recorder.markIntent({ kind: 'gesture', id: 'open-chat', targetSelector: '[data-ui="go"]' })
    history.pushState(null, '', '/#/unowned')
    await flushMutationFrame()

    recorder.markIntent({
      kind: 'route',
      id: 'expected-chat',
      expected: { kind: 'exact', value: '/#/chat/expected' },
    })
    location.hash = '#/chat/wrong'
    dispatchEvent(new HashChangeEvent('hashchange'))
    await flushMutationFrame()

    recorder.markIntent({
      kind: 'route',
      id: 'never-arrived',
      expected: { kind: 'prefix', value: '/#/chat/' },
    })
    const checkpoint = recorder.snapshot('phase-end')
    flushFrame()
    const report = await checkpoint
    expect(report.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        'covered-gesture',
        'double-gesture',
        'route-change-without-intent',
        'route-intent-mismatch',
        'route-intent-unfulfilled',
      ]),
    )
  })

  it('detects follow-bottom and prepend-anchor discontinuities from one scroll contract', async () => {
    document.body.innerHTML = `
      <div data-ui="shell"><main data-ui="content">
        <div data-ui="scroll"><div data-ui="messages">
          <article data-message-id="m1"></article>
        </div></div>
      </main></div>
    `
    const scroll = requiredElement<HTMLElement>('[data-ui="scroll"]')
    const anchor = requiredElement('[data-message-id="m1"]')
    let scrollTop = 900
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => 1_000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value
        },
      },
    })
    rectTops.set(anchor, 30)
    topElement = anchor
    installUiJourneyInvariantRecorderInPage({
      defaultScrollTolerancePx: 2,
      shell: { selector: '[data-ui="shell"]', contentSelector: '[data-ui="content"]' },
      transcript: {
        rootSelector: '[data-ui="messages"]',
        itemSelector: '[data-message-id]',
        idAttribute: 'data-message-id',
        scrollSelector: '[data-ui="scroll"]',
      },
    })
    const recorder = installedRecorder()
    const armed = recorder.arm()
    flushFrame()
    await armed

    recorder.markIntent({ kind: 'follow-bottom', id: 'stream-follow' })
    scrollTop = 100
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
    await flushMutationFrame()
    const followEnd = recorder.snapshot('follow-end')
    flushFrame()
    await followEnd

    recorder.markIntent({
      kind: 'prepend-anchor',
      id: 'older-page',
      anchorSelector: '[data-message-id="m1"]',
    })
    rectTops.set(anchor, 180)
    anchor.setAttribute('data-shifted', 'true')
    triggerResizeObservers()
    await flushMutationFrame()
    triggerResizeObservers()
    await flushMutationFrame()
    anchor.remove()
    triggerResizeObservers()
    await flushMutationFrame()
    triggerResizeObservers()
    await flushMutationFrame()

    expect(recorder.report().violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        'follow-bottom-discontinuity',
        'prepend-anchor-discontinuity',
        'prepend-anchor-lost',
      ]),
    )
  })

  it('accepts only contiguous text-anchored bounded prefix eviction', async () => {
    document.body.innerHTML = `
      <div data-ui="shell"><main data-ui="content">
        <div data-ui="scroll"><div
          data-ui="messages"
          data-rendered-count="5"
          data-total-count="8"
          data-virtualized="true"
        >
          <article data-message-id="m1"></article>
          <article data-message-id="m2"></article>
          <article data-message-id="m3"></article>
          <article data-message-id="m4"></article>
        </div></div>
      </main></div>
    `
    const scroll = requiredElement<HTMLElement>('[data-ui="scroll"]')
    const messages = requiredElement<HTMLElement>('[data-ui="messages"]')
    let scrollHeight = 1_000
    let scrollTop = 500
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value
        },
      },
    })
    for (const [index, id] of ['m1', 'm2', 'm3', 'm4'].entries()) {
      rectTops.set(requiredElement(`[data-message-id="${id}"]`), 10 + index * 20)
    }
    topElement = messages
    installUiJourneyInvariantRecorderInPage({
      defaultScrollTolerancePx: 2,
      shell: { selector: '[data-ui="shell"]', contentSelector: '[data-ui="content"]' },
      countSurfaces: [
        {
          id: 'messages',
          rootSelector: '[data-ui="messages"]',
          itemSelector: '[data-message-id]',
          monotonic: 'nondecreasing',
        },
      ],
      transcript: {
        rootSelector: '[data-ui="messages"]',
        itemSelector: '[data-message-id]',
        idAttribute: 'data-message-id',
        scrollSelector: '[data-ui="scroll"]',
        boundedPrefixEviction: {
          countSurfaceId: 'messages',
          renderedCountAttribute: 'data-rendered-count',
          totalCountAttribute: 'data-total-count',
        },
      },
    })
    const recorder = installedRecorder()
    const armed = recorder.arm()
    flushFrame()
    await armed

    requiredElement('[data-message-id="m1"]').remove()
    requiredElement('[data-message-id="m2"]').remove()
    messages.setAttribute('data-rendered-count', '2')
    messages.setAttribute('data-virtualized', 'false')
    scrollHeight = 800
    scrollTop = 350
    await flushMutationFrame()
    expect(recorder.report().violations).toEqual([])

    messages.insertAdjacentHTML('beforeend', '<article data-message-id="m5"></article>')
    rectTops.set(requiredElement('[data-message-id="m5"]'), 70)
    messages.setAttribute('data-rendered-count', '3')
    scrollHeight = 900
    scrollTop = 400
    await flushMutationFrame()

    requiredElement('[data-message-id="m4"]').remove()
    messages.setAttribute('data-rendered-count', '2')
    scrollHeight = 800
    scrollTop = 300
    await flushMutationFrame()
    expect(recorder.report().violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining(['count-regression', 'transcript-prefix-loss']),
    )
  })

  it('accepts bounded virtual residency changes but still rejects overlapping row remounts', async () => {
    document.body.innerHTML = `
      <div data-ui="shell"><main data-ui="content">
        <div data-ui="scroll"><div
          data-ui="messages"
          data-rendered-count="20"
          data-virtualized="true"
        >
          <article data-message-id="m1"></article>
          <article data-message-id="m2"></article>
          <article data-message-id="m3"></article>
        </div></div>
      </main></div>
    `
    const messages = requiredElement<HTMLElement>('[data-ui="messages"]')
    topElement = messages
    installUiJourneyInvariantRecorderInPage({
      shell: { selector: '[data-ui="shell"]', contentSelector: '[data-ui="content"]' },
      countSurfaces: [
        {
          id: 'mounted-messages',
          rootSelector: '[data-ui="messages"]',
          itemSelector: '[data-message-id]',
          minimum: 1,
        },
      ],
      transcript: {
        rootSelector: '[data-ui="messages"]',
        itemSelector: '[data-message-id]',
        idAttribute: 'data-message-id',
        boundedVirtualResidency: {
          renderedCountAttribute: 'data-rendered-count',
          virtualizedAttribute: 'data-virtualized',
        },
      },
    })
    const recorder = installedRecorder()
    const armed = recorder.arm()
    flushFrame()
    await armed

    requiredElement('[data-message-id="m1"]').remove()
    messages.insertAdjacentHTML('beforeend', '<article data-message-id="m4"></article>')
    await flushMutationFrame()
    expect(recorder.report().violations).toEqual([])

    const retained = requiredElement('[data-message-id="m2"]')
    retained.replaceWith(retained.cloneNode(true))
    await flushMutationFrame()
    expect(recorder.report().violations.map((violation) => violation.code)).toContain(
      'transcript-message-remount',
    )
  })

  it('tracks bottom acquisition continuously and rejects an alternate semantic alignment', async () => {
    document.body.innerHTML = `
      <div data-ui="shell"><main data-ui="content">
        <div data-ui="scroll"><div data-ui="messages">
          <article data-message-id="edited"></article>
        </div></div>
      </main></div>
    `
    const scroll = requiredElement<HTMLElement>('[data-ui="scroll"]')
    const edited = requiredElement('[data-message-id="edited"]')
    let scrollTop = 100
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => 1_000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value
        },
      },
    })
    rectTops.set(scroll, 10)
    rectTops.set(edited, 30)
    topElement = edited
    installUiJourneyInvariantRecorderInPage({
      defaultScrollTolerancePx: 2,
      shell: { selector: '[data-ui="shell"]', contentSelector: '[data-ui="content"]' },
      transcript: {
        rootSelector: '[data-ui="messages"]',
        itemSelector: '[data-message-id]',
        idAttribute: 'data-message-id',
        scrollSelector: '[data-ui="scroll"]',
      },
    })
    const recorder = installedRecorder()
    const armed = recorder.arm()
    flushFrame()
    await armed

    recorder.markIntent({
      kind: 'acquire-bottom',
      id: 'save-send-bottom',
      rejectAlignmentSelector: '[data-message-id="edited"]',
    })
    rectTops.set(edited, 10)
    scrollTop = 300
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
    await flushMutationFrame()
    scrollTop = 250
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
    await flushMutationFrame()
    scrollTop = 900
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
    await flushMutationFrame()
    scrollTop = 800
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
    await flushMutationFrame()
    scrollTop = 900
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
    await flushMutationFrame()

    const finished = recorder.snapshot('bottom-acquired')
    flushFrame()
    const report = await finished
    expect(report.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        'acquire-bottom-forbidden-alignment',
        'acquire-bottom-reversal',
        'acquire-bottom-discontinuity',
      ]),
    )
    expect(report.violations.map((violation) => violation.code)).not.toContain(
      'acquire-bottom-unfulfilled',
    )
  })

  it('waits for post-mutation layout before checking an acquired bottom', async () => {
    document.body.innerHTML = `
      <div data-ui="shell"><main data-ui="content">
        <div data-ui="scroll"><div data-ui="messages">
          <article data-message-id="m1"></article>
        </div></div>
      </main></div>
    `
    const scroll = requiredElement<HTMLElement>('[data-ui="scroll"]')
    const messages = requiredElement<HTMLElement>('[data-ui="messages"]')
    let scrollHeight = 1_000
    let scrollTop = 900
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value
        },
      },
    })
    topElement = messages
    installUiJourneyInvariantRecorderInPage({
      defaultScrollTolerancePx: 2,
      shell: { selector: '[data-ui="shell"]', contentSelector: '[data-ui="content"]' },
      transcript: {
        rootSelector: '[data-ui="messages"]',
        itemSelector: '[data-message-id]',
        idAttribute: 'data-message-id',
        scrollSelector: '[data-ui="scroll"]',
      },
    })
    const recorder = installedRecorder()
    const armed = recorder.arm()
    flushFrame()
    await armed
    recorder.markIntent({ kind: 'acquire-bottom', id: 'stream-bottom' })

    scrollHeight = 1_500
    messages.setAttribute('data-stream-version', '1')
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
    await flushMutationFrame()
    expect(recorder.report().violations.map((violation) => violation.code)).not.toContain(
      'acquire-bottom-discontinuity',
    )

    scrollTop = 1_400
    triggerResizeObservers()
    await flushMutationFrame()

    scrollHeight = 2_000
    messages.setAttribute('data-stream-version', '2')
    await Promise.resolve()
    await Promise.resolve()
    const finished = recorder.snapshot('post-layout-bottom')
    flushFrame()
    const report = await finished
    expect(report.violations.map((violation) => violation.code)).not.toContain(
      'acquire-bottom-discontinuity',
    )
    expect(report.violations.map((violation) => violation.code)).not.toContain(
      'acquire-bottom-unfulfilled',
    )
  })

  it('checks singleton and keyed surface state across any-visible shell and tab resume', async () => {
    document.body.innerHTML = `
      <div data-ui="shell">
        <main data-ui="primary" style="display:none"></main>
        <main data-ui="alternative">
          <button data-ui="singleton" data-state="ready">Ready</button>
          <button data-ui="keyed" data-key="a" data-state="ready">Alpha</button>
          <button data-ui="keyed" data-key="b" data-state="ready">Beta</button>
          <textarea data-ui="stable-value">private stable value</textarea>
        </main>
      </div>
    `
    topElement = requiredElement('[data-ui="singleton"]')
    installUiJourneyInvariantRecorderInPage({
      shell: {
        selector: '[data-ui="shell"]',
        contentSelectors: ['[data-ui="primary"]', '[data-ui="alternative"]'],
      },
      semanticNodes: [
        {
          id: 'singleton',
          selector: '[data-ui="singleton"]',
          requireInteractive: true,
          text: { kind: 'exact', value: 'Ready' },
          attributes: { 'data-state': { kind: 'exact', value: 'ready' } },
        },
        {
          id: 'keyed',
          selector: '[data-ui="keyed"]',
          cardinality: 'keyed',
          keyAttribute: 'data-key',
          preserveKeys: true,
          requireInteractive: true,
          text: { kind: 'stable' },
          attributes: { 'data-state': { kind: 'exact', value: 'ready' } },
        },
        {
          id: 'stable-value',
          selector: '[data-ui="stable-value"]',
          properties: { value: { kind: 'stable' } },
        },
      ],
    })
    const recorder = installedRecorder()
    const armed = recorder.arm()
    flushFrame()
    const initial = await armed
    expect(initial.violations).toEqual([])
    expect(Object.keys(initial.samples[0]?.controls ?? {})).toEqual([
      'singleton',
      'keyed[a]',
      'keyed[b]',
      'stable-value',
    ])

    visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    const keyedA = requiredElement<HTMLElement>('[data-key="a"]')
    const replacement = keyedA.cloneNode(true) as HTMLElement
    keyedA.replaceWith(replacement)
    replacement.textContent = 'Changed private surface text'
    requiredElement<HTMLButtonElement>('[data-key="b"]').disabled = true
    requiredElement('[data-ui="singleton"]').setAttribute('data-state', 'wrong')
    requiredElement<HTMLTextAreaElement>('[data-ui="stable-value"]').value =
      'changed private stable value'
    requiredElement('[data-ui="stable-value"]').dispatchEvent(new Event('input', { bubbles: true }))
    visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await flushMutationFrame()

    const codes = recorder.report().violations.map((violation) => violation.code)
    expect(codes).toEqual(
      expect.arrayContaining([
        'critical-control-inert',
        'semantic-claim-mismatch',
        'semantic-node-remount',
        'visibility-resume-discontinuity',
      ]),
    )
    expect(codes).not.toContain('shell-blank')
    expect(JSON.stringify(recorder.report())).not.toContain('Changed private surface text')
    expect(JSON.stringify(recorder.report())).not.toContain('changed private stable value')
  })

  it('accounts for exact gesture delivery and preserves focus while acquiring the bottom', async () => {
    document.body.innerHTML = `
      <div data-ui="shell"><main data-ui="content">
        <input data-ui="editor" value="abcdef" />
        <button data-ui="gesture">Act</button>
        <div data-ui="outcome" data-state="closed"></div>
        <div data-ui="scroll"></div>
      </main></div>
    `
    const editor = requiredElement<HTMLInputElement>('[data-ui="editor"]')
    const gesture = requiredElement<HTMLButtonElement>('[data-ui="gesture"]')
    const outcome = requiredElement('[data-ui="outcome"]')
    const scroll = requiredElement<HTMLElement>('[data-ui="scroll"]')
    let scrollTop = 100
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => 1_000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value
        },
      },
    })
    topElement = gesture
    editor.focus()
    editor.setSelectionRange(1, 4, 'forward')
    installUiJourneyInvariantRecorderInPage({
      shell: { selector: '[data-ui="shell"]', contentSelector: '[data-ui="content"]' },
    })
    const recorder = installedRecorder()
    const armed = recorder.arm()
    flushFrame()
    await armed

    recorder.markIntent({
      kind: 'gesture',
      id: 'successful-gesture',
      targetSelector: '[data-ui="gesture"]',
      outcome: {
        selector: '[data-ui="outcome"]',
        attributes: { 'data-state': { kind: 'exact', value: 'open' } },
      },
    })
    recorder.markIntent({ kind: 'focus-continuity', id: 'stable-editor' })
    recorder.markIntent({
      kind: 'acquire-bottom',
      id: 'jump-latest',
      scrollSelector: '[data-ui="scroll"]',
    })
    gesture.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    outcome.setAttribute('data-state', 'open')
    scrollTop = 900
    await flushMutationFrame()
    const successful = recorder.snapshot('successful-phase')
    flushFrame()
    expect((await successful).violations).toEqual([])

    editor.focus()
    editor.setSelectionRange(1, 4, 'forward')
    recorder.markIntent({
      kind: 'gesture',
      id: 'failed-gesture',
      targetSelector: '[data-ui="gesture"]',
      expectedDeliveries: 1,
      outcome: {
        selector: '[data-ui="outcome"]',
        attributes: { 'data-state': { kind: 'exact', value: 'finished' } },
      },
    })
    recorder.markIntent({ kind: 'focus-continuity', id: 'lost-editor' })
    recorder.markIntent({
      kind: 'acquire-bottom',
      id: 'missed-bottom',
      scrollSelector: '[data-ui="scroll"]',
    })
    gesture.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    gesture.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    editor.setSelectionRange(2, 5, 'forward')
    editor.setAttribute('data-selection-phase', 'changed')
    await flushMutationFrame()
    gesture.focus()
    scrollTop = 100
    gesture.setAttribute('data-focus-phase', 'changed')
    await flushMutationFrame()
    const failed = recorder.snapshot('failed-phase')
    flushFrame()

    expect((await failed).violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        'acquire-bottom-unfulfilled',
        'focus-continuity-lost',
        'gesture-delivery-mismatch',
        'gesture-outcome-unfulfilled',
        'selection-continuity-lost',
      ]),
    )
  })
})

function installedRecorder(): TestRecorderApi {
  const recorder = (window as TestWindow).__uiJourneyInvariantRecorder
  if (!recorder) throw new Error('test recorder was not installed')
  return recorder
}

function flushFrame(): void {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) callback(performance.now())
}

async function flushMutationFrame(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  flushFrame()
}

function triggerResizeObservers(): void {
  for (const { callback, observer } of resizeObservers) callback([], observer)
}

function requiredElement<T extends Element = Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`missing fixture element: ${selector}`)
  return element
}

function domRect(input: Partial<DOMRect>): DOMRect {
  return {
    x: input.x ?? 0,
    y: input.y ?? 0,
    top: input.top ?? 0,
    right: input.right ?? 0,
    bottom: input.bottom ?? 0,
    left: input.left ?? 0,
    width: input.width ?? 0,
    height: input.height ?? 0,
    toJSON: () => ({}),
  }
}
