import { useState } from 'react'
import { run } from 'switchboard'

export type Session = {
  id: string
  title: string
  status: string
  cwd: string | null
  host: string | null
  owned: number
  last_message: string | null
  decision: string | null
  run_state: string | null
  run_command: string | null
  updated: string
}

export const busy = (session: Session) => session.run_state === 'running' || session.run_state === 'queued'

/** Resumes a Switchboard-owned session, stopping its running turn first: `sessions.edit` for edits, else `sessions.headless`. */
export function followUp(session: Session, prompt: string) {
  return session.run_command === 'sessions.edit'
    ? run('sessions.edit', { prompt, session: session.id })
    : run('sessions.headless', { prompt, session: session.id, cwd: session.cwd ?? '' })
}

/**
 * Message box for a session: Queue (sent once its run finishes) and Interrupt for owned sessions, Poke for others.
 * The queued message lives in `queued`/`onQueue`, held by the card, and is lost if the card unmounts.
 */
export function Composer({
  session,
  queued,
  onQueue,
  onError,
}: {
  session: Session
  queued: string | undefined
  onQueue: (prompt: string) => void
  onError: (message: string) => void
}) {
  const [text, setText] = useState('')
  const send = (action: () => Promise<unknown>) => {
    if (!text.trim()) return
    action().then(
      () => setText(''),
      (e: Error) => onError(e.message),
    )
  }
  if (session.status === 'ended' && !session.owned) return null
  return (
    <form style={{ display: 'flex', gap: 6, marginTop: 4 }} onSubmit={e => e.preventDefault()}>
      <input
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={queued ? `Queued: ${queued}` : session.owned ? 'Follow up' : 'Poke this session'}
        style={{ flex: 1 }}
      />
      {session.owned ? (
        <>
          <button
            type="button"
            onClick={() => send(async () => (busy(session) ? onQueue(text) : followUp(session, text)))}
          >
            Queue
          </button>
          <button type="button" onClick={() => send(() => followUp(session, text))}>
            Interrupt
          </button>
        </>
      ) : (
        <button type="button" onClick={() => send(() => run('sessions.poke', { session: session.id, text }))}>
          Poke
        </button>
      )}
    </form>
  )
}
