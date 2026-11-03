import { describe, test, expect } from 'vitest'
import { requestTitle, requestWhen, REQUEST_STATUS, npdMissing } from '../styleRequests.js'
import { capsFor } from '../caps.js'

describe('how a request reads', () => {
  test('a replen names the style and the quantity', () => {
    expect(requestTitle({ kind: 'replen', product: 'Midi Dress', styleNumber: 'FYL-4002', quantity: 1200 })).toBe('Replen of Midi Dress (FYL-4002), 1,200 pcs')
    expect(requestTitle({ kind: 'replen', product: 'Skirt', styleNumber: '', quantity: 50 })).toBe('Replen of Skirt, 50 pcs')
  })

  test('a replen of several styles names them; a quantity left out is not shown', () => {
    expect(requestTitle({ kind: 'replen', items: [{ product: 'Dress', styleNumber: 'FYL-4002' }, { product: 'Skirt', styleNumber: '' }] })).toBe('Replen of 2 styles: FYL-4002, Skirt')
    expect(requestTitle({ kind: 'replen', items: [{ product: 'Dress', styleNumber: 'FYL-4002' }] })).toBe('Replen of Dress (FYL-4002)')
  })

  test('new product development names the style, or how many', () => {
    expect(requestTitle({ kind: 'npd', items: [{ product: 'Wrap Dress', styleNumber: 'FYL-5001' }] })).toBe('New product: Wrap Dress (FYL-5001)')
    expect(requestTitle({ kind: 'npd', items: [{ product: 'A' }, { product: 'B' }, { product: 'C' }] })).toBe('New product development: 3 styles')
    expect(requestTitle({ kind: 'npd', items: [{ product: 'New product (Olive, Black)', styleNumber: 'FYL-5001' }] })).toBe('New product (Olive, Black) (FYL-5001)')
  })

  test('a sheet names the file and how many styles are ready', () => {
    expect(requestTitle({ kind: 'import', filename: 'replen.xlsx', summary: { ok: 7 } })).toBe('replen.xlsx, 7 styles')
    expect(requestTitle({ kind: 'import', filename: 'replen.xlsx', summary: { ok: 1 } })).toBe('replen.xlsx, 1 style')
    expect(requestTitle({ kind: 'import', filename: '', summary: null })).toBe('Style sheet')
  })

  test('every status has a label and colours; an empty time is blank', () => {
    for (const k of ['pending', 'approved', 'declined', 'cancelled']) expect(REQUEST_STATUS[k].label).toBeTruthy()
    expect(requestWhen(null)).toBe('')
    expect(requestWhen('2026-11-02T18:10:00Z')).toMatch(/Nov/)
  })
})

describe('who sees the review queue', () => {
  test('only a master admin; other admins, customers and factories do not', () => {
    expect(capsFor({ role: 'admin', adminType: 'master' }).seeStyleRequests).toBe(true)
    expect(capsFor({ role: 'admin', adminType: 'user' }).seeStyleRequests).toBe(false)
    expect(capsFor({ role: 'buyer' }).seeStyleRequests).toBe(false)
    expect(capsFor({ role: 'manufacturer' }).seeStyleRequests).toBe(false)
  })
})

describe('a new style on the New product development form', () => {
  const ok = { styleNumber: 'FYL-5001', colours: ['Olive'], quantity: '', delivery: '2099-01-20', techPackLink: 'https://drive.example.com/tp' }
  test('is ready with colours, a delivery date and a tech pack link; the quantity may wait', () => {
    expect(npdMissing(ok)).toBe('')
    expect(npdMissing({ ...ok, quantity: '800' })).toBe('')
  })
  test('says what it still needs', () => {
    expect(npdMissing({ styleNumber: ' ', colours: [], quantity: '', delivery: '', techPackLink: ' ' })).toBe('needs your style no., a colour, the expected delivery date, the tech pack link')
    expect(npdMissing({ ...ok, quantity: '2.5' })).toBe('the quantity has to be a whole number')
    expect(npdMissing({ ...ok, delivery: '2026-01-01' }, '2026-11-03')).toBe('has an expected delivery date in the past')
  })
})
