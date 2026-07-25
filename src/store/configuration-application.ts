import type { ChatId, ProfileId } from '../core/types'
import { executeConfigurationCommand } from './configuration-command-client'
import { configurationController } from './configuration-controller'
import { createConfigurationApplication } from './configuration-domain'
import { prepareEncryptedKey } from './keys'
import type { ConfigurationProfileSwitchPlan } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

const configurationDomainApplication = createConfigurationApplication({
  port: { execute: executeConfigurationCommand },
  prepareKey: prepareEncryptedKey,
  loadProfileSwitchPlan: readConfigurationProfileSwitchPlan,
  pendingConfiguration: configurationController,
})

export const configurationApplication = configurationDomainApplication

async function readConfigurationProfileSwitchPlan(
  chatId: ChatId,
  profileId: ProfileId,
): Promise<ConfigurationProfileSwitchPlan | undefined> {
  return runWorkspaceRead('repository-query', (authority) =>
    getWorkspaceRepository()
      .query(authority, { kind: 'configuration.profile-switch-plan', chatId, profileId })
      .then((envelope) => envelope.value),
  )
}
