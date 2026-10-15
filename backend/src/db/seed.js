/**
 * Tradio — MongoDB Seed Script  ⚠️ SANDBOX ONLY — never run against real data
 * Run: npm run seed:sandbox   (loads backend/.env.sandbox — see db-name guard below)
 */
import 'dotenv/config'

if (process.env.NODE_ENV === 'production') {
  console.error('[seed] Refusing to run in production. Set NODE_ENV=development.')
  process.exit(1)
}
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import { connectDB } from './index.js'
import { User }         from '../models/User.js'
import { Order, DEFAULT_STAGE_NAMES } from '../models/Order.js'
import { Document }     from '../models/Document.js'
import { Notification } from '../models/Notification.js'
import { AuditLog }     from '../models/AuditLog.js'
import { InboundMessage } from '../models/InboundMessage.js'
import { MasterOrder }  from '../models/MasterOrder.js'
import { Organization } from '../models/Organization.js'
import { Partnership }  from '../models/Partnership.js'
import { Counter }      from '../models/Counter.js'
import { ensureOrgForUser } from '../lib/orgs.js'
import { backfillPartnerships } from '../lib/migrate.js'
import { makeDeliveryStage } from '../lib/stageMath.js'
import { Supplier } from '../models/Supplier.js'
import { SupplierItem } from '../models/SupplierItem.js'
import { PurchaseOrder } from '../models/PurchaseOrder.js'
import { gstinCheckChar } from '../lib/gst.js'
import { Bom } from '../models/Bom.js'
import { CostSheet } from '../models/CostSheet.js'
import { computeCostSheet, linesFromBom } from '../lib/costing.js'
import { weightedConsumption } from '../lib/bomMath.js'
import { computeTotals } from '../lib/poMath.js'
import { taxModeFor } from '../lib/gst.js'
import { syncOnSend, syncOnReceive } from '../lib/poSync.js'
import { renderPurchaseOrderPdf } from '../lib/pdf/po.js'
import { fiscalYearCode } from '../lib/fiscalYear.js'
import { InventoryItem } from '../models/InventoryItem.js'
import { StockLedger } from '../models/StockLedger.js'
import { Grn } from '../models/Grn.js'
import { StockIssue } from '../models/StockIssue.js'
import { Attachment } from '../models/Attachment.js'
import { JobWork } from '../models/JobWork.js'
import { SpecSheet } from '../models/SpecSheet.js'
import { itemKey } from '../lib/inventory/stock.js'
import { renderGrnPdf } from '../lib/pdf/grn.js'
import { renderJobworkChallanPdf } from '../lib/pdf/jobwork.js'

// This script deletes every User/Order/Document/Notification/AuditLog in
// whatever database MONGO_DB_URI resolves to, then inserts fake data. Local
// dev and production share one Atlas cluster, so a name check is the only
// thing standing between "reset my sandbox" and "delete every real order."
// Allowlist (must match the sandbox name), not a denylist (must not match
// prod) — this only needs to know its own name, not prod's, and stays safe
// even if prod's resolved db name ever changes. Same discipline as
// tests/helpers/db.js's host guard for the automated test suite.
const SANDBOX_DB_NAME = 'textilmarkt_sandbox'

const h = pw => bcrypt.hashSync(pw, 10)

// Builds one assignment's stages[] from a name list + qty default + sparse,
// index-keyed overrides — every field on the current stageSchema is
// available to override (kind/status/dates/materials/items/etc.), unset
// ones fall back to sane quantity-stage-not-started defaults.
const mkStages = (names, qty, overrides = {}) =>
  names.map((name, i) => {
    const o = overrides[i] || {}
    return {
      name,
      // The last default step is the mandatory Delivery step: a milestone, flagged so closing it delivers the split.
      kind: o.kind || (name === 'Delivery' ? 'milestone' : 'quantity'),
      isDelivery: name === 'Delivery',
      status: o.status || null,
      unitsDone: o.unitsDone ?? 0,
      totalUnits: o.totalUnits ?? (name === 'Delivery' ? 1 : qty),
      startDate: o.startDate ?? null,
      eta: o.eta ?? null,
      baselineEta: o.baselineEta ?? o.eta ?? null,
      actualEnd: o.actualEnd ?? null,
      description: o.description || '',
      responsibleId: o.responsibleId || null,
      blocked: o.blocked || false,
      blockedReason: o.blockedReason || '',
      updates: o.updates || [],
      materials: o.materials || [],
      items: o.items || [],
      note: o.note || '',
    }
  })

