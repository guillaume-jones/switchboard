import type { Frame } from './keymap'

/** A mounted CardSlot or Region in the context stack. One object per slot for its whole lifetime. */
export type SlotFrame = Frame & { parent: SlotFrame | null; depth: number; el: HTMLElement | null }

const FOCUSED_CLASS = 'focused'
const LEAF_SLOTS = '.slot:not(:has(.slot))'

let focused: SlotFrame | null = null
let lastClaim: Event | null = null
const frameByElement = new WeakMap<Element, SlotFrame>()

/** The card a frame is, or is a region of. */
const cardOf = (frame: SlotFrame | null) => {
  while (frame?.region) frame = frame.parent
  return frame
}

function setFocused(frame: SlotFrame | null) {
  cardOf(focused)?.el?.classList.remove(FOCUSED_CLASS)
  focused = frame
  cardOf(frame)?.el?.classList.add(FOCUSED_CLASS)
}

/** Call from an effect once the slot's element exists; returns the cleanup. The first root slot takes focus. */
export function mountSlot(frame: SlotFrame, el: HTMLElement) {
  frame.el = el
  frameByElement.set(el, frame)
  if (!frame.parent && !focused) setFocused(frame)
  return () => {
    if (focused === frame) setFocused(frame.parent)
  }
}

/** Pointer and focus events bubble through every enclosing slot; the innermost one claims focus. */
export function claimFocus(frame: SlotFrame, event: Event) {
  if (event === lastClaim) return
  lastClaim = event
  setFocused(frame)
}

/** Hands focus from a region back to its parent once focus leaves it, unless something else claimed it first. */
export function releaseFocus(frame: SlotFrame) {
  if (focused === frame) setFocused(frame.parent)
}

/** The focused slot and its ancestors, outermost first. */
export function activeStack(): SlotFrame[] {
  const stack: SlotFrame[] = []
  for (let frame = focused; frame; frame = frame.parent) stack.push(frame)
  return stack.reverse()
}

/**
 * Moves focus to the next or previous slot that contains no other slot, in document order, wrapping around.
 * From a slot that contains others, "next" starts at its first descendant.
 */
export function focusStep(step: 1 | -1) {
  const leaves = [...document.querySelectorAll(LEAF_SLOTS)]
  if (!leaves.length) return
  const from = focused?.el
  const direction = step > 0 ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING
  const isInDirection = (leaf: Element) => !!from && (from.compareDocumentPosition(leaf) & direction) !== 0
  const found = step > 0 ? leaves.findIndex(isInDirection) : leaves.findLastIndex(isInDirection)
  const next = leaves.at(found >= 0 ? found : step > 0 ? 0 : -1)!
  setFocused(frameByElement.get(next) ?? null)
  // Slots are `display: contents`, so their first child is what occupies space.
  next.firstElementChild?.scrollIntoView({ block: 'nearest' })
}
