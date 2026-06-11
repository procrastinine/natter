// Structural model-identity helpers for capability / quirk matching only.
//
// These helpers intentionally collapse OpenRouter routing variants like
// `:free` / `:thinking` so cross-provider model aliases land on one shared
// structural key. They are NOT the authority for exact model selection:
// privacy cache keys, provider routing, and the wire `model` field must keep
// using the raw model id so variant-specific behavior remains distinct.

import crosswalkJson from '../capabilities/provider_model_crosswalk.json'
import tokenizerFamiliesJson from '../capabilities/tokenizer_families.json'

interface ProviderModelCrosswalkRow {
  openrouter: string[]
  openai: string[]
  anthropic: string[]
  google: string[]
}

interface ProviderModelCrosswalkFile {
  crosswalk: ProviderModelCrosswalkRow[]
}

interface TokenizerFamilyRow {
  key: string
  canonicalModelKeys: string[]
}

interface TokenizerFamiliesFile {
  families: TokenizerFamilyRow[]
}

const CROSSWALK_PROVIDER_PRIORITY = ['openrouter', 'openai', 'google', 'anthropic'] as const
const OFFICIAL_PROVIDER_PRIORITY = ['openai', 'google', 'anthropic'] as const

const CROSSWALK_ROWS = (crosswalkJson as ProviderModelCrosswalkFile).crosswalk
const TOKENIZER_FAMILY_ROWS = (tokenizerFamiliesJson as TokenizerFamiliesFile).families
const TOKENIZER_FAMILY_KEY_SET = new Set(TOKENIZER_FAMILY_ROWS.map((row) => row.key))

const DECORATION_PROVIDERS = new Set<string>([
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'deepseek',
  'qwen',
  'z-ai',
  'moonshotai',
  'minimax',
  'meta',
  'meta-llama',
  'mistral',
  'mistralai',
])
const DECORATION_PROVIDER_LIST = [...DECORATION_PROVIDERS]

interface DeterministicStructuralModelIdentity {
  provider: string | null
  slug: string
  compatSlug: string
  key: string
  compatKey: string
}

function stripOpenRouterVariantSuffix(modelId: string): string {
  return stripProviderResourcePrefix(modelId).replace(/:(free|thinking)$/i, '')
}

function stripProviderResourcePrefix(modelId: string): string {
  const trimmed = modelId.trim()
  return (
    trimmed.match(/^models\/(.+)$/i)?.[1] ??
    trimmed.match(/^publishers\/[^/]+\/models\/(.+)$/i)?.[1] ??
    trimmed
  )
}

function rawStructuralModelSlug(modelId: string): string {
  const withoutVariant = stripOpenRouterVariantSuffix(modelId)
  const slash = withoutVariant.indexOf('/')
  return slash >= 0 ? withoutVariant.slice(slash + 1) : withoutVariant
}

function splitCanonicalModelKey(key: string): { provider: string; slug: string } | null {
  const separator = key.indexOf(':')
  if (separator <= 0 || separator === key.length - 1) return null
  return {
    provider: key.slice(0, separator),
    slug: key.slice(separator + 1),
  }
}

function addProviderGuess(
  guesses: Map<string, string | null>,
  compatSlug: string,
  provider: string,
): void {
  const previous = guesses.get(compatSlug)
  if (previous === undefined) {
    guesses.set(compatSlug, provider)
    return
  }
  if (previous !== provider) guesses.set(compatSlug, null)
}

function compatNormalizeModelSlug(modelSlug: string): string {
  return modelSlug.replace(/(\d)[.-](\d)(?=-|$)/g, '$1:$2')
}

function softNormalizeDecoratedSlug(modelSlug: string): string {
  return modelSlug.trim().replace(/[_\s]+/g, '-')
}

function preferredCrosswalkSlug(row: ProviderModelCrosswalkRow): string | null {
  for (const provider of CROSSWALK_PROVIDER_PRIORITY) {
    const entries = row[provider]
    const preferred = entries[0]
    if (preferred) return rawStructuralModelSlug(preferred)
  }
  return null
}

