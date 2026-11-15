# Switchboard folder

The Switchboard app loads this folder on every save. Run `swb check` before you finish: it is the same loader the app and the pre-commit hook run. A change that fails to load never replaces the running state; its errors go to `core_events` and are raised as attention items.

## Layout

```
settings.json            app-wide settings
keymap.json              key bindings
rules/*.json             rules that belong to no single source
cards/*.tsx              cards, one per file; Root.tsx is the entry point
cards/lib/**             .ts/.tsx/.js helpers imported by cards
cards/switchboard.d.ts     types for the "switchboard" module, written by the app (git-ignored)
sources/<name>/
  source.json            optional overrides
  schema.sql             private tables (no file = no database)
  views/*.sql            public, parameterless SELECTs
  queries/*.sql          parameterised SELECTs
  writes/*.sql           mutations of this source's tables
  commands/*             executable scripts
  rules/*.json           rules
  files/                 anything else the commands need; not loaded
data/                    git-ignored: <source>.db, logs/<run_id>.log, snapshots/, trash/, spool/
```

Any other entry in a source folder is an error. Runtime output goes to `data/` or a database, never `files/`.

## Names

| Form | Is | Usable from |
| --- | --- | --- |
| `prs.items` | table in `sources/prs/schema.sql` | SQL inside `sources/prs/` only |
| `prs_items` | view `sources/prs/views/items.sql` | any SQL, `useQuery`, rules, `swb query` |
| `prs.search` / `prs.dismiss` / `prs.fix-ci` | query / writer / command (`commands/fix-ci[.sh]`) | cards, rules, key bindings, `swb` |

Sources match `[a-z][a-z0-9]*` (`core`, `main`, `temp` reserved). SQL files are snake_case. Commands are `[a-z0-9_-]+` plus an optional ignored extension, and must be executable. A ref is `source:id`, e.g. `prs:4812`; `<Item>` renders it with the source's `item_card`.

## SQL (enforced)

- `schema.sql`: only `CREATE TABLE` / `CREATE INDEX`, tables unqualified. Additive only: new tables and columns (each on its own line) are applied on load; drops, renames and column definition changes are refused. Indexes may change. Never drop: mark `-- @deprecated reason` on the column's line or the line above `CREATE TABLE`; views and queries then cannot read it.
- Everywhere else, qualify tables (`prs.items`). SQL may read its own source's tables and any view, never another source's tables. No `SELECT *`, `ATTACH`, `PRAGMA`, DDL, transactions, or table functions other than `json_each`/`json_tree`.
- `views/`: one read-only `SELECT`, no parameters, distinct column names. Callers filter with column equality (`useQuery("core_runs", { state: "unknown" })`).
- `queries/`: one read-only `SELECT` with named parameters, all required.
- `writes/`: one or more statements in one transaction, at least one write, only to this source. Every named param is required except `:run_id` (the calling run, or NULL). `:payload` is JSON text; unpack it with `json_each(:payload)`.
- Views re-run only after a write to a table they read or on a rule's schedule, so `'now'` in a view goes stale; anything that must change with time needs a scheduled rule.

Conventions: primary key on every table; provider JSON kept in `raw` and exposed with `raw ->> '$.field'`; user state (dismissals, snoozes) in its own table so fetch writers stay plain upserts; add view columns rather than repurposing them; reshape by adding a table, a one-off copy writer, and repointing views; extend a source before adding one; cards only display.

## Rules

```json
{ "id": "prs-poll", "when": { "schedule": "*/2 * * * *" }, "run": "prs.fetch", "into": "prs.upsert" }
{ "id": "ci-attention", "when": { "view": "prs_ci_failed" }, "key": "{id}@{head_sha}", "into": "attention.raise", "args": { "ref": "prs:{id}", "reason": "CI failed", "level": 2 } }
```

