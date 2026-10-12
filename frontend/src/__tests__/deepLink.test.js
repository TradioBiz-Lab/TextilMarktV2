import { describe, test, expect } from 'vitest'
import { parseDeepLink } from '../lib/deepLink.js'

describe('deep links', () => {
  test('an order id opens that order; a listed screen opens that screen', () => {
    expect(parseDeepLink('#order=ZAR-TSHRT-FW26-001')).toEqual({ view: 'order_detail', orderId: 'ZAR-TSHRT-FW26-001' })
    expect(parseDeepLink('#view=orders')).toEqual({ view: 'orders' })
    expect(parseDeepLink('view=documents')).toEqual({ view: 'documents' })   // the # is optional
  })

  test('anything else is ignored: unknown screens, admin-only screens, odd ids, junk', () => {
    for (const bad of ['', '#', '#view=users', '#view=audit', '#view=review', '#view=nope', '#order=', '#order=../../x', '#order=a b', '#order=<script>', '#x=1', null, undefined])
      expect(parseDeepLink(bad), String(bad)).toBeNull()
  })

  test('an oversized hash is refused outright', () => {
    expect(parseDeepLink('#order=' + 'A'.repeat(400))).toBeNull()
  })

  test('a purchase order number opens that PO, and the purchasing screens can be linked', () => {
    expect(parseDeepLink('#po=PO-TPR-2627-0001')).toEqual({ view: 'po_detail', poId: 'PO-TPR-2627-0001' })
    expect(parseDeepLink('#view=purchase_orders')).toEqual({ view: 'purchase_orders' })
    expect(parseDeepLink('#view=suppliers')).toEqual({ view: 'suppliers' })
    for (const bad of ['#po=', '#po=PO-1', '#po=../x', '#po=PO-TPR-2627-0001/../x', '#po=po-tpr-2627-0001', '#po=<b>']) expect(parseDeepLink(bad), bad).toBeNull()
  })

  test('a cost sheet opens by its id, and the costing screens can be linked', () => {
    expect(parseDeepLink('#cost=0123456789abcdef01234567')).toEqual({ view: 'cost_sheet', costId: '0123456789abcdef01234567' })
    expect(parseDeepLink('#view=costing')).toEqual({ view: 'costing' })
    expect(parseDeepLink('#view=shopping_list')).toEqual({ view: 'shopping_list' })
    for (const bad of ['#cost=', '#cost=123', '#cost=0123456789ABCDEF01234567', '#cost=../x', '#cost=0123456789abcdef0123456g', '#cost=<b>']) expect(parseDeepLink(bad), bad).toBeNull()
  })

  test('a goods received note: #grn=<24 hex characters>, nothing else', () => {
    expect(parseDeepLink('#grn=0123456789abcdef01234567')).toEqual({ view: 'grn', grnId: '0123456789abcdef01234567' })
    for (const bad of ['#grn=', '#grn=123', '#grn=0123456789ABCDEF01234567', '#grn=../x', '#grn=<b>']) expect(parseDeepLink(bad), bad).toBeNull()
    expect(parseDeepLink('#view=inventory')).toEqual({ view: 'inventory' })
  })

  test('an order id wins over a screen when both are given', () => {
    expect(parseDeepLink('#view=orders&order=ZAR-1')).toEqual({ view: 'order_detail', orderId: 'ZAR-1' })
  })
})
