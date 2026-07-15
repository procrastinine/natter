import Dexie, { type IndexableType, type ObservabilitySet, RangeSet, rangesOverlap } from 'dexie'
import { useCallback, useSyncExternalStore } from 'react'
import { isPageHiding } from '../lib/page-lifecycle'
import { PersistentStringMap } from '../lib/persistent-string-map'
import { scheduleReactPublication } from '../lib/react-publication'
import { getDb } from './db'
import { runWithLocalReadActivity } from './transaction-activity'

export type RepositoryQuerySnapshot<T> =
  | { status: 'loading'; value: T; error: null }
  | { status: 'ready'; value: T; error: null }
  | { status: 'error'; value: T; error: unknown }

export type RepositoryQueryTable =
  | 'chats'
  | 'chatSidebarRows'
  | 'messages'
  | 'messageBodies'
  | 'childLists'
  | 'attachments'
  | 'attachmentBlobs'
  | 'attachmentArtifacts'
  | 'attachmentJobs'
  | 'attachmentRefEdges'
  | 'profiles'
  | 'presets'
  | 'promptPresets'
  | 'folders'
  | 'tags'
  | 'chatBranchCache'
  | 'keys'
  | 'settings'
  | 'browserLocks'
  | 'streamLeases'
  | 'streamChunks'
  | 'models'
  | 'endpoints'
  | 'privacyPolicies'
  | 'providers'
  | 'generations'
  | 'presetResolutions'
  | 'drafts'

export interface RepositoryQueryDependency {
  table: RepositoryQueryTable
  index?: string
  keys?: readonly IndexableType[]
}

export type RepositoryMutationSubscriber = (
  listener: (parts: ObservabilitySet) => void,
) => () => void

type RepositoryPublicationScheduler = (task: () => void) => void

interface QueryEntry<T> {
  key: string
  query: (signal?: AbortSignal) => T | Promise<T>
  dependencySignature: string
  blocksLocalWrites: boolean
  dependencies: readonly CompiledDependency[]
  initialValue: T
  snapshot: RepositoryQuerySnapshot<T>
  listeners: Set<() => void>
  unsubscribeChanges: (() => void) | null
  generation: number
  revision: number
  idleOrder: number
  readScheduled: boolean
  readInFlight: number | null
  readAbortController: AbortController | null
  presentationReadsActive: number
  presentationReadDeferred: boolean
  nextRead: number
  pendingPublication: {
    generation: number
    revision: number
    snapshot: RepositoryQuerySnapshot<T>
  } | null
  publicationScheduled: boolean
  incremental: IncrementalQueryAdapter<T> | null
  incrementalState: unknown
  incrementalFullRead: boolean
  incrementalKeys: Set<IndexableType>
}

interface CompiledDependency {
  part: string
  deletedPart: string | null
  range: RangeSet
}

interface IncrementalQueryAdapter<T> {
  signature: string
  table: RepositoryQueryTable
  read(keys: readonly IndexableType[], signal: AbortSignal): unknown
  merge(state: unknown, base: T, keys: readonly IndexableType[], value: unknown): T
  acceptFull(state: unknown, value: T): void
  createState(): unknown
}

interface IncrementalReadPlan {
  keys: readonly IndexableType[]
}

export interface RepositoryKeyedRowsSnapshot<Row> {
  loaded: boolean
  allRows: readonly Row[] | null
  byKey: PersistentStringMap<Row>
  changedKeys: readonly string[] | null
  changedRows: readonly (Row | undefined)[] | null
}

export interface RepositoryKeyedRowsOptions<Row> {
  table: RepositoryQueryTable
  keyOf(row: Row): string
  include(row: Row): boolean
  onMerge?: (kind: 'full' | 'delta', rowCount: number) => void
}

interface QueryDatabaseIdentity {
  isOpen(): boolean
}

