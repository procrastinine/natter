import type { ConnectionKind, KeyId, ModelListEntry } from '../core/types'

export type ConnectionProbeState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; message: string }
  | { kind: 'fail'; message: string }

export interface ConfigurationConnectionProbeInput {
  readonly kind: ConnectionKind
  readonly name: string
  readonly baseUrl: string
  readonly apiKey?: string | null
  readonly fallbackKeyId?: KeyId
}

export interface ConfigurationConnectionModelCatalog {
  readonly models: readonly ModelListEntry[]
  readonly payload: unknown
}

export interface ConnectionProbeApplication {
  readonly loadConfigurationConnectionModelCatalog: (
    input: ConfigurationConnectionProbeInput,
    options?: { readonly timeoutMs?: number },
  ) => Promise<ConfigurationConnectionModelCatalog>
  readonly runConfigurationConnectionProbe: (
    input: ConfigurationConnectionProbeInput,
  ) => Promise<ConnectionProbeState>
}

export function connectionKindRequiresKey(kind: ConnectionKind): boolean {
  return kind !== 'custom' && kind !== 'llama-server'
}

export function isValidConnectionHttpUrl(value: string): boolean {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
