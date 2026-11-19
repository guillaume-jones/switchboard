import { useState, type ReactNode } from 'react'
import { useMobile } from './theme'

export type Action = {
  label: string
  /** Shown as an icon button on desktop; actions without one, and every action on phones, go in the ⋯ menu. */
  icon?: ReactNode
  onClick: () => void
  pressed?: boolean
  /** Menu text when it differs from `label`, the tooltip. */
  text?: string
}

/** A header's actions: small icon buttons, then a ⋯ menu for the rest. */
export function Actions({ actions }: { actions: (Action | false | undefined)[] }) {
  const mobile = useMobile()
  const [menu, setMenu] = useState(false)
  const shown = actions.filter((a): a is Action => !!a)
  const icons = mobile ? [] : shown.filter(a => a.icon)
  const listed = mobile ? shown : shown.filter(a => !a.icon)
  return (
    <>
      {icons.map(a => (
        <button
          key={a.label}
          className="ghost icon small"
          title={a.label}
          aria-label={a.label}
          aria-pressed={a.pressed}
          onClick={a.onClick}
        >
          {a.icon}
        </button>
      ))}
      {listed.length > 0 && (
        <span style={{ position: 'relative' }}>
          <button
            className="ghost icon small"
            title="More"
            aria-label="More"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            ⋯
          </button>
          {menu && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 4 }} onClick={() => setMenu(false)} />
              <div className="folder-list menu fade-in" role="menu" onClick={() => setMenu(false)}>
                {listed.map(a => (
                  <button key={a.label} role="menuitem" title={a.label} aria-pressed={a.pressed} onClick={a.onClick}>
                    {a.text ?? a.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </span>
      )}
    </>
  )
}
