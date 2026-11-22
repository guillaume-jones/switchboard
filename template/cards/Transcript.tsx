import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { CardSlot, mutate, run, useExpose, useQuery, type CardProps } from 'switchboard'
import {
  BUBBLE,
  Bubble,
  busy,
  Composer,
  containsMessage,
  draftKey,
  DecisionPanel,
  hostName,
  interruptible,
  MessageBox,
  MODELS,
  ModelSelect,
  outboxText,
  QUEUE_BUTTON,
  QueuedMessage,
  Spinner,
  TONES,
  useArchive,
  useDraft,
  useOutbox,
  usePending,
  setPending,
  setDraft,
  withAttachments,
  WAITING,
  type Attachment,
  type Outbox,
  type Session,
  type Pending,
} from './lib/sessions'
import { useFindKey, useMobile } from './lib/theme'
import { ArchiveIcon, BellIcon, Icon, TerminalIcon } from './lib/icons'
import { copyCode, HTML, IMAGE, renderMarkdown, TXT } from './lib/markdown'
import { Actions } from './lib/actions'
import { Preview } from './lib/preview'
import { Doc } from './lib/doc'
import { ImageView, isUnsent } from './lib/image'
import { useQuoteShortcut } from './lib/quote'

type Message = {
  uuid: string
  at: string
  role: string
  text: string
  tokens: number | null
  model: string | null
  tool_id: string | null
  tool_name: string | null
  is_error: number | null
}
type Subagent = {
  id: string
  description: string | null
  agent_type: string | null
  background: number
  activity: string | null
  started_at: string | null
  updated_at: string | null
}

const STALE_SUBAGENT = 30 * 60 * 1000
const clip = (text: string | null, max: number) =>
  text && text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text

