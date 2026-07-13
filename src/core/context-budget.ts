export const UNLIMITED_CONTEXT = -1

export function resolveContextCap(stored: number | undefined, providerCap: number): number {
  if (stored === UNLIMITED_CONTEXT) return Number.POSITIVE_INFINITY
  return stored ?? providerCap
}
