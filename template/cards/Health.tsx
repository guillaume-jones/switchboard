import { useState, type CSSProperties, type ReactNode } from 'react'
import { Item, mutate, useQuery, type CardProps } from 'switchboard'

type AttentionItem = { id: number; ref: string; reason: string | null; level: number }
type Rule = { rule: string; disabled_reason: string | null }
type Run = { id: string; command: string; started_at: string | null }
type CoreEvent = { id: number; time: string; name: string; message: string }

const URGENT_LEVEL = 2
const RECENT_ERRORS = 20

const LINE: CSSProperties = { display: 'flex', gap: 8, alignItems: 'baseline' }
const MUTED: CSSProperties = { color: 'var(--muted)' }
const POPOVER: CSSProperties = {
  position: 'absolute',
  right: 0,
  top: '100%',
  width: 520,
  maxHeight: '60vh',
  overflow: 'auto',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  zIndex: 5,
}
const SUMMARY_BUTTON: CSSProperties = { border: 'none', background: 'none', padding: 0, cursor: 'pointer' }

/** Open attention items, disabled rules, runs in an unknown state and recent errors. Compact: a summary with a popover. */
export default function Health({ size }: CardProps) {
  const attention = useQuery<AttentionItem>('attention_open') ?? []
  const disabledRules = useQuery<Rule>('core_rules', { enabled: 0 }) ?? []
  const unknownRuns = useQuery<Run>('core_runs', { state: 'unknown' }) ?? []
  const errors = useQuery<CoreEvent>('core.events', { kind: 'error', limit: RECENT_ERRORS }) ?? []
  const [open, setOpen] = useState(false)

  const problems = [
    { count: attention.length, one: 'attention item', many: 'attention items' },
    { count: disabledRules.length, one: 'disabled rule', many: 'disabled rules' },
    { count: unknownRuns.length, one: 'unknown run', many: 'unknown runs' },
    { count: errors.length, one: 'error', many: errors.length < RECENT_ERRORS ? 'errors' : 'recent errors' },
  ].filter(problem => problem.count > 0)
  const healthy = problems.length === 0
  const summary = healthy
    ? 'healthy'
    : problems.map(({ count, one, many }) => `${count} ${count === 1 ? one : many}`).join(' · ')

  const details = (
    <div style={{ padding: 8 }}>
      {healthy && <span style={MUTED}>healthy</span>}
      <Section title="Attention">
        {attention.map(item => (
          <div key={item.id} style={LINE}>
            <span style={{ color: item.level >= URGENT_LEVEL ? 'var(--bad)' : undefined }}>●</span>
            <Item ref={item.ref} />
            <span style={{ ...MUTED, flex: 1 }}>{item.reason}</span>
            <button onClick={() => mutate('attention.clear', { ref: item.ref })}>clear</button>
          </div>
        ))}
      </Section>
      <Section title="Disabled rules">
        {disabledRules.map(rule => (
          <div key={rule.rule} style={LINE}>
            <span>{rule.rule}</span>
            <span style={{ ...MUTED, flex: 1 }}>{rule.disabled_reason}</span>
            <button onClick={() => mutate('core.rule_enable', { rule: rule.rule })}>enable</button>
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
      <Section title="Recent errors">
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

  if (size === 'full') return details
  return (
    <span style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(isOpen => !isOpen)}
        disabled={healthy}
        style={{ ...SUMMARY_BUTTON, color: healthy ? 'var(--muted)' : 'var(--bad)' }}
      >
        {summary}
      </button>
      {open && !healthy && <div style={POPOVER}>{details}</div>}
    </span>
  )
}

function Section({ title, children }: { title: string; children: ReactNode[] }) {
  if (children.length === 0) return null
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      {children}
    </div>
  )
}
