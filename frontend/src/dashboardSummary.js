import { dayNumber, getToday, isStageDone, deliveryStatus, stageStatusOf, stageIsOverdue, effectiveEta, inFlightStages } from './constants.js'

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard "AI summary" - PLACEHOLDER GENERATOR.
//
// Today this builds a 3-4 line summary from the data already on the page using
// plain rules (no model call). The shape is the contract for the real thing:
//
//   generateSummary(ctx) -> Promise<{ lines: string[], generatedAt: string, source: string }>
//
// `ctx` is { role, user, orders, actionItems }. To plug in a real model, replace
// the body of `generateSummary` with a backend call that returns the same
// object; the card, loading state and placement need no changes. Lines may use
// **bold** for emphasis.
// ─────────────────────────────────────────────────────────────────────────────

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = d => {
  const dt = new Date(d)
  return Number.isNaN(dt.getTime()) ? '' : `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`
}
const list = items => items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]

// The step's date has been moved off its original plan (a revised ETA exists and differs).
const isRevised = s => !!(s?.eta && s.eta !== 'NA' && s.baselineEta && s.baselineEta !== 'NA' && dayNumber(s.eta) !== dayNumber(s.baselineEta))

// The latest effective date anywhere in the plan, which is when the style is now expected to land
// (the mandatory Delivery step is last, so a pushed Delivery ETA shows up here too).
const planEnd = stages => {
  let best = null
  for (const s of stages || []) {
    const e = effectiveEta(s), d = e ? dayNumber(e) : null
    if (d != null && (best == null || d > best.d)) best = { d, e }
  }
  return best
}

/** One row per order x factory split, with the health facts the lines are built from. */
function buildRows(orders, role, userId, todayNum) {
  const rows = []
  for (const o of orders || []) {
    for (const a of o.assignments || []) {
      if (role === 'manufacturer' && String(a.mid) !== String(userId)) continue
      const stages = a.stages || []
      const live = inFlightStages(a, { windowDays: 3650 })
      const blocked = live.filter(({ stage }) => stage.blocked)
      const late = live.filter(({ stage }) => stageIsOverdue(stage))
      const working = live.filter(({ stage }) => stageStatusOf(stage) === 'in_progress' && !stage.blocked)
      const upcoming = live
        .filter(({ stage }) => { const e = effectiveEta(stage); return e && dayNumber(e) >= todayNum })
        .sort((x, y) => dayNumber(effectiveEta(x.stage)) - dayNumber(effectiveEta(y.stage)))[0] || null
      const deliveryDay = o.delivery ? dayNumber(new Date(o.delivery).toISOString()) : null
      const { delivered } = deliveryStatus(o, a)
      const lateBy = ({ stage }) => todayNum - dayNumber(effectiveEta(stage))
      const worstLate = late.reduce((w, x) => (!w || lateBy(x) > lateBy(w) ? x : w), null)
      const daysLate = worstLate ? lateBy(worstLate) : 0
      const health = delivered ? 'delivered'
        : blocked.length ? 'blocked'
        : (late.length || (deliveryDay != null && deliveryDay < todayNum)) ? 'late'
        : 'ontrack'
      rows.push({ order: o, asgn: a, stages, live, blocked, late, worstLate, working, upcoming, delivered, health, daysLate, deliveryDay })
    }
  }
  return rows
}

const severity = r => (r.health === 'blocked' ? 1000 : 0) + (r.health === 'late' ? 1 : 0) + r.daysLate

/**
 * buildRows is one row per order x factory split; the summary counts orders.
 * Collapse each order to one row, represented by its worst open split so a late
 * factory is never hidden behind an on-track one. An order is delivered only
 * once every split is. `splits` keeps the individual rows for step-level counts.
 */
function groupByOrder(rows) {
  const byOrder = new Map()
  for (const r of rows) {
    const g = byOrder.get(r.order.id)
    if (g) g.push(r); else byOrder.set(r.order.id, [r])
  }
  return [...byOrder.values()].map(splits => {
    const open = splits.filter(r => !r.delivered).sort((a, b) => severity(b) - severity(a))
    return { ...(open[0] || splits[0]), delivered: open.length === 0, splits }
  })
}

