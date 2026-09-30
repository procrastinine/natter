import type {
  BrowserWorkspacePreparedReplacement,
  BrowserWorkspaceReplacementCommit,
  BrowserWorkspaceReplacementReopenOutcome,
  BrowserWorkspaceSnapshot,
} from './browser-workspace-contract'

export type BrowserWorkspaceReplacementTransitionPhase =
  | 'admitted'
  | 'quiescing'
  | 'quiesced'
  | 'writing'
  | 'prepared'
  | 'committing'
  | 'committed'
  | 'uncommitted'
  | 'deferred'
  | 'cancelled'
  | 'unknown'
  | 'selection-settling'
  | 'selection-settled'
  | 'finalizing'
  | 'terminal'

export type BrowserWorkspaceReplacementOutcome<T> =
  | { readonly kind: 'online-ready' }
  | { readonly kind: 'cancelled'; readonly reason: unknown; readonly readiness: 'ready' | 'closed' }
  | {
      readonly kind: 'committed-ready'
      readonly commit: BrowserWorkspaceReplacementCommit<T>
    }
  | {
      readonly kind: 'committed-closed'
      readonly commit: BrowserWorkspaceReplacementCommit<T>
    }
  | {
      readonly kind: 'uncommitted-ready'
      readonly error: unknown
    }
  | {
      readonly kind: 'uncommitted-closed'
      readonly error: unknown
    }
  | {
      readonly kind: 'committed-recovery-required'
      readonly commit: BrowserWorkspaceReplacementCommit<T>
      readonly failures: readonly unknown[]
    }
  | {
      readonly kind: 'uncommitted-recovery-required'
      readonly failures: readonly unknown[]
    }
  | {
      readonly kind: 'outcome-unknown'
      readonly failures: readonly unknown[]
    }

export interface BrowserWorkspaceReplacementTransitionController<T> {
  readonly phase: () => BrowserWorkspaceReplacementTransitionPhase
  readonly hasDisposition: () => boolean
  readonly isDeferred: () => boolean
  readonly ownAbandon: (operation: () => Promise<void>) => void
  readonly beginQuiescing: () => void
  readonly markQuiesced: () => void
  readonly beginWriting: () => void
  readonly markPrepared: () => void
  readonly beginCommitting: () => void
  readonly markCommitted: (prepared: BrowserWorkspacePreparedReplacement<T>) => void
  readonly markUncommitted: (error: unknown) => void
  readonly markDeferred: () => void
  readonly markCancelled: (reason: unknown) => void
  readonly markOutcomeUnknown: (error: unknown) => void
  readonly settleSelection: () => Promise<void>
  readonly finalize: () => Promise<BrowserWorkspaceReplacementOutcome<T>>
}

interface BrowserWorkspaceReplacementTransitionPorts<T> {
  readonly originalWorkspace: BrowserWorkspaceSnapshot
  readonly reopen: (retained: boolean) => Promise<BrowserWorkspaceReplacementReopenOutcome>
  readonly publish: (commit: BrowserWorkspaceReplacementCommit<T>) => Promise<void> | void
}