async function seed() {
  if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] seed.js must never run in production. Aborting.')
    process.exit(1)
  }
  await connectDB()

  const dbName = mongoose.connection.name
  if (dbName !== SANDBOX_DB_NAME) {
    console.error(`[FATAL] seed.js refuses to run against database "${dbName}" - expected "${SANDBOX_DB_NAME}".`)
    console.error('[FATAL] This script deletes every User/Order/Document in the target database.')
    console.error('[FATAL] Run it via `npm run seed:sandbox` (loads backend/.env.sandbox), never `npm run dev`/plain `.env`.')
    await mongoose.disconnect().catch(() => {})
    process.exit(1)
  }

  await Promise.all([
    User.deleteMany({}),
    Order.deleteMany({}),
    Document.deleteMany({}),
    Notification.deleteMany({}),
    AuditLog.deleteMany({}),
    InboundMessage.deleteMany({}),
    // The standalone product's data: companies, who works with whom, and the ID counters. Master
    // orders reference the users that were just deleted, so they go too.
    Organization.deleteMany({}),
    Partnership.deleteMany({}),
    Counter.deleteMany({}),
    MasterOrder.deleteMany({}),
    // The standalone modules' data hangs off those companies, so it goes too.
    Supplier.deleteMany({}), SupplierItem.deleteMany({}), PurchaseOrder.deleteMany({}), Bom.deleteMany({}), SpecSheet.deleteMany({}), CostSheet.deleteMany({}),
    InventoryItem.deleteMany({}), StockLedger.deleteMany({}), Grn.deleteMany({}), StockIssue.deleteMany({}), Attachment.deleteMany({}), JobWork.deleteMany({}),
  ])
  console.log(`Collections cleared in sandbox db "${dbName}".`)

  // ── Users ──────────────────────────────────────────────────────────────────
  const users = await User.insertMany([
    { email: 'master@tradio.com', passwordHash: h('Master@123'), role: 'admin',        adminType: 'master', company: 'Tradio HQ',         name: 'Arun Mehta',    phone: '+91-9900001111', code: 'TRD', isActive: true, mustChangePw: false },
    { email: 'ops@tradio.com',    passwordHash: h('Ops@12345'),  role: 'admin',        adminType: 'user',   company: 'Tradio HQ',         name: 'Deepa Nair',    phone: '+91-9900002222', code: 'TRD', isActive: true, mustChangePw: false },
    { email: 'buyer@zara.com',    passwordHash: h('Buyer@123'),  role: 'buyer',        adminType: null,     company: 'Zara India',        name: 'Sarah Johnson', phone: '+91-9876541001', code: 'ZAR', isActive: true, mustChangePw: false },
    { email: 'buyer@hm.com',      passwordHash: h('Buyer@123'),  role: 'buyer',        adminType: null,     company: 'H&M Sourcing',      name: 'Emma Wilson',   phone: '+91-9876542002', code: 'HMX', isActive: true, mustChangePw: false },
    { email: 'mfr@tiruppur.com',  passwordHash: h('Mfr@12345'),  role: 'manufacturer', adminType: null,     company: 'Tiruppur Textiles', name: 'Raj Kumar',     phone: '+91-9876543003', code: 'TPR', isActive: true, mustChangePw: false },
    { email: 'mfr@blr.com',       passwordHash: h('Mfr@12345'),  role: 'manufacturer', adminType: null,     company: 'Bangalore Fabrics', name: 'Priya Sharma',  phone: '+91-9876544004', code: 'BLR', isActive: true, mustChangePw: false },
  ])
  const [master, ops, zaraBuyer, hmBuyer, tiruppur, blr] = users
  console.log(`Users seeded: ${users.length}`)

  // ── Orders ─────────────────────────────────────────────────────────────────
  // Dates anchored around Jun–Nov 2026 so the sandbox reads as "live" against
  // today's real calendar date instead of showing everything as ancient history.
  await Order.insertMany([
    {
      // Single-assignment, on-plan example — quantity stages mid-production,
      // one checklist stage (single colourway → one lab dip), one milestone,
      // a materials line, a responsible-person update thread, and a small
      // real slip on Knitting (baselineEta vs eta) to show variance.
      _id: 'ZAR-TPR-TSHRT-SS26-001',
      buyerId: zaraBuyer._id, product: 'Classic T-Shirt', category: 'TSHRT', season: 'SS26',
      totalQty: 5000, delivery: new Date('2026-10-05'), createdAt: new Date('2026-07-01'),
      assignments: [{
        mfrId: tiruppur._id, qty: 5000, status: 'Processing', sub: 'M1',
        note: '40% knitting complete, on track', updatedAt: new Date('2026-08-16'),
        stages: mkStages(DEFAULT_STAGE_NAMES, 5000, {
          0: { kind: 'checklist', status: 'done', startDate: '2026-07-05', eta: '2026-07-10', baselineEta: '2026-07-10', actualEnd: '2026-07-12',
               description: 'Single colourway - one round of lab dip needed.',
               items: [{ name: 'Lab Dip - Approved', status: 'done', plannedDate: '2026-07-10', dueDate: '2026-07-10', doneDate: '2026-07-12' }] },
          1: { kind: 'milestone', status: 'done', startDate: '2026-07-12', eta: '2026-07-20', baselineEta: '2026-07-18', actualEnd: '2026-07-19' },
          2: { status: 'done', unitsDone: 5000, totalUnits: 5000, startDate: '2026-07-15', eta: '2026-07-25', baselineEta: '2026-07-25', actualEnd: '2026-07-24',
               responsibleId: ops._id,
               materials: [
                 { name: '100% Cotton Jersey Fabric', requiredQty: 1200, unit: 'kg', supplier: 'Sri Lakshmi Mills', poNumber: 'PO-TPR-1187', expectedDate: '2026-07-20', status: 'received', orderedQty: 1200, receivedQty: 1200 },
                 { name: 'Woven Neck Label',           requiredQty: 5000, unit: 'pcs', supplier: 'Label Craft Co',    poNumber: 'PO-TPR-1188', expectedDate: '2026-07-22', status: 'ordered',  orderedQty: 5000, receivedQty: 0 },
               ],
               updates: [{ text: 'Fabric roll received, trims still a few days out.', byUser: ops._id, at: new Date('2026-07-24T10:00:00') }] },
          3: { unitsDone: 3500, totalUnits: 5000, status: 'in_progress', startDate: '2026-07-25', eta: '2026-08-15', baselineEta: '2026-08-08',
               description: 'Circular knit, single colourway.' },
          4:  { startDate: '2026-08-16', eta: '2026-08-22' },
          5:  { startDate: '2026-08-23', eta: '2026-08-27' },
          6:  { startDate: '2026-08-28', eta: '2026-09-02' },
          7:  { startDate: '2026-09-03', eta: '2026-09-15' },
          8:  { startDate: '2026-09-16', eta: '2026-09-20' },
          9:  { startDate: '2026-09-21', eta: '2026-09-25' },
          10: { kind: 'milestone', startDate: '2026-09-26', eta: '2026-09-28' },
          11: { kind: 'milestone', startDate: '2026-09-29', eta: '2026-10-02' },
        }),
      }],
    },
    {
      // Split order + colourway showcase: two lab dips (one done, one still
      // pending — shows the checklist close-gate in action), a blocked
      // milestone stage, and a slipped delivery promise with a callout.
      _id: 'HMX-BLR-JEANS-FW26-001',
      buyerId: hmBuyer._id, product: 'Slim Fit Jeans', category: 'JEANS', season: 'FW26',
      totalQty: 3000, delivery: new Date('2026-11-20'), createdAt: new Date('2026-07-10'),
      baselineDelivery: new Date('2026-11-10'),
      colourways: [{ name: 'Indigo Wash', code: 'IDG' }, { name: 'Black Wash', code: 'BLK' }],
      callout: 'Lab dip approval on Black Wash delayed a week - delivery pushed from Nov 10 to Nov 20.',
      assignments: [
        {
          mfrId: blr._id, qty: 2000, status: 'Processing', sub: 'M1',
          note: 'Sourcing denim fabric', updatedAt: new Date('2026-08-02'),
          stages: mkStages(DEFAULT_STAGE_NAMES, 2000, {
            0: { kind: 'checklist', status: 'in_progress', startDate: '2026-08-01', eta: '2026-08-17', baselineEta: '2026-08-10',
                 description: 'One lab dip per colourway.',
                 items: [
                   { name: 'Lab Dip - Indigo Wash', colourway: 'Indigo Wash', status: 'done',    plannedDate: '2026-08-10', dueDate: '2026-08-10', doneDate: '2026-08-09' },
                   { name: 'Lab Dip - Black Wash',  colourway: 'Black Wash',  status: 'pending', plannedDate: '2026-08-10', dueDate: '2026-08-17' },
                 ] },
            1: { kind: 'milestone', startDate: '2026-08-18', eta: '2026-08-25' },
            2: { unitsDone: 800, totalUnits: 2000, status: 'in_progress', startDate: '2026-07-20', eta: '2026-08-05', baselineEta: '2026-08-05',
                 responsibleId: blr._id, description: 'Sourcing denim fabric.',
                 materials: [
                   { name: 'Denim Fabric 12oz',    requiredQty: 2400, unit: 'm',    supplier: 'Ahmedabad Denim Mills', poNumber: 'PO-BLR-2201', expectedDate: '2026-08-01', status: 'received', orderedQty: 2400, receivedQty: 2400 },
                   { name: 'Rivets & Buttons Set', requiredQty: 2000, unit: 'sets', supplier: 'Metal Trims Ltd',        poNumber: 'PO-BLR-2202', expectedDate: '2026-08-05', status: 'pending',  orderedQty: 0,    receivedQty: 0 },
                 ],
                 updates: [{ text: 'Denim fabric arrived, QC passed.', byUser: blr._id, at: new Date('2026-08-02T09:00:00') }] },
            4: { kind: 'milestone', blocked: true, blockedReason: 'Waiting on Black Wash lab dip sign-off before the bulk dye lot is booked.',
                 startDate: '2026-08-20', eta: '2026-08-28' },
          }),
        },
        {
          mfrId: tiruppur._id, qty: 1000, status: 'Processing', sub: 'M2',
          note: '', updatedAt: new Date('2026-07-10'),
          stages: mkStages(DEFAULT_STAGE_NAMES, 1000), // all stages not started
        },
      ],
    },
    {
      // Delayed — raw material shortage, blocked stage, updates thread, and
      // a real Actual-later-than-Planned variance on PP Sample.
      _id: 'ZAR-BLR-BEDSH-SS26-001',
      buyerId: zaraBuyer._id, product: 'Premium Bedsheet', category: 'BEDSH', season: 'SS26',
      totalQty: 2000, delivery: new Date('2026-09-10'), createdAt: new Date('2026-05-20'),
      baselineDelivery: new Date('2026-08-25'),
      callout: 'Raw material shortage - revised ETA pushed twice.',
      assignments: [{
        mfrId: blr._id, qty: 2000, status: 'Delayed', sub: 'M1',
        note: 'Raw material shortage - revised ETA Aug 20', updatedAt: new Date('2026-08-12'),
        stages: mkStages(DEFAULT_STAGE_NAMES, 2000, {
          0: { kind: 'milestone', status: 'done', startDate: '2026-06-01', eta: '2026-06-10', baselineEta: '2026-06-10', actualEnd: '2026-06-09' },
          1: { kind: 'milestone', status: 'done', startDate: '2026-06-11', eta: '2026-06-20', baselineEta: '2026-06-18', actualEnd: '2026-06-22' },
          2: { unitsDone: 1000, totalUnits: 2000, status: 'in_progress', blocked: true,
               blockedReason: 'Cotton yarn shortage from mill - partial delivery only.',
               startDate: '2026-06-21', eta: '2026-08-20', baselineEta: '2026-07-05',
               responsibleId: blr._id,
               materials: [
                 { name: 'Cotton Percale Fabric', requiredQty: 3000, unit: 'm', supplier: 'Coimbatore Textiles', poNumber: 'PO-BLR-1905', expectedDate: '2026-07-01', status: 'ordered', orderedQty: 3000, receivedQty: 1500, note: 'Second half of the lot delayed by mill - no new ETA yet.' },
               ],
               updates: [
                 { text: 'Only half the fabric lot arrived. Mill cites raw cotton shortage.', byUser: blr._id, at: new Date('2026-08-05T14:15:00') },
                 { text: 'Chasing mill daily. Revised ETA Aug 20 if nothing else slips.',      byUser: master._id, at: new Date('2026-08-12T09:30:00') },
               ] },
        }),
      }],
    },
    {
      // Near-complete — most stages done (actualEnd stamped throughout), one
      // milestone QC stage in progress with its own update thread.
      _id: 'HMX-TPR-POLO-SS26-001',
      buyerId: hmBuyer._id, product: 'Polo T-Shirt', category: 'TSHRT', season: 'SS26',
      totalQty: 4000, delivery: new Date('2026-08-25'), createdAt: new Date('2026-06-01'),
      assignments: [{
        mfrId: tiruppur._id, qty: 4000, status: 'Processing', sub: 'M1',
        note: 'QC ongoing, results expected tomorrow', updatedAt: new Date('2026-08-16'),
        stages: mkStages(DEFAULT_STAGE_NAMES, 4000, {
          0: { kind: 'checklist', status: 'done', startDate: '2026-06-05', eta: '2026-06-10', baselineEta: '2026-06-10', actualEnd: '2026-06-10',
               items: [{ name: 'Lab Dip - Approved', status: 'done', plannedDate: '2026-06-10', dueDate: '2026-06-10', doneDate: '2026-06-10' }] },
          1: { kind: 'milestone', status: 'done', unitsDone: 0, startDate: '2026-06-11', eta: '2026-06-18', baselineEta: '2026-06-18', actualEnd: '2026-06-17' },
          2: { status: 'done', unitsDone: 4000, totalUnits: 4000, startDate: '2026-06-19', eta: '2026-06-25', baselineEta: '2026-06-25', actualEnd: '2026-06-24' },
          3: { status: 'done', unitsDone: 4000, totalUnits: 4000, startDate: '2026-06-26', eta: '2026-07-02', baselineEta: '2026-07-02', actualEnd: '2026-07-02' },
          4: { status: 'done', unitsDone: 4000, totalUnits: 4000, startDate: '2026-07-03', eta: '2026-07-09', baselineEta: '2026-07-09', actualEnd: '2026-07-08' },
          5: { status: 'done', unitsDone: 4000, totalUnits: 4000, startDate: '2026-07-10', eta: '2026-07-16', baselineEta: '2026-07-16', actualEnd: '2026-07-16' },
          6: { status: 'done', unitsDone: 4000, totalUnits: 4000, startDate: '2026-07-17', eta: '2026-07-23', baselineEta: '2026-07-23', actualEnd: '2026-07-22' },
          7: { status: 'done', unitsDone: 4000, totalUnits: 4000, startDate: '2026-07-24', eta: '2026-07-30', baselineEta: '2026-07-30', actualEnd: '2026-07-30' },
          8: { status: 'done', unitsDone: 4000, totalUnits: 4000, startDate: '2026-07-31', eta: '2026-08-06', baselineEta: '2026-08-06', actualEnd: '2026-08-05' },
          9: { status: 'done', unitsDone: 4000, totalUnits: 4000, startDate: '2026-08-07', eta: '2026-08-13', baselineEta: '2026-08-13', actualEnd: '2026-08-13' },
          10: { kind: 'milestone', status: 'in_progress', startDate: '2026-08-14', eta: '2026-08-17', baselineEta: '2026-08-17',
                responsibleId: master._id, description: 'Final QC before packing sign-off.',
                updates: [{ text: 'QC ongoing, results expected tomorrow.', byUser: master._id, at: new Date('2026-08-16T11:00:00') }] },
          11: { kind: 'milestone', startDate: '2026-08-18', eta: '2026-08-22' },
        }),
      }],
    },
  ])
  console.log('Orders seeded: 4')

  // ── Documents ──────────────────────────────────────────────────────────────
  await Document.insertMany([
    { type: 'compliance_cert', name: 'BSCI Audit Report 2025',     mfrId: tiruppur._id, orderId: null,                     issueDate: new Date('2025-06-01'), expiryDate: new Date('2026-11-01'), uploadedBy: tiruppur._id, issuer: 'BSCI Global',          version: 1, isActive: true },
    { type: 'compliance_cert', name: 'OEKO-TEX Standard 100',      mfrId: blr._id,      orderId: null,                     issueDate: new Date('2025-09-01'), expiryDate: new Date('2026-09-10'), uploadedBy: blr._id,      issuer: 'OEKO-TEX Association', version: 1, isActive: true },
    { type: 'PO',              name: 'Purchase Order ZAR-001',      mfrId: null,         orderId: 'ZAR-TPR-TSHRT-SS26-001', issueDate: new Date('2026-07-01'), expiryDate: null,                  uploadedBy: master._id,   issuer: 'Tradio',               version: 1, isActive: true },
    { type: 'tech_pack',       name: 'Tech Pack – Classic T-Shirt', mfrId: null,         orderId: 'ZAR-TPR-TSHRT-SS26-001', issueDate: new Date('2026-07-01'), expiryDate: null,                  uploadedBy: master._id,   issuer: 'Zara India',           version: 1, isActive: true },
    { type: 'cost_sheet',      name: 'Finalized Cost Sheet',        mfrId: null,         orderId: 'ZAR-TPR-TSHRT-SS26-001', issueDate: new Date('2026-07-02'), expiryDate: null,                  uploadedBy: master._id,   issuer: 'Tradio',               version: 1, isActive: true },
    { type: 'factory_audit',   name: 'SA8000 Social Audit',         mfrId: tiruppur._id, orderId: null,                     issueDate: new Date('2025-11-01'), expiryDate: new Date('2026-11-01'), uploadedBy: tiruppur._id, issuer: 'Bureau Veritas',       version: 1, isActive: true },
  ])
  console.log('Documents seeded: 6')

  // ── Notifications ──────────────────────────────────────────────────────────
  const TODAY = new Date().toISOString().slice(0, 10)
  await Notification.insertMany([
    { toUser: zaraBuyer._id,  type: 'status', msg: 'ZAR-BLR-BEDSH-SS26-001 marked as Delayed',              orderId: 'ZAR-BLR-BEDSH-SS26-001',  isRead: false, createdAt: new Date('2026-08-12T14:15:00') },
    { toUser: tiruppur._id,   type: 'order',  msg: 'New order assigned: ZAR-TPR-TSHRT-SS26-001',             orderId: 'ZAR-TPR-TSHRT-SS26-001',  isRead: false, createdAt: new Date('2026-07-01T09:00:00') },
    { toUser: master._id,     type: 'alert',  msg: 'OEKO-TEX cert expiring in 25 days (Bangalore Fabrics)',  orderId: null, isRead: false, createdAt: new Date(TODAY) },
    { toUser: ops._id,        type: 'alert',  msg: 'OEKO-TEX cert expiring in 25 days (Bangalore Fabrics)',  orderId: null, isRead: false, createdAt: new Date(TODAY) },
    { toUser: hmBuyer._id,    type: 'order',  msg: 'New order assigned: HMX-BLR-JEANS-FW26-001',             orderId: 'HMX-BLR-JEANS-FW26-001',  isRead: false, createdAt: new Date('2026-07-10T11:30:00') },
    { toUser: blr._id,        type: 'alert',  msg: 'OEKO-TEX Standard 100 expires in 25 days - please renew', orderId: null, isRead: false, createdAt: new Date(TODAY) },
  ])
  console.log('Notifications seeded: 6')

  // ── Audit Logs ─────────────────────────────────────────────────────────────
  await AuditLog.insertMany([
    { byUser: master._id,   action: 'Order Created',     detail: 'ZAR-TPR-TSHRT-SS26-001 created and assigned to Tiruppur Textiles', createdAt: new Date('2026-07-01T09:00:00') },
    { byUser: master._id,   action: 'Order Created',     detail: 'HMX-BLR-JEANS-FW26-001 split across 2 manufacturers',              createdAt: new Date('2026-07-10T11:30:00') },
    { byUser: master._id,   action: 'Document Uploaded', detail: 'PO & Tech Pack uploaded for ZAR-TPR-TSHRT-SS26-001',               createdAt: new Date('2026-07-01T09:15:00') },
    { byUser: tiruppur._id, action: 'Status Update',     detail: 'ZAR-TPR-TSHRT-SS26-001-M1: 3500 units knitted',                     createdAt: new Date('2026-08-14T10:30:00') },
    { byUser: blr._id,      action: 'Status Update',     detail: 'ZAR-BLR-BEDSH-SS26-001-M1: Marked Delayed - raw material shortage',  createdAt: new Date('2026-08-12T14:15:00') },
    { byUser: tiruppur._id, action: 'Document Uploaded', detail: 'SA8000 Social Audit uploaded',                                       createdAt: new Date('2025-11-05T10:00:00') },
  ])
  console.log('Audit logs seeded: 6')

  // ── Organizations ──────────────────────────────────────────────────────────
  // Every buyer and manufacturer is a company. Tradio manages Tiruppur Textiles (it may act for it);
  // Bangalore Fabrics is a standalone customer that Tradio can only view. Partnerships come from
  // the orders above: whoever works on an order together is connected.
  const orgOf = {}
  for (const u of [zaraBuyer, hmBuyer, tiruppur, blr]) orgOf[u.code] = await ensureOrgForUser(u)
  await Organization.updateOne({ _id: orgOf.TPR._id }, { $set: { tradioEnabled: true } })
  await backfillPartnerships()
  console.log('Organizations seeded: 4 (Tiruppur Textiles is Tradio-enabled)')

  // ── Standalone product extras (SEED_STANDALONE=1) ─────────────────────────
  // A teammate, a manufacturer that switched Tradio's view access off, and orders created by the
  // brand and by the manufacturer themselves, so every rule can be tried by hand. Run the backend
  // with PLATFORM_MODE=standalone to see the standalone behaviour.
  if (process.env.SEED_STANDALONE === '1') {
    const [anita, surat] = await User.insertMany([
      { email: 'anita@tiruppur.com', passwordHash: h('Mfr@12345'), role: 'manufacturer', adminType: null, company: 'Tiruppur Textiles', name: 'Anita Rao (store)', phone: '+91-9876543033', code: 'TPR', isActive: true, mustChangePw: false, orgId: orgOf.TPR._id, orgRole: 'member' },
      { email: 'mfr@surat.com',      passwordHash: h('Mfr@12345'), role: 'manufacturer', adminType: null, company: 'Surat Mills',       name: 'Vikram Shah',       phone: '+91-9876545005', code: 'SRT', isActive: true, mustChangePw: false },
    ])
    const suratOrg = await ensureOrgForUser(surat)
    await Organization.updateOne({ _id: suratOrg._id }, { $set: { tradioCanView: false } })
    await Partnership.create({ brandOrgId: orgOf.ZAR._id, mfrOrgId: suratOrg._id, source: 'admin' })

    await MasterOrder.create({ _id: 'MO-ZAR-FW26-001', buyerId: zaraBuyer._id, orderName: 'Zara FW26 core range', season: 'FW26', createdBy: zaraBuyer._id, createdByRole: 'buyer' })
    const base = { season: 'FW26', delivery: new Date('2026-12-15'), baselineDelivery: new Date('2026-12-15'), createdAt: new Date('2026-10-01') }
    await Order.insertMany([
      { // Created by the brand, assigned to Tiruppur, with a plan the factory can now run.
        ...base, _id: 'ZAR-SWTSHT-FW26-001', masterOrderId: 'MO-ZAR-FW26-001', buyerId: zaraBuyer._id, product: 'Heavy sweatshirt', category: 'SWTSHT', totalQty: 3000,
        createdBy: zaraBuyer._id, createdByRole: 'buyer',
        assignments: [{ mfrId: tiruppur._id, qty: 3000, status: 'Processing', sub: 'M1', note: '', stages: mkStages(['Fabric Inhouse', 'Cutting', 'Delivery'], 3000, {
          0: { startDate: '2026-10-05', eta: null, baselineEta: '2026-10-20' }, 1: { startDate: '2026-10-21', baselineEta: '2026-11-05' }, 2: { kind: 'milestone', startDate: '2026-12-15', baselineEta: '2026-12-15' },
        }) }],
      },
      { // Created by Surat Mills for Zara itself, plan not built yet (just the Delivery step).
        ...base, _id: 'ZAR-JACKET-FW26-001', buyerId: zaraBuyer._id, product: 'Quilted jacket', category: 'JACKET', totalQty: 1200,
        createdBy: surat._id, createdByRole: 'manufacturer',
        assignments: [{ mfrId: surat._id, qty: 1200, status: 'Processing', sub: 'M1', note: '', stages: [makeDeliveryStage('2026-12-15')] }],
      },
    ])
    console.log('Standalone extras seeded: a teammate (anita@tiruppur.com), Surat Mills (Tradio view access OFF), a master order and 2 orders created by the parties themselves')
    await seedProcurement({ tiruppur, tprOrg: orgOf.TPR })
    await seedCosting({ tiruppur, tprOrg: orgOf.TPR, zaraBuyer, zaraOrg: orgOf.ZAR })
    await seedInventory({ tiruppur, tprOrg: orgOf.TPR })
  }

  console.log('\n✓ Sandbox seed complete.')
  await mongoose.disconnect()
}