const MAX_IDLE_QUERIES = 128
const MAX_PRESENTATION_READS_PER_QUERY = 2
const MAX_PRESENTATION_READS = 4
const PlatformPromise = Promise
const entries = new Map<string, QueryEntry<unknown>>()
let idleOrder = 0
let mutationSubscriber: RepositoryMutationSubscriber = subscribeToDexieMutations
let databaseNameReader = () => getDb().name
let databaseIdentityReader: () => QueryDatabaseIdentity = getDb
let publicationScheduler: RepositoryPublicationScheduler = scheduleReactPublication
let readChannel: MessageChannel | null = null
const readTasks: Array<() => void> = []
const publicationEntries = new Set<QueryEntry<unknown>>()
const deferredPresentationEntries = new Set<QueryEntry<unknown>>()
let publicationFlushScheduled = false
let publicationEpoch = 0
let activePresentationReads = 0
let presentationSchedulerEpoch = 0

export function useRepositoryQueryState<T>(
  key: string,
  query: () => T | Promise<T>,
  initialValue: T,
  dependencies: readonly RepositoryQueryDependency[],
): RepositoryQuerySnapshot<T> {
  return useRepositoryQueryStateWithActivity(key, query, initialValue, dependencies, true)
}

function useRepositoryQueryStateWithActivity<T>(
  key: string,
  query: (signal?: AbortSignal) => T | Promise<T>,
  initialValue: T,
  dependencies: readonly RepositoryQueryDependency[],
  blocksLocalWrites: boolean,
  incremental: IncrementalQueryAdapter<T> | null = null,
): RepositoryQuerySnapshot<T> {
  const entry = queryEntry(key, query, initialValue, dependencies, blocksLocalWrites, incremental)
  const subscribe = useCallback((listener: () => void) => subscribeEntry(entry, listener), [entry])
  const getSnapshot = useCallback(() => entry.snapshot, [entry])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useRepositoryQuery<T>(
  key: string,
  query: () => T | Promise<T>,
  initialValue: T,
  dependencies: readonly RepositoryQueryDependency[],
): T {
  const snapshot = useRepositoryQueryState(key, query, initialValue, dependencies)
  if (snapshot.status === 'error') throw snapshot.error
  return snapshot.value
}

// The query must obtain one coherent snapshot inside the repository boundary and honor
// the signal. Only its abortable presentation promise bypasses the authoritative
// local read/write activity gate.
export function useRepositoryPresentationQuery<T>(
  key: string,
  query: (signal: AbortSignal) => T | Promise<T>,
  initialValue: T,
  dependencies: readonly RepositoryQueryDependency[],
): T {
  const snapshot = useRepositoryQueryStateWithActivity(
    key,
    (signal) => query(signal as AbortSignal),
    initialValue,
    dependencies,
    false,
  )
  if (snapshot.status === 'error') throw snapshot.error
  return snapshot.value
}

export function useRepositoryKeyedPresentationQuery<Row>(
  key: string,
  query: (signal: AbortSignal) => readonly Row[] | Promise<readonly Row[]>,
  readChanged: (
    keys: readonly string[],
    signal: AbortSignal,
  ) => readonly (Row | undefined)[] | Promise<readonly (Row | undefined)[]>,
  initialValue: readonly Row[],
  dependencies: readonly RepositoryQueryDependency[],
  options: RepositoryKeyedRowsOptions<Row>,
): RepositoryKeyedRowsSnapshot<Row> {
  const initialSnapshot: RepositoryKeyedRowsSnapshot<Row> = {
    loaded: false,
    allRows: initialValue,
    byKey: PersistentStringMap.from(initialValue.map((row) => [options.keyOf(row), row] as const)),
    changedKeys: null,
    changedRows: null,
  }
  const snapshot = useRepositoryQueryStateWithActivity(
    key,
    async (signal) => {
      const rows = await query(signal as AbortSignal)
      options.onMerge?.('full', rows.length)
      return {
        loaded: true,
        allRows: rows,
        byKey: PersistentStringMap.from(rows.map((row) => [options.keyOf(row), row] as const)),
        changedKeys: null,
        changedRows: null,
      }
    },
    initialSnapshot,
    dependencies,
    false,
    keyedRowsAdapter(readChanged, options),
  )
  if (snapshot.status === 'error') throw snapshot.error
  return snapshot.value
}

function keyedRowsAdapter<Row>(
  readChanged: (
    keys: readonly string[],
    signal: AbortSignal,
  ) => readonly (Row | undefined)[] | Promise<readonly (Row | undefined)[]>,
  options: RepositoryKeyedRowsOptions<Row>,
): IncrementalQueryAdapter<RepositoryKeyedRowsSnapshot<Row>> {
  return {
    signature: `keyed-rows:${options.table}`,
    table: options.table,
    read: (keys, signal) => readChanged(keys as readonly string[], signal),
    merge: (_state, base, rawKeys, rawValue) => {
      const keys = rawKeys as readonly string[]
      const values = rawValue as readonly (Row | undefined)[]
      if (values.length !== keys.length) throw new Error('RepositoryKeyedReadLengthMismatch')
      options.onMerge?.('delta', keys.length)

      let nextByKey = base.byKey
      const changedKeys: string[] = []
      const changedRows: Array<Row | undefined> = []
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index] as string
        const value = values[index]
        const existing = nextByKey.get(key)
        const accepted = value !== undefined && options.include(value) ? value : undefined
        if (accepted !== undefined && options.keyOf(accepted) !== key) {
          throw new Error('RepositoryKeyedReadKeyMismatch')
        }
        if (accepted === undefined) {
          if (existing === undefined) continue
          nextByKey = nextByKey.delete(key)
          changedKeys.push(key)
          changedRows.push(undefined)
          continue
        }
        nextByKey = nextByKey.set(key, accepted)
        changedKeys.push(key)
        changedRows.push(accepted)
      }
      return nextByKey === base.byKey
        ? base
        : { loaded: base.loaded, allRows: null, byKey: nextByKey, changedKeys, changedRows }
    },
    acceptFull: () => {},
    createState: () => undefined,
  }
}

