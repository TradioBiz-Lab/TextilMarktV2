import { describe, test, expect } from 'vitest'
import {
  categoryLabel, ledgerLabel, signedQty, grnStateLabel, acceptedOf, blankLine, formFromGrn, payloadFromForm, formKey, readiness, lineHint, suggestItems, issueProblems, round3, adoptIds, isBlankLine, itemKey, stockMatch, lossNote, returnProblems, jobworkStateLabel, PROCESSES,
} from '../lib/inventory.js'

const grn = (over = {}) => ({
  id: 'g1', status: 'draft', poId: 'PO-TPR-2627-0001', supplierId: 's1', supplierName: 'Coimbatore Knit Fabrics', challanNo: '', challanDate: null, vehicleNo: '', receivedOn: '2026-10-12', note: '',
  lines: [{ lineId: 'l1', poLineId: 'p1', description: 'Polar fleece 300 GSM - BLACK', itemId: null, unit: 'kg', orderedQty: 100, qty: 60, rejectedQty: 0, rejectReason: '', rate: 410, lot: '', note: '' }], ...over,
})

describe('labels', () => {
  test('a kind of item, a movement and a note\'s state read as words', () => {
    expect(categoryLabel('trims')).toBe('Trims')
    expect(categoryLabel('nonsense')).toBe('Other')
    expect(ledgerLabel('receipt')).toBe('Received')
    expect(ledgerLabel('adjustment')).toBe('Count correction')
    expect(ledgerLabel('mystery')).toBe('mystery')
    expect(grnStateLabel('posted')).toBe('Posted')
  })

  test('a movement shows its sign and unit', () => {
    expect(signedQty(100, 'kg')).toBe('+100 kg')
    expect(signedQty(-30.5, 'm')).toBe('-30.5 m')
    expect(signedQty(0, 'kg')).toBe('0 kg')
    expect(signedQty(1500, 'pcs', n => n.toLocaleString('en-IN'))).toBe('+1,500 pcs')
  })

  test('what went into stock is what arrived less what was turned away, never below nothing', () => {
    expect(acceptedOf({ qty: '100', rejectedQty: '10' })).toBe(90)
    expect(acceptedOf({ qty: 5, rejectedQty: 9 })).toBe(0)
    expect(acceptedOf({ qty: '', rejectedQty: '' })).toBe(0)
    expect(round3(0.1 + 0.2)).toBe(0.3)
  })
})

describe('the receiving form', () => {
  test('a server note opens as strings the person can edit, with blanks for nothing', () => {
    const f = formFromGrn(grn())
    expect(f.lines[0]).toMatchObject({ lineId: 'l1', poLineId: 'p1', qty: '60', rejectedQty: '', rate: '410', unit: 'kg', orderedQty: 100 })
    expect(f.lines[0].key).toBeTruthy()
    expect(f.poId).toBe('PO-TPR-2627-0001')
  })

  test('what is sent is numbers, trimmed, with blank rows left out and the PO not repeated', () => {
    const f = formFromGrn(grn())
    f.challanNo = '  CH-4471 '; f.vehicleNo = ' tn39 '; f.lines[0].rejectedQty = '5'; f.lines[0].rejectReason = ' shade band '
    f.lines.push(blankLine())
    const body = payloadFromForm(f)
    expect(body.poId).toBeUndefined()
    expect(body).toMatchObject({ challanNo: 'CH-4471', vehicleNo: 'tn39', challanDate: null })
    expect(body.lines).toEqual([{ lineId: 'l1', poLineId: 'p1', description: 'Polar fleece 300 GSM - BLACK', unit: 'kg', qty: 60, rejectedQty: 5, rejectReason: 'shade band', rate: 410, lot: '', note: '' }])
    expect(typeof body.lines[0].qty).toBe('number')
  })

  test('the save key moves when something is typed, and not when a blank row is added', () => {
    const f = formFromGrn(grn())
    const before = formKey(f)
    expect(formKey({ ...f, lines: [...f.lines, blankLine()] })).toBe(before)
    expect(formKey({ ...f, note: 'lorry 2' })).not.toBe(before)
    expect(formKey({ ...f, lines: [{ ...f.lines[0], qty: '61' }] })).not.toBe(before)
  })

  test('a note is ready when something arrived, has words for it, and no more turned away than came', () => {
    const f = formFromGrn(grn())
    expect(readiness(f)).toEqual({ ok: true, count: 1 })
    expect(readiness({ ...f, lines: [{ ...f.lines[0], qty: '' }] }).ok).toBe(false)
    expect(readiness({ ...f, lines: [{ ...f.lines[0], description: ' ' }] }).reason).toMatch(/Say what the goods are/)
    expect(readiness({ ...f, lines: [{ ...f.lines[0], rejectedQty: '70' }] }).reason).toMatch(/more was turned away/)
    expect(readiness({ ...f, lines: [] }).ok).toBe(false)
  })
})

