import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openMountedRepositoryProjections,
  reconcileMountedRepositoryProjections,
  resetMountedRepositoryProjectionsForTests,
  suspendMountedRepositoryProjections,
} from '../../src/store/mounted-projection-lifecycle'
import type { WorkspaceFence } from '../../src/store/repository'
import {
  createTabCatalogSession,
  type NormalizedTabCatalogRequest,
  type TabCatalogChangeImpact,
  type TabCatalogPage,
  type TabCatalogSessionAdapter,
  type TabCatalogSessionController,
} from '../../src/store/tab-catalog-session'
import {
  prepareLocalWorkspaceChange,
  type WorkspaceEffect,
} from '../../src/store/workspace-effect-hub'
import type { ReadEnvelope, WorkspaceChange } from '../../src/store/workspace-protocol'

const FENCE = Object.freeze({ workspaceId: 'catalog-workspace', replacementEpoch: 0 })

interface CatalogRequest extends WorkspaceFence {
  readonly key: string
  readonly pageSize?: number
}

interface CatalogQuery {
  readonly key: string
}

interface CatalogRow {
  readonly id: string
  readonly value: string
}

interface ReadGate {
  readonly promise: Promise<void>
  readonly release: () => void
  readonly abortable: boolean
}

type Controller = TabCatalogSessionController<CatalogRequest, CatalogRow, number>

const controllers = new Set<Controller>()

beforeEach(() => {
  resetMountedRepositoryProjectionsForTests()
  reconcileMountedRepositoryProjections(FENCE)
  openMountedRepositoryProjections()
})

afterEach(() => {
  for (const controller of controllers) controller.dispose()
  controllers.clear()
  resetMountedRepositoryProjectionsForTests()
})

