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

import { providerRoutingRef } from './provider-identity'
import {
  allowedEffortFor,
  allowedVerbosityFor,
  FULL_EFFORT,
  FULL_VERBOSITY,
  quirksFor,
  reasoningToggleableFor,
} from './quirks'
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
  // Direct endpoint capability evidence. Absence means unknown.
  prefill?: CapabilityDescriptor['prefill']
}

function positiveCap(value: number | undefined): number | undefined {
  return value !== undefined && value > 0 ? value : undefined
}

function applyParameterQuirks(
  supportedParameters: Set<string>,
  quirks: ReturnType<typeof quirksFor>,
): void {
  if (!quirks.dropsSamplingParams) return
  supportedParameters.delete('temperature')
  supportedParameters.delete('top_p')
  supportedParameters.delete('top_k')
}

export interface EffectiveCapabilityAccumulator {
  readonly endpointCount: number
  add(endpoint: ModelEndpoint): void
  finish(): EffectiveCapability
}

export function createEffectiveCapabilityAccumulator(
  modelId: string,
  opts: { strict?: boolean; architecture?: ModelEndpoint['architecture'] } = {},
): EffectiveCapabilityAccumulator {
  const strict = opts.strict === true
  const supportedParameters = new Set<string>()
  const inputModalities = new Set(opts.architecture?.input_modalities ?? [])
  const outputModalities = new Set(opts.architecture?.output_modalities ?? [])
  let endpointCount = 0
  let contextLength: number | undefined
  let maxPromptTokens: number | undefined
  let maxCompletionTokens: number | undefined
  let supportsImplicitCaching = true
  let promptPriceMin: number | undefined
  let promptPriceMax: number | undefined
  let completionPriceMin: number | undefined
  let completionPriceMax: number | undefined
  let singleProviderPin: string | undefined
  let finished = false

  const aggregateCap = (current: number | undefined, value: number | undefined) => {
    if (value === undefined) return current
    if (current === undefined) return value
    return strict ? Math.min(current, value) : Math.max(current, value)
  }
  const aggregatePrice = (
    value: string | undefined,
    min: number | undefined,
    max: number | undefined,
  ): readonly [number | undefined, number | undefined] => {
    if (value === undefined) return [min, max]
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return [min, max]
    return [
      min === undefined ? parsed : Math.min(min, parsed),
      max === undefined ? parsed : Math.max(max, parsed),
    ]
  }

  return {
    get endpointCount() {
      return endpointCount
    },
    add(endpoint) {
      if (finished) throw new Error('EffectiveCapabilityAccumulatorFinished')
      if (strict) {
        if (endpointCount === 0) {
          for (const parameter of endpoint.supported_parameters) {
            supportedParameters.add(parameter)
          }
        } else {
          const next = new Set(endpoint.supported_parameters)
          for (const parameter of supportedParameters) {
            if (!next.has(parameter)) supportedParameters.delete(parameter)
          }
        }
      } else {
        for (const parameter of endpoint.supported_parameters) supportedParameters.add(parameter)
      }
      for (const modality of endpoint.architecture?.input_modalities ?? []) {
        inputModalities.add(modality)
      }
      for (const modality of endpoint.architecture?.output_modalities ?? []) {
        outputModalities.add(modality)
      }
      contextLength = aggregateCap(contextLength, positiveCap(endpoint.context_length))
      maxPromptTokens = aggregateCap(maxPromptTokens, positiveCap(endpoint.max_prompt_tokens))
      maxCompletionTokens = aggregateCap(
        maxCompletionTokens,
        positiveCap(endpoint.max_completion_tokens),
      )
      supportsImplicitCaching &&= endpoint.supports_implicit_caching === true
      ;[promptPriceMin, promptPriceMax] = aggregatePrice(
        endpoint.pricing.prompt,
        promptPriceMin,
        promptPriceMax,
      )
      ;[completionPriceMin, completionPriceMax] = aggregatePrice(
        endpoint.pricing.completion,
        completionPriceMin,
        completionPriceMax,
      )
      endpointCount += 1
      singleProviderPin = endpointCount === 1 ? providerRoutingRef(endpoint) : undefined
    },
    finish() {
      if (finished) throw new Error('EffectiveCapabilityAccumulatorFinished')
      finished = true
      const quirks = quirksFor(modelId)
      applyParameterQuirks(supportedParameters, quirks)
      const cap: EffectiveCapability = {
        supportedParameters,
        allowedEffort: allowedEffortFor(modelId),
        allowedVerbosity: allowedVerbosityFor(modelId),
        inputModalities,
        outputModalities,
        supportsImplicitCaching: endpointCount > 0 && supportsImplicitCaching,
        quirks,
      }
      if (contextLength !== undefined) cap.contextLength = contextLength
      if (maxPromptTokens !== undefined) cap.maxPromptTokens = maxPromptTokens
      if (maxCompletionTokens !== undefined) cap.maxCompletionTokens = maxCompletionTokens
      if (promptPriceMin !== undefined || completionPriceMin !== undefined) {
        cap.pricingMin = {
          ...(promptPriceMin !== undefined ? { prompt: promptPriceMin } : {}),
          ...(completionPriceMin !== undefined ? { completion: completionPriceMin } : {}),
        }
      }
      if (
        promptPriceMin !== undefined ||
        promptPriceMax !== undefined ||
        completionPriceMin !== undefined ||
        completionPriceMax !== undefined
      ) {
        cap.pricingRange = {
          ...(promptPriceMin !== undefined && promptPriceMax !== undefined
            ? { prompt: { min: promptPriceMin, max: promptPriceMax } }
            : {}),
          ...(completionPriceMin !== undefined && completionPriceMax !== undefined
            ? { completion: { min: completionPriceMin, max: completionPriceMax } }
            : {}),
        }
      }
      if (singleProviderPin !== undefined) cap.singleProviderPin = singleProviderPin
      return cap
    },
  }
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
  const accumulator = createEffectiveCapabilityAccumulator(modelId, opts)
  for (const endpoint of endpoints) accumulator.add(endpoint)
  return accumulator.finish()
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
  applyParameterQuirks(supportedParameters, q)
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
  if (descriptor.prefill) cap.prefill = descriptor.prefill
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

// Validation result for a ChatSettings snapshot against an effective cap.
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
const SAMPLING_PARAMETER_WIRE_KEYS: Readonly<Record<SamplingKey, string>> = Object.freeze({
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
})

export function samplingParameterWireKey(key: string): string {
  return key in SAMPLING_PARAMETER_WIRE_KEYS
    ? SAMPLING_PARAMETER_WIRE_KEYS[key as SamplingKey]
    : key
}

function isSamplingKey(k: string): k is SamplingKey {
  return k in SAMPLING_PARAMETER_WIRE_KEYS
}

// Drop any snapshot sampling key not in supportedParameters; clamp enum values
// that fell out of the allowed sets; clamp numeric caps. Callers use the
// returned copy as a request/UI projection and do not overwrite the durable
// preference reservoir merely because a capability was observed.
export function validateChatSettings(
  stored: ChatSettings,
  cap: EffectiveCapability,
): ValidationResult {
  const issues: ValidationIssue[] = []
  let changed = false
  const nextSampling: Partial<Record<SamplingKey, number>> = { ...stored.sampling }
  for (const key of Object.keys(stored.sampling)) {
    if (!isSamplingKey(key)) continue
    const wire = SAMPLING_PARAMETER_WIRE_KEYS[key]
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

  if (stored.reasoning.mode === 'off' && stored.model && !reasoningToggleableFor(stored.model)) {
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
