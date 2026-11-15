import { useMemo, type CSSProperties } from 'react'
import { CardSlot, mutate, useExpose, useQuery } from 'switchboard'

type Board = { id: string; title: string; component: string; props: string; current: number }

/** Shown until the first board is added with `ui.add_board`. */
const IMPLICIT_MAIN: Board = { id: 'main', title: 'Main', component: 'Grid', props: '{"grid":"main"}', current: 1 }

const NAV: CSSProperties = { display: 'flex', gap: 4, padding: '4px 8px' }
const CURRENT_TAB: CSSProperties = { borderColor: 'var(--accent)', color: 'var(--accent)' }

export default function Boards() {
  const rows = useQuery<Board>('ui.boards')
  const boards = rows?.length === 0 ? [IMPLICIT_MAIN] : (rows ?? [])
  const current = boards.find(board => board.current) ?? boards[0]
  useExpose({ board: current?.id })
  const props = useMemo(() => JSON.parse(current?.props || '{}'), [current?.props])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <nav style={NAV}>
        {boards.map(board => (
          <button
            key={board.id}
            onClick={() => mutate('ui.set_board', { id: board.id })}
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
