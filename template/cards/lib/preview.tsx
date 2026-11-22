import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Icon } from './icons'
import { useMobile } from './theme'

const MIN_WIDTH = 20
const MAX_WIDTH = 80

export type PreviewTab = { key: string; label: string; title?: string; icon?: ReactNode; content: ReactNode }

/**
 * `children` beside tabs of previews, shown while `open` and any tab exists. They slide open and closed at their final
 * width unless already open on mount, and their width (percent, kept per `id`) is dragged from their left edge. Only
 * the `active` tab is mounted. On phones the previews replace `children` instead, until `onCollapse` (the chevron right
 * of the tabs).
 */
export function Preview({
  id,
  open: wanted,
  tabs,
  active,
  onSelect,
  onClose,
  onCollapse,
  children,
}: {
  id: string
  open: boolean
  tabs: PreviewTab[]
  active?: string
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onCollapse: () => void
  children: ReactNode
}) {
  const mobile = useMobile()
  const open = wanted && tabs.length > 0
  const [phase, setPhase] = useState<'shown' | 'opening' | 'closing' | 'hidden'>(open ? 'shown' : 'hidden')
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    setPhase(mobile ? (open ? 'shown' : 'hidden') : open ? 'opening' : 'closing')
  }
  const shown = useRef({ tabs, active })
  if (open) shown.current = { tabs, active }
  const current = shown.current.tabs.find(t => t.key === shown.current.active) ?? shown.current.tabs.at(-1)
  const widthKey = `Preview.width:${id}`
  const [width, setWidth] = useState(() => Number(localStorage.getItem(widthKey)) || 50)
  const split = useRef<HTMLDivElement>(null)
  return (
    <div ref={split} className="preview-split" style={{ '--preview': width } as CSSProperties}>
      <div className="preview-main" hidden={mobile && open}>
        {children}
      </div>
      {phase !== 'hidden' && (
        <>
          <div
            className="preview-handle"
            onPointerDown={e => {
              e.preventDefault()
              e.currentTarget.setPointerCapture(e.pointerId)
              split.current?.setAttribute('data-resizing', '')
            }}
            onPointerMove={e => {
              const box = split.current?.getBoundingClientRect()
              if (!box || !e.currentTarget.hasPointerCapture(e.pointerId)) return
              const next = ((box.right - e.clientX) / box.width) * 100
              setWidth(Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next))))
            }}
            onPointerUp={() => localStorage.setItem(widthKey, String(width))}
            onLostPointerCapture={() => split.current?.removeAttribute('data-resizing')}
          />
          <div
            className="preview"
            data-phase={phase}
            onAnimationEnd={e => e.target === e.currentTarget && setPhase(phase === 'closing' ? 'hidden' : 'shown')}
          >
            <div className="preview-body">
              <div className="preview-bar">
                <div className="preview-tabs" role="tablist">
                  {shown.current.tabs.map(tab => (
                    <div
                      key={tab.key}
                      role="tab"
                      tabIndex={0}
                      className="preview-tab"
                      data-active={tab === current || undefined}
                      title={tab.title ?? tab.label}
                      onClick={() => onSelect(tab.key)}
                      onKeyDown={e => e.key === 'Enter' && onSelect(tab.key)}
                    >
                      {tab.icon}
                      <span className="ellipsis">{tab.label}</span>
                      <button
                        className="preview-tab-close"
                        title="Close"
                        aria-label={`Close ${tab.label}`}
                        onClick={e => {
                          e.stopPropagation()
                          onClose(tab.key)
                        }}
                      >
                        <Icon name="x" />
                      </button>
                    </div>
                  ))}
                </div>
                {mobile && (
                  <button
                    className="preview-collapse"
                    title="Back to chat"
                    aria-label="Back to chat"
                    onClick={onCollapse}
                  >
                    <Icon name="chevron-right" size={16} />
                  </button>
                )}
              </div>
              {current?.content}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
