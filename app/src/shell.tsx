import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { CardSlot, mutate, run } from './switchboard'
import { isRemote, type Binding, type Config, type Params } from './bridge'
import { useConfig } from './config'
import { activeStack, focusStep, type SlotFrame } from './focus'
import { bindingAction, eventKey, groupBindings, matchBindings, normalizeKey, type Action, type Hit } from './keymap'
import { cancel, enableNotifications, useRemoteStatus } from './remote'

const SHELL_COMMANDS = ['palette.open', 'keymap.context', 'card.focus_next', 'card.focus_prev'] as const
type ShellCommand = (typeof SHELL_COMMANDS)[number]
const isShellCommand = (name: string): name is ShellCommand => (SHELL_COMMANDS as readonly string[]).includes(name)

const DEFAULT_KEYMAP: Binding[] = [{ key: 'cmd-k', command: 'palette.open' }]
const NOTICE_MS = 5000
const ARROW_STEPS: Partial<Record<string, 1 | -1>> = { ArrowDown: 1, ArrowUp: -1 }
const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift'])

type Execute = (action: Action, args: Params) => void
type Overlay = { kind: 'palette' | 'context'; stack: SlotFrame[] }

const firesFirst = (hits: Hit[]) => hits.find(hit => !hit.missing.length)
const actionId = ({ kind, name }: Action) => `${kind}:${name}`

export function Shell() {
  const config = useConfig()
  if (config instanceof Error) throw config
  return config ? <LoadedShell config={config} /> : null
}

