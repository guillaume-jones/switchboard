import { run } from 'switchboard'
import { Marked, type Token, type Tokens } from './marked'
import { OCTICONS, type Octicon } from './octicons'

const escape = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const linkable = (href: string) => /^(https?:|mailto:)/i.test(href)
export const IMAGE = /\.(png|jpe?g|gif|webp)$/i
export const DOC = /\.(md|markdown|html?|txt)$/i
export const HTML = /\.html?$/i
export const TXT = /\.txt$/i
const localFile = (href: string) => /^(~?\/|\.\.?\/)/.test(href) && (IMAGE.test(href) || DOC.test(href))
/**
 * A chip for a local file: an image, Markdown, HTML or .txt file's opens in the chat's preview, see `copyCode`, and an image's
 * also shows it when hovered (tapped on phones outside a chat), see `ImagePeek`.
 */
export const fileChip = (path: string, label = escape(path.split('/').pop()!)) =>
  `<button type="button" class="chip file" data-local="${escape(path)}"${IMAGE.test(path) ? ' data-image' : DOC.test(path) ? ' data-doc' : ''} title="${escape(path)}">${label}</button>`

const svg = (name: Octicon) =>
  `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${OCTICONS[name]}</svg>`
const SECTION_ACTIONS = `<span class="section-actions"><button type="button" class="ghost icon small quote-section" title="Add to chat" aria-label="Add section to chat">${svg('reply')}</button><button type="button" class="ghost icon small copy-section" title="Copy this section" aria-label="Copy section">${svg('copy')}</button></span>`

/** Markdown to HTML for agent text. Raw HTML is shown as text, local images as chips, and only http(s) and mailto links are kept. */
const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: ({ text }) => escape(text),
    // marked leaves text after an inline <code>, <pre>, <kbd> or <script> tag unescaped
    text(token) {
      if ('escaped' in token) token.escaped = false
      return false
    },
    image: ({ href, text }) => (localFile(href) ? fileChip(href, text ? escape(text) : undefined) : escape(text)),
    heading(token) {
      const { tokens, depth, section } = token as Tokens.Heading & { section: string }
      return `<h${depth} data-section="${section}">${this.parser.parseInline(tokens)}${SECTION_ACTIONS}</h${depth}>\n`
    },
    paragraph(token) {
      const { tokens, section } = token as Tokens.Paragraph & { section?: string }
      return section
        ? `<p data-section="${section}">${this.parser.parseInline(tokens)}${SECTION_ACTIONS}</p>\n`
        : `<p>${this.parser.parseInline(tokens)}</p>\n`
    },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens)
      if (localFile(href)) return fileChip(href, label)
      return linkable(href) ? `<a href="${escape(href)}" target="_blank" rel="noreferrer">${label}</a>` : label
    },
  },
})

const CODE_ACTIONS =
  '<div class="code-actions"><button type="button" class="ghost run-code" title="Paste into the chat\'s terminal">Terminal</button><button type="button" class="ghost copy-code">Copy</button></div>'

