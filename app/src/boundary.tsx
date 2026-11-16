import { Component, type ReactNode } from 'react'
import * as bridge from './bridge'
import type { LoadedCard } from './cards'

const GRACE_MS = 10_000

type Props = { card: string; root?: boolean; loaded?: LoadedCard; previous?: () => ReactNode; children: ReactNode }

/**
 * Shows and reports a card's error. A version that fails within GRACE_MS of replacing a working one, as while an agent
 * is still editing it, shows that previous version until then. At the root it also offers to revert the folder's last
 * commit.
 */
export class Boundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }
  timer = 0

  static getDerivedStateFromError(thrown: unknown) {
    return { error: bridge.toError(thrown) }
  }

  componentDidCatch() {
    if (this.props.loaded) this.props.loaded.failed = true
    const wait = this.graceLeft()
    if (wait <= 0) return this.report()
    this.timer = window.setTimeout(() => {
      this.report()
      this.forceUpdate()
    }, wait)
  }

  componentWillUnmount() {
    clearTimeout(this.timer)
  }

  graceLeft() {
    const replaced = this.props.loaded?.replaced
    return replaced ? replaced.at + GRACE_MS - Date.now() : 0
  }

  report() {
    const { message, stack = '' } = this.state.error!
    bridge.reportError(this.props.card, message, stack)
  }

  revert = () =>
    bridge.revertLastCommit().then(
      () => location.reload(),
      error => alert(error),
    )

  render() {
    const { error } = this.state
    const { previous, children } = this.props
    if (!error) return children
    if (previous && this.graceLeft() > 0) return previous()
    return (
      <div className="card-error">
        <b>{this.props.card}</b>: {error.message}
        <pre>{error.stack}</pre>
        {this.props.root && <button onClick={this.revert}>Revert last commit</button>}
      </div>
    )
  }
}
