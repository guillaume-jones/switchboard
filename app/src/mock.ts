// In-browser stand-in for the Tauri backend, used by `vite` dev outside the app window.
import type { ComponentType } from 'react'
import type { Backend, Binding, CardModules, Commands, Events, Params, Row } from './bridge'

/** Params arrive from cards untyped. */
type Args = Record<string, any>

const templateCards = Object.fromEntries(
  Object.entries(import.meta.glob<ComponentType>('../../template/cards/*.tsx', { import: 'default' })).map(
    ([path, load]) => [path.slice(path.lastIndexOf('/') + 1, -'.tsx'.length), load],
  ),
)
/** Template cards are bundled by Vite; the code `card` returns reads them from here. */
const bundledCards: Record<string, ComponentType> = {}

/** Cards for the mock `prs` source, which the template doesn't have, written in the loader's compiled format. */
const INLINE_CARDS: Record<string, string> = {
  PRList: `
const { jsx } = await __vite_ssr_import__("react/jsx-runtime")
const { useState } = await __vite_ssr_import__("react")
const { useQuery, useExpose, Item } = await __vite_ssr_import__("switchboard")
__vite_ssr_exports__.default = function PRList() {
  const rows = useQuery("prs_items") ?? []
  const [selected, setSelected] = useState(null)
  useExpose({ selected })
  return jsx("div", { style: { padding: 4 }, children: rows.map(r => {
    const ref = "prs:" + r.id
    return jsx("div", {
      onClick: () => setSelected(ref),
      style: { padding: "2px 4px", borderRadius: 3, background: ref === selected ? "var(--panel)" : undefined },
      children: jsx(Item, { ref }),
    }, r.id)
  }) })
}`,
  PRItem: `
const { jsxs } = await __vite_ssr_import__("react/jsx-runtime")
const { useQuery } = await __vite_ssr_import__("switchboard")
__vite_ssr_exports__.default = function PRItem({ ref, size }) {
  const pr = (useQuery("prs_items", { id: ref.slice(4) }) ?? [])[0]
  if (!pr) return ref
  const colour = { failed: "var(--bad)", passed: "green" }[pr.ci] ?? "var(--muted)"
  return jsxs("span", { children: ["#", pr.id, " ", pr.title, " ", jsxs("span", { style: { color: colour }, children: ["●", size === "full" ? " CI " + pr.ci : ""] })] })
}`,
}

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
let nextSeq = 1

type Run = { id: string; command: string; state: string; summary: string | null; started_at: string }
type Session = { id: string; title: string; status: string; run_id: string | null; cwd: string }
type Tile = { grid: string; id: string; component: string; props: string; x: number; y: number; w: number; h: number }

const db = {
  prs: [
    { id: 4812, title: 'Fix flaky login test', ci: 'failed', dismissed: false },
    { id: 4815, title: 'Bump tokio to 1.48', ci: 'passed', dismissed: false },
    { id: 4820, title: 'Retry webhook sender on 502', ci: 'running', dismissed: false },
  ],
  boards: [
    { id: 'main', title: 'Main', component: 'Grid', props: '{"grid":"main"}' },
    { id: 'prs', title: 'PRs', component: 'PRList', props: '{}' },
  ],
  currentBoard: 'main',
  tiles: [{ grid: 'main', id: 'prs', component: 'PRList', props: '{}', x: 0, y: 0, w: 7, h: 6 }] as Tile[],
  sessions: [
    { id: 'a1b2', title: 'Refactor sync worker', status: 'needs_input', run_id: null, cwd: '~/src/sync' },
  ] as Session[],
  runs: [{ id: 'r0', command: 'prs.fetch', state: 'unknown', summary: null, started_at: now() }] as Run[],
  rules: [
    { rule: 'prs-poll', enabled: 1, disabled_reason: null as string | null, last_evaluated: now() },
    { rule: 'fix-failing-ci', enabled: 0, disabled_reason: 'max_per_hour exceeded', last_evaluated: now() },
  ],
  events: [
    {
      id: 1,
      time: now(),
      kind: 'error',
      name: 'loader',
      message: 'sources/jira/views/open.sql: no such column: priority',
      run_id: null,
    },
  ],
  attention: [
    { id: 1, ref: 'prs:4812', reason: 'CI failed', level: 2, created: now() },
    { id: 2, ref: 'sessions:a1b2', reason: 'needs input', level: 1, created: now() },
  ],
}

const hiddenSessions = new Set<string>()
let errorsClearedThrough = 0
const defaultTiles: Tile[] = [
  { grid: 'main', id: 'sessions', component: 'Sessions', props: '{}', x: 0, y: 0, w: 12, h: 26 },
]

