let pageHiding = false

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    pageHiding = true
  })
  window.addEventListener('pagehide', () => {
    pageHiding = true
  })
  window.addEventListener('pageshow', () => {
    pageHiding = false
  })
}

export function isPageHiding(): boolean {
  return pageHiding
}

export function isPageHidingAbortError(error: unknown): boolean {
  return (
    pageHiding &&
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  )
}