function LoadedShell({ config }: { config: Config }) {
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [notice, setNotice] = useState('')
  const bindings = useMemo(() => [...DEFAULT_KEYMAP, ...config.keymap], [config.keymap])
  const bindingsByKey = useMemo(() => groupBindings(bindings, b => normalizeKey(b.key)), [bindings])
  const close = useCallback(() => setOverlay(null), [])

  const execute = useCallback<Execute>(({ kind, name }, args) => {
    const showError = (error: Error) => setNotice(error.message)
    const shellCommands: Record<ShellCommand, () => void> = {
      'palette.open': () => setOverlay({ kind: 'palette', stack: activeStack() }),
      'keymap.context': () => setOverlay({ kind: 'context', stack: activeStack() }),
      'card.focus_next': () => focusStep(1),
      'card.focus_prev': () => focusStep(-1),
    }
    if (kind === 'write') mutate(name, args).catch(showError)
    else if (isShellCommand(name)) shellCommands[name]()
    else run(name, args).catch(showError)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (overlay) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const editing =
        e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.closest('input, textarea, select'))
      if (editing && !e.metaKey && !e.ctrlKey) return
      const candidates = bindingsByKey.get(eventKey(e))
      const hit = candidates && firesFirst(matchBindings(candidates, activeStack()))
      if (!hit) return
      e.preventDefault()
      const action = bindingAction(hit.binding)
      if (action) execute(action, hit.args)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [overlay, bindingsByKey, execute])

  return (
    <>
      <CardSlot component={config.root} id="root" />
      {overlay?.kind === 'palette' && (
        <Palette config={config} bindings={bindings} stack={overlay.stack} close={close} execute={execute} />
      )}
      {overlay?.kind === 'context' && <KeyContext bindingsByKey={bindingsByKey} stack={overlay.stack} close={close} />}
      {notice && <div className="notice">{notice}</div>}
      {isRemote && <RemoteStatus />}
    </>
  )
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** On another device: when the board is from the cache, the writes and runs waiting to be sent, and push. */
function RemoteStatus() {
  const { online, asOf, outbox, push } = useRemoteStatus()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const offerPush = online && push === 'off'
  if (online && outbox.length === 0 && !offerPush) return null
  return (
    <>
      <div className="status">
        {!online && <span>Offline{asOf ? ` · as of ${clock(asOf)}` : ''}</span>}
        {outbox.length > 0 && <button onClick={() => setOpen(true)}>{outbox.length} pending</button>}
        {offerPush && (
          <button onClick={() => enableNotifications().catch((e: Error) => setError(e.message))}>
            Enable notifications
          </button>
        )}
        {error && <span className="error">{error}</span>}
      </div>
      {open && outbox.length > 0 && (
        <Overlay close={() => setOpen(false)}>
          {outbox.map(item => (
            <div key={item.id} className="row">
              <span>
                {item.name} <span className="muted">{clock(item.at)}</span>
                {item.error && <span className="error"> {item.error}</span>}
              </span>
              <button onClick={() => cancel(item.id)}>{item.error ? 'Dismiss' : 'Cancel'}</button>
            </div>
          ))}
        </Overlay>
      )}
    </>
  )
}

function Overlay({ close, children }: { close(): void; children: ReactNode }) {
  return (
    <div
      className="overlay"
      onPointerDown={e => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="panel">{children}</div>
    </div>
  )
}

type PaletteEntry = Action & { key?: string; args: Params; disabled: boolean; lowercaseName: string }

/** Every command and writer. Shows the innermost binding's key; disabled when every binding is missing a variable. */
function Palette({
  config,
  bindings,
  stack,
  close,
  execute,
}: {
  config: Config
  bindings: Binding[]
  stack: SlotFrame[]
  close(): void
  execute: Execute
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  const entries = useMemo(() => {
    const bindingsByAction = groupBindings(bindings, b => {
      const action = bindingAction(b)
      return action && actionId(action)
    })
    const actions: Action[] = [
      ...[...SHELL_COMMANDS, ...config.commands].map(name => ({ kind: 'command' as const, name })),
      ...config.writers.map(name => ({ kind: 'write' as const, name })),
    ]
    return actions.map((action): PaletteEntry => {
      const hits = matchBindings(bindingsByAction.get(actionId(action)) ?? [], stack)
      const runnable = firesFirst(hits)
      return {
        ...action,
        key: hits[0]?.binding.key,
        args: runnable?.args ?? {},
        disabled: hits.length > 0 && !runnable,
        lowercaseName: action.name.toLowerCase(),
      }
    })
  }, [config, bindings, stack])

  const shown = useMemo(() => {
    const needle = query.toLowerCase()
    return entries.filter(entry => entry.lowercaseName.includes(needle))
  }, [entries, query])

  const choose = (entry: PaletteEntry | undefined) => {
    if (!entry || entry.disabled) return
    close()
    execute(entry, entry.args)
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const step = ARROW_STEPS[e.key]
    if (step) {
      e.preventDefault()
      setSelected(i => Math.max(0, Math.min(i + step, shown.length - 1)))
    } else if (e.key === 'Enter') choose(shown[selected])
    else if (e.key === 'Escape') close()
  }

  return (
    <Overlay close={close}>
      <input
        autoFocus
        value={query}
        placeholder="Command or writer"
        onKeyDown={onKeyDown}
        onChange={e => {
          setQuery(e.target.value)
          setSelected(0)
        }}
      />
      {shown.map((entry, i) => (
        <div
          key={actionId(entry)}
          className={`row${i === selected ? ' sel' : ''}${entry.disabled ? ' off' : ''}`}
          onPointerEnter={() => setSelected(i)}
          onClick={() => choose(entry)}
        >
          <span>{entry.name}</span>
          <span className="muted">{entry.key ?? entry.kind}</span>
        </div>
      ))}
    </Overlay>
  )
}

/** The stack the palette would act on, and every binding of the next key pressed, in priority order. */
function KeyContext({
  bindingsByKey,
  stack,
  close,
}: {
  bindingsByKey: Map<string, Binding[]>
  stack: SlotFrame[]
  close(): void
}) {
  const [key, setKey] = useState('')

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.key === 'Escape') close()
      else if (!MODIFIER_KEYS.has(e.key)) setKey(eventKey(e))
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [close])

  const hits = key ? matchBindings(bindingsByKey.get(key) ?? [], stack) : []
  const winner = firesFirst(hits)

  return (
    <Overlay close={close}>
      <div>{stack.map(frame => `card:${frame.card}`).join(' > ') || 'No focused card'}</div>
      {stack.map((frame, i) => (
        <div key={i} className="muted" style={{ paddingLeft: i * 12 }}>
          card:{frame.card} {JSON.stringify({ size: frame.size, focused: i === stack.length - 1, ...frame.vars })}
        </div>
      ))}
      <p>{key ? `${key}${hits.length ? '' : ': no binding'}` : 'Press a key (Esc closes)'}</p>
      {hits.map((hit, i) => {
        const action = bindingAction(hit.binding)
        return (
          <div key={i} className={`row${hit === winner ? ' sel' : hit.missing.length ? ' off' : ''}`}>
            <span>{hit.depth < 0 ? 'global' : `at card:${stack[hit.depth].card}`}</span>
            <span>{hit.binding.context}</span>
            <span>{!action ? 'unbound' : action.kind === 'write' ? `write ${action.name}` : action.name}</span>
            <span className="muted">
              {hit.missing.length ? `missing ${hit.missing.join(', ')}` : JSON.stringify(hit.args)}
            </span>
          </div>
        )
      })}
    </Overlay>
  )
}
