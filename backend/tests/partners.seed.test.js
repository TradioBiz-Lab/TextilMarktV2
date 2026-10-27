// The seed importer's mapping of the two research spreadsheets, and the image-prompt report. Pure functions: the
// spreadsheets themselves live outside the repo, so these use rows copied from them.

import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import { leadToPartner, vendorToPartner, vendorCategory, parseMoq, extractSpecialisedProducts, extractFabrics, keywordsFor, inferCategories } from '../src/lib/partnerSeed.js'
import { cleanPartnerInput } from '../src/lib/partners.js'
import { imagePromptFor, imageReportMarkdown, tileFileName, matchTileFiles } from '../src/lib/partnerImagePrompts.js'

const importedOn = '2026-10-27'

const lead = (o = {}) => ({
  '#': '1', Company: '16th July Exports', City: 'New Delhi (Shakurpur)', Cluster: 'Delhi-NCR', Type: 'Manufacturer (claimed)',
  'Products / capability': 'Full knit activewear: leggings, sports bras (racerback/longline), joggers, gym tees, shorts; poly-spandex 80/20 180-220 GSM, cotton-spandex 95/5; flatlock seams',
  'MOQ claim (self-reported)': '100 pcs/style', Contact: '', Phone: '+91 98680 88882 (WhatsApp)', Email: '', Website: '16thjulyexports.com/activewearmanufacturer',
  Source: 'Own website, captured 27 Oct 2026', Confidence: 'Medium: claims verified verbatim on site', Priority: 'A', Status: 'New', 'Next action': 'Call, run 8 qualifying questions', ...o,
})

describe('Leads rows', () => {
  test('map to a valid partner with products, fabrics, MOQ claim, contact and keywords', () => {
    const p = leadToPartner(lead(), { importedOn })
    assert.equal(p.name, '16th July Exports')
    assert.equal(p.type, 'garment_manufacturer')
    assert.equal(p.cluster, 'delhi_ncr')
    assert.deepEqual(p.products, undefined, 'generic garments are not listed: the category says it')
    assert.deepEqual(p.categories, ['athleisure'])
    assert.deepEqual(p.fabrics, ['poly_spandex', 'cotton_lycra'])
    assert.equal(p.moqPerStyleColour, 100)
    assert.equal(p.moqNote, '100 pcs/style')
    assert.deepEqual(p.contacts, [{ name: '', role: '', phone: '+91 98680 88882', email: '', whatsapp: '+91 98680 88882' }])
    assert.equal(p.website, 'https://16thjulyexports.com/activewearmanufacturer')
    assert.equal(p.priority, 'A')
    assert.equal(p.status, 'new')
    assert.match(p.source, /captured 27 Oct 2026/)
    assert.match(p.notes, /Full knit activewear/)
    assert.match(p.notes, /Confidence: Medium/)
    assert.match(p.notes, /Next action: Call/)
    assert.deepEqual(p.keywords, ['sports bras', 'leggings'], 'only specialised products, no city or fabric')
    assert.equal(cleanPartnerInput(p).errors, undefined, 'passes the same validation as a hand-made partner')
  })

  test('types, clusters, statuses and MOQ notes of the other rows', () => {
    const t = type => leadToPartner(lead({ Type: type }), { importedOn }).type
    assert.equal(t('Trading company (NOT a factory)'), 'trader')
    assert.equal(t('Buying house type, audit needed'), 'buying_house')
    assert.equal(t('Sourcing/buying agent'), 'buying_house')
    assert.equal(t('Manufacturer (large, integrated)'), 'garment_manufacturer')
    assert.equal(t(''), 'unknown')
    const c = (Cluster, City = 'x') => leadToPartner(lead({ Cluster, City }), { importedOn }).cluster
    assert.equal(c('Noida/NCR'), 'noida_ncr')
    assert.equal(c('Ludhiana'), 'ludhiana')
    assert.equal(c('Tiruppur'), 'tiruppur')
    assert.equal(c('TBD', 'Not listed'), undefined)
    const s = Status => leadToPartner(lead({ Status }), { importedOn }).status
    assert.equal(s('Existing contact'), 'contacted')
    assert.equal(s('Excluded for now'), 'rejected')
    assert.equal(s('Off-scope'), 'off_scope')
    const off = leadToPartner(lead({ 'MOQ claim (self-reported)': 'Off-scope: too large for 100 pc/colour' }), { importedOn })
    assert.equal(off.moqPerStyleColour, undefined, 'a number in a note is not the partner\'s claim')
    assert.match(off.moqNote, /too large/)
    assert.equal(parseMoq('Not listed').moqPerStyleColour, undefined)
    assert.equal(parseMoq('50 pcs/style (claimed)').moqPerStyleColour, 50)
    assert.equal(parseMoq('10 pcs').moqPerStyleColour, 10)
  })

  test('a website cell that is not an address is dropped; a source without a date gets the import date', () => {
    const p = leadToPartner(lead({ Website: 'via TradeIndia listing', Source: 'Existing contact (Cocoblu vendor file)' }), { importedOn })
    assert.equal(p.website, '')
    assert.equal(p.source, 'Existing contact (Cocoblu vendor file); imported 2026-10-27')
  })

  test('a row without a company is dropped; two contacts in one cell stay two contacts', () => {
    assert.equal(leadToPartner(lead({ Company: '' }), { importedOn }), null)
    const p = leadToPartner(lead({ Contact: 'Anil; Rita', Email: 'a@x.in; r@x.in' }), { importedOn })
    assert.deepEqual(p.contacts.map(c => [c.name, c.email]), [['Anil', 'a@x.in'], ['Rita', 'r@x.in']])
  })
})