const VIEWS: Record<string, () => Row[]> = {
  prs_items: () => db.prs.filter(pr => !pr.dismissed).map(({ id, title, ci }) => ({ id, title, ci })),
  sessions_items: () => db.sessions,
  attention_open: () => db.attention,
  core_runs: () => db.runs,
  core_rules: () => db.rules,
  ui_defaults: () => defaultTiles,
  attention_errors_cleared: () => [{ through: errorsClearedThrough }],
}

const QUERIES: Record<string, (params: Args) => Row[]> = {
  'prs.search': ({ text }) =>
    VIEWS.prs_items().filter(pr => pr.title.toLowerCase().includes(String(text).toLowerCase())),
  'sessions.transcript': () => [],
  'sessions.recent': ({ limit, hidden }) =>
    [...db.sessions]
      .reverse()
      .filter(session => hiddenSessions.has(session.id) === Boolean(Number(hidden)))
      .slice(0, Number(limit)),
  'ui.boards': () => db.boards.map(board => ({ ...board, current: board.id === db.currentBoard ? 1 : 0 })),
  'core.events': ({ kind, limit }) =>
    db.events
      .filter(event => event.kind === kind)
      .slice(-Number(limit))
      .reverse(),
  'ui.tiles': ({ grid }) => db.tiles.filter(tile => tile.grid === grid).map(({ grid: _, ...tile }) => tile),
}

const stepBoard = (step: 1 | -1) => {
  const current = db.boards.findIndex(board => board.id === db.currentBoard)
  db.currentBoard = db.boards[(current + step + db.boards.length) % db.boards.length].id
}
const findTile = (grid: string, id: string) => db.tiles.find(tile => tile.grid === grid && tile.id === id)

const WRITERS: Record<string, (params: Args) => void> = {
  'sessions.transcript_close': () => {},
  'sessions.hide': ({ id }) => void hiddenSessions.add(String(id)),
  'sessions.unhide': ({ id }) => void hiddenSessions.delete(String(id)),
  'prs.dismiss': ({ ref }) => {
    for (const pr of db.prs) if (`prs:${pr.id}` === ref) pr.dismissed = true
  },
  'ui.set_board': ({ id }) => {
    db.currentBoard = id
  },
  'ui.next_board': () => stepBoard(1),
  'ui.prev_board': () => stepBoard(-1),
  'ui.tile_set': ({ grid, id, x, y, w, h }) => {
    const tile = findTile(grid, id)
    if (tile) Object.assign(tile, { x, y, w, h })
  },
  'ui.tile_add': ({ grid, id, component, props }) => {
    const y = Math.max(0, ...db.tiles.filter(tile => tile.grid === grid).map(tile => tile.y + tile.h))
    db.tiles.push({ grid, id, component, props, x: 0, y, w: 6, h: 6 })
  },
  'ui.reset': ({ grid }) => {
    db.tiles = [
      ...db.tiles.filter(tile => tile.grid !== grid),
      ...defaultTiles.filter(tile => tile.grid === grid).map(tile => ({ ...tile })),
    ]
  },
  'ui.tile_remove': ({ grid, id }) => {
    db.tiles = db.tiles.filter(tile => tile !== findTile(grid, id))
  },
  'attention.clear': ({ ref }) => {
    db.attention = db.attention.filter(item => item.ref !== ref)
  },
  'attention.clear_errors': ({ through }) => {
    errorsClearedThrough = Math.max(errorsClearedThrough, Number(through))
  },
  'core.rule_enable': ({ rule }) => {
    for (const r of db.rules) if (r.rule === rule) Object.assign(r, { enabled: 1, disabled_reason: null })
  },
}

const COMMANDS = [
  'prs.fix-ci',
  'sessions.edit',
  'sessions.headless',
  'sessions.poke',
  'sessions.open',
  'sessions.transcript',
  'core.snapshot',
  'core.restore',
]

function startRun(command: string, args: Args) {
  if (!COMMANDS.includes(command)) throw new Error(`no command named ${command}`)
  const run: Run = { id: `r${nextSeq++}`, command, state: 'running', summary: null, started_at: now() }
  db.runs.push(run)
  const later = (ms: number, change: () => void) =>
    setTimeout(() => {
      change()
      pushChangedRows()
    }, ms)
  if (command === 'sessions.edit' || command === 'sessions.headless') {
    const session: Session = {
      id: `s${nextSeq++}`,
      title: String(args.prompt),
      status: 'working',
      run_id: run.id,
      cwd: String(args.cwd ?? '~/.switchboard'),
    }
    db.sessions.push(session)
    later(1500, () => {
      session.status = 'needs_input'
    })
    later(3000, () => {
      session.status = 'ended'
      Object.assign(run, { state: 'success', summary: 'committed' })
    })
  } else {
    later(1000, () => Object.assign(run, { state: 'success', summary: `${command} ${JSON.stringify(args)}` }))
  }
  return run.id
}

