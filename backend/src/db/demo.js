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

// One stage per DEFAULT_STAGE_NAMES entry. `statuses` lists the leading stages
// that are done/in progress; the plan is anchored so the last listed stage's
// window contains today, done stages sit in the past and the rest lie ahead.
function stages(qty, statuses, extra = {}) {
  const active = Math.max(0, statuses.length - 1)
  const start = -(6 * active) - 2
  return DEFAULT_STAGE_NAMES.map((name, i) => {
    const st = statuses[i] || 'not_started'
    const o = extra[i] || {}
    const milestone = i < 2
    return {
      name, kind: milestone ? 'milestone' : 'quantity', status: st,
      unitsDone: milestone ? (st === 'done' ? 1 : 0) : (st === 'done' ? qty : st === 'in_progress' ? Math.round(qty * 0.4) : 0),
      totalUnits: milestone ? 1 : qty,
      startDate: day(start + i * 6), eta: day(start + i * 6 + 5), baselineEta: day(start + i * 6 + 5),
      actualEnd: st === 'done' ? day(start + i * 6 + 4) : null,
      blocked: false, blockedReason: '', note: '', description: '', updates: [], materials: [], items: [],
      ...o,
    }
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
  const hash = pw => bcrypt.hashSync(pw, 10)
  const base = { isActive: true, mustChangePw: false }

  const stride = await upsertUser('sourcing@stridelab.demo', { ...base, passwordHash: hash('Buyer@123'), role: 'buyer', company: 'Stride Lab', name: 'Stride Sourcing', phone: '+91-9000000011', code: 'STR' })
  const aero   = await upsertUser('sourcing@aeroactive.demo', { ...base, passwordHash: hash('Buyer@123'), role: 'buyer', company: 'Aero Active', name: 'Aero Sourcing', phone: '+91-9000000012', code: 'AER' })
  const ncr = await upsertUser('unit@ncractive.demo', { ...base, passwordHash: hash('Mfr@12345'), role: 'manufacturer', company: 'NCR Active Unit', name: 'Lalit Ji', phone: '+91-9000000013', code: 'NCR', whatsappNumber: '+91 90000 00013', language: 'hi' })
  const blr  = await upsertUser('unit@bangaloresports.demo', { ...base, passwordHash: hash('Mfr@12345'), role: 'manufacturer', company: 'Bangalore Sportswear Unit', name: 'Ravi Gowda', phone: '+91-9000000014', code: 'BSW', whatsappNumber: '+91 90000 00014', language: 'hi' })

  const D = 'done', P = 'in_progress'
  const orders = [
    { id: 'STR-NCR-JACKT-SS27-001', buyer: stride, mfr: ncr, product: 'Zip Up Recovery Jacket', style: 'STR-ZRJ-01', cat: 'JACKET', qty: 1200, slug: 'zip-up-recovery-jacket', st: [D, D, D, D, D, D, P], delivery: 70 },
    { id: 'STR-NCR-JOGGR-SS27-001', buyer: stride, mfr: ncr, product: 'Cuffed Joggers', style: 'STR-CJ-02', cat: 'SHORTS', qty: 1500, slug: 'cuffed-joggers', st: [D, D, D, D, D, D, D, P], delivery: 55 },
    { id: 'STR-BSW-TSHRT-SS27-001', buyer: stride, mfr: blr, product: 'Recovery Tee', style: 'STR-RT-03', cat: 'TSHRT', qty: 2000, slug: 'recovery-tee', st: [D, D, P], delivery: 60,
      callout: 'Fabric lot late from the mill, Material Sourcing past its planned date.', status: 'Delayed', extra: { 2: { eta: day(-6), baselineEta: day(-6) } } },
    { id: 'AER-BSW-HOODI-SS27-001', buyer: aero, mfr: blr, product: 'Hooded Tank', style: 'AER-HT-01', cat: 'HOODIE', qty: 900, slug: 'hooded-tank', st: [D, D, P], delivery: 65,
      extra: { 2: { blocked: true, blockedReason: 'Shade variation across fabric lot', note: 'Fabric inspected: shade variation between rolls' } } },
    { id: 'AER-NCR-JACKT-SS27-001', buyer: aero, mfr: ncr, product: 'Baggy Active Jacket', style: 'AER-BAJ-02', cat: 'JACKET', qty: 800, slug: 'baggy-active-jacket', st: [D, D, D, D, P], delivery: 75 },
    { id: 'AER-BSW-JOGGR-SS27-001', buyer: aero, mfr: blr, product: 'Drifit Joggers', style: 'AER-DJ-03', cat: 'SHORTS', qty: 1100, slug: 'drifit-joggers', st: [D, P], delivery: 80 },
  ]

  for (const o of orders) {
    await Order.deleteOne({ _id: o.id })
    await Order.create({
      _id: o.id, buyerId: o.buyer._id, product: o.product, styleNumber: o.style, category: o.cat, season: 'SS27',
      totalQty: o.qty, delivery: new Date(day(o.delivery)), createdAt: new Date(day(-30)),
      callout: o.callout || '', imageDataUrl: photo(o.slug),
      assignments: [{ mfrId: o.mfr._id, qty: o.qty, status: o.status || 'Processing', sub: 'M1', stages: stages(o.qty, o.st, o.extra) }],
    })
    console.log(`  ${o.id}  ${o.product}${photo(o.slug) ? '' : '  (no photo found)'}`)
  }
  console.log('\nDemo data ready. Logins:')
  console.log('  clients:   sourcing@stridelab.demo, sourcing@aeroactive.demo  (Buyer@123)')
  console.log('  factories: unit@ncractive.demo, unit@bangaloresports.demo   (Mfr@12345)')
  console.log('  factory WhatsApp numbers: +91 90000 00013 (NCR), +91 90000 00014 (Bangalore)')
  await mongoose.disconnect()
  process.exit(0)
}
main().catch(err => { console.error('demo failed:', err); process.exit(1) })
