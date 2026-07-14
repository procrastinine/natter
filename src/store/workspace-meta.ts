import type Dexie from 'dexie'
import type { Transaction } from 'dexie'
import type { WorkspaceMeta } from './repository'

export const WORKSPACE_META_KEY = 'workspace-meta'
const WORKSPACE_ID = 'browser-idb:natter'

interface SettingsValueRow {
  key: string
  value: unknown
}

type StoredWorkspaceMeta = WorkspaceMeta & { backendKind: 'browser-idb' }

function emptyBrowserWorkspaceMeta(): StoredWorkspaceMeta {
  return {
    workspaceId: WORKSPACE_ID,
    backendKind: 'browser-idb',
    lastMutationAt: 0,
    mutationCounter: 0,
    replacementEpoch: 0,
  }
}

function storedWorkspaceMeta(value: unknown): StoredWorkspaceMeta | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Partial<StoredWorkspaceMeta>
  if (
    !(
      typeof row.workspaceId === 'string' &&
      row.backendKind === 'browser-idb' &&
      typeof row.lastMutationAt === 'number' &&
      Number.isFinite(row.lastMutationAt) &&
      Number.isSafeInteger(row.mutationCounter) &&
      (row.mutationCounter ?? -1) >= 0 &&
      Number.isSafeInteger(row.replacementEpoch) &&
      (row.replacementEpoch ?? -1) >= 0
    )
  ) {
    return undefined
  }
  return {
    workspaceId: row.workspaceId,
    backendKind: 'browser-idb',
    lastMutationAt: row.lastMutationAt,
    mutationCounter: row.mutationCounter as number,
    replacementEpoch: row.replacementEpoch as number,
  }
}

export async function readBrowserWorkspaceMeta(db: Dexie): Promise<StoredWorkspaceMeta> {
  const stored = (await db.table<SettingsValueRow, string>('settings').get(WORKSPACE_META_KEY))
    ?.value
  return storedWorkspaceMeta(stored) ?? emptyBrowserWorkspaceMeta()
}

export async function readBrowserWorkspaceMetaFromTransaction(
  tx: Transaction,
): Promise<StoredWorkspaceMeta> {
  const stored = (await tx.table<SettingsValueRow, string>('settings').get(WORKSPACE_META_KEY))
    ?.value
  return storedWorkspaceMeta(stored) ?? emptyBrowserWorkspaceMeta()
}

export async function bumpBrowserWorkspaceMeta(
  tx: Transaction,
  now: number,
  minimumCounter = 0,
): Promise<void> {
  const settings = tx.table<SettingsValueRow, string>('settings')
  const stored = (await settings.get(WORKSPACE_META_KEY))?.value
  const current = storedWorkspaceMeta(stored) ?? emptyBrowserWorkspaceMeta()
  await settings.put({
    key: WORKSPACE_META_KEY,
    value: {
      ...current,
      lastMutationAt: now,
      mutationCounter: Math.max(current.mutationCounter, minimumCounter) + 1,
    } satisfies StoredWorkspaceMeta,
  })
}

export async function markBrowserWorkspaceReplaced(
  tx: Transaction,
  now: number,
  previous: WorkspaceMeta,
): Promise<number> {
  if (previous.replacementEpoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error('WorkspaceReplacementEpochExhausted')
  }
  const settings = tx.table<SettingsValueRow, string>('settings')
  const imported = storedWorkspaceMeta((await settings.get(WORKSPACE_META_KEY))?.value)
  const replacementEpoch = previous.replacementEpoch + 1
  await settings.put({
    key: WORKSPACE_META_KEY,
    value: {
      ...(imported ?? emptyBrowserWorkspaceMeta()),
      workspaceId: WORKSPACE_ID,
      backendKind: 'browser-idb',
      lastMutationAt: now,
      mutationCounter: Math.max(imported?.mutationCounter ?? 0, previous.mutationCounter) + 1,
      replacementEpoch,
    } satisfies StoredWorkspaceMeta,
  })
  return replacementEpoch
}
