import { expect, test, vi } from 'vitest'

const handlers: Record<string, (p: any) => void> = {}
const bridge = vi.hoisted(() => ({ on: vi.fn(), card: vi.fn() }))
vi.mock('./bridge', () => bridge)
vi.mock('./switchboard', () => ({}))
bridge.on.mockImplementation((event: string, cb: (p: any) => void) => (handlers[event] = cb))

import type { LoadedCard } from './cards'

const { loadCard, watchCards } = await import('./cards')
const tick = () => new Promise(r => setTimeout(r))
const settled = (promise: Promise<unknown>) => (promise as { status?: string }).status
const version = async (card: LoadedCard) => ((await card.component) as unknown as () => string)()

let release: ((version: string) => void)[] = []
bridge.card.mockImplementation(
  (name: string) =>
    new Promise(resolve =>
      release.push(version => resolve({ [`${name}.tsx`]: `__vite_ssr_exports__.default = () => '${version}'` })),
    ),
)

test('a changed card keeps rendering its old version until the new one has loaded', async () => {
  const first = loadCard('A')
  release.shift()!('v1')
  await tick()
  expect(settled(first.component)).toBe('fulfilled')

  const changed = vi.fn()
  watchCards(changed)
  handlers.card({ name: 'A' })
  expect(loadCard('A')).toBe(first)
  expect(changed).not.toHaveBeenCalled()

  release.shift()!('v2')
  await tick()
  const second = loadCard('A')
  expect(second.generation).toBeGreaterThan(first.generation)
  expect(settled(second.component)).toBe('fulfilled')
  expect(await version(second)).toBe('v2')
  expect(changed).toHaveBeenCalledTimes(1)
})

test('when two changes race, the later version wins', async () => {
  loadCard('B')
  release.shift()!('v1')
  await tick()
  handlers.card({ name: 'B' })
  handlers.card({ name: 'B' })
  const [older, newer] = release
  release = []
  newer('v3')
  await tick()
  older('v2')
  await tick()
  expect(await version(loadCard('B'))).toBe('v3')
})
