import { describe, test, expect } from 'vitest'
import { notifText, styleLabel } from '../notifText.js'

const orders = [
  { id: 'BUY-DRESS-SS26-006', product: 'Midi Dress', styleNumber: 'FYLSS26WD-4002' },
  { id: 'BUY-TOP-SS26-001', product: 'Flared Top', styleNumber: '' },
]
const masterOrders = [{ id: 'MO-BUY-SS26-001', orderName: 'SS26 Replen' }]

describe('a notification names the style, not its internal ID', () => {
  test('a style becomes its name and the last digits of the customer\'s style number', () => {
    expect(notifText('A replen of 1 style was ordered for you: BUY-DRESS-SS26-006', orders, masterOrders)).toBe('A replen of 1 style was ordered for you: Midi Dress, 4002')
    expect(styleLabel(orders[1])).toBe('Flared Top')
  })
  test('a master order becomes its name; an ID the viewer does not have stays as it was', () => {
    expect(notifText('Added under MO-BUY-SS26-001 (BUY-XX-SS26-999)', orders, masterOrders)).toBe('Added under SS26 Replen (BUY-XX-SS26-999)')
  })
})
