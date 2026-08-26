import { fetchEndpoints } from '../api/models'
import { fetchPrivacyScrape } from '../api/privacy-scrape'
import { normalizeEndpointsResponse, normalizeModelsResponse } from '../api/providers'
import type { AssistantPlanningResources } from '../core/assistant-planning-resources'
import { corsProxyConfigFromPrefs } from '../core/global-settings'
import { isStaticTextTemplateId, resolveStaticTextTemplate } from '../core/text-templates'
import type {
  AttachmentId,
  ConnectionProfile,
  ModelsQuery,
  TextTemplateConfig,
  TextTemplateId,
} from '../core/types'
import { readGlobalPreferences } from './global-settings'
import { readTokenCalibrationGlobal } from './token-calibration'
import { runWorkspaceRead } from './workspace-runtime'

interface ConnectionProbePlanningInput {
  profile: ConnectionProfile
  apiKey: string
  modelsPayload?: unknown
}

export async function createConnectionProbePlanningResources(
  input: ConnectionProbePlanningInput,
): Promise<AssistantPlanningResources> {
  const snapshot = await runWorkspaceRead('repository-query', async (authority) => {
    const [globalCalibration, preferences] = await Promise.all([
      readTokenCalibrationGlobal(authority),
      readGlobalPreferences(authority),
    ])
    return {
      globalCalibration,
      calibrationMode: preferences.tokenCalibrationMode,
      proxy: corsProxyConfigFromPrefs(preferences),
    }
  })
  return {
    globalCalibration: () => snapshot.globalCalibration,
    calibrationMode: () => snapshot.calibrationMode,
    proxy: () => snapshot.proxy,
    readModels: (_query: ModelsQuery) =>
      Promise.resolve(
        input.modelsPayload === undefined
          ? undefined
          : normalizeModelsResponse(input.modelsPayload),
      ),
    resolveEndpoints: async (modelId, options = {}) => {
      if (options.refresh === false) return null
      return normalizeEndpointsResponse(
        await fetchEndpoints({ profile: input.profile, apiKey: input.apiKey }, modelId, {
          timeoutMs: 15_000,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      )
    },
    resolvePrivacy: async (modelId, options) => {
      if (!options.refresh) return { policies: {}, offlineFallback: false }
      try {
        const result = await fetchPrivacyScrape({ proxy: snapshot.proxy }, modelId, {
          timeoutMs: 15_000,
          ...(options.signal ? { signal: options.signal } : {}),
        })
        return { policies: result.policies, offlineFallback: false }
      } catch {
        return { policies: {}, offlineFallback: true }
      }
    },
    getAttachment: (_attachmentId: AttachmentId) => Promise.resolve(undefined),
    getAttachmentBundle: (_attachmentId: AttachmentId) => Promise.resolve(undefined),
    resolveTextTemplate: (id: TextTemplateId, customFallback?: TextTemplateConfig) => {
      if (!isStaticTextTemplateId(id)) {
        return Promise.reject(new Error(`ConnectionProbeSavedTemplateUnavailable:${id}`))
      }
      return Promise.resolve(resolveStaticTextTemplate(id, customFallback))
    },
  }
}
