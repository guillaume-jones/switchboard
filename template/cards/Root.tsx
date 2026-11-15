import { useLayoutEffect, useMemo, type CSSProperties } from 'react'
import { CardSlot } from 'switchboard'
import { THEME, useMobile } from './lib/theme'

const HEALTH: CSSProperties = {
  position: 'fixed',
  top: 'calc(6px + env(safe-area-inset-top))',
  right: 8,
  zIndex: 5,
}
const FOOTER: CSSProperties = {
  display: 'flex',
  padding: '6px 8px calc(6px + env(safe-area-inset-bottom))',
  borderTop: '1px solid var(--border)',
}

/** Boards, with Health floating over them and the session box as a footer; boards become a list on phones. */
export default function Root() {
  const mobile = useMobile()
  useLayoutEffect(() => void document.documentElement.toggleAttribute('data-mobile', mobile), [mobile])
  const boards = useMemo(() => ({ client: mobile ? 'mobile' : 'desktop' }), [mobile])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <style>{THEME}</style>
      <div className="chip" style={HEALTH}>
        <CardSlot component="Health" id="health" size="compact" />
      </div>
      <main style={{ flex: 1, overflow: 'auto', paddingTop: 'env(safe-area-inset-top)' }}>
        <CardSlot component="Boards" id="boards" props={boards} />
      </main>
      <footer style={FOOTER}>
        <CardSlot component="SessionBox" id="session-box" size="compact" />
      </footer>
    </div>
  )
}
