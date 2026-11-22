import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { CardSlot, mutate, run, useExpose, useQuery, type CardProps } from 'switchboard'
import { TONES, useArchive, type Session } from './lib/sessions'
import { ArchiveIcon, ChevronIcon, Icon, TerminalIcon } from './lib/icons'
import { useFindKey } from './lib/theme'

type Board = { id: string; title: string; component: string; props: string; current: number }
type ProjectItem = { id: number; title: string; done: number; folder: string | null; created_at: number }
type Terminal = { name: string; cwd: string | null; chat: string | null }

/** Shown until the first board is added with `ui.add_board`. */
const IMPLICIT_MAIN: Board = { id: 'main', title: 'Main', component: 'Grid', props: '{"grid":"main"}', current: 1 }
const SESSIONS = 50
const ARCHIVED = 100
/** How far from the left edge of a phone a swipe opens the drawer, in px. */
const EDGE = 28
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/**
 * The app shell: a sidebar of dashboards (every board but `Transcript` ones; all but `main` can be closed) and chats
 * (a new chat, recent sessions, then archived ones), both filtered by a search box, with Health at its foot, next to
 * the current board. Each `client` (`desktop`,
 * `mobile`) has its own current board and one chat board, `chat-<client>`, that `ui.open_chat` points at a session or
 * at a new chat. On `mobile` the sidebar is a drawer that follows a swipe from
 * the left edge, and the board gets `layout: "list"`.
 */
export default function Boards({ client }: CardProps<{ client: string }>) {
  const rows = useQuery<Board>('ui.boards', { client })
  const boards = rows?.length === 0 ? [IMPLICIT_MAIN] : (rows ?? [])
  const current = boards.find(board => board.current) ?? boards[0]
  const [drawer, setDrawer] = useState(false)
  const [dragged, setDragged] = useState<number | null>(null)
  const panel = useRef<HTMLElement>(null)
  const drawerOpen = useRef(drawer)
  drawerOpen.current = drawer
  const mobile = client === 'mobile'
  const notified = !!useQuery('sessions_notified')?.length

  useEffect(() => {
    if (!mobile) return
    let gesture: { x: number; y: number; width: number; from: number; shown?: number } | null = null
    const start = (e: TouchEvent) => {
      const { clientX: x, clientY: y } = e.touches[0]
      gesture =
        e.touches.length > 1 || (!drawerOpen.current && x > EDGE)
          ? null
          : { x, y, width: panel.current?.offsetWidth || 300, from: drawerOpen.current ? 1 : 0 }
    }
    const move = (e: TouchEvent) => {
      if (!gesture) return
      const dx = e.touches[0].clientX - gesture.x
      const dy = e.touches[0].clientY - gesture.y
      if (gesture.shown === undefined) {
        if (Math.hypot(dx, dy) < 10) return
        if (Math.abs(dy) > Math.abs(dx) || (gesture.from && dx > 0)) {
          gesture = null
          return
        }
      }
      e.preventDefault()
      gesture.shown = clamp(gesture.from + dx / gesture.width, 0, 1)
      setDragged(gesture.shown)
    }
    const end = () => {
      if (gesture?.shown !== undefined) setDrawer(gesture.from ? gesture.shown > 0.8 : gesture.shown > 0.2)
      gesture = null
      setDragged(null)
    }
    document.addEventListener('touchstart', start, { passive: true })
    document.addEventListener('touchmove', move, { passive: false })
    document.addEventListener('touchend', end)
    document.addEventListener('touchcancel', end)
    return () => {
      document.removeEventListener('touchstart', start)
      document.removeEventListener('touchmove', move)
      document.removeEventListener('touchend', end)
      document.removeEventListener('touchcancel', end)
    }
  }, [mobile])

  const drawerMoving = drawer || dragged !== null
  useEffect(() => {
    if (drawerMoving && document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }, [drawerMoving])

  const shown = dragged ?? (drawer ? 1 : 0)
  const easing = dragged === null ? '.25s cubic-bezier(.2, .8, .2, 1)' : '0s'
  const drawerStyle: CSSProperties | undefined = mobile
    ? {
        transform: shown === 1 ? 'none' : `translateX(calc(${(shown - 1) * 100}% - ${shown ? 0 : 60}px))`,
        transition: `transform ${easing}`,
      }
    : undefined
  useExpose({ board: current?.id, client })
  const props = useMemo(
    () => ({ ...JSON.parse(current?.props || '{}'), ...(mobile && { layout: 'list' }) }),
    [current?.props, mobile],
  )
  const chat = current?.component === 'Transcript' ? (props.session ?? '') : undefined

  const sidebar = (
    <Sidebar
      boards={boards.filter(board => !['Transcript', 'Terminal', 'Project'].includes(board.component))}
      current={chat === undefined ? current?.id : undefined}
      chat={chat}
      client={client}
      onPick={() => setDrawer(false)}
      panel={panel}
      style={drawerStyle}
    />
  )
  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {mobile && (
        <div
          className="backdrop"
          style={{ opacity: shown, pointerEvents: shown ? 'auto' : 'none', transition: `opacity ${easing}` }}
          onClick={() => setDrawer(false)}
        />
      )}
      {sidebar}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {mobile && (
          <div
            className={chat !== undefined || current?.component === 'Project' ? 'mobile-bar floating' : 'mobile-bar'}
          >
            <button
              className="ghost icon"
              title="Menu"
              aria-label="Menu"
              onClick={() => setDrawer(true)}
              style={{ position: 'relative' }}
            >
              ☰
              {notified && (
                <span className="dot" style={{ position: 'absolute', top: 6, right: 6, background: 'var(--notify)' }} />
              )}
            </button>
            {chat === undefined && current?.component !== 'Project' && (
              <span className="heading">{current?.title}</span>
            )}
          </div>
        )}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            overscrollBehavior: 'contain',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {current && (
            <CardSlot
              key={`${current.id}/${chat ?? ''}`}
              component={current.component}
              props={props}
              id={`board:${current.id}`}
            />
          )}
        </div>
      </div>
    </div>
  )
}

