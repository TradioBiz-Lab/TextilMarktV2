import { describe, test, expect } from 'vitest'
import costCases from '../../../backend/tests/fixtures/costing.cases.json'
import { toForm, toNumbers, figures, payloadFrom, isDirty, blankMaterial, costStatus, awaitingReview, decimal } from '../lib/costing.js'
import { SECTIONS, blankLine, toDraft, numeric, preview, payloadFrom as bomPayload, reviewCount, isDirty as bomDirty, alignPerSize, shareEvenly } from '../lib/bomUi.js'

const sheet = { styleName: 'Baggy Active Jacket', styleCode: 'FLGCW17', qty: 1000, ...costCases[0].sheet }

describe('the cost sheet editor', () => {
  test('the form shows the sheet and works out the same price as the approved sheet', () => {
    const form = toForm(sheet)
    expect(form.fabric[0].consumption).toBe('1.65')
    expect(form.labour.making).toBe('116')
    expect(figures(form).price).toBe(costCases[0].expected.price)
    expect(figures(form).negotiated).toBe(costCases[0].expected.negotiated)
  })

  test('half-typed numbers and nameless lines do not break the figures', () => {
    const form = toForm(sheet)
    form.fabric.push({ ...blankMaterial('fabric'), name: '  ', consumption: '1.', rate: 'x' })
    form.trims[0].rate = ''
    form.discountPct = '.'
    expect(Number.isFinite(figures(form).price)).toBe(true)
    expect(toNumbers(form).fabric).toHaveLength(1)                       // the nameless line is dropped
  })

  test('the payload is what the server takes: numbers, the version being edited', () => {
    const body = payloadFrom(toForm(sheet), '2026-10-12T10:00:00.000Z')
    expect(body.updatedAt).toBe('2026-10-12T10:00:00.000Z')
    expect(body.fabric[0]).toMatchObject({ name: 'NS Lycra', consumption: 1.65, rate: 135 })
    expect(body.labour).toEqual({ cuttingThreads: 14, making: 116, finishingPacking: 12 })
    expect(typeof body.overheadPct).toBe('number')
  })

  test('knows when something changed', () => {
    const saved = toForm(sheet)
    const edited = toForm(sheet)
    expect(isDirty(edited, saved)).toBe(false)
    edited.labour.making = '120'
    expect(isDirty(edited, saved)).toBe(true)
  })

  test('a new line starts the way its block does', () => {
    expect(blankMaterial('fabric')).toMatchObject({ consumption: '', unit: 'm' })
    expect(blankMaterial('trims')).toMatchObject({ consumption: '1', unit: 'pcs' })
  })

  test('statuses read differently to a brand: shared is its to-do', () => {
    expect(costStatus('shared').label).toBe('Shared')
    expect(costStatus('shared', { brand: true }).label).toBe('Needs your review')
    expect(costStatus('approved', { brand: true }).tone).toBe('good')
    expect(costStatus('mystery').label).toBe('mystery')
    expect(awaitingReview([{ status: 'shared' }, { status: 'approved' }, { status: 'commented' }])).toHaveLength(1)
  })

  test('decimal keeps only a number\'s characters', () => {
    expect(decimal('1,2.5.6x')).toBe('12.56')
    expect(decimal(null)).toBe('')
  })
})

const bom = {
  plan: { totalQty: 10800, sizes: ['S', 'M', 'L', 'XL', 'XXL'], ratio: [1, 2, 3, 2, 1], colours: [{ name: 'BLACK', qty: 3600 }, { name: 'NAVY', qty: 3600 }, { name: 'CHARCOAL GREY', qty: 3600 }] },
  lines: [
    { lineId: 'l1', section: 'fabric', item: 'Polar fleece 300 GSM', spec: '', unit: 'kg', consumption: 0.72, perSize: [0.63, 0.675, 0.72, 0.765, 0.8325], wastagePct: 7, perColour: true, supplierId: null, itemId: null, rate: 410, note: '', source: 'manual', confidence: null, needsReview: false, evidence: '' },
    { lineId: 'l2', section: 'trims', item: 'YKK zip', spec: '', unit: 'pcs', consumption: 1, perSize: [], wastagePct: 2, perColour: false, supplierId: 's1', itemId: null, rate: 45, note: '', source: 'ai', confidence: 0.8, needsReview: true, evidence: 'Construction sheet' },
  ],
}

