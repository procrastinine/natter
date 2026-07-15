const PRELOAD_RECOVERY_BUILD_KEY = 'natter:preload-recovery-build'
const PRELOAD_RECOVERY_HISTORY_KEY = '__natterPreloadRecoveryBuild'
const PRELOAD_RECOVERY_WINDOW_NAME_PREFIX = '|natter-preload-recovery:'
const recoveredWithoutStorage = new Set<string>()

function runtimeBuildToken(document: Document): string {
  const entry = [...document.scripts].find(
    (script) => script.type === 'module' && script.src.length > 0,
  )
  return entry?.src ?? 'development'
}

function claimHistoryFallback(target: Window, buildToken: string): boolean {
  try {
    const current =
      target.history.state && typeof target.history.state === 'object'
        ? (target.history.state as Record<string, unknown>)
        : {}
    if (current[PRELOAD_RECOVERY_HISTORY_KEY] === buildToken) return false
    target.history.replaceState(
      { ...current, [PRELOAD_RECOVERY_HISTORY_KEY]: buildToken },
      '',
      target.location.href,
    )
    return true
  } catch {
    const marker = `${PRELOAD_RECOVERY_WINDOW_NAME_PREFIX}${encodeURIComponent(buildToken)}|`
    try {
      if (target.name.includes(marker)) return false
      target.name = `${target.name}${marker}`
      return true
    } catch {
      if (recoveredWithoutStorage.has(buildToken)) return false
      recoveredWithoutStorage.add(buildToken)
      return true
    }
  }
}

export function installPreloadErrorRecovery(
  options: { window?: Window; buildToken?: string; storage?: Storage; reload?: () => void } = {},
): () => void {
  const target = options.window ?? window
  const buildToken = options.buildToken ?? runtimeBuildToken(target.document)
  const reload = options.reload ?? (() => target.location.reload())
  const onPreloadError = (event: Event) => {
    try {
      const storage = options.storage ?? target.sessionStorage
      if (storage.getItem(PRELOAD_RECOVERY_BUILD_KEY) === buildToken) return
      storage.setItem(PRELOAD_RECOVERY_BUILD_KEY, buildToken)
    } catch {
      if (!claimHistoryFallback(target, buildToken)) return
    }
    event.preventDefault()
    reload()
  }
  target.addEventListener('vite:preloadError', onPreloadError)
  return () => target.removeEventListener('vite:preloadError', onPreloadError)
}
