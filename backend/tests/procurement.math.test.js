// The pure pieces of procurement: GST rules, PO arithmetic, amounts in words, the financial year.
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { isValidGstin, normalizeGstin, gstinCheckChar, stateCodeFromGstin, taxModeFor, isValidPan, stateName } from '../src/lib/gst.js'
import { cleanLine, computeLine, computeTotals, moqWarnings } from '../src/lib/poMath.js'
import { amountInWords, integerInWords } from '../src/lib/words.js'
import { fiscalYearCode } from '../src/lib/fiscalYear.js'

describe('GSTIN', () => {
  test('accepts a real GSTIN and works out its state', () => {
    assert.equal(isValidGstin('27AAPFU0939F1ZV'), true)
    assert.equal(stateCodeFromGstin('27AAPFU0939F1ZV'), '27')
    assert.equal(stateName('27'), 'Maharashtra')
  })

  test('is forgiving about case and spaces, strict about everything else', () => {
    assert.equal(isValidGstin(' 27aapfu0939f1zv '), true)
    assert.equal(normalizeGstin(' 27aapfu 0939f1zv '), '27AAPFU0939F1ZV')
    assert.equal(isValidGstin('27AAPFU0939F1ZX'), false)    // wrong check character
    assert.equal(isValidGstin('27AAPFU0939F1Z'), false)     // too short
    assert.equal(isValidGstin('99ZZZZZ9999Z1ZZ'), false)
    assert.equal(isValidGstin(''), false)
    assert.equal(isValidGstin(null), false)
  })

  test('an unknown state code is refused even when the checksum would pass', () => {
    const first14 = '25AAPFU0939F1Z'                         // 25 is not a state code any more
    assert.equal(isValidGstin(first14 + gstinCheckChar(first14)), false)
  })

  test('the check character is what makes the real one valid', () => {
    assert.equal(gstinCheckChar('27AAPFU0939F1Z'), 'V')
  })

  test('PAN has its own shape', () => {
    assert.equal(isValidPan('abcde1234f'), true)
    assert.equal(isValidPan('1234567890'), false)
  })
})

describe('which GST applies', () => {
  test('same state is CGST and SGST, another state is IGST', () => {
    assert.equal(taxModeFor('33', '33'), 'intra')
    assert.equal(taxModeFor('33', '27'), 'inter')
  })

  test('without both states the split is not guessed', () => {
    assert.equal(taxModeFor('', '33'), 'unknown')
    assert.equal(taxModeFor('33', undefined), 'unknown')
    assert.equal(taxModeFor('00', '33'), 'unknown')
  })
})

describe('a line', () => {
  const ok = raw => { const r = cleanLine(raw); assert.equal(r.ok, true, r.error); return r.line }
  const bad = raw => { const r = cleanLine(raw, 2); assert.equal(r.ok, false); return r.error }

  test('is cleaned and numbered in its errors', () => {
    const l = ok({ description: '  Single jersey 180 GSM  ', qty: '500', rate: '210.5', taxPct: '5', hsnCode: '6006 31', unit: 'kg' })
    assert.deepEqual([l.description, l.qty, l.rate, l.taxPct, l.hsnCode, l.unit], ['Single jersey 180 GSM', 500, 210.5, 5, '600631', 'kg'])
    assert.match(bad({ description: '', qty: 1 }), /^Line 2: /)
  })

  test('refuses what cannot be priced', () => {
    assert.match(bad({ description: 'x', qty: 0 }), /quantity/)
    assert.match(bad({ description: 'x', qty: -3 }), /quantity/)
    assert.match(bad({ description: 'x', qty: 1, rate: -1 }), /rate/)
    assert.match(bad({ description: 'x', qty: 1, discountPct: 101 }), /discount/)
    assert.match(bad({ description: 'x', qty: 1, taxPct: 41 }), /GST/)
    assert.match(bad({ description: 'x', qty: 1, hsnCode: '12' }), /HSN/)
    assert.match(bad({ description: 'x', qty: 1, expectedDate: '2026-13-45' }), /date/)
    assert.match(bad({ description: 'x', qty: 1, itemId: 'nope' }), /catalog/)
    assert.match(bad({ description: 'x', qty: 1, materialRef: { orderId: '', stageIndex: 0, materialIndex: 0 } }), /material/)
    assert.match(bad(null), /not valid/)
  })

  test('defaults a missing unit and carries a material link through', () => {
    const l = ok({ description: 'Zip', qty: 100, materialRef: { orderId: 'ZAR-1', stageIndex: 2, materialIndex: 0, name: 'Zip' } })
    assert.equal(l.unit, 'pcs')
    assert.deepEqual(l.materialRef, { orderId: 'ZAR-1', stageIndex: 2, materialIndex: 0, name: 'Zip' })
  })
})

