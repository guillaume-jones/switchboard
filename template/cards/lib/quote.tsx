import { useEffect, type RefObject } from 'react'
import { quote, sendQuote } from './markdown'

type Selected = { text: string; from: Element }

/** The selection, if inside one rendered message under `root`, as a quote referencing its file lines in a doc. */
const selectedQuote = (root: HTMLElement): Selected | undefined => {
  const selection = getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return
  const range = selection.getRangeAt(0)
  const elementOf = (node: Node) => (node instanceof Element ? node : node.parentElement)
  const start = elementOf(range.startContainer)
  let endNode: Node | null = range.endContainer
  if (range.endOffset === 0) {
    while (endNode.parentNode && !endNode.previousSibling) endNode = endNode.parentNode
    endNode = endNode.previousSibling
  } else if (!(endNode instanceof Text)) endNode = endNode.childNodes[range.endOffset - 1]
  while (endNode?.lastChild) endNode = endNode.lastChild
  const end = endNode && elementOf(endNode)
  const message = start?.closest('.message')
  const text = selection.toString().trim()
  if (!start || !end || !message || !root.contains(message) || !message.contains(end) || !text) return
  const path = message.closest<HTMLElement>('[data-doc-path]')?.dataset.docPath
  const first = start.closest<HTMLElement>('[data-lines]')?.dataset.lines?.split('-')[0]
  const last = end.closest<HTMLElement>('[data-lines]')?.dataset.lines?.split('-')[1]
  const lines = first && last && (first === last ? first : `${first}-${last}`)
  return { text: quote(text, path && (lines ? `${path}:${lines}` : path)), from: start }
}

/** ⌘E adds text selected in a message under `root` to the chat. */
export function useQuoteShortcut(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'e') return
      const selected = root.current && selectedQuote(root.current)
      if (!selected) return
      e.preventDefault()
      if (sendQuote(selected.from, selected.text)) getSelection()?.removeAllRanges()
    }
    addEventListener('keydown', key, true)
    return () => removeEventListener('keydown', key, true)
  }, [])
}
