import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { mutate, run } from 'switchboard'
import { renderMarkdown } from './markdown'
import { useMobile } from './theme'

type Decision = { tool_name: string; tool_input: Record<string, any>; at: number }
type Question = {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

const MESSAGE: CSSProperties = { margin: '4px 0', maxHeight: 160, overflow: 'auto' }
export const BUBBLE: CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--border)',
  overflowWrap: 'anywhere',
}
const USER: CSSProperties = { background: 'var(--raised)', boxShadow: 'inset 3px 0 var(--accent)' }
const ASSISTANT: CSSProperties = { boxShadow: 'inset 3px 0 var(--claude)' }

export const ATTACHED = /^Attached file: (\/.+)$/gm

/**
 * A transcript message: your messages with an accent bar, Claude's with a Claude-orange bar. `faded` for ones not yet in
 * the transcript. Attached file lines, or `attachments` (names, for messages not yet sent), show as chips; paths open the
 * file on desktop.
 */
export function Bubble({
  role,
  label,
  text,
  faded,
  action,
  attachments,
}: {
  role: string
  label: string
  text: string
  faded?: boolean
  action?: ReactNode
  attachments?: string[]
}) {
  const opacity = faded ? 0.5 : undefined
  const mobile = useMobile()
  const files = attachments ?? (role === 'user' ? [...text.matchAll(ATTACHED)].map(m => m[1]) : [])
  const body = role === 'user' ? text.replace(ATTACHED, '').trim() : text
  return (
    <div style={{ ...BUBBLE, ...(role === 'user' ? USER : ASSISTANT) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', opacity }}>
          {role === 'user' ? 'User' : 'Agent'} · {label}
        </span>
        {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      </div>
      <div className="message" style={{ opacity }} dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
      {files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0', opacity }}>
          {files.map(path => (
            <button
              key={path}
              type="button"
              className="chip file"
              disabled={mobile || !path.startsWith('/')}
              title={mobile || !path.startsWith('/') ? undefined : `Open ${path}`}
              onClick={() => run('sessions.reveal', { path })}
            >
              <PaperclipIcon /> {path.split('/').pop()}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
export const WAITING = ['needs_permission', 'needs_input']
export const TONES: Record<string, string> = {
  working: 'info',
  needs_permission: 'warn',
  needs_input: 'warn',
  ready: 'good',
  errored: 'bad',
}
const HOSTS: Record<string, string> = {
  background: 'Claude agent',
  switchboard: 'Switchboard',
  'dev.zed.Zed': 'Zed',
  'com.mitchellh.ghostty': 'Ghostty',
  'com.apple.Terminal': 'Terminal',
  'com.googlecode.iterm2': 'iTerm',
  ghostty: 'Ghostty',
  zed: 'Zed',
  vscode: 'VS Code',
  WezTerm: 'WezTerm',
}
export const hostName = (session: Session) => HOSTS[session.host ?? ''] ?? session.host ?? 'Unknown app'

export type Session = {
  id: string
  title: string
  status: string
  cwd: string | null
  host: string | null
  kind: string | null
  short_id: string | null
  live: number
  last_message: string | null
  last_prompt: string | null
  decision: string | null
  updated: string
  hidden: number
}

const DRAFT_EVENT = 'switchboard-draft'
const subscribeToDrafts = (onChange: () => void) => {
  window.addEventListener(DRAFT_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(DRAFT_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}
const storeDraft = (key: string, value: string) => {
  if (value) localStorage.setItem(key, value)
  else localStorage.removeItem(key)
  window.dispatchEvent(new Event(DRAFT_EVENT))
}

/** A text value kept in `localStorage` under `key`, so it survives reloads and is shared by every card using the key. */
export function useDraft(key: string) {
  const value = useSyncExternalStore(subscribeToDrafts, () => localStorage.getItem(key) ?? '')
  return [value, (next: string) => storeDraft(key, next)] as const
}

export const queueKey = (session: string) => `Composer.queue.${session}`
const queuedFilesKey = (session: string) => `Composer.queueFiles.${session}`

type Attachment = { id: string; name: string }
const parseFiles = (value: string): Attachment[] => (value ? JSON.parse(value) : [])

/** Images are re-encoded to at most this many pixels per side, about what Claude reads them at, to keep uploads small. */
const MAX_SIDE = 2000
const READABLE = ['image/png', 'image/jpeg', 'image/webp']
const base64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

async function shrink(file: File): Promise<{ name: string; blob: Blob }> {
  const bitmap =
    file.type.startsWith('image/') && file.type !== 'image/gif' ? await createImageBitmap(file).catch(() => null) : null
  if (!bitmap) return { name: file.name, blob: file }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && READABLE.includes(file.type)) return { name: file.name, blob: file }
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
  const blob = await canvas.convertToBlob({ type, quality: 0.9 })
  return { name: `${file.name.replace(/\.[^.]*$/, '') || 'image'}.${type.split('/')[1]}`, blob }
}

/** Uploads a file to `sessions.attach`; a command given its id saves it under data/attachments. */
async function upload(file: File): Promise<Attachment> {
  const { name, blob } = await shrink(file)
  const id = crypto.randomUUID()
  await mutate('sessions.attach', { id, name: name || 'file', data: await base64(blob) })
  return { id, name }
}

const draftKey = (session: string) => `Composer.draft.${session}`
const filesKey = (session: string) => `Composer.files.${session}`
const read = (key: string) => localStorage.getItem(key) ?? ''

/** Sends a session's queued follow-up now, if any, taking it out of storage first so it is sent once. */
function sendQueued(
  session: Session,
  onError: (message: string) => void,
  onSent?: (prompt: string, files: string[]) => void,
) {
  const prompt = read(queueKey(session.id))
  const files = parseFiles(read(queuedFilesKey(session.id)))
  if (!prompt && !files.length) return
  storeDraft(queueKey(session.id), '')
  storeDraft(queuedFilesKey(session.id), '')
  onSent?.(
    prompt,
    files.map(f => f.name),
  )
  followUp(session, prompt, files).catch((e: Error) => onError(e.message))
}

/** Moves a session's queued follow-up back into its message box, ahead of anything typed since. */
function unqueue(session: string) {
  const files = [...parseFiles(read(queuedFilesKey(session))), ...parseFiles(read(filesKey(session)))]
  storeDraft(draftKey(session), [read(queueKey(session)), read(draftKey(session))].filter(Boolean).join('\n\n'))
  storeDraft(filesKey(session), files.length ? JSON.stringify(files) : '')
  storeDraft(queueKey(session), '')
  storeDraft(queuedFilesKey(session), '')
}

/**
 * Sends each session's queued follow-up once Claude is no longer working or waiting on you. A queue is taken out of
 * storage before it is sent, so cards flushing the same session send it once.
 */
export function useFlushQueues(
  sessions: Session[],
  onError: (message: string) => void,
  onSent?: (prompt: string, files: string[]) => void,
) {
  useEffect(() => {
    for (const session of sessions) {
      if (!busy(session) && !WAITING.includes(session.status)) sendQueued(session, onError, onSent)
    }
  })
}

export const busy = (session: Session) => session.status === 'working'

/** Sends a prompt to a session with `sessions.send`, interrupting its turn if Claude is working and asking it to finish that turn's task too. */
export function followUp(session: Session, prompt: string, files: Attachment[] = []) {
  const attachments = files.length ? { attachments: files.map(f => f.id).join(',') } : {}
  const interject = busy(session) ? { interject: 1 } : {}
  return run('sessions.send', { session: session.id, text: prompt, ...attachments, ...interject })
}

const QUEUE_BUTTON: CSSProperties = { minHeight: 0, padding: '0 8px', fontSize: 12 }

/**
 * The message queued for a busy session, shown as a faded user message. Cancel (Esc in the message box) moves it back
 * into the message box; Interrupt (⌘↩ with an empty message box) sends it now.
 */
export function QueuedMessage({
  session,
  onError,
  onSent,
}: {
  session: Session
  onError: (message: string) => void
  onSent?: (prompt: string, files: string[]) => void
}) {
  const [queued] = useDraft(queueKey(session.id))
  const queuedFiles = parseFiles(useDraft(queuedFilesKey(session.id))[0])
  if (!queued && !queuedFiles.length) return null
  return (
    <div className="grow">
      <div>
        <Bubble
          role="user"
          label="Queued"
          text={queued}
          attachments={queuedFiles.map(f => f.name)}
          faded
          action={
            <span style={{ display: 'flex', gap: 4 }}>
              <button
                type="button"
                className="ghost"
                style={QUEUE_BUTTON}
                title="Back to the message box (Esc)"
                onClick={() => unqueue(session.id)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ghost"
                style={QUEUE_BUTTON}
                title="Send now (⌘↩ with an empty message box)"
                onClick={() => sendQueued(session, onError, onSent)}
              >
                Interrupt
              </button>
            </span>
          }
        />
      </div>
    </div>
  )
}

/**
 * Message box for a session. Send (cmd-Enter) sends a follow-up, queued while Claude is working; the card must show the
 * queue with `QueuedMessage` and flush it with `useFlushQueues`. `onSent` gets each message as it
 * is sent, and `onQueued` is called when one is queued.
 * Files are attached by pasting, dropping or picking them.
 */
export function Composer({
  session,
  onError,
  onSent,
  onQueued,
}: {
  session: Session
  onError: (message: string) => void
  onSent?: (prompt: string, files: string[]) => void
  onQueued?: () => void
}) {
  const [text, setText] = useDraft(draftKey(session.id))
  const [queued, setQueued] = useDraft(queueKey(session.id))
  const [filesDraft, setFilesDraft] = useDraft(filesKey(session.id))
  const [queuedFilesDraft, setQueuedFiles] = useDraft(queuedFilesKey(session.id))
  const [uploading, setUploading] = useState(0)
  const picker = useRef<HTMLInputElement>(null)
  const files = parseFiles(filesDraft)
  const queuedFiles = parseFiles(queuedFilesDraft)
  const fail = (e: Error) => onError(e.message)
  const attach = (list: FileList | null) => {
    if (!list?.length) return
    setUploading(n => n + list.length)
    for (const file of list)
      upload(file)
        .then(f => setFilesDraft(JSON.stringify([...parseFiles(read(filesKey(session.id))), f])))
        .catch(fail)
        .finally(() => setUploading(n => n - 1))
  }
  const detach = (f: Attachment) => {
    setFilesDraft(JSON.stringify(files.filter(other => other.id !== f.id)))
    mutate('sessions.detach', { id: f.id }).catch(fail)
  }
  const send = () => {
    const prompt = text.trim()
    if (!prompt && !files.length) return sendQueued(session, onError, onSent)
    if (uploading) return
    setText('')
    setFilesDraft('')
    if (busy(session)) {
      setQueued(queued && prompt ? `${queued}\n\n${prompt}` : queued || prompt)
      if (files.length) setQueuedFiles(JSON.stringify([...queuedFiles, ...files]))
      onQueued?.()
    } else {
      onSent?.(
        prompt,
        files.map(f => f.name),
      )
      followUp(session, prompt, files).catch(fail)
    }
  }
  return (
    <div>
      {(files.length > 0 || uploading > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {files.map(f => (
            <span key={f.id} className="chip file">
              <PaperclipIcon /> {f.name}
              <button
                type="button"
                className="ghost icon small round"
                aria-label={`Remove ${f.name}`}
                onClick={() => detach(f)}
              >
                ×
              </button>
            </span>
          ))}
          {uploading > 0 && (
            <span className="chip file">
              <Spinner />
            </span>
          )}
        </div>
      )}
      <form
        className="composer"
        onSubmit={e => {
          e.preventDefault()
          send()
        }}
        onPaste={e => {
          if (!e.clipboardData.files.length) return
          e.preventDefault()
          attach(e.clipboardData.files)
        }}
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault()
          attach(e.dataTransfer.files)
        }}
      >
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={e => {
            attach(e.target.files)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          className="ghost icon round"
          title="Attach files"
          aria-label="Attach files"
          onClick={() => picker.current?.click()}
        >
          <PaperclipIcon />
        </button>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault()
              send()
            } else if (e.key === 'Escape' && (queued || queuedFiles.length)) {
              e.preventDefault()
              unqueue(session.id)
            }
          }}
          placeholder="Message Claude…"
          autoComplete="off"
          enterKeyHint="enter"
          rows={1}
        />
        <button
          type="submit"
          className="primary icon round"
          disabled={(!text.trim() && !files.length) || uploading > 0}
          title="Send"
          aria-label="Send"
        >
          <SendIcon />
        </button>
      </form>
    </div>
  )
}

function PaperclipIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13.5 7.5 8 13a3.5 3.5 0 0 1-5-5l5.5-5.5a2.3 2.3 0 0 1 3.3 3.3L6.3 11.3a1.2 1.2 0 0 1-1.7-1.7L9.5 4.7" />
    </svg>
  )
}

export function SendIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
    </svg>
  )
}

const SPIN = '@keyframes sessions-spin { to { transform: rotate(360deg) } }'

export function Spinner() {
  return (
    <>
      <style>{SPIN}</style>
      <span
        style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          margin: '4px 0',
          border: '2px solid var(--border)',
          borderTopColor: 'var(--accent)',
          borderRadius: '50%',
          animation: 'sessions-spin 0.8s linear infinite',
        }}
      />
    </>
  )
}

export function DecisionPanel({
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
  const panel: CSSProperties = {
    margin: '6px 0',
    padding: 10,
    background: 'var(--raised)',
    borderLeft: '3px solid var(--accent)',
    borderRadius: 8,
  }

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
        <button className="primary" onClick={() => answer({ behavior: 'allow' })}>
          Allow
        </button>
        <button className="danger" onClick={deny}>
          Deny
        </button>
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
                aria-pressed={(picked[q.question] ?? []).includes(o.label)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <button
        className="primary"
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
