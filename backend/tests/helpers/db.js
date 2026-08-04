// Ephemeral in-process mongod for the test suite.
//
// This exists for one reason: dev and production share a single MongoDB Atlas
// cluster, so a test that connects to MONGO_DB_URI writes to live client data.
// Nothing in tests/ may ever read that variable — startTestDb() overwrites it
// with the in-memory server's URI before app code can see it.

import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'

let mongod = null

export async function startTestDb() {
  if (mongod) return mongoose.connection

  // Set before importing anything that reads env at module scope.
  process.env.NODE_ENV = 'test'
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-used-anywhere-real'

  mongod = await MongoMemoryServer.create()
  const uri = mongod.getUri()
  process.env.MONGO_DB_URI = uri

  await mongoose.connect(uri)

  // Belt and braces. clearDb() deletes every document in every collection, so
  // if this ever pointed at Atlas it would wipe live client data. Refuse to
  // proceed unless the connection is demonstrably local and ephemeral.
  const { host } = mongoose.connection
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) {
    await stopTestDb()
    throw new Error(`Test DB guard: refusing to run against non-local host "${host}"`)
  }

  return mongoose.connection
}

export async function stopTestDb() {
  await mongoose.disconnect().catch(() => {})
  if (mongod) {
    await mongod.stop().catch(() => {})
    mongod = null
  }
}

/** Wipe every collection between tests so suites can't leak state into each other. */
export async function clearDb() {
  const { collections } = mongoose.connection
  await Promise.all(Object.values(collections).map(c => c.deleteMany({})))
}
