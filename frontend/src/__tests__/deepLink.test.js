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

  test('an order id wins over a screen when both are given', () => {
    expect(parseDeepLink('#view=orders&order=ZAR-1')).toEqual({ view: 'order_detail', orderId: 'ZAR-1' })
  })
})
