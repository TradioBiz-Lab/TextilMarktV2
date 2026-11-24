import { deriveStageStatus } from '../models/Order.js'
import { effectiveEta } from './stageMath.js'

// What a coordinator should look at in a factory today, read off the plan (TNA): the steps that are late, the steps due
// today, and the steps that are running or should be. Pure: dates are ISO day strings ('2026-11-24'), `today` is India's.
const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)
const daysBetween = (a, b) => Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86400000)

/** One step's place in today's work, or null when it needs no look today: { kind: 'late' | 'due_today' | 'running', daysLate }. */
export function stepToday(stage, today) {
  const status = deriveStageStatus(stage)
  if (status === 'done') return null
  const end = effectiveEta(stage)   // the revised end date when there is one, else the planned one
  if (isDay(end) && end.slice(0, 10) < today) return { kind: 'late', daysLate: daysBetween(end, today) }
  if (isDay(end) && end.slice(0, 10) === today) return { kind: 'due_today', daysLate: 0 }
  if (status === 'in_progress' || (isDay(stage.startDate) && stage.startDate.slice(0, 10) <= today)) return { kind: 'running', daysLate: 0 }
  return null
}

const RANK = { late: 0, due_today: 1, running: 2 }

/**
 * The steps to look at today across one factory's styles, most pressing first. `styles` is [{ orderId, product, client,
 * stages }] (that factory's own split of each). Returns { steps: [...], counts: { late, dueToday, running } }.
 */
export function factoryStepsToday(styles, today, limit = 12) {
  const all = []
  for (const s of styles || []) {
    // A style that is behind has every later step past its date too. Only the step it is actually on counts as late;
    // a later step shows when it is due today or someone has started it.
    const first = (s.stages || []).findIndex(st => deriveStageStatus(st) !== 'done')
    ;(s.stages || []).forEach((stage, stageIndex) => {
      const t = stepToday(stage, today)
      if (t && stageIndex !== first && t.kind === 'late' && deriveStageStatus(stage) !== 'in_progress') return
      if (t && stageIndex !== first && t.kind === 'running' && deriveStageStatus(stage) !== 'in_progress') return
      if (t) all.push({ orderId: s.orderId, product: s.product, client: s.client, stageIndex, stageName: stage.name || `Step ${stageIndex + 1}`, blocked: !!stage.blocked, ...t })
    })
  }
  all.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.daysLate - a.daysLate || String(a.product).localeCompare(String(b.product)))
  return {
    steps: all.slice(0, limit),
    counts: { late: all.filter(x => x.kind === 'late').length, dueToday: all.filter(x => x.kind === 'due_today').length, running: all.filter(x => x.kind === 'running').length },
  }
}
