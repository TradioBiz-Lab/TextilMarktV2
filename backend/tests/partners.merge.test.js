// Merging new source rows into the directory: no duplicates, no overwriting what people entered, and the out-of-scope entries
// taken off the active list. Pure planning functions (lib/partnerMerge.js) and the Amazon row mapping.

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import { canonicalKey, mergePartner, planMerge, isRemovedName, REMOVE_NAMES, REMOVE_REASON } from '../src/lib/partnerMerge.js'
import { amazonToPartner, vendorToPartner, splitCityAddress, displayName } from '../src/lib/partnerSeed.js'
import { cleanPartnerInput } from '../src/lib/partners.js'
import { appendToImageReport, imageReportMarkdown } from '../src/lib/partnerImagePrompts.js'

const stored = (o = {}) => ({
  _id: o.name || 'x', type: 'garment_manufacturer', status: 'new', isActive: true, priority: 'C', city: '', address: '', cluster: undefined,
  contacts: [], keywords: [], fabrics: [], fabricTypes: [], trimCategories: [], categories: [], brands: [], products: [], notes: '', source: '',
  verification: { score: null, gstVerified: false }, moqPerStyleColour: null, ...o,
})

describe('the same partner under different spellings', () => {
  test('the aliases named for this update, and the usual company-form noise, give one key', () => {
    assert.equal(canonicalKey('Shiv Shakti Enterprises (likely)'), canonicalKey('Shiv Shakti Enterprises'))
    assert.equal(canonicalKey('Shivshakti Enterprises (company not identified)'), canonicalKey('Shiv Shakti Enterprises'))
    assert.equal(canonicalKey('Chinmay Ludhiana'), canonicalKey('Chinmay Enterprises'))
    assert.equal(canonicalKey('Indira Hosiery Mills'), canonicalKey('Indra Hosiery Mills'))
    assert.equal(canonicalKey('  INDRA   hosiery mills '), canonicalKey('Indra Hosiery Mills'))
    assert.equal(canonicalKey('Sportking group (Sobhagia)'), canonicalKey('Sportking (Sobhagia)'))
    assert.notEqual(canonicalKey('Chinmay Enterprises'), canonicalKey('Shiv Shakti Enterprises'))
    assert.equal(displayName('Shiv Shakti Enterprises (likely)'), 'Shiv Shakti Enterprises')
  })
})

