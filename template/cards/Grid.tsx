import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { CardSlot, mutate, useCards, useQuery, type CardProps } from 'switchboard'

const COLUMNS = 12
const ROW_HEIGHT = 32
const GAP = 4
const MIN_ROWS = 4
/** Cards that only work with props a bare tile doesn't pass, so the card picker leaves them out. */
const STRUCTURAL_CARDS = ['Root', 'Boards', 'Grid']

type Geometry = { x: number; y: number; w: number; h: number }
type Tile = Geometry & { id: string; component: string; props: string }
type DefaultTile = Tile & { grid: string }
/** The tile being dragged, drawn in place of its stored geometry. `released` once the write has been sent. */
type Drag = Geometry & { id: string; released: boolean }

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const sameGeometry = (a: Geometry, b: Geometry) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

/** Sized by its content, up to most of the screen, so cards that scroll internally still fit. */
const LIST_TILE: CSSProperties = { height: undefined, maxHeight: '75dvh' }
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
 * Tiles placed on a 12-column grid, or with `layout: "list"` stacked full width in reading order (`y`, then `x`),
 * where they can be added and removed but not moved.
 */
export default function Grid({ grid, layout }: CardProps<{ grid: string; layout?: 'list' }>) {
  const rows = useQuery<Tile>('ui.tiles', { grid })
  const defaults = useQuery<DefaultTile>('ui_defaults', { grid })
  const tiles = useMemo(
    () => (rows ?? []).map(tile => ({ ...tile, props: JSON.parse(tile.props || '{}') as Record<string, unknown> })),
    [rows],
  )
  const [drag, setDrag] = useState<Drag | null>(null)
  const [adding, setAdding] = useState('')
  const [picking, setPicking] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const query = adding.trim().toLowerCase()
  const matches = useCards().filter(card => !STRUCTURAL_CARDS.includes(card) && card.toLowerCase().includes(query))
  const choice = matches[Math.min(highlighted, matches.length - 1)]
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

  const missingDefaults =
    rows !== undefined && defaults?.some(tile => !rows.some(row => row.component === tile.component))
  const addTile = (component: string) => {
    mutate('ui.tile_add', { grid, id: `${component}-${Date.now().toString(36)}`, component, props: '{}' })
    setAdding('')
    setPicking(false)
  }
  const toolbar = (
    <form
      style={TOOLBAR}
      onSubmit={e => {
        e.preventDefault()
        if (choice) addTile(choice)
      }}
    >
      <div style={{ position: 'relative', flex: '1 1 160px', maxWidth: 280, minWidth: 0 }}>
        <input
          value={adding}
          onChange={e => {
            setAdding(e.target.value)
            setHighlighted(0)
            setPicking(true)
          }}
          onFocus={() => setPicking(true)}
          onBlur={() => setPicking(false)}
          onKeyDown={e => {
            const step = { ArrowDown: 1, ArrowUp: -1 }[e.key]
            if (step) {
              e.preventDefault()
              setPicking(true)
              setHighlighted(index => clamp(index + step, 0, matches.length - 1))
            } else if (e.key === 'Escape') setPicking(false)
          }}
          placeholder="Add a card…"
          role="combobox"
          aria-expanded={picking}
          style={{ width: '100%' }}
        />
        {picking && matches.length > 0 && (
          <div className="menu" role="listbox">
            {matches.map(card => (
              <div
                key={card}
                role="option"
                aria-selected={card === choice}
                className="menu-item"
                onPointerDown={e => e.preventDefault()}
                onPointerEnter={() => setHighlighted(matches.indexOf(card))}
                onClick={() => addTile(card)}
              >
                {card}
              </div>
            ))}
          </div>
        )}
      </div>
      <button type="submit" disabled={!query || !choice}>
        Add card
      </button>
      {missingDefaults && (
        <button
          type="button"
          className="primary"
          title="Replace this board's tiles with the template's default cards"
          onClick={() => mutate('ui.reset', { grid })}
        >
          Restore default cards
        </button>
      )}
    </form>
  )
  const removeButton = (id: string) => (
    <button
      title="Remove"
      aria-label="Remove"
      className="ghost icon danger"
      onPointerDown={e => e.stopPropagation()}
      onClick={() => mutate('ui.tile_remove', { grid, id })}
    >
      ×
    </button>
  )

  if (layout === 'list') {
    return (
      <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {toolbar}
        {tiles.length === 0 && <div className="empty">No cards on this board</div>}
        {tiles.map(tile => (
          <div key={tile.id} className="tile" style={LIST_TILE}>
            <div className="tile-bar">
              <span className="heading">{tile.component}</span>
              {removeButton(tile.id)}
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
  const height = Math.max(MIN_ROWS, ...boxes.map(box => box.y + box.h)) * ROW_HEIGHT

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
              top: box.y * ROW_HEIGHT,
              height: box.h * ROW_HEIGHT,
              padding: GAP,
              boxSizing: 'border-box',
              zIndex: drag?.id === box.id ? 1 : undefined,
            }}
          >
            <div className={drag?.id === box.id ? 'tile dragging' : 'tile'}>
              <div data-drag onPointerDown={e => startDrag(e, box, 'move')} className="tile-bar">
                <span className="heading">{box.component}</span>
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
    </div>
  )
}
