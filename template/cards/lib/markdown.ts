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

export const renderMarkdown = (text: string) => marked.parse(text, { async: false })
