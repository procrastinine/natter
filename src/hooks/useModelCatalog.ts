import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { EffectiveCapability } from '../core/capabilities'
import type { CorsProxyConfig } from '../core/cors-proxy'
import { isCorsProxyDisabled } from '../core/cors-proxy'
import type { EffectiveEndpointRouting } from '../core/effective-endpoint-routing'
import { generationCorsProxyConfigFromStored } from '../core/global-settings'
import { isFreeModel } from '../core/model-predicates'
import type { PrivacyFilterResult, WireProviderPrivacy } from '../core/privacy-filter'
import type {
  CapabilityDescriptor,
  ChatSettings,
  ConnectionProfile,
  EndpointsDescriptor,
  ModelEndpoint,
  ModelListEntry,
} from '../core/types'
import {
  configurationController,
  currentActiveConfigurationModel,
  currentActiveConfigurationSelection,
  previousActiveConfigurationModel,
  sameActiveConfigurationRoutingTarget,
} from '../store/configuration-controller'
import type {
  ActiveConfigurationSelectionTarget,
  CachedEndpointsRow,
  CachedModelsRow,
  CachedPrivacyPolicyRow,
  ConfigurationDiscoveryChannelStatus,
  ConfigurationModelCatalogProjection,
  ConfigurationModelRoutingProjection,
} from '../store/presentation-contracts'
import {
  type ModelCatalogProjection,
  privacyPoliciesFromPayload,
  projectModelCatalog,
} from './model-catalog-projection'

const DEFAULT_PROXY = generationCorsProxyConfigFromStored(new Map())

export interface UseModelsResult {
  models: ModelListEntry[]
  loading: boolean
  retained: boolean
  presentation: UseModelsPresentation
  fetchedAt: number | null
  offline: boolean
  error: string | null
  refresh: () => void
}

export interface UsePrivacyRoutingResult {
  filter: PrivacyFilterResult | null
  wire: WireProviderPrivacy | null
  endpoints: readonly ModelEndpoint[]
  descriptor: EndpointsDescriptor | null
  capability: EffectiveCapability | null
  requestCapability?: CapabilityDescriptor
  effectiveRouting: EffectiveEndpointRouting | null
  modelAvailable: boolean | null
  loading: boolean
  offline: boolean
  error: string | null
  scrapeApplicable: boolean
  liveScrapeEnabled: boolean
  isFreeModel: boolean
  capabilityPresentation: UseCapabilityRoutingPresentation
  privacyPresentation: UsePrivacyRoutingPresentation
  refresh: () => void
}

interface CatalogPresentationTarget {
  profileId: string | null
  profile: ConnectionProfile | null
  modelId: string | null
  settings: ChatSettings | null
}

interface UseModelsPresentation extends CatalogPresentationTarget {
  models: readonly ModelListEntry[]
  modelAvailable: boolean | null
  fetchedAt: number | null
  retained: boolean
}

interface UseCapabilityRoutingPresentation extends CatalogPresentationTarget {
  endpoints: readonly ModelEndpoint[]
  descriptor: EndpointsDescriptor | null
  capability: EffectiveCapability | null
  effectiveRouting: EffectiveEndpointRouting | null
  modelAvailable: boolean | null
  retained: boolean
}

interface UsePrivacyRoutingPresentation extends CatalogPresentationTarget {
  filter: PrivacyFilterResult | null
  endpoints: readonly ModelEndpoint[]
  scrapeApplicable: boolean
  isFreeModel: boolean
  retained: boolean
}

export interface UseModelCatalogResult {
  chatId: string | null
  profileId: string | null
  modelId: string | null
  models: UseModelsResult
  routing: UsePrivacyRoutingResult
}

interface UseModelCatalogOptions {
  readonly modelsDemanded: boolean
}

interface CatalogCacheSnapshot {
  models: CachedModelsRow | undefined
  endpoints: CachedEndpointsRow | undefined
  privacy: CachedPrivacyPolicyRow | undefined
  proxy: CorsProxyConfig
}

const EMPTY_CHANNEL_STATUS: ConfigurationDiscoveryChannelStatus = Object.freeze({
  targetKey: null,
  baselineFetchedAt: null,
  inFlight: false,
  error: null,
})

