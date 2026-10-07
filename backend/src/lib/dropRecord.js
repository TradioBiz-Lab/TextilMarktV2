export const MAX_DROP_REASON = 500

/** The optional reason sent with a drop: '' when absent, an error string when unusable. */
export function parseDropReason(value) {
  if (value === undefined || value === null || value === '') return { reason: '' }
  if (typeof value !== 'string') return { error: 'Reason must be text' }
  const reason = value.trim()
  if (reason.length > MAX_DROP_REASON) return { error: `Reason too long (max ${MAX_DROP_REASON} characters)` }
  return { reason }
}

export const styleLabel = order =>
  `${order.product}${order.styleNumber ? ` (${order.styleNumber})` : ''}`
