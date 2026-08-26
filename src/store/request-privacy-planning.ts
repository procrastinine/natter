// Request-time privacy resolver. Ensures `/endpoints` + scraped privacy
// policies are available for the active (profile, model), runs the filter,
// and returns the wire `provider` fragment that `toChatCompletions`
// merges with `settings.providerPrefs`.
//
// Unlike `usePrivacyRouting`, this is a plain async function suitable for
// the send path -- no React dependency. It does not silently send through a
// cold cache. Automatic routing may wait for live discovery; after the user
// owns the checked-provider set, planning uses only the attempt's captured
// discovery rows and known mandatory hard denies.
//
// OpenRouter-only by construction. Non-OpenRouter profiles get an early
// null (the transform already gates on `gate('provider')`). Free models
// also get a null so the free-model-strip logic in the transform does
// not need to also be aware of the filter.

import { normalizeError } from '../api/errors'
import type { AssistantPlanningResources } from '../core/assistant-planning-resources'
import { isCorsProxyDisabled } from '../core/cors-proxy'
import { isFreeModel } from '../core/model-predicates'
import {
  buildWireProviderPrivacy,
  filterEndpointsByPrivacy,
  type PrivacyFilterResult,
  type WireProviderPrivacy,
} from '../core/privacy-filter'
import { providerRoutingRef } from '../core/provider-identity'
import type { Chat, ConnectionProfile, DataPolicy, EndpointsDescriptor } from '../core/types'
import { errorFromUnknown } from '../lib/error'

const SEND_DISCOVERY_TIMEOUT_MS = 15_000

export class PrivacyDiscoveryUnavailableError extends Error {
  override readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'PrivacyDiscoveryUnavailableError'
    if (cause !== undefined) this.cause = cause
  }
}

interface ResolvePrivacyForSendInput {
  chat: Chat
  profile: ConnectionProfile
  resources: AssistantPlanningResources
  // Tokens that would actually be sent to this model right now (visible
  // text + media + reasoning echo + reserved completion). Provider
  // endpoints whose context can't hold this number are added to
  // `wire.ignore` as a transient filter. The user's persisted
  // `providerPrefs.ignore` list is unchanged. Omit to skip the check
  // entirely.
  neededTokens?: number
  capacityExcludedProviders?: readonly string[]
  signal?: AbortSignal
}

export interface ResolvePrivacyForSendResult {
  wire: WireProviderPrivacy | null
  filter: PrivacyFilterResult | null
  descriptor: EndpointsDescriptor | null
  applicable: boolean
  contextIgnoredProviders: string[]
}

export interface ResolvedPrivacyFacts {
  readonly descriptor: EndpointsDescriptor | null
  readonly policies: Readonly<Record<string, DataPolicy>>
  readonly offlineFallback: boolean
}

export async function resolvePrivacyForSend(
  input: ResolvePrivacyForSendInput,
): Promise<ResolvePrivacyForSendResult> {
  const facts = await resolvePrivacyFactsForSend(input)
  return buildPrivacyForSendResult({
    chat: input.chat,
    profile: input.profile,
    facts,
    ...(input.neededTokens !== undefined ? { neededTokens: input.neededTokens } : {}),
    ...(input.capacityExcludedProviders
      ? { capacityExcludedProviders: input.capacityExcludedProviders }
      : {}),
  })
}

