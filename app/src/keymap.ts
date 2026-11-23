import type { Binding, Params, Size } from './bridge'

/** A card action (`useActions`), called with the binding's args and the key or mouse event that fired it, if any. */
export type ActionHandler = (args: Params, event?: KeyboardEvent | MouseEvent) => void
/** One card, or a focused `Region` of one (`region`, named by `card`), in the context stack, which runs outermost first. */
export type Frame = {
  card: string
  size: Size
  vars: Record<string, unknown>
  actions?: Record<string, ActionHandler>
  region?: boolean
}
/**
 * A binding whose context holds at stack index `depth` (-1 for bindings without a context). `handler` is the card
 * action an `action` binding calls; an unregistered action is listed in `missing`.
 */
export type Hit = { binding: Binding; depth: number; args: Params; missing: string[]; handler?: ActionHandler }
export type Action = { kind: 'command' | 'write' | 'action'; name: string }
type Predicate = (stack: Frame[], index: number) => boolean

/** `null` for a binding that unbinds its key (`"command": null`). */
export function bindingAction(binding: Binding): Action | null {
  if (binding.write) return { kind: 'write', name: binding.write }
  if (binding.command) return { kind: 'command', name: binding.command }
  if (binding.action) return { kind: 'action', name: binding.action }
  return null
}

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable=false])'

/** Whether typing into `target` enters text: an input, textarea, select or contenteditable element. */
export const isEditable = (target: EventTarget | null | undefined) =>
  typeof Element !== 'undefined' && target instanceof Element && !!target.closest(EDITABLE)

/** Resolves `name` or `Card.name` from frame `index` outwards. `size` and `focused` (the innermost card) are reserved. */
export function variable(stack: Frame[], index: number, name: string): unknown {
  const dot = name.lastIndexOf('.')
  const card = dot < 0 ? null : name.slice(0, dot)
  const key = name.slice(dot + 1)
  for (let i = index; i >= 0; i--) {
    const frame = stack[i]
    if (card !== null && frame.card !== card) continue
    const value =
      key === 'size'
        ? frame.size
        : key === 'focused'
          ? !frame.region && stack.slice(i + 1).every(inner => inner.region)
          : frame.vars[key]
    if (card !== null || value != null) return value
  }
}

const CARD_ACTION = /^([A-Z][\w-]*)\.(.+)$/

/** Resolves action `name`, or `Card.name` for a capitalized card name, from frame `index` outwards. */
export function cardAction(stack: Frame[], index: number, name: string): ActionHandler | undefined {
  const [, card, action] = CARD_ACTION.exec(name) ?? [undefined, null, name]
  for (let i = index; i >= 0; i--) {
    const frame = stack[i]
    if (card !== null && frame.card !== card) continue
    const handler = frame.actions?.[action]
    if (handler) return handler
  }
}

const TOKEN = /&&|\|\||[!>()]|[^\s&|!>()]+/g
const OPERATOR_START = /^[&|>)]/

/** Whether a binding's context names a region, which lets it take keys that would otherwise type into a text field. */
export const namesRegion = (binding: Binding) => !!binding.context?.match(TOKEN)?.some(t => t.startsWith('region:'))

/** Compiles a binding context. Operators from loosest: `>` (descendant of), `||`, `&&`, `!`. */
export function parse(context: string): Predicate {
  const tokens = context.match(TOKEN) ?? []
  let pos = 0
  const unexpected = (token: string | undefined) => new Error(`unexpected ${token ?? 'end'} in "${context}"`)

  const leftAssociative =
    (operator: string, operand: () => Predicate, combine: (left: Predicate, right: Predicate) => Predicate) =>
    (): Predicate => {
      let left = operand()
      while (tokens[pos] === operator) {
        pos++
        left = combine(left, operand())
      }
      return left
    }

  const unary = (): Predicate => {
    const token = tokens[pos++]
    if (token === '!') {
      const negated = unary()
      return (stack, i) => !negated(stack, i)
    }
    if (token === '(') {
      const inner = descendant()
      if (tokens[pos++] !== ')') throw new Error(`missing ) in "${context}"`)
      return inner
    }
    if (token === undefined || OPERATOR_START.test(token)) throw unexpected(token)
    if (token.startsWith('card:')) {
      const card = token.slice('card:'.length)
      return (stack, i) => !stack[i].region && stack[i].card === card
    }
    if (token.startsWith('region:')) {
      const region = token.slice('region:'.length)
      return (stack, i) => !!stack[i].region && stack[i].card === region
    }
    return (stack, i) => {
      const value = variable(stack, i, token)
      return value != null && value !== false
    }
  }

  const and = leftAssociative('&&', unary, (left, right) => (stack, i) => left(stack, i) && right(stack, i))
  const or = leftAssociative('||', and, (left, right) => (stack, i) => left(stack, i) || right(stack, i))
  const descendant: () => Predicate = leftAssociative('>', or, (ancestor, child) => (stack, i) => {
    if (!child(stack, i)) return false
    for (let j = i - 1; j >= 0; j--) if (ancestor(stack, j)) return true
    return false
  })

  const predicate = descendant()
  if (pos < tokens.length) throw unexpected(tokens[pos])
  return predicate
}

