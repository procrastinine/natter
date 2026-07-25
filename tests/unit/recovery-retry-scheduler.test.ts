import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PermanentRecoveryError,
  RecoveryRetryScheduler,
} from '../../src/store/recovery-retry-scheduler'

const retryPolicy = {
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
} as const

afterEach(() => {
  vi.useRealTimers()
})

describe('RecoveryRetryScheduler', () => {
  it('quarantines only an explicitly typed permanent integrity failure', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const due = vi.fn<() => void>()
    const scheduler = new RecoveryRetryScheduler<{ streamId: string }>(due)

    scheduler.recordFailure(
      'stream:a',
      { streamId: 'a' },
      'lease-v1',
      new PermanentRecoveryError('persisted lease integrity failure'),
      retryPolicy,
    )
    expect(due).not.toHaveBeenCalled()
    expect(scheduler.get('stream:a')).toMatchObject({
      status: 'quarantined',
      attempts: 1,
      evidence: 'lease-v1',
      diagnostic: {
        name: 'PermanentRecoveryError',
        message: 'persisted lease integrity failure',
      },
    })
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(10 * 60_000)
    expect(due).not.toHaveBeenCalled()
  })

  it('releases the retry record and timer immediately after eventual success', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const due = vi.fn<(key: string) => void>()
    const scheduler = new RecoveryRetryScheduler<{ streamId: string }>((key) => {
      due(key)
      scheduler.clear(key)
    })

    scheduler.recordFailure(
      'stream:a',
      { streamId: 'a' },
      'lease-v1',
      new Error('transient'),
      retryPolicy,
    )
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(2_000)

    expect(due).toHaveBeenCalledOnce()
    expect(scheduler.snapshot()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases a permanent quarantine only when semantic evidence changes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(20_000)
    const scheduler = new RecoveryRetryScheduler<{ streamId: string }>(() => undefined)

    scheduler.recordFailure(
      'stream:a',
      { streamId: 'a' },
      'lease-v1',
      new PermanentRecoveryError('invalid lease'),
      retryPolicy,
    )
    expect(scheduler.get('stream:a')).toMatchObject({ status: 'quarantined', attempts: 1 })

    scheduler.recordFailure(
      'stream:a',
      { streamId: 'a' },
      'lease-v1',
      new Error('same evidence'),
      retryPolicy,
    )
    expect(scheduler.get('stream:a')).toMatchObject({ status: 'quarantined', attempts: 1 })

    scheduler.recordFailure(
      'stream:a',
      { streamId: 'a' },
      'lease-v2',
      new Error('new progress'),
      retryPolicy,
    )
    expect(scheduler.get('stream:a')).toMatchObject({
      status: 'scheduled',
      attempts: 1,
      evidence: 'lease-v2',
      nextRetryAt: 22_000,
    })
  })

  it('uses one timer for many keys and linearly releases replacement or close state', () => {
    vi.useFakeTimers()
    vi.setSystemTime(30_000)
    const scheduler = new RecoveryRetryScheduler<number>(() => undefined)

    for (let index = 0; index < 1_000; index += 1) {
      scheduler.recordFailure(
        `stream:${index}`,
        index,
        `lease:${index}`,
        new Error('retry'),
        retryPolicy,
      )
    }
    expect(scheduler.snapshot()).toHaveLength(1_000)
    expect(vi.getTimerCount()).toBe(1)

    scheduler.retain((key) => Number(key.slice('stream:'.length)) % 2 === 0)
    expect(scheduler.snapshot()).toHaveLength(500)
    expect(vi.getTimerCount()).toBe(1)

    scheduler.clearAll()
    expect(scheduler.snapshot()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('caps operational retries without entering a fixed-delay busy loop', () => {
    vi.useFakeTimers()
    vi.setSystemTime(40_000)
    const policy = { baseDelayMs: 2_000, maxDelayMs: 60_000 } as const
    const dueAt: number[] = []
    const scheduler = new RecoveryRetryScheduler<undefined>((key, payload, evidence) => {
      dueAt.push(Date.now())
      scheduler.recordFailure(key, payload, evidence, 'still unavailable', policy)
    })

    scheduler.recordFailure('lease-read', undefined, 'workspace-v1', 'unavailable', policy)
    for (const delay of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      vi.advanceTimersByTime(delay)
    }

    expect(dueAt).toEqual([42_000, 46_000, 54_000, 70_000, 102_000, 162_000, 222_000])
    expect(scheduler.get('lease-read')).toMatchObject({ attempts: 8, nextRetryAt: 282_000 })
    expect(vi.getTimerCount()).toBe(1)
    scheduler.clearAll()
  })
})
