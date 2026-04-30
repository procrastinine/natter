import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { installDebugFakeStream } from './lib/debug-fake-stream'
import { installDebugNuke } from './lib/debug-nuke'
import { installDebugScroll } from './lib/debug-scroll'
import { installDebugStreams } from './lib/debug-streams'
import { openDb } from './store/db'
import 'streamdown/styles.css'
import 'katex/dist/katex.css'
import './app/theme.css'

if (import.meta.env.DEV) {
  installDebugNuke()
  installDebugStreams()
  installDebugScroll()
  installDebugFakeStream()
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
