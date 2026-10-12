// Try the tech pack reader on a real file: node scripts/read-techpack.mjs <file.pdf>
// Needs ANTHROPIC_API_KEY in the environment (and optionally ANTHROPIC_TECHPACK_MODEL). It calls the model once,
// prints what it read, and touches no database. Used to tune lib/ai/techpack.js against real packs.
import fs from 'node:fs'
import path from 'node:path'
import { extractTechPack, techPackModel, linesFromTechPack, specFromTechPack } from '../src/lib/ai/techpack.js'

const file = process.argv[2]
if (!file) { console.error('usage: node scripts/read-techpack.mjs <file.pdf>'); process.exit(1) }
if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY is not set'); process.exit(1) }

const ext = path.extname(file).toLowerCase()
const mime = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[ext]
if (!mime) { console.error('only a PDF or an image can be read'); process.exit(1) }

const buffer = fs.readFileSync(file)
console.log(`${path.basename(file)}  ${(buffer.length / 1048576).toFixed(1)} MB  model ${techPackModel()}`)
const t0 = Date.now()
const { data, error } = await extractTechPack(buffer, mime)
console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s`)
if (!data) { console.error('could not be read:', error); process.exit(2) }

const h = data.header
console.log('\nHEADER', [h.brand, h.styleNo, h.description, h.category, h.gender, h.fabricComposition, h.gsm && `${h.gsm} GSM`, h.sizeRange, h.collection, h.season].filter(Boolean).join(' | '))
console.log('SIZES', data.sizes.join(' '), '  COLOURWAYS', data.colourways.join(', ') || '-')
console.log('\nBOM CANDIDATES')
for (const l of linesFromTechPack(data)) console.log(` ${l.section.padEnd(16)} ${l.item.padEnd(34)} ${(l.spec || '').slice(0, 42).padEnd(42)} ${String(l.unit).padEnd(5)} ${l.consumption || '-'}  ${l.confidence.toFixed(2)}  ${l.perColour ? 'per colour' : ''}`)
const spec = specFromTechPack(data)
console.log(`\nSPEC  ${spec.points.length} points  sizes ${spec.sizes.join(' ')}`)
for (const p of spec.points) console.log(` ${p.code.padEnd(3)} ${p.name.slice(0, 44).padEnd(44)} tol ${String(p.tolPlus ?? '-').padEnd(4)} ${p.values.map(v => (v === null ? '-' : v)).join('  ')}`)
if (data.notes.length) console.log('\nNOTES\n ' + data.notes.join('\n '))
console.log(`\nconfidence ${data.confidence}`)
