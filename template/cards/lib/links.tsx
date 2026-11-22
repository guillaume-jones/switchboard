import { useMemo, useState } from 'react'
import { useQuery } from 'switchboard'
import { TONES } from './sessions'

const PR_TONES: Record<string, string> = {
  needs_action: 'warn',
  ready: 'good',
  awaiting_review: 'accent',
  draft: 'faint',
  merged: 'good',
  closed: 'bad',
}
const CHIP_CHARS = 32
export const clip = (text: string) => (text.length > CHIP_CHARS ? `${text.slice(0, CHIP_CHARS - 1).trimEnd()}…` : text)
export const linkTone = (link: { kind: string; status?: string | null }) =>
  link.kind === 'session'
    ? TONES[link.status ?? '']
    : link.kind === 'pr'
      ? PR_TONES[link.status ?? '']
      : link.kind === 'project'
        ? 'accent'
        : undefined

const parseLink = (text: string) => {
  if (!/^https?:\/\/\S+$/.test(text)) return undefined
  const pr = text.match(/^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/)
  if (pr) return { ref: pr[0], kind: 'pr', label: `${pr[1]}#${pr[2]}` }
  return { ref: text, kind: 'url', label: new URL(text).hostname }
}

export type Linkable = { ref: string; kind: string; label: string; title?: string; status?: string | null }

export const KIND_NAMES: Record<string, string> = {
  session: 'Chat',
  pr: 'PR',
  url: 'Link',
  project: 'Project',
}

const SUGGESTIONS = 12
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]+-\d+|[a-z0-9]{3,}/g))

/**
 * Candidates sharing words with `context` first, each shared word weighted by how few candidates contain it, so
 * identifiers and distinctive words count and common ones barely do; ties keep the query's most-recent-first order.
 */
const rankByContext = (candidates: Linkable[], context: string) => {
  const wanted = words(context)
  const tokens = candidates.map(c => words(`${c.label} ${c.title ?? ''}`))
  const counts = new Map<string, number>()
  for (const set of tokens) for (const w of set) if (wanted.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1)
  const score = (set: Set<string>) => [...set].reduce((sum, w) => sum + (counts.has(w) ? 1 / counts.get(w)! : 0), 0)
  const scores = new Map(candidates.map((c, i) => [c, score(tokens[i])]))
  return [...candidates].sort((a, b) => scores.get(b)! - scores.get(a)!)
}

/**
 * One box for every kind of link: `workstreams.linkables` (chats, open PRs and projects; any source that joins it later)
 * ranked by `rankByContext` and narrowed by every typed word, and a pasted URL offered as a link of its own.
 */
export function LinkPicker({
  context,
  linked,
  onPick,
}: {
  context: string
  linked: string[]
  onPick: (link: Linkable) => void
}) {
  const [text, setText] = useState('')
  const pasted = parseLink(text.trim())
  const all = useQuery<Linkable>('workstreams.linkables', { text: '', limit: 500 })
  const ranked = useMemo(
    () =>
      rankByContext(
        (all ?? []).filter(c => !linked.includes(c.ref)),
        context,
      ),
    [all, linked.join(), context],
  )
  const typed = text.toLowerCase().split(/\s+/).filter(Boolean)
  const found = pasted
    ? []
    : ranked
        .filter(c => typed.every(w => `${c.label} ${c.title ?? ''}`.toLowerCase().includes(w)))
        .slice(0, SUGGESTIONS)
  const candidates: Linkable[] = [...(pasted && !linked.includes(pasted.ref) ? [pasted] : []), ...found]
  const options: Option[] = candidates.map(c => ({
    key: c.ref,
    badge: c === pasted ? `Add ${KIND_NAMES[c.kind]}` : KIND_NAMES[c.kind],
    tone: linkTone(c),
    label: c.title ?? c.label,
  }))

  return (
    <Combobox
      text={text}
      onText={setText}
      placeholder="Search chats, PRs and projects, or paste a link"
      options={options}
      onPick={option => {
        onPick(candidates.find(c => c.ref === option.key)!)
        setText('')
      }}
    />
  )
}

const DROPDOWN = { top: 'calc(100% + 4px)', bottom: 'auto', maxHeight: 220 } as const
export type Option = { key: string; badge: string; tone?: string; label?: string }

/** A text box whose options float over what follows it; `.todo-row:focus-within` stops the row clipping them. */
export function Combobox({
  text,
  onText,
  placeholder,
  options,
  onPick,
}: {
  text: string
  onText: (text: string) => void
  placeholder: string
  options: Option[]
  onPick: (option: Option) => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const shown = open && options.length > 0
  const pick = (option: Option) => {
    onPick(option)
    setActive(0)
  }

  return (
    <div style={{ position: 'relative', flex: '1 1 160px', minWidth: 0 }}>
      <input
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        role="combobox"
        aria-expanded={shown}
        autoComplete="off"
        style={{ width: '100%' }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={e => {
          onText(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setOpen(true)
            if (options.length) setActive(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
          } else if (e.key === 'Enter' && shown) {
            e.preventDefault()
            pick(options[Math.min(active, options.length - 1)])
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            setOpen(false)
          }
        }}
      />
      {shown && (
        <div className="folder-list fade-in" role="listbox" style={DROPDOWN}>
          {options.map((option, i) => (
            <button
              key={option.key}
              role="option"
              aria-selected={i === active}
              onMouseDown={e => {
                e.preventDefault()
                pick(option)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="badge" data-tone={option.tone}>
                {option.badge}
              </span>
              {option.label && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{option.label}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