function queryEntry<T>(
  key: string,
  query: (signal?: AbortSignal) => T | Promise<T>,
  initialValue: T,
  dependencies: readonly RepositoryQueryDependency[],
  blocksLocalWrites: boolean,
  incremental: IncrementalQueryAdapter<T> | null = null,
): QueryEntry<T> {
  const existing = entries.get(key)
  const dependencySignature = JSON.stringify(dependencies)
  if (existing) {
    if (existing.dependencySignature !== dependencySignature) {
      throw new Error(`RepositoryQueryDependencyMismatch:${key}`)
    }
    if (existing.blocksLocalWrites !== blocksLocalWrites) {
      throw new Error(`RepositoryQueryActivityMismatch:${key}`)
    }
    if (existing.incremental?.signature !== incremental?.signature) {
      throw new Error(`RepositoryQueryIncrementalMismatch:${key}`)
    }
    existing.query = query
    existing.initialValue = initialValue
    existing.incremental = incremental
    return existing as QueryEntry<T>
  }
  const entry: QueryEntry<T> = {
    key,
    query,
    dependencySignature,
    blocksLocalWrites,
    dependencies: compileDependencies(databaseNameReader(), dependencies),
    initialValue,
    snapshot: Object.freeze({ status: 'loading', value: initialValue, error: null }),
    listeners: new Set(),
    unsubscribeChanges: null,
    generation: 0,
    revision: 0,
    idleOrder: 0,
    readScheduled: false,
    readInFlight: null,
    readAbortController: null,
    presentationReadsActive: 0,
    presentationReadDeferred: false,
    nextRead: 0,
    pendingPublication: null,
    publicationScheduled: false,
    incremental,
    incrementalState: incremental?.createState(),
    incrementalFullRead: incremental !== null,
    incrementalKeys: new Set(),
  }
  entries.set(key, entry)
  return entry
}

