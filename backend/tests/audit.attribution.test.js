// An audit entry written during a "view as" session records the master admin who really acted,
// not only the user being viewed as.

import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { makeMaster, makeBuyer } from './helpers/factories.js'
import { AuditLog } from '../src/models/AuditLog.js'
import { requestContext } from '../src/lib/requestContext.js'

before(startTestDb)
after(stopTestDb)
beforeEach(clearDb)

test('an entry written while viewing as someone names the admin who did it', async () => {
  const master = await makeMaster({ name: 'Arun Mehta' })
  const buyer = await makeBuyer()
  const entry = await requestContext.run({ viewAsBy: String(master._id), viewAsByName: 'Arun Mehta' },
    () => AuditLog.create({ byUser: buyer._id, action: 'Stage Updated', detail: 'ORD-1: Cutting done' }))
  assert.equal(String(entry.viewAsBy), String(master._id))
  assert.match(entry.detail, /done by Arun Mehta using view as/)
  assert.equal(String(entry.byUser), String(buyer._id), 'still filed under the viewed user, whose permissions applied')
})

test('an ordinary entry is untouched', async () => {
  const buyer = await makeBuyer()
  const entry = await AuditLog.create({ byUser: buyer._id, action: 'Stage Updated', detail: 'ORD-1: Cutting done' })
  assert.equal(entry.viewAsBy, null)
  assert.equal(entry.detail, 'ORD-1: Cutting done')
})

test("the admin's own entries (starting or ending view as) are not tagged as view-as", async () => {
  const master = await makeMaster({ name: 'Arun Mehta' })
  const entry = await requestContext.run({ viewAsBy: String(master._id), viewAsByName: 'Arun Mehta' },
    () => AuditLog.create({ byUser: master._id, action: 'View As Ended', detail: 'stopped viewing' }))
  assert.equal(entry.viewAsBy, null)
  assert.equal(entry.detail, 'stopped viewing')
})