export function createBrowserWorkspaceReplacementTransitionController<T>(
  ports: BrowserWorkspaceReplacementTransitionPorts<T>,
): BrowserWorkspaceReplacementTransitionController<T> {
  let phase: BrowserWorkspaceReplacementTransitionPhase = 'admitted'
  let abandon: (() => Promise<void>) | null = null
  let commit: BrowserWorkspaceReplacementCommit<T> | null = null
  let disposition: 'committed' | 'uncommitted' | 'unknown' | 'deferred' | 'cancelled' | null = null
  let dispositionError: unknown
  let dispositionSet = false
  const selectionFailures: unknown[] = []
  let selectionSettlement: Promise<void> | null = null
  let finalization: Promise<BrowserWorkspaceReplacementOutcome<T>> | null = null

  const transition = (
    expected: BrowserWorkspaceReplacementTransitionPhase,
    next: BrowserWorkspaceReplacementTransitionPhase,
  ) => {
    if (phase !== expected) {
      throw new Error(`BrowserWorkspaceReplacementTransitionInvalid:${phase}:${next}`)
    }
    phase = next
  }

  const abandonOnce = async (): Promise<void> => {
    if (!abandon) return
    const operation = abandon
    abandon = null
    await operation()
  }

  const controller: BrowserWorkspaceReplacementTransitionController<T> = {
    phase: () => phase,
    hasDisposition: () => dispositionSet,
    isDeferred: () => disposition === 'deferred',
    ownAbandon: (operation) => {
      if (phase !== 'admitted' || abandon) {
        throw new Error('BrowserWorkspaceReplacementAbandonOwnerInvalid')
      }
      abandon = operation
    },
    beginQuiescing: () => transition('admitted', 'quiescing'),
    markQuiesced: () => transition('quiescing', 'quiesced'),
    beginWriting: () => transition('quiesced', 'writing'),
    markPrepared: () => transition('writing', 'prepared'),
    beginCommitting: () => transition('prepared', 'committing'),
    markCommitted: (prepared) => {
      transition('committing', 'committed')
      commit = copyPreparedReplacement(prepared)
      disposition = 'committed'
      dispositionSet = true
    },
    markUncommitted: (error) => {
      if (dispositionSet || phase === 'finalizing' || phase === 'terminal') {
        throw new Error(`BrowserWorkspaceReplacementDispositionInvalid:${phase}:uncommitted`)
      }
      phase = 'uncommitted'
      disposition = 'uncommitted'
      dispositionError = error
      dispositionSet = true
    },
    markDeferred: () => {
      if (dispositionSet || !['quiescing', 'quiesced', 'writing'].includes(phase)) {
        throw new Error(`BrowserWorkspaceReplacementDispositionInvalid:${phase}:deferred`)
      }
      phase = 'deferred'
      disposition = 'deferred'
      dispositionSet = true
    },
    markCancelled: (reason) => {
      if (
        dispositionSet ||
        !['admitted', 'quiescing', 'quiesced', 'writing', 'prepared'].includes(phase)
      ) {
        throw new Error(`BrowserWorkspaceReplacementDispositionInvalid:${phase}:cancelled`)
      }
      phase = 'cancelled'
      disposition = 'cancelled'
      dispositionError = reason
      dispositionSet = true
    },
    markOutcomeUnknown: (error) => {
      if (dispositionSet || !['writing', 'prepared', 'committing'].includes(phase)) {
        throw new Error(`BrowserWorkspaceReplacementDispositionInvalid:${phase}:unknown`)
      }
      phase = 'unknown'
      disposition = 'unknown'
      dispositionError = error
      dispositionSet = true
    },
    settleSelection: () => {
      if (selectionSettlement) return selectionSettlement
      if (!dispositionSet || !disposition) {
        return Promise.reject(new Error(`BrowserWorkspaceReplacementDispositionMissing:${phase}`))
      }
      if (!['committed', 'uncommitted', 'unknown', 'deferred', 'cancelled'].includes(phase)) {
        return Promise.reject(
          new Error(`BrowserWorkspaceReplacementDispositionInvalid:${phase}:settle-selection`),
        )
      }
      phase = 'selection-settling'
      const settling = Promise.resolve()
        .then(async () => {
          if (disposition === 'uncommitted' || disposition === 'cancelled') {
            await collectFailure(selectionFailures, abandonOnce)
          }
        })
        .then(() => {
          phase = 'selection-settled'
        })
      selectionSettlement = settling
      return settling
    },
    finalize: () => {
      if (finalization) return finalization
      if (!dispositionSet || !disposition) {
        return Promise.reject(new Error(`BrowserWorkspaceReplacementDispositionMissing:${phase}`))
      }
      if (phase !== 'selection-settled') {
        return Promise.reject(
          new Error(`BrowserWorkspaceReplacementDispositionInvalid:${phase}:finalize`),
        )
      }
      const terminalDisposition = disposition
      phase = 'finalizing'
      const running = finalizeBrowserWorkspaceReplacement({
        disposition: terminalDisposition,
        dispositionError,
        commit,
        originalWorkspace: ports.originalWorkspace,
        initialFailures: selectionFailures,
        abandon: abandonOnce,
        reopen: ports.reopen,
        publish: ports.publish,
      }).then((outcome) => {
        phase = 'terminal'
        return outcome
      })
      finalization = running
      return running
    },
  }
  return controller
}

