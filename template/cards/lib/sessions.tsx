import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { mutate, run, useQuery } from 'switchboard'
import { clickedCode, copyCode, DOC, fileChip, IMAGE, renderMarkdown, sendOpenDoc } from './markdown'
import { unsentPath, useImage } from './image'
import { useMobile } from './theme'
import { Icon } from './icons'
import { DictateButton } from './dictate'

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

/** A saved attachment's path (alone or on an older "Attached file:" line), or an unsent one's placeholder. */
const ATTACHMENT =
  /(?:^Attached file: )?(\/\S*\/data\/attachments\/[\w-]+\/[\w.-]*[\w-])|\u2063\u00a0+([^\u2063\n]+?)\u00a0+\u2063|\[file: ([^\]\n]+)\]/gm
/** A message's text without its attachments, for matching a sent prompt to the message it became. */
const withoutAttachments = (text: string) => text.replace(ATTACHMENT, '').trim()
/** The file's name padded with no-break spaces between invisible separators, which `trim` keeps: a chip's exact text. */
const placeholder = (name: string) => `\u2063\u00a0\u00a0${name.replace(/[\u2063\n]/g, '_')}\u00a0\u00a0\u2063`
/** A file's placeholder as `text` holds it: older drafts have `[file: name]`. */
const placeholderIn = (text: string, name: string) => {
  const current = placeholder(name)
  return text.includes(current) ? current : `[file: ${name.replace(/[\]\n]/g, '_')}]`
}
/** The code Zed inlines for an `@file#L1:2` mention, which the message already links to: shown as a fenced code block. */
const CONTEXT = /<context ref="file:\/\/[^"]*?(?:\.(\w+))?(?:#[^"]*)?">\n?([\s\S]*?)\n?<\/context>/g
const escapeHtml = (value: string) => value.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)

/**
 * A transcript message: your messages with an accent bar, Claude's with a Claude-orange bar. `faded` for ones not yet in
 * the transcript. Attachments in your messages show as chips where they appear in the text; saved ones open the file on
 * desktop, and images show on hover (see `ImagePeek`).
 */