| Field | |
| --- | --- |
| `id` | unique across all rules |
| `when.view` | evaluated on load and whenever its result changes; fires once per new rendered `key`, ever |
| `when.schedule` | 5-field local cron. With a view, re-evaluates it; alone, fires once per slot (after sleep, only the latest missed slot; a new rule waits for its next slot) |
| `when.files` | absolute or `~/` glob (`*` stays within one directory, `**` crosses them). Fires once a matching file changed and stayed quiet for 200 ms; gives `{path}`. A missing base directory is skipped until the next reload |
| `when.line_contains` | with `when.files`: fires once per complete line appended to a matching file that contains this text, instead of per change; gives `{path}` and `{line}`. Lines present when the rule loads never fire |
| `when.system` | `sleep`, `wake`, `lock`, `unlock`, `online` or `offline`; gives `{event}`. `offline` fires after the network stays unreachable for `offline_debounce`, `online` only after an `offline` |
| (triggers) | at most one of `schedule`, `files`, `system`. With a view, an occurrence re-evaluates it; alone, the rule fires once per occurrence |
| `key` | required with `when.view`, forbidden without; `{col}` templates over the view's columns, else over the trigger's variables |
| `run` | a command or built-in command |
| `into` | a writer. With `run`: gets stdout as `:payload` if the command succeeds. Alone: called with `args`, which must match its params exactly |
| `args` | `"{col}"` passes the typed value; other strings are interpolated |
| `max_per_hour`, `timeout` | per-rule overrides |
| `log` | `false` skips the rule's `core_firings` rows and write events, for frequent triggers. Only without `when.view`; errors, blocked firings and runs are still recorded |

Limits: past `max_depth` nested rule runs, or past `max_per_hour` runs started in an hour by a rule with `when.view` or `when.files`, the firing is blocked, recorded in `core_firings` and its key consumed; the rate limit also disables the rule until `core.rule_enable {rule}`. At most `max_concurrency` rule runs execute at once; others queue. Runs started by hand are never limited.

## Commands

- Run with the folder as cwd, in their own process group, with the login-shell environment plus `RUN_ID`, `SWITCHBOARD_HOME`, `SOURCE_DIR` (own source folder), `SWB`, and `SWB_ARG_<NAME>` per arg. Args are also on stdin as JSON.
- Never open a database: read with `swb query`, write with `swb write`. `swb write` forwards `RUN_ID`, so writes by the command or anything it launched belong to its run.
- Exit 0 is `success`, else `failure`. Unless the rule has `into`, a last stdout line `{"outcome": "success|failure|open", "summary": "..."}` overrides it. `open` runs are finished with `swb run finish $RUN_ID --ok|--fail [summary]` or become `unknown` after `open_run_expiry`.
- Timeout: rule `timeout`, else `source.json` `timeouts.<command>`, else the setting; the process group is killed. Output goes to `data/logs/<run_id>.log` (1 MB cap); `into` payloads are capped at 16 MB.

## `source.json` and `settings.json`

