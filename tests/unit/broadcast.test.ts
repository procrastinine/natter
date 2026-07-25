import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetBroadcastForTests,
  __setBroadcastFallbackReaderForTests,
  broadcastWorkspaceRuntimeResources,
  postWorkspaceChange,
  seedBroadcastWorkspaceSnapshot,
  subscribeWorkspaceChanges,
} from '../../src/store/broadcast'
import type { WorkspaceChange } from '../../src/store/workspace-protocol'

beforeEach(() => {
  __resetBroadcastForTests({ admissionsOpen: true })
})

afterEach(() => {
  __resetBroadcastForTests({ admissionsOpen: true })
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('workspace change transport', () => {
  it('fans a local commit out to every subscriber exactly once', () => {
    const channel = installBroadcastChannel()
    const first: WorkspaceChange[] = []
    const second: WorkspaceChange[] = []
    const stopFirst = subscribeWorkspaceChanges((change) => first.push(change))
    const stopSecond = subscribeWorkspaceChanges((change) => second.push(change))
    const change = commit('local-1')

    postWorkspaceChange(change)

    expect(first).toEqual([change])
    expect(second).toEqual([change])
    expect(channel.posted).toEqual([change])
    stopFirst()
    stopSecond()
  })

  it('isolates subscriber failures and stops delivery after unsubscribe', () => {
    installBroadcastChannel()
    const received: WorkspaceChange[] = []
    const stopBad = subscribeWorkspaceChanges(() => {
      throw new Error('listener failed')
    })
    const stopGood = subscribeWorkspaceChanges((change) => received.push(change))

    expect(() => postWorkspaceChange(commit('safe-1'))).not.toThrow()
    stopGood()
    postWorkspaceChange(commit('safe-2'))

    expect(received).toEqual([commit('safe-1')])
    stopBad()
  })

  it('delivers a same-workspace remote commit without echoing it back', async () => {
    const channel = installBroadcastChannel({ fanOut: true })
    seedBroadcastWorkspaceSnapshot(WORKSPACE)
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))
    const otherTab = new BroadcastChannel('llm-api-frontend')
    const change = commit('remote-1')

    otherTab.postMessage(change)
    await tick()

    expect(received).toEqual([change])
    expect(channel.posted).toEqual([change])
    stop()
    otherTab.close()
  })

  it('drops malformed and unstamped remote payloads', async () => {
    installBroadcastChannel({ fanOut: true })
    seedBroadcastWorkspaceSnapshot(WORKSPACE)
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))
    const otherTab = new BroadcastChannel('llm-api-frontend')

    otherTab.postMessage({ kind: 'commit', stamp: { workspaceId: 'workspace' } })
    otherTab.postMessage({ kind: 'invalidate', workspaceId: '', replacementEpoch: 1 })
    otherTab.postMessage({ kind: 'replace', workspaceId: 'workspace', replacementEpoch: -1 })
    otherTab.postMessage({
      ...attemptTargetCommit('malformed-attempt'),
      delta: {
        facts: [
          ...attemptTargetCommit('malformed-attempt').delta.facts,
          ...attemptTargetCommit('malformed-attempt').delta.facts,
        ],
        invalidations: [],
      },
    })
    await tick()

    expect(received).toEqual([])
    stop()
    otherTab.close()
  })

  it('preserves a typed terminal target fact across the tab transport', async () => {
    const channel = installBroadcastChannel({ fanOut: true })
    seedBroadcastWorkspaceSnapshot(WORKSPACE)
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))
    const otherTab = new BroadcastChannel('llm-api-frontend')
    const change = attemptTargetCommit('remote-terminal-target')

    otherTab.postMessage(change)
    await tick()

    expect(received).toEqual([change])
    expect(channel.posted).toEqual([change])
    stop()
    otherTab.close()
  })

  it('verifies a foreign-fence remote change and never delivers the stale payload', async () => {
    installBroadcastChannel({ fanOut: true })
    seedBroadcastWorkspaceSnapshot(WORKSPACE)
    const read = vi.fn(async () => WORKSPACE)
    __setBroadcastFallbackReaderForTests(read)
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))
    const otherTab = new BroadcastChannel('llm-api-frontend')

    otherTab.postMessage(
      commit('foreign', { workspaceId: 'deleted-workspace', replacementEpoch: 9 }),
    )
    await tick()

    expect(read).toHaveBeenCalledTimes(1)
    expect(received).toEqual([invalidate(WORKSPACE)])
    stop()
    otherTab.close()
  })

  it('turns a durably confirmed foreign fence into one replacement', async () => {
    installBroadcastChannel({ fanOut: true })
    seedBroadcastWorkspaceSnapshot(WORKSPACE)
    const replacement = { workspaceId: 'replacement', replacementEpoch: 2 }
    __setBroadcastFallbackReaderForTests(async () => replacement)
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))
    const otherTab = new BroadcastChannel('llm-api-frontend')

    otherTab.postMessage(commit('replacement-commit', replacement))
    await tick()

    expect(received).toEqual([replace(replacement)])
    stop()
    otherTab.close()
  })

  it('emits replacement before a local change from a new workspace fence', () => {
    installBroadcastChannel()
    seedBroadcastWorkspaceSnapshot(WORKSPACE)
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))
    const replacement = { workspaceId: 'replacement', replacementEpoch: 3 }
    const change = commit('local-replacement', replacement)

    postWorkspaceChange(change)

    expect(received).toEqual([replace(replacement), change])
    stop()
  })

  it('recreates the channel and retries one failed post without duplicate local delivery', () => {
    let constructions = 0
    const posted: WorkspaceChange[] = []
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        private readonly fail = constructions++ === 0
        addEventListener() {}
        close() {}
        postMessage(change: WorkspaceChange) {
          if (this.fail) throw new Error('channel failed')
          posted.push(change)
        }
      },
    )
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))
    const change = commit('retry')

    postWorkspaceChange(change)

    expect(constructions).toBe(2)
    expect(posted).toEqual([change])
    expect(received).toEqual([change])
    stop()
  })

  it('contains repeated post failure, delivers locally, and enters durable fallback', async () => {
    vi.useFakeTimers()
    let constructions = 0
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor() {
          constructions += 1
        }
        addEventListener() {}
        close() {}
        postMessage() {
          throw new Error('persistent channel failure')
        }
      },
    )
    const read = vi.fn(async () => WORKSPACE)
    __setBroadcastFallbackReaderForTests(read)
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))
    const change = commit('fallback-post')

    expect(() => postWorkspaceChange(change)).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)

    expect(constructions).toBe(2)
    expect(read).toHaveBeenCalledTimes(1)
    expect(received).toContainEqual(change)
    expect(received).toContainEqual(invalidate(WORKSPACE))
    stop()
  })

  it('switches to durable fallback after a channel message error', async () => {
    vi.useFakeTimers()
    let reportMessageError: (() => void) | undefined
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        addEventListener(kind: string, handler: () => void) {
          if (kind === 'messageerror') reportMessageError = handler
        }
        close() {}
        postMessage() {}
      },
    )
    const read = vi.fn(async () => WORKSPACE)
    __setBroadcastFallbackReaderForTests(read)
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))

    reportMessageError?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(read).toHaveBeenCalledTimes(1)
    expect(received).toEqual([invalidate(WORKSPACE)])
    stop()
  })

  it('falls back when channel construction throws', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor() {
          throw new Error('blocked')
        }
      },
    )
    const read = vi.fn(async () => WORKSPACE)
    __setBroadcastFallbackReaderForTests(read)
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))

    await vi.advanceTimersByTimeAsync(0)

    expect(read).toHaveBeenCalledTimes(1)
    expect(received).toEqual([invalidate(WORKSPACE)])
    stop()
  })

  it('does no fallback reads while BroadcastChannel remains available', async () => {
    vi.useFakeTimers()
    installBroadcastChannel()
    const read = vi.fn(async () => WORKSPACE)
    __setBroadcastFallbackReaderForTests(read)
    const stop = subscribeWorkspaceChanges(() => {})

    await vi.advanceTimersByTimeAsync(30_000)

    expect(read).not.toHaveBeenCalled()
    stop()
  })

  it('allows only one fallback read in flight', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', undefined)
    const pending = deferred<typeof WORKSPACE>()
    const read = vi.fn(() => pending.promise)
    __setBroadcastFallbackReaderForTests(read)
    const stop = subscribeWorkspaceChanges(() => {})

    await vi.advanceTimersByTimeAsync(20_000)
    expect(read).toHaveBeenCalledTimes(1)

    pending.resolve(WORKSPACE)
    await vi.advanceTimersByTimeAsync(0)
    stop()
  })

  it('contains a fallback read failure and retries on lifecycle catch-up', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', undefined)
    const read = vi
      .fn<() => Promise<typeof WORKSPACE>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(WORKSPACE)
    __setBroadcastFallbackReaderForTests(read)
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))

    await vi.advanceTimersByTimeAsync(0)
    expect(received).toEqual([])
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)

    expect(read).toHaveBeenCalledTimes(2)
    expect(received).toEqual([invalidate(WORKSPACE)])
    stop()
  })

  it('does no idle reads when the storage signal is readable and catches up on focus', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', undefined)
    const read = vi.fn(async () => WORKSPACE)
    __setBroadcastFallbackReaderForTests(read)
    const stop = subscribeWorkspaceChanges(() => {})

    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(2)
    stop()
  })

  it('turns a fallback storage notification into one durable verification', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', undefined)
    const read = vi.fn(async () => WORKSPACE)
    __setBroadcastFallbackReaderForTests(read)
    const stop = subscribeWorkspaceChanges(() => {})

    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)

    const event = new Event('storage')
    Object.defineProperty(event, 'key', { value: 'natter:workspace-change' })
    window.dispatchEvent(event)
    await vi.advanceTimersByTimeAsync(0)

    expect(read).toHaveBeenCalledTimes(2)
    stop()
  })

  it('preserves replacement semantics through fallback reconciliation', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', undefined)
    seedBroadcastWorkspaceSnapshot(WORKSPACE)
    const replacement = { workspaceId: 'replacement', replacementEpoch: 4 }
    __setBroadcastFallbackReaderForTests(async () => replacement)
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))

    await vi.advanceTimersByTimeAsync(0)

    expect(received).toEqual([replace(replacement)])
    stop()
  })

  it('uses an already-seeded historical fence as the fallback baseline', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', undefined)
    const historical = { workspaceId: 'workspace', replacementEpoch: 17 }
    seedBroadcastWorkspaceSnapshot(historical)
    __setBroadcastFallbackReaderForTests(async () => historical)
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))

    await vi.advanceTimersByTimeAsync(0)

    expect(received).toEqual([invalidate(historical)])
    stop()
  })

  it('coalesces inbound work while quiesced and reconciles once on resume', async () => {
    const channel = installBroadcastChannel({ fanOut: true })
    seedBroadcastWorkspaceSnapshot(WORKSPACE)
    const read = vi.fn(async () => WORKSPACE)
    __setBroadcastFallbackReaderForTests(read)
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))
    const inbound = broadcastWorkspaceRuntimeResources['broadcast-remote-inbound']

    inbound.closeAdmissions()
    channel.emit(commit('missed-1'))
    channel.emit(commit('missed-2'))
    expect(received).toEqual([])

    inbound.attach(WORKSPACE)

    expect(read).not.toHaveBeenCalled()
    expect(received).toEqual([invalidate(WORKSPACE)])
    stop()
  })

  it('keeps durable verification closed during startup and catches up once after resume', async () => {
    __resetBroadcastForTests({ admissionsOpen: false })
    const channel = installBroadcastChannel()
    const read = vi.fn(async () => WORKSPACE)
    __setBroadcastFallbackReaderForTests(read)
    const received: WorkspaceChange[] = []
    const stop = subscribeWorkspaceChanges((change) => received.push(change))

    broadcastWorkspaceRuntimeResources.broadcast.attach()
    channel.emit(commit('arrived-during-startup'))
    await tick()

    expect(read).not.toHaveBeenCalled()
    expect(received).toEqual([])

    broadcastWorkspaceRuntimeResources['broadcast-remote-inbound'].attach(WORKSPACE)

    expect(read).not.toHaveBeenCalled()
    expect(received).toEqual([invalidate(WORKSPACE)])
    stop()
  })
})

