import type { TestGuaranteeClaim } from './audit-test-evidence.mjs'

export const DECLARED_TEST_DOMAINS: Readonly<Record<string, readonly string[]>>
export const TEST_GUARANTEE_CLAIMS: readonly TestGuaranteeClaim[]
export const ALLOWED_DEV_BUILT_DIVERGENCES: readonly {
  id: string
  category: string
  path: string
  locator: string
  rationale: string
}[]
