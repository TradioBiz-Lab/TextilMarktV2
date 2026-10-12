import { T } from '../constants.js'
import { activateOnKey } from './ui.jsx'
import { pickPrimaryColumn, resolveRowKey, resolveAlign, mobileLabel, cellClasses, cellContent } from '../lib/dataTable.js'

// A table that turns into a list of cards on phones (below 720px, in CSS only, see "DataTable" in
// index.css). One set of columns describes both layouts:
//
//   columns   [{ key, header, render?(row), width?, align?: 'left'|'right'|'center', numeric?, hideOnMobile?, primary? }]
//             numeric: right-aligned tabular figures. primary: the card title on a phone (defaults to the
//             first text column). hideOnMobile: left out of phone cards.
//   rows      the records to show
//   rowKey    a property name on each row, or (row, index) => key (default: row.id)
//   onRowClick(row, index)   makes every row a button: Tab to reach it, Enter or Space to open it
//   empty     what to show when there are no rows (default: a short plain message)
//   loading   true shows grey placeholder rows; with rows already on screen it just dims them
//   dense     tighter rows for desktop (touch screens keep 44px rows regardless)
//   stickyHeader  keep the header visible while the rows scroll (default true; the table scrolls inside
//             its own box, `maxHeight` tall, so the header has something to stick to)
//   mobileCard    set false to keep a scrolling table on phones instead of cards (default true)
//
// Colours come from the T tokens, passed to the stylesheet as custom properties.
export function DataTable({
  columns, rows, rowKey, onRowClick, empty, loading = false, dense = false,
  stickyHeader = true, mobileCard = true, maxHeight = 'min(70vh, 720px)', className, style,
}) {
  const cols = columns || []
  const data = rows || []
  const primary = pickPrimaryColumn(cols)
  const clickable = typeof onRowClick === 'function'

  const vars = {
    '--dt-surface': T.surface, '--dt-border': T.border, '--dt-line': '#f1f5f9', '--dt-head': T.bg,
    '--dt-hover': T.bg, '--dt-text': T.text, '--dt-muted': T.textMuted, '--dt-accent': T.primary,
  }
  const wrapClass = cls => `data-table-wrap${cls ? ` ${cls}` : ''}${className ? ` ${className}` : ''}`

  // Nothing to draw yet: placeholder bars, or the empty message. Both sit in the bordered panel on every screen size.
  if (data.length === 0) {
    return (
      <div className={wrapClass()} style={{ ...vars, ...style }}>
        {loading ? (
          <div role="status" aria-label="Loading">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="dt-skel-row" aria-hidden="true">
                {cols.slice(0, 4).map(c => <span key={c.key} className="dt-skel" />)}
              </div>
            ))}
          </div>
        ) : (
          <div className="data-table-empty">{empty ?? 'Nothing to show yet.'}</div>
        )}
      </div>
    )
  }

  // A click on a button or link inside a row belongs to that control, not to the row.
  const fromControl = e => {
    const el = e.target?.closest?.('a, button, input, select, textarea, label, summary, [data-row-ignore]')
    return !!el && el !== e.currentTarget && e.currentTarget.contains(el)
  }

  return (
    <div className={wrapClass(mobileCard ? 'data-table-wrap--cards' : '')} aria-busy={loading || undefined}
      style={{ ...vars, ...(stickyHeader ? { maxHeight } : null), ...style }}>
      <table className={`data-table${dense ? ' data-table--dense' : ''}${stickyHeader ? ' data-table--sticky' : ''}${mobileCard ? ' data-table--cards' : ''}`}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.key} scope="col" className={cellClasses(c, c === primary) || undefined} data-align={resolveAlign(c)}
                style={c.width != null ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => {
            const rowProps = clickable ? {
              role: 'button',
              tabIndex: 0,
              onClick: e => { if (!fromControl(e)) onRowClick(row, i) },
              // Space and Enter open the row, but only when the row itself has focus: on a button inside it they belong to that button.
              onKeyDown: e => { if (e.target === e.currentTarget) activateOnKey(() => onRowClick(row, i))(e) },
            } : {}
            return (
              <tr key={resolveRowKey(rowKey, row, i)} {...rowProps}>
                {cols.map(c => (
                  <td key={c.key} className={cellClasses(c, c === primary) || undefined} data-align={resolveAlign(c)} data-label={mobileLabel(c)}>
                    <span className="dt-val">{cellContent(c, row)}</span>
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
