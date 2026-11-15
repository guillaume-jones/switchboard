import { useMemo, type CSSProperties } from 'react'
import { CardSlot, mutate, useExpose, useQuery, type CardProps } from 'switchboard'

type Board = { id: string; title: string; component: string; props: string; current: number }

/** Shown until the first board is added with `ui.add_board`. */
const IMPLICIT_MAIN: Board = { id: 'main', title: 'Main', component: 'Grid', props: '{"grid":"main"}', current: 1 }

/** Leaves room on the right for the Health chip `Root` floats there. */
const NAV: CSSProperties = {
  display: 'flex',
  gap: 4,
  padding: '4px 72px 4px 8px',
  overflowX: 'auto',
  whiteSpace: 'nowrap',
}
const CURRENT_TAB: CSSProperties = { borderColor: 'var(--accent)', color: 'var(--accent)' }

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
    <div>
      <nav style={NAV}>
        {boards.map(board => (
          <button
            key={board.id}
            onClick={() => mutate('ui.set_board', { client, id: board.id })}
            style={board === current ? CURRENT_TAB : undefined}
          >
            {board.title}
          </button>
        ))}
      </nav>
      {current && <CardSlot key={current.id} component={current.component} props={props} id={`board:${current.id}`} />}
    </div>
  )
}
