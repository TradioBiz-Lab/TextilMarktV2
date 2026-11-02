import { describe, test, expect } from 'vitest'
import { buildSearchIndex, searchItems } from '../search.js'

const masterOrders = [
  { id: 'MO-CBNB-SS26-003', orderName: 'FYLTR Replen SS26', buyerCompany: 'Cocoblu', season: 'SS26', poNumber: 'PO-77' },
  { id: 'MO-CBNB-SS26-001', orderName: 'H1 & H2 26', buyerCompany: 'Cocoblu', season: 'SS26' },
  { id: 'MO-FIT-FW26-001', orderName: 'Core Series', buyerCompany: 'Fitleasure', season: 'FW26' },
]
const orders = [
  { id: 'CBNB-DRESS-SS26-001', product: 'Midi Dress with Belt', styleNumber: 'FYLSS26WD-4002', buyerCompany: 'Cocoblu', masterOrderId: 'MO-CBNB-SS26-003', brand: 'FYLTR', phase: 'replen', category: 'DRESS' },
  { id: 'CBNB-DRESS-SS26-005', product: 'Flared Mini Dress', styleNumber: 'FYLSS26WD-4004', buyerCompany: 'Cocoblu', masterOrderId: 'MO-CBNB-SS26-003', brand: 'FYLTR', phase: 'replen', category: 'DRESS' },
  { id: 'CBNB-SKIRT-SS26-001', product: 'Schifli Skirt', styleNumber: 'FYLSS26WSK-4001', buyerCompany: 'Cocoblu', masterOrderId: 'MO-CBNB-SS26-003', phase: 'replen', category: 'SKIRT' },
  { id: 'FIT-LEGG-FW26-014', product: 'Seamless Leggings', styleNumber: 'FL-14002', buyerCompany: 'Fitleasure', masterOrderId: 'MO-FIT-FW26-001', phase: 'production', category: 'LEGG' },
]
const index = buildSearchIndex({ orders, masterOrders })
const find = q => searchItems(index, q).map(r => r.id)

describe('search in the top bar', () => {
  test('the last four digits of a customer style ID find that style first', () => {
    expect(find('4002')[0]).toBe('CBNB-DRESS-SS26-001')
    expect(find('4004')[0]).toBe('CBNB-DRESS-SS26-005')
    // a shorter tail still works, and a style whose ID merely contains the digits ranks below
    expect(find('002')[0]).toBe('CBNB-DRESS-SS26-001')
    expect(find('4002')).not.toContain('CBNB-SKIRT-SS26-001')
  })

  test('the full style ID matches with or without dashes, spaces or case', () => {
    expect(find('FYLSS26WD-4002')[0]).toBe('CBNB-DRESS-SS26-001')
    expect(find('fylss26 wd4002')[0]).toBe('CBNB-DRESS-SS26-001')
    expect(find('CBNB-SKIRT-SS26-001')[0]).toBe('CBNB-SKIRT-SS26-001')
  })

  test('a customer name brings its master orders first, then its styles', () => {
    const r = searchItems(index, 'cocoblu')
    expect(r.slice(0, 2).map(x => x.kind)).toEqual(['master_order', 'master_order'])
    expect(r.map(x => x.id)).not.toContain('MO-FIT-FW26-001')
    expect(r.some(x => x.kind === 'style')).toBe(true)
  })

  test('a master order by its name, its ID or its PO number', () => {
    expect(find('replen ss26')[0]).toBe('MO-CBNB-SS26-003')
    expect(find('MO-FIT')[0]).toBe('MO-FIT-FW26-001')
    expect(find('PO-77')[0]).toBe('MO-CBNB-SS26-003')
  })

  test('words narrow each other: a customer and a product', () => {
    expect(find('cocoblu skirt')).toEqual(['CBNB-SKIRT-SS26-001'])
    expect(find('fitleasure dress')).toEqual([])
    expect(find('midi')[0]).toBe('CBNB-DRESS-SS26-001')
  })

  test('says what each result is and where it leads', () => {
    const [style] = searchItems(index, '4002')
    expect(style).toMatchObject({ kind: 'style', title: 'Midi Dress with Belt', badge: 'Replen' })
    expect(style.sub).toContain('FYLSS26WD-4002')
    expect(style.sub).toContain('FYLTR Replen SS26')
    const [mo] = searchItems(index, 'core series')
    expect(mo).toMatchObject({ kind: 'master_order', id: 'MO-FIT-FW26-001' })
    expect(mo.sub).toContain('1 style')
  })

  test('nothing for an empty query, and at most the limit', () => {
    expect(searchItems(index, '   ')).toEqual([])
    expect(searchItems(index, 'ss26', 2)).toHaveLength(2)
  })
})
