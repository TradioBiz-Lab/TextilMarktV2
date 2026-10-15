// The Order Status report as data, once, for both downloads (Excel and CSV), so the two can never
// drift apart. `reportModel` turns the report rows into typed columns and plain values; dates stay
// 'YYYY-MM-DD' strings until the moment they are written.
//
// Two tables: one row per style x manufacturer split (the summary the page shows), and one row per
// TNA step (the full plan behind it). Customers get exactly what they can already see on screen:
// nothing here is read from fields a customer is not sent.
import { effectiveEta, stageKindOf, stageStatusOf, STAGE_STATUS_LABELS, stageVariance, stageActualVariance, stageProgressLabel } from './constants.js'

const KIND_LABEL = { quantity: 'Quantity', milestone: 'Approval', checklist: 'Checklist' }
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)
const dateOnly = v => (isDate(v) ? v.slice(0, 10) : null)
// A stage date is a real date, the text NA, or nothing.
const stageDate = v => (v === 'NA' ? 'NA' : dateOnly(v))

/**
 * @param rows   report rows ({ order, asgn, stages, doneCount, pct, live, blocked, late, upcoming, delivery, daysToDelivery, health, lastUpdate })
 * @param opts   { masterOrders, isBuyer, healthLabel(health) -> string, summaryText(row) -> string }
 */
export function reportModel(rows, { masterOrders = [], isBuyer = false, healthLabel = h => h, summaryText = () => '' } = {}) {
  const moName = r => (r.order.masterOrderId && masterOrders.find(m => m.id === r.order.masterOrderId)?.orderName) || ''

  // A customer sees only their own orders, so the customer column would be the same value on every row.
  const summaryCols = [
    ...(isBuyer ? [] : [{ key: 'customer', label: 'Customer', width: 20, type: 'text', get: r => r.order.buyerCompany || '' }]),
    { key: 'mo', label: 'Master order', width: 24, type: 'text', get: moName },
    { key: 'id', label: 'Order ID', width: 28, type: 'text', get: r => r.order.id },
    { key: 'style', label: 'Style', width: 30, type: 'text', get: r => r.order.product || '' },
    { key: 'mfr', label: 'Manufacturer', width: 22, type: 'text', get: r => r.asgn.mfrCompany || '' },
    { key: 'qty', label: 'Ordered qty', width: 12, type: 'number', get: r => r.asgn.qty ?? null },
    { key: 'got', label: 'Delivered qty', width: 13, type: 'number', get: r => r.delivery.deliveredQty ?? null },
    { key: 'diff', label: 'Qty difference', width: 13, type: 'number', get: r => r.delivery.diff ?? null },
    { key: 'done', label: 'Steps done', width: 11, type: 'number', get: r => r.doneCount },
    { key: 'total', label: 'Total steps', width: 11, type: 'number', get: r => r.stages.length },
    { key: 'pct', label: '% complete', width: 11, type: 'number', get: r => r.pct },
    { key: 'health', label: 'Status', width: 12, type: 'text', get: r => healthLabel(r.health) },
    { key: 'open', label: 'Open now', width: 34, type: 'text', get: r => r.live.map(({ stage }) => stage.name).join(' | ') },
    { key: 'blocked', label: 'Blocked steps', width: 13, type: 'number', get: r => r.blocked.length },
    { key: 'late', label: 'Past deadline', width: 13, type: 'number', get: r => r.late.length },
    { key: 'next', label: 'Next due', width: 26, type: 'text', get: r => r.upcoming?.stage.name || '' },
    { key: 'nextDate', label: 'Next due date', width: 14, type: 'date', get: r => (r.upcoming ? dateOnly(effectiveEta(r.upcoming.stage)) : null) },
    { key: 'delivery', label: 'Delivery date', width: 14, type: 'date', get: r => dateOnly(r.delivery.date) },
    { key: 'days', label: 'Days to delivery', width: 15, type: 'number', get: r => r.daysToDelivery ?? null },
    { key: 'summary', label: 'Summary', width: 60, type: 'text', wrap: true, get: summaryText },
    { key: 'latest', label: 'Latest update', width: 50, type: 'text', wrap: true, get: r => (r.lastUpdate ? `${r.lastUpdate.stageName}: ${r.lastUpdate.text}` : '') },
  ]

  const stepCols = [
    { key: 'id', label: 'Order ID', width: 28, type: 'text' },
    { key: 'style', label: 'Style', width: 30, type: 'text' },
    { key: 'mfr', label: 'Manufacturer', width: 22, type: 'text' },
    { key: 'no', label: 'Step no.', width: 9, type: 'number' },
    { key: 'step', label: 'Step', width: 34, type: 'text' },
    { key: 'kind', label: 'Type', width: 11, type: 'text' },
    { key: 'owner', label: 'Owner', width: 24, type: 'text' },
    { key: 'status', label: 'Status', width: 13, type: 'text' },
    { key: 'progress', label: 'Progress', width: 14, type: 'text' },
    { key: 'start', label: 'Start', width: 13, type: 'date' },
    { key: 'planned', label: 'Planned end', width: 13, type: 'date' },
    { key: 'revised', label: 'Revised end', width: 13, type: 'date' },
    { key: 'actual', label: 'Actual end', width: 13, type: 'date' },
    { key: 'slip', label: 'Days late (+) / early (-)', width: 22, type: 'number' },
    { key: 'blocked', label: 'Blocked', width: 9, type: 'text' },
    { key: 'why', label: 'Blocked reason', width: 36, type: 'text' },
  ]
  const stepRows = rows.flatMap(r => r.stages.map((s, i) => {
    const done = stageStatusOf(s) === 'done'
    const revised = s.eta && s.eta !== 'NA' && s.baselineEta && s.baselineEta !== 'NA' && s.eta.slice(0, 10) !== s.baselineEta.slice(0, 10)
    // Once done, the story is "did we hit the plan"; before that it is "has the plan moved".
    const slip = done && s.actualEnd ? stageActualVariance(s) : stageVariance(s)
    return [
      r.order.id, r.order.product || '', r.asgn.mfrCompany || '', i + 1, s.name, KIND_LABEL[stageKindOf(s)] || '',
      s.responsibleName || '', s.blocked ? 'Blocked' : STAGE_STATUS_LABELS[stageStatusOf(s)], stageProgressLabel(s),
      stageDate(s.startDate), stageDate(s.baselineEta), revised ? stageDate(s.eta) : null, done ? dateOnly(s.actualEnd) : null,
      slip ?? null, s.blocked ? 'Yes' : '', s.blocked ? (s.blockedReason || '') : '',
    ]
  }))

  return {
    summary: { name: 'Order status', columns: summaryCols, rows: rows.map(r => summaryCols.map(c => c.get(r))) },
    steps: { name: 'TNA steps', columns: stepCols, rows: stepRows },
  }
}

