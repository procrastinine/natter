import { readCachedPrivacyPayload } from '../api/privacy-scrape'
import { modelCatalogQueryForConnectionKind, modelsCacheKey } from '../core/cache-keys'
import type { CorsProxyConfig } from '../core/cors-proxy'
import { isCorsProxyDisabled } from '../core/cors-proxy'
import { isFreeModel } from '../core/model-predicates'
import type { ProfileId } from '../core/types'
import { configurationDiscoveryApplication } from './discovery-service'
import type {
  ConfigurationModelCatalogProjection,
  ConfigurationModelRoutingProjection,
} from './workspace-protocol'
import { connectionDiscoveryRevisionKey } from './workspace-protocol'

export type ConfigurationDiscoveryChannel = 'models' | 'endpoints' | 'privacy'

export interface ConfigurationDiscoveryChannelStatus {
  readonly targetKey: string | null
  readonly baselineFetchedAt: number | null
  readonly inFlight: boolean
  readonly error: string | null
}

export interface ConfigurationDiscoverySnapshot {
  readonly modelsTargetKey: string | null
  readonly endpointsTargetKey: string | null
  readonly privacyTargetKey: string | null
  readonly statuses: Readonly<
    Record<ConfigurationDiscoveryChannel, ConfigurationDiscoveryChannelStatus>
  >
}

export interface ConfigurationDiscoverySurface {
  readonly profileId: ProfileId
  readonly modelId: string | null
  readonly modelsDemanded: boolean
}

export interface ConfigurationDiscoveryCoordinatorInput {
  readonly enabled: boolean
  readonly surface: ConfigurationDiscoverySurface | null
  readonly modelCatalog: ConfigurationModelCatalogProjection | null
  readonly modelRouting: ConfigurationModelRoutingProjection | null
}

interface RefreshOptions {
  readonly signal: AbortSignal
  readonly force: boolean
  readonly forceBaselineFetchedAt: number | null
}

interface RefreshPlan {
  readonly logicalTargetKey: string
  readonly targetKey: string
  readonly fetchedAt: number | undefined
  readonly ttlMs: number
  run(options: RefreshOptions): Promise<void>
}

interface ActiveRefresh {
  readonly targetKey: string
  readonly baselineFetchedAt: number | null
  readonly controller: AbortController
}

interface SettledRefresh {
  readonly targetKey: string
  readonly baselineFetchedAt: number | null
}

interface FailedRefresh extends SettledRefresh {
  readonly error: string
}

interface ManualRefresh {
  readonly logicalTargetKey: string
}

interface CoordinatorDependencies {
  readonly onChange: () => void
}

const {
  emptyPrivacyRetryMs: EMPTY_PRIVACY_POLICY_RETRY_MS,
  endpointsTtlMs: ENDPOINTS_TTL_MS,
  modelsTtlMs: MODELS_TTL_MS,
  privacyTtlMs: PRIVACY_POLICY_TTL_MS,
} = configurationDiscoveryApplication.policy

const EMPTY_CHANNEL_STATUS: ConfigurationDiscoveryChannelStatus = Object.freeze({
  targetKey: null,
  baselineFetchedAt: null,
  inFlight: false,
  error: null,
})

const EMPTY_STATUSES = Object.freeze({
  models: EMPTY_CHANNEL_STATUS,
  endpoints: EMPTY_CHANNEL_STATUS,
  privacy: EMPTY_CHANNEL_STATUS,
})

const EMPTY_SNAPSHOT: ConfigurationDiscoverySnapshot = Object.freeze({
  modelsTargetKey: null,
  endpointsTargetKey: null,
  privacyTargetKey: null,
  statuses: EMPTY_STATUSES,
})

const CHANNELS = ['models', 'endpoints', 'privacy'] as const
export class ConfigurationDiscoveryCoordinator {
  private readonly onChange: () => void
  private input: ConfigurationDiscoveryCoordinatorInput = Object.freeze({
    enabled: false,
    surface: null,
    modelCatalog: null,
    modelRouting: null,
  })
  private readonly statuses: Record<
    ConfigurationDiscoveryChannel,
    ConfigurationDiscoveryChannelStatus
  > = { ...EMPTY_STATUSES }
  private readonly active: Record<ConfigurationDiscoveryChannel, ActiveRefresh | null> = {
    models: null,
    endpoints: null,
    privacy: null,
  }
  private readonly failed: Record<ConfigurationDiscoveryChannel, FailedRefresh | null> = {
    models: null,
    endpoints: null,
    privacy: null,
  }
  private readonly completed: Record<ConfigurationDiscoveryChannel, SettledRefresh | null> = {
    models: null,
    endpoints: null,
    privacy: null,
  }
  private readonly manual: Record<ConfigurationDiscoveryChannel, ManualRefresh | null> = {
    models: null,
    endpoints: null,
    privacy: null,
  }
  private proxyRevision = 0
  private proxyIdentity: CorsProxyConfig | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerDeadline: number | null = null
  private snapshot: ConfigurationDiscoverySnapshot = EMPTY_SNAPSHOT