describe('the bill of materials editor', () => {
  test('the preview works the real 5117 fleece plan: 2,783 kg a colour, 8,349 kg in all', () => {
    const p = preview(toDraft(bom), 10800)
    const fleece = p.lines[0].computed
    expect(fleece.orderQty).toBe(8349)
    expect(fleece.perColour.map(c => c.orderQty)).toEqual([2783, 2783, 2783])
    expect(p.lines[1].computed.orderQty).toBe(11016)
    expect(p.warnings).toEqual([])
  })

  test('the payload is what the server takes, with the line ids kept and per-size blanks as null', () => {
    const body = bomPayload(toDraft(bom), '2026-10-12T10:00:00.000Z')
    expect(body.updatedAt).toBe('2026-10-12T10:00:00.000Z')
    expect(body.plan).toMatchObject({ totalQty: 10800, sizes: ['S', 'M', 'L', 'XL', 'XXL'], sizeRatio: [1, 2, 3, 2, 1] })
    expect(body.lines[0]).toMatchObject({ lineId: 'l1', consumption: 0.72, wastagePct: 7, perColour: true, perSize: [0.63, 0.675, 0.72, 0.765, 0.8325] })
    expect(body.lines[1].perSize).toEqual([null, null, null, null, null])
    expect(body.lines[1].supplierId).toBe('s1')
    expect(bomPayload(toDraft(bom), null, { confirmAll: true }).confirmAll).toBe(true)
  })

  test('a line the person has not named is left out, and a colour with no name too', () => {
    const d = toDraft(bom)
    d.lines.push(blankLine('trims'))
    d.plan.colours.push({ key: 'x', name: '  ', qty: '5' })
    const body = bomPayload(d)
    expect(body.lines).toHaveLength(2)
    expect(body.plan.colours).toHaveLength(3)
  })

  test('lines from the AI count as needing a look until confirmed', () => {
    const d = toDraft(bom)
    expect(reviewCount(d.lines)).toBe(1)
    d.lines[1].confirmed = true
    expect(reviewCount(d.lines)).toBe(0)
    expect(bomPayload(d).lines[1].confirmed).toBe(true)
  })

  test('knows when something changed', () => {
    const saved = toDraft(bom)
    const edited = toDraft(bom)
    expect(bomDirty(edited, saved)).toBe(false)
    edited.lines[0].rate = '420'
    expect(bomDirty(edited, saved)).toBe(true)
  })

  test('sections, new lines and the size boxes', () => {
    expect(SECTIONS.map(s => s.id)).toEqual(['fabric', 'process', 'trims', 'labels_packaging', 'other'])
    expect(blankLine('fabric')).toMatchObject({ unit: 'm', perColour: true })
    expect(blankLine('trims')).toMatchObject({ unit: 'pcs', perColour: false })
    expect(alignPerSize([{ perSize: ['1'] }, { perSize: ['1', '2', '3'] }], 2).map(l => l.perSize)).toEqual([['1', ''], ['1', '2']])
  })

  test('colours share the quantity evenly, the first taking the remainder', () => {
    expect(shareEvenly([{ name: 'A' }, { name: 'B' }, { name: 'C' }], 1000).map(c => c.qty)).toEqual(['334', '333', '333'])
    expect(shareEvenly([], 100)).toEqual([])
  })

  test('numeric() gives the preview numbers, with blank per-size boxes as the base figure', () => {
    const d = toDraft(bom)
    d.lines[0].perSize[1] = ''
    const n = numeric(d)
    expect(n.lines[0].perSize[1]).toBeNull()
    expect(n.plan.ratio).toEqual([1, 2, 3, 2, 1])
  })
})
