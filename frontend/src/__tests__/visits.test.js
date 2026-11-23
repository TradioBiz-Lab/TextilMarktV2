import { describe, test, expect } from 'vitest'
import { timeIST, dayIST, durationText, distanceText, factoryCardState, visitsByDay } from '../visits.js'
import { COORDINATOR_TEXT, t, langOf } from '../coordinatorText.js'
import { capsFor, canWriteStage, canManageStepLists, canSetAssignmentStatus } from '../caps.js'

describe('visit times are India times', () => {
  test('time and day', () => {
    expect(timeIST('2026-11-23T05:12:00.000Z')).toBe('10:42')
    expect(timeIST('2026-11-23T19:00:00.000Z')).toBe('00:30')
    expect(dayIST('2026-11-23T19:00:00.000Z')).toBe('2026-11-24')
    expect(timeIST(null)).toBe('')
    expect(timeIST('nonsense')).toBe('')
  })
  test('durations and distances read plainly', () => {
    expect(durationText(153)).toBe('2 h 33 m')
    expect(durationText(45)).toBe('45 m')
    expect(durationText(120)).toBe('2 h')
    expect(durationText(0)).toBe('0 m')
    expect(durationText(null)).toBe('')
    expect(distanceText(420)).toBe('420 m')
    expect(distanceText(2400)).toBe('2.4 km')
    expect(distanceText(null)).toBe('')
  })
})

describe('what a factory card shows', () => {
  const open = { id: 'v1', factoryId: 'f1', factoryName: 'Alpha', checkIn: { at: '2026-11-23T05:00:00Z' } }
  const done = { id: 'v0', factoryId: 'f2', checkIn: { at: '2026-11-23T03:00:00Z' }, checkOut: { at: '2026-11-23T04:00:00Z' }, minutes: 60 }
  test('checked in here, checked in elsewhere, visited today, untouched', () => {
    const visits = { open, today: [open, done] }
    expect(factoryCardState(visits, 'f1').state).toBe('open')
    expect(factoryCardState(visits, 'f2')).toMatchObject({ state: 'blocked', visit: open, last: done })
    expect(factoryCardState({ open: null, today: [done] }, 'f2')).toMatchObject({ state: 'done', last: done })
    expect(factoryCardState({ open: null, today: [] }, 'f3').state).toBe('idle')
    expect(factoryCardState(null, 'f3').state).toBe('idle')
  })
  test('visits group by India day, newest day first', () => {
    const g = visitsByDay([{ id: 'a', checkIn: { at: '2026-11-22T20:00:00Z' } }, { id: 'b', checkIn: { at: '2026-11-22T10:00:00Z' } }, { id: 'c', checkIn: { at: '2026-11-23T02:00:00Z' } }])
    expect(g.map(x => [x.day, x.visits.map(v => v.id)])).toEqual([['2026-11-23', ['a', 'c']], ['2026-11-22', ['b']]])
  })
})

describe('the coordinator\'s words', () => {
  test('every key exists in both languages, with the same markers', () => {
    const en = Object.keys(COORDINATOR_TEXT.en).sort(), hi = Object.keys(COORDINATOR_TEXT.hi).sort()
    expect(hi).toEqual(en)
    const marks = s => (s.match(/\{\w+\}/g) || []).sort()
    for (const k of en) expect(marks(COORDINATOR_TEXT.hi[k]), k).toEqual(marks(COORDINATOR_TEXT.en[k]))
  })
  test('no em dashes anywhere', () => {
    for (const lang of ['en', 'hi']) for (const v of Object.values(COORDINATOR_TEXT[lang])) expect(v.includes('—')).toBe(false)
  })
  test('markers are filled, unknown keys and languages fall back', () => {
    expect(t('checked_in_at', 'en', { time: '10:42' })).toBe('Checked in at 10:42')
    expect(t('check_out_first', 'hi', { name: 'Alpha' })).toContain('Alpha')
    expect(t('check_in', 'fr')).toBe('Check in')
    expect(t('nope', 'en')).toBe('nope')
    expect(langOf({ language: 'en' })).toBe('en')
    expect(langOf({ language: 'kn' })).toBe('hi')
    expect(langOf(null)).toBe('hi')
  })
})

describe('what a coordinator may do in the shared screens', () => {
  const coord = { id: 'c1', role: 'coordinator' }
  test('checks in at factories; changes nothing on orders, plans, documents or users', () => {
    const c = capsFor(coord)
    expect(c.isCoord).toBe(true)
    expect(c.checkInAtFactories).toBe(true)
    for (const k of ['createOrders', 'editOrders', 'deleteOrders', 'assignManufacturers', 'editPlan', 'overrideStage', 'manageMaterials', 'manageChecklist',
      'uploadStageEvidence', 'uploadProductPhoto', 'uploadReferenceDocs', 'uploadPoInvoice', 'uploadInvoices', 'uploadDeliveryDocs', 'submitRequirement',
      'orderReplen', 'importStyles', 'escalate', 'manageCertificates', 'seeStyleRequests', 'seeUsers', 'seeAudit', 'seePartners', 'seeVisits']) expect(c[k], k).toBe(false)
    expect(canWriteStage(coord, { mid: 'c1' }, { responsibleId: 'c1' })).toBe(false)
    expect(canManageStepLists(coord, { mid: 'c1' }, { responsibleId: 'c1' })).toBe(false)
    expect(canSetAssignmentStatus(coord, { mid: 'c1' })).toBe(false)
  })
  test('admins read the visits; customers and factories do not', () => {
    expect(capsFor({ role: 'admin', adminType: 'user' }).seeVisits).toBe(true)
    expect(capsFor({ role: 'buyer' }).seeVisits).toBe(false)
    expect(capsFor({ role: 'manufacturer' }).seeVisits).toBe(false)
    expect(capsFor({ role: 'admin' }).checkInAtFactories).toBe(false)
  })
})
