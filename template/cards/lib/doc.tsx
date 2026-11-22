import { useEffect, useMemo, useState } from 'react'
import { pty, run, useQuery } from 'switchboard'
import { copyCode, HTML, relativePath, renderMarkdown, TXT } from './markdown'
import { useMobile } from './theme'

/** Keeps `docs_files` current for `path` with a `docs.watch` run, attached while mounted and reused across remounts through `localStorage`. */
export function useDocWatch(path: string) {
  useEffect(() => {
    if (!path) return
    const key = `Doc.watch:${path}`
    let connection: ReturnType<typeof pty> | undefined
    let disposed = false
    const connect = async (retry: boolean) => {
      const stored = localStorage.getItem(key)
      const id = stored ?? (await run('docs.watch', { path }))
      localStorage.setItem(key, id)
      if (disposed) return
      connection = pty(id, {
        data: () => undefined,
        close: () => {
          connection = undefined
          if (disposed) return
          localStorage.removeItem(key)
          if (retry) connect(false).catch(console.error)
        },
      })
    }
    connect(true).catch(console.error)
    return () => {
      disposed = true
      connection?.close()
    }
  }, [path])
}

/** A previewed file's path, as `./…` inside `cwd`: opens it in its default app, or its folder on ⇧-click. Not on phones. */
export function DocPath({ path, cwd }: { path: string; cwd?: string | null }) {
  const mobile = useMobile()
  if (mobile) return null
  return (
    <div className="doc-path ellipsis" title={path}>
      <a
        href="#"
        title="Open in its default app (⇧-click for its folder)"
        onMouseDown={e => e.shiftKey && e.preventDefault()}
        onClick={e => {
          e.preventDefault()
          const target = e.shiftKey ? path.slice(0, path.lastIndexOf('/')) || '/' : path
          run('sessions.reveal', { path: target }).catch(console.error)
        }}
      >
        {relativePath(path, cwd)}
      </a>
    </div>
  )
}

/**
 * A .txt file's editable text, saved with the button or ⌘↩ (`docs.save`). An unsaved edit is kept in `localStorage`
 * with the text it started from, as switching tabs unmounts it.
 */
function TextFile({ path, text }: { path: string; text: string }) {
  const key = `Doc.edit:${path}`
  const [edit, setEdit] = useState<{ text: string; base: string } | null>(() =>
    JSON.parse(localStorage.getItem(key) ?? 'null'),
  )
  const [error, setError] = useState('')
  const [saveId, setSaveId] = useState('')
  const saveRun = useQuery<{ state: string; summary: string | null }>('core_runs', { id: saveId })?.[0]
  const saving = !!saveId && (!saveRun || ['queued', 'running'].includes(saveRun.state))
  const change = (next: typeof edit) => {
    setEdit(next)
    if (next) localStorage.setItem(key, JSON.stringify(next))
    else localStorage.removeItem(key)
  }
  useEffect(() => {
    if (edit?.text === text) change(null)
  }, [edit, text])
  const save = () => {
    if (!edit || saving) return
    setError('')
    run('docs.save', { path, content: edit.text, base: edit.base }).then(setSaveId, (e: Error) => setError(e.message))
  }
  const revert = () => {
    change(null)
    setError('')
    setSaveId('')
  }
  const failed = error || (edit && saveRun?.state === 'failure' && (saveRun.summary || 'Saving failed'))
  return (
    <>
      <textarea
        className="doc-text"
        aria-label={path}
        value={edit?.text ?? text}
        readOnly={saving}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={e => change({ text: e.target.value, base: edit?.base ?? text })}
        onKeyDown={e => {
          if (e.key !== 'Enter' || !e.metaKey) return
          e.preventDefault()
          e.stopPropagation()
          save()
        }}
      />
      {edit && (
        <div className="doc-edit-bar">
          <span role="status">{failed || (saving ? 'Saving…' : 'Unsaved')}</span>
          <button type="button" className="ghost" disabled={saving} onClick={revert}>
            Revert
          </button>
          <button type="button" className="primary" disabled={saving} onClick={save}>
            Save
          </button>
        </div>
      )}
    </>
  )
}

/**
 * A Markdown file, an editable .txt file, or an HTML file rendered whole in a sandboxed frame, kept current by a `docs.watch` run (useDocWatch).
 * Its path (see `DocPath`), as `./…` inside `cwd`, prefixes quotes of its lines (`data-doc-path`); relative links in it
 * resolve against its folder (`data-cwd`).
 */
export function Doc({ path, cwd }: { path: string; cwd?: string | null }) {
  const row = useQuery<{ text: string | null; error: string | null }>('docs_files', { path })?.[0]
  const shown = relativePath(path, cwd)
  const isHtml = HTML.test(path)
  const isText = TXT.test(path)
  const html = useMemo(
    () => row?.text != null && !isHtml && !isText && renderMarkdown(row.text, false),
    [row?.text, isHtml, isText],
  )

  useDocWatch(path)

  return (
    <div className="doc">
      <DocPath path={path} cwd={cwd} />
      {row?.error ? (
        <div className="empty">{row.error}</div>
      ) : isText && row?.text != null ? (
        <TextFile key={path} path={path} text={row.text} />
      ) : isHtml && row?.text != null ? (
        <iframe className="doc-frame" title={shown} sandbox="allow-scripts" srcDoc={row.text} />
      ) : html !== false ? (
        <div
          className="message"
          data-doc-path={shown}
          data-cwd={path.slice(0, path.lastIndexOf('/'))}
          onClick={e => copyCode(e, row!.text!)}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="empty">Loading…</div>
      )}
    </div>
  )
}
