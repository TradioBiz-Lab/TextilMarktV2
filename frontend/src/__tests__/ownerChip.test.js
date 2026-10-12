import { describe, test, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { OwnerChip } from '../components/OwnerChip.jsx'

const brand = { id: 'b1', role: 'buyer', platformMode: 'standalone' }
const mfr = { id: 'm1', role: 'manufacturer', platformMode: 'standalone' }
const chip = (order, user) => renderToStaticMarkup(createElement(OwnerChip, { order, user }))

const byBrand = { createdBy: 'b1', createdByRole: 'buyer', buyerCompany: 'Zara India', assignments: [] }
const byMfr = { createdBy: 'm1', createdByRole: 'manufacturer', buyerCompany: 'Zara India', assignments: [{ mid: 'm1', mfrCompany: 'Tiruppur Textiles' }] }

describe('OwnerChip', () => {
  test('says "Created by you" to the company that created the order', () => {
    expect(chip(byBrand, brand)).toContain('Created by you')
    expect(chip(byMfr, mfr)).toContain('Created by you')
  })

  test('names the other company when someone else created it', () => {
    expect(chip(byBrand, mfr)).toContain('Created by Zara India')
    expect(chip(byMfr, brand)).toContain('Created by Tiruppur Textiles')
  })

  test('an order Tradio set up says so', () => {
    expect(chip({ createdBy: null, createdByRole: null }, brand)).toContain('Set up by Tradio')
  })

  test('shows nothing in the Tradio portal, where every order is Tradio\'s', () => {
    expect(chip(byBrand, { ...brand, platformMode: 'tradio' })).toBe('')
  })
})
