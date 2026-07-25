import type Dexie from 'dexie'
import type { Transaction } from 'dexie'
import { newId } from '../lib/ulid'
import type { WorkspaceMeta } from './repository'

export const BROWSER_WORKSPACE_FENCE_ID = 'global' as const

export interface BrowserWorkspaceFenceRow {
  id: typeof BROWSER_WORKSPACE_FENCE_ID
  workspaceId: string
  replacementEpoch: number
}

type StoredWorkspaceMeta = WorkspaceMeta & { backendKind: 'browser-idb' }

export function createBrowserWorkspaceId(): string {
  return `browser-idb:${newId()}`
}

export function browserWorkspaceFenceRow(): BrowserWorkspaceFenceRow {
  return {
    id: BROWSER_WORKSPACE_FENCE_ID,
    workspaceId: createBrowserWorkspaceId(),
    replacementEpoch: 0,
  }
}

export async function readBrowserWorkspaceMeta(db: Dexie): Promise<StoredWorkspaceMeta> {
  return storedWorkspaceMeta(
    await db
      .table<BrowserWorkspaceFenceRow, string>('workspaceFence')
      .get(BROWSER_WORKSPACE_FENCE_ID),
  )
}

export async function seedBrowserWorkspaceReplacementMeta(
  db: Dexie,
  source: Pick<WorkspaceMeta, 'workspaceId' | 'replacementEpoch'>,
): Promise<void> {
  await db.table<BrowserWorkspaceFenceRow, string>('workspaceFence').put({
    id: BROWSER_WORKSPACE_FENCE_ID,
    workspaceId: source.workspaceId,
    replacementEpoch: source.replacementEpoch,
  })
}

export async function readBrowserWorkspaceMetaFromTransaction(
  tx: Transaction,
): Promise<StoredWorkspaceMeta> {
  return storedWorkspaceMeta(
    await tx
      .table<BrowserWorkspaceFenceRow, string>('workspaceFence')
      .get(BROWSER_WORKSPACE_FENCE_ID),
  )
}

export async function markBrowserWorkspaceReplaced(
  tx: Transaction,
  previous: WorkspaceMeta,
): Promise<number> {
  if (previous.replacementEpoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error('WorkspaceReplacementEpochExhausted')
  }
  const table = tx.table<BrowserWorkspaceFenceRow, string>('workspaceFence')
  const current = storedWorkspaceMeta(await table.get(BROWSER_WORKSPACE_FENCE_ID))
  if (
    current.workspaceId !== previous.workspaceId ||
    current.replacementEpoch !== previous.replacementEpoch
  ) {
    throw new Error('BrowserWorkspaceFenceChanged')
  }
  const replacementEpoch = previous.replacementEpoch + 1
  await table.put({
    id: BROWSER_WORKSPACE_FENCE_ID,
    workspaceId: previous.workspaceId,
    replacementEpoch,
  })
  return replacementEpoch
}

function storedWorkspaceMeta(row: unknown): StoredWorkspaceMeta {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('BrowserWorkspaceFenceMissingOrInvalid')
  }
  const candidate = row as Record<string, unknown>
  if (
    candidate.id !== BROWSER_WORKSPACE_FENCE_ID ||
    typeof candidate.workspaceId !== 'string' ||
    candidate.workspaceId.length === 0 ||
    typeof candidate.replacementEpoch !== 'number' ||
    !Number.isSafeInteger(candidate.replacementEpoch) ||
    candidate.replacementEpoch < 0
  ) {
    throw new Error('BrowserWorkspaceFenceMissingOrInvalid')
  }
  return {
    workspaceId: candidate.workspaceId,
    backendKind: 'browser-idb',
    replacementEpoch: candidate.replacementEpoch,
  }
}
