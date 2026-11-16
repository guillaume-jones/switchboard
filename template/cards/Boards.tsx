import { useMemo, type CSSProperties } from 'react'
import { CardSlot, mutate, useExpose, useQuery, type CardProps } from 'switchboard'
import { TONES, type Session } from './lib/sessions'

type Board = { id: string; title: string; component: string; props: string; current: number }

/** Shown until the first board is added with `ui.add_board`. */
const IMPLICIT_MAIN: Board = { id: 'main', title: 'Main', component: 'Grid', props: '{"grid":"main"}', current: 1 }

/** Leaves room on the right for the Health chip `Root` floats there. */
const NAV: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 88px 4px 10px',
  overflowX: 'auto',
  whiteSpace: 'nowrap',
  scrollbarWidth: 'none',
  flexShrink: 0,
}

const TAB_TITLE: CSSProperties = { maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }

/**
 * Tabs over the boards; every board but `main` can be closed (`ui.close_board`), and transcript tabs take their
 * session's state colour. Each `client` (`desktop`, `mobile`) has its own current board; on `mobile` the board gets
 * `layout: "list"`.
 */
export default function Boards({ client }: CardProps<{ client: string }>) {
  const rows = useQuery<Board>('ui.boards', { client })
  const boards = rows?.length === 0 ? [IMPLICIT_MAIN] : (rows ?? [])
  const current = boards.find(board => board.current) ?? boards[0]
  useExpose({ board: current?.id, client })
  const props = useMemo(
    () => ({ ...JSON.parse(current?.props || '{}'), ...(client === 'mobile' && { layout: 'list' }) }),
    [current?.props, client],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <nav style={NAV}>
        {boards.map(board => {
          const tab = { board, client, current: board === current }
          const session = board.component === 'Transcript' ? JSON.parse(board.props || '{}').session : undefined
          return session ? <SessionTab key={board.id} {...tab} session={session} /> : <Tab key={board.id} {...tab} />
        })}
      </nav>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          overscrollBehavior: 'contain',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {current && (
          <CardSlot key={current.id} component={current.component} props={props} id={`board:${current.id}`} />
        )}
      </div>
    </div>
  )
}

type TabProps = { board: Board; client: string; current: boolean; title?: string; tone?: string }

function Tab({ board, client, current, title = board.title, tone }: TabProps) {
  return (
    <button
      className="ghost tab"
      data-tone={tone}
      aria-current={current ? 'page' : undefined}
      onClick={() => mutate('ui.set_board', { client, id: board.id })}
      title={title}
    >
      <span style={TAB_TITLE}>{title}</span>
      {board.id !== IMPLICIT_MAIN.id && (
        <span
          role="button"
          className="tab-close"
          title="Close"
          aria-label={`Close ${title}`}
          onClick={e => {
            e.stopPropagation()
            mutate('ui.close_board', { id: board.id })
          }}
        >
          ×
        </span>
      )}
    </button>
  )
}

/** A transcript's tab, titled and coloured by its session's current title and state. */
function SessionTab({ session, ...tab }: TabProps & { session: string }) {
  const row = useQuery<Session>('sessions_items', { id: session })?.[0]
  return <Tab {...tab} title={row?.title} tone={row && TONES[row.status]} />
}
