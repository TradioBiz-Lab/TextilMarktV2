// Tells the rest of the app that a company, its team or its connections just changed, so lists that
// were loaded earlier (the sidebar's View as picker) can read again instead of showing stale labels.
export const COMPANIES_CHANGED = 'tradio:companies-changed'

export const announceCompaniesChanged = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(COMPANIES_CHANGED))
}
