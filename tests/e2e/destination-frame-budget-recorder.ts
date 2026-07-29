import type { BrowserContext, Page } from '@playwright/test'
import { expect } from '@playwright/test'

export interface DestinationFrameBudgetTarget {
  readonly chatId: string
  readonly targetHref: string
  readonly targetMessageId: string
  readonly minimumRows: number
}

interface DestinationFramePublication {
  readonly at: number
  readonly renderedCount: number
  readonly totalCount: number
  readonly messageIds: readonly string[]
  readonly presentationKind: string
  readonly branchCounts: string
}

interface DestinationFrameTransaction {
  readonly id: number
  readonly database: string
  readonly mode: IDBTransactionMode
  readonly stores: readonly string[]
  readonly startedAt: number
  readonly completedAt: number | null
  readonly outcome: 'complete' | 'abort' | 'error' | 'pending'
}

interface DestinationFrameRequestRow {
  readonly id: string | null
  readonly chatId: string
  readonly cloneBytes: number
  readonly textBytes: number
}

interface DestinationFrameRequest {
  readonly transactionId: number | null
  readonly source: 'store' | 'index'
  readonly store: string
  readonly index: string | null
  readonly method: string
  readonly key: string | null
  readonly startedAt: number
  readonly settledAt: number | null
  readonly outcome: 'success' | 'error' | 'pending'
  targetRows: DestinationFrameRequestRow[]
}

export interface DestinationFrameBudgetSnapshot {
  readonly schemaVersion: 1
  readonly target: DestinationFrameBudgetTarget
  readonly overflowed: boolean
  readonly gesture: {
    readonly armedAt: number
    readonly pointerAt: number | null
    readonly clickAt: number | null
    readonly clickCount: number
  }
  readonly milestones: {
    readonly firstDestinationPaintAt: number | null
    readonly configuredWindowCompleteAt: number | null
    readonly terminalIdentityRetained: boolean | null
  }
  readonly publications: readonly DestinationFramePublication[]
  readonly transactions: readonly DestinationFrameTransaction[]
  readonly requests: readonly DestinationFrameRequest[]
  readonly longTasks: readonly { readonly startTime: number; readonly duration: number }[]
}

