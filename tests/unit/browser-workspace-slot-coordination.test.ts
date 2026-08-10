import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetBrowserWorkspaceSlotCoordinatorForTests,
  acquireBrowserWorkspaceSlotLease,
  awaitBrowserWorkspaceSlotCoordinatorIdle,
  type BrowserWorkspaceSlotLeaseHandle,
  browserWorkspaceSlotSwitchingSupported,
  disposeBrowserWorkspaceSlotCoordinator,
  installBrowserWorkspaceSlotCoordinator as installSlotCoordinator,
  releaseBrowserWorkspaceSlotLease,
  tryWithBrowserWorkspaceSelectionGate,
  withBrowserWorkspaceSelectionGate,
  withBrowserWorkspaceSlotOperation,
  withExclusiveBrowserWorkspaceSlots,
} from '../../src/store/browser-workspace-slot-coordination'

const originalBroadcastChannel = globalThis.BroadcastChannel
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
let activeSlotLease: BrowserWorkspaceSlotLeaseHandle | null = null

function installBrowserWorkspaceSlotCoordinator(
  lifecycle: Omit<Parameters<typeof installSlotCoordinator>[0], 'validateQuiesce'>,
) {
  return installSlotCoordinator({
    validateQuiesce: async () => true,
    ...lifecycle,
  })
}

class ImmediateLockManager {
  request<T>(
    name: string,
    options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: Lock) => Promise<T> | T,
  ): Promise<T> {
    if (options.ifAvailable && options.signal) {
      throw new DOMException('signal and ifAvailable cannot be combined', 'NotSupportedError')
    }
    return Promise.resolve(callback({ name, mode: options.mode }))
  }
}

class SerialLockManager {
  readonly requested: string[] = []
  private gateBusy = false
  private readonly gateQueue: Array<() => void> = []

  request<T>(
    name: string,
    options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: Lock) => Promise<T> | T,
  ): Promise<T> {
    this.requested.push(name)
    if (name !== 'natter:workspace-slot-selection:v1') {
      return Promise.resolve(callback({ name, mode: options.mode }))
    }
    let acquired = false
    return new Promise<void>((resolve, reject) => {
      const enter = () => {
        if (options.signal?.aborted) {
          reject(options.signal.reason)
          return
        }
        acquired = true
        options.signal?.removeEventListener('abort', abort)
        this.gateBusy = true
        resolve()
      }
      const abort = () => {
        if (acquired) return
        const index = this.gateQueue.indexOf(enter)
        if (index >= 0) this.gateQueue.splice(index, 1)
        reject(options.signal?.reason)
      }
      if (options.signal?.aborted) {
        reject(options.signal.reason)
        return
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (this.gateBusy) this.gateQueue.push(enter)
      else enter()
    })
      .then(() => callback({ name, mode: options.mode }))
      .finally(() => {
        if (!acquired) return
        this.gateBusy = false
        this.gateQueue.shift()?.()
      })
  }
}

class FairSelectionLockManager {
  readonly requested: Array<{ readonly name: string; readonly mode: 'shared' | 'exclusive' }> = []
  private activeExclusive = false
  private activeShared = 0
  private readonly queue: Array<{
    readonly mode: 'shared' | 'exclusive'
    readonly enter: () => void
  }> = []

  request<T>(
    name: string,
    options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: Lock | null) => Promise<T> | T,
  ): Promise<T> {
    this.requested.push({ name, mode: options.mode })
    if (name !== 'natter:workspace-slot-selection:v1') {
      return Promise.resolve(callback({ name, mode: options.mode }))
    }
    if (options.ifAvailable) {
      const available =
        this.queue.length === 0 &&
        !this.activeExclusive &&
        (options.mode === 'shared' || this.activeShared === 0)
      return Promise.resolve(callback(available ? { name, mode: options.mode } : null))
    }
    return new Promise<void>((resolve, reject) => {
      const queued = {
        mode: options.mode,
        enter: () => {
          if (options.signal?.aborted) {
            reject(options.signal.reason)
            return
          }
          options.signal?.removeEventListener('abort', abort)
          if (options.mode === 'exclusive') this.activeExclusive = true
          else this.activeShared += 1
          resolve()
        },
      }
      const abort = () => {
        const index = this.queue.indexOf(queued)
        if (index >= 0) this.queue.splice(index, 1)
        reject(options.signal?.reason)
      }
      if (options.signal?.aborted) {
        reject(options.signal.reason)
        return
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      this.queue.push(queued)
      this.drain()
    })
      .then(() => callback({ name, mode: options.mode }))
      .finally(() => {
        if (options.mode === 'exclusive') this.activeExclusive = false
        else this.activeShared -= 1
        this.drain()
      })
  }

  private drain(): void {
    if (this.activeExclusive || this.queue.length === 0) return
    const first = this.queue[0]
    if (!first) return
    if (first.mode === 'exclusive') {
      if (this.activeShared > 0) return
      this.queue.shift()?.enter()
      return
    }
    while (this.queue[0]?.mode === 'shared') {
      this.queue.shift()?.enter()
    }
  }
}

