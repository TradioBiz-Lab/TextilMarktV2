import { describe, test, expect } from 'vitest'
import { stylesAtFactory, clientsAtFactory, productsOfClient, productState, techPackOf, measurementOf, bomOf, masterOrderTarget } from '../coordinatorStyles.js'

const split = (mid, status = 'Processing', qty = 100) => ({ mid, status, qty })
const orders = [
  { id: 'S1', buyerId: 'b1', buyerCompany: 'Cocoblu', product: 'Polo', styleNumber: 'CB-101', masterOrderId: 'MO1', phase: 'production', assignments: [split('fA', 'Processing', 60)] },
  { id: 'S2', buyerId: 'b1', buyerCompany: 'Cocoblu', product: 'Henley', masterOrderId: 'MO2', phase: 'replen', assignments: [split('fA')] },
  { id: 'S3', buyerId: 'b1', buyerCompany: 'Cocoblu', product: 'Crew', masterOrderId: 'MO1', phase: 'production', assignments: [split('fA', 'Delivered')] },
  { id: 'S4', buyerId: 'b1', buyerCompany: 'Cocoblu', product: 'Tank', masterOrderId: null, phase: 'development', assignments: [split('fA')] },
  { id: 'S5', buyerId: 'b2', buyerCompany: 'Vibemist', product: 'Jacket', masterOrderId: 'MO3', phase: 'production', assignments: [split('fA', 'Delivered')] },
  { id: 'S6', buyerId: 'b3', buyerCompany: 'Fitleasure', product: 'Legging', masterOrderId: 'MO4', phase: 'production', assignments: [split('fB')] },
  { id: 'S7', buyerId: 'b0', buyerCompany: 'Aero', product: 'Short', masterOrderId: 'MO5', phase: 'production', assignments: [split('fA'), split('fB', 'Delivered')] },
]
const masterOrders = [{ id: 'MO1', orderName: 'SS26 Main' }, { id: 'MO2', orderName: 'Replen October' }, { id: 'MO5', orderName: 'Aero Run' }]

describe('what is at a factory', () => {
  test('only the styles with a split there', () => {
    expect(stylesAtFactory(orders, 'fA').map(o => o.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S7'])
    expect(stylesAtFactory(orders, 'fB').map(o => o.id)).toEqual(['S6', 'S7'])
    expect(stylesAtFactory(orders, 'nope')).toEqual([])
  })
  test('one card per client, those with live work first, then by name', () => {
    expect(clientsAtFactory(orders, 'fA')).toEqual([
      { id: 'b0', name: 'Aero', count: 1, live: 1 },
      { id: 'b1', name: 'Cocoblu', count: 4, live: 3 },
      { id: 'b2', name: 'Vibemist', count: 1, live: 0 },
    ])
  })
  test('a product is delivered by this factory\'s split, not the style as a whole', () => {
    expect(productState(orders[6], 'fA')).toBe('production')
    expect(productState(orders[6], 'fB')).toBe('delivered')
    expect(productState(orders[3], 'fA')).toBe('development')
    expect(productState(orders[1], 'fA')).toBe('replen')
  })
})

describe('one client\'s products', () => {
  test('under their master order names, "Other styles" last, delivered apart', () => {
    const r = productsOfClient(orders, masterOrders, 'fA', 'b1')
    expect(r.groups.map(g => [g.key, g.title, g.products.map(p => p.id)])).toEqual([
      ['MO2', 'Replen October', ['S2']],
      ['MO1', 'SS26 Main', ['S1']],
      ['none', null, ['S4']],
    ])
    expect(r.delivered.map(p => p.id)).toEqual(['S3'])
    expect(r.groups[1].products[0]).toMatchObject({ product: 'Polo', styleNumber: 'CB-101', state: 'production', qty: 60 })
  })
  test('a master order he was not sent falls back to its id; another client\'s styles never appear', () => {
    const r = productsOfClient(orders, [], 'fA', 'b1')
    expect(r.groups.map(g => g.title)).toEqual(['MO1', 'MO2', null])
    expect(productsOfClient(orders, masterOrders, 'fA', 'b3')).toEqual({ groups: [], delivered: [] })
  })
})

describe('the two papers on the order top', () => {
  const docs = [
    { id: 'd1', type: 'tech_pack', orderId: 'S1', createdAt: '2026-10-01' },
    { id: 'd2', type: 'tech_pack', orderId: 'S1', createdAt: '2026-11-01' },
    { id: 'd3', type: 'tech_pack', orderId: 'S1', createdAt: '2026-11-10', isActive: false },
    { id: 'm1', type: 'measurements', orderId: 'S1', createdAt: '2026-10-01', locked: true },
    { id: 'm2', type: 'measurements', orderId: 'S1', createdAt: '2026-11-01' },
    { id: 'm3', type: 'measurements', orderId: 'S2', createdAt: '2026-09-01' },
    { id: 'm4', type: 'measurements', orderId: 'S2', createdAt: '2026-09-15' },
    { id: 'b1', type: 'bom', orderId: 'S1', createdAt: '2026-10-01' },
    { id: 'b2', type: 'bom', orderId: 'S1', createdAt: '2026-11-05' },
  ]
  test('the newest tech pack; the Locked Measurement before a newer sheet', () => {
    expect(techPackOf(docs, 'S1').id).toBe('d2')
    expect(techPackOf(docs, 'S9')).toBe(null)
    expect(measurementOf(docs, 'S1').id).toBe('m1')
    expect(measurementOf(docs, 'S2').id).toBe('m4')
    expect(measurementOf(docs, 'S9')).toBe(null)
  })
  test('the newest bill of materials, or none', () => {
    expect(bomOf(docs, 'S1').id).toBe('b2')
    expect(bomOf(docs, 'S2')).toBe(null)
  })
})

describe('where a master order opens for a coordinator', () => {
  test('one of his factories making it (the one he is in, when it is), and its client', () => {
    expect(masterOrderTarget(orders, 'MO5')).toEqual({ factoryId: 'fA', clientId: 'b0' })
    expect(masterOrderTarget(orders, 'MO5', 'fB')).toEqual({ factoryId: 'fB', clientId: 'b0' })
    expect(masterOrderTarget(orders, 'MO5', 'fZ')).toEqual({ factoryId: 'fA', clientId: 'b0' })
    expect(masterOrderTarget(orders, 'NOPE')).toBe(null)
  })
})
