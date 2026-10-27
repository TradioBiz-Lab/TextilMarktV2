import { describe, it, expect } from 'vitest'
import { STAGE_KINDS, STAGE_KIND_LABELS, CELL_STATE } from '../constants.js'

describe('plain words for people who do not live in software', () => {
  it('names every step type in everyday words and keeps the stored words', () => {
    expect(STAGE_KIND_LABELS).toEqual({ milestone: 'Tick when done', checklist: 'Checklist', quantity: 'Count pieces' })
    expect(Object.keys(STAGE_KIND_LABELS).sort()).toEqual([...STAGE_KINDS].sort())
  })
  it('calls a step past its date "Late", the same word as everywhere else', () => {
    expect(CELL_STATE.overdue.label).toBe('Late')
  })
})
