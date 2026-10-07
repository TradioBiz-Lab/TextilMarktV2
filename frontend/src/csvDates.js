// CSV date cells arrive in whatever form someone typed. The server stores a date string
// exactly as sent and every date calculation assumes 'YYYY-MM-DD', so a cell like
// 05-01-2026 would be read as year 5. Everything is normalized here, before any request.
//
// Accepted: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (day first, as in India),
// 5-Jan-26 / 5 Jan 2026, and the literal NA. Anything else is an error, never a guess.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = n => String(n).padStart(2, '0')

export function normalizeCsvDate(input) {
  const v = String(input ?? '').trim()
  if (!v) return { error: 'missing' }
  if (/^na$/i.test(v)) return { value: 'NA' }

  let y, m, d, hit
  if ((hit = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    y = +hit[1]; m = +hit[2]; d = +hit[3]
  } else if ((hit = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) {
    d = +hit[1]; m = +hit[2]; y = +hit[3]
  } else if ((hit = v.match(/^(\d{1,2})[ -]([A-Za-z]{3,9})[ -](\d{2}|\d{4})$/))) {
    d = +hit[1]
    m = MONTHS.indexOf(hit[2].slice(0, 3).toLowerCase()) + 1
    y = hit[3].length === 2 ? 2000 + +hit[3] : +hit[3]
    if (m === 0) return { error: 'unrecognised' }
  } else {
    return { error: 'unrecognised' }
  }

  const t = new Date(Date.UTC(y, m - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return { error: 'not a real date' }
  return { value: `${y}-${pad(m)}-${pad(d)}` }
}
