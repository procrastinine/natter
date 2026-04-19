// Hand-curated per-provider `DataPolicy` fallbacks. See
// `plan/09-privacy.md §9.4` "Fallback: `src/capabilities/data_policies.json`".
//
// The live scrape (`src/api/privacy-scrape.ts`) is the authoritative source,
// but it doesn't always align with `/endpoints.provider_name`:
//   - Regional variants collapse on the JSON side: Google Vertex
//     (Global/US/EU) all appear as "Google" in /endpoints, while the HTML
//     scrape still carries the regional suffix.
//   - Freshly-added providers land on the JSON side before the scrape
//     page is updated.
//
// In those cases the curated fallback fills in. The filter consults the
// live scrape first (keyed by `provider_display_name`), then this fallback
// (keyed by `/endpoints.provider_name`), and only synthesizes worst-case
// when both miss.

import defaultsJson from '../capabilities/data_policies.json'
import type { DataPolicy } from './types'

interface PoliciesFile {
  comment?: string
  policies: Record<string, Partial<DataPolicy>>
}

const RAW_POLICIES = (defaultsJson as PoliciesFile).policies

// Normalized, frozen table. We copy each entry into a fully-populated
// `DataPolicy` (filling missing booleans with `false` and URL fields
// with empty strings) so callers never have to branch on `undefined`.
const CURATED_POLICIES: Readonly<Record<string, DataPolicy>> = Object.freeze(
  Object.fromEntries(
    Object.entries(RAW_POLICIES).map(([name, partial]) => {
      const policy: DataPolicy = {
        training: partial.training ?? false,
        trainingOpenRouter: partial.trainingOpenRouter ?? false,
        retainsPrompts: partial.retainsPrompts ?? false,
        canPublish: partial.canPublish ?? false,
        termsOfServiceURL: partial.termsOfServiceURL ?? '',
        privacyPolicyURL: partial.privacyPolicyURL ?? '',
      }
      if (partial.retentionDays !== undefined) policy.retentionDays = partial.retentionDays
      if (partial.requiresUserIDs !== undefined) {
        policy.requiresUserIDs = partial.requiresUserIDs
      }
      return [name, Object.freeze(policy)]
    }),
  ),
)

// Lookup by `/endpoints.provider_name` (e.g. "Azure", "Google", "Amazon
// Bedrock"). Returns a frozen policy so callers can mutate a copy via
// `{ ...curatedPolicy }` without touching the table.
export function curatedPolicyFor(providerName: string): DataPolicy | undefined {
  return CURATED_POLICIES[providerName]
}

export function listCuratedProviders(): readonly string[] {
  return Object.keys(CURATED_POLICIES)
}
