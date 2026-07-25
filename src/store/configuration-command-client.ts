import type {
  ConfigurationDomainCommand,
  ConfigurationDomainResult,
} from './configuration-domain-contract'
import type { ConfigurationWorkspaceCommand, WorkspaceWriteAuthority } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceAction } from './workspace-runtime'

export function executeConfigurationCommand<Command extends ConfigurationDomainCommand>(
  command: Command,
  authority?: WorkspaceWriteAuthority,
): Promise<ConfigurationDomainResult<Command['kind']>> {
  const execute = (permit: WorkspaceWriteAuthority) =>
    getWorkspaceRepository()
      .execute(permit, {
        kind: 'configuration.execute',
        input: command,
      } as ConfigurationWorkspaceCommand & { readonly input: Command })
      .then((envelope) => envelope.value)
  return authority ? execute(authority) : runWorkspaceAction('configuration', execute)
}
