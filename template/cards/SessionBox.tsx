import { useEffect, useState } from 'react'
import { run, useQuery, type CardProps } from 'switchboard'
import { SendIcon, Spinner, useDraft } from './lib/sessions'

/** Starts a background Claude session (`sessions.start`) in this folder or the one given, showing why if it fails. */
export default function SessionBox(_: CardProps) {
  const [prompt, setPrompt] = useDraft('SessionBox.prompt')
  const [cwd, setCwd] = useDraft('SessionBox.cwd')
  const [starting, setStarting] = useState(false)
  const [runId, setRunId] = useState<string>()
  const [error, setError] = useState('')

  useEffect(() => {
    if (!runId) return
    const timer = setTimeout(() => setRunId(undefined), 3000)
    return () => clearTimeout(timer)
  }, [runId])

  return (
    <form
      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', flex: 1 }}
      onKeyDown={e => {
        if (e.key !== 'Enter') return
        if (e.metaKey) e.currentTarget.requestSubmit()
        if (e.metaKey || e.target instanceof HTMLInputElement) e.preventDefault()
      }}
      onSubmit={e => {
        e.preventDefault()
        if (!prompt.trim() || starting) return
        setStarting(true)
        setError('')
        run('sessions.start', { prompt, cwd: cwd.trim() })
          .then(
            id => setRunId(id),
            (failure: Error) => setError(failure.message),
          )
          .finally(() => setStarting(false))
      }}
    >
      <textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        placeholder={cwd.trim() ? `Ask Claude in ${cwd.trim()}` : 'Ask Claude to change this app'}
        autoComplete="off"
        enterKeyHint="enter"
        rows={1}
        style={{ flex: '1 1 100%' }}
      />
      <input
        value={cwd}
        onChange={e => setCwd(e.target.value)}
        placeholder="Folder (default: this app)"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        style={{ flex: '1 1 0', minWidth: 0 }}
      />
      <button
        type="submit"
        className={runId ? 'primary' : 'primary icon'}
        disabled={!prompt.trim() || starting}
        title="Send"
        aria-label="Send"
      >
        {starting ? (
          <Spinner />
        ) : runId ? (
          <Outcome runId={runId} onSuccess={() => setPrompt('')} onFailure={setError} />
        ) : (
          <SendIcon />
        )}
      </button>
      {error && <span style={{ color: 'var(--bad)' }}>{error}</span>}
    </form>
  )
}

type Run = { state: string; summary: string | null }

function Outcome({
  runId,
  onSuccess,
  onFailure,
}: {
  runId: string
  onSuccess: () => void
  onFailure: (message: string) => void
}) {
  const started = useQuery<Run>('core_runs', { id: runId })?.[0]
  useEffect(() => {
    if (started?.state === 'success' || (!started && !navigator.onLine)) onSuccess()
    if (started?.state === 'failure') onFailure(started.summary ?? 'Could not start the session')
  }, [started?.state])
  if (!started) return navigator.onLine ? <Spinner /> : <>Queued</>
  if (started.state === 'running') return <Spinner />
  return <>{started.state === 'success' ? 'Started' : 'Failed'}</>
}