export async function installDestinationFrameBudgetRecorder(
  target: Page | BrowserContext,
): Promise<void> {
  await target.addInitScript(() => {
    const MAX_TRANSACTIONS = 256
    const MAX_REQUESTS = 4_096
    const MAX_PUBLICATIONS = 64
    const MAX_LONG_TASKS = 128
    const transactionIds = new WeakMap<IDBTransaction, number>()
    const encoder = new TextEncoder()
    let nextTransactionId = 1
    let closing = false
    let frozen = false
    let firstDestinationElement: Element | null = null
    const state: {
      target: DestinationFrameBudgetTarget | null
      overflowed: boolean
      gesture: {
        armedAt: number
        pointerAt: number | null
        clickAt: number | null
        clickCount: number
      }
      milestones: {
        firstDestinationPaintAt: number | null
        configuredWindowCompleteAt: number | null
        terminalIdentityRetained: boolean | null
      }
      publications: DestinationFramePublication[]
      transactions: DestinationFrameTransaction[]
      requests: DestinationFrameRequest[]
      longTasks: Array<{ startTime: number; duration: number }>
    } = {
      target: null,
      overflowed: false,
      gesture: { armedAt: 0, pointerAt: null, clickAt: null, clickCount: 0 },
      milestones: {
        firstDestinationPaintAt: null,
        configuredWindowCompleteAt: null,
        terminalIdentityRetained: null,
      },
      publications: [],
      transactions: [],
      requests: [],
      longTasks: [],
    }

    const append = <T>(targetRows: T[], value: T, maximum: number) => {
      if (targetRows.length >= maximum) {
        state.overflowed = true
        return false
      }
      targetRows.push(value)
      return true
    }

    const targetLink = (eventTarget: EventTarget | null) => {
      const element = eventTarget instanceof Element ? eventTarget : null
      const link = element?.closest<HTMLAnchorElement>('[data-ui="chat-row-link"]')
      return Boolean(link && state.target && link.getAttribute('href') === state.target.targetHref)
    }
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (!frozen && targetLink(event.target) && state.gesture.pointerAt === null) {
          state.gesture.pointerAt = performance.now()
        }
      },
      true,
    )
    document.addEventListener(
      'click',
      (event) => {
        if (!frozen && targetLink(event.target)) {
          state.gesture.clickAt ??= performance.now()
          state.gesture.clickCount += 1
        }
      },
      true,
    )

    const textBytes = (value: unknown): number => {
      if (typeof value === 'string') return encoder.encode(value).byteLength
      if (!value || typeof value !== 'object') return 0
      let total = 0
      if (Array.isArray(value)) {
        for (const item of value as unknown[]) total += textBytes(item)
        return total
      }
      for (const key of Object.keys(value)) {
        total += textBytes((value as Record<string, unknown>)[key])
      }
      return total
    }
    const targetRows = (value: unknown): DestinationFrameRequestRow[] => {
      const candidates = Array.isArray(value)
        ? value
        : value && typeof value === 'object' && 'value' in value
          ? [value.value]
          : [value]
      return candidates.flatMap((candidate) => {
        if (!candidate || typeof candidate !== 'object') return []
        const row = candidate as Record<string, unknown>
        if (!state.target || row.chatId !== state.target.chatId) return []
        const serialized = JSON.stringify(candidate)
        return [
          {
            id: typeof row.id === 'string' ? row.id : null,
            chatId: row.chatId,
            cloneBytes: encoder.encode(serialized).byteLength,
            textBytes: textBytes(candidate),
          },
        ]
      })
    }
    const keyText = (value: unknown) => {
      if (value === undefined || value === null) return null
      if (typeof value === 'string' || typeof value === 'number') return String(value)
      if (value instanceof IDBKeyRange) return 'IDBKeyRange'
      return Object.prototype.toString.call(value)
    }
    const recordRequest = (
      request: IDBRequest,
      transaction: IDBTransaction,
      source: 'store' | 'index',
      store: string,
      index: string | null,
      method: string,
      key: unknown,
    ) => {
      if (!state.target || closing || frozen) return
      const record: DestinationFrameRequest = {
        transactionId: transactionIds.get(transaction) ?? null,
        source,
        store,
        index,
        method,
        key: keyText(key),
        startedAt: performance.now(),
        settledAt: null,
        outcome: 'pending',
        targetRows: [],
      }
      if (!append(state.requests, record, MAX_REQUESTS)) return
      request.addEventListener('success', () => {
        if (frozen) return
        const rows = targetRows(request.result)
        record.targetRows = [...record.targetRows, ...rows]
        ;(record as { settledAt: number | null }).settledAt = performance.now()
        ;(record as { outcome: DestinationFrameRequest['outcome'] }).outcome = 'success'
      })
      request.addEventListener(
        'error',
        () => {
          ;(record as { settledAt: number | null }).settledAt = performance.now()
          ;(record as { outcome: DestinationFrameRequest['outcome'] }).outcome = 'error'
        },
        { once: true },
      )
    }

    const transactionDescriptor = Object.getOwnPropertyDescriptor(
      IDBDatabase.prototype,
      'transaction',
    )
    const transactionImplementation: unknown = transactionDescriptor?.value
    if (transactionDescriptor && typeof transactionImplementation === 'function') {
      Object.defineProperty(IDBDatabase.prototype, 'transaction', {
        ...transactionDescriptor,
        value: function (this: IDBDatabase, ...args: unknown[]) {
          const transaction: unknown = Reflect.apply(transactionImplementation, this, args)
          if (!(transaction instanceof IDBTransaction)) {
            throw new Error('DestinationFrameTransactionInstrumentationInvalid')
          }
          if (!state.target || closing || frozen) return transaction
          const stores = (
            typeof args[0] === 'string'
              ? [args[0]]
              : Array.from((args[0] as Iterable<string> | undefined) ?? [])
          ).sort()
          const id = nextTransactionId++
          const record: DestinationFrameTransaction = {
            id,
            database: this.name,
            mode: transaction.mode,
            stores,
            startedAt: performance.now(),
            completedAt: null,
            outcome: 'pending',
          }
          transactionIds.set(transaction, id)
          if (append(state.transactions, record, MAX_TRANSACTIONS)) {
            const settle = (outcome: DestinationFrameTransaction['outcome']) => {
              ;(record as { completedAt: number | null }).completedAt = performance.now()
              ;(record as { outcome: DestinationFrameTransaction['outcome'] }).outcome = outcome
            }
            transaction.addEventListener('complete', () => settle('complete'), { once: true })
            transaction.addEventListener('abort', () => settle('abort'), { once: true })
            transaction.addEventListener('error', () => settle('error'), { once: true })
          }
          return transaction
        },
      })
    }

    const wrapReads = (
      prototype: object,
      source: 'store' | 'index',
      identify: (receiver: unknown) => {
        transaction: IDBTransaction
        store: string
        index: string | null
      },
    ) => {
      for (const method of [
        'get',
        'getKey',
        'getAll',
        'getAllKeys',
        'count',
        'openCursor',
        'openKeyCursor',
      ]) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method)
        const requestImplementation: unknown = descriptor?.value
        if (!descriptor || typeof requestImplementation !== 'function') continue
        Object.defineProperty(prototype, method, {
          ...descriptor,
          value: function (this: IDBObjectStore | IDBIndex, ...args: unknown[]) {
            const request: unknown = Reflect.apply(requestImplementation, this, args)
            if (!(request instanceof IDBRequest)) {
              throw new Error('DestinationFrameRequestInstrumentationInvalid')
            }
            if (state.target && !closing && !frozen) {
              const identity = identify(this)
              recordRequest(
                request,
                identity.transaction,
                source,
                identity.store,
                identity.index,
                method,
                args[0],
              )
            }
            return request
          },
        })
      }
    }
    wrapReads(IDBObjectStore.prototype, 'store', (receiver) => {
      const store = receiver as IDBObjectStore
      return { transaction: store.transaction, store: store.name, index: null }
    })
    wrapReads(IDBIndex.prototype, 'index', (receiver) => {
      const index = receiver as IDBIndex
      return {
        transaction: index.objectStore.transaction,
        store: index.objectStore.name,
        index: index.name,
      }
    })

    const inspect = () => {
      if (!state.target || frozen || !location.hash.includes(`/chat/${state.target.chatId}`)) return
      const list = document.querySelector<HTMLElement>('[data-ui="message-list"]')
      if (!list || list.getAttribute('data-chat-id') !== state.target.chatId) return
      const messageIds = [
        ...list.querySelectorAll<HTMLElement>('[data-ui="message"][data-message-id]'),
      ]
        .map((element) => element.getAttribute('data-message-id'))
        .filter((id): id is string => id !== null)
      const renderedCount = Number(list.getAttribute('data-rendered-count') ?? messageIds.length)
      const totalCount = Number(list.getAttribute('data-total-count') ?? messageIds.length)
      const presentationKind = list.getAttribute('data-presentation-kind') ?? 'unknown'
      const branchCounts = list.getAttribute('data-branch-counts') ?? 'unknown'
      if (messageIds.length === 0) return
      const prior = state.publications.at(-1)
      if (
        !prior ||
        prior.renderedCount !== renderedCount ||
        prior.totalCount !== totalCount ||
        prior.presentationKind !== presentationKind ||
        prior.branchCounts !== branchCounts ||
        prior.messageIds.some((id, index) => messageIds[index] !== id)
      ) {
        append(
          state.publications,
          {
            at: performance.now(),
            renderedCount,
            totalCount,
            messageIds,
            presentationKind,
            branchCounts,
          },
          MAX_PUBLICATIONS,
        )
      }
      if (
        state.milestones.firstDestinationPaintAt === null &&
        messageIds.length === 1 &&
        messageIds[0] === state.target.targetMessageId
      ) {
        state.milestones.firstDestinationPaintAt = performance.now()
        firstDestinationElement = list.querySelector(
          `[data-ui="message"][data-message-id="${CSS.escape(state.target.targetMessageId)}"]`,
        )
      }
      if (
        state.milestones.configuredWindowCompleteAt === null &&
        renderedCount >= state.target.minimumRows &&
        list.getAttribute('data-branch-counts') === 'known'
      ) {
        state.milestones.configuredWindowCompleteAt = performance.now()
        const terminal = list.querySelector(
          `[data-ui="message"][data-message-id="${CSS.escape(state.target.targetMessageId)}"]`,
        )
        state.milestones.terminalIdentityRetained =
          firstDestinationElement !== null && terminal === firstDestinationElement
        closing = true
        const finishWhenSettled = () => {
          if (
            state.transactions.some((transaction) => transaction.outcome === 'pending') ||
            state.requests.some((request) => request.outcome === 'pending')
          ) {
            requestAnimationFrame(finishWhenSettled)
            return
          }
          requestAnimationFrame(() => requestAnimationFrame(() => (frozen = true)))
        }
        finishWhenSettled()
      }
    }
    new MutationObserver(inspect).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'data-chat-id',
        'data-rendered-count',
        'data-total-count',
        'data-branch-counts',
        'data-presentation-kind',
      ],
    })
    try {
      new PerformanceObserver((entries) => {
        if (!state.target || frozen) return
        for (const entry of entries.getEntries()) {
          append(
            state.longTasks,
            { startTime: entry.startTime, duration: entry.duration },
            MAX_LONG_TASKS,
          )
        }
      }).observe({ type: 'longtask', buffered: true })
    } catch {
      state.longTasks.length = 0
    }

    ;(
      window as typeof window & {
        __destinationFrameBudget?: {
          arm(target: DestinationFrameBudgetTarget): void
          frozen(): boolean
          snapshot(): DestinationFrameBudgetSnapshot
        }
      }
    ).__destinationFrameBudget = {
      arm(target) {
        state.target = structuredClone(target)
        state.overflowed = false
        state.gesture = {
          armedAt: performance.now(),
          pointerAt: null,
          clickAt: null,
          clickCount: 0,
        }
        state.milestones = {
          firstDestinationPaintAt: null,
          configuredWindowCompleteAt: null,
          terminalIdentityRetained: null,
        }
        state.publications = []
        state.transactions = []
        state.requests = []
        state.longTasks = []
        closing = false
        frozen = false
        firstDestinationElement = null
        queueMicrotask(inspect)
      },
      frozen: () => frozen,
      snapshot() {
        if (!state.target) throw new Error('DestinationFrameBudgetNotArmed')
        return structuredClone({
          schemaVersion: 1,
          target: state.target,
          overflowed: state.overflowed,
          gesture: state.gesture,
          milestones: state.milestones,
          publications: state.publications,
          transactions: state.transactions,
          requests: state.requests,
          longTasks: state.longTasks,
        })
      },
    }
  })
}

