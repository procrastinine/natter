// Live privacy-policy query + stale-while-revalidate refresh, mirrored off
// `useEndpoints`. See `plan/09-privacy.md §9.4` and `plan/07-discovery.md §7.5`.
//
// OpenRouter-only. For non-OpenRouter connections the hook returns an
// empty policy map; the UI consumes that as "privacy routing does not apply."
// Cache TTL is 24h (privacy data changes rarely); fetch rolls through a
// single-flight path so sibling mounts and cold-cache tab storms hit the
// network once per (profile, model).

import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchPrivacyScrape, readCachedPrivacyPayload } from '../api/privacy-scrape'
import { isCorsProxyDisabled } from '../core/cors-proxy'
import {
  corsProxyConfigFromPrefs,
  DEFAULT_GLOBAL_PREFERENCES,
  readGlobalPreferences,
} from '../core/global-settings'
import { isFreeModel } from '../core/model-predicates'
import type { DataPolicy, ProfileId } from '../core/types'
import type { CachedPrivacyPolicyRow } from '../store/db'
import { isFresh } from '../store/models-cache'
import {
  dedupedPrivacyFetch,
  EMPTY_PRIVACY_POLICY_RETRY_MS,
  getCachedPrivacyPolicy,
  PRIVACY_POLICY_TTL_MS,
} from '../store/privacy-cache'
import { getProfile } from '../store/profiles'

interface UsePrivacyPoliciesResult {
  policies: Record<string, DataPolicy>
  loading: boolean
  fetchedAt: number | null
  offline: boolean
  error: string | null
  refresh: () => void
  // True when this OpenRouter model can use provider privacy policy data.
  // Live fetching may still be disabled by the workspace proxy setting.
  scrapeApplicable: boolean
  // False in static builds until the user explicitly configures a proxy.
  // Cached and endpoint-embedded policy data can still be used.
  liveScrapeEnabled: boolean
  // True when the selected model is a `*:free` variant. Privacy controls
  // are irrelevant per the free-model exception; UI disables them with
  // explanatory copy.
  isFreeModel: boolean
}

function usableCachedPrivacyPolicy(row: CachedPrivacyPolicyRow | undefined): boolean {
  if (!row) return false
  const payload = readCachedPrivacyPayload(row.payload)
  const hasPolicies = payload ? Object.keys(payload.policies).length > 0 : false
  return isFresh(row.fetchedAt, hasPolicies ? PRIVACY_POLICY_TTL_MS : EMPTY_PRIVACY_POLICY_RETRY_MS)
}

export function usePrivacyPolicies(
  profileId: ProfileId | null,
  modelId: string | null,
): UsePrivacyPoliciesResult {
  const cachedRow = useLiveQuery(
    () =>
      profileId && modelId
        ? getCachedPrivacyPolicy(profileId, modelId)
        : Promise.resolve(undefined),
    [profileId, modelId],
    undefined,
  )
  const profile = useLiveQuery(
    () => (profileId ? getProfile(profileId) : Promise.resolve(undefined)),
    [profileId],
    undefined,
  )
  const globalPrefs = useLiveQuery(readGlobalPreferences, [], DEFAULT_GLOBAL_PREFERENCES)
  const [error, setError] = useState<string | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const [refreshToken, setRefreshToken] = useState(0)
  const [staleRefreshToken, setStaleRefreshToken] = useState(0)
  const handledRefreshTokenRef = useRef(0)

  const freeModel = modelId ? isFreeModel(modelId) : false
  const scrapeApplicable =
    !!profile && profile.kind === 'openrouter' && profile.supportsPrivacyScrape && !freeModel
  const proxy = useMemo(() => corsProxyConfigFromPrefs(globalPrefs), [globalPrefs])
  const liveScrapeEnabled = !isCorsProxyDisabled(proxy)

  useEffect(() => {
    void staleRefreshToken
    if (!scrapeApplicable || !liveScrapeEnabled) {
      setInFlight(false)
      setError(null)
      return
    }
    if (!profile || !modelId) return
    const fetchedAt = cachedRow?.fetchedAt
    const cachedPayload = cachedRow ? readCachedPrivacyPayload(cachedRow.payload) : null
    const hasPolicies = cachedPayload ? Object.keys(cachedPayload.policies).length > 0 : false
    const forceRefresh = refreshToken !== handledRefreshTokenRef.current
    const fullFresh = cachedRow !== undefined && hasPolicies && usableCachedPrivacyPolicy(cachedRow)
    const emptyFresh =
      fetchedAt !== undefined && !hasPolicies && isFresh(fetchedAt, EMPTY_PRIVACY_POLICY_RETRY_MS)
    if (!forceRefresh && fullFresh) {
      const delay = Math.max(0, PRIVACY_POLICY_TTL_MS - (Date.now() - cachedRow.fetchedAt))
      const timer = window.setTimeout(() => setStaleRefreshToken((n) => n + 1), delay)
      return () => window.clearTimeout(timer)
    }
    if (!forceRefresh && emptyFresh) {
      const delay = Math.max(0, EMPTY_PRIVACY_POLICY_RETRY_MS - (Date.now() - fetchedAt))
      const timer = window.setTimeout(() => setStaleRefreshToken((n) => n + 1), delay)
      return () => window.clearTimeout(timer)
    }
    let cancelled = false
    if (forceRefresh) handledRefreshTokenRef.current = refreshToken
    setInFlight(true)
    setError(null)
    void (async () => {
      try {
        await dedupedPrivacyFetch(
          profile.id,
          modelId,
          async () => {
            // The scrape URL is public — no Authorization header needed.
            // The CORS proxy + optional secret are workspace-global
            // (`corsProxyUrl` / `corsProxySecret`); they're resolved here
            // so `fetchPrivacyScrape` itself stays env-neutral.
            const result = await fetchPrivacyScrape({ proxy }, modelId)
            if (Object.keys(result.raw.policies).length === 0 && hasPolicies && cachedRow) {
              return cachedRow.payload
            }
            return result.raw
          },
          {
            force: forceRefresh,
            isCachedFresh: usableCachedPrivacyPolicy,
          },
        )
      } catch (err) {
        if (cancelled) {
          return
        }
        setError(err instanceof Error ? err.message : 'privacy scrape failed')
      } finally {
        if (!cancelled) {
          setInFlight(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    scrapeApplicable,
    liveScrapeEnabled,
    profile,
    modelId,
    cachedRow,
    refreshToken,
    staleRefreshToken,
    proxy,
  ])

  const policies = useMemo<Record<string, DataPolicy>>(() => {
    if (!cachedRow) return {}
    const payload = readCachedPrivacyPayload(cachedRow.payload)
    return payload?.policies ?? {}
  }, [cachedRow])

  const fetchedAt = cachedRow?.fetchedAt ?? null
  const offline = error !== null
  const hasPolicies = Object.keys(policies).length > 0
  const loading = scrapeApplicable && liveScrapeEnabled && inFlight && !hasPolicies

  return {
    policies,
    loading,
    fetchedAt,
    offline,
    error,
    refresh: () => setRefreshToken((n) => n + 1),
    scrapeApplicable,
    liveScrapeEnabled,
    isFreeModel: freeModel,
  }
}
