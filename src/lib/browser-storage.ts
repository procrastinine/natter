export function browserLocalStorage(
  target: Window | undefined = browserWindow(),
): Storage | undefined {
  const resolved = target
  if (!resolved) return undefined
  try {
    return resolved.localStorage
  } catch {
    return undefined
  }
}

export function browserSessionStorage(target?: Window): Storage | undefined {
  const resolved = target ?? browserWindow()
  if (!resolved) return undefined
  try {
    return resolved.sessionStorage
  } catch {
    return undefined
  }
}

function browserWindow(): Window | undefined {
  return typeof window === 'undefined' ? undefined : window
}
