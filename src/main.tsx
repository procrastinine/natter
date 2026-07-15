import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { WorkspaceBootstrap, type WorkspaceOpenOptions } from './app/WorkspaceBootstrap'
import { nukeSiteStorage } from './lib/debug-nuke'
import { installPreloadErrorRecovery } from './lib/preload-recovery'
import { closeDb, openDb } from './store/db'
import './app/theme.css'

installPreloadErrorRecovery()

const debugToolsRequested =
  import.meta.env.DEV &&
  (navigator.userAgent.endsWith(' NatterE2E') ||
    import.meta.env.VITE_NATTER_DEBUG === '1' ||
    new URLSearchParams(window.location.search).has('debug'))

let debugToolsPromise: Promise<void> | null = null

function installDebugTools(): Promise<void> {
  if (!debugToolsRequested) return Promise.resolve()
  debugToolsPromise ??= Promise.all([
    import('./lib/debug-fake-stream'),
    import('./lib/debug-nuke'),
    import('./lib/debug-scroll'),
    import('./lib/debug-streams'),
  ]).then(([fakeStream, nuke, scroll, streams]) => {
    fakeStream.installDebugFakeStream()
    nuke.installDebugNuke()
    scroll.installDebugScroll()
    streams.installDebugStreams()
  })
  return debugToolsPromise
}

async function prepareWorkspace(options: WorkspaceOpenOptions): Promise<void> {
  await Promise.all([installDebugTools(), openDb(options)])
}

const container = document.getElementById('root')
if (!container) throw new Error('#root element missing from index.html')

createRoot(container).render(
  <StrictMode>
    <WorkspaceBootstrap
      openWorkspace={prepareWorkspace}
      beforeRetry={closeDb}
      resetWorkspace={() => nukeSiteStorage({ skipReload: true })}
    >
      <App />
    </WorkspaceBootstrap>
  </StrictMode>,
)
