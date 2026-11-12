import { Component, type ReactNode } from 'react'
import * as bridge from './bridge'

type Props = { card: string; root?: boolean; children: ReactNode }

/** Shows and reports a card's render error. At the root it also offers to revert the folder's last commit. */
export class Boundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(thrown: unknown) {
    return { error: bridge.toError(thrown) }
  }

  componentDidCatch(thrown: unknown) {
    const { message, stack = '' } = bridge.toError(thrown)
    bridge.reportError(this.props.card, message, stack)
  }

  revert = () =>
    bridge.revertLastCommit().then(
      () => location.reload(),
      error => alert(error),
    )

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="card-error">
        <b>{this.props.card}</b>: {error.message}
        <pre>{error.stack}</pre>
        {this.props.root && <button onClick={this.revert}>Revert last commit</button>}
      </div>
    )
  }
}
