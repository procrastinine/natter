// Live `/models` query with Dexie-backed cache. See `plan/07-discovery.md
// §7.4` and `§7.9`.
//
// Behavior:
// - Reads the cached row via `useLiveQuery`; immediately returns what's on
//   disk so the UI never blocks on a network round-trip.
// - On mount (or whenever the cache key changes), triggers a refresh if
//   the row is stale (TTL 1h) or missing — stale-while-revalidate.
// - A failed refresh does NOT clear the cache; the UI keeps the last-known
//   rows with an `offline` flag. Next read re-tries.
// - For non-OpenRouter connections, the fetcher hits `{baseUrl}/models`
//   (OpenAI-compatible) and merges results with the bundled capability
//   table — bundled entries fill in capability fields the upstream list
//   doesn't expose.

import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { fetchModels, type ModelsQueryString } from '../api/models'
import { type ModelListEntry, normalizeModelsResponse } from '../api/providers'
import { listBundledEntries } from '../capabilities'
import { canonicalCompatModelId, compatModelIdsMatch, structuralModelSlug } from '../core/model-ids'
import type { ConnectionProfile, ModelsQuery, ProfileId } from '../core/types'
import { resolveKeyIfPresent } from '../store/keys'
import {
  clearCachedModels,
  dedupedModelsFetch,
  getCachedModels,
  isFresh,
  MODELS_TTL_MS,
} from '../store/models-cache'
import { getProfile } from '../store/profiles'

interface UseModelsOptions {
  query?: ModelsQuery
  enabled?: boolean
}

interface UseModelsResult {
  models: ModelListEntry[]
  loading: boolean
  fetchedAt: number | null
  offline: boolean
  error: string | null
  refresh: () => void
}

function toQueryString(query: ModelsQuery): ModelsQueryString {
  const q: ModelsQueryString = {}
  if (query.outputModalities?.length) {
    q.output_modalities = query.outputModalities.join(',')
  }
  if (query.supportedParameters?.length) {
    q.supported_parameters = query.supportedParameters.join(',')
  }
  return q
}