const SKILL = /^Base directory for this skill: .*\/([^/\n]+)$/m
const TOOL_LINE: CSSProperties = {
  margin: '4px 0 0',
  color: 'var(--muted)',
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
}
const COMPACT: CSSProperties = { ...BUBBLE, background: 'color-mix(in srgb, #a78bfa 20%, transparent)' }
const Working = ({ since, tokens, label }: { since?: string; tokens: number; label?: string }) => {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = since ? Math.max(0, Math.round((now - Date.parse(since)) / 1000)) : 0
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
      <span className="typing">
        <i />
        <i />
        <i />
      </span>
      <span className="ellipsis" style={{ minWidth: 0, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
        {label && `${label} · `}
        {elapsed}
        {tokens > 0 && ` · ${tokens < 1000 ? tokens : `${(tokens / 1000).toFixed(1)}k`} tokens`}
      </span>
    </span>
  )
}
/** Claude Code logs each tool call (`→ Name input`) and result (`← output`) as a message of its own. */
const isTool = (m: Message) => !!m.tool_id
const isCall = (m: Message) => !!m.tool_name
/** `fn` of a message, computed once per distinct text, as a working session re-renders its transcript on every new line. */
const byText = <T,>(fn: (m: Message) => T) => {
  const cache = new Map<string, T>()
  return (m: Message) => {
    if (!cache.has(m.text)) {
      if (cache.size > 5000) cache.clear()
      cache.set(m.text, fn(m))
    }
    return cache.get(m.text)!
  }
}
const DENIED = /^← (Permission for this \w+ was denied|The user doesn't want to proceed)/
/** Each call with the result answering it. */
const toolCalls = (group: Message[]) => {
  const results = new Map(group.filter(m => !isCall(m)).map(m => [m.tool_id, m]))
  return group.filter(isCall).map(call => [call, results.get(call.tool_id)] as [Message, Message | undefined])
}
const deniedTools = (group: Message[]) =>
  toolCalls(group).flatMap(([call, result]) =>
    result?.is_error && DENIED.test(result.text) ? [call.uuid, result.uuid] : [],
  )
const toolName = (call: Message) => call.tool_name?.split('__').pop()
const WRITES = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']
const toolInput = (call: Message) => call.text.slice(call.text.indexOf(' ', 2) + 1)
const inputOf = (call: Message) => {
  try {
    return JSON.parse(toolInput(call))
  } catch {
    return null
  }
}
const bashCommand = (call: Message): string => inputOf(call)?.command ?? toolInput(call)
const HEREDOC = /^([^\n]*?)<<-?\s*['"]?(\w+)['"]?([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/gm
const QUOTED = /'([^'\s<>|;&]+)'|'[^']*'|"((?:[^"\\\s<>|;&]|\\.)+)"|"(?:[^"\\]|\\.)*"/g
const SHELL_TARGETS = [
  /(?:^|[^>&0-9=-])>>?\s*(?!&)([^\s;&|)<>=][^\s;&|)<>]*)/g,
  /\btee\s+(?:-a\s+)?([^\s;&|)]+)/g,
  /\b(?:sed|perl)\s[^;&|\n]*?-\w*i\b[^;&|\n]*\s([^\s;&|]+)\s*(?=$|[;&|\n])/g,
]
const SCRATCH = /^(\/private)?\/tmp\/|^\/var\/folders\/|^\$\{?TMPDIR\b|^\$\{?CLAUDE_JOB_DIR\b|\/\.claude\/jobs\//
const SCRIPT_WRITE = /open\([^)]*['"][wa]\+?['"]|\.write_text\(|writeFileSync\(/
const SCRIPT_TARGET = /\b(?:(?:open|writeFileSync|Path)\(\s*|\w+\s*=\s*)['"]([\w.~\/-]*[/.][\w.~\/-]+)['"]/g
const READERS = ['cat', 'head', 'tail', 'nl', 'less', 'more', 'bat', 'sed']
/** A Bash command split into its shell text (heredoc bodies removed, with and without quoted strings) and heredocs. */
const parseBash = (command: string) => {
  const unquoted = command.replace(HEREDOC, '$1<<$2$3')
  const shell = unquoted.replace(QUOTED, '$1$2').replace(/\(\([^)]*\)\)/g, '')
  const cwd = shell.match(/^\s*cd\s+([^\s;&|]+)/)?.[1] ?? ''
  const scratch = (path: string) => SCRATCH.test(/^[/~$]/.test(path) ? path : `${cwd}/${path}`)
  const heredocs = [...command.matchAll(HEREDOC)].map(m => ({ opener: m[1] + m[3], body: m[4] }))
  const inline = [...command.matchAll(/\b(?:python3?|node)\s+-[ce]\s+(['"])([\s\S]*?)\1/g)].map(m => m[2])
  const scripts = [...heredocs.filter(h => !/\b(?:cat|tee)\b/.test(h.opener)).map(h => h.body), ...inline].join('\n')
  return { unquoted, shell, scratch, heredocs, scripts }
}
/** Heuristic: redirects, tee and in-place edits outside heredocs, and scripts opening files for writing. */
const bashTargets = (command: string) => {
  const { shell, scratch, scripts } = parseBash(command)
  const targets = SHELL_TARGETS.flatMap(re => [...shell.matchAll(re)].map(m => m[1])).filter(t => t !== '/dev/null')
  const scripted = SCRIPT_WRITE.test(scripts) ? [...scripts.matchAll(SCRIPT_TARGET)].map(m => m[1]) : []
  const paths = [...targets, ...scripted].filter(path => !scratch(path))
  return { write: paths.length > 0 || (SCRIPT_WRITE.test(scripts) && !scripted.length), paths }
}
/** Commands made only of `cd` and file readers (`cat`, `head`, `sed -n`…), with the files they read. */
const bashReads = (command: string) => {
  const segments = parseBash(command)
    .shell.split(/&&|\|\||[;|\n]/)
    .map(s => s.trim().split(/\s+/))
    .filter(s => s[0])
  const reading = segments.every(
    ([name, ...args]) => name === 'cd' || (READERS.includes(name) && !(name === 'sed' && !args.includes('-n'))),
  )
  const paths = segments
    .filter(([name]) => name !== 'cd')
    .flatMap(([, ...args]) => args.filter(arg => !/^-|[<>]|^\d/.test(arg) && /[./]/.test(arg)))
  return reading && paths.length ? paths : null
}
const callKind = byText(call => {
  const name = toolName(call)
  if (WRITES.includes(name ?? '')) return 'write'
  if (name === 'Read' || name === 'NotebookRead') return 'read'
  if (name !== 'Bash') return 'tool'
  const command = bashCommand(call)
  return bashTargets(command).write ? 'write' : bashReads(command) ? 'read' : 'tool'
})
/** Each tool call and its result, by uuid, as a write, a read or another call. */
const toolKinds = (group: Message[]) =>
  toolCalls(group).flatMap(([call, result]) => {
    const kind = callKind(call)
    return [[call.uuid, kind], ...(result ? [[result.uuid, kind]] : [])] as [string, string][]
  })
const toolPaths = byText(call =>
  toolName(call) !== 'Bash'
    ? [inputOf(call)?.file_path ?? inputOf(call)?.notebook_path ?? '?']
    : callKind(call) === 'read'
      ? (bashReads(bashCommand(call)) ?? [])
      : bashTargets(bashCommand(call)).paths,
)
const lines = (text: string, op: string) => (text ? text.split('\n').map(line => op + line) : [])
const diffLines = (before: string, after: string) => {
  const a = before.replace(/\n$/, '').split('\n')
  const b = after.replace(/\n$/, '').split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  return [
    ...a.slice(0, start).map(line => ' ' + line),
    ...a.slice(start, a.length - end).map(line => '-' + line),
    ...b.slice(start, b.length - end).map(line => '+' + line),
    ...a.slice(a.length - end).map(line => ' ' + line),
  ]
}
const hunks = (diffs: string[][]) => (diffs.length ? diffs.flatMap((d, i) => [...(i ? [' ⋯'] : []), ...d]) : null)
const ESCAPES: Record<string, string> = { n: '\n', t: '\t', '\\': '\\', "'": "'", '"': '"', '\n': '' }
/** A Python string literal starting at `from`, ignoring leading whitespace. */
const readLiteral = (src: string, from: number) => {
  const open = src.slice(from).match(/^\s*(r?)('''|"""|'|")/)
  if (!open) return null
  let value = ''
  for (let i = from + open[0].length; i < src.length; i++) {
    if (src.startsWith(open[2], i)) return { value, end: i + open[2].length }
    if (src[i] === '\n' && open[2].length === 1) return null
    if (src[i] === '\\' && !open[1]) value += ESCAPES[src[++i]] ?? '\\' + src[i]
    else value += src[i]
  }
  return null
}
const SED_D = /(['"])\/((?:\\.|[^/])*)\/d\1/g
const ECHO = /\b(echo|printf)\s+(?:-\w+\s+)?(['"])((?:\\.|(?!\2).)*)\2\s*>>?\s*([^\s;&|]+)/g
const SED_S = /(['"])(?:[\d,$]+|\/[^/]*\/)?s([^\w\s\\])((?:\\.|(?!\2).)*?)\2((?:\\.|(?!\2).)*?)\2[gIp0-9]*\1/g
/** Best effort: `cat` heredocs, `echo`/`printf` redirects, `sed -i` substitutions and deletions, and Python replacements
 * of literals (`.replace`, helpers defined in the script, and pair lists). */
const bashDiff = (command: string) => {
  const { unquoted, scratch, heredocs } = parseBash(command)
  const echoes = [...unquoted.matchAll(ECHO)]
    .filter(m => !scratch(m[4]) && m[4] !== '/dev/null')
    .map(m => lines(m[1] === 'printf' ? m[3].replaceAll('\\n', '\n').replace(/\n$/, '') : m[3], '+'))
  const unescape = (text: string) =>
    text
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\([^\w\s])/g, '$1')
  const written = heredocs
    .filter(h => /\bcat\b/.test(h.opener) && !scratch(h.opener.match(/>>?\s*['"]?([^\s'";&|]+)/)?.[1] ?? '/tmp/'))
    .map(h => lines(h.body, '+'))
  const seds = unquoted
    .split('\n')
    .filter(line => /\b(?:sed|perl)\s[^\n]*-\w*i\b/.test(line))
    .flatMap(line => [
      ...[...line.matchAll(SED_S)].map(m => diffLines(unescape(m[3]), unescape(m[4]))),
      ...[...line.matchAll(SED_D)].map(m => ['-' + unescape(m[2])]),
    ])
  const replaces = heredocs
    .filter(h => /\bpython3?\b/.test(h.opener))
    .flatMap(({ body }) => {
      const variables = new Map(
        [...body.matchAll(/^(\w+)\s*=(?=\s*r?['"])/gm)].flatMap(m => {
          const literal = readLiteral(body, m.index! + m[0].length)
          return literal ? [[m[1], literal.value] as const] : []
        }),
      )
      const argument = (from: number) => {
        const name = body.slice(from).match(/^\s*(\w+)\s*(?=[,)])/)
        return name && variables.has(name[1])
          ? { value: variables.get(name[1])!, end: from + name[0].length }
          : readLiteral(body, from)
      }
      const pair = (from: number) => {
        const before = argument(from)
        const comma = before && body.slice(before.end).match(/^\s*,/)
        const after = before && comma && argument(before.end + comma[0].length)
        return after ? [diffLines(before.value, after.value)] : []
      }
      const helpers = [...body.matchAll(/^def (\w+)\(/gm)].map(m => m[1])
      const calls = helpers.length ? new RegExp(`(?:\\.replace|\\b(?:${helpers.join('|')}))\\(`, 'g') : /\.replace\(/g
      const tuples = /[[,(]\s*\((?=\s*r?['"])/g
      return [...body.matchAll(calls), ...body.matchAll(tuples)].flatMap(m => pair(m.index! + m[0].length))
    })
  return hunks([...written, ...echoes, ...seds, ...replaces])
}
/** Write inputs are logged in full, so they parse unless the transcript was cached before they were. */
const writeDiff = byText(call => {
  try {
    if (toolName(call) === 'Bash') return bashDiff(bashCommand(call))
    const input = JSON.parse(toolInput(call))
    if (input.edits)
      return hunks(
        input.edits.map((e: { old_string: string; new_string: string }) => diffLines(e.old_string, e.new_string)),
      )
    if ('old_string' in input) return diffLines(input.old_string, input.new_string)
    return lines(input.content ?? input.new_source ?? '', '+')
  } catch {
    return null
  }
})
const DENIED_MARK = <span style={{ color: 'var(--bad)', fontWeight: 700 }}>✗ </span>
const toolSummary = (group: Message[]) => {
  const names = group.filter(isCall).map(call => {
    const skill = toolName(call) === 'Skill' && inputOf(call)?.skill
    return skill ? `Skill ${skill}` : toolName(call)
  })
  if (names.length === 0) return 'Tool results'
  return `${names.length} tool call${names.length === 1 ? '' : 's'} · ${[...new Set(names)].join(', ')}`
}

/**
 * One session's latest messages, loaded on mount (`sessions.transcript`) and followed until archived: where the session
 * runs (a link that opens it there with `sessions.open`, desktop only), then its pending decision and a message box
 * pinned to the bottom. Without a session, a new chat.
 */
export default function Transcript({ session, slot }: CardProps<{ session?: string | null }>) {
  if (!session) return <NewChat />
  return <SessionTranscript key={session} id={session} slot={slot} />
}

type Run = { state: string; summary: string | null }

type ChatLink = { ref: string; kind: string; label: string | null }
const LINK_TONES: Record<string, string> = { pr: 'info' }

const tilde = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, '~')
const short = (path: string) => tilde(path).replace(/^~\/Documents\//, '')

/**
 * A blank chat: its first message starts a session (`sessions.start`) in the folder above the box (by default the most
 * recent session's), and the chat board then follows that session.
 */
function NewChat() {
  const client = useMobile() ? 'mobile' : 'desktop'
  const [prompt, setPrompt] = useDraft('NewChat.prompt')
  const [files, setFiles] = useDraft('NewChat.files')
  const [stash, setStash] = useDraft('NewChat.stash')
  const [todo, setTodo] = useDraft('NewChat.todo')
  const [pinned, setPinned] = useDraft('NewChat.cwd')
  const [model, setModel] = useDraft('NewChat.model')
  const [linksDraft, setLinks] = useDraft('NewChat.links')
  const links: ChatLink[] = linksDraft ? JSON.parse(linksDraft) : []
  const linked = useQuery<{ title: string }>('workstreams_items', { id: Number(todo) || 0 })?.[0]
  const latest = useQuery<Session>('sessions.recent', { limit: 1, hidden: 0 })?.[0]?.cwd
  const cwd = pinned ? pinned.trim() : latest ? short(latest) : ''
  const [runId, setRunId] = useState<string>()
  const [error, setError] = useState('')
  const started = useQuery<Run>('core_runs', { id: runId ?? '' })?.[0]
  const shortId = started?.state === 'success' ? started.summary?.match(/^started (\w+)/)?.[1] : undefined
  const session = useQuery<Session>('sessions_items', { short_id: shortId ?? '' })?.[0]
  const queued = !!runId && !started && !navigator.onLine

  useEffect(() => {
    if (started?.state !== 'failure') return
    setError(started.summary ?? 'Could not start the chat')
    setRunId(undefined)
  }, [started?.state])

  useEffect(() => {
    if (!session && !queued) return
    setPrompt('')
    setFiles('')
    setPinned('')
    setLinks('')
    if (!session) return
    if (todo) {
      mutate('workstreams.link_add', {
        item: Number(todo),
        ref: `sessions:${session.id}`,
        kind: 'session',
        label: '',
      }).catch(console.error)
      setTodo('')
    }
    mutate('ui.open_chat', { client, session: session.id }).catch((e: Error) => setError(e.message))
  }, [session?.id, queued])

  const dirty = !!(prompt || links.length || todo)
  const clear = () => {
    setStash(JSON.stringify({ prompt, files, links: linksDraft, todo }))
    setPrompt('')
    setFiles('')
    setLinks('')
    setTodo('')
  }
  const restore = () => {
    const saved = JSON.parse(stash)
    setPrompt(saved.prompt)
    setFiles(saved.files)
    setLinks(saved.links)
    setTodo(saved.todo)
    setStash('')
  }

  const start = (prompt: string, files: Attachment[]) => {
    if (!prompt || runId) return
    setError('')
    const full = links.length
      ? `${prompt}\n\nLinks:\n${links.map(l => `- ${l.label ?? l.kind}: ${l.ref}`).join('\n')}`
      : prompt
    run('sessions.start', {
      ...withAttachments('prompt', full, files),
      cwd: cwd.trim(),
      model: MODELS[model] ?? MODELS.opus,
      origin: 'me',
    }).then(setRunId, (e: Error) => setError(e.message))
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        flex: 1,
        minHeight: 0,
        background: 'var(--panel)',
      }}
    >
      <div className="board-header">
        <span style={{ flex: 1, fontWeight: 600 }}>New chat</span>
        {dirty ? (
          <button
            type="button"
            className="ghost icon"
            title="Clear the message, files and links (Esc)"
            aria-label="Clear"
            onMouseDown={e => e.preventDefault()}
            onClick={clear}
          >
            ✕
          </button>
        ) : (
          stash && (
            <button
              type="button"
              className="ghost icon"
              title="Restore the cleared message, files and links"
              aria-label="Restore"
              onMouseDown={e => e.preventDefault()}
              onClick={restore}
            >
              <Icon name="undo" />
            </button>
          )
        )}
      </div>
      <div style={{ flex: 1 }} />
      {error && <div style={{ ...BUBBLE, color: 'var(--bad)' }}>{error}</div>}
      {queued && <div className="empty">Queued: the chat appears in the sidebar once it starts</div>}
      <div className="composer-footer">
        {(linked || links.length > 0) && (
          <div className="todo-chips" style={{ marginBottom: 6 }}>
            {linked && (
              <span className="badge" data-tone="accent" title="Sending links this chat to the to-do">
                To-do: {clip(linked.title, 32)}
                <button title="Don't link to the to-do" onClick={() => setTodo('')}>
                  ×
                </button>
              </span>
            )}
            {links.map(l => (
              <span key={l.ref} className="badge" data-tone={LINK_TONES[l.kind]} title={l.ref}>
                {l.label ?? l.kind}
                <button
                  title="Leave out of the message"
                  onClick={() => setLinks(JSON.stringify(links.filter(o => o.ref !== l.ref)))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="chat-options">
          <ModelSelect value={model || 'opus'} onChange={setModel} />
          <FolderPicker value={cwd} onChange={next => setPinned(next || ' ')} />
        </div>
        <div className="composer-row">
          <MessageBox
            draft="NewChat.prompt"
            files="NewChat.files"
            placeholder={cwd.trim() ? 'Ask Claude' : 'Ask Claude to change this app'}
            onSend={start}
            onError={setError}
            button={runId && !queued ? <Spinner /> : undefined}
            onKeyDown={e => {
              if (e.key !== 'Escape' || !dirty) return
              e.preventDefault()
              clear()
            }}
          />
        </div>
      </div>
    </div>
  )
}

/** The new chat's folder: on focus, lists recently used folders, filtered by what is typed since. */
function FolderPicker({ value, onChange }: { value: string; onChange: (cwd: string) => void }) {
  const folders = useQuery<{ cwd: string }>('sessions.folders', { limit: 50 }) ?? []
  const [filter, setFilter] = useState<string>()
  const [active, setActive] = useState(0)
  const needle = filter?.trim().toLowerCase() ?? ''
  const matches = folders.map(f => short(f.cwd)).filter(f => f.toLowerCase().includes(needle))
  const open = filter !== undefined && matches.length > 0
  const pick = (cwd: string) => {
    onChange(cwd)
    setFilter(undefined)
  }

  return (
    <div className="folder-picker">
      <input
        value={value}
        onFocus={e => {
          e.currentTarget.select()
          setFilter('')
          setActive(0)
        }}
        onBlur={() => setFilter(undefined)}
        onChange={e => {
          onChange(e.target.value)
          setFilter(e.target.value)
          setActive(0)
        }}
        onKeyDown={e => {
          if (!open) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setActive(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            pick(matches[Math.min(active, matches.length - 1)])
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            setFilter(undefined)
          }
        }}
        placeholder="Folder (empty: this app)"
        aria-label="Folder"
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      {open && (
        <div className="folder-list" role="listbox">
          {matches.map((cwd, i) => (
            <button
              key={cwd}
              role="option"
              aria-selected={i === active}
              title={cwd}
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(cwd)}
            >
              {cwd}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const CLOCK_SKEW = 5000
const PAGE = 500
const FIRST_PAGE = 100
const PREFETCH_SCREENS = 2
const AWAY_FROM_END = 300
const FOLLOW_WITHIN = 48
const MIN_SEARCH = 2
const SEARCH_DEBOUNCE = 120
const DRAW_BATCH = 20
const DRAW_PAUSE = 150

/**
 * Preview tabs: `terminal` or `doc:<path>` (a Markdown, HTML, .txt or image file, or an unsent image), and those closed, latest
 * last. On phones, `shown` false shows the chat.
 */
type PreviewState = { tabs: string[]; active?: string; shown: boolean; closed?: string[] }

function SessionTranscript({ id, slot }: { id: string; slot?: string }) {
  const row = useQuery<Session>('sessions_items', { id })?.[0]
  const loading = !row
  const session: Session = row ?? {
    id,
    title: '',
    status: '',
    cwd: null,
    host: null,
    kind: null,
    short_id: null,
    live: 0,
    last_message: null,
    last_prompt: null,
    decision: null,
    updated: '',
    hidden: 0,
  }
  const todos =
    useQuery<{ item: number; item_title: string; item_done: number; item_list: string }>('workstreams_links', {
      ref: `sessions:${id}`,
    }) ?? []
  const [limit, setLimit] = useState(FIRST_PAGE)
  const [away, setAway] = useState(false)
  const rows = useQuery<Message>('sessions.transcript', { session: id, limit })
  const loaded = useRef<Message[]>([])
  if (rows) loaded.current = rows
  const messages = loaded.current
  const agents = useQuery<Subagent>('sessions_subagents', { session: id, done: 0 })
  // what is already under way when the chat opens shows at once; only later changes animate
  const opened = useRef<{ agents: Set<string> }>(undefined)
  if (row && rows && agents) opened.current ??= { agents: new Set(agents.map(a => String(a.id))) }
  const subagents = (agents ?? []).filter(
    a => (a.background || busy(session)) && Date.now() - Date.parse(a.updated_at ?? '') < STALE_SUBAGENT,
  )
  const [error, setError] = useState('')
  const [searching, setSearching] = useState(false)
  const previewKey = `Transcript.preview:${id}`
  const [preview, setPreviewState] = useState<PreviewState>(
    () => JSON.parse(localStorage.getItem(previewKey) ?? 'null') ?? { tabs: [], shown: false },
  )
  const setPreview = (change: (current: PreviewState) => PreviewState) =>
    setPreviewState(current => {
      const next = change(current)
      localStorage.setItem(previewKey, JSON.stringify(next))
      return next
    })
  const openTab = (tab: string) =>
    setPreview(({ tabs, closed = [] }) => ({
      tabs: tabs.includes(tab) ? tabs : [...tabs, tab],
      active: tab,
      shown: true,
      closed: closed.filter(t => t !== tab),
    }))
  const closeTab = (tab: string) =>
    setPreview(({ tabs, active, shown, closed = [] }) => {
      const left = tabs.filter(t => t !== tab)
      return {
        tabs: left,
        active: active === tab ? left.at(-1) : active,
        shown: shown && left.length > 0,
        closed: [...closed.filter(t => t !== tab), tab].slice(-20),
      }
    })
  const previewOpen = preview.shown && preview.tabs.length > 0
  const showPreview = (shown: boolean) => setPreview(current => ({ ...current, shown }))
  const watching = !!useQuery('sessions_watches', { session: id })?.length
  const mobile = useMobile()
  const scroller = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  useQuoteShortcut(card)
  useFindKey(card, () => {
    setSearching(true)
    setLimit(current => Math.max(current, PAGE))
    requestAnimationFrame(() => card.current?.querySelector<HTMLInputElement>('.transcript-search input')?.select())
  })
  const working = busy(session)
  useExpose({ stoppable: working && session.kind === 'background' ? id : undefined })
  const scrollToEnd = () => requestAnimationFrame(() => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' }))
  const hasMessages = messages.length > 0
  useEffect(() => {
    const el = scroller.current
    const list = el?.firstElementChild
    if (!el || !list) return
    let anchor: { node: Element; top: number } | undefined
    let adjusted: number | undefined
    const pin = () => {
      if (el.scrollTop === adjusted) return
      adjusted = undefined
      const bottom = el.getBoundingClientRect().bottom
      anchor = undefined
      for (let node = list.lastElementChild; node; node = node.previousElementSibling) {
        const top = node.getBoundingClientRect().top
        if (top < bottom) return void (anchor = { node, top })
      }
    }
    const follow = new ResizeObserver(() => {
      if (el.scrollTop <= -FOLLOW_WITHIN && anchor?.node.isConnected) {
        el.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top
        adjusted = el.scrollTop
        return
      }
      if (el.scrollTop > -FOLLOW_WITHIN && el.scrollTop < 0) el.scrollTop = 0
      adjusted = undefined
      pin()
    })
    el.addEventListener('scroll', pin, { passive: true })
    follow.observe(list)
    return () => {
      el.removeEventListener('scroll', pin)
      follow.disconnect()
    }
  }, [hasMessages])
  const drawer = useRef<IntersectionObserver>(undefined)
  useEffect(() => {
    const draw = new IntersectionObserver(
      seen =>
        seen.forEach(e => {
          if (!e.isIntersecting) return
          e.target.setAttribute('data-near', '')
          draw.unobserve(e.target)
        }),
      { root: scroller.current, rootMargin: '200% 0px' },
    )
    drawer.current = draw
    return () => draw.disconnect()
  }, [])
  const entries = useOutbox(id)
  const pending = usePending(id)
  const echoed = ({ text, at }: Pending) =>
    messages.some(m => m.role === 'user' && Date.parse(m.at) >= at - CLOCK_SKEW && containsMessage(m.text, text))
  const outboxed = (state: (s: Outbox['state']) => boolean, { text, at }: Pending) =>
    entries.find(e => state(e.state) && e.queued_at >= at - CLOCK_SKEW && containsMessage(outboxText(e), text))
  const sending = pending.filter(p => !echoed(p) && !outboxed(s => s !== 'sending', p))
  const compacting = sending.find(p => /^\/compact\b/.test(p.text.trim()))

  useEffect(() => {
    setPending(id, sends => {
      const kept = sends.filter(p => !echoed(p))
      const added = entries
        .filter(e => e.state === 'sending' && !kept.some(p => containsMessage(outboxText(e), p.text)))
        .map(e => ({ text: outboxText(e), at: e.queued_at }))
        .filter(p => !echoed(p))
      return kept.length === sends.length && !added.length ? sends : [...kept, ...added]
    })
  }, [messages, entries, pending])

  useEffect(() => {
    if (!loading) mutate('sessions.seen', { session: id }).catch(console.error)
  }, [id, loading, session.updated])

  const uncached = useQuery('sessions_transcripts', { session: id })?.length === 0
  useEffect(() => {
    if (uncached) run('sessions.transcript', { session: id }).catch((e: Error) => setError(e.message))
  }, [id, uncached])

  const { denied, kinds, shownGroups } = useMemo(() => {
    const groups = messages.reduce<(Message | Message[])[]>((all, m) => {
      const last = all.at(-1)
      const loadedSkill = m.role === 'skill' || (m.role === 'user' && SKILL.test(m.text))
      if (Array.isArray(last) && (isTool(m) || (loadedSkill && last.some(c => toolName(c) === 'Skill')))) last.push(m)
      else if (!isTool(m)) all.push(m)
      else all.push([m])
      return all
    }, [])
    const denied = new Set(groups.flatMap(group => (Array.isArray(group) ? deniedTools(group) : [])))
    const kinds = new Map(groups.flatMap(group => (Array.isArray(group) ? toolKinds(group) : [])))
    const kind = (m: Message) => `${denied.has(m.uuid)}:${kinds.get(m.uuid) ?? 'tool'}`
    const callOf = new Map(
      groups.flatMap(group =>
        Array.isArray(group) ? toolCalls(group).flatMap(([call, result]) => (result ? [[result.uuid, call]] : [])) : [],
      ),
    )
    const shownGroups = groups.flatMap<Message | Message[]>(group =>
      Array.isArray(group)
        ? group.reduce<Message[][]>((runs, m) => {
            const run = runs.at(-1)
            const call = callOf.get(m.uuid)
            const callRun = call && runs.find(r => r.includes(call))
            if (callRun) callRun.push(m)
            else if (run && kind(run[0]) === kind(m)) run.push(m)
            else runs.push([m])
            return runs
          }, [])
        : [group],
    )
    return { denied, kinds, shownGroups }
  }, [messages])
  const cwdPrefix = session.cwd ? `${tilde(session.cwd)}/` : null
  const shortPaths = (calls: Message[]) =>
    [
      ...new Set(
        calls
          .flatMap(toolPaths)
          .map(tilde)
          .map(p => (cwdPrefix && p.startsWith(cwdPrefix) ? p.slice(cwdPrefix.length) : p)),
      ),
    ].join(', ')
  const newest = shownGroups.at(-1)
  const newestKey = newest && (Array.isArray(newest) ? newest[0].uuid : newest.uuid)
  const shownKeys = useRef<Set<string> | undefined>(undefined)
  const grown = useRef(new Set<string>())
  if (
    newestKey &&
    shownKeys.current &&
    !shownKeys.current.has(newestKey) &&
    (Array.isArray(newest) || newest.role !== 'user')
  )
    grown.current.add(newestKey)
  useEffect(() => {
    if (messages.length) shownKeys.current = new Set(shownGroups.map(g => (Array.isArray(g) ? g[0].uuid : g.uuid)))
  }, [shownGroups])
  const last = messages.at(-1)
  const typing = working && !compacting && !(last?.role === 'assistant' && !isTool(last))
  const lastVisible = messages.findLast(m => !isTool(m) && m.role !== 'thinking')
  const visibleAt = lastVisible ? messages.indexOf(lastVisible) : -1
  const context = messages.findLast(m => m.tokens)?.tokens ?? 0
  const baseline =
    lastVisible?.tokens ??
    messages.slice(0, visibleAt).findLast(m => m.tokens)?.tokens ??
    messages.slice(visibleAt + 1).find(m => m.tokens)?.tokens ??
    context
  const spent = context - baseline
  const decision = session.decision && WAITING.includes(session.status) ? JSON.parse(session.decision) : null
  const fail = (e: Error) => setError(e.message)
  const folder = session.cwd ? short(session.cwd) : ''
  const model = (session.model ?? messages.findLast(m => m.model)?.model)?.match(/opus|sonnet|haiku|fable/)?.[0]
  const client = mobile ? 'mobile' : 'desktop'
  const archive = useArchive(client)
  const toggleArchived = () => (session.hidden ? mutate('sessions.unhide', { id }) : archive(id, true)).catch(fail)
  const editable = !session.live || session.kind === 'background'
  const firstPrompt = messages.find(m => m.role === 'user')?.uuid
  const edit = ({ uuid, text }: Message) =>
    mutate('sessions.rewind', { session: id, uuid })
      .then(() => {
        setDraft(draftKey(id), text)
        requestAnimationFrame(() => {
          const box = scroller.current?.parentElement?.querySelector<HTMLTextAreaElement>('.composer-footer textarea')
          box?.focus()
          box?.setSelectionRange(text.length, text.length)
        })
        if (working) return run('sessions.stop', { session: id })
      })
      .catch(fail)
  const toggleWatching = () => mutate(watching ? 'sessions.unwatch' : 'sessions.watch', { session: id }).catch(fail)
  const terminalName = `chat-${id.slice(0, 8)}`
  const openTerminal = (command = '') => {
    run('term.open', { name: terminalName, cwd: session.cwd ?? '', chat: id, command }).catch(fail)
    openTab('terminal')
    if (!mobile)
      requestAnimationFrame(() => card.current?.querySelector<HTMLElement>('.preview .xterm-helper-textarea')?.focus())
  }
  const closePreviewTab = (tab: string) => {
    if (tab === 'terminal') run('term.close', { name: terminalName }).catch(fail)
    closeTab(tab)
  }
  const togglePreview = () => {
    const reopen = preview.closed?.at(-1)
    if (previewOpen) showPreview(false)
    else if (preview.tabs.length) showPreview(true)
    else if (reopen && reopen !== 'terminal') openTab(reopen)
    else openTerminal()
  }
  useEffect(() => {
    const element = card.current
    if (!element) return
    const onQuote = (e: Event) => {
      e.preventDefault()
      setDraft(
        draftKey(id),
        current => `${current.trimEnd() ? `${current.trimEnd()}\n\n` : ''}${(e as CustomEvent<string>).detail}\n\n`,
      )
      if (mobile) return
      requestAnimationFrame(() => {
        const box = element.querySelector<HTMLTextAreaElement>('.composer-footer textarea')
        box?.focus()
        box?.setSelectionRange(box.value.length, box.value.length)
      })
    }
    const onOpenDoc = (e: Event) => {
      e.preventDefault()
      openTab(`doc:${tilde((e as CustomEvent<string>).detail)}`)
    }
    element.addEventListener('quote', onQuote)
    element.addEventListener('open-doc', onOpenDoc)
    return () => {
      element.removeEventListener('quote', onQuote)
      element.removeEventListener('open-doc', onOpenDoc)
    }
  }, [mobile])
  const actions = useRef({ edit, openTerminal })
  actions.current = { edit, openTerminal }
  const items = useMemo(() => {
    const runCode = (code: string) => actions.current.openTerminal(code)
    return shownGroups.map(group => {
      const uuid = Array.isArray(group) ? group[0].uuid : group.uuid
      const groupKind = Array.isArray(group) && kinds.get(uuid)
      const calls = Array.isArray(group) ? group.filter(isCall) : []
      const count = (noun: string) => `${calls.length} ${noun}${calls.length === 1 ? '' : 's'}`
      return (
        <div
          key={uuid}
          className={
            grown.current.has(uuid)
              ? !Array.isArray(group) && group.role === 'assistant'
                ? 'transcript-item grow slow'
                : 'transcript-item grow'
              : 'transcript-item'
          }
          onAnimationEnd={e => e.target === e.currentTarget && e.currentTarget.classList.remove('grow', 'slow')}
        >
          {Array.isArray(group) && groupKind === 'read' ? (
            <div style={{ ...BUBBLE, color: 'var(--muted)', fontSize: 12 }}>
              {denied.has(uuid) && DENIED_MARK}
              {count('read')} · {shortPaths(calls)}
            </div>
          ) : Array.isArray(group) && groupKind === 'write' ? (
            <details style={BUBBLE}>
              <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>
                {denied.has(uuid) && DENIED_MARK}
                {count('write')}
                {shortPaths(calls) && ` · ${shortPaths(calls)}`}
              </summary>
              {group.map(m => {
                const diff = isCall(m) && writeDiff(m)
                if (!isCall(m) && !denied.has(m.uuid) && !m.is_error) return null
                return diff ? (
                  <div key={m.uuid}>
                    <div style={TOOL_LINE}>{shortPaths([m])}</div>
                    <div className="diff">
                      {diff.map((line, i) => (
                        <div key={i} data-op={line[0]}>
                          {line}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div key={m.uuid} style={TOOL_LINE}>
                    {toolName(m) === 'Bash' ? `$ ${bashCommand(m)}` : m.text}
                  </div>
                )
              })}
            </details>
          ) : Array.isArray(group) ? (
            <details style={BUBBLE}>
              <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>
                {denied.has(group[0].uuid) && DENIED_MARK}
                {toolSummary(group)}
              </summary>
              {group.map(m => (
                <div key={m.uuid} style={TOOL_LINE}>
                  {denied.has(m.uuid) && isCall(m) && DENIED_MARK}
                  {m.text}
                </div>
              ))}
            </details>
          ) : group.role === 'subagent' || group.role === 'peer' ? (
            <details style={BUBBLE}>
              <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>
                {group.role === 'subagent' ? 'Subagent returned' : 'Message from another agent'}
              </summary>
              <div
                className="message"
                onClick={e => copyCode(e, group.text)}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(group.text) }}
              />
            </details>
          ) : group.role === 'notification' ? (
            <details style={BUBBLE}>
              <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>
                Background command finished
              </summary>
              <div style={TOOL_LINE}>{group.text}</div>
            </details>
          ) : group.role === 'thinking' ? (
            <div style={{ ...BUBBLE, color: 'var(--muted)', fontSize: 12, fontStyle: 'italic' }}>
              {Number(group.text) ? `Thought for ${group.text} tokens` : 'Thought'}
            </div>
          ) : group.role === 'compact' ? (
            <details style={COMPACT}>
              <summary style={{ cursor: 'pointer', color: '#a78bfa', fontSize: 12 }}>Context compacted</summary>
              <div
                className="message"
                onClick={e => copyCode(e, group.text)}
                dangerouslySetInnerHTML={{ __html: renderMarkdown(group.text) }}
              />
            </details>
          ) : group.role === 'command' ? (
            <details style={BUBBLE}>
              <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>Command output</summary>
              <div style={TOOL_LINE}>{group.text}</div>
            </details>
          ) : group.role === 'skill' || (group.role === 'user' && SKILL.test(group.text)) ? (
            <details style={BUBBLE}>
              <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>
                Skill loaded{SKILL.test(group.text) && ` · ${group.text.match(SKILL)![1]}`}
              </summary>
              <div style={TOOL_LINE}>{group.text}</div>
            </details>
          ) : (
            <Bubble
              role={group.role}
              label={`${new Date(group.at).toLocaleTimeString()}${group.tokens ? ` · ${Math.round(group.tokens / 1000)}k` : ''}`}
              text={group.text}
              onRunCode={mobile ? undefined : runCode}
              action={
                group.role === 'user' &&
                editable &&
                group.uuid !== firstPrompt && (
                  <button
                    type="button"
                    className="ghost icon small"
                    title="Edit this message, dropping it and everything after it (Esc in the message box cancels)"
                    aria-label="Edit"
                    onClick={() => actions.current.edit(group)}
                  >
                    <Icon name="pencil" />
                  </button>
                )
              }
            />
          )}
        </div>
      )
    })
  }, [shownGroups, denied, kinds, session.cwd, editable, firstPrompt, mobile])
  const scrolledAt = useRef(0)
  useEffect(() => {
    const undrawn = [...(scroller.current?.querySelectorAll('.transcript-item:not([data-near])') ?? [])]
    undrawn.forEach(el => drawer.current?.observe(el))
    let timer: ReturnType<typeof setTimeout>
    const drawBatch = () => {
      if (Date.now() - scrolledAt.current > DRAW_PAUSE)
        undrawn.splice(-DRAW_BATCH).forEach(el => el.setAttribute('data-near', ''))
      if (undrawn.length) timer = setTimeout(drawBatch, DRAW_PAUSE / 3)
    }
    timer = setTimeout(drawBatch, DRAW_PAUSE)
    return () => clearTimeout(timer)
  }, [items])
  return (
    <div
      ref={card}
      className="quote-target"
      data-cwd={session.cwd ? tilde(session.cwd) : undefined}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--panel)' }}
    >
      <div className="board-header">
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <input
            key={session.title}
            defaultValue={session.title}
            placeholder={loading ? undefined : 'Title (empty restores the default)'}
            aria-label="Session title"
            title="Rename"
            className="inline-edit ellipsis"
            style={{ display: 'block', width: '100%', fontWeight: 600 }}
            onKeyDown={e => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                e.stopPropagation()
                e.currentTarget.value = session.title
                e.currentTarget.blur()
              }
            }}
            onBlur={e => {
              if (e.currentTarget.value.trim() !== session.title)
                mutate('sessions.rename', { id, title: e.currentTarget.value }).catch(fail)
            }}
          />
          <div
            className="ellipsis"
            style={{ color: 'var(--muted)', fontSize: 12, visibility: loading ? 'hidden' : undefined }}
            title={session.cwd ?? undefined}
          >
            {!['switchboard', 'dev.switchboard.app'].includes(session.host ?? '') && (
              <>
                {mobile ? (
                  hostName(session)
                ) : (
                  <a
                    href="#"
                    title={session.kind === 'background' ? 'Open in a terminal' : `Open in ${hostName(session)}`}
                    onClick={e => {
                      e.preventDefault()
                      run('sessions.open', { session: id }).catch(fail)
                    }}
                  >
                    {hostName(session)}
                  </a>
                )}{' '}
                ·{' '}
              </>
            )}
            <input
              key={folder}
              defaultValue={folder}
              placeholder="No folder"
              aria-label="Session folder"
              disabled={!!session.live && session.kind !== 'background'}
              title={
                session.live && session.kind !== 'background'
                  ? 'Close the session to change its folder'
                  : 'Change folder: the session resumes there on its next message'
              }
              className="inline-edit"
              onKeyDown={e => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  e.currentTarget.value = folder
                  e.currentTarget.blur()
                }
              }}
              onBlur={e => {
                const cwd = e.currentTarget.value.trim()
                if (cwd && cwd !== folder) run('sessions.move', { session: id, cwd }).catch(fail)
                else e.currentTarget.value = folder
              }}
            />{' '}
            ·{' '}
            <ModelSelect
              className="inline-edit"
              value={model}
              disabled={!!session.live && session.kind !== 'background'}
              onChange={(_, next) => mutate('sessions.model_set', { session: id, model: next }).catch(fail)}
            />
          </div>
        </div>
        <span
          className="badge"
          data-tone={TONES[session.status]}
          style={{ visibility: loading ? 'hidden' : undefined }}
        >
          {session.status.replace('_', ' ')}
        </span>
        {todos.map(t => (
          <button
            key={t.item}
            className="badge"
            title={t.item_list === 'projects' ? 'Open the project' : 'Open the to-do list'}
            style={{ textDecoration: t.item_done ? 'line-through' : undefined }}
            onClick={() => {
              const client = mobile ? 'mobile' : 'desktop'
              const opened =
                t.item_list === 'projects'
                  ? mutate('ui.open_project', { client, project: t.item })
                  : mutate('ui.set_board', { client, id: 'main' })
              opened.catch(fail)
            }}
          >
            {t.item_list === 'projects' ? <Icon name="briefcase" /> : '☐'} {clip(t.item_title, 32)}
          </button>
        ))}
        <Actions
          actions={[
            !loading && {
              label: previewOpen ? 'Hide preview' : 'Show preview',
              text: previewOpen ? (mobile ? 'Open chat' : 'Hide preview') : 'Open preview',
              icon: <Icon name={previewOpen ? 'sidebar-collapse' : 'sidebar-expand'} size={14} />,
              pressed: previewOpen,
              onClick: togglePreview,
            },
            !loading && {
              label: 'Terminal in this folder',
              text: 'Open terminal',
              icon: <TerminalIcon />,
              onClick: () => openTerminal(),
            },
            !loading && {
              label: session.hidden ? 'Unarchive' : 'Archive',
              icon: <ArchiveIcon unarchive={!!session.hidden} />,
              onClick: toggleArchived,
            },
            !loading && {
              label: 'Search this chat (⌘F)',
              text: 'Search',
              pressed: searching,
              onClick: () => setSearching(!searching),
            },
            !loading && {
              label: watching ? 'Notifying after every turn' : 'Notify me after every turn',
              text: watching ? 'Stop notifying' : 'Notify me after every turn',
              icon: <BellIcon off={!watching} />,
              pressed: watching,
              onClick: toggleWatching,
            },
            { label: 'Copy ID', onClick: () => navigator.clipboard.writeText(id).catch(fail) },
            { label: 'Reload transcript', onClick: () => run('sessions.transcript', { session: id }).catch(fail) },
          ]}
        />
      </div>
      <Preview
        id={id}
        open={preview.shown}
        active={preview.active}
        onSelect={tab => openTab(tab)}
        onClose={closePreviewTab}
        onCollapse={() => showPreview(false)}
        tabs={preview.tabs.map(tab => {
          if (tab === 'terminal')
            return {
              key: tab,
              label: 'Terminal',
              icon: <TerminalIcon size={12} />,
              content: <CardSlot component="Terminal" props={{ name: terminalName }} id={`${slot ?? id}/terminal`} />,
            }
          const path = tab.slice('doc:'.length)
          const cwd = session.cwd && tilde(session.cwd)
          const unsent = isUnsent(path)
          const image = unsent || IMAGE.test(path)
          const name = unsent ? 'Unsent image' : path.split('/').pop()!
          return {
            key: tab,
            label: name,
            title: unsent ? name : path,
            icon: (
              <Icon name={image ? 'image' : HTML.test(path) ? 'file-code' : TXT.test(path) ? 'file' : 'markdown'} />
            ),
            content: image ? <ImageView key={tab} path={path} cwd={cwd} /> : <Doc path={path} cwd={cwd} />,
          }
        })}
      >
        {searching && <TranscriptSearch root={scroller} messages={messages} onClose={() => setSearching(false)} />}
        <div
          style={{
            position: 'relative',
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            ref={scroller}
            onScroll={e => {
              scrolledAt.current = Date.now()
              const { scrollTop, scrollHeight, clientHeight } = e.currentTarget
              setAway(scrollTop < -AWAY_FROM_END)
              if (
                rows &&
                rows.length >= limit &&
                scrollHeight - clientHeight + scrollTop < clientHeight * PREFETCH_SCREENS
              )
                setLimit(limit + PAGE)
            }}
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              overscrollBehavior: 'contain',
              display: 'flex',
              flexDirection: 'column-reverse',
            }}
          >
            <div>
              {error && <div style={{ ...BUBBLE, color: 'var(--bad)' }}>{error}</div>}
              {items}
              {opened.current && (
                <div className="collapse" data-open={typing || undefined}>
                  <div>
                    <div style={BUBBLE}>
                      <Working since={lastVisible?.at} tokens={spent} />
                    </div>
                  </div>
                </div>
              )}
              {subagents.map(a => (
                <div
                  key={a.id}
                  className={opened.current?.agents.has(String(a.id)) === false ? 'fade-in ellipsis' : 'ellipsis'}
                  style={BUBBLE}
                  title={a.activity ?? undefined}
                >
                  <Working
                    since={a.started_at ?? undefined}
                    tokens={0}
                    label={[a.description ?? a.agent_type ?? 'Subagent', clip(a.activity, 70)]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                </div>
              ))}
              {sending.map(p => {
                const entry = outboxed(s => s === 'sending', p)
                return (
                  <Bubble
                    key={`${p.at}:${p.text}`}
                    role="user"
                    label="Sending"
                    text={p.text}
                    faded
                    action={
                      entry &&
                      interruptible(session, entry) && (
                        <button
                          type="button"
                          className="ghost"
                          style={QUEUE_BUTTON}
                          title="Stop Claude's turn so it reads this now (⌘↩ with an empty message box)"
                          onClick={() => run('sessions.stop', { session: id }).catch(fail)}
                        >
                          Interrupt
                        </button>
                      )
                    }
                  />
                )
              })}
              {compacting && (
                <div style={BUBBLE}>
                  <Working since={new Date(compacting.at).toISOString()} tokens={0} label="Compacting" />
                </div>
              )}
              <QueuedMessage session={session} onError={setError} />
            </div>
          </div>
          {away && (
            <button
              type="button"
              className="icon round fade-in"
              title="Jump to latest"
              aria-label="Jump to latest"
              style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 2, boxShadow: 'var(--shadow)' }}
              onClick={scrollToEnd}
            >
              <Icon name="arrow-down" size={14} />
            </button>
          )}
        </div>
        <div className="composer-footer">
          {decision && <DecisionPanel session={session} decision={decision} onError={setError} />}
          <Composer session={session} onError={setError} />
        </div>
      </Preview>
    </div>
  )
}

/** Highlights a text's matches in the loaded transcript; Enter steps to older matches, Shift+Enter to newer ones. */
function TranscriptSearch({
  root,
  messages,
  onClose,
}: {
  root: RefObject<HTMLElement | null>
  messages: Message[]
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [ranges, setRanges] = useState<Range[]>([])
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    const needle = text.trim().toLowerCase()
    const search = () => {
      const found: Range[] = []
      const walker =
        root.current && needle.length >= MIN_SEARCH
          ? document.createTreeWalker(root.current, NodeFilter.SHOW_TEXT)
          : undefined
      for (let node = walker && walker.nextNode(); node; node = walker!.nextNode()) {
        const value = node.nodeValue!.toLowerCase()
        for (let at = value.indexOf(needle); at >= 0; at = value.indexOf(needle, at + needle.length)) {
          const range = new Range()
          range.setStart(node, at)
          range.setEnd(node, at + needle.length)
          found.push(range)
        }
      }
      setRanges(found)
      setCurrent(found.length - 1)
    }
    if (needle.length < MIN_SEARCH) return search()
    const timer = setTimeout(search, SEARCH_DEBOUNCE)
    return () => clearTimeout(timer)
  }, [text, messages])

  useEffect(() => {
    const match = ranges[current]
    CSS.highlights.set('search', new Highlight(...ranges))
    CSS.highlights.set('search-current', match ? new Highlight(match) : new Highlight())
    const el = match?.startContainer.parentElement
    for (let details = el?.closest('details'); details; details = details.parentElement?.closest('details'))
      details.open = true
    el?.scrollIntoView({ block: 'center' })
  }, [ranges, current])

  useEffect(
    () => () => {
      CSS.highlights.delete('search')
      CSS.highlights.delete('search-current')
    },
    [],
  )

  const step = (by: number) => ranges.length && setCurrent((current + by + ranges.length) % ranges.length)
  return (
    <div className="transcript-search">
      <input
        autoFocus
        value={text}
        placeholder="Search this chat"
        aria-label="Search this chat"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? 1 : -1)
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      />
      <span className="sub">
        {text.trim().length >= MIN_SEARCH &&
          (ranges.length ? `${ranges.length - current}/${ranges.length}` : 'No matches')}
      </span>
      <button
        className="ghost icon small"
        title="Older match (Enter)"
        aria-label="Older match"
        onClick={() => step(-1)}
      >
        <Icon name="chevron-up" size={14} />
      </button>
      <button
        className="ghost icon small"
        title="Newer match (Shift+Enter)"
        aria-label="Newer match"
        onClick={() => step(1)}
      >
        <Icon name="chevron-down" size={14} />
      </button>
      <button className="ghost icon small" title="Close (Esc)" aria-label="Close search" onClick={onClose}>
        ✕
      </button>
    </div>
  )
}
