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
  if (r.kind === 'replen') {
    const its = r.items?.length ? r.items : [r]
    if (its.length > 1) return `Replen of ${its.length} styles: ${its.map(i => i.styleNumber || i.product).join(', ')}`
    const [i] = its
    return `Replen of ${i.product}${i.styleNumber ? ` (${i.styleNumber})` : ''}${i.quantity ? `, ${pcs(i.quantity)}` : ''}`
  }
  if (r.kind === 'npd') {
    const its = r.items || []
    return its.length === 1 ? `New product: ${its[0].product}${its[0].styleNumber ? ` (${its[0].styleNumber})` : ''}` : `New product development: ${its.length} styles`
  }
  const n = r.summary?.ok
  return `${r.filename || 'Style sheet'}${n != null ? `, ${n} style${n !== 1 ? 's' : ''}` : ''}`
}

/** When it was sent, short: "2 Nov, 11:40 pm". */
export function requestWhen(at) {
  if (!at) return ''
  return new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
}
