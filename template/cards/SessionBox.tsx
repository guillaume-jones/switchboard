import { useEffect, useState } from 'react'
import { run, useQuery, type CardProps } from 'switchboard'
import { MessageBox, Spinner, useDraft, withAttachments, type Attachment } from './lib/sessions'

/**
 * Starts a background Claude session (`sessions.start`) with files attached, in this folder or the one given, showing
 * why if it fails.
 */
export default function SessionBox(_: CardProps) {
  const [, setPrompt] = useDraft('SessionBox.prompt')
  const [, setFiles] = useDraft('SessionBox.files')
  const [cwd, setCwd] = useDraft('SessionBox.cwd')
  const [starting, setStarting] = useState(false)
  const [runId, setRunId] = useState<string>()
  const [error, setError] = useState('')

  useEffect(() => {
    if (!runId) return
    const timer = setTimeout(() => setRunId(undefined), 3000)
    return () => clearTimeout(timer)
  }, [runId])

  const start = (prompt: string, files: Attachment[]) => {
    if (!prompt || starting) return
    setStarting(true)
    setError('')
    run('sessions.start', { ...withAttachments('prompt', prompt, files), cwd: cwd.trim() })
      .then(
        id => setRunId(id),
        (failure: Error) => setError(failure.message),
      )
      .finally(() => setStarting(false))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0 }}>
      <MessageBox
        draft="SessionBox.prompt"
        files="SessionBox.files"
        placeholder={cwd.trim() ? `Ask Claude in ${cwd.trim()}` : 'Ask Claude to change this app'}
        onSend={start}
        onError={setError}
        button={
          starting ? (
            <Spinner />
          ) : runId ? (
            <Outcome
              runId={runId}
              onSuccess={() => {
                setPrompt('')
                setFiles('')
              }}
              onFailure={setError}
            />
          ) : undefined
        }
      />
      <input
        value={cwd}
        onChange={e => setCwd(e.target.value)}
        placeholder="Folder (default: this app)"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      {error && <span style={{ color: 'var(--bad)' }}>{error}</span>}
    </div>
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
