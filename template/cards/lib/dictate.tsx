import { useEffect, useRef, useState } from 'react'
import { pty, run, useQuery } from 'switchboard'
import { useMobile } from './theme'
import { Icon } from './icons'

const RATE = 16000
/** The level ring brightens from a quiet room to loud speech. */
const QUIET_DB = -50
const LOUD_DB = -8
/** How far the ring may dim per 10 ms. It brightens at once, and falling slower keeps it from flickering. */
const FALL = 0.04
/**
 * Posts 16-bit samples about every 0.1 s, and what is left, then null, when asked to flush. Also posts their mean
 * square as a number every 10 ms, for the level ring.
 */
const WORKLET = `registerProcessor('pcm', class extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = new Int16Array(1600)
    this.length = 0
    this.power = 0
    this.measured = 0
    this.port.onmessage = () => {
      this.post()
      this.port.postMessage(null)
    }
  }
  post() {
    if (this.length) this.port.postMessage(this.samples.slice(0, this.length))
    this.length = 0
  }
  process([[channel]]) {
    for (const x of channel ?? []) {
      this.samples[this.length++] = Math.max(-1, Math.min(1, x)) * 32767
      if (this.length === this.samples.length) this.post()
      this.power += x * x
      if (++this.measured === 160) {
        this.port.postMessage(this.power / this.measured)
        this.power = this.measured = 0
      }
    }
    return true
  }
})`

type Phase = 'idle' | 'recording' | 'transcribing'
type Run = { state: string; summary: string | null }
/** Inserts dictated text, returning what takes it back out. */
type Insert = (text: string) => () => void

/**
 * The message box ⌥Space is for: the one recording, else the one being typed in, else the one in the focused card, else
 * the only one on screen. None while typing in some other field.
 */
function hotkeyTarget(target: EventTarget | null) {
  const buttons = [...document.querySelectorAll<HTMLElement>('.dictation')].filter(b => b.getClientRects().length)
  const recording = buttons.find(b => b.dataset.phase === 'recording')
  if (recording) return recording
  const field = target instanceof Element ? target.closest('input, textarea, select, [contenteditable]') : null
  if (field) return field.closest('.composer')?.querySelector('.dictation')
  return buttons.find(b => b.closest('.slot.focused')) ?? (buttons.length === 1 ? buttons[0] : undefined)
}

/** How loud a mean square is, from 0 to 1. */
function loudness(power: number) {
  const db = 10 * Math.log10(power)
  return Math.min(1, Math.max(0, (db - QUIET_DB) / (LOUD_DB - QUIET_DB)))
}

/**
 * Resolves once animations begun now are under way, after which they run without the main thread, or soon if no frames
 * are being drawn.
 */
const animationsStarted = () =>
  new Promise<void>(resolve => {
    setTimeout(resolve, 150)
    requestAnimationFrame(async () => {
      await Promise.allSettled(document.getAnimations().map(animation => animation.ready))
      requestAnimationFrame(() => setTimeout(resolve))
    })
  })

/**
 * Streams the microphone to a `voice.listen` run, calling `insert` with each stretch of speech as it is transcribed,
 * `onLevel` as its loudness changes and `onEnd` once there is no more, after `onMissing` if it isn't installed.
 * `cancel` takes back what was inserted. Must be called from a tap or key, or iOS keeps the audio context suspended.
 */
