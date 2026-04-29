// Effective-capability resolver + stored-settings validator. See
// `plan/07-discovery.md §7.2` (step 5) and `§7.6` for the non-OpenRouter
// fallback.
//
// Inputs:
// - For OpenRouter: `ModelEndpoint[]` from `/endpoints`, filtered by user's
//   provider prefs (only / ignore). Privacy filtering happens elsewhere
//   (Phase 10); this resolver just takes whatever survived.
// - For non-OpenRouter: a bundled `CapabilityDescriptor` row from the table
//   loader, possibly overridden by `ConnectionProfile.capabilityOverrides`.
//
// Output: `EffectiveCapability` — the union of controls the UI should
// render plus the numeric caps for sliders. Intersection over union is the
// correct lower bound when `allow_fallbacks: true` can route the request to
// any retained endpoint (see §7.2 rationale); pinning a single endpoint
// uses that endpoint's set directly.

import {
  allowedEffortFor,
  allowedVerbosityFor,
  FULL_EFFORT,
  FULL_VERBOSITY,
  quirksFor,
  reasoningToggleableFor,
} from './quirks'
import { providerRoutingRef } from './provider-identity'
import type {
  CapabilityDescriptor,
  ChatSettings,
  EffortLevel,
  ModelEndpoint,
  SamplingKey,
  VerbosityLevel,
} from './types'

export interface EffectiveCapability {
  // Set of top-level parameter keys the UI may render a control for.
  supportedParameters: Set<string>
  // Narrowed enum values from the quirks registry.
  allowedEffort: readonly EffortLevel[]
  allowedVerbosity: readonly VerbosityLevel[]
  // Numeric caps across retained endpoints.
  contextLength?: number
  maxPromptTokens?: number
  maxCompletionTokens?: number
  // Min price across retained endpoints.
  pricingMin?: { prompt?: number; completion?: number }
  // Pricing range for tooltips.
  pricingRange?: {
    prompt?: { min: number; max: number }
    completion?: { min: number; max: number }
  }
  // Aggregated input/output modalities.
  inputModalities: Set<string>
  outputModalities: Set<string>
  // `true` iff all retained endpoints set `supports_implicit_caching: true`.
  supportsImplicitCaching: boolean
  // When exactly one endpoint was retained (user pinned), provider-specific
  // fields are safe to show.
  singleProviderPin?: string
  // Passthrough quirks for the UI.
  quirks: ReturnType<typeof quirksFor>
}

function minDefined(values: Array<number | undefined>): number | undefined {
  let min: number | undefined
  for (const v of values) {
    if (v === undefined) continue
    if (min === undefined || v < min) min = v
  }
  return min
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  let max: number | undefined
  for (const v of values) {
    if (v === undefined) continue
    if (max === undefined || v > max) max = v
  }
  return max
}

function positiveCap(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined
}

function intersectStringArrays(lists: Array<readonly string[]>): Set<string> {
  if (lists.length === 0) return new Set()
  const first = lists[0]
  if (!first) return new Set()
  const out = new Set<string>(first)
  for (let i = 1; i < lists.length; i += 1) {
    const next = new Set(lists[i])
    for (const item of out) {
      if (!next.has(item)) out.delete(item)
    }
  }
  return out
}

function unionStringArrays(lists: Array<readonly string[]>): Set<string> {
  const out = new Set<string>()
  for (const list of lists) for (const item of list) out.add(item)
  return out
}

function collectModalities(
  endpoints: ModelEndpoint[],
  kind: 'input_modalities' | 'output_modalities',
  fallbackArchitecture?: ModelEndpoint['architecture'],
): Set<string> {
  const out = new Set<string>()
  for (const m of fallbackArchitecture?.[kind] ?? []) out.add(m)
  for (const ep of endpoints) {
    const arr = ep.architecture?.[kind]
    if (!arr) continue
    for (const m of arr) out.add(m)
  }
  return out
}

function pricingRange(
  endpoints: ModelEndpoint[],
  key: 'prompt' | 'completion',
): { min: number; max: number } | undefined {
  const nums: number[] = []
  for (const ep of endpoints) {
    const raw = ep.pricing?.[key]
    if (raw === undefined) continue
    const n = Number(raw)
    if (Number.isFinite(n)) nums.push(n)
  }
  if (nums.length === 0) return undefined
  return { min: Math.min(...nums), max: Math.max(...nums) }
}

