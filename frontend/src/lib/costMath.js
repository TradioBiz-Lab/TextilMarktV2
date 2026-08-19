// Client-side mirror of backend/src/models/CostSheet.js's computed-total
// functions — kept LITERALLY identical to that file. Needed so CostSheetPanel
// can show a live running total as the user types, instead of only after a
// round-trip Save (the totals table used to read straight from the
// last-saved `sheet`, never the in-progress `draft`). This is an accepted,
// deliberate duplication: frontend and backend are separate npm projects
// with no shared package in this codebase. If the formula ever changes,
// both copies must move together — see the matching comment in CostSheet.js.

const sumValues = arr => (arr || []).reduce((sum, l) => sum + (Number(l.value) || 0), 0)
const sumExtra = (sheet, group) => (sheet.extraLines || []).filter(l => l.group === group).reduce((sum, l) => sum + (Number(l.value) || 0), 0)

export function fabricGrossConsumption(sheet) {
  const c = Number(sheet?.fabric?.consumption)
  if (!sheet?.fabric?.consumption && sheet?.fabric?.consumption !== 0) return null
  if (isNaN(c)) return null
  return c * (1 + (Number(sheet?.fabric?.wastagePct) || 0) / 100)
}

export function fabricValue(sheet) {
  const gross = fabricGrossConsumption(sheet)
  const r = Number(sheet?.fabric?.rate)
  return (gross != null && !isNaN(r) && sheet?.fabric?.rate !== '' && sheet?.fabric?.rate != null) ? gross * r : 0
}

export function rawMaterialTotal(sheet) {
  return fabricValue(sheet) + sumValues(sheet.process) + sumValues(sheet.trims) + sumValues(sheet.labelsPackaging) + sumExtra(sheet, 'material')
}

export function labourTotal(sheet) {
  const l = sheet.labour || {}
  return (Number(l.cuttingThreads) || 0) + (Number(l.making) || 0) + (Number(l.finishingPacking) || 0) + sumExtra(sheet, 'labour')
}

export function totalLabourAndRawMaterial(sheet) {
  return rawMaterialTotal(sheet) + labourTotal(sheet)
}

export function overheadValue(sheet) {
  return totalLabourAndRawMaterial(sheet) * ((Number(sheet.overheadPct) || 0) / 100)
}

export function rejectionValue(sheet) {
  return totalLabourAndRawMaterial(sheet) * ((Number(sheet.rejectionPct) || 0) / 100)
}

export function baseCost(sheet) {
  return totalLabourAndRawMaterial(sheet) + overheadValue(sheet) + rejectionValue(sheet)
}

export function mfrMarginValue(sheet) {
  if (sheet.mfrMarginPct === '' || sheet.mfrMarginPct == null) return null
  return baseCost(sheet) * (Number(sheet.mfrMarginPct) / 100)
}

export function mfrSellPrice(sheet) {
  const mv = mfrMarginValue(sheet)
  return mv == null ? null : baseCost(sheet) + mv
}
