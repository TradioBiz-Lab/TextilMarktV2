// The test suite must never read a .env file (src/loadEnv.js). Each case runs in a child process with its own
// working directory holding a throwaway .env, so this never touches backend/.env.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const loadEnv = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../src/loadEnv.js')).href

function readSentinel(nodeEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'loadenv-'))
  try {
    writeFileSync(join(dir, '.env'), 'LOADENV_SENTINEL=from-file\n')
    const env = { ...process.env, NODE_ENV: nodeEnv }
    delete env.LOADENV_SENTINEL
    const code = `await import(${JSON.stringify(loadEnv)}); console.log(process.env.LOADENV_SENTINEL ?? 'unset')`
    return execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, env }).toString().trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('under NODE_ENV=test the .env file is not read', () => {
  assert.equal(readSentinel('test'), 'unset')
})

test('outside tests the .env file is read as before', () => {
  assert.equal(readSentinel('development'), 'from-file')
  assert.equal(readSentinel('production'), 'from-file')
})
