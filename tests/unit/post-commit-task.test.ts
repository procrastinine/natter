import { afterEach, describe, expect, it } from 'vitest'
import {
  flushPostCommitTasksForTests,
  invalidatePostCommitTasks,
  postCommitTaskStatsForTests,
  resetPostCommitTasksForTests,
  schedulePostCommitTask,
} from '../../src/core/post-commit-task'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(resetPostCommitTasksForTests)

describe('post-commit task scheduler', () => {
  it('bounds physically hung work and expires queued work logically', async () => {
    const gates = Array.from({ length: 20 }, deferred)
    let started = 0
    const admitted = gates.map((gate) =>
      schedulePostCommitTask(
        async () => {
          started += 1
          await gate.promise
        },
        { timeoutMs: 10 },
      ),
    )

    expect(admitted.filter(Boolean)).toHaveLength(18)
    await flushPostCommitTasksForTests()
    expect(started).toBe(2)
    expect(postCommitTaskStatsForTests()).toEqual({ running: 2, queued: 0, logical: 0 })

    expect(
      schedulePostCommitTask(
        async () => {
          started += 1
        },
        { timeoutMs: 5 },
      ),
    ).toBe(true)
    await flushPostCommitTasksForTests()
    expect(started).toBe(2)

    for (const gate of gates) gate.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })

  it('invalidates the currentness token without waiting for a hung operation', async () => {
    const gate = deferred()
    let current: (() => boolean) | undefined
    let signal: AbortSignal | undefined
    schedulePostCommitTask(
      async (isCurrent, operationSignal) => {
        current = isCurrent
        signal = operationSignal
        await gate.promise
      },
      { timeoutMs: 1_000 },
    )
    await Promise.resolve()

    expect(current?.()).toBe(true)
    invalidatePostCommitTasks()
    await flushPostCommitTasksForTests()
    expect(current?.()).toBe(false)
    expect(signal?.aborted).toBe(true)
    gate.resolve()
  })

  it('aborts admitted work when its deadline expires', async () => {
    let signal: AbortSignal | undefined
    schedulePostCommitTask(
      async (_isCurrent, operationSignal) => {
        signal = operationSignal
        await new Promise<void>((resolve) =>
          operationSignal.addEventListener('abort', () => resolve(), { once: true }),
        )
      },
      { timeoutMs: 10 },
    )

    await flushPostCommitTasksForTests()
    expect(signal?.aborted).toBe(true)
  })
})
