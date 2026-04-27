// Bundled capability tables for non-OpenRouter providers. See
// `plan/07-discovery.md §7.6`. OpenRouter's /endpoints is authoritative; for
// everything else, the fallback is these hand-maintained rows.
//
// Shape mirrors CapabilityDescriptor (camelCase), plus a display title and
// grouping so the picker can show "OpenAI", "Anthropic", etc.

import type { CapabilityDescriptor } from '../core/types'

export interface BundledModelEntry {
  id: string
  name: string
  description?: string
  family?: string
  created?: number
  capability: CapabilityDescriptor
}

export type CapabilityTable = Record<string, BundledModelEntry>