export function useModelCatalog(
  target: ActiveConfigurationSelectionTarget | null,
  profileSnapshot: ConnectionProfile | null | undefined,
  options: UseModelCatalogOptions,
): UseModelCatalogResult {
  const settings = target?.settings
  const profileId = settings?.profileId ?? profileSnapshot?.id ?? null
  const suppliedProfile = profileSnapshot?.id === profileId ? profileSnapshot : undefined
  const configuration = useSyncExternalStore(
    configurationController.subscribe,
    configurationController.getSnapshot,
    configurationController.getSnapshot,
  )
  const modelId = settings?.model || null
  const workspaceFence = configuration.workspaceFence
  useEffect(() => {
    if (!workspaceFence) {
      configurationController.observeDiscoverySurface(null)
      return
    }
    configurationController.observeDiscoverySurface(
      profileId ? { profileId, modelId, modelsDemanded: options.modelsDemanded } : null,
    )
  }, [modelId, options.modelsDemanded, profileId, workspaceFence])

  const frameSelection = currentActiveConfigurationSelection(configuration.frame)
  const frameModel = currentActiveConfigurationModel(configuration.frame)
  const previousFrameModel = previousActiveConfigurationModel(configuration.frame)
  const selectionProfile =
    frameSelection?.target.profileId === profileId ? frameSelection.value.profile : null
  const frameModelForProfile =
    frameModel?.target.profileId === profileId
      ? frameModel
      : previousFrameModel?.target.profileId === profileId
        ? previousFrameModel
        : null
  const frameModelMatches =
    frameModel?.target.profileId === profileId && frameModel.target.modelId === modelId
      ? frameModel
      : null
  const retainedFrameModel = frameModelMatches === null ? (previousFrameModel ?? frameModel) : null
  const retainedModelProfile = retainedFrameModel?.target.profile ?? null
  const retainedModelSettings = retainedFrameModel?.target.settings ?? null
  const catalogProjection: ConfigurationModelCatalogProjection | null =
    selectionProfile && frameModelForProfile
      ? {
          profile: selectionProfile,
          revision: frameModelForProfile.target.requestRevision,
          ...(frameModelForProfile.value.models
            ? { models: frameModelForProfile.value.models }
            : {}),
        }
      : null
  const retainedCatalogProjection: ConfigurationModelCatalogProjection | null =
    catalogProjection === null
      ? retainedModelProfile && retainedFrameModel
        ? {
            profile: retainedModelProfile,
            revision: retainedFrameModel.target.requestRevision,
            ...(retainedFrameModel.value.models ? { models: retainedFrameModel.value.models } : {}),
          }
        : null
      : null
  const routingProjection: ConfigurationModelRoutingProjection | null = frameModelMatches?.target
    .modelId
    ? {
        profileId: frameModelMatches.target.profileId,
        revision: frameModelMatches.target.requestRevision,
        modelId: frameModelMatches.target.modelId,
        ...(frameModelMatches.value.endpoints
          ? { endpoints: frameModelMatches.value.endpoints }
          : {}),
        ...(frameModelMatches.value.privacy ? { privacy: frameModelMatches.value.privacy } : {}),
        proxy: frameModelMatches.value.proxy,
      }
    : null
  const retainedRoutingProjection: ConfigurationModelRoutingProjection | null =
    retainedFrameModel?.target.modelId && retainedModelProfile && retainedModelSettings
      ? {
          profileId: retainedFrameModel.target.profileId,
          revision: retainedFrameModel.target.requestRevision,
          modelId: retainedFrameModel.target.modelId,
          ...(retainedFrameModel.value.endpoints
            ? { endpoints: retainedFrameModel.value.endpoints }
            : {}),
          ...(retainedFrameModel.value.privacy
            ? { privacy: retainedFrameModel.value.privacy }
            : {}),
          proxy: retainedFrameModel.value.proxy,
        }
      : null
  const profile = selectionProfile ?? suppliedProfile
  const projectionLoading =
    options.modelsDemanded &&
    profileId !== null &&
    configuration.frame.model.status === 'pending' &&
    configuration.frame.model.target.profileId === profileId &&
    configuration.frame.model.target.modelId === modelId &&
    catalogProjection?.models === undefined
  const projectionError =
    options.modelsDemanded &&
    configuration.frame.model.status === 'error' &&
    configuration.frame.model.target.profileId === profileId &&
    configuration.frame.model.target.modelId === modelId
      ? configuration.frame.model.error
      : null
  const routingProjectionLoading =
    profileId !== null &&
    modelId !== null &&
    configuration.frame.model.status === 'pending' &&
    configuration.frame.model.target.profileId === profileId &&
    configuration.frame.model.target.modelId === modelId &&
    frameModelMatches === null
  const routingProjectionError =
    configuration.frame.model.status === 'error' &&
    configuration.frame.model.target.profileId === profileId &&
    configuration.frame.model.target.modelId === modelId
      ? configuration.frame.model.error
      : null
  const cacheSnapshot = useMemo<CatalogCacheSnapshot>(
    () => ({
      models: catalogProjection?.models,
      endpoints: routingProjection?.endpoints,
      privacy: routingProjection?.privacy,
      proxy: routingProjection?.proxy ?? retainedRoutingProjection?.proxy ?? DEFAULT_PROXY,
    }),
    [catalogProjection?.models, retainedRoutingProjection?.proxy, routingProjection],
  )
  const privacyPolicies = useMemo(
    () => privacyPoliciesFromPayload(cacheSnapshot.privacy?.payload),
    [cacheSnapshot.privacy?.payload],
  )
  const privacyHasPolicies = useMemo(
    () => Object.keys(privacyPolicies).length > 0,
    [privacyPolicies],
  )
  const freeModel = modelId ? isFreeModel(modelId) : false
  const scrapeApplicable =
    !!profile &&
    !!modelId &&
    profile.kind === 'openrouter' &&
    profile.supportsPrivacyScrape &&
    !freeModel
  const liveScrapeEnabled = !isCorsProxyDisabled(cacheSnapshot.proxy)
  const endpointsEnabled =
    !!profile && !!modelId && profile.kind === 'openrouter' && profile.supportsEndpointsApi
  const discovery =
    frameModelMatches?.value.discovery ??
    retainedFrameModel?.value.discovery ??
    configuration.discovery
  const modelsStatus = visibleChannelStatus(
    discovery.statuses.models,
    catalogProjection ? discovery.modelsTargetKey : null,
    cacheSnapshot.models?.fetchedAt,
  )
  const endpointsStatus = visibleChannelStatus(
    discovery.statuses.endpoints,
    routingProjection ? discovery.endpointsTargetKey : null,
    cacheSnapshot.endpoints?.fetchedAt,
  )
  const privacyStatus = visibleChannelStatus(
    discovery.statuses.privacy,
    routingProjection ? discovery.privacyTargetKey : null,
    cacheSnapshot.privacy?.fetchedAt,
  )
  const privacyLoading =
    scrapeApplicable && liveScrapeEnabled && privacyStatus.inFlight && !privacyHasPolicies
  const projection = useMemo(
    () =>
      projectModelCatalog({
        settings,
        profile,
        payloads: {
          modelsPresent: cacheSnapshot.models !== undefined,
          models: cacheSnapshot.models?.payload,
          endpoints: cacheSnapshot.endpoints?.payload,
          privacyPolicies,
        },
        privacyLoading,
        privacyFailed: privacyStatus.error !== null,
      }),
    [
      cacheSnapshot.endpoints,
      cacheSnapshot.models,
      settings,
      privacyLoading,
      privacyPolicies,
      privacyStatus.error,
      profile,
    ],
  )
  const retainedPrivacyPolicies = useMemo(
    () => privacyPoliciesFromPayload(retainedRoutingProjection?.privacy?.payload),
    [retainedRoutingProjection?.privacy?.payload],
  )
  const retainedProjection = useMemo(
    () =>
      retainedModelSettings && retainedModelProfile
        ? projectModelCatalog({
            settings: retainedModelSettings,
            profile: retainedModelProfile,
            payloads: {
              modelsPresent: retainedCatalogProjection?.models !== undefined,
              models: retainedCatalogProjection?.models?.payload,
              endpoints: retainedRoutingProjection?.endpoints?.payload,
              privacyPolicies: retainedPrivacyPolicies,
            },
            privacyLoading: false,
            privacyFailed: false,
          })
        : null,
    [
      retainedModelProfile,
      retainedModelSettings,
      retainedCatalogProjection?.models,
      retainedPrivacyPolicies,
      retainedRoutingProjection,
    ],
  )
  const selectionReadyForTarget =
    target !== null &&
    frameSelection !== null &&
    sameActiveConfigurationRoutingTarget(frameSelection.target, target)
  const modelReadyForTarget = frameModelMatches !== null
  const currentPresentationTarget = useMemo<CatalogPresentationTarget>(
    () => ({
      profileId,
      profile: profile ?? null,
      modelId,
      settings: settings ?? null,
    }),
    [modelId, profile, profileId, settings],
  )
  const retainedPresentationTarget = useMemo<CatalogPresentationTarget | null>(
    () =>
      retainedModelProfile && retainedModelSettings
        ? {
            profileId: retainedModelProfile.id,
            profile: retainedModelProfile,
            modelId: retainedModelSettings.model || null,
            settings: retainedModelSettings,
          }
        : null,
    [retainedModelProfile, retainedModelSettings],
  )
  const modelsPresentation = useIndependentPresentation(
    useMemo<UseModelsPresentation>(
      () => ({
        ...currentPresentationTarget,
        models: projection.models,
        modelAvailable: projection.modelAvailable,
        fetchedAt: catalogProjection?.models?.fetchedAt ?? null,
        retained: false,
      }),
      [
        catalogProjection?.models?.fetchedAt,
        currentPresentationTarget,
        projection.modelAvailable,
        projection.models,
      ],
    ),
    selectionReadyForTarget &&
      (!options.modelsDemanded || profile === undefined || catalogProjection?.models !== undefined),
    useMemo<UseModelsPresentation | null>(
      () =>
        retainedPresentationTarget && retainedProjection
          ? {
              ...retainedPresentationTarget,
              models: retainedProjection.models,
              modelAvailable: retainedProjection.modelAvailable,
              fetchedAt: retainedCatalogProjection?.models?.fetchedAt ?? null,
              retained: true,
            }
          : null,
      [
        retainedCatalogProjection?.models?.fetchedAt,
        retainedPresentationTarget,
        retainedProjection,
      ],
    ),
  )
  const currentModelsPresentation = useMemo<UseModelsPresentation>(
    () =>
      modelsPresentation.retained && modelsPresentation.profileId === profileId
        ? modelsPresentation.profile?.kind === 'llama-server'
          ? {
              ...currentPresentationTarget,
              models: projection.models,
              modelAvailable: projection.modelAvailable,
              fetchedAt: catalogProjection?.models?.fetchedAt ?? null,
              retained: false,
            }
          : {
              ...modelsPresentation,
              ...currentPresentationTarget,
              modelAvailable: projection.modelAvailable,
              retained: false,
            }
        : modelsPresentation,
    [
      catalogProjection?.models?.fetchedAt,
      currentPresentationTarget,
      modelsPresentation,
      profileId,
      projection.modelAvailable,
      projection.models,
    ],
  )
  const endpointsRequired =
    profile?.kind === 'openrouter' && profile.supportsEndpointsApi === true && modelId !== null
  const capabilityPresentationReady =
    selectionReadyForTarget &&
    (profile === undefined ||
      modelId === null ||
      (modelReadyForTarget && (!endpointsRequired || routingProjection?.endpoints !== undefined)))
  const capabilityPresentation = useIndependentPresentation(
    useMemo<UseCapabilityRoutingPresentation>(
      () => capabilityRoutingPresentation(projection, currentPresentationTarget, false),
      [currentPresentationTarget, projection],
    ),
    capabilityPresentationReady,
    useMemo<UseCapabilityRoutingPresentation | null>(
      () =>
        retainedPresentationTarget && retainedProjection
          ? capabilityRoutingPresentation(retainedProjection, retainedPresentationTarget, true)
          : null,
      [retainedPresentationTarget, retainedProjection],
    ),
  )
  const privacyRequired =
    projection.scrapeApplicable && liveScrapeEnabled && !projection.isFreeModel
  const privacyPresentationReady =
    capabilityPresentationReady && (!privacyRequired || routingProjection?.privacy !== undefined)
  const privacyPresentation = useIndependentPresentation(
    useMemo<UsePrivacyRoutingPresentation>(
      () => privacyRoutingPresentation(projection, currentPresentationTarget, false),
      [currentPresentationTarget, projection],
    ),
    privacyPresentationReady,
    useMemo<UsePrivacyRoutingPresentation | null>(
      () =>
        retainedPresentationTarget && retainedProjection
          ? privacyRoutingPresentation(retainedProjection, retainedPresentationTarget, true)
          : null,
      [retainedPresentationTarget, retainedProjection],
    ),
  )
  const refreshModels = useCallback(() => {
    if (profileId) configurationController.refreshModelCatalogDiscovery(profileId)
  }, [profileId])
  const refreshRouting = useCallback(() => {
    if (profileId && modelId) {
      configurationController.refreshModelRoutingDiscovery(profileId, modelId)
    }
  }, [modelId, profileId])
  const models = useMemo<UseModelsResult>(
    () => ({
      models: [...currentModelsPresentation.models],
      loading: projectionLoading || (modelsStatus.inFlight && !cacheSnapshot.models),
      retained: currentModelsPresentation.retained,
      presentation: currentModelsPresentation,
      fetchedAt: currentModelsPresentation.fetchedAt,
      offline:
        (projectionError !== null || modelsStatus.error !== null) &&
        currentModelsPresentation.fetchedAt !== null,
      error: projectionError ?? modelsStatus.error,
      refresh: refreshModels,
    }),
    [
      cacheSnapshot.models,
      modelsStatus,
      projectionError,
      projectionLoading,
      refreshModels,
      currentModelsPresentation,
    ],
  )
  const endpointLoading =
    endpointsEnabled && endpointsStatus.inFlight && cacheSnapshot.endpoints === undefined
  const routing = useMemo<UsePrivacyRoutingResult>(
    () => ({
      filter: projection.filter,
      wire: projection.wire,
      endpoints: projection.endpoints,
      descriptor: projection.descriptor,
      capability: projection.capability,
      ...(projection.requestCapability ? { requestCapability: projection.requestCapability } : {}),
      effectiveRouting: projection.effectiveRouting,
      modelAvailable: projection.modelAvailable,
      loading: routingProjectionLoading || endpointLoading || privacyLoading,
      offline:
        (routingProjectionError !== null && routingProjection !== null) ||
        (endpointsStatus.error !== null && cacheSnapshot.endpoints !== undefined) ||
        privacyStatus.error !== null,
      error: routingProjectionError ?? endpointsStatus.error ?? privacyStatus.error,
      scrapeApplicable: projection.scrapeApplicable,
      liveScrapeEnabled,
      isFreeModel: projection.isFreeModel,
      capabilityPresentation,
      privacyPresentation,
      refresh: refreshRouting,
    }),
    [
      cacheSnapshot.endpoints,
      endpointLoading,
      endpointsStatus.error,
      liveScrapeEnabled,
      privacyLoading,
      privacyStatus.error,
      routingProjection,
      routingProjectionError,
      routingProjectionLoading,
      projection,
      capabilityPresentation,
      privacyPresentation,
      refreshRouting,
    ],
  )
  return useMemo(
    () => ({
      chatId: target?.kind === 'chat' ? target.chatId : null,
      profileId,
      modelId,
      models,
      routing,
    }),
    [modelId, models, profileId, routing, target],
  )
}