describe('merging into a partner that exists', () => {
  test('blanks are filled, lists are added to, and nothing a person entered is replaced', () => {
    const cur = stored({ name: 'Indra Hosiery Mills', city: 'Ludhiana (Sunder Nagar)', cluster: 'ludhiana', status: 'qualified', notes: 'Called Manpreet: 150 pcs MOQ.', brands: ['Cocoblu'], keywords: ['leggings'],
      contacts: [{ name: 'Manpreet', role: '', phone: '+91 1', email: 'm@x.in', whatsapp: '' }], verification: { score: 65, gstVerified: true } })
    const inc = { name: 'Indra Hosiery Mills', city: 'Somewhere Else', cluster: 'other', address: '4576, 70 Feet Road', brands: ['FYLTR', 'cocoblu'], keywords: ['leggings', 'thermals'],
      contacts: [{ name: 'Manpreet', role: '', phone: '', email: 'M@X.in', whatsapp: '' }, { name: 'Bharat', role: '', phone: '', email: 'b@x.in', whatsapp: '' }],
      notes: 'Amazon: declared manufacturer on 3 FYLTR ASINs', source: 'Amazon listing mining, 27 Oct 2026' }
    const { next, diffs } = mergePartner(cur, inc)
    assert.equal(next.city, 'Ludhiana (Sunder Nagar)', 'a city someone has is kept')
    assert.equal(next.cluster, 'ludhiana')
    assert.equal(next.address, '4576, 70 Feet Road', 'a blank is filled')
    assert.deepEqual(next.brands, ['Cocoblu', 'FYLTR'], 'brands are united, whatever the capitalisation')
    assert.deepEqual(next.keywords, ['leggings', 'thermals'])
    assert.deepEqual(next.contacts.map(c => c.name), ['Manpreet', 'Bharat'], 'a contact with the same email is not added twice')
    assert.equal(next.notes, 'Called Manpreet: 150 pcs MOQ.\n\nAmazon: declared manufacturer on 3 FYLTR ASINs', 'the person\'s note stays, the new text follows')
    assert.equal(next.source, 'Amazon listing mining, 27 Oct 2026')
    assert.equal(next.status, 'qualified')
    assert.deepEqual(next.verification, cur.verification)
    assert.deepEqual(diffs.map(d => d.field).sort(), ['address', 'brands', 'contacts', 'keywords', 'notes', 'source'])
  })

  test('placeholders are upgraded: type unknown, cluster other, a stand-in name; nothing else about the type', () => {
    const cur = stored({ name: 'Shivshakti Enterprises (company not identified)', type: 'unknown', cluster: 'other' })
    const { next } = mergePartner(cur, { name: 'Shiv Shakti Enterprises', type: 'garment_manufacturer', cluster: 'jaipur', city: 'Jaipur' })
    assert.equal(next.name, 'Shiv Shakti Enterprises')
    assert.equal(next.type, 'garment_manufacturer')
    assert.equal(next.cluster, 'jaipur')
    assert.equal(next.city, 'Jaipur')
    const keep = mergePartner(stored({ name: 'A', type: 'trader', cluster: 'ludhiana' }), { name: 'A', type: 'garment_manufacturer', cluster: 'jaipur' }).next
    assert.equal(keep.type, 'trader', 'a type someone chose is not replaced')
    assert.equal(keep.cluster, 'ludhiana')
  })

  test('blank or weaker incoming data never wipes a field', () => {
    const cur = stored({ name: 'A', city: 'Noida', address: 'Plot 1', website: 'https://a.in', moqPerStyleColour: 120, moqNote: '120 pcs', notes: 'good note', brands: ['Cocoblu'] })
    const { next, diffs } = mergePartner(cur, { name: 'A', city: '', address: '', website: '', moqPerStyleColour: null, moqNote: '', notes: '', brands: [], contacts: [], keywords: [] })
    assert.deepEqual(next, cur)
    assert.deepEqual(diffs, [])
  })

  test('the same notes twice are written once', () => {
    const inc = { name: 'A', notes: 'line one\nline two', source: 'S1' }
    const once = mergePartner(stored({ name: 'A' }), inc).next
    const twice = mergePartner(once, inc)
    assert.equal(twice.next.notes, 'line one\nline two')
    assert.deepEqual(twice.diffs, [])
  })
})