describe('PO totals', () => {
  const line = (qty, rate, taxPct, discountPct = 0) => ({ qty, rate, taxPct, discountPct })

  test('inside one state: CGST and SGST each half the rate', () => {
    const r = computeTotals([line(100, 200, 12)], 'intra')
    assert.equal(r.lines[0].amount, 20000)
    assert.equal(r.totals.cgst, 1200)
    assert.equal(r.totals.sgst, 1200)
    assert.equal(r.totals.igst, 0)
    assert.equal(r.totals.taxTotal, 2400)
    assert.equal(r.totals.grandTotal, 22400)
  })

  test('between states: IGST is the whole rate', () => {
    const r = computeTotals([line(100, 200, 12)], 'inter')
    assert.deepEqual([r.totals.cgst, r.totals.sgst, r.totals.igst], [0, 0, 2400])
    assert.equal(r.totals.grandTotal, 22400)
  })

  test('with a state missing there is one combined GST figure', () => {
    const r = computeTotals([line(100, 200, 12)], 'unknown')
    assert.deepEqual([r.totals.cgst, r.totals.sgst, r.totals.igst, r.totals.gst], [0, 0, 0, 2400])
  })

  test('a discount comes off before tax', () => {
    const r = computeTotals([line(10, 100, 18, 10)], 'inter')
    assert.equal(r.totals.subtotal, 1000)
    assert.equal(r.totals.discount, 100)
    assert.equal(r.totals.taxable, 900)
    assert.equal(r.totals.igst, 162)
    assert.equal(r.totals.grandTotal, 1062)
  })

  test('the grand total is rounded to the rupee and the difference is shown', () => {
    const r = computeTotals([line(3, 33.33, 5)], 'inter')   // 99.99 + 5.00 tax = 104.99
    assert.equal(r.totals.taxTotal, 5)
    assert.equal(r.totals.roundOff, 0.01)
    assert.equal(r.totals.grandTotal, 105)
  })

  test('tax is grouped by rate across lines', () => {
    const r = computeTotals([line(10, 100, 5), line(10, 100, 12), line(5, 100, 5)], 'intra')
    assert.deepEqual(r.totals.byRate.map(g => [g.rate, g.taxable, g.cgst]), [[5, 1500, 37.5], [12, 1000, 60]])
  })

  test('money never drifts through floating point', () => {
    // 0.1 + 0.2 style trouble: 7 lines of 0.1 x 3 must add up to exactly 2.10
    const r = computeTotals(Array.from({ length: 7 }, () => line(3, 0.1, 0)), 'unknown')
    assert.equal(r.totals.taxable, 2.1)
  })

  test('a line is computed the same on its own as inside a PO', () => {
    const c = computeLine(line(4, 125.75, 5, 2), 'intra')
    const r = computeTotals([line(4, 125.75, 5, 2)], 'intra')
    assert.equal(Math.round(r.lines[0].lineTotal * 100), c.total)
  })

  test('a mode it does not know falls back to the combined figure', () => {
    assert.equal(computeTotals([line(1, 100, 5)], 'weird').taxMode, 'unknown')
  })
})

describe('minimum order quantity', () => {
  test('warns for a line below the catalog item minimum, and only then', () => {
    const items = new Map([['i1', { moq: 300, unit: 'm' }], ['i2', { moq: 0, unit: 'pcs' }]])
    const lines = [{ itemId: 'i1', qty: 130, unit: 'm' }, { itemId: 'i1', qty: 300, unit: 'm' }, { itemId: 'i2', qty: 5, unit: 'pcs' }, { qty: 1, unit: 'pcs' }]
    const w = moqWarnings(lines, items)
    assert.equal(w.length, 1)
    assert.deepEqual([w[0].line, w[0].code, w[0].moq], [0, 'BELOW_MOQ', 300])
    assert.match(w[0].message, /Line 1 is below the supplier's minimum order of 300 m/)
  })
})

describe('amount in words', () => {
  test('uses lakh and crore', () => {
    assert.equal(integerInWords(0), 'Zero')
    assert.equal(integerInWords(7), 'Seven')
    assert.equal(integerInWords(21), 'Twenty One')
    assert.equal(integerInWords(100), 'One Hundred')
    assert.equal(integerInWords(105), 'One Hundred and Five')
    assert.equal(integerInWords(1000), 'One Thousand')
    assert.equal(integerInWords(123456), 'One Lakh Twenty Three Thousand Four Hundred and Fifty Six')
    assert.equal(integerInWords(12345678), 'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred and Seventy Eight')
    assert.equal(integerInWords(100000000), 'Ten Crore')
  })

  test('reads rupees and paise', () => {
    assert.equal(amountInWords(22400), 'Twenty Two Thousand Four Hundred Rupees Only')
    assert.equal(amountInWords(105.5), 'One Hundred and Five Rupees and Fifty Paise Only')
    assert.equal(amountInWords(0.05), 'Zero Rupees and Five Paise Only')
  })

  test('refuses a fraction where whole rupees were promised', () => {
    assert.throws(() => integerInWords(1.5), RangeError)
    assert.throws(() => integerInWords(-1), RangeError)
  })
})

describe('financial year code', () => {
  test('April starts the year', () => {
    assert.equal(fiscalYearCode(new Date('2026-04-01T00:00:00+05:30')), '2627')
    assert.equal(fiscalYearCode(new Date('2026-10-12T10:00:00+05:30')), '2627')
    assert.equal(fiscalYearCode(new Date('2027-03-31T23:00:00+05:30')), '2627')
    assert.equal(fiscalYearCode(new Date('2027-04-01T00:30:00+05:30')), '2728')
  })

  test('is read in India time, not UTC', () => {
    // 21:00 UTC on 31 March is already 2:30am IST on 1 April
    assert.equal(fiscalYearCode(new Date('2027-03-31T21:00:00Z')), '2728')
    assert.equal(fiscalYearCode(new Date('2027-03-31T18:00:00Z')), '2627')
  })
})

// The browser works the same sums while a PO is typed (frontend/src/lib/poCalc.js). Both sides are held
// to these shared cases, so what a user sees before saving is what the server will save.
// If the rules change on purpose, regenerate the file and run both suites.
describe('shared fixtures with the browser', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/poMath.cases.json', import.meta.url), 'utf8'))
  for (const c of cases) {
    test(c.name, () => assert.deepEqual(computeTotals(c.lines, c.mode), c.expected))
  }
})
