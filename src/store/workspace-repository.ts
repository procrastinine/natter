import { redactDiagnosticValue } from '../lib/diagnostic-redaction'
import { postWorkspaceChange } from './broadcast'
import type { WorkspaceMeta } from './repository'
import type { PreparedWorkspaceEffect } from './workspace-effect-hub'
import {
  attachWorkspaceEffectSource,
  prepareLocalWorkspaceChange,
  prepareWorkspaceEffectForLocalCommit,
  prepareWorkspaceRecoveryEffectForCommittedWrite,
  publishPreparedWorkspaceEffect,
  recoverWorkspaceEffectGroup,
} from './workspace-effect-hub'
import type {
  CommitEnvelope,
  WorkspaceChange,
  WorkspaceCommand,
  WorkspaceCommandExecutionOptions,
  WorkspaceCommandResult,
  WorkspaceDelta,
  WorkspaceReplacement,
  WorkspaceRepository,
  WorkspaceWriteAuthority,
} from './workspace-protocol'
import { runWorkspaceRead } from './workspace-runtime'

let override: WorkspaceRepository | null = null
let repositoryFactory: (() => WorkspaceRepository) | null = null
let deliveredTarget: WorkspaceRepository | null = null
let deliveredRepository: WorkspaceRepository | null = null

export function installWorkspaceRepositoryFactory(factory: () => WorkspaceRepository): void {
  if (repositoryFactory === factory) return
  repositoryFactory = factory
  deliveredTarget = null
  deliveredRepository = null
}

export function getWorkspaceRepository(): WorkspaceRepository {
  const target = override ?? installedWorkspaceRepository()
  if (deliveredTarget !== target || !deliveredRepository) {
    attachWorkspaceEffectSource(target)
    deliveredTarget = target
    deliveredRepository = bindCommitDelivery(target)
  }
  return deliveredRepository
}

function installedWorkspaceRepository(): WorkspaceRepository {
  if (!repositoryFactory) throw new Error('WorkspaceRepositoryFactoryNotInstalled')
  return repositoryFactory()
}

export function isStreamChunkOnlyDelta(delta: WorkspaceDelta): boolean {
  if (delta.facts.length !== 0 || delta.invalidations.length === 0) return false
  return delta.invalidations.every((invalidation) => invalidation.kind === 'stream-chunks')
}

export function readWorkspaceMeta(options: { signal?: AbortSignal } = {}): Promise<WorkspaceMeta> {
  return runWorkspaceRead(
    'repository-query',
    (permit) =>
      getWorkspaceRepository()
        .query(permit, { kind: 'workspace.meta' }, { signal: permit.signal })
        .then((envelope) => envelope.value),
    options,
  )
}

export function publishLocalWorkspaceInvalidation(
  change: Extract<WorkspaceChange, { kind: 'invalidate' }>,
): void {
  const prepared = prepareLocalWorkspaceChange(change)
  publishPreparedWorkspaceEffect(prepared.effect)
  postWorkspaceChange(prepared.change)
}

export function __setWorkspaceRepositoryForTests(repo: WorkspaceRepository | null): void {
  override = repo
  deliveredTarget = null
  deliveredRepository = null
}

export function __resetWorkspaceRepositoryForTests(): void {
  override = null
  deliveredTarget = null
  deliveredRepository = null
}

function bindCommitDelivery(target: WorkspaceRepository): WorkspaceRepository {
  return Object.freeze({
    query: target.query.bind(target),
    execute: async <C extends WorkspaceCommand>(
      permit: WorkspaceWriteAuthority,
      command: C,
      options: WorkspaceCommandExecutionOptions<WorkspaceCommandResult<C>> = {},
    ) => {
      const commit = await target.execute(permit, command)
      deliverLocalCommit(command, commit, options)
      return commit
    },
    replace: async <R extends WorkspaceReplacement>(replacement: R) => {
      const envelope = await target.replace(replacement)
      const prepared = prepareLocalWorkspaceChange({
        kind: 'replace',
        workspaceId: envelope.workspaceId,
        replacementEpoch: envelope.replacementEpoch,
      })
      publishPreparedWorkspaceEffect(prepared.effect)
      return envelope
    },
    subscribeChanges: target.subscribeChanges.bind(target),
  })
}

function deliverLocalCommit<C extends WorkspaceCommand>(
  command: C,
  commit: CommitEnvelope<WorkspaceCommandResult<C>>,
  options: WorkspaceCommandExecutionOptions<WorkspaceCommandResult<C>>,
): void {
  let prepared: PreparedWorkspaceEffect | null
  try {
    prepared = prepareWorkspaceEffectForLocalCommit(commit)
  } catch (error) {
    reportLocalCommitProjectionFailure('evidence', command.kind, error)
    if (commit.effectScope === 'workspace') {
      const recovery = prepareWorkspaceRecoveryEffectForCommittedWrite(commit)
      publishPreparedWorkspaceEffect(recovery.effect)
      postWorkspaceChange(recovery.change)
    }
    return
  }
  if (!prepared) return
  const { change, effect } = prepared
  if (isStreamChunkOnlyDelta(commit.delta)) return
  const suppressedGroups = new Set<string>()
  const suppliedConversation = options.localApplications?.conversation
  if (suppliedConversation) {
    try {
      const disposition = suppliedConversation(commit)
      if (disposition === 'applied') {
        suppressedGroups.add('conversation')
      }
    } catch (error) {
      suppressedGroups.add('conversation')
      reportLocalCommitProjectionFailure('conversation', command.kind, error)
      recoverWorkspaceEffectGroup('conversation', error, effect)
    }
  }
  publishPreparedWorkspaceEffect(effect, suppressedGroups)
  postWorkspaceChange(change)
}

function reportLocalCommitProjectionFailure(
  owner: 'conversation' | 'evidence',
  commandKind: WorkspaceCommand['kind'],
  error: unknown,
): void {
  try {
    console.error('Workspace local commit projection failed', {
      owner,
      commandKind,
      error: redactDiagnosticValue(error),
    })
  } catch {
    // Diagnostics cannot alter the result of an authoritative commit.
  }
}
