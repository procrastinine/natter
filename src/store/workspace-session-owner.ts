export type LoadedWorkspaceSessionOwnerId =
  | 'catalog-core'
  | 'storage-catalog'
  | 'branch-tree-search'
  | 'prompt-estimate'

export interface LoadedWorkspaceSessionOwner {
  disposeTerminal(): void
  resetForTests(): void
}

export class LoadedWorkspaceSessionOwnerRegistry {
  private readonly owners = new Map<LoadedWorkspaceSessionOwnerId, LoadedWorkspaceSessionOwner>()
  private terminal = false

  register(id: LoadedWorkspaceSessionOwnerId, owner: LoadedWorkspaceSessionOwner): void {
    const previous = this.owners.get(id)
    if (previous === owner) return
    previous?.disposeTerminal()
    this.owners.set(id, owner)
    if (this.terminal) owner.disposeTerminal()
  }

  disposeTerminal(): void {
    if (this.terminal) return
    this.terminal = true
    this.runOwners('Loaded workspace session disposal failed', (owner) => owner.disposeTerminal())
  }

  resetForTests(): void {
    this.terminal = false
    this.runOwners('Loaded workspace session test reset failed', (owner) => owner.resetForTests())
  }

  private runOwners(
    message: string,
    operation: (owner: LoadedWorkspaceSessionOwner) => void,
  ): void {
    const errors: unknown[] = []
    for (const owner of this.owners.values()) {
      try {
        operation(owner)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, message)
  }
}

const loadedWorkspaceSessionOwners = new LoadedWorkspaceSessionOwnerRegistry()

export function registerLoadedWorkspaceSessionOwner(
  id: LoadedWorkspaceSessionOwnerId,
  owner: LoadedWorkspaceSessionOwner,
): void {
  loadedWorkspaceSessionOwners.register(id, owner)
}

export function disposeLoadedWorkspaceSessionOwners(): void {
  loadedWorkspaceSessionOwners.disposeTerminal()
}

export function resetLoadedWorkspaceSessionOwnersForTests(): void {
  loadedWorkspaceSessionOwners.resetForTests()
}
