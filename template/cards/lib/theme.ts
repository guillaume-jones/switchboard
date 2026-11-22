import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react'

/** A phone-sized touch screen. `Root` mirrors it as the `data-mobile` attribute on `<html>`. */
export const MOBILE_QUERY = '(max-width: 700px) and (pointer: coarse), (max-height: 500px) and (pointer: coarse)'

const mobileQuery = matchMedia(MOBILE_QUERY)

export const useMobile = () =>
  useSyncExternalStore(
    listener => {
      mobileQuery.addEventListener('change', listener)
      return () => mobileQuery.removeEventListener('change', listener)
    },
    () => mobileQuery.matches,
  )

/** Calls onFind on ⌘F while focus, or else the last click, is inside area. */
export function useFindKey(area: RefObject<HTMLElement | null>, onFind: () => void) {
  const find = useRef(onFind)
  find.current = onFind
  useEffect(() => {
    let clicked = false
    const onPointer = (e: PointerEvent) => (clicked = !!area.current?.contains(e.target as Node))
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey || e.key.toLowerCase() !== 'f') return
      const focused = document.activeElement
      const inside = focused && focused !== document.body ? !!area.current?.contains(focused) : clicked
      if (!inside) return
      e.preventDefault()
      find.current()
    }
    addEventListener('pointerdown', onPointer, true)
    addEventListener('keydown', onKey)
    return () => {
      removeEventListener('pointerdown', onPointer, true)
      removeEventListener('keydown', onKey)
    }
  }, [])
}

/**
 * Styles shared by every card and the shell, injected once by `Root`. Target phones with `:root[data-mobile]`
 * rather than repeating the media query. `--top-edge` is the band iOS blurs at the top of an installed app; `Root`
 * fills it with an opaque bar, and anything fixed to the top goes below it.
 */
