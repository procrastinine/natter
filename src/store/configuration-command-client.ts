import type {
  ConfigurationDomainCommand,
  ConfigurationDomainExecutionOptions,
  ConfigurationDomainResult,
} from './configuration-domain-contract'
import type { ConfigurationWorkspaceCommand, WorkspaceWriteAuthority } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceAction } from './workspace-runtime'

export function executeConfigurationCommand<Command extends ConfigurationDomainCommand>(
  command: Command,
  execution?:
    | WorkspaceWriteAuthority
    | ConfigurationDomainExecutionOptions<ConfigurationDomainResult<Command['kind']>>,
): Promise<ConfigurationDomainResult<Command['kind']>> {
  const options = isConfigurationDomainExecutionOptions(execution) ? execution : undefined
  const authority = options ? undefined : (execution as WorkspaceWriteAuthority | undefined)
  const execute = (permit: WorkspaceWriteAuthority) => {
    return getWorkspaceRepository()
      .execute(
        permit,
        {
          kind: 'configuration.execute',
          input: command,
        } as ConfigurationWorkspaceCommand & { readonly input: Command },
        options
          ? {
              localApplications: {
                configuration: (commit) => options.localApplication(commit.value),
              },
            }
          : undefined,
      )
      .then((envelope) => envelope.value)
  }
  return authority ? execute(authority) : runWorkspaceAction('configuration', execute)
}

function isConfigurationDomainExecutionOptions<Result>(
  value: WorkspaceWriteAuthority | ConfigurationDomainExecutionOptions<Result> | undefined,
): value is ConfigurationDomainExecutionOptions<Result> {
  return (
    typeof value === 'object' &&
    'localApplication' in value &&
    typeof value.localApplication === 'function'
  )
}
