// The Indian financial year runs 1 April to 31 March, and document numbers carry it: PO-TPR-2627-0001
// is the first PO of financial year 2026-27. The date is read in India time, because a PO raised at
// 11pm IST on 31 March belongs to the year that is ending, even where UTC has already rolled over.

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000

/** Four digits, the two years: 2627 for 1 April 2026 to 31 March 2027. */
export function fiscalYearCode(now = new Date()) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS)
  const year = ist.getUTCFullYear(), month = ist.getUTCMonth()   // month is 0 for January
  const start = month >= 3 ? year : year - 1
  return `${String(start).slice(2)}${String(start + 1).slice(2)}`
}