function subscribeEntry<T>(entry: QueryEntry<T>, listener: () => void): () => void {
  entry.listeners.add(listener)
  if (entry.unsubscribeChanges === null) startEntry(entry)
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size !== 0) return
    entry.generation += 1
    entry.revision += 1
    abortEntryRead(entry)
    entry.unsubscribeChanges?.()
    entry.unsubscribeChanges = null
    entry.readScheduled = false
    entry.readInFlight = null
    entry.presentationReadDeferred = false
    deferredPresentationEntries.delete(entry)
    if (!entry.blocksLocalWrites) {
      entry.pendingPublication = null
      if (entries.get(entry.key) === entry) entries.delete(entry.key)
      return
    }
    entry.idleOrder = ++idleOrder
    pruneIdleEntries()
  }
}

function startEntry<T>(entry: QueryEntry<T>): void {
  const generation = ++entry.generation
  entry.unsubscribeChanges = mutationSubscriber((parts) => {
    if (generation !== entry.generation || entry.listeners.size === 0) return
    if (!dependenciesOverlap(parts, entry.dependencies)) return
    if (entry.incremental) {
      const keys = exactChangedPrimaryStringKeys(
        parts,
        databaseNameReader(),
        entry.incremental.table,
      )
      if (keys === null) {
        entry.incrementalFullRead = true
        entry.incrementalKeys.clear()
      } else if (!entry.incrementalFullRead) {
        for (const key of keys) entry.incrementalKeys.add(key)
      }
    }
    entry.revision += 1
    if (!entry.blocksLocalWrites) abandonEntryRead(entry)
    scheduleRead(entry, generation)
  })
  entry.revision += 1
  scheduleRead(entry, generation)
}

function scheduleRead<T>(entry: QueryEntry<T>, generation: number): void {
  if (entry.readScheduled || entry.readInFlight !== null) return
  entry.readScheduled = true
  enqueueTask(() => {
    entry.readScheduled = false
    if (generation !== entry.generation || entry.listeners.size === 0) return
    runRead(entry, generation)
  })
}

function runRead<T>(entry: QueryEntry<T>, generation: number): void {
  if (entry.readInFlight !== null) return
  const incrementalPlan: IncrementalReadPlan | null =
    entry.incremental && !entry.incrementalFullRead && entry.incrementalKeys.size > 0
      ? { keys: [...entry.incrementalKeys] }
      : null
  const presentationRead = !entry.blocksLocalWrites
  if (
    presentationRead &&
    (entry.presentationReadsActive >= MAX_PRESENTATION_READS_PER_QUERY ||
      activePresentationReads >= MAX_PRESENTATION_READS)
  ) {
    entry.presentationReadDeferred = true
    deferredPresentationEntries.add(entry)
    return
  }
  const revision = entry.revision
  const database = databaseIdentityReader()
  const read = ++entry.nextRead
  entry.readInFlight = read
  const abortController = entry.blocksLocalWrites ? null : new AbortController()
  entry.readAbortController = abortController
  const schedulerEpoch = presentationSchedulerEpoch
  if (presentationRead) {
    entry.presentationReadsActive += 1
    activePresentationReads += 1
    entry.presentationReadDeferred = false
    deferredPresentationEntries.delete(entry)
  }
  PlatformPromise.resolve()
    .then(() =>
      entry.blocksLocalWrites
        ? runWithLocalReadActivity(() => Dexie.ignoreTransaction(() => entry.query()))
        : startPresentationRead(
            entry,
            abortController as AbortController,
            schedulerEpoch,
            incrementalPlan,
          ),
    )
    .then(
      (value) => {
        if (entry.readInFlight !== read) return
        entry.readInFlight = null
        entry.readAbortController = null
        if (generation !== entry.generation) {
          if (entry.listeners.size > 0) scheduleRead(entry, entry.generation)
          return
        }
        if (entry.listeners.size === 0) return
        if (revision !== entry.revision) {
          scheduleRead(entry, generation)
          return
        }
        let nextValue: T
        try {
          if (entry.incremental && incrementalPlan) {
            const base = latestReadyValue(entry)
            nextValue = entry.incremental.merge(
              entry.incrementalState,
              base,
              incrementalPlan.keys,
              value,
            )
          } else {
            nextValue = value as T
            entry.incremental?.acceptFull(entry.incrementalState, nextValue)
          }
        } catch (error) {
          enqueuePublication(
            entry,
            generation,
            revision,
            Object.freeze({ status: 'error', value: entry.snapshot.value, error }),
          )
          return
        }
        if (entry.incremental) {
          entry.incrementalFullRead = false
          entry.incrementalKeys.clear()
        }
        if (Object.is(latestReadyValue(entry), nextValue)) return
        enqueuePublication(
          entry,
          generation,
          revision,
          Object.freeze({ status: 'ready', value: nextValue, error: null }),
        )
      },
      (error: unknown) => {
        if (entry.readInFlight !== read) return
        entry.readInFlight = null
        entry.readAbortController = null
        if (generation !== entry.generation) {
          if (entry.listeners.size > 0) scheduleRead(entry, entry.generation)
          return
        }
        if (entry.listeners.size === 0) return
        if (revision !== entry.revision) {
          scheduleRead(entry, generation)
          return
        }
        if (isPresentationReadAbort(error)) return
        if (isDatabaseLifecycleReadError(error, database)) return
        enqueuePublication(
          entry,
          generation,
          revision,
          Object.freeze({ status: 'error', value: entry.snapshot.value, error }),
        )
      },
    )
}

