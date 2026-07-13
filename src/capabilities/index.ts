// `resolveBundledCapability` returns:
// 1. the table row for this connection kind + model id, if present
// 2. otherwise the permissive custom default — this covers "unknown model on
//    a known connection" and every custom-kind connection, per the user's
//    "enable all settings in case they work" guidance.
//
// ConnectionProfile.capabilityOverrides wins on top of the resolved row.

import { canonicalModelSlug, compatModelIdsMatch, structuralModelSlug } from '../core/model-ids'
import type { CapabilityDescriptor, ConnectionKind, ConnectionProfile } from '../core/types'
import { ANTHROPIC_CAPABILITIES } from './anthropic'
import { DEFAULT_CUSTOM_CAPABILITY } from './custom'
import { GOOGLE_CAPABILITIES } from './google'
import { DEFAULT_LLAMA_SERVER_CAPABILITY } from './llama-server'
import { OPENAI_CAPABILITIES } from './openai'
import type { BundledModelEntry, CapabilityTable } from './types'

function tableFor(kind: ConnectionKind): CapabilityTable | null {
  switch (kind) {
    case 'openai-compatible':
      return OPENAI_CAPABILITIES
    case 'anthropic':
      return ANTHROPIC_CAPABILITIES
    case 'google':
      return GOOGLE_CAPABILITIES
    case 'openrouter':
    case 'llama-server':
    case 'custom':
      return null
  }
}

// Baseline descriptor for a profile when no bundled row matches. For
// `llama-server` this is the llama.cpp superset (mirostat, dry_*, xtc_*,
// etc.); for `custom` it's the permissive OAI-ish set; every other kind
// falls through to the bundled tables above.
function defaultCapabilityFor(kind: ConnectionKind): CapabilityDescriptor {
  return kind === 'llama-server' ? DEFAULT_LLAMA_SERVER_CAPABILITY : DEFAULT_CUSTOM_CAPABILITY
}

function lookupBundledEntry(kind: ConnectionKind, modelId: string): BundledModelEntry | undefined {
  const table = tableFor(kind)
  if (!table) return undefined
  const direct =
    table[modelId] ?? table[structuralModelSlug(modelId)] ?? table[canonicalModelSlug(modelId)]
  if (direct) return direct
  return Object.values(table).find((entry) => compatModelIdsMatch(entry.id, modelId))
}

export function listBundledEntries(kind: ConnectionKind): BundledModelEntry[] {
  const table = tableFor(kind)
  if (!table) return []
  return Object.values(table)
}

// Deep-ish merge: scalar/array fields on `override` win; nested `pricing`
// and `architecture` objects are shallow-merged.
function mergeCapability(
  base: CapabilityDescriptor,
  override: Partial<CapabilityDescriptor> | undefined,
): CapabilityDescriptor {
  if (!override) return base
  const out: CapabilityDescriptor = { ...base, ...override }
  if (override.pricing || base.pricing) {
    out.pricing = { ...base.pricing, ...override.pricing }
  }
  if (override.architecture || base.architecture) {
    out.architecture = { ...base.architecture, ...override.architecture }
  }
  return out
}

// The effective capability row a connection can use for a model, ignoring
// live /endpoints data. Used by the non-OpenRouter hook and as a fallback
// when the OpenRouter cache is cold.
export function resolveBundledCapability(
  profile: ConnectionProfile,
  modelId: string,
): CapabilityDescriptor {
  const entry = lookupBundledEntry(profile.kind, modelId)
  const base = entry?.capability ?? defaultCapabilityFor(profile.kind)
  const override = profile.capabilityOverrides?.[modelId]
  return mergeCapability(base, override)
}
