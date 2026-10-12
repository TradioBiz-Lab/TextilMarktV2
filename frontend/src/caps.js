// What each role may do in the shared screens (Dashboard, Orders, Order detail, Documents,
// Reports, Action Items, Kriyaa). These mirror the server's rules (backend/src/lib/authz.js,
// routes/orders.js, documents.js); the server is still the real gate, this just keeps the UI from
// offering buttons that would be refused.
//
// Two products share this code, told apart by `user.platformMode`:
//
//   Tradio portal (default)  Tradio staff coordinate everything.
//     admin         everything (master admin additionally: stage override, user setup)
//     manufacturer  works their own assignment: progress, notes, materials, checklist, evidence;
//                   cannot create/edit/delete orders or move planned dates
//     buyer         read-only, except a stage assigned to them (usually an approval)
//
//   Standalone product  brands and manufacturers transact directly; Tradio staff are viewers.
//     buyer / manufacturer  also create orders and master orders. The company that created an order
//                   edits and deletes it; a brand that created it assigns its (connected)
//                   manufacturers; a manufacturer runs the plan of its own split
//     admin         acts only for Tradio-enabled manufacturers (the server decides which)
//     view as       read-only unless "acting for" an enabled manufacturer: every write cap is off
//
// Role-level caps below are deliberately conservative: anything that depends on WHO CREATED an
// order, or WHICH split it is, is admin-only here and answered per order by orderCaps / canEditPlan,
// so a call site that forgets to ask fails closed.

export const isStandalone = user => user?.platformMode === 'standalone'

/** A master admin looking at a company without "act for": the server refuses every write. */
export const isViewOnly = user => isStandalone(user) && !!user?.viewAsBy && !user?.actingFor

export function capsFor(user) {
  const role = user?.role
  const standalone = isStandalone(user)
  const viewOnly = isViewOnly(user)
  const isAdmin = role === 'admin'
  const isMaster = isAdmin && user?.adminType === 'master'
  const isMfr = role === 'manufacturer'
  const isBuyer = role === 'buyer'
  const isCompany = isMfr || isBuyer
  const w = allowed => !viewOnly && allowed   // every write is off in a read-only view
  return {
    role, isAdmin, isMaster, isMfr, isBuyer, isCompany, standalone, viewOnly,
    // Order lifecycle
    createOrders: w(isAdmin || (standalone && isCompany)),
    editOrders: w(isAdmin), deleteOrders: w(isAdmin), assignManufacturers: w(isAdmin),
    // Planning (dates, stages, TNA import) is the coordinator's. In the standalone product the split's own
    // manufacturer is the coordinator of its own schedule: ask canEditPlan(user, asgn).
    editPlan: w(isAdmin), overrideStage: w(isMaster),
    // Shipping the daily work
    manageMaterials: w(isAdmin || isMfr), manageChecklist: w(isAdmin || isMfr),
    uploadStageEvidence: w(isAdmin || isMfr),
    uploadProductPhoto: w(isAdmin),
    uploadReferenceDocs: w(isAdmin || isBuyer || (standalone && isMfr)),   // tech pack, measurements, pattern, lab dip
    submitRequirement: w(isBuyer),
    manageCertificates: w(isMfr),
    // Admin-only surfaces
    seeUsers: isAdmin, seeAudit: isAdmin, seeReviewQueue: isAdmin, seeRibbonsAdmin: isAdmin, seeBuyerRequests: isAdmin,
    seeUserSetup: isMaster,
    // The master admin's own session lands on the company directory instead of a dashboard.
    seeViewerHome: isMaster && standalone,
    // A company's own settings page: its team, partners and the Tradio access switch.
    seeCompanyPage: standalone && isCompany,
    // Suppliers and purchase orders: a manufacturer's own, in the standalone product only. A master
    // admin viewing a factory read-only is that factory's session, so sees them but cannot write.
    seeProcurement: standalone && isMfr,
    manageProcurement: w(standalone && isMfr),
    // Stock and goods received notes: a factory's store (same rule as purchasing).
    seeInventory: standalone && isMfr,
    manageInventory: w(standalone && isMfr),
    // Bills of materials and the shopping list are a factory's own (like purchasing). Cost sheets have two
    // sides: the factory drafts, revises and shares; the brand it is shared with comments and approves.
    seeBom: standalone && isMfr,
    manageBom: w(standalone && isMfr),
    seeCosting: standalone && isCompany,
    manageCosting: w(standalone && isMfr),
    commentCosting: w(standalone && isCompany),
    approveCosting: w(standalone && isBuyer),
    changeTradioAccess: standalone && isCompany && user?.orgRole === 'owner' && !user?.viewAsBy,
  }
}