const predicates = new Map<string, Predicate>()

/** An invalid context logs once and never matches. */
function predicate(context: string): Predicate {
  let compiled = predicates.get(context)
  if (!compiled) {
    try {
      compiled = parse(context)
    } catch (error) {
      console.error(error)
      compiled = () => false
    }
    predicates.set(context, compiled)
  }
  return compiled
}

const WHOLE_VARIABLE = /^\{([\w.-]+)\}$/
const VARIABLE = /\{([\w.-]+)\}/g

/** `"{x}"` takes x's value as is; `"a {x}"` interpolates it as a string. An action binding also resolves its handler. */
function fillArgs(binding: Binding, stack: Frame[], index: number) {
  const { args = {}, action } = binding
  const missing: string[] = []
  const lookup = (name: string) => {
    const value = variable(stack, index, name)
    if (value == null) missing.push(name)
    return value
  }
  const filled: Params = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') {
      filled[key] = value
      continue
    }
    const whole = WHOLE_VARIABLE.exec(value)
    filled[key] = whole ? lookup(whole[1]) : value.replace(VARIABLE, (_, name: string) => String(lookup(name)))
  }
  const handler = action ? cardAction(stack, index, action) : undefined
  if (action && !handler) missing.push(action)
  return { args: filled, missing, handler }
}

/**
 * The bindings among `candidates` that apply to `stack`: innermost frame first, context-less bindings last,
 * later bindings first within a frame. The first hit with no missing variables is the one that fires.
 */
export function matchBindings(candidates: Binding[], stack: Frame[]): Hit[] {
  const hits: Hit[] = []
  const matched = new Set<Binding>()
  for (let depth = stack.length - 1; depth >= 0; depth--) {
    for (let n = candidates.length - 1; n >= 0; n--) {
      const binding = candidates[n]
      if (!binding.context || matched.has(binding) || !predicate(binding.context)(stack, depth)) continue
      matched.add(binding)
      hits.push({ binding, depth, ...fillArgs(binding, stack, depth) })
    }
  }
  for (let n = candidates.length - 1; n >= 0; n--) {
    const binding = candidates[n]
    if (!binding.context) hits.push({ binding, depth: -1, ...fillArgs(binding, stack, stack.length - 1) })
  }
  return hits
}

/** Groups bindings in keymap order; bindings `groupOf` maps to null are left out. */
export function groupBindings(bindings: Binding[], groupOf: (binding: Binding) => string | null) {
  const groups = new Map<string, Binding[]>()
  for (const binding of bindings) {
    const group = groupOf(binding)
    if (group === null) continue
    const members = groups.get(group)
    if (members) members.push(binding)
    else groups.set(group, [binding])
  }
  return groups
}

const MODIFIERS = ['ctrl', 'alt', 'shift', 'cmd'] as const
type Modifier = (typeof MODIFIERS)[number]
const KEY_WITH_MODIFIERS = new RegExp(`^((?:(?:${MODIFIERS.join('|')})-)*)(.+)$`)

/** Lowercase, with modifiers in a fixed order, so `Cmd-Shift-K` and `shift-cmd-k` compare equal. */
export function normalizeKey(key: string): string {
  const match = KEY_WITH_MODIFIERS.exec(key.toLowerCase())
  if (!match) return ''
  const [, modifiers, base] = match
  const held = modifiers.split('-')
  return [...MODIFIERS.filter(m => held.includes(m)), base].join('-')
}

const MOUSE_BUTTONS: Partial<Record<number, string>> = { 3: 'mouse-back', 4: 'mouse-forward' }

/**
 * A keydown or mouse button in `normalizeKey` form, `''` for an unnamed button. Letters and digits come from the
 * physical key, so alt-f stays `alt-f` rather than `alt-ƒ`; shift is dropped when it only selects a symbol, so
 * shift-/ is `?`.
 */
export function eventKey(e: KeyboardEvent | MouseEvent): string {
  const letterOrDigit = 'code' in e ? /^(?:Key|Digit)(.)$/.exec(e.code)?.[1].toLowerCase() : undefined
  const base = 'key' in e ? (letterOrDigit ?? (e.code === 'Space' ? 'space' : e.key.toLowerCase())) : MOUSE_BUTTONS[e.button]
  if (!base) return ''
  const held: Record<Modifier, boolean> = {
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey && (letterOrDigit !== undefined || base.length > 1),
    cmd: e.metaKey,
  }
  return [...MODIFIERS.filter(m => held[m]), base].join('-')
}
