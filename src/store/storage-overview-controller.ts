import {
  aggregateCalibrationSamples,
  GLOBAL_TOKEN_CALIBRATION_KEY,
  globalTokenCalibrationFromStored,
} from '../core/token-calibration'
import type { TokenCalibrationSample } from '../core/types'
import type {
  AttachmentCatalogAggregate,
  ChatSidebarAggregate,
  WorkspaceFence,
  WorkspaceMeta,
} from './repository'
import {
  subscribeWorkspaceEffects,
  WORKSPACE_EFFECT_RECOVERY_OWNED,
  type WorkspaceEffect,
} from './workspace-effect-hub'
import type { WorkspaceQuery } from './workspace-protocol'
import { getWorkspaceRepository, readWorkspaceMeta } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

const CHATS_DIRTY = 1 << 0
const ATTACHMENTS_DIRTY = 1 << 1
const CALIBRATION_DIRTY = 1 << 2
const WORKSPACE_DIRTY = 1 << 3
const ALL_DIRTY = CHATS_DIRTY | ATTACHMENTS_DIRTY | CALIBRATION_DIRTY | WORKSPACE_DIRTY

export const EMPTY_STORAGE_CHAT_AGGREGATE: ChatSidebarAggregate = Object.freeze({
  totalCount: 0,
  activeCount: 0,
  archivedCount: 0,
  pinnedCount: 0,
  visibleCount: 0,
  visiblePinnedCount: 0,
  folderCounts: Object.freeze({}),
  folderAggregates: Object.freeze({}),
  rootCount: 0,
  rootVisibleCount: 0,
  rootVisiblePinnedCount: 0,
})

export const EMPTY_STORAGE_ATTACHMENT_AGGREGATE: AttachmentCatalogAggregate = Object.freeze({
  totalCount: 0,
  activeCount: 0,
  deletedCount: 0,
  referencedCount: 0,
  unreferencedCount: 0,
  localCount: 0,
  remoteCount: 0,
  missingCount: 0,
  generatedCount: 0,
  totalSizeBytes: 0,
  localSizeBytes: 0,
})

export interface StorageGlobalCalibrationModel {
  readonly rows: readonly [string, TokenCalibrationSample][]
}

export const EMPTY_STORAGE_GLOBAL_CALIBRATION_MODEL: StorageGlobalCalibrationModel = Object.freeze({
  rows: Object.freeze([]),
})

type StorageOverviewStatus = 'loading' | 'ready' | 'refreshing' | 'error'

export interface StorageOverviewSnapshot extends WorkspaceFence {
  readonly revision: number
  readonly status: StorageOverviewStatus
  readonly chats: ChatSidebarAggregate
  readonly attachments: AttachmentCatalogAggregate
  readonly calibration: StorageGlobalCalibrationModel
  readonly workspace: WorkspaceMeta | null
  readonly error: unknown
}

interface StorageOverviewValues {
  readonly chats: ChatSidebarAggregate
  readonly attachments: AttachmentCatalogAggregate
  readonly calibration: StorageGlobalCalibrationModel
  readonly workspace: WorkspaceMeta | null
}

type MutableStorageOverviewPatch = {
  -readonly [Key in keyof StorageOverviewValues]?: StorageOverviewValues[Key]
}

interface ActiveStorageOverviewRead {
  readonly controller: AbortController
  readonly fence: WorkspaceFence
  readonly mask: number
}

export interface StorageOverviewController {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => StorageOverviewSnapshot | null
  request(fence: WorkspaceFence): () => void
  dispose(): void
}

export function createStorageOverviewController(): StorageOverviewController {
  return new StorageOverviewProjectionController()
}

