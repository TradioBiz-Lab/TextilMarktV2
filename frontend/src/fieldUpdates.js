// The account manager's side of an update from the factory floor: what the AI suggests, turned into the changes an
// admin can confirm with one tap. Pure. Each suggestion is { key, label, kind, ... }; `apply` (when present) is the
// body for the ordinary stage route, so a confirmed suggestion behaves exactly like an admin editing the step.

/** "5 h", "40 min", "2 d": how long an update has waited. */
export function waitingText(minutes) {
  if (minutes == null) return ''
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`
  return `${Math.round(minutes / (24 * 60))} d`
}
export const isStale = minutes => minutes != null && minutes >= 24 * 60

/**
 * @param update one update as the API returns it
 * @param stage  the step it sits on, from the style (may be missing if the plan changed)
 * @param stages the split's steps, for the name of a step to move to
 */
export function suggestionsFor(update, stage, stages = []) {
  const ai = update?.ai
  if (!ai || ai.state !== 'done') return []
  const out = []
  if (ai.suggestedStageIndex != null && stages[ai.suggestedStageIndex] && ai.suggestedStageIndex !== update.stageIndex) {
    out.push({ key: 'move', kind: 'move', toIndex: ai.suggestedStageIndex, label: `Looks like it is about ${stages[ai.suggestedStageIndex].name}. Move it there` })
  }
  if (ai.units != null && stage) {
    const total = stage.totalUnits || 0
    const fits = stage.kind === 'quantity' && total > 0 && ai.units <= total && !stage.isDelivery
    out.push(fits
      ? { key: 'units', kind: 'apply', label: `Count ${ai.units} of ${total}`, apply: { unitsDone: ai.units }, was: `now ${stage.unitsDone || 0}` }
      : { key: 'units', kind: 'info', label: `He counted ${ai.units}`, why: stage.kind !== 'quantity' ? 'this step does not count pieces' : total > 0 && ai.units > total ? `more than the ${total} planned` : 'open the style to record it' })
  }
  if (ai.statusHint && stage && !stage.isDelivery) {
    const to = ai.statusHint === 'finished' ? 'done' : 'in_progress'
    const already = stage.status === to || (to === 'in_progress' && stage.status === 'done')
    // A step that counts pieces finishes by its count, and a checklist by its items: those are not set by hand here.
    if (!already && stage.kind === 'milestone') out.push({ key: 'status', kind: 'apply', label: ai.statusHint === 'finished' ? 'Mark the step finished' : 'Mark the step started', apply: { status: to } })
    else if (!already) out.push({ key: 'status', kind: 'info', label: ai.statusHint === 'finished' ? 'He says it is finished' : 'He says it has started', why: 'open the style to update this step' })
  }
  ;(ai.issues || []).forEach((issue, i) => {
    if (!stage || stage.blocked) out.push({ key: `issue${i}`, kind: 'info', label: `Issue: ${issue}`, why: stage?.blocked ? 'the step is already blocked' : '' })
    else out.push({ key: `issue${i}`, kind: 'apply', label: `Block the step: ${issue}`, apply: { blocked: true, blockedReason: issue.slice(0, 300) } })
  })
  if (ai.result) out.push({ key: 'result', kind: 'info', label: ai.result === 'pass' ? 'He reports a pass' : 'He reports a fail', why: '' })
  for (const [i, c] of (ai.colours || []).entries()) if (c.note) out.push({ key: `colour${i}`, kind: 'info', label: `${c.name}: ${c.note}`, why: '' })
  return out
}

/** The style's step an update sits on, and that split's steps. */
export function stageOfUpdate(orders, update) {
  const order = (orders || []).find(o => String(o.id) === String(update.orderId)) || null
  const split = (order?.assignments || []).find(a => String(a.mid) === String(update.factoryId)) || null
  const stages = split?.stages || []
  return { order, split, stages, stage: stages[update.stageIndex] || null }
}
