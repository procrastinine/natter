import { deterministicStructuralModelId, deterministicStructuralModelIdentity } from './model-ids'
import type { ConnectionKind } from './types'

interface ModelCandidate {
  id: string
}

function hasOpenRouterVariantSuffix(modelId: string): boolean {
  return /:(?:free|thinking)$/iu.test(modelId)
}

export function pickEquivalentModelId(
  sourceModelId: string,
  candidates: readonly ModelCandidate[],
): string | null {
  const exact = candidates.find((candidate) => candidate.id === sourceModelId)
  if (exact) return exact.id
  const sourceKey = deterministicStructuralModelId(sourceModelId)
  const compatible = candidates.filter(
    (candidate) => deterministicStructuralModelId(candidate.id) === sourceKey,
  )
  return (
    compatible.find((candidate) => !hasOpenRouterVariantSuffix(candidate.id))?.id ??
    compatible[0]?.id ??
    null
  )
}

export function forceEquivalentModelIdForConnection(
  sourceModelId: string,
  kind: ConnectionKind,
  candidates: readonly ModelCandidate[] = [],
): string | null {
  if (!sourceModelId) return null
  const candidate = pickEquivalentModelId(sourceModelId, candidates)
  if (candidate) return normalizeForcedModelIdForConnection(candidate, kind)
  const identity = deterministicStructuralModelIdentity(sourceModelId)
  if (kind === 'openrouter') {
    if (sourceModelId.includes('/')) return sourceModelId
    return identity.provider ? `${identity.provider}/${identity.slug}` : null
  }
  const targetProvider = providerForConnectionKind(kind)
  if (!targetProvider) return null
  if (identity.provider !== targetProvider) return null
  return normalizeForcedModelIdForConnection(identity.slug, kind)
}

export function modelLooksForeignForProfile(kind: ConnectionKind, modelId: string): boolean {
  const provider = deterministicStructuralModelIdentity(modelId).provider
  if (!provider) return false
  switch (kind) {
    case 'openrouter':
      return !modelId.includes('/') && ['openai', 'anthropic', 'google'].includes(provider)
    case 'openai-compatible':
      return provider !== 'openai'
    case 'anthropic':
      return provider !== 'anthropic'
    case 'google':
      return provider !== 'google'
    case 'custom':
    case 'llama-server':
      return false
  }
}

function providerForConnectionKind(kind: ConnectionKind): string | null {
  switch (kind) {
    case 'openai-compatible':
      return 'openai'
    case 'anthropic':
      return 'anthropic'
    case 'google':
      return 'google'
    case 'openrouter':
    case 'custom':
    case 'llama-server':
      return null
  }
}

function normalizeForcedModelIdForConnection(modelId: string, kind: ConnectionKind): string {
  if (kind !== 'google') return modelId
  if (/^(?:models|publishers)\//u.test(modelId)) return modelId
  const identity = deterministicStructuralModelIdentity(modelId, 'google')
  return `models/${identity.slug}`
}
