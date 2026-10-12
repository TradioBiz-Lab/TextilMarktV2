import { describe, test, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// ui.jsx pulls in pdf.js, which needs a browser; DataTable only uses its keyboard helper.
vi.mock('../components/ui.jsx', () => ({
  activateOnKey: onClick => e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e) } },
}))

const { DataTable } = await import('../components/DataTable.jsx')

// What the stylesheet depends on is this markup: classes, data attributes and roles. These tests pin it.
const COLUMNS = [
  { key: 'style', header: 'Style', primary: true },
  { key: 'mfr', header: 'Manufacturer' },
  { key: 'qty', header: 'Ordered qty', numeric: true, width: 120 },
  { key: 'notes', header: 'Notes', hideOnMobile: true },
]
const ROWS = [
  { id: 'a', style: 'Aero Windbreaker', mfr: 'NCR Active Unit', qty: 900, notes: '' },
  { id: 'b', style: 'Core Tee', mfr: 'Pramod Garments', qty: 0, notes: 'rush' },
]
const render = (props = {}) => renderToStaticMarkup(createElement(DataTable, { columns: COLUMNS, rows: ROWS, rowKey: 'id', ...props }))

describe('DataTable markup', () => {
  test('a table with a header cell per column and a row per record', () => {
    const out = render()
    expect(out).toContain('class="data-table')
    expect(out.match(/<th /g)).toHaveLength(4)
    expect(out.match(/<tr/g)).toHaveLength(3) // header row plus two
    expect(out).toContain('scope="col"')
    expect(out).toContain('Aero Windbreaker')
    expect(out).toContain('Pramod Garments')
  })

  test('is a card layout on phones unless told otherwise', () => {
    expect(render()).toContain('data-table--cards')
    expect(render()).toContain('data-table-wrap--cards')
    expect(render({ mobileCard: false })).not.toContain('--cards')
  })

  test('every cell carries its column header as a label, for the phone card', () => {
    const out = render()
    expect(out).toContain('data-label="Manufacturer"')
    expect(out).toContain('data-label="Ordered qty"')
    expect(out).toContain('data-label="Style"')
  })

  test('the primary column is the card title; numeric columns are right-aligned with tabular figures; hideOnMobile is marked', () => {
    const out = render()
    expect(out).toMatch(/<td class="dt-primary" data-align="left" data-label="Style">/)
    expect(out).toMatch(/<td class="dt-num" data-align="right" data-label="Ordered qty">/)
    expect(out).toMatch(/<td class="dt-hide-mobile" data-align="left" data-label="Notes">/)
  })

  test('without a primary column, the first text column is the title', () => {
    const cols = [{ key: 'qty', header: 'Qty', numeric: true }, { key: 'style', header: 'Style' }]
    expect(render({ columns: cols })).toMatch(/<td class="dt-primary" data-align="left" data-label="Style">/)
  })

  test('an explicit align wins', () => {
    const out = render({ columns: [{ key: 'style', header: 'Style', align: 'center' }] })
    expect(out).toContain('data-align="center"')
  })

  test('column widths go on the header cell', () => {
    expect(render()).toMatch(/<th [^>]*style="width:120px"[^>]*>Ordered qty/)
  })

  test('empty cells show a hyphen, zero shows as 0, render() output is used', () => {
    const out = render({ columns: [{ key: 'notes', header: 'Notes' }, { key: 'qty', header: 'Qty' }, { key: 'style', header: 'Style', render: r => `[${r.style}]` }] })
    expect(out).toContain('<span class="dt-val">-</span>')
    expect(out).toContain('<span class="dt-val">0</span>')
    expect(out).toContain('[Aero Windbreaker]')
  })

  test('sticky header and dense rows are classes; the scroll box gets a max height only when sticky', () => {
    expect(render()).toContain('data-table--sticky')
    expect(render()).toContain('max-height:min(70vh, 720px)')
    expect(render({ stickyHeader: false })).not.toContain('data-table--sticky')
    expect(render({ stickyHeader: false })).not.toContain('max-height')
    expect(render({ maxHeight: 300 })).toContain('max-height:300px')
    expect(render()).not.toContain('data-table--dense')
    expect(render({ dense: true })).toContain('data-table--dense')
  })

  test('colours come from the theme tokens, as custom properties', () => {
    const out = render()
    expect(out).toContain('--dt-border:#e2e8f0')
    expect(out).toContain('--dt-accent:#F97316')
  })

  test('className and style reach the outer box', () => {
    const out = render({ className: 'my-table', style: { margin: 4 } })
    expect(out).toMatch(/class="data-table-wrap[^"]*my-table"/)
    expect(out).toContain('margin:4px')
  })
})

describe('DataTable rows', () => {
  test('rows are plain unless there is an onRowClick', () => {
    const out = render()
    expect(out).not.toContain('role="button"')
    expect(out).not.toContain('tabindex')
  })

  test('with onRowClick every row is a focusable button', () => {
    const out = render({ onRowClick: () => {} })
    expect(out.match(/<tr role="button" tabindex="0"/g)).toHaveLength(2)
  })

  test('the header row is never a button', () => {
    const out = render({ onRowClick: () => {} })
    expect(out).toMatch(/<thead><tr><th/)
  })

  test('works with a function rowKey and rows that have no key at all', () => {
    expect(() => render({ rowKey: (r, i) => `${r.style}-${i}` })).not.toThrow()
    expect(() => render({ rowKey: undefined, rows: [{ style: 'x' }, { style: 'y' }] })).not.toThrow()
  })
})

describe('DataTable empty and loading states', () => {
  test('no rows shows the empty message, in place of the table', () => {
    const out = render({ rows: [] })
    expect(out).toContain('data-table-empty')
    expect(out).toContain('Nothing to show yet.')
    expect(out).not.toContain('<table')
  })

  test('a custom empty state is shown as given', () => {
    const out = render({ rows: [], empty: createElement('p', { className: 'mine' }, 'No styles yet. Add one.') })
    expect(out).toContain('<p class="mine">No styles yet. Add one.</p>')
  })

  test('undefined rows count as none', () => {
    expect(render({ rows: undefined })).toContain('data-table-empty')
  })

  test('loading with no rows shows placeholder rows, not the empty message', () => {
    const out = render({ rows: [], loading: true })
    expect(out).toContain('role="status"')
    expect(out).toContain('dt-skel-row')
    expect(out).not.toContain('Nothing to show yet.')
  })

  test('loading with rows on screen keeps them and marks the table busy', () => {
    const out = render({ loading: true })
    expect(out).toContain('aria-busy="true"')
    expect(out).toContain('Aero Windbreaker')
  })

  test('not loading means no busy flag', () => {
    expect(render()).not.toContain('aria-busy')
  })
})
