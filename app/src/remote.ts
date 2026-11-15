// The backend on another device (a phone, a browser tab), served by the desktop over Tailscale. Every response is
// kept in IndexedDB so the board opens offline as of its last contact, and writes and runs made offline wait in an
// outbox until the desktop is reachable again.
import { useSyncExternalStore } from 'react'
import type { Backend, Commands, Config, Events, Params, Row } from './bridge'

export type Queued = {
  id: string
  command: 'mutate' | 'run'
  name: string
  params: Params
  at: number
  /** Why it was not sent: kept until dismissed. */
  error?: string
}
export type Status = { online: boolean; asOf: number | undefined; outbox: Queued[] }

/** The desktop is unreachable, or the app on it is not running. */
class Offline extends Error {}

const CLIENT_HEADER = 'switchboard-client'
const RETRY_MS = 5000
const HELLO_WAIT_MS = 3000
const AS_OF_KEY = 'switchboard.as_of'

let status: Status = { online: false, asOf: Number(localStorage.getItem(AS_OF_KEY)) || undefined, outbox: [] }
const statusListeners = new Set<() => void>()

function setStatus(next: Partial<Status>) {
  status = { ...status, ...next }
  for (const listener of statusListeners) listener()
}

function contact() {
  const now = Date.now()
  localStorage.setItem(AS_OF_KEY, String(now))
  if (!status.online || now - (status.asOf ?? 0) > 1000) setStatus({ online: true, asOf: now })
}

export const useRemoteStatus = () =>
  useSyncExternalStore(
    listener => {
      statusListeners.add(listener)
      return () => void statusListeners.delete(listener)
    },
    () => status,
  )

let database: Promise<IDBDatabase> | undefined

const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('switchboard', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('cache')
      request.result.createObjectStore('outbox', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

async function store<T>(name: 'cache' | 'outbox', use: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const transaction = (await (database ??= openDatabase())).transaction(name, 'readwrite')
  const request = use(transaction.objectStore(name))
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(request.result)
    transaction.onerror = () => reject(transaction.error)
  })
}

const cached = <T>(key: string) => store<T | undefined>('cache', s => s.get(key))
const keep = (key: string, value: unknown) => store('cache', s => s.put(value, key)).catch(() => {})

async function loadOutbox() {
  const items = await store<Queued[]>('outbox', s => s.getAll())
  setStatus({ outbox: items.sort((a, b) => a.at - b.at) })
}

/** The open stream's id, which subscriptions belong to; empty while disconnected. */
let client = ''
let connected: Promise<void>
let current: EventSource | undefined
/** Something was answered from the cache, or the desktop dropped this client's subscriptions with its last stream. */
let stale = false

