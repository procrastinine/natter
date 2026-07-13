import { afterEach, describe, expect, it } from 'vitest'
import { isPageHiding, isPageHidingAbortError } from '../../src/lib/page-lifecycle'

afterEach(() => {
  window.dispatchEvent(new Event('pageshow'))
})

describe('page lifecycle', () => {
  it('treats beforeunload as teardown and pageshow as a reset', () => {
    const abort = new DOMException('navigation aborted the request', 'AbortError')

    expect(isPageHiding()).toBe(false)
    expect(isPageHidingAbortError(abort)).toBe(false)

    window.dispatchEvent(new Event('beforeunload'))
    expect(isPageHiding()).toBe(true)
    expect(isPageHidingAbortError(abort)).toBe(true)
    expect(isPageHidingAbortError(new Error('open-page failure'))).toBe(false)

    window.dispatchEvent(new Event('pageshow'))
    expect(isPageHiding()).toBe(false)
    expect(isPageHidingAbortError(abort)).toBe(false)
  })
})
