import type { ChatFolder, FolderId } from '../core/types'
import type {
  CreateFolderInput,
  DeleteFolderResult,
  EnsureFolderAndMoveChatsInput,
  EnsureFolderAndMoveChatsResult,
  UpdateFolderInput,
} from './repository'
import type { WorkspaceWriteAuthority } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceAction } from './workspace-runtime'

export async function createFolder(
  input: CreateFolderInput,
  authority?: WorkspaceWriteAuthority,
): Promise<ChatFolder> {
  const write = (permit: WorkspaceWriteAuthority) =>
    getWorkspaceRepository()
      .execute(permit, { kind: 'folder.create', input })
      .then((envelope) => envelope.value)
  return authority ? write(authority) : runWorkspaceAction('workspace-organization', write)
}

export async function updateFolder(
  folderId: FolderId,
  patch: UpdateFolderInput,
  authority?: WorkspaceWriteAuthority,
): Promise<ChatFolder | undefined> {
  const write = (permit: WorkspaceWriteAuthority) =>
    getWorkspaceRepository()
      .execute(permit, { kind: 'folder.update', folderId, patch })
      .then((envelope) => envelope.value)
  return authority ? write(authority) : runWorkspaceAction('workspace-organization', write)
}

export async function deleteFolderWithDisposition(
  folderId: FolderId,
  chatDisposition: 'move-top-level' | 'archive',
  now = Date.now(),
  authority?: WorkspaceWriteAuthority,
): Promise<DeleteFolderResult> {
  const write = (permit: WorkspaceWriteAuthority) =>
    getWorkspaceRepository()
      .execute(permit, { kind: 'folder.delete', folderId, chatDisposition, now })
      .then((envelope) => envelope.value)
  return authority ? write(authority) : runWorkspaceAction('workspace-organization', write)
}

export async function ensureFolderAndMoveChats(
  input: EnsureFolderAndMoveChatsInput,
  authority?: WorkspaceWriteAuthority,
): Promise<EnsureFolderAndMoveChatsResult> {
  const write = (permit: WorkspaceWriteAuthority) =>
    getWorkspaceRepository()
      .execute(permit, { kind: 'folder.ensure-and-move-chats', input })
      .then((envelope) => envelope.value)
  return authority ? write(authority) : runWorkspaceAction('workspace-organization', write)
}
