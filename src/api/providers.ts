// OpenRouter `/endpoints` + `/models` response normalizers.
//
// Wire payloads are snake_case and can include fields we don't care about.
// We normalize to a compact TypeScript shape defined in `src/core/types.ts`
// (`ModelEndpoint`, `ModelListEntry`) so downstream consumers don't have to
// defensively check random fields.
//
// Non-OpenRouter `/v1/models` responses are OpenAI-compatible bare lists:
// `{ data: [{ id, object, created, owned_by }, ...] }`. No capability data —
// we merge with bundled capability tables in the hooks layer.

import type { ModelEndpoint, PercentileBucket } from '../core/types'
import { normalizeDataPolicy } from './privacy-scrape'

export interface ModelListEntry {
  id: string
  canonicalSlug?: string
  name?: string
  description?: string
  created?: number
  contextLength?: number
  architecture?: {
    inputModalities?: string[]
    outputModalities?: string[]
    tokenizer?: string
  }
  pricing?: Record<string, string | undefined>
  topProvider?: Record<string, unknown>
  perRequestLimits?: Record<string, unknown>
  supportedParameters?: string[]
  defaultParameters?: Record<string, number>
  expirationDate?: string
  knowledgeCutoff?: string
  huggingFaceId?: string
  links?: { details?: string }
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  for (const item of v) {
    if (typeof item === 'string') out.push(item)
  }
  return out.length ? out : undefined
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>
  }
  return undefined
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function normalizePricing(v: unknown): Record<string, string | undefined> | undefined {
  const obj = asRecord(v)
  if (!obj) return undefined
  const out: Record<string, string | undefined> = {}
  let found = false
  for (const [k, val] of Object.entries(obj)) {
    if (typeof val === 'string' || typeof val === 'number') {
      out[k] = String(val)
      found = true
    }
  }
  return found ? out : undefined
}

function normalizePercentile(v: unknown): PercentileBucket | undefined {
  const obj = asRecord(v)
  if (!obj) return undefined
  const out: PercentileBucket = {}
  let found = false
  for (const key of ['p50', 'p75', 'p90', 'p99'] as const) {
    const n = asNumber(obj[key])
    if (n !== undefined) {
      out[key] = n
      found = true
    }
  }
  return found ? out : undefined
}

function normalizeArchitecture(v: unknown): ModelEndpoint['architecture'] | undefined {
  const obj = asRecord(v)
  if (!obj) return undefined
  const out: NonNullable<ModelEndpoint['architecture']> = {}
  const im = asStringArray(obj.input_modalities) ?? asStringArray(obj.inputModalities)
  const om = asStringArray(obj.output_modalities) ?? asStringArray(obj.outputModalities)
  const tok = asString(obj.tokenizer)
  if (im) out.input_modalities = im
  if (om) out.output_modalities = om
  if (tok) out.tokenizer = tok
  return Object.keys(out).length > 0 ? out : undefined
}

// Normalize one endpoint row from the /endpoints payload.
export function normalizeEndpoint(raw: unknown): ModelEndpoint | null {
  const obj = asRecord(raw)
  if (!obj) return null
  const provider_name = asString(obj.provider_name)
  const supported_parameters = asStringArray(obj.supported_parameters)
  const context_length = asNumber(obj.context_length)
  if (!provider_name || !supported_parameters || context_length === undefined) {
    return null
  }
  const endpoint: ModelEndpoint = {
    provider_name,
    supported_parameters,
    context_length,
    pricing: normalizePricing(obj.pricing) ?? {},
  }
  const id = asString(obj.id)
  if (id) endpoint.id = id
  const providerDisplayName = asString(obj.provider_display_name) ?? asString(asRecord(obj.provider_info)?.displayName)
  if (providerDisplayName) endpoint.provider_display_name = providerDisplayName
  const providerSlug =
    asString(obj.provider_slug) ??
    asString(obj.tag) ??
    asString(asRecord(obj.provider_info)?.slug)
  if (providerSlug) endpoint.provider_slug = providerSlug
  const providerModelId = asString(obj.provider_model_id)
  if (providerModelId) endpoint.provider_model_id = providerModelId
  const rawPolicy = asRecord(obj.data_policy) ?? asRecord(asRecord(obj.provider_info)?.dataPolicy)
  const dataPolicy = rawPolicy ? normalizeDataPolicy(rawPolicy) : null
  if (dataPolicy) endpoint.data_policy = dataPolicy
  const mpt = asNumber(obj.max_prompt_tokens)
  if (mpt !== undefined) endpoint.max_prompt_tokens = mpt
  const mct = asNumber(obj.max_completion_tokens)
  if (mct !== undefined) endpoint.max_completion_tokens = mct
  const sic = obj.supports_implicit_caching
  if (typeof sic === 'boolean') endpoint.supports_implicit_caching = sic
  const q = asString(obj.quantization)
  if (q) endpoint.quantization = q
  const status = asString(obj.status)
  if (status) endpoint.status = status
  const u5 = asNumber(obj.uptime_last_5m)
  if (u5 !== undefined) endpoint.uptime_last_5m = u5
  const u30 = asNumber(obj.uptime_last_30m)
  if (u30 !== undefined) endpoint.uptime_last_30m = u30
  const u1d = asNumber(obj.uptime_last_1d)
  if (u1d !== undefined) endpoint.uptime_last_1d = u1d
  const lat = normalizePercentile(obj.latency_last_30m)
  if (lat) endpoint.latency_last_30m = lat
  const through = asRecord(obj.throughput_last_30m)
  if (through) endpoint.throughput_last_30m = through
  const arch = normalizeArchitecture(obj.architecture)
  if (arch) endpoint.architecture = arch
  return endpoint
}

