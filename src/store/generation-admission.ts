import { readCachedPrivacyPayload } from '../api/privacy-scrape'
import { normalizeEndpointsResponse } from '../api/providers'
import { type CorsProxyConfig, isCorsProxyDisabled } from '../core/cors-proxy'
import { isFreeModel } from '../core/model-predicates'
import type { Chat, ConnectionProfile } from '../core/types'
import type { CachedEndpointsRow, CachedPrivacyPolicyRow } from './db-rows'
import {
  EMPTY_PRIVACY_POLICY_RETRY_MS,
  ENDPOINTS_TTL_MS,
  isFresh,
  PRIVACY_POLICY_TTL_MS,
} from './discovery-cache-policy'
import { buildPrivacyForSendResult } from './request-privacy-planning'
import type { GenerationPlanningSnapshot } from './workspace-protocol'

export type GenerationAdmissionDecision = 'eligible' | 'unknown' | 'zero-eligible'

export function generationAdmissionDecision(input: {
  chat: Chat
  profile: ConnectionProfile
  proxy: CorsProxyConfig
  discovery: GenerationPlanningSnapshot['discovery']
  now?: number
}): GenerationAdmissionDecision {
  const { chat, profile, discovery } = input
  const modelId = chat.settings.model
  if (profile.kind !== 'openrouter' || !modelId || isFreeModel(modelId)) return 'eligible'
  const endpointsRow = discovery.endpoints
  const now = input.now ?? Date.now()
  if (!endpointsRow || !isFresh(endpointsRow.fetchedAt, ENDPOINTS_TTL_MS, now)) return 'unknown'
  const descriptor = normalizeEndpointsResponse(endpointsRow.payload)
  const endpoints = descriptor?.endpoints ?? []
  const needsScrape =
    profile.supportsPrivacyScrape !== false && endpoints.some((endpoint) => !endpoint.data_policy)
  const refreshPrivacy = needsScrape && !isCorsProxyDisabled(input.proxy)
  const privacyRow = discovery.privacy
  if (refreshPrivacy && !capturedPrivacyRowIsFresh(privacyRow, now)) return 'unknown'
  const policies = privacyRow ? (readCachedPrivacyPayload(privacyRow.payload)?.policies ?? {}) : {}
  const result = buildPrivacyForSendResult({
    chat,
    profile,
    facts: { descriptor, policies, offlineFallback: false },
  })
  return (result.wire?.zeroEligible ?? result.filter?.zeroEligible) ? 'zero-eligible' : 'eligible'
}

export function capturedPrivacyRowIsFresh(
  row: CachedPrivacyPolicyRow | null,
  now: number = Date.now(),
): row is CachedPrivacyPolicyRow {
  if (!row) return false
  const parsed = readCachedPrivacyPayload(row.payload)
  const ttl =
    parsed && Object.keys(parsed.policies).length > 0
      ? PRIVACY_POLICY_TTL_MS
      : EMPTY_PRIVACY_POLICY_RETRY_MS
  return isFresh(row.fetchedAt, ttl, now)
}

export function capturedEndpointsRowIsFresh(
  row: CachedEndpointsRow | null,
  now: number = Date.now(),
): row is CachedEndpointsRow {
  return row !== null && isFresh(row.fetchedAt, ENDPOINTS_TTL_MS, now)
}
