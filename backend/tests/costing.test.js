// The cost sheet maths against the approved Fitleasure core costing sheet (six real styles), and the cases around it.
// The shared cases are in tests/fixtures/costing.cases.json, which the frontend suite runs too.
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { computeCostSheet, lineAmount, linesFromBom, DEFAULT_PERCENTS } from '../src/lib/costing.js'
import { weightedConsumption } from '../src/lib/bomMath.js'

const cases = JSON.parse(readFileSync(new URL('./fixtures/costing.cases.json', import.meta.url), 'utf8'))
const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k]]))
const ROWS = ['fabric', 'process', 'trims', 'labelsPackaging', 'materials', 'labour', 'base', 'overhead', 'rejection', 'margin', 'tradio', 'price', 'negotiated']

describe('the approved Fitleasure sheet, style by style', () => {
  for (const c of cases) {
    test(c.name, () => assert.deepEqual(pick(computeCostSheet(c.sheet), ROWS), pick(c.expected, ROWS)))
  }
})

describe('one material line', () => {
  test('quantity times rate, with wastage on top', () => {
    assert.equal(lineAmount({ consumption: 1.65, rate: 135 }), 222.75)
    assert.equal(lineAmount({ consumption: 2, rate: 100, wastagePct: 5 }), 210)
  })

  test('imported cloth carries freight per unit and duty on rate plus freight', () => {
    // (100 + 20) x 1.1 = 132 per metre, 1.5 m, 2% wastage
    assert.equal(Number(lineAmount({ consumption: 1.5, rate: 100, freight: 20, dutyPct: 10, wastagePct: 2 }).toFixed(6)), 201.96)
  })

  test('half-typed or missing numbers count as zero', () => {
    assert.equal(lineAmount({ consumption: '', rate: 'x' }), 0)
    assert.equal(lineAmount(null), 0)
    assert.equal(lineAmount({ consumption: '2.5', rate: '10' }), 25)
  })
})

describe('the summary rows', () => {
  const sheet = { fabric: [{ consumption: 1, rate: 100 }], labour: { making: 50 }, ...DEFAULT_PERCENTS }

  test('build up in the sheet\'s order from the subtotals', () => {
    const r = computeCostSheet({ ...sheet, discountPct: 0 })
    assert.equal(r.base, 150)
    assert.equal(r.overhead, 7.5)                       // 5% of base
    assert.equal(r.rejection, 4.725)                    // 3% of base + overhead
    assert.equal(r.margin, 32.445)                      // 20% of base + overhead + rejection
    assert.equal(r.tradio, 15)                          // 10% of base alone, not compounded
    assert.equal(r.price, 209.67)
    assert.equal(r.negotiated, 209.67)
  })

  test('a negotiated discount comes off the price', () => {
    assert.equal(computeCostSheet({ ...sheet, discountPct: 10 }).negotiated, 188.7)
  })

  test('no Tradio fee when the percent is zero', () => {
    const r = computeCostSheet({ ...sheet, tradioPct: 0 })
    assert.equal(r.tradio, 0)
    assert.equal(r.price, 194.67)
  })

  test('an empty sheet is zero, not NaN', () => {
    const r = computeCostSheet({})
    assert.equal(r.price, 0)
    assert.equal(r.base, 0)
    assert.deepEqual(r.lines.fabric, [])
  })

  test('with a quantity it also says what the order comes to', () => {
    const r = computeCostSheet({ ...sheet, discountPct: 10, qty: 1000 })
    assert.equal(r.orderValue, 209670)
    assert.equal(r.negotiatedValue, 188700)             // 188.70 as shown, times 1000
  })

  test('each line\'s amount is reported by section', () => {
    const r = computeCostSheet({ fabric: [{ consumption: 1.65, rate: 135 }, { consumption: 1, rate: 17.5 }], trims: [{ consumption: 1, rate: 45 }] })
    assert.deepEqual(r.lines, { fabric: [222.75, 17.5], process: [], trims: [45], labelsPackaging: [] })
  })
})

describe('seeding a sheet from a bill of materials', () => {
  const plan = { sizes: ['S', 'M', 'L', 'XL', 'XXL'], ratio: [1, 2, 3, 2, 1] }
  const lines = [
    { section: 'fabric', item: 'Polar fleece 300 GSM', unit: 'kg', consumption: 0.72, perSize: [0.63, 0.675, 0.72, 0.765, 0.8325], wastagePct: 7, rate: 410 },
    { section: 'trims', item: 'YKK zip', unit: 'pcs', consumption: 1, wastagePct: 2, rate: 45 },
    { section: 'process', item: 'HD print', unit: 'pc', consumption: 1, rate: 15 },
    { section: 'labels_packaging', item: 'Main label', unit: 'pcs', consumption: 1, rate: 1.5 },
    { section: 'other', item: 'Sample charge', unit: 'pc', consumption: 1, rate: 99 },
  ]
  const seeded = linesFromBom(lines, l => weightedConsumption(plan, l))

  test('puts each line under its block with the size-mix consumption, wastage and rate', () => {
    assert.deepEqual(Object.keys(seeded), ['fabric', 'process', 'trims', 'labelsPackaging'])
    assert.equal(seeded.fabric[0].consumption, 0.7225)
    assert.equal(seeded.fabric[0].wastagePct, 7)
    assert.equal(seeded.fabric[0].rate, 410)
    assert.equal(seeded.trims[0].name, 'YKK zip')
    assert.equal(seeded.labelsPackaging[0].rate, 1.5)
  })

  test('leaves out lines the costing blocks do not have', () => {
    assert.ok(!JSON.stringify(seeded).includes('Sample charge'))
  })

  test('and the seeded sheet prices to what the BOM says', () => {
    const r = computeCostSheet({ ...seeded, labour: {}, overheadPct: 0, rejectionPct: 0, marginPct: 0, tradioPct: 0 })
    // fabric 0.7225 kg x 410 x 1.07 = 316.96075; zip 45 x 1.02 = 45.9; print 15; label 1.5
    assert.equal(r.fabric, 316.9608)
    assert.equal(r.trims, 45.9)
    assert.equal(r.base, 379.3608)
  })
})
