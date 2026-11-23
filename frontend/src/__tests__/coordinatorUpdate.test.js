import { describe, test, expect } from 'vitest'
import { nextSteps, stepState } from '../nextSteps.js'
import { fitWithin, draftOf, draftKey, DRAFT_LIMIT_BYTES } from '../capture.js'
import { capsFor } from '../caps.js'

const plan = statuses => statuses.map((status, i) => ({ name: `Step ${i + 1}`, status }))
const idx = list => list.map(s => s.index)

describe('the steps offered for an update', () => {
  test('those in progress first, then the earliest not started; done steps wait behind "other steps"', () => {
    const r = nextSteps(plan(['done', 'done', 'in_progress', 'not_started', 'not_started', 'not_started']))
    expect(idx(r.suggested)).toEqual([2, 3, 4])
    expect(idx(r.others)).toEqual([0, 1, 5])
  })
  test('real plans run steps side by side: several in progress come before anything not started', () => {
    const r = nextSteps(plan(['done', 'in_progress', 'not_started', 'in_progress', 'in_progress', 'not_started', 'not_started']))
    expect(idx(r.suggested)).toEqual([1, 3, 4])
    expect(idx(r.others)).toEqual([0, 2, 5, 6])
  })
  test('the plan shapes on Live (6, 7, 9, 12 and 17 steps), a fresh plan, a finished one and none', () => {
    for (const n of [6, 7, 9, 12, 17]) {
      const r = nextSteps(plan(Array(n).fill('not_started')))
      expect(idx(r.suggested)).toEqual([0, 1, 2])
      expect(r.suggested.length + r.others.length).toBe(n)
    }
    const done = nextSteps(plan(['done', 'done']))
    expect(done.suggested).toEqual([])
    expect(idx(done.others)).toEqual([0, 1])
    expect(nextSteps([])).toEqual({ suggested: [], others: [] })
    expect(nextSteps(undefined)).toEqual({ suggested: [], others: [] })
    expect(idx(nextSteps(plan(['in_progress', 'not_started'])).suggested)).toEqual([0, 1])
  })
  test('a step with no status yet counts as not started', () => {
    expect(idx(nextSteps([{ name: 'Old step' }, { name: 'B', status: 'done' }]).suggested)).toEqual([0])
    expect(stepState({ status: 'done' })).toBe('done')
    expect(stepState({ status: 'in_progress' })).toBe('running')
    expect(stepState({})).toBe('not_started')
  })
})

describe('a photo is shrunk before it is sent', () => {
  test('the longer side comes down to the limit and nothing is enlarged', () => {
    expect(fitWithin(4000, 3000, 1280)).toEqual({ width: 1280, height: 960 })
    expect(fitWithin(3000, 4000, 1280)).toEqual({ width: 960, height: 1280 })
    expect(fitWithin(800, 600, 1280)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(0, 600)).toEqual({ width: 0, height: 0 })
  })
})

describe('an unsent update is kept on the phone', () => {
  test('words and small photos are kept; nothing at all is not a draft', () => {
    expect(draftOf({ text: '', photos: [] })).toBe(null)
    expect(draftOf({ text: '   ' })).toBe(null)
    expect(draftOf({ text: '240 pieces', photos: ['data:a'], viaVoice: true })).toMatchObject({ text: '240 pieces', photos: ['data:a'], viaVoice: true, droppedPhotos: 0 })
    expect(draftOf({ photos: ['data:a'] }).photos).toEqual(['data:a'])
  })
  test('photos too big to keep are left out, and the words stay', () => {
    const big = 'x'.repeat(DRAFT_LIMIT_BYTES)
    expect(draftOf({ text: 'shade is off', photos: [big, 'y'] })).toMatchObject({ text: 'shade is off', photos: [], droppedPhotos: 2 })
  })
  test('one draft per person, product, factory and step', () => {
    expect(draftKey('u1', 'S-1', 'fA', 2)).not.toBe(draftKey('u1', 'S-1', 'fA', 3))
    expect(draftKey('u1', 'S-1', 'fA', 2)).not.toBe(draftKey('u2', 'S-1', 'fA', 2))
  })
})

describe('who sends and who reads updates from the floor', () => {
  test('a coordinator sends, admins read; nobody else does either', () => {
    expect(capsFor({ role: 'coordinator' })).toMatchObject({ sendFieldUpdates: true, seeFieldUpdates: false })
    expect(capsFor({ role: 'admin', adminType: 'user' })).toMatchObject({ sendFieldUpdates: false, seeFieldUpdates: true })
    for (const role of ['buyer', 'manufacturer']) expect(capsFor({ role })).toMatchObject({ sendFieldUpdates: false, seeFieldUpdates: false })
  })
})
