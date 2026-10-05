// What each role may do in the shared screens (Dashboard, Orders, Order detail,
// Documents, Reports, Action Items, Kriyaa). These mirror the server's rules
// exactly (backend/src/routes/orders.js, documents.js); the server is still the
// real gate, this just keeps the UI from offering buttons that would be refused.
//
//   admin        everything (master admin additionally: stage override, user setup)
//   manufacturer works their own assignment: progress, notes, materials, checklist,
//                evidence; cannot create/edit/delete orders or move planned dates
//   buyer        read-only, except a stage assigned to them (usually an approval):
//                they may post notes on it and set its status
export function capsFor(user) {
  const role = user?.role
  const isAdmin = role === 'admin'
  const isMaster = isAdmin && user?.adminType === 'master'
  const isMfr = role === 'manufacturer'
  const isBuyer = role === 'buyer'
  return {
    role, isAdmin, isMaster, isMfr, isBuyer,
    // Order lifecycle
    createOrders: isAdmin, editOrders: isAdmin, deleteOrders: isAdmin, assignManufacturers: isAdmin,
    // Planning (dates, stages, TNA import) is the coordinator's
    editPlan: isAdmin, overrideStage: isMaster,
    // Shipping the daily work
    manageMaterials: isAdmin || isMfr, manageChecklist: isAdmin || isMfr,
    uploadStageEvidence: isAdmin || isMfr,
    uploadProductPhoto: isAdmin,
    uploadReferenceDocs: isAdmin || isBuyer,   // tech pack, measurements, pattern, lab dip
    submitRequirement: isBuyer,
    manageCertificates: isMfr,
    // Admin-only surfaces
    seeUsers: isAdmin, seeAudit: isAdmin, seeReviewQueue: isAdmin, seeRibbonsAdmin: isAdmin, seeBuyerRequests: isAdmin,
  }
}

/** May this user write to this stage of this assignment (progress, status, notes)? */
export function canWriteStage(user, asgn, stage) {
  if (!user) return false
  if (user.role === 'admin') return true
  if (user.role === 'manufacturer') return String(asgn?.mid) === String(user.id)
  if (user.role === 'buyer') return !!stage?.responsibleId && String(stage.responsibleId) === String(user.id)
  return false
}

/** May this user change this assignment's overall status (Processing / On Hold / Delayed / Delivered)? */
export function canSetAssignmentStatus(user, asgn) {
  if (user?.role === 'admin') return true
  return user?.role === 'manufacturer' && String(asgn?.mid) === String(user.id)
}
