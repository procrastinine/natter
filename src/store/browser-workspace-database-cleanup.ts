import Dexie from 'dexie'
import {
  abandonPreparedBrowserWorkspaceDatabase,
  type BrowserWorkspaceReplacementCleanup,
  type BrowserWorkspaceReplacementDiscard,
  type BrowserWorkspaceReplacementPreparing,
  completeBrowserWorkspaceDatabaseCleanup,
  readBrowserWorkspaceDatabaseManifest,
  sameBrowserWorkspaceReplacementJournal,
} from './browser-workspace-database-control'
import {
  type BrowserWorkspaceSelectionGrant,
  type BrowserWorkspaceSlotTransition,
  tryWithBrowserWorkspaceSelectionGate,
  withBrowserWorkspaceSelectionGate,
  withExclusiveBrowserWorkspaceSlots,
} from './browser-workspace-slot-coordination'

export type BrowserWorkspaceDatabaseCleanupResult =
  | { readonly status: 'none' }
  | { readonly status: 'preparing' }
  | {
      readonly status: 'cleaned'
      readonly phase: 'discard' | 'cleanup'
      readonly databaseName: string
    }
  | { readonly status: 'changed' }

export type QuiescedBrowserWorkspaceReplacementRecovery =
  | {
      readonly kind: 'committed'
      readonly databaseName: string
      readonly activationSequence: number
    }
  | {
      readonly kind: 'uncommitted'
      readonly databaseName: string
      readonly activationSequence: number
    }
  | {
      readonly kind: 'advanced'
      readonly databaseName: string
      readonly activationSequence: number
    }

export async function cleanPendingBrowserWorkspaceDatabase(
  signal?: AbortSignal,
): Promise<BrowserWorkspaceDatabaseCleanupResult> {
  if (signal?.aborted) throw signal.reason
  const manifest = await readBrowserWorkspaceDatabaseManifest()
  const journal = manifest.pending
  if (!journal) return { status: 'none' }
  if (journal.phase === 'preparing') {
    const claimed = await tryWithBrowserWorkspaceSelectionGate(
      (selection) =>
        cleanPendingBrowserWorkspaceDatabaseWithinSelection(selection, journal, signal),
      signal,
    )
    return claimed.acquired ? claimed.value : { status: 'preparing' }
  }
  return withBrowserWorkspaceSelectionGate(
    (selection) => cleanPendingBrowserWorkspaceDatabaseWithinSelection(selection, journal, signal),
    signal,
  )
}

export function recoverQuiescedBrowserWorkspaceReplacement(
  transition: BrowserWorkspaceSlotTransition,
  signal?: AbortSignal,
): Promise<QuiescedBrowserWorkspaceReplacementRecovery> {
  return withBrowserWorkspaceSelectionGate(async () => {
    if (signal?.aborted) throw signal.reason
    let manifest = await readBrowserWorkspaceDatabaseManifest()
    let journal = manifest.pending
    if (journal?.phase === 'preparing' && sameBrowserWorkspaceSlotTransition(journal, transition)) {
      await abandonPreparedBrowserWorkspaceDatabase(journal)
      manifest = await readBrowserWorkspaceDatabaseManifest()
      journal = manifest.pending
      if (
        journal?.phase !== 'discard' ||
        !sameBrowserWorkspaceSlotTransition(journal, transition)
      ) {
        throw new Error('BrowserWorkspaceQuiescedRecoveryJournalChanged')
      }
    }
    if (journal && !sameBrowserWorkspaceSlotTransition(journal, transition)) {
      return {
        kind: 'advanced',
        databaseName: manifest.activeDatabaseName,
        activationSequence: manifest.activationSequence,
      }
    }
    const recovery = {
      databaseName: manifest.activeDatabaseName,
      activationSequence: manifest.activationSequence,
    }
    if (manifest.activeDatabaseName === transition.destinationDatabaseName) {
      return { kind: 'committed', ...recovery }
    }
    if (manifest.activeDatabaseName === transition.sourceDatabaseName) {
      return { kind: 'uncommitted', ...recovery }
    }
    return { kind: 'advanced', ...recovery }
  }, signal)
}

function sameBrowserWorkspaceSlotTransition(
  journal:
    | BrowserWorkspaceReplacementPreparing
    | BrowserWorkspaceReplacementDiscard
    | BrowserWorkspaceReplacementCleanup,
  transition: BrowserWorkspaceSlotTransition,
): boolean {
  return (
    journal.nonce === transition.nonce &&
    journal.sourceDatabaseName === transition.sourceDatabaseName &&
    journal.destinationDatabaseName === transition.destinationDatabaseName
  )
}

export async function cleanPendingBrowserWorkspaceDatabaseWithinSelection(
  selection: BrowserWorkspaceSelectionGrant,
  expected:
    | BrowserWorkspaceReplacementPreparing
    | BrowserWorkspaceReplacementDiscard
    | BrowserWorkspaceReplacementCleanup,
  signal?: AbortSignal,
): Promise<BrowserWorkspaceDatabaseCleanupResult> {
  if (signal?.aborted) throw signal.reason
  const manifest = await readBrowserWorkspaceDatabaseManifest()
  if (!sameBrowserWorkspaceReplacementJournal(manifest.pending, expected)) {
    return { status: 'changed' }
  }
  let journal: BrowserWorkspaceReplacementDiscard | BrowserWorkspaceReplacementCleanup
  if (expected.phase === 'preparing') {
    await abandonPreparedBrowserWorkspaceDatabase(expected)
    journal = { ...expected, phase: 'discard' }
  } else {
    journal = expected
  }
  const databaseName = obsoleteDatabaseName(journal)
  return withExclusiveBrowserWorkspaceSlots(
    selection,
    [databaseName],
    async () => {
      if (signal?.aborted) throw signal.reason
      const confirmed = await readBrowserWorkspaceDatabaseManifest()
      if (!sameBrowserWorkspaceReplacementJournal(confirmed.pending, journal)) {
        return { status: 'changed' as const }
      }
      await Dexie.delete(databaseName)
      if (signal?.aborted) throw signal.reason
      await completeBrowserWorkspaceDatabaseCleanup(journal)
      return { status: 'cleaned' as const, phase: journal.phase, databaseName }
    },
    signal,
  )
}

function obsoleteDatabaseName(
  journal: BrowserWorkspaceReplacementDiscard | BrowserWorkspaceReplacementCleanup,
): BrowserWorkspaceReplacementDiscard['destinationDatabaseName'] {
  return journal.phase === 'discard' ? journal.destinationDatabaseName : journal.sourceDatabaseName
}