const WORKSPACE = { workspaceId: 'workspace', replacementEpoch: 1 } as const

function commit(
  commitId: string,
  workspace: { workspaceId: string; replacementEpoch: number } = WORKSPACE,
): WorkspaceChange {
  return {
    kind: 'commit',
    stamp: { ...workspace, commitId },
    delta: { facts: [], invalidations: [{ kind: 'workspace' }] },
  }
}

function attemptTargetCommit(commitId: string): Extract<WorkspaceChange, { kind: 'commit' }> {
  return {
    kind: 'commit',
    stamp: { ...WORKSPACE, commitId },
    delta: {
      facts: [
        {
          kind: 'attempt-target-committed',
          streamId: 'stream-a',
          chatId: 'chat-a',
          messageId: 'message-a',
          attemptKind: 'generation',
          admissionSequence: 4,
          leaseRevision: 7,
          bodyVersion: 3,
        },
      ],
      invalidations: [],
    },
  }
}

function invalidate(workspace: { workspaceId: string; replacementEpoch: number }): WorkspaceChange {
  return { kind: 'invalidate', ...workspace, dependencies: 'all' }
}

function replace(workspace: { workspaceId: string; replacementEpoch: number }): WorkspaceChange {
  return { kind: 'replace', ...workspace }
}

