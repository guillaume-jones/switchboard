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
 * rather than repeating the media query. `--top-edge` is the band iOS blurs at the top of an installed app; `Root`
 * fills it with an opaque bar, and anything fixed to the top goes below it.
 */
export const THEME = `
:root {
  color-scheme: dark;
  --bg: #16181c; --panel: #1f2228; --raised: #2c3038; --fg: #f4f2ec; --muted: #9b988f; --border: #343840;
  --accent: #f5b841; --on-accent: #1d1f24; --info: #5aa9e6; --bad: #e0533d; --good: #6cc08b;
  --shadow: 0 1px 2px #0006, 0 4px 16px #0003;
  --radius: 10px;
  font: 13px/1.45 system-ui, -apple-system, sans-serif;
  -webkit-tap-highlight-color: transparent;
}
::selection { background: color-mix(in srgb, var(--info) 35%, transparent); }
a { color: var(--info); }
button, input, textarea, select {
  font: inherit; color: inherit; background: var(--raised); box-sizing: border-box; min-height: 28px;
  border: 1px solid transparent; border-radius: 8px; padding: 3px 10px;
  transition: background-color .12s, border-color .12s, box-shadow .12s, color .12s;
}
input::placeholder, textarea::placeholder { color: var(--muted); }
:is(input, textarea, select):focus {
  outline: none; border-color: var(--info); box-shadow: 0 0 0 3px color-mix(in srgb, var(--info) 25%, transparent);
}
button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  font-weight: 500; white-space: nowrap; cursor: pointer; user-select: none;
}
button:hover:not(:disabled) { background: color-mix(in srgb, var(--raised) 85%, #fff); }
button:active:not(:disabled) { transform: translateY(1px); }
button:disabled { opacity: .45; cursor: default; }
button:focus-visible { outline: 2px solid var(--info); outline-offset: 1px; }
button.primary { background: var(--accent); color: var(--on-accent); font-weight: 600; }
button.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 85%, #fff); }
button.ghost { background: transparent; color: var(--muted); }
button.ghost:hover:not(:disabled) { background: var(--raised); color: var(--fg); }
button.danger:hover:not(:disabled) { color: var(--bad); border-color: var(--bad); }
button.icon { width: 28px; padding: 0; font-size: 15px; line-height: 1; }
button[aria-pressed=true], button[aria-current=page] {
  background: color-mix(in srgb, var(--accent) 22%, var(--raised)); color: var(--fg);
}
:root[data-mobile] { font-size: 16px; }
@media (display-mode: standalone) { :root[data-mobile] { --top-edge: 2rem; } }
@media (pointer: coarse) {
  :is(button, input, select) { min-height: 40px; padding: 6px 14px; }
  button.icon { width: 40px; }
}
:root[data-mobile] :is(button, input, textarea, select) { min-height: 44px; border-radius: 10px; }
:root[data-mobile] button.icon { width: 44px; font-size: 18px; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 999px; border: 3px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-track { background: transparent; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px;
  background: var(--panel); border-radius: 999px; box-shadow: var(--shadow);
}
.badge {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; white-space: nowrap; background: var(--raised); color: var(--muted);
}
.badge[data-tone=accent] { background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--fg); }
.badge[data-tone=info] { background: color-mix(in srgb, var(--info) 20%, transparent); color: var(--fg); }
.badge[data-tone=good] { background: color-mix(in srgb, var(--good) 20%, transparent); color: var(--fg); }
.badge[data-tone=bad] { background: color-mix(in srgb, var(--bad) 22%, transparent); color: var(--fg); }
.heading { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.empty { padding: 20px 12px; text-align: center; color: var(--muted); }
.menu {
  position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 10; max-height: 260px; overflow: auto;
  padding: 4px; background: var(--panel); border-radius: var(--radius); box-shadow: 0 12px 40px #0006;
}
.menu-item { display: flex; align-items: center; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
.menu-item[aria-selected=true] { background: var(--raised); }
:root[data-mobile] .menu-item { min-height: 44px; }
.tile {
  height: 100%; display: flex; flex-direction: column; overflow: hidden;
  background: var(--panel); border: 1px solid transparent; border-radius: var(--radius); box-shadow: var(--shadow);
}
.slot .slot.focused > * { outline: none; }
.tile:has(.slot.focused) { border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.tile.dragging { border-color: var(--accent); box-shadow: 0 8px 32px #0005; }
.tile-bar {
  display: flex; align-items: center; gap: 6px; padding: 2px 4px 2px 10px; min-height: 30px;
}
.tile-bar[data-drag] { cursor: grab; touch-action: none; }
.tile.dragging .tile-bar { cursor: grabbing; }
.tile-bar .heading { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile-bar button { opacity: .6; }
.tile:hover .tile-bar button, .tile-bar button:focus-visible, :root[data-mobile] .tile-bar button { opacity: 1; }
`
