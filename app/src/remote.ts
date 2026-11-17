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
export type Status = {
  /** `reconnecting` while the stream is down for less than RECONNECT_MS; reads answer from the cache meanwhile. */
  connection: 'online' | 'reconnecting' | 'offline'
  /** The desktop's last contact. */
  asOf: number | undefined
  outbox: Queued[]
  /** `off` until the user enables notifications; push is only offered by home-screen apps. */
  push: 'unavailable' | 'off' | 'on'
}

/** The desktop is unreachable, or the app on it is not running. */
class Offline extends Error {}
/** A read the desktop did not answer in time, or answered for a stream already replaced: the stream stays as it is. */
class Unanswered extends Offline {}

const CLIENT_HEADER = 'switchboard-client'
const NO_STREAM = 'no open event stream for this client'
const HELLO_WAIT_MS = 3000
/** The desktop pings every 10s; a stream silent for longer is dead, as after the phone sleeps or its VPN reconnects. */
const STREAM_SILENT_MS = 15000
const RECONNECT_MS = 15000
const AS_OF_KEY = 'switchboard.as_of'

let status: Status = {
  connection: 'online',
  asOf: Number(localStorage.getItem(AS_OF_KEY)) || undefined,
  outbox: [],
  push: 'unavailable',
}
const statusListeners = new Set<() => void>()

function setStatus(next: Partial<Status>) {
  status = { ...status, ...next }
  for (const listener of statusListeners) listener()
}

let lastContact = status.asOf ?? 0
let streamAt = 0
let openedAt = 0
/** When the stream was lost, or the app was opened or woken without one. */
let lostAt = Date.now()

function contact() {
  lastContact = Date.now()
  localStorage.setItem(AS_OF_KEY, String(lastContact))
}

function setConnection(connection: Status['connection']) {
  if (status.connection !== connection) setStatus({ connection, asOf: lastContact || undefined })
}

/** Replaces the stream; the app shows as reconnecting only if the new one does not say hello in HELLO_WAIT_MS. */
function lose() {
  if (!client) return
  client = ''
  lostAt = Date.now()
  restart()
}

/**
 * While visible, a dead stream is replaced at once, and one that has not said hello is opened again every
 * HELLO_WAIT_MS: a connection made while the network was not up yet can hang long after a new one would succeed.
 */
function check() {
  if (document.visibilityState !== 'visible') return
  const now = Date.now()
  if (client) {
    if (now - streamAt < STREAM_SILENT_MS) return
    return lose()
  }
  if (now - openedAt < HELLO_WAIT_MS) return
  setConnection(!navigator.onLine || now - lostAt >= RECONNECT_MS ? 'offline' : 'reconnecting')
  restart()
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
let hello: (() => void) | undefined
let current: EventSource | undefined
/** Something was answered from the cache, or the desktop dropped this client's subscriptions with its last stream. */
let stale = false

/** Reads that can be answered from the cache give up after `timeout` ms, so a hanging network does not block them. */
async function post(command: string, args: unknown, timeout?: number) {
  if (timeout && status.connection === 'offline') throw new Offline('offline')
  let response: Response
  try {
    response = await fetch(`/api/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLIENT_HEADER]: client },
      body: JSON.stringify(args),
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new Unanswered('timed out')
    throw new Offline('the desktop is unreachable')
  }
  if (response.status >= 502 && response.status <= 504) throw new Offline('Switchboard is not running on the desktop')
  if (response.status === 403) throw new Error('this device is not allowed to reach the desktop')
  const body = await response.json()
  if (!response.ok) throw new (body.error === NO_STREAM ? Unanswered : Error)(body.error)
  contact()
  return body
}

function offline(error: unknown) {
  if (!(error instanceof Offline)) throw error
  stale = true
  if (!(error instanceof Unanswered)) lose()
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

const pushAvailable = () =>
  matchMedia('(display-mode: standalone)').matches &&
  'PushManager' in window &&
  'Notification' in window &&
  'serviceWorker' in navigator

/** Sends this device's push subscription again, so the desktop's list survives it being reset. */
async function syncPush() {
  if (!pushAvailable() || Notification.permission === 'denied') return setStatus({ push: 'unavailable' })
  const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
  if (!subscription || Notification.permission !== 'granted') return setStatus({ push: 'off' })
  await post('push_subscribe', subscription.toJSON()).catch(() => {})
  setStatus({ push: 'on' })
}

/** Must run from a tap: iOS only asks for permission in response to one. */
export async function enableNotifications() {
  if ((await Notification.requestPermission()) !== 'granted') return setStatus({ push: 'unavailable' })
  const { key } = await post('push_key', {})
  const applicationServerKey = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
  await post('push_subscribe', subscription.toJSON())
  setStatus({ push: 'on' })
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
  if (!hello) connected = new Promise(resolve => (hello = resolve))
  openedAt = Date.now()
  const source = new EventSource('/api/events')
  source.addEventListener('hello', async event => {
    client = JSON.parse(event.data).client
    streamAt = Date.now()
    contact()
    setConnection('online')
    hello?.()
    hello = undefined
    syncPush()
    await flush()
    if (stale) emit('reconnect', null)
    stale = true
  })
  source.addEventListener('ping', () => {
    streamAt = Date.now()
    contact()
  })
  for (const name of ['rows', 'config', 'card'] as const) {
    source.addEventListener(name, event => {
      streamAt = Date.now()
      const payload = JSON.parse(event.data)
      if (name === 'rows' && rowKeys.has(payload.id)) keep(rowKeys.get(payload.id)!, payload.rows)
      emit(name, payload)
    })
  }
  source.onerror = lose
  current = source
}

function restart() {
  current?.close()
  if (document.visibilityState === 'visible') open()
}

/** With a live stream, reads wait for the desktop: a dead stream is replaced on ping silence, which reloads them. */
const readTimeout = () => (client ? undefined : HELLO_WAIT_MS)

/** Waits briefly for the stream's client id, so subscriptions belong to it; offline, answers from the cache. */
const ready = () => Promise.race([connected, new Promise(resolve => setTimeout(resolve, HELLO_WAIT_MS))])

const handlers: { [C in keyof Commands]: (args: Commands[C]['args']) => Promise<Commands[C]['result']> } = {
  config: async () => {
    try {
      const config = await post('config', {}, readTimeout())
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
      const modules = await post('card', { name }, readTimeout())
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
    if (status.connection !== 'offline') await ready()
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
  let hiddenAt = 0
  const wake = () => {
    if (document.visibilityState !== 'visible') return void (hiddenAt = Date.now())
    if (client && Date.now() - hiddenAt >= HELLO_WAIT_MS) lose()
    else if (!client) {
      lostAt = Date.now()
      openedAt = 0
    }
    check()
    if (status.connection === 'online') flush()
  }
  setInterval(check, HELLO_WAIT_MS)
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
