// Chat lock helpers. See `plan/03-storage.md §3.5` and `plan/13-delivery.md §13.2.2`.
//
// Two cross-tab locks, both keyed by chat id:
//   - `chat:{id}`          — mutations to that chat
//   - `chat:{id}:generate` — the single in-flight generation owner for the chat
//
// Legal acquisition order is `:generate` → `{id}`. Acquiring `:generate` while
// already holding plain `{id}` violates the ordering rule and can deadlock when
// two tabs fight for the pair.
//
// Full Web-Locks plumbing lands in Phase 3. This module ships the ordering
// guard so Phase 0 tests can prove the rule holds.

export type ChatLockKind = 'chat' | 'generate'

export interface ChatLockName {
  chatId: string
  kind: ChatLockKind
}

export class LockOrderError extends Error {
  readonly chatId: string
  constructor(chatId: string, message: string) {
    super(message)
    this.name = 'LockOrderError'
    this.chatId = chatId
  }
}

// Per-async-flow stack of currently-held locks, keyed by chat id. An async
// context may hold both locks at once, but only in the legal order. Separate
// async contexts for different chats are independent.
const heldByChat = new Map<string, ChatLockKind[]>()

export function lockResourceName({ chatId, kind }: ChatLockName): string {
  return kind === 'generate' ? `chat:${chatId}:generate` : `chat:${chatId}`
}

// Assert the requested acquisition is legal given what's already held for the
// same chat. Throws `LockOrderError` when the caller tries to escalate from
// `chat` → `:generate`.
export function assertAcquireOrder(name: ChatLockName): void {
  const stack = heldByChat.get(name.chatId) ?? []
  if (name.kind === 'generate' && stack.includes('chat')) {
    throw new LockOrderError(
      name.chatId,
      `Illegal lock escalation: cannot acquire chat:${name.chatId}:generate while chat:${name.chatId} is held`,
    )
  }
  if (stack.includes(name.kind)) {
    // Re-entering a lock we already hold in the same async flow is a bug; the
    // Web Locks API would deadlock. Surface it here too.
    throw new LockOrderError(
      name.chatId,
      `Re-entrant acquisition of ${lockResourceName(name)} is not allowed`,
    )
  }
}

// Tracked lock runner. Runs `fn` while the lock is "held" for purposes of the
// ordering check. Does NOT call `navigator.locks` — the real Web-Locks binding
// lands in Phase 3 and layers this helper underneath.
export async function withTrackedLock<T>(name: ChatLockName, fn: () => Promise<T> | T): Promise<T> {
  assertAcquireOrder(name)
  const stack = heldByChat.get(name.chatId) ?? []
  stack.push(name.kind)
  heldByChat.set(name.chatId, stack)
  try {
    return await fn()
  } finally {
    const current = heldByChat.get(name.chatId)
    if (current) {
      const idx = current.lastIndexOf(name.kind)
      if (idx >= 0) current.splice(idx, 1)
      if (current.length === 0) heldByChat.delete(name.chatId)
    }
  }
}

// Test-only reset. Exported so unit tests can clear state between cases.
export function __resetLockTrackerForTests(): void {
  heldByChat.clear()
}
