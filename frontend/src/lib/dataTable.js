// The pure logic behind components/DataTable.jsx, kept apart so it can be tested without React.

/** What an empty cell shows. A plain hyphen, not a dash character. */
export const EMPTY_CELL = '-'

/**
 * The column that becomes the card title on a phone: the one marked `primary`, otherwise the first
 * column that is neither numeric nor hidden on mobile, otherwise simply the first column.
 * Undefined when there are no columns.
 */
export function pickPrimaryColumn(columns) {
  const cols = Array.isArray(columns) ? columns : []
  return cols.find(c => c?.primary) || cols.find(c => c && !c.numeric && !c.hideOnMobile) || cols[0]
}

/**
 * A stable React key for a row. `rowKey` is the name of a property on the row, or a function
 * (row, index) => key; with neither it uses `row.id`. A row with no usable key gets `row-<index>`,
 * so rendering never breaks on one bad record.
 */
export function resolveRowKey(rowKey, row, index) {
  const k = typeof rowKey === 'function' ? rowKey(row, index) : row?.[rowKey ?? 'id']
  return k == null || k === '' ? `row-${index}` : String(k)
}

/** 'left', 'right' or 'center' for a column: its own `align`, else right for numeric columns, else left. */
export function resolveAlign(col) {
  const a = col?.align
  if (a === 'left' || a === 'right' || a === 'center') return a
  return col?.numeric ? 'right' : 'left'
}

/** The label a column gets on a phone card: its header when that is plain text or a number, else its key. */
export function mobileLabel(col) {
  const h = col?.header
  if ((typeof h === 'string' && h.trim()) || typeof h === 'number') return String(h)
  return String(col?.key ?? '')
}

/**
 * Class names for a column's header and body cells. `dt-primary` marks the card title, `dt-num` gets
 * tabular figures, `dt-hide-mobile` drops the cell from phone cards (never on the primary column,
 * which is the card's title and must stay).
 */
export function cellClasses(col, isPrimary) {
  return [
    isPrimary && 'dt-primary',
    col?.numeric && 'dt-num',
    col?.hideOnMobile && !isPrimary && 'dt-hide-mobile',
  ].filter(Boolean).join(' ')
}

/** What to draw in a cell: the column's `render(row)` if it has one, else `row[key]`. Empty values show EMPTY_CELL; 0 is a value. */
export function cellContent(col, row) {
  const v = typeof col?.render === 'function' ? col.render(row) : row?.[col?.key]
  return v == null || v === '' || typeof v === 'boolean' ? EMPTY_CELL : v
}