`source.json`: `item_card` (card for this source's refs, gets `ref` and `size`), `snapshot_interval`, `snapshot_retention` (seconds), `timeouts` (`{ "<command>": seconds }`), `queue_expiry` (`{ "<command>": seconds }`: how long a run queued offline on another device may wait; `0` refuses to queue it, for commands that only make sense right away).

`settings.json` (numbers are positive integers, seconds unless noted):

| Key | Default | |
| --- | --- | --- |
| `root` | `"Root"` | root card |
| `terminal` | `"Terminal"` | app `sessions.launch` and `sessions.open` open (e.g. `"Ghostty"`) |
| `hotkey` | `"cmd-shift-space"` | global bring-forward key; `""` disables |
| `menu_bar` | `""` | view whose row count shows in the menu bar |
| `max_per_hour` / `max_depth` / `max_concurrency` | `20` / `5` / `4` | rule limits |
| `timeout` | `600` | command timeout |
| `open_run_expiry` | `86400` | |
| `offline_debounce` | `3` | how long the network must stay unreachable before `when.system: offline` fires |
| `snapshot_interval` / `snapshot_retention` | `3600` / `604800` | |
| `retention` | `2592000` | events and finished runs |
| `depth_cap` | `20` | card nesting |
| `remote` | none | HTTPS port that `tailscale serve` exposes the board on to your other devices; none keeps it local |
| `queue_run_expiry` | `3600` | how long a run queued offline on another device may wait before it is dropped; writes never expire |

## Cards

`cards/<Name>.tsx` default-exports a React component. Imports allowed: `react`, `react/jsx-runtime`, `switchboard`, and relative paths into `cards/lib/` (tried as written, then `.ts`, `.tsx`, `.js`; no `index`). Cards never import each other; no npm packages, dynamic `import()` or `import.meta`. A dependency-free single-file ESM build of a library can be vendored into `cards/lib/` with its `.d.ts`, like `lib/marked.js`. Each card gets its own instance of its helpers. Render agent or remote text with `renderMarkdown` from `lib/markdown`, never as raw HTML: card HTML runs in the webview, which can start commands.

```ts
import { useQuery, mutate, run, useExpose, CardSlot, Item, type CardProps } from "switchboard"

useQuery("prs_items", { id })        // live rows; undefined until loaded; throws on error
useQuery("prs.search", { text })     // query
mutate("prs.dismiss", { ref })       // resolves to changed row count
run("prs.fix-ci", { pr })            // resolves to run id
useExpose({ selected: "prs:4812" })  // context variables for key bindings
<CardSlot component="PRList" props={{}} size="compact" id="prs" />
<Item ref="prs:4812" size="compact" />
```

On another device without a connection to the desktop, `useQuery` returns the last rows it saw, `mutate` queues the write and resolves to `0`, and `run` queues the run and resolves to its id.

A subscription re-runs after every write to a table it reads and sends its whole result when it changes, so never mount a view over a growing table (`core_events`, `core_runs`, `core_firings`, your own logs) unless the filter keeps the result small (`kind: "error"`, one `run_id`). A filter that still matches a growing set, like `kind: "write"`, is as slow as none: use a query with a limit.

Cards receive `size` and `slot` (the slot `id`). Per-slot UI state goes in `localStorage` keyed by `slot`; navigation and layout live in the `ui` source. `Root.tsx` defines the theme variables (`--bg --fg --muted --border --panel --accent --bad`) that cards and the shell use.

## Key bindings

```json
{ "key": "f", "context": "card:PRList && selected", "command": "prs.fix-ci", "args": { "pr": "{selected}" } }
{ "key": "cmd-]", "context": "card:Boards", "write": "ui.next_board" }
```

Exactly one of `command` (source, built-in, or shell: `palette.open`, `card.focus_next`, `card.focus_prev`, `keymap.context`) or `write`; `null` unbinds. Context: `card:<Name>`, variable names, `&&`, `||`, `!`, `>` (descendant), parentheses. Innermost match wins. `{var}` is the nearest card's, `{Card.var}` explicit; a missing variable disables the binding. `keymap.context` (cmd-shift-k) shows the stack and which binding a key hits.

## Built-ins

- Commands: `core.snapshot {source?}`, `core.restore {source, snapshot?}` (snapshots current data first), `core.notify {title, body}`.
- Writers: `core.rule_enable {rule}`, `core.run_finish {id, state, summary}`.
- Views: `core_runs`, `core_firings`, `core_rules`, `core_items` (rules as `core:<rule>`), `core_events` (`kind`: `write`, `error`, `slow_read`). Core views expose every row and never filter; filter on top in your own views or with equality filters.
- Queries: `core.timeline {limit}` (runs, firings and events, newest first), `core.events {kind, limit}` (newest events of a kind), `core.runs {limit}` (newest runs).

## Debugging

- `swb query core.timeline limit=50`, `core.events kind=error limit=20`, `core_events run_id=<run_id>`, `core_runs id=<run_id>`, `core_firings rule=<rule>`. Views exist only inside the running app.
- Tables: `sqlite3 -readonly data/<source>.db`. Never write databases directly.
- Command output: `data/logs/<run_id>.log`. Spool replay errors have `trigger = 'spool'`, card runtime errors `trigger = 'card_runtime'`.

```
swb check
swb write <source.writer> [name=value ...] [< payload]   values parsing as JSON are JSON; spooled if the app is closed
swb query <view | source.query> [name=value ...]
swb run finish <run_id> --ok|--fail [summary]
```

## Existing sources and cards

Read `sources/` and `cards/` before adding anything; extend what is there. To show a card on the main board: `swb write ui.tile_add grid=main id=<id> component=<Card> 'props="{}"'`.
