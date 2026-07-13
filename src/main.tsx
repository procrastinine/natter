import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { openDb } from './store/db'
import './app/theme.css'

const debugToolsRequested =
  import.meta.env.DEV &&
  (navigator.userAgent.endsWith(' NatterE2E') ||
    import.meta.env.VITE_NATTER_DEBUG === '1' ||
    new URLSearchParams(window.location.search).has('debug'))

if (debugToolsRequested) {
  const [fakeStream, nuke, scroll, streams] = await Promise.all([
    import('./lib/debug-fake-stream'),
    import('./lib/debug-nuke'),
    import('./lib/debug-scroll'),
    import('./lib/debug-streams'),
  ])
  fakeStream.installDebugFakeStream()
  nuke.installDebugNuke()
  scroll.installDebugScroll()
  streams.installDebugStreams()
}

const container = document.getElementById('root')
if (!container) throw new Error('#root element missing from index.html')

void openDb().then(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
