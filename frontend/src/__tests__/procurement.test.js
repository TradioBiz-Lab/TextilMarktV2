import { describe, test, expect } from 'vitest'
import cases from '../../../backend/tests/fixtures/poMath.cases.json'
import { computeTotals, computeLine, moqWarnings } from '../lib/poCalc.js'
import { isValidGstin, gstinCheckChar, stateCodeFromGstin, taxModeFor, stateName, normalizeGstin, GST_STATE_OPTIONS } from '../lib/gst.js'
import { isSystemDoc, SYSTEM_DOC_TYPES, DOC_ICONS } from '../constants.js'
import { rupees, rupeesWhole, fmtQty, fmtDay, materialsToBuy, stagePoSummary, poStatusLabel, reconcileLines, supplierForLines } from '../lib/procurement.js'

describe('PO sums match the server on the shared cases', () => {
  // The same file the backend suite runs (backend/tests/fixtures/poMath.cases.json): if the browser and
  // the server ever disagree, one of these two suites fails.
  for (const c of cases) {
    test(c.name, () => expect(computeTotals(c.lines, c.mode)).toEqual(c.expected))
  }

  test('a line on its own is worked the same as inside a PO', () => {
    const l = { qty: 4, rate: 125.75, taxPct: 5, discountPct: 2 }
    expect(Math.round(computeTotals([l], 'intra').lines[0].lineTotal * 100)).toBe(computeLine(l, 'intra').total)
  })

  test('half-typed numbers do not break the total', () => {
    expect(computeTotals([{ qty: '', rate: 'x', taxPct: undefined }], 'intra').totals.grandTotal).toBe(0)
    expect(computeTotals([{ qty: '10', rate: '2.5', taxPct: '5' }], 'inter').totals.grandTotal).toBe(26)
  })
})

describe('minimum order warnings', () => {
  test('warns only for a line below its catalog item\'s minimum', () => {
    const items = [{ id: 'i1', moq: 300, unit: 'm' }, { id: 'i2', moq: 0, unit: 'pcs' }]
    const w = moqWarnings([{ itemId: 'i1', qty: 130, unit: 'm' }, { itemId: 'i1', qty: 300 }, { itemId: 'i2', qty: 1 }, { qty: 1 }], items)
    expect(w).toHaveLength(1)
    expect(w[0].line).toBe(0)
    expect(w[0].message).toMatch(/Line 1 is below the supplier's minimum order of 300 m/)
  })
})

describe('GSTIN', () => {
  test('accepts a real one and refuses a wrong check character', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true)
    expect(isValidGstin(' 27aapfu0939f1zv ')).toBe(true)
    expect(isValidGstin('27AAPFU0939F1ZX')).toBe(false)
    expect(isValidGstin('')).toBe(false)
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V')
    expect(normalizeGstin(' 27aapfu 0939f1zv ')).toBe('27AAPFU0939F1ZV')
  })

  test('gives the state, and decides the tax between two states', () => {
    expect(stateCodeFromGstin('27AAPFU0939F1ZV')).toBe('27')
    expect(stateName('27')).toBe('Maharashtra')
    expect(taxModeFor('33', '33')).toBe('intra')
    expect(taxModeFor('33', '27')).toBe('inter')
    expect(taxModeFor('', '33')).toBe('unknown')
  })

  test('the state list is sorted by name for a select', () => {
    const names = GST_STATE_OPTIONS.map(s => s.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    expect(GST_STATE_OPTIONS.find(s => s.code === '33').name).toBe('Tamil Nadu')
  })
})

describe('formatting', () => {
  test('rupees in the Indian way', () => {
    expect(rupees(123456.5)).toBe('₹1,23,456.50')
    expect(rupeesWhole(2400000.4)).toBe('₹24,00,000')
    expect(rupees(null)).toBe('₹0.00')
    expect(fmtQty(1250.5)).toBe('1,250.5')
  })

  test('a day', () => {
    expect(fmtDay('2026-11-05')).toBe('05 Nov 2026')
    expect(fmtDay(null)).toBe('-')
    expect(fmtDay('nonsense')).toBe('-')
  })

  test('status labels', () => {
    expect(poStatusLabel('partially_received')).toBe('Part received')
    expect(poStatusLabel('closed')).toBe('Received')
    expect(poStatusLabel('mystery')).toBe('mystery')
  })
})