function installBroadcastChannel(options: { fanOut?: boolean } = {}): {
  posted: WorkspaceChange[]
  emit(change: WorkspaceChange): void
} {
  const instances: StubBroadcastChannel[] = []
  const posted: WorkspaceChange[] = []
  class StubBroadcastChannel {
    private readonly messageHandlers = new Set<(event: MessageEvent) => void>()
    private readonly messageErrorHandlers = new Set<() => void>()

    constructor(_name: string) {
      instances.push(this)
    }

    addEventListener(kind: string, handler: EventListener): void {
      if (kind === 'message') {
        this.messageHandlers.add(handler as (event: MessageEvent) => void)
      } else if (kind === 'messageerror') {
        this.messageErrorHandlers.add(handler as () => void)
      }
    }

    close(): void {
      const index = instances.indexOf(this)
      if (index >= 0) instances.splice(index, 1)
    }

    postMessage(value: unknown): void {
      posted.push(value as WorkspaceChange)
      if (!options.fanOut) return
      for (const instance of [...instances]) {
        if (instance !== this) instance.emit(value)
      }
    }

    emit(value: unknown): void {
      for (const handler of [...this.messageHandlers]) handler({ data: value } as MessageEvent)
    }
  }
  vi.stubGlobal('BroadcastChannel', StubBroadcastChannel)
  return {
    posted,
    emit: (change) => instances[0]?.emit(change),
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