function attentionLine(rows, role) {
  const bad = rows.filter(r => r.health === 'blocked' || r.health === 'late').sort((a, b) => severity(b) - severity(a))
  if (!bad.length) return 'Nothing is late or blocked right now, every live order is on plan.'
  const bits = bad.slice(0, 2).map(r => {
    const who = role === 'admin' ? ` (${r.order.buyerCompany || 'unknown customer'})` : ''
    if (r.health === 'blocked') {
      const s = r.blocked[0].stage
      return `**${r.order.product}**${who} is blocked at ${s.name}${s.blockedReason ? `, ${s.blockedReason.toLowerCase()}` : ''}`
    }
    const s = r.worstLate?.stage
    const via = role === 'admin' && r.splits.length > 1 && r.asgn.mfrCompany ? ` via ${r.asgn.mfrCompany}` : ''
    return r.worstLate
      ? `**${r.order.product}**${who} is ${plural(r.daysLate, 'day')} past plan at ${s.name}${via}`
      : `**${r.order.product}**${who} is past its delivery date`
  })
  const more = bad.length - bits.length
  return `Needs attention: ${bits.join('; ')}${more > 0 ? `, plus ${plural(more, 'other order')}` : ''}.`
}

function nextDeliveryLine(rows, role, todayNum) {
  const next = rows
    .filter(r => !r.delivered && r.deliveryDay != null && r.deliveryDay >= todayNum)
    .sort((a, b) => a.deliveryDay - b.deliveryDay)[0]
  if (!next) return null
  const days = next.deliveryDay - todayNum
  const who = role === 'admin' ? ` for ${next.order.buyerCompany || 'an unknown customer'}` : ''
  return `Next delivery: **${next.order.product}**${who} on ${shortDate(next.order.delivery)} (${days === 0 ? 'today' : `in ${plural(days, 'day')}`}).`
}

