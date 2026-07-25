export const MODELS_TTL_MS = 60 * 60 * 1000
export const ENDPOINTS_TTL_MS = 5 * 60 * 1000
export const PRIVACY_POLICY_TTL_MS = 24 * 60 * 60 * 1000
export const EMPTY_PRIVACY_POLICY_RETRY_MS = 5 * 60 * 1000

export function isFresh(fetchedAt: number, ttlMs: number, now: number = Date.now()): boolean {
  const age = now - fetchedAt
  return age >= 0 && age < ttlMs
}
