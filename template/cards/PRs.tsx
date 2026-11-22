import { useState, type CSSProperties } from 'react'
import { mutate, useQuery, type CardProps } from 'switchboard'
import { Icon, type IconName } from './lib/icons'
import { Disclosure } from './lib/disclosure'
import { useMobile } from './lib/theme'

type Pr = {
  id: string
  url: string
  repo: string
  number: number
  title: string | null
  ci: string | null
  merge_state: string | null
  auto_merge: number
  queued: number
  new_comments: number | null
  folder: string | null
  status: string
  is_open: number
}

const GROUPS: [string, string, string][] = [
  ['needs_action', 'Needs action', 'var(--warn)'],
  ['ready', 'Ready', 'var(--good)'],
  ['awaiting_review', 'Awaiting review', 'var(--accent)'],
  ['draft', 'Drafts', 'var(--muted)'],
]
const CI: Record<string, [IconName, string, string]> = {
  SUCCESS: ['check', 'CI passed', 'var(--good)'],
  FAILURE: ['x', 'CI failed', 'var(--bad)'],
  ERROR: ['x', 'CI error', 'var(--bad)'],
}
const CONFLICTS: [IconName, string, string] = ['alert-fill', 'Merge conflicts', 'var(--bad)']
const AUTO_MERGE: [IconName, string, string] = ['git-merge', 'Auto-merge enabled', 'var(--good)']
const QUEUED: [IconName, string, string] = ['git-merge', 'In the merge queue', 'var(--warn)']
const LINK: CSSProperties = { cursor: 'pointer', color: 'inherit', textDecoration: 'none' }

/**
 * PRs you opened, grouped like GitHub's inbox, plus those merged in the past 14 days, but for those of a project. With
 * `project`, all of that project's PRs instead. PRs closed without merging are left out.
 */
export default function PRs({ project }: CardProps<{ project?: number }>) {
  const prs = (
    useQuery<Pr & { project?: number | null }>(
      project ? 'workstreams.project_pr_list' : 'github_items',
      project ? { project } : {},
    ) ?? []
  ).filter(pr => pr.status !== 'closed' && (project || !pr.project))
  const [showDone, setShowDone] = useState(false)
  const [error, setError] = useState<string>()
  const client = useMobile() ? 'mobile' : 'desktop'
  const open = prs.filter(pr => pr.is_open)
  const done = prs.filter(pr => !pr.is_open)

  const newChat = async ({ url, repo, number, folder }: Pr) => {
    try {
      await mutate('sessions.draft_set', { key: 'NewChat.prompt', text: '' })
      await mutate('sessions.draft_set', {
        key: 'NewChat.links',
        text: JSON.stringify([{ ref: url, kind: 'pr', label: `${repo}#${number}` }]),
      })
      await mutate('sessions.draft_set', { key: 'NewChat.todo', text: '' })
      await mutate('sessions.draft_set', { key: 'NewChat.cwd', text: folder ?? '' })
      await mutate('ui.open_chat', { client, session: '' })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const icon = ([name, label, color]: [IconName, string, string]) => (
    <span key={label} title={label} aria-label={label} style={{ color, display: 'inline-flex' }}>
      <Icon name={name} />
    </span>
  )

  const row = (pr: Pr) => (
    <div key={pr.id} className="list-row trailing" style={{ opacity: pr.is_open ? 1 : 0.7 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          title={pr.url}
          className="ellipsis"
          style={{ ...LINK, display: 'block' }}
        >
          {pr.title ?? pr.url}
        </a>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            columnGap: 10,
            rowGap: 2,
            marginTop: 4,
            color: 'var(--muted)',
            fontSize: 12,
          }}
        >
          <span>
            {pr.repo.split('/').pop()}#{pr.number}
          </span>
          {!!pr.is_open && pr.ci === 'PENDING' && (
            <span className="spinner ci" title="CI running" aria-label="CI running" />
          )}
          {!!pr.is_open && pr.ci === 'EXPECTED' && (
            <span className="spinner ci waiting" title="CI waiting" aria-label="CI waiting" />
          )}
          {!!pr.is_open && pr.ci && CI[pr.ci] && icon(CI[pr.ci])}
          {!!pr.is_open && pr.merge_state === 'DIRTY' && icon(CONFLICTS)}
          {!!pr.is_open && !!pr.auto_merge && icon(AUTO_MERGE)}
          {!!pr.is_open && !!pr.queued && icon(QUEUED)}
          {!!pr.is_open && !!pr.new_comments && (
            <span style={{ color: 'var(--warn)' }}>
              {pr.new_comments} new comment{pr.new_comments > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
      <button className="icon ghost" title="New chat about this PR" onClick={() => newChat(pr)}>
        ✦
      </button>
    </div>
  )

  const groups = (rows: Pr[]) =>
    GROUPS.map(([status, label, color]) => {
      const matching = rows.filter(pr => pr.status === status)
      return (
        matching.length > 0 && (
          <div key={status}>
            <div className="group-heading" style={{ '--tone': color } as CSSProperties}>
              {label} <span className="count">{matching.length}</span>
            </div>
            {matching.map(row)}
          </div>
        )
      )
    })

  return (
    <div>
      {error && <div className="error-line">{error}</div>}
      {open.length === 0 && <div className="empty idle">No open PRs</div>}
      {groups(open)}
      {done.length > 0 && (
        <Disclosure label="Done" count={done.length} open={showDone} onToggle={() => setShowDone(!showDone)}>
          {done.map(row)}
        </Disclosure>
      )}
    </div>
  )
}
