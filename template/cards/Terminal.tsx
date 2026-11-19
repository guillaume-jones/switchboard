import { useEffect, useRef, useState } from 'react'
import { run, useQuery, type CardProps } from 'switchboard'
import { useMobile } from './lib/theme'
import { Terminal as XTerm } from './lib/xterm'
import { FitAddon } from './lib/xterm-fit'
import { XTERM_CSS } from './lib/xterm-css'

const THEME = {
  background: '#16181c',
  foreground: '#fbfbfb',
  cursor: '#0099ff',
  cursorAccent: '#bfdbfe',
  selectionBackground: '#bfdbfe',
  selectionForeground: '#000000',
  black: '#191919',
  red: '#aa342e',
  green: '#4b8c0f',
  yellow: '#dbba00',
  blue: '#1370d3',
  magenta: '#c43ac3',
  cyan: '#008eb0',
  white: '#bebebe',
  brightBlack: '#525252',
  brightRed: '#f05b50',
  brightGreen: '#95dc55',
  brightYellow: '#ffe763',
  brightBlue: '#60a4ec',
  brightMagenta: '#e26be2',
  brightCyan: '#60b6cb',
  brightWhite: '#f7f7f7',
}

const arrow = (key: string) => (term: XTerm) => (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + key
/** Keys a phone keyboard lacks. */
const KEYS: [string, string | ((term: XTerm) => string)][] = [
  ['Esc', '\x1b'],
  ['^C', '\x03'],
  ['Tab', '\t'],
  ['⇧Tab', '\x1b[Z'],
  ['↑', arrow('A')],
  ['↓', arrow('B')],
]

/**
 * A tmux session, through term.serve's ttyd: on the desktop at 127.0.0.1:7681, elsewhere through the tailnet at :7682,
 * passing the token in `term_token` as the first URL arg, which files/attach requires. Sized to the visible viewport so an on-screen keyboard shrinks it instead
 * of covering the prompt. A vertical swipe scrolls one line per row the finger moves, as one-line wheel events that
 * xterm.js passes on to tmux (mouse mode, one line per event, set by term.list), and a flick keeps scrolling. Trackpad and mouse wheel pixels go through the same conversion. Shift+Enter
 * sends Esc + Return, which Claude reads as a new line. On a phone, a key bar sends the keys its keyboard lacks.
 */
export default function Terminal({ name }: CardProps<{ name: string }>) {
  const live = useQuery('term_items', { name })
  const token = useQuery<{ token: string }>('term_token')?.[0]?.token
  const mobile = useMobile()
  const box = useRef<HTMLDivElement>(null)
  const screen = useRef<HTMLDivElement>(null)
  const session = useRef<{ term: XTerm; input: (data: string) => void }>(null)
  const typing = useRef(false)
  const [height, setHeight] = useState<number>()
  const [connected, setConnected] = useState(true)
  const running = !!live?.length

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport || !box.current) return
    const fit = () => setHeight(viewport.offsetTop + viewport.height - (box.current?.getBoundingClientRect().top ?? 0))
    fit()
    viewport.addEventListener('resize', fit)
    viewport.addEventListener('scroll', fit)
    return () => {
      viewport.removeEventListener('resize', fit)
      viewport.removeEventListener('scroll', fit)
    }
  }, [running])

  useEffect(() => {
    const element = screen.current
    if (!running || !token || !element) return
    const term = new XTerm({
      fontFamily: 'Monaco, Menlo, monospace',
      fontSize: 13,
      scrollback: 0,
      macOptionClickForcesSelection: true,
      theme: THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    fit.fit()
    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(element)

    // ttyd: the first message is {AuthToken, columns, rows}, then '0' + input or '1' + {columns, rows}; it sends '0' + output.
    const encoder = new TextEncoder()
    const base = location.hostname.endsWith('.ts.net') ? `wss://${location.hostname}:7682` : 'ws://127.0.0.1:7681'
    let socket: WebSocket | undefined
    let failures = 0
    let retry = 0
    let disposed = false
    const send = (type: string, text: string) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(type + text))
    }
    const connect = () => {
      if (disposed || (socket && socket.readyState <= WebSocket.OPEN)) return
      const ws = new WebSocket(`${base}/ws?arg=${token}&arg=${encodeURIComponent(name)}`, ['tty'])
      socket = ws
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => {
        failures = 0
        term.reset()
        ws.send(encoder.encode(JSON.stringify({ AuthToken: '', columns: term.cols, rows: term.rows })))
        setConnected(true)
      }
      ws.onmessage = e => {
        const data = new Uint8Array(e.data as ArrayBuffer)
        if (data[0] === 48) term.write(data.subarray(1))
      }
      ws.onclose = () => {
        if (disposed) return
        setConnected(false)
        if (!document.hidden) retry = window.setTimeout(connect, Math.min(1000 * ++failures, 10000))
      }
    }
    const onVisible = () => document.hidden || connect()
    document.addEventListener('visibilitychange', onVisible)
    connect()

    const subscriptions = [
      term.onData(data => send('0', data)),
      term.onBinary(data => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(Uint8Array.from('0' + data, c => c.charCodeAt(0)))
      }),
      term.onResize(({ cols, rows }) => send('1', JSON.stringify({ columns: cols, rows }))),
    ]
    term.attachCustomKeyEventHandler(e => {
      if (e.key !== 'Enter' || !e.shiftKey) return true
      if (e.type === 'keydown') send('0', '\x1b\r')
      return false
    })

    let touch: { x: number; y: number; at: number; velocity: number; swiping: boolean } | null = null
    let glide = 0
    let partial = 0
    const scroll = (pixels: number, clientX: number, clientY: number) => {
      partial += pixels / (element.clientHeight / term.rows)
      const lines = Math.trunc(partial)
      partial -= lines
      for (let i = 0; i < Math.abs(lines); i++)
        term.element?.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: Math.sign(lines),
            deltaMode: WheelEvent.DOM_DELTA_LINE,
            clientX,
            clientY,
            bubbles: true,
            cancelable: true,
          }),
        )
    }
    term.attachCustomWheelEventHandler(e => {
      if (!e.isTrusted || e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || e.shiftKey) return true
      e.preventDefault()
      scroll(e.deltaY, e.clientX, e.clientY)
      return false
    })
    const onTouchStart = (e: TouchEvent) => {
      cancelAnimationFrame(glide)
      const { clientX, clientY } = e.touches[0]
      touch = e.touches.length === 1 ? { x: clientX, y: clientY, at: e.timeStamp, velocity: 0, swiping: false } : null
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!touch) return
      const { clientX, clientY } = e.touches[0]
      const deltaY = touch.y - clientY
      if (!touch.swiping) {
        if (Math.abs(clientX - touch.x) > Math.abs(deltaY)) touch = null
        if (!touch || Math.abs(deltaY) < 8) return
        touch.swiping = true
        partial = 0
      }
      e.preventDefault()
      touch.velocity = 0.8 * (deltaY / Math.max(e.timeStamp - touch.at, 1)) + 0.2 * touch.velocity
      Object.assign(touch, { x: clientX, y: clientY, at: e.timeStamp })
      scroll(deltaY, clientX, clientY)
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (touch?.swiping && e.timeStamp - touch.at < 100) {
        const { x, y } = touch
        let { velocity } = touch
        let last = performance.now()
        const step = (now: number) => {
          velocity *= 0.997 ** (now - last)
          if (Math.abs(velocity) < 0.03) return
          scroll(velocity * (now - last), x, y)
          last = now
          glide = requestAnimationFrame(step)
        }
        glide = requestAnimationFrame(step)
      }
      touch = null
    }
    element.addEventListener('touchstart', onTouchStart, { passive: true })
    element.addEventListener('touchmove', onTouchMove, { passive: false })
    element.addEventListener('touchend', onTouchEnd)

    session.current = { term, input: data => send('0', data) }
    if (!matchMedia('(pointer: coarse)').matches) term.focus()
    return () => {
      disposed = true
      session.current = null
      clearTimeout(retry)
      cancelAnimationFrame(glide)
      socket?.close()
      document.removeEventListener('visibilitychange', onVisible)
      element.removeEventListener('touchstart', onTouchStart)
      element.removeEventListener('touchmove', onTouchMove)
      element.removeEventListener('touchend', onTouchEnd)
      observer.disconnect()
      subscriptions.forEach(s => s.dispose())
      term.dispose()
    }
  }, [running, token, name])

  if (!live) return null
  if (!running)
    return (
      <div className="empty">
        <p>Terminal {name} is not running.</p>
        <button onClick={() => run('term.open', { name, cwd: '', chat: '' }).catch(console.error)}>Start it</button>
      </div>
    )
  return (
    <div
      ref={box}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        flex: height === undefined ? 1 : 'none',
        height,
      }}
    >
      <style>{XTERM_CSS}</style>
      <div
        ref={screen}
        style={{ flex: 1, minHeight: 0, padding: 4, background: THEME.background, touchAction: 'none' }}
      />
      {!connected && (
        <span className="chip" style={{ position: 'absolute', top: 12, left: '50%', translate: '-50% 0' }}>
          Reconnecting…
        </span>
      )}
      {mobile && (
        <div
          style={{
            display: 'flex',
            gap: 4,
            padding: '4px 14px 4px 20px',
            overflowX: 'auto',
            borderTop: '1px solid var(--border)',
          }}
        >
          {KEYS.map(([label, sequence]) => (
            <button
              key={label}
              className="ghost"
              style={{ flex: 'none', minWidth: 44 }}
              onPointerDown={e => {
                e.preventDefault()
                const current = session.current
                if (!current) return
                typing.current = document.activeElement === current.term.textarea
                current.input(typeof sequence === 'string' ? sequence : sequence(current.term))
              }}
              onMouseDown={e => e.preventDefault()}
              onClick={() => typing.current && session.current?.term.focus()}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
