import { useState } from 'react'
import { mutate, useQuery, type CardProps } from 'switchboard'
import { Icon } from './lib/icons'
import { relativePath, resolvePath } from './lib/markdown'

export default function ProjectNotesHeader({ project }: CardProps<{ project: number }>) {
  const item = useQuery<{ folder: string | null; notes_file: string | null }>('workstreams_items', { id: project })?.[0]
  const [linking, setLinking] = useState(false)
  const [error, setError] = useState('')
  if (!item) return null
  const notesFile = item.notes_file ?? ''
  const base = item.folder && (/^[~/]/.test(item.folder) ? item.folder : `~/Documents/${item.folder}`)
  const shown = relativePath(notesFile, base)
  const link = (value: string) =>
    mutate('workstreams.update', {
      id: project,
      field: 'notes_file',
      value: resolvePath(value.trim(), base || undefined),
    })
      .then(() => setError(''))
      .catch((e: Error) => setError(e.message))
  return (
    <div style={{ display: 'flex', flex: 1, justifyContent: 'flex-end', gap: 6, alignItems: 'center', minWidth: 0 }}>
      {error && (
        <span style={{ color: 'var(--bad)' }} title={error}>
          Link failed
        </span>
      )}
      {linking ? (
        <input
          autoFocus
          defaultValue={shown}
          placeholder={base ? './NOTES.md' : '~/path/to/NOTES.md'}
          aria-label="Notes file"
          style={{ flex: 1, minWidth: 0 }}
          onKeyDown={e =>
            e.key === 'Escape'
              ? ((e.currentTarget.value = shown), e.currentTarget.blur())
              : e.key === 'Enter' && e.currentTarget.blur()
          }
          onBlur={e => {
            setLinking(false)
            if (e.currentTarget.value.trim() !== shown) link(e.currentTarget.value)
          }}
        />
      ) : (
        <>
          {notesFile && (
            <span className="ellipsis" style={{ color: 'var(--muted)', minWidth: 0 }} title={notesFile}>
              {shown}
            </span>
          )}
          <button
            className="ghost icon"
            title={notesFile ? 'Change notes file' : 'Link notes file'}
            aria-label={notesFile ? 'Change notes file' : 'Link notes file'}
            onClick={() => setLinking(true)}
          >
            <Icon name={notesFile ? 'pencil' : 'link'} />
          </button>
          {notesFile && (
            <button
              className="ghost icon"
              title="Unlink notes file"
              aria-label="Unlink notes file"
              onClick={() => link('')}
            >
              <Icon name="unlink" />
            </button>
          )}
        </>
      )}
    </div>
  )
}