export interface EndpointsDescriptor {
  modelId: string
  name?: string
  description?: string
  contextLength?: number
  architecture?: ModelEndpoint['architecture']
  endpoints: ModelEndpoint[]
}

// Normalize an /endpoints response. OpenRouter wraps the payload in `data`;
// some compatible gateways skip the envelope.
export function normalizeEndpointsResponse(raw: unknown): EndpointsDescriptor | null {
  let root = asRecord(raw)
  if (!root) return null
  const dataField = asRecord(root.data)
  if (dataField) root = dataField
  const modelId = asString(root.id) ?? asString(root.canonical_slug)
  if (!modelId) return null
  const rawEndpoints = root.endpoints
  const endpoints: ModelEndpoint[] = []
  if (Array.isArray(rawEndpoints)) {
    for (const row of rawEndpoints) {
      const normalized = normalizeEndpoint(row)
      if (normalized) endpoints.push(normalized)
    }
  }
  const out: EndpointsDescriptor = { modelId, endpoints }
  const name = asString(root.name)
  if (name) out.name = name
  const description = asString(root.description)
  if (description) out.description = description
  const cl = asNumber(root.context_length)
  if (cl !== undefined) out.contextLength = cl
  const arch = normalizeArchitecture(root.architecture)
  if (arch) out.architecture = arch
  return out
}

// Normalize an /models response (OpenRouter or OpenAI-compatible bare list).
// OpenRouter rows include capability data; OpenAI-compat rows include just
// `{ id, object, created, owned_by }` which leaves capability fields empty —
// callers merge with bundled capability tables.
export function normalizeModelsResponse(raw: unknown): ModelListEntry[] {
  const root = asRecord(raw)
  if (!root) return []
  const data = root.data
  if (!Array.isArray(data)) return []
  const out: ModelListEntry[] = []
  for (const row of data) {
    const obj = asRecord(row)
    if (!obj) continue
    const id = asString(obj.id)
    if (!id) continue
    const entry: ModelListEntry = { id }
    const slug = asString(obj.canonical_slug)
    if (slug) entry.canonicalSlug = slug
    const name = asString(obj.name)
    if (name) entry.name = name
    const description = asString(obj.description)
    if (description) entry.description = description
    const created = asNumber(obj.created)
    if (created !== undefined) entry.created = created
    // OpenRouter returns `context_length` at the top level; llama.cpp /v1/models
    // tucks it under `meta.n_ctx_train` (training context); Ollama uses
    // `model_info.general.context_length` or similar. Try each so local
    // servers get a real numeric cap instead of the permissive default.
    let cl = asNumber(obj.context_length)
    if (cl === undefined) {
      const meta = asRecord(obj.meta)
      cl = asNumber(meta?.n_ctx_train) ?? asNumber(meta?.n_ctx)
    }
    if (cl === undefined) {
      const mi = asRecord(obj.model_info)
      cl = asNumber(mi?.context_length)
    }
    if (cl !== undefined) entry.contextLength = cl
    const arch = asRecord(obj.architecture)
    if (arch) {
      const normalized: NonNullable<ModelListEntry['architecture']> = {}
      const im = asStringArray(arch.input_modalities)
      const om = asStringArray(arch.output_modalities)
      const tok = asString(arch.tokenizer)
      if (im) normalized.inputModalities = im
      if (om) normalized.outputModalities = om
      if (tok) normalized.tokenizer = tok
      if (Object.keys(normalized).length > 0) entry.architecture = normalized
    }
    const pricing = normalizePricing(obj.pricing)
    if (pricing) entry.pricing = pricing
    const tp = asRecord(obj.top_provider)
    if (tp) entry.topProvider = tp
    const prl = asRecord(obj.per_request_limits)
    if (prl) entry.perRequestLimits = prl
    const sp = asStringArray(obj.supported_parameters)
    if (sp) entry.supportedParameters = sp
    const dp = asRecord(obj.default_parameters)
    if (dp) {
      const numericDefaults: Record<string, number> = {}
      for (const [k, v] of Object.entries(dp)) {
        const n = asNumber(v)
        if (n !== undefined) numericDefaults[k] = n
      }
      if (Object.keys(numericDefaults).length > 0) entry.defaultParameters = numericDefaults
    }
    const exp = asString(obj.expiration_date)
    if (exp) entry.expirationDate = exp
    const kc = asString(obj.knowledge_cutoff)
    if (kc) entry.knowledgeCutoff = kc
    const hf = asString(obj.hugging_face_id)
    if (hf) entry.huggingFaceId = hf
    const links = asRecord(obj.links)
    if (links) {
      const details = asString(links.details)
      if (details) entry.links = { details }
    }
    out.push(entry)
  }
  return out
}