async function finalizeBrowserWorkspaceReplacement<T>(input: {
  readonly disposition: 'committed' | 'uncommitted' | 'unknown' | 'deferred' | 'cancelled'
  readonly dispositionError: unknown
  readonly commit: BrowserWorkspaceReplacementCommit<T> | null
  readonly originalWorkspace: BrowserWorkspaceSnapshot
  readonly initialFailures: readonly unknown[]
  readonly abandon: () => Promise<void>
  readonly reopen: (retained: boolean) => Promise<BrowserWorkspaceReplacementReopenOutcome>
  readonly publish: (commit: BrowserWorkspaceReplacementCommit<T>) => Promise<void> | void
}): Promise<BrowserWorkspaceReplacementOutcome<T>> {
  const failures: unknown[] = [...input.initialFailures]
  if (input.disposition === 'uncommitted') {
    failures.push(input.dispositionError)
  } else if (input.disposition === 'unknown') {
    failures.push(input.dispositionError)
  } else if (input.disposition === 'committed' && !input.commit) {
    throw new Error('BrowserWorkspaceReplacementCommittedValueMissing')
  } else if (input.disposition === 'committed') {
    await collectFailure(failures, () =>
      input.publish(input.commit as BrowserWorkspaceReplacementCommit<T>),
    )
  }

  let cancelledReopen: Extract<
    BrowserWorkspaceReplacementReopenOutcome,
    { kind: 'cancelled-closed' }
  > | null = null
  {
    const reopened = await Promise.resolve()
      .then(() => input.reopen(input.disposition === 'deferred'))
      .then(
        (value) => ({ status: 'fulfilled', value }) as const,
        (reason: unknown) => ({ status: 'rejected', reason }) as const,
      )
    if (reopened.status === 'rejected') {
      failures.push(reopened.reason)
    } else if (reopened.value.kind === 'cancelled-closed') {
      cancelledReopen = reopened.value
    } else if (input.disposition !== 'unknown') {
      const expected =
        input.disposition === 'committed'
          ? (input.commit as BrowserWorkspaceReplacementCommit<T>).workspace
          : input.originalWorkspace
      if (!sameWorkspaceSnapshot(reopened.value.workspace, expected)) {
        failures.push(new Error('BrowserWorkspaceReplacementReopenFenceMismatch'))
      }
    }
  }
  if (input.disposition === 'deferred' && (failures.length > 0 || cancelledReopen)) {
    await collectFailure(failures, input.abandon)
  }
  if (input.disposition === 'deferred' || input.disposition === 'cancelled') {
    if (failures.length > 0) return { kind: 'uncommitted-recovery-required', failures }
    if (cancelledReopen) {
      return { kind: 'cancelled', reason: cancelledReopen.reason, readiness: 'closed' }
    }
    return input.disposition === 'deferred'
      ? { kind: 'online-ready' }
      : {
          kind: 'cancelled',
          reason: input.dispositionError,
          readiness: 'ready',
        }
  }
  if (input.disposition === 'committed') {
    const committed = input.commit as BrowserWorkspaceReplacementCommit<T>
    return failures.length === 0
      ? { kind: cancelledReopen ? 'committed-closed' : 'committed-ready', commit: committed }
      : { kind: 'committed-recovery-required', commit: committed, failures }
  }
  if (input.disposition === 'unknown') {
    return { kind: 'outcome-unknown', failures }
  }
  return failures.length === 1
    ? {
        kind: cancelledReopen ? 'uncommitted-closed' : 'uncommitted-ready',
        error: input.dispositionError,
      }
    : { kind: 'uncommitted-recovery-required', failures }
}

async function collectFailure(
  failures: unknown[],
  operation: () => Promise<void> | void,
): Promise<void> {
  try {
    await operation()
  } catch (error) {
    failures.push(error)
  }
}

function copyPreparedReplacement<T>(
  prepared: BrowserWorkspacePreparedReplacement<T>,
): BrowserWorkspaceReplacementCommit<T> {
  return {
    workspace: { ...prepared.workspace },
    storageBaseline: { ...prepared.storageBaseline },
    ...(prepared.publication ? { publication: prepared.publication } : {}),
    value: prepared.value,
  }
}

function sameWorkspaceSnapshot(
  left: BrowserWorkspaceSnapshot,
  right: BrowserWorkspaceSnapshot,
): boolean {
  return left.workspaceId === right.workspaceId && left.replacementEpoch === right.replacementEpoch
}
