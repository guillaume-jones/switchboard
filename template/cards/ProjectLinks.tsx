import { useState } from 'react'
import { mutate, useQuery, type CardProps } from 'switchboard'
import { Disclosure } from './lib/disclosure'
import { Icon } from './lib/icons'
import { LinkPicker, linkTone } from './lib/links'
import { useMobile } from './lib/theme'

type ProjectLink = {
  ref: string
  kind: string
  label: string | null
  title: string
  status: string | null
  archived: number
  item: number
  item_title: string
  own: number
  created_at: number
}

const HEADINGS: Record<string, string> = { url: 'Links', session: 'Chats' }
const ROW = { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', minWidth: 0 } as const
const SUB = {
  color: 'var(--muted)',
  fontSize: 12,
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  overflowWrap: 'anywhere',
} as const
const SESSION = 'sessions:'

/** Everything but PRs (see `PRs` with `project`) linked to a project or its to-dos, by kind, newest first; links of the project itself can be removed. */
export default function ProjectLinks({ project }: CardProps<{ project: number }>) {
  const rows = useQuery<ProjectLink>('workstreams_project_links', { project })
  const item = useQuery<{ title: string; description: string }>('workstreams_items', { id: project })?.[0]
  const [showArchived, setShowArchived] = useState(false)
  const [error, setError] = useState('')
  const fail = (e: Error) => setError(e.message)
  const client = useMobile() ? 'mobile' : 'desktop'
  const links = (rows ?? []).filter(l => l.kind !== 'pr')
  const kinds = [...new Set([...Object.keys(HEADINGS), ...links.map(l => l.kind)])].filter(k =>
    links.some(l => l.kind === k),
  )

  const row = (l: ProjectLink) => (
    <div key={l.ref} style={ROW}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <a
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            color: 'inherit',
            textDecoration: 'none',
          }}
          href={l.kind === 'session' ? '#' : l.ref}
          target="_blank"
          rel="noreferrer"
          title={l.kind === 'session' ? l.title : l.ref}
          onClick={e => {
            if (l.kind !== 'session') return
            e.preventDefault()
            mutate('ui.open_chat', { client, session: l.ref.slice(SESSION.length) }).catch(fail)
          }}
        >
          <span className="ellipsis" style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>
            {l.title}
          </span>
          {l.status && (
            <span className="badge" data-tone={linkTone(l)}>
              {l.status.replace('_', ' ')}
            </span>
          )}
        </a>
        {!l.own && <div style={SUB}>via {l.item_title}</div>}
      </div>
      {!!l.own && (
        <button
          className="ghost icon small"
          title="Unlink"
          aria-label="Unlink"
          onClick={() => mutate('workstreams.link_remove', { item: project, ref: l.ref }).catch(fail)}
        >
          <Icon name="x" />
        </button>
      )}
    </div>
  )

  return (
    <div className="project-links" style={{ paddingBottom: 8 }}>
      <div style={{ padding: '8px 10px' }}>
        <LinkPicker
          context={`${item?.title ?? ''} ${item?.description ?? ''}`}
          linked={(rows ?? []).map(l => l.ref)}
          onPick={l =>
            mutate('workstreams.link_add', {
              item: project,
              ref: l.ref,
              kind: l.kind,
              label: l.kind === 'session' ? '' : l.label,
            }).catch(fail)
          }
        />
      </div>
      {error && (
        <div style={{ padding: '0 10px 6px', color: 'var(--bad)' }} onClick={() => setError('')}>
          {error}
        </div>
      )}
      {rows && links.length === 0 && <div className="empty idle">Nothing linked yet</div>}
      {kinds.map(kind => {
        const sorted = links.filter(l => l.kind === kind).sort((a, b) => b.created_at - a.created_at)
        const archived = sorted.filter(l => l.kind === 'session' && l.archived)
        return (
          <div key={kind}>
            <div className="todo-section heading">{HEADINGS[kind] ?? kind}</div>
            {sorted.filter(l => !archived.includes(l)).map(row)}
            {archived.length > 0 && (
              <Disclosure
                label="Archived"
                count={archived.length}
                open={showArchived}
                onToggle={() => setShowArchived(!showArchived)}
              >
                {archived.map(row)}
              </Disclosure>
            )}
          </div>
        )
      })}
    </div>
  )
}
