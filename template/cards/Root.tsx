import { useLayoutEffect, useMemo, type CSSProperties } from 'react'
import { CardSlot } from 'switchboard'
import { THEME, useMobile } from './lib/theme'

/** Opaque, so iOS extends its colour into the status bar instead of blurring the content below it. */
const TOP_EDGE: CSSProperties = {
  position: 'sticky',
  top: 0,
  flexShrink: 0,
  height: 'var(--top-edge, 0px)',
  background: 'var(--bg)',
}

/** Boards, with Health floating over them; boards become a list on phones. */
export default function Root() {
  const mobile = useMobile()
  useLayoutEffect(() => void document.documentElement.toggleAttribute('data-mobile', mobile), [mobile])
  const boards = useMemo(() => ({ client: mobile ? 'mobile' : 'desktop' }), [mobile])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <style>{THEME}</style>
      <div style={TOP_EDGE} />
      <div className="chip health-anchor">
        <CardSlot component="Health" id="health" />
      </div>
      <main style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <CardSlot component="Boards" id="boards" props={boards} />
      </main>
    </div>
  )
}
