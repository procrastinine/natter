import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetBroadcastForTests,
  type BroadcastEvent,
  onEvent,
  postEvent,
} from '../../src/store/broadcast'
import {
  __resetStreamLeasesForTests,
  getStreamClientId,
  installStreamLeaseListener,
  requestAbortForChat,
} from '../../src/store/stream-leases'
import { useStreamStore } from '../../src/store/zustand/streamStore'

beforeEach(() => {
  __resetBroadcastForTests()
  __resetStreamLeasesForTests()
  useStreamStore.getState().reset()
})

afterEach(() => {
  __resetBroadcastForTests()
  __resetStreamLeasesForTests()
  useStreamStore.getState().reset()
})

describe('stream leases', () => {
  it('mirrors fresh remote leases into stream status and clears on stream end', () => {
    installStreamLeaseListener()

    postEvent({
      kind: 'stream-heartbeat',
      lease: {
        streamId: 'S-remote',
        chatId: 'C1',
        messageId: 'M1',
        ownerClientId: 'other-tab',
        startedAt: 1,
        heartbeatAt: Date.now(),
      },
    })

    expect(useStreamStore.getState().isTargetActive('C1', 'M1')).toBe(true)
    expect(useStreamStore.getState().hasStreamForChat('C1')).toBe(true)

    postEvent({
      kind: 'stream-ended',
      chatId: 'C1',
      streamId: 'S-remote',
      messageId: 'M1',
      outcome: 'done',
    })

    expect(useStreamStore.getState().isTargetActive('C1', 'M1')).toBe(false)
  })

  it('routes remote abort requests without pretending a remote stream has a local abort', () => {
    installStreamLeaseListener()
    const seen: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => {
      if (event.kind === 'stream-abort-requested') seen.push(event)
    })

    useStreamStore.getState().setActive({
      streamId: 'S-remote',
      chatId: 'C1',
      messageId: 'M1',
      startedAt: 1,
      heartbeatAt: 2,
      ownerClientId: 'other-tab',
    })

    expect(requestAbortForChat('C1')).toBe(1)
    expect(seen).toEqual([
      {
        kind: 'stream-abort-requested',
        chatId: 'C1',
        streamId: 'S-remote',
        ownerClientId: 'other-tab',
      },
    ])
    unsubscribe()
  })

  it('aborts local streams directly', () => {
    installStreamLeaseListener()
    const abort = vi.fn()
    useStreamStore.getState().setActive({
      streamId: 'S-local',
      chatId: 'C1',
      messageId: 'M1',
      startedAt: 1,
      ownerClientId: getStreamClientId(),
      abort,
    })

    expect(requestAbortForChat('C1')).toBe(1)
    expect(abort).toHaveBeenCalledTimes(1)
  })
})