describe('planning a whole run', () => {
  const existing = [
    stored({ name: 'Chinmay Enterprises', type: 'unknown', notes: 'Website blocks crawlers' }),
    stored({ name: 'Wings2Fashion (R S Enterprises)', type: 'buying_house', status: 'new' }),
    stored({ name: 'MASS India / Mirthuni Apparel Sourcing', type: 'buying_house', status: 'rejected' }),
    stored({ name: 'Lal10 Noida', type: 'buying_house' }),
    stored({ name: 'Unrelated Mills' }),
    stored({ name: 'HCR Enterprises', status: 'live', linkedUserId: 'u1' }),
  ]
  const incoming = [
    { source: 'Vendors', body: { name: 'Chinmay Enterprises', type: 'garment_manufacturer', city: 'Ludhiana', cluster: 'ludhiana', notes: 'Resolved on 13 ASINs' } },
    { source: 'Amazon', body: { name: 'Chinmay Ludhiana', brands: ["Pump'd"], source: 'Amazon listing mining, 27 Oct 2026' } },
    { source: 'Amazon', body: { name: 'Brand New Mills', type: 'garment_manufacturer', brands: ['FYLTR'] } },
    { source: 'Vendors', body: { name: 'Brand New Mills (likely)'.replace(' (likely)', ''), city: 'Surat' } },
    { source: 'Leads', body: { name: 'Wings2Fashion (R S Enterprises)', type: 'buying_house' } },
  ]

  test('creates, updates (with field diffs), deactivates and skips; one row per partner whatever the spelling', () => {
    const plan = planMerge(existing, incoming)
    assert.deepEqual(plan.create.map(c => c.name), ['Brand New Mills'])
    assert.deepEqual(plan.create[0].brands, ['FYLTR'])
    assert.equal(plan.create[0].city, 'Surat', 'two rows for one new partner become one record')
    assert.deepEqual(plan.create[0]._sources, ['Amazon', 'Vendors'])
    assert.equal(plan.update.length, 1)
    assert.equal(plan.update[0].partner.name, 'Chinmay Enterprises')
    assert.deepEqual(plan.update[0].diffs.map(d => d.field).sort(), ['brands', 'city', 'cluster', 'notes', 'source', 'type'])
    assert.equal(plan.update[0].patch.type, 'garment_manufacturer')
    assert.deepEqual(plan.deactivate.map(d => d.partner.name).sort(), ['Lal10 Noida', 'MASS India / Mirthuni Apparel Sourcing', 'Wings2Fashion (R S Enterprises)'])
    assert.ok(plan.deactivate.every(d => d.reason === REMOVE_REASON))
    assert.ok(plan.skipped.some(s => s.name === 'Wings2Fashion (R S Enterprises)' && /not imported/.test(s.reason)), 'a removed name in a source is not imported')
  })

  test('a platform or live partner is never removed, an already removed one is left alone, and nothing is planned twice', () => {
    const risky = [stored({ name: 'Lal10', status: 'live', linkedUserId: 'u9' }), stored({ name: 'T International', isActive: false, status: 'off_scope' })]
    const plan = planMerge(risky, [])
    assert.deepEqual(plan.deactivate, [])
    assert.deepEqual(plan.skipped.map(s => s.reason).sort(), ['already removed', 'is on the platform: not removed'])
    // after the plan is applied by hand, a second plan is empty
    const after = existing.map(p => (isRemovedName(p.name) ? { ...p, isActive: false, status: 'off_scope' } : p))
    const first = planMerge(existing, incoming)
    const applied = [...after.filter(p => p.name !== 'Chinmay Enterprises'), { ...existing[0], ...first.update[0].patch }, { ...first.create[0] }]
    const second = planMerge(applied, incoming)
    assert.equal(second.create.length, 0)
    assert.equal(second.update.length, 0)
    assert.equal(second.deactivate.length, 0)
  })

  test('the removal list names exactly the seven out-of-scope entries, matched case-insensitively and by prefix', () => {
    assert.equal(REMOVE_NAMES.length, 7)
    for (const n of ['lal10', 'LAL10 NOIDA', 'ASK Apparels & Textiles Sourcing', 'RDPL Digital Value Added Services Pvt Ltd', 'Bhagwandas Retail Private Limited', 'T International', 'Wings2Fashion (R S Enterprises)', 'MASS India / Mirthuni Apparel Sourcing']) assert.ok(isRemovedName(n), n)
    for (const n of ['Lal Mills', 'International Knits', 'ASK Garments', 'Dossil Fashions']) assert.equal(isRemovedName(n), false, n)
  })
})

