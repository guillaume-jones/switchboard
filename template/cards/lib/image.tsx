import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { mutate, run, useQuery } from 'switchboard'
import { DocPath } from './doc'
import { IMAGE } from './markdown'
import { useMobile } from './theme'

const MAX_SCALE = 16
const UNSENT = 'unsent:'

/** The preview path of a message box's image, which has no file until it is sent. */
export const unsentPath = (id: string) => UNSENT + id
export const isUnsent = (path: string) => path.startsWith(UNSENT)

/**
 * An image as a data URL: an unsent one's upload, or a local file's, staged by `sessions.preview` under its path while
 * mounted. The last one read is kept, as another viewer of the same path (hover and preview) drops the row when it closes.
 */
export function useImage(path: string) {
  const unsent = isUnsent(path)
  const id = unsent ? path.slice(UNSENT.length) : path
  const rows = useQuery<{ name: string; data: string }>('sessions.attachments', { ids: JSON.stringify([id]) })
  const [runId, setRunId] = useState('')
  const [error, setError] = useState('')
  const failed = useQuery<{ state: string }>('core_runs', { id: runId })?.[0]?.state === 'failure'
  const row = rows?.[0]
  const [last, setLast] = useState(row)
  if (row && row.data !== last?.data) setLast(row)
  useEffect(() => {
    if (unsent) return
    run('sessions.preview', { path }).then(setRunId, (e: Error) => setError(e.message))
    return () => void mutate('sessions.detach', { id: path })
  }, [path, unsent])
  const image = row ?? last
  if (image) {
    const type = IMAGE.exec(image.name)?.[1].toLowerCase().replace('jpg', 'jpeg')
    return { src: `data:image/${type};base64,${image.data}`, name: image.name }
  }
  if (unsent && rows) return { error: 'Sent or removed. Open it from the message instead.' }
  return { error: error || (failed ? 'Could not load the image' : '') }
}

/**
 * An image fitted to its box until zoomed by pinching, ⌘ or ⌃ scrolling or double-clicking, then panned by scrolling or
 * dragging, below its path (see `DocPath`).
 */
export function ImageView({ path, cwd }: { path: string; cwd?: string | null }) {
  const mobile = useMobile()
  const { src, name, error } = useImage(path)
  const stage = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  const [natural, setNatural] = useState({ width: 0, height: 0 })
  const [zoomed, setZoomed] = useState<number>()
  const fit = natural.width ? Math.min(1, box.width / natural.width, box.height / natural.height) : 0
  const scale = zoomed ?? fit
  const view = useRef({ fit, scale })
  view.current = { fit, scale }
  const anchor = useRef<{ x: number; y: number; left: number; top: number }>(undefined)

  const zoom = (to: number, x?: number, y?: number) => {
    const { fit, scale } = view.current
    if (!fit || !stage.current || !img.current) return
    const next = Math.min(MAX_SCALE, Math.max(fit, to))
    if (next === scale) return
    const area = stage.current.getBoundingClientRect()
    const shown = img.current.getBoundingClientRect()
    const atX = x ?? area.left + area.width / 2
    const atY = y ?? area.top + area.height / 2
    anchor.current = { x: atX, y: atY, left: (atX - shown.left) / shown.width, top: (atY - shown.top) / shown.height }
    view.current.scale = next
    setZoomed(next === fit ? undefined : next)
  }

  useLayoutEffect(() => {
    const at = anchor.current
    if (!at || !stage.current || !img.current) return
    anchor.current = undefined
    const shown = img.current.getBoundingClientRect()
    stage.current.scrollLeft += shown.left + at.left * shown.width - at.x
    stage.current.scrollTop += shown.top + at.top * shown.height - at.y
  }, [scale])

  useEffect(() => {
    const el = stage.current!
    // The border box, which scrollbars appearing on zoom do not change
    const resize = new ResizeObserver(() => setBox({ width: el.offsetWidth, height: el.offsetHeight }))
    resize.observe(el)
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoom(view.current.scale * Math.exp(-e.deltaY / 100), e.clientX, e.clientY)
    }
    // WebKit reports pinches as gesture events, which have no DOM types
    let from = 0
    const pinchStart = (e: Event) => {
      e.preventDefault()
      from = view.current.scale
    }
    const pinch = (e: Event) => {
      e.preventDefault()
      const { scale, clientX, clientY } = e as Event & { scale: number; clientX: number; clientY: number }
      zoom(from * scale, clientX, clientY)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    el.addEventListener('gesturestart', pinchStart)
    el.addEventListener('gesturechange', pinch)
    return () => {
      resize.disconnect()
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('gesturestart', pinchStart)
      el.removeEventListener('gesturechange', pinch)
    }
  }, [])

  const unsent = isUnsent(path)
  return (
    <div className="doc">
      {!unsent ? <DocPath path={path} cwd={cwd} /> : !mobile && <div className="doc-path ellipsis">{name}</div>}
      <div
        ref={stage}
        className="image-stage"
        data-zoomed={zoomed ? '' : undefined}
        onDoubleClick={e => zoom(zoomed ? fit : fit < 1 ? 1 : 2, e.clientX, e.clientY)}
        onPointerDown={e => {
          if (e.pointerType !== 'mouse' || e.button !== 0 || !zoomed || e.target !== img.current) return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={e => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
          e.currentTarget.scrollLeft -= e.movementX
          e.currentTarget.scrollTop -= e.movementY
        }}
      >
        {src ? (
          <img
            ref={img}
            src={src}
            alt={name}
            draggable={false}
            style={fit ? { width: natural.width * scale, height: natural.height * scale } : { visibility: 'hidden' }}
            onLoad={e => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          />
        ) : (
          <div className="empty">{error || 'Loading…'}</div>
        )}
      </div>
    </div>
  )
}
