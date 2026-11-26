// Zoho Catalyst's file storage (Stratus) as a file driver (lib/fileStore.js): where a coordinator's photos and voice
// notes go when FILE_STORE=stratus, so they do not fill the database. The bucket is private; the app reads a file
// through here only after its own access checks.
//
// The Catalyst SDK works only inside Catalyst (AppSail): it takes the project and its credentials from headers that
// Catalyst's gateway adds to every incoming request. So each call needs that request (`ctx.req`), and none of this can
// run on a laptop or in the tests, which use a stand-in SDK (setCatalystSdk). The SDK is loaded on first use, so a
// server that keeps files in the database never loads it.
import { registerFileDriver } from './fileStore.js'

let sdk = null
/** Tests hand in a stand-in for zcatalyst-sdk-node; null goes back to the real one. */
export function setCatalystSdk(fake) { sdk = fake }
const catalyst = async () => (sdk ||= (await import('zcatalyst-sdk-node')).default)

export const stratusBucketName = () => String(process.env.STRATUS_BUCKET || '').trim()

async function bucket(ctx) {
  const name = stratusBucketName()
  if (!name) throw new Error('STRATUS_BUCKET is not set on this server')
  if (!ctx?.req?.headers) throw new Error('Stratus needs the incoming request (it carries the Catalyst project credentials)')
  // Admin scope: the people using this app sign in with the app's own login, not Catalyst's, so there is no Catalyst
  // user to act as. The app's own checks decide who may read or write a file.
  const app = (await catalyst()).initialize({ headers: ctx.req.headers }, { scope: 'admin' })
  return { name, bucket: app.stratus().bucket(name) }
}

const readAll = async stream => {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export const stratusDriver = {
  async put(key, buffer, mimeType, ctx) {
    const b = await bucket(ctx)
    // A key is made once from fresh ids, so nothing is ever overwritten.
    await b.bucket.putObject(key, buffer, { contentType: mimeType, overwrite: false })
    return { bucket: b.name }
  },
  async get(key, storage, ctx) {
    return readAll(await (await bucket(ctx)).bucket.getObject(key))
  },
  async remove(key, storage, ctx) {
    await (await bucket(ctx)).bucket.deleteObject(key)
  },
}
registerFileDriver('stratus', stratusDriver)

/**
 * Proves Stratus works on this server before any photo depends on it: writes a few bytes, reads them back, removes
 * them. Returns { ok, bucket, steps: [{ step, ok, error? }] } and never throws.
 */
export async function checkStratus(ctx) {
  const steps = []
  const key = `storage-check/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
  const body = Buffer.from(`tradio storage check ${new Date().toISOString()}`)
  const run = async (step, fn) => {
    if (steps.some(s => !s.ok)) { steps.push({ step, ok: false, error: 'not tried' }); return }
    try { await fn(); steps.push({ step, ok: true }) } catch (err) { steps.push({ step, ok: false, error: String(err?.message || err).slice(0, 300) }) }
  }
  await run('write', () => stratusDriver.put(key, body, 'text/plain', ctx))
  await run('read', async () => { const back = await stratusDriver.get(key, null, ctx); if (!back.equals(body)) throw new Error('what came back is not what was written') })
  await run('remove', () => stratusDriver.remove(key, null, ctx))
  return { ok: steps.every(s => s.ok), bucket: stratusBucketName() || null, steps }
}
