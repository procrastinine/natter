import { resolveDefaultModel } from '../core/defaults'
import { configurationApplication } from './configuration-application'
import type { CreateConnectionIntent } from './configuration-domain'
import type { ConfigurationDomainResult } from './configuration-domain-contract'
import { loadConnectionProbeApplication } from './connection-probe-capability'

export async function createConnectionWithSeedPreset(
  input: CreateConnectionIntent & { readonly initialPresetName: string },
): Promise<ConfigurationDomainResult<'connection.create'>> {
  let model = input.initialPresetModel
  if (model === undefined) {
    try {
      const { loadConfigurationConnectionModelCatalog } = await loadConnectionProbeApplication()
      const catalog = await loadConfigurationConnectionModelCatalog({
        kind: input.kind,
        name: input.name,
        baseUrl: input.baseUrl,
        ...(input.plaintextKey === undefined ? {} : { apiKey: input.plaintextKey }),
      })
      model = resolveDefaultModel(catalog.models)
    } catch {
      model = input.kind === 'openrouter' ? resolveDefaultModel([]) : ''
    }
  }
  return configurationApplication.createConnection({
    ...input,
    initialPresetModel: model,
  })
}
