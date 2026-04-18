import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import 'streamdown/styles.css'
import 'katex/dist/katex.css'
import './app/theme.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root element missing from index.html')
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
