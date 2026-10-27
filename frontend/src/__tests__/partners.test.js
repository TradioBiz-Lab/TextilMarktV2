import { describe, test, expect } from 'vitest'
import { capsFor } from '../caps.js'
import {
  scoreTone, moqVerified, initialsOf, snakeOf, labelOf, fieldsFor, emptyQuery, queryToParams, activeFilterCount,
  describeQuery, kriyaaPromptFor, sortsFor, TYPE_TABS, CATEGORIES, CLUSTERS, SORTS,
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
    expect(SORTS.map(s => s.v)).toEqual(['score', 'updated', 'name'])
    expect(queryToParams(q).sort).toBe('score')
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
