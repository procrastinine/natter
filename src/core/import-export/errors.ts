export class WorkspaceReplacementInProgressError extends Error {
  readonly blockerIds: readonly string[]
  readonly retryable = true

  constructor(blockerIds: Iterable<string>) {
    const ids = [...new Set(blockerIds)].sort()
    super(`WorkspaceReplacementInProgress:${ids.join(',')}`)
    this.name = 'WorkspaceReplacementInProgressError'
    this.blockerIds = Object.freeze(ids)
  }
}

export class WorkspaceReplacementCommittedRecoveryRequiredError extends AggregateError {
  readonly retryable = false
  readonly workspace: { readonly workspaceId: string; readonly replacementEpoch: number }

  constructor(
    workspace: { readonly workspaceId: string; readonly replacementEpoch: number },
    failures: readonly unknown[],
  ) {
    super(failures, 'WorkspaceReplacementCommittedRecoveryRequired')
    this.name = 'WorkspaceReplacementCommittedRecoveryRequiredError'
    this.workspace = Object.freeze({ ...workspace })
  }
}

export class WorkspaceReplacementUncommittedRecoveryRequiredError extends AggregateError {
  readonly retryable = false

  constructor(failures: readonly unknown[]) {
    super(failures, 'WorkspaceReplacementUncommittedRecoveryRequired')
    this.name = 'WorkspaceReplacementUncommittedRecoveryRequiredError'
  }
}

export class WorkspaceReplacementOutcomeUnknownError extends AggregateError {
  readonly retryable = false

  constructor(failures: readonly unknown[]) {
    super(failures, 'WorkspaceReplacementOutcomeUnknown')
    this.name = 'WorkspaceReplacementOutcomeUnknownError'
  }
}

export type WorkspaceReplacementRecoveryRequiredError =
  | WorkspaceReplacementCommittedRecoveryRequiredError
  | WorkspaceReplacementUncommittedRecoveryRequiredError
  | WorkspaceReplacementOutcomeUnknownError

export function isWorkspaceReplacementRecoveryRequiredError(
  error: unknown,
): error is WorkspaceReplacementRecoveryRequiredError {
  return (
    error instanceof WorkspaceReplacementCommittedRecoveryRequiredError ||
    error instanceof WorkspaceReplacementUncommittedRecoveryRequiredError ||
    error instanceof WorkspaceReplacementOutcomeUnknownError
  )
}
