const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_DIAGNOSTIC_NAME_LENGTH = 120
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 1_000

export interface RecoveryRetryPolicy {
  baseDelayMs: number
  maxDelayMs: number
}

export class PermanentRecoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PermanentRecoveryError'
  }
}

interface RecoveryRetryDiagnostic {
  name: string
  message: string
}

export interface RecoveryRetryState {
  key: string
  evidence: string
  status: 'scheduled' | 'ready' | 'quarantined'
  attempts: number
  firstFailureAt: number
  lastFailureAt: number
  nextRetryAt?: number
  diagnostic: RecoveryRetryDiagnostic
}

interface RecoveryRetryEntry<Payload> {
  key: string
  evidence: string
  payload: Payload
  attempts: number
  firstFailureAt: number
  lastFailureAt: number
  nextRetryAt: number | undefined
  quarantined: boolean
  diagnostic: RecoveryRetryDiagnostic
  policy: RecoveryRetryPolicy
  heapIndex: number | undefined
}

export class RecoveryRetryScheduler<Payload> {
  private readonly entries = new Map<string, RecoveryRetryEntry<Payload>>()
  private readonly heap: RecoveryRetryEntry<Payload>[] = []
  private readonly onDue: (key: string, payload: Payload, evidence: string) => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerAt: number | null = null

  constructor(onDue: (key: string, payload: Payload, evidence: string) => void) {
    this.onDue = onDue
  }

  recordFailure(
    key: string,
    payload: Payload,
    evidence: string,
    failure: unknown,
    policy: RecoveryRetryPolicy,
    now = Date.now(),
  ): RecoveryRetryState {
    let entry = this.entries.get(key)
    if (entry && entry.evidence !== evidence) {
      this.clear(key)
      entry = undefined
    }
    const diagnostic = recoveryRetryDiagnostic(failure)
    if (entry?.quarantined) {
      entry.payload = payload
      entry.lastFailureAt = now
      entry.diagnostic = diagnostic
      return stateFromEntry(entry)
    }
    if (!entry) {
      entry = {
        key,
        evidence,
        payload,
        attempts: 0,
        firstFailureAt: now,
        lastFailureAt: now,
        nextRetryAt: undefined,
        quarantined: false,
        diagnostic,
        policy,
        heapIndex: undefined,
      }
      this.entries.set(key, entry)
    } else {
      this.removeFromHeap(entry)
      entry.payload = payload
      entry.lastFailureAt = now
      entry.diagnostic = diagnostic
      entry.policy = policy
    }
    entry.attempts = Math.min(Number.MAX_SAFE_INTEGER, entry.attempts + 1)
    if (failure instanceof PermanentRecoveryError) {
      entry.nextRetryAt = undefined
      entry.quarantined = true
    } else {
      entry.nextRetryAt = Math.min(
        Number.MAX_SAFE_INTEGER,
        now + retryDelay(policy, entry.attempts),
      )
      this.push(entry)
    }
    this.armTimer()
    return stateFromEntry(entry)
  }

