import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetBroadcastForTests,
  type BroadcastEvent,
  onEvent,
  postEvent,
} from '../../src/store/broadcast'

afterEach(() => {
  __resetBroadcastForTests()
})

// Wait for BroadcastChannel's microtask fan-out to complete. Vitest + jsdom
// queue deliveries on the task queue, so `setTimeout(_, 0)` drains them.
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('broadcast', () => {
  it('fans out a posted event to local subscribers exactly once', () => {
    const received: BroadcastEvent[] = []
    const unsub = onEvent((ev) => received.push(ev))
    postEvent({ kind: 'chat-mutated', chatId: 'C1', version: 1 })
    expect(received).toEqual([{ kind: 'chat-mutated', chatId: 'C1', version: 1 }])
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

  it('stops delivering after unsubscribe', () => {
    const received: BroadcastEvent[] = []
    const unsub = onEvent((ev) => received.push(ev))
    postEvent({ kind: 'chat-mutated', chatId: 'C1', version: 1 })
    unsub()
    postEvent({ kind: 'chat-mutated', chatId: 'C1', version: 2 })
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({ kind: 'chat-mutated', chatId: 'C1', version: 1 })
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
    postEvent({ kind: 'chat-mutated', chatId: 'C1', version: 1 })
    // Exactly two events: the original plus the downstream one. No repeat.
    expect(seen).toEqual([
      { kind: 'chat-mutated', chatId: 'C1', version: 1 },
      { kind: 'settings-mutated', key: 'derived' },
    ])
    unsub()
  })
})
