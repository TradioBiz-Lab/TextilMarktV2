// Runs every backend test file with node's built-in runner.
//
// `node --test "tests/**/*.test.js"` only expands the pattern on Node 21 and later; on Node 20, which is what
// AppSail runs, it looks for a file literally named that and finds nothing. Listing the files here works the same
// on every version. Extra arguments are passed through (e.g. `npm test -- --watch`, or a file name to run one).
import { readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const args = process.argv.slice(2)
const named = args.filter(a => !a.startsWith('-'))
const flags = args.filter(a => a.startsWith('-'))

const files = named.length
  ? named
  : readdirSync(here, { recursive: true })
      .filter(f => f.endsWith('.test.js') && !f.split(/[\\/]/).includes('node_modules'))
      .map(f => relative(root, join(here, f)))
      .sort()

if (files.length === 0) {
  console.error('No test files found under tests/')
  process.exit(1)
}

// NODE_ENV=test from the start, so nothing can read backend/.env (src/loadEnv.js) even before a suite sets it.
const env = { ...process.env, NODE_ENV: 'test' }
const child = spawn(process.execPath, ['--test', ...flags, ...files], { cwd: root, stdio: 'inherit', env })
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1))