function buildCrosswalkAliasMap(
  rows: readonly ProviderModelCrosswalkRow[],
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>()
  for (const row of rows) {
    const preferred = preferredCrosswalkSlug(row)
    if (!preferred) continue
    for (const provider of CROSSWALK_PROVIDER_PRIORITY) {
      const entries = row[provider]
      for (const id of entries) {
        aliases.set(compatNormalizeModelSlug(rawStructuralModelSlug(id)), preferred)
      }
    }
  }
  return aliases
}

const CROSSWALK_ALIAS_MAP = buildCrosswalkAliasMap(CROSSWALK_ROWS)

function buildKnownProviderByCompatSlug(): ReadonlyMap<string, string> {
  const guesses = new Map<string, string | null>()
  for (const row of CROSSWALK_ROWS) {
    for (const provider of OFFICIAL_PROVIDER_PRIORITY) {
      for (const id of row[provider]) {
        addProviderGuess(guesses, compatNormalizeModelSlug(rawStructuralModelSlug(id)), provider)
      }
    }
  }
  for (const row of TOKENIZER_FAMILY_ROWS) {
    for (const canonicalModelKey of row.canonicalModelKeys) {
      const parts = splitCanonicalModelKey(canonicalModelKey)
      if (!parts) continue
      addProviderGuess(guesses, compatNormalizeModelSlug(parts.slug), parts.provider)
    }
  }
  return new Map([...guesses].filter((entry): entry is [string, string] => entry[1] !== null))
}

function addCanonicalSlug(
  canonical: Map<string, string | null>,
  compatSlug: string,
  slug: string,
): void {
  const previous = canonical.get(compatSlug)
  if (previous === undefined) {
    canonical.set(compatSlug, slug)
    return
  }
  if (previous !== slug) canonical.set(compatSlug, null)
}

function buildExactCanonicalSlugByCompatSlug(): ReadonlyMap<string, string> {
  const canonical = new Map<string, string | null>()
  for (const row of CROSSWALK_ROWS) {
    const preferred = preferredCrosswalkSlug(row)
    if (preferred) addCanonicalSlug(canonical, compatNormalizeModelSlug(preferred), preferred)
  }
  for (const row of TOKENIZER_FAMILY_ROWS) {
    for (const canonicalModelKey of row.canonicalModelKeys) {
      const parts = splitCanonicalModelKey(canonicalModelKey)
      if (!parts) continue
      addCanonicalSlug(canonical, compatNormalizeModelSlug(parts.slug), parts.slug)
    }
  }
  return new Map([...canonical].filter((entry): entry is [string, string] => entry[1] !== null))
}

function buildExactTokenizerFamilyByCompatKey(): ReadonlyMap<string, string> {
  const exact = new Map<string, string>()
  for (const row of TOKENIZER_FAMILY_ROWS) {
    for (const canonicalModelKey of row.canonicalModelKeys) {
      const parts = splitCanonicalModelKey(canonicalModelKey)
      if (!parts) continue
      exact.set(`${parts.provider}:${compatNormalizeModelSlug(parts.slug)}`, row.key)
    }
  }
  return exact
}

const KNOWN_PROVIDER_BY_COMPAT_SLUG = buildKnownProviderByCompatSlug()
const EXACT_CANONICAL_SLUG_BY_COMPAT_SLUG = buildExactCanonicalSlugByCompatSlug()
const EXACT_TOKENIZER_FAMILY_BY_COMPAT_KEY = buildExactTokenizerFamilyByCompatKey()

function structuralSlugCandidates(modelSlug: string): string[] {
  const candidates = [modelSlug, softNormalizeDecoratedSlug(modelSlug)]
  const at = modelSlug.lastIndexOf('@')
  if (at <= 0) return candidates
  const decoration = modelSlug.slice(at + 1).toLowerCase()
  if (!DECORATION_PROVIDERS.has(decoration)) return candidates
  const undecorated = modelSlug.slice(0, at)
  if (undecorated) {
    candidates.unshift(undecorated)
    candidates.unshift(softNormalizeDecoratedSlug(undecorated))
  }
  return [...new Set(candidates.filter(Boolean))]
}

