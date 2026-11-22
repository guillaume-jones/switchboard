import { run, useQuery } from 'switchboard'
import { Icon } from './icons'

type ScanStatus = { running: number; last_scan: string | null; last_state: string | null; last_summary: string | null }

/** Last successful run of `command` from `view`, and a button to run it now, for a tile bar. */
export function ScanHeader({ view, command }: { view: string; command: string }) {
  const status = useQuery<ScanStatus>(view)?.[0]
  const failed = status?.last_state === 'failure'
  const lastScan = status?.last_scan
  const time =
    lastScan &&
    (lastScan.slice(0, 10) === new Date().toLocaleDateString('sv') ? lastScan.slice(11, 16) : lastScan.slice(5, 16))

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{ color: failed ? 'var(--bad)' : 'var(--muted)' }}
        title={(failed && status.last_summary) || undefined}
      >
        {status?.running ? 'Scanning…' : failed ? 'Scan failed' : time ? `Scanned ${time}` : 'Never scanned'}
      </span>
      {!status?.running && (
        <button className="ghost icon" title="Scan now" aria-label="Scan now" onClick={() => run(command, {})}>
          <Icon name="sync" />
        </button>
      )}
    </div>
  )
}