  constructor(dependencies: CoordinatorDependencies) {
    this.onChange = dependencies.onChange
  }

  getSnapshot(): ConfigurationDiscoverySnapshot {
    return this.snapshot
  }

  reconcile(input: ConfigurationDiscoveryCoordinatorInput): void {
    this.input = input
    this.evaluate(false)
  }

  requestModels(profileId: ProfileId): void {
    this.request(['models'], modelsLogicalTargetKey(profileId))
  }

  requestRouting(profileId: ProfileId, modelId: string): void {
    const logicalTargetKey = routingLogicalTargetKey(profileId, modelId)
    this.request(['endpoints', 'privacy'], logicalTargetKey)
  }

  reset(): void {
    this.clearTimer()
    for (const channel of CHANNELS) {
      this.active[channel]?.controller.abort()
      this.active[channel] = null
      this.failed[channel] = null
      this.completed[channel] = null
      this.manual[channel] = null
      this.statuses[channel] = EMPTY_CHANNEL_STATUS
    }
    this.proxyIdentity = null
    this.proxyRevision = 0
    this.input = Object.freeze({
      enabled: false,
      surface: null,
      modelCatalog: null,
      modelRouting: null,
    })
    this.snapshot = EMPTY_SNAPSHOT
  }

  private request(
    channels: readonly ConfigurationDiscoveryChannel[],
    logicalTargetKey: string,
  ): void {
    for (const channel of channels) this.manual[channel] = { logicalTargetKey }
    this.evaluate(true)
  }

  private evaluate(notify: boolean): void {
    const plans = this.plans()
    let nextDeadline: number | null = null
    let changed = false
    const now = Date.now()
    for (const channel of CHANNELS) {
      const plan = plans[channel]
      if (!plan) {
        changed = this.disableChannel(channel) || changed
        continue
      }
      if (this.manual[channel]?.logicalTargetKey !== plan.logicalTargetKey) {
        this.manual[channel] = null
      }
      const active = this.active[channel]
      if (active && active.targetKey !== plan.targetKey) {
        active.controller.abort()
        this.active[channel] = null
        changed = true
      }
      changed = this.clearSettledForChangedBaseline(channel, plan) || changed
      if (this.active[channel]) {
        changed = this.publishStatus(channel, plan, true, null) || changed
        continue
      }
      const force = this.manual[channel] !== null
      const failed = this.failed[channel]
      if (!force && failed) {
        changed = this.publishStatus(channel, plan, false, failed.error) || changed
        continue
      }
      if (!force && this.completed[channel]) {
        changed = this.publishStatus(channel, plan, false, null) || changed
        continue
      }
      if (
        !force &&
        plan.fetchedAt !== undefined &&
        configurationDiscoveryApplication.isFresh(plan.fetchedAt, plan.ttlMs, now)
      ) {
        changed = this.publishStatus(channel, plan, false, null) || changed
        const deadline = plan.fetchedAt + plan.ttlMs
        nextDeadline = Math.min(nextDeadline ?? Number.POSITIVE_INFINITY, deadline)
        continue
      }
      if (force) this.manual[channel] = null
      this.failed[channel] = null
      this.completed[channel] = null
      const controller = new AbortController()
      const refresh: ActiveRefresh = {
        targetKey: plan.targetKey,
        baselineFetchedAt: plan.fetchedAt ?? null,
        controller,
      }
      this.active[channel] = refresh
      changed = this.publishStatus(channel, plan, true, null) || changed
      void Promise.resolve()
        .then(() =>
          plan.run({
            signal: controller.signal,
            force,
            forceBaselineFetchedAt: refresh.baselineFetchedAt,
          }),
        )
        .then(
          () => this.finish(channel, refresh, null),
          (error: unknown) => this.finish(channel, refresh, refreshError(error)),
        )
    }
    this.schedule(nextDeadline)
    changed = this.publishSnapshot(plans) || changed
    if (notify && changed) this.onChange()
  }

