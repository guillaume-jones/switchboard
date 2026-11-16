import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { mutate, run, useQuery, type CardProps } from 'switchboard'
import {
  BUBBLE,
  Bubble,
  busy,
  Composer,
  DecisionPanel,
  hostName,
  QueuedMessage,
  queueKey,
  TONES,
  useDraft,
  useFlushQueues,
  WAITING,
  type Session,
} from './lib/sessions'
import { useMobile } from './lib/theme'

type Message = { uuid: string; at: string; role: string; text: string }

/** How long a sent message stays as a placeholder if it never shows up in the transcript. */
const PENDING_TIMEOUT = 120_000
const SKILL = /^Base directory for this skill: .*\/([^/\n]+)$/m
const TOOL_LINE: CSSProperties = {
  margin: '4px 0 0',
  color: 'var(--muted)',
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
}
/** Claude Code logs each tool call (`→ Name input`) and result (`← output`) as a message of its own. */
const isTool = (m: Message) => m.text.startsWith('→ ') || m.text.startsWith('← ')
const toolSummary = (group: Message[]) => {
  const names = group.filter(m => m.text.startsWith('→ ')).map(m => m.text.slice(2).split(/\s/)[0].split('__').pop())
  if (names.length === 0) return 'Tool results'
  return `${names.length} tool call${names.length === 1 ? '' : 's'} · ${[...new Set(names)].join(', ')}`
}
const HEADER: CSSProperties = {
  ...BUBBLE,
  flexShrink: 0,
  position: 'relative',
  zIndex: 1,
  background: 'var(--bg)',
  borderBottom: '1px solid var(--border)',
  boxShadow: 'var(--shadow)',
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px 8px',
  alignItems: 'center',
}
const FOOTER: CSSProperties = {
  position: 'sticky',
  bottom: 0,
  padding: '6px calc(10px + var(--bottom-edge, 0px)) calc(10px + var(--bottom-edge, 0px))',
}
const ELLIPSIS: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

/**
 * One session's latest messages, loaded on mount (`sessions.transcript`) and followed until unmount: where the session
 * runs (a link that opens it there with `sessions.open`, desktop only), then its pending decision and a message box
 * pinned to the bottom.
 */
export default function Transcript({ session, limit = 1000 }: CardProps<{ session?: string; limit?: number }>) {
  if (!session) return <div className="empty">Open a transcript from the Sessions card</div>
  return <SessionTranscript id={session} limit={limit} />
}

