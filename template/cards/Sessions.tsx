import { useEffect, useState, type CSSProperties } from 'react'
import { mutate, run, useQuery, type CardProps } from 'switchboard'

type Session = {
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
type Decision = { tool_name: string; tool_input: Record<string, any>; at: number }
type Question = {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

const ROW: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid var(--border)' }
const MUTED: CSSProperties = { color: 'var(--muted)' }
const MESSAGE: CSSProperties = { whiteSpace: 'pre-wrap', margin: '4px 0', maxHeight: 160, overflow: 'auto' }
const WAITING = ['needs_permission', 'needs_input']

const HOSTS: Record<string, string> = {
  switchboard: 'Switchboard',
  'dev.zed.Zed': 'Zed',
  'com.mitchellh.ghostty': 'Ghostty',
  'com.apple.Terminal': 'Terminal',
  'com.googlecode.iterm2': 'iTerm',
}

const busy = (session: Session) => session.run_state === 'running' || session.run_state === 'queued'

/** Claude sessions: status, last message, decisions to answer, follow-ups (owned sessions) or pokes (others). */
export default function Sessions({ limit = 30 }: CardProps<{ limit?: number }>) {
  const sessions = useQuery<Session>('sessions.recent', { limit }) ?? []
  const [queued, setQueued] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    for (const session of sessions) {
      const prompt = queued[session.id]
      if (prompt === undefined || busy(session)) continue
      setQueued(({ [session.id]: _, ...rest }) => rest)
      followUp(session, prompt).catch((e: Error) => setError(e.message))
    }
  }, [sessions, queued])

  return (
    <div>
      {error && <div style={{ ...ROW, color: 'var(--bad)' }}>{error}</div>}
      {sessions.length === 0 && <div style={{ ...ROW, ...MUTED }}>No sessions yet</div>}
      {sessions.map(session => (
        <SessionRow
          key={session.id}
          session={session}
          queued={queued[session.id]}
          onQueue={prompt => setQueued(q => ({ ...q, [session.id]: prompt }))}
          onError={setError}
        />
      ))}
    </div>
  )
}

function followUp(session: Session, prompt: string) {
  return session.run_command === 'sessions.edit'
    ? run('sessions.edit', { prompt, session: session.id })
    : run('sessions.headless', { prompt, session: session.id, cwd: session.cwd ?? '' })
}

function SessionRow({
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
  const [expanded, setExpanded] = useState(false)
  const decision: Decision | null = session.decision ? JSON.parse(session.decision) : null
  const fail = (e: Error) => onError(e.message)
  const send = (action: () => Promise<unknown>) => {
    if (!text.trim()) return
    action().then(() => setText(''), fail)
  }

  return (
    <div style={ROW}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {session.title}
        </span>
        <span style={{ color: WAITING.includes(session.status) ? 'var(--accent)' : 'var(--muted)' }}>
          {session.status}
        </span>
        <span style={MUTED}>{HOSTS[session.host ?? ''] ?? session.host ?? '?'}</span>
        <span style={MUTED}>{session.updated}</span>
        <button onClick={() => run('sessions.open', { session: session.id }).catch(fail)}>Open</button>
      </div>
      {session.last_message && (
        <div
          style={{ ...MESSAGE, maxHeight: expanded ? undefined : MESSAGE.maxHeight }}
          onClick={() => setExpanded(!expanded)}
        >
          {session.last_message}
        </div>
      )}
      {decision && WAITING.includes(session.status) && (
        <DecisionPanel session={session} decision={decision} onError={onError} />
      )}
      {session.status !== 'ended' || session.owned ? (
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
      ) : null}
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
      <pre style={{ ...MESSAGE, fontFamily: 'ui-monospace, monospace' }}>{input}</pre>
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