const vendor = (o = {}) => ({
  '#': '1', Company: 'Indra Hosiery Mills', Category: 'Manufacturer (knits)', City: 'Ludhiana', Address: '4576, 70 Feet Road, Sunder Nagar',
  'What they do': "Men's and ladies' jackets, full-sleeve tees.", 'Contact name(s)': 'Indra Hosiery Mills; Manpreet Singh; Bharat Kohli',
  'Email(s)': 'indracorp1954@gmail.com; manpreet.singh@indrahosierymills.com; bharat.kohli@indrahosierymills.com', 'Phone(s)': '',
  Website: 'indrahosierymills.com', Confidence: 'Confirmed', ...o,
})

describe('Vendors rows', () => {
  test('several contacts in one cell become separate contacts, in step with their emails and phones', () => {
    const p = vendorToPartner(vendor(), { importedOn })
    assert.equal(p.contacts.length, 3)
    assert.deepEqual(p.contacts.map(c => c.name), ['Indra Hosiery Mills', 'Manpreet Singh', 'Bharat Kohli'])
    assert.equal(p.contacts[1].email, 'manpreet.singh@indrahosierymills.com')
    const two = vendorToPartner(vendor({ 'Contact name(s)': 'Sanjeev; Rahul Kalia', 'Email(s)': 'a@x.in; b@x.in', 'Phone(s)': '+91 1795 271087; +91 161 2846846' }), { importedOn })
    assert.deepEqual(two.contacts.map(c => [c.name, c.phone]), [['Sanjeev', '+91 1795 271087'], ['Rahul Kalia', '+91 161 2846846']])
    const commas = vendorToPartner(vendor({ 'Contact name(s)': 'Ganesh Fabrics', 'Email(s)': 'info@ganesh.in', 'Phone(s)': '+91 88476 16934, +91 98728 54100' }), { importedOn })
    assert.deepEqual(commas.contacts.map(c => c.phone), ['+91 88476 16934', '+91 98728 54100'])
    assert.equal(cleanPartnerInput(p).errors, undefined)
  })

  test('service providers, brands only and individuals are kept as type unknown and not active', () => {
    const k = Category => vendorCategory(Category)
    assert.deepEqual(k('Service provider (e-com account mgmt), NOT a manufacturer'), { type: 'unknown', isActive: false })
    assert.deepEqual(k('Individual / agent'), { type: 'unknown', isActive: false })
    assert.deepEqual(k('Brand / individual'), { type: 'unknown', isActive: false })
    assert.deepEqual(k('Brand (footwear, accessories)'), { type: 'unknown', isActive: false })
    assert.deepEqual(k('Unknown (likely brand)'), { type: 'unknown', isActive: false })
    assert.deepEqual(k('Unknown'), { type: 'unknown', isActive: true })
    assert.deepEqual(k('Manufacturer (woven, export)'), { type: 'garment_manufacturer', isActive: true })
    assert.deepEqual(k('Manufacturer / brand (denim)'), { type: 'garment_manufacturer', isActive: true })
    assert.deepEqual(k('Manufacturer (leather accessories)'), { type: 'unknown', isActive: true })
    const p = vendorToPartner(vendor({ Category: 'Individual / agent', Company: 'Individual (merchandiser)' }), { importedOn })
    assert.equal(p.isActive, false)
    assert.equal(p.status, 'off_scope')
    assert.equal(p.priority, 'D')
  })

  test('"Not found" cities and an unidentified company are handled', () => {
    const p = vendorToPartner(vendor({ Company: 'Not identified', City: 'Not found', 'Contact name(s)': 'Shivshakti Enterprises', Category: 'Unknown' }), { importedOn })
    assert.equal(p.name, 'Shivshakti Enterprises (company not identified)')
    assert.equal(p.city, '')
    assert.equal(p.cluster, undefined)
    assert.equal(vendorToPartner(vendor({ City: 'Baddi; Ludhiana' }), { importedOn }).cluster, 'ludhiana')
    assert.equal(vendorToPartner(vendor({ City: 'Jaipur' }), { importedOn }).cluster, 'other')
    const desk = vendorToPartner(vendor({ 'Contact name(s)': '(info desk)', 'Email(s)': 'info@x.in' }), { importedOn })
    assert.deepEqual(desk.contacts.map(c => [c.name, c.email]), [['', 'info@x.in']])
  })
})

