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

  test('an order id wins over a screen when both are given', () => {
    expect(parseDeepLink('#view=orders&order=ZAR-1')).toEqual({ view: 'order_detail', orderId: 'ZAR-1' })
  })
})
