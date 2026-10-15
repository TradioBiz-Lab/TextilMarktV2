import { T, CURRENCIES, INCOTERMS } from '../../constants.js'
import { Input, Select, Textarea } from '../../components/ui.jsx'

/**
 * What the customer pays for a buy and on what terms, plus how it ships. Used by the create and edit forms. Only
 * Tradio fills these in; price, currency and payment terms are never shown to a factory (the server blanks them).
 */
export function MasterOrderTermsFields({ details, setDetail }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12, border: `1px solid ${T.border}`, borderRadius: 10, background: '#f8fafc' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Commercial terms <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>· price and payment terms are not shown to factories</span>
      </div>
      <div className="form-grid-2" style={{ gap: 12 }}>
        <Select label="Currency" value={details.currency} onChange={setDetail('currency')}>
          <option value="">Not set</option>
          {[...new Set([...CURRENCIES, ...(details.currency ? [details.currency] : [])])].map(c => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Input label="Order value" type="number" min="0" step="0.01" inputMode="decimal" value={details.price} onChange={setDetail('price')} placeholder="e.g. 125000" />
      </div>
      <Input label="Payment terms" value={details.paymentTerms} onChange={setDetail('paymentTerms')} maxLength={200} placeholder="e.g. 30% advance, 70% against BL" />
      <Select label="Incoterm" value={details.incoterm} onChange={setDetail('incoterm')}>
        <option value="">Not set</option>
        {INCOTERMS.map(c => <option key={c} value={c}>{c}</option>)}
      </Select>
      <Textarea label="Ship to" value={details.shipTo} onChange={setDetail('shipTo')} rows={2} maxLength={500} placeholder="Delivery address or port" />
    </div>
  )
}
