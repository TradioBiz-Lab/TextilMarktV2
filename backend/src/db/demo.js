/**
 * Demo data for recording a Zero Entry Capture walkthrough.  SANDBOX ONLY.
 * Run: node --env-file=.env src/db/demo.js   (from backend/, sandbox .env)
 *
 * Unlike seed.js this never deletes anything: it upserts two dummy clients,
 * two factories and six athleisure orders by fixed ids, so it is safe to
 * re-run and does not touch other sandbox data. Product photos are read from
 * src/db/demo-images/<slug>.jpg when present (orders get no photo otherwise).
 */
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import { connectDB } from './index.js'
import { User } from '../models/User.js'
import { Order, DEFAULT_STAGE_NAMES } from '../models/Order.js'
import { MasterOrder } from '../models/MasterOrder.js'
import { seedModelOrder } from './modelOrder.js'
import { STYLES, MASTER_ORDERS } from './demoStyles.js'
import { Document } from '../models/Document.js'
import { InboundMessage } from '../models/InboundMessage.js'

const SANDBOX_DB_NAME = 'textilmarkt_sandbox'
const IMG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'demo-images')
const MAX_PHOTO_BYTES = 1024 * 1024

if (process.env.NODE_ENV === 'production') { console.error('[demo] refusing to run in production'); process.exit(1) }

const day = n => new Date(Date.now() + 5.5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10)
const photo = slug => {
  const f = path.join(IMG_DIR, `${slug}.jpg`)
  if (!fs.existsSync(f)) return null
  const buf = fs.readFileSync(f)
  return buf.length <= MAX_PHOTO_BYTES ? `data:image/jpeg;base64,${buf.toString('base64')}` : null
}

const DESC = {
  'Lab Dip Approval': 'One lab dip per colourway, approved by the client before bulk dyeing.',
  'PP Sample': 'Pre-production sample made on bulk fabric and approved by the client.',
  'Material Sourcing': 'Fabric and trims ordered, received and inspected against the PO.',
  'Knitting': 'Fabric knitted to the approved GSM and width.',
  'Dyeing': 'Bulk dyeing to the approved lab dip shades.',
  'Processing': 'Finishing of fabric: washing, shrinkage control, heat setting.',
  'Cutting': 'Fabric cut to the approved pattern and marker.',
  'Stitching': 'Garments stitched on the line to the approved PP sample.',
  'Finishing': 'Trimming, pressing, labelling and inline checks.',
  'Packing': 'Folding, polybagging and carton packing to the buyer spec.',
  'QC': 'Final inspection against the AQL and tech pack measurements.',
  'Dispatch': 'Cartons handed over to the carrier with dispatch documents.',
}
const MILESTONES = new Set(['PP Sample', 'QC', 'Dispatch', 'Delivery'])
const NOTES_DONE = {
  'Lab Dip Approval': 'All colourways approved by the client.',
  'PP Sample': 'PP sample approved with minor measurement comments.',
  'Material Sourcing': 'Fabric and trims received, inspection passed.',
  'Knitting': 'Knitting completed, fabric moved to dyeing.',
  'Dyeing': 'Dyeing completed, shade matches the approved lab dip.',
  'Processing': 'Processing done, shrinkage within tolerance.',
  'Cutting': 'Cutting completed against the marker.',
  'Stitching': 'Stitching completed on all lines.',
  'Finishing': 'Finishing and pressing completed.',
  'Packing': 'Packing completed to the buyer spec.',
  'QC': 'Final inspection passed at AQL 2.5, released for dispatch.',
  'Dispatch': 'Dispatched and delivered to the buyer warehouse.',
  'Delivery': 'Goods received by the buyer. Closing this step marks the order delivered.',
}

/**
 * Builds a fully populated 12-stage TNA. `active` is the index of the stage in
 * progress (earlier ones are done, later ones not started); the plan is
 * anchored so that stage's window contains today. `ctx` carries the people
 * and order details the per-stage content needs.
 */