  get(key: string): RecoveryRetryState | undefined {
    const entry = this.entries.get(key)
    return entry ? stateFromEntry(entry) : undefined
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  evidenceFor(key: string): string | undefined {
    return this.entries.get(key)?.evidence
  }

  clear(key: string): boolean {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.removeFromHeap(entry)
    this.entries.delete(key)
    this.armTimer()
    return true
  }

  retain(keep: (key: string, evidence: string) => boolean): void {
    let changed = false
    for (const [key, entry] of this.entries) {
      if (keep(key, entry.evidence)) continue
      this.entries.delete(key)
      changed = true
    }
    if (!changed) return
    this.rebuildHeap()
    this.armTimer()
  }

  clearAll(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.timerAt = null
    for (const entry of this.entries.values()) entry.heapIndex = undefined
    this.entries.clear()
    this.heap.length = 0
  }

  snapshot(): readonly RecoveryRetryState[] {
    return [...this.entries.values()]
      .map(stateFromEntry)
      .sort((left, right) => left.key.localeCompare(right.key))
  }

  private armTimer(): void {
    const nextAt = this.heap[0]?.nextRetryAt ?? null
    if (nextAt === null) {
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = null
      this.timerAt = null
      return
    }
    if (this.timer !== null && this.timerAt === nextAt) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.timerAt = nextAt
    this.timer = setTimeout(
      () => this.runDue(),
      Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextAt - Date.now())),
    )
  }

  private runDue(): void {
    this.timer = null
    this.timerAt = null
    const now = Date.now()
    const due: RecoveryRetryEntry<Payload>[] = []
    while (this.heap[0] && (this.heap[0].nextRetryAt as number) <= now) {
      const entry = this.removeAt(0)
      if (!entry) break
      entry.nextRetryAt = undefined
      due.push(entry)
    }
    this.armTimer()
    for (const entry of due) this.onDue(entry.key, entry.payload, entry.evidence)
  }

  private push(entry: RecoveryRetryEntry<Payload>): void {
    if (entry.heapIndex !== undefined || entry.nextRetryAt === undefined) return
    entry.heapIndex = this.heap.length
    this.heap.push(entry)
    this.bubbleUp(entry.heapIndex)
  }

  private removeFromHeap(entry: RecoveryRetryEntry<Payload>): void {
    if (entry.heapIndex === undefined) return
    this.removeAt(entry.heapIndex)
  }

  private removeAt(index: number): RecoveryRetryEntry<Payload> | undefined {
    const removed = this.heap[index]
    if (!removed) return undefined
    const last = this.heap.pop() as RecoveryRetryEntry<Payload>
    removed.heapIndex = undefined
    if (index < this.heap.length) {
      this.heap[index] = last
      last.heapIndex = index
      this.repair(index)
    }
    return removed
  }

  private repair(index: number): void {
    const parent = Math.floor((index - 1) / 2)
    if (index > 0 && compareEntries(this.heap[index], this.heap[parent]) < 0) {
      this.bubbleUp(index)
    } else {
      this.sinkDown(index)
    }
  }

  private bubbleUp(start: number): void {
    let index = start
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (compareEntries(this.heap[parent], this.heap[index]) <= 0) break
      this.swap(index, parent)
      index = parent
    }
  }

  private sinkDown(start: number): void {
    let index = start
    for (;;) {
      const left = index * 2 + 1
      if (left >= this.heap.length) return
      const right = left + 1
      const child =
        right < this.heap.length && compareEntries(this.heap[right], this.heap[left]) < 0
          ? right
          : left
      if (compareEntries(this.heap[index], this.heap[child]) <= 0) return
      this.swap(index, child)
      index = child
    }
  }

  private swap(left: number, right: number): void {
    const leftEntry = this.heap[left] as RecoveryRetryEntry<Payload>
    const rightEntry = this.heap[right] as RecoveryRetryEntry<Payload>
    this.heap[left] = rightEntry
    this.heap[right] = leftEntry
    rightEntry.heapIndex = left
    leftEntry.heapIndex = right
  }

  private rebuildHeap(): void {
    this.heap.length = 0
    for (const entry of this.entries.values()) {
      entry.heapIndex = undefined
      if (entry.nextRetryAt === undefined) continue
      entry.heapIndex = this.heap.length
      this.heap.push(entry)
    }
    for (let index = Math.floor(this.heap.length / 2) - 1; index >= 0; index -= 1) {
      this.sinkDown(index)
    }
  }
}

function retryDelay(policy: RecoveryRetryPolicy, attempts: number): number {
  const exponent = Math.min(30, Math.max(0, attempts - 1))
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent)
}

function recoveryRetryDiagnostic(failure: unknown): RecoveryRetryDiagnostic {
  const name =
    failure instanceof Error && failure.name.length > 0 ? failure.name : 'StreamRecoveryError'
  const message =
    failure instanceof Error
      ? failure.message
      : typeof failure === 'string' && failure.length > 0
        ? failure
        : 'Recovery operation failed'
  return {
    name: name.slice(0, MAX_DIAGNOSTIC_NAME_LENGTH),
    message: message.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
  }
}

function stateFromEntry<Payload>(entry: RecoveryRetryEntry<Payload>): RecoveryRetryState {
  return {
    key: entry.key,
    evidence: entry.evidence,
    status: entry.quarantined
      ? 'quarantined'
      : entry.nextRetryAt === undefined
        ? 'ready'
        : 'scheduled',
    attempts: entry.attempts,
    firstFailureAt: entry.firstFailureAt,
    lastFailureAt: entry.lastFailureAt,
    ...(entry.nextRetryAt === undefined ? {} : { nextRetryAt: entry.nextRetryAt }),
    diagnostic: { ...entry.diagnostic },
  }
}

function compareEntries<Payload>(
  left: RecoveryRetryEntry<Payload> | undefined,
  right: RecoveryRetryEntry<Payload> | undefined,
): number {
  if (!left) return right ? 1 : 0
  if (!right) return -1
  const time = (left.nextRetryAt as number) - (right.nextRetryAt as number)
  return time === 0 ? left.key.localeCompare(right.key) : time
}
