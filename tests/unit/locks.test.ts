import { afterEach, describe, expect, it } from 'vitest'
import type { MutationScope } from '../../src/core/types'
import {
  __resetLockTrackerForTests,
  assertAcquireOrder,
  normalizeMutationScopes,
  ScopeOrderError,
  scopeResourceName,
  withTrackedScopes,
} from '../../src/store/locks'

afterEach(() => {
  __resetLockTrackerForTests()
})

describe('scopeResourceName', () => {
  it('formats every mutation scope key deterministically', () => {
    expect(scopeResourceName({ kind: 'chat-meta', chatId: 'C1' })).toBe('chat-meta:C1')
    expect(scopeResourceName({ kind: 'message', messageId: 'M1' })).toBe('message:M1')
    expect(scopeResourceName({ kind: 'children', chatId: 'C1', parentId: null })).toBe(
      'children:C1:__root__',
    )
    expect(scopeResourceName({ kind: 'children', chatId: 'C1', parentId: 'M1' })).toBe(
      'children:C1:M1',
    )
    expect(scopeResourceName({ kind: 'draft', chatId: 'C1' })).toBe('draft:C1')
    expect(scopeResourceName({ kind: 'attachment', attachmentId: 'A1' })).toBe('attachment:A1')
  })
})

describe('normalizeMutationScopes', () => {
  it('dedupes and sorts by canonical kind order, then key', () => {
    const scopes: MutationScope[] = [
      { kind: 'attachment', attachmentId: 'A1' },
      { kind: 'message', messageId: 'M2' },
      { kind: 'children', chatId: 'C1', parentId: 'P1' },
      { kind: 'chat-meta', chatId: 'C1' },
      { kind: 'message', messageId: 'M1' },
      { kind: 'message', messageId: 'M2' },
    ]
    expect(normalizeMutationScopes(scopes).map(scopeResourceName)).toEqual([
      'chat-meta:C1',
      'message:M1',
      'message:M2',
      'children:C1:P1',
      'attachment:A1',
    ])
  })
})

describe('tracked acquisition order', () => {
  it('allows nested acquisition only in canonical order', async () => {
    await withTrackedScopes([{ kind: 'chat-meta', chatId: 'C1' }], async () => {
      await expect(
        withTrackedScopes([{ kind: 'message', messageId: 'M1' }], async () => 'ok'),
      ).resolves.toBe('ok')
    })
  })

  it('rejects descending order', async () => {
    await withTrackedScopes([{ kind: 'message', messageId: 'M1' }], async () => {
      await expect(
        withTrackedScopes([{ kind: 'chat-meta', chatId: 'C1' }], async () => 'boom'),
      ).rejects.toBeInstanceOf(ScopeOrderError)
    })
  })

  it('rejects re-acquiring the same scope', async () => {
    await withTrackedScopes([{ kind: 'message', messageId: 'M1' }], async () => {
      await expect(
        withTrackedScopes([{ kind: 'message', messageId: 'M1' }], async () => 'boom'),
      ).rejects.toBeInstanceOf(ScopeOrderError)
    })
  })

  it('assertAcquireOrder accepts raw resource names for tests', async () => {
    await withTrackedScopes([{ kind: 'chat-meta', chatId: 'C1' }], async () => {
      expect(() => assertAcquireOrder('message:M1')).not.toThrow()
      expect(() => assertAcquireOrder('chat-meta:C1')).toThrow(ScopeOrderError)
    })
  })

  it('releases tracked scopes after errors', async () => {
    await expect(
      withTrackedScopes([{ kind: 'children', chatId: 'C1', parentId: 'P1' }], async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await expect(
      withTrackedScopes([{ kind: 'children', chatId: 'C1', parentId: 'P1' }], async () => 'ok'),
    ).resolves.toBe('ok')
  })
})