function SessionTranscript({ id, limit }: { id: string; limit: number }) {
  const session = useQuery<Session>('sessions_items', { id })?.[0]
  const messages = useQuery<Message>('sessions.transcript', { session: id, limit }) ?? []
  const [error, setError] = useState('')
  const mobile = useMobile()
  const scroller = useRef<HTMLDivElement>(null)
  const initial = useRef<Set<string> | null>(null)
  const working = !!session && busy(session)
  const scrollToEnd = () => scroller.current?.scrollTo({ top: 0 })
  const shown = useRef(new Set<string>())
  const [queued] = useDraft(queueKey(id))
  const [pending, setPending] = useState<{ prompt: string; files: string[]; wasQueued: boolean }[]>([])
  const addPending = (prompt: string, files: string[]) => {
    const message = { prompt, files, wasQueued: shown.current.has(prompt) }
    setPending(current => [...current, message])
    setTimeout(() => setPending(current => current.filter(p => p !== message)), PENDING_TIMEOUT)
    scrollToEnd()
  }

  useEffect(() => {
    const arrived = ({ prompt }: { prompt: string }) =>
      messages.some(m => m.role === 'user' && m.text.trim().startsWith(prompt))
    if (pending.some(arrived)) setPending(current => current.filter(p => !arrived(p)))
  }, [messages, pending])

  useEffect(() => {
    for (const prompt of [queued, ...pending.map(p => p.prompt)]) if (prompt) shown.current.add(prompt)
  })

  useEffect(() => {
    scrollToEnd()
  }, [messages.at(-1)?.uuid, working, !session, pending.length])

  useEffect(() => {
    run('sessions.transcript', { session: id }).catch((e: Error) => setError(e.message))
    return () => void mutate('sessions.transcript_close', { session: id })
  }, [id])

  useFlushQueues(session ? [session] : [], setError, addPending)

  if (!initial.current && messages.length) initial.current = new Set(messages.map(m => m.uuid))
  if (!session) return <div className="empty">Loading session…</div>
  const groups = messages.reduce<(Message | Message[])[]>((all, m) => {
    const last = all.at(-1)
    if (!isTool(m)) all.push(m)
    else if (Array.isArray(last)) last.push(m)
    else all.push([m])
    return all
  }, [])
  const last = messages.at(-1)
  const typing = working && !(last?.role === 'assistant' && !isTool(last))
  const decision = session.decision && WAITING.includes(session.status) ? JSON.parse(session.decision) : null
  const fail = (e: Error) => setError(e.message)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--panel)' }}>
      <div style={HEADER}>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <div style={{ ...ELLIPSIS, fontWeight: 600 }}>{session.title}</div>
          <div style={{ ...ELLIPSIS, color: 'var(--muted)', fontSize: 12 }} title={session.cwd ?? undefined}>
            {mobile ? (
              hostName(session)
            ) : (
              <a
                href="#"
                title={`Open in ${hostName(session)}`}
                onClick={e => {
                  e.preventDefault()
                  run('sessions.open', { session: id }).catch(fail)
                }}
              >
                {hostName(session)}
              </a>
            )}{' '}
            · {session.cwd ?? 'No folder'}
          </div>
        </div>
        <span className="badge" data-tone={TONES[session.status]}>
          {session.status.replace('_', ' ')}
        </span>
      </div>
      <div
        ref={scroller}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          overscrollBehavior: 'contain',
          display: 'flex',
          flexDirection: 'column-reverse',
        }}
      >
        <div>
          {error && <div style={{ ...BUBBLE, color: 'var(--bad)' }}>{error}</div>}
          {groups.map(group => {
            const uuid = Array.isArray(group) ? group[0].uuid : group.uuid
            const seen =
              initial.current?.has(uuid) ||
              (!Array.isArray(group) &&
                group.role === 'user' &&
                [...shown.current].some(prompt => group.text.startsWith(prompt)))
            return (
              <div key={uuid} className={seen ? undefined : 'grow'}>
                <div>
                  {Array.isArray(group) ? (
                    <details style={BUBBLE}>
                      <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>
                        {toolSummary(group)}
                      </summary>
                      {group.map(m => (
                        <div key={m.uuid} style={TOOL_LINE}>
                          {m.text}
                        </div>
                      ))}
                    </details>
                  ) : group.role === 'user' && SKILL.test(group.text) ? (
                    <details style={BUBBLE}>
                      <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>
                        Skill loaded · {group.text.match(SKILL)![1]}
                      </summary>
                      <div style={TOOL_LINE}>{group.text}</div>
                    </details>
                  ) : (
                    <Bubble role={group.role} label={new Date(group.at).toLocaleTimeString()} text={group.text} />
                  )}
                </div>
              </div>
            )
          })}
          {pending.map(({ prompt, files, wasQueued }, i) => (
            <div key={i} className={wasQueued ? undefined : 'grow'}>
              <div>
                <Bubble role="user" label="Sending" text={prompt} attachments={files} faded />
              </div>
            </div>
          ))}
          <div className="collapse" data-open={typing || undefined}>
            <div>
              <div style={BUBBLE}>
                <span className="typing">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            </div>
          </div>
          <QueuedMessage session={session} onError={setError} onSent={addPending} />
          <div style={FOOTER}>
            {decision && <DecisionPanel session={session} decision={decision} onError={setError} />}
            <Composer session={session} onError={setError} onSent={addPending} onQueued={scrollToEnd} />
          </div>
        </div>
      </div>
    </div>
  )
}
