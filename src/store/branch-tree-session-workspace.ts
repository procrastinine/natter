import {
  type BranchTreeSearchSession,
  type BranchTreeSearchSource,
  createBranchTreeSearchSession,
} from './branch-tree-search-session'
import { registerLoadedWorkspaceSessionOwner } from './workspace-session-owner'

class BranchTreeSessionWorkspace {
  private search: {
    readonly source: BranchTreeSearchSource | undefined
    readonly session: BranchTreeSearchSession
  } | null = null
  private terminal = false

  searchFor(source?: BranchTreeSearchSource): BranchTreeSearchSession {
    this.assertOpen()
    const current = this.search
    if (current && current.source === source) return current.session
    current?.session.dispose()
    const session = createBranchTreeSearchSession(source)
    this.search = { source, session }
    return session
  }

  disposeTerminal(): void {
    if (this.terminal) return
    this.disposeSession()
    this.terminal = true
  }

  resetForTests(): void {
    this.disposeSession()
    this.terminal = false
  }

  private disposeSession(): void {
    this.search?.session.dispose()
    this.search = null
  }

  private assertOpen(): void {
    if (this.terminal) throw new Error('BranchTreeSessionWorkspaceDisposed')
  }
}

const workspace = new BranchTreeSessionWorkspace()

registerLoadedWorkspaceSessionOwner('branch-tree-search', workspace)

export const branchTreeSessionWorkspace = Object.freeze({
  searchFor: (source?: BranchTreeSearchSource) => workspace.searchFor(source),
})
