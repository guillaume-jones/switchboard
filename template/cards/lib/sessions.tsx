import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { mutate, run, useQuery } from 'switchboard'
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

/** A saved attachment's path (alone or on an older "Attached file:" line), or the `[file: name]` placeholder of an unsent one. */
const ATTACHMENT = /(?:^Attached file: )?(\/\S*\/data\/attachments\/[\w-]+\/[\w.-]+)|\[file: ([^\]\n]+)\]/gm
/** A message's text without its attachments, for matching a sent prompt to the message it became. */
export const withoutAttachments = (text: string) => text.replace(ATTACHMENT, '').trim()
const placeholder = (name: string) => `[file: ${name.replace(/[\]\n]/g, '_')}]`
const escapeHtml = (value: string) => value.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)

/**
 * A transcript message: your messages with an accent bar, Claude's with a Claude-orange bar. `faded` for ones not yet in
 * the transcript. Attachments in your messages show as chips where they appear in the text; saved ones open the file on
 * desktop.
 */
export function Bubble({
  role,
  label,
  text,
  faded,
  action,
}: {
  role: string
  label: string
  text: string
  faded?: boolean
  action?: ReactNode
}) {
  const opacity = faded ? 0.5 : undefined
  const mobile = useMobile()
  const chips: string[] = []
  const body =
    role === 'user'
      ? text.replace(ATTACHMENT, (_, path?: string, name?: string) => {
          const label = escapeHtml(path?.split('/').pop() ?? name!)
          chips.push(
            path && !mobile
              ? `<button type="button" class="chip file" data-path="${escapeHtml(path)}" title="Open ${escapeHtml(path)}">${label}</button>`
              : `<button type="button" class="chip file" disabled>${label}</button>`,
          )
          return `ATTACHMENTCHIP${chips.length - 1}END`
        })
      : text
  const html = renderMarkdown(body).replace(/ATTACHMENTCHIP(\d+)END/g, (_, i) => chips[Number(i)])
  return (
    <div style={{ ...BUBBLE, ...(role === 'user' ? USER : ASSISTANT) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', opacity }}>
          {role === 'user' ? 'User' : 'Agent'} · {label}
        </span>
        {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      </div>
      <div
        className="message"
        style={{ opacity }}
        onClick={e => {
          const path = (e.target as Element).closest<HTMLElement>('[data-path]')?.dataset.path
          if (path) run('sessions.reveal', { path })
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
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
  background: 'Claude',
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

const SAVE_DELAY = 500
/**
 * Local edits to drafts, saved to `sessions.draft_set` once typing pauses and dropped once `sessions_drafts` shows them,
 * so typing never waits on a round trip and an echo of an older save never overwrites newer text.
 */
type Edit = { text: string; sent: Set<string>; saved: boolean; timer?: ReturnType<typeof setTimeout> }
const edits = new Map<string, Edit>()
const stored = new Map<string, string>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(listener => listener())
const subscribeToEdits = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
const readDraft = (key: string) => edits.get(key)?.text ?? stored.get(key) ?? ''

/** Drops a saved edit once its text is stored, or once another client stores something else (`changed`). */
function settle(key: string, changed: boolean) {
  const edit = edits.get(key)
  const value = stored.get(key) ?? ''
  if (!edit?.saved || (value !== edit.text && (!changed || edit.sent.has(value)))) return
  edits.delete(key)
  emit()
}

function save(key: string) {
  const edit = edits.get(key)
  if (!edit) return
  clearTimeout(edit.timer)
  edit.timer = undefined
  const { text } = edit
  edit.sent.add(text)
  mutate('sessions.draft_set', { key, text }).then(
    () => {
      if (edits.get(key) !== edit || edit.text !== text || edit.timer) return
      edit.saved = true
      settle(key, false)
    },
    () => undefined,
  )
}
addEventListener('pagehide', () => edits.forEach((edit, key) => edit.timer && save(key)))

function setDraft(key: string, next: string | ((current: string) => string)) {
  const text = typeof next === 'function' ? next(readDraft(key)) : next
  const edit = edits.get(key) ?? { text, sent: new Set<string>(), saved: false }
  clearTimeout(edit.timer)
  Object.assign(edit, { text, saved: false, timer: setTimeout(() => save(key), text ? SAVE_DELAY : 0) })
  edits.set(key, edit)
  emit()
}

/** A text value stored in `sessions_drafts` under `key`, so it survives reloads and follows you across cards and devices. */
export function useDraft(key: string) {
  const rows = useQuery<{ text: string }>('sessions_drafts', { key })
  const value = rows && (rows[0]?.text ?? '')
  useEffect(() => {
    if (value === undefined) return
    stored.set(key, value)
    settle(key, true)
  }, [key, value])
  const edit = useSyncExternalStore(subscribeToEdits, () => edits.get(key)?.text)
  return [edit ?? value ?? '', (next: string | ((current: string) => string)) => setDraft(key, next)] as const
}

export type Attachment = { id: string; name: string }
const parseFiles = (value: string): Attachment[] => (value ? JSON.parse(value) : [])

/** A follow-up waiting in `sessions.queue` (`queued`, or `failed` with its error) or being sent by `sessions.flush`. */
export type Outbox = {
  session: string
  state: 'queued' | 'failed' | 'sending'
  text: string
  files: string
  queued_at: number
  error: string | null
  acked: number
  sent_at: number | null
}
export const useOutbox = (session: string) => useQuery<Outbox>('sessions_outbox', { session }) ?? []
/** An outbox message's text with its `{{attachment:<id>}}` references shown as the message box's placeholders. */
export const outboxText = ({ text, files }: Outbox) =>
  parseFiles(files).reduce((shown, f) => shown.replaceAll(`{{attachment:${f.id}}}`, placeholder(f.name)), text)

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

/** Puts a queued or failed follow-up back into its message box, ahead of anything typed since. */
function unqueue(entry: Outbox) {
  const { session } = entry
  setDraft(draftKey(session), current => [outboxText(entry), current].filter(Boolean).join('\n\n'))
  setDraft(filesKey(session), current => {
    const files = [...parseFiles(entry.files), ...parseFiles(current)]
    return files.length ? JSON.stringify(files) : ''
  })
  return mutate('sessions.queue_cancel', { session, queued_at: entry.queued_at })
}

export const busy = (session: Session) => session.status === 'working'

/** A message Claude has been sent but not taken yet, which an interrupt (`sessions.stop`) hands to it at once. */
export const interruptible = (session: Session, entry: Outbox) =>
  session.kind === 'background' && entry.state === 'sending' && !!entry.sent_at && !entry.acked

/**
 * The `text`-style param and `attachments` for a command taking files: each file's placeholder becomes
 * `{{attachment:<id>}}`, which the command replaces with its saved path. Files whose placeholder was deleted are dropped.
 */
export function withAttachments<K extends string>(param: K, prompt: string, files: Attachment[]) {
  let text = prompt
  const used: Attachment[] = []
  for (const f of files) {
    if (!text.includes(placeholder(f.name))) void mutate('sessions.detach', { id: f.id })
    else {
      text = text.replace(placeholder(f.name), `{{attachment:${f.id}}}`)
      used.push(f)
    }
  }
  return { [param]: text, ...(used.length ? { attachments: used.map(f => f.id).join(',') } : {}) } as Record<
    K,
    string
  > & {
    attachments?: string
  }
}

export const QUEUE_BUTTON: CSSProperties = { minHeight: 0, padding: '0 8px', fontSize: 12 }

/**
 * The follow-up queued for a session, shown as a faded user message, or with its error if sending it failed. Cancel (Esc
 * in the message box) moves it back into the message box; Send now (⌘↩ with an empty message box) sends it while Claude
 * works, folded into its turn, and
 * Retry sends a failed one again.
 */
export function QueuedMessage({ session, onError }: { session: Session; onError: (message: string) => void }) {
  const entry = useOutbox(session.id).find(e => e.state !== 'sending')
  if (!entry) return null
  const fail = (e: Error) => onError(e.message)
  const failed = entry.state === 'failed'
  return (
    <div className="grow">
      <div>
        <Bubble
          role="user"
          label={failed ? `Not sent · ${entry.error}` : 'Queued'}
          text={outboxText(entry)}
          faded
          action={
            <span style={{ display: 'flex', gap: 4 }}>
              <button
                type="button"
                className="ghost"
                style={QUEUE_BUTTON}
                title="Back to the message box (Esc)"
                onClick={() => unqueue(entry).catch(fail)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ghost"
                style={QUEUE_BUTTON}
                title={failed ? 'Send again' : 'Send now (⌘↩ with an empty message box)'}
                onClick={() =>
                  mutate('sessions.queue_send', { session: session.id, interject: failed ? 0 : 1 }).catch(fail)
                }
              >
                {failed ? 'Retry' : 'Send now'}
              </button>
            </span>
          }
        />
      </div>
    </div>
  )
}

/**
 * A rounded message box over drafts kept under `draft` and `files` (see `useDraft`). Files are attached by pasting,
 * dropping or picking them, and show in the text as placeholders where they were added. Send (or ⌘↩) calls `onSend`,
 * which clears the drafts when it takes the message; `button` replaces the send icon and `actions` sit before it.
 */
export function MessageBox({
  draft,
  files: filesKey,
  placeholder: hint,
  onSend,
  onError,
  onKeyDown,
  button,
  actions,
}: {
  draft: string
  files: string
  placeholder: string
  onSend: (prompt: string, files: Attachment[]) => void
  onError: (message: string) => void
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  button?: ReactNode
  actions?: ReactNode
}) {
  const [text, setText] = useDraft(draft)
  const [filesDraft, setFilesDraft] = useDraft(filesKey)
  const [uploading, setUploading] = useState(0)
  const picker = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const attach = (list: FileList | null) => {
    if (!list?.length) return
    const at = box.current?.selectionStart ?? text.length
    setText(text.slice(0, at) + [...list].map(file => placeholder(file.name)).join(' ') + text.slice(at))
    setUploading(n => n + list.length)
    for (const file of list)
      upload(file)
        .then(({ id }) => setFilesDraft(current => JSON.stringify([...parseFiles(current), { id, name: file.name }])))
        .catch((e: Error) => onError(e.message))
        .finally(() => setUploading(n => n - 1))
  }
  const send = () => {
    if (!uploading) onSend(text.trim(), parseFiles(filesDraft))
  }
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      {uploading > 0 && (
        <span className="chip file" style={{ marginBottom: 6 }}>
          <Spinner />
        </span>
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
          className="ghost icon round attach"
          title="Attach files"
          aria-label="Attach files"
          onClick={() => picker.current?.click()}
        >
          <PaperclipIcon />
        </button>
        <textarea
          ref={box}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault()
              send()
            } else onKeyDown?.(e)
          }}
          placeholder={hint}
          autoComplete="off"
          enterKeyHint="enter"
          rows={1}
        />
        {actions}
        <button
          type="submit"
          className={button ? 'primary round' : 'primary icon round'}
          disabled={!text.trim() || uploading > 0}
          title="Send"
          aria-label="Send"
        >
          {button ?? <SendIcon />}
        </button>
      </form>
    </div>
  )
}

/**
 * Message box for a session. Send (⌘↩) adds a follow-up to `sessions.queue`, which the desktop sends at once to a session
 * it holds, where Claude takes it at its next pause, and otherwise once Claude is neither working nor asking for a
 * permission; the card must show the queue with `QueuedMessage`. `onQueued` is called for each message. Sending an empty
 * box sends the queue now, or interrupts Claude's turn so that it takes the message waiting for it; Esc moves a queued
 * message back into the box.
 */
export function Composer({
  session,
  onError,
  onQueued,
}: {
  session: Session
  onError: (message: string) => void
  onQueued?: () => void
}) {
  const entries = useOutbox(session.id)
  const queued = entries.find(e => e.state !== 'sending')
  const fail = (e: Error) => onError(e.message)
  const send = (prompt: string, files: Attachment[]) => {
    if (!prompt) {
      if (queued) mutate('sessions.queue_send', { session: session.id, interject: 1 }).catch(fail)
      else if (entries.some(e => interruptible(session, e))) run('sessions.stop', { session: session.id }).catch(fail)
      return
    }
    const { text, attachments = '' } = withAttachments('text', prompt, files)
    const ids = attachments.split(',')
    setDraft(draftKey(session.id), '')
    setDraft(filesKey(session.id), '')
    mutate('sessions.queue_add', {
      session: session.id,
      text,
      files: JSON.stringify(files.filter(f => ids.includes(f.id))),
    }).catch(fail)
    onQueued?.()
  }
  return (
    <MessageBox
      draft={draftKey(session.id)}
      files={filesKey(session.id)}
      placeholder="Message Claude…"
      onSend={send}
      onError={onError}
      onKeyDown={e => {
        if (e.key !== 'Escape' || !queued) return
        e.preventDefault()
        unqueue(queued).catch(fail)
      }}
      actions={
        session.kind === 'background' &&
        busy(session) && (
          <button
            type="button"
            className="danger icon round"
            title="Stop"
            aria-label="Stop"
            onClick={() => run('sessions.stop', { session: session.id }).catch((e: Error) => onError(e.message))}
          >
            <StopIcon />
          </button>
        )
      }
    />
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

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <rect x="3" y="3" width="10" height="10" rx="2" />
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