class FakeBroadcastChannel extends EventTarget {
  static instances: FakeBroadcastChannel[] = []
  readonly name: string

  constructor(name: string) {
    super()
    this.name = name
    FakeBroadcastChannel.instances.push(this)
  }

  close(): void {}

  postMessage(): void {}

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

describe('browser workspace slot coordination', () => {
  beforeEach(() => {
    __resetBrowserWorkspaceSlotCoordinatorForTests()
    activeSlotLease = null
    FakeBroadcastChannel.instances = []
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      value: FakeBroadcastChannel,
    })
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: new ImmediateLockManager(),
    })
  })

  afterEach(async () => {
    if (activeSlotLease) await releaseBrowserWorkspaceSlotLease(activeSlotLease)
    activeSlotLease = null
    __resetBrowserWorkspaceSlotCoordinatorForTests()
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      value: originalBroadcastChannel,
    })
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
    vi.restoreAllMocks()
  })

  it('reconciles a quiesced peer once for the matching durable transition', async () => {
    const transitions: string[] = []
    installSlotCoordinator({
      validateQuiesce: async (transition) => transition.nonce === 'current-transition',
      reconcile: async (transition) => {
        transitions.push(`reconcile:${transition.nonce}`)
        if (activeSlotLease) await releaseBrowserWorkspaceSlotLease(activeSlotLease)
        activeSlotLease = null
      },
    })
    activeSlotLease = await acquireBrowserWorkspaceSlotLease('natter')
    const channel = FakeBroadcastChannel.instances[0]
    if (!channel) throw new Error('slot channel missing')

    channel.receive({
      kind: 'quiesce',
      senderId: 'peer',
      nonce: 'stale-transition',
      sourceDatabaseName: 'natter',
      destinationDatabaseName: 'natter-workspace-a',
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(transitions).toEqual([])

    channel.receive({
      kind: 'quiesce',
      senderId: 'peer',
      nonce: 'current-transition',
      sourceDatabaseName: 'natter',
      destinationDatabaseName: 'natter-workspace-a',
    })
    await expect.poll(() => transitions).toEqual(['reconcile:current-transition'])

    channel.receive({
      kind: 'quiesce',
      senderId: 'peer',
      nonce: 'current-transition',
      sourceDatabaseName: 'natter',
      destinationDatabaseName: 'natter-workspace-a',
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(transitions).toEqual(['reconcile:current-transition'])
  })

  it('ignores a quiesce message not admitted by the durable slot journal', async () => {
    const reconcile = vi.fn(async () => undefined)
    const validateQuiesce = vi.fn(async () => false)
    installSlotCoordinator({
      validateQuiesce,
      reconcile,
    })
    activeSlotLease = await acquireBrowserWorkspaceSlotLease('natter')
    const channel = FakeBroadcastChannel.instances[0]
    if (!channel) throw new Error('slot channel missing')
    const transition = {
      nonce: 'foreign-storage-partition',
      sourceDatabaseName: 'natter' as const,
      destinationDatabaseName: 'natter-workspace-a' as const,
    }

    channel.receive({ kind: 'quiesce', senderId: 'peer', ...transition })
    await expect.poll(() => validateQuiesce.mock.calls.length).toBe(1)
    expect(validateQuiesce).toHaveBeenCalledWith(transition, expect.any(AbortSignal))
    await Promise.resolve()

    expect(reconcile).not.toHaveBeenCalled()
  })

  it('keeps installation failure-atomic and releases only the exact coordinator owner', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener').mockImplementationOnce(() => {
      throw new Error('storage-listener-failed')
    })

    expect(() =>
      installBrowserWorkspaceSlotCoordinator({
        reconcile: async () => {},
      }),
    ).toThrow('storage-listener-failed')
    addEventListener.mockRestore()

    const ownerA = installBrowserWorkspaceSlotCoordinator({
      reconcile: async () => {},
    })
    expect(() =>
      installBrowserWorkspaceSlotCoordinator({
        reconcile: async () => {},
      }),
    ).toThrow('BrowserWorkspaceSlotCoordinatorAlreadyInstalled')
    disposeBrowserWorkspaceSlotCoordinator(ownerA)

    const ownerB = installBrowserWorkspaceSlotCoordinator({
      reconcile: async () => {},
    })
    disposeBrowserWorkspaceSlotCoordinator(ownerA)
    disposeBrowserWorkspaceSlotCoordinator(ownerB)
  })

  it('does not allocate transport while only checking slot support', () => {
    expect(browserWorkspaceSlotSwitchingSupported()).toBe(true)
    expect(FakeBroadcastChannel.instances).toHaveLength(0)
  })

  it('keeps abort ownership outside an if-available Web Lock request', async () => {
    const controller = new AbortController()
    const value = await tryWithBrowserWorkspaceSelectionGate(
      async () => 'acquired',
      controller.signal,
    )

    expect(value).toEqual({ acquired: true, value: 'acquired' })
    controller.abort()
  })

  it('releases producer cancellation ownership when the selection callback starts', async () => {
    const controller = new AbortController()
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const selected = tryWithBrowserWorkspaceSelectionGate(async () => {
      markStarted()
      await held
      return 'transferred'
    }, controller.signal)

    await started
    controller.abort(new Error('producer-closed-after-transfer'))
    release()

    await expect(selected).resolves.toEqual({ acquired: true, value: 'transferred' })
  })

  it('cannot deliver an old owner queued transition to its successor', async () => {
    let releaseOwnerA!: () => void
    const ownerAGate = new Promise<void>((resolve) => {
      releaseOwnerA = resolve
    })
    let ownerACalls = 0
    let ownerBCalls = 0
    const ownerA = installBrowserWorkspaceSlotCoordinator({
      reconcile: async () => {
        ownerACalls += 1
        await ownerAGate
      },
    })
    activeSlotLease = await acquireBrowserWorkspaceSlotLease('natter')
    const channelA = FakeBroadcastChannel.instances[0]
    if (!channelA) throw new Error('owner A slot channel missing')
    const message = (nonce: string) => ({
      kind: 'quiesce',
      senderId: 'peer',
      nonce,
      sourceDatabaseName: 'natter',
      destinationDatabaseName: 'natter-workspace-a',
    })

    channelA.receive(message('owner-a-active'))
    await expect.poll(() => ownerACalls).toBe(1)
    channelA.receive(message('owner-a-queued'))
    disposeBrowserWorkspaceSlotCoordinator(ownerA)
    const ownerB = installBrowserWorkspaceSlotCoordinator({
      reconcile: async () => {
        ownerBCalls += 1
      },
    })
    channelA.receive(message('owner-a-stale-channel'))

    releaseOwnerA()
    await Promise.resolve()
    await Promise.resolve()
    expect(ownerACalls).toBe(1)
    expect(ownerBCalls).toBe(0)

    const channelB = FakeBroadcastChannel.instances.at(-1)
    if (!channelB) throw new Error('owner B slot channel missing')
    channelB.receive(message('owner-b-active'))
    await expect.poll(() => ownerBCalls).toBe(1)
    disposeBrowserWorkspaceSlotCoordinator(ownerB)
  })

  it('aborts and drains an already-started owner transition before terminal disposal completes', async () => {
    const neverSettles = new Promise<void>(() => {})
    const capturedSignals: AbortSignal[] = []
    let ownerACalls = 0
    let ownerBCalls = 0
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ownerA = installBrowserWorkspaceSlotCoordinator({
      reconcile: async (_transition, signal) => {
        ownerACalls += 1
        capturedSignals.push(signal)
        await neverSettles
      },
    })
    activeSlotLease = await acquireBrowserWorkspaceSlotLease('natter')
    const channelA = FakeBroadcastChannel.instances[0]
    if (!channelA) throw new Error('owner A slot channel missing')
    channelA.receive({
      kind: 'quiesce',
      senderId: 'peer',
      nonce: 'owner-a-started',
      sourceDatabaseName: 'natter',
      destinationDatabaseName: 'natter-workspace-a',
    })
    await expect.poll(() => ownerACalls).toBe(1)

    disposeBrowserWorkspaceSlotCoordinator(ownerA)
    await awaitBrowserWorkspaceSlotCoordinatorIdle(ownerA)
    expect(capturedSignals[0]?.aborted).toBe(true)

    const ownerB = installBrowserWorkspaceSlotCoordinator({
      reconcile: async () => {
        ownerBCalls += 1
      },
    })
    channelA.receive({
      kind: 'quiesce',
      senderId: 'peer',
      nonce: 'owner-a-after-dispose',
      sourceDatabaseName: 'natter',
      destinationDatabaseName: 'natter-workspace-a',
    })
    await Promise.resolve()
    expect(ownerBCalls).toBe(0)
    expect(consoleError).not.toHaveBeenCalled()
    disposeBrowserWorkspaceSlotCoordinator(ownerB)
    consoleError.mockRestore()
  })

  it('serializes selection and replacement and nests sorted slot locks under the gate', async () => {
    const manager = new SerialLockManager()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: manager,
    })
    const events: string[] = []
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = withBrowserWorkspaceSelectionGate(async () => {
      events.push('first:start')
      await firstHeld
      events.push('first:end')
    })
    const second = withBrowserWorkspaceSelectionGate(async (selection) => {
      events.push('second:start')
      await withExclusiveBrowserWorkspaceSlots(
        selection,
        ['natter-workspace-b', 'natter-workspace-a'],
        async () => {
          events.push('second:slots')
        },
      )
      events.push('second:end')
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])

    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:slots',
      'second:end',
    ])
    expect(manager.requested).toEqual([
      'natter:workspace-slot-selection:v1',
      'natter:workspace-slot-selection:v1',
      'natter:workspace-slot:natter-workspace-a',
      'natter:workspace-slot:natter-workspace-b',
    ])
  })

  it('keeps the runtime live for admitted bounded slot work and fences later probes', async () => {
    const manager = new FairSelectionLockManager()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: manager,
    })
    const events: string[] = []
    let releaseProbe!: () => void
    let releaseReplacement!: () => void
    let markProbeStarted!: () => void
    let markReplacementStarted!: () => void
    const probeHeld = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const replacementHeld = new Promise<void>((resolve) => {
      releaseReplacement = resolve
    })
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve
    })
    const replacementStarted = new Promise<void>((resolve) => {
      markReplacementStarted = resolve
    })

    const admittedProbe = withBrowserWorkspaceSlotOperation('natter', {
      kind: 'retained',
      run: async () => {
        events.push('probe:start')
        markProbeStarted()
        await probeHeld
        events.push('probe:end')
      },
    })
    await probeStarted
    const replacement = withBrowserWorkspaceSelectionGate(async () => {
      events.push('replacement:start')
      markReplacementStarted()
      await replacementHeld
      events.push('replacement:end')
    })
    const laterProbe = withBrowserWorkspaceSlotOperation('natter', {
      kind: 'retained',
      run: async () => {
        events.push('later-probe')
      },
    })

    await Promise.resolve()
    expect(events).toEqual(['probe:start'])
    releaseProbe()
    await replacementStarted
    expect(events).toEqual(['probe:start', 'probe:end', 'replacement:start'])
    releaseReplacement()
    await Promise.all([admittedProbe, replacement, laterProbe])

    expect(events).toEqual([
      'probe:start',
      'probe:end',
      'replacement:start',
      'replacement:end',
      'later-probe',
    ])
    expect(manager.requested).toEqual([
      { name: 'natter:workspace-slot-selection:v1', mode: 'shared' },
      { name: 'natter:workspace-slot:natter', mode: 'shared' },
      { name: 'natter:workspace-slot-selection:v1', mode: 'exclusive' },
      { name: 'natter:workspace-slot-selection:v1', mode: 'shared' },
      { name: 'natter:workspace-slot:natter', mode: 'shared' },
    ])
  })

  it('aborts a queued selection owner before its callback can enter', async () => {
    const manager = new SerialLockManager()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: manager,
    })
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = withBrowserWorkspaceSelectionGate(async () => firstHeld)
    const controller = new AbortController()
    const reason = new Error('selection-owner-cancelled')
    let secondCalls = 0
    const second = withBrowserWorkspaceSelectionGate(async () => {
      secondCalls += 1
    }, controller.signal)

    controller.abort(reason)
    await expect(second).rejects.toBe(reason)
    expect(secondCalls).toBe(0)
    releaseFirst()
    await first
  })
})
