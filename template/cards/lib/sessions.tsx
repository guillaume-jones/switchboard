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
  last_prompt: string | null
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
 * Message box for a session. Send (Enter) sends a follow-up to an owned session, queued in the card while its run is
 * busy and shown faded with an Interrupt button; cmd-Enter interrupts straight away. For other sessions, Send pokes.
 * The queue lives in `queued`/`onQueue` (undefined clears it), held by the card and lost if it unmounts. `onSent` gets
 * each follow-up once its run has started.
 */
export function Composer({
  session,
  queued,
  onQueue,
  onError,
  onSent,
}: {
  session: Session
  queued: string | undefined
  onQueue: (prompt: string | undefined) => void
  onError: (message: string) => void
  onSent?: (prompt: string) => void
}) {
  const [text, setText] = useState('')
  const fail = (e: Error) => onError(e.message)
  const sendNow = (prompt: string) => followUp(session, prompt).then(() => onSent?.(prompt), fail)
  const take = () => {
    const prompt = text.trim()
    setText('')
    return prompt
  }
  const send = () => {
    const prompt = take()
    if (!prompt) return
    if (!session.owned) run('sessions.poke', { session: session.id, text: prompt }).catch(fail)
    else if (busy(session)) onQueue(queued ? `${queued}\n\n${prompt}` : prompt)
    else sendNow(prompt)
  }
  if (session.status === 'ended' && !session.owned) return null
  return (
    <div>
      {queued !== undefined && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1, minWidth: 0, opacity: 0.5 }}>
            <Spinner />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{queued}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              onQueue(undefined)
              sendNow(queued)
            }}
          >
            Interrupt
          </button>
        </div>
      )}
      <form
        style={{ display: 'flex', gap: 6, marginTop: 4 }}
        onSubmit={e => {
          e.preventDefault()
          send()
        }}
      >
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && e.metaKey && session.owned) {
              e.preventDefault()
              const prompt = take()
              if (prompt) sendNow(prompt)
            }
          }}
          placeholder={session.owned ? 'Follow up' : 'Message this session'}
          style={{ flex: 1 }}
        />
        <button type="submit">Send</button>
      </form>
    </div>
  )
}

const SPIN = '@keyframes sessions-spin { to { transform: rotate(360deg) } }'

export function Spinner() {
  return (
    <>
      <style>{SPIN}</style>
      <span
        style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          margin: '4px 0',
          border: '2px solid var(--border)',
          borderTopColor: 'var(--accent)',
          borderRadius: '50%',
          animation: 'sessions-spin 0.8s linear infinite',
        }}
      />
    </>
  )
}
