import { T } from '../../constants.js'
import { Card, SectionLabel, FlexRow } from '../../components/ui.jsx'
import { DataTable } from '../../components/DataTable.jsx'
import { Fact } from '../procurement/common.jsx'
import { BLOCKS } from '../../lib/costing.js'
import { rupees, fmtQty, fmtDay } from '../../lib/procurement.js'

const money = n => rupees(n)

/** A label and an amount on one line, for the build-up. */
function Row({ label, value, strong, tone }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0', fontSize: strong ? 14 : 13, fontWeight: strong ? 800 : 500, color: tone || (strong ? T.text : T.textMuted) }}>
      <span>{label}</span><span style={{ fontVariantNumeric: 'tabular-nums', color: T.text }}>{value}</span>
    </div>
  )
}

/**
 * A cost sheet laid out to read: the style, each block's lines, labour, and the build-up down to the price.
 * The same screen for the factory and for the brand it is shared with; the figures are the server's.
 */
export function CostSheetView({ sheet }) {
  const c = sheet.computed || {}
  const columns = [
    { key: 'name', header: 'Item', primary: true, render: l => (
      <div>
        <div style={{ fontWeight: 600, fontSize: 13, color: T.text }}>{l.name}</div>
        {(l.spec || l.note) && <div style={{ fontSize: 11, color: T.textLight, marginTop: 2 }}>{[l.spec, l.note].filter(Boolean).join(' · ')}</div>}
      </div>
    ) },
    { key: 'consumption', header: 'Qty per piece', numeric: true, render: l => `${fmtQty(l.consumption)}${l.unit ? ` ${l.unit}` : ''}` },
    { key: 'rate', header: 'Rate', numeric: true, render: l => (l.rate || l.freight ? money(l.rate) : '') },
    { key: 'wastagePct', header: 'Wastage', numeric: true, render: l => (l.wastagePct ? `${fmtQty(l.wastagePct)}%` : '') },
    { key: 'amount', header: 'Per piece', numeric: true, render: l => <strong>{money(l.amount)}</strong> },
  ]
  const rowsOf = key => (sheet[key] || []).map((l, i) => ({ ...l, id: `${key}${i}`, amount: c.lines?.[key]?.[i] ?? 0 }))

  return (
    <div>
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 16 }}>
          <Fact label="Style">{sheet.styleName}{sheet.styleCode ? ` (${sheet.styleCode})` : ''}</Fact>
          <Fact label="Factory">{sheet.factoryName}</Fact>
          <Fact label="Prepared for">{sheet.brandName}</Fact>
          <Fact label="Quantity">{sheet.qty ? `${fmtQty(sheet.qty)} pcs` : ''}</Fact>
          <Fact label="Shared">{sheet.sharedAt && fmtDay(sheet.sharedAt)}</Fact>
        </div>
        {sheet.sharedMessage && <div style={{ marginTop: 14, padding: '10px 14px', background: '#f8fafc', borderLeft: `3px solid ${T.primary}`, fontSize: 13, color: T.text, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{sheet.sharedMessage}</div>}
      </Card>

      {BLOCKS.filter(b => (sheet[b.key] || []).length).map(b => (
        <div key={b.key}>
          <div style={{ height: 14 }} />
          <Card pad={false}>
            <div style={{ padding: '16px 20px 6px' }}><SectionLabel>{b.label}</SectionLabel></div>
            <DataTable columns={columns} rows={rowsOf(b.key)} rowKey="id" stickyHeader={false} style={{ border: 0, borderRadius: 0 }} />
            <FlexRow justify="space-between" style={{ padding: '10px 20px 14px', borderTop: `1px solid ${T.border}`, fontSize: 13, fontWeight: 700 }}>
              <span style={{ color: T.textMuted }}>Total {b.label.split(',')[0].toLowerCase()}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(c[b.key])}</span>
            </FlexRow>
          </Card>
        </div>
      ))}

      <div style={{ height: 14 }} />
      <Card>
        <SectionLabel>Labour</SectionLabel>
        <div style={{ marginTop: 6 }}>
          <Row label="Cutting and threads" value={money(c.cuttingThreads)} />
          <Row label="Making" value={money(c.making)} />
          <Row label="Finishing and packing" value={money(c.finishingPacking)} />
          <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 6, paddingTop: 6 }}><Row label="Total labour" value={money(c.labour)} strong /></div>
        </div>
      </Card>

      <div style={{ height: 14 }} />
      <Card>
        <SectionLabel>How the price builds up</SectionLabel>
        <div style={{ marginTop: 6 }}>
          <Row label="Raw material" value={money(c.materials)} />
          <Row label="Labour" value={money(c.labour)} />
          <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 4, paddingTop: 4 }}><Row label="Total labour and raw material" value={money(c.base)} strong /></div>
          <Row label={`Overhead (${fmtQty(sheet.overheadPct)}%)`} value={money(c.overhead)} />
          <Row label={`Rejection (${fmtQty(sheet.rejectionPct)}%)`} value={money(c.rejection)} />
          <Row label={`Margin (${fmtQty(sheet.marginPct)}%)`} value={money(c.margin)} />
          {sheet.tradioPct > 0 && <Row label={`Tradio fee (${fmtQty(sheet.tradioPct)}%)`} value={money(c.tradio)} />}
          <div style={{ borderTop: `2px solid ${T.text}`, marginTop: 8, paddingTop: 8 }}><Row label="Price per piece" value={money(c.price)} strong /></div>
          {sheet.discountPct > 0 && (
            <>
              <Row label={`Negotiated discount (${fmtQty(sheet.discountPct)}%)`} value={`-${money(c.price - c.negotiated)}`} />
              <div style={{ background: T.primaryLight, borderRadius: 8, padding: '6px 10px', marginTop: 4 }}><Row label="Negotiated price per piece" value={money(c.negotiated)} strong tone={T.primaryDeep} /></div>
            </>
          )}
          {c.orderValue ? <Row label={`Order value (${fmtQty(sheet.qty)} pcs)`} value={money(sheet.discountPct > 0 ? c.negotiatedValue : c.orderValue)} /> : null}
        </div>
      </Card>
    </div>
  )
}
