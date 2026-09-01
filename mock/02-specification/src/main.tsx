import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { MiteProvider } from './state/MiteContext'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <MiteProvider>
        <App />
      </MiteProvider>
    </BrowserRouter>
  </StrictMode>,
)