export function useModels(
  profileId: ProfileId | null,
  opts: UseModelsOptions = {},
): UseModelsResult {
  const enabled = opts.enabled !== false && !!profileId
  // Stabilize query identity via JSON — callers almost always pass an inline
  // object literal, which would otherwise re-trigger the effect every render
  // and loop the network (ERR_INSUFFICIENT_RESOURCES on failure paths).
  const queryKey = JSON.stringify(opts.query ?? {})
  const query = useMemo<ModelsQuery>(() => JSON.parse(queryKey) as ModelsQuery, [queryKey])
  const cachedRow = useLiveQuery(
    () => (profileId ? getCachedModels(profileId, query) : Promise.resolve(undefined)),
    [profileId, queryKey],
    undefined,
  )
  const [error, setError] = useState<string | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)

  const profile = useLiveQuery(
    () => (profileId ? getProfile(profileId) : Promise.resolve(undefined)),
    [profileId],
    undefined,
  )

  useEffect(() => {
    if (!enabled) return
    if (!profile) return
    const fetchedAt = cachedRow?.fetchedAt
    const fresh = fetchedAt !== undefined && isFresh(fetchedAt, MODELS_TTL_MS)
    if (fresh && refreshToken === 0) return
    let cancelled = false
    setInFlight(true)
    setError(null)
    void (async () => {
      try {
        // dedupedModelsFetch shares the Promise across sibling mounts so
        // two components refreshing the same key at once hit the network
        // once. `cancelled` still short-circuits local state writes if
        // the owning component unmounted.
        await dedupedModelsFetch(profile.id, query, () => loadModelsPayload(profile, query))
      } catch (err) {
        if (cancelled) {
          return
        }
        if (profile.kind === 'llama-server') {
          await clearCachedModels(profile.id, query)
          if (cancelled) {
            return
          }
        }
        setError(err instanceof Error ? err.message : 'refresh failed')
      } finally {
        if (!cancelled) {
          setInFlight(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, profile, query, cachedRow?.fetchedAt, refreshToken])

  const models = useMemo(() => {
    if (!profile) return []
    const live = cachedRow ? normalizeModelsResponse(cachedRow.payload) : []
    return mergeBundledModels(profile, live)
  }, [profile, cachedRow])

  const fetchedAt = cachedRow?.fetchedAt ?? null
  const offline = error !== null && fetchedAt !== null
  const loading = inFlight && !cachedRow

  return {
    models,
    loading,
    fetchedAt,
    offline,
    error,
    refresh: () => setRefreshToken((n) => n + 1),
  }
}

async function loadModelsPayload(profile: ConnectionProfile, query: ModelsQuery): Promise<unknown> {
  const apiKey = (await resolveKeyIfPresent(profile.apiKeyRef)) ?? ''
  return fetchModels({ profile, apiKey }, toQueryString(query))
}

// For non-OpenRouter connections, `/models` returns just `{id, object,
// created, owned_by}`. Merge with the bundled table so entries show a
// display name, pricing, modalities, etc. For OpenRouter, `/models` already
// carries capability data — the merge is a no-op for ids that appear in
// the live response.
function mergeBundledModels(profile: ConnectionProfile, live: ModelListEntry[]): ModelListEntry[] {
  if (profile.kind === 'openrouter') return live
  const bundled = listBundledEntries(profile.kind)
  if (bundled.length === 0) return live
  const liveById = new Map(live.map((m) => [m.id, m]))
  const liveBySuffix = new Map<string, ModelListEntry>()
  const liveByCompat = new Map<string, ModelListEntry>()
  for (const row of live) {
    const suffix = structuralModelSlug(row.id)
    if (suffix !== row.id) liveBySuffix.set(suffix, row)
    liveByCompat.set(canonicalCompatModelId(row.id), row)
  }
  const out: ModelListEntry[] = []
  const seen = new Set<string>()
  for (const entry of bundled) {
    const hit =
      liveById.get(entry.id) ??
      liveBySuffix.get(entry.id) ??
      liveByCompat.get(canonicalCompatModelId(entry.id)) ??
      live.find((row) => compatModelIdsMatch(row.id, entry.id)) ??
      null
    const merged: ModelListEntry = hit
      ? {
          ...hit,
          name: hit.name ?? entry.name,
          ...(entry.description ? { description: entry.description } : {}),
          ...(entry.capability.contextLength !== undefined
            ? { contextLength: hit.contextLength ?? entry.capability.contextLength }
            : {}),
          ...(entry.capability.pricing ? { pricing: hit.pricing ?? entry.capability.pricing } : {}),
          ...(entry.capability.architecture
            ? {
                architecture: hit.architecture ?? {
                  ...(entry.capability.architecture.inputModalities
                    ? { inputModalities: [...entry.capability.architecture.inputModalities] }
                    : {}),
                  ...(entry.capability.architecture.outputModalities
                    ? {
                        outputModalities: [...entry.capability.architecture.outputModalities],
                      }
                    : {}),
                },
              }
            : {}),
          supportedParameters: hit.supportedParameters ?? [...entry.capability.supportedParameters],
        }
      : {
          id: entry.id,
          name: entry.name,
          ...(entry.description ? { description: entry.description } : {}),
          ...(entry.capability.contextLength !== undefined
            ? { contextLength: entry.capability.contextLength }
            : {}),
          ...(entry.capability.pricing ? { pricing: entry.capability.pricing } : {}),
          ...(entry.capability.architecture
            ? {
                architecture: {
                  ...(entry.capability.architecture.inputModalities
                    ? { inputModalities: [...entry.capability.architecture.inputModalities] }
                    : {}),
                  ...(entry.capability.architecture.outputModalities
                    ? {
                        outputModalities: [...entry.capability.architecture.outputModalities],
                      }
                    : {}),
                },
              }
            : {}),
          supportedParameters: [...entry.capability.supportedParameters],
        }
    if (seen.has(merged.id)) continue
    out.push(merged)
    seen.add(merged.id)
  }
  for (const row of live) {
    if (!seen.has(row.id)) out.push(row)
  }
  return out
}
