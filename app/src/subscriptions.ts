import * as bridge from './bridge'
import type { Params, Row } from './bridge'

type Listener = () => void

const registry = new Map<string, Subscription>()
const rowHandlers = new Map<number, (rows: Row[]) => void>()
/** Rows pushed for ids whose `subscribe` reply hasn't arrived yet. Pushes for closed ids are dropped once nothing is pending. */
const earlyRows = new Map<number, Row[]>()
let pendingOpens = 0

bridge.on('rows', ({ id, rows }) => {
  const handler = rowHandlers.get(id)
  if (handler) handler(rows)
  else if (pendingOpens > 0) earlyRows.set(id, rows)
})

/** The live result of a view or query, shared by every reader of the same name and params. Shaped for `useSyncExternalStore`. */
export class Subscription {
  rows: Row[] | undefined
  error: Error | undefined
  readonly #listeners = new Set<Listener>()
  #backendId: Promise<number | undefined> | undefined

  constructor(
    readonly key: string,
    readonly name: string,
    readonly params: Params,
  ) {}

  getSnapshot = () => this.rows

  subscribe = (listener: Listener) => {
    this.#listeners.add(listener)
    if (!registry.has(this.key)) registry.set(this.key, this)
    this.#backendId ??= this.#open()
    return () => {
      this.#listeners.delete(listener)
      // Deferred so an unmount followed by a remount in the same task keeps the backend subscription.
      setTimeout(this.#closeIfUnused)
    }
  }

  async #open() {
    pendingOpens++
    try {
      const { id, rows } = await bridge.subscribe(this.name, this.params)
      rowHandlers.set(id, this.#receive)
      this.rows = earlyRows.get(id) ?? rows
      return id
    } catch (error) {
      this.error = bridge.toError(error)
      return undefined
    } finally {
      if (--pendingOpens === 0) earlyRows.clear()
      this.#notify()
    }
  }

  #receive = (rows: Row[]) => {
    this.rows = rows
    this.#notify()
  }

  #notify() {
    for (const listener of this.#listeners) listener()
  }

  #closeIfUnused = () => {
    const backendId = this.#backendId
    if (this.#listeners.size || !backendId) return
    this.#backendId = undefined
    if (registry.get(this.key) === this) registry.delete(this.key)
    backendId.then(id => {
      if (id === undefined) return
      rowHandlers.delete(id)
      bridge.unsubscribe(id)
    })
  }
}

export function subscription(name: string, params: Params = {}): Subscription {
  const key = name + JSON.stringify(params)
  let existing = registry.get(key)
  if (!existing) registry.set(key, (existing = new Subscription(key, name, params)))
  return existing
}
