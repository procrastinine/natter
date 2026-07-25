import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  localTransactionActivityStats,
  resumeLocalTransactionAdmissions,
  runWithLocalReadActivity,
  runWithLocalWriteActivity,
  stopLocalTransactionAdmissions,
  waitForLocalTransactionIdle,
} from '../../src/store/transaction-activity'

beforeEach(() => {
  resumeLocalTransactionAdmissions()
})

afterEach(async () => {
  await waitForLocalTransactionIdle()
  stopLocalTransactionAdmissions()
})

describe('local transaction activity', () => {
  it('runs same-mode work concurrently and alternates queued mode phases in FIFO order', async () => {
    const active = { read: 0, write: 0 }
    const maximum = { read: 0, write: 0 }
    const starts: string[] = []
    const overlap: string[] = []
    const firstRead = activity('read', 'read-1')
    const secondRead = activity('read', 'read-2')
    await Promise.all([firstRead.started.promise, secondRead.started.promise])
    expect(maximum.read).toBe(2)

    const firstWrite = activity('write', 'write-1')
    const thirdRead = activity('read', 'read-3')
    const secondWrite = activity('write', 'write-2')
    expect(starts).toEqual(['read-1', 'read-2'])

    firstRead.release.resolve()
    secondRead.release.resolve()
    await firstWrite.started.promise
    expect(starts).toEqual(['read-1', 'read-2', 'write-1'])

    firstWrite.release.resolve()
    await thirdRead.started.promise
    expect(starts).toEqual(['read-1', 'read-2', 'write-1', 'read-3'])

    thirdRead.release.resolve()
    await secondWrite.started.promise
    expect(starts).toEqual(['read-1', 'read-2', 'write-1', 'read-3', 'write-2'])

    secondWrite.release.resolve()
    await Promise.all([
      firstRead.result,
      secondRead.result,
      firstWrite.result,
      thirdRead.result,
      secondWrite.result,
    ])
    expect(overlap).toEqual([])

    function activity(mode: 'read' | 'write', name: string) {
      const started = deferred<void>()
      const release = deferred<void>()
      const run = mode === 'read' ? runWithLocalReadActivity : runWithLocalWriteActivity
      const result = run(async () => {
        starts.push(name)
        active[mode] += 1
        maximum[mode] = Math.max(maximum[mode], active[mode])
        if (active[mode === 'read' ? 'write' : 'read'] !== 0) overlap.push(name)
        started.resolve()
        try {
          await release.promise
          return name
        } finally {
          active[mode] -= 1
        }
      })
      return { result, started, release }
    }
  })

  it('admits one hundred writes in the same phase without serializing them', async () => {
    const readRelease = deferred<void>()
    const readStarted = deferred<void>()
    const read = runWithLocalReadActivity(async () => {
      readStarted.resolve()
      await readRelease.promise
    })
    await readStarted.promise

    const writeRelease = deferred<void>()
    let activeWrites = 0
    let maximumWrites = 0
    const writeStarts = Array.from({ length: 100 }, () => deferred<void>())
    const writes = writeStarts.map((started) =>
      runWithLocalWriteActivity(async () => {
        activeWrites += 1
        maximumWrites = Math.max(maximumWrites, activeWrites)
        started.resolve()
        try {
          await writeRelease.promise
        } finally {
          activeWrites -= 1
        }
      }),
    )

    readRelease.resolve()
    await read
    await Promise.all(writeStarts.map((started) => started.promise))
    expect(maximumWrites).toBe(100)
    writeRelease.resolve()
    await Promise.all(writes)
  })

  it('releases phases after synchronous throws and asynchronous rejections', async () => {
    const heldRead = deferred<void>()
    const read = runWithLocalReadActivity(() => heldRead.promise)
    const syncFailure = runWithLocalWriteActivity(() => {
      throw new Error('sync failure')
    })
    const asyncFailure = runWithLocalWriteActivity(() => Promise.reject(new Error('async failure')))
    const finalRead = runWithLocalReadActivity(() => 'unblocked')

    heldRead.resolve()
    await read
    await expect(syncFailure).rejects.toThrow('sync failure')
    await expect(asyncFailure).rejects.toThrow('async failure')
    await expect(finalRead).resolves.toBe('unblocked')
  })

  it('rejects queued and new admissions while physical work drains', async () => {
    const activeRelease = deferred<void>()
    const activeStarted = deferred<void>()
    const active = runWithLocalReadActivity(async () => {
      activeStarted.resolve()
      await activeRelease.promise
    })
    await activeStarted.promise
    const queued = runWithLocalWriteActivity(() => undefined)

    stopLocalTransactionAdmissions()

    await expect(queued).rejects.toThrow('LocalTransactionActivityClosed')
    await expect(runWithLocalReadActivity(() => undefined)).rejects.toThrow(
      'LocalTransactionActivityClosed',
    )
    expect(localTransactionActivityStats()).toEqual({ accepting: false, active: 1, queued: 0 })

    let drained = false
    const drain = waitForLocalTransactionIdle().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    activeRelease.resolve()
    await Promise.all([active, drain])
    expect(localTransactionActivityStats()).toEqual({ accepting: false, active: 0, queued: 0 })
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}
