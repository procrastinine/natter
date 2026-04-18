// Chat locks. See `plan/03-storage.md §3.5–§3.7`.
//
// Two cross-tab locks, both keyed by chat id:
//   - `chat:{id}`          — mutations to that chat
//   - `chat:{id}:generate` — the single in-flight generation owner for the chat
//
// Legal acquisition order is `:generate` → `{id}`. Acquiring `:generate` while
// already holding plain `{id}` violates the ordering rule and can deadlock when
// two tabs fight for the pair.
//
// `withChatLock` is the chokepoint for every mutating write. It:
//   - enforces the ordering rule in-process
//   - holds `navigator.locks.request('chat:{id}', exclusive)` cross-tab
//   - opens a Dexie rw transaction covering the hot tables
//   - loads the chat row, hands the caller a structured clone + a patch fn
//   - bumps `chat.version` and `chat.updatedAt` exactly once on commit
//   - broadcasts `chat-mutated` AFTER the commit settles (never before)
//
// Callers return arbitrary values from the callback; the wrapper returns both
// the value and the new version.

import type { Chat, ChatId } from '../core/types'
import type { Transaction } from 'dexie'
import { getDb } from './db'
import { postEvent } from './broadcast'

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

export class ChatMissingError extends Error {
  readonly chatId: string
  constructor(chatId: string) {
    super(`ChatMissing:${chatId}`)
    this.name = 'ChatMissingError'
    this.chatId = chatId
  }
}

export interface ChatMutationContext {
  tx: Transaction
  chat: Chat
  patchChat: (patch: Partial<Chat>) => void
}

export interface ChatMutationResult<T> {
  value: T
  version: number
}

const heldByChat = new Map<string, ChatLockKind[]>()

export function lockResourceName({ chatId, kind }: ChatLockName): string {
  return kind === 'generate' ? `chat:${chatId}:generate` : `chat:${chatId}`
}

export function assertAcquireOrder(name: ChatLockName): void {
  const stack = heldByChat.get(name.chatId) ?? []
  if (name.kind === 'generate' && stack.includes('chat')) {
    throw new LockOrderError(
      name.chatId,
      `Illegal lock escalation: cannot acquire chat:${name.chatId}:generate while chat:${name.chatId} is held`,
    )
  }
  if (stack.includes(name.kind)) {
    throw new LockOrderError(
      name.chatId,
      `Re-entrant acquisition of ${lockResourceName(name)} is not allowed`,
    )
  }
}

// Tracked lock runner. Enforces the ordering rule on a per-async-flow stack.
// Does NOT cross tabs — `withChatLock` layers `navigator.locks.request` on top.
export async function withTrackedLock<T>(
  name: ChatLockName,
  fn: () => Promise<T> | T,
): Promise<T> {
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

// Web-Locks binding. In the browser we delegate to `navigator.locks.request`
// for cross-tab serialization; in environments without it (jsdom, Node tests)
// we fall back to an in-memory promise queue keyed by the resource name. Both
// paths provide same-origin exclusive semantics; only the browser path spans
// tabs.
const inMemoryQueues = new Map<string, Promise<unknown>>()

type NavigatorLocks = {
  request: <T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<T> | T,
  ) => Promise<T>
}

function getNavigatorLocks(): NavigatorLocks | null {
  if (typeof navigator === 'undefined') return null
  const maybe = (navigator as unknown as { locks?: NavigatorLocks }).locks
  return maybe && typeof maybe.request === 'function' ? maybe : null
}

export async function acquireWebLock<T>(
  resourceName: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const locks = getNavigatorLocks()
  if (locks) {
    return locks.request(resourceName, { mode: 'exclusive' }, fn)
  }
  const previous = inMemoryQueues.get(resourceName) ?? Promise.resolve()
  // Run `fn` once the previous holder settles, regardless of whether it threw
  // — mirrors `navigator.locks.request` semantics (a failing holder still
  // releases the lock).
  const settled = previous.then(fn, fn)
  const tail = settled.then(
    () => {},
    () => {},
  )
  inMemoryQueues.set(resourceName, tail)
  tail.then(() => {
    if (inMemoryQueues.get(resourceName) === tail) {
      inMemoryQueues.delete(resourceName)
    }
  })
  return settled
}

// `withChatLock` serializes via the cross-tab web lock; it deliberately does
// NOT interact with the in-process tracker. Concurrent calls from independent
// async flows in the same tab would false-positive under the tracker's "single
// stack per chat id" model. The tracker exists for explicit ordering assertions
// by code that interleaves `chat` and `:generate` in a known flow (streaming,
// Phase 6). Nested misuse of `withChatLock` inside `withChatGenerateLock`
// relies on that call pattern's explicit tracker usage.
export async function withChatLock<T>(
  chatId: ChatId,
  fn: (ctx: ChatMutationContext) => Promise<T> | T,
): Promise<ChatMutationResult<T>> {
  const resource = lockResourceName({ chatId, kind: 'chat' })
  return acquireWebLock(resource, async () => {
    const db = getDb()
    let value!: T
    let chatPatch: Partial<Chat> = {}
    let newVersion = 0
    await db.transaction(
      'rw',
      [db.chats, db.messages, db.attachments, db.drafts, db.chatBranchCache],
      async (tx) => {
        const existing = await db.chats.get(chatId)
        if (!existing) throw new ChatMissingError(chatId)
        const ctx: ChatMutationContext = {
          tx,
          chat: structuredClone(existing),
          patchChat: (patch) => {
            chatPatch = { ...chatPatch, ...patch }
          },
        }
        value = await fn(ctx)
        newVersion = existing.version + 1
        const next: Chat = {
          ...existing,
          ...chatPatch,
          version: newVersion,
          updatedAt: Date.now(),
        }
        await db.chats.put(next)
      },
    )
    postEvent({ kind: 'chat-mutated', chatId, version: newVersion })
    return { value, version: newVersion }
  })
}

export function __resetLockTrackerForTests(): void {
  heldByChat.clear()
  inMemoryQueues.clear()
}