describe('vocabulary helpers', () => {
  test('only specialised products become keywords; fabrics are found in free text', () => {
    assert.deepEqual(extractSpecialisedProducts('Full knit activewear: leggings, sports bras, joggers, gym tees, shorts'), ['sports bras', 'leggings'])
    assert.deepEqual(extractSpecialisedProducts('Knit tees, sweatshirts, jackets, lowers, tracksuits'), ['tracksuits'])
    assert.deepEqual(extractSpecialisedProducts("Kids' innerwear, thermals, socks"), ['thermals', 'socks', 'innerwear'])
    assert.deepEqual(extractSpecialisedProducts('Women\'s dresses and tunics'), [])
    assert.deepEqual(extractFabrics('poly-spandex 80/20, cotton basics'), ['poly_spandex', 'cotton'])
    assert.deepEqual(extractFabrics('cotton-lycra and polyester spandex'), ['poly_spandex', 'cotton_lycra'])
    assert.deepEqual(keywordsFor({ specialised: ['leggings', 'leggings', 'thermals'] }), ['leggings', 'thermals'])
  })
})

describe('categories from the spreadsheets', () => {
  test('set only where the text says so plainly, never fusion, and left empty otherwise', () => {
    assert.deepEqual(inferCategories('Full knit activewear: leggings, sports bras'), ['athleisure'])
    assert.deepEqual(inferCategories("Women's denim jeans and cargos"), ['western'])
    assert.deepEqual(inferCategories('Formal suits, jackets, trousers, waistcoats'), ['western'])
    assert.deepEqual(inferCategories('Casual, ethnic and fire-resistant protective wear'), ['indian'])
    assert.deepEqual(inferCategories('Bed sheets, towels and curtains'), ['home_textiles'])
    assert.deepEqual(inferCategories('Kidswear, babywear, activewear'), ['athleisure'])
    assert.deepEqual(inferCategories('Knit tees, sweatshirts, jackets'), [])
    assert.deepEqual(inferCategories(''), [])
    assert.equal(leadToPartner(lead(), { importedOn }).categories.includes('athleisure'), true)
    assert.deepEqual(vendorToPartner(vendor(), { importedOn }).categories, [])
    assert.equal(cleanPartnerInput(leadToPartner(lead(), { importedOn })).errors, undefined)
  })
})