describe('mounted tab catalog session', () => {
  it('keeps requests pending until one exact runtime open', async () => {
    suspendMountedRepositoryProjections()
    const source = new CatalogSource()
    source.seed('deferred', row('one', 'opened'))
    const controller = createController(source)

    controller.request({ ...FENCE, key: 'deferred' })
    expect(controller.getSnapshot()).toMatchObject({ status: 'loading', interactive: false })
    expect(source.pageReads).toHaveLength(0)
    expect(source.subscriptionCount).toBe(0)

    reconcileMountedRepositoryProjections(FENCE)
    expect(source.pageReads).toHaveLength(0)

    openMountedRepositoryProjections()
    await ready(controller)
    expect(source.pageReads).toHaveLength(1)
    expect(source.subscriptionCount).toBe(1)
  })

  it('owns one changefeed and publishes frozen snapshots to every observer', async () => {
    const source = new CatalogSource()
    source.seed('shared', row('one', 'ready'))
    const controller = createController(source)
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = controller.subscribe(first)
    const unsubscribeSecond = controller.subscribe(second)

    controller.request({ ...FENCE, key: 'shared' })
    await ready(controller)

    expect(source.subscriptionCount).toBe(1)
    expect(first).toHaveBeenCalled()
    expect(second).toHaveBeenCalled()
    expect(Object.isFrozen(controller.getSnapshot())).toBe(true)
    expect(Object.isFrozen(controller.getSnapshot()?.page.rows)).toBe(true)

    unsubscribeFirst()
    expect(source.subscriptionCount).toBe(1)
    unsubscribeSecond()
    expect(source.subscriptionCount).toBe(1)
  })

  it('releases inactive state and starts a fresh read when requested again', async () => {
    const source = new CatalogSource()
    source.seed('released', row('one', 'version-1'))
    const controller = createController(source)
    controller.request({ ...FENCE, key: 'released' })
    await ready(controller)

    controller.release()
    expect(controller.getSnapshot()).toBeNull()
    expect(source.subscriptionCount).toBe(0)

    source.seed('released', row('one', 'version-2'))
    controller.request({ ...FENCE, key: 'released' })
    await ready(controller)
    expect(source.pageReads).toHaveLength(2)
    expect(controller.getSnapshot()?.page.rows).toEqual([row('one', 'version-2')])
  })

  it('publishes one coherent loading frame before the asynchronous result', async () => {
    const source = new CatalogSource()
    source.seed('scheduled', row('one', 'ready'))
    const release = source.blockNextPageRead()
    const controller = createController(source)

    controller.request({ ...FENCE, key: 'scheduled' })
    expect(controller.getSnapshot()).toMatchObject({
      status: 'loading',
      interactive: false,
      page: { rows: [] },
    })

    release()
    await ready(controller)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      interactive: true,
      page: { rows: [{ id: 'one', value: 'ready' }] },
    })
  })

  it('keeps a hung session from blocking an unrelated catalog capability', async () => {
    const blockedSource = new CatalogSource()
    blockedSource.seed('blocked', row('one', 'blocked'))
    blockedSource.blockNextPageRead({ abortable: false })
    const liveSource = new CatalogSource()
    liveSource.seed('live', row('two', 'live'))
    const blocked = createController(blockedSource)
    const live = createController(liveSource)

    blocked.request({ ...FENCE, key: 'blocked' })
    live.request({ ...FENCE, key: 'live' })
    await ready(live)

    expect(blocked.getSnapshot()?.status).toBe('loading')
    expect(live.getSnapshot()?.page.rows).toEqual([row('two', 'live')])
  })

  it('coalesces invalidations behind one uncancellable read and publishes only the rerun', async () => {
    const source = new CatalogSource()
    source.seed('coalesced', row('one', 'stale'))
    const release = source.blockNextPageRead({ abortable: false })
    const controller = createController(source)
    const publishedValues: string[][] = []
    controller.subscribe(() => {
      publishedValues.push(
        controller.getSnapshot()?.page.rows.map((candidate) => candidate.value) ?? [],
      )
    })
    controller.request({ ...FENCE, key: 'coalesced' })
    await waitFor(() => source.pageReads.length === 1)

    source.seed('coalesced', row('one', 'fresh'))
    for (let index = 0; index < 100; index += 1) source.emit(settingInvalidation())
    expect(source.pageReads).toHaveLength(1)
    expect(source.maxActivePageReads).toBe(1)

    release()
    await waitFor(() => source.pageReads.length === 2)
    await ready(controller)
    expect(source.maxActivePageReads).toBe(1)
    expect(controller.getSnapshot()?.page.rows).toEqual([row('one', 'fresh')])
    expect(publishedValues).not.toContainEqual(['stale'])
  })

  it('aborts superseded request keys and lets only the newest key publish', async () => {
    const source = new CatalogSource()
    source.seed('a', row('a', 'A'))
    source.seed('b', row('b', 'B'))
    const release = source.blockNextPageRead()
    const controller = createController(source)

    controller.request({ ...FENCE, key: 'a' })
    await waitFor(() => source.pageSignals.length === 1)
    controller.request({ ...FENCE, key: 'b' })

    expect(source.pageSignals[0]?.aborted).toBe(true)
    release()
    await ready(controller)
    expect(controller.getSnapshot()?.requestKey).toContain(':b:')
    expect(controller.getSnapshot()?.page.rows).toEqual([row('b', 'B')])
  })

  it('aborts the active read when the session releases', async () => {
    const source = new CatalogSource()
    source.seed('release', row('one', 'late'))
    source.blockNextPageRead()
    const controller = createController(source)

    controller.request({ ...FENCE, key: 'release' })
    await waitFor(() => source.pageSignals.length === 1)
    controller.release()

    expect(source.pageSignals[0]?.aborted).toBe(true)
    expect(controller.getSnapshot()).toBeNull()
  })

  it('holds replacement reads closed until the reconciled runtime opens', async () => {
    const source = new CatalogSource()
    source.seed('replacement', row('one', 'before'))
    const controller = createController(source)
    controller.request({ ...FENCE, key: 'replacement' })
    await ready(controller)

    const nextFence = { workspaceId: 'replacement-workspace', replacementEpoch: 1 }
    source.seed('replacement', row('one', 'after'))
    source.setFence(nextFence)
    suspendMountedRepositoryProjections()
    reconcileMountedRepositoryProjections(nextFence)
    await nextTask()

    expect(source.pageReads).toHaveLength(1)
    expect(controller.getSnapshot()).toMatchObject({
      ...nextFence,
      status: 'loading',
      interactive: false,
      page: { rows: [] },
    })

    openMountedRepositoryProjections()
    await ready(controller)
    expect(source.pageReads).toHaveLength(2)
    expect(controller.getSnapshot()?.page.rows).toEqual([row('one', 'after')])
  })

  it('ignores effect kinds outside the adapter capability without changing the snapshot', async () => {
    const source = new CatalogSource()
    source.seed('stable', row('chat-a', 'same'))
    const controller = createController(source)
    controller.request({ ...FENCE, key: 'stable' })
    await ready(controller)
    const readySnapshot = controller.getSnapshot()

    source.emit(messageBodyInvalidation('chat-a'))
    await flushTasks()

    expect(source.pageReads).toHaveLength(1)
    expect(source.pointReads).toHaveLength(0)
    expect(controller.getSnapshot()).toBe(readySnapshot)
  })

  it('point-evaluates an exact changed row and then reconciles the demanded page', async () => {
    const source = new CatalogSource()
    source.seed('exact', row('chat-a', 'before'), row('chat-b', 'stable'))
    const controller = createController(source)
    controller.request({ ...FENCE, key: 'exact' })
    await ready(controller)

    source.seed('exact', row('chat-a', 'after'), row('chat-b', 'stable'))
    source.emit(chatInvalidation('chat-a'))
    await waitFor(() => source.pointReads.length === 1)
    await ready(controller)

    expect(source.pointReads).toEqual([['chat-a']])
    expect(controller.getSnapshot()?.page.rows).toContainEqual(row('chat-a', 'after'))
  })

  it('turns a broad dependency effect into one full refresh', async () => {
    const source = new CatalogSource()
    source.seed('broad', row('one', 'before'))
    const controller = createController(source)
    controller.request({ ...FENCE, key: 'broad' })
    await ready(controller)

    source.seed('broad', row('one', 'after'))
    source.emit(settingInvalidation())
    await waitFor(() => source.pageReads.length === 2)
    await ready(controller)

    expect(source.pointReads).toHaveLength(0)
    expect(controller.getSnapshot()?.page.rows).toEqual([row('one', 'after')])
  })

  it('keeps the last interactive page when a refresh fails', async () => {
    const source = new CatalogSource()
    source.seed('error', row('one', 'last-good'))
    const controller = createController(source)
    controller.request({ ...FENCE, key: 'error' })
    await ready(controller)

    source.failNextPageRead(new Error('read failed'))
    source.emit(settingInvalidation())
    await waitFor(() => controller.getSnapshot()?.status === 'error')

    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      interactive: true,
      page: { rows: [{ id: 'one', value: 'last-good' }] },
      error: new Error('read failed'),
    })
  })

  it('does not resurrect an invalidated in-flight page before a failing rerun', async () => {
    const source = new CatalogSource()
    source.seed('stale-error', row('one', 'stale'))
    const release = source.blockNextPageRead({ abortable: false })
    const controller = createController(source)
    controller.request({ ...FENCE, key: 'stale-error' })
    await waitFor(() => source.pageReads.length === 1)

    source.emit(settingInvalidation())
    source.failNextPageRead(new Error('fresh read failed'))
    release()
    await waitFor(() => controller.getSnapshot()?.status === 'error')

    expect(source.pageReads).toHaveLength(2)
    expect(controller.getSnapshot()?.page.rows).toEqual([])
    expect(controller.getSnapshot()?.error).toEqual(new Error('fresh read failed'))
  })

  it('uses lifecycle suspension to suppress an aborted read and repay it after reopen', async () => {
    const source = new CatalogSource()
    source.seed('lifecycle', row('one', 'before'))
    const controller = createController(source)
    controller.request({ ...FENCE, key: 'lifecycle' })
    await ready(controller)

    source.seed('lifecycle', row('one', 'after'))
    source.blockNextPageRead()
    controller.refresh()
    await waitFor(() => source.pageSignals.length === 2)
    suspendMountedRepositoryProjections()

    expect(source.pageSignals[1]?.aborted).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'refreshing',
      interactive: false,
      error: null,
      page: { rows: [{ id: 'one', value: 'before' }] },
    })

    reconcileMountedRepositoryProjections(FENCE)
    openMountedRepositoryProjections()
    await ready(controller)
    expect(controller.getSnapshot()?.page.rows).toEqual([row('one', 'after')])
  })

  it('does not surface an AbortError from an ordinary cancelled page read', async () => {
    const source = new CatalogSource()
    source.seed('abort', row('one', 'last-good'))
    const controller = createController(source)
    controller.request({ ...FENCE, key: 'abort' })
    await ready(controller)

    source.failNextPageRead(new DOMException('ordinary abort', 'AbortError'))
    source.emit(settingInvalidation())
    await flushTasks()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'refreshing',
      interactive: true,
      error: null,
      page: { rows: [{ id: 'one', value: 'last-good' }] },
    })
  })

  it('still surfaces non-abort storage errors while the lifecycle remains open', async () => {
    const source = new CatalogSource()
    source.seed('database-error', row('one', 'last-good'))
    const controller = createController(source)
    controller.request({ ...FENCE, key: 'database-error' })
    await ready(controller)

    const error = new DOMException('object store missing', 'NotFoundError')
    source.failNextPageRead(error)
    source.emit(settingInvalidation())
    await waitFor(() => controller.getSnapshot()?.status === 'error')

    expect(controller.getSnapshot()?.error).toBe(error)
    expect(controller.getSnapshot()?.page.rows).toEqual([row('one', 'last-good')])
  })

  it('drops late publication after release and restarts without retained cache state', async () => {
    const source = new CatalogSource()
    source.seed('restart', row('one', 'stale'))
    const release = source.blockNextPageRead({ abortable: false })
    const controller = createController(source)
    controller.request({ ...FENCE, key: 'restart' })
    await waitFor(() => source.pageReads.length === 1)
    controller.release()

    source.seed('restart', row('one', 'fresh'))
    release()
    await flushTasks()
    expect(controller.getSnapshot()).toBeNull()

    controller.request({ ...FENCE, key: 'restart' })
    await ready(controller)
    expect(controller.getSnapshot()?.page.rows).toEqual([row('one', 'fresh')])
  })

  it('starts a fresh A read after an A to B to A return', async () => {
    const source = new CatalogSource()
    source.seed('a', row('a', 'A'))
    source.seed('b', row('b', 'B'))
    const release = source.blockNextPageRead({ abortable: false })
    const controller = createController(source)
    controller.request({ ...FENCE, key: 'a' })
    await waitFor(() => source.pageReads.length === 1)

    controller.request({ ...FENCE, key: 'b' })
    await ready(controller)
    controller.request({ ...FENCE, key: 'a' })
    await ready(controller)

    expect(source.pageReads.map((read) => read.key)).toEqual(['a', 'b', 'a'])
    expect(controller.getSnapshot()?.page.rows).toEqual([row('a', 'A')])
    release()
    await flushTasks()
    expect(controller.getSnapshot()?.page.rows).toEqual([row('a', 'A')])
  })

  it('treats an identical normalized request as a no-op', async () => {
    const source = new CatalogSource()
    source.seed('stable-request', row('one', 'first'))
    const controller = createController(source)
    const request = { ...FENCE, key: 'stable-request', pageSize: 20 }
    controller.request(request)
    await ready(controller)
    const snapshot = controller.getSnapshot()

    source.seed('stable-request', row('one', 'second'))
    controller.request({ ...request })
    await flushTasks()

    expect(source.pageReads).toHaveLength(1)
    expect(controller.getSnapshot()).toBe(snapshot)
    expect(controller.getSnapshot()?.page.rows).toEqual([row('one', 'first')])
  })

  it('makes dependency matching an adapter capability instead of a consumer key convention', () => {
    const source = new CatalogSource()
    const controller = createController(source)

    expect(() => controller.request({ ...FENCE, key: 'typed-contract' })).not.toThrow()
    source.emit(messageBodyInvalidation('typed-contract'))

    expect(source.pointReads).toHaveLength(0)
  })
})

