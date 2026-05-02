import type { MutationScope } from '../core/types'

const SCOPE_KIND_ORDER = {
  'chat-meta': 0,
  message: 1,
  children: 2,
  draft: 3,
  attachment: 4,
} as const

const TEST_HELD_SCOPES: string[] = []
const FALLBACK_QUEUES = new Map<string, Promise<void>>()

export class ScopeOrderError extends Error {
  readonly requested: string
  readonly held: string[]

  constructor(requested: string, held: string[]) {
    super(`ScopeOrder:${requested}:${held.join(',')}`)
    this.name = 'ScopeOrderError'
    this.requested = requested
    this.held = [...held]
  }
}

function compareScopeKeys(a: string, b: string): number {
  const [aKind] = a.split(':', 1)
  const [bKind] = b.split(':', 1)
  const aRank = SCOPE_KIND_ORDER[aKind as keyof typeof SCOPE_KIND_ORDER]
  const bRank = SCOPE_KIND_ORDER[bKind as keyof typeof SCOPE_KIND_ORDER]
  if (aRank !== bRank) return aRank - bRank
  return a.localeCompare(b)
}

export function scopeResourceName(scope: MutationScope): string {
  switch (scope.kind) {
    case 'chat-meta':
      return `chat-meta:${scope.chatId}`
    case 'message':
      return `message:${scope.messageId}`
    case 'children':
      return `children:${scope.chatId}:${scope.parentId ?? '__root__'}`
    case 'draft':
      return `draft:${scope.chatId}`
    case 'attachment':
      return `attachment:${scope.attachmentId}`
  }
}

export function normalizeMutationScopes(scopes: readonly MutationScope[]): MutationScope[] {
  const keyed = new Map<string, MutationScope>()
  for (const scope of scopes) {
    keyed.set(scopeResourceName(scope), scope)
  }
  return [...keyed.entries()].sort(([a], [b]) => compareScopeKeys(a, b)).map(([, scope]) => scope)
}

export function assertAcquireOrder(resourceName: string): void {
  const lastHeld = TEST_HELD_SCOPES.at(-1)
  if (lastHeld && compareScopeKeys(lastHeld, resourceName) >= 0) {
    throw new ScopeOrderError(resourceName, TEST_HELD_SCOPES)
  }
}

export async function withTrackedScopes<T>(
  scopes: readonly MutationScope[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const normalized = normalizeMutationScopes(scopes)
  const acquired: string[] = []
  for (const scope of normalized) {
    const resourceName = scopeResourceName(scope)
    assertAcquireOrder(resourceName)
    TEST_HELD_SCOPES.push(resourceName)
    acquired.push(resourceName)
  }
  try {
    return await fn()
  } finally {
    for (let i = acquired.length - 1; i >= 0; i -= 1) {
      const resourceName = acquired[i] as string
      const top = TEST_HELD_SCOPES.at(-1)
      if (top === resourceName) {
        TEST_HELD_SCOPES.pop()
      } else {
        const idx = TEST_HELD_SCOPES.lastIndexOf(resourceName)
        if (idx >= 0) TEST_HELD_SCOPES.splice(idx, 1)
      }
    }
  }
}

async function withFallbackLock<T>(resourceName: string, fn: () => Promise<T> | T): Promise<T> {
  const prior = FALLBACK_QUEUES.get(resourceName) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = prior.then(() => gate)
  FALLBACK_QUEUES.set(resourceName, queued)
  await prior
  try {
    return await fn()
  } finally {
    release()
    if (FALLBACK_QUEUES.get(resourceName) === queued) {
      FALLBACK_QUEUES.delete(resourceName)
    }
  }
}

async function withSingleScopeLock<T>(resourceName: string, fn: () => Promise<T> | T): Promise<T> {
  if (typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks) {
    return navigator.locks.request(resourceName, async () => fn())
  }
  return withFallbackLock(resourceName, fn)
}

export async function withNamedLock<T>(resourceName: string, fn: () => Promise<T> | T): Promise<T> {
  return withSingleScopeLock(resourceName, fn)
}

export async function withMutationLocks<T>(
  scopes: readonly MutationScope[],
  fn: () => Promise<T> | T,
): Promise<T> {
  const normalized = normalizeMutationScopes(scopes)
  const run = async (index: number): Promise<T> => {
    if (index >= normalized.length) return fn()
    const scope = normalized[index] as MutationScope
    return withSingleScopeLock(scopeResourceName(scope), () => run(index + 1))
  }
  return run(0)
}

export function __resetLockTrackerForTests(): void {
  TEST_HELD_SCOPES.length = 0
  FALLBACK_QUEUES.clear()
}
