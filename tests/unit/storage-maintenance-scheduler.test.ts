import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { yieldToEventLoop } from '../../src/lib/yield-to-event-loop'
import type { BrowserWorkspaceCompactionResult } from '../../src/store/browser-workspace-compaction'
import type { BrowserWorkspaceReplacementCommit } from '../../src/store/browser-workspace-contract'
import { createBrowserWorkspacePromotedReplacementDrain } from '../../src/store/browser-workspace-lifecycle'
import { createDbForTests } from '../../src/store/db'
import {
  __linkedStorageMaintenanceAbortControllerForTests,
  __runStorageMaintenancePumpForTests,
} from '../../src/store/storage-maintenance-runtime'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('parks storage maintenance until the runtime-idle signal reopens its pump', () => {
  const source = readFileSync(
    resolve(__dirname, '../../src/store/storage-maintenance-runtime.ts'),
    'utf8',
  )
  const scheduleStart = source.indexOf('#schedulePump(): void {')
  const idleStart = source.indexOf('#receiveRuntimeIdle(): void {')
  const schedulePump = source.slice(scheduleStart, source.indexOf('async #runPump', scheduleStart))
  const receiveRuntimeIdle = source.slice(
    idleStart,
    source.indexOf('#publishCompactionWake', idleStart),
  )

  expect(schedulePump).toContain('this.#waitingForRuntimeIdle')
  expect(receiveRuntimeIdle).toMatch(
    /if \(!this\.#waitingForRuntimeIdle\) return[\s\S]*this\.#waitingForRuntimeIdle = false[\s\S]*this\.#schedulePump\(\)/u,
  )
})

it('transfers promoted replacement custody before ending the finalized maintenance pump', () => {
  const source = readFileSync(
    resolve(__dirname, '../../src/store/storage-maintenance-runtime.ts'),
    'utf8',
  )
  const scheduleStart = source.indexOf('#schedulePump(): void {')
  const pumpStart = source.indexOf('async #runPump', scheduleStart)
  const compactionStart = source.indexOf('async #runCompactionSlice', pumpStart)
  const compactionEnd = source.indexOf('async #runIdleSlice', compactionStart)
  const schedulePump = source.slice(scheduleStart, pumpStart)
  const runPump = source.slice(pumpStart, compactionStart)
  const runCompaction = source.slice(compactionStart, compactionEnd)

  expect(schedulePump).toMatch(
    /const finalized = runStorageMaintenancePump\(\(\) => this\.#runPump\(generation\)\)\.finally[\s\S]*this\.#pumpTask = finalized/u,
  )
  expect(runPump).toContain("if (outcome.kind === 'handoff') return")
  expect(runCompaction).not.toContain('#observeTransitionHandoff')
  expect(runCompaction.indexOf('readStorageCompactionState')).toBeLessThan(
    runCompaction.indexOf("import('./browser-workspace-compaction')"),
  )
  expect(runCompaction).toMatch(
    /this\.#replacementHandoffs\.transfer\(started\.handoff\)[\s\S]*return \{ kind: 'handoff' \}/u,
  )
})

it('starts the maintenance pump outside an ambient Dexie transaction', async () => {
  const db = createDbForTests(`natter-maintenance-zone-${crypto.randomUUID()}`)
  await db.open()
  let pump: Promise<void> | undefined
  let observed: unknown
  try {
    await db.transaction('r', db.settings, () => {
      expect(Dexie.currentTransaction).not.toBeNull()
      pump = __runStorageMaintenancePumpForTests(async () => {
        observed = Dexie.currentTransaction
      })
    })
    await pump
    expect(observed).toBeNull()
  } finally {
    db.close()
    await Dexie.delete(db.name)
  }
})

it('keeps promoted replacement custody alive after the producer closes and drains it exactly once', async () => {
  const drain = createBrowserWorkspacePromotedReplacementDrain()
  const completion = deferred<BrowserWorkspaceReplacementCommit<BrowserWorkspaceCompactionResult>>()

  drain.handoffs.transfer({ completion: completion.promise })
  drain.closeAdmissions()
  const idle = drain.awaitIdle()
  let settled = false
  void idle.then(() => {
    settled = true
  })

  await Promise.resolve()
  expect(settled).toBe(false)
  expect(() => drain.assertClosed()).toThrow('BrowserWorkspacePromotedReplacementDrainNotClosed')

  completion.resolve({
    workspace: { workspaceId: 'workspace', replacementEpoch: 2 },
    storageBaseline: { kind: 'carry-source', liveBytes: 0 },
    value: { copiedRows: 0, estimatedLiveBytes: 0 },
  })
  await idle

  expect(settled).toBe(true)
  drain.assertClosed()
  expect(() => drain.handoffs.transfer({ completion: completion.promise })).toThrow(
    'BrowserWorkspacePromotedReplacementDrainClosed',
  )
})

it('forwards the exact abort source reason and disposes every linked listener', () => {
  const first = new AbortController()
  const second = new AbortController()
  const removeFirst = vi.spyOn(first.signal, 'removeEventListener')
  const removeSecond = vi.spyOn(second.signal, 'removeEventListener')
  const linked = __linkedStorageMaintenanceAbortControllerForTests(first.signal, second.signal)
  const reason = new DOMException('lease ownership lost', 'AbortError')

  second.abort(reason)

  expect(linked.controller.signal.aborted).toBe(true)
  expect(linked.controller.signal.reason).toBe(reason)
  expect(removeFirst).toHaveBeenCalledWith('abort', expect.any(Function))
  expect(removeSecond).toHaveBeenCalledWith('abort', expect.any(Function))

  first.abort(new Error('late parent abort'))
  expect(linked.controller.signal.reason).toBe(reason)
})

it('removes earlier listeners when a later source is already aborted', () => {
  const first = new AbortController()
  const second = new AbortController()
  const removeFirst = vi.spyOn(first.signal, 'removeEventListener')
  const reason = new DOMException('workspace already closed', 'AbortError')
  second.abort(reason)

  const linked = __linkedStorageMaintenanceAbortControllerForTests(first.signal, second.signal)

  expect(linked.controller.signal.reason).toBe(reason)
  expect(removeFirst).toHaveBeenCalledWith('abort', expect.any(Function))
})

it('releases a fallback yield immediately when its owning work is aborted', async () => {
  vi.stubGlobal('scheduler', undefined)
  vi.stubGlobal('MessageChannel', undefined)
  vi.useFakeTimers()
  const controller = new AbortController()
  const yielded = yieldToEventLoop(controller.signal)

  controller.abort(new DOMException('workspace closed', 'AbortError'))

  await expect(yielded).resolves.toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

it('treats scheduler rejection as a hint failure and falls back to a total event-loop yield', async () => {
  vi.stubGlobal('scheduler', {
    yield: vi.fn().mockRejectedValue(new Error('scheduler unavailable')),
  })
  vi.stubGlobal('MessageChannel', undefined)
  vi.useFakeTimers()

  const yielded = yieldToEventLoop()
  await vi.runAllTimersAsync()

  await expect(yielded).resolves.toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

it('treats a synchronous scheduler throw as a hint failure and uses the same fallback', async () => {
  vi.stubGlobal('scheduler', {
    yield: vi.fn(() => {
      throw new Error('scheduler detached')
    }),
  })
  vi.stubGlobal('MessageChannel', undefined)
  vi.useFakeTimers()

  const yielded = yieldToEventLoop()
  await vi.runAllTimersAsync()

  await expect(yielded).resolves.toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

it('settles an aborted scheduler yield without starting a fallback timer', async () => {
  let rejectYield!: (error: unknown) => void
  vi.stubGlobal('scheduler', {
    yield: () =>
      new Promise<void>((_resolve, reject) => {
        rejectYield = reject
      }),
  })
  vi.stubGlobal('MessageChannel', undefined)
  vi.useFakeTimers()
  const controller = new AbortController()
  const yielded = yieldToEventLoop(controller.signal)

  controller.abort(new DOMException('workspace closed', 'AbortError'))
  rejectYield(new Error('late scheduler rejection'))

  await expect(yielded).resolves.toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

function deferred<Value>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
} {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
