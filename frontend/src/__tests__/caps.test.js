import { describe, test, expect } from 'vitest'
import { capsFor, canWriteStage, canSetAssignmentStatus, orderCaps, canEditPlan, canEditMasterOrder, orderOwner, homeViewFor, isViewOnly, createdByUser } from '../caps.js'

const admin = { id: 'a1', role: 'admin', adminType: 'master' }
const buyer = { id: 'b1', role: 'buyer' }
const mfr = { id: 'm1', role: 'manufacturer' }
const asgn = { mid: 'm1' }

describe('what each role may do', () => {
  test('only admins edit the plan; manufacturers manage materials, buyers do not', () => {
    expect(capsFor(admin).editPlan).toBe(true)
    expect(capsFor(mfr).editPlan).toBe(false)
    expect(capsFor(buyer).editPlan).toBe(false)
    expect(capsFor(mfr).manageMaterials).toBe(true)
    expect(capsFor(buyer).manageMaterials).toBe(false)
  })

  test('a manufacturer writes only its own split', () => {
    expect(canWriteStage(mfr, asgn, { name: 'Cutting' })).toBe(true)
    expect(canWriteStage(mfr, { mid: 'someone-else' }, { name: 'Cutting' })).toBe(false)
  })

  test('a buyer writes only a stage they own, and never the Delivery step', () => {
    expect(canWriteStage(buyer, asgn, { name: 'PP Approval', responsibleId: 'b1' })).toBe(true)
    expect(canWriteStage(buyer, asgn, { name: 'PP Approval', responsibleId: 'other' })).toBe(false)
    expect(canWriteStage(buyer, asgn, { name: 'Delivery', isDelivery: true, responsibleId: 'b1' })).toBe(false)
  })

  test('only admins and the split owner set the overall status', () => {
    expect(canSetAssignmentStatus(admin, asgn)).toBe(true)
    expect(canSetAssignmentStatus(mfr, asgn)).toBe(true)
    expect(canSetAssignmentStatus(mfr, { mid: 'x' })).toBe(false)
    expect(canSetAssignmentStatus(buyer, asgn)).toBe(false)
  })

  test('no user means no access', () => {
    expect(canWriteStage(null, asgn, {})).toBe(false)
  })
})

// ── The standalone product ──────────────────────────────────────────────────────────────────────
const S = { platformMode: 'standalone' }
const sBuyer = { ...S, id: 'b1', role: 'buyer', orgRole: 'owner' }
const sMfr = { ...S, id: 'm1', role: 'manufacturer', orgRole: 'owner' }
const sMaster = { ...S, id: 'a1', role: 'admin', adminType: 'master' }
const sAdmin = { ...S, id: 'a2', role: 'admin', adminType: 'user' }
// A master admin looking at a company: the session is the company's, plus who is really behind it.
const viewing = (company, extra = {}) => ({ ...company, viewAsBy: 'a1', viewAsByName: 'Master', ...extra })

