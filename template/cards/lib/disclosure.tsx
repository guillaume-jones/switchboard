import { useState, type ReactNode } from 'react'
import { Icon } from './icons'

export function Disclosure({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string
  count: number
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  return (
    <>
      <button className="ghost disclosure" aria-expanded={open} onClick={onToggle}>
        <Icon name="chevron-right" />
        {label} <span className="count">{count}</span>
      </button>
      <div
        className="collapse"
        data-open={open ? '' : undefined}
        onTransitionEnd={e => e.target === e.currentTarget && !open && setMounted(false)}
      >
        <div>{mounted && children}</div>
      </div>
    </>
  )
}
