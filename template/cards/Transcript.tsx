import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { mutate, run, useExpose, useQuery, type CardProps } from 'switchboard'
import {
  BUBBLE,
  Bubble,
  busy,
  Composer,
  DecisionPanel,
  hostName,
  interruptible,
  outboxText,
  QUEUE_BUTTON,
  QueuedMessage,
  TONES,
  useOutbox,
  withoutAttachments,
  WAITING,
  type Session,
} from './lib/sessions'
import { useMobile } from './lib/theme'
import { renderMarkdown } from './lib/markdown'

type Message = { uuid: string; at: string; role: string; text: string; tokens: number | null }

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
const DENIED = /^← (Permission for this \w+ was denied|The user doesn't want to proceed)/
/** Denied calls and their results. Results arrive in call order, so the nth result answers the nth call. */
const deniedTools = (group: Message[]) => {
  const calls = group.filter(m => m.text.startsWith('→ '))
  const results = group.filter(m => m.text.startsWith('← '))
  return calls.flatMap((call, i) => (DENIED.test(results[i]?.text ?? '') ? [call.uuid, results[i].uuid] : []))
}
const DENIED_MARK = <span style={{ color: 'var(--bad)', fontWeight: 700 }}>✗ </span>
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
  useExpose({ stoppable: working && session.kind === 'background' ? id : undefined })
  const scrollToEnd = () => scroller.current?.scrollTo({ top: 0 })
  const shown = useRef(new Set<string>())
  const grows = useRef(new Map<string, boolean>())
  const entries = useOutbox(id)
  const sending = entries
    .filter(e => e.state === 'sending')
    .map(e => ({ text: outboxText(e), sent: e.acked || e.sent_at, entry: e }))
    .filter(
      ({ text }) =>
        !messages.some(m => m.role === 'user' && withoutAttachments(m.text).startsWith(withoutAttachments(text))),
    )
  for (const { text } of sending) if (!grows.current.has(text)) grows.current.set(text, !shown.current.has(text))

  useEffect(() => {
    for (const entry of entries) shown.current.add(outboxText(entry))
  })

  useEffect(() => {
    scrollToEnd()
  }, [
    messages.findLast(m => m.role === 'user' && !isTool(m))?.uuid,
    entries.find(e => e.state !== 'sending')?.queued_at,
  ])

  useEffect(() => {
    run('sessions.transcript', { session: id }).catch((e: Error) => setError(e.message))
    return () => void mutate('sessions.transcript_close', { session: id })
  }, [id])

  if (!initial.current && messages.length) initial.current = new Set(messages.map(m => m.uuid))
  if (!session) return <div className="empty">Loading session…</div>
  const groups = messages.reduce<(Message | Message[])[]>((all, m) => {
    const last = all.at(-1)
    if (!isTool(m)) all.push(m)
    else if (Array.isArray(last)) last.push(m)
    else all.push([m])
    return all
  }, [])
  const denied = new Set(groups.flatMap(group => (Array.isArray(group) ? deniedTools(group) : [])))
  const shownGroups = groups.flatMap<Message | Message[]>(group =>
    Array.isArray(group)
      ? group.reduce<Message[][]>((runs, m) => {
          const run = runs.at(-1)
          if (run && denied.has(run[0].uuid) === denied.has(m.uuid)) run.push(m)
          else runs.push([m])
          return runs
        }, [])
      : [group],
  )
  const last = messages.at(-1)
  const typing = working && !(last?.role === 'assistant' && !isTool(last))
  const decision = session.decision && WAITING.includes(session.status) ? JSON.parse(session.decision) : null
  const fail = (e: Error) => setError(e.message)
  const folder = session.cwd?.replace(/^\/(Users|home)\/[^/]+/, '~') ?? ''
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--panel)' }}>
      <div style={HEADER}>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <input
            key={session.title}
            defaultValue={session.title}
            placeholder="Title (empty restores the default)"
            aria-label="Session title"
            title="Rename"
            className="inline-edit"
            style={{ ...ELLIPSIS, display: 'block', width: '100%', fontWeight: 600 }}
            onKeyDown={e => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                e.stopPropagation()
                e.currentTarget.value = session.title
                e.currentTarget.blur()
              }
            }}
            onBlur={e => {
              if (e.currentTarget.value.trim() !== session.title)
                mutate('sessions.rename', { id, title: e.currentTarget.value }).catch(fail)
            }}
          />
          <div style={{ ...ELLIPSIS, color: 'var(--muted)', fontSize: 12 }} title={session.cwd ?? undefined}>
            {mobile ? (
              hostName(session)
            ) : (
              <a
                href="#"
                title={session.kind === 'background' ? 'Open in a terminal' : `Open in ${hostName(session)}`}
                onClick={e => {
                  e.preventDefault()
                  run('sessions.open', { session: id }).catch(fail)
                }}
              >
                {hostName(session)}
              </a>
            )}{' '}
            ·{' '}
            <input
              key={folder}
              defaultValue={folder}
              placeholder="No folder"
              aria-label="Session folder"
              disabled={!!session.live && session.kind !== 'background'}
              title={
                session.live && session.kind !== 'background'
                  ? 'Close the session to change its folder'
                  : 'Change folder: the session resumes there on its next message'
              }
              className="inline-edit"
              onKeyDown={e => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  e.currentTarget.value = folder
                  e.currentTarget.blur()
                }
              }}
              onBlur={e => {
                const cwd = e.currentTarget.value.trim()
                if (cwd && cwd !== folder) run('sessions.move', { session: id, cwd }).catch(fail)
                else e.currentTarget.value = folder
              }}
            />{' '}
            ·{' '}
            <a
              href="#"
              title={id}
              onClick={e => {
                e.preventDefault()
                navigator.clipboard.writeText(id).catch(fail)
              }}
            >
              Copy id
            </a>
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
          {shownGroups.map(group => {
            const uuid = Array.isArray(group) ? group[0].uuid : group.uuid
            const seen =
              initial.current?.has(uuid) ||
              (!Array.isArray(group) &&
                group.role === 'user' &&
                [...shown.current].some(prompt =>
                  withoutAttachments(group.text).startsWith(withoutAttachments(prompt)),
                ))
            return (
              <div key={uuid} className={seen ? undefined : 'grow'}>
                <div>
                  {Array.isArray(group) ? (
                    <details style={BUBBLE}>
                      <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>
                        {denied.has(group[0].uuid) && DENIED_MARK}
                        {toolSummary(group)}
                      </summary>
                      {group.map(m => (
                        <div key={m.uuid} style={TOOL_LINE}>
                          {denied.has(m.uuid) && m.text.startsWith('→ ') && DENIED_MARK}
                          {m.text}
                        </div>
                      ))}
                    </details>
                  ) : group.role === 'subagent' || group.role === 'peer' ? (
                    <details style={BUBBLE}>
                      <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>
                        {group.role === 'subagent' ? 'Subagent returned' : 'Message from another agent'}
                      </summary>
                      <div className="message" dangerouslySetInnerHTML={{ __html: renderMarkdown(group.text) }} />
                    </details>
                  ) : group.role === 'notification' ? (
                    <details style={BUBBLE}>
                      <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>
                        Background command finished
                      </summary>
                      <div style={TOOL_LINE}>{group.text}</div>
                    </details>
                  ) : group.role === 'command' ? (
                    <details style={BUBBLE}>
                      <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>
                        Command output
                      </summary>
                      <div style={TOOL_LINE}>{group.text}</div>
                    </details>
                  ) : group.role === 'user' && SKILL.test(group.text) ? (
                    <details style={BUBBLE}>
                      <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12 }}>
                        Skill loaded · {group.text.match(SKILL)![1]}
                      </summary>
                      <div style={TOOL_LINE}>{group.text}</div>
                    </details>
                  ) : (
                    <Bubble
                      role={group.role}
                      label={`${new Date(group.at).toLocaleTimeString()}${group.tokens ? ` · ${Math.round(group.tokens / 1000)}k context` : ''}`}
                      text={group.text}
                    />
                  )}
                </div>
              </div>
            )
          })}
          {sending.map(({ text, sent, entry }) => (
            <div key={text} className={grows.current.get(text) ? 'grow' : undefined}>
              <div>
                {interruptible(session, entry) ? (
                  <Bubble
                    role="user"
                    label="Waiting for Claude to pause"
                    text={text}
                    faded
                    action={
                      <button
                        type="button"
                        className="ghost"
                        style={QUEUE_BUTTON}
                        title="Stop Claude's turn so it reads this now (⌘↩ with an empty message box)"
                        onClick={() => run('sessions.stop', { session: id }).catch(fail)}
                      >
                        Interrupt
                      </button>
                    }
                  />
                ) : (
                  <Bubble role="user" label={sent ? 'Sent' : 'Sending'} text={text} faded />
                )}
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
          <QueuedMessage session={session} onError={setError} />
        </div>
      </div>
      <div className="composer-footer">
        {decision && <DecisionPanel session={session} decision={decision} onError={setError} />}
        <Composer session={session} onError={setError} onQueued={scrollToEnd} />
      </div>
    </div>
  )
}