function leadingProviderStrippedCandidates(modelSlug: string): string[] {
  const out: string[] = []
  for (const provider of DECORATION_PROVIDER_LIST) {
    const escaped = provider.replace(/[-]/g, '\\-')
    const match = modelSlug.match(new RegExp(`^${escaped}[\\s_:.\\/-]+(.+)$`, 'i'))
    const remainder = match?.[1]
    if (!remainder) continue
    out.push(remainder)
    out.push(softNormalizeDecoratedSlug(remainder))
  }
  return [...new Set(out.filter(Boolean))]
}

function structuralLookupCandidates(modelSlug: string): string[] {
  const direct = structuralSlugCandidates(modelSlug)
  const leadingStripped = leadingProviderStrippedCandidates(modelSlug)
  return [...new Set([...direct, ...leadingStripped])]
}

function preferredStructuralCandidate(modelSlug: string): string {
  const raw = rawStructuralModelSlug(modelSlug)
  for (const candidate of structuralLookupCandidates(raw)) {
    const exactCanonical = exactKnownCanonicalSlugFromSlug(candidate)
    if (exactCanonical) return exactCanonical
    const exactAlias = CROSSWALK_ALIAS_MAP.get(compatNormalizeModelSlug(candidate))
    if (exactAlias) return exactAlias
    if (candidate !== raw && guessStructuralProvider(candidate)) return candidate
  }
  return CROSSWALK_ALIAS_MAP.get(compatNormalizeModelSlug(raw)) ?? raw
}

function preferredProviderHintFromDecoratedSlug(modelSlug: string): string | null {
  for (const provider of DECORATION_PROVIDER_LIST) {
    const escaped = provider.replace(/[-]/g, '\\-')
    if (new RegExp(`^${escaped}[\\s_:.\\/-]+.+$`, 'i').test(modelSlug)) return provider
  }
  return null
}

const FAMILY_GUESS_RULES: ReadonlyArray<{ match: RegExp; provider: string; familyKey?: string }> =
  Object.freeze([
    { match: /^claude(?:-|$)/i, provider: 'anthropic' },
    { match: /^gemma-3(?:n)?(?:-|$)/i, provider: 'google', familyKey: 'google:gemma3' },
    { match: /^gemma-4(?:-|$)/i, provider: 'google', familyKey: 'google:gemma4' },
    {
      match: /^deep-research-pro-preview(?:-|$)/i,
      provider: 'google',
      familyKey: 'google:gemma3',
    },
    { match: /^deepseek-v4(?:-|$)/i, provider: 'deepseek', familyKey: 'oss:deepseek-v4' },
    { match: /^deepseek(?:-|$)/i, provider: 'deepseek' },
    { match: /^qwen3\.6(?:-|$)/i, provider: 'qwen', familyKey: 'oss:qwen3.5-bpe' },
    { match: /^(?:qwen|qwq)(?:-|$)/i, provider: 'qwen' },
    { match: /^glm(?:-|$)/i, provider: 'z-ai' },
    { match: /^kimi(?:-|$)/i, provider: 'moonshotai' },
    { match: /^minimax(?:-|$)/i, provider: 'minimax' },
    { match: /^(?:meta-llama|llama)(?:-|$)/i, provider: 'meta-llama', familyKey: 'oss:llama3' },
    {
      match: /^(?:mistral|mixtral|ministral|codestral|devstral|pixtral)(?:-|$)/i,
      provider: 'mistralai',
    },
  ])

function exactKnownProviderFromSlug(modelSlug: string): string | null {
  return KNOWN_PROVIDER_BY_COMPAT_SLUG.get(compatNormalizeModelSlug(modelSlug)) ?? null
}

function exactKnownCanonicalSlugFromSlug(modelSlug: string): string | null {
  return EXACT_CANONICAL_SLUG_BY_COMPAT_SLUG.get(compatNormalizeModelSlug(modelSlug)) ?? null
}

