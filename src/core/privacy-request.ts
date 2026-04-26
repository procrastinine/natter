// Request-time privacy resolver. Ensures `/endpoints` + scraped privacy
// policies are available for the active (profile, model), runs the filter,
// and returns the wire `provider` fragment that `toChatCompletions`
// merges with `settings.providerPrefs`.
//
// Unlike `usePrivacyRouting`, this is a plain async function suitable for
// the send path -- no React dependency. It does not silently send through a
// cold cache: OpenRouter sends either wait for live discovery, use an
// already-cached fallback when refresh fails, or throw before the request is
// fired if no provider list is available.
//
// OpenRouter-only by construction. Non-OpenRouter profiles get an early
// null (the transform already gates on `gate('provider')`). Free models
// also get a null so the free-model-strip logic in the transform does
// not need to also be aware of the filter.

import { fetchEndpoints } from '../api/models'
import { normalizeEndpointsResponse, type EndpointsDescriptor } from '../api/providers'
import { fetchPrivacyScrape, readCachedPrivacyPayload } from '../api/privacy-scrape'
import { isFreeModel } from './model-predicates'
import { providerRoutingRef } from './provider-identity'
import { migrateLegacyProviderSettings } from './provider-settings-migration'
import {
  buildWireProviderPrivacy,
  filterEndpointsByPrivacy,
  type PrivacyFilterResult,
  type WireProviderPrivacy,
} from './privacy-filter'
import type { Chat, ConnectionProfile, DataPolicy } from './types'
import { resolveKeyIfPresent } from '../store/keys'
import {
  dedupedEndpointsFetch,
  ENDPOINTS_TTL_MS,
  getCachedEndpoints,
  isFresh,
} from '../store/models-cache'
import {
  dedupedPrivacyFetch,
  getCachedPrivacyPolicy,
  PRIVACY_POLICY_TTL_MS,
} from '../store/privacy-cache'

const SEND_DISCOVERY_TIMEOUT_MS = 15_000

export class PrivacyDiscoveryUnavailableError extends Error {
  override readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'PrivacyDiscoveryUnavailableError'
    if (cause !== undefined) this.cause = cause
  }
}

export interface ResolvePrivacyForSendInput {
  chat: Chat
  profile: ConnectionProfile
  // Tokens we'd actually send to this model right now (visible text +
  // media + reasoning echo + reserved completion). Provider endpoints
  // whose context can't hold this number are added to `wire.ignore` as
  // a transient filter — the user's persisted `providerPrefs.ignore`
  // list is unchanged. Omit to skip the check entirely.
  neededTokens?: number
  signal?: AbortSignal
}

export interface ResolvePrivacyForSendResult {
  wire: WireProviderPrivacy | null
  filter: PrivacyFilterResult | null
  descriptor: EndpointsDescriptor | null
  applicable: boolean
  contextIgnoredProviders: string[]
}

