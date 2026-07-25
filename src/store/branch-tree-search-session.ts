import type { MessageId } from '../core/types'
import type {
  BranchTreeSearchRequest,
  BranchTreeSearchSession,
  BranchTreeSearchSnapshot,
  BranchTreeSearchSource,
  BranchTreeSearchTarget,
} from './branch-tree-search-contract'
import { branchTreeSearchTarget, type MessageHeaderRow } from './message-storage'

export type {
  BranchTreeSearchRequest,
  BranchTreeSearchSession,
  BranchTreeSearchSnapshot,
  BranchTreeSearchSource,
  BranchTreeSearchTarget,
} from './branch-tree-search-contract'
export { branchTreeSearchTarget } from './message-storage'

const EMPTY_MATCHES: readonly MessageId[] = Object.freeze([])

export function createBranchTreeSearchSession(
  source?: BranchTreeSearchSource,
): BranchTreeSearchSession {
  return new LazyBranchTreeSearchSession(source)
}

class LazyBranchTreeSearchSession implements BranchTreeSearchSession {
  private readonly source: BranchTreeSearchSource | undefined
  private readonly listeners = new Set<() => void>()
  private delegate: BranchTreeSearchSession | null = null
  private unsubscribeDelegate: (() => void) | null = null
  private load: Promise<void> | null = null
  private pendingRequest: BranchTreeSearchRequest | null = null
  private snapshot: BranchTreeSearchSnapshot | null = null
  private inspectedMessageId: MessageId | null = null
  private revision = 0
  private active = true
  private disposed = false

  constructor(source?: BranchTreeSearchSource) {
    this.source = source
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): BranchTreeSearchSnapshot | null => this.snapshot

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return
    this.active = active
    if (this.delegate) {
      this.delegate.setActive(active)
      return
    }
    if (active) return
    this.pendingRequest = null
    if (!this.snapshot) return
    this.snapshot = Object.freeze({
      ...this.snapshot,
      revision: ++this.revision,
      status: this.snapshot.query.length > 0 ? 'searching' : 'idle',
      interactive: false,
      matches: EMPTY_MATCHES,
      currentIndex: -1,
      currentMatchId: null,
      error: null,
    })
    this.emit()
  }

  request(request: BranchTreeSearchRequest): void {
    if (this.disposed) throw new Error('BranchTreeSearchSessionDisposed')
    if (!this.active) return
    if (this.delegate) {
      this.delegate.request(request)
      return
    }
    const normalized = freezeRequest(request)
    this.pendingRequest = normalized
    this.publishPending(normalized)
    if (normalized.query.length > 0) this.ensureLoaded()
  }

  replaceTopology(targets: readonly BranchTreeSearchTarget[]): void {
    if (this.disposed) return
    if (this.delegate) {
      this.delegate.replaceTopology(targets)
      return
    }
    if (!this.pendingRequest) return
    this.pendingRequest = Object.freeze({
      ...this.pendingRequest,
      targets: Object.freeze([...targets]),
    })
  }

  observeHeaders(headers: readonly MessageHeaderRow[]): void {
    this.observeTargets(headers.map(branchTreeSearchTarget))
  }

  observeTargets(targets: readonly BranchTreeSearchTarget[]): void {
    if (this.disposed) return
    if (this.delegate) {
      this.delegate.observeTargets(targets)
      return
    }
    if (!this.pendingRequest) return
    this.pendingRequest = Object.freeze({
      ...this.pendingRequest,
      targets: mergeTargets(this.pendingRequest.targets, targets),
    })
  }

  setInspectedMessageId(messageId: MessageId | null): void {
    this.inspectedMessageId = messageId
    this.delegate?.setInspectedMessageId(messageId)
  }

  move(delta: -1 | 1): MessageId | null {
    return this.delegate?.move(delta) ?? null
  }

  clear(): void {
    if (this.disposed) return
    this.pendingRequest = null
    if (this.delegate) {
      this.delegate.clear()
      return
    }
    if (!this.snapshot) return
    this.snapshot = null
    this.emit()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pendingRequest = null
    this.unsubscribeDelegate?.()
    this.unsubscribeDelegate = null
    this.delegate?.dispose()
    this.delegate = null
    this.listeners.clear()
  }

  private ensureLoaded(): void {
    if (this.load || this.delegate || this.disposed) return
    this.load = import('./branch-tree-search-runtime')
      .then(({ createLoadedBranchTreeSearchSession }) => {
        if (this.disposed) return
        const delegate = createLoadedBranchTreeSearchSession(this.source)
        this.delegate = delegate
        this.unsubscribeDelegate = delegate.subscribe(() => this.publishDelegateSnapshot())
        delegate.setActive(this.active)
        delegate.setInspectedMessageId(this.inspectedMessageId)
        const pending = this.pendingRequest
        this.pendingRequest = null
        if (pending && this.active) delegate.request(pending)
      })
      .catch((error: unknown) => {
        if (this.disposed) return
        const current = this.snapshot
        if (!current) return
        this.snapshot = Object.freeze({
          ...current,
          revision: ++this.revision,
          status: 'error',
          interactive: false,
          error,
        })
        this.emit()
      })
      .finally(() => {
        this.load = null
      })
  }

  private publishPending(request: BranchTreeSearchRequest): void {
    const current = this.snapshot
    if (
      current?.workspaceId === request.workspaceId &&
      current.replacementEpoch === request.replacementEpoch &&
      current.chatId === request.chatId &&
      current.query === request.query &&
      current.status === (request.query.length > 0 ? 'searching' : 'idle')
    ) {
      return
    }
    this.snapshot = Object.freeze({
      workspaceId: request.workspaceId,
      replacementEpoch: request.replacementEpoch,
      revision: ++this.revision,
      status: request.query.length > 0 ? 'searching' : 'idle',
      interactive: request.query.length === 0,
      chatId: request.chatId,
      query: request.query,
      matches: EMPTY_MATCHES,
      currentIndex: -1,
      currentMatchId: null,
      revealRevision: 0,
      error: null,
    })
    this.emit()
  }

  private publishDelegateSnapshot(): void {
    if (this.disposed || !this.delegate) return
    this.snapshot = this.delegate.getSnapshot()
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function freezeRequest(request: BranchTreeSearchRequest): BranchTreeSearchRequest {
  return Object.freeze({
    ...request,
    query: request.query.trim(),
    targets: Object.freeze([...request.targets]),
  })
}

function mergeTargets(
  previous: readonly BranchTreeSearchTarget[],
  changed: readonly BranchTreeSearchTarget[],
): readonly BranchTreeSearchTarget[] {
  if (changed.length === 0) return previous
  const byId = new Map(changed.map((target) => [target.id, target]))
  const merged: BranchTreeSearchTarget[] = []
  for (const target of previous) {
    merged.push(byId.get(target.id) ?? target)
    byId.delete(target.id)
  }
  for (const target of changed) merged.push(target)
  return Object.freeze(merged)
}
