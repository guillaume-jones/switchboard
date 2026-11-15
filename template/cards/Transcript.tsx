import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { mutate, run, useQuery, type CardProps } from 'switchboard'
import { renderMarkdown } from './lib/markdown'
import { busy, Composer, followUp, type Session } from './lib/sessions'

type Message = { uuid: string; at: string; role: string; text: string }

const MESSAGE: CSSProperties = { padding: '4px 8px', borderBottom: '1px solid var(--border)', overflowWrap: 'anywhere' }

/** One session's latest messages, loaded on mount (`sessions.transcript`) and followed until unmount, with a message box. */
export default function Transcript({ session, limit = 50 }: CardProps<{ session?: string; limit?: number }>) {
  if (!session) return <div style={{ ...MESSAGE, color: 'var(--muted)' }}>Open a transcript from the Sessions card</div>
  return <SessionTranscript id={session} limit={limit} />
}

function SessionTranscript({ id, limit }: { id: string; limit: number }) {
  const session = useQuery<Session>('sessions_items', { id })?.[0]
  const messages = useQuery<Message>('sessions.transcript', { session: id, limit }) ?? []
  const [queued, setQueued] = useState<string>()
  const [error, setError] = useState('')
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [messages.length])

  useEffect(() => {
    run('sessions.transcript', { session: id }).catch((e: Error) => setError(e.message))
    return () => void mutate('sessions.transcript_close', { session: id })
  }, [id])

  useEffect(() => {
    if (!session || queued === undefined || busy(session)) return
    setQueued(undefined)
    followUp(session, queued).catch((e: Error) => setError(e.message))
  }, [session, queued])

  return (
    <div>
      {session && <div style={{ ...MESSAGE, fontWeight: 600 }}>{session.title}</div>}
      {error && <div style={{ ...MESSAGE, color: 'var(--bad)' }}>{error}</div>}
      {messages.map(m => (
        <div key={m.uuid} style={{ ...MESSAGE, background: m.role === 'user' ? 'var(--panel)' : undefined }}>
          <div style={{ color: 'var(--muted)', fontSize: 11 }}>
            {m.role} · {new Date(m.at).toLocaleTimeString()}
          </div>
          <div dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
        </div>
      ))}
      {session && <Composer session={session} queued={queued} onQueue={setQueued} onError={setError} />}
      <div ref={end} />
    </div>
  )
}
