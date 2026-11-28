import { describe, test, expect } from 'vitest'
import { capsFor } from '../caps.js'
import {
  scoreTone, moqVerified, initialsOf, snakeOf, labelOf, fieldsFor, emptyQuery, queryToParams, activeFilterCount, machineTotal,
  describeQuery, kriyaaPromptFor, sortsFor, TYPE_TABS, CATEGORIES, CLUSTERS, SORTS, STATUSES, canBeLive, cityName,
  readNotes, plainKeywords, certificationsOf,
} from '../partners.js'

describe('who sees the Partner Directory', () => {
  test('only admins', () => {
    expect(capsFor({ role: 'admin', adminType: 'user' }).seePartners).toBe(true)
    expect(capsFor({ role: 'admin', adminType: 'master' }).seePartners).toBe(true)
    expect(capsFor({ role: 'buyer' }).seePartners).toBe(false)
    expect(capsFor({ role: 'manufacturer' }).seePartners).toBe(false)
    expect(capsFor(null).seePartners).toBe(false)
  })
})

describe('verification score badge', () => {
  test('green from 70, amber 50 to 69, grey below and when unknown', () => {
    expect(scoreTone(70).level).toBe('high')
    expect(scoreTone(100).level).toBe('high')
    expect(scoreTone(69).level).toBe('mid')
    expect(scoreTone(50).level).toBe('mid')
    expect(scoreTone(49).level).toBe('low')
    expect(scoreTone(0).level).toBe('low')
    expect(scoreTone(null).level).toBe('unknown')
    expect(scoreTone(undefined).label).toBe('Unscored')
  })
})

describe('MOQ claims', () => {
  test('a MOQ is self-reported until GST is verified or a sample is approved', () => {
    expect(moqVerified({ verification: {} })).toBe(false)
    expect(moqVerified({ verification: { referencesChecked: true, siteVisited: true } })).toBe(false)
    expect(moqVerified({ verification: { gstVerified: true } })).toBe(true)
    expect(moqVerified({ verification: { sampleApproved: true } })).toBe(true)
    expect(moqVerified(null)).toBe(false)
  })
})

describe('labels and tags', () => {
  test('initials, snake tags and labels', () => {
    expect(initialsOf('Dossil Fashions Pvt Ltd')).toBe('DF')
    expect(initialsOf('DGREEN')).toBe('D')
    expect(initialsOf('(info) 16th July Exports')).toBe('I1')
    expect(initialsOf('')).toBe('?')
    expect(snakeOf('Sports Bra')).toBe('sports_bra')
    expect(snakeOf(' poly-spandex ')).toBe('poly_spandex')
    expect(labelOf('sports_bra')).toBe('Sports bra')
  })

  test('which sections a type shows', () => {
    expect(fieldsFor('garment_manufacturer')).toEqual({ garment: true, fabricTypes: false, trimCategories: false })
    expect(fieldsFor('fabric_supplier')).toEqual({ garment: false, fabricTypes: true, trimCategories: false })
    expect(fieldsFor('trims_supplier')).toEqual({ garment: false, fabricTypes: false, trimCategories: true })
    expect(fieldsFor('trader')).toEqual({ garment: false, fabricTypes: false, trimCategories: false })
  })
})

describe('the list query', () => {
  test('an empty query asks only for the default sort and page', () => {
    expect(queryToParams(emptyQuery())).toEqual({ sort: 'score', limit: 120 })
    expect(activeFilterCount(emptyQuery())).toBe(0)
  })

  test('the tab becomes a type list; filters become comma lists and flags', () => {
    const q = { ...emptyQuery(), tab: 'other', search: ' ludh ', cluster: ['ludhiana', 'tiruppur'], fabric: ['poly_spandex'], minScore: 70, verifiedOnly: true }
    const p = queryToParams(q)
    expect(p.type).toBe('dyer_processor,trader,buying_house,unknown')
    expect(p.search).toBe('ludh')
    expect(p.cluster).toBe('ludhiana,tiruppur')
    expect(p.fabric).toBe('poly_spandex')
    expect(p.product).toBeUndefined()
    expect(p.minScore).toBe(70)
    expect(p.verifiedOnly).toBe(1)
    expect(p.maxScore).toBeUndefined()
    expect(activeFilterCount(q)).toBe(5)
    expect(queryToParams({ ...emptyQuery(), tab: 'garment' }).type).toBe('garment_manufacturer')
    expect(queryToParams({ ...emptyQuery(), tab: 'all' }).type).toBeUndefined()
  })

  test('"best match" only applies while searching', () => {
    expect(queryToParams({ ...emptyQuery(), sort: 'relevance' }).sort).toBe('score')
    expect(queryToParams({ ...emptyQuery(), sort: 'relevance', search: 'x' }).sort).toBe('relevance')
    expect(sortsFor(false).some(s => s.v === 'relevance')).toBe(false)
    expect(sortsFor(true)[0].v).toBe('relevance')
  })

  test('every tab but All names real types, together covering all seven', () => {
    const all = TYPE_TABS.flatMap(t => t.types)
    expect(new Set(all).size).toBe(7)
  })
})

