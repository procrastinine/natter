// Per-tab branch navigation is an intent-owned state machine. Only the opaque
// capability returned by `beginNavigationIntent` can publish an async result;
// repository observations may reconcile an existing cursor but never become a
// navigation intent.

import { create } from 'zustand'
import type { ChatId, CursorMap, CursorPatch, MessageId } from '../../core/types'
import {
  isPersistentCursor,
  patchPersistentCursor,
  persistentCursorSize,
  toPersistentCursor,
} from './persistentCursor'
import {
  claimTabNavigation,
  invalidateTabNavigation,
  isTabNavigationCurrent,
  type TabNavigationAuthority,
} from './tabNavigation'

const navigationIntentBrand: unique symbol = Symbol('NavigationIntent')
const navigationAuthority: unique symbol = Symbol('NavigationAuthority')

export interface NavigationIntent {
  readonly chatId: ChatId
  readonly revision: string
  readonly [navigationIntentBrand]: true
  readonly [navigationAuthority]: TabNavigationAuthority
}

export interface PendingBranchNavigation {
  readonly revision: string
  readonly selections: Readonly<CursorMap>
  readonly pathMessageIds: readonly MessageId[]
  readonly targetMessageId: MessageId
}

interface TabBranchState {
  readonly intent: NavigationIntent | null
  readonly revision: string
  readonly cursor: Readonly<CursorMap>
  readonly pending?: PendingBranchNavigation
}

interface ChatStoreState {
  publication: number
  getDebugStats: () => { chatCursorCount: number; cursorEntryCount: number }
  getCursor: (chatId: ChatId) => Readonly<CursorMap> | undefined
  getNavigationRevision: (chatId: ChatId) => string
  getPendingBranchNavigation: (chatId: ChatId) => PendingBranchNavigation | undefined
  isNavigationIntentCurrent: (intent: NavigationIntent) => boolean
  beginNavigationIntent: (chatId: ChatId) => NavigationIntent
  navigateToCursor: (chatId: ChatId, cursor: Readonly<CursorMap>) => NavigationIntent
  navigateWithCursorPatch: (chatId: ChatId, patch: Readonly<CursorPatch>) => NavigationIntent
  setCursorForIntent: (
    chatId: ChatId,
    intent: NavigationIntent,
    cursor: Readonly<CursorMap>,
  ) => boolean
  patchCursorForIntent: (
    chatId: ChatId,
    intent: NavigationIntent,
    patch: Readonly<CursorPatch>,
  ) => boolean
  reconcileCursor: (chatId: ChatId, cursor: Readonly<CursorMap>) => void
  reconcileCursorPatch: (chatId: ChatId, patch: Readonly<CursorPatch>) => void
  selectPathForIntent: (
    chatId: ChatId,
    intent: NavigationIntent,
    selections: Readonly<Record<string, MessageId>>,
    pendingPathMessageIds?: readonly MessageId[],
  ) => boolean
  acknowledgePendingBranchNavigation: (chatId: ChatId, pending: PendingBranchNavigation) => void
  clearCursor: (chatId: ChatId) => void
  resetForWorkspaceReplacement: () => void
  reset: () => void
}

const branches = new Map<ChatId, TabBranchState>()

function createNavigationIntent(chatId: ChatId): NavigationIntent {
  const authority = claimTabNavigation()
  return Object.freeze({
    chatId,
    revision: authority.revision,
    [navigationIntentBrand]: true as const,
    [navigationAuthority]: authority,
  })
}

function ownedCursor(cursor: Readonly<CursorMap>): Readonly<CursorMap> {
  return toPersistentCursor(cursor)
}

function mergedCursor(
  cursor: Readonly<CursorMap>,
  selections: Readonly<CursorMap>,
): Readonly<CursorMap> {
  return patchPersistentCursor(cursor, selections)
}

function cursorEqual(left: Readonly<CursorMap>, right: Readonly<CursorMap>): boolean {
  if (left === right) return true
  if (isPersistentCursor(left) && isPersistentCursor(right)) return false
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) => left[key] === right[key])
}

function pathEqual(left: readonly MessageId[], right: readonly MessageId[]): boolean {
  return (
    left.length === right.length && left.every((messageId, index) => messageId === right[index])
  )
}

function pendingEqual(
  pending: PendingBranchNavigation | undefined,
  revision: string,
  selections: Readonly<CursorMap>,
  pathMessageIds: readonly MessageId[] | undefined,
): boolean {
  const targetMessageId = pathMessageIds?.at(-1)
  if (!pathMessageIds || !targetMessageId) return pending === undefined
  return (
    pending?.revision === revision &&
    pending.targetMessageId === targetMessageId &&
    cursorEqual(pending.selections, selections) &&
    pathEqual(pending.pathMessageIds, pathMessageIds)
  )
}

function ownedPath(pathMessageIds: readonly MessageId[]): readonly MessageId[] {
  return Object.freeze([...pathMessageIds])
}

function ownedSelections(selections: Readonly<CursorMap>): Readonly<CursorMap> {
  return Object.freeze({ ...selections })
}

function isCurrent(chatId: ChatId, intent: NavigationIntent): boolean {
  return (
    intent.chatId === chatId &&
    branches.get(chatId)?.intent === intent &&
    isTabNavigationCurrent(intent[navigationAuthority])
  )
}

