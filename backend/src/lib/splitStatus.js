// A split's status as every screen (and Kriyaa) shows it, worked out in one place.
//
// On Hold is set by a person, with a reason. Delivered follows the Delivery step being closed. Delayed is never set
// by hand: a split is Delayed when any open step of its plan, or (with no Delivery step) the style's delivery date,
// has passed. A delay someone hears about early is recorded by moving that step's date, which shows as slip.
import { deriveStageStatus } from '../models/Order.js'
import { effectiveEta, getToday } from './stageMath.js'

const day = v => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null)

export function splitStatus(order, asgn, today = getToday()) {
  if (asgn?.status === 'Delivered' || asgn?.status === 'On Hold') return asgn.status
  const stages = asgn?.stages || []
  const lateStep = stages.some(s => {
    if (deriveStageStatus(s) === 'done') return false
    const due = day(effectiveEta(s))
    return !!due && due < today
  })
  const hasDeliveryStep = stages.some(s => s.isDelivery)
  const promised = day(order?.delivery)
  const latePromise = !hasDeliveryStep && order?.phase !== 'development' && !!promised && promised < today
  return lateStep || latePromise ? 'Delayed' : 'Processing'
}