function startPresentationRead<T>(
  entry: QueryEntry<T>,
  controller: AbortController,
  schedulerEpoch: number,
  incrementalPlan: IncrementalReadPlan | null,
): Promise<unknown> {
  return abortablePresentationRead(
    () =>
      Dexie.ignoreTransaction(() =>
        entry.incremental && incrementalPlan
          ? entry.incremental.read(incrementalPlan.keys, controller.signal)
          : entry.query(controller.signal),
      ),
    controller,
    () => {
      entry.presentationReadsActive -= 1
      if (schedulerEpoch !== presentationSchedulerEpoch) return
      activePresentationReads -= 1
      drainDeferredPresentationReads()
    },
  )
}

function latestReadyValue<T>(entry: QueryEntry<T>): T {
  const pending = entry.pendingPublication?.snapshot
  return pending?.status === 'ready' ? pending.value : entry.snapshot.value
}

function drainDeferredPresentationReads(): void {
  if (activePresentationReads >= MAX_PRESENTATION_READS) return
  for (const entry of [...deferredPresentationEntries]) {
    if (entry.listeners.size === 0 || !entry.presentationReadDeferred) {
      deferredPresentationEntries.delete(entry)
      continue
    }
    scheduleRead(entry, entry.generation)
    if (activePresentationReads >= MAX_PRESENTATION_READS) return
  }
}

function abortablePresentationRead<T>(
  query: () => T | Promise<T>,
  controller: AbortController,
  onUnderlyingSettled: () => void,
): Promise<T> {
  const { signal } = controller
  return new PlatformPromise<T>((resolve, reject) => {
    if (signal.aborted) {
      onUnderlyingSettled()
      reject(new PresentationReadAbortError())
      return
    }
    const onAbort = () => reject(new PresentationReadAbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    let value: T | Promise<T>
    try {
      value = query()
    } catch (error) {
      signal.removeEventListener('abort', onAbort)
      onUnderlyingSettled()
      reject(presentationReadError(error))
      return
    }
    PlatformPromise.resolve(value).then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        onUnderlyingSettled()
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        onUnderlyingSettled()
        reject(presentationReadError(error))
      },
    )
  })
}

class PresentationReadAbortError extends Error {
  override name = 'PresentationReadAbortError'
}