// Resolve capabilities from a set of /endpoints rows (OpenRouter). The
// default is the UNION (upper bound) — the UI renders every control some
// retained provider could answer for. Providers that don't support a field
// ignore it at send time. When `strict` is true, the resolver falls back to
// the INTERSECTION (lower bound): only show / send parameters ALL retained
// providers support; combined with `require_parameters: true` this forces
// routing to providers that honour every set option. `endpoints.length === 1`
// collapses both modes to that single row's set.
export function effectiveCapabilityFromEndpoints(
  modelId: string,
  endpoints: ModelEndpoint[],
  opts: { strict?: boolean; architecture?: ModelEndpoint['architecture'] } = {},
): EffectiveCapability {
  const supportedLists = endpoints.map((e) => e.supported_parameters)
  const supportedParameters = opts.strict
    ? intersectStringArrays(supportedLists)
    : unionStringArrays(supportedLists)
  const inputModalities = collectModalities(endpoints, 'input_modalities', opts.architecture)
  const outputModalities = collectModalities(endpoints, 'output_modalities', opts.architecture)
  // Upper bound: expose the largest context / completion caps across
  // retained providers, so the user's sliders go as high as any provider
  // can accommodate. In strict mode the intersection-caller narrows the
  // provider set first; without strict, OpenRouter's fallback routing
  // skips providers that can't handle the requested values.
  const numericAgg = opts.strict ? minDefined : maxDefined
  const contextLength = numericAgg(endpoints.map((e) => positiveCap(e.context_length)))
  const maxPromptTokens = numericAgg(endpoints.map((e) => positiveCap(e.max_prompt_tokens)))
  const maxCompletionTokens = numericAgg(
    endpoints.map((e) => positiveCap(e.max_completion_tokens)),
  )
  const supportsImplicitCaching =
    endpoints.length > 0 && endpoints.every((e) => e.supports_implicit_caching === true)
  const pr = pricingRange(endpoints, 'prompt')
  const pc = pricingRange(endpoints, 'completion')
  const pricingMin: { prompt?: number; completion?: number } = {}
  if (pr) pricingMin.prompt = pr.min
  if (pc) pricingMin.completion = pc.min
  const pricingRangeObj: {
    prompt?: { min: number; max: number }
    completion?: { min: number; max: number }
  } = {}
  if (pr) pricingRangeObj.prompt = pr
  if (pc) pricingRangeObj.completion = pc
  const q = quirksFor(modelId)
  const cap: EffectiveCapability = {
    supportedParameters,
    allowedEffort: allowedEffortFor(modelId),
    allowedVerbosity: allowedVerbosityFor(modelId),
    inputModalities,
    outputModalities,
    supportsImplicitCaching,
    quirks: q,
  }
  if (contextLength !== undefined) cap.contextLength = contextLength
  if (maxPromptTokens !== undefined) cap.maxPromptTokens = maxPromptTokens
  if (maxCompletionTokens !== undefined) cap.maxCompletionTokens = maxCompletionTokens
  if (Object.keys(pricingMin).length > 0) cap.pricingMin = pricingMin
  if (Object.keys(pricingRangeObj).length > 0) cap.pricingRange = pricingRangeObj
  if (endpoints.length === 1 && endpoints[0]) cap.singleProviderPin = providerRoutingRef(endpoints[0])
  return cap
}

// Resolve from a bundled descriptor (non-OpenRouter or unknown OR model).
export function effectiveCapabilityFromDescriptor(
  modelId: string,
  descriptor: CapabilityDescriptor,
): EffectiveCapability {
  const supportedParameters = new Set(descriptor.supportedParameters)
  const inputModalities = new Set(descriptor.architecture?.inputModalities ?? ['text'])
  const outputModalities = new Set(descriptor.architecture?.outputModalities ?? ['text'])
  const q = quirksFor(modelId)
  const cap: EffectiveCapability = {
    supportedParameters,
    allowedEffort: allowedEffortFor(modelId),
    allowedVerbosity: allowedVerbosityFor(modelId),
    inputModalities,
    outputModalities,
    supportsImplicitCaching: false,
    quirks: q,
  }
  const contextLength = positiveCap(descriptor.contextLength)
  const maxPromptTokens = positiveCap(descriptor.maxPromptTokens)
  const maxCompletionTokens = positiveCap(descriptor.maxCompletionTokens)
  if (contextLength !== undefined) cap.contextLength = contextLength
  if (maxPromptTokens !== undefined) cap.maxPromptTokens = maxPromptTokens
  if (maxCompletionTokens !== undefined) cap.maxCompletionTokens = maxCompletionTokens
  const promptPrice = Number(descriptor.pricing?.prompt)
  const completionPrice = Number(descriptor.pricing?.completion)
  if (Number.isFinite(promptPrice) || Number.isFinite(completionPrice)) {
    const pm: { prompt?: number; completion?: number } = {}
    if (Number.isFinite(promptPrice)) pm.prompt = promptPrice
    if (Number.isFinite(completionPrice)) pm.completion = completionPrice
    cap.pricingMin = pm
  }
  return cap
}

