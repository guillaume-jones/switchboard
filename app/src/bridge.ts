import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export type Row = Record<string, any>
export type Params = Record<string, unknown>
export type Size = 'compact' | 'full'
export type Binding = { key: string; context?: string; command?: string | null; write?: string | null; args?: Params }
export type Config = {
  root: string
  depth_cap: number
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
  run: { args: { name: string; args: Params }; result: { run_id: string } }
  revert_last_commit: { args: NoArgs; result: null }
  report_error: { args: { card: string; message: string; stack: string }; result: null }
}
export type Events = {
  rows: { id: number; rows: Row[] }
  config: null
  card: { name: string }
}
/** Rejects with an `Error`. */
export type Backend = {
  invoke<C extends keyof Commands>(command: C, args: Commands[C]['args']): Promise<Commands[C]['result']>
  listen<E extends keyof Events>(event: E, handler: (payload: Events[E]) => void): void
}

export const toError = (thrown: unknown) => (thrown instanceof Error ? thrown : new Error(String(thrown)))

const tauri: Backend = {
  invoke: (command, args) =>
    invoke<Commands[typeof command]['result']>(command, args).catch(thrown => {
      throw toError(thrown)
    }),
  listen: (event, handler) => void listen<Events[typeof event]>(event, e => handler(e.payload)),
}

async function connect(): Promise<Backend> {
  if ('__TAURI_INTERNALS__' in globalThis) return tauri
  if (import.meta.env.DEV) return (await import('./mock')).default
  throw new Error('Switchboard must run inside its Tauri window')
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
