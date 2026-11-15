import { useState, type CSSProperties, type ReactNode } from 'react'
import { Item, mutate, useQuery } from 'switchboard'

type AttentionItem = { id: number; ref: string; reason: string | null; level: number }
type Rule = { rule: string; disabled_reason: string | null }
type Run = { id: string; command: string; started_at: string | null }
type CoreEvent = { id: number; time: string; name: string; message: string }

const URGENT_LEVEL = 2
const attentionColor = (level: number) => (level >= URGENT_LEVEL ? 'var(--accent)' : 'var(--info)')
const RECENT_ERRORS = 20

const LINE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '4px 0' }
const MUTED: CSSProperties = { color: 'var(--muted)' }
const ACTION: CSSProperties = { marginLeft: 'auto' }
const POPOVER: CSSProperties = {
  position: 'absolute',
  right: 0,
  top: 'calc(100% + 10px)',
  width: 'min(520px, calc(100vw - 20px))',
  maxHeight: '60vh',
  overflow: 'auto',
  background: 'var(--panel)',
  border: '1px solid color-mix(in srgb, var(--fg) 14%, transparent)',
  borderRadius: 'var(--radius)',
  boxShadow: '0 16px 48px #000b',
  zIndex: 1,
}
const BACKDROP: CSSProperties = { position: 'fixed', inset: 0, background: '#0008' }
const SUMMARY_BUTTON: CSSProperties = {
  border: 'none',
  background: 'none',
  padding: '0 2px',
  fontWeight: 600,
  opacity: 1,
}

/** Open attention items, disabled rules, runs in an unknown state and recent errors: a count with a popover. */
export default function Health() {
  const attention = useQuery<AttentionItem>('attention_open') ?? []
  const disabledRules = useQuery<Rule>('core_rules', { enabled: 0 }) ?? []
  const unknownRuns = useQuery<Run>('core_runs', { state: 'unknown' }) ?? []
  const recentErrors = useQuery<CoreEvent>('core.events', { kind: 'error', limit: RECENT_ERRORS }) ?? []
  const clearedThrough = useQuery<{ through: number }>('attention_errors_cleared')?.[0]?.through ?? 0
  const errors = recentErrors.filter(event => event.id > clearedThrough)
  const [open, setOpen] = useState(false)

  const problems = [
    { count: attention.length, one: 'attention item', many: 'attention items' },
    { count: disabledRules.length, one: 'disabled rule', many: 'disabled rules' },
    { count: unknownRuns.length, one: 'unknown run', many: 'unknown runs' },
    { count: errors.length, one: 'error', many: errors.length < RECENT_ERRORS ? 'errors' : 'recent errors' },
  ].filter(problem => problem.count > 0)
  const healthy = problems.length === 0
  const failures = disabledRules.length + unknownRuns.length + errors.length
  const summary = healthy
    ? 'healthy'
    : problems.map(({ count, one, many }) => `${count} ${count === 1 ? one : many}`).join(' · ')

  const details = (
    <div style={{ padding: '8px 12px' }}>
      {healthy && (
        <div className="empty">
          <span style={{ color: 'var(--good)' }}>●</span> All healthy
        </div>
      )}
      <Section title="Attention">
        {attention.map(item => (
          <div key={item.id} style={LINE}>
            <span style={{ color: attentionColor(item.level) }}>●</span>
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
    <span style={{ position: 'relative' }}>
      <button onClick={() => setOpen(isOpen => !isOpen)} title={summary} style={SUMMARY_BUTTON}>
        {healthy && <span style={{ color: 'var(--good)' }}>●</span>}
        {attention.length > 0 && (
          <span style={{ color: attentionColor(Math.max(...attention.map(item => item.level))) }}>
            ● {attention.length}
          </span>
        )}
        {failures > 0 && <span style={{ color: 'var(--bad)' }}>▲ {failures}</span>}
      </button>
      {open && (
        <>
          <div style={BACKDROP} onClick={() => setOpen(false)} />
          <div style={POPOVER}>{details}</div>
        </>
      )}
    </span>
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
