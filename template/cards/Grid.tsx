import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { CardSlot, mutate, useCards, useQuery, type CardProps } from 'switchboard'

const COLUMNS = 24
const LIST_ROW_HEIGHT = 16
const GAP = 4
const MIN_ROWS = 4

type Geometry = { x: number; y: number; w: number; h: number }
type Tile = Geometry & { id: string; component: string; props: string; list_h: number | null }
type DefaultTile = Tile & { grid: string }
/** The tile being dragged, drawn in place of its stored geometry. `released` once the write has been sent. */
type Drag = Geometry & { id: string; released: boolean }

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
/** A tile's `title` prop, else its card's name in words. */
const heading = (tile: { component: string; props: Record<string, unknown> }) =>
  typeof tile.props.title === 'string' ? tile.props.title : tile.component.replace(/([a-z])([A-Z])/g, '$1 $2')
const sameGeometry = (a: Geometry, b: Geometry) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

/** Sized by its content, up to most of the screen, so cards that scroll internally still fit. */
const LIST_TILE: CSSProperties = { height: 'auto', maxHeight: '85dvh' }
const TOOLBAR: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, padding: `2px ${GAP}px 6px` }
/** A corner grip drawn inside the tile's bottom-right corner, with a larger hit area than it looks. */
const RESIZE_HANDLE: CSSProperties = {
  position: 'absolute',
  right: GAP + 2,
  bottom: GAP + 2,
  width: 18,
  height: 18,
  touchAction: 'none',
  cursor: 'nwse-resize',
  background:
    'linear-gradient(135deg, transparent 55%, var(--muted) 55%, var(--muted) 62%, transparent 62%, transparent 75%, var(--muted) 75%, var(--muted) 82%, transparent 82%)',
  opacity: 0.7,
}

/**
 * A card `<Name>` may come with a `<Name>Header` card, rendered with the same props in its tile bar.
 * Tiles placed on a 24-column grid of square cells, or with `layout: "list"` stacked full width in reading order (`y`, then `x`),
 * where they cannot be moved.
 */
export default function Grid({ grid, layout }: CardProps<{ grid: string; layout?: 'list' }>) {
  const rows = useQuery<Tile>('ui.tiles', { grid })
  const defaults = useQuery<DefaultTile>('ui_defaults', { grid })
  const tiles = useMemo(
    () => (rows ?? []).map(tile => ({ ...tile, props: JSON.parse(tile.props || '{}') as Record<string, unknown> })),
    [rows],
  )
  const cards = useCards()
  const [drag, setDrag] = useState<Drag | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const [cell, setCell] = useState(0)

  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const observer = new ResizeObserver(() => setCell(element.clientWidth / COLUMNS))
    observer.observe(element)
    return () => observer.disconnect()
  }, [layout])

  // A released tile stays where it was dropped until the write comes back as new rows, instead of snapping back.
  useEffect(() => setDrag(current => (current?.released ? null : current)), [rows])

  const startDrag = (e: ReactPointerEvent<HTMLElement>, tile: Geometry & { id: string }, mode: 'move' | 'resize') => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const origin = { x: e.clientX, y: e.clientY }
    let latest: Drag = { ...tile, released: false }

    const onMove = (move: PointerEvent) => {
      const dx = Math.round((move.clientX - origin.x) / cell)
      const dy = Math.round((move.clientY - origin.y) / cell)
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

  const missingDefaults =
    rows !== undefined && defaults?.some(tile => !rows.some(row => row.component === tile.component))
  const toolbar = missingDefaults && (
    <div style={TOOLBAR}>
      <button
        type="button"
        className="primary"
        title="Replace this board's tiles with the template's default cards"
        onClick={() => mutate('ui.reset', { grid })}
      >
        Restore default cards
      </button>
    </div>
  )
  const header = (tile: { id: string; component: string; props: Record<string, unknown> }) =>
    cards.includes(`${tile.component}Header`) && (
      <div className="tile-header" onPointerDown={e => e.stopPropagation()}>
        <CardSlot
          component={`${tile.component}Header`}
          props={tile.props}
          size="compact"
          id={`${grid}/${tile.id}/header`}
        />
      </div>
    )
  if (layout === 'list') {
    return (
      <div
        style={{
          padding: '10px 10px calc(32px + var(--bottom-edge, 0px))',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {toolbar}
        {tiles.length === 0 && <div className="empty">No cards on this board</div>}
        {tiles.map(tile => (
          <div
            key={tile.id}
            className="tile fade-in"
            style={tile.list_h ? { ...LIST_TILE, height: tile.list_h * LIST_ROW_HEIGHT } : LIST_TILE}
          >
            <div className="tile-bar" data-card={tile.component}>
              <span className="heading">{heading(tile)}</span>
              {header(tile)}
            </div>
            <div style={{ overflow: 'auto' }}>
              <CardSlot component={tile.component} props={tile.props} id={`${grid}/${tile.id}`} />
            </div>
          </div>
        ))}
      </div>
    )
  }
  const boxes = tiles.map(tile => (drag?.id === tile.id ? { ...tile, ...drag } : tile))
  const height = Math.max(MIN_ROWS, ...boxes.map(box => box.y + box.h + 1)) * cell

  return (
    <div style={{ padding: 6, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {toolbar}
      {tiles.length === 0 && rows !== undefined && <div className="empty">No cards on this board</div>}
      <div ref={container} style={{ position: 'relative', flex: 1, minHeight: height }}>
        {boxes.map(box => (
          <div
            key={box.id}
            style={{
              position: 'absolute',
              left: `${(box.x / COLUMNS) * 100}%`,
              width: `${(box.w / COLUMNS) * 100}%`,
              top: box.y * cell,
              height: box.h * cell,
              padding: GAP,
              boxSizing: 'border-box',
              zIndex: drag?.id === box.id ? 1 : undefined,
            }}
          >
            <div className={drag?.id === box.id ? 'tile fade-in dragging' : 'tile fade-in'}>
              <div
                data-drag
                onPointerDown={e => startDrag(e, box, 'move')}
                className="tile-bar"
                data-card={box.component}
              >
                <span className="heading">{heading(box)}</span>
                {header(box)}
              </div>
              <div style={{ flex: 1, overflow: 'auto' }}>
                <CardSlot component={box.component} props={box.props} id={`${grid}/${box.id}`} />
              </div>
            </div>
            <div onPointerDown={e => startDrag(e, box, 'resize')} style={RESIZE_HANDLE} />
          </div>
        ))}
      </div>
    </div>
  )
}
