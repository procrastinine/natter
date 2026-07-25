import {
  createPromptEstimateContextController,
  type PromptEstimateContextController,
} from './prompt-estimate-context-controller'
import { registerLoadedWorkspaceSessionOwner } from './workspace-session-owner'

class PromptEstimateContextWorkspace {
  private controller: PromptEstimateContextController | null = null
  private terminal = false

  promptEstimate(): PromptEstimateContextController {
    if (this.terminal) throw new Error('PromptEstimateContextWorkspaceDisposed')
    if (this.controller) return this.controller
    this.controller = createPromptEstimateContextController()
    return this.controller
  }

  disposeTerminal(): void {
    if (this.terminal) return
    this.disposeController()
    this.terminal = true
  }

  resetForTests(): void {
    this.disposeController()
    this.terminal = false
  }

  private disposeController(): void {
    this.controller?.dispose()
    this.controller = null
  }
}

const workspace = new PromptEstimateContextWorkspace()

registerLoadedWorkspaceSessionOwner('prompt-estimate', workspace)

export const promptEstimateContextWorkspace = Object.freeze({
  promptEstimate: () => workspace.promptEstimate(),
})
