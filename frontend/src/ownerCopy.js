// "Apply to other styles" copies who owns a step, but a person is not the same thing on every style. A
// factory owner means "this style's own factory", the customer means "this order's customer", and only a Tradio
// person is the same person everywhere. Sending Factory A's id to Factory B's split would hand A write access there.

/** The owner to write on a sibling split, given the owner picked on this one ({ id, role } or null). */
export function ownerForSplit(owner, sibling, sibAsgn) {
  if (!owner || !owner.id) return null
  if (owner.role === 'manufacturer') return sibAsgn?.mid ? String(sibAsgn.mid) : null
  if (owner.role === 'buyer') return sibling?.buyerId ? String(sibling.buyerId) : null
  return String(owner.id)
}

/** How a copied owner reads in the confirmation list. */
export function ownerCopyLabel(owner, nameOf) {
  if (!owner || !owner.id) return 'Unassigned'
  if (owner.role === 'manufacturer') return "Each style's own factory"
  if (owner.role === 'buyer') return "The customer"
  return nameOf(owner.id) || 'Unknown'
}
