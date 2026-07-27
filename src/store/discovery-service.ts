import { fetchEndpoints, fetchModels, type ModelsQueryString } from '../api/models'
import { fetchPrivacyScrape, readCachedPrivacyPayload } from '../api/privacy-scrape'
import { modelsCacheKey } from '../core/cache-keys'
import { connectionHttpProfile } from '../core/connection-dispatch-proof'
import type { CorsProxyConfig } from '../core/cors-proxy'
import type {
  ConfigurationRequestRevision,
  ConnectionProfile,
  ModelsQuery,
  ProfileId,
} from '../core/types'
import { requestConfigurationModelResolution } from './configuration-model-resolution-capability'
import type { CachedEndpointsRow, CachedModelsRow, CachedPrivacyPolicyRow } from './db-rows'
import {
  EMPTY_PRIVACY_POLICY_RETRY_MS,
  ENDPOINTS_TTL_MS,
  isFresh,
  MODELS_TTL_MS,
  PRIVACY_POLICY_TTL_MS,
} from './discovery-cache-policy'
import { captureKeyProofForDispatch } from './keys'
import { withCoordinationLock } from './locks'
import { clearCachedModels, getCachedEndpoints, getCachedModels } from './models-cache'
import { getCachedPrivacyPolicy } from './privacy-cache'
import {
  type ConnectionDiscoverySnapshot,
  connectionDiscoveryRevisionKey,
  type WorkspaceReadAuthority,
  type WorkspaceWriteAuthority,
} from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceAction } from './workspace-runtime'

interface DiscoveryRefreshOptions<Row = never> {
  authority?: WorkspaceWriteAuthority
  signal?: AbortSignal
  force?: boolean
  forceBaselineFetchedAt?: number | null
  timeoutMs?: number
  apiKey?: string
  expectedRevision?: ConfigurationRequestRevision
  baseline?: Row | null
}

export const configurationDiscoveryApplication = Object.freeze({
  policy: Object.freeze({
    modelsTtlMs: MODELS_TTL_MS,
    endpointsTtlMs: ENDPOINTS_TTL_MS,
    privacyTtlMs: PRIVACY_POLICY_TTL_MS,
    emptyPrivacyRetryMs: EMPTY_PRIVACY_POLICY_RETRY_MS,
  }),
  refreshModels: refreshModelsDiscovery,
  refreshEndpoints: refreshEndpointsDiscovery,
  refreshPrivacy: refreshPrivacyDiscovery,
  isFresh,
  clearModels(profileId: ProfileId, query: ModelsQuery): Promise<void> {
    return clearCachedModels(profileId, query)
  },
})

interface PrivacyRefreshOptions extends DiscoveryRefreshOptions<CachedPrivacyPolicyRow> {
  proxy: CorsProxyConfig
}

class DiscoveryResolutionError<Row> extends Error {
  override readonly cause: unknown
  readonly stale: Row | undefined

  constructor(cause: unknown, stale: Row | undefined) {
    super(cause instanceof Error ? cause.message : 'Discovery refresh failed')
    this.name = 'DiscoveryResolutionError'
    this.cause = cause
    this.stale = stale
  }
}

export function staleDiscoveryRow<Row>(error: unknown): Row | undefined {
  return error instanceof DiscoveryResolutionError ? (error.stale as Row | undefined) : undefined
}

async function resolveModelsDiscovery(
  profile: ConnectionProfile,
  query: ModelsQuery,
  options: DiscoveryRefreshOptions<CachedModelsRow> = {},
): Promise<CachedModelsRow> {
  const queryKey = modelsCacheKey(query)
  return runDiscoveryResolution(
    profile,
    `models:${queryKey}`,
    options,
    async (authority, target) => {
      const revision = connectionDiscoveryRevisionKey(target.revision)
      const cached = matchingRevision(
        hasCapturedBaseline(options)
          ? (options.baseline ?? undefined)
          : await getCachedModels(profile.id, query, authority),
        revision,
      )
      if (cacheSatisfiesRefresh(cached?.fetchedAt, MODELS_TTL_MS, options)) {
        requestConfigurationModelResolution()
        return cached as CachedModelsRow
      }
      let payload: unknown
      try {
        payload = await fetchModels(
          {
            profile: target.profile,
            apiKey: await discoveryApiKey(target, authority, options.apiKey),
          },
          modelsQueryString(query),
          {
            signal: authority.signal,
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          },
        )
      } catch (error) {
        throw new DiscoveryResolutionError(error, cached)
      }
      const row: CachedModelsRow = {
        profileId: target.profile.id,
        profileRevision: revision,
        queryKey,
        fetchedAt: Date.now(),
        payload,
      }
      const publication = await publishDiscoveryRow(authority, target.revision, {
        kind: 'discovery.models.put',
        row,
      })
      if (publication && !publication.cached) requestConfigurationModelResolution(row)
      return row
    },
  )
}

