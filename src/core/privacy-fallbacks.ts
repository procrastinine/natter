import { providerPolicyLookupKeys } from './provider-identity'
import type { DataPolicy, ModelEndpoint } from './types'

const CLEAN_POLICY: DataPolicy = {
  training: false,
  trainingOpenRouter: false,
  retainsPrompts: false,
  requiresUserIDs: false,
  canPublish: false,
  termsOfServiceURL: '',
  privacyPolicyURL: '',
}

const OPENAI_DIRECT_FALLBACK: DataPolicy = {
  ...CLEAN_POLICY,
  retainsPrompts: true,
  requiresUserIDs: true,
}

const ANTHROPIC_DIRECT_FALLBACK: DataPolicy = {
  ...CLEAN_POLICY,
  retainsPrompts: true,
  retentionDays: 30,
  requiresUserIDs: true,
}

const GOOGLE_VERTEX_FALLBACK: DataPolicy = {
  ...CLEAN_POLICY,
  requiresUserIDs: true,
}

const GOOGLE_AI_STUDIO_FALLBACK: DataPolicy = {
  ...CLEAN_POLICY,
  retainsPrompts: true,
  retentionDays: 55,
  requiresUserIDs: false,
}

const OPENAI_ALIASES = ['openai']
const AZURE_ALIASES = ['azure', 'microsoftazure']
const ANTHROPIC_ALIASES = ['anthropic']
const BEDROCK_ALIASES = ['amazonbedrock', 'awsbedrock', 'bedrock', 'amazon']
const GOOGLE_VERTEX_ALIASES = ['googlevertex', 'vertex', 'googlecloudvertex']
const GOOGLE_AI_STUDIO_ALIASES = ['googleaistudio', 'aistudio', 'generativelanguage']
const GOOGLE_AMBIGUOUS_ALIASES = ['google']
const OSS_HOST_ALIASES = [
  'deepinfra',
  'together',
  'togetherai',
  'novita',
  'novitaai',
  'parasail',
  'fireworks',
  'fireworksai',
]

export function fallbackDataPolicyForEndpoint(
  model: string,
  endpoint: ModelEndpoint,
): DataPolicy | undefined {
  const refs = normalizedRefs(endpoint)
  if (refs.some((ref) => OSS_HOST_ALIASES.includes(ref))) return CLEAN_POLICY

  if (isOpenAiFamily(model)) {
    if (refs.some((ref) => AZURE_ALIASES.includes(ref))) return CLEAN_POLICY
    if (refs.some((ref) => OPENAI_ALIASES.includes(ref))) return OPENAI_DIRECT_FALLBACK
  }

  if (isAnthropicFamily(model)) {
    if (refs.some((ref) => BEDROCK_ALIASES.includes(ref))) return CLEAN_POLICY
    if (refs.some((ref) => GOOGLE_VERTEX_ALIASES.includes(ref))) return GOOGLE_VERTEX_FALLBACK
    if (refs.some((ref) => GOOGLE_AMBIGUOUS_ALIASES.includes(ref))) return GOOGLE_VERTEX_FALLBACK
    if (refs.some((ref) => ANTHROPIC_ALIASES.includes(ref))) return ANTHROPIC_DIRECT_FALLBACK
  }

  if (isGeminiFamily(model)) {
    if (refs.some((ref) => GOOGLE_AI_STUDIO_ALIASES.includes(ref))) {
      return GOOGLE_AI_STUDIO_FALLBACK
    }
    if (refs.some((ref) => GOOGLE_VERTEX_ALIASES.includes(ref))) return GOOGLE_VERTEX_FALLBACK
    if (refs.some((ref) => GOOGLE_AMBIGUOUS_ALIASES.includes(ref))) return GOOGLE_VERTEX_FALLBACK
  }

  return undefined
}

function normalizedRefs(endpoint: ModelEndpoint): string[] {
  const refs = [
    endpoint.provider_name,
    endpoint.provider_display_name,
    endpoint.provider_slug,
    endpoint.provider_model_id,
    endpoint.id,
    ...providerPolicyLookupKeys(endpoint),
  ]
  return refs.map((ref) => normalizeRef(ref)).filter((ref): ref is string => ref !== null)
}

function normalizeRef(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalized.length > 0 ? normalized : null
}

function isOpenAiFamily(model: string): boolean {
  return model.startsWith('openai/')
}

function isAnthropicFamily(model: string): boolean {
  return model.startsWith('anthropic/')
}

function isGeminiFamily(model: string): boolean {
  return model.startsWith('google/gemini') || model.includes('/gemini-')
}
