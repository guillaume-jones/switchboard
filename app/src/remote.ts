// The backend on another device (a phone, a browser tab), served by the desktop over Tailscale. Every config, card and
// rows response is kept in IndexedDB with the desktop's digest of it, so the board opens at once as of its last
// contact, and a new stream catches up in one `resync`: the desktop answers with only what changed, applied together.
// Writes and runs made offline wait in an outbox until the desktop is reachable again.
import { useSyncExternalStore } from 'react'
import type { Backend, CardModules, Commands, Config, Events, Params, Row } from './bridge'

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
  /** `reconnecting` until a stream has caught up, for less than the `reconnect_timeout` setting; reads answer from the cache meanwhile. */
  connection: 'online' | 'reconnecting' | 'offline'
  /** The desktop's last contact. */
  asOf: number | undefined
  outbox: Queued[]
  /** `off` until the user enables notifications; push is only offered by home-screen apps. */
  push: 'unavailable' | 'off' | 'on'
}

/** The desktop is unreachable, or the app on it is not running. */
class Offline extends Error {}

const CLIENT_HEADER = 'switchboard-client'
const NO_STREAM = 'no open event stream for this client'
/** The desktop pings every 10s; a stream silent for longer is dead, as after the phone sleeps or its VPN reconnects. */
const STREAM_SILENT_MS = 15000
/** Streams opened alongside each other while none has said hello; the oldest gives way to a new one. */
const MAX_ATTEMPTS = 3
/** An attempt refused at once, as while the VPN is still down, is tried again this soon. */
const REFUSED_RETRY_MS = 1000
const RESYNC_TIMEOUT_MS = 10000
/** A gap this long between the 1 s checks means the app was suspended, which iOS does not always report. */
const SUSPENDED_MS = 5000
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

function contact() {
  lastContact = Date.now()
  localStorage.setItem(AS_OF_KEY, String(lastContact))
}

