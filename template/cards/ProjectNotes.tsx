import { useState } from 'react'
import { mutate, run, useQuery, type CardProps } from 'switchboard'
import { useDocWatch } from './lib/doc'
import { copyCode, renderMarkdown } from './lib/markdown'

/** The project's notes as Markdown, from its notes file if linked, else its description; click to edit, blur to save. */
export default function ProjectNotes({ project }: CardProps<{ project: number }>) {
  const item = useQuery<{ description: string; notes_file: string | null }>('workstreams_items', { id: project })?.[0]
  const notesFile = item?.notes_file ?? ''
  const file = useQuery<{ text: string | null; error: string | null }>('docs_files', {
    path: notesFile,
  })?.[0]
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const [saveRun, setSaveRun] = useState<string>()
  const saveFailure = useQuery<{ state: string; summary: string | null }>('core_runs', { id: saveRun ?? '' })?.find(
    r => r.state === 'failure',
  )
  useDocWatch(notesFile)
  if (!item) return null
  const text = notesFile ? (file?.text ?? '') : item.description
  const shownError = error || (saveFailure && (saveFailure.summary || 'Saving the notes file failed'))
  const save = (value: string) =>
    (notesFile
      ? run('workstreams.notes-save', { path: notesFile, content: value, base: text }).then(setSaveRun)
      : mutate('workstreams.update', { id: project, field: 'description', value })
    ).catch((e: Error) => setError(e.message))
  return (
    <div
      style={{ padding: '8px 10px', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}
    >
      {shownError && (
        <div style={{ color: 'var(--bad)' }} onClick={() => (setError(''), setSaveRun(undefined))}>
          {shownError}
        </div>
      )}
      {notesFile && !file ? (
        <div className="empty">Reading {notesFile}…</div>
      ) : file?.error ? (
        <div style={{ color: 'var(--bad)' }}>
          Can't read {notesFile}: {file.error}
        </div>
      ) : editing ? (
        <textarea
          autoFocus
          defaultValue={text}
          placeholder="Notes, in Markdown"
          aria-label="Notes"
          style={{
            flex: 1,
            minHeight: 120,
            maxHeight: 'none',
            width: '100%',
            fontFamily: 'ui-monospace, monospace',
            fontSize: 12,
          }}
          onKeyDown={e => (e.key === 'Escape' || (e.key === 'Enter' && e.metaKey)) && e.currentTarget.blur()}
          onBlur={e => {
            setEditing(false)
            if (e.currentTarget.value !== text) save(e.currentTarget.value)
          }}
        />
      ) : text.trim() ? (
        <div
          className="message"
          title="Click to edit"
          onClick={e => (copyCode(e, text), (e.target as Element).closest('a, pre, button') || setEditing(true))}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
        />
      ) : (
        <button className="ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setEditing(true)}>
          Add notes
        </button>
      )}
    </div>
  )
}
