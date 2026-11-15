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
  cache.delete(name)
  for (const listener of listeners) listener()
})

// Cards may have changed while the connection was down.
bridge.on('reconnect', () => {
  cache.clear()
  for (const listener of listeners) listener()
})

export function watchCards(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Cached until the backend reports the card changed. */
export function loadCard(name: string): LoadedCard {
  let card = cache.get(name)
  if (!card) {
    const component = bridge.card(name).then(modules => instantiate(name, modules))
    exposeSettledState(component)
    cache.set(name, (card = { generation: ++generation, component }))
  }
  return card
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
