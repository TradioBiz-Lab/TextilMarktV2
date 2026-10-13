import { describe, test, expect } from 'vitest'
import { deliveryDocsOf, stageForDoc, PO_INVOICE_DOC_TYPES } from '../constants.js'
import { capsFor } from '../caps.js'

const orders = [{
  id: 'O-1',
  assignments: [{ mid: 'm1', stages: [{ name: 'Trims Order' }, { name: 'PP +Fit Sample Sent' }, { name: 'Delivery', isDelivery: true }] }],
}]
const doc = (over = {}) => ({ id: 'd', orderId: 'O-1', mfrId: 'm1', type: 'dispatch_docs', stageIndex: 2, ...over })

describe('Delivery documents folder', () => {
  test('lists delivery paperwork on the Delivery step and on the order itself', () => {
    const docs = [doc({ id: 'a' }), doc({ id: 'b', stageIndex: null, mfrId: null })]
    expect(deliveryDocsOf(orders, docs).map(d => d.id)).toEqual(['a', 'b'])
  })

  test('leaves out a delivery document filed on some other step, and every other type', () => {
    const docs = [doc({ id: 'pp', stageIndex: 1 }), doc({ id: 'inv', type: 'invoice', stageIndex: null }), doc({ id: 'po', type: 'PO', stageIndex: null }), doc({ id: 'lab', type: 'lab_dip', stageIndex: 2 })]
    expect(deliveryDocsOf(orders, docs)).toEqual([])
  })

  test('a document pointing past the plan is not listed', () => {
    expect(deliveryDocsOf(orders, [doc({ stageIndex: 9 })])).toEqual([])
    expect(stageForDoc(orders, doc({ stageIndex: 0 }))?.name).toBe('Trims Order')
  })
})

describe('who sees and uploads POs and invoices', () => {
  const caps = role => capsFor({ role })
  test('POs, buyer orders and invoices are the PO and Invoice folder', () => {
    expect(PO_INVOICE_DOC_TYPES).toEqual(['PO', 'buyer_order', 'invoice'])
  })
  test('a factory does not see the folder; Tradio and the customer do', () => {
    expect(caps('manufacturer').seePoInvoice).toBe(false)
    expect(caps('admin').seePoInvoice).toBe(true)
    expect(caps('buyer').seePoInvoice).toBe(true)
  })
  test('the customer uploads POs, only Tradio uploads invoices', () => {
    expect(caps('buyer').uploadPoInvoice).toBe(true)
    expect(caps('buyer').uploadInvoices).toBe(false)
    expect(caps('admin').uploadInvoices).toBe(true)
    expect(caps('manufacturer').uploadPoInvoice).toBe(false)
  })
  test('Tradio and the factory upload delivery papers, the customer does not', () => {
    expect(caps('admin').uploadDeliveryDocs).toBe(true)
    expect(caps('manufacturer').uploadDeliveryDocs).toBe(true)
    expect(caps('buyer').uploadDeliveryDocs).toBe(false)
  })
})
