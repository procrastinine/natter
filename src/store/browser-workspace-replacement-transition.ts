import type {
  BrowserWorkspacePreparedReplacement,
  BrowserWorkspaceReplacementCommit,
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
  | 'unknown'
  | 'selection-settling'
  | 'selection-settled'
  | 'finalizing'
  | 'terminal'

export type BrowserWorkspaceReplacementOutcome<T> =
  | {
      readonly kind: 'committed-ready'
      readonly commit: BrowserWorkspaceReplacementCommit<T>
    }
  | {
      readonly kind: 'uncommitted-ready'
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
  readonly ownAbandon: (operation: () => Promise<void>) => void
  readonly ownPeerResume: (operation: () => Promise<void> | void) => void
  readonly beginQuiescing: () => void
  readonly markQuiesced: () => void
  readonly beginWriting: () => void
  readonly markPrepared: () => void
  readonly beginCommitting: () => void
  readonly markCommitted: (prepared: BrowserWorkspacePreparedReplacement<T>) => void
  readonly markUncommitted: (error: unknown) => void
  readonly markOutcomeUnknown: (error: unknown) => void
  readonly settleSelection: () => Promise<void>
  readonly finalize: () => Promise<BrowserWorkspaceReplacementOutcome<T>>
}

interface BrowserWorkspaceReplacementTransitionPorts<T> {
  readonly originalWorkspace: BrowserWorkspaceSnapshot
  readonly reopen: () => Promise<BrowserWorkspaceSnapshot>
  readonly publish: (commit: BrowserWorkspaceReplacementCommit<T>) => Promise<void> | void
}

export function createBrowserWorkspaceReplacementTransitionController<T>(
  ports: BrowserWorkspaceReplacementTransitionPorts<T>,
): BrowserWorkspaceReplacementTransitionController<T> {
  let phase: BrowserWorkspaceReplacementTransitionPhase = 'admitted'
  let abandon: (() => Promise<void>) | null = null
  let resume: (() => Promise<void> | void) | null = null
  let commit: BrowserWorkspaceReplacementCommit<T> | null = null
  let disposition: 'committed' | 'uncommitted' | 'unknown' | null = null
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

  const controller: BrowserWorkspaceReplacementTransitionController<T> = {
    phase: () => phase,
    hasDisposition: () => dispositionSet,
    ownAbandon: (operation) => {
      if (phase !== 'admitted' || abandon) {
        throw new Error('BrowserWorkspaceReplacementAbandonOwnerInvalid')
      }
      abandon = operation
    },
    ownPeerResume: (operation) => {
      if (phase !== 'admitted' || resume) {
        throw new Error('BrowserWorkspaceReplacementPeerResumeOwnerInvalid')
      }
      resume = operation
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
      if (phase !== 'committed' && phase !== 'uncommitted' && phase !== 'unknown') {
        return Promise.reject(
          new Error(`BrowserWorkspaceReplacementDispositionInvalid:${phase}:settle-selection`),
        )
      }
      phase = 'selection-settling'
      const settling = Promise.resolve()
        .then(async () => {
          if (disposition === 'uncommitted' && abandon) {
            const operation = abandon
            abandon = null
            await collectFailure(selectionFailures, operation)
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
        resume,
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
  readonly disposition: 'committed' | 'uncommitted' | 'unknown'
  readonly dispositionError: unknown
  readonly commit: BrowserWorkspaceReplacementCommit<T> | null
  readonly originalWorkspace: BrowserWorkspaceSnapshot
  readonly initialFailures: readonly unknown[]
  readonly resume: (() => Promise<void> | void) | null
  readonly reopen: () => Promise<BrowserWorkspaceSnapshot>
  readonly publish: (commit: BrowserWorkspaceReplacementCommit<T>) => Promise<void> | void
}): Promise<BrowserWorkspaceReplacementOutcome<T>> {
  const failures: unknown[] = [...input.initialFailures]
  if (input.disposition === 'uncommitted') {
    failures.push(input.dispositionError)
  } else if (input.disposition === 'unknown') {
    failures.push(input.dispositionError)
  } else if (!input.commit) {
    throw new Error('BrowserWorkspaceReplacementCommittedValueMissing')
  } else {
    await collectFailure(failures, () =>
      input.publish(input.commit as BrowserWorkspaceReplacementCommit<T>),
    )
  }

  const recovery = await Promise.allSettled([
    input.reopen(),
    Promise.resolve().then(() => input.resume?.()),
  ])
  const reopened = recovery[0]
  if (reopened.status === 'rejected') {
    failures.push(reopened.reason)
  } else if (input.disposition !== 'unknown') {
    const expected =
      input.disposition === 'committed'
        ? (input.commit as BrowserWorkspaceReplacementCommit<T>).workspace
        : input.originalWorkspace
    if (!sameWorkspaceSnapshot(reopened.value, expected)) {
      failures.push(new Error('BrowserWorkspaceReplacementReopenFenceMismatch'))
    }
  }
  const resumed = recovery[1]
  if (resumed.status === 'rejected') failures.push(resumed.reason)

  if (input.disposition === 'committed') {
    const committed = input.commit as BrowserWorkspaceReplacementCommit<T>
    return failures.length === 0
      ? { kind: 'committed-ready', commit: committed }
      : { kind: 'committed-recovery-required', commit: committed, failures }
  }
  if (input.disposition === 'unknown') {
    return { kind: 'outcome-unknown', failures }
  }
  return failures.length === 1
    ? { kind: 'uncommitted-ready', error: input.dispositionError }
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
    value: prepared.value,
  }
}

function sameWorkspaceSnapshot(
  left: BrowserWorkspaceSnapshot,
  right: BrowserWorkspaceSnapshot,
): boolean {
  return left.workspaceId === right.workspaceId && left.replacementEpoch === right.replacementEpoch
}