async function post(command: string, args: unknown) {
  let response: Response
  try {
    response = await fetch(`/api/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLIENT_HEADER]: client },
      body: JSON.stringify(args),
    })
  } catch {
    throw new Offline('the desktop is unreachable')
  }
  if (response.status >= 502 && response.status <= 504) throw new Offline('Switchboard is not running on the desktop')
  if (response.status === 403) throw new Error('this device is not allowed to reach the desktop')
  const body = await response.json()
  if (!response.ok) throw new Error(body.error)
  contact()
  return body
}

function offline(error: unknown) {
  if (!(error instanceof Offline)) throw error
  stale = true
  setStatus({ online: false })
  return error
}

async function expirySeconds(name: string) {
  const config = await cached<Config>('config')
  return config?.queue_expiry[name] ?? config?.queue_run_expiry ?? 3600
}

async function queue(command: Queued['command'], name: string, params: Params) {
  if (command === 'run' && (await expirySeconds(name)) === 0) throw new Error(`${name} cannot be queued while offline`)
  const item: Queued = { id: crypto.randomUUID(), command, name, params, at: Date.now() }
  await store('outbox', s => s.put(item))
  await loadOutbox()
  return item
}

const send = (item: Queued) =>
  post(
    item.command,
    item.command === 'run'
      ? { name: item.name, args: item.params, id: item.id }
      : { name: item.name, params: item.params },
  )

let flushing: Promise<void> | undefined

/** Sends the outbox in order, until the desktop stops answering. Writes never expire; runs do. */
function flush() {
  flushing ??= (async () => {
    for (const item of status.outbox.filter(item => !item.error)) {
      let error: string | undefined
      if (item.command === 'run' && Date.now() - item.at > (await expirySeconds(item.name)) * 1000) error = 'expired'
      else {
        try {
          await send(item)
        } catch (thrown) {
          if (thrown instanceof Offline) break
          error = thrown instanceof Error ? thrown.message : String(thrown)
        }
      }
      if (error) await store('outbox', s => s.put({ ...item, error }))
      else await store('outbox', s => s.delete(item.id))
      await loadOutbox()
    }
  })().finally(() => (flushing = undefined))
  return flushing
}

export const cancel = async (id: string) => {
  await store('outbox', s => s.delete(id))
  await loadOutbox()
}

const listeners = new Map<keyof Events, Set<(payload: any) => void>>()
function emit<E extends keyof Events>(event: E, payload: Events[E]) {
  for (const listener of listeners.get(event) ?? []) listener(payload)
}

/** Subscription id → its cache key, so pushed rows replace the cached ones. */
const rowKeys = new Map<number, string>()
let offlineIds = 0

function open() {
  let hello: () => void
  connected = new Promise(resolve => (hello = resolve))
  const source = new EventSource('/api/events')
  source.addEventListener('hello', async event => {
    client = JSON.parse(event.data).client
    contact()
    hello()
    await flush()
    if (stale) emit('reconnect', null)
    stale = true
  })
  for (const name of ['rows', 'config', 'card'] as const) {
    source.addEventListener(name, event => {
      const payload = JSON.parse(event.data)
      if (name === 'rows' && rowKeys.has(payload.id)) keep(rowKeys.get(payload.id)!, payload.rows)
      emit(name, payload)
    })
  }
  source.onerror = () => {
    client = ''
    setStatus({ online: false })
    if (source.readyState === EventSource.CLOSED) setTimeout(reopen, RETRY_MS)
  }
  current = source
}

function reopen() {
  if (current?.readyState !== EventSource.CLOSED || document.visibilityState !== 'visible') return
  open()
}

/** Waits briefly for the stream's client id, so subscriptions belong to it; offline, answers from the cache. */
const ready = () => Promise.race([connected, new Promise(resolve => setTimeout(resolve, HELLO_WAIT_MS))])

const handlers: { [C in keyof Commands]: (args: Commands[C]['args']) => Promise<Commands[C]['result']> } = {
  config: async () => {
    try {
      const config = await post('config', {})
      keep('config', config)
      return config
    } catch (error) {
      const config = await cached<Config>('config')
      if (!config) throw offline(error)
      offline(error)
      return config
    }
  },
  card: async ({ name }) => {
    try {
      const modules = await post('card', { name })
      keep(`card:${name}`, modules)
      return modules
    } catch (error) {
      const modules = await cached<Commands['card']['result']>(`card:${name}`)
      if (!modules) throw offline(error)
      offline(error)
      return modules
    }
  },
  subscribe: async ({ name, params }) => {
    const key = `rows:${name}${JSON.stringify(params)}`
    await ready()
    try {
      if (!client) throw new Offline('not connected')
      const reply = await post('subscribe', { name, params })
      rowKeys.set(reply.id, key)
      keep(key, reply.rows)
      return reply
    } catch (error) {
      offline(error)
      return { id: -++offlineIds, rows: (await cached<Row[]>(key)) as Row[] }
    }
  },
  unsubscribe: async ({ id }) => {
    rowKeys.delete(id)
    if (id >= 0) await post('unsubscribe', { id }).catch(() => {})
    return null
  },
  mutate: async ({ name, params }) => {
    try {
      return await post('mutate', { name, params })
    } catch (error) {
      offline(error)
      await queue('mutate', name, params)
      return { changes: 0 }
    }
  },
  run: async ({ name, args }) => {
    try {
      return await post('run', { name, args })
    } catch (error) {
      offline(error)
      return { run_id: (await queue('run', name, args)).id }
    }
  },
  revert_last_commit: () => post('revert_last_commit', {}),
  report_error: args => post('report_error', args).catch(() => null),
}

export function connect(): Backend {
  open()
  loadOutbox()
  navigator.serviceWorker?.register('/sw.js')
  navigator.storage?.persist?.()
  const wake = () => {
    if (document.visibilityState !== 'visible') return
    reopen()
    if (status.online) flush()
  }
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('online', wake)
  return {
    invoke: (command, args) => (handlers[command] as (args: unknown) => Promise<never>)(args),
    listen: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    },
  }
}
