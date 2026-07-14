import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'

afterEach(() => {
  vi.restoreAllMocks()
  __resetDbForTests()
})

describe('openDb recovery events', () => {
  it('forwards blocked version changes only for the active open attempt', async () => {
    const db = getDb()
    let rejectOpen!: (reason?: unknown) => void
    const pendingOpen = new Promise<never>((_resolve, reject) => {
      rejectOpen = reject
    })
    vi.spyOn(db, 'open').mockReturnValue(pendingOpen as unknown as ReturnType<typeof db.open>)
    const onBlocked = vi.fn()
    const opening = openDb({ onBlocked })
    const event = { oldVersion: 220, newVersion: 230 } as IDBVersionChangeEvent

    db.on.blocked.fire(event)
    expect(onBlocked).toHaveBeenCalledWith(event)

    rejectOpen(new Error('open failed'))
    await expect(opening).rejects.toThrow('open failed')
    db.on.blocked.fire(event)
    expect(onBlocked).toHaveBeenCalledTimes(1)
  })
})
