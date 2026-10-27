// Writes reports/partners_needing_images.md: one line per partner with no tile yet, each with a ready-to-paste
// image prompt. Read-only on the database. The report names partners, which is sourcing data, so reports/ is git-ignored.
//
//   node --env-file=.env.sandbox scripts/partnersImageReport.mjs          partners with no tile yet
//   node --env-file=.env.sandbox scripts/partnersImageReport.mjs --all    every active partner (to redo all the tiles)
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Manufacturer } from '../src/models/Manufacturer.js'
import { imageReportMarkdown } from '../src/lib/partnerImagePrompts.js'
import { connectGuarded, disconnect, repoDir, brandPrimary, today, flag } from './partners-shared.mjs'

export async function writeImageReport({ out, all = false } = {}) {
  const file = out || path.join(repoDir, 'reports', all ? 'partners_tiles_redo.md' : 'partners_needing_images.md')
  const filter = all ? { isActive: { $ne: false } } : { isActive: { $ne: false }, imageUploadedAt: null, $or: [{ imageUrl: '' }, { imageUrl: null }] }
  const partners = await Manufacturer.find(filter, 'name type city cluster categories products keywords notes').sort({ name: 1 }).lean()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, imageReportMarkdown(partners, { primary: brandPrimary(), generatedOn: today(), redo: all }))
  return { file, count: partners.length }
}

// Run directly (not imported by importManufacturers.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await connectGuarded()
  const { file, count } = await writeImageReport({ out: flag('out'), all: process.argv.includes('--all') })
  console.log(`[partners] wrote ${count} line${count === 1 ? '' : 's'} to ${file}`)
  await disconnect()
}
