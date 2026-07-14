import type { CursorMap, MessageId } from './types'

export function createCursorOverlay(base: Readonly<CursorMap>): CursorMap {
  const patch = Object.create(null) as CursorMap
  return new Proxy(patch, {
    get: (target, property) => {
      if (typeof property !== 'string') return undefined
      return Object.hasOwn(target, property) ? target[property] : base[property]
    },
  })
}

export interface ExactCursorPathGuard {
  matches(cursor: Readonly<CursorMap> | undefined): boolean
}

export function createExactCursorPathGuard(
  selections: ReadonlyArray<readonly [string, MessageId]>,
): ExactCursorPathGuard {
  return createCursorPathGuard(
    selections,
    (selectedMessageId, requiredMessageId) => selectedMessageId === requiredMessageId,
  )
}

export function createNonConflictingCursorPathGuard(
  selections: ReadonlyArray<readonly [string, MessageId]>,
): ExactCursorPathGuard {
  return createCursorPathGuard(
    selections,
    (selectedMessageId, requiredMessageId) =>
      selectedMessageId === undefined || selectedMessageId === requiredMessageId,
  )
}

function createCursorPathGuard(
  selections: ReadonlyArray<readonly [string, MessageId]>,
  selectionMatches: (
    selectedMessageId: MessageId | undefined,
    requiredMessageId: MessageId,
  ) => boolean,
): ExactCursorPathGuard {
  const required = [...selections]
  let hasCachedCursor = false
  let cachedCursor: Readonly<CursorMap> | undefined
  let cachedResult = false
  return {
    matches(cursor) {
      // Store cursor snapshots are immutable, so identity is the exact invalidation key.
      if (hasCachedCursor && cursor === cachedCursor) return cachedResult
      hasCachedCursor = true
      cachedCursor = cursor
      cachedResult = required.every(([key, selectedMessageId]) =>
        selectionMatches(cursor?.[key], selectedMessageId),
      )
      return cachedResult
    },
  }
}
