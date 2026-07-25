import { describe, expect, it } from 'vitest'
import { browserLocalStorage, browserSessionStorage } from '../../src/lib/browser-storage'

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
})
