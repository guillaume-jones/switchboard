import { useSyncExternalStore } from 'react'
import * as bridge from './bridge'
import type { Config } from './bridge'
import { loadCard, prepareCards } from './cards'
import { deliverRows } from './subscriptions'

let config: Config | Error | undefined
let latestRequest = 0
const listeners = new Set<() => void>()

/** Publishes once the root card is loaded, then loads the others meanwhile, so startup does not grow with the folder. */
async function reload() {
  const request = ++latestRequest
  let next: Config | Error
  try {
    next = await bridge.config()
    await loadCard(next.root).component.catch(() => {})
  } catch (error) {
    next = bridge.toError(error)
  }
  if (request === latestRequest) publish(next)
}

function publish(next: Config | Error) {
  config = next
  for (const listener of listeners) listener()
  if (!(next instanceof Error)) for (const name of next.cards) loadCard(name)
}

let resyncs = Promise.resolve()

/** Applies a catch-up in one render: new cards and the config once loaded, together with the rows. */
bridge.on('resync', ({ config: changed, cards, rows }) => {
  resyncs = resyncs.then(async () => {
    const swap = await prepareCards(cards)
    if (changed) await loadCard(changed.root).component.catch(() => {})
    swap()
    if (changed) {
      latestRequest++
      publish(changed)
    }
    deliverRows(rows)
  })
  return resyncs
})

reload()
bridge.on('config', reload)

function watch(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** `undefined` until the first load. */
export const useConfig = () => useSyncExternalStore(watch, () => config)

/** For components the shell renders only once the config has loaded. */
export function useLoadedConfig(): Config {
  const loaded = useConfig()
  if (!loaded || loaded instanceof Error) throw new Error('rendered before the config loaded')
  return loaded
}
