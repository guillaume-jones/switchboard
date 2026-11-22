import { expect, test, vi } from 'vitest'
import { renderMarkdown } from '../../template/cards/lib/markdown'

vi.mock('switchboard', () => ({ run: vi.fn() }))

test.each(['code', 'pre', 'kbd', 'script'])('escapes HTML after an inline <%s>', tag => {
  const html = renderMarkdown(`a <${tag}> <img src=x: onerror="alert(1)" "">`)
  expect(html).not.toContain('<img')
  expect(html).toContain('&lt;img')
})

test('keeps entities and code readable', () => {
  const html = renderMarkdown('a &amp; b `<i>`')
  expect(html).toContain('a &amp; b <code>&lt;i&gt;</code>')
})
