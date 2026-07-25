import { readCachedPrivacyPayload } from '../api/privacy-scrape'
import { normalizeEndpointsResponse, normalizeModelsResponse } from '../api/providers'
import { listBundledEntries, resolveBundledCapability } from '../capabilities'
import type { EffectiveCapability } from '../core/capabilities'
import {
  type EffectiveEndpointRouting,
  resolveEffectiveEndpointRouting,
} from '../core/effective-endpoint-routing'
import {
  canonicalCompatModelId,
  deterministicStructuralModelId,
  structuralModelSlug,
} from '../core/model-ids'
import { isFreeModel } from '../core/model-predicates'
import {
  buildWireProviderPrivacy,
  filterEndpointsByPrivacy,
  type PrivacyFilterResult,
  type WireProviderPrivacy,
} from '../core/privacy-filter'
import { EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS } from '../core/reasoning'
import type {
  CapabilityDescriptor,
  ChatSettings,
  ConnectionProfile,
  DataPolicy,
  EndpointsDescriptor,
  ModelEndpoint,
  ModelListEntry,
} from '../core/types'

export interface ModelCatalogPayloads {
  modelsPresent: boolean
  models: unknown
  endpoints: unknown
  privacyPolicies: Record<string, DataPolicy>
}

export interface ModelCatalogProjection {
  models: ModelListEntry[]
  descriptor: EndpointsDescriptor | null
  endpoints: ModelEndpoint[]
  capability: EffectiveCapability | null
  requestCapability?: CapabilityDescriptor
  effectiveRouting: EffectiveEndpointRouting | null
  modelAvailable: boolean | null
  policies: Record<string, DataPolicy>
  filter: PrivacyFilterResult | null
  wire: WireProviderPrivacy | null
  scrapeApplicable: boolean
  isFreeModel: boolean
}

export function projectModelCatalog(input: {
  settings: ChatSettings | null | undefined
  profile: ConnectionProfile | null | undefined
  payloads: ModelCatalogPayloads
  privacyLoading: boolean
  privacyFailed: boolean
}): ModelCatalogProjection {
  const { settings, profile, payloads } = input
  const modelId = settings?.model || null
  const liveModels = payloads.modelsPresent ? normalizeModelsResponse(payloads.models) : []
  const models = profile ? mergeBundledModels(profile, liveModels) : []
  const liveEntry = modelId ? equivalentModel(modelId, liveModels) : null
  const descriptor = payloads.endpoints ? normalizeEndpointsResponse(payloads.endpoints) : null
  const endpoints = descriptor?.endpoints ?? []
  const endpointDiscoveryEnabled =
    !!profile && !!modelId && profile.kind === 'openrouter' && profile.supportsEndpointsApi
  const modelAvailable = resolveModelAvailability({
    profile,
    modelId,
    modelsCachePresent: payloads.modelsPresent,
    liveEntry,
  })
  const freeModel = modelId ? isFreeModel(modelId) : false
  const scrapeApplicable =
    !!profile &&
    !!modelId &&
    profile.kind === 'openrouter' &&
    profile.supportsPrivacyScrape &&
    !freeModel
  const policies = payloads.privacyPolicies
  const filter = resolvePrivacyFilter({
    settings,
    modelId,
    endpoints,
    policies,
    scrapeApplicable,
    privacyLoading: input.privacyLoading,
    privacyFailed: input.privacyFailed,
  })
  const wire = settings && filter ? privacyWire(settings, filter) : null
  const requestCapability = resolveRequestCapability({
    profile,
    modelId,
    endpointDiscoveryEnabled,
    liveEntry,
    modelAvailable,
  })
  const effectiveRouting =
    profile && settings && modelId
      ? resolveEffectiveEndpointRouting({
          profile,
          settings,
          contextFacts: EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
          ...(requestCapability ? { capability: requestCapability } : {}),
          descriptor,
          filter,
          providerWire: wire,
        })
      : null
  return {
    models,
    descriptor,
    endpoints,
    capability: effectiveRouting?.capability ?? effectiveRouting?.catalogCapability ?? null,
    ...(requestCapability ? { requestCapability } : {}),
    effectiveRouting,
    modelAvailable,
    policies,
    filter,
    wire: effectiveRouting?.providerWire ?? wire,
    scrapeApplicable,
    isFreeModel: freeModel,
  }
}

