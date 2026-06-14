/**
 * Tradio — MongoDB Seed Script  ⚠️ DEVELOPMENT ONLY — DO NOT RUN IN PRODUCTION
 * Run: node src/db/seed.js
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

const h = pw => bcrypt.hashSync(pw, 10)
const TODAY = new Date().toISOString().slice(0, 10)

// Build 10 stage entries for an assignment; pass overrides per stage index
const mkStages = (qty, overrides = {}) =>
  DEFAULT_STAGE_NAMES.map((name, i) => ({
    name,
    unitsDone:  overrides[i]?.unitsDone  ?? 0,
    totalUnits: overrides[i]?.totalUnits ?? qty,
    eta:        overrides[i]?.eta        ?? null,
    note:       overrides[i]?.note       ?? '',
  }))

async function seed() {
  if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] seed.js must never run in production. Aborting.')
    process.exit(1)
  }
  await connectDB()

  await Promise.all([
    User.deleteMany({}),
    Order.deleteMany({}),
    Document.deleteMany({}),
    Notification.deleteMany({}),
    AuditLog.deleteMany({}),
  ])
  console.log('Collections cleared.')

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
  await Order.insertMany([
    {
      // Knitting 70% done → solid In-Production example for Zara
      _id: 'ZAR-TPR-TSHRT-SS26-001',
      buyerId: zaraBuyer._id, product: 'Classic T-Shirt', category: 'TSHRT', season: 'SS26',
      totalQty: 5000, delivery: new Date('2026-05-15'), createdAt: new Date('2026-03-01'),
      assignments: [{
        mfrId: tiruppur._id, qty: 5000, status: 'Processing', sub: 'M1',
        note: '40% knitting complete, on track', updatedAt: new Date('2026-03-14'),
        stages: mkStages(5000, {
          0: { unitsDone: 5000 },                    // Material Sourcing — Complete
          1: { unitsDone: 3500, eta: '2026-03-28' }, // Knitting — In Progress
          2: { eta: '2026-04-05' }, 3: { eta: '2026-04-10' }, 4: { eta: '2026-04-15' },
          5: { eta: '2026-04-22' }, 6: { eta: '2026-04-28' }, 7: { eta: '2026-05-05' },
          8: { eta: '2026-05-10' }, 9: { eta: '2026-05-14' },
        }),
      }],
    },
    {
      // Split order — BLR sourcing, TPR not started yet
      _id: 'HMX-BLR-JEANS-FW26-001',
      buyerId: hmBuyer._id, product: 'Slim Fit Jeans', category: 'JEANS', season: 'FW26',
      totalQty: 3000, delivery: new Date('2026-08-20'), createdAt: new Date('2026-03-05'),
      assignments: [
        {
          mfrId: blr._id, qty: 2000, status: 'Processing', sub: 'M1',
          note: 'Sourcing denim fabric', updatedAt: new Date('2026-03-10'),
          stages: mkStages(2000, {
            0: { unitsDone: 800, eta: '2026-03-25' }, // Material Sourcing — In Progress
            1: { eta: '2026-04-10' }, 2: { eta: '2026-04-20' },
          }),
        },
        {
          mfrId: tiruppur._id, qty: 1000, status: 'Processing', sub: 'M2',
          note: '', updatedAt: new Date('2026-03-05'),
          stages: mkStages(1000),                     // All stages not started
        },
      ],
    },
    {
      // Delayed — raw material shortage
      _id: 'ZAR-BLR-BEDSH-SS26-001',
      buyerId: zaraBuyer._id, product: 'Premium Bedsheet', category: 'BEDSH', season: 'SS26',
      totalQty: 2000, delivery: new Date('2026-04-30'), createdAt: new Date('2026-02-15'),
      assignments: [{
        mfrId: blr._id, qty: 2000, status: 'Delayed', sub: 'M1',
        note: 'Raw material shortage — revised ETA Apr 20', updatedAt: new Date('2026-03-12'),
        stages: mkStages(2000, {
          0: { unitsDone: 1000, eta: '2026-04-01' }, // Material Sourcing — In Progress (stuck)
        }),
      }],
    },
    {
      // Near-QC-complete — good showcase of the filled grid
      _id: 'HMX-TPR-POLO-SS26-001',
      buyerId: hmBuyer._id, product: 'Polo T-Shirt', category: 'TSHRT', season: 'SS26',
      totalQty: 4000, delivery: new Date('2026-06-01'), createdAt: new Date('2026-03-08'),
      assignments: [{
        mfrId: tiruppur._id, qty: 4000, status: 'Processing', sub: 'M1',
        note: 'QC ongoing, results expected tomorrow', updatedAt: new Date('2026-03-15'),
        stages: mkStages(4000, {
          0: { unitsDone: 4000 }, 1: { unitsDone: 4000 }, 2: { unitsDone: 4000 },
          3: { unitsDone: 4000 }, 4: { unitsDone: 4000 }, 5: { unitsDone: 4000 },
          6: { unitsDone: 4000 }, 7: { unitsDone: 4000 },
          8: { unitsDone: 2000, eta: '2026-03-20' }, // QC — In Progress
          9: { eta: '2026-03-25' },
        }),
      }],
    },
  ])
  console.log('Orders seeded: 4')

  // ── Documents ──────────────────────────────────────────────────────────────
  await Document.insertMany([
    { type: 'compliance_cert', name: 'BSCI Audit Report 2025',     mfrId: tiruppur._id, orderId: null,                     issueDate: new Date('2025-06-01'), expiryDate: new Date('2026-06-01'), uploadedBy: tiruppur._id, issuer: 'BSCI Global',          version: 1, isActive: true },
    { type: 'compliance_cert', name: 'OEKO-TEX Standard 100',      mfrId: blr._id,      orderId: null,                     issueDate: new Date('2025-09-01'), expiryDate: new Date('2026-04-10'), uploadedBy: blr._id,      issuer: 'OEKO-TEX Association', version: 1, isActive: true },
    { type: 'PO',              name: 'Purchase Order ZAR-001',      mfrId: null,         orderId: 'ZAR-TPR-TSHRT-SS26-001', issueDate: new Date('2026-03-01'), expiryDate: null,                  uploadedBy: master._id,   issuer: 'Tradio',               version: 1, isActive: true },
    { type: 'tech_pack',       name: 'Tech Pack – Classic T-Shirt', mfrId: null,         orderId: 'ZAR-TPR-TSHRT-SS26-001', issueDate: new Date('2026-03-01'), expiryDate: null,                  uploadedBy: master._id,   issuer: 'Zara India',           version: 1, isActive: true },
    { type: 'cost_sheet',      name: 'Finalized Cost Sheet',        mfrId: null,         orderId: 'ZAR-TPR-TSHRT-SS26-001', issueDate: new Date('2026-03-02'), expiryDate: null,                  uploadedBy: master._id,   issuer: 'Tradio',               version: 1, isActive: true },
    { type: 'factory_audit',   name: 'SA8000 Social Audit',         mfrId: tiruppur._id, orderId: null,                     issueDate: new Date('2025-11-01'), expiryDate: new Date('2026-11-01'), uploadedBy: tiruppur._id, issuer: 'Bureau Veritas',       version: 1, isActive: true },
  ])
  console.log('Documents seeded: 6')

  // ── Notifications ──────────────────────────────────────────────────────────
  await Notification.insertMany([
    { toUser: zaraBuyer._id,  type: 'status', msg: 'ZAR-BLR-BEDSH-SS26-001 marked as Delayed',              orderId: 'ZAR-BLR-BEDSH-SS26-001',  isRead: false, createdAt: new Date('2026-03-12T14:15:00') },
    { toUser: tiruppur._id,   type: 'order',  msg: 'New order assigned: ZAR-TPR-TSHRT-SS26-001',             orderId: 'ZAR-TPR-TSHRT-SS26-001',  isRead: false, createdAt: new Date('2026-03-01T09:00:00') },
    { toUser: master._id,     type: 'alert',  msg: 'OEKO-TEX cert expiring in 25 days (Bangalore Fabrics)',  orderId: null, isRead: false, createdAt: new Date(TODAY) },
    { toUser: ops._id,        type: 'alert',  msg: 'OEKO-TEX cert expiring in 25 days (Bangalore Fabrics)',  orderId: null, isRead: false, createdAt: new Date(TODAY) },
    { toUser: hmBuyer._id,    type: 'order',  msg: 'New order assigned: HMX-BLR-JEANS-FW26-001',             orderId: 'HMX-BLR-JEANS-FW26-001',  isRead: false, createdAt: new Date('2026-03-05T11:30:00') },
    { toUser: blr._id,        type: 'alert',  msg: 'OEKO-TEX Standard 100 expires in 25 days — please renew', orderId: null, isRead: false, createdAt: new Date(TODAY) },
  ])
  console.log('Notifications seeded: 6')

  // ── Audit Logs ─────────────────────────────────────────────────────────────
  await AuditLog.insertMany([
    { byUser: master._id,   action: 'Order Created',     detail: 'ZAR-TPR-TSHRT-SS26-001 created and assigned to Tiruppur Textiles', createdAt: new Date('2026-03-01T09:00:00') },
    { byUser: master._id,   action: 'Order Created',     detail: 'HMX-BLR-JEANS-FW26-001 split across 2 manufacturers',              createdAt: new Date('2026-03-05T11:30:00') },
    { byUser: master._id,   action: 'Document Uploaded', detail: 'PO & Tech Pack uploaded for ZAR-TPR-TSHRT-SS26-001',               createdAt: new Date('2026-03-01T09:15:00') },
    { byUser: tiruppur._id, action: 'Status Update',     detail: 'ZAR-TPR-TSHRT-SS26-001-M1: 3500 units knitted',                     createdAt: new Date('2026-03-14T10:30:00') },
    { byUser: blr._id,      action: 'Status Update',     detail: 'ZAR-BLR-BEDSH-SS26-001-M1: Marked Delayed — raw material shortage',  createdAt: new Date('2026-03-12T14:15:00') },
    { byUser: tiruppur._id, action: 'Document Uploaded', detail: 'SA8000 Social Audit uploaded',                                       createdAt: new Date('2025-11-05T10:00:00') },
  ])
  console.log('Audit logs seeded: 6')

  console.log('\n✓ Seed complete.')
  await mongoose.disconnect()
}

seed().catch(err => { console.error('Seed failed:', err); process.exit(1) })
