import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRequestLifecycle } from '../../src/hooks/requestLifecycle'
import { postEvent } from '../../src/store/broadcast'
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
    messageId: `message-${streamId}`,
    attemptKind: 'generation',
  })
  lifecycle.publishTarget()
  return lifecycle
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('request lifecycle announcements', () => {
  it('announces a targeted stream once even when its target is marked repeatedly', async () => {
    const lifecycle = await targetLifecycle('stream-repeated-target')

    lifecycle.publishTarget()

    expect(useAnnouncementStore.getState().polite.map((event) => event.text)).toEqual([
      'Assistant is responding.',
    ])
  })

  it('does not announce a continuation until its exact target is published', async () => {
    const lifecycle = await startRequestLifecycle({
      chatId: 'chat-a11y',
      streamId: 'stream-continuation',
      messageId: 'message-continuation',
      attemptKind: 'continuation',
    })

    expect(useAnnouncementStore.getState().polite).toEqual([])
    expect(useAnnouncementStore.getState().assertive).toEqual([])

    lifecycle.publishTarget()
    expect(useAnnouncementStore.getState().polite.map((event) => event.text)).toEqual([
      'Assistant is responding.',
    ])
    await lifecycle.end('abort')
  })

  it('announces distinct targeted streams independently', async () => {
    await targetLifecycle('stream-a')
    await targetLifecycle('stream-b')

    expect(useAnnouncementStore.getState().polite.map((event) => event.text)).toEqual([
      'Assistant is responding.',
      'Assistant is responding.',
    ])
  })

  it('admits a generation against its final target before publishing it', async () => {
    const lifecycle = await startRequestLifecycle({
      chatId: 'chat-a11y',
      streamId: 'stream-targeted-admission',
      messageId: 'message-targeted-admission',
      attemptKind: 'generation',
    })

    expect(streamLeaseMocks.startStreamLease).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: 'stream-targeted-admission',
        messageId: 'message-targeted-admission',
        attemptKind: 'generation',
      }),
    )
    expect(lifecycle.streamFence).toEqual(FENCE)
    expect(useAnnouncementStore.getState().polite).toEqual([])

    await lifecycle.refreshLease()
    expect(streamLeaseMocks.startStreamLease).toHaveBeenLastCalledWith(
      expect.objectContaining({
        streamId: 'stream-targeted-admission',
        messageId: 'message-targeted-admission',
        replacementEpoch: FENCE.replacementEpoch,
      }),
    )

    lifecycle.publishTarget()
    expect(useAnnouncementStore.getState().polite.map((event) => event.text)).toEqual([
      'Assistant is responding.',
    ])
  })

  it('keeps local origin metadata across target publication without broadcasting it', async () => {
    const lifecycle = await startRequestLifecycle({
      chatId: 'chat-a11y',
      streamId: 'stream-origin-metadata',
      messageId: 'message-origin-metadata',
      attemptKind: 'generation',
      originNavigationRevision: 'tab-navigation-revision',
    })

    expect(useStreamStore.getState().getActive(lifecycle.streamId)).toMatchObject({
      messageId: 'message-origin-metadata',
      attemptKind: 'generation',
      originNavigationRevision: 'tab-navigation-revision',
    })
    lifecycle.publishTarget()
    expect(useStreamStore.getState().getActive(lifecycle.streamId)).toMatchObject({
      messageId: 'message-origin-metadata',
      attemptKind: 'generation',
      originNavigationRevision: 'tab-navigation-revision',
    })
    for (const [event] of vi.mocked(postEvent).mock.calls) {
      expect(event).not.toHaveProperty('originNavigationRevision')
    }
  })

  it('admits a continuation against its exact existing target immediately', async () => {
    const lifecycle = await startRequestLifecycle({
      chatId: 'chat-a11y',
      streamId: 'stream-continuation-admission',
      messageId: 'message-continuation-admission',
      attemptKind: 'continuation',
      originNavigationRevision: 'continue-navigation-revision',
    })

    expect(streamLeaseMocks.startStreamLease).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: 'stream-continuation-admission',
        messageId: 'message-continuation-admission',
        attemptKind: 'continuation',
      }),
    )
    expect(useStreamStore.getState().getActive(lifecycle.streamId)).toMatchObject({
      messageId: 'message-continuation-admission',
      attemptKind: 'continuation',
      originNavigationRevision: 'continue-navigation-revision',
    })
  })

  it('does not announce stream end until persistent target ownership is released', async () => {
    const releaseLease = deferred<void>()
    streamLeaseMocks.stopStreamLease.mockReturnValueOnce(releaseLease.promise)
    const lifecycle = await targetLifecycle('stream-slow-release')

    const ending = lifecycle.end('done')
    await Promise.resolve()

    expect(streamLeaseMocks.announceStreamEnded).not.toHaveBeenCalled()
    expect(useStreamStore.getState().getActive(lifecycle.streamId)).toBeDefined()

    releaseLease.resolve()
    await expect(ending).resolves.toEqual({ recoveryPending: false })
    expect(streamLeaseMocks.announceStreamEnded).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: lifecycle.streamId,
        messageId: lifecycle.messageId,
        outcome: 'done',
      }),
    )
  })

  it('keeps a failed finalization projected and recovery-eligible without announcing end', async () => {
    const lifecycle = await targetLifecycle('stream-recovery-pending')
    lifecycle.preserveLease()

    await expect(lifecycle.end('error')).resolves.toEqual({ recoveryPending: true })

    expect(streamLeaseMocks.announceStreamEnded).not.toHaveBeenCalled()
    expect(useStreamStore.getState().getActive(lifecycle.streamId)).toMatchObject({
      streamId: lifecycle.streamId,
      phase: 'recovery-pending',
      recoveryOutcome: 'error',
    })
    expect(streamLeaseMocks.stopStreamLease).toHaveBeenCalledWith(lifecycle.streamId, {
      deleteRow: false,
    })
  })

  it('keeps a failed lease cleanup recovery-eligible without retaining visible target ownership', async () => {
    streamLeaseMocks.stopStreamLease.mockRejectedValueOnce(new Error('lease delete unavailable'))
    const lifecycle = await targetLifecycle('stream-lease-cleanup-pending')

    await expect(lifecycle.end('done')).resolves.toEqual({ recoveryPending: true })

    expect(streamLeaseMocks.announceStreamEnded).not.toHaveBeenCalled()
    expect(useStreamStore.getState().getActive(lifecycle.streamId)).toMatchObject({
      streamId: lifecycle.streamId,
      phase: 'cleanup-pending',
      recoveryOutcome: 'done',
    })
    expect(
      useStreamStore.getState().getTargetActive('chat-a11y', `message-${lifecycle.streamId}`),
    ).toBeUndefined()
    expect(
      useStreamStore.getState().getLiveSnapshot('chat-a11y', `message-${lifecycle.streamId}`),
    ).toBeUndefined()
  })
})
