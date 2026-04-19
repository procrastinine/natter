// Compound hook: combines /endpoints + privacy scrape + chat privacy
// prefs into a memoized `PrivacyFilterResult`. The provider picker,
// header lock, and zero-eligible modal all read from this.
//
// Separated from `usePrivacyPolicies` so the policy layer can be tested
// in isolation from the filter wiring.

import { useCallback, useMemo } from 'react'
import type { EffectiveCapability } from '../core/capabilities'
import type { EndpointsDescriptor } from '../api/providers'
import type { Chat, ModelEndpoint } from '../core/types'
import {
  buildWireProviderPrivacy,
  filterEndpointsByPrivacy,
  type PrivacyFilterResult,
  type WireProviderPrivacy,
} from '../core/privacy-filter'
import { useEndpoints } from './useEndpoints'
import { usePrivacyPolicies } from './usePrivacyPolicies'

export interface UsePrivacyRoutingResult {
  filter: PrivacyFilterResult | null
  wire: WireProviderPrivacy | null
  endpoints: readonly ModelEndpoint[]
  descriptor: EndpointsDescriptor | null
  capability: EffectiveCapability | null
  loading: boolean
  offline: boolean
  error: string | null
  scrapeApplicable: boolean
  isFreeModel: boolean
  // Refreshes both `/endpoints` and the privacy scrape in one call so the
  // picker's reload button can freshen everything it depends on.
  refresh: () => void
}

export function usePrivacyRouting(chat: Chat): UsePrivacyRoutingResult {
  const modelId = chat.settings.model || null
  const ep = useEndpoints(chat.settings.profileId, modelId, {
    strict: chat.settings.strictProviderRouting === true,
  })
  const pol = usePrivacyPolicies(chat.settings.profileId, modelId)

  const filter = useMemo<PrivacyFilterResult | null>(() => {
    if (!pol.scrapeApplicable) return null
    if (!modelId) return null
    if (ep.endpoints.length === 0) return null
    return filterEndpointsByPrivacy({
      model: modelId,
      endpoints: ep.endpoints,
      policies: pol.policies,
      privacy: chat.settings.privacy,
    })
  }, [pol.scrapeApplicable, pol.policies, modelId, ep.endpoints, chat.settings.privacy])

  const wire = useMemo<WireProviderPrivacy | null>(() => {
    if (!filter) return null
    const prefs = chat.settings.providerPrefs
    const userTouched = prefs?.ignoreOverridesFilter === true
    const opts: { existingIgnore?: readonly string[]; userTouchedPicker?: boolean } = {
      userTouchedPicker: userTouched,
    }
    if (prefs?.ignore) opts.existingIgnore = prefs.ignore
    return buildWireProviderPrivacy(filter, chat.settings.privacy, opts)
  }, [
    filter,
    chat.settings.privacy,
    chat.settings.providerPrefs?.ignore,
    chat.settings.providerPrefs?.ignoreOverridesFilter,
  ])

  const refresh = useCallback(() => {
    ep.refresh()
    pol.refresh()
  }, [ep, pol])

  return {
    filter,
    wire,
    endpoints: ep.endpoints,
    descriptor: ep.descriptor,
    capability: ep.capability,
    loading: ep.loading || pol.loading,
    offline: ep.offline || pol.offline,
    error: ep.error ?? pol.error,
    scrapeApplicable: pol.scrapeApplicable,
    isFreeModel: pol.isFreeModel,
    refresh,
  }
}
