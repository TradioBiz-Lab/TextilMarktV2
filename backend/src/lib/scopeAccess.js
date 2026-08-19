import { MfrProject } from '../models/MfrProject.js'

// Shared scoping rule for MaterialRequirement and CostSheet: every document is
// either tied to a real Tradio Order or to a manufacturer's own private
// MfrProject — never both, never neither. Same shape of problem as this app's
// wikiScope/buyerId pairing, validated the same way: check the discriminator,
// check exactly one id is set, and for mfr_project confirm the caller actually
// owns it (that ownership check is what makes the privacy rule in MfrProject.js
// real instead of aspirational).
export async function assertScopeShape(scopeType, orderId, mfrProjectId, user) {
  if (!['tradio_order', 'mfr_project'].includes(scopeType))
    throw Object.assign(new Error('scopeType must be "tradio_order" or "mfr_project"'), { status: 400 })

  if (scopeType === 'tradio_order') {
    if (!orderId) throw Object.assign(new Error('scopeType "tradio_order" requires orderId'), { status: 400 })
    if (mfrProjectId) throw Object.assign(new Error('scopeType "tradio_order" must not include mfrProjectId'), { status: 400 })
  } else {
    if (!mfrProjectId) throw Object.assign(new Error('scopeType "mfr_project" requires mfrProjectId'), { status: 400 })
    if (orderId) throw Object.assign(new Error('scopeType "mfr_project" must not include orderId'), { status: 400 })
    const project = await MfrProject.findById(mfrProjectId, 'mfrId isActive').lean()
    if (!project || !project.isActive)
      throw Object.assign(new Error('mfrProjectId must reference a valid project'), { status: 400 })
    // Ownership, not just existence — a manufacturer can only attach requirements/
    // cost sheets to their OWN project. No admin override anywhere in this check.
    if (String(project.mfrId) !== String(user.id))
      throw Object.assign(new Error('Forbidden'), { status: 403 })
  }
}
