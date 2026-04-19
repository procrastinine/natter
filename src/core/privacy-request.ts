// Request-time privacy resolver. Reads the cached `/endpoints` + scraped
// privacy policies for the active (profile, model), runs the filter,
// and returns the wire `provider` fragment that `toChatCompletions`
// merges with `settings.providerPrefs`.
//
// Unlike `usePrivacyRouting`, this is a plain async function suitable
// for the send path — no React dependency. If the caches are cold, it
// returns `null` and the caller falls back to sending without a
// privacy-derived provider block (we never block a send on scrape
// availability; the user might be on a fresh install or offline).
//
// OpenRouter-only by construction. Non-OpenRouter profiles get an early
// null (the transform already gates on `gate('provider')`). Free models
// also get a null so the free-model-strip logic in the transform does
// not need to also be aware of the filter.

import { normalizeEndpointsResponse } from '../api/providers'
import { readCachedPrivacyPayload } from '../api/privacy-scrape'
import { isFreeModel } from './model-predicates'
import {
  buildWireProviderPrivacy,
  filterEndpointsByPrivacy,
  type PrivacyFilterResult,
  type WireProviderPrivacy,
} from './privacy-filter'
import type { Chat, ConnectionProfile } from './types'
import { getCachedEndpoints } from '../store/models-cache'
import { getCachedPrivacyPolicy } from '../store/privacy-cache'

export interface ResolvePrivacyForSendInput {
  chat: Chat
  profile: ConnectionProfile
}

export interface ResolvePrivacyForSendResult {
  wire: WireProviderPrivacy | null
  filter: PrivacyFilterResult | null
  applicable: boolean
}

export async function resolvePrivacyForSend(
  input: ResolvePrivacyForSendInput,
): Promise<ResolvePrivacyForSendResult> {
  const { chat, profile } = input
  if (profile.kind !== 'openrouter') {
    return { wire: null, filter: null, applicable: false }
  }
  if (!chat.settings.model) return { wire: null, filter: null, applicable: false }
  if (isFreeModel(chat.settings.model)) {
    return { wire: null, filter: null, applicable: false }
  }
  const [endpointsRow, policyRow] = await Promise.all([
    getCachedEndpoints(chat.settings.profileId, chat.settings.model),
    getCachedPrivacyPolicy(chat.settings.profileId, chat.settings.model),
  ])
  if (!endpointsRow) {
    // Cold /endpoints cache — privacy filter cannot run. This happens
    // on the very first send from a fresh install before the hook has
    // finished fetching. Sending without the privacy wire fragment is
    // safe because OpenRouter's account-level defaults still apply;
    // the UI can correct on the next send.
    return { wire: null, filter: null, applicable: true }
  }
  const descriptor = normalizeEndpointsResponse(endpointsRow.payload)
  const endpoints = descriptor?.endpoints ?? []
  const policies =
    readCachedPrivacyPayload(policyRow?.payload)?.policies ?? {}
  const filter = filterEndpointsByPrivacy({
    model: chat.settings.model,
    endpoints,
    policies,
    privacy: chat.settings.privacy,
  })
  const prefs = chat.settings.providerPrefs
  const wireOpts: { existingIgnore?: readonly string[]; userTouchedPicker?: boolean } = {
    userTouchedPicker: prefs?.ignoreOverridesFilter === true,
  }
  if (prefs?.ignore) wireOpts.existingIgnore = prefs.ignore
  const wire = buildWireProviderPrivacy(filter, chat.settings.privacy, wireOpts)
  return { wire, filter, applicable: true }
}