function dictate(
  insert: Insert,
  onLevel: (level: number) => void,
  onMissing: () => void,
  onEnd: (error?: Error) => void,
) {
  const context = new AudioContext({ sampleRate: RATE })
  void context.resume()
  let stream: MediaStream | undefined
  let node: AudioWorkletNode | undefined
  let terminal: ReturnType<typeof pty> | undefined
  let ready = false
  let stopping = false
  let ended = false
  let timeout = 0
  let level = 0
  const unsent: string[] = []
  const undos: (() => void)[] = []

  const send = (line: string) => {
    if (ready) terminal?.write(`${line}\n`)
    else unsent.push(line)
  }
  const release = () => {
    onLevel(0)
    if (node) node.port.onmessage = null
    // Like starting it, stopping the microphone can freeze iOS for a moment, so the buttons start moving first.
    void animationsStarted().then(() => {
      stream?.getTracks().forEach(track => track.stop())
      if (context.state !== 'closed') void context.close()
    })
  }
  const end = (error?: Error) => {
    if (ended) return
    ended = true
    clearTimeout(timeout)
    release()
    // The run exits on `q`, which closes the terminal; closing it here could drop the `q`.
    terminal?.write('q\n')
    onEnd(error)
  }
  const finish = () => {
    clearTimeout(timeout)
    release()
    send('.')
  }
  const stop = () => {
    if (stopping || ended) return
    stopping = true
    if (!node) return end()
    timeout = window.setTimeout(finish, 500)
    node.port.postMessage('flush')
  }
  const cancel = () => {
    if (ended) return
    end()
    undos.reverse().forEach(undo => undo())
  }

  const start = async () => {
    if (!navigator.mediaDevices) throw new Error('This app has no microphone access')
    await animationsStarted()
    if (ended) return
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })
    if (ended) return release()
    const module = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    await context.audioWorklet.addModule(module).finally(() => URL.revokeObjectURL(module))
    if (ended) return release()
    node = new AudioWorkletNode(context, 'pcm')
    node.port.onmessage = ({ data }: MessageEvent<Int16Array | number | null>) => {
      if (ended) return
      if (data === null) return finish()
      if (typeof data === 'number') {
        level = Math.max(loudness(data), level - FALL)
        if (!stopping) onLevel(level)
        return
      }
      send(btoa(String.fromCharCode(...new Uint8Array(data.buffer))))
    }
    context.createMediaStreamSource(stream).connect(node).connect(context.destination)
    stream.getTracks().forEach(track => track.addEventListener('ended', stop))

    const id = await run('voice.listen')
    const decoder = new TextDecoder()
    let output = ''
    terminal = pty(id, {
      // Cancelled before it could be told to exit, which would hold the model in memory until it is hung up.
      open: () => ended && terminal?.write('q\n'),
      data: bytes => {
        const lines = (output + decoder.decode(bytes, { stream: true })).split('\n')
        output = lines.pop()!
        for (const line of lines) {
          if (ended || !line.startsWith('{')) continue
          const message: { ready?: true; install?: true; text?: string; done?: true; error?: string } = JSON.parse(line)
          if (message.ready) {
            ready = true
            unsent.splice(0).forEach(send)
          }
          if (message.text) undos.push(insert(message.text))
          if (message.install) {
            onMissing()
            end()
          }
          if (message.error) end(new Error(message.error))
          if (message.done) end()
        }
      },
      close: error => end(error ?? new Error('Dictation stopped before it finished')),
    })
  }
  start().catch(end)
  return { stop, cancel }
}

/**
 * A microphone button, also ⌥Space (see `hotkeyTarget`), that dictates with `insert`. While it does, it becomes Stop,
 * ringed by the live volume, and a Cancel button slides out beside it. Until dictation is installed, a press offers to
 * install it (`voice.install`). It finishes the recording when unmounted.
 */
