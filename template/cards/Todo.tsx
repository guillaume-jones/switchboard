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
import { Disclosure } from './lib/disclosure'
import { Icon } from './lib/icons'
import { useMobile } from './lib/theme'
import { clip, linkTone, LinkPicker } from './lib/links'

type Todo = {
  id: number
  list: string
  title: string
  description: string
  due: string | null
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
  project_folder?: string | null
}

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

const NOW = 'default'
const LATER = 'later'
/** The sections below Now. Their headers are sorted along with the to-dos, under negative ids. */
const GROUPS = [
  { id: -1, list: LATER, label: 'Later' },
  { id: -2, list: 'blocked', label: 'Blocked' },
]

/**
 * To-dos from `workstreams`, ordered by dragging their handles; each ties together chats, projects, PRs and links. The main
 * list and a project's (`project`) split into Now, Later and Blocked: a drag moves between them, and dropping on a
 * collapsed section's header puts the to-do on top of it. Any other `list` is flat. With `addCommand`, the add box runs
 * that command with `{ text }` instead of adding a to-do.
 */
export default function TodoList({
  list = NOW,
  project,
  addCommand,
  placeholder = 'Add a to-do',
  slot,
}: CardProps<{ list?: string; project?: number; addCommand?: string; placeholder?: string }>) {
  const sectioned = !!project || list === NOW
  const rows = useQuery<Todo>(
    project ? 'workstreams_project_items' : sectioned ? 'workstreams_todos' : 'workstreams_items',
    project ? { project } : sectioned ? {} : { list },
  )
  const projectRef = project && `workstreams:${project}`
  const allLinks = useQuery<Link>('workstreams_links') ?? []
  const expandedKey = `Todo.expanded:${slot}`
  const [expanded, setExpanded] = useState<string[]>(() =>
    JSON.parse(localStorage.getItem(expandedKey) ?? JSON.stringify(project ? [LATER] : [])),
  )
  const [folding, setFolding] = useState<string[]>([])
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
  const groups = sectioned ? GROUPS : []
  const sectionOf = (todo: Todo) => groups.find(g => g.list === listOf(todo))?.list ?? NOW
  const inSection = (section: string) => pending.filter(t => sectionOf(t) === section)
  const now = inSection(NOW)
  const sections = groups.map(g => {
    const todos = inSection(g.list)
    const shown = expanded.includes(g.list)
    return { ...g, todos, shown, rendered: shown || folding.includes(g.list) }
  })
  const order = [...now.map(t => t.id), ...sections.flatMap(g => [g.id, ...(g.rendered ? g.todos.map(t => t.id) : [])])]
  const done = (rows ?? []).filter(t => t.done).sort((a, b) => (b.done_at ?? 0) - (a.done_at ?? 0))

  const move = (id: number, to: number) => {
    const todo = pending.find(t => t.id === id)!
    const others = order.filter(o => o !== id)
    const section = sections.findLast(g => others.slice(0, to).includes(g.id))?.list ?? NOW
    const [before, after] = [to - 1, to].map(i => pending.find(t => t.id === others[i]))
    const rest = inSection(section).filter(t => t.id !== id)
    const at =
      before && after
        ? (position(before) + position(after)) / 2
        : before
          ? position(before) + 1
          : after
            ? position(after) - 1
            : rest.length
              ? position(rest[0]) - 1
              : 0
    const target = sectionOf(todo) === section ? listOf(todo) : section
    setMoved(m => new Map(m).set(id, { position: at, list: target }))
    mutate('workstreams.move', { id, position: at, list: target }).catch((e: Error) => {
      setMoved(m => (m.delete(id), new Map(m)))
      fail(e)
    })
  }
  const sortable = useSortable(order, move)
  const toggle = (section: string) => {
    const shown = expanded.includes(section)
    const next = shown ? expanded.filter(s => s !== section) : [...expanded, section]
    if (shown) {
      setFolding(f => [...f, section])
      setTimeout(() => setFolding(f => f.filter(s => s !== section)), LEAVE_MS)
    }
    setExpanded(next)
    localStorage.setItem(expandedKey, JSON.stringify(next))
  }

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

  const row = (todo: Todo, folded = false) => (
    <Row
      key={todo.id}
      todo={todo}
      links={allLinks.filter(l => l.item === todo.id && l.ref !== projectRef)}
      cwd={allLinks.find(l => l.item === todo.id && l.project_folder)?.project_folder ?? ''}
      open={open === todo.id}
      onToggle={() => setOpen(open === todo.id ? undefined : todo.id)}
      dragging={sortable.dragging === todo.id}
      handle={todo.done ? undefined : sortable.handle(todo.id)}
      appear={loaded.current}
      folded={folded}
      onError={fail}
    />
  )

  return (
    <div className="todo-list">
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
      {sectioned && <div className="todo-now">Now</div>}
      <div ref={sortable.list}>
        {/* one array, so a row dragged into another section keeps its element */}
        {[
          ...now.map(t => row(t)),
          ...sections.flatMap(({ id, list, label, todos, shown, rendered }) => {
            return [
              <button
                key={id}
                className="ghost disclosure"
                data-collapsed={rendered ? undefined : ''}
                aria-expanded={shown}
                onClick={() => toggle(list)}
              >
                <Icon name="chevron-right" />
                {label} <span className="count">{todos.length}</span>
              </button>,
              ...(rendered ? todos.map(t => row(t, !shown)) : []),
            ]
          }),
        ]}
      </div>
      {done.length > 0 && (
        <Disclosure label="Done" count={done.length} open={showDone} onToggle={() => setShowDone(!showDone)}>
          {done.slice(0, DONE_LIMIT).map(t => row(t))}
        </Disclosure>
      )}
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
  bounds: DOMRect[] // on screen when picked up
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
 * only renders on pick-up and drop, and the dropped row glides from where it was let go into its new slot. A child
 * marked `data-collapsed` takes drops on itself: it stays put until the pointer is past it, and lights up under it.
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
    if (!dropped.el.isConnected) {
      requestAnimationFrame(() => rows.forEach(r => (r.style.transition = '')))
      return
    }
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
    let to = d.rows.filter((_, i) => (i < d.from ? middle(i) <= top : i > d.from && middle(i) < top + height)).length
    const pointer = d.y + d.scroller.scrollTop - d.startScroll
    d.rows.forEach((r, i) => {
      if (i === d.from || r.dataset.collapsed === undefined) return
      const below = i > d.from
      const { top, bottom } = d.bounds[i]
      if (pointer >= top && pointer <= bottom) to = below ? i : i + 1
      else if (below && pointer < top) to = Math.min(to, i - 1)
      else if (!below && pointer > bottom) to = Math.max(to, i + 1)
    })
    d.to = to
    const previous = d.rows.filter((_, i) => i !== d.from)[to - 1]
    const into = previous?.dataset.collapsed !== undefined ? previous : undefined
    d.el.toggleAttribute('data-into', !!into)
    d.rows.forEach((r, i) => {
      r.toggleAttribute('data-drop', r === into)
      const shift =
        i === d.from ? d.offset : into ? 0 : i > d.from && i <= to ? -height : i < d.from && i >= to ? height : 0
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
      bounds: rows.map(r => r.getBoundingClientRect()),
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
    d.el.removeAttribute('data-into')
    d.rows.forEach(r => r.removeAttribute('data-drop'))
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
  cwd,
  open,
  onToggle,
  dragging,
  handle,
  appear,
  folded,
  onError,
}: {
  todo: Todo
  links: Link[]
  cwd: string
  open: boolean
  onToggle: () => void
  dragging: boolean
  handle?: ReturnType<ReturnType<typeof useSortable>['handle']>
  appear: boolean
  folded: boolean
  onError: (e: Error) => void
}) {
  const [entering] = useState(appear)
  const [leaving, setLeaving] = useState(false)
  const [ticked, setTicked] = useState(false)
  const leave = (write: () => Promise<unknown>) => {
    setLeaving(true)
    setTimeout(() => write().catch((e: Error) => (setLeaving(false), setTicked(false), onError(e))), LEAVE_MS)
  }
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  const chats = links.filter(l => l.kind === 'session')
  const projects = links.filter(l => l.kind === 'project')
  const prs = links.filter(l => l.kind === 'pr')
  const urls = links.filter(l => l.kind === 'url')
  const focusTitle = useRef<number | undefined>(undefined)
  const collapse = () => open && onToggle()
  const countChip = (items: Link[], label: string, tone?: string) =>
    items.length === 1 ? (
      <LinkAnchor link={items[0]} onError={onError} onOpen={collapse} className="badge" data-tone={tone} style={LINK}>
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
      await mutate('sessions.draft_set', { key: 'NewChat.cwd', text: cwd })
      await mutate('ui.open_chat', { client, session: '' })
    } catch (e) {
      onError(e as Error)
    }
  }

  return (
    <div
      className={[
        'todo-row',
        dragging && 'dragging',
        todo.done && 'done',
        entering && 'appear',
        (leaving || folded) && 'leaving',
        folded && 'folded',
      ]
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
                style={{ display: 'block' }}
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
                <div className="todo-note">{todo.description.split('\n')[0]}</div>
              </div>
            )}
            {(links.length > 0 || todo.due) && (
              <div className="collapse" data-open={open ? undefined : ''}>
                <div>
                  <div className="todo-chips" style={{ paddingTop: 4 }}>
                    {projects.map(l => (
                      <LinkAnchor
                        key={l.ref}
                        link={l}
                        onError={onError}
                        onOpen={collapse}
                        className="badge"
                        data-tone={linkTone(l)}
                        style={LINK}
                      >
                        <Icon name="briefcase" />
                        {clip(l.title)}
                      </LinkAnchor>
                    ))}
                    {countChip(chats, chats.length === 1 ? '1 chat' : `${chats.length} chats`)}
                    {countChip(prs, prs.length === 1 ? '1 PR' : `${prs.length} PRs`)}
                    {countChip(urls, urls.length === 1 ? '1 link' : `${urls.length} links`)}
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
          {!open && (
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
          )}
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
            {mounted && <Details todo={todo} links={links} onNewChat={newChat} onOpen={collapse} onError={onError} />}
          </div>
        </div>
      </div>
    </div>
  )
}

function LinkAnchor({
  link,
  onError,
  onOpen,
  ...rest
}: {
  link: Link
  onError: (e: Error) => void
  onOpen?: () => void
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'onError'>) {
  const client = useMobile() ? 'mobile' : 'desktop'
  return link.kind === 'session' || link.kind === 'project' ? (
    <a
      href="#"
      title={link.title}
      {...rest}
      onClick={e => {
        e.preventDefault()
        e.stopPropagation()
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        onOpen?.()
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
  links,
  onNewChat,
  onOpen,
  onError,
}: {
  todo: Todo
  links: Link[]
  onNewChat: () => void
  onOpen: () => void
  onError: (e: Error) => void
}) {
  const update = (field: string, value: string) =>
    mutate('workstreams.update', { id: todo.id, field, value }).catch(onError)
  const link = (ref: string, kind: string, label: string) =>
    mutate('workstreams.link_add', { item: todo.id, ref, kind, label }).catch(onError)

  return (
    <div className="todo-details">
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
      <div className="todo-chips" style={{ alignItems: 'flex-start' }}>
        <span className="todo-label">Links</span>
        <div className="todo-links">
          {links.length > 0 && (
            <div className="todo-chips">
              {links.map(l => (
                <span key={l.ref} className="badge" data-tone={linkTone(l)}>
                  {l.kind === 'project' && <Icon name="briefcase" />}
                  <LinkAnchor link={l} onError={onError} onOpen={onOpen} style={LINK}>
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
      <div className="todo-chips">
        <span className="todo-label">Due</span>
        <input
          key={`due:${todo.due}`}
          type="date"
          defaultValue={todo.due ?? ''}
          onBlur={e => e.currentTarget.value !== (todo.due ?? '') && update('due', e.currentTarget.value)}
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