async function refreshModelsDiscovery(
  profile: ConnectionProfile,
  query: ModelsQuery,
  options: DiscoveryRefreshOptions<CachedModelsRow> = {},
): Promise<void> {
  await resolveModelsDiscovery(profile, query, options)
}

export async function resolveEndpointsDiscovery(
  profile: ConnectionProfile,
  modelId: string,
  options: DiscoveryRefreshOptions<CachedEndpointsRow> = {},
): Promise<CachedEndpointsRow> {
  return runDiscoveryResolution(
    profile,
    `endpoints:${modelId}`,
    options,
    async (authority, target) => {
      const revision = connectionDiscoveryRevisionKey(target.revision)
      const cached = matchingRevision(
        hasCapturedBaseline(options)
          ? (options.baseline ?? undefined)
          : await getCachedEndpoints(target.profile.id, modelId, authority),
        revision,
      )
      if (cacheSatisfiesRefresh(cached?.fetchedAt, ENDPOINTS_TTL_MS, options)) {
        return cached as CachedEndpointsRow
      }
      let payload: unknown
      try {
        payload = await fetchEndpoints(
          {
            profile: target.profile,
            apiKey: await discoveryApiKey(target, authority, options.apiKey),
          },
          modelId,
          {
            signal: authority.signal,
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          },
        )
      } catch (error) {
        throw new DiscoveryResolutionError(error, cached)
      }
      const row: CachedEndpointsRow = {
        profileId: target.profile.id,
        profileRevision: revision,
        modelId,
        fetchedAt: Date.now(),
        payload,
      }
      await publishDiscoveryRow(authority, target.revision, {
        kind: 'discovery.endpoints.put',
        row,
      })
      return row
    },
  )
}

async function refreshEndpointsDiscovery(
  profile: ConnectionProfile,
  modelId: string,
  options: DiscoveryRefreshOptions<CachedEndpointsRow> = {},
): Promise<void> {
  await resolveEndpointsDiscovery(profile, modelId, options)
}

export async function resolvePrivacyDiscovery(
  profile: ConnectionProfile,
  modelId: string,
  options: PrivacyRefreshOptions,
): Promise<CachedPrivacyPolicyRow> {
  return runDiscoveryResolution(
    profile,
    `privacy:${modelId}`,
    options,
    async (authority, target) => {
      const revision = connectionDiscoveryRevisionKey(target.revision)
      const cached = matchingRevision(
        hasCapturedBaseline(options)
          ? (options.baseline ?? undefined)
          : await getCachedPrivacyPolicy(target.profile.id, modelId, authority),
        revision,
      )
      const cachedPayload = cached ? readCachedPrivacyPayload(cached.payload) : null
      const hasPolicies = cachedPayload ? Object.keys(cachedPayload.policies).length > 0 : false
      const ttl = hasPolicies ? PRIVACY_POLICY_TTL_MS : EMPTY_PRIVACY_POLICY_RETRY_MS
      if (cacheSatisfiesRefresh(cached?.fetchedAt, ttl, options)) {
        return cached as CachedPrivacyPolicyRow
      }
      let result: Awaited<ReturnType<typeof fetchPrivacyScrape>>
      try {
        result = await fetchPrivacyScrape({ proxy: options.proxy }, modelId, {
          signal: authority.signal,
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        })
      } catch (error) {
        throw new DiscoveryResolutionError(error, cached)
      }
      const fetchedAt = Date.now()
      const policies =
        Object.keys(result.raw.policies).length === 0 && hasPolicies && cachedPayload
          ? cachedPayload.policies
          : result.raw.policies
      const row: CachedPrivacyPolicyRow = {
        profileId: target.profile.id,
        profileRevision: revision,
        modelId,
        fetchedAt,
        payload: { policies, fetchedAt },
      }
      await publishDiscoveryRow(
        authority,
        target.revision,
        {
          kind: 'discovery.privacy.put',
          row,
        },
        cached ?? null,
      )
      return row
    },
  )
}

async function refreshPrivacyDiscovery(
  profile: ConnectionProfile,
  modelId: string,
  options: PrivacyRefreshOptions,
): Promise<void> {
  await resolvePrivacyDiscovery(profile, modelId, options)
}

