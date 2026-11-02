// Pure helpers for the style review queue: how a request reads, and its status colours.

export const REQUEST_STATUS = {
  pending:   { label: 'Waiting for review', fg: '#92400e', bg: '#fef3c7', bd: '#fcd34d' },
  approved:  { label: 'Approved', fg: '#047857', bg: '#ecfdf5', bd: '#6ee7b7' },
  declined:  { label: 'Declined', fg: '#b91c1c', bg: '#fef2f2', bd: '#fca5a5' },
  cancelled: { label: 'Cancelled', fg: '#475569', bg: '#f1f5f9', bd: '#cbd5e1' },
}

const pcs = n => `${Number(n).toLocaleString('en-IN')} pcs`

/** One line saying what the request is. */
export function requestTitle(r) {
  if (r.kind === 'replen') return `Replen of ${r.product}${r.styleNumber ? ` (${r.styleNumber})` : ''}, ${pcs(r.quantity)}`
  const n = r.summary?.ok
  return `${r.filename || 'Style sheet'}${n != null ? `, ${n} style${n !== 1 ? 's' : ''}` : ''}`
}

/** When it was sent, short: "2 Nov, 11:40 pm". */
export function requestWhen(at) {
  if (!at) return ''
  return new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
}