// ── CSV ────────────────────────────────────────────────────────────────────
const ddmmyyyy = v => (v === 'NA' ? 'NA' : isDate(v) ? `${v.slice(8, 10)}-${v.slice(5, 7)}-${v.slice(0, 4)}` : '')

/** The summary table as CSV rows (header first), dates written day-first like everywhere else in the app. */
export function summaryCsvRows(model) {
  const { columns, rows } = model.summary
  return [
    columns.map(c => c.label),
    ...rows.map(r => r.map((v, i) => (columns[i].type === 'date' ? ddmmyyyy(v) : (v ?? '')))),
  ]
}

// ── Excel ──────────────────────────────────────────────────────────────────
const HEAD = { fontWeight: 'bold', backgroundColor: '#e2e8f0', textColor: '#0f172a', borderColor: '#94a3b8', bottomBorderStyle: 'thin', alignVertical: 'center', wrap: true }
const HEALTH_FILL = { Blocked: '#fee2e2', Delayed: '#fee2e2', Late: '#fee2e2', 'At risk': '#fef3c7', 'On track': '#dcfce7', Complete: '#dcfce7' }
const STATUS_FILL = { Done: '#dcfce7', 'In progress': '#dbeafe', Blocked: '#fee2e2' }

// 'YYYY-MM-DD' as a UTC date: the writer stores the calendar day, so it shows the same day in every time zone.
const asDate = v => { const [y, m, d] = v.slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)) }

function sheetOf(table, cellStyle = () => null) {
  const { columns, rows, name } = table
  const head = columns.map(c => ({ value: c.label, ...HEAD }))
  const body = rows.map(row => row.map((v, i) => {
    const col = columns[i]
    const style = { alignVertical: 'top', ...(col.wrap ? { wrap: true } : {}), ...(cellStyle(col, v, row) || {}) }
    if (v === null || v === undefined || v === '') return null
    if (col.type === 'date') return v === 'NA' ? { value: 'NA', textColor: '#94a3b8', align: 'right', ...style } : { value: asDate(v), type: Date, format: 'dd-mmm-yyyy', align: 'right', ...style }
    if (col.type === 'number') return { value: v, type: Number, format: col.key === 'pct' ? '0"%"' : '#,##0;-#,##0;0', ...style }
    return { value: String(v), type: String, ...style }
  }))
  return {
    data: [head, ...body], sheet: name, stickyRowsCount: 1,
    columns: columns.map(c => ({ width: c.width })),
  }
}

/** Sheet definitions for write-excel-file. */
export function excelSheets(model) {
  return [
    sheetOf(model.summary, (col, v) => (col.key === 'health' && HEALTH_FILL[v] ? { backgroundColor: HEALTH_FILL[v], fontWeight: 'bold' } : col.key === 'diff' && v ? { textColor: '#b45309', fontWeight: 'bold' } : null)),
    sheetOf(model.steps, (col, v) => (col.key === 'status' && STATUS_FILL[v] ? { backgroundColor: STATUS_FILL[v] } : col.key === 'slip' && v > 0 ? { textColor: '#b91c1c', fontWeight: 'bold' } : null)),
  ]
}

/** Build the .xlsx as a Blob. Loaded on demand, so the writer only costs anything when someone exports. */
export async function reportXlsxBlob(model) {
  const { default: writeXlsx } = await import('write-excel-file/universal')
  return writeXlsx(excelSheets(model)).toBlob()
}