class CatalogSource {
  readonly pageReads: Array<{ key: string; limit: number }> = []
  readonly pointReads: string[][] = []
  readonly pageSignals: AbortSignal[] = []
  maxActivePageReads = 0
  private activePageReads = 0
  private fence: WorkspaceFence = FENCE
  private readonly rowsByKey = new Map<string, CatalogRow[]>()
  private readonly listeners = new Set<{
    apply: (effect: WorkspaceEffect) => void
    recover: (effect: WorkspaceEffect) => void
  }>()
  private pageReadGate: ReadGate | null = null
  private pageReadError: Error | undefined

  get subscriptionCount(): number {
    return this.listeners.size
  }

  seed(key: string, ...rows: CatalogRow[]): void {
    this.rowsByKey.set(
      key,
      rows.map((candidate) => ({ ...candidate })),
    )
  }

  setFence(fence: WorkspaceFence): void {
    this.fence = Object.freeze({ ...fence })
  }

  blockNextPageRead(options: { abortable?: boolean } = {}): () => void {
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    this.pageReadGate = { promise, release, abortable: options.abortable ?? true }
    return release
  }

  failNextPageRead(error: Error): void {
    this.pageReadError = error
  }

  subscribe = (
    apply: (effect: WorkspaceEffect) => void,
    recover: (effect: WorkspaceEffect) => void,
  ): (() => void) => {
    const listener = { apply, recover }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(change: WorkspaceChange): void {
    const effect = prepareLocalWorkspaceChange(change).effect
    for (const listener of [...this.listeners]) listener.apply(effect)
  }

  readPage = async (
    query: CatalogQuery,
    page: { readonly cursor?: string; readonly limit: number },
    signal: AbortSignal,
  ): Promise<ReadEnvelope<TabCatalogPage<CatalogRow, number>>> => {
    this.pageReads.push({ key: query.key, limit: page.limit })
    this.pageSignals.push(signal)
    const rows = (this.rowsByKey.get(query.key) ?? []).map((candidate) => ({ ...candidate }))
    const gate = this.pageReadGate
    const error = this.pageReadError
    this.pageReadGate = null
    this.pageReadError = undefined
    this.activePageReads += 1
    this.maxActivePageReads = Math.max(this.maxActivePageReads, this.activePageReads)
    try {
      if (gate) {
        if (gate.abortable) await Promise.race([gate.promise, aborted(signal)])
        else await gate.promise
      }
      if (signal.aborted) throw signal.reason
      if (error !== undefined) throw error
      const offset = page.cursor ? Number(page.cursor) : 0
      const selected = rows.slice(offset, offset + page.limit)
      const nextOffset = offset + selected.length
      return {
        workspaceId: this.fence.workspaceId,
        replacementEpoch: this.fence.replacementEpoch,
        value: Object.freeze({
          rows: Object.freeze(selected),
          ...(nextOffset < rows.length ? { nextCursor: String(nextOffset) } : {}),
          meta: rows.length,
        }),
      }
    } finally {
      this.activePageReads -= 1
    }
  }

  evaluate = async (
    query: CatalogQuery,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadEnvelope<readonly (CatalogRow | undefined)[]>> => {
    if (signal.aborted) throw signal.reason
    this.pointReads.push([...ids])
    const rows = this.rowsByKey.get(query.key) ?? []
    return {
      workspaceId: this.fence.workspaceId,
      replacementEpoch: this.fence.replacementEpoch,
      value: Object.freeze(
        ids.map((id) => {
          const candidate = rows.find((row) => row.id === id)
          return candidate ? Object.freeze({ ...candidate }) : undefined
        }),
      ),
    }
  }
}

const adapter = (
  source: CatalogSource,
): TabCatalogSessionAdapter<CatalogRequest, CatalogQuery, CatalogRow, string, number> => ({
  disposedError: 'CatalogSessionDisposed',
  normalize(request): NormalizedTabCatalogRequest<CatalogQuery> {
    const pageSize = request.pageSize ?? 20
    const query = { key: request.key }
    return {
      ...request,
      requestKey: this.requestKey(request, query, pageSize),
      query,
      pageSize,
    }
  },
  requestKey(fence, query, pageSize) {
    return `${fence.workspaceId}:${fence.replacementEpoch}:${query.key}:${pageSize}`
  },
  emptyPage: () => Object.freeze({ rows: Object.freeze([]), meta: 0 }),
  readPage: source.readPage,
  evaluate: source.evaluate,
  changeImpact(effect): TabCatalogChangeImpact<string> {
    if (effect.kind !== 'changed') return noImpact()
    if (effect.impact === 'all') return broadImpact()
    let broad = false
    const changedIds = new Set<string>()
    for (const dependency of effect.impact) {
      if (dependency.kind === 'workspace' || dependency.kind === 'setting') broad = true
      if (dependency.kind === 'chat') {
        for (const chatId of dependency.chatIds ?? []) changedIds.add(chatId)
      }
    }
    return {
      relevant: broad || changedIds.size > 0,
      broad,
      changedIds,
      deletedIds: new Set(),
    }
  },
  rowId: (candidate) => candidate.id,
  cloneRow: (candidate) => Object.freeze({ ...candidate }),
  compareRows: (left, right) => left.id.localeCompare(right.id),
})

function createController(source: CatalogSource): Controller {
  const controller = createTabCatalogSession(adapter(source), source.subscribe)
  controllers.add(controller)
  return controller
}

function row(id: string, value: string): CatalogRow {
  return { id, value }
}

function noImpact(): TabCatalogChangeImpact<string> {
  return { relevant: false, broad: false, changedIds: new Set(), deletedIds: new Set() }
}

function broadImpact(): TabCatalogChangeImpact<string> {
  return { relevant: true, broad: true, changedIds: new Set(), deletedIds: new Set() }
}

function settingInvalidation(): WorkspaceChange {
  return {
    kind: 'invalidate',
    ...FENCE,
    dependencies: [{ kind: 'setting', keys: ['watched'] }],
  }
}

function chatInvalidation(chatId: string): WorkspaceChange {
  return {
    kind: 'invalidate',
    ...FENCE,
    dependencies: [{ kind: 'chat', chatIds: [chatId] }],
  }
}

function messageBodyInvalidation(chatId: string): WorkspaceChange {
  return {
    kind: 'invalidate',
    ...FENCE,
    dependencies: [{ kind: 'message-body', chatId }],
  }
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

async function ready(controller: Controller): Promise<void> {
  await waitFor(() => controller.getSnapshot()?.status === 'ready')
}

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await nextTask()
  }
  throw new Error('ConditionNotMet')
}

async function flushTasks(): Promise<void> {
  await nextTask()
  await Promise.resolve()
  await nextTask()
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(undefined)
  })
}
