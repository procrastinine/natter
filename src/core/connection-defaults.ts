import type { ConnectionKind } from './types'

export function connectionKindDefaults(
  kind: ConnectionKind,
  _baseUrl: string,
): {
  supportsEndpointsApi: boolean
  supportsGenerationApi: boolean
  supportsPrivacyScrape: boolean
} {
  switch (kind) {
    case 'openrouter':
      return {
        supportsEndpointsApi: true,
        supportsGenerationApi: true,
        supportsPrivacyScrape: true,
      }
    case 'openai-compatible':
    case 'anthropic':
    case 'google':
    case 'llama-server':
    case 'custom':
      return {
        supportsEndpointsApi: false,
        supportsGenerationApi: false,
        supportsPrivacyScrape: false,
      }
  }
}
