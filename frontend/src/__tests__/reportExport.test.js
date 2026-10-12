import { describe, test, expect } from 'vitest'
import readXlsx from 'read-excel-file/node'
import { reportModel, summaryCsvRows, reportXlsxBlob } from '../reportExport.js'
import { deliveryStatus } from '../constants.js'

const stage = (over = {}) => ({ name: 'Cutting', kind: 'quantity', status: 'in_progress', unitsDone: 40, totalUnits: 100, startDate: '2026-10-01', baselineEta: '2026-10-12', eta: '2026-10-17', actualEnd: null, blocked: false, blockedReason: '', responsibleName: 'Lalit Ji', ...over })
const order = { id: 'AER-001', product: 'Aero Windbreaker', buyerCompany: 'Aero Active', masterOrderId: 'MO-1', delivery: '2026-10-21T00:00:00.000Z', callout: '' }

function row() {
  const stages = [
    stage({ name: 'Lab Dip Approval', kind: 'milestone', status: 'done', unitsDone: 1, totalUnits: 1, baselineEta: '2026-10-05', eta: '2026-10-05', actualEnd: '2026-10-07', responsibleName: 'Emma Wilson' }),
    stage(),
    stage({ name: 'Delivery', kind: 'milestone', status: 'not_started', unitsDone: 0, totalUnits: 1, startDate: 'NA', baselineEta: '2026-10-21', eta: null, isDelivery: true }),
  ]
  const asgn = { mid: 'm1', mfrCompany: 'NCR Active Unit', qty: 900, deliveredQty: 880, stages }
  return {
    order, asgn, stages, doneCount: 1, pct: 33, live: [{ stage: stages[1], index: 1 }], blocked: [], late: [{ stage: stages[1], index: 1 }],
    upcoming: { stage: stages[2] }, delivery: deliveryStatus(order, asgn), daysToDelivery: 9, health: 'late', lastUpdate: { stageName: 'Cutting', text: 'Cut 40 pcs' },
  }
}
const opts = isBuyer => ({ masterOrders: [{ id: 'MO-1', orderName: 'Aero SS27 Outerwear' }], isBuyer, healthLabel: h => ({ late: 'Late' })[h] || h, summaryText: () => '3 days behind at Cutting' })

describe('reportModel', () => {
  test('the customer view drops the customer column, everything else is the same', () => {
    const admin = reportModel([row()], opts(false)).summary.columns.map(c => c.label)
    const buyer = reportModel([row()], opts(true)).summary.columns.map(c => c.label)
    expect(admin[0]).toBe('Customer')
    expect(buyer).not.toContain('Customer')
    expect(buyer).toEqual(admin.slice(1))
  })

  test('summary values line up with their columns', () => {
    const { columns, rows } = reportModel([row()], opts(false)).summary
    const v = key => rows[0][columns.findIndex(c => c.key === key)]
    expect(v('customer')).toBe('Aero Active')
    expect(v('mo')).toBe('Aero SS27 Outerwear')
    expect(v('qty')).toBe(900)
    expect(v('got')).toBe(880)
    expect(v('diff')).toBe(-20)
    expect(v('pct')).toBe(33)
    expect(v('health')).toBe('Late')
    expect(v('open')).toBe('Cutting')
    expect(v('nextDate')).toBe('2026-10-21')
    expect(v('delivery')).toBe('2026-10-21')
    expect(v('summary')).toBe('3 days behind at Cutting')
    expect(v('latest')).toBe('Cutting: Cut 40 pcs')
  })

  test('the TNA sheet has one row per step with planned, revised and actual dates', () => {
    const { columns, rows } = reportModel([row()], opts(true)).steps
    expect(rows).toHaveLength(3)
    const at = (i, key) => rows[i][columns.findIndex(c => c.key === key)]
    expect(at(0, 'step')).toBe('Lab Dip Approval')
    expect(at(0, 'kind')).toBe('Approval')
    expect(at(0, 'owner')).toBe('Emma Wilson')
    expect(at(0, 'status')).toBe('Done')
    expect(at(0, 'actual')).toBe('2026-10-07')
    expect(at(0, 'slip')).toBe(2) // finished two days after plan
    expect(at(1, 'planned')).toBe('2026-10-12')
    expect(at(1, 'revised')).toBe('2026-10-17')
    expect(at(1, 'slip')).toBe(5) // plan moved five days
    expect(at(1, 'actual')).toBeNull()
    expect(at(2, 'start')).toBe('NA')
    expect(at(2, 'revised')).toBeNull()
  })

  test('an unrevised step has no revised date', () => {
    const r = row(); r.stages[1].eta = '2026-10-12'; r.asgn.stages = r.stages
    const { columns, rows } = reportModel([r], opts(true)).steps
    expect(rows[1][columns.findIndex(c => c.key === 'revised')]).toBeNull()
  })

  test('a blocked step says so and why', () => {
    const r = row(); Object.assign(r.stages[1], { blocked: true, blockedReason: 'Fabric not in' })
    const { columns, rows } = reportModel([r], opts(true)).steps
    expect(rows[1][columns.findIndex(c => c.key === 'status')]).toBe('Blocked')
    expect(rows[1][columns.findIndex(c => c.key === 'why')]).toBe('Fabric not in')
  })
})

describe('CSV', () => {
  test('writes dates day-first and leaves missing values empty', () => {
    const r = row(); r.delivery = { ...r.delivery, deliveredQty: null, diff: null }
    const csv = summaryCsvRows(reportModel([r], opts(true)))
    const head = csv[0]
    expect(csv[1][head.indexOf('Delivery date')]).toBe('21-10-2026')
    expect(csv[1][head.indexOf('Next due date')]).toBe('21-10-2026')
    expect(csv[1][head.indexOf('Delivered qty')]).toBe('')
    expect(csv[1][head.indexOf('Ordered qty')]).toBe(900)
  })
})

describe('Excel file', () => {
  test('is a real workbook: two sheets, real dates and numbers, same on any timezone', async () => {
    const blob = await reportXlsxBlob(reportModel([row()], opts(false)))
    const sheets = await readXlsx(Buffer.from(await blob.arrayBuffer()))
    expect(sheets.map(s => s.sheet)).toEqual(['Order status', 'TNA steps'])

    const [summary, steps] = sheets.map(s => s.data)
    const col = (table, label) => table[0].indexOf(label)
    expect(summary).toHaveLength(2)
    expect(summary[1][col(summary, 'Ordered qty')]).toBe(900)
    expect(summary[1][col(summary, 'Qty difference')]).toBe(-20)
    expect(summary[1][col(summary, '% complete')]).toBe(33)
    const due = summary[1][col(summary, 'Delivery date')]
    expect(due).toBeInstanceOf(Date)
    expect(due.toISOString().slice(0, 10)).toBe('2026-10-21')
    expect(summary[1][col(summary, 'Summary')]).toBe('3 days behind at Cutting')

    expect(steps).toHaveLength(4)
    expect(steps[3][col(steps, 'Start')]).toBe('NA')
    expect(steps[1][col(steps, 'Actual end')].toISOString().slice(0, 10)).toBe('2026-10-07')
    expect(steps[2][col(steps, 'Revised end')].toISOString().slice(0, 10)).toBe('2026-10-17')
  })

  test('an export with no rows still has headers', async () => {
    const blob = await reportXlsxBlob(reportModel([], opts(true)))
    const sheets = await readXlsx(Buffer.from(await blob.arrayBuffer()))
    expect(sheets[0].data).toHaveLength(1)
  })
})