function build({ role, user, orders, actionItems }) {
  const todayNum = dayNumber(getToday())
  const rows = buildRows(orders, role, user?.id, todayNum)   // order x factory
  const orderRows = groupByOrder(rows)                        // one per order
  const live = orderRows.filter(r => !r.delivered)
  const liveSplits = rows.filter(r => !r.delivered)           // open order x factory rows
  const delivered = orderRows.length - live.length
  const count = h => live.filter(r => r.health === h).length
  const lines = []

  if (!live.length) {
    lines.push(orderRows.length
      ? `All ${plural(orderRows.length, 'order')} on your book ${orderRows.length === 1 ? 'is' : 'are'} delivered, nothing is in progress.`
      : (() => {
        // Styles that exist but have no manufacturer yet produce no rows, so they used to read as "no orders".
        const unassigned = role === 'manufacturer' ? 0 : (orders || []).filter(o => !(o.assignments || []).length).length
        return unassigned
          ? `${plural(unassigned, 'style')} ${unassigned === 1 ? 'has' : 'have'} been created but no manufacturer is assigned yet, so there is no production to track.`
          : 'No orders yet, there is nothing to summarise.'
      })())
    return lines
  }

  const mix = `${count('ontrack')} on track, ${count('late')} late, ${count('blocked')} blocked`
  if (role === 'admin') {
    const customers = new Set(live.map(r => r.order.buyerCompany)).size
    const factories = new Set(liveSplits.map(r => r.asgn.mfrCompany)).size
    lines.push(`**${plural(live.length, 'live order')}** across ${plural(customers, 'customer')} and ${plural(factories, 'factory', 'factories')}: ${mix}${delivered ? `, ${delivered} already delivered` : ''}.`)
  } else if (role === 'buyer') {
    lines.push(`Your **${plural(live.length, 'live order')}**: ${mix}${delivered ? `, ${delivered} already delivered` : ''}.`)
  } else {
    const pcs = liveSplits.reduce((n, r) => n + (r.asgn.qty || 0), 0)
    const customers = new Set(live.map(r => r.order.buyerCompany)).size
    lines.push(`You have **${plural(live.length, 'live order')}** (${pcs.toLocaleString('en-IN')} pcs) for ${plural(customers, 'customer')}: ${mix}.`)
  }

  lines.push(attentionLine(live, role))

  // The action-items line differs most by role: it answers "what is waiting on me".
  if (role === 'admin') {
    // Same definition as the dashboard's "My Action Items" card: open items assigned to
    // this admin, plus the active (first unfinished) stage of each order they own.
    const items = (actionItems || []).filter(i => i.status === 'open' && String(i.assigneeId) === String(user?.id))
    const ownedSteps = rows.map(r => r.stages.find(s => !isStageDone(s))).filter(s => s && s.responsibleId && String(s.responsibleId) === String(user?.id))
    const etas = [...items.map(i => i.eta), ...ownedSteps.map(s => effectiveEta(s))]
    const total = items.length + ownedSteps.length
    const overdue = etas.filter(e => e && dayNumber(e) < todayNum).length
    const open = liveSplits.reduce((n, r) => n + inFlightStages(r.asgn, { windowDays: 3 }).length, 0)
    lines.push(`Action items: **${plural(total, 'open item')}** assigned to you${overdue ? ` (${overdue} overdue)` : ''}${ownedSteps.length ? `, of which ${ownedSteps.length} ${ownedSteps.length === 1 ? 'is a production step' : 'are production steps'}` : ''}. ${plural(open, 'step')} across all orders ${open === 1 ? 'is' : 'are'} open or due in the next 3 days.`)
  } else if (role === 'buyer') {
    const waiting = liveSplits.flatMap(r => r.live
      .filter(({ stage }) => String(stage.responsibleId) === String(user?.id) && !stage.blocked)
      .map(({ stage }) => `${stage.name} on **${r.order.product}**`))
    lines.push(waiting.length
      ? `Waiting on you: **${plural(waiting.length, 'approval')}**, ${list(waiting.slice(0, 2))}${waiting.length > 2 ? `, plus ${waiting.length - 2} more` : ''}.`
      : 'Nothing is waiting on you, no approvals are pending.')
  } else {
    const focus = liveSplits
      .flatMap(r => r.working.map(w => ({ r, ...w })))
      .sort((a, b) => dayNumber(effectiveEta(a.stage) || '9999-12-31') - dayNumber(effectiveEta(b.stage) || '9999-12-31'))
      .slice(0, 2)
      .map(f => `${f.stage.name} on **${f.r.order.product}**`)
    lines.push(focus.length ? `Today's focus: ${list(focus)}.` : 'No step is in progress today, check the orders that are about to start.')
  }

  if (role === 'manufacturer') {
    const soon = liveSplits.filter(r => r.upcoming).sort((a, b) => dayNumber(effectiveEta(a.upcoming.stage)) - dayNumber(effectiveEta(b.upcoming.stage)))[0]
    if (soon) lines.push(`Next deadline: ${soon.upcoming.stage.name} for **${soon.order.product}** on ${shortDate(effectiveEta(soon.upcoming.stage))}.`)
  } else {
    const nd = nextDeliveryLine(orderRows, role, todayNum)
    if (nd) lines.push(nd)
  }
  return lines
}

