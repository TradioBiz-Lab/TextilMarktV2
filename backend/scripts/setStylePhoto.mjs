// One-off: give a style its product photo from an image file, when it has none. Never replaces an existing photo unless
// --replace is given.
//
//   node --env-file=.env.sandbox scripts/setStylePhoto.mjs --id=STYLE-ID --file=/path/photo.jpg            dry run
//   node --env-file=.env.sandbox scripts/setStylePhoto.mjs --id=STYLE-ID --file=/path/photo.jpg --apply    write it
//
// A JPEG or PNG up to 1MB, the same limit the app has. Production needs CONFIRM_DB=<its exact name> as well (see
// partners-shared.mjs), and nobody should do that without asking.
import fs from 'node:fs'
import mongoose from 'mongoose'
import { AuditLog } from '../src/models/AuditLog.js'
import { connectGuarded, disconnect, apply, flag } from './partners-shared.mjs'

const id = flag('id'), file = flag('file'), replace = process.argv.includes('--replace')
if (!id || !file) { console.error('[photo] --id and --file are required.'); process.exit(1) }
const bytes = fs.readFileSync(file)
const mime = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg' : bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? 'image/png' : null
if (!mime) { console.error('[photo] that file is not a JPEG or PNG.'); process.exit(1) }
if (bytes.length > 1024 * 1024) { console.error('[photo] that file is over 1MB.'); process.exit(1) }
const image = `data:${mime};base64,${bytes.toString('base64')}`

await connectGuarded()
const col = mongoose.connection.collection('orders')
const o = await col.findOne({ _id: id }, { projection: { product: 1, styleNumber: 1, photos: 1, imageDataUrl: 1, imageUrl: 1 } })
if (!o) { console.error(`[photo] ${id}: not found`); await disconnect(); process.exit(1) }
const has = !!(o.photos?.length || o.imageDataUrl || o.imageUrl)
console.log(`[photo] ${id} ${o.product} (${o.styleNumber || '-'}): ${has ? 'already has a photo' : 'has no photo'}; new photo ${mime}, ${Math.round(bytes.length / 1024)}KB`)
if (has && !replace) console.log('[photo] left alone (use --replace to swap it).')
else if (!apply) console.log('[photo] dry run only. Re-run with --apply to write.')
else {
  await col.updateOne({ _id: id }, { $set: { photos: [{ image, colourway: '' }], imageDataUrl: image, imageUrl: null } })
  await AuditLog.create({ byUser: null, action: 'Style Photos Updated', detail: `${id}: product photo added from the replen workbook (script, on Ankit's instruction)` })
  console.log('[photo] written.')
}
await disconnect()