function capabilityRoutingPresentation(
  projection: ModelCatalogProjection,
  target: CatalogPresentationTarget,
  retained: boolean,
): UseCapabilityRoutingPresentation {
  return {
    ...target,
    endpoints: projection.endpoints,
    descriptor: projection.descriptor,
    capability: projection.capability,
    effectiveRouting: projection.effectiveRouting,
    modelAvailable: projection.modelAvailable,
    retained,
  }
}

function privacyRoutingPresentation(
  projection: ModelCatalogProjection,
  target: CatalogPresentationTarget,
  retained: boolean,
): UsePrivacyRoutingPresentation {
  return {
    ...target,
    filter: projection.filter,
    endpoints: projection.endpoints,
    scrapeApplicable: projection.scrapeApplicable,
    isFreeModel: projection.isFreeModel,
    retained,
  }
}

function useIndependentPresentation<T extends { readonly retained: boolean }>(
  current: T,
  ready: boolean,
  initialRetained: T | null,
): T {
  const committedRef = useRef<T | null>(null)
  useLayoutEffect(() => {
    if (ready) committedRef.current = current
  }, [current, ready])
  if (ready) return current
  const retained = committedRef.current ?? initialRetained
  return retained ? { ...retained, retained: true } : current
}

function visibleChannelStatus(
  status: ConfigurationDiscoveryChannelStatus,
  targetKey: string | null,
  fetchedAt: number | undefined,
): ConfigurationDiscoveryChannelStatus {
  if (!targetKey || status.targetKey !== targetKey) return EMPTY_CHANNEL_STATUS
  if (status.error !== null && fetchedAt !== undefined && status.baselineFetchedAt !== fetchedAt) {
    return EMPTY_CHANNEL_STATUS
  }
  return status
}
