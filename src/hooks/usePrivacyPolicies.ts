// Live privacy-policy query + stale-while-revalidate refresh, mirrored off
// `useEndpoints`. See `plan/09-privacy.md §9.4` and `plan/07-discovery.md §7.5`.
//
// OpenRouter-only. For non-OpenRouter connections the hook returns an
// empty policy map; the UI consumes that as "privacy routing does not apply."
// Cache TTL is 24h (privacy data changes rarely); fetch rolls through a
// shared in-flight Map so sibling mounts hit the network once.

import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchPrivacyScrape, readCachedPrivacyPayload } from '../api/privacy-scrape'
import { isFreeModel } from '../core/model-predicates'
import type { DataPolicy, ProfileId } from '../core/types'
import { isFresh } from '../store/models-cache'
import {
  dedupedPrivacyFetch,
  EMPTY_PRIVACY_POLICY_RETRY_MS,
  getCachedPrivacyPolicy,
  PRIVACY_POLICY_TTL_MS,
} from '../store/privacy-cache'
import { getProfile } from '../store/profiles'

export interface UsePrivacyPoliciesResult {
  policies: Record<string, DataPolicy>
  loading: boolean
  fetchedAt: number | null
  offline: boolean
  error: string | null
  refresh: () => void
  // True when the connection doesn't support the scrape (not OpenRouter,
  // or scrape explicitly disabled). UI skips privacy-routing controls.
  scrapeApplicable: boolean
  // True when the selected model is a `*:free` variant. Privacy controls
  // are irrelevant per the free-model exception; UI disables them with
  // explanatory copy.
  isFreeModel: boolean
}

export function usePrivacyPolicies(
  profileId: ProfileId | null,
  modelId: string | null,
): UsePrivacyPoliciesResult {
  const cachedRow = useLiveQuery(
    () =>
      profileId && modelId ? getCachedPrivacyPolicy(profileId, modelId) : Promise.resolve(undefined),
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
  const handledRefreshTokenRef = useRef(0)

  const freeModel = modelId ? isFreeModel(modelId) : false
  const scrapeApplicable =
    !!profile && profile.kind === 'openrouter' && profile.supportsPrivacyScrape && !freeModel

  useEffect(() => {
    if (!scrapeApplicable) return
    if (!profile || !modelId) return
    const fetchedAt = cachedRow?.fetchedAt
    const cachedPayload = cachedRow ? readCachedPrivacyPayload(cachedRow.payload) : null
    const hasPolicies = cachedPayload ? Object.keys(cachedPayload.policies).length > 0 : false
    const forceRefresh = refreshToken !== handledRefreshTokenRef.current
    const fullFresh = fetchedAt !== undefined && hasPolicies && isFresh(fetchedAt, PRIVACY_POLICY_TTL_MS)
    const emptyFresh =
      fetchedAt !== undefined && !hasPolicies && isFresh(fetchedAt, EMPTY_PRIVACY_POLICY_RETRY_MS)
    if (!forceRefresh && fullFresh) return
    if (!forceRefresh && emptyFresh) {
      const delay = Math.max(0, EMPTY_PRIVACY_POLICY_RETRY_MS - (Date.now() - fetchedAt))
      const timer = window.setTimeout(() => setRefreshToken((n) => n + 1), delay)
      return () => window.clearTimeout(timer)
    }
    let cancelled = false
    if (forceRefresh) handledRefreshTokenRef.current = refreshToken
    setInFlight(true)
    setError(null)
    ;(async () => {
      try {
        await dedupedPrivacyFetch(profile.id, modelId, async () => {
          // The scrape URL is public — no Authorization header needed.
          // A user-configured `privacyScrapeProxy` lives on the profile
          // so it rides with `fetchPrivacyScrape` automatically.
          const result = await fetchPrivacyScrape({ profile }, modelId)
          if (Object.keys(result.raw.policies).length === 0 && hasPolicies && cachedRow) {
            return cachedRow.payload
          }
          return result.raw
        })
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'privacy scrape failed')
      } finally {
        if (!cancelled) setInFlight(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [scrapeApplicable, profile, modelId, cachedRow, refreshToken])

  const policies = useMemo<Record<string, DataPolicy>>(() => {
    if (!cachedRow) return {}
    const payload = readCachedPrivacyPayload(cachedRow.payload)
    return payload?.policies ?? {}
  }, [cachedRow])

  const fetchedAt = cachedRow?.fetchedAt ?? null
  const offline = error !== null
  const hasPolicies = Object.keys(policies).length > 0
  const loading = scrapeApplicable && inFlight && !hasPolicies

  return {
    policies,
    loading,
    fetchedAt,
    offline,
    error,
    refresh: () => setRefreshToken((n) => n + 1),
    scrapeApplicable,
    isFreeModel: freeModel,
  }
}
