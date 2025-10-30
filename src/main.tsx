import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './index.css'
import App from './App.tsx'
import { logAppEnvOnce } from './config/env.ts'

logAppEnvOnce();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
