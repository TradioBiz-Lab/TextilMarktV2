// A throwaway local copy of the standalone product: starts an ephemeral MongoDB, seeds it (with the
// standalone extras), and runs the API against it on PLATFORM_MODE=standalone.
//
//   npm run dev:local          then run the frontend with `npm run dev` (it proxies to :3001)
//
// Nothing here can reach Atlas: the database is an in-process mongod that disappears when this
// stops, so it is safe to click around, create things, and break them. The shared sandbox database
// (which the hosted sandbox also uses) is never touched. Sign in with the seed accounts, e.g.
// master@tradio.com, buyer@zara.com, mfr@tiruppur.com (see src/db/seed.js).
//
// Overrides: PLATFORM_MODE=tradio to see the Tradio portal; LOCAL_MONGO_PORT, PORT.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { MongoMemoryServer } from 'mongodb-memory-server'

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DB_NAME = 'textilmarkt_sandbox'   // the seed script refuses any other name

const mongod = await MongoMemoryServer.create({ instance: { port: Number(process.env.LOCAL_MONGO_PORT) || 27555, dbName: DB_NAME } })
const env = {
  ...process.env,
  MONGO_DB_URI: mongod.getUri(DB_NAME),
  JWT_SECRET: process.env.JWT_SECRET || 'local-dev-secret-not-a-real-one-0123456789abcdef',
  NODE_ENV: 'development',
  PORT: process.env.PORT || '3001',
  PLATFORM_MODE: process.env.PLATFORM_MODE || 'standalone',
  SEED_STANDALONE: '1',
  // No outbound mail from a local run, whatever a developer's .env holds.
  RESEND_API_KEY: '',
}
console.log(`[dev-local] ephemeral MongoDB at ${env.MONGO_DB_URI}`)

const run = (file, label) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file], { cwd: backendDir, env, stdio: 'inherit' })
  child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${label} exited with ${code}`))))
  child.on('error', reject)
})

await run('src/db/seed.js', 'seed')
console.log(`[dev-local] seeded. API on http://localhost:${env.PORT} in ${env.PLATFORM_MODE} mode (Ctrl-C to stop)`)

const api = spawn(process.execPath, ['src/app.js'], { cwd: backendDir, env, stdio: 'inherit' })
const stop = async () => { api.kill('SIGTERM'); await mongod.stop().catch(() => {}); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
api.on('exit', async code => { await mongod.stop().catch(() => {}); process.exit(code ?? 0) })