// Tiruppur Textiles' supplier book and purchase orders: a draft, a sent one and one part received, with
// material lines on its sweatshirt order linked to them, so the whole procurement flow can be walked.
async function seedProcurement({ tiruppur, tprOrg }) {
  const gstin = (state, pan) => { const f = `${state}${pan}1Z`; return f + gstinCheckChar(f) }
  await Organization.updateOne({ _id: tprOrg._id }, { $set: { profile: {
    legalName: 'Tiruppur Textiles Pvt Ltd', gstin: gstin('33', 'AAPFU0939F'), pan: 'AAPFU0939F', address: 'Plot 22, SIDCO Industrial Estate',
    city: 'Tiruppur', pincode: '641604', stateCode: '33', phone: '+91 98765 43003', email: 'mfr@tiruppur.com',
  } } })
  const org = await Organization.findById(tprOrg._id).lean()

  const mk = (name, type, o = {}) => ({ ownerOrgId: tprOrg._id, name, type, createdBy: tiruppur._id, updatedBy: tiruppur._id, ...o })
  const [mill, dyer, rib, zips, labels, print] = await Supplier.insertMany([
    mk('Coimbatore Knit Fabrics', 'fabric_supplier', { email: 'sales@cknit.example', phone: '+91 98430 11223', gstin: gstin('33', 'AABCC1234D'), stateCode: '33', address: '14 Avinashi Road', city: 'Coimbatore', pincode: '641018', paymentTerms: '45 days from invoice', contacts: [{ name: 'Mr. Selvam', role: 'Sales', phone: '+91 98430 11223', email: 'selvam@cknit.example' }] }),
    mk('Salem Dyeing Works', 'dyer', { email: 'orders@salemdye.example', gstin: gstin('33', 'AAHCS5678E'), stateCode: '33', city: 'Salem', paymentTerms: '30 days' }),
    mk('Erode Rib and Collar', 'fabric_supplier', { email: 'erode.rib@example.com', gstin: gstin('33', 'AAFFE4321K'), stateCode: '33', city: 'Erode', paymentTerms: 'Advance 30%, balance on delivery' }),
    mk('YKK India (Mumbai depot)', 'trims_supplier', { email: 'trims@ykk.example', gstin: gstin('27', 'AAACY1111A'), stateCode: '27', city: 'Mumbai', paymentTerms: '60 days' }),
    mk('Tiruppur Label Works', 'trims_supplier', { email: 'labels@tlw.example', stateCode: '33', city: 'Tiruppur' }),
    mk('Surat Print House', 'other', { email: 'hello@suratprint.example', gstin: gstin('24', 'AAKCS9876M'), stateCode: '24', city: 'Surat', notes: 'Screen and digital printing' }),
  ])
  const item = (supplier, o) => ({ ownerOrgId: tprOrg._id, supplierId: supplier._id, ...o })
  const [fleece] = await SupplierItem.insertMany([
    item(mill, { name: 'Brushed fleece 280 GSM', category: 'fabric', unit: 'kg', defaultRate: 410, moq: 300, hsnCode: '600610', taxPct: 5, leadTimeDays: 12, specs: { composition: '80% cotton 20% polyester', gsm: 280, widthInches: 72, construction: 'brushed fleece' } }),
    item(mill, { name: 'Single jersey 180 GSM', category: 'fabric', unit: 'kg', defaultRate: 342.5, moq: 300, hsnCode: '600631', taxPct: 5, leadTimeDays: 10, specs: { composition: '100% cotton', gsm: 180, widthInches: 72, construction: 'single jersey' } }),
    item(rib, { name: 'Rib 2x2 collar and cuff', category: 'fabric', unit: 'kg', defaultRate: 520, moq: 50, hsnCode: '600632', taxPct: 5, specs: { composition: '95% cotton 5% elastane', construction: 'rib 2x2' } }),
    item(zips, { name: '5 inch metal zip, antique brass', category: 'trim', unit: 'pcs', defaultRate: 18.75, moq: 1000, hsnCode: '960719', taxPct: 18 }),
    item(labels, { name: 'Woven main label', category: 'trim', unit: 'pcs', defaultRate: 1.6, moq: 2000, hsnCode: '580710', taxPct: 12 }),
  ])

  // Material lines on the sweatshirt order's first step.
  await Order.updateOne({ _id: 'ZAR-SWTSHT-FW26-001' }, { $set: { 'assignments.0.stages.0.materials': [
    { name: 'Brushed fleece 280 GSM', requiredQty: 1200, unit: 'kg', status: 'pending', orderedQty: 0, receivedQty: 0, supplier: '', poNumber: '' },
    { name: 'Rib 2x2 collar and cuff', requiredQty: 150, unit: 'kg', status: 'pending', orderedQty: 0, receivedQty: 0, supplier: '', poNumber: '' },
  ] } })

  const fy = fiscalYearCode()
  const id = n => `PO-TPR-${fy}-${String(n).padStart(4, '0')}`
  const buyer = { name: 'Tiruppur Textiles Pvt Ltd', email: 'mfr@tiruppur.com', phone: '+91 98765 43003', gstin: org.profile.gstin, pan: 'AAPFU0939F', stateCode: '33', address: org.profile.address, city: 'Tiruppur', pincode: '641604' }
  const snap = s => ({ name: s.name, email: s.email || '', phone: s.phone || '', gstin: s.gstin || '', stateCode: s.stateCode || '', address: s.address || '', city: s.city || '', pincode: s.pincode || '', contactName: s.contacts?.[0]?.name || '' })
  const line = (n, desc, qty, unit, rate, taxPct, extra = {}) => ({ lineId: `5f0000000000000000000${String(n).padStart(3, '0')}`, description: desc, hsnCode: '', unit, qty, rate, discountPct: 0, taxPct, receivedQty: 0, note: '', ...extra })
  const build = (supplier, lines) => {
    const mode = taxModeFor(supplier.stateCode, '33')
    const calc = computeTotals(lines, mode)
    return { taxMode: calc.taxMode, totals: calc.totals, lines: lines.map((l, i) => ({ ...l, ...calc.lines[i] })) }
  }
  const draftAt = new Date('2026-10-10T10:00:00+05:30'), sentAt = new Date('2026-10-08T11:30:00+05:30')
  const stamp = (action, at, note = '') => ({ at, by: tiruppur._id, byName: tiruppur.name, action, note })

  const fleeceRef = { orderId: 'ZAR-SWTSHT-FW26-001', stageIndex: 0, materialIndex: 0, name: 'Brushed fleece 280 GSM' }
  const ribRef = { orderId: 'ZAR-SWTSHT-FW26-001', stageIndex: 0, materialIndex: 1, name: 'Rib 2x2 collar and cuff' }
  const defs = [
    { n: 1, supplier: mill, status: 'sent', at: sentAt, expectedDate: '2026-10-22', lines: [line(1, 'Brushed fleece 280 GSM, 72 in, 80/20 CVC', 1200, 'kg', 410, 5, { itemId: fleece._id, hsnCode: '600610', materialRef: fleeceRef })] },
    { n: 2, supplier: rib, status: 'partially_received', at: new Date('2026-10-05T16:00:00+05:30'), expectedDate: '2026-10-15', lines: [line(2, 'Rib 2x2 collar and cuff, matching', 150, 'kg', 520, 5, { hsnCode: '600632', materialRef: ribRef, receivedQty: 60 })] },
    { n: 3, supplier: zips, status: 'draft', at: draftAt, expectedDate: '2026-11-05', lines: [line(3, '5 inch metal zip, antique brass', 3000, 'pcs', 18.75, 18, { hsnCode: '960719' })] },
  ]
  for (const d of defs) {
    const priced = build(d.supplier, d.lines)
    const base = {
      _id: id(d.n), ownerOrgId: tprOrg._id, supplierId: d.supplier._id, supplierSnapshot: snap(d.supplier), buyerSnapshot: buyer, status: d.status,
      ...priced, expectedDate: d.expectedDate, paymentTerms: d.supplier.paymentTerms || '', terms: 'Goods must match the approved sample. Quote the PO number on the challan and invoice.',
      createdBy: tiruppur._id, createdAt: d.at, timeline: [stamp('Draft created', d.at)],
    }
    if (d.status === 'draft') { await PurchaseOrder.create(base); continue }
    const po = await PurchaseOrder.create({ ...base, sentAt: d.at, sentBy: tiruppur._id, sentTo: [d.supplier.email], timeline: [...base.timeline, stamp('Sent to supplier', d.at, `Emailed to ${d.supplier.email}`)] })
    const pdf = await renderPurchaseOrderPdf({ ...po.toObject(), status: 'sent' })
    const doc = await Document.create({ type: 'supplier_po', name: `Purchase order ${po._id}`, mfrId: tiruppur._id, orderId: null, issueDate: d.at, uploadedBy: tiruppur._id, issuer: buyer.name, poId: po._id, dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}`, fileName: `${po._id}.pdf`, fileSize: pdf.length, mimeType: 'application/pdf' })
    const received = po.lines.filter(l => l.receivedQty > 0)
    await PurchaseOrder.updateOne({ _id: po._id }, { $set: { documentId: doc._id }, ...(received.length ? { $push: { receipts: { at: new Date('2026-10-09T12:00:00+05:30'), by: tiruppur._id, note: 'Lorry 1', lines: received.map(l => ({ lineId: l.lineId, qty: l.receivedQty })) }, timeline: stamp('Goods received', new Date('2026-10-09T12:00:00+05:30'), '1 line: Lorry 1') } } : {}) })
    const fresh = await PurchaseOrder.findById(po._id).lean()
    await syncOnSend({ partyId: tiruppur._id, po: fresh, supplier: d.supplier })
    if (received.length) await syncOnReceive({ partyId: tiruppur._id, po: fresh, received: received.map(l => ({ line: fresh.lines.find(x => x.lineId === l.lineId), qty: l.receivedQty })) })
  }
  await Counter.updateOne({ _id: `po:${tprOrg._id}:${fy}` }, { $set: { seq: 3 } }, { upsert: true })
  console.log('Procurement seeded: 6 suppliers, 5 catalog items, 3 purchase orders (1 draft, 1 sent, 1 part received) for Tiruppur Textiles')
}

// Tiruppur's store: five items, two posted goods received notes (one against the part-received rib PO, one from a local
// shop with no PO), a draft note ready for the fleece lorry, and 20 kg of rib issued to the sweatshirt order. The zips
// are at nothing, below the level the factory keeps, so the "to buy" flag can be seen.
async function seedInventory({ tiruppur, tprOrg }) {
  const org = await Organization.findById(tprOrg._id).lean()
  const fy = fiscalYearCode()
  const mk = (name, unit, category, o = {}) => ({ ownerOrgId: tprOrg._id, name, unit, category, key: itemKey(name, unit), createdBy: tiruppur._id, ...o })
  const [fleece, rib, zip, label, polybag] = await InventoryItem.insertMany([
    mk('Brushed fleece 280 GSM', 'kg', 'fabric', { reorderLevel: 300, hsnCode: '600610' }),
    mk('Rib 2x2 collar and cuff', 'kg', 'fabric', { reorderLevel: 40, hsnCode: '600632' }),
    mk('5 inch metal zip, antique brass', 'pcs', 'trims', { reorderLevel: 1000, hsnCode: '960719' }),
    mk('Woven main label', 'pcs', 'packaging', { reorderLevel: 1500, hsnCode: '580710' }),
    mk('Polybag', 'pcs', 'packaging', { reorderLevel: 2000 }),
  ])
  const ribPo = await PurchaseOrder.findOne({ ownerOrgId: tprOrg._id, 'lines.description': /Rib 2x2/ }).lean()
  const fleecePo = await PurchaseOrder.findOne({ ownerOrgId: tprOrg._id, 'lines.description': /Brushed fleece/ }).lean()
  const erode = await Supplier.findOne({ ownerOrgId: tprOrg._id, name: 'Erode Rib and Collar' }).lean()
  const mill = await Supplier.findOne({ ownerOrgId: tprOrg._id, name: 'Coimbatore Knit Fabrics' }).lean()
  const lid = n => `5d0000000000000000000${String(n).padStart(3, '0')}`

  const post = async (n, at, g, lines) => {
    const number = `GRN-TPR-${fy}-${String(n).padStart(4, '0')}`
    const doc = { ownerOrgId: tprOrg._id, number, status: 'posted', source: 'web', createdBy: tiruppur._id, postedBy: tiruppur._id, postedAt: at, createdAt: at, receivedOn: at.toISOString().slice(0, 10), ...g, lines }
    const grn = await Grn.create(doc)
    const pdf = await renderGrnPdf(grn.toObject(), org, { receivedBy: tiruppur.name, poNumber: g.poId })
    const d = await Document.create({ type: 'goods_receipt', name: `Goods received note ${number}`, mfrId: tiruppur._id, orderId: null, issueDate: at, uploadedBy: tiruppur._id, issuer: g.supplierName, grnId: String(grn._id), dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}`, fileName: `${number}.pdf`, fileSize: pdf.length, mimeType: 'application/pdf' })
    await Grn.updateOne({ _id: grn._id }, { $set: { documentId: d._id } })
    await StockLedger.insertMany(lines.filter(l => l.qty - (l.rejectedQty || 0) > 0).map(l => ({
      ownerOrgId: tprOrg._id, itemId: l.itemId, location: 'store', type: 'receipt', qty: l.qty - (l.rejectedQty || 0), unit: l.unit, unitCost: l.rate || 0,
      refType: 'grn', refId: String(grn._id), refLineId: l.lineId, note: number, at, by: tiruppur._id, key: `grn:${grn._id}:${l.lineId}`,
    })))
    return grn
  }

  const at1 = new Date('2026-10-09T12:00:00+05:30'), at2 = new Date('2026-10-10T15:30:00+05:30')
  const ribLine = ribPo.lines[0]
  const g1 = await post(1, at1, { poId: ribPo._id, supplierId: erode._id, supplierName: erode.name, supplierGstin: erode.gstin, challanNo: 'ERB-2231', challanDate: '2026-10-09', vehicleNo: 'TN33 BC 4821', note: 'Lorry 1 of 2' },
    [{ lineId: lid(1), poLineId: ribLine.lineId, description: ribLine.description, itemId: rib._id, unit: 'kg', orderedQty: ribLine.qty, qty: 60, rejectedQty: 0, rate: 520, lot: 'R-77' }])
  await PurchaseOrder.updateOne({ _id: ribPo._id, 'receipts.0': { $exists: true } }, { $set: { 'receipts.0.grnId': String(g1._id) } })
  await post(2, at2, { supplierName: 'Sri Murugan Trims', challanNo: 'SM-1840' },
    [{ lineId: lid(2), description: 'Woven main label', itemId: label._id, unit: 'pcs', qty: 3000, rejectedQty: 0, rate: 1.6 },
     { lineId: lid(3), description: 'Polybag', itemId: polybag._id, unit: 'pcs', qty: 5000, rejectedQty: 200, rejectReason: 'torn seals', rate: 2.5 }])

  // Ready to receive: the fleece lorry is expected, the note is drafted from the PO.
  const fl = fleecePo.lines[0]
  await Grn.create({ ownerOrgId: tprOrg._id, status: 'draft', source: 'web', poId: fleecePo._id, supplierId: mill._id, supplierName: mill.name, supplierGstin: mill.gstin, createdBy: tiruppur._id, receivedOn: '2026-10-12',
    lines: [{ lineId: lid(4), poLineId: fl.lineId, description: fl.description, unit: 'kg', orderedQty: fl.qty, qty: fl.qty, rate: 410 }] })

  // Twenty kilos of rib went to the sweatshirt order's cutting.
  const slipId = new mongoose.Types.ObjectId()
  const issueAt = new Date('2026-10-11T09:30:00+05:30')
  await StockIssue.create({ _id: slipId, ownerOrgId: tprOrg._id, number: `ISS-TPR-${fy}-0001`, type: 'issue', orderId: 'ZAR-SWTSHT-FW26-001', stageIndex: 1, issuedOn: '2026-10-11', note: 'Collar and cuff for the first cutting lot', createdBy: tiruppur._id, createdAt: issueAt,
    lines: [{ lineId: lid(5), itemId: rib._id, name: rib.name, unit: 'kg', qty: 20 }] })
  await StockLedger.create({ ownerOrgId: tprOrg._id, itemId: rib._id, location: 'store', type: 'issue', qty: -20, unit: 'kg', refType: 'issue', refId: String(slipId), refLineId: lid(5), orderId: 'ZAR-SWTSHT-FW26-001', note: 'Issued to ZAR-SWTSHT-FW26-001', at: issueAt, by: tiruppur._id, key: `issue:${slipId}:${lid(5)}` })

  // Thirty kilos of the rib are at the dyer, due back a couple of days ago: the job work tab shows an overdue challan.
  const salem = await Supplier.findOne({ ownerOrgId: tprOrg._id, name: 'Salem Dyeing Works' }).lean()
  const jwId = new mongoose.Types.ObjectId()
  const sentAt = new Date('2026-10-06T10:00:00+05:30')
  const snap = p => ({ name: p.legalName || p.name || '', gstin: p.gstin || '', stateCode: p.stateCode || '', address: p.address || '', city: p.city || '', pincode: p.pincode || '', phone: p.phone || '', contactName: '' })
  const jwLine = { lineId: lid(6), itemId: rib._id, name: rib.name, unit: 'kg', hsnCode: rib.hsnCode, qty: 30, rate: 520, returnedQty: 0, writtenOffQty: 0 }
  const job = await JobWork.create({
    _id: jwId, ownerOrgId: tprOrg._id, number: `JWC-TPR-${fy}-0001`, status: 'open', supplierId: salem._id, supplierSnapshot: snap(salem), consignorSnapshot: snap({ ...org.profile, name: org.name }),
    process: 'Dyeing', orderId: 'ZAR-SWTSHT-FW26-001', sentOn: '2026-10-06', expectedBack: '2026-10-10', vehicleNo: 'TN33 AB 7782', note: 'Charcoal, shade card with the driver', lines: [jwLine], createdBy: tiruppur._id, createdAt: sentAt,
  })
  const jwPdf = await renderJobworkChallanPdf(job.toObject())
  const jwDoc = await Document.create({ type: 'job_challan', name: `Job work challan ${job.number}`, mfrId: tiruppur._id, orderId: null, issueDate: sentAt, uploadedBy: tiruppur._id, issuer: salem.name, jobworkId: String(jwId), dataUrl: `data:application/pdf;base64,${jwPdf.toString('base64')}`, fileName: `${job.number}.pdf`, fileSize: jwPdf.length, mimeType: 'application/pdf' })
  await JobWork.updateOne({ _id: jwId }, { $set: { documentId: jwDoc._id } })
  const jwBase = { ownerOrgId: tprOrg._id, itemId: rib._id, type: 'jobwork_out', unit: 'kg', refType: 'jobwork', refId: String(jwId), refLineId: lid(6), orderId: 'ZAR-SWTSHT-FW26-001', note: `${job.number} to ${salem.name}`, at: sentAt, by: tiruppur._id }
  await StockLedger.insertMany([
    { ...jwBase, location: 'store', qty: -30, key: `jw:${jwId}:${lid(6)}:out` },
    { ...jwBase, location: `jw:${salem._id}`, qty: 30, key: `jw:${jwId}:${lid(6)}:at` },
  ])
  await Counter.updateOne({ _id: `jwc:${tprOrg._id}:${fy}` }, { $set: { seq: 1 } }, { upsert: true })

  await Counter.updateOne({ _id: `grn:${tprOrg._id}:${fy}` }, { $set: { seq: 2 } }, { upsert: true })
  await Counter.updateOne({ _id: `iss:${tprOrg._id}:${fy}` }, { $set: { seq: 1 } }, { upsert: true })
  console.log('Inventory seeded: 5 items, 2 posted goods received notes, 1 draft note, 1 stock issue, 1 overdue job work challan for Tiruppur Textiles')
  void fleece; void zip
}