type SidebarProps = {
  boards: Board[]
  current?: string
  chat?: string
  client: string
  onPick: () => void
  panel: RefObject<HTMLElement | null>
  style?: CSSProperties
}

function Sidebar({ boards, current, chat, client, onPick, panel, style }: SidebarProps) {
  const [showArchived, setShowArchived] = useState(false)
  const [search, setSearch] = useState('')
  useFindKey(panel, () => panel.current?.querySelector<HTMLInputElement>('.sidebar-top input')?.select())
  const needle = search.trim().toLowerCase()
  const matches = (...texts: (string | null)[]) => !needle || texts.some(text => text?.toLowerCase().includes(needle))
  const archivedShown = showArchived || !!needle
  const sessions = (useQuery<Session>('sessions.recent', { limit: SESSIONS, hidden: 0 }) ?? []).filter(s =>
    matches(s.title, s.cwd),
  )
  const archived = (
    useQuery<Session>('sessions.recent', { limit: archivedShown ? ARCHIVED : 0, hidden: 1 }) ?? []
  ).filter(s => matches(s.title, s.cwd))
  const dashboards = boards.filter(board => matches(board.title))
  const [showDoneProjects, setShowDoneProjects] = useState(false)
  const [naming, setNaming] = useState(false)
  const projects = (useQuery<ProjectItem>('workstreams_items', { list: 'projects' }) ?? [])
    .filter(p => matches(p.title, p.folder))
    .sort((a, b) => b.created_at - a.created_at)
  const openProjects = projects.filter(p => !p.done)
  const doneProjects = projects.filter(p => p.done)
  const doneShown = showDoneProjects || !!needle
  const pick = (write: string, args: Record<string, string | number>) => {
    mutate(write, args).catch(console.error)
    onPick()
  }
  const openChat = (session: string) => pick('ui.open_chat', { client, session })
  const archive = useArchive(client)
  const terminals = useQuery<Terminal>('term_items')
  const shownTerminals = (terminals ?? []).filter(t => !t.chat && matches(t.name, t.cwd))
  const openTerminal = (name: string, cwd: string, chat: string) => {
    run('term.open', { name, cwd, chat }).catch(console.error)
    pick('ui.open_terminal', { client, name })
  }
  const sessionItem = (session: Session, isArchived: boolean) => {
    const finished = new Date(session.updated.replace(' ', 'T'))
    const finishedLabel = ['working', 'waiting'].includes(session.status)
      ? ''
      : finished.toDateString() === new Date().toDateString()
        ? finished.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : finished.toLocaleDateString([], { month: 'short', day: 'numeric' })
    return (
      <NavItem
        key={session.id}
        current={chat === session.id}
        onClick={() => openChat(session.id)}
        title={`${session.title}\n${session.status.replace('_', ' ')} · ${session.cwd ?? 'No folder'} · ${session.updated}`}
        action={
          <button
            title={isArchived ? 'Unarchive' : 'Archive'}
            aria-label={isArchived ? 'Unarchive' : 'Archive'}
            className="ghost icon small hover-action"
            onClick={() =>
              (isArchived
                ? mutate('sessions.unhide', { id: session.id })
                : archive(session.id, chat === session.id)
              ).catch(console.error)
            }
          >
            <ArchiveIcon unarchive={isArchived} />
          </button>
        }
      >
        <span className="nav-icon">
          <span
            className="dot"
            data-tone={TONES[session.status]}
            data-status={session.status}
            data-notified={session.notified ? '' : undefined}
          />
        </span>
        <span className="label">
          {session.title}
          <span className="sub">
            {session.cwd?.split('/').pop() || 'No folder'}
            {finishedLabel && ` · ${finishedLabel}`}
          </span>
        </span>
      </NavItem>
    )
  }

  return (
    <nav className="sidebar" ref={panel} style={style}>
      <div className="sidebar-top">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => e.key === 'Escape' && setSearch('')}
          placeholder="Search"
          aria-label="Search dashboards and chats"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      <div className="sidebar-scroll">
        <div className="sidebar-section">
          <span className="heading">Dashboards</span>
          {needle && dashboards.length === 0 && <span className="sub nav-note">No matches</span>}
          {dashboards.map(board => (
            <NavItem
              key={board.id}
              current={board.id === current}
              onClick={() => pick('ui.set_board', { client, id: board.id })}
              title={board.title}
              action={
                board.id !== IMPLICIT_MAIN.id && (
                  <button
                    title="Close"
                    aria-label={`Close ${board.title}`}
                    className="ghost icon small hover-action"
                    onClick={() => mutate('ui.close_board', { id: board.id }).catch(console.error)}
                  >
                    ×
                  </button>
                )
              }
            >
              <span className="nav-icon">
                <GridIcon />
              </span>
              <span className="label">{board.title}</span>
            </NavItem>
          ))}
        </div>
        <div className="sidebar-section">
          <div className="heading">
            Projects
            <button
              title="New project"
              aria-label="New project"
              className="ghost icon small"
              onClick={() => setNaming(true)}
            >
              <PlusIcon />
            </button>
          </div>
          {naming && (
            <form
              onSubmit={e => {
                e.preventDefault()
                const title = new FormData(e.currentTarget).get('title')?.toString().trim()
                setNaming(false)
                if (title)
                  mutate('workstreams.add', { list: 'projects', title })
                    .then(() => pick('ui.open_project', { client, project: 0 }))
                    .catch(console.error)
              }}
            >
              <input
                name="title"
                autoFocus
                placeholder="Project name"
                aria-label="Project name"
                style={{ width: '100%' }}
                onBlur={e => !e.currentTarget.value.trim() && setNaming(false)}
                onKeyDown={e => e.key === 'Escape' && setNaming(false)}
              />
            </form>
          )}
          {needle && projects.length === 0 && <span className="sub nav-note">No matches</span>}
          {[...openProjects, ...(doneShown ? doneProjects : [])].map(p => (
            <NavItem
              key={p.id}
              current={current === `project:${p.id}`}
              onClick={() => pick('ui.open_project', { client, project: p.id })}
              title={p.folder ? `${p.title}\n${p.folder}` : p.title}
            >
              <span className="nav-icon">
                <Icon name="briefcase" size={12} />
              </span>
              <span className="label" style={p.done ? { opacity: 0.6, textDecoration: 'line-through' } : undefined}>
                {p.title}
                {p.folder && <span className="sub">{p.folder.split('/').pop()}</span>}
              </span>
            </NavItem>
          ))}
          {doneProjects.length > 0 && !needle && (
            <NavItem current={false} onClick={() => setShowDoneProjects(!showDoneProjects)} title="Done projects">
              <span className="nav-icon">
                <ChevronIcon open={doneShown} />
              </span>
              <span className="label" style={{ opacity: 0.6 }}>
                Done
              </span>
            </NavItem>
          )}
        </div>
        <div className="sidebar-section">
          <div className="heading">
            Chats
            <button
              title="New chat"
              aria-label="New chat"
              className="ghost icon small"
              aria-pressed={chat === ''}
              onClick={() => openChat('')}
            >
              <PlusIcon />
            </button>
          </div>
          {needle && sessions.length === 0 && <span className="sub nav-note">No matches</span>}
          {sessions.map(session => sessionItem(session, false))}
          <NavItem current={false} onClick={() => setShowArchived(!showArchived)} title="Archived chats">
            <span className="nav-icon">
              <ChevronIcon open={archivedShown} />
            </span>
            <span className="label" style={{ opacity: 0.6 }}>
              Archived
            </span>
          </NavItem>
          {archivedShown && archived.length === 0 && (
            <span className="sub nav-note">{needle ? 'No matches' : 'No archived chats'}</span>
          )}
          {archivedShown && archived.map(session => sessionItem(session, true))}
        </div>
        <div className="sidebar-section">
          <div className="heading">
            Terminals
            <button
              title="New terminal"
              aria-label="New terminal"
              className="ghost icon small"
              onClick={() => {
                const taken = new Set((terminals ?? []).map(t => t.name))
                let n = 1
                while (taken.has(`t${n}`)) n++
                openTerminal(`t${n}`, '', '')
              }}
            >
              <PlusIcon />
            </button>
          </div>
          {needle && shownTerminals.length === 0 && <span className="sub nav-note">No matches</span>}
          {shownTerminals.map(t => (
            <NavItem
              key={t.name}
              current={current === `term:${t.name}`}
              onClick={() => openTerminal(t.name, t.cwd ?? '', '')}
              title={`${t.name}\n${t.cwd ?? ''}`}
              action={
                <button
                  title="Close"
                  aria-label={`Close terminal ${t.name}`}
                  className="ghost icon small hover-action"
                  onClick={() => {
                    const away = current === `term:${t.name}` ? mutate('ui.next_board', { client }) : Promise.resolve()
                    away.then(() => run('term.close', { name: t.name })).catch(console.error)
                  }}
                >
                  ×
                </button>
              }
            >
              <span className="nav-icon">
                <TerminalIcon size={12} />
              </span>
              <span className="label">
                {t.name}
                <span className="sub">{t.cwd?.split('/').pop() || '~'}</span>
              </span>
            </NavItem>
          ))}
        </div>
      </div>
      <div className="sidebar-footer">
        <CardSlot component="Health" id="health" />
      </div>
    </nav>
  )
}

type NavItemProps = {
  current: boolean
  onClick: () => void
  title: string
  action?: ReactNode
  children: ReactNode
}

/** A row that acts as a button; `action` is a button of its own whose clicks don't reach the row. */
function NavItem({ current, onClick, title, action, children }: NavItemProps) {
  const onKeyDown = (e: KeyboardEvent) => e.target === e.currentTarget && e.key === 'Enter' && onClick()
  return (
    <div
      role="button"
      tabIndex={0}
      className="nav-item"
      aria-current={current ? 'page' : undefined}
      title={title}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {children}
      {action && <span onClick={e => e.stopPropagation()}>{action}</span>}
    </div>
  )
}

function PlusIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M6 1.5v9M1.5 6h9" />
    </svg>
  )
}

function GridIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1" y="1" width="4" height="4" rx="1" />
      <rect x="7" y="1" width="4" height="4" rx="1" />
      <rect x="1" y="7" width="4" height="4" rx="1" />
      <rect x="7" y="7" width="4" height="4" rx="1" />
    </svg>
  )
}
