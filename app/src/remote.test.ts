import { expect, test, vi } from 'vitest'
import type { Config } from './bridge'
import type { ResyncReply } from './remote'

/** Just enough IndexedDB for the cache: string keys, and transactions that commit once no request is left. */
const entries = vi.hoisted(() => {
  const entries = new Map<string, unknown>()
  type Range = { includes(key: string): boolean }
  const later = (run: () => void) => setTimeout(run)
  const transaction = () => {
    let pending = 0
    const tx: Record<string, any> = { error: null }
    const settle = () => later(() => pending === 0 && later(() => pending === 0 && tx.oncomplete?.()))
    const request = (compute: () => unknown) => {
      const req: Record<string, any> = {}
      pending++
      later(() => {
        req.result = compute()
        pending--
        req.onsuccess?.()
        settle()
      })
      return req
    }
    const keys = (range: Range) => [...entries.keys()].filter(key => range.includes(key)).sort()
    const store = {
      get: (key: string) => request(() => structuredClone(entries.get(key))),
      put: (value: unknown, key: string) => request(() => entries.set(key, structuredClone(value))),
      delete: (key: string) => request(() => entries.delete(key)),
      clear: () => request(() => entries.clear()),
      getAll: (range: Range) => request(() => keys(range).map(key => structuredClone(entries.get(key)))),
      getAllKeys: (range: Range) => request(() => keys(range)),
    }
    tx.objectStore = () => store
    settle()
    return tx
  }
  const db = { transaction, createObjectStore: () => {} }
  Object.assign(globalThis, {
    localStorage: { getItem: () => null, setItem: () => {} },
    IDBKeyRange: { bound: (lower: string, upper: string) => ({ includes: (k: string) => k >= lower && k <= upper }) },
    indexedDB: {
      open: () => {
        const req: Record<string, any> = { result: db, transaction: transaction() }
        setTimeout(() => {
          req.onupgradeneeded?.({ oldVersion: 0 })
          req.onsuccess?.()
        })
        return req
      },
    },
  })
  return entries
})

const { cachedCard, storeCards } = await import('./remote')

const config = (...cards: string[]) => ({ cards }) as Config
const reply = (cards: ResyncReply['cards'], code: Record<string, string>) =>
  ({ config: null, config_hash: '', cards, code, subs: [] }) as ResyncReply
const codeKeys = () => [...entries.keys()].filter(key => key.startsWith('code:')).sort()

test('code is kept once for every card using it, and dropped with the last of them', async () => {
  const changed = await storeCards(
    reply(
      {
        A: { hash: 'a1', modules: { 'A.tsx': 'ha1', 'lib/big.ts': 'hbig' } },
        B: { hash: 'b1', modules: { 'B.tsx': 'hb1', 'lib/big.ts': 'hbig' } },
      },
      { ha1: 'a1', hb1: 'b1', hbig: 'big' },
    ),
    config('A', 'B'),
  )
  expect(changed).toEqual({ A: { 'A.tsx': 'a1', 'lib/big.ts': 'big' }, B: { 'B.tsx': 'b1', 'lib/big.ts': 'big' } })
  expect(codeKeys()).toEqual(['code:ha1', 'code:hb1', 'code:hbig'])
  expect(await cachedCard('B')).toEqual({ 'B.tsx': 'b1', 'lib/big.ts': 'big' })

  const next = await storeCards(
    reply({ A: { hash: 'a2', modules: { 'A.tsx': 'ha2', 'lib/big.ts': 'hbig' } } }, { ha2: 'a2' }),
    config('A', 'B'),
  )
  expect(next).toEqual({ A: { 'A.tsx': 'a2', 'lib/big.ts': 'big' } })
  expect(codeKeys()).toEqual(['code:ha2', 'code:hb1', 'code:hbig'])

  await storeCards(reply({}, {}), config('A'))
  expect(await cachedCard('B')).toBeUndefined()
  expect(codeKeys()).toEqual(['code:ha2', 'code:hbig'])
})

test('a card is not kept without its code', async () => {
  const changed = await storeCards(reply({ C: { hash: 'c', modules: { 'C.tsx': 'hmissing' } } }, {}), config('A', 'C'))
  expect(changed).toEqual({})
  expect(await cachedCard('C')).toBeUndefined()
  expect(await cachedCard('A')).toEqual({ 'A.tsx': 'a2', 'lib/big.ts': 'big' })
})