async function runDiscoveryResolution<Row>(
  profile: ConnectionProfile,
  discriminator: string,
  options: DiscoveryRefreshOptions<unknown>,
  resolve: (
    authority: WorkspaceWriteAuthority,
    target: ConnectionDiscoverySnapshot,
  ) => Promise<Row>,
): Promise<Row> {
  const execute = async (authority: WorkspaceWriteAuthority) => {
    const target = options.expectedRevision
      ? expectedDiscoveryTarget(profile, options)
      : await readConnectionDiscoverySnapshot(profile.id, authority)
    if (!target) throw new Error(`DiscoveryProfileMissing:${profile.id}`)
    return withCoordinationLock(
      discoveryLockName(authority, target.revision, discriminator),
      () => resolve(authority, target),
      { signal: authority.signal },
    )
  }
  if (options.authority) return execute(options.authority)
  return runWorkspaceAction(
    'cache-refresh',
    execute,
    options.signal ? { signal: options.signal } : {},
  )
}

function hasCapturedBaseline(options: DiscoveryRefreshOptions<unknown>): boolean {
  return Object.hasOwn(options, 'baseline')
}

async function publishDiscoveryRow(
  authority: WorkspaceWriteAuthority,
  revision: ConfigurationRequestRevision,
  command:
    | { kind: 'discovery.models.put'; row: CachedModelsRow }
    | { kind: 'discovery.endpoints.put'; row: CachedEndpointsRow }
    | { kind: 'discovery.privacy.put'; row: CachedPrivacyPolicyRow },
  expectedCurrent?: CachedPrivacyPolicyRow | null,
): Promise<import('./workspace-protocol').DiscoveryModelsPutResult | undefined> {
  switch (command.kind) {
    case 'discovery.models.put':
      return getWorkspaceRepository()
        .execute(authority, {
          ...command,
          guard: { expectedProfileRevision: revision },
        })
        .then((envelope) => envelope.value)
    case 'discovery.endpoints.put':
      await getWorkspaceRepository().execute(authority, {
        ...command,
        guard: { expectedProfileRevision: revision },
      })
      return
    case 'discovery.privacy.put':
      await getWorkspaceRepository().execute(authority, {
        ...command,
        guard: {
          expectedProfileRevision: revision,
          ...(expectedCurrent !== undefined ? { expectedCurrent } : {}),
        },
      })
  }
}

function matchingRevision<Row extends { profileRevision: string }>(
  row: Row | undefined,
  revision: string,
): Row | undefined {
  return row?.profileRevision === revision ? row : undefined
}

function cacheSatisfiesRefresh(
  fetchedAt: number | undefined,
  ttlMs: number,
  options: DiscoveryRefreshOptions<unknown>,
): boolean {
  if (options.force) {
    return (
      options.forceBaselineFetchedAt !== undefined &&
      (fetchedAt ?? null) !== options.forceBaselineFetchedAt
    )
  }
  return fetchedAt !== undefined && isFresh(fetchedAt, ttlMs)
}

function discoveryLockName(
  authority: WorkspaceWriteAuthority,
  revision: ConfigurationRequestRevision,
  discriminator: string,
): string {
  return [
    'discovery',
    authority.workspaceId,
    authority.replacementEpoch,
    connectionDiscoveryRevisionKey(revision),
    discriminator,
  ].join(':')
}

async function discoveryApiKey(
  target: ConnectionDiscoverySnapshot,
  authority: WorkspaceWriteAuthority,
  capturedApiKey: string | undefined,
): Promise<string> {
  if (capturedApiKey !== undefined) return capturedApiKey
  return target.primaryKey
    ? captureKeyProofForDispatch(target.primaryKey).resolve({}, authority)
    : ''
}

async function readConnectionDiscoverySnapshot(
  profileId: ProfileId,
  authority: WorkspaceReadAuthority,
): Promise<ConnectionDiscoverySnapshot | undefined> {
  return getWorkspaceRepository()
    .query(authority, { kind: 'configuration.discovery-snapshot', profileId })
    .then((result) => result.value)
}

function expectedDiscoveryTarget(
  profile: ConnectionProfile,
  options: DiscoveryRefreshOptions<unknown>,
): ConnectionDiscoverySnapshot {
  const revision = options.expectedRevision as ConfigurationRequestRevision
  if (
    revision.profileId !== profile.id ||
    revision.requestRevision !== (profile.requestRevision ?? 0)
  ) {
    throw new Error(`DiscoveryRevisionProfileMismatch:${profile.id}`)
  }
  if (options.apiKey === undefined) {
    throw new Error(`DiscoveryCapturedKeyMissing:${profile.id}`)
  }
  return {
    profile: Object.freeze({ id: profile.id, ...connectionHttpProfile(profile) }),
    revision: structuredClone(revision),
  }
}

function modelsQueryString(query: ModelsQuery): ModelsQueryString {
  return {
    ...(query.outputModalities?.length
      ? { output_modalities: query.outputModalities.join(',') }
      : {}),
    ...(query.supportedParameters?.length
      ? { supported_parameters: query.supportedParameters.join(',') }
      : {}),
  }
}