describe('categories', () => {
  test('five categories, sent as a comma list and counted as a filter', () => {
    expect(CATEGORIES.map(c => c.v)).toEqual(['athleisure', 'indian', 'western', 'fusion', 'home_textiles'])
    const q = { ...emptyQuery(), category: ['athleisure', 'fusion'] }
    expect(queryToParams(q).category).toBe('athleisure,fusion')
    expect(queryToParams(emptyQuery()).category).toBeUndefined()
    expect(activeFilterCount(q)).toBe(2)
    expect(describeQuery(q)).toBe('for athleisure or fusion')
  })
})

describe('clusters and ranking', () => {
  test('Ludhiana, one NCR, Jaipur, Kolkata, Tiruppur, other; no Noida or Delhi of their own', () => {
    expect(CLUSTERS.map(c => c.v)).toEqual(['ludhiana', 'ncr', 'jaipur', 'kolkata', 'tiruppur', 'other'])
  })

  test('priority is out of the list: no filter, no sort; score ranks', () => {
    const q = emptyQuery()
    expect('priority' in q).toBe(false)
    expect('priority' in queryToParams({ ...q, priority: ['A'] })).toBe(false)
    expect(SORTS.map(s => s.v)).toEqual(['score', 'updated', 'machines', 'name'])
    expect(queryToParams(q).sort).toBe('score')
  })
})

describe('one status: Live', () => {
  test('Live is a status, there is no Onboarded, and no On platform filter', () => {
    expect(STATUSES.map(s => s.v)).toEqual(['new', 'contacted', 'qualified', 'pilot', 'live', 'rejected', 'off_scope'])
    expect('onPlatform' in emptyQuery()).toBe(false)
    expect('onPlatform' in queryToParams({ ...emptyQuery(), onPlatform: true })).toBe(false)
  })

  test('only a partner with a platform account can be set to Live', () => {
    expect(canBeLive({ onPlatform: true })).toBe(true)
    expect(canBeLive({ onPlatform: false })).toBe(false)
    expect(canBeLive(null)).toBe(false)
  })
})

describe('the city on a card', () => {
  test('only the place, never the address filed in brackets after it', () => {
    expect(cityName('Noida (C-117-118, Hosiery Complex, Phase-2 Ext, 201305)')).toBe('Noida')
    expect(cityName('New Delhi (Shakurpur)')).toBe('New Delhi')
    expect(cityName('Ludhiana (Millar Ganj)')).toBe('Ludhiana')
    expect(cityName('Ludhiana / Baddi')).toBe('Ludhiana / Baddi')
    expect(cityName('Jaipur')).toBe('Jaipur')
    expect(cityName('')).toBe('')
    expect(cityName(null)).toBe('')
  })
})

describe('brands', () => {
  test('the brand filter is sent as a comma list and counted', () => {
    const q = { ...emptyQuery(), brand: ['Cocoblu', 'Fitleasure'] }
    expect(queryToParams(q).brand).toBe('Cocoblu,Fitleasure')
    expect(queryToParams(emptyQuery()).brand).toBeUndefined()
    expect(activeFilterCount(q)).toBe(2)
    expect(describeQuery(q)).toBe('working with Cocoblu or Fitleasure')
  })
})

describe('live manufacturers', () => {
  test('the live switch is a filter and is sent as a flag', () => {
    const q = { ...emptyQuery(), live: true }
    expect(queryToParams(q).live).toBe(1)
    expect(queryToParams(emptyQuery()).live).toBeUndefined()
    expect(activeFilterCount(q)).toBe(1)
    expect(describeQuery(q)).toBe('live (orders at Tradio now)')
  })
})

