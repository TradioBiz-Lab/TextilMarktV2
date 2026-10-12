import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import bomCases from '../../../backend/tests/fixtures/bomMath.cases.json'
import costCases from '../../../backend/tests/fixtures/costing.cases.json'
import { computeLine, computeBom, weightedConsumption, roundTo, isCountUnit } from '../lib/bomCalc.js'
import { computeCostSheet, lineAmount, linesFromBom } from '../lib/costCalc.js'

// The browser shows quantities and prices while a person edits; the server stores and shares the real ones.
// Both run the same cases from the backend's fixtures, and the two source files are kept identical, so a drift
// in either place fails here.
const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8')
const withoutHeader = src => src.replace(/^(\/\/[^\n]*\n)+/, '')

describe('the browser copies are the server\'s files', () => {
  test('bomCalc.js is bomMath.js', () => {
    expect(withoutHeader(read('../lib/bomCalc.js'))).toBe(withoutHeader(read('../../../backend/src/lib/bomMath.js')))
  })

  test('costCalc.js is costing.js (the import aside)', () => {
    const server = withoutHeader(read('../../../backend/src/lib/costing.js')).replace("'./bomMath.js'", "'./bomCalc.js'")
    expect(withoutHeader(read('../lib/costCalc.js'))).toBe(server)
  })
})

describe('bill of materials quantities match the server on the shared cases', () => {
  for (const c of bomCases) {
    test(c.name, () => {
      const r = computeLine(c.plan, c.line)
      expect([r.net, r.buffer, r.orderQty]).toEqual([c.expected.net, c.expected.buffer, c.expected.orderQty])
      expect(r.perColour.map(p => [p.colour, p.sizePcs, p.net, p.buffer, p.orderQty])).toEqual(c.expected.perColour.map(p => [p.colour, p.sizePcs, p.net, p.buffer, p.orderQty]))
      if (c.expected.sizePcs) expect(r.sizePcs).toEqual(c.expected.sizePcs)
    })
  }

  test('rounding the way the spreadsheet does, and units bought by the piece', () => {
    expect(roundTo(303.45000000000005, 1)).toBe(303.5)
    expect(isCountUnit('Pcs')).toBe(true)
    expect(isCountUnit('kg')).toBe(false)
  })

  test('the size-mix average consumption and the warnings', () => {
    const plan = { sizes: ['S', 'M', 'L', 'XL', 'XXL'], ratio: [1, 2, 3, 2, 1] }
    expect(weightedConsumption(plan, { consumption: 0.72, perSize: [0.63, 0.675, 0.72, 0.765, 0.8325] })).toBe(0.7225)
    const w = computeBom({ sizes: ['M', 'L'], ratio: [1, 1], colours: [{ name: 'RED', qty: 1000 }, { name: 'BLUE', qty: 501 }] }, [{ unit: 'm', consumption: 1.5, perColour: true }], { totalQty: 1600 })
    expect(w.warnings.map(x => x.code).sort()).toEqual(['colour_total', 'size_rounding'])
  })
})

describe('cost sheet prices match the approved Fitleasure sheet, style by style', () => {
  const ROWS = ['fabric', 'process', 'trims', 'labelsPackaging', 'materials', 'labour', 'base', 'overhead', 'rejection', 'margin', 'tradio', 'price', 'negotiated']
  for (const c of costCases) {
    test(c.name, () => {
      const r = computeCostSheet(c.sheet)
      expect(Object.fromEntries(ROWS.map(k => [k, r[k]]))).toEqual(Object.fromEntries(ROWS.map(k => [k, c.expected[k]])))
    })
  }

  test('one material line, with freight, duty and wastage', () => {
    expect(lineAmount({ consumption: 1.65, rate: 135 })).toBe(222.75)
    expect(Number(lineAmount({ consumption: 1.5, rate: 100, freight: 20, dutyPct: 10, wastagePct: 2 }).toFixed(6))).toBe(201.96)
    expect(lineAmount({ consumption: '', rate: 'x' })).toBe(0)
  })

  test('with a quantity it also says what the order comes to, at the price as shown', () => {
    const r = computeCostSheet({ fabric: [{ consumption: 1, rate: 100 }], labour: { making: 50 }, overheadPct: 5, rejectionPct: 3, marginPct: 20, tradioPct: 10, discountPct: 10, qty: 1000 })
    expect([r.price, r.negotiated, r.orderValue, r.negotiatedValue]).toEqual([209.67, 188.7, 209670, 188700])
  })

  test('seeding from a BOM', () => {
    const plan = { sizes: ['S', 'M', 'L', 'XL', 'XXL'], ratio: [1, 2, 3, 2, 1] }
    const seeded = linesFromBom([
      { section: 'fabric', item: 'Fleece', unit: 'kg', consumption: 0.72, perSize: [0.63, 0.675, 0.72, 0.765, 0.8325], wastagePct: 7, rate: 410 },
      { section: 'other', item: 'Sample', unit: 'pc', consumption: 1, rate: 99 },
    ], l => weightedConsumption(plan, l))
    expect(seeded.fabric[0]).toMatchObject({ name: 'Fleece', consumption: 0.7225, wastagePct: 7, rate: 410 })
    expect(JSON.stringify(seeded)).not.toContain('Sample')
  })
})
