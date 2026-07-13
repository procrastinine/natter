// Live `/endpoints` query for a single model on an OpenRouter connection.
//
// For non-OpenRouter connections (openai-compatible, anthropic, google,
// custom), /endpoints doesn't exist. The caller should use
// `resolveBundledCapability` from `src/capabilities` instead — this hook
// returns a synthetic single-endpoint descriptor in that case so callers
// can share a code path.

import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchEndpoints } from '../api/models'
import {
  type EndpointsDescriptor,
  type ModelListEntry,
  normalizeEndpointsResponse,
  normalizeModelsResponse,
} from '../api/providers'
import { listBundledEntries, resolveBundledCapability } from '../capabilities'
import { modelsCacheKey } from '../core/cache-keys'
import type { EffectiveCapability } from '../core/capabilities'
import {
  effectiveCapabilityFromDescriptor,
  effectiveCapabilityFromEndpoints,
} from '../core/capabilities'
import { pickEquivalentModelId } from '../core/model-selection'
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
import { primaryKeys } from '../store/reactive-dependencies'
import { useRepositoryQuery } from '../store/reactive-query'

// `useModels` in ModelPicker uses this exact query; useEndpoints looks up
// the already-cached row keyed off the same signature so a double
// fetch is avoided just to read a context length for non-OpenRouter connections.
const OPENROUTER_CAPABILITY_LOOKUP_QUERY = {
  outputModalities: ['text', 'image', 'audio', 'file', 'video'],
} as const

const DIRECT_CAPABILITY_LOOKUP_QUERY = {} as const

interface UseEndpointsResult {
  descriptor: EndpointsDescriptor | null
  endpoints: ModelEndpoint[]
  capability: EffectiveCapability | null
  loading: boolean
  fetchedAt: number | null
  offline: boolean
  error: string | null
  // `null` = unknown yet (models list cold).
  // `true`  = this modelId appears in the profile's /models list.
  // `false` = /models is cached and this modelId is not in it — that's why
  //           the Context tab has no capability, not a stale fetch.
  modelAvailable: boolean | null
  refresh: () => void
}

interface UseEndpointsOptions {
  strict?: boolean
}

export function useEndpoints(
  profileId: ProfileId | null,
  modelId: string | null,
  opts: UseEndpointsOptions = {},
): UseEndpointsResult {
  const cachedRow = useRepositoryQuery(
    JSON.stringify(['endpoint-cache', profileId, modelId]),
    () =>
      profileId && modelId ? getCachedEndpoints(profileId, modelId) : Promise.resolve(undefined),
    undefined,
    primaryKeys('endpoints', profileId && modelId ? [profileId, modelId] : undefined),
  )
  const profile = useRepositoryQuery(
    JSON.stringify(['profile', profileId]),
    () => (profileId ? getProfile(profileId) : Promise.resolve(undefined)),
    undefined,
    primaryKeys('profiles', profileId),
  )
  const [error, setError] = useState<string | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const handledRefreshTokenRef = useRef(0)
  // `supportsEndpointsApi` is a stored flag; require kind==='openrouter'
  // too so a profile that was once OpenRouter and is now pointed at a
  // local llama.cpp doesn't keep hitting /models/<id>/endpoints with the
  // stale flag still set to true.
  const enabled =
    !!profile && !!modelId && profile.kind === 'openrouter' && profile.supportsEndpointsApi

  useEffect(() => {
    if (!enabled) return
    const fetchedAt = cachedRow?.fetchedAt
    const fresh = fetchedAt !== undefined && isFresh(fetchedAt, ENDPOINTS_TTL_MS)
    const forceRefresh = refreshToken !== handledRefreshTokenRef.current
    if (fresh && !forceRefresh) return
    const requestState = { cancelled: false }
    if (forceRefresh) handledRefreshTokenRef.current = refreshToken
    setInFlight(true)
    setError(null)
    void (async () => {
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
        if (requestState.cancelled) {
          return
        }
        setError(err instanceof Error ? err.message : 'refresh failed')
      } finally {
        if (!requestState.cancelled) {
          setInFlight(false)
        }
      }
    })()
    return () => {
      requestState.cancelled = true
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
  // model-availability signal for the panel. For OR it is read too so
  // the panel can distinguish "waiting for /endpoints" from "this model
  // simply isn't served on this connection" (e.g., a chat started on
  // llama-server with gemma, now pointed at OR; OR returns 404 and an
  // actionable banner is needed, not a permanently-spinning Context tab).
  const liveModelsRow = useRepositoryQuery(
    JSON.stringify(['model-cache-capability', profileId, profile?.kind]),
    () =>
      profileId
        ? getCachedModels(
            profileId,
            profile?.kind === 'openrouter'
              ? OPENROUTER_CAPABILITY_LOOKUP_QUERY
              : DIRECT_CAPABILITY_LOOKUP_QUERY,
          )
        : Promise.resolve(undefined),
    undefined,
    primaryKeys(
      'models',
      profileId
        ? [
            profileId,
            modelsCacheKey(
              profile?.kind === 'openrouter'
                ? OPENROUTER_CAPABILITY_LOOKUP_QUERY
                : DIRECT_CAPABILITY_LOOKUP_QUERY,
            ),
          ]
        : undefined,
    ),
  )
  const liveModelRows = useMemo<ModelListEntry[]>(() => {
    return liveModelsRow ? normalizeModelsResponse(liveModelsRow.payload) : []
  }, [liveModelsRow])
  const liveEntry = useMemo<ModelListEntry | null>(() => {
    if (!modelId) return null
    const rows = liveModelRows
    const equivalentModelId = pickEquivalentModelId(modelId, rows)
    return rows.find((r) => r.id === equivalentModelId) ?? null
  }, [liveModelRows, modelId])
  const modelAvailable = useMemo<boolean | null>(() => {
    if (!profile || !modelId) return null
    if (profile.kind !== 'openrouter') {
      const bundledRows = listBundledEntries(profile.kind).map<ModelListEntry>((entry) => ({
        id: entry.id,
        name: entry.name,
      }))
      if (pickEquivalentModelId(modelId, [...liveModelRows, ...bundledRows])) return true
    }
    if (!liveModelsRow) return null
    return liveEntry !== null
  }, [profile, modelId, liveModelsRow, liveModelRows, liveEntry])
  const strict = opts.strict === true
  const capability = useMemo<EffectiveCapability | null>(() => {
    if (!profile || !modelId) return null
    if (enabled && endpoints.length > 0) {
      return effectiveCapabilityFromEndpoints(modelId, endpoints, {
        strict,
        ...(descriptor?.architecture ? { architecture: descriptor.architecture } : {}),
      })
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
  }, [profile, modelId, endpoints, descriptor, strict, enabled, liveEntry, modelAvailable])

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
