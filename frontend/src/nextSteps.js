// The steps a coordinator is most likely to report on, so he picks from two or three big buttons instead of a long
// list: those in progress, in plan order, then the earliest ones not yet started. Everything else is "other steps".
// Worked out from the plan alone: instant, and the same every time. Pure.

/**
 * @param {Array} stages a split's steps, in plan order, each with a `status`
 * @returns {{ suggested: Array<{ index, stage }>, others: Array<{ index, stage }> }}
 */
export function nextSteps(stages, max = 3) {
  const all = (stages || []).map((stage, index) => ({ index, stage }))
  const running = all.filter(s => s.stage.status === 'in_progress')
  const waiting = all.filter(s => s.stage.status !== 'in_progress' && s.stage.status !== 'done')
  const suggested = [...running, ...waiting].slice(0, max)
  const picked = new Set(suggested.map(s => s.index))
  return { suggested, others: all.filter(s => !picked.has(s.index)) }
}

/** 'done' | 'running' | 'not_started', for the small word under a step's name. */
export const stepState = stage => (stage?.status === 'done' ? 'done' : stage?.status === 'in_progress' ? 'running' : 'not_started')