function mergeBundledModels(profile: ConnectionProfile, live: ModelListEntry[]): ModelListEntry[] {
  if (profile.kind === 'openrouter') return live
  const bundled = listBundledEntries(profile.kind)
  if (bundled.length === 0) return live
  const liveById = new Map(live.map((model) => [model.id, model]))
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
                    ? { outputModalities: [...entry.capability.architecture.outputModalities] }
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
                    ? { outputModalities: [...entry.capability.architecture.outputModalities] }
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

function equivalentModel<T extends { id: string }>(
  sourceModelId: string,
  candidates: readonly T[],
): T | null {
  const sourceKey = deterministicStructuralModelId(sourceModelId)
  let firstCompatible: T | null = null
  let firstUnsuffixed: T | null = null
  for (const candidate of candidates) {
    if (candidate.id === sourceModelId) return candidate
    if (deterministicStructuralModelId(candidate.id) !== sourceKey) continue
    firstCompatible ??= candidate
    if (!firstUnsuffixed && !hasOpenRouterVariantSuffix(candidate.id)) {
      firstUnsuffixed = candidate
    }
  }
  return firstUnsuffixed ?? firstCompatible
}

function hasOpenRouterVariantSuffix(modelId: string): boolean {
  return /:(?:free|thinking)$/iu.test(modelId)
}

function resolveModelAvailability(input: {
  profile: ConnectionProfile | null | undefined
  modelId: string | null
  modelsCachePresent: boolean
  liveEntry: ModelListEntry | null
}): boolean | null {
  const { profile, modelId, modelsCachePresent, liveEntry } = input
  if (!profile || !modelId) return null
  if (profile.kind !== 'openrouter') {
    if (liveEntry) return true
    if (equivalentModel(modelId, listBundledEntries(profile.kind))) return true
  }
  if (!modelsCachePresent) return null
  return liveEntry !== null
}

function resolveRequestCapability(input: {
  profile: ConnectionProfile | null | undefined
  modelId: string | null
  endpointDiscoveryEnabled: boolean
  liveEntry: ModelListEntry | null
  modelAvailable: boolean | null
}): CapabilityDescriptor | undefined {
  const { profile, modelId, endpointDiscoveryEnabled, liveEntry, modelAvailable } = input
  if (!profile || !modelId || endpointDiscoveryEnabled) return undefined
  if (profile.kind === 'llama-server' && modelAvailable === false) return undefined
  const merged: CapabilityDescriptor = { ...resolveBundledCapability(profile, modelId) }
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
  return merged
}

export function privacyPoliciesFromPayload(payload: unknown): Record<string, DataPolicy> {
  const cached = payload ? readCachedPrivacyPayload(payload) : null
  return cached?.policies ?? {}
}

function resolvePrivacyFilter(input: {
  settings: ChatSettings | null | undefined
  modelId: string | null
  endpoints: readonly ModelEndpoint[]
  policies: Readonly<Record<string, DataPolicy>>
  scrapeApplicable: boolean
  privacyLoading: boolean
  privacyFailed: boolean
}): PrivacyFilterResult | null {
  if (!input.settings || !input.scrapeApplicable || input.privacyLoading || !input.modelId) {
    return null
  }
  if (input.endpoints.length === 0) return null
  return filterEndpointsByPrivacy({
    model: input.modelId,
    endpoints: input.endpoints,
    policies: input.policies,
    privacy: input.settings.privacy,
    missingPolicyMode: input.privacyFailed ? 'offline-worst-case' : 'unavailable',
  })
}

function privacyWire(settings: ChatSettings, filter: PrivacyFilterResult): WireProviderPrivacy {
  const prefs = settings.providerPrefs
  const userTouched = prefs?.ignoreOverridesFilter === true || (prefs?.only?.length ?? 0) > 0
  return buildWireProviderPrivacy(filter, settings.privacy, {
    userTouchedPicker: userTouched,
    ...(prefs?.ignore ? { existingIgnore: prefs.ignore } : {}),
    ...(prefs?.only ? { existingOnly: prefs.only } : {}),
    ...(prefs?.order ? { existingOrder: prefs.order } : {}),
  })
}
