import type { ConnectionProbeApplication } from './connection-probe-contract'

export type {
  ConfigurationConnectionModelCatalog,
  ConfigurationConnectionProbeInput,
  ConnectionProbeApplication,
  ConnectionProbeState,
} from './connection-probe-contract'
export {
  connectionKindRequiresKey,
  isValidConnectionHttpUrl,
} from './connection-probe-contract'

export function loadConnectionProbeApplication(): Promise<ConnectionProbeApplication> {
  return import('./connection-probe-application')
}