  private plans(): Record<ConfigurationDiscoveryChannel, RefreshPlan | null> {
    const { enabled, surface, modelCatalog, modelRouting } = this.input
    if (!enabled || !surface || !modelCatalog || modelCatalog.profile.id !== surface.profileId) {
      return { models: null, endpoints: null, privacy: null }
    }
    const profile = modelCatalog.profile
    const revisionKey = connectionDiscoveryRevisionKey(modelCatalog.revision)
    const modelsQuery = modelCatalogQueryForConnectionKind(profile.kind)
    const queryKey = modelsCacheKey(modelsQuery)
    const models: RefreshPlan | null = surface.modelsDemanded
      ? {
          logicalTargetKey: modelsLogicalTargetKey(profile.id),
          targetKey: JSON.stringify(['models', profile.id, revisionKey, queryKey]),
          fetchedAt: modelCatalog.models?.fetchedAt,
          ttlMs: MODELS_TTL_MS,
          run: async (options) => {
            try {
              await configurationDiscoveryApplication.refreshModels(profile, modelsQuery, options)
            } catch (error) {
              if (profile.kind === 'llama-server' && !options.signal.aborted) {
                await configurationDiscoveryApplication.clearModels(profile.id, modelsQuery)
              }
              throw error
            }
          },
        }
      : null
    if (
      !surface.modelId ||
      !modelRouting ||
      modelRouting.profileId !== profile.id ||
      modelRouting.modelId !== surface.modelId ||
      connectionDiscoveryRevisionKey(modelRouting.revision) !== revisionKey
    ) {
      return { models, endpoints: null, privacy: null }
    }
    const modelId = surface.modelId
    const logicalTargetKey = routingLogicalTargetKey(profile.id, modelId)
    const endpoints =
      profile.kind === 'openrouter' && profile.supportsEndpointsApi
        ? {
            logicalTargetKey,
            targetKey: JSON.stringify(['endpoints', profile.id, revisionKey, modelId]),
            fetchedAt: modelRouting.endpoints?.fetchedAt,
            ttlMs: ENDPOINTS_TTL_MS,
            run: (options: RefreshOptions) =>
              configurationDiscoveryApplication.refreshEndpoints(profile, modelId, options),
          }
        : null
    const proxy = modelRouting.proxy
    const privacyEnabled =
      profile.kind === 'openrouter' &&
      profile.supportsPrivacyScrape &&
      !isFreeModel(modelId) &&
      !isCorsProxyDisabled(proxy)
    let privacy: RefreshPlan | null = null
    if (privacyEnabled) {
      const proxyRevision = this.proxyTargetRevision(proxy)
      const cachedPrivacy = readCachedPrivacyPayload(modelRouting.privacy?.payload)
      const hasPolicies = cachedPrivacy ? Object.keys(cachedPrivacy.policies).length > 0 : false
      privacy = {
        logicalTargetKey,
        targetKey: JSON.stringify(['privacy', profile.id, revisionKey, modelId, proxyRevision]),
        fetchedAt: modelRouting.privacy?.fetchedAt,
        ttlMs: hasPolicies ? PRIVACY_POLICY_TTL_MS : EMPTY_PRIVACY_POLICY_RETRY_MS,
        run: (options) =>
          configurationDiscoveryApplication.refreshPrivacy(profile, modelId, {
            ...options,
            proxy,
          }),
      }
    }
    return { models, endpoints, privacy }
  }

  private proxyTargetRevision(proxy: CorsProxyConfig): number {
    if (this.proxyIdentity?.url !== proxy.url || this.proxyIdentity.secret !== proxy.secret) {
      this.proxyIdentity = { ...proxy }
      this.proxyRevision += 1
    }
    return this.proxyRevision
  }

  private disableChannel(channel: ConfigurationDiscoveryChannel): boolean {
    const active = this.active[channel]
    if (active) active.controller.abort()
    const changed = active !== null || this.statuses[channel] !== EMPTY_CHANNEL_STATUS
    this.active[channel] = null
    this.failed[channel] = null
    this.completed[channel] = null
    if (!this.manualAwaitsProjection(channel)) this.manual[channel] = null
    this.statuses[channel] = EMPTY_CHANNEL_STATUS
    return changed
  }