describe('materials still to buy', () => {
  const orders = [
    { id: 'ORD-1', product: 'Sweatshirt', buyerCompany: 'Zara', assignments: [{ mid: 'm1', stages: [
      { name: 'Fabric Inhouse', materials: [
        { name: 'Fleece', requiredQty: 1200, orderedQty: 0, unit: 'kg', status: 'pending', supplier: 'Mill' },
        { name: 'Rib', requiredQty: 150, orderedQty: 100, unit: 'kg', status: 'ordered' },
        { name: 'Thread', requiredQty: 50, orderedQty: 50, unit: 'cones', status: 'ordered' },
        { name: 'Zip', requiredQty: 10, orderedQty: 0, unit: 'pcs', status: 'received' },
      ] },
    ] }] },
    { id: 'ORD-2', product: 'Tee', assignments: [{ mid: 'someone-else', stages: [{ name: 'X', materials: [{ name: 'Secret', requiredQty: 5, orderedQty: 0, status: 'pending' }] }] }] },
    { id: 'ORD-3', product: 'Cap', assignments: [{ mid: 'm1', stages: [{ name: 'Cutting', materials: [] }] }] },
  ]

  test('lists what is not yet fully ordered or received, for this factory only', () => {
    const r = materialsToBuy(orders, 'm1')
    expect(r).toHaveLength(1)
    expect(r[0].orderId).toBe('ORD-1')
    expect(r[0].lines.map(l => [l.name, l.remaining])).toEqual([['Fleece', 1200], ['Rib', 50]])
    expect(r[0].lines[0].ref).toEqual({ orderId: 'ORD-1', stageIndex: 0, materialIndex: 0, name: 'Fleece' })
  })

  test('a stage\'s purchasing summary counts lines on POs and the ones that arrived', () => {
    expect(stagePoSummary({ materials: [{ poId: 'PO-1', status: 'received' }, { poId: 'PO-1', status: 'ordered' }, { poId: 'PO-2', status: 'ordered' }, { name: 'free text' }] }))
      .toEqual({ lines: 3, received: 1, pos: ['PO-1', 'PO-2'] })
    expect(stagePoSummary({ materials: [{ name: 'x' }] })).toBeNull()
    expect(stagePoSummary({})).toBeNull()
  })
})

describe('carrying a PO\'s lines across a change of supplier', () => {
  const catalog = [
    { id: 'i1', name: 'Elastic tape 25 mm', hsnCode: '5806', defaultRate: 12.5, taxPct: 12, isActive: true },
    { id: 'i2', name: 'Retired zip', hsnCode: '9607', defaultRate: 8, taxPct: 12, isActive: false },
  ]
  const line = (o = {}) => ({ description: '', itemId: null, hsnCode: '', rate: '', taxPct: '5', ...o })

  test('a blank, unlinked line is matched by name and takes the catalog rate, HSN and GST', () => {
    const [l] = reconcileLines([line({ description: ' elastic TAPE 25 mm ' })], catalog)
    expect(l).toMatchObject({ itemId: 'i1', hsnCode: '5806', rate: '12.5', taxPct: '12' })
  })

  test('numbers the person already typed are never overwritten', () => {
    expect(reconcileLines([line({ description: 'Elastic tape 25 mm', rate: '15' })], catalog)[0]).toMatchObject({ itemId: null, rate: '15' })
    expect(reconcileLines([line({ description: 'Elastic tape 25 mm', hsnCode: '1111', taxPct: '18' })], catalog)[0]).toMatchObject({ hsnCode: '1111', taxPct: '18', rate: '12.5' })
  })

  test('a tie to an item this supplier does not stock is dropped, the words and numbers stay', () => {
    const [l] = reconcileLines([line({ description: 'Single jersey', itemId: 'someone-elses', rate: '200', hsnCode: '6006' })], catalog)
    expect(l).toMatchObject({ itemId: null, description: 'Single jersey', rate: '200', hsnCode: '6006' })
  })

  test('a tie to an item since retired is kept, and a retired item is never matched by name', () => {
    expect(reconcileLines([line({ description: 'Retired zip', itemId: 'i2', rate: '8' })], catalog)[0].itemId).toBe('i2')
    expect(reconcileLines([line({ description: 'Retired zip' })], catalog)[0].itemId).toBeNull()
  })

  test('nothing matches against an empty catalog, and the input is not changed', () => {
    const input = [line({ description: 'Elastic tape 25 mm' })]
    expect(reconcileLines(input, [])).toEqual(input)
    reconcileLines(input, catalog)
    expect(input[0].itemId).toBeNull()
  })

  test('the supplier to start with is the one every named material was planned with', () => {
    expect(supplierForLines([{ supplierId: 's1' }, { supplierId: 's1' }, { supplierId: null }])).toBe('s1')
    expect(supplierForLines([{ supplierId: 's1' }, { supplierId: 's2' }])).toBeNull()
    expect(supplierForLines([{ supplierId: null }, {}])).toBeNull()
    expect(supplierForLines([])).toBeNull()
  })
})

describe('documents the server makes itself', () => {
  test('a sent PO\'s PDF is a system document: named, with an icon, never edited or deleted by hand', () => {
    expect(isSystemDoc({ type: 'supplier_po' })).toBe(true)
    expect(isSystemDoc({ type: 'compliance_cert' })).toBe(false)
    expect(isSystemDoc(null)).toBe(false)
    expect(SYSTEM_DOC_TYPES.find(t => t.v === 'supplier_po').l).toBe('Supplier PO')
    expect(DOC_ICONS.supplier_po).toBeTruthy()
  })
})
