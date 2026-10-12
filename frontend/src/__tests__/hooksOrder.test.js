import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// A component that returns early while its data is loading must declare every hook ABOVE that return.
// A hook below it runs on the renders after loading but not before, and React throws "Rendered more
// hooks than during the previous render". It only shows when the screen is the first one drawn (a link
// into an order, or a page reload), so a quick click-through in the browser never finds it.
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const HOOK = /\buse(State|Ref|Memo|Effect|Callback|Context|Reducer|LayoutEffect)\(/

describe('hooks come before the early returns', () => {
  for (const [path, marker] of [
    ['../pages/admin/AdminOrderDetail.jsx', 'if (!order) return null'],
  ]) {
    test(path, () => {
      const text = source(path)
      const at = text.indexOf(marker)
      expect(at, `${marker} not found: update this test if the guard moved`).toBeGreaterThan(-1)
      const below = text.slice(at).split('\n').filter(l => HOOK.test(l) && !l.trim().startsWith('//'))
      expect(below, 'hooks declared below the early return').toEqual([])
    })
  }
})
