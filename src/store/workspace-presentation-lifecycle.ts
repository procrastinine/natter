export interface WorkspacePresentationSuspensionRequest {
  readonly generation: number
}

export type WorkspacePresentationRoot = (
  request: WorkspacePresentationSuspensionRequest,
) => Promise<void>

interface PendingSuspension {
  readonly generation: number
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
  dispatchedRoot: WorkspacePresentationRoot | null
}

let root: WorkspacePresentationRoot | null = null
let pending: PendingSuspension | null = null
let generation = 0

export function registerWorkspacePresentationRoot(nextRoot: WorkspacePresentationRoot): () => void {
  if (root && root !== nextRoot) throw new Error('WorkspacePresentationRootAlreadyRegistered')
  root = nextRoot
  dispatchPendingSuspension()
  return () => {
    if (root === nextRoot) root = null
  }
}

export function suspendWorkspacePresentation(): Promise<void> {
  if (pending) return pending.promise
  if (!root) return Promise.resolve()
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  pending = {
    generation: ++generation,
    promise,
    resolve,
    reject,
    dispatchedRoot: null,
  }
  dispatchPendingSuspension()
  return promise
}

function dispatchPendingSuspension(): void {
  const request = pending
  const activeRoot = root
  if (!request || !activeRoot || request.dispatchedRoot) return
  request.dispatchedRoot = activeRoot
  let suspended: Promise<void>
  try {
    suspended = activeRoot({ generation: request.generation })
  } catch (error) {
    settle(request, error)
    return
  }
  void suspended.then(
    () => settle(request),
    (error: unknown) => settle(request, error),
  )
}

function settle(request: PendingSuspension, error?: unknown): void {
  if (pending !== request) return
  pending = null
  if (error === undefined) request.resolve()
  else request.reject(error)
}
