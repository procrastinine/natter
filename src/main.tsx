import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { installDebugNuke } from './lib/debug-nuke'
import 'streamdown/styles.css'
import 'katex/dist/katex.css'
import './app/theme.css'

if (import.meta.env.DEV) installDebugNuke()

const container = document.getElementById('root')
if (!container) throw new Error('#root element missing from index.html')
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
