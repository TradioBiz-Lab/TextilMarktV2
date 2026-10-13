import { describe, test, expect } from 'vitest'
import { navSections, navIdForView } from '../nav.js'

const ids = u => navSections(u).flatMap(s => s.items.map(i => i.id))
const S = { platformMode: 'standalone' }

describe('the sidebar', () => {
  test('the Tradio portal is exactly as before: six tabs for everyone, three more for admins, user setup for the master', () => {
    expect(ids({ role: 'buyer' })).toEqual(['dashboard', 'reports', 'action_items', 'kriyaa', 'orders', 'documents'])
    expect(ids({ role: 'manufacturer' })).toEqual(['dashboard', 'action_items', 'kriyaa', 'orders', 'documents', 'reports'])
    expect(ids({ role: 'admin', adminType: 'user' })).toEqual(['dashboard', 'action_items', 'kriyaa', 'orders', 'review', 'documents', 'reports', 'audit'])
    expect(ids({ role: 'admin', adminType: 'master' })).toEqual(['dashboard', 'action_items', 'kriyaa', 'orders', 'review', 'documents', 'reports', 'audit', 'users'])
  })

  test('a customer sees Reports second and Orders as Order TnA; everyone else keeps Orders', () => {
    const label = (u, id) => navSections(u).flatMap(s => s.items).find(i => i.id === id).label
    expect(label({ role: 'buyer' }, 'orders')).toBe('Order TnA')
    expect(label({ role: 'manufacturer' }, 'orders')).toBe('Orders')
    expect(label({ role: 'admin', adminType: 'user' }, 'orders')).toBe('Orders')
  })

  test('standalone: the master admin lands on companies, with only what a viewer needs', () => {
    expect(ids({ ...S, role: 'admin', adminType: 'master' })).toEqual(['viewer', 'kriyaa', 'audit', 'users'])
  })

  test('standalone: other admins keep the working tabs; companies gain their Company page', () => {
    expect(ids({ ...S, role: 'admin', adminType: 'user' })).toEqual(['dashboard', 'action_items', 'kriyaa', 'orders', 'review', 'documents', 'reports', 'audit'])
    expect(ids({ ...S, role: 'manufacturer', orgRole: 'owner' })).toEqual(['dashboard', 'action_items', 'kriyaa', 'orders', 'documents', 'reports', 'shopping_list', 'suppliers', 'purchase_orders', 'inventory', 'costing', 'company'])
    expect(ids({ ...S, role: 'buyer', orgRole: 'owner' })).toEqual(['dashboard', 'action_items', 'kriyaa', 'orders', 'documents', 'reports', 'costing', 'company'])
  })

  test('standalone: a manufacturer buys and costs, so it gets Purchasing and Commercial sections; a brand only reviews cost sheets', () => {
    const mfr = navSections({ ...S, role: 'manufacturer', orgRole: 'owner' })
    expect(mfr.map(s => s.label || null)).toEqual([null, 'Purchasing', 'Commercial', 'Account'])
    expect(mfr[1].items.map(i => i.label)).toEqual(['Shopping List', 'Suppliers', 'Purchase Orders', 'Stock'])
    expect(mfr[2].items.map(i => i.label)).toEqual(['Cost Sheets'])
    const brand = navSections({ ...S, role: 'buyer', orgRole: 'owner' })
    expect(brand.map(s => s.label || null)).toEqual([null, 'Commercial', 'Account'])
    for (const id of ['suppliers', 'purchase_orders', 'shopping_list', 'inventory']) expect(ids({ ...S, role: 'buyer', orgRole: 'owner' })).not.toContain(id)
  })

  test('the Tradio portal has no purchasing section at all', () => {
    expect(ids({ role: 'manufacturer' })).not.toContain('suppliers')
    expect(ids({ role: 'manufacturer' })).not.toContain('inventory')
    expect(ids({ role: 'buyer' })).not.toContain('costing')
    expect(navSections({ role: 'manufacturer' })).toHaveLength(1)
  })

  test('while viewing a company the master admin sees that company\'s own tabs, not their own', () => {
    expect(ids({ ...S, role: 'manufacturer', viewAsBy: 'a1' })).toContain('orders')
    expect(ids({ ...S, role: 'manufacturer', viewAsBy: 'a1' })).not.toContain('viewer')
  })

  test('no user, no sidebar; a detail screen lights up its list', () => {
    expect(navSections(null)).toEqual([])
    expect(navIdForView('order_detail')).toBe('orders')
    expect(navIdForView('submit_req')).toBe('orders')
    expect(navIdForView('reports')).toBe('reports')
    expect(navIdForView('po_detail')).toBe('purchase_orders')
    expect(navIdForView('grn')).toBe('inventory')
    expect(navIdForView('po_builder')).toBe('purchase_orders')
    expect(navIdForView('supplier_detail')).toBe('suppliers')
    expect(navIdForView('cost_sheet')).toBe('costing')
  })

  test('every item has an id, an icon name and a label', () => {
    for (const u of [{ role: 'buyer' }, { ...S, role: 'admin', adminType: 'master' }, { ...S, role: 'manufacturer' }])
      for (const i of navSections(u).flatMap(s => s.items)) expect(i.id && i.icon && i.label).toBeTruthy()
  })
})