// Validation result for the stored ChatSettings against an effective cap.
interface ValidationIssue {
  kind: 'dropped-param' | 'clamped-enum' | 'clamped-numeric'
  field: string
  reason: string
  previous?: unknown
  replacement?: unknown
}

interface ValidationResult {
  settings: ChatSettings
  issues: ValidationIssue[]
  changed: boolean
}

// Numeric and enum fields the validator knows how to clamp.
const SAMPLING_PARAM_WIRE: Record<SamplingKey, string> = {
  temperature: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  min_p: 'min_p',
  top_a: 'top_a',
  frequency_penalty: 'frequency_penalty',
  presence_penalty: 'presence_penalty',
  repetition_penalty: 'repetition_penalty',
  seed: 'seed',
  logprobs: 'logprobs',
  top_logprobs: 'top_logprobs',
  typical_p: 'typical_p',
  repeat_penalty: 'repeat_penalty',
  repeat_last_n: 'repeat_last_n',
  dynatemp_range: 'dynatemp_range',
  dynatemp_exponent: 'dynatemp_exponent',
  mirostat: 'mirostat',
  mirostat_tau: 'mirostat_tau',
  mirostat_eta: 'mirostat_eta',
  xtc_probability: 'xtc_probability',
  xtc_threshold: 'xtc_threshold',
  dry_multiplier: 'dry_multiplier',
  dry_base: 'dry_base',
  dry_allowed_length: 'dry_allowed_length',
  dry_penalty_last_n: 'dry_penalty_last_n',
  n_keep: 'n_keep',
}

function isSamplingKey(k: string): k is SamplingKey {
  return k in SAMPLING_PARAM_WIRE
}

