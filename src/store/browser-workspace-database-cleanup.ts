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
  tryWithBrowserWorkspaceSelectionGate,
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

export async function cleanPendingBrowserWorkspaceDatabase(
  signal?: AbortSignal,
): Promise<BrowserWorkspaceDatabaseCleanupResult> {
  if (signal?.aborted) throw signal.reason
  const manifest = await readBrowserWorkspaceDatabaseManifest()
  let journal = manifest.pending
  if (!journal) return { status: 'none' }
  if (journal.phase === 'preparing') {
    const claimed = await claimAbandonedPreparedDatabase(journal, signal)
    if (claimed.kind === 'occupied') return { status: 'preparing' }
    if (claimed.kind === 'changed') return { status: 'changed' }
    journal = claimed.journal
  }
  const databaseName = obsoleteDatabaseName(journal)
  return withExclusiveBrowserWorkspaceSlots(
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

async function claimAbandonedPreparedDatabase(
  journal: BrowserWorkspaceReplacementPreparing,
  signal?: AbortSignal,
): Promise<
  | { readonly kind: 'occupied' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'claimed'; readonly journal: BrowserWorkspaceReplacementDiscard }
> {
  const claimed = await tryWithBrowserWorkspaceSelectionGate(async () => {
    const confirmed = await readBrowserWorkspaceDatabaseManifest()
    if (!sameBrowserWorkspaceReplacementJournal(confirmed.pending, journal)) {
      return { kind: 'changed' as const }
    }
    await abandonPreparedBrowserWorkspaceDatabase(journal)
    return {
      kind: 'claimed' as const,
      journal: { ...journal, phase: 'discard' as const },
    }
  }, signal)
  return claimed.acquired ? claimed.value : { kind: 'occupied' }
}

function obsoleteDatabaseName(
  journal: BrowserWorkspaceReplacementDiscard | BrowserWorkspaceReplacementCleanup,
): BrowserWorkspaceReplacementDiscard['destinationDatabaseName'] {
  return journal.phase === 'discard' ? journal.destinationDatabaseName : journal.sourceDatabaseName
}
