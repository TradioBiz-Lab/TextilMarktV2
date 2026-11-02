import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Dropping a style removes it from state while its page is still mounted, so the page renders once more with no order and
// returns early. A hook called after that early return makes React throw "Rendered fewer hooks than expected" and the
// whole app falls to the error screen. There is no DOM test setup here, so this reads the source instead.
describe('AdminOrderDetail hooks sit above its early returns', () => {
  const src = readFileSync(new URL('../pages/admin/AdminOrderDetail.jsx', import.meta.url), 'utf8')
  const lines = src.split('\n')
  const start = lines.findIndex(l => l.startsWith('export function AdminOrderDetail'))
  const guard = lines.findIndex((l, i) => i > start && l === '  if (!order) return null')

  test('the early return is where this test expects it', () => {
    expect(start).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(start)
  })

  test('no hook is called at the top level of the component after it', () => {
    // Top level of the component = two-space indent; the component ends at the first closing brace in column 0.
    const end = lines.findIndex((l, i) => i > guard && l === '}')
    const after = lines.slice(guard + 1, end === -1 ? undefined : end)
    const late = after.filter(l => /^ {2}(const|let|var)?[^/]*\buse[A-Z]\w*\(/.test(l) && !/^ {2}\/\//.test(l))
    expect(late).toEqual([])
  })
})