export async function resolvePrivacyFactsForSend(
  input: ResolvePrivacyForSendInput,
): Promise<ResolvedPrivacyFacts> {
  const { chat, profile } = input
  if (profile.kind !== 'openrouter' || !chat.settings.model) {
    return { descriptor: null, policies: {}, offlineFallback: false }
  }
  const manualSelection = chat.settings.providerPrefs?.ignoreOverridesFilter === true
  const descriptor = await ensureEndpointsDescriptor(
    input.resources,
    chat.settings.model,
    input.signal,
    !manualSelection,
  )
  if (isFreeModel(chat.settings.model)) {
    return { descriptor, policies: {}, offlineFallback: false }
  }
  const policyResult = await ensurePrivacyPolicies({
    profile,
    resources: input.resources,
    modelId: chat.settings.model,
    endpoints: descriptor?.endpoints ?? [],
    refreshAllowed: !manualSelection,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  return {
    descriptor,
    policies: policyResult.policies,
    offlineFallback: policyResult.offlineFallback,
  }
}

export function buildPrivacyForSendResult(input: {
  chat: Chat
  profile: ConnectionProfile
  facts: ResolvedPrivacyFacts
  neededTokens?: number
  capacityExcludedProviders?: readonly string[]
}): ResolvePrivacyForSendResult {
  const { chat, profile, facts } = input
  if (profile.kind !== 'openrouter' || !chat.settings.model) {
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
      descriptor: facts.descriptor,
      applicable: false,
      contextIgnoredProviders: [],
    }
  }
  const descriptor = facts.descriptor
  const endpoints = descriptor?.endpoints ?? []
  const filter = filterEndpointsByPrivacy({
    model: chat.settings.model,
    endpoints,
    policies: facts.policies,
    privacy: chat.settings.privacy,
    ...(facts.offlineFallback ? { missingPolicyMode: 'offline-worst-case' } : {}),
  })
  const prefs = chat.settings.providerPrefs
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
  const wire = buildWireProviderPrivacy(filter, chat.settings.privacy, wireOpts)
  const insufficient = new Set(input.capacityExcludedProviders ?? [])
  if (typeof input.neededTokens === 'number' && input.neededTokens > 0) {
    for (const ep of endpoints) {
      const cap = ep.max_prompt_tokens ?? ep.context_length
      if (typeof cap === 'number' && cap > 0 && input.neededTokens > cap) {
        insufficient.add(providerRoutingRef(ep))
      }
    }
    if (insufficient.size > 0) {
      // Merge into the existing wire.ignore. User prefs / privacy
      // filter exclusions stay intact. The UI still shows the provider as
      // "checked" because the settings row is unchanged; the grey badge
      // plus this transient ignore are what keep the send honest.
      const next = new Set<string>(wire.ignore ?? [])
      for (const name of insufficient) next.add(name)
      const merged: WireProviderPrivacy = { ...wire, ignore: [...next] }
      return {
        wire: merged,
        filter,
        descriptor,
        applicable: true,
        contextIgnoredProviders: [...insufficient],
      }
    }
  }
  if (insufficient.size > 0) {
    const next = new Set<string>(wire.ignore ?? [])
    for (const name of insufficient) next.add(name)
    return {
      wire: { ...wire, ignore: [...next] },
      filter,
      descriptor,
      applicable: true,
      contextIgnoredProviders: [...insufficient],
    }
  }
  return { wire, filter, descriptor, applicable: true, contextIgnoredProviders: [] }
}

async function ensureEndpointsDescriptor(
  resources: AssistantPlanningResources,
  modelId: string,
  signal: AbortSignal | undefined,
  refresh: boolean,
) {
  try {
    return await awaitSendDiscovery(signal, (operationSignal) =>
      resources.resolveEndpoints(modelId, { refresh, signal: operationSignal }),
    )
  } catch (err) {
    throw new PrivacyDiscoveryUnavailableError(
      'OpenRouter provider discovery failed before privacy routing could run.',
      err,
    )
  }
}

async function ensurePrivacyPolicies(input: {
  profile: ConnectionProfile
  resources: AssistantPlanningResources
  modelId: string
  endpoints: readonly { data_policy?: DataPolicy }[]
  refreshAllowed: boolean
  signal?: AbortSignal
}): Promise<{
  policies: Readonly<Record<string, DataPolicy>>
  offlineFallback: boolean
}> {
  const { profile, resources, modelId, endpoints, refreshAllowed, signal } = input
  const needsScrape =
    profile.supportsPrivacyScrape !== false && endpoints.some((endpoint) => !endpoint.data_policy)
  const refresh = refreshAllowed && needsScrape && !isCorsProxyDisabled(resources.proxy())
  return awaitSendDiscovery(signal, (operationSignal) =>
    resources.resolvePrivacy(modelId, {
      refresh,
      signal: operationSignal,
    }),
  )
}

function awaitSendDiscovery<T>(
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(normalizeError(signal.reason, { midStream: false, cause: 'abort' }))
  }
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => {
      controller.abort(signal?.reason)
      finish(() => reject(normalizeError(signal?.reason, { midStream: false, cause: 'abort' })))
    }
    const timer = setTimeout(() => {
      controller.abort(new DOMException('Send discovery timed out', 'TimeoutError'))
      finish(() => reject(new Error('SendDiscoveryTimeout')))
    }, SEND_DISCOVERY_TIMEOUT_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(errorFromUnknown(error))),
      )
  })
}
