import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markLifecycleTarget, startRequestLifecycle } from '../../src/hooks/requestLifecycle'
import { useAnnouncementStore } from '../../src/store/zustand/announcementStore'
import { useStreamStore } from '../../src/store/zustand/streamStore'

const streamLeaseMocks = vi.hoisted(() => ({
  announceStreamEnded: vi.fn(),
  startStreamLease: vi.fn(),
  stopStreamLease: vi.fn(),
}))

vi.mock('../../src/store/broadcast', () => ({ postEvent: vi.fn() }))
vi.mock('../../src/store/stream-leases', () => ({
  announceStreamEnded: streamLeaseMocks.announceStreamEnded,
  getStreamClientId: () => 'accessibility-test-client',
  startStreamLease: streamLeaseMocks.startStreamLease,
  stopStreamLease: streamLeaseMocks.stopStreamLease,
}))

const FENCE = {
  ownerClientId: 'accessibility-test-client',
  fenceToken: 'fence-token',
  replacementEpoch: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  streamLeaseMocks.startStreamLease.mockResolvedValue(FENCE)
  streamLeaseMocks.stopStreamLease.mockResolvedValue(undefined)
  useAnnouncementStore.getState().reset()
  useStreamStore.getState().reset()
})

afterEach(() => {
  useAnnouncementStore.getState().reset()
  useStreamStore.getState().reset()
})

async function targetLifecycle(streamId: string) {
  const lifecycle = await startRequestLifecycle({
    chatId: 'chat-a11y',
    streamId,
    attemptKind: 'generation',
  })
  await markLifecycleTarget({
    chatId: 'chat-a11y',
    streamId,
    messageId: `message-${streamId}`,
    abort: lifecycle.abort,
  })
  return lifecycle
}

describe('request lifecycle announcements', () => {
  it('announces a targeted stream once even when its target is marked repeatedly', async () => {
    const lifecycle = await targetLifecycle('stream-repeated-target')

    await markLifecycleTarget({
      chatId: 'chat-a11y',
      streamId: lifecycle.streamId,
      messageId: 'message-stream-repeated-target',
      abort: lifecycle.abort,
    })

    expect(useAnnouncementStore.getState().polite.map((event) => event.text)).toEqual([
      'Assistant is responding.',
    ])
  })

  it('does not announce an untargeted request lifecycle', async () => {
    const untargeted = await startRequestLifecycle({
      chatId: 'chat-a11y',
      streamId: 'stream-untargeted',
      attemptKind: 'generation',
    })
    await untargeted.end('abort')

    expect(useAnnouncementStore.getState().polite).toEqual([])
    expect(useAnnouncementStore.getState().assertive).toEqual([])
  })

  it('announces distinct targeted streams independently', async () => {
    await targetLifecycle('stream-a')
    await targetLifecycle('stream-b')

    expect(useAnnouncementStore.getState().polite.map((event) => event.text)).toEqual([
      'Assistant is responding.',
      'Assistant is responding.',
    ])
  })
})
