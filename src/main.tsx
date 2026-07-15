import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { WorkspaceBootstrap, type WorkspaceOpenOptions } from './app/WorkspaceBootstrap'
import { installPreloadErrorRecovery } from './lib/preload-recovery'
import { wipeSiteStorage } from './lib/storage-wipe'
import { closeDb, openDb } from './store/db'
import './app/theme.css'

installPreloadErrorRecovery()

async function prepareWorkspace(options: WorkspaceOpenOptions): Promise<void> {
  await openDb(options)
}

const container = document.getElementById('root')
if (!container) throw new Error('#root element missing from index.html')

createRoot(container).render(
  <StrictMode>
    <WorkspaceBootstrap
      openWorkspace={prepareWorkspace}
      beforeRetry={closeDb}
      resetWorkspace={() => wipeSiteStorage({ skipReload: true })}
    >
      <App />
    </WorkspaceBootstrap>
  </StrictMode>,
)