function setConnection(connection: Status['connection']) {
  if (status.connection !== connection) setStatus({ connection, asOf: lastContact || undefined })
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

/** Version 2 keeps digests with the cache, so older entries are dropped. */
const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('switchboard', 2)
    request.onupgradeneeded = event => {
      if (event.oldVersion < 1) {
        request.result.createObjectStore('cache')
        request.result.createObjectStore('outbox', { keyPath: 'id' })
      } else request.transaction!.objectStore('cache').clear()
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

type CachedConfig = { hash: string; config: Config }
type CachedCard = { name: string; hash: string; modules: CardModules }
type CachedRows = { hash: string; rows: Row[] }

const cached = <T>(key: string) => store<T | undefined>('cache', s => s.get(key)).catch(() => undefined)
const keep = (key: string, value: unknown) => store('cache', s => s.put(value, key)).catch(() => {})

async function loadOutbox() {
  const items = await store<Queued[]>('outbox', s => s.getAll())
  setStatus({ outbox: items.sort((a, b) => a.at - b.at) })
}

/** The digests of the cached config and cards, which a resync sends so that the desktop skips them. */
let configHash: string | undefined
const cardHashes: Record<string, string> = {}
const hydrated = (async () => {
  configHash = (await cached<CachedConfig>('config'))?.hash
  const cards = await store<CachedCard[]>('cache', s => s.getAll(IDBKeyRange.bound('card:', 'card:￿'))).catch(() => [])
  for (const card of cards) cardHashes[card.name] = card.hash
})()

let caughtUp: () => void
/** Resolves once the first stream has caught up, for reads the cache cannot answer. */
const firstSync = new Promise<void>(resolve => (caughtUp = resolve))

type Sub = { name: string; params: Params; key: string; hash?: string; server?: number }
type Waiting = { resolve(rows: Row[]): void; reject(error: Error): void }
/** Subscriptions by the id given to the shell, which stays the same across streams. */
const subs = new Map<number, Sub>()
/** The current stream's subscription ids to the shell's. */
const byServer = new Map<number, number>()
/** Opened since the last resync, to send with the next. */
const unsent = new Set<number>()
/** Subscriptions with no cached rows, answered by the desktop. */
const waiting = new Map<number, Waiting>()
let subIds = 0

type Stream = { controller: AbortController }
let live: Stream | undefined
/** Streams that have not said hello yet. */
const attempts = new Set<Stream>()
/** The live stream's id, which subscriptions belong to; empty while disconnected. */
let client = ''
/** The live stream has caught up. */
let synced = false
/** Returned to the foreground with a live stream that may have died meanwhile: a new one is opened alongside. */
let replacing = false
let streamAt = 0
/** When the stream was lost, or the app was opened or woken: `reconnect_timeout` counts from here. */
let lostAt = Date.now()
let reconnectMs = 10000
let connectMs = 3000
let nextAttemptAt = 0

/** One line per catch-up in the desktop's `data/remote.log`, in ms from the wake or launch. */
let timings: { cause: string; at: number; phases: [string, number][] } = { cause: 'launch', at: Date.now(), phases: [] }
const phase = (name: string) => timings.phases.push([name, Date.now() - timings.at])

async function post(command: string, args: unknown, timeout?: number) {
  let response: Response
  try {
    response = await fetch(`/api/${command}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLIENT_HEADER]: client },
      body: JSON.stringify(args),
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    })
  } catch {
    throw new Offline('the desktop is unreachable')
  }
  if (response.status >= 502 && response.status <= 504) throw new Offline('Switchboard is not running on the desktop')
  if (response.status === 403) throw new Error('this device is not allowed to reach the desktop')
  const body = await response.json()
  if (!response.ok) throw new (body.error === NO_STREAM ? Offline : Error)(body.error)
  contact()
  return body
}

/** A failed request means the stream is likely dead too. */
function offline(error: unknown) {
  if (!(error instanceof Offline)) throw error
  if (live) end(live)
}

async function expirySeconds(name: string) {
  const config = (await cached<CachedConfig>('config'))?.config
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

const listeners = new Map<keyof Events, Set<(payload: any) => unknown>>()
function emit<E extends keyof Events>(event: E, payload: Events[E]) {
  return Promise.all([...(listeners.get(event) ?? [])].map(listener => listener(payload)))
}

/** Pushed rows wait for a resync being applied, so they are never overwritten by the older rows it carries. */
let applied: Promise<unknown> = Promise.resolve()
const afterApplied = (apply: () => unknown) => (applied = applied.then(apply).catch(() => {}))

type ResyncReply = {
  config: Config | null
  config_hash: string
  cards: Record<string, { hash: string; modules: CardModules }>
  subs: { local: number; id?: number; hash?: string; rows?: Row[] | null; error?: string }[]
}

let resyncTimer: ReturnType<typeof setTimeout> | undefined
let resyncing = false
let resyncAgain = false

/** Batches the subscriptions opened and the cards and config changed within a task into one resync. */
function requestResync() {
  if (!client) return
  if (!synced || resyncing) return void (resyncAgain = true)
  resyncTimer ??= setTimeout(() => {
    resyncTimer = undefined
    resync()
  })
}

/** After a new hello, `previous` is the replaced client, and every subscription is opened again. */
async function resync(previous?: string) {
  const full = previous !== undefined
  if (!full && (resyncing || !synced)) return void (resyncAgain = true)
  resyncing = true
  resyncAgain = false
  const stream = live
  const ids = full ? [...subs.keys()] : [...unsent]
  ids.forEach(id => unsent.delete(id))
  await hydrated
  const manifest = {
    previous: previous || undefined,
    config: configHash,
    cards: cardHashes,
    subs: ids.flatMap(local => {
      const sub = subs.get(local)
      return sub ? [{ local, name: sub.name, params: sub.params, hash: sub.hash }] : []
    }),
  }
  try {
    const reply: ResyncReply = await post('resync', manifest, RESYNC_TIMEOUT_MS)
    if (stream === live) await apply(reply)
  } catch (error) {
    if (stream === live) ids.forEach(id => unsent.add(id))
    if (error instanceof Offline) offline(error)
    else post('report_error', { card: 'resync', message: String(error), stack: '' }).catch(() => {})
  }
  if (stream !== live) return
  resyncing = false
  if (full) {
    synced = true
    phase('synced')
    post('log', timings).catch(() => {})
    caughtUp()
    check()
  }
  if (resyncAgain || unsent.size) requestResync()
}

function apply(reply: ResyncReply) {
  const changes: Events['resync'] = { cards: {}, rows: [] }
  configHash = reply.config_hash
  if (reply.config) {
    keep('config', { hash: reply.config_hash, config: reply.config })
    applyTimeouts(reply.config)
    changes.config = reply.config
  }
  for (const [name, { hash, modules }] of Object.entries(reply.cards)) {
    keep(`card:${name}`, { name, hash, modules })
    cardHashes[name] = hash
    changes.cards[name] = modules
  }
  for (const { local, id, hash, rows, error } of reply.subs) {
    const sub = subs.get(local)
    if (!sub) {
      if (id !== undefined) post('unsubscribe', { id }).catch(() => {})
      continue
    }
    const wait = waiting.get(local)
    waiting.delete(local)
    if (error !== undefined) {
      wait?.reject(new Error(error))
      continue
    }
    sub.server = id
    byServer.set(id!, local)
    if (!rows) continue
    sub.hash = hash
    keep(sub.key, { hash, rows })
    if (wait) wait.resolve(rows)
    else changes.rows.push({ id: local, rows })
  }
  timings.phases.push([
    `changed config:${Number(!!reply.config)} cards:${Object.keys(changes.cards).length} rows:${changes.rows.length}`,
    Date.now() - timings.at,
  ])
  if (changes.config || changes.rows.length || Object.keys(changes.cards).length)
    return afterApplied(() => emit('resync', changes))
}

function pushed({ id, rows, hash }: { id: number; rows: Row[]; hash: string }) {
  const local = byServer.get(id)
  const sub = local === undefined ? undefined : subs.get(local)
  if (!sub) return
  sub.hash = hash
  keep(sub.key, { hash, rows })
  afterApplied(() => emit('rows', { id: local!, rows }))
}

/** Reads the stream's server-sent events, until it ends or is aborted. */
async function open() {
  if (attempts.size >= MAX_ATTEMPTS) {
    const [oldest] = attempts
    attempts.delete(oldest)
    oldest.controller.abort()
  }
  const stream: Stream = { controller: new AbortController() }
  attempts.add(stream)
  phase('attempt')
  try {
    const response = await fetch('/api/events', { signal: stream.controller.signal, cache: 'no-store' })
    if (!response.ok || !response.body) throw new Offline(`stream refused: ${response.status}`)
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        let event = 'message'
        const data: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        }
        receive(stream, event, data.join('\n'))
      }
    }
  } catch {}
  end(stream)
}

function receive(stream: Stream, event: string, data: string) {
  if (event === 'hello') return hello(stream, JSON.parse(data).client)
  if (stream !== live) return
  streamAt = Date.now()
  contact()
  if (event === 'rows') pushed(JSON.parse(data))
  else if (event === 'config' || event === 'card') requestResync()
}

/** The first stream to say hello replaces the live one and every other attempt, and catches up. */
async function hello(stream: Stream, id: string) {
  if (!attempts.delete(stream)) return stream.controller.abort()
  for (const other of attempts) other.controller.abort()
  attempts.clear()
  live?.controller.abort()
  const previous = client
  live = stream
  client = id
  synced = false
  replacing = false
  streamAt = Date.now()
  contact()
  phase('hello')
  byServer.clear()
  for (const sub of subs.values()) sub.server = undefined
  syncPush()
  await flush()
  if (stream === live) resync(previous)
}

/** Ends a stream; losing the live one shows the app as reconnecting and opens another at once. */
function end(stream: Stream) {
  const refused = !stream.controller.signal.aborted && attempts.delete(stream)
  stream.controller.abort()
  if (refused && !attempts.size) nextAttemptAt = Math.min(nextAttemptAt, Date.now() + REFUSED_RETRY_MS)
  if (stream !== live) return
  live = undefined
  client = ''
  synced = false
  lostAt = Date.now()
  nextAttemptAt = 0
  timings = { cause: 'lost', at: lostAt, phases: [] }
  check()
}

let lastCheck = Date.now()

/**
 * While visible, opens a stream when there is none or the live one may be dead, then another every
 * `connect_timeout` until one says hello. Attempts are never cut short: a slow connection may still succeed, while
 * one made before the network was up can hang for good, so the oldest only gives way to a new one past three.
 */
function check() {
  const now = Date.now()
  const suspended = now - lastCheck > SUSPENDED_MS
  lastCheck = now
  if (document.visibilityState !== 'visible') return
  if (suspended) return wake('suspended')
  if (live && now - streamAt > STREAM_SILENT_MS) return end(live)
  if ((!live || replacing) && now >= nextAttemptAt) {
    nextAttemptAt = now + connectMs
    open()
  }
  if (live && synced && !replacing) setConnection('online')
  else setConnection(!navigator.onLine || now - lostAt >= reconnectMs ? 'offline' : 'reconnecting')
}

function wake(cause: string) {
  lostAt = Date.now()
  replacing = !!live
  nextAttemptAt = 0
  timings = { cause, at: lostAt, phases: [] }
  check()
}

function applyTimeouts(config: Config) {
  reconnectMs = (config.reconnect_timeout ?? 10) * 1000
  connectMs = (config.connect_timeout ?? 3) * 1000
}

/** Answers from the cache, or once the first stream has caught up if it holds nothing yet. */
async function fromCache<T>(key: string): Promise<T | undefined> {
  const hit = await cached<T>(key)
  if (hit) return hit
  await firstSync
  return cached<T>(key)
}

const handlers: { [C in keyof Commands]: (args: Commands[C]['args']) => Promise<Commands[C]['result']> } = {
  config: async () => {
    const entry = await fromCache<CachedConfig>('config')
    if (!entry) throw new Error('the desktop sent no config')
    applyTimeouts(entry.config)
    return entry.config
  },
  card: async ({ name }) => {
    const entry = await fromCache<CachedCard>(`card:${name}`)
    if (!entry) throw new Error(`no card named ${name}`)
    return entry.modules
  },
  subscribe: async ({ name, params }) => {
    const id = ++subIds
    const key = `rows:${name}${JSON.stringify(params)}`
    const entry = await cached<CachedRows>(key)
    subs.set(id, { name, params, key, hash: entry?.hash })
    unsent.add(id)
    requestResync()
    if (entry) return { id, rows: entry.rows }
    return { id, rows: await new Promise<Row[]>((resolve, reject) => waiting.set(id, { resolve, reject })) }
  },
  unsubscribe: async ({ id }) => {
    const sub = subs.get(id)
    subs.delete(id)
    unsent.delete(id)
    waiting.delete(id)
    if (sub?.server === undefined) return null
    byServer.delete(sub.server)
    if (client) await post('unsubscribe', { id: sub.server }).catch(() => {})
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
  setConnection('reconnecting')
  loadOutbox()
  navigator.serviceWorker?.register('/sw.js')
  navigator.storage?.persist?.()
  let hiddenAt = 0
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      hiddenAt = Date.now()
      for (const attempt of attempts) attempt.controller.abort()
      attempts.clear()
    } else if (!live || Date.now() - hiddenAt >= connectMs) wake('foreground')
  })
  window.addEventListener('online', () => wake('online'))
  window.addEventListener('pageshow', event => event.persisted && wake('pageshow'))
  setInterval(check, 1000)
  check()
  return {
    invoke: (command, args) => (handlers[command] as (args: unknown) => Promise<never>)(args),
    listen: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    },
  }
}
