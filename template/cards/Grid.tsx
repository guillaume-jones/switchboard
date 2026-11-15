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
/** Sized by its content, up to most of the screen, so cards that scroll internally still fit. */
const LIST_TILE: CSSProperties = { ...FRAME, height: undefined, maxHeight: '75dvh' }
const REMOVE_BUTTON: CSSProperties = { border: 'none', background: 'none', padding: 0, cursor: 'pointer' }
/** A corner grip drawn inside the tile's bottom-right corner, with a larger hit area than it looks. */
const RESIZE_HANDLE: CSSProperties = {
  position: 'absolute',
  right: 2,
  bottom: 2,
  width: 16,
  height: 16,
  cursor: 'nwse-resize',
  background:
    'linear-gradient(135deg, transparent 55%, var(--muted) 55%, var(--muted) 62%, transparent 62%, transparent 75%, var(--muted) 75%, var(--muted) 82%, transparent 82%)',
  opacity: 0.7,
}

/**
 * Tiles placed on a 12-column grid, or with `layout: "list"` stacked full width in reading order (`y`, then `x`),
 * where they can be added and removed but not moved.
 */
export default function Grid({ grid, layout }: CardProps<{ grid: string; layout?: 'list' }>) {
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

  const addForm = (
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
  )
  const removeButton = (id: string) => (
    <button
      title="Remove"
      onPointerDown={e => e.stopPropagation()}
      onClick={() => mutate('ui.tile_remove', { grid, id })}
      style={REMOVE_BUTTON}
    >
      ×
    </button>
  )

  if (layout === 'list') {
    return (
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tiles.map(tile => (
          <div key={tile.id} style={LIST_TILE}>
            <div style={{ ...TITLE_BAR, cursor: undefined }}>
              <span style={{ flex: 1 }}>{tile.component}</span>
              {removeButton(tile.id)}
            </div>
            <div style={{ overflow: 'auto' }}>
              <CardSlot component={tile.component} props={tile.props} id={`${grid}/${tile.id}`} />
            </div>
          </div>
        ))}
        {addForm}
      </div>
    )
  }
  const boxes = tiles.map(tile => (drag?.id === tile.id ? { ...tile, ...drag } : tile))
  const height = Math.max(MIN_ROWS, ...boxes.map(box => box.y + box.h)) * ROW_HEIGHT

  return (
    <div style={{ padding: 8, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div ref={container} style={{ position: 'relative', flex: 1, minHeight: height }}>
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
                {removeButton(box.id)}
              </div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                <CardSlot component={box.component} props={box.props} id={`${grid}/${box.id}`} />
              </div>
            </div>
            <div onPointerDown={e => startDrag(e, box, 'resize')} style={RESIZE_HANDLE} />
          </div>
        ))}
      </div>
      {addForm}
    </div>
  )
}
