import type { CSSProperties } from 'react'
import { CardSlot } from 'switchboard'

/** Theme variables used by every card and by the shell. */
const THEME = `
:root {
  --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --border: #d2d2d7;
  --panel: #f2f2f4; --accent: #0a64d8; --bad: #c62828;
  font: 13px/1.4 system-ui, -apple-system, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1c1e; --fg: #e5e5e7; --muted: #8e8e93; --border: #3a3a3c;
    --panel: #2a2a2d; --accent: #4c9bff; --bad: #ff6b6b;
  }
}
button, input, textarea, select {
  font: inherit; color: inherit; background: var(--panel);
  border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px;
}
`

const HEADER: CSSProperties = {
  display: 'flex',
  gap: 12,
  alignItems: 'center',
  padding: '4px 8px',
  borderBottom: '1px solid var(--border)',
}

export default function Root() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <style>{THEME}</style>
      <header style={HEADER}>
        <CardSlot component="EditBox" id="edit-box" size="compact" />
        <CardSlot component="Health" id="health" size="compact" />
      </header>
      <main style={{ flex: 1, overflow: 'auto' }}>
        <CardSlot component="Boards" id="boards" />
      </main>
    </div>
  )
}