describe('Ask Kriyaa', () => {
  test('the question is the typed words, else the filters, else a default', () => {
    expect(kriyaaPromptFor(emptyQuery(), 'knit tees ludhiana')).toMatch(/knit tees ludhiana/)
    const q = { ...emptyQuery(), cluster: ['ludhiana'], category: ['athleisure'], verifiedOnly: true }
    expect(describeQuery(q)).toBe('for athleisure, in Ludhiana, verified (GST checked or sample approved)')
    expect(kriyaaPromptFor(q, '  ')).toMatch(/for athleisure, in Ludhiana/)
    expect(kriyaaPromptFor(emptyQuery(), '')).toMatch(/low-MOQ garment manufacturers/)
  })
})

describe('machines', () => {
  test('the total is the entered figure, else the sum of the types, else not recorded', () => {
    expect(machineTotal({ machineCount: 60, machines: { flatlock: 5 } })).toBe(60)
    expect(machineTotal({ machineCount: 0, machines: { flatlock: 5 } })).toBe(0)
    expect(machineTotal({ machineCount: null, machines: { flatlock: 5, overlock: 3, coverstitch: 0, singleNeedle: 0 } })).toBe(8)
    expect(machineTotal({ machineCount: null, machines: { flatlock: 0, overlock: 0 } })).toBeNull()
    expect(machineTotal({ machineCount: null })).toBeNull()
  })

  test('the minimum is a filter: sent to the API, counted, and put in words', () => {
    expect(queryToParams(emptyQuery()).minMachines).toBeUndefined()
    const q = { ...emptyQuery(), minMachines: 50 }
    expect(queryToParams(q).minMachines).toBe(50)
    expect(activeFilterCount(q)).toBe(1)
    expect(describeQuery(q)).toContain('at least 50 machines')
    expect(queryToParams({ ...emptyQuery(), sort: 'machines' }).sort).toBe('machines')
  })
})

describe('reading a partner\'s notes into a profile', () => {
  const notes = [
    'Lead: met at the Tiruppur fair.',
    'From the profile on file (WorkDrive, Sourcing Team/Vendors), read 28 Nov 2026:\nSmall knit unit near Tirupur.\nEstablished: 2012\nCapacity: 60,000 pcs/month\nWorkforce: 42 workers\nCertifications: GOTS, OEKO-TEX Standard 100\nCertificate details: GOTS licence 123, valid to 2026-11-12\nCame through: Alliance Apparel\nNote: To confirm: no GSTIN in the files.\nFiles: Guru Tex - GOTS Certificate.pdf',
    'Web research, 28 Nov 2026 (public pages, not verified by Tradio):\nListed on IndiaMART as a knitwear exporter.\nEstablished: 2010\nCertifications: gots, SEDEX\nSources: https://example.com/a https://example.com/b',
  ].join('\n\n')

  test('dated blocks become a summary, facts, certifications and things to confirm; the rest stays as own notes', () => {
    const r = readNotes(notes)
    expect(r.own).toBe('Lead: met at the Tiruppur fair.')
    expect(r.blocks.map(b => b.kind)).toEqual(['profile', 'web'])
    expect(r.blocks[0].summary).toBe('Small knit unit near Tirupur.')
    expect(r.blocks[0].toConfirm).toBe('no GSTIN in the files.')
    expect(r.blocks[0].files).toBe('Guru Tex - GOTS Certificate.pdf')
    expect(r.blocks[1].sources).toEqual(['https://example.com/a', 'https://example.com/b'])
    expect(r.facts).toEqual({ established: '2012', capacity: '60,000 pcs/month', workforce: '42 workers', cameThrough: 'Alliance Apparel' }) // the first block to say it wins
    expect(r.certifications).toEqual(['GOTS', 'OEKO-TEX Standard 100', 'SEDEX'])
    expect(r.certDetails).toEqual(['GOTS licence 123, valid to 2026-11-12'])
  })

  test('plain notes and no notes are left alone', () => {
    expect(readNotes('Just a note.\nSecond line: with a colon.')).toMatchObject({ own: 'Just a note.\nSecond line: with a colon.', blocks: [], certifications: [] })
    expect(readNotes(undefined)).toMatchObject({ own: '', blocks: [] })
  })

  test('certification tags are shown once: under certifications, not among the keywords', () => {
    const p = { keywords: ['knits', 'gots', 'sedex', 'via alliance apparel'] }
    expect(plainKeywords(p.keywords)).toEqual(['knits'])
    expect(certificationsOf(p, readNotes(''))).toEqual(['GOTS', 'SEDEX'])
    expect(certificationsOf(p, readNotes(notes))).toEqual(['GOTS', 'OEKO-TEX Standard 100', 'SEDEX'])
  })
})
