import { describe, test, expect } from 'vitest'
import { navSections, navIdForView } from '../nav.js'

const ids = u => navSections(u).flatMap(s => s.items.map(i => i.id))
const S = { platformMode: 'standalone' }

describe('the sidebar', () => {
  test('the Tradio portal is exactly as before: six tabs for everyone, three more for admins, user setup for the master', () => {
    expect(ids({ role: 'buyer' })).toEqual(['dashboard', 'action_items', 'kriyaa', 'orders', 'documents', 'reports'])
    expect(ids({ role: 'manufacturer' })).toEqual(['dashboard', 'action_items', 'kriyaa', 'orders', 'documents', 'reports'])
    expect(ids({ role: 'admin', adminType: 'user' })).toEqual(['dashboard', 'action_items', 'kriyaa', 'orders', 'review', 'documents', 'reports', 'audit'])
    expect(ids({ role: 'admin', adminType: 'master' })).toEqual(['dashboard', 'action_items', 'kriyaa', 'orders', 'review', 'documents', 'reports', 'audit', 'users'])
  })

  test('standalone: the master admin lands on companies, with only what a viewer needs', () => {
    expect(ids({ ...S, role: 'admin', adminType: 'master' })).toEqual(['viewer', 'kriyaa', 'audit', 'users'])
  })

  test('standalone: other admins keep the working tabs; companies gain their Company page', () => {
    expect(ids({ ...S, role: 'admin', adminType: 'user' })).toEqual(['dashboard', 'action_items', 'kriyaa', 'orders', 'review', 'documents', 'reports', 'audit'])
    expect(ids({ ...S, role: 'manufacturer', orgRole: 'owner' })).toEqual(['dashboard', 'action_items', 'kriyaa', 'orders', 'documents', 'reports', 'company'])
    expect(ids({ ...S, role: 'buyer', orgRole: 'owner' })).toContain('company')
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
  })

  test('every item has an id, an icon name and a label', () => {
    for (const u of [{ role: 'buyer' }, { ...S, role: 'admin', adminType: 'master' }, { ...S, role: 'manufacturer' }])
      for (const i of navSections(u).flatMap(s => s.items)) expect(i.id && i.icon && i.label).toBeTruthy()
  })
})