/** Plug-in point: swap the body for a backend/model call returning the same shape. */
export async function generateSummary(ctx) {
  return { lines: build(ctx), generatedAt: new Date().toISOString(), source: 'rules' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-order one-liner for the Reporting page's "AI summary" column.
// PLACEHOLDER: rule-based like the dashboard summary above. `r` is a Reporting
// page row ({ order, asgn, stages, live, blocked, late, working, upcoming,
// health, doneCount, daysToDelivery }). To plug in a real model, replace this
// function (or fetch one line per row and look it up by order id).
// ─────────────────────────────────────────────────────────────────────────────
export function rowCallout(r) {
  const { order, stages, live, blocked, late, working, upcoming, health, doneCount, daysToDelivery } = r
  const total = stages.length
  const deliveryBit = daysToDelivery == null ? ''
    : daysToDelivery < 0 ? `delivery was due ${shortDate(order.delivery)}`
    : `delivery ${shortDate(order.delivery)} (${daysToDelivery === 0 ? 'today' : `${daysToDelivery}d`})`

  if (health === 'done') {
    const when = r.delivery?.isActual ? ` on ${shortDate(r.delivery.date)}` : ''
    const due = order.delivery ? `, due ${shortDate(order.delivery)}` : ''
    const open = total - doneCount
    return `Delivered${when}${due}.${open > 0 ? ` ${plural(open, 'step')} left open in the plan.` : ''}`
  }

  if (health === 'blocked') {
    const s = blocked[0].stage
    const why = s.blockedReason ? `: ${s.blockedReason}` : ''
    return `Blocked at ${s.name}${why}. Needs a decision before it can move${deliveryBit ? `, ${deliveryBit}` : ''}.`
  }

  if (health === 'late') {
    // Name the stage that is furthest behind, the same one the day count belongs to.
    const lateBy = ({ stage }) => dayNumber(getToday()) - dayNumber(effectiveEta(stage))
    const worstEntry = late.reduce((w, x) => (!w || lateBy(x) > lateBy(w) ? x : w), null)
    const worst = worstEntry?.stage
    const days = worstEntry ? lateBy(worstEntry) : 0
    // A manual callout only rides along when it is short enough to keep this a one-liner.
    const cause = order.callout && order.callout.length <= 50 ? ` ${order.callout}` : ''
    // Say where the date now stands, not just that it slipped: the step's planned and revised dates,
    // and when the style is now expected to land against what was promised.
    const end = planEnd(stages)
    const promised = order.delivery ? dayNumber(new Date(order.delivery).toISOString()) : null
    const over = end && promised != null && end.d > promised ? end.d - promised : 0
    const landing = over
      ? ` Now expected ${shortDate(end.e)}, ${plural(over, 'day')} past the ${shortDate(order.delivery)} delivery date.`
      : deliveryBit ? ` ${deliveryBit[0].toUpperCase()}${deliveryBit.slice(1)} at risk.` : ''
    if (worst) {
      const dates = isRevised(worst) ? `planned ${shortDate(worst.baselineEta)}, revised to ${shortDate(worst.eta)}` : `due ${shortDate(effectiveEta(worst))}`
      return `${plural(days, 'day')} behind at ${worst.name} (${dates}).${landing}${cause}`
    }
    return `Past its delivery date${order.delivery ? ` (${shortDate(order.delivery)})` : ''}.${over ? ` Now expected ${shortDate(end.e)}.` : ''}${cause}`
  }

  const w = working[0]?.stage
  if (w) {
    const pct = Math.round(((w.unitsDone || 0) / Math.max(w.totalUnits || 1, 1)) * 100)
    const due = effectiveEta(w) ? `, due ${shortDate(effectiveEta(w))}` : ''
    const prog = w.kind === 'quantity' || !w.kind ? ` ${pct}% done` : ' in progress'
    return `On track: ${w.name}${prog}${due}${deliveryBit ? `; ${deliveryBit}` : ''}.`
  }
  if (live.length === 0 && doneCount === 0) return `Not started yet${stages[0]?.startDate && stages[0].startDate !== 'NA' ? `, first step ${stages[0].name} begins ${shortDate(stages[0].startDate)}` : ''}.`
  if (upcoming) return `On track: next up ${upcoming.stage.name} on ${shortDate(effectiveEta(upcoming.stage))}${deliveryBit ? `; ${deliveryBit}` : ''}.`
  return `${doneCount} of ${total} steps done${deliveryBit ? `, ${deliveryBit}` : ''}.`
}