export async function resolvePrivacyForSend(
  input: ResolvePrivacyForSendInput,
): Promise<ResolvePrivacyForSendResult> {
  const { chat, profile } = input
  if (profile.kind !== 'openrouter') {
    return {
      wire: null,
      filter: null,
      descriptor: null,
      applicable: false,
      contextIgnoredProviders: [],
    }
  }
  if (!chat.settings.model) {
    return {
      wire: null,
      filter: null,
      descriptor: null,
      applicable: false,
      contextIgnoredProviders: [],
    }
  }
  if (isFreeModel(chat.settings.model)) {
    return {
      wire: null,
      filter: null,
      descriptor: null,
      applicable: false,
      contextIgnoredProviders: [],
    }
  }
  const endpointsRow = await ensureEndpointsRow(profile, chat.settings.model, input.signal)
  const descriptor = normalizeEndpointsResponse(endpointsRow.payload)
  const endpoints = descriptor?.endpoints ?? []
  const policyResult = await ensurePrivacyPolicies({
    profile,
    modelId: chat.settings.model,
    endpoints,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const migrated = migrateLegacyProviderSettings(chat.settings, {
    model: chat.settings.model,
    endpoints,
    policies: policyResult.policies,
  })
  const settings = migrated.settings
  const filter = filterEndpointsByPrivacy({
    model: settings.model,
    endpoints,
    policies: policyResult.policies,
    privacy: settings.privacy,
    ...(policyResult.offlineFallback ? { missingPolicyMode: 'offline-worst-case' } : {}),
  })
  const prefs = settings.providerPrefs
  const wireOpts: {
    existingIgnore?: readonly string[]
    existingOnly?: readonly string[]
    existingOrder?: readonly string[]
    userTouchedPicker?: boolean
  } = {
    userTouchedPicker: prefs?.ignoreOverridesFilter === true,
  }
  if (prefs?.ignore) wireOpts.existingIgnore = prefs.ignore
  if (prefs?.only) wireOpts.existingOnly = prefs.only
  if (prefs?.order) wireOpts.existingOrder = prefs.order
  const wire = buildWireProviderPrivacy(filter, settings.privacy, wireOpts)
  if (typeof input.neededTokens === 'number' && input.neededTokens > 0) {
    const insufficient: string[] = []
    for (const ep of endpoints) {
      const cap = ep.max_prompt_tokens ?? ep.context_length
      if (typeof cap === 'number' && cap > 0 && input.neededTokens > cap) {
        insufficient.push(providerRoutingRef(ep))
      }
    }
    if (insufficient.length > 0) {
      // Merge into the existing wire.ignore — keep user prefs / privacy
      // filter exclusions intact. The UI still shows the provider as
      // "checked" because the settings row is unchanged; the grey badge
      // + this transient ignore are what keep the send honest.
      const base: { ignore?: string[] } = (wire ?? { ignore: [] }) as { ignore?: string[] }
      const next = new Set<string>(base.ignore ?? [])
      for (const name of insufficient) next.add(name)
      const merged: WireProviderPrivacy = { ...(wire ?? {}), ignore: [...next] }
      return {
        wire: merged,
        filter,
        descriptor,
        applicable: true,
        contextIgnoredProviders: insufficient,
      }
    }
  }
  return { wire, filter, descriptor, applicable: true, contextIgnoredProviders: [] }
}

async function ensureEndpointsRow(
  profile: ConnectionProfile,
  modelId: string,
  signal?: AbortSignal,
) {
  const cached = await getCachedEndpoints(profile.id, modelId)
  if (cached && isFresh(cached.fetchedAt, ENDPOINTS_TTL_MS)) return cached
  try {
    await dedupedEndpointsFetch(profile.id, modelId, async () => {
      const apiKey = (await resolveKeyIfPresent(profile.apiKeyRef)) ?? ''
      return fetchEndpoints({ profile, apiKey }, modelId, {
        ...(signal ? { signal } : {}),
        timeoutMs: SEND_DISCOVERY_TIMEOUT_MS,
      })
    })
  } catch (err) {
    if (cached) return cached
    throw new PrivacyDiscoveryUnavailableError(
      'OpenRouter provider discovery failed before privacy routing could run.',
      err,
    )
  }
  const refreshed = await getCachedEndpoints(profile.id, modelId)
  if (refreshed) return refreshed
  if (cached) return cached
  throw new PrivacyDiscoveryUnavailableError(
    'OpenRouter provider discovery did not populate an endpoints cache row.',
  )
}

async function ensurePrivacyPolicies(input: {
  profile: ConnectionProfile
  modelId: string
  endpoints: readonly { data_policy?: DataPolicy }[]
  signal?: AbortSignal
}): Promise<{ policies: Record<string, DataPolicy>; offlineFallback: boolean }> {
  const { profile, modelId, endpoints, signal } = input
  const needsScrape =
    profile.supportsPrivacyScrape !== false && endpoints.some((endpoint) => !endpoint.data_policy)
  const cached = await getCachedPrivacyPolicy(profile.id, modelId)
  const cachedPayload = cached ? readCachedPrivacyPayload(cached.payload) : null
  const cachedPolicies = cachedPayload?.policies ?? {}
  const hasCachedPolicies = Object.keys(cachedPolicies).length > 0
  if (!needsScrape) return { policies: cachedPolicies, offlineFallback: false }

  if (cached && hasCachedPolicies && isFresh(cached.fetchedAt, PRIVACY_POLICY_TTL_MS)) {
    return { policies: cachedPolicies, offlineFallback: false }
  }

  try {
    await dedupedPrivacyFetch(profile.id, modelId, async () => {
      const result = await fetchPrivacyScrape(
        { profile },
        modelId,
        {
          ...(signal ? { signal } : {}),
          timeoutMs: SEND_DISCOVERY_TIMEOUT_MS,
        },
      )
      if (Object.keys(result.raw.policies).length === 0 && hasCachedPolicies && cached) {
        return cached.payload
      }
      return result.raw
    })
  } catch {
    if (hasCachedPolicies) return { policies: cachedPolicies, offlineFallback: false }
    return { policies: cachedPolicies, offlineFallback: true }
  }

  const refreshed = await getCachedPrivacyPolicy(profile.id, modelId)
  const refreshedPayload = refreshed ? readCachedPrivacyPayload(refreshed.payload) : null
  return { policies: refreshedPayload?.policies ?? {}, offlineFallback: false }
}
