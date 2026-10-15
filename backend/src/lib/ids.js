// Server numbering for master orders and styles, used when a caller sends id 'auto' (the app's own forms and
// Kriyaa both do). The shapes are the ones the app has always used:
//   master order  MO-<customer code>-<season>-NNN   (NNN counts across all of that customer's master orders)
//   style         <customer code>-<CATEGORY>-<season>-NNN
// A race between two creators is caught by the unique _id; callers retry with the next number. A number that
// belonged to a dropped style or deleted master order is never given out again: documents and history are filed
// against the id, so a new record reusing it would inherit them.
import { MasterOrder } from '../models/MasterOrder.js'
import { Order } from '../models/Order.js'
import { DroppedRecord } from '../models/DroppedRecord.js'

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const nextAfter = (ids, prefix) => ids.reduce((max, id) => {
  const n = parseInt(String(id).slice(String(id).lastIndexOf('-') + 1), 10)
  return String(id).startsWith(prefix) && Number.isFinite(n) && n > max ? n : max
}, 0) + 1

export async function nextMasterOrderId(customerCode, season) {
  const prefix = `MO-${customerCode}-`
  const re = { $regex: `^${escapeRe(prefix)}` }
  const [live, gone] = await Promise.all([MasterOrder.find({ _id: re }, { _id: 1 }).lean(), DroppedRecord.find({ refId: re }, { refId: 1 }).lean()])
  return `${prefix}${season || 'XX'}-${String(nextAfter([...live.map(m => m._id), ...gone.map(d => d.refId)], prefix)).padStart(3, '0')}`
}

export async function nextStyleId(customerCode, category, season) {
  const cat = String(category || 'XX').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'XX'
  const prefix = `${customerCode}-${cat}-${season || 'XX'}-`
  const re = { $regex: `^${escapeRe(prefix)}` }
  const [live, gone] = await Promise.all([Order.find({ _id: re }, { _id: 1 }).lean(), DroppedRecord.find({ refId: re }, { refId: 1 }).lean()])
  return `${prefix}${String(nextAfter([...live.map(o => o._id), ...gone.map(d => d.refId)], prefix)).padStart(3, '0')}`
}
