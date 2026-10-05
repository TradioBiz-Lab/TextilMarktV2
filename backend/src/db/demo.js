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
const MILESTONES = new Set(['PP Sample', 'QC', 'Dispatch'])
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

  const stride = await upsertUser('sourcing@stridelab.demo', { ...base, passwordHash: hash('Buyer@123'), role: 'buyer', company: 'Stride Lab', name: 'Stride Sourcing', phone: '+91-9000000011', code: 'STR' })
  const aero   = await upsertUser('sourcing@aeroactive.demo', { ...base, passwordHash: hash('Buyer@123'), role: 'buyer', company: 'Aero Active', name: 'Aero Sourcing', phone: '+91-9000000012', code: 'AER' })
  const ncr = await upsertUser('unit@ncractive.demo', { ...base, passwordHash: hash('Mfr@12345'), role: 'manufacturer', company: 'NCR Active Unit', name: 'Lalit Ji', phone: '+91-9000000013', code: 'NCR', whatsappNumber: '+91 90000 00013', language: 'hi' })
  const blr  = await upsertUser('unit@bangaloresports.demo', { ...base, passwordHash: hash('Mfr@12345'), role: 'manufacturer', company: 'Bangalore Sportswear Unit', name: 'Ravi Gowda', phone: '+91-9000000014', code: 'BSW', whatsappNumber: '+91 90000 00014', language: 'hi' })

  const orders = [
    { id: 'STR-NCR-JACKT-SS27-001', buyer: stride, mfr: ncr, product: 'Zip Up Recovery Jacket', style: 'STR-ZRJ-01', cat: 'JACKET', qty: 1200, colours: ['Teal'], slug: 'zip-up-recovery-jacket', active: 6, delivery: 70 },
    { id: 'STR-NCR-JOGGR-SS27-001', buyer: stride, mfr: ncr, product: 'Cuffed Joggers', style: 'STR-CJ-02', cat: 'SHORTS', qty: 1500, colours: ['Charcoal'], slug: 'cuffed-joggers', active: 7, delivery: 55 },
    { id: 'STR-BSW-TSHRT-SS27-001', buyer: stride, mfr: blr, product: 'Recovery Tee', style: 'STR-RT-03', cat: 'TSHRT', qty: 2000, colours: ['White'], slug: 'recovery-tee', active: 2, delivery: 60,
      callout: 'Fabric lot late from the mill, Material Sourcing past its planned date.', status: 'Delayed', extra: { 2: { eta: day(-6), baselineEta: day(-12), note: 'Fabric lot delayed at the mill, revised ETA pushed.' } } },
    { id: 'AER-BSW-HOODI-SS27-001', buyer: aero, mfr: blr, product: 'Hooded Tank', style: 'AER-HT-01', cat: 'HOODIE', qty: 900, colours: ['White'], slug: 'hooded-tank', active: 2, delivery: 65,
      extra: { 2: { blocked: true, blockedReason: 'Shade variation across fabric lot', note: 'Fabric inspected: shade variation between rolls' } } },
    { id: 'AER-NCR-JACKT-SS27-001', buyer: aero, mfr: ncr, product: 'Baggy Active Jacket', style: 'AER-BAJ-02', cat: 'JACKET', qty: 800, slug: 'baggy-active-jacket', active: 12, delivery: -3, delivered: true, colours: ['Olive Green', 'Black'], fabric: 'Nylon-poly stretch woven 135 GSM', supplier: 'Surat Technical Fabrics' },
    { id: 'AER-BSW-JOGGR-SS27-001', buyer: aero, mfr: blr, product: 'Drifit Joggers', style: 'AER-DJ-03', cat: 'SHORTS', qty: 1100, colours: ['Black'], slug: 'drifit-joggers', active: 1, delivery: 80 },
    // More range per customer
    { id: 'STR-NCR-LEGGN-SS27-001', buyer: stride, mfr: ncr, product: 'Studio Leggings', style: 'STR-SL-04', cat: 'LEGGINGS', qty: 2400, slug: 'studio-leggings', active: 8, delivery: 35, fabric: 'Nylon-spandex brushed jersey 260 GSM', colours: ['Black'] },
    { id: 'STR-BSW-SHORT-SS27-001', buyer: stride, mfr: blr, product: 'Pace Running Shorts', style: 'STR-PRS-05', cat: 'SHORTS', qty: 1800, slug: 'pace-running-shorts', active: 3, delivery: 62, fabric: 'Recycled poly micro-mesh 110 GSM', colours: ['Orange Red'] },
    { id: 'STR-NCR-SWEAT-SS27-001', buyer: stride, mfr: ncr, product: 'Core Crew Sweatshirt', style: 'STR-CCS-06', cat: 'SWEATSHIRT', qty: 1000, slug: 'core-crew-sweatshirt', active: 6, delivery: 48, fabric: 'Cotton-poly fleece 320 GSM', colours: ['Navy'] },
    { id: 'STR-BSW-TRACK-SS27-001', buyer: stride, mfr: blr, product: 'Stride Track Jacket', style: 'STR-STJ-07', cat: 'JACKET', qty: 700, slug: 'stride-track-jacket', active: 2, delivery: 78, status: 'Delayed',
      callout: 'Tricot fabric lot rejected on shade, resubmitted. Material Sourcing pushed.', fabric: 'Poly tricot 190 GSM', colours: ['Royal Blue', 'Red'], extra: { 2: { eta: day(-4), baselineEta: day(-10), note: 'First fabric lot rejected on shade, resubmitted.' } } },
    { id: 'AER-BSW-BRA00-SS27-001', buyer: aero, mfr: blr, product: 'Flex Sports Bra', style: 'AER-FSB-04', cat: 'SPORTSBRA', qty: 1600, slug: 'flex-sports-bra', active: 9, delivery: 28, fabric: 'Nylon-spandex double knit 240 GSM', colours: ['Black'] },
    { id: 'AER-NCR-WINDB-SS27-001', buyer: aero, mfr: ncr, product: 'Aero Windbreaker', style: 'AER-AWB-05', cat: 'JACKET', qty: 900, slug: 'aero-windbreaker', active: 5, delivery: 52, fabric: 'Nylon ripstop 70D, PU coated', colours: ['Black Floral'] },
    { id: 'AER-BSW-LSTEE-SS27-001', buyer: aero, mfr: blr, product: 'Long Sleeve Training Tee', style: 'AER-LST-06', cat: 'TSHRT', qty: 1400, slug: 'long-sleeve-training-tee', active: 1, delivery: 85, fabric: 'Poly-spandex interlock 180 GSM', colours: ['Black'] },
    { id: 'AER-NCR-CROPH-SS27-001', buyer: aero, mfr: ncr, product: 'Cropped Fleece Hoodie', style: 'AER-CFH-07', cat: 'HOODIE', qty: 750, slug: 'cropped-fleece-hoodie', active: 7, delivery: 40, fabric: 'Cotton-poly fleece 300 GSM', colours: ['Orange'],
      extra: { 7: { blocked: true, blockedReason: 'Skipped stitches on hood seam', note: 'Inline QC: skipped stitches found on hood seam, line rework under way.' } } },
  ]

  // One master order per customer, as on prod: the dashboard groups a
  // customer's styles under it and prefixes the buyer name.
  const masters = {
    [stride._id]: { id: 'MO-STR-SS27-001', name: 'SS27 Core Training Capsule' },
    [aero._id]:   { id: 'MO-AER-SS27-001', name: 'SS27 Launch Drop' },
  }
  for (const b of [stride, aero]) {
    const m = masters[b._id]
    await MasterOrder.deleteOne({ _id: m.id })
    await MasterOrder.create({ _id: m.id, buyerId: b._id, orderName: m.name, season: 'SS27', createdBy: admin._id })
  }

  for (const o of orders) {
    await Order.deleteOne({ _id: o.id })
    await Order.create({
      _id: o.id, masterOrderId: masters[o.buyer._id].id, buyerId: o.buyer._id, product: o.product, styleNumber: o.style, category: o.cat, season: 'SS27',
      totalQty: o.qty, delivery: new Date(day(o.delivery)), createdAt: new Date(day(o.delivered ? -95 : -30)),
      callout: o.callout || '',
      colourways: (o.colours || ['Black', 'Charcoal']).map(n => ({ name: n })),
      fabricDetails: [{ name: o.fabric || 'Poly-spandex interlock 220 GSM', composition: '88% Polyester 12% Elastane', gsm: '220', supplier: o.supplier || 'Sri Lakshmi Mills' }], imageDataUrl: photo(o.slug),
      assignments: [{ mfrId: o.mfr._id, qty: o.qty, status: o.delivered ? 'Delivered' : (o.status || 'Processing'), sub: 'M1', stages: stages(o.qty, o.active, { buyer: o.buyer, mfr: o.mfr, admin, colours: o.colours || ['Black', 'Charcoal'], fabric: o.fabric || 'Poly-spandex interlock 220 GSM', supplier: o.supplier || 'Sri Lakshmi Mills', code: o.style }, o.extra) }],
    })
    if (o.delivered) {
      const n = await seedModelOrder({ orderId: o.id, qty: o.qty, buyer: o.buyer, mfr: o.mfr, admin, day, startOffset: -(6 * o.active) - 2 })
      console.log(`    model order: ${n} documents and floor messages filed`)
    }
    console.log(`  ${o.id}  ${o.product}${photo(o.slug) ? '' : '  (no photo found)'}`)
  }
  // The two older H&M seed orders get photos too, so no customer shows blank thumbnails.
  for (const [id, slug] of [['HMX-BLR-JEANS-FW26-001', 'slim-fit-jeans'], ['HMX-TPR-POLO-SS26-001', 'polo-tshirt']]) {
    const img = photo(slug)
    if (img) console.log(`  ${id}  photo ${(await Order.updateOne({ _id: id }, { $set: { imageDataUrl: img } })).matchedCount ? 'set' : 'skipped (order not found)'}`)
  }
  console.log('\nDemo data ready. Logins:')
  console.log('  clients:   sourcing@stridelab.demo, sourcing@aeroactive.demo  (Buyer@123)')
  console.log('  factories: unit@ncractive.demo, unit@bangaloresports.demo   (Mfr@12345)')
  console.log('  factory WhatsApp numbers: +91 90000 00013 (NCR), +91 90000 00014 (Bangalore)')
  await mongoose.disconnect()
  process.exit(0)
}
main().catch(err => { console.error('demo failed:', err); process.exit(1) })
