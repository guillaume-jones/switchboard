import { useEffect, useState, type CSSProperties } from 'react'
import { CardSlot, mutate, run, useQuery, type CardProps } from 'switchboard'
import { renderMarkdown } from './lib/markdown'
import { busy, Composer, followUp, Spinner, type Session } from './lib/sessions'

type Decision = { tool_name: string; tool_input: Record<string, any>; at: number }
type Question = {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

const ROW: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid var(--border)' }
const MUTED: CSSProperties = { color: 'var(--muted)' }
const MESSAGE: CSSProperties = { margin: '4px 0', maxHeight: 160, overflow: 'auto' }
const WAITING = ['needs_permission', 'needs_input']
const ICON_BUTTON: CSSProperties = {
  border: 'none',
  background: 'none',
  padding: '0 2px',
  cursor: 'pointer',
  color: 'var(--muted)',
}

const HOSTS: Record<string, string> = {
  switchboard: 'Switchboard',
  'dev.zed.Zed': 'Zed',
  'com.mitchellh.ghostty': 'Ghostty',
  'com.apple.Terminal': 'Terminal',
  'com.googlecode.iterm2': 'iTerm',
}

/**
 * Claude sessions: status, last prompt and reply, decisions to answer, follow-ups (owned sessions) or pokes (others).
 * Transcript opens a `Transcript` tile on the grid this card is in (its slot is `<grid>/<tile>`), else inline. Rows
 * start collapsed to their header (expanded rows are kept per card in localStorage) and can be hidden (`sessions.hide`) until unhidden.
 */
export default function Sessions({ limit = 30, slot }: CardProps<{ limit?: number }>) {
  const grid = slot?.includes('/') ? slot.split('/')[0] : undefined
  const [showHidden, setShowHidden] = useState(false)
  const sessions = useQuery<Session>('sessions.recent', { limit, hidden: showHidden ? 1 : 0 }) ?? []
  const expandedKey = `Sessions.expanded.${slot}`
  const [expanded, setExpanded] = useState<string[]>(() => JSON.parse(localStorage.getItem(expandedKey) ?? '[]'))
  const toggleExpanded = (id: string) => {
    const next = expanded.includes(id) ? expanded.filter(e => e !== id) : [...expanded, id]
    localStorage.setItem(expandedKey, JSON.stringify(next))
    setExpanded(next)
  }
  const [queued, setQueued] = useState<Record<string, string>>({})
  /**
   * Follow-ups just sent, shown with a spinner until the session has received the prompt and stopped working, or for at
   * most a minute in case the run fails before Claude starts.
   */
  const [sent, setSent] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const markSent = (session: Session, prompt: string) => {
    setSent(s => ({ ...s, [session.id]: prompt }))
    setTimeout(() => setSent(({ [session.id]: _, ...rest }) => rest), 60_000)
  }

  useEffect(() => {
    const settled = sessions.filter(session => sent[session.id] === session.last_prompt && session.status !== 'working')
    if (settled.length)
      setSent(s => Object.fromEntries(Object.entries(s).filter(([id]) => !settled.some(x => x.id === id))))
  }, [sessions, sent])

  useEffect(() => {
    for (const session of sessions) {
      const prompt = queued[session.id]
      if (prompt === undefined || busy(session)) continue
      setQueued(({ [session.id]: _, ...rest }) => rest)
      followUp(session, prompt).then(
        () => markSent(session, prompt),
        (e: Error) => setError(e.message),
      )
    }
  }, [sessions, queued])

  return (
    <div>
      {error && <div style={{ ...ROW, color: 'var(--bad)' }}>{error}</div>}
      {sessions.length === 0 && (
        <div style={{ ...ROW, ...MUTED }}>{showHidden ? 'No hidden sessions' : 'No sessions yet'}</div>
      )}
      {sessions.map(session => (
        <SessionRow
          key={session.id}
          session={session}
          queued={queued[session.id]}
          onQueue={prompt =>
            setQueued(({ [session.id]: _, ...rest }) =>
              prompt === undefined ? rest : { ...rest, [session.id]: prompt },
            )
          }
          onError={setError}
          onSent={prompt => markSent(session, prompt)}
          sent={sent[session.id]}
          grid={grid}
          collapsed={!expanded.includes(session.id)}
          onCollapse={() => toggleExpanded(session.id)}
          hidden={showHidden}
        />
      ))}
      <div style={{ ...ROW, borderBottom: 'none' }}>
        <button onClick={() => setShowHidden(!showHidden)}>{showHidden ? 'Back to sessions' : 'Show hidden'}</button>
      </div>
    </div>
  )
}

function SessionRow({
  session,
  queued,
  onQueue,
  onError,
  onSent,
  sent,
  grid,
  collapsed,
  onCollapse,
  hidden,
}: {
  session: Session
  queued: string | undefined
  onQueue: (prompt: string | undefined) => void
  onError: (message: string) => void
  onSent: (prompt: string) => void
  sent: string | undefined
  grid: string | undefined
  collapsed: boolean
  onCollapse: () => void
  hidden: boolean
}) {
  const prompt = sent ?? session.last_prompt
  const working = sent !== undefined || session.status === 'working'
  const [expanded, setExpanded] = useState(false)
  const [transcript, setTranscript] = useState(false)
  const decision: Decision | null = session.decision ? JSON.parse(session.decision) : null
  const fail = (e: Error) => onError(e.message)

  return (
    <div style={ROW}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <button title={collapsed ? 'Expand' : 'Collapse'} onClick={onCollapse} style={ICON_BUTTON}>
          {collapsed ? '▸' : '▾'}
        </button>
        <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {session.title}
        </span>
        <span style={{ color: WAITING.includes(session.status) ? 'var(--accent)' : 'var(--muted)' }}>
          {session.status}
        </span>
        <span style={MUTED}>{HOSTS[session.host ?? ''] ?? session.host ?? '?'}</span>
        <span style={MUTED}>{session.updated}</span>
        <button
          onClick={() =>
            grid
              ? mutate('ui.tile_add', {
                  grid,
                  id: `transcript-${session.id}`,
                  component: 'Transcript',
                  props: JSON.stringify({ session: session.id }),
                }).catch(fail)
              : setTranscript(!transcript)
          }
        >
          {transcript ? 'Hide' : 'Transcript'}
        </button>
        <button onClick={() => run('sessions.open', { session: session.id }).catch(fail)}>External</button>
        <button
          title={hidden ? 'Unhide' : 'Hide'}
          onClick={() => mutate(hidden ? 'sessions.unhide' : 'sessions.hide', { id: session.id }).catch(fail)}
          style={ICON_BUTTON}
        >
          {hidden ? '↺' : '×'}
        </button>
      </div>
      {!collapsed && prompt && (
        <div style={{ ...MUTED, margin: '4px 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          You: {prompt}
        </div>
      )}
      {collapsed ? null : working ? (
        <Spinner />
      ) : (
        session.last_message && (
          <div
            style={{ ...MESSAGE, maxHeight: expanded ? undefined : MESSAGE.maxHeight }}
            onClick={() => setExpanded(!expanded)}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(session.last_message) }}
          />
        )
      )}
      {decision && WAITING.includes(session.status) && (
        <DecisionPanel session={session} decision={decision} onError={onError} />
      )}
      {collapsed ? null : transcript ? (
        <CardSlot component="Transcript" props={{ session: session.id }} id={`transcript-${session.id}`} />
      ) : (
        <Composer session={session} queued={queued} onQueue={onQueue} onError={onError} onSent={onSent} />
      )}
    </div>
  )
}

function DecisionPanel({
  session,
  decision,
  onError,
}: {
  session: Session
  decision: Decision
  onError: (m: string) => void
}) {
  const answer = (value: Record<string, unknown>) =>
    mutate('sessions.decide', { id: session.id, at: decision.at, answer: JSON.stringify(value) }).catch((e: Error) =>
      onError(e.message),
    )
  const deny = () => answer({ behavior: 'deny', message: 'Denied from Switchboard' })
  const panel: CSSProperties = { margin: '4px 0', padding: 6, background: 'var(--panel)', borderRadius: 4 }

  if (decision.tool_name === 'AskUserQuestion') {
    const questions: Question[] = decision.tool_input.questions ?? []
    return (
      <Questions
        questions={questions}
        style={panel}
        onAnswer={answers => answer({ behavior: 'allow', updatedInput: { questions, answers } })}
      />
    )
  }
  const input =
    decision.tool_name === 'ExitPlanMode' ? decision.tool_input.plan : JSON.stringify(decision.tool_input, null, 2)
  return (
    <div style={panel}>
      <div style={{ fontWeight: 600 }}>
        {decision.tool_name === 'ExitPlanMode' ? 'Approve plan?' : `Allow ${decision.tool_name}?`}
      </div>
      <pre style={{ ...MESSAGE, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace' }}>{input}</pre>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => answer({ behavior: 'allow' })}>Allow</button>
        <button onClick={deny}>Deny</button>
      </div>
    </div>
  )
}

function Questions({
  questions,
  style,
  onAnswer,
}: {
  questions: Question[]
  style: CSSProperties
  onAnswer: (answers: Record<string, string>) => void
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const toggle = (q: Question, label: string) =>
    setPicked(p => {
      const current = p[q.question] ?? []
      const next = q.multiSelect
        ? current.includes(label)
          ? current.filter(l => l !== label)
          : [...current, label]
        : [label]
      return { ...p, [q.question]: next }
    })
  const complete = questions.every(q => (picked[q.question] ?? []).length > 0)
  return (
    <div style={style}>
      {questions.map(q => (
        <div key={q.question} style={{ marginBottom: 6 }}>
          <div style={{ fontWeight: 600 }}>{q.question}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {q.options.map(o => (
              <button
                key={o.label}
                title={o.description}
                onClick={() => toggle(q, o.label)}
                style={(picked[q.question] ?? []).includes(o.label) ? { borderColor: 'var(--accent)' } : undefined}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <button
        disabled={!complete}
        onClick={() =>
          onAnswer(Object.fromEntries(questions.map(q => [q.question, (picked[q.question] ?? []).join(', ')])))
        }
      >
        Answer
      </button>
    </div>
  )
}
