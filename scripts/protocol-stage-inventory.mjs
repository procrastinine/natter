function stage(id, subject, role, domain, reason) {
  return Object.freeze({
    id,
    subject,
    role,
    domain,
    reason,
  })
}

export const PROTOCOL_STAGE_SWITCHES = Object.freeze([
  stage(
    'src/store/browser-repo.ts#BrowserWorkspaceRepository.dispatchCommand|command|1',
    'command',
    'repository-dispatch',
    'repository-protocol',
    'Every authoritative command reaches exactly one repository implementation.',
  ),
  stage(
    'src/store/browser-repo.ts#BrowserWorkspaceRepository.dispatchQuery|query|1',
    'query',
    'repository-dispatch',
    'repository-protocol',
    'Workspace metadata, interchange exports, and conversation envelopes are handled by typed outer query paths.',
  ),
  stage(
    'src/store/browser-repo.ts#BrowserWorkspaceRepository.mutateDiscoveryCache|command|1',
    'command',
    'domain-dispatch',
    'configuration-discovery-context',
    'Discovery cache writes share one guarded cache mutation implementation.',
  ),
  stage(
    'src/store/browser-mutation-plan.ts#scopeDerivedMutationReceiptPolicy|command|1',
    'command',
    'semantic-receipt-policy',
    'repository-protocol',
    'Every command explicitly selects a scope-derived receipt policy or declares that it has none.',
  ),
  stage(
    'src/store/discovery-service.ts#publishDiscoveryRow|command|1',
    'command',
    'domain-publication',
    'configuration-discovery-context',
    'Successful discovery fetches publish the three cache row kinds; deletion has a separate caller.',
  ),
  stage(
    'src/store/workspace-protocol.ts#workspaceQueryDependencies|query|1',
    'query',
    'reactive-dependencies',
    'repository-protocol',
    'Every query declares the durable dependencies that can invalidate its result.',
  ),
])
