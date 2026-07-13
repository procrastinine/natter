// OpenRouter's /endpoints is authoritative; other providers fall back to these
// hand-maintained capability rows.
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