class StorageOverviewProjectionController implements StorageOverviewController {
  private readonly listeners = new Set<() => void>()
  private snapshot: StorageOverviewSnapshot | null = null
  private values: StorageOverviewValues = {
    chats: EMPTY_STORAGE_CHAT_AGGREGATE,
    attachments: EMPTY_STORAGE_ATTACHMENT_AGGREGATE,
    calibration: EMPTY_STORAGE_GLOBAL_CALIBRATION_MODEL,
    workspace: null,
  }
  private fence: WorkspaceFence | null = null
  private read: ActiveStorageOverviewRead | null = null
  private stopEffects: (() => void) | null = null
  private queuedMask = 0
  private demandCount = 0
  private revision = 0
  private disposed = false

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): StorageOverviewSnapshot | null => this.snapshot

  request(fence: WorkspaceFence): () => void {
    if (this.disposed) throw new Error('StorageOverviewControllerDisposed')
    this.demandCount += 1
    const changedFence = !sameFence(this.fence, fence)
    if (changedFence) {
      this.cancelRead()
      this.fence = Object.freeze({ ...fence })
      this.values = {
        chats: EMPTY_STORAGE_CHAT_AGGREGATE,
        attachments: EMPTY_STORAGE_ATTACHMENT_AGGREGATE,
        calibration: EMPTY_STORAGE_GLOBAL_CALIBRATION_MODEL,
        workspace: null,
      }
      this.publish('loading', null)
    }
    this.attachEffects()
    this.schedule(ALL_DIRTY)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.demandCount -= 1
      if (this.demandCount > 0) return
      this.cancelRead()
      this.stopEffects?.()
      this.stopEffects = null
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.demandCount = 0
    this.cancelRead()
    this.stopEffects?.()
    this.stopEffects = null
    this.listeners.clear()
  }

  private attachEffects(): void {
    if (this.stopEffects) return
    this.stopEffects = subscribeWorkspaceEffects({
      owner: 'storage-overview-controller',
      impactKinds: ['workspace', 'sidebar', 'attachment', 'setting'],
      replacements: true,
      apply: (effect) => this.receiveEffect(effect),
      recover: (_error, effect) => {
        if (this.matchesEffect(effect)) this.schedule(ALL_DIRTY)
        return WORKSPACE_EFFECT_RECOVERY_OWNED
      },
    })
  }

  private receiveEffect(effect: WorkspaceEffect): void {
    if (!this.matchesEffect(effect)) return
    this.schedule(storageOverviewDirtyMask(effect))
  }

  private matchesEffect(effect: WorkspaceEffect): boolean {
    return (
      this.fence?.workspaceId === effect.workspaceId &&
      this.fence.replacementEpoch === effect.replacementEpoch
    )
  }

  private schedule(mask: number): void {
    if (mask === 0 || this.demandCount === 0 || !this.fence) return
    if (this.read) {
      this.queuedMask |= mask
      return
    }
    this.publish(this.snapshot?.workspace ? 'refreshing' : 'loading', null)
    this.startRead(mask)
  }

  private startRead(mask: number): void {
    const fence = this.fence
    if (!fence || this.demandCount === 0) return
    const controller = new AbortController()
    const read: ActiveStorageOverviewRead = { controller, fence, mask }
    this.read = read
    void readStorageOverview(mask, controller.signal).then(
      (patch) => {
        if (this.read !== read || controller.signal.aborted || !sameFence(this.fence, fence)) return
        this.read = null
        this.values = Object.freeze({ ...this.values, ...patch })
        this.publish('ready', null)
        this.drainQueued()
      },
      (error: unknown) => {
        if (this.read !== read || controller.signal.aborted) return
        this.read = null
        this.publish('error', error)
        this.drainQueued()
      },
    )
  }

  private drainQueued(): void {
    const mask = this.queuedMask
    this.queuedMask = 0
    if (mask !== 0) this.schedule(mask)
  }

  private cancelRead(): void {
    this.read?.controller.abort()
    this.read = null
    this.queuedMask = 0
  }

  private publish(status: StorageOverviewStatus, error: unknown): void {
    const fence = this.fence
    if (!fence) return
    this.snapshot = Object.freeze({
      ...fence,
      revision: ++this.revision,
      status,
      ...this.values,
      error,
    })
    for (const listener of [...this.listeners]) listener()
  }
}

async function readStorageOverview(
  mask: number,
  signal: AbortSignal,
): Promise<Partial<StorageOverviewValues>> {
  const patch: MutableStorageOverviewPatch = {}
  await Promise.all([
    ...(mask & CHATS_DIRTY
      ? [
          readWorkspaceQuery({ kind: 'sidebar.aggregate' }, signal).then(
            (value) => (patch.chats = value),
          ),
        ]
      : []),
    ...(mask & ATTACHMENTS_DIRTY
      ? [
          readWorkspaceQuery({ kind: 'attachment.catalog-aggregate' }, signal).then(
            (value) => (patch.attachments = value),
          ),
        ]
      : []),
    ...(mask & CALIBRATION_DIRTY
      ? [readCalibration(signal).then((value) => (patch.calibration = value))]
      : []),
    ...(mask & WORKSPACE_DIRTY
      ? [readWorkspaceMeta({ signal }).then((value) => (patch.workspace = value))]
      : []),
  ])
  return patch
}

async function readWorkspaceQuery<Query extends WorkspaceQuery>(query: Query, signal: AbortSignal) {
  return runWorkspaceRead(
    'repository-query',
    (permit) =>
      getWorkspaceRepository()
        .query(permit, query, { signal: permit.signal })
        .then((envelope) => envelope.value),
    { signal },
  )
}

async function readCalibration(signal: AbortSignal): Promise<StorageGlobalCalibrationModel> {
  const stored = await readWorkspaceQuery(
    { kind: 'setting.get', key: GLOBAL_TOKEN_CALIBRATION_KEY },
    signal,
  )
  const global = globalTokenCalibrationFromStored(stored)
  return Object.freeze({
    rows: Object.freeze(
      Object.entries(aggregateCalibrationSamples(global.byModel)).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  })
}

function storageOverviewDirtyMask(effect: WorkspaceEffect): number {
  if (effect.kind === 'replace' || effect.impact === 'all') return ALL_DIRTY
  let mask = 0
  for (const dependency of effect.impact) {
    if (dependency.kind === 'workspace') return ALL_DIRTY
    if (dependency.kind === 'sidebar') mask |= CHATS_DIRTY
    else if (dependency.kind === 'attachment') mask |= ATTACHMENTS_DIRTY
    else if (
      dependency.kind === 'setting' &&
      (!dependency.keys || dependency.keys.includes(GLOBAL_TOKEN_CALIBRATION_KEY))
    ) {
      mask |= CALIBRATION_DIRTY
    }
  }
  return mask
}

function sameFence(left: WorkspaceFence | null, right: WorkspaceFence): boolean {
  return left?.workspaceId === right.workspaceId && left.replacementEpoch === right.replacementEpoch
}
