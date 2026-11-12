import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { CardSlot, mutate, useQuery, type CardProps } from 'switchboard'

const COLUMNS = 12
const ROW_HEIGHT = 32
const MIN_ROWS = 4

type Geometry = { x: number; y: number; w: number; h: number }
type Tile = Geometry & { id: string; component: string; props: string }
/** The tile being dragged, drawn in place of its stored geometry. `released` once the write has been sent. */
type Drag = Geometry & { id: string; released: boolean }

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const sameGeometry = (a: Geometry, b: Geometry) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

const FRAME: CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  border: '1px solid var(--border)',
  borderRadius: 4,
  overflow: 'hidden',
}
const TITLE_BAR: CSSProperties = {
  display: 'flex',
  padding: '1px 6px',
  fontSize: 11,
  color: 'var(--muted)',
  background: 'var(--panel)',
  cursor: 'move',
}
const REMOVE_BUTTON: CSSProperties = { border: 'none', background: 'none', padding: 0, cursor: 'pointer' }
const RESIZE_HANDLE: CSSProperties = {
  position: 'absolute',
  right: 2,
  bottom: 2,
  width: 10,
  height: 10,
  cursor: 'nwse-resize',
}

export default function Grid({ grid }: CardProps<{ grid: string }>) {
  const rows = useQuery<Tile>('ui.tiles', { grid })
  const tiles = useMemo(
    () => (rows ?? []).map(tile => ({ ...tile, props: JSON.parse(tile.props || '{}') as Record<string, unknown> })),
    [rows],
  )
  const [drag, setDrag] = useState<Drag | null>(null)
  const [adding, setAdding] = useState('')
  const container = useRef<HTMLDivElement>(null)

  // A released tile stays where it was dropped until the write comes back as new rows, instead of snapping back.
  useEffect(() => setDrag(current => (current?.released ? null : current)), [rows])

  const startDrag = (e: ReactPointerEvent<HTMLElement>, tile: Geometry & { id: string }, mode: 'move' | 'resize') => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const cellWidth = container.current!.clientWidth / COLUMNS
    const origin = { x: e.clientX, y: e.clientY }
    let latest: Drag = { ...tile, released: false }

    const onMove = (move: PointerEvent) => {
      const dx = Math.round((move.clientX - origin.x) / cellWidth)
      const dy = Math.round((move.clientY - origin.y) / ROW_HEIGHT)
      const next =
        mode === 'resize'
          ? { ...latest, w: clamp(tile.w + dx, 1, COLUMNS - tile.x), h: Math.max(1, tile.h + dy) }
          : { ...latest, x: clamp(tile.x + dx, 0, COLUMNS - tile.w), y: Math.max(0, tile.y + dy) }
      if (sameGeometry(next, latest)) return
      latest = next
      setDrag(next)
    }

    const onRelease = () => {
      handle.removeEventListener('pointermove', onMove)
      if (sameGeometry(latest, tile)) {
        setDrag(null)
        return
      }
      setDrag({ ...latest, released: true })
      const { x, y, w, h } = latest
      mutate('ui.tile_set', { grid, id: tile.id, x, y, w, h }).then(
        changes => {
          if (changes === 0) setDrag(null)
        },
        () => setDrag(null),
      )
    }

    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('lostpointercapture', onRelease, { once: true })
  }

  const boxes = tiles.map(tile => (drag?.id === tile.id ? { ...tile, ...drag } : tile))
  const height = Math.max(MIN_ROWS, ...boxes.map(box => box.y + box.h)) * ROW_HEIGHT

  return (
    <div style={{ padding: 8 }}>
      <div ref={container} style={{ position: 'relative', height }}>
        {boxes.map(box => (
          <div
            key={box.id}
            style={{
              position: 'absolute',
              left: `${(box.x / COLUMNS) * 100}%`,
              width: `${(box.w / COLUMNS) * 100}%`,
              top: box.y * ROW_HEIGHT,
              height: box.h * ROW_HEIGHT,
              padding: 2,
              boxSizing: 'border-box',
            }}
          >
            <div style={FRAME}>
              <div onPointerDown={e => startDrag(e, box, 'move')} style={TITLE_BAR}>
                <span style={{ flex: 1 }}>{box.component}</span>
                <button
                  title="Remove"
                  onPointerDown={e => e.stopPropagation()}
                  onClick={() => mutate('ui.tile_remove', { grid, id: box.id })}
                  style={REMOVE_BUTTON}
                >
                  ×
                </button>
              </div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                <CardSlot component={box.component} props={box.props} id={`${grid}/${box.id}`} />
              </div>
            </div>
            <div onPointerDown={e => startDrag(e, box, 'resize')} style={RESIZE_HANDLE} />
          </div>
        ))}
      </div>
      <form
        onSubmit={e => {
          e.preventDefault()
          const component = adding.trim()
          if (component) {
            mutate('ui.tile_add', { grid, id: `${component}-${Date.now().toString(36)}`, component, props: '{}' })
          }
          setAdding('')
        }}
      >
        <input
          value={adding}
          onChange={e => setAdding(e.target.value)}
          placeholder="Add card by name"
          style={{ width: 200 }}
        />
      </form>
    </div>
  )
}
