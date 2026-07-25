import type { ConnectionKind, ModelsQuery } from './types'

const OPENROUTER_CATALOG_QUERY: ModelsQuery = Object.freeze({
  outputModalities: Object.freeze(['text', 'image', 'audio', 'file', 'video']),
})
const DIRECT_CATALOG_QUERY: ModelsQuery = Object.freeze({})

export function modelCatalogQueryForConnectionKind(kind: ConnectionKind): ModelsQuery {
  return kind === 'openrouter' ? OPENROUTER_CATALOG_QUERY : DIRECT_CATALOG_QUERY
}

// Stable key for the `/models` cache. Two queries with different
// `supported_parameters` must produce different keys. Order-insensitive on both
// arrays; empty/undefined arrays collapse to `[]` so `{}` and
// `{ outputModalities: [] }` share a key.
export function modelsCacheKey(query: ModelsQuery): string {
  const normalized = {
    outputModalities: normalizeList(query.outputModalities),
    supportedParameters: normalizeList(query.supportedParameters),
  }
  return stableStringify(normalized)
}

function normalizeList(input: readonly string[] | undefined): string[] {
  if (!input || input.length === 0) return []
  const unique = Array.from(new Set(input.map((s) => s.trim()).filter(Boolean)))
  unique.sort()
  return unique
}

// Object-key-sorted JSON so `{a:1,b:2}` and `{b:2,a:1}` produce the same string.
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key: string, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const record = v as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(record).sort()) {
        sorted[k] = record[k]
      }
      return sorted
    }
    return v
  })
}