export const useChatStore = create<ChatStoreState>((set) => {
  const publish = () => set((state) => ({ publication: state.publication + 1 }))

  return {
    publication: 0,
    getDebugStats: () => {
      let cursorEntryCount = 0
      for (const branch of branches.values()) {
        cursorEntryCount += persistentCursorSize(branch.cursor)
      }
      return { chatCursorCount: branches.size, cursorEntryCount }
    },
    getCursor: (chatId) => branches.get(chatId)?.cursor,
    getNavigationRevision: (chatId) => branches.get(chatId)?.revision ?? '0',
    getPendingBranchNavigation: (chatId) => {
      const branch = branches.get(chatId)
      return branch?.intent && isCurrent(chatId, branch.intent) ? branch.pending : undefined
    },
    isNavigationIntentCurrent: (intent) => isCurrent(intent.chatId, intent),
    beginNavigationIntent: (chatId) => {
      const intent = createNavigationIntent(chatId)
      const current = branches.get(chatId)
      branches.set(chatId, {
        intent,
        revision: intent.revision,
        cursor: current?.cursor ?? ownedCursor({}),
      })
      publish()
      return intent
    },
    navigateToCursor: (chatId, cursor) => {
      const intent = createNavigationIntent(chatId)
      const current = branches.get(chatId)
      branches.set(chatId, {
        intent,
        revision: intent.revision,
        cursor:
          current && cursorEqual(current.cursor, cursor) ? current.cursor : ownedCursor(cursor),
      })
      publish()
      return intent
    },
    navigateWithCursorPatch: (chatId, patch) => {
      const intent = createNavigationIntent(chatId)
      const current = branches.get(chatId)
      branches.set(chatId, {
        intent,
        revision: intent.revision,
        cursor: patchPersistentCursor(current?.cursor ?? ownedCursor({}), patch),
      })
      publish()
      return intent
    },
    setCursorForIntent: (chatId, intent, cursor) => {
      const current = branches.get(chatId)
      if (!current || !isCurrent(chatId, intent)) return false
      const cursorUnchanged = cursorEqual(current.cursor, cursor)
      if (cursorUnchanged && !current.pending) return true
      branches.set(chatId, {
        intent,
        revision: intent.revision,
        cursor: cursorUnchanged ? current.cursor : ownedCursor(cursor),
      })
      publish()
      return true
    },
    patchCursorForIntent: (chatId, intent, patch) => {
      const current = branches.get(chatId)
      if (!current || !isCurrent(chatId, intent)) return false
      const cursor = patchPersistentCursor(current.cursor, patch)
      if (cursor === current.cursor && !current.pending) return true
      branches.set(chatId, {
        intent,
        revision: intent.revision,
        cursor,
      })
      publish()
      return true
    },
    reconcileCursor: (chatId, cursor) => {
      const current = branches.get(chatId)
      if (current && cursorEqual(current.cursor, cursor)) return
      branches.set(chatId, {
        intent: current?.intent ?? null,
        revision: current?.revision ?? '0',
        cursor: ownedCursor(cursor),
        ...(current?.pending ? { pending: current.pending } : {}),
      })
      publish()
    },
    reconcileCursorPatch: (chatId, patch) => {
      const current = branches.get(chatId)
      const cursor = patchPersistentCursor(current?.cursor ?? ownedCursor({}), patch)
      if (current && cursor === current.cursor) return
      branches.set(chatId, {
        intent: current?.intent ?? null,
        revision: current?.revision ?? '0',
        cursor,
        ...(current?.pending ? { pending: current.pending } : {}),
      })
      publish()
    },
    selectPathForIntent: (chatId, intent, selections, pendingPathMessageIds) => {
      const current = branches.get(chatId)
      if (!current || !isCurrent(chatId, intent)) return false
      const cursorChanged = Object.entries(selections).some(
        ([parentKey, childId]) => current.cursor[parentKey] !== childId,
      )
      if (
        !cursorChanged &&
        pendingEqual(current.pending, intent.revision, selections, pendingPathMessageIds)
      ) {
        return true
      }
      const path = pendingPathMessageIds?.length ? ownedPath(pendingPathMessageIds) : undefined
      const targetMessageId = path?.at(-1)
      const nextSelections = targetMessageId ? ownedSelections(selections) : undefined
      branches.set(chatId, {
        intent,
        revision: intent.revision,
        cursor: cursorChanged ? mergedCursor(current.cursor, selections) : current.cursor,
        ...(path && targetMessageId && nextSelections
          ? {
              pending: Object.freeze({
                revision: intent.revision,
                selections: nextSelections,
                pathMessageIds: path,
                targetMessageId,
              }),
            }
          : {}),
      })
      publish()
      return true
    },
    acknowledgePendingBranchNavigation: (chatId, pending) => {
      const current = branches.get(chatId)
      if (!current || current.pending !== pending) return
      branches.set(chatId, {
        intent: current.intent,
        revision: current.revision,
        cursor: current.cursor,
      })
      publish()
    },
    clearCursor: (chatId) => {
      const current = branches.get(chatId)
      if (!branches.delete(chatId)) return
      if (current?.intent && isTabNavigationCurrent(current.intent[navigationAuthority])) {
        invalidateTabNavigation()
      }
      publish()
    },
    resetForWorkspaceReplacement: () => {
      branches.clear()
      publish()
    },
    reset: () => {
      branches.clear()
      invalidateTabNavigation()
      publish()
    },
  }
})
