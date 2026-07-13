import type { ChatFolder, FolderId } from '../core/types'
import { getDb } from './db'
import type { CreateFolderInput, UpdateFolderInput } from './repository'
import { getWorkspaceRepository } from './workspace-repository'

export async function listFolders(): Promise<ChatFolder[]> {
  // Keep this read synchronous up to the Dexie table access so reactive queries can
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

export async function createFolder(input: CreateFolderInput): Promise<ChatFolder> {
  return getWorkspaceRepository().createFolder(input)
}

export async function updateFolder(
  folderId: FolderId,
  patch: UpdateFolderInput,
): Promise<ChatFolder | undefined> {
  return getWorkspaceRepository().updateFolder(folderId, patch)
}

export async function deleteFolder(folderId: FolderId): Promise<boolean> {
  const result = await getWorkspaceRepository().deleteFolder(folderId)
  return result.deleted
}

export function __resetFolderStoreForTests(): void {}

function sortFolders(rows: ChatFolder[]): ChatFolder[] {
  return rows.sort((left, right) => {
    if (left.sortIndex !== right.sortIndex) return left.sortIndex - right.sortIndex
    const byName = left.name.localeCompare(right.name)
    return byName !== 0 ? byName : left.id.localeCompare(right.id)
  })
}
