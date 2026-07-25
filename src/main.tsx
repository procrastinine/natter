import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { browserConversationNavigationPort } from './app/router'
import { WorkspaceBootstrap } from './app/WorkspaceBootstrap'
import { installPreloadErrorRecovery } from './lib/preload-recovery'
import { getBrowserRepository } from './store/browser-repo'
import {
  installBrowserWorkspaceLifecycle,
  openBrowserWorkspace,
} from './store/browser-workspace-lifecycle'
import { conversationController } from './store/conversation-controller'
import type { BrowserWorkspaceOpenOptions } from './store/presentation-contracts'
import {
  awaitStorageAdministrationReady,
  clearLocalWorkspaceStorage,
  installStorageAdministrationResponder,
} from './store/storage-administration'
import { installWorkspaceRepositoryFactory } from './store/workspace-repository'
import './app/theme.css'

installPreloadErrorRecovery()
installWorkspaceRepositoryFactory(getBrowserRepository)
installBrowserWorkspaceLifecycle()
installStorageAdministrationResponder()
conversationController.setNavigationPort(browserConversationNavigationPort)

async function prepareWorkspace(options: BrowserWorkspaceOpenOptions): Promise<void> {
  options.onProgress?.({ kind: 'storage-administration' })
  await awaitStorageAdministrationReady()
  await openBrowserWorkspace(options)
}

const container = document.getElementById('root')
if (!container) throw new Error('#root element missing from index.html')

createRoot(container).render(
  <StrictMode>
    <WorkspaceBootstrap
      openWorkspace={prepareWorkspace}
      resetWorkspace={() => clearLocalWorkspaceStorage({ skipReload: true })}
    >
      <App />
    </WorkspaceBootstrap>
  </StrictMode>,
)
