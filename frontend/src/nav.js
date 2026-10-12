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
  const items = [
    { id: 'dashboard', icon: 'Home', label: 'Dashboard' },
    { id: 'action_items', icon: 'ListChecks', label: 'Action Items' },
    { id: 'kriyaa', icon: 'Bot', label: 'Kriyaa' },
    { id: 'orders', icon: 'Package', label: 'Orders' },
    ...(caps.seeReviewQueue ? [{ id: 'review', icon: 'Inbox', label: 'Review Queue' }] : []),
    { id: 'documents', icon: 'Folder', label: 'Documents' },
    { id: 'reports', icon: 'BarChart3', label: 'Reports' },
    ...(caps.seeAudit ? [{ id: 'audit', icon: 'History', label: 'Audit Log' }] : []),
    ...(caps.seeUserSetup ? [{ id: 'users', icon: 'Users', label: 'User Setup' }] : []),
    ...(caps.seeCompanyPage ? [{ id: 'company', icon: 'Buildings', label: 'Company' }] : []),
  ]
  return [{ items }]
}

/** Which sidebar item lights up for a view (a detail screen belongs to its list). */
export const navIdForView = view => (view === 'order_detail' || view === 'submit_req' ? 'orders' : view)
