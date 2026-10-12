import { orderOwner } from '../caps.js'
import { T } from '../constants.js'

/**
 * Whose order this is: "Created by you", "Created by Zara India" or "Set up by Tradio". Only the
 * standalone product shows it; in the Tradio portal every order is Tradio's and the chip is nothing.
 */
export function OwnerChip({ order, user, style }) {
  const o = orderOwner(order, user)
  if (!o) return null
  const text = o.mine ? 'Created by you' : o.role === 'admin' ? 'Set up by Tradio' : `Created by ${o.company}`
  return (
    <span title={text} style={{
      display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      padding: '1px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700, letterSpacing: '0.02em',
      background: o.mine ? T.primaryLight : '#f1f5f9', color: o.mine ? T.primaryDark : T.textMuted, ...style,
    }}>{text}</span>
  )
}
