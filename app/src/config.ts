import { useSyncExternalStore } from 'react'
import * as bridge from './bridge'
import type { Config } from './bridge'
import { loadCard } from './cards'

let config: Config | Error | undefined
let latestRequest = 0
const listeners = new Set<() => void>()

/** Publishes only once every card is loaded, so slots render without suspending. */
async function reload() {
  const request = ++latestRequest
  let next: Config | Error
  try {
    next = await bridge.config()
    await Promise.allSettled(next.cards.map(name => loadCard(name).component))
  } catch (error) {
    next = bridge.toError(error)
  }
  if (request !== latestRequest) return
  config = next
  for (const listener of listeners) listener()
}

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
