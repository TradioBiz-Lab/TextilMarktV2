// Startup migrations: each is idempotent and leaves existing data working.
import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { makeAdmin, makeBuyer, makeMfr, makeOrder } from './helpers/factories.js'
import { User } from '../src/models/User.js'
import { Organization } from '../src/models/Organization.js'
import { Partnership } from '../src/models/Partnership.js'
import { migrateIndexes, backfillOrgs, backfillPartnerships, runStartupMigrations } from '../src/lib/migrate.js'

before(async () => { await startTestDb(); await User.init() })
after(async () => { await stopTestDb() })
beforeEach(async () => { await clearDb() })

describe('the users.code index', () => {
  test('the old unique index is dropped, so teammates can share their company code', async () => {
    // Recreate what an existing database has: a unique index on code, for buyers and manufacturers.
    await User.collection.dropIndex('code_1')
    await User.collection.createIndex({ code: 1 }, { name: 'code_1', unique: true, partialFilterExpression: { role: { $in: ['buyer', 'manufacturer'] } } })
    await makeMfr({ code: 'TPR' })
    await assert.rejects(() => makeMfr({ code: 'TPR' }), /duplicate key/)

    assert.match(await migrateIndexes(), /dropped/)
    await makeMfr({ code: 'TPR' })   // now allowed
    assert.equal(await User.countDocuments({ code: 'TPR' }), 2)
    // The replacement is an ordinary (non-unique) index, and running again does nothing.
    const idx = (await User.collection.indexes()).find(i => i.name === 'code_1')
    assert.ok(idx && !idx.unique)
    assert.equal(await migrateIndexes(), null)
  })

  test('a database that never had the old index is left alone', async () => {
    assert.equal(await migrateIndexes(), null)
  })
})

describe('organizations for accounts that predate them', () => {
  test('every buyer and manufacturer gets one, admins get none, and running again changes nothing', async () => {
    const buyer = await makeBuyer({ company: 'Zara India', code: 'ZAR' }), mfr = await makeMfr({ company: 'Tiruppur Textiles', code: 'TPR' })
    await makeAdmin()
    assert.match(await backfillOrgs(), /created 2/)
    const orgs = await Organization.find().lean()
    assert.deepEqual(orgs.map(o => [o.name, o.type, o.code]).sort(), [['Tiruppur Textiles', 'manufacturer', 'TPR'], ['Zara India', 'brand', 'ZAR']])
    // Tradio is never switched on for them, and they stay visible to Tradio until they say otherwise.
    assert.ok(orgs.every(o => o.tradioEnabled === false && o.tradioCanView === true && o.isActive === true))
    const u = await User.findById(mfr._id).lean()
    assert.equal(String(u.orgId), String(orgs.find(o => o.type === 'manufacturer')._id))
    assert.equal(u.orgRole, 'owner')
    assert.equal(await backfillOrgs(), null)
    assert.equal(await Organization.countDocuments(), 2)
    void buyer
  })
})

describe('partnerships from existing orders', () => {
  test('each brand-and-manufacturer pair on an order becomes a partnership, once', async () => {
    const brand = await makeBuyer(), a = await makeMfr(), b = await makeMfr()
    await makeOrder({ id: 'M-1', buyer: brand, mfrs: [a] })
    await makeOrder({ id: 'M-2', buyer: brand, mfrs: [a, b] })
    await makeOrder({ id: 'M-3', buyer: brand, mfrs: [] })   // no manufacturer: no pair
    assert.match(await backfillPartnerships(), /linked 2/)
    assert.equal(await Partnership.countDocuments({ status: 'active' }), 2)
    assert.equal(await backfillPartnerships(), null)
  })

  test('a partnership that was revoked is not revived by running the migration again', async () => {
    const brand = await makeBuyer(), mfr = await makeMfr()
    await makeOrder({ id: 'R-1', buyer: brand, mfrs: [mfr] })
    await backfillPartnerships()
    await Partnership.updateMany({}, { $set: { status: 'revoked' } })
    await backfillPartnerships()
    assert.equal(await Partnership.countDocuments({ status: 'revoked' }), 1)
  })

  test('the whole startup sequence runs without error on an empty database', async () => {
    const lines = []
    await runStartupMigrations({ log: line => lines.push(line), error: line => lines.push(line) })
    assert.deepEqual(lines, [])
  })
})
