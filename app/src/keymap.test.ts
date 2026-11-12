import { expect, test } from 'vitest'
import type { Binding, Size } from './bridge'
import { eventKey, groupBindings, matchBindings, normalizeKey, parse, variable, type Frame } from './keymap'

const frame = (card: string, vars: Record<string, unknown> = {}, size: Size = 'full'): Frame => ({ card, size, vars })
const stack = [
  frame('Root'),
  frame('Boards', { board: 'main' }),
  frame('WorkstreamView', { selected: 'ws:1' }),
  frame('PRList', { selected: 'prs:4812' }, 'compact'),
]
const at = (src: string, i = stack.length - 1) => parse(src)(stack, i)

test('predicate operators', () => {
  expect(at('card:PRList')).toBe(true)
  expect(at('card:Boards')).toBe(false)
  expect(at('card:Boards', 1)).toBe(true)
  expect(at('card:PRList && selected')).toBe(true)
  expect(at('card:PRList && missing')).toBe(false)
  expect(at('card:Nope || card:PRList')).toBe(true)
  expect(at('!card:Nope && !missing')).toBe(true)
  expect(at('!(card:PRList || card:Nope)')).toBe(false)
  expect(at('card:Boards > card:PRList')).toBe(true)
  expect(at('card:Root > card:WorkstreamView > card:PRList')).toBe(true)
  expect(at('card:PRList > card:Boards')).toBe(false)
  expect(at('card:Boards > card:PRList && focused')).toBe(true)
  expect(at('card:Boards > card:Nope || card:PRList')).toBe(true)
  expect(at('focused', 2)).toBe(false)
})

test('predicate syntax errors', () => {
  for (const bad of ['', 'a &&', '(a', 'a b', '&& a', 'a > > b', 'a)']) expect(() => parse(bad), bad).toThrow()
})

test('variables: nearest wins, explicit form, reserved', () => {
  expect(variable(stack, 3, 'selected')).toBe('prs:4812')
  expect(variable(stack, 2, 'selected')).toBe('ws:1')
  expect(variable(stack, 3, 'WorkstreamView.selected')).toBe('ws:1')
  expect(variable(stack, 3, 'Boards.selected')).toBeUndefined()
  expect(variable(stack, 3, 'board')).toBe('main')
  expect(variable(stack, 3, 'size')).toBe('compact')
  expect(variable(stack, 3, 'Boards.size')).toBe('full')
  expect(variable(stack, 3, 'focused')).toBe(true)
  expect(variable(stack, 3, 'Boards.focused')).toBe(false)
  expect(variable([frame('A', { x: null }), frame('B', { x: undefined })], 1, 'x')).toBeUndefined()
})

const keymap: Binding[] = [
  { key: 'cmd-k', command: 'palette.open' },
  { key: 'f', command: 'global.f' },
  { key: 'f', context: 'card:Boards', command: 'boards.f' },
  {
    key: 'f',
    context: 'card:PRList && selected',
    command: 'prs.fix-ci',
    args: { pr: '{selected}', note: 'in {Boards.board}', n: 3 },
  },
  { key: 'g', context: 'card:PRList', command: 'prs.g', args: { x: '{nothing}' } },
  { key: 'g', context: 'card:Boards', command: 'boards.g' },
  { key: 'h', context: 'card:Boards', command: 'first' },
  { key: 'h', context: 'card:Boards', command: 'second' },
  { key: 'u', context: 'card:Boards', write: 'ui.u' },
  { key: 'u', context: 'card:PRList', command: null },
]
const byKey = groupBindings(keymap, b => normalizeKey(b.key))
const win = (key: string, s = stack) => matchBindings(byKey.get(key) ?? [], s).find(h => !h.missing.length)

test('innermost match wins, args filled at keypress', () => {
  const hit = win('f')!
  expect(hit.binding.command).toBe('prs.fix-ci')
  expect(hit.depth).toBe(3)
  expect(hit.args).toEqual({ pr: 'prs:4812', note: 'in main', n: 3 })
  stack[3].vars.selected = 'prs:1'
  expect(win('f')!.args.pr).toBe('prs:1')
  stack[3].vars.selected = 'prs:4812'
  expect(win('f', stack.slice(0, 2))!.binding.command).toBe('boards.f')
  expect(win('f', [])!.binding.command).toBe('global.f')
})

test('missing variable disables the binding; null unbinds; later wins at equal depth', () => {
  const g = matchBindings(byKey.get('g')!, stack)
  expect(g[0].missing).toEqual(['nothing'])
  expect(win('g')!.binding.command).toBe('boards.g')
  expect(win('u')!.binding.command).toBeNull()
  expect(win('u', stack.slice(0, 3))!.binding.write).toBe('ui.u')
  expect(win('h')!.binding.command).toBe('second')
  expect(win('z')).toBeUndefined()
})

test('key names', () => {
  expect(normalizeKey('Cmd-K')).toBe('cmd-k')
  expect(normalizeKey('shift-cmd-]')).toBe('shift-cmd-]')
  expect(normalizeKey('cmd-shift-]')).toBe('shift-cmd-]')
  expect(normalizeKey('cmd--')).toBe('cmd--')
  expect(normalizeKey('')).toBe('')
  const ev = (init: Partial<KeyboardEvent>) =>
    ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: '', key: '', ...init }) as KeyboardEvent
  expect(eventKey(ev({ metaKey: true, code: 'KeyK', key: 'k' }))).toBe('cmd-k')
  expect(eventKey(ev({ altKey: true, code: 'KeyF', key: 'ƒ' }))).toBe('alt-f')
  expect(eventKey(ev({ shiftKey: true, code: 'KeyF', key: 'F' }))).toBe('shift-f')
  expect(eventKey(ev({ shiftKey: true, code: 'Slash', key: '?' }))).toBe('?')
  expect(eventKey(ev({ metaKey: true, code: 'BracketRight', key: ']' }))).toBe('cmd-]')
  expect(eventKey(ev({ shiftKey: true, code: 'Enter', key: 'Enter' }))).toBe('shift-enter')
})
