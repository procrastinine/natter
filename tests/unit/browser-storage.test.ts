import type { Transaction } from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserLocalStorage, browserSessionStorage } from '../../src/lib/browser-storage'
import {
  abortIndexedDbTransactionAtCancellationBoundary,
  bindReadonlyTransactionAbort,
} from '../../src/store/browser-indexeddb-reads'
import {
  CONVERSATION_SESSION_PREFIX,
  initializeWorkspaceTabSessionContext,
} from '../../src/store/workspace-tab-session'

afterEach(() => {
  sessionStorage.clear()
})

describe('browser storage boundary', () => {
  it('selects the current browser origin storage', () => {
    const target = document.defaultView
    expect(target).not.toBeNull()
    expect(browserLocalStorage(target ?? undefined)).toBe(target?.localStorage)
    expect(browserSessionStorage(target ?? undefined)).toBe(target?.sessionStorage)
    expect(browserLocalStorage()).toBe(target?.localStorage)
    expect(browserSessionStorage()).toBe(target?.sessionStorage)
    expect(target?.location.origin).toBe('http://localhost')

    browserLocalStorage()?.setItem('browser-storage-proof', 'local')
    browserSessionStorage()?.setItem('browser-storage-proof', 'session')
    expect(target?.localStorage.getItem('browser-storage-proof')).toBe('local')
    expect(target?.sessionStorage.getItem('browser-storage-proof')).toBe('session')
  })

  it('preserves reload state but clears cloned presentation state in a new navigation context', () => {
    const conversationKey = `${CONVERSATION_SESSION_PREFIX}chat-a`
    sessionStorage.clear()
    sessionStorage.setItem(conversationKey, 'inherited-tree-presentation')

    initializeWorkspaceTabSessionContext(window, 'navigate')
    expect(sessionStorage.getItem(conversationKey)).toBeNull()

    sessionStorage.setItem(conversationKey, 'reload-presentation')
    initializeWorkspaceTabSessionContext(window, 'reload')
    expect(sessionStorage.getItem(conversationKey)).toBe('reload-presentation')

    initializeWorkspaceTabSessionContext(window, 'navigate')
    expect(sessionStorage.getItem(conversationKey)).toBeNull()
  })
})

describe('IndexedDB read cancellation', () => {
  it('does not abort an already-terminal transaction', () => {
    const transaction = {
      active: false,
      abort: vi.fn(),
    } as unknown as Transaction
    const controller = new AbortController()
    const unbind = bindReadonlyTransactionAbort(
      transaction,
      controller.signal,
      'Workspace query aborted',
    )

    expect(() => controller.abort()).not.toThrow()
    expect(transaction.abort).not.toHaveBeenCalled()
    unbind()
  })

  it('treats a native terminal race as an idempotent cancellation without classifying the error', () => {
    const transaction = {
      active: true,
      abort: vi.fn(() => {
        transaction.active = false
        throw new DOMException('The transaction has finished', 'InvalidStateError')
      }),
    } as unknown as Transaction
    const controller = new AbortController()
    const unbind = bindReadonlyTransactionAbort(
      transaction,
      controller.signal,
      'Workspace query aborted',
    )

    expect(() => controller.abort()).not.toThrow()
    expect(transaction.abort).toHaveBeenCalledTimes(1)
    unbind()
  })

  it('does not hide an unexpected transaction abort failure', () => {
    const failure = new Error('abort failed before terminal ownership transferred')
    const transaction = {
      active: true,
      abort: vi.fn(() => {
        throw failure
      }),
    } as unknown as Transaction

    expect(() => abortIndexedDbTransactionAtCancellationBoundary(transaction)).toThrow(failure)
    expect(transaction.abort).toHaveBeenCalledTimes(1)
  })
})
