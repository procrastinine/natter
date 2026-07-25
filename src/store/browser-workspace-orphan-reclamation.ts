import Dexie from 'dexie'
import {
  BROWSER_WORKSPACE_DATABASE_NAMES,
  type BrowserWorkspaceDatabaseName,
} from '../lib/origin-storage-names'
import {
  deleteBrowserWorkspaceCompactionState,
  readBrowserWorkspaceDatabaseManifest,
} from './browser-workspace-database-control'
import {
  tryWithBrowserWorkspaceSelectionGate,
  tryWithExclusiveBrowserWorkspaceSlot,
} from './browser-workspace-slot-coordination'

export type BrowserWorkspaceOrphanReclamationResult =
  | { readonly status: 'selection-busy' }
  | {
      readonly status: 'replacement-pending'
      readonly activeDatabaseName: BrowserWorkspaceDatabaseName
      readonly pendingPhase: 'preparing' | 'discard' | 'cleanup'
    }
  | {
      readonly status: 'swept'
      readonly activeDatabaseName: BrowserWorkspaceDatabaseName
      readonly deleted: readonly BrowserWorkspaceDatabaseName[]
      readonly skipped: readonly BrowserWorkspaceDatabaseName[]
      readonly failed: readonly {
        readonly databaseName: BrowserWorkspaceDatabaseName
        readonly reason: string
      }[]
    }

export async function reclaimInactiveBrowserWorkspaceDatabases(): Promise<BrowserWorkspaceOrphanReclamationResult> {
  const snapshot = await tryWithBrowserWorkspaceSelectionGate(async () => {
    const manifest = await readBrowserWorkspaceDatabaseManifest()
    if (manifest.pending) {
      return {
        status: 'replacement-pending' as const,
        activeDatabaseName: manifest.activeDatabaseName,
        pendingPhase: manifest.pending.phase,
      }
    }
    return {
      status: 'candidates' as const,
      activeDatabaseName: manifest.activeDatabaseName,
      databaseNames: BROWSER_WORKSPACE_DATABASE_NAMES.filter(
        (databaseName) => databaseName !== manifest.activeDatabaseName,
      ),
    }
  })
  if (!snapshot.acquired) return { status: 'selection-busy' }
  if (snapshot.value.status === 'replacement-pending') return snapshot.value

  const deleted: BrowserWorkspaceDatabaseName[] = []
  const skipped: BrowserWorkspaceDatabaseName[] = []
  const failed: Array<{ databaseName: BrowserWorkspaceDatabaseName; reason: string }> = []
  for (const databaseName of snapshot.value.databaseNames) {
    const result = await tryWithExclusiveBrowserWorkspaceSlot(databaseName, async () => {
      const validation = await tryWithBrowserWorkspaceSelectionGate(async () => {
        const manifest = await readBrowserWorkspaceDatabaseManifest()
        return manifest.pending === undefined && manifest.activeDatabaseName !== databaseName
      })
      if (!validation.acquired || !validation.value) return { status: 'skipped' as const }
      try {
        await Dexie.delete(databaseName)
        await deleteBrowserWorkspaceCompactionState(databaseName)
        return { status: 'deleted' as const }
      } catch (error) {
        return { status: 'failed' as const, reason: errorText(error) }
      }
    })
    if (!result.acquired || result.value.status === 'skipped') {
      skipped.push(databaseName)
    } else if (result.value.status === 'deleted') {
      deleted.push(databaseName)
    } else {
      failed.push({ databaseName, reason: result.value.reason })
    }
  }
  return {
    status: 'swept',
    activeDatabaseName: snapshot.value.activeDatabaseName,
    deleted,
    skipped,
    failed,
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}:${error.message}` : String(error)
}
