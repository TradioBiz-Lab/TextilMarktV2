// One cell of a CSV we export. Cell text comes from buyers and factories (product names,
// callouts, stage notes), and a cell that starts with = + - @ is run as a formula when the
// file is opened in Excel or Sheets. Such text gets a leading apostrophe, which spreadsheets
// show as plain text. Real numbers, including negative variances, are left alone.
const FORMULA_START = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

export function toCsvCell(v) {
  let s = String(v ?? '')
  if (typeof v !== 'number' && FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
