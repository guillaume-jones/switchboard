import { useState, type CSSProperties, type ReactNode } from 'react'
import { Item, mutate, useConnection, useQuery } from 'switchboard'

type AttentionItem = { id: number; ref: string; reason: string | null; level: number }
type Rule = { rule: string; disabled_reason: string | null }
type Run = { id: string; command: string; started_at: string | null }
type CoreEvent = { id: number; time: string; name: string; message: string }
type WeeklyUsage = { percent: number; resets: string }

const URGENT_LEVEL = 2
const attentionColor = (level: number) => (level >= URGENT_LEVEL ? 'var(--accent)' : 'var(--info)')
const RECENT_ERRORS = 20
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const LINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '4px 0' }
const MUTED: CSSProperties = { color: 'var(--muted)' }
const ACTION: CSSProperties = { marginLeft: 'auto' }

/** Open attention items, disabled rules, runs in an unknown state and recent errors: a count that opens them in a modal. */
export default function Health() {
  const attention = useQuery<AttentionItem>('attention_open') ?? []
  const disabledRules = useQuery<Rule>('core_rules', { enabled: 0 }) ?? []
  const unknownRuns = useQuery<Run>('core_runs', { state: 'unknown' }) ?? []
  const recentErrors = useQuery<CoreEvent>('core.events', { kind: 'error', limit: RECENT_ERRORS }) ?? []
  const clearedThrough = useQuery<{ through: number }>('attention_errors_cleared')?.[0]?.through ?? 0
  const errors = recentErrors.filter(event => event.id > clearedThrough)
  const usage = useQuery<WeeklyUsage>('claude_weekly')?.[0]
  const [open, setOpen] = useState(false)
  const [usageTipOpen, setUsageTipOpen] = useState(false)
  const connection = useConnection()
  const online = connection.state === 'online'
  const connectionLabel =
    connection.state === 'reconnecting'
      ? 'Reconnecting'
      : `Offline${connection.asOf ? ` as of ${clock(connection.asOf)}` : ''}`
  const connectionDot = (
    <span
      className="dot"
      style={{ '--tone': connection.state === 'reconnecting' ? 'var(--warn)' : 'var(--bad)' } as CSSProperties}
    />
  )

  const problems = [
    { count: attention.length, one: 'attention item', many: 'attention items' },
    { count: disabledRules.length, one: 'disabled rule', many: 'disabled rules' },
    { count: unknownRuns.length, one: 'unknown run', many: 'unknown runs' },
    { count: errors.length, one: 'error', many: errors.length < RECENT_ERRORS ? 'errors' : 'recent errors' },
  ].filter(problem => problem.count > 0)
  const healthy = online && problems.length === 0
  const failures = disabledRules.length + unknownRuns.length + errors.length
  const summary = healthy
    ? 'healthy'
    : [
        ...(online ? [] : [connectionLabel]),
        ...problems.map(({ count, one, many }) => `${count} ${count === 1 ? one : many}`),
      ].join(' · ')

  const details = (
    <div style={{ padding: '8px 12px' }}>
      {healthy && (
        <div className="empty">
          <span className="dot" style={{ '--tone': 'var(--good)', display: 'inline-block' } as CSSProperties} /> All
          healthy
        </div>
      )}
      {!online && (
        <div style={LINE}>
          {connectionDot}
          <span>{connectionLabel}: showing the last data seen; writes and runs are queued until reconnected</span>
        </div>
      )}
      <Section title="Attention">
        {attention.map(item => (
          <div key={item.id} style={LINE}>
            <span className="dot" style={{ '--tone': attentionColor(item.level) } as CSSProperties} />
            <Item ref={item.ref} />
            <span style={{ ...MUTED, flex: 1 }}>{item.reason}</span>
            <button onClick={() => mutate('attention.clear', { ref: item.ref })} style={ACTION}>
              Clear
            </button>
          </div>
        ))}
      </Section>
      <Section title="Disabled rules">
        {disabledRules.map(rule => (
          <div key={rule.rule} style={LINE}>
            <span>{rule.rule}</span>
            <span style={{ ...MUTED, flex: 1 }}>{rule.disabled_reason}</span>
            <button onClick={() => mutate('core.rule_enable', { rule: rule.rule })} style={ACTION}>
              Enable
            </button>
          </div>
        ))}
      </Section>
      <Section title="Unknown runs">
        {unknownRuns.map(run => (
          <div key={run.id} style={LINE}>
            <span>{run.command}</span>
            <span style={MUTED}>{run.started_at}</span>
          </div>
        ))}
      </Section>
      <Section
        title="Recent errors"
        action={
          <button className="ghost" onClick={() => mutate('attention.clear_errors', { through: errors[0]?.id })}>
            Clear all
          </button>
        }
      >
        {errors.map(event => (
          <div key={event.id} style={LINE}>
            <span style={{ ...MUTED, whiteSpace: 'nowrap' }}>{event.time}</span>
            <span>{event.name}</span>
            <span style={{ color: 'var(--bad)' }}>{event.message}</span>
          </div>
        ))}
      </Section>
    </div>
  )

  return (
    <>
      {usage && (
        <div
          className="usage"
          tabIndex={0}
          data-open={usageTipOpen || undefined}
          onClick={() => setUsageTipOpen(isOpen => !isOpen)}
          onBlur={() => setUsageTipOpen(false)}
        >
          <span className="usage-tip">
            Claude weekly usage: {usage.percent}%
            <br />
            Resets {usage.resets.replace(/ \(.*\)$/, '').replace(/(\d)([ap]m)$/, '$1 $2')}
          </span>
          <span>Usage</span>
          <div className="usage-bar">
            <div style={{ width: `${Math.min(usage.percent, 100)}%` }} />
          </div>
        </div>
      )}
      <button onClick={() => setOpen(isOpen => !isOpen)} title={summary} className="ghost health">
        <span style={{ flex: 1, textAlign: 'left' }}>{online ? 'Health' : connectionLabel}</span>
        {healthy && <span className="dot" style={{ '--tone': 'var(--good)' } as CSSProperties} />}
        {!online && connectionDot}
        {attention.length > 0 && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              color: attentionColor(Math.max(...attention.map(item => item.level))),
            }}
          >
            <span className="dot" style={{ '--tone': 'currentColor' } as CSSProperties} />
            {attention.length}
          </span>
        )}
        {failures > 0 && <span style={{ color: 'var(--bad)' }}>▲ {failures}</span>}
      </button>
      <div className="backdrop" data-closed={!open || undefined} onClick={() => setOpen(false)} />
      <div className="modal" data-closed={!open || undefined} role="dialog" aria-label="Health">
        {details}
      </div>
    </>
  )
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode[] }) {
  if (children.length === 0) return null
  return (
    <div style={{ margin: '4px 0 10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
        <span className="heading">{title}</span>
        {action}
      </div>
      {children}
    </div>
  )
}
