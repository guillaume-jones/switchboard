import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { mutate, run, useQuery, type CardProps } from 'switchboard'
import { useMobile } from './lib/theme'
import { clip, Combobox, linkTone, LinkPicker, NEW, type Option } from './lib/links'

type Todo = {
  id: number
  list: string
  title: string
  description: string
  due: string | null
  tags: string
  position: number
  done: number
  done_at: number | null
}
type Link = {
  item: number
  ref: string
  kind: string
  label: string | null
  title: string
  status: string | null
}

const TAG_TONES: Record<string, string | undefined> = { blocked: 'bad', 'on hold': 'warn', background: 'faint' }
const tagTone = (tag: string) => (tag in TAG_TONES ? TAG_TONES[tag] : 'info')
const SESSION = 'sessions:'
const PROJECT = 'workstreams:'
const DONE_LIMIT = 50
const LEAVE_MS = 200
const LINK = { color: 'inherit', textDecoration: 'none' }

const formatDue = (due: string) =>
  new Date(`${due}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const dueTone = (due: string) => {
  const today = new Date().toLocaleDateString('sv')
  return due < today ? 'bad' : due === today ? 'warn' : undefined
}

const LATER = 'later'
const DIVIDER = -1

/**
 * To-dos of one `list` in `workstreams`, ordered by dragging their handles; each ties together chats, projects and links.
 * With `addCommand`, the add box runs that command with `{ text }` instead of adding a to-do. With `project`, the
 * project's to-dos instead: those in any list but `later` (on Main when in `default`), then those in `later`; dragging
 * across the divider moves a to-do between Now (`default`) and Later.
 */
export default function TodoList({
  list = 'default',
  project,
  addCommand,
  placeholder = 'Add a to-do',
}: CardProps<{ list?: string; project?: number; addCommand?: string; placeholder?: string }>) {
  const rows = useQuery<Todo>(
    project ? 'workstreams_project_items' : 'workstreams_items',
    project ? { project } : { list },
  )
  const projectRef = project && `workstreams:${project}`
  const links = (useQuery<Link>('workstreams_links') ?? []).filter(l => l.ref !== projectRef)
  const tags = (useQuery<{ name: string }>('workstreams_tags') ?? []).map(t => t.name)
  const [moved, setMoved] = useState(new Map<number, { position: number; list: string }>())
  const [open, setOpen] = useState<number>()
  const [showDone, setShowDone] = useState(false)
  const loaded = useRef(false)
  useEffect(() => void (loaded.current ||= !!rows), [rows])
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  const fail = (e: Error) => setError(e.message)

  useEffect(() => {
    if (!rows || !moved.size) return
    const kept = new Map(
      [...moved].filter(([id, at]) => {
        const row = rows.find(r => r.id === id)
        return row?.position !== at.position || row?.list !== at.list
      }),
    )
    if (kept.size !== moved.size) setMoved(kept)
  }, [rows])

  const position = (todo: Todo) => moved.get(todo.id)?.position ?? todo.position
  const listOf = (todo: Todo) => moved.get(todo.id)?.list ?? todo.list
  const pending = (rows ?? []).filter(t => !t.done).sort((a, b) => position(a) - position(b))
  const todos = project ? pending.filter(t => listOf(t) !== LATER) : pending
  const later = project ? pending.filter(t => listOf(t) === LATER) : []
  const order = project ? [...todos.map(t => t.id), DIVIDER, ...later.map(t => t.id)] : todos.map(t => t.id)
  const done = (rows ?? []).filter(t => t.done).sort((a, b) => (b.done_at ?? 0) - (a.done_at ?? 0))

  const move = (id: number, to: number) => {
    const todo = pending.find(t => t.id === id)!
    const others = order.filter(o => o !== id)
    const split = project ? others.indexOf(DIVIDER) : others.length
    const toLater = !!project && to > split
    const neighbour = (i: number) => pending.find(t => t.id === others[i] && others[i] !== DIVIDER)
    const [before, after] = [neighbour(to - 1), neighbour(to)]
    const at =
      before && after
        ? (position(before) + position(after)) / 2
        : before
          ? position(before) + 1
          : after
            ? position(after) - 1
            : 0
    const current = listOf(todo)
    const target = toLater ? LATER : current === LATER ? 'default' : current
    setMoved(m => new Map(m).set(id, { position: at, list: target }))
    mutate('workstreams.move', { id, position: at, list: target }).catch((e: Error) => {
      setMoved(m => (m.delete(id), new Map(m)))
      fail(e)
    })
  }
  const sortable = useSortable(order, move)

  const add = () => {
    if (!title.trim()) return
    const added = addCommand
      ? run(addCommand, { text: title.trim() })
      : project
        ? mutate('workstreams.add_linked', {
            list: LATER,
            title: title.trim(),
            ref: projectRef,
            kind: 'project',
            label: '',
          })
        : mutate('workstreams.add', { list, title: title.trim() })
    added.then(() => setTitle(''), fail)
  }

  const row = (todo: Todo) => (
    <Row
      key={todo.id}
      todo={todo}
      links={links.filter(l => l.item === todo.id)}
      tags={tags}
      open={open === todo.id}
      onToggle={() => setOpen(open === todo.id ? undefined : todo.id)}
      dragging={sortable.dragging === todo.id}
      handle={todo.done ? undefined : sortable.handle(todo.id)}
      appear={loaded.current}
      onError={fail}
    />
  )

  return (
    <div>
      <form
        className="todo-add"
        onSubmit={e => {
          e.preventDefault()
          add()
        }}
      >
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        <button type="submit" className="primary" disabled={!title.trim()}>
          Add
        </button>
      </form>
      {error && (
        <div style={{ padding: '0 10px 6px', color: 'var(--bad)' }} onClick={() => setError('')}>
          {error}
        </div>
      )}
      {rows && pending.length === 0 && <div className="empty idle">Nothing to do</div>}
      {project && pending.length > 0 && (
        <div className="todo-section heading" title="Also on Main">
          Now
        </div>
      )}
      <div ref={sortable.list}>
        {todos.map(row)}
        {project && pending.length > 0 && (
          <div className="todo-section heading" title="Drag a to-do above this line to put it on Main">
            Later
          </div>
        )}
        {later.map(row)}
      </div>
      {done.length > 0 && (
        <div className="show-more">
          <button className="ghost" onClick={() => setShowDone(!showDone)}>
            {showDone ? 'Hide done' : `Show done (${done.length})`}
          </button>
        </div>
      )}
      <div className="collapse" data-open={showDone ? '' : undefined}>
        <div>{done.slice(0, DONE_LIMIT).map(row)}</div>
      </div>
    </div>
  )
}

type Drag = {
  id: number
  from: number
  to: number
  offset: number
  el: HTMLElement
  rows: HTMLElement[]
  tops: number[]
  heights: number[]
  startY: number
  y: number
  startScroll: number
  scroller: HTMLElement
  frame: number
}

const scrollParent = (el: HTMLElement): HTMLElement => {
  for (let node = el.parentElement; node; node = node.parentElement)
    if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node
  return document.scrollingElement as HTMLElement
}

/**
 * Drag to reorder the children of `list`: rows move by transforms written straight to the DOM every frame, so React
 * only renders on pick-up and drop, and the dropped row glides from where it was let go into its new slot.
 */
function useSortable(ids: number[], onMove: (id: number, to: number) => void) {
  const list = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<number>()
  const drag = useRef<Drag | undefined>(undefined)
  const settle = useRef<{ el: HTMLElement; top: number } | undefined>(undefined)

  useLayoutEffect(() => {
    const dropped = settle.current
    if (!dropped || !list.current) return
    settle.current = undefined
    const rows = [...list.current.children] as HTMLElement[]
    rows.forEach(r => Object.assign(r.style, { transition: 'none', transform: '' }))
    dropped.el.style.transform = `translateY(${dropped.top - dropped.el.offsetTop}px)`
    dropped.el.getBoundingClientRect()
    rows.forEach(r => (r.style.transition = ''))
    dropped.el.style.transform = ''
  })

  const layout = (d: Drag) => {
    const last = d.rows.length - 1
    const dy = d.y - d.startY + d.scroller.scrollTop - d.startScroll
    d.offset = Math.max(
      -d.tops[d.from],
      Math.min(d.tops[last] + d.heights[last] - d.tops[d.from] - d.heights[d.from], dy),
    )
    const height = d.heights[d.from]
    const top = d.tops[d.from] + d.offset
    const middle = (i: number) => d.tops[i] + d.heights[i] / 2
    d.to = d.rows.filter((_, i) => (i < d.from ? middle(i) <= top : i > d.from && middle(i) < top + height)).length
    d.rows.forEach((r, i) => {
      const shift = i === d.from ? d.offset : i > d.from && i <= d.to ? -height : i < d.from && i >= d.to ? height : 0
      r.style.transform = shift ? `translateY(${shift}px)` : ''
    })
  }

  const start = (e: ReactPointerEvent<HTMLElement>, id: number) => {
    const from = ids.indexOf(id)
    const rows = [...(list.current?.children ?? [])] as HTMLElement[]
    if (e.button !== 0 || from < 0 || !rows[from]) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const scroller = scrollParent(list.current!)
    const d: Drag = {
      id,
      from,
      to: from,
      offset: 0,
      el: rows[from],
      rows,
      tops: rows.map(r => r.offsetTop),
      heights: rows.map(r => r.offsetHeight),
      startY: e.clientY,
      y: e.clientY,
      startScroll: scroller.scrollTop,
      scroller,
      frame: 0,
    }
    drag.current = d
    setDragging(id)
    navigator.vibrate?.(8)
    const tick = () => {
      const box =
        d.scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : d.scroller.getBoundingClientRect()
      const edge = 48
      const speed = d.y < box.top + edge ? d.y - box.top - edge : d.y > box.bottom - edge ? d.y - box.bottom + edge : 0
      if (speed) d.scroller.scrollTop += Math.max(-20, Math.min(20, speed / 3))
      layout(d)
      d.frame = requestAnimationFrame(tick)
    }
    d.frame = requestAnimationFrame(tick)
  }

  const end = () => {
    const d = drag.current
    if (!d) return
    drag.current = undefined
    cancelAnimationFrame(d.frame)
    layout(d)
    settle.current = { el: d.el, top: d.tops[d.from] + d.offset }
    setDragging(undefined)
    if (d.to !== d.from) onMove(d.id, d.to)
  }

  const handle = (id: number) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => start(e, id),
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => drag.current && (drag.current.y = e.clientY),
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    onKeyDown: (e: KeyboardEvent) => {
      const index = ids.indexOf(id)
      const to = e.key === 'ArrowUp' ? index - 1 : e.key === 'ArrowDown' ? index + 1 : -1
      if (to < 0 || to >= ids.length) return
      e.preventDefault()
      onMove(id, to)
    },
  })

  return { list, dragging, handle }
}

function Row({
  todo,
  links,
  tags,
  open,
  onToggle,
  dragging,
  handle,
  appear,
  onError,
}: {
  todo: Todo
  links: Link[]
  tags: string[]
  open: boolean
  onToggle: () => void
  dragging: boolean
  handle?: ReturnType<ReturnType<typeof useSortable>['handle']>
  appear: boolean
  onError: (e: Error) => void
}) {
  const [entering] = useState(appear)
  const [leaving, setLeaving] = useState(false)
  const [ticked, setTicked] = useState(false)
  const leave = (write: () => Promise<unknown>) => {
    setLeaving(true)
    setTimeout(() => write().catch((e: Error) => (setLeaving(false), setTicked(false), onError(e))), LEAVE_MS)
  }
  const own: string[] = JSON.parse(todo.tags)
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  const chats = links.filter(l => l.kind === 'session')
  const urls = links.filter(l => l.kind === 'url')
  const projects = links.filter(l => l.kind === 'project')
  const focusTitle = useRef<number | undefined>(undefined)
  const countChip = (items: Link[], label: string, tone?: string) =>
    items.length === 1 ? (
      <LinkAnchor link={items[0]} onError={onError} className="badge" data-tone={tone} style={LINK}>
        {label}
      </LinkAnchor>
    ) : (
      items.length > 1 && (
        <span className="badge" data-tone={tone}>
          {label}
        </span>
      )
    )
  const tone = todo.due && !todo.done ? dueTone(todo.due) : undefined
  const client = useMobile() ? 'mobile' : 'desktop'

  const newChat = async () => {
    const prompt = [todo.title, todo.description.trim()].filter(Boolean).join('\n\n')
    const chatLinks = links.filter(l => l.kind !== 'session').map(({ ref, kind, label }) => ({ ref, kind, label }))
    try {
      await mutate('sessions.draft_set', { key: 'NewChat.prompt', text: prompt })
      await mutate('sessions.draft_set', { key: 'NewChat.links', text: JSON.stringify(chatLinks) })
      await mutate('sessions.draft_set', { key: 'NewChat.todo', text: String(todo.id) })
      await mutate('ui.open_chat', { client, session: '' })
    } catch (e) {
      onError(e as Error)
    }
  }

  return (
    <div
      className={['todo-row', dragging && 'dragging', todo.done && 'done', entering && 'appear', leaving && 'leaving']
        .filter(Boolean)
        .join(' ')}
    >
      <div>
        <div className="todo-main" onClick={onToggle}>
          {handle ? (
            <button
              className="icon ghost todo-handle"
              title="Drag to reorder (or ↑/↓)"
              onClick={e => e.stopPropagation()}
              {...handle}
            >
              ⋮⋮
            </button>
          ) : (
            <span style={{ width: 8 }} />
          )}
          <button
            className="todo-check"
            role="checkbox"
            aria-checked={!!todo.done !== ticked}
            title={todo.done ? 'Mark not done' : 'Mark done'}
            onClick={e => {
              e.stopPropagation()
              setTicked(true)
              leave(() => mutate('workstreams.set_done', { id: todo.id, done: todo.done ? 0 : 1 }))
            }}
          >
            ✓
          </button>
          <div className="label">
            {open ? (
              <input
                key={todo.title}
                ref={el => {
                  if (el && focusTitle.current !== undefined) {
                    el.focus()
                    el.setSelectionRange(focusTitle.current, focusTitle.current)
                    focusTitle.current = undefined
                  }
                }}
                defaultValue={todo.title}
                aria-label="Title"
                title="Rename"
                className="inline-edit title"
                style={{ display: 'block', width: '100%', fontWeight: 600 }}
                onClick={e => e.stopPropagation()}
                onKeyDown={e => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    e.currentTarget.value = todo.title
                    e.currentTarget.blur()
                  }
                }}
                onBlur={e => {
                  const title = e.currentTarget.value.trim()
                  if (title && title !== todo.title)
                    mutate('workstreams.update', { id: todo.id, field: 'title', value: title }).catch(onError)
                  else e.currentTarget.value = todo.title
                }}
              />
            ) : (
              <div
                className="title"
                style={{ fontWeight: 600 }}
                onClick={e => {
                  focusTitle.current =
                    document.caretRangeFromPoint?.(e.clientX, e.clientY)?.startOffset ?? todo.title.length
                }}
              >
                {todo.title}
              </div>
            )}
            {todo.description && (
              <div className="collapse" data-open={open ? undefined : ''}>
                <div style={{ color: 'var(--muted)', fontSize: 12, textOverflow: 'ellipsis' }}>
                  {todo.description.split('\n')[0]}
                </div>
              </div>
            )}
            {(own.length > 0 || links.length > 0 || todo.due) && (
              <div className="collapse" data-open={open ? undefined : ''}>
                <div>
                  <div className="todo-chips" style={{ paddingTop: 4 }}>
                    {own.map(tag => (
                      <span key={tag} className="badge" data-tone={tagTone(tag)}>
                        {tag}
                      </span>
                    ))}
                    {projects.map(l => (
                      <LinkAnchor
                        key={l.ref}
                        link={l}
                        onError={onError}
                        className="badge"
                        data-tone={linkTone(l)}
                        style={LINK}
                      >
                        {l.title}
                      </LinkAnchor>
                    ))}
                    {countChip(urls, urls.length > 1 ? `Link ×${urls.length}` : 'Link')}
                    {countChip(chats, chats.length === 1 ? '1 chat' : `${chats.length} chats`)}
                    {todo.due && (
                      <span className="badge" data-tone={tone}>
                        {formatDue(todo.due)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
          <button
            className="icon ghost"
            title="New chat about this to-do"
            onClick={e => {
              e.stopPropagation()
              newChat()
            }}
          >
            ✦
          </button>
          {open && (
            <span className="todo-actions fade-in">
              <button
                className="icon ghost"
                title="Collapse"
                aria-label="Collapse"
                onClick={e => {
                  e.stopPropagation()
                  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
                  onToggle()
                }}
              >
                <CollapseIcon />
              </button>
              <button
                className="icon ghost danger"
                title="Delete"
                aria-label="Delete"
                onClick={e => {
                  e.stopPropagation()
                  if (confirm(`Delete “${todo.title}”?`)) leave(() => mutate('workstreams.delete', { id: todo.id }))
                }}
              >
                <TrashIcon />
              </button>
            </span>
          )}
        </div>
        <div
          className="collapse"
          data-open={open ? '' : undefined}
          onTransitionEnd={e => e.target === e.currentTarget && !open && setMounted(false)}
        >
          <div>
            {mounted && (
              <Details todo={todo} own={own} tags={tags} links={links} onNewChat={newChat} onError={onError} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function LinkAnchor({
  link,
  onError,
  ...rest
}: { link: Link; onError: (e: Error) => void } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'onError'>) {
  const client = useMobile() ? 'mobile' : 'desktop'
  return link.kind === 'session' || link.kind === 'project' ? (
    <a
      href="#"
      title={link.title}
      {...rest}
      onClick={e => {
        e.preventDefault()
        e.stopPropagation()
        if (link.kind === 'project')
          mutate('ui.open_project', { client, project: Number(link.ref.slice(PROJECT.length)) }).catch(onError)
        else mutate('ui.open_chat', { client, session: link.ref.slice(SESSION.length) }).catch(onError)
      }}
    />
  ) : (
    <a
      href={link.ref}
      target="_blank"
      rel="noreferrer"
      title={link.status ? `${link.title} · ${link.status}` : link.ref}
      {...rest}
      onClick={e => e.stopPropagation()}
    />
  )
}

function Details({
  todo,
  own,
  tags,
  links,
  onNewChat,
  onError,
}: {
  todo: Todo
  own: string[]
  tags: string[]
  links: Link[]
  onNewChat: () => void
  onError: (e: Error) => void
}) {
  const update = (field: string, value: string) =>
    mutate('workstreams.update', { id: todo.id, field, value }).catch(onError)
  const setTags = (next: string[]) =>
    mutate('workstreams.set_tags', { id: todo.id, tags: JSON.stringify(next) }).catch(onError)
  const link = (ref: string, kind: string, label: string) =>
    mutate('workstreams.link_add', { item: todo.id, ref, kind, label }).catch(onError)

  return (
    <div className="todo-details">
      <div className="todo-chips">
        <span className="todo-label">Due</span>
        <input
          type="date"
          value={todo.due ?? ''}
          onChange={e => update('due', e.target.value)}
          aria-label="Due date"
          data-empty={todo.due ? undefined : ''}
          style={{ width: 'auto' }}
        />
        {todo.due && (
          <button className="ghost" onClick={() => update('due', '')}>
            Clear
          </button>
        )}
      </div>
      <TagEditor own={own} tags={tags} onChange={setTags} />
      <div className="todo-chips" style={{ alignItems: 'flex-start' }}>
        <span className="todo-label">Links</span>
        <div className="todo-links">
          {links.length > 0 && (
            <div className="todo-chips">
              {links.map(l => (
                <span key={l.ref} className="badge" data-tone={linkTone(l)}>
                  <LinkAnchor link={l} onError={onError} style={LINK}>
                    {l.kind === 'session' && '💬 '}
                    {clip(l.title)}
                  </LinkAnchor>
                  <button
                    title="Unlink"
                    onClick={() => mutate('workstreams.link_remove', { item: todo.id, ref: l.ref }).catch(onError)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="todo-chips" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
            <LinkPicker
              context={`${todo.title} ${todo.description}`}
              linked={links.map(l => l.ref)}
              onPick={l => link(l.ref, l.kind, l.kind === 'session' ? '' : l.label)}
            />
            <button className="primary" onClick={onNewChat}>
              New chat
            </button>
          </div>
        </div>
      </div>
      <div className="todo-chips" style={{ alignItems: 'flex-start' }}>
        <span className="todo-label">Notes</span>
        <textarea
          key={`description:${todo.description}`}
          defaultValue={todo.description}
          placeholder="Add notes"
          aria-label="Notes"
          rows={2}
          style={{ flex: 1, minWidth: 0 }}
          onBlur={e => e.currentTarget.value !== todo.description && update('description', e.currentTarget.value)}
        />
      </div>
    </div>
  )
}

/** The item's tags, then a search over the tag set; a typed tag not in the set joins it. */
function TagEditor({ own, tags, onChange }: { own: string[]; tags: string[]; onChange: (tags: string[]) => void }) {
  const [text, setText] = useState('')
  const needle = text.trim().toLowerCase()
  const matches = tags.filter(t => !own.includes(t) && t.toLowerCase().includes(needle))
  const exists = tags.some(t => t.toLowerCase() === needle)
  const options: Option[] = [
    ...matches.map(t => ({ key: t, badge: t, tone: tagTone(t) })),
    ...(needle && !exists ? [{ key: NEW, badge: 'New tag', label: text.trim() }] : []),
  ]

  return (
    <div className="todo-chips">
      <span className="todo-label">Tags</span>
      {own.map(tag => (
        <span key={tag} className="badge" data-tone={tagTone(tag)}>
          {tag}
          <button title="Remove tag" onClick={() => onChange(own.filter(t => t !== tag))}>
            ×
          </button>
        </span>
      ))}
      <Combobox
        text={text}
        onText={setText}
        placeholder="Add tag"
        options={options}
        onPick={option => {
          onChange([...own, option.key === NEW ? text.trim() : option.key])
          setText('')
        }}
      />
    </div>
  )
}

const CollapseIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 10l4-4 4 4" />
  </svg>
)

const TrashIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.75 6.5v4.5M9.25 6.5v4.5" />
  </svg>
)
