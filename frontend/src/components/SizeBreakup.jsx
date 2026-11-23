import { useState } from 'react'
import { Pencil, Plus, Trash2, Check, AlertTriangle } from '../icons.jsx'
import { T } from '../constants.js'
import { Modal, Btn, Input, FlexRow, useToast } from './ui.jsx'
import { useApp } from '../context.jsx'
import { capsFor } from '../caps.js'
import { breakupTotals, editorGrid, editorPayload, fitRows, parseSizes, totalNote } from '../sizeBreakup.js'

const cell = { padding: '7px 10px', fontSize: 13, textAlign: 'right', borderTop: `1px solid ${T.border}`, whiteSpace: 'nowrap' }
const head = { padding: '7px 10px', fontSize: 11, fontWeight: 800, color: T.textMuted, textAlign: 'right', whiteSpace: 'nowrap', background: '#f8fafc' }

/**
 * The grid itself, read only: colours down the side, sizes across, totals on both edges. `large` is for a phone on the
 * factory floor (the coordinator's view): bigger figures, same grid.
 */
export function SizeBreakupTable({ breakup, large = false }) {
  if (!breakup?.sizes?.length) return null
  const { bySize, byColour, total } = breakupTotals(breakup)
  const fs = large ? 15 : 13
  const named = breakup.rows.some(r => r.colour)
  return (
    <div className="table-scroll" style={{ border: `1px solid ${T.border}`, borderRadius: 10, background: '#fff' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ ...head, textAlign: 'left' }}>{named ? 'Colour' : ''}</th>
            {breakup.sizes.map(s => <th key={s} style={{ ...head, fontSize: large ? 13 : 11 }}>{s}</th>)}
            <th style={{ ...head, fontSize: large ? 13 : 11 }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {breakup.rows.map((r, ri) => (
            <tr key={ri}>
              <td style={{ ...cell, fontSize: fs, textAlign: 'left', fontWeight: 700, color: T.text, whiteSpace: 'normal' }}>{r.colour || 'Pieces'}</td>
              {breakup.sizes.map((_, i) => <td key={i} style={{ ...cell, fontSize: fs, color: r.qty[i] ? T.text : T.textLight }}>{r.qty[i] || 0}</td>)}
              <td style={{ ...cell, fontSize: fs, fontWeight: 800, color: T.text }}>{byColour[ri]}</td>
            </tr>
          ))}
          {breakup.rows.length > 1 && (
            <tr style={{ background: '#f8fafc' }}>
              <td style={{ ...cell, fontSize: fs, textAlign: 'left', fontWeight: 800, color: T.text }}>Total</td>
              {bySize.map((n, i) => <td key={i} style={{ ...cell, fontSize: fs, fontWeight: 800, color: T.text }}>{n}</td>)}
              <td style={{ ...cell, fontSize: fs, fontWeight: 800, color: T.primaryDeep }}>{total}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

const cellInput = { width: 64, boxSizing: 'border-box', border: `1px solid ${T.border}`, borderRadius: 7, padding: '6px 8px', fontSize: 13, textAlign: 'right', fontFamily: 'inherit', color: T.text }

// Type the sizes once, then the pieces for each colour. Totals add up as you type.
function SizeBreakupEditor({ order, onClose }) {
  const { setSizeBreakup } = useApp()
  const toast = useToast()
  const [grid, setGrid] = useState(() => editorGrid(order))
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const sizes = parseSizes(grid.sizes)
  const rows = fitRows(grid.rows, sizes.length)
  const totals = breakupTotals({ sizes, rows })
  const note = totalNote(totals.total, order.totalQty)
  const setRow = (ri, patch) => { setErr(''); setGrid(g => ({ ...g, rows: fitRows(g.rows, sizes.length).map((r, i) => (i === ri ? { ...r, ...patch } : r)) })) }
  const setQty = (ri, i, v) => setRow(ri, { qty: rows[ri].qty.map((q, j) => (j === i ? v.replace(/[^\d]/g, '').slice(0, 7) : q)) })

  const save = async body => {
    setBusy(true); setErr('')
    try { await setSizeBreakup(order.id, body); toast(body.sizes.length ? 'Size breakup saved' : 'Size breakup removed', 'success'); onClose() }
    catch (e) { setErr(e?.message || 'Could not save the size breakup'); setBusy(false) }
  }
  const submit = () => { const r = editorPayload(grid); if (r.error) { setErr(r.error); return } save(r.body) }

  return (
    <Modal title="Size breakup" subtitle={`${order.product} · pieces of each colour in each size`} size="lg" onClose={() => !busy && onClose()}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label="Sizes, in order, separated by commas" value={grid.sizes} onChange={e => { setErr(''); setGrid(g => ({ ...g, sizes: e.target.value })) }} placeholder="S, M, L, XL, 2XL   or   28, 30, 32, 34, 36" maxLength={300} />
        {sizes.length > 0 && (
          <div className="table-scroll" style={{ border: `1px solid ${T.border}`, borderRadius: 10 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ ...head, textAlign: 'left' }}>Colour</th>
                  {sizes.map((s, i) => <th key={i} style={head}>{s}</th>)}
                  <th style={head}>Total</th>
                  <th style={head} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri}>
                    <td style={{ ...cell, textAlign: 'left' }}>
                      <input value={r.colour} onChange={e => setRow(ri, { colour: e.target.value })} placeholder={rows.length > 1 ? 'Colour' : 'Colour (optional)'} maxLength={60} aria-label={`Colour of row ${ri + 1}`}
                        style={{ ...cellInput, width: 150, textAlign: 'left' }} />
                    </td>
                    {sizes.map((s, i) => (
                      <td key={i} style={cell}>
                        <input value={r.qty[i]} onChange={e => setQty(ri, i, e.target.value)} inputMode="numeric" placeholder="0" aria-label={`${r.colour || 'Pieces'}, size ${s}`} style={cellInput} />
                      </td>
                    ))}
                    <td style={{ ...cell, fontWeight: 800 }}>{totals.byColour[ri]}</td>
                    <td style={cell}>
                      {rows.length > 1 && <button type="button" onClick={() => { setErr(''); setGrid(g => ({ ...g, rows: fitRows(g.rows, sizes.length).filter((_, i) => i !== ri) })) }} aria-label={`Remove ${r.colour || 'this row'}`} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: T.textLight, display: 'inline-flex' }}><Trash2 size={14} /></button>}
                    </td>
                  </tr>
                ))}
                <tr style={{ background: '#f8fafc' }}>
                  <td style={{ ...cell, textAlign: 'left', fontWeight: 800 }}>Total</td>
                  {totals.bySize.map((n, i) => <td key={i} style={{ ...cell, fontWeight: 800 }}>{n}</td>)}
                  <td style={{ ...cell, fontWeight: 800, color: T.primaryDeep }}>{totals.total}</td>
                  <td style={cell} />
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {sizes.length > 0 && (
          <div><Btn size="sm" variant="secondary" onClick={() => setGrid(g => ({ ...g, rows: [...fitRows(g.rows, sizes.length), { colour: '', qty: Array(sizes.length).fill('') }] }))} icon={<Plus size={12} />}>Add a colour</Btn></div>
        )}
        {note && <div style={{ fontSize: 12, color: T.warning, background: T.warningBg, border: `1px solid ${T.warningBorder}`, borderRadius: 8, padding: '8px 10px' }}>{note} You can still save it.</div>}
        {err && <div role="alert" style={{ fontSize: 12, color: T.dangerDeep, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}><AlertTriangle size={13} /> {err}</div>}
        <FlexRow justify="space-between" gap={8} style={{ flexWrap: 'wrap' }}>
          <div>{order.sizeBreakup && <Btn variant="danger" disabled={busy} onClick={() => save({ sizes: [], rows: [] })} icon={<Trash2 size={13} />}>Remove the breakup</Btn>}</div>
          <FlexRow gap={8}>
            <Btn variant="secondary" disabled={busy} onClick={onClose}>Cancel</Btn>
            <Btn disabled={busy} onClick={submit} icon={<Check size={13} strokeWidth={3} />}>{busy ? 'Saving…' : 'Save'}</Btn>
          </FlexRow>
        </FlexRow>
      </div>
    </Modal>
  )
}

/**
 * The size breakup on a style's page: the grid, a line when its total and the style's quantity differ, and Edit for
 * those who may change it (Tradio, and a customer on its own style; the server decides). Everyone else reads it.
 */
export function SizeBreakupSection({ order }) {
  const { currentUser } = useApp()
  const [editing, setEditing] = useState(false)
  const b = order.sizeBreakup
  const mayEdit = capsFor(currentUser).editSizeBreakup
  if (!b && !mayEdit) return null
  const note = b ? totalNote(b.total, order.totalQty) : ''
  return (
    <div style={{ marginTop: 16 }}>
      <FlexRow gap={8} style={{ marginBottom: 7 }}>
        <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 9, fontWeight: 700, color: T.textLight, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Size breakup{b ? ` · ${b.total} pieces` : ''}</div>
        {mayEdit && <Btn size="sm" variant="ghost" onClick={() => setEditing(true)} icon={b ? <Pencil size={11} /> : <Plus size={11} />}>{b ? 'Edit' : 'Add'}</Btn>}
      </FlexRow>
      {b ? <SizeBreakupTable breakup={b} /> : <div style={{ fontSize: 12, color: T.textMuted }}>Not added yet. Add the pieces of each colour in each size from the purchase order.</div>}
      {note && <div style={{ fontSize: 12, color: T.warning, marginTop: 6 }}>{note}</div>}
      {editing && <SizeBreakupEditor order={order} onClose={() => setEditing(false)} />}
    </div>
  )
}
