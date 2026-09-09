import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js')
  })
}

const root = document.getElementById('root')
if (!root) throw new Error('Root element was not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
