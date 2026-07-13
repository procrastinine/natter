import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __buildBroadDexieObservabilitySetForTests,
  __resetBroadcastForTests,
  __setBroadcastFallbackReaderForTests,
  type BroadcastEvent,
  onEvent,
  postEvent,
} from '../../src/store/broadcast'

afterEach(() => {
  __resetBroadcastForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Wait for BroadcastChannel's microtask fan-out to complete. Vitest + jsdom
// queue deliveries on the task queue, so `setTimeout(_, 0)` drains them.
const tick = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms))

function observabilityDb(): Dexie {
  const db = new Dexie(`broadcast-observability-${Math.random().toString(36).slice(2)}`)
  db.version(1).stores({
    things: '&id, value, *tags',
    settings: '&key',
  })
  return db
}

describe('broadcast', () => {
  it('fans out a posted event to local subscribers exactly once', () => {
    const received: BroadcastEvent[] = []
    const unsub = onEvent((ev) => received.push(ev))
    postEvent({
      kind: 'chat-mutated',
      chatId: 'C1',
      metaVersion: 1,
      summaryVersion: 2,
      affected: [{ kind: 'message', chatId: 'C1', messageId: 'M1' }],
    })
    expect(received).toEqual([
      {
        kind: 'chat-mutated',
        chatId: 'C1',
        metaVersion: 1,
        summaryVersion: 2,
        affected: [{ kind: 'message', chatId: 'C1', messageId: 'M1' }],
      },
    ])
    unsub()
  })

  it('delivers to every local subscriber, each exactly once', () => {
    let count1 = 0
    let count2 = 0
    const u1 = onEvent(() => {
      count1 += 1
    })
    const u2 = onEvent(() => {
      count2 += 1
    })
    postEvent({ kind: 'profile-mutated', profileId: 'P1' })
    postEvent({ kind: 'profile-mutated', profileId: 'P2' })
    expect(count1).toBe(2)
    expect(count2).toBe(2)
    u1()
    u2()
  })

  it('isolates subscriber failures from later handlers and callers', () => {
    const received: BroadcastEvent[] = []
    const bad = onEvent(() => {
      throw new Error('listener failed')
    })
    const good = onEvent((event) => received.push(event))

    expect(() => postEvent({ kind: 'settings-mutated', key: 'safe' })).not.toThrow()
    expect(received).toEqual([{ kind: 'settings-mutated', key: 'safe' }])

    bad()
    good()
  })

  it('recreates the channel and retries one failed post without duplicating local delivery', () => {
    let constructions = 0
    const posted: BroadcastEvent[] = []
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        private readonly fail = constructions++ === 0

        addEventListener() {}
        close() {}
        postMessage(event: BroadcastEvent) {
          if (this.fail) throw new Error('channel became unusable')
          posted.push(event)
        }
      },
    )
    const received: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => received.push(event))
    const event = { kind: 'settings-mutated' as const, key: 'retry-safe' }

    expect(() => postEvent(event)).not.toThrow()
    expect(constructions).toBe(2)
    expect(posted).toEqual([event])
    expect(received).toEqual([event])

    unsubscribe()
  })

  it('falls back to polling after a repeated post failure and still fans out locally', async () => {
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
    const db = observabilityDb()
    const read = vi.fn(async () => ({ db, mutationCounter: 3 }))
    __setBroadcastFallbackReaderForTests(read)
    const received: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => received.push(event))
    const event = { kind: 'settings-mutated' as const, key: 'committed' }

    expect(() => postEvent(event)).not.toThrow()
    expect(constructions).toBe(2)
    expect(received).toContainEqual(event)
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)
    expect(received).toContainEqual({ kind: 'workspace-invalidated', mutationCounter: 3 })

    unsubscribe()
    db.close()
  })

  it('switches to polling when the channel reports a messageerror', async () => {
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
    const db = observabilityDb()
    const read = vi.fn(async () => ({ db, mutationCounter: 5 }))
    __setBroadcastFallbackReaderForTests(read)
    const received: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => received.push(event))

    reportMessageError?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(read).toHaveBeenCalledTimes(1)
    expect(received).toEqual([{ kind: 'workspace-invalidated', mutationCounter: 5 }])

    unsubscribe()
    db.close()
  })

  it('stops delivering after unsubscribe', () => {
    const received: BroadcastEvent[] = []
    const unsub = onEvent((ev) => received.push(ev))
    postEvent({
      kind: 'chat-mutated',
      chatId: 'C1',
      metaVersion: 1,
      summaryVersion: 1,
      affected: [{ kind: 'chat-meta', chatId: 'C1' }],
    })
    unsub()
    postEvent({
      kind: 'chat-mutated',
      chatId: 'C1',
      metaVersion: 2,
      summaryVersion: 2,
      affected: [{ kind: 'chat-meta', chatId: 'C1' }],
    })
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({
      kind: 'chat-mutated',
      chatId: 'C1',
      metaVersion: 1,
      summaryVersion: 1,
      affected: [{ kind: 'chat-meta', chatId: 'C1' }],
    })
  })

  it('crosses a BroadcastChannel to other tabs exactly once and does not echo to the sender', async () => {
    // Tag the event with a unique marker because Node's BroadcastChannel is
    // process-global — under vitest's default threads pool, other test files
    // running in the same process post events on this channel too.
    const marker = `broadcast-test-${Math.random().toString(36).slice(2)}`
    const otherTab = new BroadcastChannel('llm-api-frontend')
    const receivedByOther: BroadcastEvent[] = []
    const receivedByLocal: BroadcastEvent[] = []
    otherTab.addEventListener('message', (ev) => {
      const event = ev.data as BroadcastEvent
      if (event.kind === 'preset-mutated' && event.presetId === marker) {
        receivedByOther.push(event)
      }
    })
    const unsubLocal = onEvent((ev) => {
      if (ev.kind === 'preset-mutated' && ev.presetId === marker) {
        receivedByLocal.push(ev)
      }
    })
    postEvent({ kind: 'preset-mutated', presetId: marker })
    await tick()
    expect(receivedByOther).toEqual([{ kind: 'preset-mutated', presetId: marker }])
    // Local subscriber saw it from the direct dispatch path.
    expect(receivedByLocal).toEqual([{ kind: 'preset-mutated', presetId: marker }])
    // The posting tab's own BroadcastChannel does NOT echo — confirmed because
    // the local count is 1 (direct dispatch), not 2 (dispatch + BC echo).
    unsubLocal()
    otherTab.close()
  })

  it('does not echo-loop when a subscriber posts a different event', () => {
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => {
      seen.push(ev)
      if (ev.kind === 'chat-mutated' && seen.length === 1) {
        postEvent({ kind: 'settings-mutated', key: 'derived' })
      }
    })
    postEvent({
      kind: 'chat-mutated',
      chatId: 'C1',
      metaVersion: 1,
      summaryVersion: 1,
      affected: [{ kind: 'children', chatId: 'C1', parentId: null }],
    })
    // Exactly two events: the original plus the downstream one. No repeat.
    expect(seen).toEqual([
      {
        kind: 'chat-mutated',
        chatId: 'C1',
        metaVersion: 1,
        summaryVersion: 1,
        affected: [{ kind: 'children', chatId: 'C1', parentId: null }],
      },
      { kind: 'settings-mutated', key: 'derived' },
    ])
    unsub()
  })

  it('builds broad Dexie invalidation ranges from every actual table and index', () => {
    const db = observabilityDb()
    const parts = __buildBroadDexieObservabilitySetForTests(db)
    const prefix = `idb://${db.name}`

    expect(Object.keys(parts)).toEqual(
      expect.arrayContaining([
        `${prefix}/things/`,
        `${prefix}/things/:dels`,
        `${prefix}/things/value`,
        `${prefix}/things/tags`,
        `${prefix}/settings/`,
        `${prefix}/settings/:dels`,
      ]),
    )
    expect(Object.keys(parts)).toHaveLength(6)
    db.close()
  })

  it('polls mutationCounter without BroadcastChannel and coalesces missed increments', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', undefined)
    const db = observabilityDb()
    let mutationCounter = 1
    const read = vi.fn(async () => ({ db, mutationCounter }))
    const storageMutated = vi.spyOn(Dexie.on.storagemutated, 'fire')
    __setBroadcastFallbackReaderForTests(read)
    const received: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => received.push(event))

    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)

    mutationCounter = 4
    await vi.advanceTimersByTimeAsync(1_000)
    mutationCounter = 8
    await vi.advanceTimersByTimeAsync(1_000)
    mutationCounter = 1
    await vi.advanceTimersByTimeAsync(1_000)

    expect(received).toEqual([
      { kind: 'workspace-invalidated', mutationCounter: 1 },
      { kind: 'workspace-invalidated', mutationCounter: 4 },
      { kind: 'workspace-invalidated', mutationCounter: 8 },
      { kind: 'workspace-invalidated', mutationCounter: 1 },
    ])
    expect(storageMutated).toHaveBeenCalledTimes(4)

    unsubscribe()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(read).toHaveBeenCalledTimes(4)
    db.close()
  })

  it('allows only one fallback read in flight', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', undefined)
    const db = observabilityDb()
    let resolveFirst!: (snapshot: { db: Dexie; mutationCounter: number }) => void
    const first = new Promise<{ db: Dexie; mutationCounter: number }>((resolve) => {
      resolveFirst = resolve
    })
    const read = vi
      .fn<() => Promise<{ db: Dexie; mutationCounter: number }>>()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ db, mutationCounter: 1 })
    __setBroadcastFallbackReaderForTests(read)
    const unsubscribe = onEvent(() => {})

    await vi.advanceTimersByTimeAsync(5_000)
    expect(read).toHaveBeenCalledTimes(1)

    resolveFirst({ db, mutationCounter: 1 })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(2)

    unsubscribe()
    db.close()
  })

  it('invalidates when the first fallback read resolves after a concurrent commit', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', undefined)
    const db = observabilityDb()
    let resolveFirst!: (snapshot: { db: Dexie; mutationCounter: number }) => void
    const first = new Promise<{ db: Dexie; mutationCounter: number }>((resolve) => {
      resolveFirst = resolve
    })
    const read = vi.fn(() => first)
    const storageMutated = vi.spyOn(Dexie.on.storagemutated, 'fire')
    __setBroadcastFallbackReaderForTests(read)
    const received: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => received.push(event))

    await vi.advanceTimersByTimeAsync(0)
    resolveFirst({ db, mutationCounter: 9 })
    await vi.advanceTimersByTimeAsync(0)

    expect(received).toEqual([{ kind: 'workspace-invalidated', mutationCounter: 9 }])
    expect(storageMutated).toHaveBeenCalledTimes(1)

    unsubscribe()
    db.close()
  })

  it('contains fallback read failures and retries on the next interval', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('BroadcastChannel', undefined)
    const db = observabilityDb()
    const read = vi
      .fn<() => Promise<{ db: Dexie; mutationCounter: number }>>()
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce({ db, mutationCounter: 2 })
      .mockResolvedValueOnce({ db, mutationCounter: 3 })
    __setBroadcastFallbackReaderForTests(read)
    const received: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => received.push(event))

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(read).toHaveBeenCalledTimes(3)
    expect(received).toEqual([
      { kind: 'workspace-invalidated', mutationCounter: 2 },
      { kind: 'workspace-invalidated', mutationCounter: 3 },
    ])

    unsubscribe()
    db.close()
  })

  it('falls back when BroadcastChannel construction throws', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor() {
          throw new Error('BroadcastChannel denied')
        }
      },
    )
    const db = observabilityDb()
    const read = vi.fn(async () => ({ db, mutationCounter: 1 }))
    __setBroadcastFallbackReaderForTests(read)

    const unsubscribe = onEvent(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(read).toHaveBeenCalledTimes(1)

    unsubscribe()
    db.close()
  })

  it('suppresses fallback polling when BroadcastChannel is available', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        addEventListener() {}
        postMessage() {}
        close() {}
      },
    )
    const read = vi.fn(async () => ({ db: observabilityDb(), mutationCounter: 1 }))
    __setBroadcastFallbackReaderForTests(read)

    const unsubscribe = onEvent(() => {})
    await vi.advanceTimersByTimeAsync(10_000)
    expect(read).not.toHaveBeenCalled()

    unsubscribe()
  })
})
