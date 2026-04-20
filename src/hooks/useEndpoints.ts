// Live `/endpoints` query for a single model on an OpenRouter connection.
// See `plan/07-discovery.md §7.2–§7.3`.
//
// For non-OpenRouter connections (openai-compatible, anthropic, google,
// custom), /endpoints doesn't exist. The caller should use
// `resolveBundledCapability` from `src/capabilities` instead — this hook
// returns a synthetic single-endpoint descriptor in that case so callers
// can share a code path.

import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { fetchEndpoints } from '../api/models'
import {
  type EndpointsDescriptor,
  type ModelListEntry,
  normalizeEndpointsResponse,
  normalizeModelsResponse,
} from '../api/providers'
import { resolveBundledCapability } from '../capabilities'
import type { EffectiveCapability } from '../core/capabilities'
import {
  effectiveCapabilityFromDescriptor,
  effectiveCapabilityFromEndpoints,
} from '../core/capabilities'
import type { CapabilityDescriptor, ModelEndpoint, ProfileId } from '../core/types'
import { resolveKey } from '../store/keys'
import {
  dedupedEndpointsFetch,
  ENDPOINTS_TTL_MS,
  getCachedEndpoints,
  getCachedModels,
  isFresh,
} from '../store/models-cache'
import { getProfile } from '../store/profiles'

// `useModels` in ModelPicker uses this exact query; useEndpoints looks up
// the already-cached row keyed off the same signature so we don't double-
// fetch just to read a context length for non-OpenRouter connections.
const OPENROUTER_CAPABILITY_LOOKUP_QUERY = {
  outputModalities: ['text', 'image', 'audio', 'file', 'video'],
} as const

const DIRECT_CAPABILITY_LOOKUP_QUERY = {} as const

function idsEquivalent(left: string, right: string): boolean {
  return (
    left.replace(/(\d)[.-](\d)(?=-|$)/g, '$1:$2') ===
    right.replace(/(\d)[.-](\d)(?=-|$)/g, '$1:$2')
  )
}

export interface UseEndpointsResult {
  descriptor: EndpointsDescriptor | null
  endpoints: ModelEndpoint[]
  capability: EffectiveCapability | null
  loading: boolean
  fetchedAt: number | null
  offline: boolean
  error: string | null
  // `null` = we don't know yet (models list cold).
  // `true`  = this modelId appears in the profile's /models list.
  // `false` = /models is cached and this modelId is not in it — that's why
  //           the Context tab has no capability, not a stale fetch.
  modelAvailable: boolean | null
  refresh: () => void
}

export interface UseEndpointsOptions {
  strict?: boolean
}

