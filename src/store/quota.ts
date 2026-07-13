export const QUOTA_WARN_RATIO = 0.8
export const QUOTA_HARD_WARN_RATIO = 0.95

type QuotaLevel = 'ok' | 'warn' | 'hard-warn'
type PersistenceHelpBrowser = 'chromium' | 'safari' | 'other'

export type StoragePersistenceNotificationPermission =
  | NotificationPermission
  | 'unsupported'
  | 'skipped'
  | 'error'

export interface QuotaSnapshot {
  usage: number
  quota: number
  ratio: number
  level: QuotaLevel
  usageDetails: Record<string, number>
}

function storageManager(): StorageManager | undefined {
  if (typeof navigator === 'undefined') return undefined
  return (navigator as { storage?: StorageManager }).storage
}

export function classifyQuota(usage: number, quota: number): QuotaLevel {
  if (quota <= 0) return 'ok'
  const ratio = usage / quota
  if (ratio >= QUOTA_HARD_WARN_RATIO) return 'hard-warn'
  if (ratio >= QUOTA_WARN_RATIO) return 'warn'
  return 'ok'
}

export async function estimateQuota(): Promise<QuotaSnapshot | null> {
  const storage = storageManager()
  if (!storage || typeof storage.estimate !== 'function') return null
  const est = await storage.estimate()
  const usage = est.usage ?? 0
  const quota = est.quota ?? 0
  const usageDetails = normalizeUsageDetails(
    (est as StorageEstimate & { usageDetails?: Record<string, unknown> }).usageDetails,
  )
  return {
    usage,
    quota,
    ratio: quota > 0 ? usage / quota : 0,
    level: classifyQuota(usage, quota),
    usageDetails,
  }
}

function normalizeUsageDetails(value: Record<string, unknown> | undefined): Record<string, number> {
  if (!value) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0,
    ),
  )
}

export function storagePersistenceAvailable(): boolean {
  const storage = storageManager()
  return (
    !!storage && typeof storage.persist === 'function' && typeof storage.persisted === 'function'
  )
}

function storagePersistenceHelpBrowser(): PersistenceHelpBrowser {
  if (typeof navigator === 'undefined') return 'other'
  const brands = (navigator as { userAgentData?: { brands?: Array<{ brand: string }> } })
    .userAgentData?.brands
  if (
    brands?.some(({ brand }) => /Chromium|Google Chrome|Microsoft Edge|Opera|Brave/i.test(brand))
  ) {
    return 'chromium'
  }
  const userAgent = navigator.userAgent
  if (/\b(?:Chrome|Chromium|Edg|OPR|SamsungBrowser)\//.test(userAgent)) return 'chromium'
  if (
    /\bSafari\//.test(userAgent) &&
    !/\b(?:Chrome|Chromium|CriOS|FxiOS|Edg|OPR|SamsungBrowser)\//.test(userAgent)
  ) {
    return 'safari'
  }
  return 'other'
}

export function storagePersistenceNotificationMayHelp(): boolean {
  const browser = storagePersistenceHelpBrowser()
  return browser === 'chromium' || browser === 'safari'
}

export async function requestNotificationPermissionForStoragePersistence(): Promise<StoragePersistenceNotificationPermission> {
  if (!storagePersistenceNotificationMayHelp()) return 'skipped'
  const notificationApi = (
    globalThis as {
      Notification?: {
        permission?: NotificationPermission
        requestPermission?: () => Promise<NotificationPermission>
      }
    }
  ).Notification
  if (!notificationApi || typeof notificationApi.requestPermission !== 'function') {
    return 'unsupported'
  }
  if (notificationApi.permission === 'granted' || notificationApi.permission === 'denied') {
    return notificationApi.permission
  }
  if (notificationApi.permission !== 'default') return 'unsupported'
  try {
    return await notificationApi.requestPermission()
  } catch {
    return 'error'
  }
}

// Best-effort request for persistent storage. Browsers may prompt the user or
// grant silently depending on engagement / install state. Safe to call any
// number of times; calling from a non-interactive context is a no-op in most
// browsers.
export async function requestPersist(): Promise<boolean> {
  const storage = storageManager()
  if (!storage || typeof storage.persist !== 'function') return false
  try {
    return await storage.persist()
  } catch {
    return false
  }
}

export async function isPersisted(): Promise<boolean> {
  const storage = storageManager()
  if (!storage || typeof storage.persisted !== 'function') return false
  try {
    return await storage.persisted()
  } catch {
    return false
  }
}

let persistOncePromise: Promise<boolean> | null = null

function requestPersistOnce(): Promise<boolean> {
  if (persistOncePromise) return persistOncePromise
  persistOncePromise = requestPersist()
  return persistOncePromise
}

export function installPersistenceRequestOnFirstInteraction(): () => void {
  if (typeof window === 'undefined') return () => {}
  if (!storagePersistenceAvailable()) return () => {}

  let active = true
  const run = () => {
    if (!active) return
    removeListeners()
    void requestPersistOnce()
  }
  const addOptions: AddEventListenerOptions = { capture: true, once: true }
  const removeOptions: EventListenerOptions = { capture: true }

  function removeListeners() {
    window.removeEventListener('pointerdown', run, removeOptions)
    window.removeEventListener('keydown', run, removeOptions)
    window.removeEventListener('touchstart', run, removeOptions)
  }

  const userActivation = (navigator as { userActivation?: { hasBeenActive?: boolean } })
    .userActivation
  if (userActivation?.hasBeenActive) run()
  else {
    window.addEventListener('pointerdown', run, addOptions)
    window.addEventListener('keydown', run, addOptions)
    window.addEventListener('touchstart', run, addOptions)
  }

  void isPersisted().then((persisted) => {
    if (persisted) removeListeners()
  })

  return () => {
    active = false
    removeListeners()
  }
}
