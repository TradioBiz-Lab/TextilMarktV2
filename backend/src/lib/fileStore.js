// Where a coordinator's photos and voice notes are kept. The database is the default home, as for every other document
// (the bytes sit in Document.dataUrl). Live's database is small, so these files are meant to move to Zoho Catalyst's
// file storage (Stratus): a driver named by FILE_STORE keeps the bytes elsewhere and the document carries only
// `storage: { driver, bucket, key }`. Reads go through load(), after the route's own access checks, so nothing in a
// bucket is ever public.
//
// Only routes/fieldUpdates.js writes through here. Every other upload is unchanged.
const drivers = new Map()

/** A driver is { put(key, buffer, mimeType) -> { bucket? }, get(key, storage) -> Buffer, remove(key, storage) }. */
export function registerFileDriver(name, driver) { drivers.set(name, driver) }

// The Stratus driver is not built yet: it needs a bucket in the Catalyst console and a first proof from AppSail on the
// hosted sandbox. Until it is registered, asking for it fails loudly here instead of quietly filling the database.
export const fileDriverName = () => String(process.env.FILE_STORE || 'mongo').trim().toLowerCase()

export function fileStoreProblem() {
  const name = fileDriverName()
  if (name === 'mongo' || drivers.has(name)) return null
  return `FILE_STORE=${name} is not available on this server (no such file driver is set up)`
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
export async function saveFile(key, buffer, mimeType) {
  const problem = fileStoreProblem()
  if (problem) throw new Error(problem)
  const name = fileDriverName()
  if (name === 'mongo') return { dataUrl: toDataUrl(buffer, mimeType) }
  const out = await drivers.get(name).put(key, buffer, mimeType)
  return { storage: { driver: name, bucket: out?.bucket || null, key } }
}

/** A document's file as a data URL, wherever it is kept; null when it has none. */
export async function loadFile(doc) {
  if (!doc?.storage?.driver) return doc?.dataUrl || null
  const driver = drivers.get(doc.storage.driver)
  if (!driver) throw new Error(`This file is kept in "${doc.storage.driver}", which is not set up on this server`)
  const buffer = await driver.get(doc.storage.key, doc.storage)
  return toDataUrl(buffer, doc.mimeType || 'application/octet-stream')
}

/** Removes a stored file. Never throws: a file left behind is logged, the document's removal goes on. */
export async function removeFile(doc) {
  if (!doc?.storage?.driver) return
  try { await drivers.get(doc.storage.driver)?.remove(doc.storage.key, doc.storage) }
  catch (err) { console.error('[fileStore] could not remove', doc.storage.key, err.message) }
}