function stages(qty, active, ctx, extra = {}) {
  const start = -(6 * active) - 2
  return DEFAULT_STAGE_NAMES.map((name, i) => {
    const st = i < active ? 'done' : i === active ? 'in_progress' : 'not_started'
    const milestone = MILESTONES.has(name)
    const checklist = name === 'Lab Dip Approval'
    const kind = checklist ? 'checklist' : milestone ? 'milestone' : 'quantity'
    const eta = day(start + i * 6 + 5)
    // A few completed stages finished a day or two after their first plan, so
    // the TNA shows real baseline-vs-revised slippage.
    const slip = st === 'done' && i % 4 === 2 ? 2 : 0
    const responsible = ['Lab Dip Approval', 'PP Sample'].includes(name) ? ctx.buyer
      : name === 'Material Sourcing' || name === 'QC' ? ctx.admin : ctx.mfr
    const o = extra[i] || {}
    const stage = {
      name, kind, status: st, totalUnits: kind === 'quantity' ? qty : 1,
      unitsDone: kind === 'quantity' ? (st === 'done' ? qty : st === 'in_progress' ? Math.round(qty * 0.4) : 0) : (st === 'done' ? 1 : 0),
      startDate: day(start + i * 6), eta: day(start + i * 6 + 5 + slip), baselineEta: eta,
      actualEnd: st === 'done' ? day(start + i * 6 + 4 + slip) : null,
      description: DESC[name], responsibleId: responsible._id,
      isDelivery: name === 'Delivery',
      blocked: false, blockedReason: '',
      note: st === 'done' ? (NOTES_DONE[name] || '') : '',
      updates: st === 'done' && NOTES_DONE[name]
        ? [{ text: NOTES_DONE[name], byUser: (responsible.role === 'buyer' ? ctx.admin : responsible)._id, at: new Date(day(start + i * 6 + 4 + slip) + 'T10:00:00+05:30') }]
        : st === 'in_progress' ? [{ text: `${name} under way, about 40% done.`, byUser: ctx.mfr._id, at: new Date(Date.now() - 3600e3) }] : [],
      materials: [], items: [],
    }
    if (checklist) {
      stage.items = ctx.colours.map(c => ({
        name: `Lab Dip - ${c}`, colourway: c, status: st === 'done' ? 'done' : 'pending',
        plannedDate: eta, dueDate: eta, doneDate: st === 'done' ? day(start + i * 6 + 4) : null,
      }))
    }
    if (name === 'Material Sourcing') {
      const got = st === 'done'
      stage.materials = [
        { name: ctx.fabric, requiredQty: Math.round(qty * 0.35), unit: 'kg', supplier: ctx.supplier, poNumber: `PO-${ctx.code}-01`, expectedDate: day(start + i * 6 + 3),
          status: got ? 'received' : 'ordered', orderedQty: Math.round(qty * 0.35), receivedQty: got ? Math.round(qty * 0.35) : Math.round(qty * 0.15) },
        { name: 'Zippers, drawcords and woven labels', requiredQty: qty, unit: 'sets', supplier: 'Trims Hub', poNumber: `PO-${ctx.code}-02`, expectedDate: day(start + i * 6 + 4),
          status: got ? 'received' : 'pending', orderedQty: got ? qty : 0, receivedQty: got ? qty : 0 },
      ]
    }
    return { ...stage, ...o }
  })
}

async function upsertUser(email, fields) {
  const existing = await User.findOne({ email })
  if (existing) { Object.assign(existing, fields); return existing.save() }
  return User.create({ email, ...fields })
}