export async function armDestinationFrameBudgetRecorder(
  page: Page,
  target: DestinationFrameBudgetTarget,
): Promise<void> {
  await page.evaluate((nextTarget) => {
    const recorder = (
      window as typeof window & {
        __destinationFrameBudget?: { arm(target: DestinationFrameBudgetTarget): void }
      }
    ).__destinationFrameBudget
    if (!recorder) throw new Error('DestinationFrameBudgetRecorderMissing')
    recorder.arm(nextTarget)
  }, target)
}

export async function finishDestinationFrameBudgetRecorder(
  page: Page,
): Promise<DestinationFrameBudgetSnapshot> {
  await page.waitForFunction(
    () =>
      (
        window as typeof window & {
          __destinationFrameBudget?: { frozen(): boolean }
        }
      ).__destinationFrameBudget?.frozen() === true,
  )
  return page.evaluate(() => {
    const recorder = (
      window as typeof window & {
        __destinationFrameBudget?: { snapshot(): DestinationFrameBudgetSnapshot }
      }
    ).__destinationFrameBudget
    if (!recorder) throw new Error('DestinationFrameBudgetRecorderMissing')
    return recorder.snapshot()
  })
}

export function assertDestinationFrameBudget(
  snapshot: DestinationFrameBudgetSnapshot,
  bounds: { readonly firstPaintMs: number; readonly completeMs: number },
): void {
  const firstPaint = snapshot.milestones.firstDestinationPaintAt
  const complete = snapshot.milestones.configuredWindowCompleteAt
  expect(snapshot.overflowed).toBe(false)
  expect(snapshot.gesture.clickCount).toBe(1)
  expect(firstPaint).not.toBeNull()
  expect(complete).not.toBeNull()
  expect(snapshot.milestones.terminalIdentityRetained).toBe(true)
  expect(firstPaint as number).toBeLessThan(complete as number)
  expect((firstPaint as number) - snapshot.gesture.armedAt).toBeLessThanOrEqual(bounds.firstPaintMs)
  expect((complete as number) - snapshot.gesture.armedAt).toBeLessThanOrEqual(bounds.completeMs)
}