describe('image prompts', () => {
  const P = '#F97316'
  const STYLE = /simple vector style with soft shading, square 1:1, no text, no logos, no people, consistent muted palette matching #F97316$/

  test('every prompt ends with the one style sentence and names the place; the scene follows the type', () => {
    const knit = imagePromptFor({ type: 'garment_manufacturer', city: 'Ludhiana', categories: ['western'] }, P, 0)
    assert.match(knit, /^flat illustrative tile of a knitwear factory floor in Ludhiana/)
    assert.match(knit, /no text, no logos/)
    assert.match(knit, STYLE)
    assert.match(imagePromptFor({ type: 'garment_manufacturer', city: 'Noida', categories: ['athleisure'] }, P, 0), /activewear factory floor in Noida/)
    assert.match(imagePromptFor({ type: 'garment_manufacturer', city: 'Jaipur', categories: ['indian'] }, P, 0), /woven garment factory floor in Jaipur/)
    assert.match(imagePromptFor({ type: 'fabric_supplier', city: 'Tiruppur' }, P, 0), /rolls of fabric/)
    assert.match(imagePromptFor({ type: 'trims_supplier', cluster: 'delhi_ncr' }, P, 0), /buttons, zippers/)
    assert.match(imagePromptFor({ type: 'unknown' }, P, 0), /apparel industry building with/)
    for (const type of ['garment_manufacturer', 'fabric_supplier', 'trims_supplier', 'dyer_processor', 'trader', 'buying_house', 'unknown']) {
      for (const n of [0, 1, 2, 40]) assert.match(imagePromptFor({ type, city: 'X' }, P, n), STYLE)
    }
  })

  test('what the partner is known for is drawn in', () => {
    const p = imagePromptFor({ type: 'garment_manufacturer', city: 'Ludhiana', categories: ['athleisure'], keywords: ['sports bras', 'leggings'] }, P, 0)
    assert.match(p, /with sports bras on a rack and leggings on hangers/)
    assert.match(imagePromptFor({ type: 'garment_manufacturer', categories: ['indian', 'western'] }, P, 0), /with embroidered ethnic panels and draped fabric and western casual garments on racks/)
    assert.doesNotMatch(imagePromptFor({ type: 'garment_manufacturer' }, P, 0), /, with /)
  })

  test('a batch of partners of the same kind and place gets all different pictures', () => {
    const batch = Array.from({ length: 39 }, (_, i) => ({ name: `Ludhiana Unit ${i}`, type: 'garment_manufacturer', city: 'Ludhiana', categories: ['athleisure'] }))
    const prompts = batch.map((p, i) => imagePromptFor(p, P, i))
    assert.equal(new Set(prompts).size, 39)
    // the scene, the framing and the base colour each really vary
    assert.ok(new Set(prompts.map(x => x.split(', ')[0])).size >= 3)
    assert.ok(new Set(prompts.map(x => /(seen from a high angle|straight-on front view|isometric cutaway view|wide view down a long aisle|close crop on one work table|side elevation with large windows|view through a doorway)/.exec(x)[1])).size === 7)
    assert.ok(new Set(prompts.map(x => / ([a-z -]+) base colours/.exec(x)[1])).size === 6)
  })

  test('without a position the name decides, and the same name always gets the same prompt', () => {
    const a = { name: 'Dossil Fashions', type: 'garment_manufacturer' }
    assert.equal(imagePromptFor(a, P), imagePromptFor({ ...a }, P))
  })

  test('the report has one line per partner with name, type, city and a prompt, all different', () => {
    const md = imageReportMarkdown([
      { name: "Atam Apparel's", type: 'garment_manufacturer', city: 'Ludhiana' },
      { name: 'Bauer India', type: 'unknown' },
      { name: 'Dossil Fashions', type: 'garment_manufacturer', city: 'Ludhiana' },
    ], { primary: P, generatedOn: '2026-10-27' })
    assert.match(md, /3 partners have no tile yet/)
    assert.match(md, /- \*\*Atam Apparel's\*\* \| garment manufacturer \| Ludhiana \| save as `atam-apparel-s\.png`\n {2}`flat illustrative tile of/)
    assert.match(md, /- \*\*Bauer India\*\* \| type unknown \| city unknown/)
    const lines = md.split('\n').filter(l => l.startsWith('  `'))
    assert.equal(new Set(lines).size, 3)
    assert.match(imageReportMarkdown([{ name: 'A', type: 'unknown' }], { primary: P, generatedOn: 'x', redo: true }), /^# Partner tiles: redo, all partners/)
    assert.equal(tileFileName('Dossil Fashions Pvt Ltd'), 'dossil-fashions-pvt-ltd.png')
    assert.equal(tileFileName('A & B (Co.)'), 'a-and-b-co.png')
  })
})

describe('matching tile files to partners', () => {
  const partners = [{ name: '16th July Exports' }, { name: 'Dossil Fashions Pvt Ltd' }, { name: "Atam Apparel's" }]
  test('by the requested file name, whatever the extension; strays and gaps are listed', () => {
    const r = matchTileFiles(['16th-july-exports.png', 'dossil-fashions-pvt-ltd.JPG', 'mystery.png', 'notes.txt'.replace('.txt', '.webp')], partners)
    assert.deepEqual(r.matched.map(m => [m.file, m.partner.name]), [['16th-july-exports.png', '16th July Exports'], ['dossil-fashions-pvt-ltd.JPG', 'Dossil Fashions Pvt Ltd']])
    assert.deepEqual(r.unmatchedFiles, ['mystery.png', 'notes.webp'])
    assert.deepEqual(r.partnersWithoutFile.map(p => p.name), ["Atam Apparel's"])
  })
  test('two files for one partner: the first wins, the other is listed as unmatched', () => {
    const r = matchTileFiles(['16th-july-exports.jpg', '16th-july-exports.png'], partners)
    assert.equal(r.matched.length, 1)
    assert.equal(r.unmatchedFiles.length, 1)
  })
})

describe('the same company under another spelling', () => {
  test('companyKey folds company-form words and punctuation', async () => {
    const { companyKey } = await import('../src/lib/partners.js')
    assert.equal(companyKey('Sportking (Sobhagia)'), companyKey('Sportking group (Sobhagia)'))
    assert.equal(companyKey('Dossil Fashions Pvt Ltd'), companyKey('dossil  fashions'))
    assert.notEqual(companyKey('Ganesh Fabrics'), companyKey('Dossil Fashions'))
    assert.notEqual(companyKey('Sportking (Sobhagia)'), companyKey('Sportking Textiles'))
  })
})