export const THEME = `
:root {
  color-scheme: dark;
  scrollbar-color: #ffffff40 transparent;
  --bg: #16181c; --panel: #1f2228; --raised: #2c3038; --fg: #f4f2ec; --muted: #9b988f; --border: #343840;
  --accent: #2563eb; --on-accent: #fff; --info: #5aa9e6; --claude: #d97757; --warn: #f5b841; --bad: #e5484d; --notify: var(--warn); --good: #6cc08b; --agents: #a78bfa;
  --shadow: 0 1px 2px #0006, 0 4px 16px #0003;
  --radius: 10px;
  font: 13px/1.45 system-ui, -apple-system, sans-serif;
  -webkit-tap-highlight-color: transparent;
  -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
}
html, body { overscroll-behavior: none; }
::selection { background: color-mix(in srgb, var(--info) 35%, transparent); }
a { color: var(--info); }
a[data-local] { cursor: pointer; text-decoration: underline dotted; }
:root[data-mobile] a[data-local] { color: inherit; cursor: auto; text-decoration: none; }
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
button:is([aria-pressed=true], [aria-current=page]):not(:disabled) {
  background: color-mix(in srgb, var(--accent) 22%, var(--raised)); color: var(--fg);
}
:root[data-mobile] { font-size: 16px; }
@media (display-mode: standalone) { :root[data-mobile] { --top-edge: env(safe-area-inset-top, 0px); --bottom-edge: max(env(safe-area-inset-bottom, 0px), 0.5rem); } }
@media (pointer: coarse) {
  :is(button, input, select) { min-height: 38px; padding: 5px 14px; }
  :is(input, select) { padding: 4px 10px; }
  button.icon { width: 38px; }
  textarea { padding: calc((38px - 1lh - 2px) / 2) 10px; }
}
:root[data-mobile] :is(button, input, select) { min-height: 42px; border-radius: 10px; }
:root input.inline-edit { field-sizing: content; min-width: 2ch; max-width: 100%; min-height: 0; padding: 0 2px; margin-inline: -2px; border: none; border-radius: 4px; background: transparent; }
:root input.inline-edit:focus { box-shadow: none; background: var(--raised); }
:root select.inline-edit { appearance: none; min-height: 0; padding: 0 2px; margin-inline: -2px; border: none; border-radius: 4px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
:root select.inline-edit:is(:hover, :focus) { box-shadow: none; background: var(--raised); }
:root[data-mobile] textarea { padding-block: calc((42px - 1lh - 2px) / 2); border-radius: 10px; }
:root[data-mobile] button.icon { width: 42px; font-size: 18px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px;
  background: var(--panel); border-radius: 999px;
}
.connection { position: fixed; inset: var(--top-edge, 0px) 0 auto; height: 1px; overflow: hidden; z-index: 6; background: var(--bad); }
.connection.reconnecting { background: color-mix(in srgb, var(--warn) 25%, transparent); }
.connection.reconnecting::after {
  content: ''; position: absolute; inset: 0 auto 0 0; width: 40%; background: var(--warn);
  animation: connection-slide 1.2s ease-in-out infinite;
}
@keyframes connection-slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
.composer {
  display: flex; align-items: flex-end; padding: 4px;
  background: var(--raised); border: 1px solid var(--border); border-radius: 22px; box-shadow: var(--shadow);
}
.composer .attach, :root[data-mobile] .composer .attach { width: 28px; }
.composer-row { display: flex; align-items: flex-end; gap: 4px; }
.composer-row > button { margin-bottom: 9px; }
.composer:focus-within { border-color: var(--accent); }
.composer-footer { padding: 6px calc(10px + var(--bottom-edge, 0px)) calc(10px + var(--bottom-edge, 0px)); transition: padding .15s ease-out; }
:root[data-mobile] .composer-footer:focus-within { padding: 4px 6px 6px; }
.chip.file { background: var(--raised); }
button.chip.file:disabled { opacity: 1; }
.composer textarea { flex: 1; min-width: 0; background: transparent; border: none; box-shadow: none; padding-inline: 12px 4px; }
.composer-field { position: relative; flex: 1; min-width: 0; align-self: center; }
.composer-field textarea { width: 100%; }
.composer-field[data-chips] textarea { color: transparent; caret-color: var(--fg); transition: none; scrollbar-width: none; }
.composer-layer {
  position: absolute; inset: 0; box-sizing: border-box; overflow: hidden; pointer-events: none;
  white-space: pre-wrap; overflow-wrap: break-word;
}
.composer-chip {
  pointer-events: auto; cursor: default; border-radius: 999px; box-decoration-break: clone; -webkit-box-decoration-break: clone;
  background: color-mix(in srgb, var(--fg) 10%, transparent);
}
.composer-chip:not([data-staged]) { opacity: .5; }
.composer-chip[data-image][data-staged] { cursor: pointer; }
.composer-chip[data-image] { background: color-mix(in srgb, #a78bfa 22%, transparent); }
.composer-buttons { display: flex; align-items: center; gap: 2px; margin-left: auto; }
:root[data-mobile] .composer:has(textarea:focus) { flex-wrap: wrap; }
:root[data-mobile] .composer:has(textarea:focus) .composer-field { flex-basis: 100%; }
.dictation { display: flex; align-items: center; margin-right: 5px; }
/* Above the message box, which is the nearest positioned ancestor. */
.dictate-status { position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 3; box-sizing: border-box; max-width: 100%; flex-wrap: wrap; border-radius: var(--radius); box-shadow: var(--shadow); }
/* Cancel slides out from under the mic over the paperclip. Only transforms and opacity are animated, which keeps iOS
   smooth while the microphone starts and stops, and takes no room, so nothing is laid out again. */
:root .composer .dictation .dictate-cancel {
  width: 28px; margin: 0 2px 0 -30px; opacity: 0; visibility: hidden; transform: translateX(30px); will-change: transform, opacity;
  transition: transform .2s ease-out, opacity .2s ease-out, visibility .2s;
}
:root .composer .dictation:is([data-phase=recording], [data-phase=transcribing]) .dictate-cancel { opacity: 1; visibility: visible; transform: none; }
:root .composer .attach { will-change: opacity; transition: opacity .2s ease-out, visibility .2s; }
:root .composer .composer-buttons:has(.dictation:is([data-phase=recording], [data-phase=transcribing])) .attach { opacity: 0; visibility: hidden; }
.composer .dictate { position: relative; isolation: isolate; transition: color .2s; }
:root .composer .dictation[data-phase=recording] .dictate { color: var(--bad); background: transparent; }
/* Drawn smaller than the button, which keeps its tap target. */
.dictation[data-phase=recording] .dictate::before {
  content: ''; position: absolute; inset: 0; z-index: -1; border-radius: 50%;
  background: color-mix(in srgb, var(--bad) 16%, transparent);
}
.dictate-ring {
  position: absolute; inset: 0; border-radius: 50%; opacity: 0; will-change: opacity; pointer-events: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--bad) 70%, transparent);
}
@media (prefers-reduced-motion: reduce) { :root .composer :is(.dictation .dictate-cancel, .attach) { transition: none; } }
.composer textarea::placeholder { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
:root[data-mobile] .composer textarea { max-height: 25dvh; }
.message > :first-child { margin-top: 4px; }
.message > :last-child { margin-bottom: 8px; }
.message blockquote { margin: 8px 0; padding: 0 0 0 12px; border-left: 3px solid; color: color-mix(in srgb, var(--fg) 75%, var(--panel)); }
.message { overflow-wrap: break-word; }
.message table { display: block; max-width: 100%; overflow-x: auto; }
.message .code-block { position: relative; }
.message .code-block pre { padding: 8px 10px; border-radius: calc(var(--radius) - 4px); background: color-mix(in srgb, black 18%, transparent); }
.message .code-actions { position: absolute; top: 4px; right: 4px; display: flex; gap: 2px; opacity: 0; transition: opacity .1s; }
:root .message .code-actions button { min-height: 0; padding: 2px 8px; font-size: 12px; }
.message .code-block:hover .code-actions, .message .code-actions:focus-within, :root[data-mobile] .message .code-actions { opacity: 1; }
.message:not([data-runnable]) .run-code { display: none; }
.message .chip { vertical-align: middle; box-shadow: none; border: none; background: color-mix(in srgb, var(--fg) 10%, var(--raised)); }
:root .message button.chip { min-height: 0; padding: 0 8px; font-size: .9em; font-weight: 400; line-height: 1.5; vertical-align: baseline; }
.message .chip.file[data-doc] { background: color-mix(in srgb, var(--info) 16%, var(--raised)); }
.message .chip.file[data-doc]:is([data-local$=".html" i], [data-local$=".htm" i]) { background: color-mix(in srgb, #fb923c 16%, var(--raised)); }
.message .chip.file[data-image] { background: color-mix(in srgb, #a78bfa 16%, var(--raised)); }
.message .section-actions { display: inline-flex; gap: 2px; margin-left: 6px; vertical-align: middle; opacity: 0; transition: opacity .1s; }
:root .message .section-actions button { min-height: 0; width: auto; padding: 2px 4px; color: var(--muted); }
.message [data-section]:hover .section-actions, .message .section-actions:focus-within { opacity: 1; }
:root[data-mobile] .message .section-actions { opacity: .7; }
.message .quote-section { display: none; }
:root .quote-target .message .quote-section { display: inline-flex; }
.image-peek {
  position: fixed; z-index: 30; padding: 4px; pointer-events: none;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow);
  transition: opacity .12s ease-out;
}
@starting-style { .image-peek { opacity: 0; } }
.image-peek img { display: block; max-width: min(480px, calc(100vw - 24px)); max-height: min(50dvh, var(--room)); border-radius: calc(var(--radius) - 4px); }
.image-peek .empty { display: grid; place-items: center; width: 160px; height: 100px; }
.question { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.decision { max-height: 55vh; overflow: auto; overscroll-behavior: contain; }
.options { display: flex; flex-direction: column; gap: 4px; }
.options input { width: 100%; padding: 6px 12px; border-radius: 10px; background: transparent; }
.options input:not(:focus) { border-color: var(--border); }
button.option {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; padding: 6px 12px;
  text-align: left; font-weight: 400; white-space: normal; background: var(--panel); border-radius: 10px; transition: background .15s, box-shadow .15s;
}
button.option .description { font-size: 12px; color: var(--muted); }
button.option[aria-pressed=true] { background: color-mix(in srgb, var(--accent) 18%, var(--panel)); box-shadow: inset 0 0 0 1px var(--accent); }
.collapse { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows .25s ease-in-out, opacity .25s; }
.collapse[data-open] { grid-template-rows: 1fr; opacity: 1; }
.collapse > * { min-height: 0; overflow: hidden; }
.transcript-item:not([data-near]) { content-visibility: auto; contain-intrinsic-size: auto 40px; }
.grow { display: grid; animation: grow .1s ease-out; }
.grow.slow { animation-duration: .4s; }
.grow > * { min-height: 0; overflow: hidden; }
@keyframes grow { from { grid-template-rows: 0fr; opacity: 0; } to { grid-template-rows: 1fr; opacity: 1; } }
.typing { display: inline-flex; gap: 4px; padding: 6px 0 2px; }
.typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: typing 1.2s ease-in-out infinite; }
.typing i:nth-child(2) { animation-delay: .15s; }
.typing i:nth-child(3) { animation-delay: .3s; }
.diff { margin-top: 2px; font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.diff [data-op="+"] { background: color-mix(in srgb, var(--good) 15%, transparent); }
.diff [data-op="-"] { background: color-mix(in srgb, var(--bad) 15%, transparent); }
.diff [data-op=" "] { color: var(--muted); }
.fade-in { animation: fade-in .15s ease-out; }
.preview-split { flex: 1; min-height: 0; display: flex; container-type: inline-size; }
.preview-split[data-resizing] { user-select: none; -webkit-user-select: none; cursor: col-resize; }
.preview-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.preview-main[hidden] { display: none; }
.preview {
  position: relative; flex: 0 0 calc(var(--preview) * 1%); min-width: 0; display: flex; justify-content: flex-end;
  overflow: hidden; border-left: 1px solid var(--border);
}
.preview[data-phase=opening] { animation: preview-open .2s ease-out; }
.preview[data-phase=closing] { flex-basis: 0; animation: preview-close .2s ease-in; }
.preview-body { flex: none; width: calc(var(--preview) * 1cqw - 1px); display: flex; flex-direction: column; }
.preview-bar { display: flex; flex: none; background: var(--bg); box-shadow: inset 0 -1px var(--border); }
.preview-tabs { display: flex; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
:root[data-mobile] .preview-collapse { flex: none; width: 48px; min-height: 0; padding: 0; border: none; background: none; box-shadow: none; color: var(--fg); }
:root[data-mobile] .preview-tab { height: 44px; }
.preview-tab {
  display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 220px; height: 36px; padding: 0 8px 0 14px;
  border-right: 1px solid var(--border); color: var(--muted); cursor: pointer; user-select: none;
}
.preview-tab:not([data-active]) { box-shadow: inset 0 -1px var(--border); }
.preview-tab[data-active] { background: var(--panel); color: var(--fg); }
.preview-tab:not([data-active]):hover { background: color-mix(in srgb, var(--fg) 4%, var(--bg)); }
:root .preview-tab-close {
  display: grid; place-items: center; flex: none; width: 16px; min-height: 16px; height: 16px; padding: 0;
  background: none; border: none; box-shadow: none; color: var(--muted); visibility: hidden;
}
.preview-tab:is([data-active], :hover) .preview-tab-close, :root[data-mobile] .preview-tab-close { visibility: visible; }
:root .preview-tab-close:hover { color: var(--fg); background: none; }
.doc { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.doc-path { flex: none; padding: 8px 16px; font-size: 12px; color: var(--muted); }
.doc-path a { color: inherit; text-decoration: none; }
.doc-path a:hover { color: var(--fg); text-decoration: underline; }
.image-stage { flex: 1; min-height: 0; display: flex; overflow: hidden; overscroll-behavior: contain; touch-action: pan-x pan-y; }
.image-stage > * { flex: none; margin: auto; }
.image-stage img { display: block; max-width: none; user-select: none; -webkit-user-select: none; }
.image-stage[data-zoomed] { overflow: auto; }
.image-stage[data-zoomed] img { cursor: grab; }
.image-stage[data-zoomed] img:active { cursor: grabbing; }
:root .doc > textarea.doc-text {
  flex: 1; min-height: 0; max-height: none; width: 100%; padding: 8px 16px; resize: none;
  background: transparent; border: none; border-radius: 0; box-shadow: none;
}
.doc-edit-bar { flex: none; display: flex; align-items: center; gap: 6px; padding: 6px 12px calc(6px + var(--bottom-edge, 0px)); border-top: 1px solid var(--border); }
.doc-edit-bar > span { flex: 1; min-width: 0; font-size: 12px; color: var(--muted); }
.doc-frame { flex: 1; min-height: 0; width: 100%; border: 0; background: #fff; }
.doc > .message { flex: 1; min-height: 0; overflow: hidden auto; overscroll-behavior: contain; padding: 0 16px 16px; }
.preview-handle { position: relative; flex: none; width: 0; z-index: 3; cursor: col-resize; touch-action: none; }
.preview-handle::before { content: ''; position: absolute; inset: 0 -4px; }
.preview-handle::after { content: ''; position: absolute; inset: 0 auto 0 -0.5px; width: 2px; background: color-mix(in srgb, var(--accent) 45%, transparent); opacity: 0; transition: opacity .15s; }
.preview-handle:hover::after { opacity: 1; transition-delay: .15s; }
.preview-handle:active::after { opacity: 1; transition-delay: 0s; }
:root[data-mobile] .preview { flex: 1; border-left: none; }
:root[data-mobile] .preview-body { flex: 1; width: auto; min-width: 0; }
:root[data-mobile] .preview-handle { display: none; }
@keyframes preview-open { from { flex-basis: 0; } }
@keyframes preview-close { from { flex-basis: calc(var(--preview) * 1%); } }
@keyframes fade-in { from { opacity: 0; } }
.spinner { display: inline-block; width: 12px; height: 12px; margin: 4px 0; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.spinner.ci { width: 10px; height: 10px; margin: 0; border-width: 1.5px; border-top-color: var(--warn); }
.spinner.ci.waiting { animation: none; border-top-color: var(--muted); }
@keyframes typing { 0%, 60%, 100% { opacity: .35; transform: none; } 30% { opacity: 1; transform: translateY(-4px); } }
.composer textarea:focus { box-shadow: none; }
button.round, :root[data-mobile] button.round { border-radius: 999px; }
:root[data-mobile] button.icon.small { width: 30px; min-height: 30px; font-size: 16px; }
.badge {
  display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; white-space: nowrap; background: var(--raised); color: var(--muted);
}
:root button.badge { min-height: 0; padding: 1px 8px; border-radius: 999px; }
[data-tone=accent] { --tone: var(--accent); }
[data-tone=info] { --tone: var(--info); }
[data-tone=warn] { --tone: var(--warn); }
[data-tone=good] { --tone: var(--good); }
[data-tone=bad] { --tone: var(--bad); }
[data-tone=agents] { --tone: var(--agents); }
[data-tone=muted] { --tone: var(--muted); }
[data-tone=faint] { --tone: color-mix(in srgb, var(--info) 45%, var(--muted)); }
.badge[data-tone] {
  background: color-mix(in srgb, var(--tone) 32%, transparent); color: color-mix(in srgb, var(--tone) 45%, var(--fg));
}
.sidebar { width: 248px; flex-shrink: 0; display: flex; flex-direction: column; background: var(--panel); border-right: 1px solid var(--border); }
:root[data-mobile] .sidebar { position: fixed; inset: 0 auto 0 0; z-index: 10; width: min(300px, 85vw); padding-top: var(--top-edge, 0px); box-shadow: 0 16px 48px #000b; }
.sidebar-top { padding: 8px 6px 0; }
.sidebar-top input { width: 100%; }
.nav-icon { width: 14px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: var(--muted); }
.nav-note { padding: 4px 8px 4px 30px; }
.sidebar-scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 8px 6px; }
.sidebar-section { display: flex; flex-direction: column; gap: 1px; margin-bottom: 12px; }
.sidebar-section > .heading { display: flex; align-items: center; justify-content: space-between; min-height: 28px; padding: 2px 4px 2px 8px; }
.sidebar-footer { padding: 6px 6px calc(6px + var(--bottom-edge, 0px)); border-top: 1px solid var(--border); }
.nav-item { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 2px 4px 2px 8px; border-radius: 8px; cursor: pointer; user-select: none; }
.nav-item:hover { background: var(--raised); }
.nav-item:focus-visible { outline: 2px solid var(--info); outline-offset: -2px; }
.nav-item[aria-current=page] { background: color-mix(in srgb, var(--accent) 22%, var(--raised)); }
:root[data-mobile] .nav-item { min-height: 44px; }
.nav-item .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { color: var(--muted); font-size: 11px; }
.nav-item .label .sub { display: block; overflow: hidden; text-overflow: ellipsis; }
.hover-action { opacity: 0; }
.nav-item:is(:hover, :focus-within, [aria-current=page]) .hover-action, :root[data-mobile] .hover-action { opacity: .7; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--tone, var(--border)); }
.dot[data-notified] { outline: 1.5px solid var(--notify); outline-offset: 2.5px; }
.dot:is([data-status=working], [data-status=waiting]) { display: grid; background: none; }
.dot:is([data-status=working], [data-status=waiting])::before { content: ""; border-radius: inherit; background: var(--tone, var(--border)); animation: dot-pulse 1.4s ease-in-out infinite; }
@keyframes dot-pulse { 50% { opacity: .5; transform: scale(.8); } }
@media (prefers-reduced-motion: reduce) { .dot:is([data-status=working], [data-status=waiting])::before { animation: none; } }
.backdrop { position: fixed; inset: 0; z-index: 9; background: #0008; }
.mobile-bar { display: flex; align-items: center; gap: 6px; padding: 2px 6px; flex-shrink: 0; }
.mobile-bar.floating { position: absolute; z-index: 2; top: 2px; left: 0; }
.board-header {
  flex-shrink: 0; position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center;
  padding: 6px 10px; overflow-wrap: anywhere; background: var(--bg); border-bottom: 1px solid var(--border); box-shadow: var(--shadow);
}
:root[data-mobile] .board-header { padding-left: 54px; }
.transcript-search { display: flex; align-items: center; gap: 4px; padding: 6px 10px; flex-shrink: 0; background: var(--bg); border-bottom: 1px solid var(--border); }
.transcript-search input { flex: 1; min-width: 0; border: 1px solid var(--border); border-radius: 12px; font-size: 13px; }
.transcript-search .sub { color: var(--muted); font-size: 12px; white-space: nowrap; }
::highlight(search) { background: color-mix(in srgb, var(--accent) 30%, transparent); color: inherit; }
::highlight(search-current) { background: var(--accent); color: var(--on-accent); }
button.health { width: 100%; justify-content: flex-start; font-weight: 400; }
button.health .dot { width: .5em; height: .5em; }
.usage { position: relative; color: var(--muted); display: flex; align-items: center; gap: 10px; min-height: 26px; padding: 3px 11px; box-sizing: border-box; cursor: default; outline: none; }
.usage-tip {
  display: none; position: absolute; bottom: calc(100% + 4px); left: 6px; right: 6px; z-index: 10; padding: 6px 10px;
  color: var(--fg); background: var(--raised); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow);
}
.usage:hover .usage-tip, .usage[data-open] .usage-tip { display: block; }
.usage-bar { flex: 1; height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; }
.usage-bar > div { height: 100%; background: var(--accent); }
.modal {
  position: fixed; z-index: 21; top: max(10dvh, var(--top-edge, 0px)); left: 50%; translate: -50% 0;
  width: min(560px, calc(100vw - 20px)); max-height: 75dvh; overflow: auto;
  background: var(--panel); border: 1px solid color-mix(in srgb, var(--fg) 14%, transparent); border-radius: var(--radius); box-shadow: 0 4px 16px #0004;
}
.modal, .backdrop:has(+ .modal) { transition: opacity .15s ease-out, visibility .15s; }
@starting-style { .modal, .backdrop:has(+ .modal) { opacity: 0; } }
.modal[data-closed], .backdrop[data-closed] { opacity: 0; visibility: hidden; }
.backdrop:has(+ .modal) { z-index: 20; }
.chat-options { display: flex; gap: 6px; margin-bottom: 6px; }
.chat-options > button { border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); font-size: 13px; }
.folder-picker { position: relative; flex: 1; min-width: 0; }
.chat-options select {
  appearance: none; padding-right: 26px; border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); font-size: 13px; cursor: pointer;
  background: var(--raised) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2.5 4 5 1.5 7.5 4M2.5 6 5 8.5 7.5 6'/%3E%3C/svg%3E") no-repeat right 9px center;
}
.folder-picker input { display: block; width: 100%; border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); font-size: 13px; }
.folder-list {
  position: absolute; z-index: 5; bottom: calc(100% + 4px); left: 0; right: 0; max-height: 240px; overflow: auto; padding: 4px;
  background: var(--raised); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 8px 24px #0008;
}
.folder-list button { display: flex; width: 100%; justify-content: flex-start; background: none; border: none; font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folder-list.menu { bottom: auto; left: auto; top: calc(100% + 4px); width: max-content; max-height: 70dvh; }
.folder-list button[aria-selected=true] { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.heading { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.empty { padding: 20px 12px; text-align: center; color: var(--muted); }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.list-row.trailing { padding-right: 2px; }
.group-heading {
  display: flex; align-items: center; gap: 6px; padding: 12px 10px 2px;
  font-size: 13px; font-weight: 600; color: var(--fg);
}
.group-heading::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--tone, var(--muted)); }
.group-heading .count, button.disclosure .count { color: var(--muted); font-weight: 500; }
button.disclosure { margin: 6px 4px; padding-left: 6px; gap: 4px; }
.project-links button.disclosure { margin-left: 0; }
button.disclosure svg { transition: transform .2s ease-out; }
button.disclosure[aria-expanded="true"] svg { transform: rotate(90deg); }
.error-line { padding: 6px 10px; color: var(--bad); }
.tile {
  height: 100%; display: flex; flex-direction: column; overflow: hidden;
  background: var(--panel); border: 1px solid transparent; border-radius: var(--radius); box-shadow: var(--shadow);
}
.slot .slot.focused > * { outline: none; }
.tile:has(.slot.focused) { border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.tile.dragging { border-color: var(--accent); box-shadow: 0 8px 32px #0005; }
.tile-bar {
  display: flex; align-items: center; gap: 6px; padding: 2px 4px 2px 12px; min-height: 34px;
  background: color-mix(in srgb, var(--tone, var(--fg)) 8%, var(--raised)); border-bottom: 1px solid var(--border);
}
.tile-bar .heading { font-size: 13px; letter-spacing: normal; text-transform: none; color: var(--tone, var(--fg)); }
.tile-bar[data-card=PRs] { --tone: #f0f6fc; }
.tile-bar[data-card=Todo] { --tone: var(--good); }
.tile-bar[data-card=ProjectLinks] { --tone: #8ab4f8; }
.tile-bar[data-card=ProjectNotes] { --tone: #e3b341; }
.tile:has(.empty.idle) { opacity: .5; }
.tile:has(.empty.idle):is(:hover, :focus-within) { opacity: 1; transition: opacity .15s; }
.tile-bar[data-drag] { cursor: grab; touch-action: none; }
.tile.dragging .tile-bar { cursor: grabbing; }
.tile-bar .heading { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile-header { font-size: 12px; white-space: nowrap; }
.tile-bar[data-card=ProjectNotes] :is(.tile-header, .tile-header .slot) { display: flex; flex: 1; min-width: 0; }
.todo-row {
  position: relative; display: grid; grid-template-rows: 1fr; background: var(--panel); border-bottom: 1px solid var(--border);
  transition: transform .2s cubic-bezier(.2, 0, 0, 1), box-shadow .2s, background-color .2s, grid-template-rows .2s ease-out, opacity .2s, border-bottom-width .2s ease-out, margin-bottom .2s ease-out;
}
.todo-row > * { min-height: 0; overflow: hidden; }
.todo-row:focus-within { z-index: 3; }
.todo-row:focus-within > *, .todo-row:focus-within .collapse[data-open] > * { overflow: visible; }
.todo-row.appear { animation: todo-appear .2s ease-out; }
.todo-row.leaving { grid-template-rows: 0fr; opacity: 0; border-bottom-width: 0; }
.todo-row:not(:has(+ .todo-row)) { --fold-gap: -6px; } /* an empty section's header margins collapse */
.todo-row.folded { margin-bottom: var(--fold-gap, 0); pointer-events: none; }
@keyframes todo-appear { from { grid-template-rows: 0fr; opacity: 0; border-bottom-width: 0; margin-bottom: var(--fold-gap, 0); } }
.todo-row.dragging { z-index: 2; background: var(--raised); border-radius: 8px; box-shadow: 0 10px 30px #0008; transition: box-shadow .2s, background-color .2s; }
.todo-main { display: flex; align-items: center; gap: 6px; padding: 4px 10px 4px 2px; cursor: pointer; }
.todo-main .label { flex: 1; min-width: 0; }
.todo-main .label > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todo-main .label > div.title { width: fit-content; max-width: 100%; }
.todo-note { color: var(--muted); opacity: .7; font-size: 12px; text-overflow: ellipsis; }
.todo-row[data-into] { opacity: .35; }
:root .todo-list button.disclosure {
  display: flex; width: calc(100% - 8px); justify-content: flex-start;
  transition: transform .2s cubic-bezier(.2, 0, 0, 1), background-color .12s, box-shadow .12s;
}
:root .todo-list button.disclosure[data-drop] {
  color: var(--fg); background: color-mix(in srgb, var(--info) 22%, var(--panel)); box-shadow: inset 0 0 0 1.5px var(--info);
}
:root .todo-row button.todo-handle { cursor: grab; touch-action: none; color: var(--muted); letter-spacing: -3px; }
:root .todo-row.dragging button.todo-handle { cursor: grabbing; }
:root .todo-row button.todo-handle { width: 18px; }
:root[data-mobile] .todo-row button.todo-handle { width: 28px; }
.todo-actions { display: flex; flex-shrink: 0; margin-right: -8px; }
:root .todo-row button.todo-check {
  flex-shrink: 0; width: 18px; height: 18px; min-height: 0; padding: 0; margin-inline: 2px 4px; font-size: 11px;
  border-radius: 50%; border: 1.5px solid var(--muted); background: transparent; color: transparent;
}
:root .todo-row button.todo-check { transition: background-color .15s, border-color .15s, color .15s, transform .1s; }
:root .todo-row button.todo-check:active { transform: scale(.85); border-color: var(--good); }
@media (hover: hover) { :root .todo-row button.todo-check:hover { border-color: var(--good); color: var(--good); } }
:root .todo-row button.todo-check[aria-checked=true] { background: var(--good); border-color: var(--good); color: var(--bg); }
:root[data-mobile] .todo-row button.todo-check { width: 24px; height: 24px; font-size: 14px; }
.todo-row.done .todo-main .title { text-decoration: line-through; color: var(--muted); }
.todo-details { display: flex; flex-direction: column; gap: 8px; padding: 2px 10px 12px; }
.todo-details > input, .todo-details > textarea { width: 100%; }
.todo-chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.todo-details .todo-chips .badge { padding: 3px 10px; font-size: 12px; }
:root .todo-chips .badge button { min-height: 0; padding: 0 0 0 4px; font-size: 13px; background: none; color: inherit; opacity: .7; border-radius: 999px; }
@media (pointer: coarse) {
  .todo-details .todo-chips .badge { min-height: 32px; padding: 3px 12px; font-size: 14px; }
  :root .todo-details .todo-chips .badge button { position: relative; padding: 0 0 0 6px; font-size: 18px; }
  .todo-details .todo-chips .badge button::after { content: ''; position: absolute; inset: -10px -12px -10px -4px; }
}
.todo-details input[type=date][data-empty]:not(:focus) { color: transparent; }
.todo-label { flex-shrink: 0; width: 48px; min-height: 26px; display: inline-flex; align-items: center; color: var(--muted); }
.todo-links { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.todo-links > .todo-chips { min-height: 26px; }
@media (pointer: coarse) { .todo-label, .todo-links > .todo-chips { min-height: 38px; } }
:root[data-mobile] :is(.todo-label, .todo-links > .todo-chips) { min-height: 42px; }
.todo-add { display: flex; gap: 6px; padding: 8px 10px; }
.todo-add input { flex: 1; min-width: 0; }
.todo-now {
  display: flex; align-items: center; min-height: 26px; box-sizing: border-box;
  margin: 6px 4px; padding: 4px 0 4px 23px; color: var(--muted); font-weight: 500; /* in line with the disclosure labels */
}
@media (pointer: coarse) { .todo-now { min-height: 38px; } }
:root[data-mobile] .todo-now { min-height: 42px; }
.todo-section { display: block; padding: 8px 12px 4px; }
`
