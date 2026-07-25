export interface CatalogQueryTransitionPolicy {
  readonly debounceKey?: string | null
  readonly debounceMs?: number
}

export interface CatalogQueryTransitionScheduler<Input> {
  schedule(input: Input, policy?: CatalogQueryTransitionPolicy): () => void
  cancelPending(): void
  dispose(): void
}

export function createCatalogQueryTransitionScheduler<Input>(
  start: (input: Input) => void,
): CatalogQueryTransitionScheduler<Input> {
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let pendingRevision = 0
  let lastStartedDebounceKey: string | null = null
  let disposed = false

  const cancelPending = () => {
    pendingRevision += 1
    if (pendingTimer !== null) clearTimeout(pendingTimer)
    pendingTimer = null
  }

  return {
    schedule: (input, policy = {}) => {
      if (disposed) throw new Error('CatalogQueryTransitionSchedulerDisposed')
      cancelPending()
      const revision = pendingRevision
      const debounceKey = policy.debounceKey ?? null
      const configuredDelay = policy.debounceMs ?? 0
      const delay =
        debounceKey !== null &&
        lastStartedDebounceKey !== null &&
        debounceKey !== lastStartedDebounceKey
          ? Math.max(0, configuredDelay)
          : 0
      pendingTimer = setTimeout(() => {
        if (disposed || revision !== pendingRevision) return
        pendingTimer = null
        lastStartedDebounceKey = debounceKey
        start(input)
      }, delay)
      return () => {
        if (revision === pendingRevision) cancelPending()
      }
    },
    cancelPending,
    dispose: () => {
      if (disposed) return
      disposed = true
      cancelPending()
      lastStartedDebounceKey = null
    },
  }
}
