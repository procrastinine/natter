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
import { type EndpointsDescriptor, normalizeEndpointsResponse } from '../api/providers'
import { resolveBundledCapability } from '../capabilities'
import type { EffectiveCapability } from '../core/capabilities'
import {
  effectiveCapabilityFromDescriptor,
  effectiveCapabilityFromEndpoints,
} from '../core/capabilities'
import type { ModelEndpoint, ProfileId } from '../core/types'
import { resolveKey } from '../store/keys'
import {
  dedupedEndpointsFetch,
  ENDPOINTS_TTL_MS,
  getCachedEndpoints,
  isFresh,
} from '../store/models-cache'
import { getProfile } from '../store/profiles'

export interface UseEndpointsResult {
  descriptor: EndpointsDescriptor | null
  endpoints: ModelEndpoint[]
  capability: EffectiveCapability | null
  loading: boolean
  fetchedAt: number | null
  offline: boolean
  error: string | null
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
  const enabled = !!profile && !!modelId && profile.supportsEndpointsApi

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

  const strict = opts.strict === true
  const capability = useMemo<EffectiveCapability | null>(() => {
    if (!profile || !modelId) return null
    if (profile.supportsEndpointsApi && endpoints.length > 0) {
      return effectiveCapabilityFromEndpoints(modelId, endpoints, { strict })
    }
    if (!profile.supportsEndpointsApi) {
      const descriptor = resolveBundledCapability(profile, modelId)
      return effectiveCapabilityFromDescriptor(modelId, descriptor)
    }
    return null
  }, [profile, modelId, endpoints, strict])

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
    refresh: () => setRefreshToken((n) => n + 1),
  }
}
