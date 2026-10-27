// Shared by the Partner Directory scripts. Deliberately does NOT load backend/.env: dev and production share one
// Atlas cluster, so a script only ever talks to the database the caller names, and only after the guard below.
//
//   node --env-file=.env.sandbox scripts/<script>.mjs            dry run against the sandbox database
//   node --env-file=.env.sandbox scripts/<script>.mjs --apply    write to it
//
// Allowed without ceremony: a local mongod, or a database whose name ends in _sandbox. Any other database (that is,
// production) needs CONFIRM_DB=<its exact name> as well, for a dry run too, and nobody should do that without asking.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'

export const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const repoDir = path.resolve(backendDir, '..')
export const apply = process.argv.includes('--apply')
export const flag = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) || null

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[?::1\]?)$/

/** Connects to MONGO_DB_URI if the guard allows it, and says where it connected. Exits otherwise. */
export async function connectGuarded() {
  const uri = process.env.MONGO_DB_URI
  if (!uri) fail('MONGO_DB_URI is not set. Run with --env-file=.env.sandbox (this script never reads backend/.env).')
  let host; let db
  try {
    const u = new URL(uri)
    host = u.hostname
    // No database in the URI means the driver's default, which is "test".
    db = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'test'
  } catch { fail('MONGO_DB_URI could not be read, so the target database cannot be checked.') }
  const local = LOCAL_HOST.test(host)
  const sandbox = /_sandbox$/.test(db)
  if (!local && !sandbox && process.env.CONFIRM_DB !== db) {
    fail(`Refusing to touch database "${db}" on ${host}: it is not local and not a _sandbox database, so it may be production.\n`
      + `If that is really the intent, ask first, then re-run with CONFIRM_DB=${db}.`)
  }
  // A dry run must write nothing, and Mongoose would otherwise build the directory's indexes (creating its collection) on connect.
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoIndex: apply })
  console.log(`[partners] ${apply ? 'APPLY' : 'dry run'} on ${mongoose.connection.host} / ${mongoose.connection.name}`)
  return mongoose.connection
}

export function fail(msg) {
  console.error(`[partners] ${msg}`)
  process.exit(1)
}

export async function disconnect() {
  await mongoose.disconnect().catch(() => {})
}

/** T.primary from the frontend theme, so the image prompts follow the brand colour. */
export function brandPrimary() {
  try {
    const src = fs.readFileSync(path.join(repoDir, 'frontend', 'src', 'constants.js'), 'utf8')
    return /\bprimary:\s*'(#[0-9A-Fa-f]{6})'/.exec(src)?.[1] || '#F97316'
  } catch { return '#F97316' }
}

export const today = () => new Date().toISOString().slice(0, 10)
