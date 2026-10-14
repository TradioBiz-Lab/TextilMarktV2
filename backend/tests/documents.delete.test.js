// Deleting a document only hides it, and works on old records that today's rules would no longer accept.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as } from './helpers/client.js'
import { makeMaster, makeMfr } from './helpers/factories.js'
import { Document } from '../src/models/Document.js'

before(async () => { await startTestDb(); await startServer() })
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

describe('deleting a document', () => {
  test('Tradio can delete a factory\'s seed audit report with no file', async () => {
    const admin = await makeMaster()
    const mfr = await makeMfr()
    const doc = await Document.create({ type: 'factory_audit', name: 'SA8000 Social Audit', mfrId: mfr._id, uploadedBy: mfr._id, issuer: 'Bureau Veritas' })
    const res = await as(admin).post(`/api/documents/${doc._id}/delete`, {})
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal((await Document.findById(doc._id).lean()).isActive, false)
  })

  test('an old record that no longer passes validation still deletes', async () => {
    const admin = await makeMaster()
    const mfr = await makeMfr()
    // Written straight to the collection, as old data was: a type the schema no longer lists.
    const { insertedId } = await Document.collection.insertOne({ type: 'social_audit', name: 'Old audit', mfrId: mfr._id, uploadedBy: mfr._id, isActive: true, createdAt: new Date() })
    const res = await as(admin).post(`/api/documents/${insertedId}/delete`, {})
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal((await Document.collection.findOne({ _id: insertedId })).isActive, false)
  })

  test('a factory cannot delete someone else\'s document', async () => {
    const admin = await makeMaster()
    const mfr = await makeMfr()
    const doc = await Document.create({ type: 'compliance_cert', name: 'Cert', mfrId: mfr._id, uploadedBy: admin._id })
    assert.equal((await as(mfr).post(`/api/documents/${doc._id}/delete`, {})).status, 403)
  })
})
