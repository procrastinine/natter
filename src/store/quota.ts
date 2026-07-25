export const QUOTA_WARN_RATIO = 0.8
export const QUOTA_HARD_WARN_RATIO = 0.95
const STORAGE_PROBE_TIMEOUT_MS = 3_000

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

export type StorageProbeStatus = 'checking' | 'ready' | 'unavailable' | 'error'

export type StorageProbeResult<T> =
  | { status: 'ready'; value: T }
  | { status: 'unavailable' }
  | { status: 'error'; reason: 'timeout' | 'failed' }

export type StorageProbeState<T> = { status: 'checking' } | StorageProbeResult<T>

export interface StorageProbeOptions {
  timeoutMs?: number
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

function storageProbeTimeout(options: StorageProbeOptions | undefined): number {
  const requested = options?.timeoutMs
  return typeof requested === 'number' && Number.isFinite(requested) && requested >= 0
    ? requested
    : STORAGE_PROBE_TIMEOUT_MS
}

async function runStorageProbe<T>(
  operation: (() => Promise<T>) | undefined,
  options?: StorageProbeOptions,
): Promise<StorageProbeResult<T>> {
  if (!operation) return { status: 'unavailable' }

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const operationResult = Promise.resolve()
    .then(operation)
    .then<StorageProbeResult<T>, StorageProbeResult<T>>(
      (value) => ({ status: 'ready', value }),
      () => ({ status: 'error', reason: 'failed' }),
    )
  const timeoutResult = new Promise<StorageProbeResult<T>>((resolve) => {
    timeoutId = setTimeout(
      () => resolve({ status: 'error', reason: 'timeout' }),
      storageProbeTimeout(options),
    )
  })

  try {
    return await Promise.race([operationResult, timeoutResult])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

export async function probeQuota(
  options?: StorageProbeOptions,
): Promise<StorageProbeResult<QuotaSnapshot>> {
  const storage = storageManager()
  const result = await runStorageProbe(
    storage && typeof storage.estimate === 'function' ? () => storage.estimate() : undefined,
    options,
  )
  if (result.status !== 'ready') return result
  const usage = result.value.usage ?? 0
  const quota = result.value.quota ?? 0
  return {
    status: 'ready',
    value: {
      usage,
      quota,
      ratio: quota > 0 ? usage / quota : 0,
      level: classifyQuota(usage, quota),
      usageDetails: normalizeUsageDetails(
        (result.value as StorageEstimate & { usageDetails?: Record<string, unknown> }).usageDetails,
      ),
    },
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

export async function requestNotificationPermissionForStoragePersistence(
  options?: StorageProbeOptions,
): Promise<StoragePersistenceNotificationPermission> {
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
  const requestPermission = notificationApi.requestPermission
  const result = await runStorageProbe(() => requestPermission.call(notificationApi), options)
  return result.status === 'ready' ? result.value : 'error'
}

// Best-effort request for persistent storage. Browsers may prompt the user or
// grant silently depending on engagement / install state. Safe to call any
// number of times; calling from a non-interactive context is a no-op in most
// browsers.
export async function probePersistRequest(
  options?: StorageProbeOptions,
): Promise<StorageProbeResult<boolean>> {
  const storage = storageManager()
  return runStorageProbe(
    storage && typeof storage.persist === 'function' ? () => storage.persist() : undefined,
    options,
  )
}

export async function requestPersist(options?: StorageProbeOptions): Promise<boolean> {
  const result = await probePersistRequest(options)
  return result.status === 'ready' ? result.value : false
}

export async function probePersisted(
  options?: StorageProbeOptions,
): Promise<StorageProbeResult<boolean>> {
  const storage = storageManager()
  return runStorageProbe(
    storage && typeof storage.persisted === 'function' ? () => storage.persisted() : undefined,
    options,
  )
}

export async function isPersisted(options?: StorageProbeOptions): Promise<boolean> {
  const result = await probePersisted(options)
  return result.status === 'ready' ? result.value : false
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
