// Pure helpers for the style review queue: how a request reads, and its status colours.
import { getToday } from './constants.js'

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
    if (its.length !== 1) return `New product development: ${its.length} styles`
    // The short form names a style "New product (its colours)" until Tradio names it.
    const [i] = its
    return `${/^New product\b/.test(i.product || '') ? i.product : `New product: ${i.product}`}${i.styleNumber ? ` (${i.styleNumber})` : ''}`
  }
  const n = r.summary?.ok
  return `${r.filename || 'Style sheet'}${n != null ? `, ${n} style${n !== 1 ? 's' : ''}` : ''}`
}

/** What a style on the New product development form still needs before it can be sent, or '' when it is ready. */
export function npdMissing(s, today = getToday()) {
  const gaps = [!String(s.styleNumber || '').trim() && 'your style no.', !s.colours.length && 'a colour', !s.delivery && 'the expected delivery date', !s.techPackLink.trim() && 'the tech pack link'].filter(Boolean)
  if (gaps.length) return `needs ${gaps.join(', ')}`
  if (s.delivery < today) return 'has an expected delivery date in the past'
  if (String(s.quantity).trim() && !(Number.isInteger(Number(s.quantity)) && Number(s.quantity) > 0)) return 'the quantity has to be a whole number'
  return ''
}

/** When it was sent, short: "2 Nov, 11:40 pm". */
export function requestWhen(at) {
  if (!at) return ''
  return new Date(at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
}
