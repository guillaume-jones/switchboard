import { Marked } from './marked'

const escape = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const linkable = (href: string) => /^(https?:|mailto:)/i.test(href)

/** Markdown to HTML for agent text. Raw HTML and images are shown as text, and only http(s) and mailto links are kept. */
const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escape(text),
    image: ({ text }) => escape(text),
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens)
      return linkable(href) ? `<a href="${escape(href)}" target="_blank" rel="noreferrer">${label}</a>` : label
    },
  },
})

const CODE_ACTIONS =
  '<div class="code-actions"><button type="button" class="ghost run-code" title="Paste into the chat\'s terminal">Terminal</button><button type="button" class="ghost copy-code">Copy</button></div>'

const rendered = new Map<string, string>()
export const renderMarkdown = (text: string) => {
  let html = rendered.get(text)
  if (html === undefined) {
    if (rendered.size > 2000) rendered.clear()
    html = marked
      .parse(text, { async: false })
      .replace(/<pre>/g, `<div class="code-block">${CODE_ACTIONS}<pre>`)
      .replace(/<\/pre>/g, '</pre></div>')
    rendered.set(text, html)
  }
  return html
}

/** The code of the block whose `selector` button was clicked, if one was. */
export const clickedCode = (target: EventTarget, selector: string) =>
  (target as Element).closest(selector)?.closest('.code-block')!.querySelector('pre')!.textContent ?? undefined

/** Click handler for rendered markdown: copies the code block whose Copy button was clicked. */
export const copyCode = ({ target }: { target: EventTarget }) => {
  const code = clickedCode(target, '.copy-code')
  if (code === undefined) return
  const button = (target as Element).closest<HTMLElement>('.copy-code')!
  navigator.clipboard.writeText(code).then(() => {
    button.textContent = 'Copied'
    setTimeout(() => (button.textContent = 'Copy'), 1500)
  })
}