export function useEndpoints(
  profileId: ProfileId | null,
  modelId: string | null,
  opts: UseEndpointsOptions = {},
): UseEndpointsResult {
  const cachedRow = useLiveQuery(
    () =>
      profileId && modelId ? getCachedEndpoints(profileId, modelId) : Promise.resolve(undefined),
    [profileId, modelId],
    undefined,
  )
  const profile = useLiveQuery(
    () => (profileId ? getProfile(profileId) : Promise.resolve(undefined)),
    [profileId],
    undefined,
  )
  const [error, setError] = useState<string | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  // `supportsEndpointsApi` is a stored flag; require kind==='openrouter'
  // too so a profile that was once OpenRouter and is now pointed at a
  // local llama.cpp doesn't keep hitting /models/<id>/endpoints with the
  // stale flag still set to true.
  const enabled =
    !!profile && !!modelId && profile.kind === 'openrouter' && profile.supportsEndpointsApi

  useEffect(() => {
    if (!enabled) return
    if (!profile || !modelId) return
    const fetchedAt = cachedRow?.fetchedAt
    const fresh = fetchedAt !== undefined && isFresh(fetchedAt, ENDPOINTS_TTL_MS)
    if (fresh && refreshToken === 0) return
    let cancelled = false
    setInFlight(true)
    setError(null)
    ;(async () => {
      try {
        // dedupedEndpointsFetch shares the Promise across sibling mounts
        // so two components refreshing the same (profileId, modelId)
        // at once hit the network once. `cancelled` still short-circuits
        // local state writes if the owning component unmounted first.
        await dedupedEndpointsFetch(profile.id, modelId, async () => {
          const apiKey = await resolveKey(profile.apiKeyRef)
          return fetchEndpoints({ profile, apiKey }, modelId)
        })
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'refresh failed')
      } finally {
        if (!cancelled) setInFlight(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, profile, modelId, cachedRow?.fetchedAt, refreshToken])

  const descriptor = useMemo(() => {
    if (!cachedRow) return null
    return normalizeEndpointsResponse(cachedRow.payload)
  }, [cachedRow])

  const endpoints = useMemo<ModelEndpoint[]>(() => {
    return descriptor?.endpoints ?? []
  }, [descriptor])

  // The cached /models response drives two things: (a) a contextLength
  // overlay on top of the bundled capability for non-OpenRouter kinds
  // (llama.cpp advertises `meta.n_ctx_train` there), and (b) a
  // model-availability signal for the panel. For OR we read it too so
  // the panel can distinguish "waiting for /endpoints" from "this model
  // simply isn't served on this connection" (e.g., a chat started on
  // llama-server with gemma, now pointed at OR — OR returns 404 and we
  // want an actionable banner, not a permanently-spinning Context tab).
  const liveModelsRow = useLiveQuery(
    () =>
      profileId
        ? getCachedModels(
            profileId,
            profile?.kind === 'openrouter'
              ? OPENROUTER_CAPABILITY_LOOKUP_QUERY
              : DIRECT_CAPABILITY_LOOKUP_QUERY,
          )
        : Promise.resolve(undefined),
    [profileId, profile?.kind],
    undefined,
  )
  const liveEntry = useMemo<ModelListEntry | null>(() => {
    if (!liveModelsRow || !modelId) return null
    const rows = normalizeModelsResponse(liveModelsRow.payload)
    return rows.find((r) => idsEquivalent(r.id, modelId)) ?? null
  }, [liveModelsRow, modelId])
  const modelAvailable = useMemo<boolean | null>(() => {
    if (!profileId || !modelId) return null
    if (!liveModelsRow) return null
    return liveEntry !== null
  }, [profileId, modelId, liveModelsRow, liveEntry])
  const strict = opts.strict === true
  const capability = useMemo<EffectiveCapability | null>(() => {
    if (!profile || !modelId) return null
    if (enabled && endpoints.length > 0) {
      return effectiveCapabilityFromEndpoints(modelId, endpoints, { strict })
    }
    if (!enabled) {
      if (profile.kind === 'llama-server' && modelAvailable === false) {
        return null
      }
      const bundled = resolveBundledCapability(profile, modelId)
      const merged: CapabilityDescriptor = { ...bundled }
      if (liveEntry?.contextLength !== undefined) {
        merged.contextLength = liveEntry.contextLength
        if (
          merged.maxCompletionTokens === undefined ||
          merged.maxCompletionTokens < liveEntry.contextLength
        ) {
          merged.maxCompletionTokens = Math.min(
            liveEntry.contextLength,
            Math.max(merged.maxCompletionTokens ?? 0, 4096),
          )
        }
      }
      return effectiveCapabilityFromDescriptor(modelId, merged)
    }
    return null
  }, [profile, modelId, endpoints, strict, enabled, liveEntry, modelAvailable])

  const fetchedAt = cachedRow?.fetchedAt ?? null
  const offline = error !== null && fetchedAt !== null
  const loading = enabled && inFlight && !cachedRow

  return {
    descriptor,
    endpoints,
    capability,
    loading,
    fetchedAt,
    offline,
    error,
    modelAvailable,
    refresh: () => setRefreshToken((n) => n + 1),
  }
}
