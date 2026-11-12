import { useState, type CSSProperties } from 'react'
import { run, useQuery, type CardProps } from 'switchboard'

type Run = { id: string; state: string; summary: string | null }
type Session = { id: string; status: string }

const STATUS: CSSProperties = {
  color: 'var(--muted)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 360,
}

/** Asks Claude Code to change this folder (`sessions.edit`) and shows the latest run's progress. */
export default function EditBox({ slot }: CardProps) {
  const storageKey = `EditBox.run.${slot}`
  const [prompt, setPrompt] = useState('')
  const [runId, setRunId] = useState(() => localStorage.getItem(storageKey))
  const [error, setError] = useState('')

  return (
    <form
      style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1 }}
      onSubmit={e => {
        e.preventDefault()
        if (!prompt.trim()) return
        run('sessions.edit', { prompt }).then(
          id => {
            localStorage.setItem(storageKey, id)
            setRunId(id)
            setPrompt('')
            setError('')
          },
          (failure: Error) => setError(failure.message),
        )
      }}
    >
      <input
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        placeholder="Ask Claude to change this app"
        style={{ flex: 1 }}
      />
      {error ? <span style={{ color: 'var(--bad)' }}>{error}</span> : runId && <Status runId={runId} />}
    </form>
  )
}

function Status({ runId }: { runId: string }) {
  const latestRun = useQuery<Run>('core_runs', { id: runId })?.[0]
  const session = useQuery<Session>('sessions_items', { run_id: runId })?.[0]
  return (
    <span style={STATUS}>{[latestRun?.state, session?.status, latestRun?.summary].filter(Boolean).join(' · ')}</span>
  )
}