// Drop any stored sampling key not in supportedParameters; clamp enum values
// that fell out of the allowed sets; clamp numeric caps. Returns an updated
// ChatSettings plus a list of user-visible issues.
export function validateChatSettings(
  stored: ChatSettings,
  cap: EffectiveCapability,
): ValidationResult {
  const issues: ValidationIssue[] = []
  let changed = false
  const nextSampling: Partial<Record<SamplingKey, number>> = { ...stored.sampling }
  for (const key of Object.keys(stored.sampling)) {
    if (!isSamplingKey(key)) continue
    const wire = SAMPLING_PARAM_WIRE[key]
    if (!cap.supportedParameters.has(wire)) {
      issues.push({
        kind: 'dropped-param',
        field: `sampling.${key}`,
        reason: `${key} is not supported by the current model`,
        previous: stored.sampling[key],
      })
      delete nextSampling[key]
      changed = true
    }
  }

  // Reasoning effort narrowing.
  let nextReasoning = stored.reasoning
  if (stored.reasoning.effort !== undefined) {
    const allowed = cap.allowedEffort
    if (allowed.length > 0 && !allowed.includes(stored.reasoning.effort)) {
      const replacement = pickClosestEnum<EffortLevel>(
        stored.reasoning.effort,
        allowed,
        FULL_EFFORT,
      )
      issues.push({
        kind: 'clamped-enum',
        field: 'reasoning.effort',
        reason: `${stored.reasoning.effort} unsupported; clamped to ${replacement}`,
        previous: stored.reasoning.effort,
        replacement,
      })
      nextReasoning = { ...stored.reasoning, effort: replacement }
      changed = true
    } else if (allowed.length === 0 && cap.quirks.adaptiveReasoningOnly) {
      // Adaptive-only: drop effort entirely so the request is clean.
      const { effort: _effort, ...rest } = stored.reasoning
      nextReasoning = rest
      issues.push({
        kind: 'dropped-param',
        field: 'reasoning.effort',
        reason: 'model uses adaptive reasoning; effort ignored',
        previous: stored.reasoning.effort,
      })
      changed = true
    }
  }

  if (
    stored.reasoning.mode === 'off' &&
    stored.model &&
    !reasoningToggleableFor(stored.model)
  ) {
    nextReasoning = { ...nextReasoning, mode: 'enabled' }
    issues.push({
      kind: 'clamped-enum',
      field: 'reasoning.mode',
      reason: 'model requires reasoning; off is not supported',
      previous: stored.reasoning.mode,
      replacement: 'enabled',
    })
    changed = true
  }

  // Verbosity narrowing.
  let nextVerbosity = stored.verbosity
  if (stored.verbosity !== undefined) {
    if (!cap.supportedParameters.has('verbosity')) {
      issues.push({
        kind: 'dropped-param',
        field: 'verbosity',
        reason: 'verbosity not supported by current model',
        previous: stored.verbosity,
      })
      nextVerbosity = undefined
      changed = true
    } else {
      const allowed = cap.allowedVerbosity
      if (allowed.length > 0 && !allowed.includes(stored.verbosity)) {
        const replacement = pickClosestEnum<VerbosityLevel>(
          stored.verbosity,
          allowed,
          FULL_VERBOSITY,
        )
        issues.push({
          kind: 'clamped-enum',
          field: 'verbosity',
          reason: `${stored.verbosity} unsupported; clamped to ${replacement}`,
          previous: stored.verbosity,
          replacement,
        })
        nextVerbosity = replacement
        changed = true
      }
    }
  }

  // Max completion tokens cap.
  let nextMaxCompletion = stored.maxCompletionTokens
  if (
    stored.maxCompletionTokens !== undefined &&
    cap.maxCompletionTokens !== undefined &&
    stored.maxCompletionTokens > cap.maxCompletionTokens
  ) {
    issues.push({
      kind: 'clamped-numeric',
      field: 'maxCompletionTokens',
      reason: `exceeds cap of ${cap.maxCompletionTokens}`,
      previous: stored.maxCompletionTokens,
      replacement: cap.maxCompletionTokens,
    })
    nextMaxCompletion = cap.maxCompletionTokens
    changed = true
  }

  // Response format requires `response_format` in the supported list.
  let nextResponseFormat = stored.responseFormat
  if (stored.responseFormat && !cap.supportedParameters.has('response_format')) {
    issues.push({
      kind: 'dropped-param',
      field: 'responseFormat',
      reason: 'response_format not supported by current model',
      previous: stored.responseFormat,
    })
    nextResponseFormat = undefined
    changed = true
  }

  // logit_bias: drop if unsupported.
  let nextLogitBias = stored.logitBias
  if (stored.logitBias && !cap.supportedParameters.has('logit_bias')) {
    issues.push({
      kind: 'dropped-param',
      field: 'logitBias',
      reason: 'logit_bias not supported by current model',
      previous: stored.logitBias,
    })
    nextLogitBias = undefined
    changed = true
  }

  if (!changed) return { settings: stored, issues, changed: false }

  const next: ChatSettings = {
    ...stored,
    sampling: nextSampling,
    reasoning: nextReasoning,
    ...(nextVerbosity !== undefined ? { verbosity: nextVerbosity } : {}),
    ...(nextMaxCompletion !== undefined ? { maxCompletionTokens: nextMaxCompletion } : {}),
    ...(nextResponseFormat !== undefined ? { responseFormat: nextResponseFormat } : {}),
    ...(nextLogitBias !== undefined ? { logitBias: nextLogitBias } : {}),
  }
  if (nextVerbosity === undefined) delete (next as { verbosity?: unknown }).verbosity
  if (nextMaxCompletion === undefined) {
    delete (next as { maxCompletionTokens?: unknown }).maxCompletionTokens
  }
  if (nextResponseFormat === undefined) {
    delete (next as { responseFormat?: unknown }).responseFormat
  }
  if (nextLogitBias === undefined) delete (next as { logitBias?: unknown }).logitBias
  return { settings: next, issues, changed: true }
}

// When clamping an enum to a narrower set, pick the value whose position in
// the global superset is closest to the original, so "xhigh" clamped
// against [low, medium, high] lands on "high", not "low".
function pickClosestEnum<T extends string>(
  previous: T,
  allowed: readonly T[],
  superset: readonly T[],
): T {
  const idxPrev = superset.indexOf(previous)
  if (idxPrev < 0) {
    const first = allowed[0]
    if (first === undefined) {
      throw new Error('pickClosestEnum: allowed list is empty')
    }
    return first
  }
  let best = allowed[0] as T
  let bestDist = Number.POSITIVE_INFINITY
  for (const candidate of allowed) {
    const idx = superset.indexOf(candidate)
    if (idx < 0) continue
    const dist = Math.abs(idx - idxPrev)
    if (dist < bestDist) {
      bestDist = dist
      best = candidate
    }
  }
  return best
}