describe('Amazon_Mined_Manufacturers rows', () => {
  const row = (o = {}) => ({
    '#': '1', 'Manufacturer (canonical)': 'Sairam', 'Name variants on listings': 'Plot no. 58-59, Street 3', 'City / address': 'Ludhiana (Plot 58-59, St 3, Mahavir Hosiery Complex, Kailash Nagar Rd)',
    Cluster: 'Ludhiana', 'Entity assessment': 'Manufacturer (likely)', 'Activewear relevant': 'Yes', 'Cocoblu brands supplied': "FYLTR, Pump'd",
    'Example products': "PUMP'D Women's Jacket | Slim Fit | dry-fit tees | leggings", Notes: 'Top Pump\'d maker by revenue: jackets, dry-fit tees, half-zips, shorts.', ...o,
  })

  test('maps to name, address and city, cluster, notes, keywords, brands, type and source', () => {
    const p = amazonToPartner(row())
    assert.equal(p.name, 'Sairam')
    assert.equal(p.city, 'Ludhiana')
    assert.match(p.address, /Mahavir Hosiery Complex/)
    assert.equal(p.cluster, 'ludhiana')
    assert.equal(p.type, 'garment_manufacturer')
    assert.equal(p.source, 'Amazon listing mining, 27 Oct 2026')
    assert.deepEqual(p.brands, ['FYLTR', "Pump'd"])
    assert.deepEqual(p.keywords, ['leggings'])
    assert.deepEqual(p.categories, ['athleisure'])
    assert.match(p.notes, /Entity assessment \(Amazon listings\): Manufacturer \(likely\)/)
    assert.match(p.notes, /Top Pump'd maker/)
    assert.equal(cleanPartnerInput(p).errors, undefined, 'passes the API\'s own validation')
  })

  test('clusters: Jaipur is a cluster, other cities stay "other" with the city set, NCR towns are NCR', () => {
    const c = (city, Cluster = 'Other') => amazonToPartner(row({ 'City / address': city, Cluster }))
    assert.equal(c('Jaipur').cluster, 'jaipur')
    assert.equal(c('Surat').cluster, 'other')
    assert.equal(c('Surat').city, 'Surat')
    assert.equal(c('Bengaluru').city, 'Bengaluru')
    assert.equal(c('Ghaziabad, UP', 'Delhi-NCR').cluster, 'ncr')
    assert.equal(c('Ghaziabad, UP', 'Delhi-NCR').city, 'Ghaziabad')
    assert.equal(c('Tirupur', 'Tiruppur').cluster, 'tiruppur')
    assert.equal(c('India (not stated)').city, '')
    assert.deepEqual(splitCityAddress('Sangli, MH'), { city: 'Sangli', address: 'Sangli, MH' })
    assert.deepEqual(splitCityAddress('Surat'), { city: 'Surat', address: '' })
  })

  test('an ethnicwear maker is categorised Indian; a blank row is skipped', () => {
    assert.deepEqual(amazonToPartner(row({ 'Example products': 'Kaari kurta sets', Notes: 'Kaari kurta sets, 56% of revenue.' })).categories, ['indian'])
    assert.equal(amazonToPartner(row({ 'Manufacturer (canonical)': '' })), null)
  })
})

describe('the updated Vendors rows', () => {
  const v = (o = {}) => ({ '#': '2', Company: 'Chinmay Enterprises', Category: 'Manufacturer (knit activewear)', City: 'Ludhiana', Address: '', 'What they do': 'Website blocks crawlers', 'Contact name(s)': 'Vivek Kumar', 'Email(s)': 'merch3@chinmayenterprises.in', 'Phone(s)': '', Website: 'chinmayenterprises.in', Confidence: 'Likely', 'Amazon listing match (27 Oct 2026)': "Resolved: declared manufacturer on 13 Pump'd ASINs (leggings, quick-dry tees)", ...o })

  test('the Amazon match is appended to the notes, the category sets type and cluster', () => {
    const p = vendorToPartner(v(), { importedOn: '2026-10-27' })
    assert.equal(p.type, 'garment_manufacturer')
    assert.equal(p.cluster, 'ludhiana')
    assert.match(p.notes, /Amazon listing match: Resolved: declared manufacturer on 13 Pump'd ASINs/)
    assert.deepEqual(p.categories, ['athleisure'])
  })

  test('"Shiv Shakti Enterprises (likely)" is filed as Shiv Shakti Enterprises, as an ethnicwear maker in Jaipur', () => {
    const p = vendorToPartner(v({ Company: 'Shiv Shakti Enterprises (likely)', Category: 'Manufacturer (ethnicwear), likely', City: 'Jaipur', 'Contact name(s)': 'Shivshakti Enterprises', 'Amazon listing match (27 Oct 2026)': "Likely 'Shiv Shakti Enterprises', Jaipur: declared manufacturer on 4 Kaari ASINs (chikankari kurta sets)" }), { importedOn: '2026-10-27' })
    assert.equal(p.name, 'Shiv Shakti Enterprises')
    assert.equal(p.cluster, 'jaipur')
    assert.deepEqual(p.categories, ['indian'])
  })
})

describe('the images report', () => {
  test('new partners are appended in the same format and prompt style, once each, numbered on from the old lines', () => {
    const P = '#F97316'
    const base = imageReportMarkdown([{ name: 'Old One', type: 'garment_manufacturer', city: 'Ludhiana' }], { primary: P, generatedOn: '2026-10-27' })
    const fresh = [{ name: 'Brand New Mills', type: 'garment_manufacturer', city: 'Surat', categories: ['indian'], keywords: [] }, { name: 'Old One', type: 'garment_manufacturer' }]
    const out = appendToImageReport(base, fresh, { primary: P })
    assert.deepEqual(out.added, ['Brand New Mills'])
    assert.match(out.md, /2 partners have no tile yet\./)
    assert.match(out.md, /- \*\*Brand New Mills\*\* \| garment manufacturer \| Surat \| save as `brand-new-mills\.png`\n {2}`flat illustrative tile of [^`]* in Surat[^`]*embroidered ethnic panels/)
    assert.equal((out.md.match(/\*\*Old One\*\*/g) || []).length, 1)
    assert.equal(appendToImageReport(out.md, fresh, { primary: P }).added.length, 0, 'a second append adds nothing')
    const promptsOnly = out.md.split('\n').filter(l => l.startsWith('  `'))
    assert.equal(new Set(promptsOnly).size, 2)
  })
})
