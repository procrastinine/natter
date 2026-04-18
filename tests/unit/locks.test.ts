import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetLockTrackerForTests,
  assertAcquireOrder,
  LockOrderError,
  lockResourceName,
  withTrackedLock,
} from '../../src/store/locks'

afterEach(() => {
  __resetLockTrackerForTests()
})

describe('lockResourceName', () => {
  it('formats the `chat:{id}` resource name', () => {
    expect(lockResourceName({ chatId: 'CHAT_1', kind: 'chat' })).toBe('chat:CHAT_1')
  })

  it('formats the `chat:{id}:generate` resource name', () => {
    expect(lockResourceName({ chatId: 'CHAT_1', kind: 'generate' })).toBe('chat:CHAT_1:generate')
  })
})

describe('lock acquisition order', () => {
  it('allows :generate → chat (the only legal order)', async () => {
    await withTrackedLock({ chatId: 'CHAT_1', kind: 'generate' }, async () => {
      await expect(
        withTrackedLock({ chatId: 'CHAT_1', kind: 'chat' }, async () => 'ok'),
      ).resolves.toBe('ok')
    })
  })

  it('rejects chat → :generate', async () => {
    await withTrackedLock({ chatId: 'CHAT_1', kind: 'chat' }, async () => {
      await expect(
        withTrackedLock({ chatId: 'CHAT_1', kind: 'generate' }, async () => 'ok'),
      ).rejects.toBeInstanceOf(LockOrderError)
    })
  })

  it('rejects re-entrant acquisition of the same kind', async () => {
    await withTrackedLock({ chatId: 'CHAT_1', kind: 'generate' }, async () => {
      await expect(
        withTrackedLock({ chatId: 'CHAT_1', kind: 'generate' }, async () => 'ok'),
      ).rejects.toBeInstanceOf(LockOrderError)
    })
  })

  it('ordering state is scoped per chat id', async () => {
    await withTrackedLock({ chatId: 'CHAT_1', kind: 'chat' }, async () => {
      await expect(
        withTrackedLock({ chatId: 'CHAT_2', kind: 'generate' }, async () => 'ok'),
      ).resolves.toBe('ok')
    })
  })

  it('assertAcquireOrder surfaces the chat id on the error', () => {
    // Hand-hold the state: we pretend `chat:X` is held and try to escalate.
    // Using withTrackedLock ensures cleanup.
    return withTrackedLock({ chatId: 'CHAT_X', kind: 'chat' }, async () => {
      try {
        assertAcquireOrder({ chatId: 'CHAT_X', kind: 'generate' })
        expect.fail('expected LockOrderError')
      } catch (err) {
        expect(err).toBeInstanceOf(LockOrderError)
        expect((err as LockOrderError).chatId).toBe('CHAT_X')
      }
    })
  })

  it('releases the lock after completion', async () => {
    await withTrackedLock({ chatId: 'CHAT_1', kind: 'generate' }, async () => 'first')
    await expect(
      withTrackedLock({ chatId: 'CHAT_1', kind: 'generate' }, async () => 'second'),
    ).resolves.toBe('second')
  })

  it('releases the lock even when the callback throws', async () => {
    await expect(
      withTrackedLock({ chatId: 'CHAT_1', kind: 'generate' }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await expect(
      withTrackedLock({ chatId: 'CHAT_1', kind: 'generate' }, async () => 'after'),
    ).resolves.toBe('after')
  })
})
