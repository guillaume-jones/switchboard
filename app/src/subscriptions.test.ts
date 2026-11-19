import { beforeEach, expect, test, vi } from 'vitest'

const handlers: Record<string, (p: any) => void> = {}
let nextId = 1
const bridge = vi.hoisted(() => ({
  on: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  toError: (thrown: unknown) => (thrown instanceof Error ? thrown : new Error(String(thrown))),
}))
vi.mock('./bridge', () => bridge)
bridge.on.mockImplementation((event: string, cb: (p: any) => void) => (handlers[event] = cb))
bridge.subscribe.mockImplementation(async () => ({ id: nextId++, rows: [{ n: 0 }] }))

const { deliverRows, subscription } = await import('./subscriptions')
const tick = () => new Promise(r => setTimeout(r))

beforeEach(() => {
  bridge.subscribe.mockClear()
  bridge.unsubscribe.mockClear()
})

test('identical (name, params) share one backend subscription', async () => {
  const a = subscription('prs_items', { id: 1 })
  expect(subscription('prs_items', { id: 1 })).toBe(a)
  const l1 = vi.fn(),
    l2 = vi.fn()
  const off1 = a.subscribe(l1)
  const off2 = subscription('prs_items', { id: 1 }).subscribe(l2)
  await tick()
  expect(bridge.subscribe).toHaveBeenCalledTimes(1)
  expect(a.getSnapshot()).toEqual([{ n: 0 }])

  const id = (await bridge.subscribe.mock.results[0].value).id
  const rows = [{ n: 1 }]
  handlers.rows({ id, rows })
  expect(a.getSnapshot()).toBe(rows)
  expect(l1).toHaveBeenCalledTimes(2)
  expect(l2).toHaveBeenCalledTimes(2)

  off1()
  await tick()
  expect(bridge.unsubscribe).not.toHaveBeenCalled()
  off2()
  await tick()
  expect(bridge.unsubscribe).toHaveBeenCalledExactlyOnceWith(id)
  handlers.rows({ id, rows: [] })
  expect(a.getSnapshot()).toBe(rows)
  expect(subscription('prs_items', { id: 1 })).not.toBe(a)
})

test('different params are separate; remount within a tick does not resubscribe', async () => {
  const a = subscription('prs_items', { id: 2 })
  const b = subscription('prs_items', { id: 3 })
  expect(a).not.toBe(b)
  const offA = a.subscribe(() => {})
  b.subscribe(() => {})
  expect(bridge.subscribe).toHaveBeenCalledTimes(2)
  offA()
  a.subscribe(() => {})
  await tick()
  expect(bridge.subscribe).toHaveBeenCalledTimes(2)
  expect(bridge.unsubscribe).not.toHaveBeenCalled()
})

test('unsubscribe before the subscription resolves still unsubscribes', async () => {
  const off = subscription('core_runs').subscribe(() => {})
  off()
  await tick()
  await tick()
  expect(bridge.unsubscribe).toHaveBeenCalledTimes(1)
})

test('errors are kept on the subscription and notify', async () => {
  bridge.subscribe.mockImplementationOnce(async () => {
    throw 'no view named nope'
  })
  const e = subscription('nope')
  const l = vi.fn()
  e.subscribe(l)
  await tick()
  expect(e.error).toEqual(new Error('no view named nope'))
  expect(l).toHaveBeenCalledOnce()
})

test('rows pushed before the subscription registers are not lost', async () => {
  let resolve!: (r: { id: number; rows: { n: number }[] }) => void
  bridge.subscribe.mockImplementationOnce(() => new Promise(r => (resolve = r)))
  const e = subscription('core_events')
  const l = vi.fn()
  e.subscribe(l)
  const id = nextId++
  handlers.rows({ id, rows: [{ n: 2 }] })
  resolve({ id, rows: [{ n: 1 }] })
  await tick()
  expect(e.getSnapshot()).toEqual([{ n: 2 }])
  expect(l).toHaveBeenCalledOnce()
})

test('rows delivered by a resync reach their subscription', async () => {
  const s = subscription('resynced')
  const off = s.subscribe(() => {})
  await tick()
  const { id } = await bridge.subscribe.mock.results.at(-1)!.value
  deliverRows([{ id, rows: [{ n: 'fresh' }] }])
  expect(s.getSnapshot()).toEqual([{ n: 'fresh' }])
  off()
})
