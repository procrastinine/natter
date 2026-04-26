import type { ChatFolder, FolderId } from '../core/types'
import { onEvent } from './broadcast'
import { getDb } from './db'
import type { CreateFolderInput, UpdateFolderInput } from './repository'
import { getWorkspaceRepository } from './workspace-repository'

let cache: ChatFolder[] | null = null
let unsubscribe: (() => void) | null = null

function ensureListener(): void {
  if (unsubscribe) return
  unsubscribe = onEvent((event) => {
    if (event.kind === 'folder-mutated' || event.kind === 'folder-deleted') {
      cache = null
    }
  })
}

export async function listFolders(): Promise<ChatFolder[]> {
  ensureListener()
  // Keep this read synchronous up to the Dexie table access so useLiveQuery can
  // subscribe to folder writes. The UI still depends only on this store-layer
  // abstraction; daemon mode will replace the store implementation.
  try {
    const rows = await getDb().folders.toArray()
    return sortFolders(rows).map((folder) => ({ ...folder }))
  } catch (error) {
    if (error instanceof Error && error.name === 'DatabaseClosedError') return []
    throw error
  }
}

export async function getFolder(folderId: FolderId): Promise<ChatFolder | undefined> {
  ensureListener()
  const cached = cache?.find((folder) => folder.id === folderId)
  if (cached) return { ...cached }
  return getWorkspaceRepository().getFolder(folderId)
}

export async function createFolder(input: CreateFolderInput): Promise<ChatFolder> {
  ensureListener()
  return getWorkspaceRepository().createFolder(input)
}

export async function updateFolder(
  folderId: FolderId,
  patch: UpdateFolderInput,
): Promise<ChatFolder | undefined> {
  ensureListener()
  return getWorkspaceRepository().updateFolder(folderId, patch)
}

export async function deleteFolder(folderId: FolderId): Promise<boolean> {
  ensureListener()
  const result = await getWorkspaceRepository().deleteFolder(folderId)
  return result.deleted
}

export function __resetFolderStoreForTests(): void {
  cache = null
  unsubscribe?.()
  unsubscribe = null
}

function sortFolders(rows: ChatFolder[]): ChatFolder[] {
  return rows.sort((left, right) => {
    if (left.sortIndex !== right.sortIndex) return left.sortIndex - right.sortIndex
    const byName = left.name.localeCompare(right.name)
    return byName !== 0 ? byName : left.id.localeCompare(right.id)
  })
}
