import { useMemo, type CSSProperties } from 'react'
import { CardSlot, mutate, useExpose, useQuery, type CardProps } from 'switchboard'

type Board = { id: string; title: string; component: string; props: string; current: number }

/** Shown until the first board is added with `ui.add_board`. */
const IMPLICIT_MAIN: Board = { id: 'main', title: 'Main', component: 'Grid', props: '{"grid":"main"}', current: 1 }

/** Leaves room on the right for the Health chip `Root` floats there. */
const NAV: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '8px 88px 4px 10px',
  overflowX: 'auto',
  whiteSpace: 'nowrap',
  scrollbarWidth: 'none',
}

/**
 * Tabs over the boards. Each `client` (`desktop`, `mobile`) has its own current board; on `mobile` the board gets
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
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <nav style={NAV}>
        {boards.map(board => (
          <button
            key={board.id}
            className="ghost"
            aria-current={board === current ? 'page' : undefined}
            onClick={() => mutate('ui.set_board', { client, id: board.id })}
          >
            {board.title}
          </button>
        ))}
      </nav>
      {current && <CardSlot key={current.id} component={current.component} props={props} id={`board:${current.id}`} />}
    </div>
  )
}