function presentationReadError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isPresentationReadAbort(error: unknown): boolean {
  return error instanceof PresentationReadAbortError
}

function abortEntryRead(entry: QueryEntry<unknown>): void {
  entry.readAbortController?.abort()
  entry.readAbortController = null
}

function abandonEntryRead(entry: QueryEntry<unknown>): void {
  abortEntryRead(entry)
  entry.readInFlight = null
}

function enqueuePublication<T>(
  entry: QueryEntry<T>,
  generation: number,
  revision: number,
  snapshot: RepositoryQuerySnapshot<T>,
): void {
  entry.pendingPublication = { generation, revision, snapshot }
  if (!entry.publicationScheduled) {
    entry.publicationScheduled = true
    publicationEntries.add(entry)
  }
  if (publicationFlushScheduled) return
  publicationFlushScheduled = true
  const epoch = publicationEpoch
  publicationScheduler(() => {
    if (epoch !== publicationEpoch) return
    publicationFlushScheduled = false
    const queuedEntries = [...publicationEntries]
    publicationEntries.clear()
    const listeners = new Set<() => void>()
    for (const queuedEntry of queuedEntries) collectPublicationListeners(queuedEntry, listeners)
    for (const listener of listeners) listener()
  })
}

function collectPublicationListeners(entry: QueryEntry<unknown>, listeners: Set<() => void>): void {
  entry.publicationScheduled = false
  let changed = false
  const publication = entry.pendingPublication
  entry.pendingPublication = null
  if (
    publication &&
    publication.generation === entry.generation &&
    publication.revision === entry.revision &&
    entry.listeners.size > 0 &&
    !(
      publication.snapshot.status === 'ready' &&
      entry.snapshot.status === 'ready' &&
      Object.is(publication.snapshot.value, entry.snapshot.value)
    )
  ) {
    entry.snapshot = publication.snapshot
    changed = true
  }
  if (changed) {
    for (const listener of entry.listeners) listeners.add(listener)
  }
}

function enqueueTask(task: () => void): void {
  readTasks.push(task)
  if (readChannel !== null) return
  const channel = new MessageChannel()
  readChannel = channel
  channel.port1.onmessage = () => {
    if (readChannel === channel) readChannel = null
    channel.port1.close()
    channel.port2.close()
    const tasks = readTasks.splice(0)
    for (const pending of tasks) pending()
  }
  channel.port2.postMessage(undefined)
}

function isDatabaseLifecycleReadError(error: unknown, database: QueryDatabaseIdentity): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false
  const name = error.name
  return (
    (name === Dexie.errnames.DatabaseClosed || name === Dexie.errnames.Abort) &&
    (!database.isOpen() || isPageHiding())
  )
}

function dependenciesOverlap(
  parts: ObservabilitySet,
  dependencies: readonly CompiledDependency[],
): boolean {
  if (dependencies.length === 0) return false
  if (parts.all) return true
  for (const dependency of dependencies) {
    const changed = parts[dependency.part]
    if (changed && rangesOverlap(changed, dependency.range)) return true
    if (dependency.deletedPart) {
      const deleted = parts[dependency.deletedPart]
      if (deleted && rangesOverlap(deleted, dependency.range)) return true
    }
  }
  return false
}

function exactChangedPrimaryStringKeys(
  parts: ObservabilitySet,
  databaseName: string,
  table: RepositoryQueryTable,
): readonly string[] | null {
  if (parts.all) return null
  const tablePart = `idb://${databaseName}/${table}/`
  const ranges = [parts[tablePart], parts[`${tablePart}:dels`]].filter(
    (range): range is NonNullable<typeof range> => range !== undefined,
  )
  if (ranges.length === 0) return null
  const keys = new Set<string>()
  for (const range of ranges) {
    const pending = 'from' in range ? [range] : []
    while (pending.length > 0) {
      const interval = pending.pop()
      if (!interval) continue
      if (
        typeof interval.from !== 'string' ||
        typeof interval.to !== 'string' ||
        interval.from !== interval.to
      ) {
        return null
      }
      keys.add(interval.from)
      if (interval.l) pending.push(interval.l)
      if (interval.r) pending.push(interval.r)
    }
  }
  return [...keys]
}