// A frozen bill of materials on Tiruppur's sweatshirt order, and three cost sheets for Zara India in different
// states (approved, commented on and waiting for the factory, and a draft), so costing can be walked by hand.
async function seedCosting({ tiruppur, tprOrg, zaraBuyer, zaraOrg }) {
  const order = 'ZAR-SWTSHT-FW26-001'
  await Order.updateOne({ _id: order }, { $set: { styleNumber: 'SWT-100', colourways: [{ name: 'BLACK' }, { name: 'CHARCOAL' }, { name: 'NAVY' }] } })
  const sup = async name => (await Supplier.findOne({ ownerOrgId: tprOrg._id, name }, '_id').lean())?._id || null
  const [mill, rib, zips, labels] = await Promise.all(['Coimbatore Knit Fabrics', 'Erode Rib and Collar', 'YKK India (Mumbai depot)', 'Tiruppur Label Works'].map(sup))
  const L = (n, o) => ({ lineId: `5e0000000000000000000${String(n).padStart(3, '0')}`, perSize: [], wastagePct: 0, perColour: false, supplierId: null, itemId: null, rate: 0, note: '', source: 'manual', confidence: null, needsReview: false, evidence: '', spec: '', ...o })
  const lines = [
    L(1, { section: 'fabric', item: 'Brushed fleece 280 GSM', unit: 'kg', consumption: 0.7, perSize: [0.62, 0.66, 0.7, 0.74, 0.8], wastagePct: 6, perColour: true, supplierId: mill, rate: 410 }),
    L(2, { section: 'fabric', item: 'Rib 2x2 collar and cuff', unit: 'kg', consumption: 0.05, wastagePct: 5, perColour: true, supplierId: rib, rate: 520 }),
    L(3, { section: 'process', item: 'Puff print logo', unit: 'pcs', consumption: 1, rate: 14 }),
    L(4, { section: 'trims', item: 'Flat drawcord, 140 cm', unit: 'pcs', consumption: 1, wastagePct: 2, rate: 7.5 }),
    L(5, { section: 'trims', item: 'Cord stopper', unit: 'pcs', consumption: 2, wastagePct: 2, supplierId: zips, rate: 4 }),
    L(6, { section: 'labels_packaging', item: 'Woven main label', unit: 'pcs', consumption: 1, wastagePct: 2, supplierId: labels, rate: 1.6 }),
    L(7, { section: 'labels_packaging', item: 'Polybag', unit: 'pcs', consumption: 1, rate: 2.5 }),
  ]
  const bom = await Bom.create({
    ownerOrgId: tprOrg._id, mfrId: tiruppur._id, orderId: order, version: 1, status: 'frozen',
    sizes: ['S', 'M', 'L', 'XL', 'XXL'], sizeRatio: [1, 2, 3, 2, 1], colours: [{ name: 'BLACK', qty: 1000 }, { name: 'CHARCOAL', qty: 1000 }, { name: 'NAVY', qty: 1000 }], totalQty: 3000,
    lines, frozenAt: new Date('2026-10-06T11:00:00+05:30'), frozenBy: tiruppur._id, createdBy: tiruppur._id, updatedBy: tiruppur._id,
  })

  const plan = { sizes: bom.sizes, ratio: bom.sizeRatio }
  const seeded = linesFromBom(lines, l => weightedConsumption(plan, l))
  const base = { ownerOrgId: tprOrg._id, mfrId: tiruppur._id, brandOrgId: zaraOrg._id, brandId: zaraBuyer._id, createdBy: tiruppur._id, updatedBy: tiruppur._id, overheadPct: 5, rejectionPct: 3, marginPct: 20, tradioPct: 10 }
  const priced = (inputs) => ({ ...inputs, computed: computeCostSheet(inputs) })
  const sweat = priced({ styleName: 'Heavy sweatshirt', styleCode: 'SWT-100', qty: 3000, ...seeded, labour: { cuttingThreads: 14, making: 78, finishingPacking: 12 }, discountPct: 2.5, ...{ overheadPct: 5, rejectionPct: 3, marginPct: 20, tradioPct: 10 } })
  const fy = '2627'
  const sheets = await CostSheet.insertMany([
    { ...base, chainId: `CS-TPR-${fy}-0001`, version: 1, status: 'approved', orderId: order, bomId: bom._id, ...sweat,
      sharedAt: new Date('2026-10-07T10:00:00+05:30'), sharedBy: tiruppur._id, sharedMessage: 'Prices valid until 30 October.', approvedAt: new Date('2026-10-08T16:30:00+05:30'), approvedBy: zaraBuyer._id, approvedByName: zaraBuyer.name, approvedPrice: sweat.computed.negotiated,
      comments: [{ at: new Date('2026-10-08T12:00:00+05:30'), byUser: zaraBuyer._id, byName: zaraBuyer.name, byRole: 'buyer', kind: 'comment', text: 'Happy with the fleece. Please keep the rib at this rate for the repeat.' }, { at: new Date('2026-10-08T14:00:00+05:30'), byUser: tiruppur._id, byName: tiruppur.name, byRole: 'manufacturer', kind: 'comment', text: 'Yes, held for the repeat order.' }] },
    { ...base, chainId: `CS-TPR-${fy}-0002`, version: 1, status: 'commented', ...priced({ styleName: 'Zip hoodie', styleCode: 'HD-210', qty: 1500, overheadPct: 5, rejectionPct: 3, marginPct: 20, tradioPct: 10, discountPct: 0,
        fabric: [{ name: 'Brushed fleece 320 GSM', spec: 'Charcoal melange', unit: 'kg', consumption: 0.82, wastagePct: 6, rate: 430, freight: 0, dutyPct: 0, note: '' }],
        process: [{ name: 'Embroidered chest logo', spec: '', unit: 'pcs', consumption: 1, wastagePct: 0, rate: 18, freight: 0, dutyPct: 0, note: '' }],
        trims: [{ name: 'YKK metal zip, 24 inch', spec: '', unit: 'pcs', consumption: 1, wastagePct: 2, rate: 38, freight: 0, dutyPct: 0, note: 'Antique brass' }, { name: 'Drawcord', spec: '', unit: 'pcs', consumption: 1, wastagePct: 2, rate: 7.5, freight: 0, dutyPct: 0, note: '' }],
        labelsPackaging: [{ name: 'Main label', spec: '', unit: 'pcs', consumption: 1, wastagePct: 0, rate: 1.6, freight: 0, dutyPct: 0, note: '' }, { name: 'Polybag and carton', spec: '', unit: 'pcs', consumption: 1, wastagePct: 0, rate: 5.5, freight: 0, dutyPct: 0, note: '' }],
        labour: { cuttingThreads: 14, making: 96, finishingPacking: 12 } }),
      sharedAt: new Date('2026-10-10T11:00:00+05:30'), sharedBy: tiruppur._id, sharedMessage: 'First costing for the zip hoodie.',
      comments: [{ at: new Date('2026-10-11T10:00:00+05:30'), byUser: zaraBuyer._id, byName: zaraBuyer.name, byRole: 'buyer', kind: 'changes', text: 'The zip looks high. Can it come down to 34 with a different supplier, or is YKK required?' }] },
    { ...base, chainId: `CS-TPR-${fy}-0003`, version: 1, status: 'draft', ...priced({ styleName: 'Cuffed joggers', styleCode: 'JG-118', qty: 2000, overheadPct: 5, rejectionPct: 3, marginPct: 20, tradioPct: 10, discountPct: 0,
        fabric: [{ name: 'French terry 260 GSM', spec: '', unit: 'kg', consumption: 0.55, wastagePct: 6, rate: 360, freight: 0, dutyPct: 0, note: '' }], process: [], trims: [{ name: 'Waistband elastic', spec: '', unit: 'm', consumption: 1.1, wastagePct: 3, rate: 8, freight: 0, dutyPct: 0, note: '' }], labelsPackaging: [],
        labour: { cuttingThreads: 12, making: 60, finishingPacking: 10 } }), internalNote: 'Waiting on a rate for the terry. Margin is thin here.' },
  ])
  await Counter.updateOne({ _id: `cs:${tprOrg._id}:${fy}` }, { $set: { seq: 3 } }, { upsert: true })
  const hoodie = sheets[1]
  await Notification.insertMany([
    { toUser: tiruppur._id, type: 'costing', msg: `Zara India asked for changes on cost sheet CS-TPR-${fy}-0002 v1 (Zip hoodie)`, link: `#cost=${hoodie._id}`, isRead: false },
    { toUser: zaraBuyer._id, type: 'costing', msg: `Tiruppur Textiles shared cost sheet CS-TPR-${fy}-0002 for Zip hoodie`, link: `#cost=${hoodie._id}`, isRead: false },
  ])
  console.log('Costing seeded: a frozen bill of materials on the sweatshirt order, and 3 cost sheets for Zara India (approved, commented, draft)')
}

seed().catch(err => { console.error('Seed failed:', err); process.exit(1) })
