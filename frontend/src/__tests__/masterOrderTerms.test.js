import { describe, test, expect } from 'vitest'
import { moDetailsForm, moDetailsPayload, fmtMoney } from '../constants.js'

describe('master order details form', () => {
  const mo = { poNumber: 'PO-1', poDate: '2027-01-05', shipBy: null, notes: '', currency: 'USD', price: 1250.5, paymentTerms: '', incoterm: 'FOB', shipTo: '' }
  test('reads every field as a string and sends only what changed', () => {
    const form = moDetailsForm(mo)
    expect(form.price).toBe('1250.5')
    expect(form.shipBy).toBe('')
    expect(moDetailsPayload(form, moDetailsForm(mo))).toEqual({})
    expect(moDetailsPayload({ ...form, price: ' ', paymentTerms: ' 30 days ' }, moDetailsForm(mo))).toEqual({ price: null, paymentTerms: '30 days' })
  })
  test('on create, every field goes, blanks as null for dates and price', () => {
    const out = moDetailsPayload(moDetailsForm({}))
    expect(out.poDate).toBe(null)
    expect(out.price).toBe(null)
    expect(out.incoterm).toBe('')
  })
})

describe('fmtMoney', () => {
  test('groups rupees the Indian way and other currencies the international way', () => {
    expect(fmtMoney(125000, 'INR')).toBe('INR 1,25,000')
    expect(fmtMoney(125000.5, 'USD')).toBe('USD 125,000.5')
    expect(fmtMoney(null, 'USD')).toBe('')
  })
})
