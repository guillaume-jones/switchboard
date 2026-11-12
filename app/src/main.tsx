import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Boundary } from './boundary'
import { Shell } from './shell'
import './style.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boundary card="shell" root>
      <Shell />
    </Boundary>
  </StrictMode>,
)
