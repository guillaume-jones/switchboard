import { useSyncExternalStore } from 'react'

/** A phone-sized touch screen. `Root` mirrors it as the `data-mobile` attribute on `<html>`. */
export const MOBILE_QUERY = '(max-width: 700px) and (pointer: coarse)'

const mobileQuery = matchMedia(MOBILE_QUERY)

export const useMobile = () =>
  useSyncExternalStore(
    listener => {
      mobileQuery.addEventListener('change', listener)
      return () => mobileQuery.removeEventListener('change', listener)
    },
    () => mobileQuery.matches,
  )

/**
 * Styles shared by every card and the shell, injected once by `Root`. Target phones with `:root[data-mobile]`
 * rather than repeating the media query.
 */
export const THEME = `
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
:root[data-mobile] { font-size: 16px; }
:root[data-mobile] :is(button, input, textarea, select) { min-height: 36px; padding: 6px 10px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 999px;
}
`
