import { invoke } from '@tauri-apps/api/core'
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
  /** Seconds another device waits for the desktop before answering from its cache and opening the stream again. */
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
  /** Another device's connection came back: its subscriptions and cards are gone on the desktop and are opened again. */
  reconnect: null
}
/** Rejects with an `Error`. */
export type Backend = {
  invoke<C extends keyof Commands>(command: C, args: Commands[C]['args']): Promise<Commands[C]['result']>
  listen<E extends keyof Events>(event: E, handler: (payload: Events[E]) => void): void
}

export const toError = (thrown: unknown) => (thrown instanceof Error ? thrown : new Error(String(thrown)))

const tauri: Backend = {
  invoke: (command, args) =>
    invoke<Commands[typeof command]['result']>('call', { command, args }).catch(thrown => {
      throw toError(thrown)
    }),
  listen: (event, handler) => void listen<Events[typeof event]>(event, e => handler(e.payload)),
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