const KEYMAP: Binding[] = [
  { key: 'cmd-shift-p', command: 'palette.open' },
  { key: 'cmd-shift-k', command: 'keymap.context' },
  { key: 'alt-j', command: 'card.focus_next' },
  { key: 'alt-k', command: 'card.focus_prev' },
  { key: 'ctrl-tab', context: 'card:Boards', write: 'ui.next_board' },
  { key: 'ctrl-shift-tab', context: 'card:Boards', write: 'ui.prev_board' },
  { key: 'x', context: 'card:Boards', write: 'ui.next_board' },
  { key: 'x', context: 'card:Health', write: null },
  { key: 'f', context: 'card:PRList && selected', command: 'prs.fix-ci', args: { pr: '{selected}' } },
  { key: 'd', context: 'card:PRList', write: 'prs.dismiss', args: { ref: '{selected}' } },
]

const listeners: { [E in keyof Events]: ((payload: Events[E]) => void)[] } = {
  rows: [],
  config: [],
  card: [],
  reconnect: [],
}
const emit = <E extends keyof Events>(event: E, payload: Events[E]) => {
  for (const listener of listeners[event]) listener(payload)
}
const subscriptions = new Map<number, { name: string; params: Params; json: string }>()
let nextSubscriptionId = 1

/** Debugging handles for the devtools console, e.g. `__mockEmit('card', { name: 'Grid' })`. */
Object.assign(globalThis, { __mockCards: bundledCards, __mockEmit: emit, __mockSubscriptions: subscriptions })

function read(name: string, params: Params): Row[] {
  const view = VIEWS[name]
  if (view) return view().filter(row => Object.entries(params).every(([column, value]) => row[column] == value))
  const query = QUERIES[name]
  if (query) return query(params)
  throw new Error(`no view or query named ${name}`)
}

function pushChangedRows() {
  for (const [id, subscription] of subscriptions) {
    const rows = read(subscription.name, subscription.params)
    const json = JSON.stringify(rows)
    if (json === subscription.json) continue
    subscription.json = json
    emit('rows', { id, rows })
  }
}

async function cardModules(name: string): Promise<CardModules> {
  const inline = INLINE_CARDS[name]
  if (inline) return { [`${name}.tsx`]: inline }
  const load = templateCards[name]
  if (!load) throw new Error(`no card named ${name}`)
  bundledCards[name] = await load()
  return { [`${name}.tsx`]: `__vite_ssr_exports__.default = globalThis.__mockCards[${JSON.stringify(name)}]` }
}

type Handlers = {
  [C in keyof Commands]: (args: Commands[C]['args']) => Commands[C]['result'] | Promise<Commands[C]['result']>
}

const handlers: Handlers = {
  config: () => ({
    root: 'Root',
    depth_cap: 20,
    queue_run_expiry: 3600,
    reconnect_timeout: 10,
    connect_timeout: 3,
    queue_expiry: {},
    sources: {
      prs: { item_card: 'PRItem' },
      sessions: {},
      core: {},
      ui: {},
      attention: {},
    },
    cards: [...Object.keys(templateCards), ...Object.keys(INLINE_CARDS)],
    commands: COMMANDS,
    writers: Object.keys(WRITERS),
    keymap: KEYMAP,
    errors: [],
  }),
  card: ({ name }) => cardModules(name),
  subscribe: ({ name, params }) => {
    const rows = read(name, params)
    const id = nextSubscriptionId++
    subscriptions.set(id, { name, params, json: JSON.stringify(rows) })
    return { id, rows }
  },
  unsubscribe: ({ id }) => {
    subscriptions.delete(id)
    return null
  },
  mutate: ({ name, params }) => {
    const writer = WRITERS[name]
    if (!writer) throw new Error(`no writer named ${name}`)
    writer(params)
    pushChangedRows()
    return { changes: 1 }
  },
  run: ({ name, args }) => {
    const run_id = startRun(name, args)
    pushChangedRows()
    return { run_id }
  },
  revert_last_commit: () => {
    console.info('mock: revert_last_commit')
    return null
  },
  report_error: args => {
    console.warn('mock: report_error', args)
    return null
  },
}

const mock: Backend = {
  invoke: async (command, args) => handlers[command](args),
  listen: (event, handler) => {
    listeners[event].push(handler)
  },
}

export default mock
