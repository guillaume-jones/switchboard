import { useEffect, useRef, useState } from 'react'
import { CardSlot, mutate, useQuery, type CardProps } from 'switchboard'
import { Actions } from './lib/actions'
import { Icon } from './lib/icons'
import { useMobile } from './lib/theme'

type Item = {
  id: number
  title: string
  description: string
  done: number
  folder: string | null
  notes_file: string | null
}
type Todo = { id: number; list: string; title: string; done: number; position: number }
type ProjectLink = {
  project: number
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

/**
 * A project: an item in the `projects` list whose to-dos link to it (`workstreams:<id>`). A header of actions over
 * the project's own grid, `project:<id>`, seeded from `ui_defaults` while it has no tiles.
 */
export default function Project({ project, layout }: CardProps<{ project: number; layout?: 'list' }>) {
  const items = useQuery<Item>('workstreams_items', { id: project })
  const item = items?.[0]
  const links = (useQuery<ProjectLink>('workstreams_project_links', { project }) ?? []).sort(
    (a, b) => a.created_at - b.created_at,
  )
  const todos = useQuery<Todo>('workstreams_project_items', { project, done: 0 }) ?? []
  const grid = `project:${project}`
  const tiles = useQuery('ui.tiles', { grid })
  const client = useMobile() ? 'mobile' : 'desktop'
  const [error, setError] = useState('')
  const fail = (e: Error) => setError(e.message)
  const seeded = useRef(false)
  useEffect(() => {
    if (tiles?.length !== 0 || seeded.current) return
    seeded.current = true
    mutate('ui.reset', { grid }).catch(fail)
  }, [tiles])

  if (!item) return items ? <div className="empty">This project no longer exists</div> : null

  const newChat = async () => {
    const open = [...todos].sort((a, b) => a.position - b.position)
    const list = (heading: string, included: (list: string) => boolean) => {
      const titles = open.filter(t => included(t.list)).map(t => `- ${t.title}`)
      return titles.length > 0 && `To-dos ${heading}:\n${titles.join('\n')}`
    }
    const shared = links.filter(l => l.kind !== 'session')
    const prompt = [
      `Project: ${item.title}`,
      item.notes_file ? `Notes: ${item.notes_file}` : item.description.trim(),
      list('now', l => l !== 'later' && l !== 'blocked'),
      list('later', l => l === 'later'),
      list('blocked', l => l === 'blocked'),
      shared.length > 0 && `Links:\n${shared.map(l => `- ${l.kind}: ${l.title} (${l.ref})`).join('\n')}`,
    ]
      .filter(Boolean)
      .join('\n\n')
    try {
      await mutate('sessions.draft_set', { key: 'NewChat.prompt', text: prompt })
      await mutate('sessions.draft_set', {
        key: 'NewChat.links',
        text: JSON.stringify(shared.map(({ ref, kind, label }) => ({ ref, kind, label }))),
      })
      await mutate('sessions.draft_set', { key: 'NewChat.todo', text: String(project) })
      if (item.folder) await mutate('sessions.draft_set', { key: 'NewChat.cwd', text: item.folder })
      await mutate('ui.open_chat', { client, session: '' })
    } catch (e) {
      fail(e as Error)
    }
  }

  const remove = async () => {
    if (!confirm(`Delete the project “${item.title}”? Its to-dos stay, unlinked.`)) return
    try {
      await mutate('ui.set_board', { client, id: 'main' })
      await mutate('ui.close_board', { id: grid })
      await mutate('workstreams.delete', { id: project })
    } catch (e) {
      fail(e as Error)
    }
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="board-header">
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <input
            key={item.title}
            defaultValue={item.title}
            aria-label="Project title"
            title="Rename"
            className="inline-edit ellipsis"
            style={{
              display: 'block',
              width: '100%',
              fontWeight: 600,
              textDecoration: item.done ? 'line-through' : undefined,
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                e.stopPropagation()
                e.currentTarget.value = item.title
                e.currentTarget.blur()
              }
            }}
            onBlur={e => {
              const title = e.currentTarget.value.trim()
              if (title && title !== item.title)
                mutate('workstreams.update', { id: project, field: 'title', value: title }).catch(fail)
              else e.currentTarget.value = item.title
            }}
          />
          <input
            key={item.folder}
            defaultValue={item.folder ?? ''}
            placeholder="No folder"
            aria-label="Project folder"
            title="Folder new chats start in"
            className="inline-edit ellipsis"
            style={{ display: 'block', width: '100%', color: 'var(--muted)', fontSize: 12 }}
            onKeyDown={e => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                e.stopPropagation()
                e.currentTarget.value = item.folder ?? ''
                e.currentTarget.blur()
              }
            }}
            onBlur={e => {
              const folder = e.currentTarget.value.trim()
              if (folder !== (item.folder ?? ''))
                mutate('workstreams.update', { id: project, field: 'folder', value: folder }).catch(fail)
            }}
          />
        </div>
        <Actions
          actions={[
            {
              label: 'New chat with the project as context',
              text: 'New chat',
              icon: <Icon name="sparkle-fill" size={14} />,
              onClick: newChat,
            },
            {
              label: item.done ? 'Reopen project' : 'Mark project done',
              onClick: () => mutate('workstreams.set_done', { id: project, done: item.done ? 0 : 1 }).catch(fail),
            },
            { label: 'Delete project', onClick: remove },
          ]}
        />
      </div>
      {error && (
        <div style={{ padding: '6px 10px', color: 'var(--bad)' }} onClick={() => setError('')}>
          {error}
        </div>
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          overscrollBehavior: 'contain',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <CardSlot component="Grid" props={{ grid, layout }} id={`${grid}/grid`} />
      </div>
    </div>
  )
}
