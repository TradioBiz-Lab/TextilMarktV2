// The total machine count of a partner (its capacity at a glance): stored, validated, filtered, sorted, imported and
// offered to Kriyaa. The four per-type counts stay as the breakdown.

import test, { before, after, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { startTestDb, stopTestDb, clearDb } from './helpers/db.js'
import { startServer, stopServer, as, tokenFor } from './helpers/client.js'
import { makeAdmin } from './helpers/factories.js'
import { Manufacturer } from '../src/models/Manufacturer.js'
import { TOOL_HANDLERS, toolsFor } from '../src/routes/assistant.js'
import { suggestPartnerMapping, mapPartnerRecord } from '../src/lib/partnerImport.js'
import { mergePartner } from '../src/lib/partnerMerge.js'

before(async () => {
  await startTestDb()
  const baseUrl = await startServer()
  process.env.PORT = new URL(baseUrl).port
  await Manufacturer.init()
})
after(async () => { await stopServer(); await stopTestDb() })
beforeEach(clearDb)

const ctxFor = user => ({ cookie: `tradio_token=${tokenFor(user)}`, user: { id: String(user._id), role: user.role } })
const arrange = async () => {
  const api = as(await makeAdmin())
  for (const [name, machineCount, score] of [['Big Unit', 120, 10], ['Mid Unit', 40, 90], ['Small Unit', 8, 50], ['Unknown Unit', undefined, 99]]) {
    const res = await api.post('/api/manufacturers', { name, type: 'garment_manufacturer', machineCount, verification: { score } })
    assert.equal(res.status, 201, JSON.stringify(res.body))
  }
  return api
}
const names = async (api, qs) => (await api.get(`/api/manufacturers?${qs}`)).body.items.map(p => p.name)

describe('machine count on a partner', () => {
  test('it is saved, returned, and not recorded is null', async () => {
    const api = await arrange()
    const items = (await api.get('/api/manufacturers?sort=name')).body.items
    assert.deepEqual(items.map(p => [p.name, p.machineCount]), [['Big Unit', 120], ['Mid Unit', 40], ['Small Unit', 8], ['Unknown Unit', null]])
  })

  test('an edit changes it and a blank value clears it', async () => {
    const api = await arrange()
    const id = (await api.get('/api/manufacturers?search=mid')).body.items[0].id
    assert.equal((await api.post(`/api/manufacturers/${id}`, { machineCount: 55 })).body.machineCount, 55)
    assert.equal((await api.post(`/api/manufacturers/${id}`, { machineCount: '' })).body.machineCount, null)
  })

  test('only a whole number from 0 up is accepted', async () => {
    const api = await arrange()
    for (const bad of [-1, 2.5, 'lots', 100000]) {
      const res = await api.post('/api/manufacturers', { name: `Bad ${bad}`, type: 'garment_manufacturer', machineCount: bad })
      assert.equal(res.status, 400, `${bad}`)
    }
    const ok = await api.post('/api/manufacturers', { name: 'Text Count', type: 'garment_manufacturer', machineCount: '30' })
    assert.equal(ok.body.machineCount, 30)
  })
})

describe('machine filter and sort', () => {
  test('a minimum leaves out smaller units and those with no count', async () => {
    const api = await arrange()
    assert.deepEqual(await names(api, 'minMachines=40&sort=name'), ['Big Unit', 'Mid Unit'])
    assert.deepEqual(await names(api, 'minMachines=1&sort=name'), ['Big Unit', 'Mid Unit', 'Small Unit'])
    assert.equal((await api.get('/api/manufacturers?minMachines=-3')).status, 400)
    assert.equal((await api.get('/api/manufacturers?minMachines=many')).status, 400)
  })

  test('the machines sort puts the biggest first and not recorded last, rejected after those', async () => {
    const api = await arrange()
    assert.deepEqual(await names(api, 'sort=machines'), ['Big Unit', 'Mid Unit', 'Small Unit', 'Unknown Unit'])
    await Manufacturer.updateOne({ name: 'Big Unit' }, { status: 'rejected' })
    assert.deepEqual(await names(api, 'sort=machines'), ['Mid Unit', 'Small Unit', 'Unknown Unit', 'Big Unit'])
  })
})

describe('machine count in imports, merges and Kriyaa', () => {
  test('a CSV column about machines maps to the total and reads the number out of words', () => {
    const m = suggestPartnerMapping(['Company', 'No. of machines'])
    assert.equal(m['No. of machines'], 'machineCount')
    const out = mapPartnerRecord({ Company: 'X', 'No. of machines': '60 machines (approx)' }, m)
    assert.equal(out.machineCount, 60)
    assert.equal(mapPartnerRecord({ Company: 'X', 'No. of machines': 'many' }, m).machineCount, undefined)
  })

  test('a merge fills a blank total but never replaces one that is there', () => {
    const base = { name: 'A', type: 'garment_manufacturer', contacts: [], keywords: [], verification: {} }
    const blank = mergePartner({ ...base, machineCount: null }, { name: 'A', machineCount: 50 })
    assert.equal(blank.next.machineCount, 50)
    const kept = mergePartner({ ...base, machineCount: 70 }, { name: 'A', machineCount: 50 })
    assert.equal(kept.next.machineCount, 70)
  })

  test('Kriyaa can filter by minimum machines, sort by capacity and sees the count', async () => {
    await arrange()
    const tool = toolsFor({ role: 'admin' }).find(t => t.name === 'listManufacturers')
    assert.ok(tool.input_schema.properties.minMachines)
    assert.ok(tool.input_schema.properties.sort.enum.includes('machines'))
    const ctx = ctxFor(await makeAdmin())
    const res = await TOOL_HANDLERS.listManufacturers({ minMachines: 30, sort: 'machines' }, ctx)
    assert.equal(res.ok, true, JSON.stringify(res.data))
    assert.deepEqual(res.data.partners.map(p => [p.name, p.machineCount]), [['Big Unit', 120], ['Mid Unit', 40]])
  })
})
