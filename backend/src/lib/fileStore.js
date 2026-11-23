// Where a coordinator's photos and voice notes are kept. The database is the default home, as for every other document
// (the bytes sit in Document.dataUrl). Live's database is small, so these files are meant to move to Zoho Catalyst's
// file storage (Stratus): a driver named by FILE_STORE keeps the bytes elsewhere and the document carries only
// `storage: { driver, bucket, key }`. Reads go through load(), after the route's own access checks, so nothing in a
// bucket is ever public.
//
// Only routes/fieldUpdates.js writes through here. Every other upload is unchanged.
const drivers = new Map()

/**
 * A driver is { put(key, buffer, mimeType, ctx) -> { bucket? }, get(key, storage, ctx) -> Buffer, remove(key, storage, ctx) }.
 * `ctx` is { req }: the incoming request, which a driver that lives inside the hosting platform needs (lib/stratusDriver.js).
 */
export function registerFileDriver(name, driver) { drivers.set(name, driver) }

// A driver that is asked for but not registered fails loudly here instead of quietly filling the database. The Stratus
// driver (lib/stratusDriver.js) registers itself when the app starts; it also needs STRATUS_BUCKET.
export const fileDriverName = () => String(process.env.FILE_STORE || 'mongo').trim().toLowerCase()

export function fileStoreProblem() {
  const name = fileDriverName()
  if (name === 'mongo') return null
  if (!drivers.has(name)) return `FILE_STORE=${name} is not available on this server (no such file driver is set up)`
  if (name === 'stratus' && !String(process.env.STRATUS_BUCKET || '').trim()) return 'FILE_STORE=stratus needs STRATUS_BUCKET, the name of the bucket'
  return null
}

const toDataUrl = (buffer, mimeType) => `data:${mimeType};base64,${buffer.toString('base64')}`
export function fromDataUrl(dataUrl) {
  const m = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/s.exec(String(dataUrl || ''))
  if (!m) return null
  return { mimeType: m[1].toLowerCase(), buffer: Buffer.from(m[2], 'base64') }
}

/**
 * Keeps a file and returns the fields to put on its Document: { dataUrl } when the database holds it, or
 * { storage: { driver, bucket, key } } when a driver does.
 */
export async function saveFile(key, buffer, mimeType, ctx) {
  const problem = fileStoreProblem()
  if (problem) throw new Error(problem)
  const name = fileDriverName()
  if (name === 'mongo') return { dataUrl: toDataUrl(buffer, mimeType) }
  const out = await drivers.get(name).put(key, buffer, mimeType, ctx)
  return { storage: { driver: name, bucket: out?.bucket || null, key } }
}

/** A document's file as a data URL, wherever it is kept; null when it has none. */
export async function loadFile(doc, ctx) {
  if (!doc?.storage?.driver) return doc?.dataUrl || null
  const driver = drivers.get(doc.storage.driver)
  if (!driver) throw new Error(`This file is kept in "${doc.storage.driver}", which is not set up on this server`)
  const buffer = await driver.get(doc.storage.key, doc.storage, ctx)
  return toDataUrl(buffer, doc.mimeType || 'application/octet-stream')
}

/** Removes a stored file. Never throws: a file left behind is logged, the document's removal goes on. */
export async function removeFile(doc, ctx) {
  if (!doc?.storage?.driver) return
  try { await drivers.get(doc.storage.driver)?.remove(doc.storage.key, doc.storage, ctx) }
  catch (err) { console.error('[fileStore] could not remove', doc.storage.key, err.message) }
}
