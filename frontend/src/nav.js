// The sidebar, as data. Built from capabilities rather than role strings, in sections, so a new
// module is one entry here and a tab per role is a capability, not a scattering of conditionals.
//
// `icon` is a name (a key of NAV_ICONS in Shell.jsx), so this file stays free of React and can be
// tested on its own. Sections without a `label` render as a plain list; a labelled section gets a
// small uppercase heading (hidden when the sidebar is collapsed).
import { capsFor } from './caps.js'

export function navSections(user) {
  if (!user) return []
  const caps = capsFor(user)

  // Standalone product, master admin's own session: the company directory is home. They look at
  // companies through it; they do not run an orders dashboard of their own.
  if (caps.seeViewerHome) {
    return [{ items: [
      { id: 'viewer', icon: 'Buildings', label: 'Companies' },
      { id: 'kriyaa', icon: 'Bot', label: 'Kriyaa' },
      { id: 'audit', icon: 'History', label: 'Audit Log' },
      { id: 'users', icon: 'Users', label: 'User Setup' },
    ] }]
  }

  // Every role gets the same six tabs, in the same order. Admins get three extra management tabs;
  // what each tab shows is scoped to the signed-in user's own data.
  // A customer reads the plan first: Reports sits right under the Dashboard and Orders is called Order TnA.
  const reports = { id: 'reports', icon: 'BarChart3', label: 'Reports' }
  const main = [
    { id: 'dashboard', icon: 'Home', label: 'Dashboard' },
    ...(caps.isBuyer ? [reports] : []),
    { id: 'action_items', icon: 'ListChecks', label: 'Action Items' },
    { id: 'kriyaa', icon: 'Bot', label: 'Kriyaa' },
    { id: 'orders', icon: 'Package', label: caps.isBuyer ? 'Order TnA' : 'Orders' },
    ...(caps.seeReviewQueue ? [{ id: 'review', icon: 'Inbox', label: 'Review Queue' }] : []),
    { id: 'documents', icon: 'Folder', label: 'Documents' },
    ...(caps.isBuyer ? [] : [reports]),
    ...(caps.seeAudit ? [{ id: 'audit', icon: 'History', label: 'Audit Log' }] : []),
    ...(caps.seeUserSetup ? [{ id: 'users', icon: 'Users', label: 'User Setup' }] : []),
  ]
  const company = caps.seeCompanyPage ? [{ id: 'company', icon: 'Buildings', label: 'Company' }] : []

  // A manufacturer in the standalone product also buys: its supplier book and purchase orders get a
  // section of their own, so style-level depth stays inside the order and the sidebar stays short.
  if (caps.seeProcurement) {
    return [
      { items: main },
      { label: 'Purchasing', items: [
        { id: 'shopping_list', icon: 'ShoppingCart', label: 'Shopping List' },
        { id: 'suppliers', icon: 'Storefront', label: 'Suppliers' },
        { id: 'purchase_orders', icon: 'Receipt', label: 'Purchase Orders' },
        ...(caps.seeInventory ? [{ id: 'inventory', icon: 'Warehouse', label: 'Stock' }] : []),
      ] },
      ...(caps.seeCosting ? [{ label: 'Commercial', items: [{ id: 'costing', icon: 'Calculator', label: 'Cost Sheets' }] }] : []),
      ...(company.length ? [{ label: 'Account', items: company }] : []),
    ]
  }
  // A brand in the standalone product reviews the cost sheets its factories share with it.
  if (caps.seeCosting) {
    return [
      { items: main },
      { label: 'Commercial', items: [{ id: 'costing', icon: 'Calculator', label: 'Cost Sheets' }] },
      ...(company.length ? [{ label: 'Account', items: company }] : []),
    ]
  }
  return [{ items: [...main, ...company] }]
}

/** Which sidebar item lights up for a view (a detail screen belongs to its list). */
export function navIdForView(view) {
  if (view === 'order_detail' || view === 'submit_req') return 'orders'
  if (view === 'po_builder' || view === 'po_detail') return 'purchase_orders'
  if (view === 'supplier_detail') return 'suppliers'
  if (view === 'grn') return 'inventory'
  if (view === 'cost_sheet') return 'costing'
  return view
}
