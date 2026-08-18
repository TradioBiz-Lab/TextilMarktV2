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
      kind: o.kind || 'quantity',
      status: o.status || null,
      unitsDone: o.unitsDone ?? 0,
      totalUnits: o.totalUnits ?? qty,
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
    console.error(`[FATAL] seed.js refuses to run against database "${dbName}" — expected "${SANDBOX_DB_NAME}".`)
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
               description: 'Single colourway — one round of lab dip needed.',
               items: [{ name: 'Lab Dip — Approved', status: 'done', plannedDate: '2026-07-10', dueDate: '2026-07-10', doneDate: '2026-07-12' }] },
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
      callout: 'Lab dip approval on Black Wash delayed a week — delivery pushed from Nov 10 to Nov 20.',
      assignments: [
        {
          mfrId: blr._id, qty: 2000, status: 'Processing', sub: 'M1',
          note: 'Sourcing denim fabric', updatedAt: new Date('2026-08-02'),
          stages: mkStages(DEFAULT_STAGE_NAMES, 2000, {
            0: { kind: 'checklist', status: 'in_progress', startDate: '2026-08-01', eta: '2026-08-17', baselineEta: '2026-08-10',
                 description: 'One lab dip per colourway.',
                 items: [
                   { name: 'Lab Dip — Indigo Wash', colourway: 'Indigo Wash', status: 'done',    plannedDate: '2026-08-10', dueDate: '2026-08-10', doneDate: '2026-08-09' },
                   { name: 'Lab Dip — Black Wash',  colourway: 'Black Wash',  status: 'pending', plannedDate: '2026-08-10', dueDate: '2026-08-17' },
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
      callout: 'Raw material shortage — revised ETA pushed twice.',
      assignments: [{
        mfrId: blr._id, qty: 2000, status: 'Delayed', sub: 'M1',
        note: 'Raw material shortage — revised ETA Aug 20', updatedAt: new Date('2026-08-12'),
        stages: mkStages(DEFAULT_STAGE_NAMES, 2000, {
          0: { kind: 'milestone', status: 'done', startDate: '2026-06-01', eta: '2026-06-10', baselineEta: '2026-06-10', actualEnd: '2026-06-09' },
          1: { kind: 'milestone', status: 'done', startDate: '2026-06-11', eta: '2026-06-20', baselineEta: '2026-06-18', actualEnd: '2026-06-22' },
          2: { unitsDone: 1000, totalUnits: 2000, status: 'in_progress', blocked: true,
               blockedReason: 'Cotton yarn shortage from mill — partial delivery only.',
               startDate: '2026-06-21', eta: '2026-08-20', baselineEta: '2026-07-05',
               responsibleId: blr._id,
               materials: [
                 { name: 'Cotton Percale Fabric', requiredQty: 3000, unit: 'm', supplier: 'Coimbatore Textiles', poNumber: 'PO-BLR-1905', expectedDate: '2026-07-01', status: 'ordered', orderedQty: 3000, receivedQty: 1500, note: 'Second half of the lot delayed by mill — no new ETA yet.' },
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
               items: [{ name: 'Lab Dip — Approved', status: 'done', plannedDate: '2026-06-10', dueDate: '2026-06-10', doneDate: '2026-06-10' }] },
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
    { toUser: blr._id,        type: 'alert',  msg: 'OEKO-TEX Standard 100 expires in 25 days — please renew', orderId: null, isRead: false, createdAt: new Date(TODAY) },
  ])
  console.log('Notifications seeded: 6')

  // ── Audit Logs ─────────────────────────────────────────────────────────────
  await AuditLog.insertMany([
    { byUser: master._id,   action: 'Order Created',     detail: 'ZAR-TPR-TSHRT-SS26-001 created and assigned to Tiruppur Textiles', createdAt: new Date('2026-07-01T09:00:00') },
    { byUser: master._id,   action: 'Order Created',     detail: 'HMX-BLR-JEANS-FW26-001 split across 2 manufacturers',              createdAt: new Date('2026-07-10T11:30:00') },
    { byUser: master._id,   action: 'Document Uploaded', detail: 'PO & Tech Pack uploaded for ZAR-TPR-TSHRT-SS26-001',               createdAt: new Date('2026-07-01T09:15:00') },
    { byUser: tiruppur._id, action: 'Status Update',     detail: 'ZAR-TPR-TSHRT-SS26-001-M1: 3500 units knitted',                     createdAt: new Date('2026-08-14T10:30:00') },
    { byUser: blr._id,      action: 'Status Update',     detail: 'ZAR-BLR-BEDSH-SS26-001-M1: Marked Delayed — raw material shortage',  createdAt: new Date('2026-08-12T14:15:00') },
    { byUser: tiruppur._id, action: 'Document Uploaded', detail: 'SA8000 Social Audit uploaded',                                       createdAt: new Date('2025-11-05T10:00:00') },
  ])
  console.log('Audit logs seeded: 6')

  console.log('\n✓ Sandbox seed complete.')
  await mongoose.disconnect()
}

seed().catch(err => { console.error('Seed failed:', err); process.exit(1) })