describe('the standalone product: brands and manufacturers create their own work', () => {
  test('companies can create orders; in the Tradio portal only Tradio staff can', () => {
    expect(capsFor(sBuyer).createOrders).toBe(true)
    expect(capsFor(sMfr).createOrders).toBe(true)
    expect(capsFor({ id: 'b1', role: 'buyer' }).createOrders).toBe(false)
    expect(capsFor({ id: 'm1', role: 'manufacturer' }).createOrders).toBe(false)
    expect(capsFor(admin).createOrders).toBe(true)
  })

  test('role-level edit, delete, assign and plan caps stay admin-only, so a call site that forgets to ask per order fails closed', () => {
    for (const u of [sBuyer, sMfr]) {
      const c = capsFor(u)
      expect([c.editOrders, c.deleteOrders, c.assignManufacturers, c.editPlan, c.overrideStage, c.uploadProductPhoto]).toEqual([false, false, false, false, false, false])
    }
    expect(capsFor(sAdmin).editOrders).toBe(true)
    expect(capsFor(sAdmin).overrideStage).toBe(false)
    expect(capsFor(sMaster).overrideStage).toBe(true)
  })

  test('a manufacturer may also upload reference documents; in the Tradio portal only admins and buyers do', () => {
    expect(capsFor(sMfr).uploadReferenceDocs).toBe(true)
    expect(capsFor(mfr).uploadReferenceDocs).toBe(false)
  })

  test('only the master admin sees the company directory and User Setup; only a company sees its Company page', () => {
    expect(capsFor(sMaster).seeViewerHome).toBe(true)
    expect(capsFor(sAdmin).seeViewerHome).toBe(false)
    expect(capsFor(admin).seeViewerHome).toBe(false)                  // the Tradio portal has no viewer home
    expect(capsFor(sMaster).seeUserSetup).toBe(true)
    expect(capsFor(sAdmin).seeUserSetup).toBe(false)
    expect(capsFor(sBuyer).seeCompanyPage).toBe(true)
    expect(capsFor(buyer).seeCompanyPage).toBe(false)
    expect(capsFor(sMaster).seeCompanyPage).toBe(false)
  })

  test('suppliers and purchase orders: a factory\'s own, in the standalone product only; read-only while merely viewed', () => {
    expect(capsFor(sMfr).seeProcurement).toBe(true)
    expect(capsFor(sMfr).manageProcurement).toBe(true)
    expect(capsFor(mfr).seeProcurement).toBe(false)                   // the Tradio portal
    for (const u of [sBuyer, sAdmin, sMaster]) { expect(capsFor(u).seeProcurement).toBe(false); expect(capsFor(u).manageProcurement).toBe(false) }
    expect(capsFor(viewing(sMfr)).seeProcurement).toBe(true)          // the master admin sees what the factory sees...
    expect(capsFor(viewing(sMfr)).manageProcurement).toBe(false)      // ...but cannot change it
    expect(capsFor({ ...viewing(sMfr), actingFor: true }).manageProcurement).toBe(true)
  })

  test('bills of materials are a factory\'s own; cost sheets have two sides: the factory prepares, the brand reviews and approves', () => {
    const c = u => capsFor(u)
    expect([c(sMfr).seeBom, c(sMfr).manageBom, c(sMfr).seeCosting, c(sMfr).manageCosting, c(sMfr).commentCosting, c(sMfr).approveCosting]).toEqual([true, true, true, true, true, false])
    expect([c(sBuyer).seeBom, c(sBuyer).manageBom, c(sBuyer).seeCosting, c(sBuyer).manageCosting, c(sBuyer).commentCosting, c(sBuyer).approveCosting]).toEqual([false, false, true, false, true, true])
    for (const u of [sAdmin, sMaster, mfr, buyer]) for (const k of ['seeBom', 'manageBom', 'seeCosting', 'manageCosting', 'commentCosting', 'approveCosting']) expect(c(u)[k], `${u.role} ${k}`).toBe(false)
    // looked at by Tradio's master admin: they see what the company sees and can change nothing, approving included
    for (const company of [sMfr, sBuyer]) {
      const v = c(viewing(company))
      expect(v.seeCosting).toBe(true)
      expect([v.manageBom, v.manageCosting, v.commentCosting, v.approveCosting]).toEqual([false, false, false, false])
    }
  })

  test('only a company\'s owner changes Tradio\'s access, and never from inside a view-as session', () => {
    expect(capsFor(sMfr).changeTradioAccess).toBe(true)
    expect(capsFor({ ...sMfr, orgRole: 'member' }).changeTradioAccess).toBe(false)
    expect(capsFor(viewing(sMfr)).changeTradioAccess).toBe(false)
  })

  test('home is the company directory for the master admin, the dashboard for everyone else', () => {
    expect(homeViewFor(sMaster)).toBe('viewer')
    expect(homeViewFor(sAdmin)).toBe('dashboard')
    expect(homeViewFor(sMfr)).toBe('dashboard')
    expect(homeViewFor(admin)).toBe('dashboard')
  })
})

describe('view as is read-only until acting for', () => {
  test('a read-only view turns every write capability off, however the company could normally write', () => {
    const c = capsFor(viewing(sMfr))
    expect(c.viewOnly).toBe(true)
    for (const k of ['createOrders', 'editOrders', 'deleteOrders', 'assignManufacturers', 'editPlan', 'overrideStage', 'manageMaterials', 'manageChecklist', 'uploadStageEvidence', 'uploadProductPhoto', 'uploadReferenceDocs', 'submitRequirement', 'manageCertificates'])
      expect(c[k], k).toBe(false)
    const b = capsFor(viewing(sBuyer))
    expect(b.createOrders).toBe(false)
    expect(b.submitRequirement).toBe(false)
  })

  test('acting for an enabled manufacturer restores that manufacturer\'s own powers', () => {
    const acting = viewing(sMfr, { actingFor: true })
    expect(isViewOnly(acting)).toBe(false)
    expect(capsFor(acting).manageMaterials).toBe(true)
    expect(capsFor(acting).createOrders).toBe(true)
    expect(canWriteStage(acting, asgn, { name: 'Cutting' })).toBe(true)
  })

  test('stage and status writes are refused in a read-only view', () => {
    const v = viewing(sMfr)
    expect(canWriteStage(v, { mid: 'm1' }, { name: 'Cutting' })).toBe(false)
    expect(canSetAssignmentStatus(v, { mid: 'm1' })).toBe(false)
    expect(canEditPlan(v, { mid: 'm1' })).toBe(false)
  })

  test('the Tradio portal\'s sandbox view-as is not read-only (it has full powers as the viewed user)', () => {
    const sandbox = { ...mfr, viewAsBy: 'a1', actingFor: true }
    expect(isViewOnly(sandbox)).toBe(false)
    expect(isViewOnly({ ...mfr, viewAsBy: 'a1' })).toBe(false)   // not standalone, so the rule never applies
  })
})