export function assertDestinationPublicationContract(
  snapshot: DestinationFrameBudgetSnapshot,
  options: { readonly point: 'required' | 'optional' },
): void {
  const { publications, target } = snapshot
  expect(publications.length).toBeGreaterThan(0)
  const pointPublications = publications.filter(
    (publication) => publication.presentationKind === 'point',
  )
  if (options.point === 'required') expect(pointPublications).toHaveLength(1)
  expect(pointPublications.length).toBeLessThanOrEqual(1)
  if (pointPublications.length > 0) {
    expect(publications[0]).toMatchObject({
      presentationKind: 'point',
      branchCounts: 'pending',
      renderedCount: 1,
      messageIds: [target.targetMessageId],
    })
  }

  const readyPublications = publications.slice(pointPublications.length)
  expect(readyPublications.length).toBeGreaterThan(0)
  expect(readyPublications.every((publication) => publication.presentationKind === 'ready')).toBe(
    true,
  )
  expect(readyPublications[0]).toMatchObject({
    renderedCount: 1,
    messageIds: [target.targetMessageId],
  })
  expect(readyPublications.at(-1)).toMatchObject({
    presentationKind: 'ready',
    branchCounts: 'known',
    renderedCount: target.minimumRows,
  })

  let previousRenderedCount = 0
  let previousBranchCounts = 'pending'
  for (const publication of publications) {
    expect([1, target.minimumRows]).toContain(publication.renderedCount)
    expect(['pending', 'known']).toContain(publication.branchCounts)
    expect(publication.messageIds).toHaveLength(publication.renderedCount)
    expect(new Set(publication.messageIds).size).toBe(publication.messageIds.length)
    expect(publication.messageIds.at(-1)).toBe(target.targetMessageId)
    expect(publication.renderedCount).toBeGreaterThanOrEqual(previousRenderedCount)
    if (previousBranchCounts === 'known' && publication.branchCounts === 'pending') {
      expect(publication.renderedCount).toBeGreaterThan(previousRenderedCount)
    }
    previousRenderedCount = publication.renderedCount
    previousBranchCounts = publication.branchCounts
  }
}

