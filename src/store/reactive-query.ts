import Dexie, { type IndexableType, type ObservabilitySet, RangeSet, rangesOverlap } from 'dexie'
import { useCallback, useSyncExternalStore } from 'react'
import { isPageHiding } from '../lib/page-lifecycle'
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
}

interface CompiledDependency {
  part: string
  deletedPart: string | null
  range: RangeSet
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
): RepositoryQuerySnapshot<T> {
  const entry = queryEntry(key, query, initialValue, dependencies, blocksLocalWrites)
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

function queryEntry<T>(
  key: string,
  query: (signal?: AbortSignal) => T | Promise<T>,
  initialValue: T,
  dependencies: readonly RepositoryQueryDependency[],
  blocksLocalWrites: boolean,
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
    existing.query = query
    existing.initialValue = initialValue
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
        : startPresentationRead(entry, abortController as AbortController, schedulerEpoch),
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
        if (entry.snapshot.status === 'ready' && Object.is(entry.snapshot.value, value)) return
        enqueuePublication(
          entry,
          generation,
          revision,
          Object.freeze({ status: 'ready', value, error: null }),
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
): Promise<T> {
  return abortablePresentationRead(
    () => Dexie.ignoreTransaction(() => entry.query(controller.signal)),
    controller,
    () => {
      entry.presentationReadsActive -= 1
      if (schedulerEpoch !== presentationSchedulerEpoch) return
      activePresentationReads -= 1
      drainDeferredPresentationReads()
    },
  )
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
