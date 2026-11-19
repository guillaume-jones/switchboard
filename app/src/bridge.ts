import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import * as remote from './remote'

export type Row = Record<string, any>
export type Params = Record<string, unknown>
export type Size = 'compact' | 'full'
export type Binding = { key: string; context?: string; command?: string | null; write?: string | null; args?: Params }
export type Config = {
  root: string
  depth_cap: number
  /** Seconds a run queued on another device while offline stays sendable, by default and per command (0: never queued). */
  queue_run_expiry: number
  queue_expiry: Record<string, number>
  /** Seconds another device shows as reconnecting after losing the desktop, before offline. */
  reconnect_timeout: number
  /** Seconds another device waits for a stream to say hello before opening another alongside it. */
  connect_timeout: number
  sources: Record<string, { item_card?: string | null }>
  cards: string[]
  commands: string[]
  writers: string[]
  keymap: Binding[]
  errors: { path: string; message: string }[]
}
/** Module id (`Root.tsx`, `lib/format.ts`) to code compiled into Vite's module-runner format. */
export type CardModules = Record<string, string>

type NoArgs = Record<string, never>
export type Commands = {
  config: { args: NoArgs; result: Config }
  card: { args: { name: string }; result: CardModules }
  subscribe: { args: { name: string; params: Params }; result: { id: number; rows: Row[] } }
  unsubscribe: { args: { id: number }; result: null }
  mutate: { args: { name: string; params: Params }; result: { changes: number } }
  /** `id`, chosen by a device queuing the run while offline, makes sending it twice start it once. */
  run: { args: { name: string; args: Params; id?: string }; result: { run_id: string } }
  revert_last_commit: { args: NoArgs; result: null }
  report_error: { args: { card: string; message: string; stack: string }; result: null }
}
export type Events = {
  rows: { id: number; rows: Row[] }
  config: null
  card: { name: string }
  /** Another device caught up with the desktop: everything that changed meanwhile, to apply together. */
  resync: { config?: Config; cards: Record<string, CardModules>; rows: { id: number; rows: Row[] }[] }
}
export type PtyHandlers = {
  open?: () => void
  data: (bytes: Uint8Array) => void
  /** Once, when the terminal closes; with an error if it never opened. */
  close: (error?: Error) => void
}
export type PtyHandle = {
  write: (text: string) => void
  resize: (cols: number, rows: number) => void
  close: () => void
}
/** Rejects with an `Error`. */
export type Backend = {
  /** Attaches to a `pty` run's terminal. */
  pty(run: string, on: PtyHandlers): PtyHandle
  invoke<C extends keyof Commands>(command: C, args: Commands[C]['args']): Promise<Commands[C]['result']>
  /** A handler's promise holds back the events after it, on another device. */
  listen<E extends keyof Events>(event: E, handler: (payload: Events[E]) => unknown): void
}

export const toError = (thrown: unknown) => (thrown instanceof Error ? thrown : new Error(String(thrown)))

const tauri: Backend = {
  invoke: (command, args) =>
    invoke<Commands[typeof command]['result']>('call', { command, args }).catch(thrown => {
      throw toError(thrown)
    }),
  listen: (event, handler) => void listen<Events[typeof event]>(event, e => handler(e.payload)),
  pty: (run, on) => {
    let id: number | undefined
    let closed = false
    const end = (error?: Error) => {
      if (closed) return
      closed = true
      on.close(error)
    }
    const output = new Channel<ArrayBuffer>()
    output.onmessage = buffer => (buffer.byteLength ? on.data(new Uint8Array(buffer)) : end())
    invoke<number>('pty_open', { run, output }).then(
      opened => {
        if (closed) return void invoke('pty_close', { id: opened })
        id = opened
        on.open?.()
      },
      thrown => end(toError(thrown)),
    )
    const send = (command: string, args: Record<string, unknown>) => {
      if (id !== undefined && !closed) invoke(command, { id, ...args }).catch(() => end())
    }
    return {
      write: data => send('pty_input', { data }),
      resize: (cols, rows) => send('pty_resize', { cols, rows }),
      close: () => {
        if (id !== undefined && !closed) void invoke('pty_close', { id })
        closed = true
      },
    }
  },
}

const inWindow = '__TAURI_INTERNALS__' in globalThis
/** Another device served by the desktop over Tailscale, rather than the Tauri window or the mock in `vite` dev. */
export const isRemote = !inWindow && !import.meta.env.DEV

async function connect(): Promise<Backend> {
  if (inWindow) return tauri
  if (import.meta.env.DEV) return (await import('./mock')).default
  return remote.connect()
}

const backend = await connect()

export const config = () => backend.invoke('config', {})
export const card = (name: string) => backend.invoke('card', { name })
export const subscribe = (name: string, params: Params) => backend.invoke('subscribe', { name, params })
export const unsubscribe = (id: number) => backend.invoke('unsubscribe', { id })
export const mutate = (name: string, params: Params) => backend.invoke('mutate', { name, params })
export const run = (name: string, args: Params) => backend.invoke('run', { name, args })
export const revertLastCommit = () => backend.invoke('revert_last_commit', {})
export const reportError = (card: string, message: string, stack: string) =>
  backend.invoke('report_error', { card, message, stack })
export const on: Backend['listen'] = (event, handler) => backend.listen(event, handler)
export const pty: Backend['pty'] = (run, on) => backend.pty(run, on)