describe('what a quantity means against the order', () => {
  const po = { ordered: 100, received: 40, outstanding: 60, unit: 'kg' }
  const at = (qty, extra = {}) => lineHint({ qty, rejectedQty: '', unit: 'kg', ...extra }, po)

  test('short, complete, a little over and too far over', () => {
    expect(at('')).toBeNull()
    expect(at('20')).toEqual({ tone: 'warn', text: '40 kg still to come after this' })
    expect(at('60')).toEqual({ tone: 'good', text: 'Completes this line of the order' })
    expect(at('63')).toEqual({ tone: 'info', text: '3 kg more than ordered' })
    expect(at('80')).toMatchObject({ tone: 'bad' })
    expect(at('80').text).toMatch(/more than 10% over, so it will be refused/)
  })

  test('what was turned away does not count as received', () => {
    expect(at('60', { rejectedQty: '10' })).toEqual({ tone: 'warn', text: '10 kg still to come after this' })
  })

  test('with no purchase order there is nothing to compare with', () => {
    expect(lineHint({ qty: '5', unit: 'kg' }, null)).toBeNull()
  })
})

describe('finding stock items as a name is typed', () => {
  const items = [{ id: 'a', name: 'Polar fleece 300 GSM - BLACK' }, { id: 'b', name: 'Black polybag' }, { id: 'c', name: 'Zip', isActive: false }, { id: 'd', name: 'Blackout lining' }]
  test('those holding the text, those starting with it first, archived ones never', () => {
    expect(suggestItems(items, 'black').map(i => i.id)).toEqual(['b', 'd', 'a'])
    expect(suggestItems(items, 'zip')).toEqual([])
    expect(suggestItems(items, '  ')).toEqual([])
    expect(suggestItems(items, 'black', 1)).toHaveLength(1)
  })
})

describe('checking an issue before it is sent', () => {
  const items = [{ id: 'a', name: 'Rib', unit: 'kg', onHand: 60 }]
  test('says which line asks for more than the store holds, or for nothing', () => {
    expect(issueProblems([{ itemId: 'a', qty: '20' }, { itemId: 'a', qty: '61' }, { itemId: 'a', qty: '0' }, { itemId: 'a', qty: '' }, { itemId: '', qty: '5' }], items)).toEqual([null, 'Only 60 kg in the store', 'The quantity must be more than zero', null, null])
  })
  test('a return is not limited by the store', () => {
    expect(issueProblems([{ itemId: 'a', qty: '500' }], items, 'return')).toEqual([null])
  })
})

describe('after the server saves a draft', () => {
  test('its ids for the new lines go onto the lines that were sent, skipping blank rows', () => {
    const f = formFromGrn(grn({ poId: null, lines: [] }))
    f.lines = [blankLine({ description: 'Elastic', qty: '5', unit: 'pcs' }), blankLine(), blankLine({ description: 'Zip', qty: '3', unit: 'pcs' })]
    const next = adoptIds(f, [{ lineId: 'a', itemId: 'i1', unit: 'm' }, { lineId: 'b', itemId: null, unit: 'pcs' }])
    expect(next.lines.map(l => [l.description, l.lineId, l.itemId, l.unit])).toEqual([['Elastic', 'a', 'i1', 'm'], ['', '', '', 'pcs'], ['Zip', 'b', '', 'pcs']])
    expect(isBlankLine(next.lines[1])).toBe(true)
  })

  test('a note with no PO sends its supplier choice, one with a PO does not', () => {
    const adhoc = formFromGrn(grn({ poId: null, supplierId: 's9' }))
    expect(payloadFromForm(adhoc).supplierId).toBe('s9')
    expect(payloadFromForm(formFromGrn(grn())).supplierId).toBeUndefined()
  })
})

