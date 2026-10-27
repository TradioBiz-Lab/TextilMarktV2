// Attaches generated tiles to partners. Reads a folder of images named as partners_needing_images.md asked
// (dossil-fashions-pvt-ltd.png ...), shrinks each to 640px JPEG with macOS `sips`, and stores it as the partner's tile,
// exactly as the upload button on the partner page does. A partner that already has a tile is skipped unless --replace.
// Files that match no partner, and partners with no file, are listed.
//
//   node --env-file=.env.sandbox scripts/uploadPartnerTiles.mjs                 dry run: what would be attached
//   node --env-file=.env.sandbox scripts/uploadPartnerTiles.mjs --apply         attach them
//   options: --dir=<folder> (default ../partner-tiles next to this repo)   --replace
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Manufacturer } from '../src/models/Manufacturer.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { cleanPartnerImage } from '../src/lib/partners.js'
import { matchTileFiles } from '../src/lib/partnerImagePrompts.js'
import { connectGuarded, disconnect, apply, flag, repoDir, fail } from './partners-shared.mjs'

const dir = path.resolve(flag('dir') || path.join(repoDir, '..', 'partner-tiles'))
const replace = process.argv.includes('--replace')
if (!fs.existsSync(dir)) fail(`No folder at ${dir}`)
const files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f) && !f.startsWith('.'))

await connectGuarded()
if (apply) await Manufacturer.init()
const partners = await Manufacturer.find({}, 'name imageUploadedAt imageUrl').lean()
const { matched, unmatchedFiles, partnersWithoutFile } = matchTileFiles(files, partners)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-tiles-'))
let attached = 0; let skipped = 0; let failed = 0
for (const { file, partner } of matched) {
  if ((partner.imageUploadedAt || partner.imageUrl) && !replace) { console.log(`[partners] skip "${partner.name}": already has a tile (use --replace)`); skipped++; continue }
  const out = path.join(tmp, `${path.parse(file).name}.jpg`)
  const r = spawnSync('sips', ['-Z', '640', path.join(dir, file), '--out', out, '-s', 'format', 'jpeg', '-s', 'formatOptions', '80'], { encoding: 'utf8' })
  if (r.status !== 0 || !fs.existsSync(out)) { console.log(`[partners] FAILED to shrink ${file}: ${(r.stderr || r.error?.message || '').trim()}`); failed++; continue }
  const image = `data:image/jpeg;base64,${fs.readFileSync(out).toString('base64')}`
  const ok = cleanPartnerImage(image)
  if (ok.error) { console.log(`[partners] FAILED ${file}: ${ok.error}`); failed++; continue }
  console.log(`[partners] ${apply ? 'attach' : 'would attach'} ${file} -> "${partner.name}" (${Math.round(image.length * 0.75 / 1024)} KB)`)
  if (apply) {
    await Manufacturer.updateOne({ _id: partner._id }, { $set: { imageData: ok.image, imageUploadedAt: new Date(), imageUrl: '' } })
    await AuditLog.create({ byUser: null, action: 'Partner Image Updated', detail: `${partner.name}: image set from ${file} (script)` })
  }
  attached++
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`[partners] ${files.length} file${files.length === 1 ? '' : 's'}: ${attached} ${apply ? 'attached' : 'to attach'}, ${skipped} skipped, ${failed} failed, ${unmatchedFiles.length} matching no partner.`)
for (const f of unmatchedFiles) console.log(`  no partner for file: ${f}`)
console.log(`[partners] ${partnersWithoutFile.length} partner${partnersWithoutFile.length === 1 ? ' has' : 's have'} no file in the folder yet.`)
if (!apply && attached) console.log('[partners] dry run only. Re-run with --apply to write.')
await disconnect()
if (failed) process.exitCode = 1
