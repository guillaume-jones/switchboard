import { useState } from 'react'
import { mutate, useQuery, type CardProps } from 'switchboard'
import { copyCode, renderMarkdown } from './lib/markdown'

/** The project's description as Markdown; click to edit, blur to save. */
export default function ProjectNotes({ project }: CardProps<{ project: number }>) {
  const item = useQuery<{ description: string }>('workstreams_items', { id: project })?.[0]
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  if (!item) return null
  return (
    <div
      style={{ padding: '8px 10px', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}
    >
      {error && (
        <div style={{ color: 'var(--bad)' }} onClick={() => setError('')}>
          {error}
        </div>
      )}
      {editing ? (
        <textarea
          autoFocus
          defaultValue={item.description}
          placeholder="Notes, in Markdown"
          aria-label="Notes"
          style={{ flex: 1, minHeight: 120, width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          onKeyDown={e => e.key === 'Escape' && e.currentTarget.blur()}
          onBlur={e => {
            setEditing(false)
            if (e.currentTarget.value !== item.description)
              mutate('workstreams.update', { id: project, field: 'description', value: e.currentTarget.value }).catch(
                (e: Error) => setError(e.message),
              )
          }}
        />
      ) : item.description.trim() ? (
        <div
          className="message"
          title="Click to edit"
          onClick={e => (copyCode(e), (e.target as Element).closest('a, pre') || setEditing(true))}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(item.description) }}
        />
      ) : (
        <button className="ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setEditing(true)}>
          Add notes
        </button>
      )}
    </div>
  )
}
