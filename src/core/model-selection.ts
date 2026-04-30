import type { ModelListEntry } from '../api/providers'
import type { ConnectionKind } from './types'
import { deterministicStructuralModelId, deterministicStructuralModelIdentity } from './model-ids'

function hasOpenRouterVariantSuffix(modelId: string): boolean {
  return /:(?:free|thinking)$/iu.test(modelId)
}

export function pickEquivalentModelId(
  sourceModelId: string,
  candidates: readonly ModelListEntry[],
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