function compileDependencies(
  databaseName: string,
  dependencies: readonly RepositoryQueryDependency[],
): readonly CompiledDependency[] {
  return dependencies.map((dependency) => {
    const tablePart = `idb://${databaseName}/${dependency.table}/`
    const range =
      dependency.keys === undefined
        ? new RangeSet(Dexie.minKey, Dexie.maxKey)
        : new RangeSet().addKeys([...dependency.keys])
    return {
      part: dependency.index ? `${tablePart}${dependency.index}` : tablePart,
      deletedPart: dependency.index ? null : `${tablePart}:dels`,
      range,
    }
  })
}

function subscribeToDexieMutations(listener: (parts: ObservabilitySet) => void): () => void {
  Dexie.on.storagemutated.subscribe(listener)
  return () => Dexie.on.storagemutated.unsubscribe(listener)
}

function pruneIdleEntries(): void {
  let idleCount = 0
  for (const entry of entries.values()) {
    if (entry.listeners.size === 0) idleCount += 1
  }
  while (idleCount > MAX_IDLE_QUERIES) {
    let oldest: QueryEntry<unknown> | undefined
    for (const entry of entries.values()) {
      if (entry.listeners.size !== 0) continue
      if (!oldest || entry.idleOrder < oldest.idleOrder) oldest = entry
    }
    if (!oldest) return
    entries.delete(oldest.key)
    idleCount -= 1
  }
}

export function __resetRepositoryQueriesForTests(): void {
  for (const entry of entries.values()) {
    entry.generation += 1
    entry.revision += 1
    entry.unsubscribeChanges?.()
    entry.unsubscribeChanges = null
    abortEntryRead(entry)
    entry.readInFlight = null
    entry.presentationReadDeferred = false
    entry.listeners.clear()
    entry.pendingPublication = null
  }
  entries.clear()
  publicationEntries.clear()
  deferredPresentationEntries.clear()
  publicationFlushScheduled = false
  publicationEpoch += 1
  presentationSchedulerEpoch += 1
  activePresentationReads = 0
  idleOrder = 0
}

export function invalidateRepositoryQueriesForWorkspaceReplacement(): void {
  const listeners = new Set<() => void>()
  for (const [key, entry] of entries) {
    entry.revision += 1
    entry.pendingPublication = null
    abortEntryRead(entry)
    if (entry.incremental) {
      entry.incrementalFullRead = true
      entry.incrementalKeys.clear()
      entry.incrementalState = entry.incremental.createState()
    }
    if (entry.listeners.size === 0) {
      entry.unsubscribeChanges?.()
      entries.delete(key)
      continue
    }
    entry.snapshot = Object.freeze({
      status: 'loading',
      value: entry.initialValue,
      error: null,
    })
    entry.readInFlight = null
    for (const listener of entry.listeners) listeners.add(listener)
    scheduleRead(entry, entry.generation)
  }
  for (const listener of listeners) listener()
}

export function __setRepositoryMutationSubscriberForTests(
  subscriber: RepositoryMutationSubscriber | undefined,
  databaseName = 'natter-test',
  databaseReader?: () => QueryDatabaseIdentity,
  schedulePublication?: RepositoryPublicationScheduler,
): void {
  __resetRepositoryQueriesForTests()
  mutationSubscriber = subscriber ?? subscribeToDexieMutations
  databaseNameReader = subscriber ? () => databaseName : () => getDb().name
  databaseIdentityReader = subscriber ? (databaseReader ?? (() => TEST_OPEN_DATABASE)) : getDb
  publicationScheduler = schedulePublication ?? scheduleReactPublication
}

const TEST_OPEN_DATABASE: QueryDatabaseIdentity = Object.freeze({ isOpen: () => true })