export function comparableDestinationWork(snapshot: DestinationFrameBudgetSnapshot): unknown {
  const targetRequests = snapshot.requests.filter((request) => request.targetRows.length > 0)
  const targetTransactionIds = new Set(
    targetRequests.flatMap((request) =>
      request.transactionId === null ? [] : [request.transactionId],
    ),
  )
  const requestHistogram = new Map<string, number>()
  const bodyReads = new Map<string, { reads: number; cloneBytes: number; textBytes: number }>()
  for (const request of targetRequests) {
    const signature = `${request.source}:${request.store}:${request.index ?? ''}:${request.method}`
    requestHistogram.set(signature, (requestHistogram.get(signature) ?? 0) + 1)
    for (const row of request.targetRows) {
      if (!row.id) continue
      const current = bodyReads.get(row.id) ?? { reads: 0, cloneBytes: 0, textBytes: 0 }
      current.reads += 1
      current.cloneBytes += row.cloneBytes
      current.textBytes += row.textBytes
      bodyReads.set(row.id, current)
    }
  }
  const transactionHistogram = new Map<string, number>()
  for (const transaction of snapshot.transactions) {
    if (!targetTransactionIds.has(transaction.id)) continue
    const signature = `${transaction.mode}:${transaction.stores.join(',')}`
    transactionHistogram.set(signature, (transactionHistogram.get(signature) ?? 0) + 1)
  }
  return {
    publications: snapshot.publications.map((publication) => ({
      renderedCount: publication.renderedCount,
      totalCount: publication.totalCount,
      messageIds: publication.messageIds,
      presentationKind: publication.presentationKind,
      branchCounts: publication.branchCounts,
    })),
    transactions: Object.fromEntries(
      [...transactionHistogram].sort(([left], [right]) => left.localeCompare(right)),
    ),
    requests: Object.fromEntries(
      [...requestHistogram].sort(([left], [right]) => left.localeCompare(right)),
    ),
    bodyReads: Object.fromEntries(
      [...bodyReads].sort(([left], [right]) => left.localeCompare(right)),
    ),
  }
}
