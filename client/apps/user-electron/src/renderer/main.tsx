import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@mite/ui/styles.css'
import { App } from './App'
import { MarkingOverlay } from './MarkingOverlay'
import type { MarkingOverlayBridge } from '../shared/marking-overlay'

declare global {
  interface Window {
    miteMarking?: MarkingOverlayBridge
  }
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element was not found')

createRoot(root).render(
  <StrictMode>
    {window.miteMarking ? (
      <MarkingOverlay bridge={window.miteMarking} />
    ) : (
      <App />
    )}
  </StrictMode>,
)