/** The view a signed-in user starts on. */
export const homeViewFor = user => (capsFor(user).seeViewerHome ? 'viewer' : 'dashboard')

const sameId = (a, b) => a != null && b != null && String(a) === String(b)

/** True when this user's company created the order (standalone only; older orders belong to Tradio). */
export function createdByUser(user, order) {
  return isStandalone(user) && !!order?.createdBy && order.createdByRole === user?.role && sameId(order.createdBy, user.id)
}

/**
 * What this user may do to one order, beyond the role-level caps. Mirrors requireOrderOwner and
 * requireAssigner: Tradio staff, or the company that created it; assigning is a brand's job.
 */
export function orderCaps(user, order) {
  const none = { edit: false, remove: false, assign: false, uploadPhoto: false, createdByYou: false }
  if (!user || !order) return none
  const mine = createdByUser(user, order)
  const edit = !isViewOnly(user) && (user.role === 'admin' || mine)
  return {
    edit, remove: edit, uploadPhoto: edit, createdByYou: mine,
    assign: !isViewOnly(user) && (user.role === 'admin' || (mine && user.role === 'buyer')),
  }
}

/** May this user edit or delete this master order (its name and season)? Same rule as orders. */
export function canEditMasterOrder(user, mo) {
  if (!user || !mo || isViewOnly(user)) return false
  return user.role === 'admin' || createdByUser(user, mo)
}

/**
 * May this user change this split's plan (dates, steps, who owns a step)? Tradio staff; or, in the
 * standalone product, the split's own manufacturer. A brand never runs a factory's calendar.
 */
export function canEditPlan(user, asgn) {
  if (!user || isViewOnly(user)) return false
  if (user.role === 'admin') return true
  return isStandalone(user) && user.role === 'manufacturer' && sameId(asgn?.mid, user.id)
}

/** "Created by you / by Zara India / by Tradio" for an order, or null in the Tradio portal where every order is Tradio's. */
export function orderOwner(order, user) {
  if (!isStandalone(user) || !order) return null
  const role = order.createdByRole
  if (role === 'buyer') return { role, mine: sameId(order.createdBy, user?.id), company: order.buyerCompany || 'the customer' }
  if (role === 'manufacturer') return { role, mine: sameId(order.createdBy, user?.id), company: (order.assignments || []).find(a => sameId(a.mid, order.createdBy))?.mfrCompany || (order.assignments || [])[0]?.mfrCompany || 'the manufacturer' }
  return { role: 'admin', mine: false, company: 'Tradio' }
}

/** May this user write to this stage of this assignment (progress, status, notes)? */
export function canWriteStage(user, asgn, stage) {
  if (!user || isViewOnly(user)) return false
  if (user.role === 'admin') return true
  if (user.role === 'manufacturer') return String(asgn?.mid) === String(user.id)
  // A buyer never writes the Delivery step: it decides when a split counts as delivered (server rule too).
  if (user.role === 'buyer') return !stage?.isDelivery && !!stage?.responsibleId && String(stage.responsibleId) === String(user.id)
  return false
}

/** May this user change this assignment's overall status (Processing / On Hold / Delayed / Delivered)? */
export function canSetAssignmentStatus(user, asgn) {
  if (!user || isViewOnly(user)) return false
  if (user?.role === 'admin') return true
  return user?.role === 'manufacturer' && String(asgn?.mid) === String(user.id)
}