export function DictateButton({
  insert,
  onActive,
  onError,
}: {
  insert: Insert
  onActive: (active: boolean) => void
  onError: (message: string) => void
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const session = useRef<ReturnType<typeof dictate>>(undefined)
  const ring = useRef<HTMLSpanElement>(null)
  const meter = useRef({ level: 0, frame: 0 }).current
  const root = useRef<HTMLSpanElement>(null)
  const mobile = useMobile()
  const [installId, setInstallId] = useState('')
  const [offered, setOffered] = useState(false)
  const ownInstall = useQuery<Run>('core_runs', { id: installId })?.[0]
  const installs = useQuery<Run>('core_runs', { command: 'voice.install', state: 'running' })
  const installing =
    !!installs?.length || (!!installId && (!ownInstall || ['queued', 'running'].includes(ownInstall.state)))
  useEffect(() => {
    if (!installId || !ownInstall || !['failure', 'stopped', 'unknown'].includes(ownInstall.state)) return
    setInstallId('')
    onError(ownInstall.summary || 'Installing dictation failed')
  }, [installId, ownInstall?.state])
  const stop = () => {
    setPhase('transcribing')
    session.current?.stop()
  }
  useEffect(() => () => session.current?.stop(), [])
  useEffect(() => {
    if (phase !== 'recording' || !mobile) return
    // iOS cuts the microphone in the background.
    const hidden = () => document.hidden && stop()
    document.addEventListener('visibilitychange', hidden)
    return () => document.removeEventListener('visibilitychange', hidden)
  }, [phase, mobile])
  const start = () => {
    setOffered(false)
    try {
      session.current = dictate(
        insert,
        // Once a frame and only the ring's opacity, which WebKit changes without repainting.
        level => {
          meter.level = level
          meter.frame ||= requestAnimationFrame(() => {
            meter.frame = 0
            if (ring.current) ring.current.style.opacity = meter.level.toFixed(2)
          })
        },
        () => setOffered(true),
        error => {
          session.current = undefined
          setPhase('idle')
          onActive(false)
          if (error) onError(error.message)
        },
      )
      setPhase('recording')
      onActive(true)
    } catch (error) {
      onError((error as Error).message)
    }
  }
  const shown = phase === 'idle' && installing ? 'installing' : phase
  const toggle = shown === 'idle' ? start : shown === 'recording' ? stop : undefined
  const latestToggle = useRef(toggle)
  latestToggle.current = toggle
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
      if (!root.current || hotkeyTarget(e.target) !== root.current) return
      // Also stops it typing a non-breaking space.
      e.preventDefault()
      if (!e.repeat) latestToggle.current?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const install = () => {
    setOffered(false)
    run('voice.install').then(setInstallId, (error: Error) => onError(error.message))
  }
  const label = {
    idle: 'Dictate (⌥Space)',
    recording: 'Stop dictating (⌥Space)',
    transcribing: 'Transcribing',
    installing: 'Installing dictation',
  }[shown]
  return (
    // Keeps the caret, and the phone's keyboard, where they are.
    <span ref={root} className="dictation" data-phase={shown} onMouseDown={e => e.preventDefault()}>
      {shown === 'idle' && offered && (
        <span className="chip dictate-status" role="dialog" aria-label="Install dictation">
          Install dictation (540 MB)?
          <button type="button" className="primary" onClick={install}>
            Install
          </button>
          <button type="button" className="ghost" onClick={() => setOffered(false)}>
            Not now
          </button>
        </span>
      )}
      {shown === 'installing' && (
        <span className="chip dictate-status" role="status">
          Installing dictation (540 MB, a few minutes)…
        </span>
      )}
      <button
        type="button"
        className="ghost icon round dictate-cancel"
        title="Cancel dictation"
        aria-label="Cancel dictation"
        onClick={() => session.current?.cancel()}
      >
        <Icon name="x" size={16} />
      </button>
      <button
        type="button"
        className="ghost icon round dictate"
        disabled={!toggle}
        title={label}
        aria-label={label}
        onClick={toggle}
      >
        {shown === 'transcribing' || shown === 'installing' ? (
          <span className="spinner" />
        ) : phase === 'recording' ? (
          <>
            <span ref={ring} className="dictate-ring" />
            <Icon name="square-fill" size={14} />
          </>
        ) : (
          <MicIcon />
        )}
      </button>
    </span>
  )
}

function MicIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
    </svg>
  )
}