function heuristicFamilyGuess(modelSlug: string): { provider: string; familyKey?: string } | null {
  for (const rule of FAMILY_GUESS_RULES) {
    if (!rule.match.test(modelSlug)) continue
    if (rule.familyKey) return { provider: rule.provider, familyKey: rule.familyKey }
    return { provider: rule.provider }
  }
  return null
}

function guessStructuralProvider(modelSlug: string): string | null {
  return exactKnownProviderFromSlug(modelSlug) ?? heuristicFamilyGuess(modelSlug)?.provider ?? null
}

export function structuralModelSlug(modelId: string): string {
  return preferredStructuralCandidate(modelId)
}

export function deterministicStructuralModelIdentity(
  modelId: string,
  providerHint?: string | null,
): DeterministicStructuralModelIdentity {
  const withoutVariant = stripOpenRouterVariantSuffix(modelId)
  const slash = withoutVariant.indexOf('/')
  const rawProvider = slash >= 0 ? withoutVariant.slice(0, slash) : null
  const slug = structuralModelSlug(modelId)
  const provider =
    rawProvider ??
    providerHint ??
    preferredProviderHintFromDecoratedSlug(rawStructuralModelSlug(modelId)) ??
    guessStructuralProvider(slug)
  const compatSlug = compatNormalizeModelSlug(slug)
  const key = provider ? `${provider}:${slug}` : slug
  const compatKey = provider ? `${provider}:${compatSlug}` : compatSlug
  return { provider, slug, compatSlug, key, compatKey }
}

export function deterministicStructuralModelId(
  modelId: string,
  providerHint?: string | null,
): string {
  return deterministicStructuralModelIdentity(modelId, providerHint).key
}

export function canonicalModelSlug(modelId: string): string {
  return structuralModelSlug(modelId)
}

export function canonicalCompatModelId(modelId: string): string {
  return compatNormalizeModelSlug(canonicalModelSlug(modelId))
}

export function compatModelIdsMatch(a: string, b: string): boolean {
  const left = canonicalCompatModelId(a)
  const right = canonicalCompatModelId(b)
  return left === right || left.startsWith(`${right}-`) || right.startsWith(`${left}-`)
}

export function bestGuessTokenizerFamilyKey(
  modelId: string,
  providerHint?: string | null,
): string | null {
  const identity = deterministicStructuralModelIdentity(modelId, providerHint)
  const exact = EXACT_TOKENIZER_FAMILY_BY_COMPAT_KEY.get(identity.compatKey)
  if (exact) return exact
  return heuristicFamilyGuess(identity.slug)?.familyKey ?? null
}

function isTokenizerFamilyKey(key: string): boolean {
  return TOKENIZER_FAMILY_KEY_SET.has(key)
}

function stripRepeatedProviderDecoration(provider: string, slug: string): string {
  const escaped = provider.replace(/[-]/g, '\\-')
  const pattern = new RegExp(`^${escaped}[\\s_:.\\/-]+(.+)$`, 'i')
  let current = slug
  for (;;) {
    const match = current.match(pattern)
    const next = match?.[1]
    if (!next) return current
    current = next
  }
}

// Durable storage key for token calibration. Known shared-tokenizer families
// collapse onto their family key; everything else stays on the canonical
// structural model identity.
export function tokenCalibrationKey(modelId: string, providerHint?: string | null): string {
  return (
    bestGuessTokenizerFamilyKey(modelId, providerHint) ??
    deterministicStructuralModelId(modelId, providerHint)
  )
}

// Backcompat resolver for persisted calibration rows: old rows may still be
// keyed by exact model strings, while new rows are stored directly under
// tokenizer-family keys.
export function tokenCalibrationKeyForStoredRecordKey(
  storedKey: string,
  providerHint?: string | null,
): string {
  if (isTokenizerFamilyKey(storedKey)) return storedKey
  const parts = splitCanonicalModelKey(storedKey)
  if (parts) {
    const slug = stripRepeatedProviderDecoration(parts.provider, parts.slug)
    return tokenCalibrationKey(`${parts.provider}/${slug}`, parts.provider)
  }
  return tokenCalibrationKey(storedKey, providerHint)
}
