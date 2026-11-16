import { useState, type CSSProperties } from 'react'
import { CardSlot, mutate, useQuery, type CardProps } from 'switchboard'
import { TONES, type Session } from './lib/sessions'
import { useMobile } from './lib/theme'

const ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  borderBottom: '1px solid var(--border)',
}
const ELLIPSIS: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

/**
 * The Ask Claude box over recent Claude sessions: title, folder, time and status, with a click showing the session's
 * `Transcript` in a tab of its own.
 */
export default function Sessions({ limit = 30 }: CardProps<{ limit?: number }>) {
  const client = useMobile() ? 'mobile' : 'desktop'
  const [showArchived, setShowArchived] = useState(false)
  const sessions = useQuery<Session>('sessions.recent', { limit, hidden: 0 }) ?? []
  const archived = useQuery<Session>('sessions.recent', { limit: showArchived ? limit : 0, hidden: 1 }) ?? []
  const [error, setError] = useState('')

  const fail = (e: Error) => setError(e.message)
  const open = (session: Session) =>
    mutate('ui.open_board', {
      client,
      id: `transcript-${session.id}`,
      title: session.title,
      component: 'Transcript',
      props: JSON.stringify({ session: session.id }),
    }).catch(fail)

  const row = (session: Session, isArchived: boolean) => (
    <div
      key={session.id}
      role="button"
      tabIndex={0}
      style={{ ...ROW, cursor: 'pointer', opacity: isArchived ? 0.7 : 1 }}
      onClick={() => open(session)}
      onKeyDown={e => e.key === 'Enter' && open(session)}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...ELLIPSIS, fontWeight: 600 }}>{session.title}</div>
        <div
          style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2, color: 'var(--muted)', fontSize: 12 }}
        >
          <span className="badge" data-tone={TONES[session.status]}>
            {session.status.replace('_', ' ')}
          </span>
          <span title={session.cwd ?? undefined} style={ELLIPSIS}>
            {session.cwd?.split('/').pop() || 'No folder'} · {session.updated}
          </span>
        </div>
      </div>
      <button
        title={isArchived ? 'Unarchive' : 'Archive'}
        aria-label={isArchived ? 'Unarchive' : 'Archive'}
        className="ghost icon small"
        onClick={e => {
          e.stopPropagation()
          mutate(isArchived ? 'sessions.unhide' : 'sessions.hide', { id: session.id }).catch(fail)
        }}
      >
        <ArchiveIcon unarchive={isArchived} />
      </button>
    </div>
  )

  return (
    <div>
      <div style={ROW}>
        <CardSlot component="SessionBox" id="session-box" size="compact" />
      </div>
      {error && <div style={{ ...ROW, color: 'var(--bad)' }}>{error}</div>}
      {sessions.length === 0 && <div className="empty">No sessions yet. Start one from the box above.</div>}
      {sessions.map(session => row(session, false))}
      <div style={{ ...ROW, borderBottom: showArchived ? undefined : 'none' }}>
        <button className="ghost" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>
      </div>
      {showArchived && archived.length === 0 && <div className="empty">No archived sessions</div>}
      {showArchived && archived.map(session => row(session, true))}
    </div>
  )
}

function ArchiveIcon({ unarchive }: { unarchive: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1.5" y="2.5" width="13" height="3" rx="0.5" />
      <path d="M2.5 5.5v7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-7" />
      <path d={unarchive ? 'M8 12V8M6 10l2-2 2 2' : 'M6.5 8.5h3'} />
    </svg>
  )
}