const LOCAL_PATH = /(^|[\s(;])(~?\/(?:[\w.@+-]+\/)+[\w.@+-]*[\w@+-]|\.\.?\/(?:[\w.@+-]+\/)*[\w.@+-]*[\w@+-])/g
const linkPaths = (html: string) => {
  let skip = 0
  return html
    .split(/(<[^>]+>)/)
    .map(part => {
      if (part.startsWith('<')) {
        if (/^<(pre|a|button)[\s>]/.test(part)) skip++
        else if (/^<\/(pre|a|button)>/.test(part)) skip--
        return part
      }
      return skip
        ? part
        : part.replace(
            LOCAL_PATH,
            (_, before: string, path: string) =>
              before +
              (IMAGE.test(path) || DOC.test(path)
                ? fileChip(path)
                : `<a data-local="${path}" title="Open on this computer">${path}</a>`),
          )
    })
    .join('')
}

/**
 * Each top-level block's HTML, its first tag marked with the source lines it came from (`data-lines="3-5"`), and each
 * heading with those of its section, up to the next heading as high or higher. A paragraph of only bold text (and maybe
 * a colon) is a heading below all others.
 */
const renderBlocks = (text: string) => {
  const source = text.replace(/\r\n|\r/g, '\n')
  const tokens = marked.lexer(source)
  const newlines = (from: number, to: number) => {
    let count = 0
    for (let i = source.indexOf('\n', from); i >= 0 && i < to; i = source.indexOf('\n', i + 1)) count++
    return count
  }
  let at = 0
  let line = 1
  const blocks = tokens
    .map(token => {
      const found = source.indexOf(token.raw, at)
      if (found >= 0) {
        line += newlines(at, found)
        at = found
      }
      const start = line
      const end = start + token.raw.trimEnd().split('\n').length - 1
      if (found >= 0) {
        line += newlines(at, at + token.raw.length)
        at += token.raw.length
      }
      return { token, start, end }
    })
    .filter(b => b.token.type !== 'space')
  const depthOf = ({ token }: (typeof blocks)[number]) => {
    if (token.type === 'heading') return (token as Tokens.Heading).depth
    const [first, ...rest] = token.type === 'paragraph' ? (token as Tokens.Paragraph).tokens : []
    return first?.type === 'strong' && rest.every(t => t.type === 'text' && /^:?\s*$/.test(t.raw)) ? 7 : undefined
  }
  blocks.forEach((block, i) => {
    const depth = depthOf(block)
    if (depth === undefined) return
    const next = blocks.findIndex((b, j) => j > i && (depthOf(b) ?? Infinity) <= depth)
    const end = (next < 0 ? blocks.at(-1)! : blocks[next - 1]).end
    Object.assign(block.token, { section: `${block.start}-${end}` })
  })
  return blocks
    .map(({ token, start, end }) =>
      marked
        .parser(Object.assign([token] as Token[], { links: tokens.links }))
        .replace(/^<(\w+)/, `<$1 data-lines="${start}-${end}"`),
    )
    .join('')
}

const rendered = new Map<string, string>()
/**
 * Markdown to HTML, see `renderBlocks`; a click handler for it is `copyCode`. Cached by text unless `cache` is false,
 * for text that changes in place like a watched file.
 */
export const renderMarkdown = (text: string, cache = true) => {
  let html = rendered.get(text)
  if (html === undefined) {
    html = linkPaths(renderBlocks(text))
      .replace(/<pre( data-lines="[^"]*")?>/g, `<div class="code-block"$1>${CODE_ACTIONS}<pre>`)
      .replace(/<\/pre>/g, '</pre></div>')
    if (!cache) return html
    if (rendered.size > 2000) rendered.clear()
    rendered.set(text, html)
  }
  return html
}

/** `path` with a leading `./` or `../` resolved against the folder `base`, if given. */
export const resolvePath = (path: string, base?: string) => {
  if (!base || !/^\.\.?\//.test(path)) return path
  const parts = base.replace(/\/$/, '').split('/')
  for (const part of path.split('/'))
    if (part === '..') parts.pop()
    else if (part !== '.') parts.push(part)
  return parts.join('/')
}

/** `path` as `./…` when inside the folder `base`, else as given. */
export const relativePath = (path: string, base?: string | null) =>
  base && path.startsWith(`${base.replace(/\/$/, '')}/`) ? `.${path.slice(base.replace(/\/$/, '').length)}` : path

/** Lines `start`-`end` (1-based, inclusive) of `text`. */
export const sourceLines = (text: string, lines: string) => {
  const [start, end] = lines.split('-').map(Number)
  return text
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .slice(start - 1, end)
    .join('\n')
    .trim()
}

/** `text` as a Markdown quote, after a `[path:lines]` reference when it comes from a file. */
export const quote = (text: string, ref?: string) =>
  (ref ? `[${ref}]\n` : '') +
  text
    .trim()
    .split('\n')
    .map(line => `> ${line}`.trimEnd())
    .join('\n')

/** Asks the chat around `from` to add `text` to its message box, see `SessionTranscript`; false if none did. */
export const sendQuote = (from: Element, text: string) =>
  !from.dispatchEvent(new CustomEvent('quote', { bubbles: true, cancelable: true, detail: text }))

/** Asks the chat around `from` to show the Markdown, HTML, .txt or image file `path` in its preview; false if none did. */
export const sendOpenDoc = (from: Element, path: string) =>
  !from.dispatchEvent(new CustomEvent('open-doc', { bubbles: true, cancelable: true, detail: path }))

const flash = (button: HTMLElement, done: string) => {
  const was = button.innerHTML
  button.innerHTML = done
  setTimeout(() => (button.innerHTML = was), 1500)
}

/** The code of the block whose `selector` button was clicked, if one was. */
export const clickedCode = (target: EventTarget, selector: string) =>
  (target as Element).closest(selector)?.closest('.code-block')!.querySelector('pre')!.textContent ?? undefined

/**
 * Click handler for markdown rendered from `source`: opens a clicked local path (a Markdown, HTML, .txt or image file in the chat's preview),
 * copies or quotes the section of a heading's button, or copies the code block whose Copy button was clicked. Quotes
 * from inside a `[data-doc-path]` element reference its lines in that file.
 */
export const copyCode = ({ target }: { target: EventTarget }, source?: string) => {
  const element = target as Element
  const chip = element.closest<HTMLElement>('[data-local]')
  const local = chip && resolvePath(chip.dataset.local!, chip.closest<HTMLElement>('[data-cwd]')?.dataset.cwd)
  if (local && !(chip!.matches('[data-doc], [data-image]') && sendOpenDoc(chip!, local)))
    if (!document.documentElement.hasAttribute('data-mobile') && !/^\.\.?\//.test(local))
      run('sessions.reveal', { path: local })
  const sectionButton = element.closest<HTMLElement>('.copy-section, .quote-section')
  const heading = sectionButton?.closest<HTMLElement>('[data-section]')
  if (sectionButton && heading) {
    const lines = heading.dataset.section!
    const text = source === undefined ? (heading.textContent ?? '') : sourceLines(source, lines)
    const path = heading.closest<HTMLElement>('[data-doc-path]')?.dataset.docPath
    if (sectionButton.classList.contains('copy-section'))
      navigator.clipboard.writeText(text).then(() => flash(sectionButton, svg('check')))
    else if (sendQuote(sectionButton, quote(text, path && `${path}:${lines}`))) flash(sectionButton, svg('check'))
  }
  const code = clickedCode(target, '.copy-code')
  if (code === undefined) return
  const button = (target as Element).closest<HTMLElement>('.copy-code')!
  navigator.clipboard.writeText(code).then(() => {
    button.textContent = 'Copied'
    setTimeout(() => (button.textContent = 'Copy'), 1500)
  })
}