describe('per-order rules (standalone)', () => {
  const byBrand = { createdBy: 'b1', createdByRole: 'buyer', buyerCompany: 'Zara India' }
  const byMfr = { createdBy: 'm1', createdByRole: 'manufacturer', assignments: [{ mid: 'm1', mfrCompany: 'Tiruppur Textiles' }] }
  const legacy = { createdBy: null, createdByRole: null }

  test('the creating company edits and deletes; the other side does not', () => {
    expect(orderCaps(sBuyer, byBrand)).toMatchObject({ edit: true, remove: true, uploadPhoto: true, createdByYou: true })
    expect(orderCaps(sMfr, byBrand)).toMatchObject({ edit: false, remove: false, createdByYou: false })
    expect(orderCaps(sMfr, byMfr)).toMatchObject({ edit: true, remove: true, createdByYou: true })
    expect(orderCaps(sBuyer, byMfr)).toMatchObject({ edit: false, remove: false })
  })

  test('only a brand assigns manufacturers, and only on an order it created', () => {
    expect(orderCaps(sBuyer, byBrand).assign).toBe(true)
    expect(orderCaps(sMfr, byMfr).assign).toBe(false)
    expect(orderCaps(sBuyer, byMfr).assign).toBe(false)
    expect(orderCaps(sBuyer, legacy).assign).toBe(false)
  })

  test('an order from before creators were recorded is Tradio\'s: companies cannot change it, staff can', () => {
    expect(orderCaps(sBuyer, legacy).edit).toBe(false)
    expect(orderCaps(sMfr, legacy).edit).toBe(false)
    expect(orderCaps(sAdmin, legacy)).toMatchObject({ edit: true, assign: true })
  })

  test('a teammate counts as the company: ids are compared as the server compares them', () => {
    expect(orderCaps({ ...sBuyer, actorId: 'someone-else' }, byBrand).edit).toBe(true)
    expect(createdByUser(sBuyer, { createdBy: 'b1', createdByRole: 'manufacturer' })).toBe(false)   // same id, wrong role
  })

  test('in the Tradio portal no company edits anything', () => {
    expect(orderCaps({ id: 'b1', role: 'buyer' }, byBrand).edit).toBe(false)
    expect(orderCaps(admin, legacy).edit).toBe(true)
  })

  test('nothing in a read-only view', () => {
    expect(orderCaps(viewing(sBuyer), byBrand)).toMatchObject({ edit: false, remove: false, assign: false })
  })

  test('a split\'s own manufacturer edits its plan; no one else but Tradio staff', () => {
    expect(canEditPlan(sMfr, { mid: 'm1' })).toBe(true)
    expect(canEditPlan(sMfr, { mid: 'other' })).toBe(false)
    expect(canEditPlan(sBuyer, { mid: 'm1' })).toBe(false)
    expect(canEditPlan(sAdmin, { mid: 'm1' })).toBe(true)
    expect(canEditPlan(mfr, asgn)).toBe(false)      // the Tradio portal
    expect(canEditPlan(null, asgn)).toBe(false)
  })

  test('master orders follow the same rule', () => {
    expect(canEditMasterOrder(sBuyer, { createdBy: 'b1', createdByRole: 'buyer' })).toBe(true)
    expect(canEditMasterOrder(sBuyer, { createdBy: 'm1', createdByRole: 'manufacturer' })).toBe(false)
    expect(canEditMasterOrder(sAdmin, { createdBy: null })).toBe(true)
    expect(canEditMasterOrder({ id: 'b1', role: 'buyer' }, { createdBy: 'b1', createdByRole: 'buyer' })).toBe(false)
  })
})

describe('who created an order, for display', () => {
  test('names the company, says "you" for your own, and Tradio for older orders', () => {
    expect(orderOwner({ createdBy: 'b1', createdByRole: 'buyer', buyerCompany: 'Zara India' }, sBuyer)).toMatchObject({ role: 'buyer', mine: true, company: 'Zara India' })
    expect(orderOwner({ createdBy: 'b1', createdByRole: 'buyer', buyerCompany: 'Zara India' }, sMfr)).toMatchObject({ mine: false, company: 'Zara India' })
    expect(orderOwner({ createdBy: 'm1', createdByRole: 'manufacturer', assignments: [{ mid: 'm1', mfrCompany: 'Tiruppur Textiles' }] }, sBuyer)).toMatchObject({ role: 'manufacturer', mine: false, company: 'Tiruppur Textiles' })
    expect(orderOwner({ createdBy: null, createdByRole: null }, sBuyer)).toMatchObject({ role: 'admin', company: 'Tradio' })
  })

  test('the Tradio portal shows no creator at all: every order is Tradio\'s there', () => {
    expect(orderOwner({ createdBy: 'b1', createdByRole: 'buyer' }, buyer)).toBeNull()
  })
})