export function Bubble({
  role,
  label,
  text,
  faded,
  action,
  onRunCode,
}: {
  role: string
  label: string
  text: string
  faded?: boolean
  action?: ReactNode
  onRunCode?: (code: string) => void
}) {
  const opacity = faded ? 0.5 : undefined
  const mobile = useMobile()
  const { body, html } = useMemo(() => {
    const chips: string[] = []
    const body =
      role === 'user'
        ? text
            .replace(CONTEXT, '```$1\n$2\n```')
            .replace(ATTACHMENT, (_, path?: string, unsent?: string, older?: string) => {
              const label = escapeHtml(path?.split('/').pop() ?? unsent ?? older!)
              chips.push(
                path && (!mobile || IMAGE.test(path) || DOC.test(path))
                  ? fileChip(path, label)
                  : `<button type="button" class="chip file" disabled>${label}</button>`,
              )
              return `ATTACHMENTCHIP${chips.length - 1}END`
            })
        : text
    return { body, html: renderMarkdown(body).replace(/ATTACHMENTCHIP(\d+)END/g, (_, i) => chips[Number(i)]) }
  }, [role, text, mobile])
  return (
    <div style={{ ...BUBBLE, ...(role === 'user' ? USER : ASSISTANT) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', opacity }}>
          <span
            style={{ color: role === 'user' ? 'color-mix(in srgb, var(--accent) 60%, var(--muted))' : 'var(--claude)' }}
          >
            {role === 'user' ? 'User' : 'Agent'}
          </span>{' '}
          · {label}
        </span>
        {(action || role !== 'user') && (
          <span style={{ marginLeft: 'auto', height: 0, display: 'flex', alignItems: 'center' }}>
            {action}
            {role !== 'user' && <CopyButton text={text} />}
          </span>
        )}
      </div>
      <div
        className="message"
        style={{ opacity }}
        data-runnable={onRunCode ? '' : undefined}
        onClick={e => {
          copyCode(e, body)
          const code = clickedCode(e.target, '.run-code')
          if (code !== undefined) onRunCode?.(code)
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="ghost icon small"
      title="Copy this message"
      aria-label="Copy message"
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }
    >
      <Icon name={copied ? 'check' : 'copy'} />
    </button>
  )
}

/**
 * Shows the image of a saved (`data-local`) or unsent (`data-staged`) `[data-image]` chip anywhere on the page next to
 * it, while hovered on desktop or once tapped on phones (until the next tap), until it opens in a preview. Mounted
 * once by `Root`.
 */
export function ImagePeek() {
  const mobile = useMobile()
  const [chip, setChip] = useState<HTMLElement>()
  useEffect(() => {
    const chipOf = (e: Event) =>
      e.composedPath().find((el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute('data-image'))
    const hover = (e: MouseEvent) => setChip(chipOf(e))
    const tap = (e: MouseEvent) => {
      const next = chipOf(e)
      setChip(current => (next === current ? undefined : next))
    }
    const opened = () => setChip(undefined)
    document.addEventListener(mobile ? 'click' : 'mouseover', mobile ? tap : hover, { capture: true, passive: true })
    document.addEventListener('open-doc', opened)
    return () => {
      document.removeEventListener(mobile ? 'click' : 'mouseover', mobile ? tap : hover, true)
      document.removeEventListener('open-doc', opened)
    }
  }, [mobile])
  useEffect(() => {
    if (!chip) return
    const close = () => setChip(undefined)
    const escape = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('scroll', close, { capture: true, passive: true, once: true })
    window.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', escape)
    }
  }, [chip])
  return chip?.isConnected ? <Peek key={chip.dataset.staged ?? chip.dataset.local} chip={chip} /> : null
}

function Peek({ chip }: { chip: HTMLElement }) {
  const { local, staged } = chip.dataset
  const { src, name, error } = useImage(staged ? unsentPath(staged) : local!)
  const rect = chip.getBoundingClientRect()
  const below = rect.top < innerHeight / 2
  const style = {
    ...(below ? { top: rect.bottom + 6 } : { bottom: innerHeight - rect.top + 6 }),
    ...(rect.left < innerWidth / 2
      ? { left: Math.max(8, rect.left) }
      : { right: Math.max(8, innerWidth - rect.right) }),
    ['--room' as string]: `${(below ? innerHeight - rect.bottom : rect.top) - 16}px`,
  } as CSSProperties
  return (
    <div className="image-peek" style={style}>
      {src ? (
        <img src={src} alt={name} />
      ) : error ? (
        <div className="empty">{error}</div>
      ) : (
        <div className="empty">
          <Spinner />
        </div>
      )}
    </div>
  )
}
export const WAITING = ['needs_permission', 'needs_input']
export const TONES: Record<string, string> = {
  working: 'info',
  waiting: 'agents',
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
export const MODELS: Record<string, string> = {
  fable: 'claude-fable-5-2',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

/**
 * Picks one of `MODELS` by name; `onChange` gets the model's name, `value` is a name too (none shows "Model"). A text
 * field focused before it opened gets focus back once a model is picked.
 */
export function ModelSelect({
  value,
  onChange,
  className,
  disabled,
}: {
  value?: string
  onChange: (name: string, model: string) => void
  className?: string
  disabled?: boolean
}) {
  const typing = useRef<HTMLElement | null>(null)
  return (
    <select
      className={className}
      aria-label="Model"
      title="Change model"
      disabled={disabled}
      value={value ?? ''}
      onPointerDown={() => {
        const focused = document.activeElement
        typing.current = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement ? focused : null
      }}
      onChange={e => {
        onChange(e.target.value, MODELS[e.target.value])
        typing.current?.focus()
      }}
    >
      {!value && <option value="">Model</option>}
      {Object.keys(MODELS).map(name => (
        <option key={name} value={name}>
          {name[0].toUpperCase() + name.slice(1)}
        </option>
      ))}
    </select>
  )
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
  notified?: number
  model?: string | null
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

export function setDraft(key: string, next: string | ((current: string) => string)) {
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

/** Archives a session, first moving `client` off it to the next chat in the sidebar, else the previous, else a new chat. */
export function useArchive(client: string) {
  const sessions = useQuery<Session>('sessions.recent', { limit: 50, hidden: 0 }) ?? []
  return (id: string, open: boolean) => {
    const at = sessions.findIndex(s => s.id === id)
    const next = sessions[at + 1] ?? sessions[at - 1]
    const away = open ? mutate('ui.open_chat', { client, session: next?.id ?? '' }) : Promise.resolve(0)
    return away.then(() => mutate('sessions.hide', { id }))
  }
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

/**
 * Messages being sent, from this client at once and from `sessions_outbox`, kept until the transcript shows them (see
 * `SessionTranscript`), so a message never blinks out between leaving the outbox and reaching the transcript.
 */
export type Pending = { text: string; at: number }
const pending = new Map<string, Pending[]>()
const NONE: Pending[] = []
export const setPending = (session: string, update: (sends: Pending[]) => Pending[]) => {
  const next = update(pending.get(session) ?? NONE)
  if (next === pending.get(session)) return
  pending.set(session, next)
  emit()
}
/** Whether `text` holds `message` whole, alone or among follow-ups joined into one (see `sessions.queue_add`). */
export const containsMessage = (text: string, message: string) =>
  `\n\n${withoutAttachments(text)}\n\n`.includes(`\n\n${withoutAttachments(message)}\n\n`)
export const usePending = (session: string) =>
  useSyncExternalStore(subscribeToEdits, () => pending.get(session) ?? NONE)
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

export const draftKey = (session: string) => `Composer.draft.${session}`
const filesKey = (session: string) => `Composer.files.${session}`

/** Puts a queued or failed follow-up back into its message box, ahead of anything typed since. */
function unqueue(entry: Outbox) {
  const { session } = entry
  setDraft(draftKey(session), current => [outboxText(entry), current].filter(Boolean).join('\n\n'))
  setDraft(filesKey(session), current => {
    const files = [...parseFiles(entry.files), ...parseFiles(current)]
    return files.length ? JSON.stringify(files) : ''
  })
  setPending(session, sends => sends.filter(p => !containsMessage(outboxText(entry), p.text)))
  return mutate('sessions.queue_cancel', { session, queued_at: entry.queued_at })
}

export const busy = (session: Session) => ['working', 'waiting'].includes(session.status)

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
    const mark = placeholderIn(text, f.name)
    if (!text.includes(mark)) void mutate('sessions.detach', { id: f.id })
    else {
      text = text.replace(mark, `{{attachment:${f.id}}}`)
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
  )
}

/**
 * A rounded message box over drafts kept under `draft` and `files` (see `useDraft`). Files are attached by pasting,
 * dropping or picking them, and are placeholders in the text where they were added, drawn as chips by a layer over the
 * textarea and edited as one character. Send (or ⌘↩) calls `onSend`, which clears the drafts when it takes the message;
 * `button` replaces the send icon and `actions` sit before it.
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
  cwd,
  onStop,
}: {
  draft: string
  files: string
  placeholder: string
  onSend: (prompt: string, files: Attachment[]) => void
  onError: (message: string) => void
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  button?: ReactNode
  actions?: ReactNode
  cwd?: string | null
  /** Replaces send with a stop button while the box is empty. */
  onStop?: () => void
}) {
  const [text, setText] = useDraft(draft)
  const commandRows = useQuery<{ cwd: string; name: string }>('sessions_commands') ?? []
  const ownRows = commandRows.filter(c => c.cwd === cwd)
  const commands = [...new Set((ownRows.length ? ownRows : commandRows).map(c => c.name))].filter(
    name => !name.startsWith('_'),
  )
  const [caret, setCaret] = useState(text.length)
  const token = /(?:^|\s)\/(\S*)$/.exec(text.slice(0, caret))
  const typed = token?.[1].toLowerCase()
  const [dismissed, setDismissed] = useState<string>()
  const [active, setActive] = useState(0)
  const matches =
    typed === undefined || dismissed === text
      ? []
      : commands
          .filter(name => name.includes(typed))
          .sort((a, b) => Number(!a.startsWith(typed)) - Number(!b.startsWith(typed)))
  const highlighted = Math.min(active, matches.length - 1)
  const pickCommand = (name: string) => {
    const start = caret - typed!.length - 1
    const end = caret + /^\S*/.exec(text.slice(caret))![0].length
    const inserted = `/${name} `
    const at = start + inserted.length
    setText(text.slice(0, start) + inserted + text.slice(end).replace(/^ /, ''))
    setCaret(at)
    requestAnimationFrame(() => {
      box.current?.focus()
      box.current?.setSelectionRange(at, at)
    })
  }
  const [filesDraft, setFilesDraft] = useDraft(filesKey)
  const [uploading, setUploading] = useState<string[]>([])
  const [dictating, setDictating] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const mobile = useMobile()
  const selection = useRef([0, 0])
  const chips = useMemo(() => {
    const found: { start: number; end: number; name: string; id?: string }[] = []
    for (const file of [...parseFiles(filesDraft), ...uploading.map(name => ({ name, id: undefined }))]) {
      const mark = placeholderIn(text, file.name)
      let start = text.indexOf(mark)
      while (found.some(c => c.start === start)) start = text.indexOf(mark, start + 1)
      if (start >= 0) found.push({ ...file, start, end: start + mark.length })
    }
    return found.sort((a, b) => a.start - b.start)
  }, [text, filesDraft, uploading])
  useLayoutEffect(() => {
    if (!layer.current || !box.current) return
    layer.current.style.padding = getComputedStyle(box.current).padding
    layer.current.scrollTop = box.current.scrollTop
  }, [chips, mobile])
  useEffect(() => {
    if (!mobile) box.current?.focus()
  }, [draft])
  const attach = (list: FileList | null) => {
    const names = new Set([...parseFiles(filesDraft).map(f => f.name), ...uploading])
    const files = [...(list ?? [])].map(file => {
      const [, stem, extension] = /^(.*?)(\.[^.]*)?$/.exec(file.name || 'file')!
      let name = file.name || 'file'
      for (let n = 2; names.has(name) || text.includes(placeholder(name)); n++) name = `${stem}-${n}${extension ?? ''}`
      names.add(name)
      return new File([file], name, { type: file.type })
    })
    if (!files.length) return
    const at = box.current?.selectionStart ?? text.length
    setText(text.slice(0, at) + files.map(file => placeholder(file.name)).join(' ') + text.slice(at))
    setUploading(current => [...current, ...files.map(file => file.name)])
    for (const file of files)
      upload(file)
        .then(({ id }) => setFilesDraft(current => JSON.stringify([...parseFiles(current), { id, name: file.name }])))
        .catch((e: Error) => onError(e.message))
        .finally(() => setUploading(current => current.filter(name => name !== file.name)))
  }
  // May be called after the box moved on to another draft, whose caret says nothing about this one.
  const insertSpeech = (speech: string) => {
    let end: number | undefined
    let at = 0
    let inserted = ''
    let replaced = ''
    setText(current => {
      const el = box.current?.value === current ? box.current : null
      const [from, to] = el ? [el.selectionStart, el.selectionEnd] : [current.length, current.length]
      const lead = /\S$/.test(current.slice(0, from)) ? ' ' : ''
      at = from
      inserted = lead + speech + (/^\S/.test(current.slice(to)) ? ' ' : '')
      replaced = current.slice(from, to)
      if (el) end = from + lead.length + speech.length
      return current.slice(0, from) + inserted + current.slice(to)
    })
    requestAnimationFrame(() => {
      const el = box.current
      // Selecting in an unfocused box would open the phone's keyboard.
      if (el && end !== undefined && (!mobile || document.activeElement === el)) el.setSelectionRange(end, end)
    })
    // Left alone if it was edited since.
    return () =>
      setText(current => {
        const found = current.startsWith(inserted, at) ? at : current.lastIndexOf(inserted)
        return found < 0 ? current : current.slice(0, found) + replaced + current.slice(found + inserted.length)
      })
  }
  const send = () => {
    if (uploading.length || dictating) return
    for (const [, used] of text.matchAll(/(?:^|\s)\/(\S+)/g))
      if (commands.includes(used)) mutate('sessions.command_used', { name: used }).catch(console.error)
    onSend(text.trim(), parseFiles(filesDraft))
    if (mobile) box.current?.blur()
  }
  return (
    <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
      {matches.length > 0 && (
        <div className="folder-list" role="listbox">
          {matches.map((name, i) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={i === highlighted}
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pickCommand(name)}
            >
              /{name}
            </button>
          ))}
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
        <div className="composer-field" data-chips={chips.length ? '' : undefined}>
          <textarea
            ref={box}
            value={text}
            onChange={e => {
              setText(e.target.value)
              setCaret(e.target.selectionStart)
              selection.current = [e.target.selectionStart, e.target.selectionEnd]
              setActive(0)
            }}
            onSelect={e => {
              const { selectionStart, selectionEnd, selectionDirection } = e.currentTarget
              const [start, end] = [selectionStart, selectionEnd].map((at, side) => {
                const chip = chips.find(c => c.start < at && at < c.end)
                if (!chip) return at
                const before = selection.current[side]
                if (before === chip.start) return chip.end
                if (before === chip.end) return chip.start
                if (selectionStart !== selectionEnd) return side ? chip.end : chip.start
                return at - chip.start < chip.end - at ? chip.start : chip.end
              })
              selection.current = [start, end]
              if (start !== selectionStart || end !== selectionEnd)
                e.currentTarget.setSelectionRange(start, end, selectionDirection)
              setCaret(start)
            }}
            onScroll={e => layer.current && (layer.current.scrollTop = e.currentTarget.scrollTop)}
            onKeyDown={e => {
              const { selectionStart: at, selectionEnd, selectionDirection } = e.currentTarget
              if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.metaKey && !e.ctrlKey) {
                const left = e.key === 'ArrowLeft'
                const collapsed = at === selectionEnd
                const backward = selectionDirection === 'backward' || (selectionDirection === 'none' && left)
                const from = collapsed || backward ? at : selectionEnd
                const chip = chips.find(c => (left ? c.end : c.start) === from)
                if (chip && (e.shiftKey || collapsed)) {
                  e.preventDefault()
                  const to = left ? chip.start : chip.end
                  const anchor = !e.shiftKey ? to : collapsed ? at : backward ? selectionEnd : at
                  const [start, end] = [Math.min(anchor, to), Math.max(anchor, to)]
                  selection.current = [start, end]
                  e.currentTarget.setSelectionRange(start, end, to < anchor ? 'backward' : 'forward')
                  return
                }
              }
              if (at === selectionEnd && !e.metaKey && (e.key === 'Backspace' || e.key === 'Delete')) {
                const chip = chips.find(c => (e.key === 'Backspace' ? c.end : c.start) === at)
                // Not prevented: the browser deletes the selected chip itself, which keeps ⌘Z working
                if (chip) e.currentTarget.setSelectionRange(chip.start, chip.end)
              }
              if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault()
                setActive((highlighted + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length)
              } else if (matches.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey))) {
                e.preventDefault()
                pickCommand(matches[highlighted])
              } else if (matches.length && e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setDismissed(text)
              } else if (e.key === 'Enter' && e.metaKey) {
                e.preventDefault()
                send()
              } else onKeyDown?.(e)
            }}
            placeholder={hint}
            autoComplete="off"
            enterKeyHint="enter"
            rows={1}
          />
          {chips.length > 0 && (
            <div ref={layer} className="composer-layer" aria-hidden="true">
              {chips.map(({ start, end, name, id }, i) => (
                <Fragment key={id ?? name}>
                  {text.slice(chips[i - 1]?.end ?? 0, start)}
                  <span
                    className="composer-chip"
                    data-staged={id}
                    data-image={id && IMAGE.test(name) ? '' : undefined}
                    onMouseDown={e => {
                      e.preventDefault()
                      box.current?.focus()
                      box.current?.setSelectionRange(end, end)
                    }}
                    onClick={e => {
                      if (id && IMAGE.test(name)) sendOpenDoc(e.currentTarget, unsentPath(id))
                    }}
                  >
                    {text.slice(start, end)}
                  </span>
                </Fragment>
              ))}
              {text.slice(chips[chips.length - 1].end)}
              {'\u200b'}
            </div>
          )}
        </div>
        {/* On phones, blurring the box folds this row, which would move a button out from under the tap. */}
        <span className="composer-buttons" onMouseDown={e => mobile && e.preventDefault()}>
          {actions}
          <button
            type="button"
            className="ghost icon round attach"
            title="Attach files"
            aria-label="Attach files"
            onClick={() => picker.current?.click()}
          >
            <PaperclipIcon />
          </button>
          <DictateButton key={draft} insert={insertSpeech} onActive={setDictating} onError={onError} />
          {onStop && !text.trim() && !dictating ? (
            <button type="button" className="primary icon round send" title="Stop" aria-label="Stop" onClick={onStop}>
              <StopIcon />
            </button>
          ) : (
            <button
              type="submit"
              className="primary icon round send"
              disabled={!text.trim() || uploading.length > 0 || dictating}
              title="Send"
              aria-label="Send"
            >
              {button ?? <SendIcon />}
            </button>
          )}
        </span>
      </form>
    </div>
  )
}

/**
 * Message box for a session. Send (⌘↩) adds a follow-up to `sessions.queue`, which the desktop sends at once to a session
 * it holds, where Claude takes it at its next pause, and otherwise once Claude is neither working nor asking for a
 * permission; the card must show the queue with `QueuedMessage`. Sending an empty
 * box sends the queue now, or interrupts Claude's turn so that it takes the message waiting for it; Esc moves a queued
 * message back into the box.
 */
export function Composer({ session, onError }: { session: Session; onError: (message: string) => void }) {
  const entries = useOutbox(session.id)
  const queued = entries.find(e => e.state !== 'sending')
  const editing = !!useQuery('sessions_rewinds', { session: session.id })?.length
  const fail = (e: Error) => onError(e.message)
  const cancelEdit = () =>
    mutate('sessions.rewind_cancel', { session: session.id }).then(() => setDraft(draftKey(session.id), ''), fail)
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
    const message = { text: prompt, at: Date.now() }
    setPending(session.id, sends => [...sends, message])
    mutate('sessions.queue_add', {
      session: session.id,
      text,
      files: JSON.stringify(files.filter(f => ids.includes(f.id))),
    }).catch((e: Error) => {
      setPending(session.id, sends => sends.filter(s => s !== message))
      fail(e)
    })
  }
  return (
    <MessageBox
      draft={draftKey(session.id)}
      files={filesKey(session.id)}
      placeholder="Message Claude…"
      cwd={session.cwd}
      onSend={send}
      onError={onError}
      onKeyDown={e => {
        if (e.key !== 'Escape' || !(queued || editing)) return
        e.preventDefault()
        if (queued) unqueue(queued).catch(fail)
        else cancelEdit()
      }}
      actions={
        <>
          {editing && (
            <button
              type="button"
              className="ghost icon round"
              title="Cancel the edit (Esc)"
              aria-label="Cancel the edit"
              onClick={cancelEdit}
            >
              ✕
            </button>
          )}
        </>
      }
      onStop={
        session.kind === 'background' && busy(session)
          ? () => run('sessions.stop', { session: session.id }).catch(fail)
          : undefined
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
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    </svg>
  )
}

function SendIcon() {
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

export function Spinner() {
  return <span className="spinner" />
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
  const [other, setOther] = useState<Record<string, string>>({})
  const answerFor = (q: Question) => [...(picked[q.question] ?? []), other[q.question]?.trim()].filter(Boolean)
  const toggle = (q: Question, label: string) => {
    if (!q.multiSelect) setOther(o => ({ ...o, [q.question]: '' }))
    setPicked(p => {
      const current = p[q.question] ?? []
      const next = q.multiSelect
        ? current.includes(label)
          ? current.filter(l => l !== label)
          : [...current, label]
        : [label]
      return { ...p, [q.question]: next }
    })
  }
  const write = (q: Question, text: string) => {
    if (!q.multiSelect) setPicked(p => ({ ...p, [q.question]: [] }))
    setOther(o => ({ ...o, [q.question]: text }))
  }
  const complete = questions.every(q => answerFor(q).length > 0)
  return (
    <div className="decision" style={style}>
      {questions.map(q => (
        <div key={q.question} className="question">
          <div>{q.question}</div>
          <div className="options">
            {q.options.map(o => (
              <button
                key={o.label}
                type="button"
                className="option"
                onClick={() => toggle(q, o.label)}
                aria-pressed={(picked[q.question] ?? []).includes(o.label)}
              >
                {o.label}
                {o.description && <span className="description">{o.description}</span>}
              </button>
            ))}
            <input placeholder="Other…" value={other[q.question] ?? ''} onChange={e => write(q, e.target.value)} />
          </div>
        </div>
      ))}
      <button
        className="primary"
        style={{ width: '100%' }}
        disabled={!complete}
        onClick={() => onAnswer(Object.fromEntries(questions.map(q => [q.question, answerFor(q).join(', ')])))}
      >
        Answer
      </button>
    </div>
  )
}
