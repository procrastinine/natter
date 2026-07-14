import { describe, expect, it } from 'vitest'
import {
  createCursorOverlay,
  createExactCursorPathGuard,
  createNonConflictingCursorPathGuard,
} from '../../src/core/cursor-overlay'
import type { CursorMap } from '../../src/core/types'

describe('cursor overlays and exact-path guards', () => {
  it('reads overlay patches before the immutable base cursor', () => {
    const overlay = createCursorOverlay({ root: 'A', A: 'B' })
    expect(overlay.root).toBe('A')
    overlay.A = 'C'
    expect(overlay.A).toBe('C')
  })

  it('validates a path once per immutable cursor identity', () => {
    const selections = Array.from(
      { length: 1_000 },
      (_, index) => [`fork-${index}`, `message-${index}`] as const,
    )
    const guard = createExactCursorPathGuard(selections)
    let propertyReads = 0
    const measuredCursor = (mismatchAt?: number): Readonly<CursorMap> =>
      new Proxy(
        Object.fromEntries(
          selections.map(([key, messageId], index) => [
            key,
            index === mismatchAt ? 'different-message' : messageId,
          ]),
        ),
        {
          get(target, property, receiver) {
            if (typeof property === 'string') propertyReads += 1
            return Reflect.get(target, property, receiver) as unknown
          },
        },
      )

    const first = measuredCursor()
    expect(guard.matches(first)).toBe(true)
    expect(propertyReads).toBe(selections.length)
    for (let publication = 0; publication < 10_000; publication += 1) {
      expect(guard.matches(first)).toBe(true)
    }
    expect(propertyReads).toBe(selections.length)

    const leftPath = measuredCursor(500)
    expect(guard.matches(leftPath)).toBe(false)
    expect(propertyReads).toBe(selections.length + 501)
    expect(guard.matches(leftPath)).toBe(false)
    expect(propertyReads).toBe(selections.length + 501)

    expect(guard.matches(first)).toBe(true)
    expect(propertyReads).toBe(selections.length * 2 + 501)
  })

  it('memoizes continuation compatibility while allowing missing pins', () => {
    const guard = createNonConflictingCursorPathGuard([
      ['root', 'A'],
      ['A', 'B'],
    ])
    let propertyReads = 0
    const partial = new Proxy<Readonly<CursorMap>>(
      { root: 'A' },
      {
        get(target, property, receiver) {
          if (typeof property === 'string') propertyReads += 1
          return Reflect.get(target, property, receiver) as unknown
        },
      },
    )

    expect(guard.matches(partial)).toBe(true)
    expect(propertyReads).toBe(2)
    for (let publication = 0; publication < 1_000; publication += 1) {
      expect(guard.matches(partial)).toBe(true)
    }
    expect(propertyReads).toBe(2)
    expect(guard.matches({ root: 'different' })).toBe(false)
    expect(guard.matches(undefined)).toBe(true)
  })
})
