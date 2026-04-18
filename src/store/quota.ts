// Storage-quota probes. See `plan/03-storage.md §3.4`.

export const QUOTA_WARN_RATIO = 0.8
export const QUOTA_HARD_WARN_RATIO = 0.95

export type QuotaLevel = 'ok' | 'warn' | 'hard-warn'

export interface QuotaSnapshot {
  usage: number
  quota: number
  ratio: number
  level: QuotaLevel
}

export function classifyQuota(usage: number, quota: number): QuotaLevel {
  if (quota <= 0) return 'ok'
  const ratio = usage / quota
  if (ratio >= QUOTA_HARD_WARN_RATIO) return 'hard-warn'
  if (ratio >= QUOTA_WARN_RATIO) return 'warn'
  return 'ok'
}

export async function estimateQuota(): Promise<QuotaSnapshot | null> {
  if (typeof navigator === 'undefined') return null
  const storage = (navigator as { storage?: StorageManager }).storage
  if (!storage || typeof storage.estimate !== 'function') return null
  const est = await storage.estimate()
  const usage = est.usage ?? 0
  const quota = est.quota ?? 0
  return {
    usage,
    quota,
    ratio: quota > 0 ? usage / quota : 0,
    level: classifyQuota(usage, quota),
  }
}

// Best-effort request for persistent storage. Browsers may prompt the user or
// grant silently depending on engagement / install state. Safe to call any
// number of times; calling from a non-interactive context is a no-op in most
// browsers.
export async function requestPersist(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false
  const storage = (navigator as { storage?: StorageManager }).storage
  if (!storage || typeof storage.persist !== 'function') return false
  try {
    return await storage.persist()
  } catch {
    return false
  }
}

export async function isPersisted(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false
  const storage = (navigator as { storage?: StorageManager }).storage
  if (!storage || typeof storage.persisted !== 'function') return false
  try {
    return await storage.persisted()
  } catch {
    return false
  }
}
