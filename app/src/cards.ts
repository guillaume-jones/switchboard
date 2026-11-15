import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import type { ComponentType } from 'react'
import * as switchboard from './switchboard'
import * as bridge from './bridge'
import type { CardModules, Params } from './bridge'

export type CardComponent = ComponentType<Params>
export type LoadedCard = {
  /** Distinct per load, so a slot's error boundary resets when its card is reloaded. */
  generation: number
  component: Promise<CardComponent>
}

const AsyncFunction = (async () => {}).constructor as FunctionConstructor

const cache = new Map<string, LoadedCard>()
const listeners = new Set<() => void>()
let generation = 0

bridge.on('card', ({ name }) => {
  if (cache.has(name)) refresh(name)
})

// Cards may have changed while the connection was down.
bridge.on('reconnect', () => {
  for (const name of cache.keys()) refresh(name)
})

/**
 * Swaps in the card's new version once it has loaded, so its slots re-render without suspending, and the remounted card
 * finds its subscriptions (closed a tick after unmount) still open, with their rows.
 */
function refresh(name: string) {
  const next = fetchCard(name)
  const swap = () => {
    if (next.generation < (cache.get(name)?.generation ?? 0)) return
    cache.set(name, next)
    for (const listener of listeners) listener()
  }
  next.component.then(swap, swap)
}

export function watchCards(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Cached; a changed card is replaced once its new version has loaded. */
export function loadCard(name: string): LoadedCard {
  let card = cache.get(name)
  if (!card) cache.set(name, (card = fetchCard(name)))
  return card
}

function fetchCard(name: string): LoadedCard {
  const component = bridge.card(name).then(modules => instantiate(name, modules))
  exposeSettledState(component)
  return { generation: ++generation, component }
}

/** Every card gets its own instances of the `cards/lib` helpers it imports. */
async function instantiate(name: string, modules: CardModules): Promise<CardComponent> {
  const instances: Record<string, object> = { react: React, 'react/jsx-runtime': jsxRuntime, switchboard }
  const importModule = async (id: string) => {
    const existing = instances[id]
    if (existing) return existing
    const code = modules[id]
    if (code === undefined) throw new Error(`${name}: module ${id} was not delivered`)
    const exports: Record<string, unknown> = {}
    instances[id] = exports
    const exportAll = (source: Record<string, unknown>) => {
      for (const key of Object.keys(source)) {
        if (key === 'default' || key in exports) continue
        Object.defineProperty(exports, key, { enumerable: true, get: () => source[key] })
      }
    }
    const evaluate = new AsyncFunction('__vite_ssr_import__', '__vite_ssr_exports__', '__vite_ssr_exportAll__', code)
    await evaluate(importModule, exports, exportAll)
    return exports
  }
  const { default: component } = (await importModule(`${name}.tsx`)) as { default?: unknown }
  const isComponent =
    typeof component === 'function' || (typeof component === 'object' && component !== null && '$$typeof' in component)
  if (!isComponent) throw new Error(`${name}.tsx must default-export a React component`)
  return component as CardComponent
}

/** Lets React's `use()` read an already settled promise synchronously instead of suspending for a frame. */
function exposeSettledState<T>(promise: Promise<T>) {
  promise.then(
    value => Object.assign(promise, { status: 'fulfilled', value }),
    reason => Object.assign(promise, { status: 'rejected', reason }),
  )
}
