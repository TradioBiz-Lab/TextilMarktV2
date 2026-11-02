import { describe, test, expect } from 'vitest'
import { requestTitle, requestWhen, REQUEST_STATUS } from '../styleRequests.js'
import { capsFor } from '../caps.js'

describe('how a request reads', () => {
  test('a replen names the style and the quantity', () => {
    expect(requestTitle({ kind: 'replen', product: 'Midi Dress', styleNumber: 'FYL-4002', quantity: 1200 })).toBe('Replen of Midi Dress (FYL-4002), 1,200 pcs')
    expect(requestTitle({ kind: 'replen', product: 'Skirt', styleNumber: '', quantity: 50 })).toBe('Replen of Skirt, 50 pcs')
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