async function main() {
  await connectDB()
  const dbName = mongoose.connection.name
  if (dbName !== SANDBOX_DB_NAME) {
    console.error(`[demo] refusing to run against "${dbName}", expected "${SANDBOX_DB_NAME}"`)
    await mongoose.disconnect().catch(() => {}); process.exit(1)
  }
  const admin = await User.findOne({ role: 'admin', isActive: true })
  if (!admin) { console.error('[demo] needs at least one admin user in the sandbox DB'); process.exit(1) }
  const hash = pw => bcrypt.hashSync(pw, 10)
  const base = { isActive: true, mustChangePw: false }

  // One customer. (An earlier version of the demo also had a second customer, Stride Lab; it is
  // folded into Aero Active, so remove it and everything that hung off it.)
  const aero = await upsertUser('sourcing@aeroactive.demo', { ...base, passwordHash: hash('Buyer@123'), role: 'buyer', company: 'Aero Active', name: 'Aero Sourcing', phone: '+91-9000000012', code: 'AER' })
  const stride = await User.findOne({ email: 'sourcing@stridelab.demo' })
  if (stride) {
    const old = (await Order.find({ buyerId: stride._id }, '_id').lean()).map(o => o._id)
    await Document.deleteMany({ orderId: { $in: old } }); await InboundMessage.deleteMany({ orderId: { $in: old } })
    await Order.deleteMany({ _id: { $in: old } }); await MasterOrder.deleteMany({ buyerId: stride._id }); await User.deleteOne({ _id: stride._id })
    console.log(`  removed legacy customer Stride Lab (${old.length} orders)`)
  }
  const ncr = await upsertUser('unit@ncractive.demo', { ...base, passwordHash: hash('Mfr@12345'), role: 'manufacturer', company: 'NCR Active Unit', name: 'Lalit Ji', phone: '+91-9000000013', code: 'NCR', whatsappNumber: '+91 90000 00013', language: 'hi' })
  const blr  = await upsertUser('unit@bangaloresports.demo', { ...base, passwordHash: hash('Mfr@12345'), role: 'manufacturer', company: 'Bangalore Sportswear Unit', name: 'Ravi Gowda', phone: '+91-9000000014', code: 'BSW', whatsappNumber: '+91 90000 00014', language: 'hi' })
  const factory = { ncr, blr }

  // Per-order tweaks that depend on today's date (delays, blocks).
  const EXTRAS = {
    'AER-BSW-TSHRT-SS27-001': { 2: { eta: day(-6), baselineEta: day(-12), note: 'Fabric lot delayed at the mill, revised ETA pushed.' } },
    'AER-BSW-TRACK-SS27-001': { 2: { eta: day(-4), baselineEta: day(-10), note: 'First fabric lot rejected on shade, resubmitted.' } },
    'AER-BSW-HOODI-SS27-001': { 2: { blocked: true, blockedReason: 'Shade variation across fabric lot', note: 'Fabric inspected: shade variation between rolls' } },
    'AER-NCR-CROPH-SS27-001': { 7: { blocked: true, blockedReason: 'Skipped stitches on hood seam', note: 'Inline QC: skipped stitches found on hood seam, line rework under way.' } },
  }

  // Master orders: one per product family, all under the one customer. Anything left over from earlier
  // versions of the demo for this customer is dropped first.
  const keepIds = STYLES.map(x => x.id)
  await Order.deleteMany({ buyerId: aero._id, _id: { $nin: keepIds } })
  await MasterOrder.deleteMany({ buyerId: aero._id })
  for (const m of MASTER_ORDERS) await MasterOrder.create({ _id: m.id, buyerId: aero._id, orderName: m.name, season: 'SS27', createdBy: admin._id })

  const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'demo-docs')
  const fileDoc = (file, mime) => {
    const f = path.join(DOCS, file)
    if (!fs.existsSync(f)) return null
    const buf = fs.readFileSync(f)
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, fileName: file, fileSize: buf.length, mimeType: mime }
  }
  const FABRIC_META = fs.existsSync(path.join(DOCS, 'fabric-meta.json')) ? JSON.parse(fs.readFileSync(path.join(DOCS, 'fabric-meta.json'), 'utf8')) : {}
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

  for (const st of STYLES) {
    const o = { ...st, buyer: aero, mfr: factory[st.mfr] }
    // Fabric facts come from the tech pack so the order page and the PDF agree.
    const tpMeta = FABRIC_META[o.slug] || {}
    const fab = { name: (o.fabric || 'Poly-spandex interlock').replace(/\s*\d+\s*GSM/i, ''), composition: tpMeta.composition || '88% Polyester 12% Spandex', gsm: tpMeta.gsm || '220' }
    const fabricLabel = `${fab.name} ${fab.gsm} GSM`
    await Order.deleteOne({ _id: o.id })
    await Document.deleteMany({ orderId: o.id })
    await Order.create({
      _id: o.id, masterOrderId: MASTER_ORDERS[o.mo - 1].id, buyerId: o.buyer._id, product: o.product, styleNumber: o.style, category: o.cat, season: 'SS27',
      totalQty: o.qty, delivery: new Date(day(o.delivery)), createdAt: new Date(day(o.delivered ? -95 : -30)),
      callout: o.callout || '',
      colourways: (o.colours || ['Black', 'Charcoal']).map(n => ({ name: n })),
      fabricDetails: [{ name: fab.name, composition: fab.composition, gsm: fab.gsm, supplier: o.supplier || 'Sri Lakshmi Mills' }], imageDataUrl: photo(o.slug),
      assignments: [{ mfrId: o.mfr._id, qty: o.qty, status: o.delivered ? 'Delivered' : (o.status || 'Processing'), sub: 'M1', stages: stages(o.qty, o.delivered ? DEFAULT_STAGE_NAMES.length : o.active, { buyer: o.buyer, mfr: o.mfr, admin, colours: o.colours || ['Black', 'Charcoal'], fabric: fabricLabel, supplier: o.supplier || 'Sri Lakshmi Mills', code: o.style }, EXTRAS[o.id]) }],
    })
    if (o.delivered) {
      const n = await seedModelOrder({ orderId: o.id, qty: o.qty, buyer: o.buyer, mfr: o.mfr, admin, day, startOffset: -(6 * o.active) - 2, slug: o.slug })
      console.log(`    model order: ${n} documents and floor messages filed`)
    } else {
      // Every other style gets its reference documents too: the (modified) tech pack and the Excel measurement sheet.
      const refs = [
        ['tech_pack', `Tech Pack - ${o.product}`, fileDoc(`techpack-${o.slug}.pdf`, 'application/pdf')],
        ['measurements', `Measurement Spec - ${o.product}`, fileDoc(`measurements-${o.slug}.xlsx`, XLSX_MIME)],
      ]
      for (const [type, name, f] of refs) if (f) await Document.create({ type, name, orderId: o.id, mfrId: null, uploadedBy: o.buyer._id, issuer: 'Aero Active', issueDate: new Date(day(-26)), version: 1, isActive: true, ...f })
    }
    console.log(`  ${o.id}  ${o.product}${photo(o.slug) ? '' : '  (no photo found)'}`)
  }
  // The two older H&M seed orders get photos too, so no customer shows blank thumbnails.
  for (const [id, slug] of [['HMX-BLR-JEANS-FW26-001', 'slim-fit-jeans'], ['HMX-TPR-POLO-SS26-001', 'polo-tshirt']]) {
    const img = photo(slug)
    if (img) console.log(`  ${id}  photo ${(await Order.updateOne({ _id: id }, { $set: { imageDataUrl: img } })).matchedCount ? 'set' : 'skipped (order not found)'}`)
  }
  console.log('\nDemo data ready. Logins:')
  console.log('  customer:  sourcing@aeroactive.demo  (Buyer@123)')
  console.log('  factories: unit@ncractive.demo, unit@bangaloresports.demo   (Mfr@12345)')
  console.log('  factory WhatsApp numbers: +91 90000 00013 (NCR), +91 90000 00014 (Bangalore)')
  await mongoose.disconnect()
  process.exit(0)
}
main().catch(err => { console.error('demo failed:', err); process.exit(1) })
