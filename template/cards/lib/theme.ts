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
  --accent: #3b82f6; --on-accent: #fff; --info: #5aa9e6; --claude: #d97757; --warn: #f5b841; --bad: #e5484d; --good: #6cc08b;
  --shadow: 0 1px 2px #0006, 0 4px 16px #0003;
  --radius: 10px;
  font: 13px/1.45 system-ui, -apple-system, sans-serif;
  -webkit-tap-highlight-color: transparent;
}
html, body { overscroll-behavior: none; }
::selection { background: color-mix(in srgb, var(--info) 35%, transparent); }
a { color: var(--info); }
pre { max-width: 100%; overflow-x: auto; }
button, input, textarea, select {
  font: inherit; color: inherit; background: var(--raised); box-sizing: border-box; min-height: 26px;
  border: 1px solid transparent; border-radius: 8px; padding: 3px 10px;
  transition: background-color .12s, border-color .12s, box-shadow .12s, color .12s;
}
textarea {
  field-sizing: content; resize: none; max-height: 40dvh; min-height: 0; display: block;
  padding-block: calc((26px - 1lh - 2px) / 2);
}
:is(input, textarea, select) { padding-inline: 8px; }
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
button.icon { width: 26px; padding: 0; font-size: 15px; line-height: 1; }
button[aria-pressed=true], button[aria-current=page] {
  background: color-mix(in srgb, var(--accent) 22%, var(--raised)); color: var(--fg);
}
:root[data-mobile] { font-size: 16px; }
@media (display-mode: standalone) { :root[data-mobile] { --top-edge: max(env(safe-area-inset-top, 0px), 1.5rem); --bottom-edge: max(env(safe-area-inset-bottom, 0px), 0.5rem); } }
@media (pointer: coarse) {
  :is(button, input, select) { min-height: 38px; padding: 5px 14px; }
  :is(input, select) { padding: 4px 10px; }
  button.icon { width: 38px; }
  textarea { padding: calc((38px - 1lh - 2px) / 2) 10px; }
}
:root[data-mobile] :is(button, input, select) { min-height: 42px; border-radius: 10px; }
:root input.inline-edit { field-sizing: content; min-width: 2ch; max-width: 100%; min-height: 0; padding: 0 2px; margin-inline: -2px; border: none; border-radius: 4px; background: transparent; }
:root input.inline-edit:focus { box-shadow: none; background: var(--raised); }
:root[data-mobile] textarea { padding-block: calc((42px - 1lh - 2px) / 2); border-radius: 10px; }
:root[data-mobile] button.icon { width: 42px; font-size: 18px; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 999px; border: 3px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-track { background: transparent; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px;
  background: var(--panel); border-radius: 999px; box-shadow: var(--shadow);
}
.connection { position: fixed; inset: var(--top-edge, 0px) 0 auto; height: 1px; overflow: hidden; z-index: 6; background: var(--bad); }
.connection.reconnecting { background: color-mix(in srgb, var(--warn) 25%, transparent); }
.connection.reconnecting::after {
  content: ''; position: absolute; inset: 0 auto 0 0; width: 40%; background: var(--warn);
  animation: connection-slide 1.2s ease-in-out infinite;
}
@keyframes connection-slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
.health-anchor { position: fixed; right: 10px; z-index: 5; padding: 2px; top: calc(var(--top-edge, 0px) + 2px); }
:root[data-mobile] .health-anchor { top: calc(var(--top-edge, 0px) + 3px); }
.health { min-width: 22px; min-height: 22px; padding: 0 6px; border-radius: 999px; }
:root[data-mobile] .health { min-width: 26px; min-height: 26px; }
:root[data-mobile] button.tab { min-height: 32px; padding: 4px 12px; }
.composer {
  display: flex; align-items: flex-end; padding: 4px;
  background: var(--raised); border: 1px solid var(--border); border-radius: 22px; box-shadow: var(--shadow);
}
.composer .attach, :root[data-mobile] .composer .attach { width: 28px; }
.composer [type=submit] { margin-inline: 4px 2px; }
.composer:focus-within { border-color: var(--accent); }
.composer-footer { padding: 6px calc(10px + var(--bottom-edge, 0px)) calc(10px + var(--bottom-edge, 0px)); transition: padding .15s ease-out; }
:root[data-mobile] .composer-footer:focus-within { padding: 4px 6px 6px; }
.chip.file { background: var(--raised); border: 1px solid var(--border); box-shadow: var(--shadow); }
button.chip.file:disabled { opacity: 1; }
.composer textarea { flex: 1; min-width: 0; background: transparent; border: none; box-shadow: none; padding-inline: 4px 16px; }
.message > :first-child { margin-top: 4px; }
.message .chip { vertical-align: middle; box-shadow: none; background: color-mix(in srgb, var(--accent) 22%, var(--panel)); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.grow { display: grid; grid-template-rows: 1fr; animation: grow .2s ease-out; }
@keyframes grow { from { grid-template-rows: 0fr; opacity: 0; } }
.collapse { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows .2s ease-out, opacity .2s; }
.collapse[data-open] { grid-template-rows: 1fr; opacity: 1; }
:is(.grow, .collapse) > * { min-height: 0; overflow: hidden; }
.typing { display: inline-flex; gap: 4px; padding: 6px 0; }
.typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: typing 1.2s infinite; }
.typing i:nth-child(2) { animation-delay: .2s; }
.typing i:nth-child(3) { animation-delay: .4s; }
@keyframes typing { 0%, 60%, 100% { opacity: .25; } 30% { opacity: 1; } }
.composer textarea:focus { box-shadow: none; }
button.round, :root[data-mobile] button.round { border-radius: 999px; }
.tab-close { margin-right: -4px; padding: 0 4px; border-radius: 6px; opacity: .6; }
.tab-close:hover { opacity: 1; background: var(--raised); }
:root[data-mobile] button.icon.small { width: 30px; min-height: 30px; font-size: 16px; }
.badge {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; white-space: nowrap; background: var(--raised); color: var(--muted);
}
[data-tone=accent] { --tone: var(--accent); }
[data-tone=info] { --tone: var(--info); }
[data-tone=warn] { --tone: var(--warn); }
[data-tone=good] { --tone: var(--good); }
[data-tone=bad] { --tone: var(--bad); }
.badge[data-tone] {
  background: color-mix(in srgb, var(--tone) 32%, transparent); color: color-mix(in srgb, var(--tone) 45%, var(--fg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 55%, transparent);
}
button.tab[data-tone], button.tab[data-tone]:hover:not(:disabled) { background: color-mix(in srgb, var(--tone) 36%, var(--raised)); color: var(--fg); }
button.tab:not([data-tone]), button.tab:not([data-tone]):hover:not(:disabled) { background: var(--raised); color: var(--fg); }
button.tab:hover:not(:disabled) { filter: brightness(1.15); }
button.tab[aria-current=page] { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fg) 30%, transparent); }
.heading { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.empty { padding: 20px 12px; text-align: center; color: var(--muted); }
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
