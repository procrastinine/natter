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
  query: () => T | Promise<T>
  dependencySignature: string
  dependencies: readonly CompiledDependency[]
  snapshot: RepositoryQuerySnapshot<T>
  listeners: Set<() => void>
  unsubscribeChanges: (() => void) | null
  generation: number
  revision: number
  idleOrder: number
  readScheduled: boolean
  readInFlight: boolean
  pendingPublications: Array<{
    generation: number
    revision: number
    snapshot: RepositoryQuerySnapshot<T>
  }>
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
let publicationFlushScheduled = false
let publicationEpoch = 0

export function useRepositoryQueryState<T>(
  key: string,
  query: () => T | Promise<T>,
  initialValue: T,
  dependencies: readonly RepositoryQueryDependency[],
): RepositoryQuerySnapshot<T> {
  const entry = queryEntry(key, query, initialValue, dependencies)
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

function queryEntry<T>(
  key: string,
  query: () => T | Promise<T>,
  initialValue: T,
  dependencies: readonly RepositoryQueryDependency[],
): QueryEntry<T> {
  const existing = entries.get(key)
  const dependencySignature = JSON.stringify(dependencies)
  if (existing) {
    if (existing.dependencySignature !== dependencySignature) {
      throw new Error(`RepositoryQueryDependencyMismatch:${key}`)
    }
    return existing as QueryEntry<T>
  }
  const entry: QueryEntry<T> = {
    key,
    query,
    dependencySignature,
    dependencies: compileDependencies(databaseNameReader(), dependencies),
    snapshot: Object.freeze({ status: 'loading', value: initialValue, error: null }),
    listeners: new Set(),
    unsubscribeChanges: null,
    generation: 0,
    revision: 0,
    idleOrder: 0,
    readScheduled: false,
    readInFlight: false,
    pendingPublications: [],
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
    entry.unsubscribeChanges?.()
    entry.unsubscribeChanges = null
    entry.readScheduled = false
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
    scheduleRead(entry, generation)
  })
  entry.revision += 1
  scheduleRead(entry, generation)
}

function scheduleRead<T>(entry: QueryEntry<T>, generation: number): void {
  if (entry.readScheduled || entry.readInFlight) return
  entry.readScheduled = true
  enqueueTask(() => {
    entry.readScheduled = false
    if (generation !== entry.generation || entry.listeners.size === 0) return
    runRead(entry, generation)
  })
}

function runRead<T>(entry: QueryEntry<T>, generation: number): void {
  if (entry.readInFlight) return
  const revision = entry.revision
  const database = databaseIdentityReader()
  entry.readInFlight = true
  PlatformPromise.resolve()
    .then(() => runWithLocalReadActivity(() => Dexie.ignoreTransaction(entry.query)))
    .then(
      (value) => {
        entry.readInFlight = false
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
        entry.readInFlight = false
        if (generation !== entry.generation) {
          if (entry.listeners.size > 0) scheduleRead(entry, entry.generation)
          return
        }
        if (entry.listeners.size === 0) return
        if (revision !== entry.revision) {
          scheduleRead(entry, generation)
          return
        }
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

function enqueuePublication<T>(
  entry: QueryEntry<T>,
  generation: number,
  revision: number,
  snapshot: RepositoryQuerySnapshot<T>,
): void {
  entry.pendingPublications.push({ generation, revision, snapshot })
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
  const pending = entry.pendingPublications.splice(0)
  for (const publication of pending) {
    if (
      publication.generation !== entry.generation ||
      publication.revision !== entry.revision ||
      entry.listeners.size === 0
    ) {
      continue
    }
    if (
      publication.snapshot.status === 'ready' &&
      entry.snapshot.status === 'ready' &&
      Object.is(publication.snapshot.value, entry.snapshot.value)
    ) {
      continue
    }
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
    entry.listeners.clear()
    entry.pendingPublications.length = 0
  }
  entries.clear()
  publicationEntries.clear()
  publicationFlushScheduled = false
  publicationEpoch += 1
  idleOrder = 0
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