  private manualAwaitsProjection(channel: ConfigurationDiscoveryChannel): boolean {
    const manual = this.manual[channel]
    const { enabled, surface, modelCatalog, modelRouting } = this.input
    if (!manual || !enabled || !surface) return false
    const logicalTargetKey =
      channel === 'models'
        ? modelsLogicalTargetKey(surface.profileId)
        : surface.modelId
          ? routingLogicalTargetKey(surface.profileId, surface.modelId)
          : null
    if (manual.logicalTargetKey !== logicalTargetKey) return false
    if (channel === 'models' && !surface.modelsDemanded) return false
    if (!modelCatalog || modelCatalog.profile.id !== surface.profileId) return true
    if (channel === 'models') return false
    return (
      modelRouting === null ||
      modelRouting.profileId !== surface.profileId ||
      modelRouting.modelId !== surface.modelId
    )
  }

  private clearSettledForChangedBaseline(
    channel: ConfigurationDiscoveryChannel,
    plan: RefreshPlan,
  ): boolean {
    let changed = false
    const failed = this.failed[channel]
    if (
      failed &&
      (failed.targetKey !== plan.targetKey || failed.baselineFetchedAt !== (plan.fetchedAt ?? null))
    ) {
      this.failed[channel] = null
      changed = true
    }
    const completed = this.completed[channel]
    if (
      completed &&
      (completed.targetKey !== plan.targetKey ||
        completed.baselineFetchedAt !== (plan.fetchedAt ?? null))
    ) {
      this.completed[channel] = null
      changed = true
    }
    return changed
  }

  private publishStatus(
    channel: ConfigurationDiscoveryChannel,
    plan: RefreshPlan,
    inFlight: boolean,
    error: string | null,
  ): boolean {
    const next: ConfigurationDiscoveryChannelStatus = Object.freeze({
      targetKey: plan.targetKey,
      baselineFetchedAt: plan.fetchedAt ?? null,
      inFlight,
      error,
    })
    const current = this.statuses[channel]
    if (
      current.targetKey === next.targetKey &&
      current.baselineFetchedAt === next.baselineFetchedAt &&
      current.inFlight === next.inFlight &&
      current.error === next.error
    ) {
      return false
    }
    this.statuses[channel] = next
    return true
  }

  private finish(
    channel: ConfigurationDiscoveryChannel,
    refresh: ActiveRefresh,
    error: string | null,
  ): void {
    if (this.active[channel] !== refresh) return
    this.active[channel] = null
    const plan = this.plans()[channel]
    this.failed[channel] = error
      ? {
          targetKey: refresh.targetKey,
          baselineFetchedAt: refresh.baselineFetchedAt,
          error,
        }
      : null
    this.completed[channel] = error
      ? null
      : {
          targetKey: refresh.targetKey,
          baselineFetchedAt: refresh.baselineFetchedAt,
        }
    if (plan && plan.targetKey === refresh.targetKey) {
      this.publishStatus(channel, plan, false, error)
    }
    this.evaluate(true)
  }

  private schedule(deadline: number | null): void {
    if (deadline === this.timerDeadline) return
    this.clearTimer()
    if (deadline === null) return
    this.timerDeadline = deadline
    const delay = Math.max(0, deadline - Date.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.timerDeadline = null
      this.evaluate(true)
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.timerDeadline = null
  }

  private publishSnapshot(
    plans: Record<ConfigurationDiscoveryChannel, RefreshPlan | null>,
  ): boolean {
    const next: ConfigurationDiscoverySnapshot = Object.freeze({
      modelsTargetKey: plans.models?.targetKey ?? null,
      endpointsTargetKey: plans.endpoints?.targetKey ?? null,
      privacyTargetKey: plans.privacy?.targetKey ?? null,
      statuses: Object.freeze({ ...this.statuses }),
    })
    const current = this.snapshot
    if (
      current.modelsTargetKey === next.modelsTargetKey &&
      current.endpointsTargetKey === next.endpointsTargetKey &&
      current.privacyTargetKey === next.privacyTargetKey &&
      CHANNELS.every((channel) => current.statuses[channel] === next.statuses[channel])
    ) {
      return false
    }
    this.snapshot = next
    return true
  }
}

function modelsLogicalTargetKey(profileId: ProfileId): string {
  return JSON.stringify(['models', profileId])
}

function routingLogicalTargetKey(profileId: ProfileId, modelId: string): string {
  return JSON.stringify(['routing', profileId, modelId])
}

function refreshError(error: unknown): string {
  return error instanceof Error ? error.message : 'refresh failed'
}