describe('which stock item a line goes into', () => {
  const items = [
    { id: 'a', name: 'Brushed fleece 280 GSM', unit: 'kg' },
    { id: 'b', name: 'Polar fleece 300 GSM - BLACK', unit: 'kg' },
    { id: 'c', name: 'Polar fleece 300 GSM', unit: 'm' },
    { id: 'd', name: 'Zip', unit: 'pcs' },
    { id: 'e', name: 'Old item', unit: 'kg', isActive: false },
  ]
  test('the key is the server\'s: name and unit, ignoring case and spacing', () => {
    expect(itemKey('Polar Fleece  300 GSM', ' KG ')).toBe('polar fleece 300 gsm|kg')
  })

  test('the same name and unit is the item; no guessing between colours', () => {
    expect(stockMatch(items, '  polar fleece 300 gsm - black ', 'KG').exact.id).toBe('b')
    const navy = stockMatch(items, 'Polar fleece 300 GSM - NAVY', 'kg')
    expect(navy.exact).toBeNull()
    expect(navy.near).toEqual([])                                   // BLACK is not NAVY, and the generic one is in metres
  })

  test('an item whose name starts the description is offered to be confirmed, in the same unit only', () => {
    const r = stockMatch(items, 'Brushed fleece 280 GSM, 72 in, 80/20 CVC', 'kg')
    expect(r.exact).toBeNull()
    expect(r.near.map(i => i.id)).toEqual(['a'])
    expect(stockMatch(items, 'Brushed fleece 280 GSM, 72 in', 'm').near).toEqual([])
    expect(stockMatch(items, 'Polar fleece', 'kg').near.map(i => i.id)).toEqual(['b'])       // a shorter description that starts the name
  })

  test('archived items and very short words are never offered', () => {
    expect(stockMatch(items, 'Old item with a longer description', 'kg').near).toEqual([])
    expect(stockMatch(items, 'Zi', 'pcs')).toEqual({ exact: null, near: [] })
  })
})

describe('job work', () => {
  test('what came back is told against what went: nothing lost, a loss with its share, or more than went', () => {
    expect(lossNote(100, 'kg', [{ qty: 92, unit: 'kg' }])).toBe('92 kg back for 100 kg: 8 kg (8%) lost in the process')
    expect(lossNote(100, 'kg', [{ qty: 60 }, { qty: 40, unit: 'KG' }])).toBe('100 kg back for 100 kg: nothing lost')
    expect(lossNote(100, 'kg', [{ qty: 104 }])).toMatch(/4 kg more than went/)
    expect(lossNote(100, 'kg', [{ qty: 90, unit: 'm' }])).toBeNull()                       // different units cannot be compared
    expect(lossNote(0, 'kg', [{ qty: 5 }])).toBeNull()
    expect(lossNote(100, 'kg', [{ qty: '' }])).toBeNull()
  })

  test('a delivery is checked before it is sent: how much it accounts for, that something came back, and no more than is out', () => {
    const job = { lines: [{ lineId: 'a', outstanding: 40, unit: 'kg' }, { lineId: 'b', outstanding: 10, unit: 'kg' }] }
    const out = (o = {}) => ({ itemId: '', description: 'Navy', unit: 'kg', qty: '5', ...o })
    expect(returnProblems([
      { lineId: 'a', inputQty: '41', outputs: [out()] },
      { lineId: 'b', inputQty: '', outputs: [] },
      { lineId: 'a', inputQty: '10', outputs: [] },
      { lineId: 'a', inputQty: '10', outputs: [out({ description: '', itemId: '' })] },
      { lineId: 'a', inputQty: '10', outputs: [out({ description: '', itemId: 'i1' })] },
      { lineId: 'a', inputQty: '0', outputs: [out()] },
      { lineId: 'zzz', inputQty: '1', outputs: [] },
    ], job)).toEqual(['Only 40 kg is still with the job worker', null, 'Say what came back for it', 'Say what came back', null, 'Say how much of it this delivery accounts for', null])
  })

  test('the states and the usual work read as words', () => {
    expect(jobworkStateLabel('partially_returned')).toBe('Part back')
    expect(jobworkStateLabel('nope')).toBe('nope')
    expect(PROCESSES).toContain('Dyeing')
  })
})
