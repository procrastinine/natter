import { runAssistantRequestOnce } from '../api/assistant-stream'
import { fetchModels } from '../api/models'
import { probeLlamaServer } from '../api/probe'
import { normalizeModelsResponse } from '../api/providers'
import { cloneDefaultChatSettings } from '../core/defaults'
import { OPENROUTER_PROBE_MODEL_IDS } from '../core/latest-models'
import { withProfileApiDefaults } from '../core/provider-defaults'
import type { Chat, ChatSettings, ConnectionKind, ConnectionProfile, Message } from '../core/types'
import {
  type ConfigurationConnectionModelCatalog,
  type ConfigurationConnectionProbeInput,
  type ConnectionProbeState,
  connectionKindRequiresKey,
  isValidConnectionHttpUrl,
} from './connection-probe-contract'
import { createConnectionProbePlanningResources } from './connection-probe-planning'
import { resolveKey } from './keys'
import { logPreparedAssistantRequestPlan } from './request-plan-diagnostics'
import { prepareAssistantRequestPlan } from './request-planning'

const PROBE_MODEL_CANDIDATES: Record<ConnectionKind, readonly string[]> = {
  openrouter: OPENROUTER_PROBE_MODEL_IDS,
  'openai-compatible': ['gpt-5.6-luna'],
  anthropic: ['claude-haiku-4-5'],
  google: ['gemini-3.1-flash-lite-preview'],
  'llama-server': [],
  custom: [],
}

export async function runConfigurationConnectionProbe(
  input: ConfigurationConnectionProbeInput,
): Promise<ConnectionProbeState> {
  if (!isValidConnectionHttpUrl(input.baseUrl)) {
    return { kind: 'fail', message: 'Enter a full URL starting with http:// or https://.' }
  }
  if (input.kind === 'llama-server') {
    const result = await probeLlamaServer({ baseUrl: input.baseUrl }, { timeoutMs: 3_000 })
    if (result.kind === 'ok') {
      const bits = [
        result.props.modelPath?.split('/').pop() ?? null,
        result.props.defaultContextLength ? `ctx ${result.props.defaultContextLength}` : null,
        result.props.chatTemplate ? 'template detected' : null,
      ]
      return {
        kind: 'ok',
        message: `Reached llama-server in ${result.elapsedMs}ms — ${bits.filter(Boolean).join(' · ') || 'OK'}`,
      }
    }
    return { kind: 'fail', message: `${result.message} (${result.rootUrl}/props)` }
  }

  const apiKey =
    input.apiKey ?? (input.fallbackKeyId ? await resolveKey(input.fallbackKeyId) : null)
  if (connectionKindRequiresKey(input.kind) && !apiKey) {
    return { kind: 'fail', message: 'Set an API key before testing this profile.' }
  }

  const started = performance.now()
  try {
    const profile = buildProbeProfile(input.kind, input.name, input.baseUrl)
    let modelIds: string[] = []
    let modelsPayload: unknown
    try {
      const catalog = await loadConfigurationConnectionModelCatalog(
        { ...input, apiKey },
        { timeoutMs: 3_000 },
      )
      modelsPayload = catalog.payload
      modelIds = catalog.models.map((row) => normalizeProbeModelId(input.kind, row.id))
    } catch {
      // Completion is the actual probe; several compatible APIs omit /models.
    }
    const model = pickProbeModel(input.kind, modelIds)
    if (!model) return { kind: 'fail', message: 'Could not choose a model to test.' }

    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    settings.model = model
    const probeSettings = withProfileApiDefaults(settings, profile)
    const resources = await createConnectionProbePlanningResources({
      profile,
      apiKey: apiKey ?? '',
      ...(modelsPayload !== undefined ? { modelsPayload } : {}),
    })
    const chat = probeChat(probeSettings)
    const pathMessages = [probeUserMessage()]
    const { requestPlan, privacyPlan } = await prepareAssistantRequestPlan({
      chat,
      connection: profile,
      pathMessages,
      settings: probeSettings,
      stream: false,
      resources,
    })
    logPreparedAssistantRequestPlan(
      'connection-probe',
      chat.id,
      profile,
      pathMessages.length,
      requestPlan,
      privacyPlan,
    )
    await runAssistantRequestOnce({ connection: profile, apiKey: apiKey ?? '', requestPlan })
    return {
      kind: 'ok',
      message: `Completed test chat in ${Math.round(performance.now() - started)}ms — ${model}`,
    }
  } catch (error) {
    return { kind: 'fail', message: error instanceof Error ? error.message : String(error) }
  }
}

export async function loadConfigurationConnectionModelCatalog(
  input: ConfigurationConnectionProbeInput,
  options: { readonly timeoutMs?: number } = {},
): Promise<ConfigurationConnectionModelCatalog> {
  const apiKey =
    input.apiKey ?? (input.fallbackKeyId ? await resolveKey(input.fallbackKeyId) : null)
  if (connectionKindRequiresKey(input.kind) && !apiKey) {
    throw new Error('ConnectionModelCatalogKeyRequired')
  }
  const profile = buildProbeProfile(input.kind, input.name, input.baseUrl)
  const payload = await fetchModels(
    { profile, apiKey: apiKey ?? '' },
    {},
    { timeoutMs: options.timeoutMs ?? 15_000 },
  )
  return { models: normalizeModelsResponse(payload), payload }
}

function buildProbeProfile(kind: ConnectionKind, name: string, baseUrl: string): ConnectionProfile {
  const now = Date.now()
  return {
    id: `probe:${kind}:${name}`,
    name,
    kind,
    baseUrl,
    apiKeyRef: 'probe-key',
    defaultHeaders: {},
    appTitle: 'llm-api-frontend',
    appUrl: '',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: kind === 'openrouter',
    createdAt: now,
    updatedAt: now,
  }
}

function normalizeProbeModelId(kind: ConnectionKind, modelId: string): string {
  if (kind === 'google' && modelId.startsWith('models/')) return modelId.slice('models/'.length)
  if (kind === 'anthropic') {
    return modelId.replace(/-\d{8}$/u, '').replace(/(\d)\.(\d)(?=-|$)/g, '$1-$2')
  }
  return modelId
}

function pickProbeModel(kind: ConnectionKind, modelIds: string[]): string {
  for (const candidate of PROBE_MODEL_CANDIDATES[kind]) {
    const hit = modelIds.find((modelId) => normalizeProbeModelId(kind, modelId) === candidate)
    if (hit) return hit
  }
  return modelIds[0] ?? PROBE_MODEL_CANDIDATES[kind][0] ?? ''
}

function probeUserMessage(): Message {
  return {
    id: 'probe-user',
    chatId: 'probe-chat',
    parentId: null,
    siblingIndex: 0,
    turnId: 'probe-turn',
    turnIndex: 0,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'Reply with the single word ok.' }],
    createdAt: 1,
    nodeVersion: 0,
    deleted: false,
  }
}

function probeChat(settings: ChatSettings): Chat {
  return {
    id: 'probe-chat',
    title: 'Connection probe',
    titleStatus: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 0,
    settings,
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}
